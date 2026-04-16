/**
 * ball-controller.js – 卡拉 OK 跳動小球
 *
 * Copyright (C) 2024-2026 Helloj
 *
 * This file is part of AbcDrill
 *
 * AbcDrill is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * ──────────────────────────────────────────────────────────────────────
 *
 * 職責：
 *   在播放期間，用一顆跳動的小球標示目前演奏位置，模擬卡拉 OK 效果。
 *
 * 動畫引擎：requestAnimationFrame 狀態機
 *   - 每幀計算進度，套拋物線公式
 *   - pause 時記錄 pausedProgress，小球停在半空中
 *   - resume 時重算 segStart，從半空中繼續飛行
 *
 * 座標策略（方案 A：scroll/resize 持續 snap）：
 *   - _livePos{}：只存「活躍 istart」（最多 2~3 個）的 viewport 座標快照
 *   - _tick 直接讀此表，零 DOM query
 *   - scroll/resize 事件驅動更新，非每幀查詢
 *
 * 小球生命週期：
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ drop_wait      曲首球靜止在第一音符正上方，等待 leadTimeout    │
 *   │   ↓ 提前 LEAD_MS 開始直線掉落                                 │
 *   │ flying         飛向目標音符                                    │
 *   │   ↓ on=true 落地，立刻以 dur 為時長起飛                       │
 *   │ flying         飛向 next（同行 / 換行 / 跳躍 / 曲尾）         │
 *   │   ↓ 換行 / isJump：原地上升（stopAt=0.5）→ wrapPending=true   │
 *   │       → 完成 → _preHighlightNote + 目標正上方掉落             │
 *   │   ↓ isAtB：完整拋物線原地跳（stopAt=1.0）→ idle_at_note       │
 *   │   ↓ 曲尾：飛向右邊界 → done（淡出）                          │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * 與現有模組的接點：
 *   - hook-bridge.js：po._ballMeta[istart] = { durMs, nextIstart }
 *   - abcplay-driver.js：playStart / pausePlay / resumePlay / onPlaybackEnd
 *   - loader.js：doRender 完成後呼叫 BallController.init()
 *
 * 依賴（全域）：abc2svg._current_po（取得 _ballMeta）
 */

