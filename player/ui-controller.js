/**
 * ui-controller.js – abc2svg Player UI 控制層
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
 * 職責：
 *   1. 注入 CSS（fab-toolbar、調速面板、樂譜樣式）
 *   2. 建立 DOM 結構（fab-toolbar、speed-panel）
 *   3. 點擊事件（左鍵 / 右鍵）
 *   4. 播放按鈕 + 循環開關 UI
 *   5. 調速面板 UI
 *   6. 選取高亮（setsel / setOpacity）
 *   7. 播放中音符高亮（setNoteOp）
 *
 * 與 loader.js 的接合：
 *   UIController.init(cfg)      – 注入 Player API 與狀態存取器（§13 啟動時呼叫）
 *   UIController.getCallbacks() – 回傳 Player → UI callbacks 物件（§13 填入 play.on*）
 *
 * Player → UI callbacks（由 getCallbacks() 回傳，填入 play.on*）：
 *   onStateChange()       – 任何 PlayState 變化後通知 UI 更新按鈕/圖示
 *   onNoteHighlight(i,on) – 單一音符亮/暗（由 notehlight 委派）
 *   onClearHighlight()    – 清除全部播放高亮（pause / resume 時）
 *   onPauseHighlight(i)   – pause 時補亮暫停位置的最後一個音符
 *
 * UI → Player API（透過 cfg.api 注入，不直接呼叫 Player 函式名稱）：
 *   cfg.api.pause()       – 暫停
 *   cfg.api.resume()      – 繼續
 *   cfg.api.play()        – 播放
 *   cfg.api.stop()        – 停止
 *   cfg.api.seekTo(v)     – 跳至指定音符
 *   cfg.api.setSpeed(v)   – 設定播放速度
 *
 * 依賴（全域）：
 *   無直接依賴 loader.js 內部函式；所有狀態透過 cfg 存取器讀寫。
 *
 * HTML 載入順序：
 *   <script src="abc2svg-1.js"></script>
 *   <script src="snd-1.js"></script>
 *   <script src="jump-engine.js"></script>
 *   <script src="hook-bridge.js"></script>
 *   <script src="ui-controller.js"></script>   ← 必須在 loader.js 之前
 *   <script src="loader.js"></script>
 */

