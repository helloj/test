/**
 * hook-bridge.js – abc2svg play_next 橋接層
 *
 * 職責：
 *   - 完整替換 abc2svg.play_next（含 play_cont 複本）
 *   - 在 play_cont 的推進迴圈中攔截 anchor，委派給 JumpEngine.walkAnchors()
 *   - 透過 JumpEngine.getCtxForSym() 懶取得每個 tune 的 jumpCtx
 *   - 保存 play_cont reference 供 resumePlay 使用（[pause:*] patch）
 *   - 填入 po._ballMeta 供 BallController 使用（[ball:*] patch）
 *
 * 依賴：
 *   - JumpEngine（全域，必須在本檔之前載入）
 *   - abc2svg（全域，必須在本檔之前載入）
 *   - BallController（全域，可選；未載入時 ball patch 自動跳過）
 *
 * 版本同步說明：
 *   play_next / play_cont / do_tie / set_ctrl / get_part 複製自 snd-1.js。
 *   snd-1.js 升級時，重新複製上述四個函數後，貼回以下標記的修補段：
 *     [stop-guard]      play_next 入口最前面：po.stop 快速退出守衛
 *                       （原版 snd-1.js play_next 末段的同名檢查移至此處，
 *                        防止 Audio5.stop() 呼叫 play_next 時走進 play_cont
 *                        製造殭屍排程）
 *     [GEN]             play_cont 開頭：_playGeneration 世代守衛，
 *                       過濾 stop 後殘存的舊世代 setTimeout(play_cont,...)
 *     [repCtrl]         _createRepeatCtrl 定義在 IIFE 頂層（模組私有函式），
 *                       無 upvalue，完全脫離 play_next 生命週期。
 *                       play_cont 開頭（[GEN] 之後）兩行：
 *                         if(!po.repCtrl){ po.repCtrl=_createRepeatCtrl(po); HookBridge.repCtrl=po.repCtrl; }
 *                         var rep = po.repCtrl;
 *                       case C.BAR 的 rep_p / rep_s / 裸 |: 三段，以及
 *                       [B1][B2] DC/DS 落點、part1 切換，全部改由 rep.*() 代理。
 *                       注意：do_tie 內的局部 repv 複本不納入管理，保持原狀。
 *                       skipVoltas 內含 var_end 邏輯複本（標記 [from:var_end]），
 *                       snd-1.js 升版時請 AI 比對新版 var_end 與該段的差異。
 *     [B1]              play_cont 推進迴圈前：起點落在 anchor 時走過
 *                       + DC/DS 落在 tuneStart/segno → rep.onDCDSLanding()
 *     [B2]              play_cont 內層 while：中途遇到 anchor 時跳轉
 *                       + DC/DS 落在 tuneStart/segno → rep.onDCDSLanding()
 *     [repv-on-enter]   已整合至 [repCtrl]（rep_s 段改由 rep.enterVolta 代理）
 *     [pause:reset-timouts]  po.timouts=[] 之後，重置 po._onnoteTimouts
 *     [pause:track-onnote]   onnote on/off setTimeout 改存入 po._onnoteTimouts
 *     [pause:save-refs]      play_cont 排程前記錄 po._nextT；結尾存 po._play_cont
 *     [ball:meta]            填入 po._ballMeta[i] = { durMs, nextIstart, isJump }
 *                            nextIstart 由 _findNextMeta(s, rep, ctx) 查找
 *                            第一個音符時直接呼叫 BallController.onPlayStart（需要 st）
 *
 * po.repv / po.repn 語義（新）：
 *   所有讀寫統一透過 po.repCtrl 代理，外部仍可直接讀 po.repv / po.repn（雙軌同步）。
 *   - 初始值：repv=1, repn=false
 *   - 進入第 N 房（repCtrl.enterVolta）：repn=false; repv++
 *   - rep_p 彈回（repCtrl.bounceBack）：repn=true（不再遞增 repv）
 *   - 跳過 volta / 段末（repCtrl.skipVoltas）：repn=false; repv=1
 *   - DC/DS 落點（repCtrl.onDCDSLanding）：repn=false; repv 不變（慣例 A）
 *   - 裸 |: / part 切換（repCtrl.openNewBlock）：repv=1; repn 不動
 *
 * 載入順序（HTML）：
 *   <script src="abc2svg-1.js"></script>
 *   <script src="snd-1.js"></script>
 *   <script src="jump-engine.js"></script>
 *   <script src="hook-bridge.js"></script>   ← 本檔
 *   <script src="ball-controller.js"></script>
 *   <script src="loader.js"></script>
 */

