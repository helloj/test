/**
 * loader.js – abc2svg 播放器（多曲自包含版）
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
 * AbcDrill is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * Based on abc2svg by Jean-Francois Moine
 * @source: https://chiselapp.com/user/moinejf/repository/abc2svg
 */

/**
 * HTML 中只需：
 *   <script src="abc2svg-1.js"></script>
 *   <script src="snd-1.js"></script>
 *   <script src="jump-engine.js"></script>
 *   <script src="hook-bridge.js"></script>
 *   <script src="abcplay-driver.js"></script>
 *   <script src="ui-controller.js"></script>
 *   <script src="ball-controller.js"></script>
 *   <script src="loader.js"></script>
 *
 *   <!-- 每首曲子放在獨立的區塊 -->
 *   <script type="text/vnd.abc">
 *   X:1
 *   T:曲名
 *   ...
 *   </script>
 *
 * 本檔負責（協調層）：
 *   1. 注入 CSS（委派給 UIController）
 *   2. 建立 DOM 結構（委派給 UIController）
 *   3. 修補 abc2svg.play_next（委派給 HookBridge）
 *   4. 渲染 ABC → SVG
 *      - 收集所有 <script type="text/vnd.abc">，合併後一次 tosvg()
 *      - 每段 <script> 就地替換成 <div class="abc-slot">
 *      - 渲染完成後將各 tuneN SVG 搬入對應的 abc-slot
 *   5. 組裝各模組（AbcplayDriver / UIController）
 *
 * 播放邏輯（pause / resume / stop / notehlight 等）已移至 abcplay-driver.js。
 * UI 邏輯（點擊事件 / 按鈕 / 調速面板）已移至 ui-controller.js。
 *
 * 與 HTML 的約定：
 *   - 若頁面有 .tune-block 等父容器包住 <script type="text/vnd.abc">，
 *     SVG 會自然落在容器內，說明文字與樂譜穿插排列
 *   - #target（隱藏）作為殘留 SVG 的暫存容器
 */
