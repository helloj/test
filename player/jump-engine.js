/**
 * jump-engine.js – DS/DC/Coda/Fine 跳轉引擎
 *
 * 職責：
 *   - 收集 anno_stop 期間的跳轉符（setupHooks）
 *   - 為每首曲子建立 anchor 鏈與 jumpCtx（buildContextForTune）
 *   - 播放前重置 anchor 狀態（resetAllContexts）
 *   - 播放中執行跳轉決策（walkAnchors / handleAnchor）
 *   - 暫停 / 繼續時保存 / 恢復 anchor 快照（suspendPlayback / resumePlayback）
 *
 * 依賴：
 *   - abc2svg.C（常數，透過 abc2svg 全域取得）
 *   - symbol 物件結構（ts_next / ts_prev / ptim / pdur / a_dd 等）
 *   - 零播放器依賴（不引用 play 物件、AudioContext、DOM）
 *
 * 對外接口（8 個公開 API + 1 個內部查詢）：
 *   setupHooks(abc2svg_user)         – 註冊 anno_stop，開始收集跳轉符
 *   buildContextForTune(first)       – 為一首曲子建立 jumpCtx（需在 abcplay.add 之後呼叫）
 *   resetAllContexts()               – 重置所有 ctx 的 anchor 狀態（播放前呼叫）
 *   walkAnchors(s, ctx, repn, speed) – 走過 anchor 鏈，返回 { target, stimDelta }
 *   handleAnchor(s, ctx, repn)       – 單一 anchor 跳轉決策，返回 target symbol 或 null
 *   suspendPlayback(tuneIdx)         – 保存指定 tune 的 anchor 狀態快照
 *   resumePlayback(tuneIdx)          – 恢復指定 tune 的 anchor 狀態快照
 *   reset()                          – 清除所有狀態（doRender 重渲染前呼叫）
 *   getCtxForSym(s)                  – 根據 symbol 查找對應 jumpCtx（供 HookBridge 使用）
 *
 * ══════════════════════════════════════════════════════════════════
 * 動態攔截架構
 * ══════════════════════════════════════════════════════════════════
 *
 * 策略：
 *   1. ToAudio.add() 完成後（ptim 已設定），在每個跳轉/降落 sym
 *      之前插入 0 拍錨點（anchor）。
 *   2. 修補 abc2svg.play_next，在每次走到 anchor 時即時判斷
 *      是否跳轉，並修改 po.s_cur 指向跳轉目標。
 *   3. 錨點帶具名跳轉屬性（jumpDC / jumpDS / jumpCoda / jumpFine），
 *      用完設為 false（disable），天然實現「只跳一次」。
 *   4. Loop / 重播重置時把所有 anchor 恢復初始狀態。
 *
 * 錨點分兩類：
 *   - jump anchor：帶 _jumpAnchor=true，有 jumpDC/jumpDS/jumpCoda/jumpFine
 *   - land anchor：帶 _landAnchor=true，是跳轉目標，無狀態
 *     （tuneStart / segno / coda / fine）
 *
 * per-tune pools（建立後存在 ctx）：
 *   tuneStartAnchor  曲首降落點（唯一）
 *   tuneEndAnchor    曲尾邊界（唯一）
 *   segnoAnchors[]   !segno! 降落點（ptim 去重）
 *   fineAnchors[]    !fine! 降落點（初始 jumpFine=false，由跳轉 enable）
 *   codaAnchors[]    !coda!/O 錨點（按 ptim 排序，ptim 去重）
 *                    - 若在跳轉符之前：分歧點，初始 jumpCoda=false
 *                    - 若在跳轉符之後：降落點，純 land anchor
 *   jumpAnchors[]    所有 jump anchor（loop reset 用）
 *
 * coda 降落標記（_isLanding）：
 *   jump anchor 跳轉時，目標 coda anchor 設 _isLanding=true。
 *   coda anchor 看到 _isLanding 時不執行分歧跳轉，清掉標記繼續往下播。
 *
 * ══════════════════════════════════════════════════════════════════
 */