;(function (root) {
  'use strict';

  // ── 殘存排程防護（_playGeneration）──────────────────────────────────
  //
  // 每次 playStart() 開始新播放時，由 abcplay-driver.js 呼叫
  // HookBridge.newGeneration() 遞增此值。
  //
  // play_cont 首次進入（po._gen === undefined）時將當前世代號寫入 po._gen。
  // 後續所有 setTimeout(play_cont,...) 回呼進入時比對 po._gen：
  //   - 相符：合法的當代排程，正常執行
  //   - 不符：舊世代殘存排程（stop 後漏網的 setTimeout），立即清乾淨後 return
  //
  // 與 _resumeGen（防 pause/resume race condition）互相獨立，各管一層。
  //
  var _playGeneration = 0;

  // ── _scanToNote(sym) ────────────────────────────────────────────
  //
  // 從 sym 開始往 ts_next 掃描，回傳第一個「可播音符」sym，
  // 或 null（掃到鏈尾）。
  //
  // 「可播音符」定義：istart 存在 && !noplay && type 為 NOTE/REST/GRACE。
  // 三處 findNextIstart 落點掃描（rep_p / volta / DC-DS）邏輯完全相同，
  // 統一由此函式處理，避免重複。
  //
  function _scanToNote(sym) {
    var C = abc2svg.C;
    while(sym && !(sym.istart && !sym.noplay &&
        (sym.type===C.NOTE || sym.type===C.REST || sym.type===C.GRACE)))
      sym = sym.ts_next;
    return sym || null;
  }

  // ── _resolveDCDS(a, ctx) ─────────────────────────────────────────
  //
  // DC / DS jump anchor 跳轉時，解析落點 anchor 後第一個可播音符的 istart。
  // 純讀，不改任何狀態。
  //
  // @param  {symbol}      a   - jump anchor（jumpDC 或 jumpDS 為 true）
  // @param  {object|null} ctx - jumpCtx
  // @return {number|null} istart，或 null（ctx 缺失 / 落點找不到音符）
  //
  function _resolveDCDS(a, ctx) {
    if(!ctx) return null;
    var at = a.jumpDC ? ctx.tuneStartAnchor
                      : (ctx.segnoAnchors && ctx.segnoAnchors[0]);
    if(!at) return null;
    var n = _scanToNote(at.ts_next);
    return n ? n.istart : null;
  }

  // ── _resolveCoda(a, ctx) ─────────────────────────────────────────
  //
  // jumpCoda 分歧時，解析第一個 ptim >= a.ptim 的 coda land anchor
  // 後第一個可播音符的 istart。純讀，不改任何狀態。
  //
  function _resolveCoda(a, ctx) {
    if(!ctx) return null;
    var land = null;
    for(var i=0; i<ctx.codaAnchors.length; i++){
      if(ctx.codaAnchors[i].ptim >= a.ptim){ land = ctx.codaAnchors[i]; break; }
    }
    if(!land) return null;
    var n = _scanToNote(land.ts_next);
    return n ? n.istart : null;
  }

  // ── _findNextMeta(s, rep, ctx) ──────────────────────────────────
  //
  // ball 軌跡預測：從 s.ts_next 掃描，回傳 { nextIstart, isJump }。
  // 邊界規則與 play_cont 實際路徑對齊：
  //   rep_p（:|）     : willBounce → isJump
  //   rep_s（volta）  : rep_s[repv] 存在 → isJump
  //   _jumpAnchor DC/DS  : jumpDC/jumpDS true → isJump
  //   _jumpAnchor coda   : jumpCoda true → isJump
  //   land anchor        : 永遠穿越
  //
  function _findNextMeta(s, rep, ctx) {
    var C=abc2svg.C, bjump=false, bjumpNext=null
    var bn=s.ts_next
    while(bn){
      if(bn.type===C.BAR){
        if(bn.rep_p&&rep.willBounce(bn)){
          bjump=true; bjumpNext=rep.bounceTarget(bn); break}
        if(bn.rep_s&&bn.rep_s[rep.repv]){
          bjump=true; bjumpNext=rep.voltaTarget(bn); break}
      }
      if(bn._anchor){
        if(!bn._jumpAnchor){ bn=bn.ts_next;continue}  // land anchor → 穿越
        if(bn.jumpDC||bn.jumpDS){
          bjump=true; bjumpNext=_resolveDCDS(bn,ctx); break}
        if(bn.jumpCoda){
          bjump=true; bjumpNext=_resolveCoda(bn,ctx); break}
        bn=bn.ts_next;continue}  // 已消耗 → 穿越
      if(!bn.noplay&&bn.istart&&
         (bn.type===C.NOTE||bn.type===C.REST||bn.type===C.GRACE))
        break
      bn=bn.ts_next}
    return { nextIstart: bjump ? bjumpNext : (bn ? bn.istart : null), isJump: bjump }
  }

  // ── _createRepeatCtrl(_po) ───────────────────────────────────────
  //
  // repeat / volta 狀態控制物件工廠。
  // 不依賴任何 upvalue，_po 以參數傳入。
  // 每首曲子 play_next 入口建立一次（po.repCtrl = null 強制重建）；
  // play_cont 每次進入直接複用 po.repCtrl。
  //
  // 雙軌寫回：每個 method 同步更新 this.* 和 _po.repn / _po.repv，
  // 確保 do_tie / jump-engine / po.onend 等外部讀取永遠拿到正確值。
  // do_tie 的局部 repv 複本不納入管理。
  //
  // Methods（Pre/Post 見各 method 註解）：
  //   willBounce(s)         查詢 :| 是否彈回（純讀，不改狀態）
  //   bounceTarget(s)      :| 彈回落點 istart（純讀）
  //   voltaTarget(s)       volta 進房落點 istart（純讀）
  //   isAnchorPassThrough(a) 永遠回傳 false（_inRepeat 移除後保留介面相容）
  //   clearBounce()        repn=false，無 volta 清單時使用
  //   bounceBack(s)        rep_p 第一次彈回（:|）
  //   skipVoltas(s)        跳過剩餘 volta，走向段尾  ← [from:var_end]
  //   enterVolta(s2)       進入 volta 房
  //   onDCDSLanding()      DC/DS 落在 tuneStart/segno 時重置 repn（慣例 A）
  //   openNewBlock()       裸 |: 或 part 切換，重置 repv
  //
  function _createRepeatCtrl(_po) {
    var rep = {
      // 鏡像 _po.repn / _po.repv，供外部讀取（雙軌同步）
      repn: _po.repn,
      repv: _po.repv,

      // ── state ─────────────────────────────────────────────────
      // 具名狀態，平行於 repn/repv，供 debug 使用。
      // repn/repv 雙軌同步不受影響，do_tie / jump-engine 等外部讀取照舊。
      //
      //   'NORMAL'   repn=false：正常前進（含進房中）
      //   'BOUNCING' repn=true ：已彈回，正在走回 |: 段
      //
      // repv（房號計數）屬獨立維度，不納入狀態名稱。
      state: 'NORMAL',

      // ── willBounce(s) ────────────────────────────────────────
      // 查詢 :| 這次是否會彈回，純讀，不改狀態。
      // 與 play_cont case C.BAR 及 _findNextMeta 的判斷條件完全一致，
      // 單點定義，避免三處各自 inline 造成不同步。
      // Pre : s 帶 rep_p
      // Returns: boolean
      willBounce: function(s) {
        return !this.repn && (!s.rep_v || this.repv <= s.rep_v.length);
      },

      // ── bounceTarget(s) ──────────────────────────────────────
      // :| 彈回後的落點 istart，純讀，不改狀態。
      // Pre : s 帶 rep_p；willBounce(s) === true
      // Returns: istart | null
      bounceTarget: function(s) {
        var n=_scanToNote(s.rep_p); return n?n.istart:null;
      },

      // ── voltaTarget(s) ────────────────────────────────────────
      // volta 進房落點 istart，純讀，不改狀態。
      // Pre : s 帶 rep_s；rep_s[this.repv] 存在
      // Returns: istart | null
      voltaTarget: function(s) {
        var n=_scanToNote(s.rep_s[this.repv]); return n?n.istart:null;
      },

      // ── isAnchorPassThrough(a) ───────────────────────────────
      // _inRepeat 已移除；DC/DS 遇到就跳，無穿越條件。
      // 保留此 method 供 _findNextMeta 呼叫點介面相容。
      // Pre : a._jumpAnchor === true
      // Returns: boolean（永遠 false）
      isAnchorPassThrough: function(a) {
        return false;
      },

      // ── clearBounce() ────────────────────────────────────────
      // Pre : rep_p 存在但 rep_v 不存在（無 volta 清單）
      // Post: repn=false; repv 不動; state='NORMAL'
      clearBounce: function() {
        this.repn  = false; _po.repn = false;
        this.state = 'NORMAL';
      },

      // ── bounceBack(s) ─────────────────────────────────────────
      // Pre : repn===false; repv 在合法房範圍內
      // Post: repn=true; state='BOUNCING'
      // Returns: s.rep_p（|: 跳回目標）
      bounceBack: function(s) {
        this.repn  = true; _po.repn = true;
        this.state = 'BOUNCING';
        return s.rep_p;
      },

      // ── skipVoltas(s) ─────────────────────────────────────────
      // Pre : 無更多合法 volta 可進
      // Post: repn=false; repv=1; state='NORMAL'
      // Returns: 跳轉目標 symbol
      //
      // ── [from:var_end] ────────────────────────────────────────
      // 此段邏輯來自 snd-1.js play_cont 內的 var_end()。
      // snd-1.js 升版時，請 AI 比對新版 var_end 與此段差異，
      // 確認兩處修正的邊界是否需要調整：
      //   修正一（[fix:double-repeat]）：:: 落點改為 ts_next（|:）
      //     原版只檢查 rbstop==2，落點停在 :|] 本身，
      //     後續 while(!s.dur) 跳過 |:，新 repeat block 被忽略。
      //   修正二（[fix:double-repeat]）：補 repn=false
      //     防止舊 repn=true 帶入新段，導致新段 :| 跳過彈回。
      // ── [from:var_end] end ────────────────────────────────────
      skipVoltas: function(s) {
        var i,s2,s3,a=s.rep_v||s.rep_s,ti=0
        for(i=1;i<a.length;i++){s2=a[i]
          if(s2.time>ti){ti=s2.time
            s3=s2}}
        for(s=s3;s!=_po.s_end;s=s.ts_next){if(s.time==ti)
          continue
          if(s.rep_p&&s.ts_next){s=s.ts_next;break}  // 修正一
          if(s.rbstop==2)break}
        _po.repv=1;     this.repv=1;
        _po.repn=false; this.repn=false;  this.state='NORMAL';  // 修正二
        return s;
      },

      // ── enterVolta(s2) ────────────────────────────────────────
      // Pre : rep_s[this.repv] === s2 存在
      // Post: repn=false; repv++; state='NORMAL'
      // Returns: s2（房入口；若 s2===s 則由呼叫方補 null）
      enterVolta: function(s2) {
        this.repn  = false; _po.repn = false;
        this.repv++;        _po.repv = this.repv;
        this.state = 'NORMAL';
        return s2;
      },

      // ── onDCDSLanding() ───────────────────────────────────────
      // 慣例 A：DC/DS 落在 tuneStart / segno 時重置 repn。
      // repv 不重置：保留已進房計數，下次 volta 分歧自然走下一未播房。
      // Pre : anchor 落點是 _tuneStartAnchor 或 _segnoAnchor
      // Post: repn=false; repv 不變; state='NORMAL'
      onDCDSLanding: function() {
        this.repn  = false; _po.repn = false;
        this.state = 'NORMAL';
      },

      // ── openNewBlock() ────────────────────────────────────────
      // Pre : 裸 |:（bar_type 末為 ':' 且首非 ':'）或 part1 切換
      // Post: repv=1; repn 不動; state 不動
      openNewBlock: function() {
        this.repv = 1;
        _po.repv  = 1;
      }
    };
    return rep;
  }

  // ── HookBridge.setup() ───────────────────────────────────────────
  //
  // 唯一的公開入口。由 loader.js 的 Section 3 位置呼叫（頁面載入時立即執行）。
  // 執行後 abc2svg.play_next 被完整替換；orig_play_next 存底以備不時之需。
  //
  var HookBridge = {

    /**
     * repCtrl
     *
     * 最新一個 po.repCtrl 的 alias，供外部 debug / 測試使用。
     * 在第一首曲子的 play_next 入口被賦值；播放前為 null。
     * 舊的 po 被取代後，舊的 repCtrl 實例隨舊 po 一起由 GC 回收。
     */
    repCtrl: null,

    /**
     * newGeneration()
     *
     * 遞增播放世代號。
     * 由 abcplay-driver.js 的 playStart() 在每次新播放開始前呼叫。
     * 遞增後，所有持有舊世代號（po._gen !== _playGeneration）的
     * play_cont 回呼在下次觸發時將自動清除並靜默退出。
     */
    newGeneration: function () {
      ++_playGeneration;
    },

    /**
     * setup()
     *
     * 替換 abc2svg.play_next。
     * 本函式冪等：多次呼叫不會重複包裝（_patched 旗標防護）。
     */
    setup: function () {
      if (abc2svg.play_next && abc2svg.play_next._hb_patched) return;

      var orig_play_next = abc2svg.play_next;

      abc2svg.play_next = function(po) {

        // ── [stop-guard] po.stop 快速退出 ────────────────────────
        // Audio5.stop() 會設 po.stop=true 後呼叫 abc2svg.play_next(po) 做收尾。
        // 原版 snd-1.js 在 play_next 末段才檢查 po.stop；
        // 但本版 play_next 在末段之前就進入 play_cont，若不在此攔截，
        // play_cont 會重新排程新的 setTimeout(play_cont,...)，
        // 製造殭屍排程（stop 後仍持續觸發），且無法被後續 stop/pause 消滅。
        // 移至入口最前面，確保 stop 路徑不進入任何播放邏輯。
        if (po.stop) {
          if (po.onend) po.onend(po.repv);
          return;
        }
        // ── [stop-guard] end ─────────────────────────────────────

        // ── 最小修補：instrument filter ──────────────────────────
        if (po.note_run && !po.note_run._patched && po.params) {
          var _origNR = po.note_run;
          po.note_run = function(po2, s, key, t, d) {
            var instr = po2.c_i[po2.v_c[s.v]];
            if (po2.params[instr] && po2.params[instr][key | 0]) _origNR(po2, s, key, t, d);
          };
          po.note_run._patched = true;
        }
        abc2svg._current_po = po;

        // ── jumpCtx 取得（懶查找，首次進入時設定）─────────────────
        if (po._jumpCtx === undefined) {
          po._jumpCtx = JumpEngine.getCtxForSym(po.s_cur) || null;
        }
        var ctx = po._jumpCtx;

        // ── [ball:meta] init ──────────────────────────────────────
        // 每次 play_next 入口重置，確保循環播放時第一個音符可重新觸發。
        // _ballFirstNote 三態：undefined（未進入）→ false（已進入，未發出 onPlayStart）
        //                      → true（onPlayStart 已呼叫）
        if (!po._ballFirstNote) {
          po._ballFirstNote = false;
          po._ballMeta      = {};
        }
        // ── [ball:meta] init end ──────────────────────────────────

        // ── 以下為 snd-1.js 原文（do_tie）────────────────────────
        function do_tie(not_s,d){var i,s=not_s.s,C=abc2svg.C,v=s.v,end_time=s.time+s.dur,repv=po.repv
          while(1){s=s.ts_next
            if(!s||s.time>end_time)
              break
            if(s.type==C.BAR){if(s.rep_p){if(!po.repn){s=s.rep_p
              end_time=s.time}}
              if(s.rep_s){if(!s.rep_s[repv])
                break
                s=s.rep_s[repv++]
                end_time=s.time}
              while(s.ts_next&&!s.ts_next.dur)
                s=s.ts_next
              continue}
            if(s.time<end_time||!s.ti2)
              continue
            i=s.notes.length
            while(--i>=0){var note=s.notes[i]
              if(note.tie_s==not_s){d+=s.pdur/po.conf.speed
                return note.tie_e?do_tie(note,d):d}}}
          return d}

        // ── 以下為 snd-1.js 原文（set_ctrl）─────────────────────
        function set_ctrl(po,s2,t){var i,p_v=s2.p_v,s={subtype:"midictl",p_v:p_v,v:s2.v}
          p_v.vol=p_v.pan=undefined
          for(i in p_v.midictl){s.ctrl=Number(i)
            s.val=p_v.midictl[i]
            po.midi_ctrl(po,s,t)}
          for(s=p_v.sym;s!=s2;s=s.next){if(s.subtype=="midictl"){po.midi_ctrl(po,s,t)}else if(s.subtype=='midiprog'){po.v_c[s.v]=s.chn
            if(s.instr!=undefined)
              po.c_i[po.v_c[s.v]]=s.instr
            po.midi_prog(po,s)}}
          i=po.v_c[s2.v]
          if(i==undefined)
            po.v_c[s2.v]=i=s2.v<9?s2.v:s2.v+1
          if(po.c_i[i]==undefined)
            po.c_i[i]=0
          while(p_v.voice_down){p_v=p_v.voice_down
            po.v_c[p_v.v]=i}
          po.p_v[s2.v]=true}

        // ── 以下為 snd-1.js 原文（play_cont）+ [GEN][repCtrl][B1][B2][pause:*][ball:*] patch ──
        function play_cont(po){var d,i,st,m,note,g,s2,t,maxt,now,p_v,C=abc2svg.C,s=po.s_cur

          // ── [GEN] 殘存排程防護 ────────────────────────────────────
          // 首次進入（po 剛由 Audio5.play 建立，po._gen 尚未定義）：
          //   綁定當前世代號，後續回呼以此比對。
          // 後續 setTimeout(play_cont,...) 回呼進入時：
          //   若世代號不符，表示這是舊世代殘存排程（例如 stop 後漏網的 setTimeout），
          //   清乾淨後靜默退出，不觸發任何副作用。
          if(po._gen === undefined){
            po._gen = _playGeneration;
          }
          if(po._gen !== _playGeneration){
            po.timouts.forEach(function(id){ clearTimeout(id); });
            po.timouts = [];
            if(po._onnoteTimouts){
              po._onnoteTimouts.forEach(function(e){ clearTimeout(e.id); });
              po._onnoteTimouts = [];
            }
            return;
          }
          // ── [GEN] end ─────────────────────────────────────────────

          // ── [repCtrl] 建立／複用 repeat/volta 控制物件 ───────────
          if(!po.repCtrl){po.repCtrl=_createRepeatCtrl(po);HookBridge.repCtrl=po.repCtrl;}
          var rep=po.repCtrl;
          // ── [repCtrl] end ─────────────────────────────────────────
          while(s.noplay){s=s.ts_next
            if(!s||s==po.s_end){if(po.onend)
              po.onend(po.repv)
              return}}

          // ── [B1] 起點落在 anchor 時走過並取得落點 ────────────────
          if(s._anchor){
            var _w1=JumpEngine.walkAnchors(s,ctx,po.conf.speed)
            if(!_w1.target){if(po.onend)po.onend(po.repv);return}
            po.stim+=_w1.stimDelta
            s=_w1.target
            // DC/DS 落在 tuneStart/segno：rep.onDCDSLanding()（慣例 A）。
            // coda/fine 方向前進，不重置。
            if(s._tuneStartAnchor||s._segnoAnchor){rep.onDCDSLanding()}
            if(s==po.s_end){if(po.onend)po.onend(po.repv);return}
            po.s_cur=s}
          // ── [B1] end ───────────────────────────────────────────

          t=po.stim+s.ptim/po.conf.speed
          now=po.get_time(po)
          if(po.conf.new_speed){po.stim=t-s.ptim/po.conf.new_speed
            po.conf.speed=po.conf.new_speed
            po.conf.new_speed=0}
          maxt=t+po.tgen
          po.timouts=[]
          // ── [pause:reset-timouts] ────────────────────────────────
          // po._onnoteTimouts 與 po.timouts 同步重置。
          // pause 時兩者分別處理：po.timouts（play_cont reschedule）直接丟棄，
          // po._onnoteTimouts 存下剩餘 delay 供 resume 重排。
          po._onnoteTimouts=[]
          // ── [pause:reset-timouts] end ────────────────────────────
          var _lastNoteT, _lastNoteD;  // 記錄最後一個發聲音符的 t/d，供 [B2] 使用

          while(1){switch(s.type){case C.BAR:s2=null
            // ── [repCtrl] case C.BAR repeat/volta 判斷 ───────────
            if(s.rep_p){
              // rep_p（:|）：第一次彈回 → bounceBack；已彈回或無合法房 → skipVoltas。
              // repv 遞增語義移至 rep_s 分歧點（enterVolta），rep_p 只負責彈回判斷。
              if(rep.willBounce(s)){s2=rep.bounceBack(s)
                }else{if(s.rep_v)
                s2=rep.skipVoltas(s)
                else{rep.clearBounce()}           // [repCtrl] 無 volta 清單：僅重置 repn
                if(s.bar_type.slice(-1)==':')
                  rep.openNewBlock()
                }}
            if(s.rep_s){
              // rep_s 分歧：rep_s[rep.repv] 存在 → enterVolta（repn=false; repv++）。
              // 不存在 → skipVoltas（跳過所有 volta，走向段落結尾）。
              s2=s.rep_s[rep.repv]
              if(s2){s2=rep.enterVolta(s2)
                if(s2==s)
                  s2=null}else{s2=rep.skipVoltas(s)
                if(s2==po.s_end)
                  break}}
            if(s.bar_type.slice(-1)==':'&&s.bar_type[0]!=':')
              rep.openNewBlock()              // 裸 |:：開新 repeat block
            // ── [repCtrl] end ─────────────────────────────────────
            if(s2){po.stim+=(s.ptim-s2.ptim)/po.conf.speed
              s=s2
              while(s&&!s.dur)
                s=s.ts_next
              if(!s)
                break
              t=po.stim+s.ptim/po.conf.speed
              break}
            if(!s.part1){while(s.ts_next&&!s.ts_next.seqst){s=s.ts_next
              if(s.part1)
                break}
              if(!s.part1)
                break}}
          if(s&&s!=po.s_end&&!s.noplay){switch(s.type){case C.BAR:break
            case C.BLOCK:if(s.subtype=="midictl"){po.midi_ctrl(po,s,t)}else if(s.subtype=='midiprog'){po.v_c[s.v]=s.chn
              if(s.instr!=undefined)
                po.c_i[po.v_c[s.v]]=s.instr
              po.midi_prog(po,s)
              p_v=s.p_v
              while(p_v.voice_down){p_v=p_v.voice_down
                po.v_c[p_v.v]=s.chn}}
              break
            case C.GRACE:if(!po.p_v[s.v])
              set_ctrl(po,s,t)
              for(g=s.extra;g;g=g.next){d=g.pdur/po.conf.speed
                for(m=0;m<=g.nhd;m++){note=g.notes[m]
                  if(!note.noplay)
                    po.note_run(po,g,note.midi,t+g.dtim,d)}}
              break
            case C.NOTE:case C.REST:if(!po.p_v[s.v])
              set_ctrl(po,s,t)
              d=s.pdur/po.conf.speed
              // ── [last-note] 記錄最後一個發聲音符的 t 和 d ────────────
              // [B2] 跳轉時需要用「前一個音符的結束時間」計算 po.stim，
              // 不能用外層 while 的 t（BAR 推進後 t 已不是音符時間）。
              var _lastNoteT=t, _lastNoteD=d;
              // ── [last-note] end ───────────────────────────────────────
              if(s.type==C.NOTE){for(m=0;m<=s.nhd;m++){note=s.notes[m]
                if(note.tie_s||note.noplay)
                  continue
                po.note_run(po,s,note.midi,t,note.tie_e?do_tie(note,d):d)}}
              if(po.onnote&&s.istart){i=s.istart
                st=(t-now)*1000
                // ── [pause:track-onnote] ──────────────────────────────
                // 原版直接 push 進 po.timouts；此處改存入 po._onnoteTimouts，
                // 並附帶觸發絕對時間 at，供 pausePlay 計算剩餘 delay、
                // resumePlay 重新排程使用。
                // po.timouts 僅保留 play_cont reschedule，相容 Audio5.stop() 原版行為。
                if(!po._onnoteTimouts) po._onnoteTimouts=[]
                po._onnoteTimouts.push({id:setTimeout(po.onnote,st,i,true),at:now+st/1000,i:i,on:true})
                if(d>2)
                  d-=.1
                var doff=st+d*1000
                po._onnoteTimouts.push({id:setTimeout(po.onnote,doff,i,false),at:now+doff/1000,i:i,on:false})}
                // ── [pause:track-onnote] end ──────────────────────────

                // ── [ball:meta] ───────────────────────────────────────
                // 填入 _ballMeta，供 BallController.onNoteOn 與
                // UIController.setNoteOp 取用。
                // 第一個音符在此直接呼叫 onPlayStart：
                //   st = (t-now)*1000 是「on=true 距現在的 ms」，僅在排程階段有意義，
                //   必須在 play_cont 內取用，無法延遲到 notehlight 觸發時。
                if(root.BallController && s.istart){
                  var _m=_findNextMeta(s,rep,ctx)
                  po._ballMeta[s.istart]={
                    durMs:      d * 1000,
                    nextIstart: _m.nextIstart,
                    isJump:     _m.isJump
                  }
                  if(po._ballFirstNote === false){
                    po._ballFirstNote = true
                    root.BallController.onPlayStart(s.istart, st)
                  }
                }
                // ── [ball:meta] end ───────────────────────────────────

              break}}
          while(1){if(!s||s==po.s_end||!s.ts_next||s.ts_next==po.s_end||po.stop){if(po.onend)
              setTimeout(po.onend,(t-now+d)*1000,po.repv)
              po.s_cur=s
              return}
            s=s.ts_next

            // ── [B2] 中途遇到 anchor 時跳轉 ────────────────────────
            // anchor 統一插在音符之前（'before' 模式），內層 while 自然踩到。
            // 跳轉後截斷本批次（return），避免後續音符排進同一 WebAudio batch。
            // po.stim 用「前一個音符的結束時間」計算，不用外層 t
            // （外層 t 在 BAR 推進後已不等於前一個音符的排程時間）。
            if(s._anchor){
              var _w2=JumpEngine.walkAnchors(s,ctx,po.conf.speed)
              if(!_w2.target){if(po.onend)setTimeout(po.onend,(t-now+d)*1000,po.repv);po.s_cur=s;return}
              s=_w2.target
              if(s._tuneStartAnchor||s._segnoAnchor){rep.onDCDSLanding()}
              // 落點音符接在前一個音符結束後
              var _bt=(_lastNoteT!==undefined)?_lastNoteT:t
              var _bd=(_lastNoteD!==undefined)?_lastNoteD:d
              po.stim=(_bt+_bd)-s.ptim/po.conf.speed
              po.s_cur=s
              po._nextT=_bt+_bd
              po._play_cont=play_cont
              po.timouts.push(setTimeout(play_cont,_bd*1000-300,po))
              return}
            // ── [B2] end ─────────────────────────────────────────────

            if(s.part1&&po.i_p!=undefined){s2=s.part1.p_s[++po.i_p]
              if(!s2){s=null
                continue}
              po.stim+=(s.ptim-s2.ptim)/po.conf.speed
              s=s2
              t=po.stim+s.ptim/po.conf.speed
              rep.openNewBlock()}             // [repCtrl] part 切換：重置 repv
            if(!s.noplay)
              break}
          t=po.stim+s.ptim/po.conf.speed
          if(t>maxt)
            break}
        po.s_cur=s
        // ── [pause:save-refs] ─────────────────────────────────────
        // 記錄下一批 play_cont 應觸發的絕對時間，供 pausePlay 計算剩餘等待。
        // 同時把 play_cont 的閉包 reference 存到 po，供 resumePlay 直接呼叫，
        // 不需再透過 abc2svg.play_next 重新進入。
        po._nextT = t;
        po.timouts.push(setTimeout(play_cont,(t-now)*1000
          -300,po))
        po._play_cont = play_cont;}
        // ── [pause:save-refs] end ─────────────────────────────────

        // ── 以下為 snd-1.js 原文（get_part）─────────────────────
        function get_part(po){var s,i,s_p
          for(s=po.s_cur;s;s=s.ts_prev){if(s.parts){po.i_p=-1
            return}
            s_p=s.part1
            if(!s_p||!s_p.p_s)
              continue
            for(i=0;i<s_p.p_s.length;i++){if(s_p.p_s[i]==s){po.i_p=i
              return}}}}

        if(po.stop){if(po.onend)
          po.onend(po.repv)
          return}
        get_part(po)
        po.stim=po.get_time(po)+.3
          -po.s_cur.ptim/po.conf.speed
        po.p_v=[]
        if(!po.repv)
          po.repv=1
        // ── [repCtrl] 強制重建，每首曲子重新初始化 ──────────────
        po.repCtrl = null;
        // ── [repCtrl] end ─────────────────────────────────────────
        play_cont(po)
      };

      abc2svg.play_next._hb_patched = true;
      abc2svg.play_next._orig = orig_play_next;
    }
  };

  // ── 模組導出 ──────────────────────────────────────────────────────
  if (typeof module === 'object' && module.exports) {
    module.exports = HookBridge;
  } else {
    root.HookBridge = HookBridge;
  }

}(typeof globalThis !== 'undefined' ? globalThis : this));