;(function (root) {
  'use strict';

  // ── 模組私有狀態 ──────────────────────────────────────────────────
  var _cfg = null;            // init() 注入的 config 物件
  var _scrollPending = false; // [scroll] 防抖旗標：smooth 動畫期間鎖住重複觸發

  // ── 公開物件 ──────────────────────────────────────────────────────
  var UIController = {

    // ══════════════════════════════════════════
    // A. 初始化
    // ══════════════════════════════════════════

    /**
     * init(cfg)
     *
     * 注入 Player API 與狀態存取器。必須在 §1/§2 DOM 建立之後、dom_loaded 之前呼叫。
     *
     * cfg 欄位：
     *   api          {object}   – play.api（UI → Player 操作入口）
     *   getState     {function} – () → PlayState 整數
     *   getLoopMode  {function} – () → loopMode 整數
     *   setLoopMode  {function} – (v) → void
     *   getLoopCount {function} – () → loopCount 整數
     *   setLoopCount {function} – (v) → void
     *   getSelx      {function} – () → selx 陣列引用
     *   getSelxSav   {function} – () → selx_sav 陣列引用
     *   getSpeed     {function} – () → currentSpeed 數值
     *   PlayState    {object}   – PlayState 枚舉
     *   CFG          {object}   – CFG 常數物件
     */
    init: function (cfg) {
      _cfg = cfg;
      UIController._setupButtons();
      UIController._setupSpeedPanel();
    },

    /**
     * getCallbacks()
     *
     * 回傳 Player → UI callbacks 物件，供 loader.js §13 填入 play.on*。
     *
     * @return {object} { onStateChange, onNoteHighlight, onClearHighlight, onPauseHighlight }
     */
    getCallbacks: function () {
      return {
        onStateChange:    UIController.refreshToggleLabel.bind(UIController),
        onNoteHighlight:  UIController.setNoteOp.bind(UIController),
        onClearHighlight: UIController.clearAllHighlight.bind(UIController),
        onPauseHighlight: function (i) { UIController.setNoteOp(i, true); }
      };
    },

    // ══════════════════════════════════════════
    // 1. 注入 CSS
    // ══════════════════════════════════════════

    /**
     * injectCSS()
     *
     * 將 Player 所需的 CSS 注入 <head>，並補充 charset meta（若缺失）。
     * 由模組自身在載入時立即執行（見檔案尾端的 IIFE 呼叫）。
     */
    injectCSS: function () {
      var style = document.createElement('style');
      style.textContent = [
        "/* player.css – abc2svg Player 樣式 */",
        "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}",
        ":root{--ink:#1a120b;--paper:#f5efe6;--accent:#8b3a3a;--muted:#c2a97a;--panel:rgba(245,239,230,0.66);--panel-solid: rgb(245,239,230)}",
        "html,body{height:100%;background:var(--paper);color:var(--ink);font-family:'Noto Serif TC','Kaiti TC','STKaiti',serif}",
        /* fab-toolbar：水平浮動，固定在右上角 */
        "#fab-toolbar{position:fixed;top:16px;right:4.0rem;z-index:50;display:flex;flex-direction:row;align-items:center;gap:6px;background:var(--panel);border:1px solid var(--muted);border-radius:8px;padding:6px 8px;box-shadow:0 4px 16px rgba(139,58,58,0.15);user-select:none}",
        ".fab-divider{width:1px;height:1.8em;background:var(--muted);opacity:.4;margin:0 2px}",
        "#play-pause-btn{display:flex;align-items:center;justify-content:center;width:2.4em;height:2.4em;border:1px solid var(--muted);border-radius:4px;background:transparent;color:var(--muted);font-size:1.1rem;cursor:pointer;transition:background .12s,color .12s;line-height:1;padding:0;font-family:inherit}",
        "#play-pause-btn:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
        "#loopSegBtn{position:relative;display:flex;align-items:center}",
        "#loop-icon{display:flex;align-items:center;justify-content:center;width:2.4em;height:2.4em;border:1px solid var(--muted);border-radius:4px;background:transparent;color:var(--muted);font-size:1.1rem;cursor:pointer;transition:background .12s,color .12s;line-height:1;padding:0;font-family:inherit;white-space:nowrap}",
        "#loop-icon:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
        "#loop-icon.active{background:rgba(139,58,58,0.15);color:var(--ink)}",
        "#dright{display:none}",
        ".abc-slot{display:block;width:100%;margin:0 auto}",
        ".abc-slot svg{display:block;width:100%;height:auto}",
        ".abcr{fill:#8b3a3a;fill-opacity:0;z-index:15}",
        ".abcr.sel{fill:#3cc878}",
        ".abcr.selb{fill:#e07b00}",
        "#errbanner{display:none;background:#c0392b;color:#fff;padding:6px 16px;font-size:.82rem;cursor:pointer}",
        ".tune-block{border:1px solid #ccc;border-radius:6px;margin:16px auto;max-width:85%;padding:12px 16px 0;background:#fffdf8}",
        ".tune-block p{margin:0 0 6px;font-size:.88rem;color:#444;white-space:pre-wrap;font-family:monospace}",
        ".tune-svg svg,.tune-block svg{display:block;width:100%;height:auto}",
        /* 調速面板：底部 sheet，仿 YouTube 風格 */
        "#speed-panel{position:fixed;bottom:0;left:0;right:0;z-index:300;display:flex;justify-content:center;pointer-events:none;transform:translateY(100%);transition:transform .22s cubic-bezier(.4,0,.2,1)}",
        "#speed-panel.open{transform:translateY(0)}",
        "#speed-panel-inner{pointer-events:all;width:100%;max-width:87%;background:var(--panel-solid);border:1px solid var(--muted);border-radius:16px 16px 0 0;box-shadow:0 -4px 24px rgba(26,18,11,0.18);padding:8px 0 0;margin:0 12px}",
        /* 頂部拖曳把手（仿 iOS/Android sheet）*/
        "#speed-handle{width:36px;height:4px;border-radius:2px;background:var(--muted);opacity:.5;margin:0 auto 16px}",
        "#speed-display{text-align:center;font-size:1.8rem;font-weight:700;color:var(--ink);margin-bottom:20px;letter-spacing:.02em}",
        "#speed-slider-row{display:flex;align-items:center;gap:14px;margin:0 20px 18px}",
        "#speed-minus,#speed-plus{flex-shrink:0;width:2.2em;height:2.2em;border:1px solid var(--muted);border-radius:50%;background:transparent;color:var(--ink);font-size:1.1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .12s}",
        "#speed-minus:hover,#speed-plus:hover{background:rgba(139,58,58,0.12)}",
        "#speed-slider{flex:1;-webkit-appearance:none;appearance:none;height:4px;border-radius:2px;background:linear-gradient(to right,var(--accent) var(--pct,50%),var(--muted) var(--pct,50%));outline:none;cursor:pointer}",
        "#speed-slider::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;background:var(--accent);cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.25)}",
        "#speed-slider::-moz-range-thumb{width:22px;height:22px;border-radius:50%;background:var(--accent);cursor:pointer;border:none;box-shadow:0 1px 4px rgba(0,0,0,.25)}",
        "#speed-presets{display:flex;justify-content:center;gap:8px;flex-wrap:wrap;padding:0 20px 24px}",
        ".speed-preset{padding:7px 16px;border:1px solid var(--muted);border-radius:20px;background:transparent;color:var(--muted);font-size:.82rem;font-family:inherit;cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
        ".speed-preset:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
        ".speed-preset.active{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600}",
        "#speed-btn{display:flex;align-items:center;justify-content:center;width:2.4em;height:2.4em;border:1px solid var(--muted);border-radius:4px;background:transparent;color:var(--muted);font-size:1.1rem;cursor:pointer;transition:background .12s,color .12s;line-height:1;padding:0;font-family:inherit}",
        "#speed-btn:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
        "#speed-btn.active{background:rgba(139,58,58,0.15);color:var(--ink)}"
      ].join('\n');
      document.head.appendChild(style);

      if (!document.querySelector('meta[charset]')) {
        var m = document.createElement('meta');
        m.setAttribute('charset', 'UTF-8');
        document.head.insertBefore(m, document.head.firstChild);
      }
    },

    // ══════════════════════════════════════════
    // 2. 建立 DOM 結構
    // ══════════════════════════════════════════

    /**
     * buildDOM()
     *
     * 建立 fab-toolbar 與 speed-panel 的 DOM 結構，插入 body。
     * 由模組自身在載入時立即執行（見檔案尾端的 IIFE 呼叫）。
     * 依賴 CFG（全域常數），需在 loader.js 之後或 CFG 已定義時執行。
     *
     * 注意：此函式在 init() 之前執行（模組載入時立即建立 DOM），
     *       init() 之後才能存取 _cfg；DOM 元素引用由 _setupButtons / _setupSpeedPanel 取得。
     */
    buildDOM: function (CFG) {
      document.documentElement.setAttribute('lang', 'zh-TW');
      if (!document.title) document.title = 'abc2svg Player';

      var body = document.body;
      body.insertAdjacentHTML('afterbegin', [
        '<div id="fab-toolbar">',
        '  <button id="play-pause-btn">' + CFG.ICON_PLAY + '</button>',
        '  <div class="fab-divider"></div>',
        '  <div id="loopSegBtn">',
        '    <span id="loop-icon">' + CFG.ICON_NOLOOP + '</span>',
        '  </div>',
        '  <div class="fab-divider"></div>',
        '  <button id="speed-btn">' + CFG.ICON_SPEED + '</button>',
        '</div>',
        '<div id="errbanner"></div>',
        '<div id="dright">',
        '  <div id="target">',
        '    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="60" viewBox="0 0 800 60">',
        '      <text x="300" y="40" font-family="serif" font-size="14" fill="#c2a97a">載入中…</text>',
        '    </svg>',
        '  </div>',
        '</div>'
      ].join('\n'));

      document.getElementById('errbanner').onclick = function () { this.style.display = 'none'; };

      // ── 調速面板（底部 sheet，獨立插入 body 末端）──────────────────
      var _presetHtml = CFG.SPEED_PRESETS.map(function (v) {
        return '<button class="speed-preset' + (v === CFG.SPEED_DEFAULT ? ' active' : '') +
               '" data-speed="' + v + '">' + v + 'x</button>';
      }).join('');
      body.insertAdjacentHTML('beforeend', [
        '<div id="speed-panel">',
        '  <div id="speed-panel-inner">',
        '    <div id="speed-handle"></div>',
        '    <div id="speed-display">' + CFG.SPEED_DEFAULT.toFixed(2) + '×</div>',
        '    <div id="speed-slider-row">',
        '      <button id="speed-minus">－</button>',
        '      <input id="speed-slider" type="range"',
        '        min="' + CFG.SPEED_MIN + '" max="' + CFG.SPEED_MAX + '"',
        '        step="' + CFG.SPEED_STEP + '" value="' + CFG.SPEED_DEFAULT + '" />',
        '      <button id="speed-plus">＋</button>',
        '    </div>',
        '    <div id="speed-presets">' + _presetHtml + '</div>',
        '  </div>',
        '</div>'
      ].join('\n'));
    },

    // ══════════════════════════════════════════
    // 7. 點擊事件
    // ══════════════════════════════════════════

    /**
     * onLeftClick(evt)
     *
     * 左鍵點擊處理：依目前 PlayState 決定行為。
     *   PAUSED  + 音符 → seekTo
     *   PAUSED  + 空白 → resume
     *   PLAYING + 音符 → stop + seekTo
     *   PLAYING + 空白 → pause
     *   IDLE    + 音符 → seekTo
     *   IDLE    + 空白 → play（感知 A/B 點）
     *
     * @param {MouseEvent} evt
     */
    onLeftClick: function (evt) {
      var v = UIController._getSymIndex(evt.target);
      var PlayState = _cfg.PlayState;
      var state = _cfg.getState();

      // ── paused 狀態 ───────────────────────────────────────────────
      if (state === PlayState.PAUSED) {
        if (v) _cfg.api.seekTo(v);
        else   _cfg.api.resume();
        return;
      }

      // ── playing 狀態 ──────────────────────────────────────────────
      if (state === PlayState.PLAYING) {
        if (v) {
          // abcplay.stop() 同步呼叫 onPlayEnd，stopPlay() 返回時
          // play.state 已為 IDLE，seekTo() 可安全起播。
          _cfg.api.stop(); _cfg.api.seekTo(v);
        } else {
          _cfg.api.pause();
        }
        return;
      }

      // ── idle 狀態 ─────────────────────────────────────────────────
      if (v) _cfg.api.seekTo(v);
      else   _cfg.api.play();  // 無音符：從頭（或上次位置）起播，感知 A/B 點
    },

    /**
     * onRightClick(evt)
     *
     * 右鍵點擊處理：設 B 點（選段終點）。
     * 播放中即時調整終點：以目前 A 點（selx[0]）和新 B 點重算 ei。
     *
     * @param {MouseEvent} evt
     */
    onRightClick: function (evt) {
      evt.preventDefault();
      var v = UIController._getSymIndex(evt.target);
      if (!v) return;
      // 右鍵點音符：設 B 點
      UIController.setsel(1, v);
      var PlayState = _cfg.PlayState;
      if (_cfg.getState() === PlayState.PLAYING) {
        // 播放中即時調整終點：以目前 A 點（selx[0]）和新 B 點重算 ei
        // 與 play_tune 的 A/B 對調保護對齊：b < a 時 swap 後重算
        var selx = _cfg.getSelx();
        var a = selx[0], b = v, si;
        if (a) {
          if (b < a) { var t = a; a = b; b = t; }
          si = _cfg.api.getSe(a);
        } else {
          si = _cfg.api.getPlaySi();
        }
        if (si) {
          var newEi = (a === b)
            ? _cfg.api.getMeasureEnd(a)
            : _cfg.api.getEeByTime(si, _cfg.api.getSyms(b));
          _cfg.api.setCurrentPoEnd(newEi);
          _cfg.api.setPlayEi(newEi);
          // 選段範圍變更：循環計數歸零，UI 從第一圈重新顯示
          if (_cfg.getLoopMode() !== 0) {
            _cfg.setLoopCount(0);
            UIController.refreshToggleLabel();
          }
        }
      }
    },

    // ══════════════════════════════════════════
    // 8. 播放按鈕 + 循環開關
    // ══════════════════════════════════════════

    /**
     * refreshToggleLabel()
     *
     * 統一刷新播放按鈕圖示與循環圖示。
     * 由 getCallbacks().onStateChange 回傳，填入 play.onStateChange。
     */
    refreshToggleLabel: function () {
      UIController._refreshPlayPauseBtn();
      UIController._refreshLoopIcon();
    },

    // ══════════════════════════════════════════
    // 9. 選取高亮
    // ══════════════════════════════════════════

    /**
     * setOpacity(v, op, cls)
     *
     * 設定指定 istart 對應的所有 .abcr 元素的 fillOpacity 與 CSS class。
     *
     * @param {number} v   - symbol istart
     * @param {number} op  - fillOpacity 值（0 或 0.4）
     * @param {string} cls - 要加的 CSS class（'sel' / 'selb' / null）
     */
    setOpacity: function (v, op, cls) {
      if (!v) return;
      var elts = document.getElementsByClassName('_' + v + '_');
      for (var i = elts.length - 1; i >= 0; i--) {
        elts[i].style.fillOpacity = op;
        elts[i].classList.remove('sel', 'selb');
        if (op && cls) elts[i].classList.add(cls);
      }
    },

    /**
     * setsel(idx, v)
     *
     * 設定 A 點（idx=0）或 B 點（idx=1）的選取高亮。
     * 同時更新 selx[idx]（透過 _cfg.getSelx() 取得 selx 陣列引用並直接寫入）。
     *
     * @param {number} idx - 0=A點，1=B點
     * @param {number} v   - symbol istart（0 表示清除）
     */
    setsel: function (idx, v) {
      var selx = _cfg.getSelx();
      if (v === selx[idx]) return;
      UIController.setOpacity(selx[idx], 0, null);
      UIController.setOpacity(v, 0.4, idx === 0 ? 'sel' : 'selb');
      selx[idx] = v;
    },

    /**
     * clearAllHighlight()
     *
     * 清除全部播放中音符高亮（pause / resume 時呼叫）。
     * 由 getCallbacks().onClearHighlight 回傳，填入 play.onClearHighlight。
     */
    clearAllHighlight: function () {
      var curNotes = _cfg.getCurNotes();
      curNotes.forEach(function (i) { UIController.setNoteOp(i, false); });
      _cfg.clearCurNotes();
    },

    // ══════════════════════════════════════════
    // 10. 播放中音符高亮
    // ══════════════════════════════════════════

    /**
     * setNoteOp(i, on)
     *
     * 設定單一音符的高亮狀態，並在音符進入視窗邊緣時自動捲動。
     * 由 getCallbacks().onNoteHighlight 回傳，填入 play.onNoteHighlight。
     *
     * 選取 marker 保護：若 i 是 A/B 點（selx / selx_sav），
     * on=false 時仍保持 0.4 不清除（選取高亮優先）。
     *
     * 捲動邏輯：
     *   觸發條件：音符進入下 1/5（bottom 超過 4/5 高度）或超出上緣（top < 20）
     *   捲動目標：讓音符落在上 1/3（r.top → innerHeight / 3）
     *   防抖：_scrollPending 期間不重複觸發，避免 smooth 動畫連續疊加抖動
     *
     * @param {number}  i  - symbol istart
     * @param {boolean} on - true=亮，false=暗
     */
    setNoteOp: function (i, on) {
      var elts = document.getElementsByClassName('_' + i + '_');
      if (!elts || !elts.length) return;
      var selx    = _cfg.getSelx();
      var selxSav = _cfg.getSelxSav();
      var isMarker = (i === selx[0] || i === selxSav[0] || i === selx[1] || i === selxSav[1]);
      var op = on ? 0.4 : (isMarker ? 0.4 : 0);
      for (var j = 0; j < elts.length; j++) elts[j].style.fillOpacity = op;
      if (on) {
        var r = elts[0].getBoundingClientRect();
        var triggerLow  = r.bottom > window.innerHeight * 4 / 5;
        var triggerHigh = r.top < 20;
        if ((triggerLow || triggerHigh) && !_scrollPending) {
          _scrollPending = true;
          window.scrollBy({ top: r.top - window.innerHeight / 3, behavior: 'smooth' });
          setTimeout(function () { _scrollPending = false; }, 500);
        }
      }
    },

    // ══════════════════════════════════════════
    // 內部私有方法
    // ══════════════════════════════════════════

    /**
     * _getSymIndex(el)
     *
     * 從點擊目標 DOM 元素取得 symbol istart。
     * .abcr 元素的 class 形如 "_12345_"，從中解析數字。
     *
     * @param  {Element}      el - evt.target
     * @return {number|null}     - istart 或 null
     */
    _getSymIndex: function (el) {
      if (!el) return null;
      var c = el.getAttribute('class') || '';
      var m = c.match(/_(\d+)_/);
      return m ? parseInt(m[1]) : null;
    },

    /**
     * _refreshPlayPauseBtn()
     *
     * 根據目前 PlayState 更新播放/暫停按鈕的圖示。
     */
    _refreshPlayPauseBtn: function () {
      var ppBtn = document.getElementById('play-pause-btn');
      if (!ppBtn) return;
      var PlayState = _cfg.PlayState;
      var CFG = _cfg.CFG;
      var icon;
      switch (_cfg.getState()) {
        case PlayState.PAUSED:  icon = CFG.ICON_RESUME; break;
        case PlayState.PLAYING: icon = CFG.ICON_PAUSE;  break;
        default:                icon = CFG.ICON_PLAY;   // IDLE / STOPPING
      }
      ppBtn.textContent = icon;
    },

    /**
     * _refreshLoopIcon()
     *
     * 根據 loopMode / loopCount / PlayState 更新循環圖示。
     * 播放中顯示累計循環次數，否則顯示開/關圖示。
     */
    _refreshLoopIcon: function () {
      var loopIcon = document.getElementById('loop-icon');
      if (!loopIcon) return;
      var PlayState = _cfg.PlayState;
      var CFG = _cfg.CFG;
      var loopMode  = _cfg.getLoopMode();
      var loopCount = _cfg.getLoopCount();
      var on = loopMode !== 0;
      loopIcon.classList.toggle('active', on);
      if (on && _cfg.getState() === PlayState.PLAYING) {
        // 播放中顯示累計循環次數
        loopIcon.textContent = '×' + (loopCount + 1);
      } else {
        loopIcon.textContent = on ? CFG.ICON_LOOP : CFG.ICON_NOLOOP;
      }
    },

    /**
     * _setupButtons()
     *
     * 綁定播放按鈕與循環開關的 click 事件。
     * 在 init() 內呼叫（DOM 已存在）。
     */
    _setupButtons: function () {
      var loopIcon = document.getElementById('loop-icon');
      var ppBtn    = document.getElementById('play-pause-btn');
      var PlayState = _cfg.PlayState;
      var CFG = _cfg.CFG;

      // ── Play/Pause 按鈕 click ──────────────────────────────────────
      ppBtn.addEventListener('click', function () {
        var state = _cfg.getState();
        if (state === PlayState.PAUSED) {
          // paused 狀態：resume（直接接續，不走 play_next）
          _cfg.api.resume();
        } else if (state === PlayState.PLAYING) {
          // playing 狀態：pause（凍結 ac，保留 po）
          _cfg.api.pause();
        } else {
          // idle 狀態：play_tune() 統一感知 A/B 點與 play.si
          _cfg.api.play();
        }
      });

      // ── 內部：啟用循環 ────────────────────────────────────────────
      function setLoopMode() {
        _cfg.setLoopMode(CFG.LOOP_INFINITE);
        _cfg.setLoopCount(0);
        UIController._refreshLoopIcon();
      }

      // ── 內部：關閉循環 ────────────────────────────────────────────
      function clearLoopMode() {
        _cfg.setLoopMode(0);
        _cfg.setLoopCount(0);
        UIController._refreshLoopIcon();
      }

      // ── loop-icon click：直接 toggle loopMode ─────────────────────
      loopIcon.addEventListener('click', function (e) {
        e.stopPropagation();
        if (_cfg.getLoopMode() !== 0) clearLoopMode();
        else setLoopMode();
      });
    },

    /**
     * _setupSpeedPanel()
     *
     * 綁定調速面板所有互動：開關、滑桿、+/-、預設按鈕。
     * 在 init() 內呼叫（DOM 已存在）。
     */
    _setupSpeedPanel: function () {
      var CFG      = _cfg.CFG;
      var panel    = document.getElementById('speed-panel'),
          display  = document.getElementById('speed-display'),
          slider   = document.getElementById('speed-slider'),
          btnMinus = document.getElementById('speed-minus'),
          btnPlus  = document.getElementById('speed-plus'),
          speedBtn = document.getElementById('speed-btn');

      // ── 更新滑桿填色（用 CSS 自訂屬性模擬已填色段）────────────────
      function updateSliderFill(v) {
        var pct = ((v - CFG.SPEED_MIN) / (CFG.SPEED_MAX - CFG.SPEED_MIN) * 100).toFixed(1) + '%';
        slider.style.setProperty('--pct', pct);
      }

      // ── 套用速度（更新所有 UI 並呼叫引擎）──────────────────────────
      function applySpeed(v) {
        // 限制在合法範圍，四捨五入到 STEP
        v = Math.round(v / CFG.SPEED_STEP) * CFG.SPEED_STEP;
        v = Math.max(CFG.SPEED_MIN, Math.min(CFG.SPEED_MAX, v));
        v = parseFloat(v.toFixed(2));

        // 更新顯示
        display.textContent = v.toFixed(2) + '×';
        slider.value = v;
        updateSliderFill(v);

        // 更新預設按鈕 active 狀態
        var presets = panel.querySelectorAll('.speed-preset');
        presets.forEach(function (btn) {
          btn.classList.toggle('active', parseFloat(btn.dataset.speed) === v);
        });

        // 通知播放引擎（播放中即時生效，未播放時下次播放自動套用）
        _cfg.api.setSpeed(v);
      }

      // ── 開關面板 ──────────────────────────────────────────────────
      function openPanel() {
        panel.classList.add('open');
        speedBtn.classList.add('active');
      }

      function closePanel() {
        panel.classList.remove('open');
        speedBtn.classList.remove('active');
      }

      // ── 速度 icon 按鈕：toggle panel ──────────────────────────────
      speedBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (panel.classList.contains('open')) closePanel();
        else openPanel();
      });

      // ── 點擊 panel 外關閉（避免 panel 內部操作誤觸發）────────────
      document.addEventListener('click', function (e) {
        if (panel.classList.contains('open') &&
            !panel.contains(e.target) &&
            e.target !== speedBtn) {
          closePanel();
        }
      });

      // ── 滑桿拖曳 ──────────────────────────────────────────────────
      slider.addEventListener('input', function () {
        applySpeed(parseFloat(slider.value));
      });

      // ── +/- 按鈕 ──────────────────────────────────────────────────
      btnMinus.addEventListener('click', function (e) {
        e.stopPropagation();
        applySpeed(_cfg.getSpeed() - CFG.SPEED_STEP);
      });
      btnPlus.addEventListener('click', function (e) {
        e.stopPropagation();
        applySpeed(_cfg.getSpeed() + CFG.SPEED_STEP);
      });

      // ── 預設快速選擇按鈕 ──────────────────────────────────────────
      panel.addEventListener('click', function (e) {
        var btn = e.target.closest('.speed-preset');
        if (!btn) return;
        e.stopPropagation();
        applySpeed(parseFloat(btn.dataset.speed));
      });

      // ── 初始化（設定滑桿填色）────────────────────────────────────
      updateSliderFill(CFG.SPEED_DEFAULT);
    }

  };

  // ── 模組導出 ──────────────────────────────────────────────────────
  if (typeof module === 'object' && module.exports) {
    module.exports = UIController;
  } else {
    root.UIController = UIController;
  }

}(typeof globalThis !== 'undefined' ? globalThis : this));
