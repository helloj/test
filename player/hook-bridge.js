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
 *     [B1]              play_cont 推進迴圈前：起點落在 anchor 時走過
 *                       + DC/DS 跳轉後重置 po.repn=false / po.repv=1（慣例 A）
 *     [B2]              play_cont 內層 while：中途遇到 anchor 時跳轉
 *                       + DC/DS 跳轉後重置 po.repn=false / po.repv=1（慣例 A）
 *     [pause:reset-timouts]  po.timouts=[] 之後，重置 po._onnoteTimouts
 *     [pause:track-onnote]   onnote on/off setTimeout 改存入 po._onnoteTimouts
 *     [pause:save-refs]      play_cont 排程前記錄 po._nextT；結尾存 po._play_cont
 *     [ball:meta]            填入 po._ballMeta[i] = { durMs, nextIstart }
 *                            nextIstart 查找邏輯內聯在 [ball:meta] 區塊內
 *                            第一個音符時直接呼叫 BallController.onPlayStart（需要 st）
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

  // ── HookBridge.setup() ───────────────────────────────────────────
  //
  // 唯一的公開入口。由 loader.js 的 Section 3 位置呼叫（頁面載入時立即執行）。
  // 執行後 abc2svg.play_next 被完整替換；orig_play_next 存底以備不時之需。
  //
  var HookBridge = {

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

        // ── 無跳轉：直接呼叫原版，完全不介入 ─────────────────────
        if (!ctx) {
          ctx = null;
        }

        // ── [ball:meta] init ──────────────────────────────────────
        // 每次 play_next 入口重置，確保循環播放時第一個音符可重新觸發。
        if (!po._ballFirstNote) {
          po._ballFirstNote = false;  // false = 尚未通知 onPlayStart
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

        // ── 以下為 snd-1.js 原文（play_cont）+ [GEN][B1][B2][pause:*][ball:*] patch ──
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

          function var_end(s){var i,s2,s3,a=s.rep_v||s.rep_s
            var ti=0
            for(i=1;i<a.length;i++){s2=a[i]
              if(s2.time>ti){ti=s2.time
                s3=s2}}
            for(s=s3;s!=po.s_end;s=s.ts_next){if(s.time==ti)
              continue
              if(s.rbstop==2)
                break}
            po.repv=1
            return s}
          while(s.noplay){s=s.ts_next
            if(!s||s==po.s_end){if(po.onend)
              po.onend(po.repv)
              return}}

          // ── [B1] 起點落在 anchor 時走過並取得落點 ────────────────
          if(s._anchor){
            var _w1=JumpEngine.walkAnchors(s,ctx,po.repn,po.conf.speed)
            if(!_w1.target){if(po.onend)po.onend(po.repv);return}
            po.stim+=_w1.stimDelta
            s=_w1.target
            // 慣例 A：DC/DS 跳回曲首或 segno 時，重置 repeat 狀態，
            // 讓 repeat 從頭計數（volta bracket 從 1 房重走）。
            // coda/fine 跳轉方向為前進，不重置。
            if(s._tuneStartAnchor||s._segnoAnchor){po.repn=false;po.repv=1}
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

          while(1){switch(s.type){case C.BAR:s2=null
            if(s.rep_p){po.repv++
              if(!po.repn&&(!s.rep_v||po.repv<=s.rep_v.length)){s2=s.rep_p
                po.repn=true}else{if(s.rep_v)
                s2=var_end(s)
                po.repn=false
                if(s.bar_type.slice(-1)==':')
                  po.repv=1
                }}
            if(s.rep_s){s2=s.rep_s[po.repv]
              if(s2){po.repn=false
                if(s2==s)
                  s2=null}else{s2=var_end(s)
                if(s2==po.s_end)
                  break}}
            if(s.bar_type.slice(-1)==':'&&s.bar_type[0]!=':')
              po.repv=1
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
                // 填入 _ballMeta，供 BallController.onNoteOn 取用（由 abcplay-driver 呼叫）。
                // 第一個音符在此直接呼叫 onPlayStart：
                //   st = (t-now)*1000 是「on=true 距現在的 ms」，僅在排程階段有意義，
                //   必須在 play_cont 內取用，無法延遲到 notehlight 觸發時。
                if(root.BallController && s.istart){
                  if(!po._ballMeta) po._ballMeta={}
                  // findNextIstart：從 s.ts_next 找第一個有 istart 的可播音符
                  var _bnext=s.ts_next
                  while(_bnext){
                    if(!_bnext.noplay&&_bnext.istart&&
                       (_bnext.type===C.NOTE||_bnext.type===C.REST||_bnext.type===C.GRACE))
                      break
                    _bnext=_bnext.ts_next}
                  po._ballMeta[s.istart]={
                    durMs:      d * 1000,
                    nextIstart: _bnext ? _bnext.istart : null
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
            if(s._anchor){
              var _w2=JumpEngine.walkAnchors(s,ctx,po.repn,po.conf.speed)
              if(!_w2.target){if(po.onend)setTimeout(po.onend,(t-now+d)*1000,po.repv);po.s_cur=s;return}
              po.stim+=_w2.stimDelta
              s=_w2.target
              // 慣例 A：DC/DS 跳回曲首或 segno 時，重置 repeat 狀態，
              // 讓 repeat 從頭計數（volta bracket 從 1 房重走）。
              // coda/fine 跳轉方向為前進，不重置。
              if(s._tuneStartAnchor||s._segnoAnchor){po.repn=false;po.repv=1}
              t=po.stim+s.ptim/po.conf.speed
              break}  // 跳出內層 while，讓外層重新從落點開始處理
            // ── [B2] end ─────────────────────────────────────────────

            if(s.part1&&po.i_p!=undefined){s2=s.part1.p_s[++po.i_p]
              if(!s2){s=null
                continue}
              po.stim+=(s.ptim-s2.ptim)/po.conf.speed
              s=s2
              t=po.stim+s.ptim/po.conf.speed
              po.repv=1}
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