;(function (root) {
  'use strict';

  // ── 模組私有狀態 ─────────────────────────────────────────────────

  /** istart → symbol：anno_stop 期間收集帶跳轉符的 sym */
  var _allDecoSyms    = {};

  /** 所有已建立的 jumpCtx 列表，供 resetAllContexts 遍歷 */
  var _allJumpCtxList = [];

  /** istart 範圍 → jumpCtx 對照表，供 getCtxForSym 查找 */
  var _tuneCtxMap     = [];

  /** 暫停快照：tuneIdx → snapshot object */
  var _suspendSnapshots = {};

  // ── 跳轉符名稱白名單 ─────────────────────────────────────────────

  var _JUMP_NAMES = {
    'segno':1, 'coda':1, 'fine':1,
    'D.C.':1, 'D.S.':1, 'dacapo':1, 'dacoda':1,
    'D.C.alcoda':1, 'D.S.alcoda':1,
    'D.C.alfine':1, 'D.S.alfine':1
  };

  // ── 內部工具函式（私有）──────────────────────────────────────────

  function _symHasDeco(s, name) {
    var a = s.a_dd;
    if (!a) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] && a[i].name === name) return true;
    }
    return false;
  }

  // ptim 去重輔助：若 arr 中已有相同 ptim 的 anchor 則不重複加入
  function _pushIfNewPtim(arr, a) {
    for (var j = 0; j < arr.length; j++) {
      if (arr[j].ptim === a.ptim) return;
    }
    arr.push(a);
  }

  function _tuneIstartRange(first) {
    var lo = Infinity, hi = -Infinity, s = first;
    while (s) {
      if (s.istart) {
        if (s.istart < lo) lo = s.istart;
        if (s.istart > hi) hi = s.istart;
      }
      s = s.ts_next;
    }
    return lo <= hi ? [lo, hi] : null;
  }

  /**
   * 判斷 jumpSym 是否在某個 repeat 括弧（|: ... :|）內。
   *
   * 方法：往 ts_next 方向掃，找到第一個帶 rep_p 的 BAR（即 :|）。
   *   - rep_p 是 ToAudio.add() 在 :| 上設定的指標，指向對應的 |:。
   *   - 若 rep_p.ptim <= jumpSym.ptim，表示這個 |: 在 jump 之前，
   *     jump 確實落在這對 |: ... :| 括弧內 → 回傳 true。
   *   - 若找不到任何帶 rep_p 的 BAR，或找到的 :| 其 rep_p.ptim > jumpSym.ptim
   *     （屬於更後面的 repeat），→ 回傳 false。
   */
  function _isInsideRepeat(jumpSym) {
    var s = jumpSym.ts_next;
    while (s) {
      if (s.type === abc2svg.C.BAR && s.rep_p) {
        return s.rep_p.ptim <= jumpSym.ptim;
      }
      s = s.ts_next;
    }
    return false;
  }

  /**
   * _insertAnchor(refSym, extra, mode, rangeMin)
   *
   * 統一錨點插入函式，支援三種模式：
   *
   *   'before'     插在 refSym 同 ptim 群組的最前面（多聲部安全）。
   *                回溯時遇到非 anchor 且 ptim 較小的節點即停，
   *                遇到已有 anchor 也停（不穿透），保留呼叫順序。
   *                用於 fine / segno / coda / jump anchor。
   *
   *   'chain-head' 插到整條鏈的最前面（tuneStartAnchor 用）。
   *                ptim 取第一個有 ptim 值的節點。
   *
   *   'chain-tail' 插到整條鏈的最後面（tuneEndAnchor 用）。
   *                ptim 取鏈尾節點的 ptim + pdur。
   */
  function _insertAnchor(refSym, extra, mode, rangeMin) {
    var C = abc2svg.C;
    var anchor = {
      _anchor:  true,
      pdur:     0,
      type:     C.SPACE,
      noplay:   false,
      dur:      0,
      bar_type: '',
      seqst:    true
    };
    if (extra) {
      for (var k in extra) anchor[k] = extra[k];
    }

    var insertBefore;

    if (mode === 'chain-head') {
      // 找插入點：從 refSym 往 ts_prev 走，找到第一個 _anchor 節點，
      // tuneStart 插在它之前，維護 anchor 鏈的正確 ts_prev/ts_next。
      // 若沒有任何 anchor，則插在當前最前面的節點之前。
      var s = refSym;
      while (s && s.ptim === undefined) s = s.ts_next;
      anchor.ptim = s ? s.ptim : 0;
      anchor.v    = refSym.v;
      anchor.p_v  = refSym.p_v;

      var cur = refSym;
      var firstAnchor = null;
      while (cur.ts_prev) {
        cur = cur.ts_prev;
        if (cur._anchor) { firstAnchor = cur; break; }
      }
      insertBefore = firstAnchor || cur;

    } else if (mode === 'chain-tail') {
      var last = refSym;
      while (last.ts_next) last = last.ts_next;
      anchor.ptim  = last.ptim + (last.pdur || 0);
      anchor.v     = last.v;
      anchor.p_v   = last.p_v;
      anchor.ts_prev = last;
      anchor.ts_next = null;
      last.ts_next   = anchor;
      return anchor;

    } else {
      // mode === 'before'：插在 refSym 同 ptim 群組最前面
      // 回溯停止條件（優先順序由上至下）：
      //   1. 遇到 _tuneStartAnchor：絕對起點，不往前插
      //   2. 遇到已有 anchor：保持呼叫順序
      //   3. 遇到 tune 範圍外節點（istart < rangeMin）：不穿越邊界
      //   4. 遇到 ptim 更早的節點：停在它後面
      //   5. 遇到真正的 BAR（bar_type 非空）：停在它後面
      var ptim = refSym.ptim;
      anchor.ptim   = ptim;
      anchor.time   = refSym.time;
      anchor.v      = refSym.v;
      anchor.p_v    = refSym.p_v;
      anchor.istart = refSym.istart;

      var insertAfter = refSym.ts_prev;
      var cur = refSym.ts_prev;
      while (cur) {
        if (cur._tuneStartAnchor) {
          insertAfter = cur;
          break;
        }
        if (cur._anchor) {
          insertAfter = cur;
          break;
        }
        if (rangeMin !== undefined && cur.istart !== undefined && cur.istart < rangeMin) {
          insertAfter = cur;
          break;
        }
        if (cur.ptim === undefined || cur.ptim < ptim) {
          insertAfter = cur;
          break;
        }
        if (cur.bar_type) {
          insertAfter = cur;
          break;
        }
        insertAfter = cur.ts_prev;
        cur = cur.ts_prev;
      }

      if (insertAfter) {
        insertBefore = insertAfter.ts_next;
      } else {
        insertBefore = refSym;
        while (insertBefore.ts_prev) insertBefore = insertBefore.ts_prev;
      }
    }

    // 通用插入：anchor 插在 insertBefore 之前
    var prev = insertBefore ? insertBefore.ts_prev : null;
    anchor.ts_prev = prev;
    anchor.ts_next = insertBefore;
    if (prev) prev.ts_next = anchor;
    if (insertBefore) insertBefore.ts_prev = anchor;
    return anchor;
  }

  /**
   * 掃描 tune，建立所有錨點，回傳 jumpCtx。
   * anchor 插入順序依照 a_dd 書寫順序（每個 sym 的 deco 依序插入）。
   * segnoAnchors / codaAnchors 以 ptim 去重，避免多聲部重複。
   */
  function _buildJumpCtx(first) {
    var range = _tuneIstartRange(first);
    if (!range) return null;

    // 收集屬於此 tune 的 deco sym，按 istart 排序
    var decoList = [];
    var keys = Object.keys(_allDecoSyms).map(Number).sort(function(a,b){return a-b;});
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] >= range[0] && keys[i] <= range[1])
        decoList.push(_allDecoSyms[keys[i]]);
    }

    // 判斷是否有任何跳轉裝飾
    var hasJump = decoList.some(function(s) {
      return _symHasDeco(s,'D.C.') || _symHasDeco(s,'D.S.') ||
             _symHasDeco(s,'dacapo') || _symHasDeco(s,'dacoda') ||
             _symHasDeco(s,'D.C.alcoda') || _symHasDeco(s,'D.S.alcoda') ||
             _symHasDeco(s,'D.C.alfine') || _symHasDeco(s,'D.S.alfine');
    });
    if (!hasJump) return null;

    // 曲尾錨點先插（鏈尾，不影響其他 anchor 的插入順序）
    var tuneEndAnchor = _insertAnchor(first, { _landAnchor: true, _tuneEndAnchor: true }, 'chain-tail');

    var segnoAnchors = [];
    var fineAnchors  = [];
    var codaAnchors  = [];
    var jumpAnchors  = [];

    // 依照 a_dd 書寫順序插入 anchor（同一 sym 上多個 deco 保持原始順序）
    // _findMainChainRef：從 first 往 ts_next 找第一個 ptim === targetPtim 的節點，
    // 確保插入參考點一定在主鏈上，不依賴 ts_prev 回溯。
    function _findMainChainRef(targetPtim) {
      var s = first;
      while (s) {
        if (s.ptim === targetPtim && !s._anchor) return s;
        s = s.ts_next;
      }
      return null;
    }

    decoList.forEach(function(s) {
      if (!s.a_dd) return;
      for (var i = 0; i < s.a_dd.length; i++) {
        var name = s.a_dd[i] && s.a_dd[i].name;
        if (!name) continue;

        if (name === 'segno') {
          var ref = _findMainChainRef(s.ptim) || s;
          var a = _insertAnchor(ref, { _landAnchor: true, _segnoAnchor: true }, 'before', range[0]);
          _pushIfNewPtim(segnoAnchors, a);
        }

        if (name === 'fine') {
          var ref = _findMainChainRef(s.ptim) || s;
          var a = _insertAnchor(ref, { _landAnchor: true, _fineAnchor: true, jumpFine: false }, 'before', range[0]);
          _pushIfNewPtim(fineAnchors, a);
        }

        if (name === 'coda') {
          var ref = _findMainChainRef(s.ptim) || s;
          var a = _insertAnchor(ref, { _codaAnchor: true, jumpCoda: false }, 'before', range[0]);
          _pushIfNewPtim(codaAnchors, a);
        }

        var isDC     = name === 'D.C.'       || name === 'dacapo';
        var isDS     = name === 'D.S.';
        var isDCcoda = name === 'D.C.alcoda' || name === 'dacoda';
        var isDScoda = name === 'D.S.alcoda';
        var isDCfine = name === 'D.C.alfine';
        var isDSfine = name === 'D.S.alfine';
        var isAnyJump = isDC || isDS || isDCcoda || isDScoda || isDCfine || isDSfine;
        if (isAnyJump) {
          var inRepeat = _isInsideRepeat(s);
          var extra = {
            _jumpAnchor: true,
            _inRepeat:   inRepeat,
            _isDC:       isDC  || isDCcoda || isDCfine,
            _isDS:       isDS  || isDScoda || isDSfine,
            jumpDC:   (isDC   || isDCcoda || isDCfine) && !inRepeat,
            jumpDS:   (isDS   || isDScoda || isDSfine) && !inRepeat,
            jumpCoda: isDCcoda || isDScoda,
            jumpFine: false,
            _init: {
              jumpDC:   (isDC   || isDCcoda || isDCfine) && !inRepeat,
              jumpDS:   (isDS   || isDScoda || isDSfine) && !inRepeat,
              jumpCoda: isDCcoda || isDScoda,
              jumpFine: false
            }
          };
          var ref = _findMainChainRef(s.ptim) || s;
          var a = _insertAnchor(ref, extra, 'before', range[0]);
          if (jumpAnchors.indexOf(a) < 0) jumpAnchors.push(a);
        }
      }
    });

    // tuneStartAnchor 最後插入，找 tune range 內的第一個節點之前插入，
    // 不走到絕對鏈頭，避免把已插好的 fine/segno anchor 甩出鏈外。
    var tuneStartAnchor = _insertAnchor(first, { _landAnchor: true, _tuneStartAnchor: true }, 'chain-head', range[0]);

    // 按 ptim 排序 codaAnchors
    codaAnchors.sort(function(a,b) { return a.ptim - b.ptim; });

    var ctx = {
      range:           range,
      tuneStartAnchor: tuneStartAnchor,
      tuneEndAnchor:   tuneEndAnchor,
      segnoAnchors:    segnoAnchors,
      fineAnchors:     fineAnchors,
      codaAnchors:     codaAnchors,
      jumpAnchors:     jumpAnchors,
      _fineInitState:  fineAnchors.map(function(a)  { return a.jumpFine; }),
      _codaInitState:  codaAnchors.map(function(a)  { return a.jumpCoda; })
    };
    return ctx;
  }

  /**
   * _getIdxForSym(s)  【私有】
   *
   * 根據 symbol 的 istart 範圍在 _tuneCtxMap 中查找對應的索引。
   * 邏輯與 getCtxForSym 相同，但回傳整數 index 而非 ctx 物件。
   * 僅供 suspendPlayback / resumePlayback 內部使用，不對外暴露。
   *
   * anchor symbol 本身沒有 istart（插入時未設定），需向 ts_next 找第一個有
   * istart 的節點來定位所屬 tune 範圍。
   *
   * @param  {symbol} s - 任意 symbol（通常為 po.s_cur）
   * @return {number}   _tuneCtxMap 中的索引，找不到回傳 -1
   */
  function _getIdxForSym(s) {
    if (!s) return -1;
    var istart = s.istart;
    if (!istart) {
      var t = s.ts_next;
      while (t && !t.istart) t = t.ts_next;
      istart = t && t.istart;
    }
    if (!istart) return -1;
    for (var i = 0; i < _tuneCtxMap.length; i++) {
      var e = _tuneCtxMap[i];
      if (istart >= e.range[0] && istart <= e.range[1]) return i;
    }
    return -1;
  }

  // ── 公開 API ──────────────────────────────────────────────────────

  var JumpEngine = {

    /**
     * setupHooks(user)
     *
     * 將 anno_stop 的 deco 收集邏輯注入 abc2svg.user。
     * 必須在 abc.tosvg() 之前呼叫（由 dom_loaded 呼叫）。
     * 採用包裝模式：保留 user 上既有的 anno_stop，在 deco 分支處理後
     * 繼續呼叫原始 handler，確保 note/rest/grace 的高亮矩形繪製不受影響。
     *
     * @param {object} user - abc2svg.user 物件（直接修改其 anno_stop）
     */
    setupHooks: function (user) {
      var _origAnnoStop = user.anno_stop;
      user.anno_stop = function (type, start, stop, x, y, w, h, s) {
        if (type === 'deco') {
          if (s && s.a_dd) {
            for (var i = 0; i < s.a_dd.length; i++) {
              if (s.a_dd[i] && _JUMP_NAMES[s.a_dd[i].name]) {
                _allDecoSyms[s.istart] = s; break;
              }
            }
          }
          return;
        }
        // 非 deco 類型：繼續呼叫原始 handler（note/rest/grace 高亮矩形）
        if (_origAnnoStop) _origAnnoStop.apply(this, arguments);
      };
    },

    /**
     * buildContextForTune(first)
     *
     * 為一首曲子建立完整的 jumpCtx（錨點鏈 + 狀態池）。
     * 必須在 abcplay.add(tuneFirst, ...) 之後呼叫（ptim 需已設定）。
     * 若此曲無跳轉符，返回 null（first._jumpCtx 保持 null）。
     *
     * 同時：
     *   - 在 first._jumpCtx 和 ctx.tuneStartAnchor._jumpCtx 掛載 ctx
     *   - 登記到 _allJumpCtxList 和 _tuneCtxMap
     *   - 在 ctx 上掛載 reset() 方法
     *
     * @param  {symbol} first - 曲子的第一個 symbol（abc.tunes[i][0]）
     * @return {object|null}  jumpCtx 或 null
     */
    buildContextForTune: function (first) {
      if (!first || first._jumpCtx !== undefined) return first ? first._jumpCtx : null;
      first._jumpCtx = null;

      var ctx = _buildJumpCtx(first);
      if (!ctx) return null;

      // 雙向掛載：讓 HookBridge 可從 first 或 tuneStartAnchor 快速取得 ctx
      ctx.tuneStartAnchor._jumpCtx = ctx;
      first._jumpCtx = ctx;

      // 登記到模組狀態，供 resetAllContexts / getCtxForSym 使用
      _allJumpCtxList.push(ctx);
      _tuneCtxMap.push({ range: ctx.range, ctx: ctx });

      // 掛載 reset()：還原所有 anchor 到初始狀態
      ctx.reset = function() {
        ctx.jumpAnchors.forEach(function(a) {
          if (!a._init) return;
          a.jumpDC   = a._init.jumpDC;
          a.jumpDS   = a._init.jumpDS;
          a.jumpCoda = a._init.jumpCoda;
          a.jumpFine = a._init.jumpFine;
        });
        ctx.fineAnchors.forEach(function(a, i) {
          a.jumpFine = ctx._fineInitState[i];
        });
        ctx.codaAnchors.forEach(function(a, i) {
          a.jumpCoda   = ctx._codaInitState[i];
          a._isLanding = false;
        });
      };

      return ctx;
    },

    /**
     * resetAllContexts()
     *
     * 將所有 jumpCtx 的 anchor 狀態還原為初始值。
     * 在 playStart() 開始播放前呼叫（對應 loader.js _resetAllJumpCtx）。
     */
    resetAllContexts: function () {
      _allJumpCtxList.forEach(function(ctx) { ctx.reset(); });
    },

    /**
     * walkAnchors(s, ctx, repn, speed)
     *
     * 走過連續 anchor 鏈，執行跳轉直到落在非 anchor 節點。
     * 若落點是 tuneEndAnchor，target 為 null 表示應結束播放。
     *
     * API 差異（相對 loader.js _walkAnchors）：
     *   原版直接修改 po.stim；新版改為回傳 stimDelta，
     *   由 HookBridge 的 play_cont 複本負責 po.stim += stimDelta，
     *   使 JumpEngine 對 po 完全零依賴。
     *
     * @param  {symbol}  s     - 起始 anchor symbol
     * @param  {object}  ctx   - jumpCtx
     * @param  {boolean} repn  - po.repn 的當前值
     * @param  {number}  speed - po.conf.speed（播放速度倍率）
     * @return {{ target: symbol|null, stimDelta: number }}
     */
    walkAnchors: function (s, ctx, repn, speed) {
      var stimDelta = 0;
      var limit = 20;
      while (s && s._anchor && limit-- > 0) {
        if (s._tuneEndAnchor) return { target: null, stimDelta: stimDelta };
        var target = JumpEngine.handleAnchor(s, ctx, repn);
        if (target) {
          stimDelta += (s.ptim - target.ptim) / speed;
          if (target._codaAnchor) target._isLanding = true;  // 標記降落
          s = target;
        } else {
          s = s.ts_next;
        }
      }
      if (!s || s._tuneEndAnchor) return { target: null, stimDelta: stimDelta };
      return { target: s, stimDelta: stimDelta };
    },

    /**
     * handleAnchor(s, ctx, repn)
     *
     * 單一 anchor 跳轉決策。
     * 返回跳轉目標 symbol，或 null（不跳轉，繼續往下）。
     *
     * API 差異（相對 loader.js _handleAnchor）：
     *   原版傳入 po 以讀取 po.repn；新版只傳 repn 值，消除對 po 的依賴。
     *
     * @param  {symbol}  s    - anchor symbol
     * @param  {object}  ctx  - jumpCtx
     * @param  {boolean} repn - po.repn 的當前值
     * @return {symbol|null}
     */
    handleAnchor: function (s, ctx, repn) {
      if (!ctx) return null;
      var target = null;

      if (s._jumpAnchor) {
        // 若 anchor 在 repeat 括弧內，且目前是第一次 pass
        // （repn === false 表示尚未回彈過，即還在第一次通過），
        // 則 enable 而不跳，等第二次路過再執行跳轉。
        if (s._inRepeat && !repn) {
          if (s._isDC) s.jumpDC = true;
          if (s._isDS) s.jumpDS = true;
          return null;  // 第一次：pass，不跳
        }

        if (s.jumpDC) {
          s.jumpDC = false;
          ctx.fineAnchors.forEach(function(a) { a.jumpFine = true; });
          // enable 所有在重播段內（曲首到 jump 之前）的 coda anchor
          ctx.codaAnchors.forEach(function(a) {
            if (a.ptim < s.ptim) {
              a.jumpCoda = true;
            }
          });
          target = ctx.tuneStartAnchor;

        } else if (s.jumpDS) {
          s.jumpDS = false;
          ctx.fineAnchors.forEach(function(a) { a.jumpFine = true; });
          // enable 所有在重播段內（segno 到 jump 之前）的 coda anchor
          var segPtim = (ctx.segnoAnchors[0] || ctx.tuneStartAnchor).ptim;
          ctx.codaAnchors.forEach(function(a) {
            if (a.ptim >= segPtim && a.ptim < s.ptim) {
              a.jumpCoda = true;
            }
          });
          target = ctx.segnoAnchors[0] || ctx.tuneStartAnchor;

        } else if (s.jumpCoda) {
          s.jumpCoda = false;
          // 找 codaAnchors 裡第一個 ptim >= s.ptim 的降落點
          var landCoda = null;
          for (var i = 0; i < ctx.codaAnchors.length; i++) {
            if (ctx.codaAnchors[i].ptim >= s.ptim) { landCoda = ctx.codaAnchors[i]; break; }
          }
          target = landCoda || ctx.tuneEndAnchor;
        }

      } else if (s._codaAnchor && s.jumpCoda) {
        if (s._isLanding) {
          s._isLanding = false;  // 降落標記：消耗後繼續往下播，不跳轉
        } else {
          s.jumpCoda = false;
          // 找下一個 coda anchor（ptim 嚴格大於自身）
          var landCoda = null;
          for (var i = 0; i < ctx.codaAnchors.length; i++) {
            if (ctx.codaAnchors[i].ptim > s.ptim) { landCoda = ctx.codaAnchors[i]; break; }
          }
          target = landCoda || ctx.tuneEndAnchor;
        }

      } else if (s._fineAnchor && s.jumpFine) {
        s.jumpFine = false;
        target = ctx.tuneEndAnchor;
      }

      return target;
    },

    /**
     * suspendPlayback(s)
     *
     * 保存指定 tune 的 anchor 狀態快照（pausePlay 時呼叫）。
     * 快照所有 jumpXxx 布林值，確保 resume 後狀態完整還原。
     *
     * tune 索引由內部 _getIdxForSym(s) 查找，呼叫端只需傳入 po.s_cur。
     *
     * @param {symbol} s - 當前播放位置的 symbol（po.s_cur）
     */
    suspendPlayback: function (s) {
      var tuneIdx = _getIdxForSym(s);
      if (tuneIdx < 0) return;
      var entry = _tuneCtxMap[tuneIdx];
      if (!entry) return;
      var ctx = entry.ctx;

      _suspendSnapshots[tuneIdx] = {
        jumpAnchors: ctx.jumpAnchors.map(function(a) {
          return { jumpDC: a.jumpDC, jumpDS: a.jumpDS, jumpCoda: a.jumpCoda, jumpFine: a.jumpFine };
        }),
        fineAnchors: ctx.fineAnchors.map(function(a) {
          return { jumpFine: a.jumpFine };
        }),
        codaAnchors: ctx.codaAnchors.map(function(a) {
          return { jumpCoda: a.jumpCoda, _isLanding: a._isLanding };
        })
      };
    },

    /**
     * resumePlayback(s)
     *
     * 恢復指定 tune 的 anchor 狀態快照（resumePlay 時呼叫）。
     *
     * tune 索引由內部 _getIdxForSym(s) 查找，呼叫端只需傳入 po.s_cur。
     *
     * @param {symbol} s - 當前播放位置的 symbol（po.s_cur）
     */
    resumePlayback: function (s) {
      var tuneIdx = _getIdxForSym(s);
      if (tuneIdx < 0) return;
      var snapshot = _suspendSnapshots[tuneIdx];
      if (!snapshot) return;
      var entry = _tuneCtxMap[tuneIdx];
      if (!entry) return;
      var ctx = entry.ctx;

      ctx.jumpAnchors.forEach(function(a, i) {
        if (!snapshot.jumpAnchors[i]) return;
        a.jumpDC   = snapshot.jumpAnchors[i].jumpDC;
        a.jumpDS   = snapshot.jumpAnchors[i].jumpDS;
        a.jumpCoda = snapshot.jumpAnchors[i].jumpCoda;
        a.jumpFine = snapshot.jumpAnchors[i].jumpFine;
      });
      ctx.fineAnchors.forEach(function(a, i) {
        if (!snapshot.fineAnchors[i]) return;
        a.jumpFine = snapshot.fineAnchors[i].jumpFine;
      });
      ctx.codaAnchors.forEach(function(a, i) {
        if (!snapshot.codaAnchors[i]) return;
        a.jumpCoda   = snapshot.codaAnchors[i].jumpCoda;
        a._isLanding = snapshot.codaAnchors[i]._isLanding;
      });

      delete _suspendSnapshots[tuneIdx];
    },

    /**
     * reset()
     *
     * 清除所有模組內部狀態。
     * 在 doRender 重新渲染前呼叫，對應 loader.js doRender 中：
     *   _allDecoSyms = {}; _allJumpCtxList = []; _tuneCtxMap = [];
     */
    reset: function () {
      _allDecoSyms      = {};
      _allJumpCtxList   = [];
      _tuneCtxMap       = [];
      _suspendSnapshots = {};
    },

    /**
     * getCtxForSym(s)
     *
     * 根據 symbol 的 istart 範圍查找對應的 jumpCtx。
     * 供 HookBridge 在 play_next 首次進入時使用（懶查找模式）。
     *
     * @param  {symbol}      s - 任意 symbol（可為 anchor 或普通 sym）
     * @return {object|null}   jumpCtx 或 null
     */
    getCtxForSym: function (s) {
      if (!s) return null;
      var istart = s.istart;
      if (!istart) {
        var t = s.ts_next;
        while (t && !t.istart) t = t.ts_next;
        istart = t && t.istart;
      }
      if (!istart) return null;
      for (var i = 0; i < _tuneCtxMap.length; i++) {
        var e = _tuneCtxMap[i];
        if (istart >= e.range[0] && istart <= e.range[1]) return e.ctx;
      }
      return null;
    }

  };

  // ── 模組導出 ──────────────────────────────────────────────────────
  if (typeof module === 'object' && module.exports) {
    module.exports = JumpEngine;           // Node.js / CommonJS
  } else {
    root.JumpEngine = JumpEngine;          // 瀏覽器全域
  }

}(typeof globalThis !== 'undefined' ? globalThis : this));