;(function (root) {
  'use strict';

  // ══════════════════════════════════════════
  // 常數
  // ══════════════════════════════════════════

  var BALL_R      = 6;      // 小球半徑（px）
  var LEAD_MS     = 100;    // 第一個音符掉落動畫時長（ms）
  var BOUNCE_H    = 28;     // 跳躍弧高（px，拋物線頂點相對於端點的高度）
  var FADE_MS     = 600;    // 曲尾淡出時間（ms）
  var ROW_THRESH  = 20;     // 換行判斷閾值（px，兩音符 DOM Y 差距超過此值視為換行）
  var BALL_COLOR  = 'rgba(220, 60, 60, 0.85)';  // 小球顏色
  var BALL_Z      = '1000'; // z-index

  // 換行 / 跳躍時長分配比例
  var WRAP_UP_RATIO   = 1 / 4;    // 第一段：（快速跳起）
  var WRAP_DOWN_RATIO = 3 / 4;    // 第二段：（從容掉落）
  var WRAP_BOUNCE_H   = BOUNCE_H; // 換行起跳弧高（px），比一般 BOUNCE_H 高，視覺更顯眼

  // ══════════════════════════════════════════
  // 模組私有狀態
  // ══════════════════════════════════════════

  var _canvas = null;
  var _ctx    = null;
  var _rafId  = null;

  /**
   * 活躍音符座標快照：istart → { cx, cy }
   * 只存當前飛行相關的 2~3 個 istart。_tick 讀此表，零 DOM query。
   */
  var _livePos = {};

  /**
   * 當前需要追蹤的 istart 列表（最多 3 個）。
   */
  var _activeIstarts = [];

  /**
   * 有效 istart 快取：Set<istart>
   * 第一次查 querySelector，之後直接查快取。
   */
  var _validIstarts = new Set();  // Set<istart>，已知有 DOM 的 istart

  /**
   * 小球狀態機
   *
   * state:
   *   'idle'         - 停止，不顯示
   *   'drop_wait'    - 球靜止在第一音符正上方，等待掉落
   *   'flying'       - 拋物線飛行中（含第一音符直線掉落）
   *   'idle_at_note' - 停在音符上等待下一個 on=true
   *   'done'         - 曲尾淡出
   */
  var _ball = {
    state:      'idle',

    // ── 飛行段（flying）──────────────────────────────────────────
    fromX:      0,      // 起點 X（viewport 座標，從 _livePos 取）
    fromY:      0,      // 起點 Y
    toX:        0,      // 終點 X（從 _livePos 取，scroll 時自動更新）
    toY:        0,      // 終點 Y
    segStart:   0,      // 本段開始的 performance.now()（ms）
    segDur:     0,      // 本段持續時長（ms）
    arcH:       BOUNCE_H, // 拋物線弧高（px）

    // ── 飛行目標 istart（供 scroll 更新活躍列表 / _livePos 用）──
    _currentToIstart: null,  // 當前飛行終點的 istart；null = 邊界點

    // ── 換行 / 跳躍緩衝 ────────────────────────────────────────
    // 換行（isWrap）與跳躍（isJump）的第二段（掉落）共用此緩衝。
    // isJump 的 wrapToIstart 由 hook-bridge [ball:jump-patch] 在
    // play_cont 同批次修補為實際跳轉後的第一個音符，與換行路徑完全對稱。
    wrapPending:  false, // 是否有待執行的第二段掉落
    wrapToIstart: null,  // 第二段的目標 istart
    wrapDur:      0,     // 第二段的持續時長（ms）

    // ── 第一音符掉落與 drop_wait ─────────────────────────────────
    _firstIstart: null,  // 第一個音符的 istart（drop_wait / onResume 用）

    // ── 第一音符掉落（drop）──────────────────────────────────────
    // 掉落起點 Y = 第一音符 Y - BOUNCE_H（音符正上方弧高處）
    // 掉落期間 state = 'flying'，arcH = 0（直線掉落）
    dropFromY:    0,     // 掉落起點 Y，供 pause 時 idle_at_drop 重繪用

    // ── 飛行段提前完成（stopAt）────────────────────────────────
    // 預設 1.0（跑完整段）；換行第一段設 0.5（只跑拋物線上升半段）
    stopAt:     1.0,

    // ── pause 快照 ────────────────────────────────────────────
    pausedProgress: -1, // -1 = 未暫停；0~1 = 暫停時的進度

    // ── 曲尾標記 ────────────────────────────────────────────────
    _afterFlyToDone: false,

    // ── 淡出（done）─────────────────────────────────────────────
    fadeStart:  0,

    // ── leadTimeout 輔助 ─────────────────────────────────────────
    _leadDelay: 0       // onPlayStart 排程的 leadDelay（ms），供 onResume 計算剩餘
  };

  /** 是否已完成第一個音符的提前起飛（避免重複排程） */
  var _firstNoteScheduled = false;
  /** 第一個音符的提前起飛 setTimeout ID */
  var _leadTimeoutId      = null;
  /** onPause 時若 leadTimeout 尚未觸發，記錄剩餘等待 ms 供 onResume 補排 */
  var _leadPausedAt       = -1;   // performance.now() 快照，-1 = 未暫停
  var _leadScheduledAt    = -1;   // leadTimeout 排程時的 performance.now()

  // ══════════════════════════════════════════
  // 內部工具函式
  // ══════════════════════════════════════════

  /**
   * _svgLeftEdge() - 取第一個 abc-slot SVG 的左邊界 X（DOM 座標）
   * 若無 SVG，回傳 BALL_R。
   */
  function _svgLeftEdge() {
    var svg = document.querySelector('.abc-slot svg, #target svg');
    if (!svg) return BALL_R;
    return svg.getBoundingClientRect().left;
  }

  /**
   * _svgRightEdge() - 取最後一個可見 SVG 的右邊界 X（DOM 座標）
   * 曲尾小球飛到此處停止。
   */
  function _svgRightEdge() {
    var svgs = document.querySelectorAll('.abc-slot svg, #target svg');
    if (!svgs.length) return window.innerWidth - BALL_R;
    return svgs[svgs.length - 1].getBoundingClientRect().right;
  }

  /**
   * _getNotePos(istart) - 即時查詢音符的 viewport 座標
   */
  function _getNotePos(istart) {
    if (!istart) return null;
    // [多 rect] 同一 istart 可能對應多個 .abcr（如簡譜 + 五線譜雙系統）。
    // 與 setNoteOp（UIController）保持一致，使用 getElementsByClassName 取第一個元素，
    // 確保球的 X 座標來源與 playline 定位使用的是同一個 rect。
    var elts = document.getElementsByClassName('_' + istart + '_');
    if (!elts || !elts.length) return null;
    var r = elts[0].getBoundingClientRect();
    return {
      cx: r.left + BALL_R * 2,
      cy: r.top  + r.height / 2
    };
  }

  /**
   * _setActiveIstarts(istarts) - 登記活躍 istart，重查座標
   * 快取優化：已知有 DOM 的 istart 直接查詢；新 istart 才查 querySelector。
   */
  function _setActiveIstarts(istarts) {
    _activeIstarts = istarts;
    for (var i = 0; i < istarts.length; i++) {
      var istart = istarts[i];
      if (_validIstarts.has(istart)) {
        var pos = _livePos[istart];
        if (!pos) _livePos[istart] = _getNotePos(istart);
      } else {
        var pos2 = _getNotePos(istart);
        if (pos2) {
          _validIstarts.add(istart);
          _livePos[istart] = pos2;
        }
      }
    }
  }

  /**
   * _refreshLivePos(fromScroll) - 重查活躍 istart 座標
   * scroll/resize 時更新座標；飛行中補償 fromY 與 toY 偏差。
   */
  function _refreshLivePos(fromScroll) {
    for (var i = 0; i < _activeIstarts.length; i++) {
      var pos = _getNotePos(_activeIstarts[i]);
      if (pos) _livePos[_activeIstarts[i]] = pos;
    }
    // 同步更新 _ball.toX/Y（飛行終點），讓 _tick 不需要再查
    if (_ball._currentToIstart && _livePos[_ball._currentToIstart]) {
      _ball.toX = _livePos[_ball._currentToIstart].cx;
      _ball.toY = _livePos[_ball._currentToIstart].cy;
    }

    // ── 共同前置條件：flying 中、未暫停 ─────────────────────────
    if (_ball.state !== 'flying' || _ball.pausedProgress >= 0) return;

    // scroll/resize 觸發：fromY snap 到 toY，球 Y 軸固定於目標
    if (fromScroll) {
      _ball.fromY = _ball.toY;
      _ball.arcH  = BOUNCE_H;
    }
  }

  /**
   * _parabola(p, fromY, toY, arcH) - 拋物線 Y 計算
   *
   * p:    進度 0~1
   * fromY, toY: 起終點 Y（注意：螢幕 Y 向下為正）
   * arcH: 弧頂高度（px，正值 = 向上）
   *
   * 公式：y = lerp(fromY, toY, p) - 4 * arcH * p * (1 - p)
   * 即拋物線頂點在 p=0.5 時，向上偏移 arcH。
   */
  function _parabola(p, fromY, toY, arcH) {
    var linear = fromY + (toY - fromY) * p;
    return linear - 4 * arcH * p * (1 - p);
  }

  /**
   * _startFly(fromX, fromY, toX, toY, durMs, toIstart, arcH)
   * 開始一段飛行。arcH 省略時用 BOUNCE_H。
   * 調用端負責在前面呼叫 performance.now() 並傳入給相關狀態。
   * @param {number}      fromX, fromY  起點 viewport 座標
   * @param {number}      toX,   toY    終點 viewport 座標
   * @param {number}      durMs         飛行時長（ms）
   * @param {number|null} toIstart      終點音符 istart；null = 邊界點
   * @param {number}      [arcH]        拋物線弧高，省略時用 BOUNCE_H
   */
  function _startFly(fromX, fromY, toX, toY, durMs, toIstart, arcH) {
    _ball.state            = 'flying';
    _ball.fromX            = fromX;
    _ball.fromY            = fromY;
    _ball.toX              = toX;
    _ball.toY              = toY;
    _ball.segStart         = performance.now();
    _ball.segDur           = Math.max(durMs, 50); // 最短 50ms，防止除零
    // arcH 每次起飛都從傳入值（或 BOUNCE_H）重設，
    // 避免前一段 _refreshLivePos 壓縮的殘餘值污染新段。
    _ball.arcH             = (arcH !== undefined) ? arcH : BOUNCE_H;
    _ball.pausedProgress   = -1;
    _ball._currentToIstart = toIstart || null;
  }

  /**
   * _ensureRaf() - 確保 rAF loop 正在跑
   */
  function _ensureRaf() {
    if (_rafId === null) {
      _rafId = requestAnimationFrame(_tick);
    }
  }

  /**
   * _stopRaf() - 停止 rAF loop
   */
  function _stopRaf() {
    if (_rafId !== null) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
  }

  /**
   * _preHighlightNote(istart) - 預點亮下一音符
   * 加 abcr-pre CSS class，同時觸發自動捲動。
   */
  function _preHighlightNote(istart) {
    if (!istart) return;
    var preElts = document.querySelectorAll('.abcr-pre');
    for (var i = 0; i < preElts.length; i++) {
      preElts[i].classList.remove('abcr-pre');
    }
    var elts = document.getElementsByClassName('_' + istart + '_');
    for (var j = 0; j < elts.length; j++) {
      elts[j].classList.add('abcr-pre');
    }
    // 觸發自動捲動（與 setNoteOp 相同的邏輯）
    if (typeof UIController !== 'undefined' && UIController.scrollToNote) {
      UIController.scrollToNote(istart);
    }
  }

  /**
   * _clearPreHighlight() - 清除 abcr-pre 高亮
   */
  function _clearPreHighlight() {
    var preElts = document.querySelectorAll('.abcr-pre');
    for (var i = 0; i < preElts.length; i++) {
      preElts[i].classList.remove('abcr-pre');
    }
  }

  /**
   * _resetLead(now) - 清除 leadTimeout，保存 pause 快照
   */
  function _resetLead(now) {
    if (_leadTimeoutId !== null) {
      clearTimeout(_leadTimeoutId);
      _leadTimeoutId = null;
      if (typeof now === 'number') {
        _leadPausedAt = now;
      }
    }
  }

  /**
   * _clearCanvas() - 清除畫布
   */
  function _clearCanvas() {
    if (_ctx) {
      _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    }
  }

  /**
   * _drawBall(x, y, op) - 在指定位置繪製小球（op：透明度）
   */
  function _drawBall(x, y, op) {
    if (!_ctx) return;
    _ctx.fillStyle = BALL_COLOR;
    _ctx.globalAlpha = op !== undefined ? op : 1;
    _ctx.beginPath();
    _ctx.arc(x, y, BALL_R, 0, 2 * Math.PI);
    _ctx.fill();
    _ctx.globalAlpha = 1;
  }


  // ══════════════════════════════════════════
  // rAF 主迴圈
  // ══════════════════════════════════════════

  /**
   * _tick(now) - requestAnimationFrame 回調
   * 效能原則：_tick 內不做任何 DOM query，所有座標從 _livePos 直接讀取。
   */
  var _tick = function (now) {
    _rafId = null;  // 每幀重設，讓下面的 _ensureRaf 可以重新排
    _clearCanvas();

    switch (_ball.state) {

      // ── 等待掉落（曲首）──────────────────────────────────────────
      // 球靜止顯示在第一音符正上方，等待 leadTimeout 觸發掉落
      // scroll 時由 _refreshLivePos 同步 _livePos，重畫位置自動校正
      case 'drop_wait': {
        var dwPos = _livePos[_ball._firstIstart];
        var dwX   = dwPos ? dwPos.cx : 0;
        var dwY   = dwPos ? (dwPos.cy - BOUNCE_H) : _ball.dropFromY;
        _drawBall(dwX, dwY);
        _ensureRaf();
        break;
      }

      // ── 飛行中 ───────────────────────────────────────────────────
      // toX/Y 已由 _refreshLivePos 在 scroll/resize 時同步，此處直接用
      case 'flying': {
        var progress;
        if (_ball.pausedProgress >= 0) {
          progress = _ball.pausedProgress;
        } else {
          var elapsed = now - _ball.segStart;
          progress = Math.min(elapsed / _ball.segDur, 1);
        }

        var bx = _ball.fromX + (_ball.toX - _ball.fromX) * progress;
        var fy = _parabola(progress, _ball.fromY, _ball.toY, _ball.arcH);
        _drawBall(bx, fy);

        if (progress < _ball.stopAt) {
          _ensureRaf();
        } else {
          // 飛行完成（含 stopAt=0.5 的換行 / isJump 第一段）
          if (_ball.wrapPending) {
            // 換行 / 跳躍第二段：在目標音符正上方直線掉落（同第一拍落地動畫）
            // isJump 的 wrapToIstart 已由 hook-bridge [ball:jump-patch] 修補為實際落點，
            // 與換行路徑完全對稱，無需分岔。
            _ball.wrapPending = false;
            _ball.stopAt      = 1.0;   // 第二段跑完整段
            var wrapIstart = _ball.wrapToIstart;
            var wrapPos    = _livePos[wrapIstart];
            var wrapToX    = wrapPos ? wrapPos.cx : 0;
            var wrapToY    = wrapPos ? wrapPos.cy : _ball.toY;
            // 掉落起點：目標音符正上方 BOUNCE_H 處（同 onPlayStart）
            var wrapFromY  = wrapToY - BOUNCE_H;
            // 預先登記 wrapIstart 的下一個音符，確保落地時 _livePos[nextIstart]
            // 已有座標，onNoteOn 起飛不會 fallback 到 fromX 造成頓挫
            var _wpo            = abc2svg && abc2svg._current_po;
            var _wMeta          = _wpo && _wpo._ballMeta && _wpo._ballMeta[wrapIstart];
            var _wrapNextIstart = _wMeta ? _wMeta.nextIstart : null;
            _setActiveIstarts(_wrapNextIstart ? [wrapIstart, _wrapNextIstart] : [wrapIstart]);
            // 第二段開始時點亮目標音符（觸發自動捲動）
            _preHighlightNote(wrapIstart);
            // arcH = 0：直線掉落，不彎曲
            _startFly(wrapToX, wrapFromY, wrapToX, wrapToY, _ball.wrapDur, wrapIstart, 0);
            _ensureRaf();
          } else if (_ball._afterFlyToDone) {
            // 曲尾：切換到淡出狀態
            _ball._afterFlyToDone  = false;
            _ball._currentToIstart = null;
            _activeIstarts         = [];
            _livePos               = {};
            _ball.state            = 'done';
            _ball.fadeStart        = now;
            _ensureRaf();
          } else {
            // 正常飛行結束：停在音符上，等待下一個 on=true
            _ball.state = 'idle_at_note';
            _ensureRaf();
          }
        }
        break;
      }

      // ── 停在音符上（等待下一個 on=true）────────────────────────
      // 座標從 _livePos 讀（scroll 時已更新）
      case 'idle_at_note': {
        var nx = _ball._currentToIstart
          ? _livePos[_ball._currentToIstart]
          : null;
        var ny = nx ? nx.cy : _ball.toY;
        nx = nx ? nx.cx : _ball.toX;
        _drawBall(nx, ny);
        _ensureRaf();
        break;
      }

      // ── 曲尾淡出 ─────────────────────────────────────────────────
      // 停在右邊界（_ball.toX/Y），固定座標，不需追蹤
      case 'done': {
        var fadeElapsed = now - _ball.fadeStart;
        var fadeP = Math.min(fadeElapsed / FADE_MS, 1);
        var op    = 1 - fadeP;
        _drawBall(_ball.toX, _ball.toY, op);
        if (op > 0) {
          _ensureRaf();
        }
        break;
      }
    }
  };

  // ══════════════════════════════════════════
  // 公開 API
  // ══════════════════════════════════════════

  var BallController = {
    /**
     * init() - 初始化（doRender 完成後呼叫）
     * 建立畫布、掛載事件監聽
     */
    init: function () {
      if (_canvas) return;

      _canvas = document.createElement('canvas');
      _canvas.style.cssText = 'position: fixed; left: 0; top: 0; ' +
                              'width: 100%; height: 100%; ' +
                              'pointer-events: none; z-index: ' + BALL_Z;
      document.body.appendChild(_canvas);
      _ctx = _canvas.getContext('2d');

      _canvas.width  = window.innerWidth;
      _canvas.height = window.innerHeight;

      window.addEventListener('resize', function () {
        _canvas.width  = window.innerWidth;
        _canvas.height = window.innerHeight;
        _refreshLivePos(true);
      });

      // 捲動時重查活躍音符座標（passive，不阻塞捲動）
      window.addEventListener('scroll', function () { _refreshLivePos(true); }, { passive: true });
    },

    /**
     * clearValidCache() - 清除 istart 快取（doRender 重新渲染時呼叫）
     */
    clearValidCache: function () {
      _validIstarts.clear();
    },

    /**
     * onPlayStart(firstIstart, firstOnMs) - 播放開始
     * 小球出現在第一音符正上方，等待 leadTimeout 開始掉落
     */
    onPlayStart: function (firstIstart, firstOnMs) {
      _stopRaf();
      _resetLead();
      _clearCanvas();
      _clearPreHighlight();
      _activeIstarts            = [];
      _livePos                  = {};
      _ball.state               = 'idle';
      _ball.pausedProgress      = -1;
      _ball.stopAt              = 1.0;
      _ball.wrapPending         = false;
      _ball.wrapToIstart        = null;
      _ball._currentToIstart    = null;
      _ball._afterFlyToDone     = false;
      _ball.dropFromY           = 0;
      _ball._firstIstart        = null;
      _firstNoteScheduled       = false;
      _validIstarts.clear();

      // 即時取第一音符座標
      _setActiveIstarts([firstIstart]);
      var lp     = _livePos[firstIstart];
      var firstX = lp ? lp.cx : 0;
      var firstY = lp ? lp.cy : window.innerHeight / 2;

      // 掉落起點：第一音符正上方 BOUNCE_H 處
      var dropY  = firstY - BOUNCE_H;

      // 進入 drop_wait：球靜止在掉落起點，等待 leadTimeout
      _ball.state        = 'drop_wait';
      _ball._firstIstart = firstIstart;  // drop_wait 分支讀 _livePos 用
      _ball.dropFromY    = dropY;        // pause 中重繪備用

      _ensureRaf();

      // 集中調用一次 performance.now()，供 leadTimeout 排程使用
      var now = performance.now();
      var leadDelay = Math.max(0, firstOnMs - LEAD_MS);
      _leadScheduledAt = now;
      _ball._leadDelay = leadDelay;
      _leadTimeoutId = setTimeout(function () {
        _leadTimeoutId   = null;
        _leadScheduledAt = -1;
        if (_ball.state !== 'drop_wait') return;  // 已被 stop/pause 取消
        // 重查座標（可能已捲動）
        _setActiveIstarts([firstIstart]);
        var lp2   = _livePos[firstIstart];
        var fx    = lp2 ? lp2.cx : firstX;
        var fy    = lp2 ? lp2.cy : firstY;
        var dropY2 = fy - BOUNCE_H;
        _stopRaf();
        // arcH = 0：直線掉落，不彎曲
        _startFly(fx, dropY2, fx, fy, LEAD_MS, firstIstart, 0);
        _firstNoteScheduled = true;
        _ensureRaf();
      }, leadDelay);
    },

    /**
     * onNoteOn(istart, isAtB) - 音符點亮，小球起飛
     *
     * 換行 / 跳躍時分兩段：原地上升（stopAt=0.5），再從目標正上方直線掉落。
     * 曲尾時飛向右邊界後進入 done 狀態。
     *
     * 原地上升觸發條件：
     *   換行：fromY 與 toY 差距超過 ROW_THRESH
     *   meta.isJump：repeat / volta / DC / DS / Coda / Fine
     *
     * isAtB = true：原地完整拋物線（stopAt=1.0），進入 idle_at_note
     *
     * meta 由 hook-bridge.js 填入 po._ballMeta[istart]
     */
    onNoteOn: function (istart, isAtB) {
      // 主清除：若上一個換行已預點亮 next，在正式 selb 接手前清除 abcr-pre
      _clearPreHighlight();

      var po   = abc2svg && abc2svg._current_po;
      var meta = po && po._ballMeta && po._ballMeta[istart];
      if (!meta) return;

      var durMs      = meta.durMs;
      var nextIstart = meta.nextIstart;

      // 即時查當前音符座標（起飛點）
      // 同時把 from/to istart 加入活躍列表，確保 scroll 時可追蹤
      _setActiveIstarts(nextIstart ? [istart, nextIstart] : [istart]);
      var fromPos = _livePos[istart];
      var fromX   = fromPos ? fromPos.cx : _ball.toX;
      var fromY   = fromPos ? fromPos.cy : _ball.toY;

      // ── 選段 B 點：完整拋物線原地跳（上升 + 回落），進入 idle_at_note ──
      // play engine 循環重播會重新觸發 onPlayStart，不需第二段掉落。
      if (isAtB) {
        _setActiveIstarts([istart]);
        _ball.wrapPending = false;
        _ball.stopAt      = 1.0;   // 完整拋物線
        _startFly(fromX, fromY, fromX, fromY, durMs, istart);
        _ensureRaf();
        return;
      }

      if (!nextIstart) {
        // ── 曲尾：飛向右邊界後淡出 ──────────────────────────────
        var rightX = _svgRightEdge() - BALL_R;
        _startFly(fromX, fromY, rightX, fromY, durMs, null);
        _ball._afterFlyToDone = true;
        _ensureRaf();
        return;
      }

      var toPos = _livePos[nextIstart];
      var toX   = toPos ? toPos.cx : fromX;
      var toY   = toPos ? toPos.cy : fromY;

      // ── 換行 / 跳躍判斷 ──────────────────────────────────────────
      // 換行：fromY 與 toY 差距超過 ROW_THRESH
      // isJump：repeat / volta / DC / DS / Coda / Fine 跳躍，
      //   nextIstart 已由 hook-bridge [ball:jump-patch] 修補為實際落點，
      //   兩段式動畫與換行完全對稱。
      if (Math.abs(toY - fromY) > ROW_THRESH || meta.isJump) {
        var dur1 = durMs * WRAP_UP_RATIO;
        var dur2 = durMs * WRAP_DOWN_RATIO;
        _ball.wrapPending  = true;
        _ball.wrapToIstart = nextIstart;
        _ball.wrapDur      = dur2;
        _ball.stopAt       = 0.5;
        _startFly(fromX, fromY, fromX, fromY, dur1, null, WRAP_BOUNCE_H);
      } else {
        // ── 同行：直接飛向 next ─────────────────────────────────
        _ball.wrapPending = false;
        _startFly(fromX, fromY, toX, toY, durMs, nextIstart);
      }

      _ensureRaf();
    },

    /**
     * onPlayEnd() - 播放結束
     * 清除小球，停止 rAF。
     */
    onPlayEnd: function () {
      _resetLead();
      _stopRaf();
      _clearCanvas();
      _clearPreHighlight();   // 保底：清除可能殘留的換行預點亮
      _activeIstarts            = [];
      _livePos                  = {};
      _ball.state               = 'idle';
      _ball.pausedProgress      = -1;
      _ball.stopAt              = 1.0;
      _ball.wrapPending         = false;
      _ball.wrapToIstart        = null;
      _ball._currentToIstart    = null;
      _ball._afterFlyToDone     = false;
      _ball.dropFromY           = 0;
      _ball._firstIstart        = null;
      _firstNoteScheduled       = false;
    },

    // ══════════════════════════════════════════
    // Pause / Resume
    // ══════════════════════════════════════════

    /**
     * onPause() - 暫停播放
     *
     * flying：記錄 pausedProgress，小球凍結在半空中，rAF 繼續維持顯示。
     * drop_wait：若 leadTimeout 尚未觸發，清掉並記錄剩餘時間，供 onResume 補排。
     */
    onPause: function () {
      // 集中調用一次 performance.now()
      var now = performance.now();
      _resetLead(now);
      // 保底：清除可能殘留的換行預點亮（第二段尚未落地就 pause）
      _clearPreHighlight();

      if (_ball.state === 'flying' && _ball.pausedProgress < 0) {
        // 記錄當前進度，讓 _tick 停止推進時間
        // 上限用 _ball.stopAt（換行第一段為 0.5，一般段為 1.0）
        var elapsed = now - _ball.segStart;
        _ball.pausedProgress = Math.min(elapsed / _ball.segDur, _ball.stopAt);
      }
    },

    /**
     * onResume() - 繼續播放
     *
     * flying：從 pausedProgress 重新計算 segStart，繼續飛行。
     * drop_wait：若 onPause 時清掉了 leadTimeout，計算剩餘時間後補排。
     */
    onResume: function () {
      // 集中調用一次 performance.now()
      var now = performance.now();
      
      if (_leadPausedAt >= 0 && _leadScheduledAt >= 0 && !_firstNoteScheduled) {
        var elapsed   = _leadPausedAt - _leadScheduledAt;
        var remaining = Math.max(0, (_ball._leadDelay || 0) - elapsed);
        var firstY2   = window.innerHeight / 2;
        _leadScheduledAt = now;
        // _leadScheduledAt 此處重設，確保若補排後再次 onPause，
        // 下一次 onResume 的 elapsed 計算仍以本次排程為基準。
        _ball._leadDelay = remaining;
        _leadTimeoutId = setTimeout(function () {
          _leadTimeoutId   = null;
          _leadScheduledAt = -1;
          _leadPausedAt    = -1;  // timeout 觸發後的收尾清除
          if (_ball.state !== 'drop_wait') return;  // guard 改為 drop_wait
          // 起飛前重查座標
          _setActiveIstarts([_ball._firstIstart]);
          var lp  = _livePos[_ball._firstIstart];
          var rx  = lp ? lp.cx : _svgLeftEdge() + BALL_R;  // fallback 對齊換行起點
          var ry  = lp ? lp.cy : firstY2;
          var dropY = ry - BOUNCE_H;
          _stopRaf();
          // arcH = 0：直線掉落
          _startFly(rx, dropY, rx, ry, LEAD_MS, _ball._firstIstart, 0);
          _firstNoteScheduled = true;
          _ensureRaf();
        }, remaining);
        _leadPausedAt = -1;  // 補排完立刻歸零，防止重複呼叫 onResume 再次補排
      }

      // ── flying 繼續 ───────────────────────────────────────────────
      if (_ball.state === 'flying' && _ball.pausedProgress >= 0) {
        // 重算 segStart，讓進度從 pausedProgress 繼續
        _ball.segStart       = now - _ball.pausedProgress * _ball.segDur;
        _ball.pausedProgress = -1;
        _ensureRaf();
      }
    }
  };

  // ── 掛載到全域 ────────────────────────────────────────────────────
  if (typeof module === 'object' && module.exports) {
    module.exports = BallController;
  } else {
    root.BallController = BallController;
  }

}(typeof globalThis !== 'undefined' ? globalThis : this));
