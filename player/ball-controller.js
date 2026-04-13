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
 *   - 每幀根據 (now - segStart) / segDur 計算進度，套拋物線公式
 *   - pause 時記錄 pausedProgress，小球停在半空中
 *   - resume 時重算 segStart，從半空中繼續飛行
 *
 * 座標策略（方案 A：scroll/resize 持續 snap）：
 *   - _livePos{}：只存「活躍 istart」（最多 2~3 個）的 viewport 座標快照。
 *     _tick 直接讀此表，零 DOM query。
 *   - 更新時機（事件驅動，非每幀）：
 *       1. onNoteOn / leadTimeout 起飛時：呼叫 _refreshLivePos(false) 立刻重查
 *       2. scroll 事件（passive）：呼叫 _refreshLivePos(true)，snap fromY → toY
 *       3. resize 事件：同上，呼叫 _refreshLivePos(true)
 *   - _getNotePos()：僅在起飛等低頻時機呼叫，不進入 _tick 主迴圈。
 *
 * 小球生命週期：
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ IDLE_BOUNCING  曲首在左邊界持續跳動（等待第一個 on=true）      │
 *   │   ↓ 提前 LEAD_MS (80ms) 起飛                                  │
 *   │ FLYING         飛向目標音符                                    │
 *   │   ↓ on=true 落地，立刻以 dur 為時長起飛飛向 next              │
 *   │ FLYING         飛向 next 音符（同行 / 換行 / 曲尾）            │
 *   │   ↓ 換行：先飛到右邊界（WRAP_TO_EDGE_RATIO），再從左邊界飛到 next（WRAP_TO_NOTE_RATIO）│
 *   │   ↓ 選段 B 點：原地跳躍（fromX→fromX），不理 next，不換行     │
 *   │ DONE           停在右邊界（曲尾後淡出）                        │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * 與現有模組的接點：
 *   - hook-bridge.js：play_cont 的 [pause:track-onnote] 區段需額外填入
 *                     po._ballMeta[istart] = { durMs, nextIstart }
 *   - abcplay-driver.js：playStart / pausePlay / resumePlay / onPlaybackEnd
 *                        各呼叫 BallController 對應的生命週期函式
 *   - loader.js：doRender 完成後呼叫 BallController.init()
 *                （buildPositions 已移除，不再需要預先掃描）
 *
 * HTML 載入順序（在 loader.js 之前）：
 *   <script src="ball-controller.js"></script>
 *
 * 依賴（全域）：
 *   abc2svg._current_po  – 取得 _ballMeta
 *   （不依賴 AbcplayDriver / UIController 的私有狀態）
 */

