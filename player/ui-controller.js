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

  // [playline] 獨立 overlay 細線池（方案 B）
  // 不動 .abcr rect，用 position:fixed 的 <div> 疊在音符左邊界。
  // 預建固定數量（PLAYLINE_POOL_SIZE），避免動態建立元素。
  // _linePool       : 空閒的 div 陣列
  // _lineMap        : Map<istart, {div, elt}>，記錄哪個 istart 佔用了哪個 div
  // _highlightWidth : null = fill（與音符等寬色塊）；數字 = line（固定寬細線 px）
  var PLAYLINE_POOL_SIZE = 4;
  var _linePool        = [];           // Array<div>（空閒）
  var _lineMap         = new Map();    // Map<istart, {div, elt}>（使用中）
  var _highlightWidth  = null;         // null=fill | number=line px，預設 fill

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
     *   getSelx      {function} – () → selx 陣列引用（UI 高亮本地鏡像）
     *   getSelxSav   {function} – () → selx_sav 陣列引用
     *   getSpeed     {function} – () → currentSpeed 數值
     *   PlayState    {object}   – PlayState 枚舉
     *   CFG          {object}   – CFG 常數物件
     *
     * 注意：loopMode / loopCount 已改由全域 StateManager 管理，
     *       不再透過 cfg 存取器傳入。
     */
    init: function (cfg) {
      _cfg = cfg;
      UIController._buildLinePool();
      UIController._setupButtons();
      UIController._setupSpeedPanel();
      // [playline] 捲動時重新定位所有顯示中的細線
      // [passageMark] 捲動時重新定位所有顯示中的色帶
      window.addEventListener('scroll', function () {
        UIController._repositionLines();
        if (root.PassageMarkPackage) root.PassageMarkPackage.reposition();
      }, { passive: true });
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
        "#loopSegBtn{position:relative;display:flex;align-items:center}",
        "#loop-icon{display:flex;align-items:center;justify-content:center;width:2.4em;height:2.4em;border:1px solid var(--muted);border-radius:4px;background:transparent;color:var(--muted);font-size:1.1rem;cursor:pointer;transition:background .12s,color .12s;line-height:1;padding:0;font-family:inherit;white-space:nowrap}",
        "#loop-icon:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
        "#loop-icon.active{background:rgba(139,58,58,0.15);color:var(--ink)}",
        "#back-btn{display:flex;align-items:center;justify-content:center;width:2.4em;height:2.4em;border:1px solid var(--muted);border-radius:4px;background:transparent;color:var(--muted);font-size:1.1rem;cursor:pointer;transition:background .12s,color .12s;line-height:1;padding:0;font-family:inherit}",
        "#back-btn:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
        "#dright{display:none}",
        ".abc-slot{display:block;width:100%;margin:0 auto}",
        ".abc-slot svg{display:block;width:100%;height:auto}",
        ".abcr{fill:#8b3a3a;fill-opacity:0;z-index:15}",
        ".abcr.sel{fill:#3cc878}",
        ".abcr.selb{fill:#e07b00}",
        /* [ball-pre] 換行預點亮：小球掉落期間提前點亮目標音符，橘色同 selb      */
        /* 由 ball-controller.js _preHighlightNote 加上，onNoteOn 落地後移除    */
        ".abcr.abcr-pre{fill:#e07b00;fill-opacity:0.4}",
        /* [playline] 播放中音符高亮：fixed overlay，不影響 SVG layout           */
        /* left:0;top:0 固定在原點，實際位置完全由 transform:translate 控制        */
        /* will-change:transform 提示瀏覽器提升到獨立 GPU layer，定位零 Layout     */
        /* width/height 由 _positionLine 動態設定，與對應 .abcr rect 尺寸一致     */
        ".playline{position:fixed;left:0;top:0;background:#40d0ff;opacity:0;pointer-events:none;z-index:20;border-radius:1px;will-change:transform}",
        ".playline.on{opacity:0.4}",
        /* [passageMark] 樂句螢光筆色帶：pause 時顯示，覆蓋播放走過的樂句範圍  */
        /* 每行一個 div，x_min~x_max 為該行所有音符的水平跨度                   */
        ".passage-band{position:fixed;left:0;top:0;background:#c285ff;opacity:0.32;pointer-events:none;z-index:18;border-radius:3px;will-change:transform}",
        "#errbanner{display:none;background:#c0392b;color:#fff;padding:6px 16px;font-size:.82rem;cursor:pointer}",
        ".tune-block{border:1px solid #ccc;border-radius:6px;margin:16px auto;max-width:85%;padding:12px 16px 0;background:#fffdf8}",
        ".tune-block p{margin:0 0 6px;font-size:.88rem;color:#444;white-space:pre-wrap;font-family:monospace}",
        ".tune-svg svg,.tune-block svg{display:block;width:100%;height:auto}",
        /* 調速面板：底部 sheet，仿 YouTube 風格 */
        "#speed-panel{position:fixed;bottom:20px;left:0;right:0;z-index:300;display:flex;justify-content:center;pointer-events:none;transform:translateY(calc(100% + 100px));transition:transform .22s cubic-bezier(.4,0,.2,1)}",
        /* 僅在「直屏」時判斷比例 */
        /* 直屏平板 (如 iPad 16:10 豎拿, 比例 > 1.4): 50px */
        "@media (orientation: portrait) and (max-aspect-ratio: 10/14){ #speed-panel{bottom:50px} }",
        /* 直屏手機 (如 18:9 以上窄長手機, 比例 > 1.85): 80px */
        "@media (orientation: portrait) and (max-aspect-ratio: 10/185){ #speed-panel{bottom:80px} }",
        "#speed-panel.open{transform:translateY(0)}",
        "#speed-panel-inner{pointer-events:all;width:100%;max-width:87%;background:var(--panel-solid);border:1px solid var(--muted);border-radius:16px;box-shadow:0 8px 32px rgba(26,18,11,0.22);padding:8px 0 0;margin:0 12px}",
        /* 頂部拖曳把手（仿 iOS/Android sheet）*/
        "#speed-handle{width:40px;height:5px;border-radius:3px;background:var(--muted);opacity:.3;margin:0 auto 12px;cursor:pointer}",
        "#speed-handle:hover{opacity:.6}",
        "#speed-display{text-align:center;font-size:1.8rem;font-weight:700;color:var(--ink);margin-bottom:20px;letter-spacing:.02em}",
        "#speed-slider-row{display:flex;align-items:center;gap:14px;margin:0 20px 18px}",
        "#speed-minus,#speed-plus{flex-shrink:0;width:2.2em;height:2.2em;border:1px solid var(--muted);border-radius:50%;background:transparent;color:var(--ink);font-size:1.2rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .12s}",
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
        "#speed-btn.active{background:rgba(139,58,58,0.15);color:var(--ink)}",
        "@font-face{font-family:'NumberFont';src:url('/fonts/Roboto-Black.ttf') format('truetype'),local('sans-serif-black'),local('NotoSerif-Bold'),local('Impact'),local('Arial Black'),local('Verdana');unicode-range:U+30-39}",
        "svg[class*=\"tune\"] text{font-family:'NumberFont',music}"
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
        '  <button id="back-btn" title="Back to start">⏮</button>',
        '  <div class="fab-divider"></div>',
        '  <div id="loopSegBtn">',
        '    <span id="loop-icon">' + CFG.ICON_NOLOOP + '</span>',
        '  </div>',
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
     * PLAYING / PAUSED 皆即時同步 po.s_end 與 play.ei，確保
     * resume 後能接續正確的 B 點，而非 pause 前的舊 B 點。
     *
     * Toggle 行為：右鍵再點同一 B 點音符 → 清除 B 點（播到曲尾）。
     *   - selx[1] 歸零，高亮清除
     *   - PLAYING / PAUSED：po.s_end = null（自然結尾）、play.ei = null
     *   - 循環計數歸零，UI 重新顯示
     *
     * @param {MouseEvent} evt
     */
    onRightClick: function (evt) {
      evt.preventDefault();
      var v = UIController._getSymIndex(evt.target);
      if (!v) return;

      var PlayState = _cfg.PlayState;
      var state = _cfg.getState();
      var selx = _cfg.getSelx();
      // 判斷是否需要同步 po.s_end（PLAYING 或 PAUSED 狀態皆需要）
      var isActive = (state === PlayState.PLAYING || state === PlayState.PAUSED);
      var SM = root.StateManager;

      // ── Toggle：右鍵再點同一 B 點 → 清除 B 點 ──────────────────────
      if (v === selx[1]) {
        UIController.setsel(1, 0);
        // ── [StateManager] 清除 B 點，自動禁用 AB 模式 ──
        if (SM) {
          SM.setSelectionB(0);
          SM.setLoopMode(0);
        }
        if (isActive) {
          // po.s_end = null → 播到曲尾；play.ei = null 同步
          // PAUSED 時 po.s_end 同步確保 resume 後不再受舊 B 點限制
          _cfg.api.setCurrentPoEnd(null);
          _cfg.api.setPlayEi(null);
          // 循環計數歸零，UI 從第一圈重新顯示
          UIController._resetLoopIfActive();
        }
        return;
      }

      // ── 右鍵點新音符：設 B 點 ──────────────────────────────────────
      UIController.setsel(1, v);
      // ── [StateManager] 設新 B 點，自動啟用 AB 模式 ──
      if (SM) {
        SM.setSelectionB(v);
        if (SM.getState().playback.loopMode === 0) SM.setLoopMode(_cfg.CFG.LOOP_INFINITE);
      }
      if (isActive) {
        // 即時調整終點：以目前 A 點（selx[0]）和新 B 點重算 ei
        // 與 play_tune 的 A/B 對調保護對齊：b < a 時 swap 後重算
        // PAUSED 時同步 po.s_end，確保 resume 後接續正確的新 B 點
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
          UIController._resetLoopIfActive();
        }
      }
    },

    // ══════════════════════════════════════════
    // 8. 播放按鈕 + 循環開關
    // ══════════════════════════════════════════

    /**
     * refreshToggleLabel()
     *
     * 統一刷新循環圖示。
     * 由 getCallbacks().onStateChange 回傳，填入 play.onStateChange。
     */
    refreshToggleLabel: function () {
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
     *
     * [playline] 將 _lineMap 所有使用中的 div 隱藏並歸還 _linePool。
     * _lineMap.clear() 比 new Map() 更輕量，不觸發 GC。
     * _cfg.clearCurNotes() 維持與 Driver 層的計數合約。
     */
    clearAllHighlight: function () {
      // ── [playline] 歸還所有使用中的線條 div ──────────────────────────
      _lineMap.forEach(function (entry) {
        entry.div.classList.remove('on');
        _linePool.push(entry.div);
      });
      _lineMap.clear();   // 比 new Map() 更輕量，不觸發 GC

      // ── Driver 層計數清除（維持 curNotes 合約）───────────────────────
      _cfg.clearCurNotes();
    },

    // ══════════════════════════════════════════
    // 10. 播放中音符高亮
    // ══════════════════════════════════════════

    /**
     * scrollToNote(i)
     *
     * 觸發捲動：若 istart 對應的音符在視窗邊緣外，執行 smooth scroll。
     * 與 setNoteOp(on=true) 的捲動邏輯相同，但不操作 playline overlay。
     * 供 ball-controller.js 的 _preHighlightNote 呼叫，
     * 確保換行第二段（掉落）開始前畫面已捲到目標行。
     *
     * @param {number} i - symbol istart
     */
    scrollToNote: function (i) {
      var elts = document.getElementsByClassName('_' + i + '_');
      if (!elts || !elts.length) return;
      var r = elts[0].getBoundingClientRect();
      var triggerLow  = r.bottom > window.innerHeight * 4 / 5;
      var triggerHigh = r.top < 20;
      if ((triggerLow || triggerHigh) && !_scrollPending) {
        _scrollPending = true;
        window.scrollBy({ top: r.top - window.innerHeight / 3, behavior: 'smooth' });
        setTimeout(function () { _scrollPending = false; }, 500);
      }
    },

    /**
     * setNoteOp(i, on)
     *
     * 設定單一音符的高亮狀態，並在音符進入視窗邊緣時自動捲動。
     * 由 getCallbacks().onNoteHighlight 回傳，填入 play.onNoteHighlight。
     *
     * [playline] 方案 B：完全不動 .abcr rect，改用獨立 overlay div 顯示細線。
     *   on=true ：從 _linePool 取 div，定位到音符左邊界，顯示；存入 _lineMap。
     *   on=false：從 _lineMap 取 div，隱藏，歸還 _linePool；從 _lineMap 刪除。
     *   .abcr rect 的 fillOpacity 不再操作（高亮完全由細線負責）。
     *   A/B 點選取高亮（setOpacity）維持不變，不受此函式影響。
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

      if (on) {
        // ── [playline] on：取 div，定位，顯示 ───────────────────────────
        var elt = elts[0];
        var r   = elt.getBoundingClientRect();  // .abcr 未被動過，座標正確

        if (!_lineMap.has(i)) {
          // [優化3] pool 耗盡時自動補充一個，避免靜默失敗
          if (_linePool.length === 0) {
            var extra = document.createElement('div');
            extra.className = 'playline';
            document.body.appendChild(extra);
            _linePool.push(extra);
          }
          var div = _linePool.pop();
          UIController._positionLine(div, r);
          div.classList.add('on');
          // [優化2] 同時存 elt 引用，_repositionLines 不需要再 querySelector
          _lineMap.set(i, { div: div, elt: elt });
        }

        // ── 捲動邏輯 ──────────────────────────────────────────────────
        var triggerLow  = r.bottom > window.innerHeight * 4 / 5;
        var triggerHigh = r.top < 20;
        if ((triggerLow || triggerHigh) && !_scrollPending) {
          _scrollPending = true;
          window.scrollBy({ top: r.top - window.innerHeight / 3, behavior: 'smooth' });
          setTimeout(function () { _scrollPending = false; }, 500);
        }

      } else {
        // ── [playline] off：隱藏，歸還 ──────────────────────────────────
        if (_lineMap.has(i)) {
          var entry  = _lineMap.get(i);
          entry.div.classList.remove('on');
          _linePool.push(entry.div);
          _lineMap.delete(i);
        }
      }
    },

    /**
     * setHighlightMode(mode)
     *
     * 切換播放中音符的高亮樣式。
     *
     * @param {string} mode
     *   'fill' - 與音符等寬色塊（預設）
     *   'line' - 左邊界固定寬細線（3px）
     *
     * 切換時立即重新定位所有顯示中的高亮 div，不需要重新播放。
     * 若需要自訂線寬，可直接設 _highlightWidth（模組內部使用）。
     */
    setHighlightMode: function (mode) {
      _highlightWidth = (mode === 'line') ? 3 : null;
      // 立即套用至目前顯示中的所有 div
      _lineMap.forEach(function (entry) {
        UIController._positionLine(entry.div, entry.elt.getBoundingClientRect());
      });
    },

    // ══════════════════════════════════════════
    // 內部私有方法
    // ══════════════════════════════════════════

    /**
     * _buildLinePool()
     *
     * 預建 PLAYLINE_POOL_SIZE 個 .playline div，掛到 body，全部隱藏。
     * 在 init() 內呼叫一次，之後不再建立新元素。
     */
    _buildLinePool: function () {
      for (var i = 0; i < PLAYLINE_POOL_SIZE; i++) {
        var div = document.createElement('div');
        div.className = 'playline';
        document.body.appendChild(div);
        _linePool.push(div);
      }
    },

    /**
     * _positionLine(div, r)
     *
     * 將 div 定位並縮放至對應音符的位置與尺寸。
     * r = getBoundingClientRect()，viewport 座標。
     *
     * [GPU] 定位改用 transform:translate 而非 left/top，
     * 配合 will-change:transform，瀏覽器將此元素提升到獨立 compositor layer，
     * 每次定位只在 GPU 上執行，零 CPU Layout/Paint，不干擾 rAF。
     *
     * width 由 _highlightWidth 決定：
     *   null（fill 模式）→ r.width，與音符等寬色塊
     *   數字（line 模式）→ 固定寬度（px），左邊界細線
     * height 只在變化時設定，後續同行音符只需更新 transform。
     *
     * @param {HTMLElement} div
     * @param {DOMRect}     r
     */
    _positionLine: function (div, r) {
      div.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
      var w = (_highlightWidth !== null ? _highlightWidth : r.width) + 'px';
      var h = r.height + 'px';
      if (div.style.width  !== w) div.style.width  = w;
      if (div.style.height !== h) div.style.height = h;
    },

    /**
     * _repositionLines()
     *
     * 捲動 / resize 時重新定位所有顯示中的高亮 div。
     * [優化2] _lineMap value 存有 elt 引用，直接用，零 DOM query。
     */
    _repositionLines: function () {
      _lineMap.forEach(function (entry) {
        UIController._positionLine(entry.div, entry.elt.getBoundingClientRect());
      });
    },

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
     * _resetLoopIfActive()
     *
     * 若循環模式已啟用，將 loopCount 歸零並刷新循環圖示。
     * 在 B 點變更時（清除或設新）呼叫，確保 UI 從第一圈重新顯示。
     */
    _resetLoopIfActive: function () {
      // 改讀 StateManager（唯一真值源）
      if (root.StateManager && root.StateManager.getState().playback.loopMode !== 0) {
        root.StateManager.setLoopCount(0);
        UIController.refreshToggleLabel();
      }
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
      // 改讀 StateManager（唯一真值源）
      var smState   = root.StateManager ? root.StateManager.getState() : null;
      var loopMode  = smState ? smState.playback.loopMode  : 0;
      var loopCount = smState ? smState.playback.loopCount : 0;
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
      var PlayState = _cfg.PlayState;
      var CFG = _cfg.CFG;

      // ── 播放控制：點擊樂譜空白區域會觸發 play / pause / resume ──
      // 按 Back 鈕 ⏮ 可跳回選段開始（見下方 Back 按鈕邏輯）

      // ── 內部：啟用循環（AB 模式）────────────────────────────────
      // OFF → AB：
      //   有 passage → 設 A/B 點，seekTo(A) 觸發 play_tune 感知新選段
      //   無 passage → 純 loopMode ON（保留原有行為，不改 A/B）
      function enableLoopAB() {
        var SM = root.StateManager;
        if (!SM) return;
        var span = SM.getPassageSpan();
        if (span) {
          // 有 passage：設 A/B 並 seekTo(A) 重新起播，讓 play_tune 感知新 B 點
          UIController.setsel(0, span.startIstart);
          UIController.setsel(1, span.endIstart);
          SM.setSelection(span.startIstart, span.endIstart);
          SM.setLoopMode(CFG.LOOP_INFINITE);
          SM.setLoopCount(0);
          UIController._refreshLoopIcon();
          // seekTo 走 play_tune 路徑，負責感知 B 點並重新起播
          _cfg.api.seekTo(span.startIstart);
        } else {
          // 無 passage：純 loopMode toggle，不改 A/B 點
          SM.setLoopMode(CFG.LOOP_INFINITE);
          SM.setLoopCount(0);
          UIController._refreshLoopIcon();
        }
      }

      // ── 內部：關閉循環（OFF 模式）───────────────────────────────
      // AB → OFF：清除 B 點，保留 A 點
      function disableLoopAB() {
        var SM = root.StateManager;
        if (!SM) return;
        // 取當前播放音符作為新 A 點（按下 loop 的那一刻就是新起點）
        // 改讀 StateManager（唯一真值源）
        var curNote = root.StateManager ? root.StateManager.getState().lastNote : 0;
        // 先清 B 點高亮
        UIController.setsel(1, 0);
        SM.setSelectionB(0);
        // 設新 A 點
        if (curNote) {
          UIController.setsel(0, curNote);
          SM.setSelectionA(curNote);
        } else {
          UIController.setsel(0, 0);
          SM.setSelectionA(0);
        }
        SM.setLoopMode(0);
        SM.setLoopCount(0);
        // 清空 passage，再把新 A 點推入，確保 pause 後色帶從新 A 點開始
        if (root.PassageMarkPackage) {
          root.PassageMarkPackage.onStop();   // 清空 _passage[]
          if (curNote) root.PassageMarkPackage.onNoteOn(curNote);  // 推入新起點
        }
        SM.clear();
        // PLAYING / PAUSED 中即時同步後端：清除 ei，讓當前播放繼續到曲尾
        var state = _cfg.getState();
        if (state === PlayState.PLAYING || state === PlayState.PAUSED) {
          _cfg.api.setCurrentPoEnd(null);
          _cfg.api.setPlayEi(null);
        }
        UIController._refreshLoopIcon();
      }

      // ── loop-icon click：依 loopMode 和 PlayState 決定行為 ──────
      // PLAYING + AB 模式：允許取消 AB → 直線播到曲尾
      // PLAYING + OFF 模式：禁用（無 passage 可設 A/B）
      // PAUSED / IDLE：正常 toggle
      loopIcon.addEventListener('click', function (e) {
        e.stopPropagation();
        var SM = root.StateManager;
        if (!SM) return;
        var isPlaying = _cfg.getState() === PlayState.PLAYING;
        var loopOn = SM.getState().playback.loopMode !== 0;
        // PLAYING + OFF：無意義，禁用
        if (isPlaying && !loopOn) return;
        if (loopOn) {
          disableLoopAB();
        } else {
          enableLoopAB();
        }
      });

      // ── Back 按鈕 click：跳回起點重播，不改 A/B 點和 loopMode ──
      // seekTo 本身已處理 A 點高亮更新與 keepB 判斷，Back 不需要額外操作。
      var backBtn = document.getElementById('back-btn');
      if (backBtn) {
        backBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          var SM = root.StateManager;
          if (!SM) return;
          var state = _cfg.getState();
          // PAUSED 或 PLAYING 時才操作
          if (state !== PlayState.PAUSED && state !== PlayState.PLAYING) return;
          // 先 flush _passage → StateManager，確保 PLAYING 中也能取到起點
          if (root.PassageMarkPackage) root.PassageMarkPackage.flushPassage();
          var span = SM.getPassageSpan();
          if (!span) return;  // 無任何播放記錄，不操作

          // PLAYING：先 stop，再 seekTo(起點)
          // PAUSED ：直接 seekTo（內部處理非同步序列）
          // A/B 點、loopMode 全部不動，seekTo 自帶 keepB 判斷
          if (state === PlayState.PLAYING) {
            _cfg.api.stop();
          }
          _cfg.api.seekTo(span.startIstart);
        });
      }
    },

    /**
     * _setupSpeedPanel()
     *
     * 綁定調速面板所有互動：開關、滑桿、+/-、預設按鈕。
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

      // ── 點擊橫棒收起 ──────────────────────────────────────────────
      var handle = document.getElementById('speed-handle');
      handle.addEventListener('click', function (e) {
        e.stopPropagation();
        closePanel();
      });

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