;(function () {

// ══════════════════════════════════════════
// 0. 全域常數（類 C #define，集中修改）
// ══════════════════════════════════════════
var CFG = {
  // ── UI 圖示符號 ──────────────────────────
  ICON_PLAY:     '▶',   // 播放按鈕（idle 狀態）
  ICON_PAUSE:    '⏸',   // 暫停按鈕（playing 狀態）
  ICON_RESUME:   '⏯',   // 繼續按鈕（paused 狀態）
  ICON_LOOP:     '↺',   // 循環模式狀態指示（不可按）
  ICON_NOLOOP:   '↪',   // 非循環模式狀態指示（不可按）
  ICON_SPEED:    '๑ï',  // 調速按鈕

  // ── 播放速度 ─────────────────────────────
  SPEED_DEFAULT:  1.0,   // 預設速度（1x）
  SPEED_MIN:      0.25,  // 最小速度
  SPEED_MAX:      2.0,   // 最大速度
  SPEED_STEP:     0.05,  // +/- 步進
  SPEED_PRESETS:  [0.5, 0.75, 1, 1.25, 1.5],  // 快速選擇

  // ── 循環 ─────────────────────────────────
  LOOP_INFINITE: 99,    // loop-on 的代理數值（loopMode !== 0 即表示啟用）
};

// ══════════════════════════════════════════
// 1. 注入 CSS（委派給 UIController）
// ══════════════════════════════════════════
UIController.injectCSS();

// ══════════════════════════════════════════
// 2. 建立 DOM 結構（委派給 UIController）
// ══════════════════════════════════════════
UIController.buildDOM(CFG);

// ══════════════════════════════════════════
// 3. 修補 abc2svg.play_next（含 D.S. / D.C. 跳轉支援）
// ══════════════════════════════════════════
//
//   play_next 替換由 hook-bridge.js 的 HookBridge.setup() 負責。
//   跳轉決策委派給 jump-engine.js 的 JumpEngine.walkAnchors()。
//
HookBridge.setup();

// ══════════════════════════════════════════
// 4. Driver 初始化
// ══════════════════════════════════════════
//
//   AbcplayDriver 在此取得 UIController 引用與 CFG 常數。
//   後端（AbcPlay）在 doRender 的 setInterval 確認可用後注入（setBackend）。
//
AbcplayDriver.init({
  uiController: UIController,
  CFG:          CFG
});

// ══════════════════════════════════════════
// 5. 渲染核心（以 abcweb1-1.js 為基礎）
// ══════════════════════════════════════════

abc2svg.jsdir = (function () {
  var s_a = document.getElementsByTagName('script');
  // 優先：已載入的 abc2svg-1.js script 標籤
  for (var k = 0; k < s_a.length; k++) {
    if (s_a[k].src.indexOf('abc2svg') >= 0)
      return s_a[k].src.match(/.*\//) || '';
  }
  return '';
})();

abc2svg.loadjs = function (fn, relay, onerror) {
  var s = document.createElement('script');
  s.src = /:\/\//.test(fn) ? fn : abc2svg.jsdir + fn;
  s.onload = relay;
  s.onerror = function () {
    if (onerror) onerror(fn);
    else alert('error loading ' + fn);
  };
  document.head.appendChild(s);
};

var abcSrc = '';

function dom_loaded() {
  var abc, a_inc = {}, errtxt = '';

  abc2svg.user = {
    read_file: function (fn) { return a_inc[fn]; },
    errmsg:    function (msg) { errtxt += msg + '\n'; },
    img_out:   function (str) {
      document.getElementById('target').innerHTML += str;
    },
    anno_stop: function (type, start, stop, x, y, w, h, s) {
      // deco 收集由 JumpEngine 負責（setupHooks 已包裝此 handler）
      if (['note', 'rest', 'grace'].indexOf(type) < 0) return;
      AbcplayDriver.registerSymbol(start, s);   // 登記可播放符號
      var abc = abc2svg.abc;
      abc.out_svg('<rect class="abcr _' + start + '_" x="');
      abc.out_sxsy(x, '" y="', y);
      abc.out_svg('" width="' + w.toFixed(2) +
                  '" height="' + abc.sh(h).toFixed(2) + '"/>\n');
    },
    page_format: true
  };

  // deco 收集 hook 交由 JumpEngine 管理（包裝 anno_stop 的 deco 分支）
  JumpEngine.setupHooks(abc2svg.user);

  if (!abc2svg.Abc) { abc2svg.loadjs('abc2svg-1.js', dom_loaded); return; }

  // 收集所有 <script type="text/vnd.abc">：合併 ABC、同時替換成 abc-slot div
  // data-tune 用 0 起算的順序編號，對應 abc2svg tunes[] 的 index（非 X: 號碼）
  abcSrc = '';
  var _tuneIdx = 0;
  while (1) {
    var _sa = document.getElementsByTagName('script'), _found = false;
    for (var _i = 0; _i < _sa.length; _i++) {
      if (_sa[_i].type !== 'text/vnd.abc') continue;
      var _s = _sa[_i];
      abcSrc += _s.textContent + '\n';
      var _div = document.createElement('div');
      _div.className = 'abc-slot';
      _div.setAttribute('data-tune', _tuneIdx++);
      _s.parentNode.replaceChild(_div, _s);
      _found = true;
      break;
    }
    if (!_found) break;
  }

  abc2svg.abc_end = function () {};

  var el = document.createElement('span');
  el.style.position = 'absolute'; el.style.top = el.style.padding = 0;
  el.style.visibility = 'hidden'; el.style.lineHeight = 1;
  document.body.appendChild(el);
  abc2svg.el = el;

  function doRender() {
    // 通知 Driver：渲染即將開始，重置符號索引與 JumpEngine
    AbcplayDriver.onRenderStart();
    document.getElementById('target').innerHTML = '';
    abc2svg.abc = abc = new abc2svg.Abc(abc2svg.user);
    try { abc.tosvg('player', abcSrc); } catch(e) { console.error(e); return; }
    abc2svg.abc_end();
    if (errtxt) {
      document.getElementById('target').innerHTML +=
        '<pre style="background:#ff8080">' + errtxt + '</pre>';
      errtxt = '';
    }
    var m = abcSrc.match(/^T:[ \t]*(.+)/m);
    if (m) {
      document.title = m[1].trim();
    }
    // ── 把每個 tuneN SVG 搬到對應的 .abc-slot div ──────────────
    var tgt = document.getElementById('target');
    var slots = document.querySelectorAll('.abc-slot');
    if (slots.length) {
      // 建立 tuneN → slot 對照表（slot 的 data-tune 屬性）
      var slotMap = {};
      for (var _i = 0; _i < slots.length; _i++) {
        var _tn = slots[_i].getAttribute('data-tune');
        if (_tn !== null) slotMap[_tn] = slots[_i];
      }
      // 先快照成靜態陣列：live NodeList 在 appendChild 後會縮短，導致每隔一個被跳過
      var svgs = Array.prototype.slice.call(tgt.querySelectorAll('svg'));
      for (var _j = 0; _j < svgs.length; _j++) {
        var _cl = svgs[_j].getAttribute('class') || '';
        var _tm = _cl.match(/tune(\d+)/);
        if (!_tm) continue;
        var _slot = slotMap[_tm[1]];
        if (_slot) _slot.appendChild(svgs[_j]);
      }
    }
    // 綁點擊：target（剩餘 SVG）+ 所有 abc-slot
    // 點擊事件實作已移至 UIController.onLeftClick / onRightClick
    tgt.onclick       = function (e) { UIController.onLeftClick(e); };
    tgt.oncontextmenu = function (e) { UIController.onRightClick(e); };
    for (var _k = 0; _k < slots.length; _k++) {
      slots[_k].onclick       = function (e) { UIController.onLeftClick(e); };
      slots[_k].oncontextmenu = function (e) { UIController.onRightClick(e); };
    }

    // ── [ball:init] ───────────────────────────────────────────────
    // 渲染完成後初始化小球畫布（冪等）。
    // 座標採即時查詢策略，不需要預建位置表。
    if (window.BallController) {
      BallController.init();
    }
    // ── [ball:init] end ───────────────────────────────────────────

    // 後端注入：等待 AbcPlay 可用後呼叫 AbcplayDriver.setBackend()
    // AbcplayDriver 持有 onPlaybackEnd / notehlight 的私有引用，
    // 此處只負責建立後端實例並傳入，不暴露 Driver 內部細節。
    if (window.AudioContext || window.webkitAudioContext) {
      var ti = setInterval(function () {
        if (typeof AbcPlay === 'function') {
          clearInterval(ti);
          AbcplayDriver.setBackend(
            AbcPlay({
              onend:  AbcplayDriver._onPlaybackEnd,
              onnote: AbcplayDriver._onNoteActivate
            })
          );
        }
      }, 100);
    }
  }

  function include() {
    var i, j, fn, r, k = 0;
    while (1) {
      i = abcSrc.indexOf('%%abc-include ', k);
      if (i < 0) { doRender(); return; }
      i += 14; j = abcSrc.indexOf('\n', i);
      fn = abcSrc.slice(i, j).trim();
      if (!a_inc[fn]) break;
      k = j;
    }
    r = new XMLHttpRequest();
    r.open('GET', fn, true);
    r.onload = function () {
      if (r.status === 200) {
        a_inc[fn] = r.responseText;
        if (abc2svg.modules.load(a_inc[fn], include)) include();
      } else { a_inc[fn] = '%\n'; alert('Error getting ' + fn); include(); }
    };
    r.onerror = function () { a_inc[fn] = '%\n'; include(); };
    r.send();
  }

  if (abc2svg.modules.load(abcSrc, include)) include();
}

// ══════════════════════════════════════════
// 13. 啟動（組裝序列）
// ══════════════════════════════════════════

// ── [組裝 1] 填入 UI → Player 命令集 ──────────────────────────────
//
// UIController 的按鈕 / 點擊事件只呼叫 play.api.*，
// 不直接引用 AbcplayDriver 或 loader.js 內部的函式名稱。
//
var _cmds = AbcplayDriver.getCommands();
var _playApi = {
  pause:           _cmds.pause,
  resume:          _cmds.resume,
  play:            _cmds.play,
  stop:            _cmds.stop,
  seekTo:          _cmds.seekTo,
  setSpeed:        _cmds.setSpeed,
  getSe:           _cmds.getSe,
  getPlaySi:       _cmds.getPlaySi,
  getMeasureEnd:   _cmds.getMeasureEnd,
  getEeByTime:     _cmds.getEeByTime,
  getSyms:         _cmds.getSymbol,    // UIController 仍用 getSyms 名稱，此處橋接
  setCurrentPoEnd: _cmds.setCurrentPoEnd,
  setPlayEi:       _cmds.setPlayEi
};

// ── [組裝 2] 初始化 UIController ──────────────────────────────────
//
// UIController 透過存取器函式讀寫 AbcplayDriver 的私有狀態，
// 不直接引用變數名稱，維持模組邊界。
//
var _ctx = AbcplayDriver.getContext(CFG);
UIController.init(Object.assign({ api: _playApi }, _ctx));

// ── [組裝 3] 注入 Player → UI callbacks ───────────────────────────
//
// Driver 內部的 play.on* 由 setUICallbacks 填入，
// loader.js 不需要知道 play 物件的結構。
//
AbcplayDriver.setUICallbacks(UIController.getCallbacks());

// ── [啟動] 渲染 ───────────────────────────────────────────────────
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', dom_loaded, { once: true });
else
  dom_loaded();

}());