;(function (root) {
  'use strict';

  // ══════════════════════════════════════════
  // 常數
  // ══════════════════════════════════════════

  var BALL_R      = 6;      // 小球半徑（px）
  var LEAD_MS     = 100;    // 第一個音符掉落動畫時長（ms）
  var BOUNCE_H    = 27;     // 跳躍弧高（px，拋物線頂點相對於端點的高度）
  var FADE_MS     = 600;    // 曲尾淡出時間（ms）
  var ROW_THRESH  = 20;     // 換行判斷閾值（px，兩音符 DOM Y 差距超過此值視為換行）
  var BALL_COLOR  = 'rgba(220, 60, 60, 0.85)';  // 小球顏色
  var BALL_Z      = '1000'; // z-index

  // ── 換行時長分配比例 ─────────────────────────────────────────────
  // 第一段（當前音符 → 右邊界）佔 dur 的比例
  // 第二段（左邊界 → next 音符）佔 1 - WRAP_TO_EDGE_RATIO
  var WRAP_TO_EDGE_RATIO = 3 / 4;  // 第一段：3/4
  var WRAP_TO_NOTE_RATIO = 1 / 4;  // 第二段：1/4（= 1 - WRAP_TO_EDGE_RATIO）

  // ══════════════════════════════════════════
  // 模組私有狀態
  // ══════════════════════════════════════════

  /** @type {HTMLCanvasElement|null} 小球畫布（fixed 定位，全螢幕） */
  var _canvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  var _ctx    = null;
  /** @type {number|null} requestAnimationFrame ID */
  var _rafId  = null;

  /**
   * 活躍音符座標快照：istart → { cx, cy }
   *
   * 只存當前飛行相關的 2~3 個 istart（from / to / wrapTo）。
   * _tick 讀此表，零 DOM query。
   * 由 _refreshLivePos() 在起飛或捲動時更新。
   */
  var _livePos = {};

  /**
   * 當前需要追蹤的 istart 列表（最多 3 個）。
   * scroll / resize 時只重查這幾個元素。
   */
  var _activeIstarts = [];

  /**
   * [優化4] 有效 istart 快取：Set<istart>
   *
   * 記錄已確認有對應 .abcr DOM 元素的 istart。
   * 用途：_setActiveIstarts 過濾無效 istart（多聲部靜音聲部）時，
   * 第一次查 querySelector，之後直接查快取，避免每次 onNoteOn 都查 DOM。
   *
   * 清除時機：doRender 重新渲染時（由 BallController.init 或外部重置呼叫 _clearValidCache）。
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

    // ── 換行緩衝（line_wrap）───────────────────────────────────
    wrapPending:  false, // 是否有待執行的換行第二段
    wrapToIstart: null,  // 換行第二段的目標 istart
    wrapDur:      0,     // 換行第二段的持續時長（ms）

    // ── 第一音符掉落與 drop_wait ─────────────────────────────────
    _firstIstart: null,  // 第一個音符的 istart（drop_wait / onResume 用）

    // ── 第一音符掉落（drop）──────────────────────────────────────
    // 掉落起點 Y = 第一音符 Y - BOUNCE_H（音符正上方弧高處）
    // 掉落期間 state = 'flying'，arcH = 0（直線掉落）
    dropFromY:    0,     // 掉落起點 Y，供 pause 時 idle_at_drop 重繪用

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
    var last = svgs[svgs.length - 1];
    return last.getBoundingClientRect().right;
  }

  /**
   * _getNotePos(istart) - 即時查詢音符的 viewport 座標
   *
   * 每次呼叫都執行 querySelector + getBoundingClientRect()，
   * 確保捲動、縮放後座標永遠正確。
   *
   * 對應 .abcr 元素的 class 形如 "abcr _12345_"。
   * 同一個 istart 可能有多個 rect（多聲部），取第一個。
   *
   * @param  {number} istart
   * @returns {{ cx: number, cy: number }|null}
   *   cx = 音符矩形左邊界 X（viewport）—— 對齊 [playline] 垂直細線位置
   *   cy = 音符矩形垂直中心 Y（viewport）
   *   null = 找不到對應元素
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
      cx: r.left + BALL_R * 2,  // [playline] 左邊界右移一個直徑：球左邊緣貼 playline 右側，球心距 playline 一個半徑
      cy: r.top  + r.height / 2
    };
  }

  /**
   * _setActiveIstarts(list) - 設定活躍 istart 列表並立刻重查座標
   *
   * 在起飛（onNoteOn / leadTimeout）時呼叫，設定當前需追蹤的 istart 集合。
   * 同時呼叫 _refreshLivePos() 立刻填入最新座標。
   *
   * [多聲部過濾] 多聲部情況下（如 V:2 純 MIDI 伴奏），部分 istart 沒有對應的
   * .abcr DOM 元素（例如 %%MIDI control 7 0 的靜音聲部）。這類 istart 保留在
   * _activeIstarts 會導致 scroll 時查不到座標，並覆蓋有效聲部的 _livePos。
   *
   * [優化4] 使用 _validIstarts 快取：第一次遇到的 istart 才查 querySelector，
   * 之後直接查 Set，避免每次 onNoteOn 都查 DOM。
   *
   * @param {Array} list  istart 陣列，falsy 值與無 DOM 元素的值自動過濾
   */
  function _setActiveIstarts(list) {
    _activeIstarts = list.filter(function (v) {
      if (!v) return false;
      if (_validIstarts.has(v)) return true;          // 快取命中，直接通過
      if (document.querySelector('._' + v + '_')) {   // 首次：查 DOM
        _validIstarts.add(v);                         // 加入快取
        return true;
      }
      return false;                                   // 無 DOM，過濾掉
    });
    _refreshLivePos(false);
  }

  /**
   * _refreshLivePos(fromScroll) - 重查所有活躍 istart 的 viewport 座標
   *
   * 呼叫時機：
   *   1. _setActiveIstarts()（起飛時）              → fromScroll = false
   *   2. scroll 事件（passive listener）             → fromScroll = true
   *   3. resize 事件                                → fromScroll = true
   *
   * 每次只查 _activeIstarts 中的幾個元素（最多 3 個），開銷極低。
   * 查完後同步更新 _ball.toX / _ball.toY，確保 _tick 讀到最新值。
   *
   * [方案 A] scroll / resize 觸發時，持續將飛行起點 Y snap 到目標音符 Y：
   *   條件：fromScroll = true、flying 中、未暫停
   *   只修改 fromY 和 arcH，完全不動 fromX / segStart。
   *   效果：每次 scroll 事件都重新 snap，捲動過程中球的 Y 軸持續追蹤目標；
   *         X 軸飛行路徑與時序完全不受影響，球照正常速度水平推進。
   *   原理：fromY = toY、arcH = 0 → _parabola(p, toY, toY, 0) 恆等於 toY。
   *
   * @param {boolean} [fromScroll]  true = 由 scroll/resize 事件觸發
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

    // [方案 A] scroll / resize 觸發：持續將 fromY snap 到目標音符 Y
    // 只修改 fromY 和 arcH，完全不動 fromX / segStart，
    // 確保 X 軸飛行路徑與時序不受影響。
    // fromY = toY、arcH = BOUNCE_H → _parabola(p, toY, toY, 0) 結果永遠是 toY，
    // 球在 Y 軸固定於目標音符高度，X 軸照原本進度正常推進。
    if (fromScroll) {
      _ball.fromY = _ball.toY;
      _ball.arcH  = BOUNCE_H;
    }
  }

  /**
   * _liveCx(istart) - 從 _livePos 取 X，找不到回傳 0
   */
  function _liveCx(istart) {
    var p = istart && _livePos[istart];
    return p ? p.cx : 0;
  }

  /**
   * _liveCy(istart) - 從 _livePos 取 Y，找不到回傳視窗中央
   */
  function _liveCy(istart) {
    var p = istart && _livePos[istart];
    return p ? p.cy : window.innerHeight / 2;
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
   *
   * 開始一段飛行。
   * toIstart 用於記錄到 _ball._currentToIstart，
   * 供 _refreshLivePos 在 scroll 時知道要更新哪個終點。
   *
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
   * _resetLead(pausedAt) - 取消提前起飛的 setTimeout 並重置所有相關旗標
   *
   * 重置：_leadTimeoutId / _leadScheduledAt / _leadPausedAt。
   *
   * @param {number} [pausedAt] - 傳入 performance.now() 時，將 _leadPausedAt
   *   設為該時間點（onPause 用，供 onResume 計算剩餘等待）；
   *   省略時 _leadPausedAt 歸零（onPlayStart / onPlayEnd 用）。
   */
  function _resetLead(pausedAt) {
    if (_leadTimeoutId !== null) {
      clearTimeout(_leadTimeoutId);
      _leadTimeoutId = null;
    }
    _leadScheduledAt = -1;
    _leadPausedAt    = (pausedAt !== undefined) ? pausedAt : -1;
  }

  /**
   * _clearCanvas() - 清除畫布
   */
  function _clearCanvas() {
    if (_canvas) _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
  }

  /**
   * _drawBall(x, y, opacity) - 在 (x, y) 畫小球
   */
  function _drawBall(x, y, opacity) {
    if (!_ctx) return;
    _ctx.save();
    _ctx.globalAlpha = (opacity !== undefined) ? opacity : 1;
    _ctx.beginPath();
    _ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
    _ctx.fillStyle = BALL_COLOR;
    _ctx.fill();
    _ctx.restore();
  }

  // ══════════════════════════════════════════
  // rAF 主迴圈
  // ══════════════════════════════════════════

  /**
   * _tick(now) - requestAnimationFrame 回調
   *
   * 使用 var 宣告（非 function 宣告），確保 _ensureRaf 內
   * requestAnimationFrame(_tick) 捕捉到的永遠是同一個函式引用。
   *
   * 效能原則：
   *   _tick 內不做任何 DOM query。
   *   所有座標從 _livePos / _ball.toX/Y 直接讀取（純 JS 物件查詢）。
   *   _livePos 由 scroll/resize 事件或起飛時機更新，與 _tick 解耦。
   *
   * 狀態說明：
   *   'drop_wait'    → 球靜止在第一音符正上方 BOUNCE_H 處，等待 leadTimeout
   *   'flying'       → 拋物線飛行（含第一音符直線掉落），toX/Y 由 _refreshLivePos 同步
   *   'idle_at_note' → 停在終點音符，座標從 _livePos 取
   *   'done'         → 淡出，座標固定（右邊界，不需追蹤）
   *   其他（idle）    → 清畫布後停止
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
        var dwX   = dwPos ? dwPos.cx : _ball.fromX;
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

        if (progress < 1) {
          _ensureRaf();
        } else {
          // 飛行完成
          if (_ball.wrapPending) {
            // 換行第二段：從左邊界飛到 next 音符
            _ball.wrapPending = false;
            var wrapIstart = _ball.wrapToIstart;
            var wrapPos    = _livePos[wrapIstart];
            var wrapToX    = wrapPos ? wrapPos.cx : 0;
            var wrapToY    = wrapPos ? wrapPos.cy : _ball.toY;
            var leftX      = _svgLeftEdge() + BALL_R;
            // 預先登記 wrapIstart 的下一個音符，確保落地時 _livePos[nextIstart]
            // 已有座標，onNoteOn 起飛不會 fallback 到 fromX 造成頓挫
            var _wpo             = abc2svg && abc2svg._current_po;
            var _wMeta           = _wpo && _wpo._ballMeta && _wpo._ballMeta[wrapIstart];
            var _wrapNextIstart  = _wMeta ? _wMeta.nextIstart : null;
            _setActiveIstarts(_wrapNextIstart ? [wrapIstart, _wrapNextIstart] : [wrapIstart]);
            _startFly(leftX, wrapToY, wrapToX, wrapToY, _ball.wrapDur, wrapIstart);
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
            // 正常飛行結束：轉 idle_at_note
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
          ? _liveCx(_ball._currentToIstart)
          : _ball.toX;
        var ny = _ball._currentToIstart
          ? _liveCy(_ball._currentToIstart)
          : _ball.toY;
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

      // ── 其他狀態（idle）：清畫布後停止 ──────────────────────────
      default:
        break;
    }
  };

  // ══════════════════════════════════════════
  // 公開 API
  // ══════════════════════════════════════════

  var BallController = {

    // ══════════════════════════════════════════
    // 初始化
    // ══════════════════════════════════════════

    /**
     * init() - 建立 canvas 並掛載到 body
     *
     * 由 loader.js doRender 完成後呼叫（只需呼叫一次）。
     * 多次呼叫安全（冪等）。
     */
    init: function () {
      if (_canvas) return;
      _canvas = document.createElement('canvas');
      _canvas.style.cssText = [
        'position:fixed',
        'top:0',
        'left:0',
        'width:100%',
        'height:100%',
        'pointer-events:none',  // 不攔截滑鼠事件
        'z-index:' + BALL_Z
      ].join(';');
      _canvas.width  = window.innerWidth;
      _canvas.height = window.innerHeight;
      document.body.appendChild(_canvas);
      _ctx = _canvas.getContext('2d');

      // 視窗大小改變時同步畫布尺寸，並重查活躍音符座標
      window.addEventListener('resize', function () {
        if (!_canvas) return;
        _canvas.width  = window.innerWidth;
        _canvas.height = window.innerHeight;
        _refreshLivePos(true);
      });

      // 捲動時重查活躍音符座標（passive，不阻塞捲動）
      // 只查 _activeIstarts 中的 2~3 個元素，開銷極低
      // fromScroll = true：觸發方案 C snap，將球 Y 軸對齊目標音符
      window.addEventListener('scroll', function () { _refreshLivePos(true); }, { passive: true });
    },

    // ══════════════════════════════════════════
    // 播放生命週期 hooks（由 abcplay-driver.js 呼叫）
    // ══════════════════════════════════════════

    /**
     * onPlayStart(firstIstart, firstOnMs) - 播放開始
     *
     * 小球出現在第一音符正上方 BOUNCE_H 高度靜止（drop_wait 狀態），
     * 在第一個 on=true 之前 LEAD_MS 毫秒開始直線掉落，
     * 正好在音符點亮時落地。
     *
     * 掉落使用 arcH=0 的 _startFly（直線，無拋物線弧），
     * 視覺上呈現「自然落下」而非橫向飛入。
     *
     * @param {number} firstIstart - 第一個音符的 istart
     * @param {number} firstOnMs   - 第一個 on=true 距現在的 ms（hook-bridge 的 st）
     */
    onPlayStart: function (firstIstart, firstOnMs) {
      _stopRaf();
      _resetLead();
      _firstNoteScheduled  = false;
      _ball.wrapPending    = false;
      _ball.pausedProgress = -1;
      _ball._afterFlyToDone = false;

      // [優化4] 重新播放時清除有效 istart 快取，確保新渲染的 DOM 重新驗證
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

      // 提前 LEAD_MS 開始掉落
      var leadDelay = Math.max(0, firstOnMs - LEAD_MS);
      _leadScheduledAt = performance.now();
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
     * onNoteOn(istart, isAtB) - 音符點亮（on=true）
     *
     * 小球落地，立刻以 durMs 為時長起飛飛向 next 音符。
     * 換行時分兩段：先飛右邊界（WRAP_TO_EDGE_RATIO），再飛 next（WRAP_TO_NOTE_RATIO）。
     * 曲尾時飛向右邊界後進入 done 狀態。
     *
     * isAtB = true（選段 B 點）：原地跳躍，不理 next，不換行，
     *   避免換行第二段從左邊界冒出的突兀感。
     *
     * meta 由 hook-bridge.js 填入 po._ballMeta[istart]：
     *   { durMs: number, nextIstart: number|null }
     */
    onNoteOn: function (istart, isAtB) {
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

      // ── 選段 B 點：原地跳躍，不理 next，不換行 ──────────────────
      // 避免 next 在下一行時，換行第二段從左邊界冒出的突兀感。
      // 飛行結束後進入 idle_at_note，等待 onPlayEnd 清除。
      if (isAtB) {
        _setActiveIstarts([istart]);
        _startFly(fromX, fromY, fromX, fromY, durMs, istart);
        _ensureRaf();
        return;
      }

      if (!nextIstart) {
        // ── 曲尾：飛向右邊界後淡出 ──────────────────────────────
        var rightX = _svgRightEdge() - BALL_R;
        // 右邊界不是音符，toIstart = null
        _startFly(fromX, fromY, rightX, fromY, durMs, null);
        _ball._afterFlyToDone = true;
        _ensureRaf();
        return;
      }

      var toPos = _livePos[nextIstart];
      var toX   = toPos ? toPos.cx : fromX;
      var toY   = toPos ? toPos.cy : fromY;

      // ── 換行判斷 ─────────────────────────────────────────────
      if (Math.abs(toY - fromY) > ROW_THRESH) {
        // 換行：第一段飛到右邊界，第二段從左邊界飛到 next
        // 時長分配由 WRAP_TO_EDGE_RATIO / WRAP_TO_NOTE_RATIO 控制
        var dur1    = durMs * WRAP_TO_EDGE_RATIO;
        var dur2    = durMs * WRAP_TO_NOTE_RATIO;
        var rightX2 = _svgRightEdge() - BALL_R;
        _ball.wrapPending  = true;
        _ball.wrapToIstart = nextIstart;
        _ball.wrapDur      = dur2;
        _startFly(fromX, fromY, rightX2, fromY, dur1, null);
      } else {
        // ── 同行：直接飛向 next ─────────────────────────────────
        _ball.wrapPending = false;
        _startFly(fromX, fromY, toX, toY, durMs, nextIstart);
      }

      _ensureRaf();
    },

    /**
     * onPlayEnd() - 播放結束（onPlaybackEnd 觸發，含自然結束與主動停止）
     *
     * 清除小球，停止 rAF。
     */
    onPlayEnd: function () {
      _resetLead();
      _stopRaf();
      _clearCanvas();
      _activeIstarts            = [];
      _livePos                  = {};
      _ball.state               = 'idle';
      _ball.pausedProgress      = -1;
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
     * flying 狀態：記錄 pausedProgress，小球凍結在半空中，rAF 繼續維持顯示。
     * drop_wait 狀態：若 leadTimeout 尚未觸發，清掉並記錄剩餘時間，
     *               供 onResume 補排；rAF 繼續讓球靜止顯示在掉落起點。
     */
    onPause: function () {
      // ── leadTimeout 保存 ──────────────────────────────────────────
      // timeout 在跑時傳入 performance.now()，_resetLead 將其存入
      // _leadPausedAt 供 onResume 計算剩餘等待；沒有 timeout 時歸零。
      _resetLead(performance.now());

      if (_ball.state === 'flying' && _ball.pausedProgress < 0) {
        // 記錄當前進度，讓 _tick 停止推進時間
        var elapsed = performance.now() - _ball.segStart;
        _ball.pausedProgress = Math.min(elapsed / _ball.segDur, 1);
        // _tick 在 flying 分支中已 _ensureRaf，繼續跑維持顯示
      }
      // drop_wait：rAF 已在持續跑顯示靜止球，不需額外操作
    },

    /**
     * onResume() - 繼續播放
     *
     * flying 狀態：從 pausedProgress 重新計算 segStart，繼續飛行。
     * drop_wait 狀態：若 onPause 時清掉了 leadTimeout，
     *               計算剩餘時間後補排。
     */
    onResume: function () {
      // ── leadTimeout 補排 ──────────────────────────────────────────
      if (_leadPausedAt >= 0 && _leadScheduledAt >= 0 && !_firstNoteScheduled) {
        var elapsed   = _leadPausedAt - _leadScheduledAt;
        var remaining = Math.max(0, (_ball._leadDelay || 0) - elapsed);
        var firstY2   = window.innerHeight / 2;  // fallback（_livePos 尚未更新時）
        _leadScheduledAt = performance.now();
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
        _ball.segStart       = performance.now() - _ball.pausedProgress * _ball.segDur;
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
