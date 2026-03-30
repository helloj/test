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
 *   <script src="https://cdn.jsdelivr.net/gh/helloj/test@latest/abc2svg/abc2svg_files/abc2svg-1.js"></script>
 *   <script src="https://cdn.jsdelivr.net/gh/helloj/test@latest/abc2svg/abc2svg_files/snd-1.js"></script>
 *   <script src="https://cdn.jsdelivr.net/gh/helloj/test@latest/player/loader.js"></script>
 *
 *   <!-- 每首曲子放在獨立的區塊 -->
 *   <script type="text/vnd.abc">
 *   X:1
 *   T:曲名
 *   ...
 *   </script>
 *
 * 本檔負責：
 *   1. 注入 CSS（垂直浮動工具列、ctxMenu 樣式）
 *   2. 建立 DOM 結構（#fab-toolbar、#target、ctxMenu）
 *   3. 修補 abc2svg.play_next，支援 D.C. / D.S. / Coda / Fine 跳轉
 *      - play_cont 複製版加入 _playGeneration 版本守衛，防止殘存排程復活
 *   4. 渲染 ABC → SVG
 *      - 收集所有 <script type="text/vnd.abc">，合併後一次 tosvg()
 *      - 每段 <script> 就地替換成 <div class="abc-slot">
 *      - 渲染完成後將各 tuneN SVG 搬入對應的 abc-slot
 *   5. 播放 / 循環 / 選段 / 繼續 / 音符高亮 等完整邏輯
 *      - 各首邊界由 abcplay.add(first, last) 管理，不跨首
 *      - 左鍵點音符：播放中直接切換起點，非播放中從該音符起播
 *      - 右鍵點音符：設 B 點（選段終點），左鍵 click 清除 B 點
 *      - 右鍵點空白：開選單（播放 / 繼續），有 B 點時「播放」自動選段
 *
 * 與 HTML 的約定：
 *   - 若頁面有 .tune-block 等父容器包住 <script type="text/vnd.abc">，
 *     SVG 會自然落在容器內，說明文字與樂譜穿插排列
 *   - #target（隱藏）作為殘留 SVG 的暫存容器
 *
 * 刷新cdn
 *   https://cdn.jsdelivr.net/gh/helloj/test@latest/player/loader.js
 */
;(function () {

// ══════════════════════════════════════════
// 0. 全域常數（類 C #define，集中修改）
// ══════════════════════════════════════════
var CFG = {
  // ── UI 圖示符號 ──────────────────────────
  ICON_PLAY:     '▶',   // 播放按鈕（idle 狀態）
  ICON_PAUSE:    '⏸',   // 暫停按鈕（playing 狀態）
  ICON_RESUME:   '⏯',   // 繼續按鈕（stopAt > 0 狀態）
  ICON_LOOP:     '↺',   // 循環模式狀態指示（不可按）
  ICON_NOLOOP:   '➔',   // 非循環模式狀態指示（不可按）
  ICON_INFINITE: '♾️',  // 無限循環
  ICON_SPEED:    '๑ï',  // 調速按鈕

  // ── 播放速度 ─────────────────────────────
  SPEED_DEFAULT:  1.0,   // 預設速度（1x）
  SPEED_MIN:      0.25,  // 最小速度
  SPEED_MAX:      2.0,   // 最大速度
  SPEED_STEP:     0.05,  // +/- 步進
  SPEED_PRESETS:  [0.5, 0.75, 1, 1.25, 1.5],  // 快速選擇

  // ── 循環次數 ─────────────────────────────
  LOOP_DEFAULT:  5,     // 循環 N 次的預設值
  LOOP_INFINITE: 99,    // 無限循環的代理數值（內部用）
};

// ══════════════════════════════════════════
// 1. 注入 CSS
// ══════════════════════════════════════════
(function () {
  var style = document.createElement('style');
  style.textContent = [
    "/* player.css – abc2svg Player 樣式 */",
    "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}",
    ":root{--ink:#1a120b;--paper:#f5efe6;--accent:#8b3a3a;--muted:#c2a97a;--panel:rgba(245,239,230,0.96)}",
    "html,body{height:100%;background:var(--paper);color:var(--ink);font-family:'Noto Serif TC','Kaiti TC','STKaiti',serif}",
    "body{padding-right:56px}",
    "#fab-toolbar{position:fixed;top:16px;right:16px;z-index:50;display:flex;flex-direction:column;align-items:stretch;gap:6px;background:var(--panel);border:1px solid var(--muted);border-radius:8px;padding:8px 6px;box-shadow:0 4px 16px rgba(139,58,58,0.15);user-select:none}",
    ".fab-divider{height:1px;background:var(--muted);opacity:.4;margin:2px 0}",
    "#play-pause-btn{display:flex;align-items:center;justify-content:center;width:2.4em;height:2.4em;border:1px solid var(--muted);border-radius:4px;background:transparent;color:var(--muted);font-size:.85rem;cursor:pointer;transition:background .12s,color .12s;line-height:1;padding:0;font-family:inherit}",
    "#play-pause-btn:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
    "#loop-icon{justify-content:center}",
    ".seg-btn{display:flex;flex-direction:column;border:1px solid var(--muted);border-radius:4px;overflow:hidden;cursor:pointer}",
    ".seg-btn .seg{display:flex;align-items:center;justify-content:center;padding:5px 4px;font-size:.7rem;font-family:inherit;background:transparent;color:var(--muted);transition:background .12s,color .12s;white-space:nowrap;cursor:pointer}",
    ".seg-btn .seg:not(:last-child){border-bottom:1px solid var(--muted)}",
    ".seg-btn .seg:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
    ".seg-btn .seg.active{background:var(--accent);color:#fff;font-weight:600}",
    "#loop-n-input{width:2em;border:none;background:transparent;color:inherit;font:inherit;font-size:.7rem;text-align:center;outline:none;padding:0;cursor:pointer;-moz-appearance:textfield}",
    "#loop-n-input::-webkit-inner-spin-button,#loop-n-input::-webkit-outer-spin-button{-webkit-appearance:none}",
    ".seg.active #loop-n-input{color:#fff;cursor:text}",
    "#dright{display:none}",
    ".abc-slot{display:block;width:100%;margin:0 auto}",
    ".abc-slot svg{display:block;width:100%;height:auto}",
    "#ctxMenu{position:fixed;display:none;z-index:200;background:var(--panel);border:1px solid var(--muted);border-radius:6px;box-shadow:0 6px 24px rgba(26,18,11,0.18);overflow:hidden;min-width:130px;font-size:.85rem}",
    "#ctxMenu ul{list-style:none}",
    "#ctxMenu li{padding:9px 18px;cursor:pointer;color:var(--ink);transition:background .12s;white-space:nowrap}",
    "#ctxMenu li:hover{background:var(--accent);color:#fff}",
    "#ctxMenu li+li{border-top:1px solid rgba(194,169,122,.3)}",
    ".abcr{fill:#8b3a3a;fill-opacity:0;z-index:15}",
    ".abcr.sel{fill:#3cc878}",
    ".abcr.selb{fill:#e07b00}",
    "#errbanner{display:none;background:#c0392b;color:#fff;padding:6px 16px;font-size:.82rem;cursor:pointer}",
    ".tune-block{border:1px solid #ccc;border-radius:6px;margin:16px auto;max-width:85%;padding:12px 16px 0;background:#fffdf8}",
    ".tune-block p{margin:0 0 6px;font-size:.88rem;color:#444;white-space:pre-wrap;font-family:monospace}",
    ".tune-svg svg,.tune-block svg{display:block;width:100%;height:auto}",
    // ── 調速面板 ──────────────────────────────────────────────────
    // 仿 YouTube 風格：底部留白、左右留白、圓角上緣、置中內容區
    "#speed-panel{position:fixed;bottom:0;left:0;right:0;z-index:300;display:flex;justify-content:center;pointer-events:none;transform:translateY(100%);transition:transform .22s cubic-bezier(.4,0,.2,1)}",
    "#speed-panel.open{transform:translateY(0)}",
    "#speed-panel-inner{pointer-events:all;width:100%;max-width:60%;background:var(--panel);border:1px solid var(--muted);border-radius:16px 16px 0 0;box-shadow:0 -4px 24px rgba(26,18,11,0.18);padding:8px 0 0;margin:0 12px}",
    // 頂部拖曳把手（仿 iOS/Android sheet）
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
    "#speed-btn{display:flex;align-items:center;justify-content:center;width:2.4em;height:2.4em;border:1px solid var(--muted);border-radius:4px;background:transparent;color:var(--muted);font-size:.85rem;cursor:pointer;transition:background .12s,color .12s;line-height:1;padding:0;font-family:inherit}",
    "#speed-btn:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
    "#speed-btn.active{background:rgba(139,58,58,0.15);color:var(--ink)}"
  ].join('\n');
  document.head.appendChild(style);

  if (!document.querySelector('meta[charset]')) {
    var m = document.createElement('meta');
    m.setAttribute('charset', 'UTF-8');
    document.head.insertBefore(m, document.head.firstChild);
  }
}());

// ══════════════════════════════════════════
// 2. 建立 DOM 結構
// ══════════════════════════════════════════
(function () {
  document.documentElement.setAttribute('lang', 'zh-TW');
  if (!document.title) document.title = 'abc2svg Player';

  var body = document.body;
  body.insertAdjacentHTML('afterbegin', [
    '<div id="fab-toolbar">',
    '  <button id="play-pause-btn">' + CFG.ICON_PLAY + '</button>',
    '  <div class="fab-divider"></div>',
    '  <div class="seg-btn" id="loopSegBtn">',
    '    <span class="seg" id="loop-icon" data-val="loop">' + CFG.ICON_NOLOOP + '</span>',
    '    <span class="seg" data-val="' + CFG.LOOP_DEFAULT + '" id="seg-n">',
    '      <input id="loop-n-input" type="number" min="1" max="' + CFG.LOOP_INFINITE + '" value="' + CFG.LOOP_DEFAULT + '"/>',
    '    </span>',
    '    <span class="seg" data-val="' + CFG.LOOP_INFINITE + '">' + CFG.ICON_INFINITE + '</span>',
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
    '</div>',
    // ── 選單：拿掉「選段播放」，「整首」改為「播放」 ──
    // 「播放」onclick 根據 selx[1] 是否有 B 點，自動選擇 what=1（選段）或 what=0（整首）
    '<div id="ctxMenu">',
    '  <ul>',
    '    <li id="cmpt">' + CFG.ICON_PLAY + ' 播放</li>',
    '    <li id="cmpc">' + CFG.ICON_RESUME + ' 繼續</li>',
    '  </ul>',
    '</div>'
  ].join('\n'));

  document.getElementById('errbanner').onclick = function () { this.style.display = 'none'; };
  // 「播放」：有 B 點 → 選段(1)，無 B 點 → 整首(0)
  document.getElementById('cmpt').onclick = function () { play_tune(selx[1] ? 1 : 0); };
  document.getElementById('cmpc').onclick = function () { play_tune(3); };

  // ── 調速面板（底部 sheet，獨立插入 body 末端）──────────────────
  var _presetHtml = CFG.SPEED_PRESETS.map(function(v) {
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
}());

// ══════════════════════════════════════════
// 3. 修補 abc2svg.play_next（含 D.S. / D.C. 跳轉支援）
// ══════════════════════════════════════════

/**
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
 * 殘存排程防護（_playGeneration）：
 *   play_cont 首次進入時遞增 _playGeneration 並寫入 po._gen。
 *   後續 setTimeout(play_cont,...) 再進來時比對 po._gen，版本不符即 return，
 *   讓漏網的舊 setTimeout(play_cont,...) 自然熄滅，不再復活。
 * ══════════════════════════════════════════════════════════════════
 */

// ── 全域收集：istart → sym（anno_stop 時填入）──────────────────
var _allDecoSyms    = {};
var _allJumpCtxList = [];

// ── 播放世代號：每次 playStart 遞增，play_cont 複製版據此過濾殘存排程 ──
var _playGeneration = 0;

var _JUMP_NAMES = {
  'segno':1, 'coda':1, 'fine':1,
  'D.C.':1, 'D.S.':1, 'dacapo':1, 'dacoda':1,
  'D.C.alcoda':1, 'D.S.alcoda':1,
  'D.C.alfine':1, 'D.S.alfine':1
};

function _symHasDeco(s, name) {
  var a = s.a_dd;
  if (!a) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] && a[i].name === name) return true;
  }
  return false;
}

// ── 錨點建立 ────────────────────────────────────────────────────

/**
 * 在 refSym 之前插入一個 0 拍錨點並回傳。
 * 每次都建立新 anchor 串入 chain，依照呼叫順序排列。
 */
function _insertAnchorBefore(refSym, extra) {
  var C = abc2svg.C;
  var anchor = {
    _anchor:  true,
    ptim:     refSym.ptim,
    time:     refSym.time,
    pdur:     0,
    type:     C.SPACE,
    noplay:   false,
    v:        refSym.v,
    p_v:      refSym.p_v,
    seqst:    true,
    istart:   refSym.istart,
    dur:      0,
    bar_type: ''
  };
  if (extra) {
    for (var k in extra) anchor[k] = extra[k];
  }
  // 永遠插在 refSym 的緊前面
  var prev = refSym.ts_prev;
  anchor.ts_prev = prev;
  anchor.ts_next = refSym;
  if (prev) prev.ts_next = anchor;
  refSym.ts_prev = anchor;
  return anchor;
}

/**
 * 在 chain 最前面（first 之前）插入曲首錨點。
 */
function _insertTuneStartAnchor(first) {
  var C = abc2svg.C;
  var s = first;
  while (s && s.ptim === undefined) s = s.ts_next;
  var ptim = s ? s.ptim : 0;
  var anchor = {
    _anchor:          true,
    _landAnchor:      true,
    _tuneStartAnchor: true,
    ptim:     ptim,
    pdur:     0,
    type:     C.SPACE,
    noplay:   false,
    dur:      0,
    bar_type: '',
    v:        first.v,
    p_v:      first.p_v,
    seqst:    true
  };
  var prev = first.ts_prev;
  anchor.ts_prev = prev;
  anchor.ts_next = first;
  if (prev) prev.ts_next = anchor;
  first.ts_prev = anchor;
  return anchor;
}

/**
 * 在 chain 最後面插入曲尾錨點。
 */
function _insertTuneEndAnchor(first) {
  var C = abc2svg.C;
  var last = first;
  while (last.ts_next) last = last.ts_next;
  var anchor = {
    _anchor:         true,
    _landAnchor:     true,
    _tuneEndAnchor:  true,
    ptim:     last.ptim + (last.pdur || 0),
    pdur:     0,
    type:     C.SPACE,
    noplay:   false,
    dur:      0,
    bar_type: '',
    v:        last.v,
    p_v:      last.p_v,
    seqst:    true
  };
  anchor.ts_prev = last;
  anchor.ts_next = null;
  last.ts_next   = anchor;
  return anchor;
}

// ── tune 掃描與錨點建立 ──────────────────────────────────────────

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

  // 建立曲首 / 曲尾錨點
  var tuneStartAnchor = _insertTuneStartAnchor(first);
  var tuneEndAnchor   = _insertTuneEndAnchor(first);

  var segnoAnchors = [];
  var fineAnchors  = [];
  var codaAnchors  = [];
  var jumpAnchors  = [];

  // 依照 a_dd 書寫順序插入 anchor（同一 sym 上多個 deco 保持原始順序）
  decoList.forEach(function(s) {
    if (!s.a_dd) return;
    for (var i = 0; i < s.a_dd.length; i++) {
      var name = s.a_dd[i] && s.a_dd[i].name;
      if (!name) continue;

      if (name === 'segno') {
        var a = _insertAnchorBefore(s, { _landAnchor: true, _segnoAnchor: true });
        // ptim 去重
        var dup = false;
        for (var j = 0; j < segnoAnchors.length; j++) {
          if (segnoAnchors[j].ptim === a.ptim) { dup = true; break; }
        }
        if (!dup) segnoAnchors.push(a);
      }

      if (name === 'fine') {
        var a = _insertAnchorBefore(s, { _landAnchor: true, _fineAnchor: true, jumpFine: false });
        var dup = false;
        for (var j = 0; j < fineAnchors.length; j++) {
          if (fineAnchors[j].ptim === a.ptim) { dup = true; break; }
        }
        if (!dup) fineAnchors.push(a);
      }

      if (name === 'coda') {
        var a = _insertAnchorBefore(s, { _codaAnchor: true, jumpCoda: false });
        // ptim 去重
        var dup = false;
        for (var j = 0; j < codaAnchors.length; j++) {
          if (codaAnchors[j].ptim === a.ptim) { dup = true; break; }
        }
        if (!dup) codaAnchors.push(a);
      }

      var isDC     = name === 'D.C.'       || name === 'dacapo';
      var isDS     = name === 'D.S.';
      var isDCcoda = name === 'D.C.alcoda' || name === 'dacoda';
      var isDScoda = name === 'D.S.alcoda';
      var isDCfine = name === 'D.C.alfine';
      var isDSfine = name === 'D.S.alfine';
      var isAnyJump = isDC || isDS || isDCcoda || isDScoda || isDCfine || isDSfine;
      if (isAnyJump) {
        var extra = {
          _jumpAnchor: true,
          jumpDC:   isDC   || isDCcoda || isDCfine,
          jumpDS:   isDS   || isDScoda || isDSfine,
          jumpCoda: isDCcoda || isDScoda,
          jumpFine: false,
          _init: {
            jumpDC:   isDC   || isDCcoda || isDCfine,
            jumpDS:   isDS   || isDScoda || isDSfine,
            jumpCoda: isDCcoda || isDScoda,
            jumpFine: false
          }
        };
        var a = _insertAnchorBefore(s, extra);
        if (jumpAnchors.indexOf(a) < 0) jumpAnchors.push(a);
      }
    }
  });

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

// ── 動態攔截：完整替換 abc2svg.play_next，加入 anchor 處理 ──────

function _handleAnchor(s, po, ctx) {
  if (!ctx) return null;
  var target = null;

  if (s._jumpAnchor) {
    if (s.jumpDC) {
      s.jumpDC = false;
      ctx.fineAnchors.forEach(function(a) { a.jumpFine = true; });
      // enable 所有在重播段內（曲首到 jump 之前）的 coda anchor
      ctx.codaAnchors.forEach(function(a) {
        if (a.ptim < s.ptim) {
          a.jumpCoda   = true;
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
          a.jumpCoda   = true;
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
}

/**
 * 走過連續 anchor，執行跳轉直到落在非 anchor 節點為止。
 * 回傳最終落點（非 anchor），並更新 po.stim。
 * 若落點是 tuneEndAnchor 或 null，回傳 null 表示應結束播放。
 */
function _walkAnchors(s, po, ctx) {
  var limit = 20;
  while (s && s._anchor && limit-- > 0) {
    if (s._tuneEndAnchor) return null;
    var target = _handleAnchor(s, po, ctx);
    if (target) {
      po.stim += (s.ptim - target.ptim) / po.conf.speed;
      if (target._codaAnchor) target._isLanding = true;  // 標記降落
      s = target;
    } else {
      s = s.ts_next;
    }
  }
  if (!s || s._tuneEndAnchor) return null;
  return s;
}

// ── play_next 修補 ───────────────────────────────────────────────
//   - 最小修補（instrument filter + _current_po）
//   - 攔截點 A（播放起點預走 anchor）
//   - play_cont 最小複製（僅加入攔截點 B，其餘與 snd-1.js 原版相同）
//   - [GEN] 版本守衛：play_cont 開頭 init po._gen + 遞增 + 守衛，過濾殘存排程

var orig_play_next = abc2svg.play_next;

abc2svg.play_next = function(po) {

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

  // ── jumpCtx 取得 ───────────────────────────────────────────────
  if (po._jumpCtx === undefined) {
    po._jumpCtx = _getCtxForSym(po.s_cur) || null;
  }
  var ctx = po._jumpCtx;

  // ── 無跳轉：直接呼叫原版，完全不介入 ─────────────────────────
  if (!ctx) {
    orig_play_next(po);
    return;
  }

  // ── patch 說明 ────────────────────────────────────────────────
  // do_tie / set_ctrl / play_cont / get_part 直接複製自 snd-1.js 原文，
  // 不做任何修改。僅在 play_cont 的三個位置插入修補：
  //   [GEN] play_cont 開頭：init po._gen + 遞增世代號 + 版本守衛，
  //         過濾殘存的舊世代 setTimeout（集中於 play_cont，play_next 不介入）
  //   [B1]  noplay while 之後：處理播放起點本身落在 anchor 的情況
  //   [B2]  內層 while 的 s=s.ts_next 之後：中途遇到 anchor 時跳轉
  // 未來 snd-1.js 更新時，只需重新複製這四個函數，再貼回 [GEN][B1][B2] 即可。
  // ─────────────────────────────────────────────────────────────

  // ── 以下為 snd-1.js 原文（do_tie）────────────────────────────
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

  // ── 以下為 snd-1.js 原文（set_ctrl）─────────────────────────
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

  // ── 以下為 snd-1.js 原文（play_cont）+ [GEN][B1][B2] patch ───
  function play_cont(po){var d,i,st,m,note,g,s2,t,maxt,now,p_v,C=abc2svg.C,s=po.s_cur

    // ── [GEN] 首次進入（po 剛建立）：init + 遞增世代號
    //         後續 setTimeout(play_cont,...) 再進來時 po._gen 已有值，跳過遞增。
    //         版本不符表示這是殘存的舊世代排程，直接丟棄。
    if(po._gen === undefined){
      po._gen = ++_playGeneration;
    }
    if(po._gen !== _playGeneration){
      po.timouts.forEach(function(id){ clearTimeout(id); });  // 清除已排的音符
      po.timouts = [];
      return;
    }
    // ── [GEN] end ─────────────────────────────────────────────────

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

    // ── [B1] anchor patch：起點落在 anchor 時走過並取得落點 ──────
    if(s._anchor){
      s=_walkAnchors(s,po,ctx)
      if(!s){if(po.onend)po.onend(po.repv);return}
      if(s==po.s_end){if(po.onend)po.onend(po.repv);return}
      po.s_cur=s}
    // ── [B1] end ─────────────────────────────────────────────────

    t=po.stim+s.ptim/po.conf.speed
    now=po.get_time(po)
    if(po.conf.new_speed){po.stim=t-s.ptim/po.conf.new_speed
      po.conf.speed=po.conf.new_speed
      po.conf.new_speed=0}
    maxt=t+po.tgen
    po.timouts=[]
    while(1){switch(s.type){case C.BAR:s2=null
      if(s.rep_p){po.repv++
        if(!po.repn&&(!s.rep_v||po.repv<=s.rep_v.length)){s2=s.rep_p
          po.repn=true}else{if(s.rep_v)
          s2=var_end(s)
          po.repn=false
          if(s.bar_type.slice(-1)==':')
            po.repv=1}}
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
          po.timouts.push(setTimeout(po.onnote,st,i,true))
          if(d>2)
            d-=.1
          setTimeout(po.onnote,st+d*1000,i,false)}
        break}}
    while(1){if(!s||s==po.s_end||!s.ts_next||s.ts_next==po.s_end||po.stop){if(po.onend)
        setTimeout(po.onend,(t-now+d)*1000,po.repv)
        po.s_cur=s
        return}
      s=s.ts_next

      // ── [B2] anchor patch：中途遇到 anchor 時跳轉 ────────────
      if(s._anchor){
        var walked=_walkAnchors(s,po,ctx)
        if(!walked){if(po.onend)setTimeout(po.onend,(t-now+d)*1000,po.repv);po.s_cur=s;return}
        s=walked
        t=po.stim+s.ptim/po.conf.speed
        break}  // 跳出內層 while，讓外層重新從落點開始處理
      // ── [B2] end ───────────────────────────────────────────────

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
  po.timouts.push(setTimeout(play_cont,(t-now)*1000
    -300,po))}

  // ── 以下為 snd-1.js 原文（get_part）─────────────────────────
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

// ── _patchTune ──────────────────────────────────────────────────

var _tuneCtxMap = [];

function _getCtxForSym(s) {
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

function _resetAllJumpCtx() {
  _allJumpCtxList.forEach(function(ctx) { ctx.reset(); });
}

function _patchTune(first) {
  if (!first || first._jumpCtx !== undefined) return;
  first._jumpCtx = null;

  var ctx = _buildJumpCtx(first);
  if (!ctx) return;

  ctx.tuneStartAnchor._jumpCtx = ctx;
  first._jumpCtx = ctx;
  _allJumpCtxList.push(ctx);
  _tuneCtxMap.push({ range: ctx.range, ctx: ctx });

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
}

// ══════════════════════════════════════════
// 4. 狀態變數
// ══════════════════════════════════════════
var abcSrc  = '',
    syms    = [],
    ctxMenu = document.getElementById('ctxMenu'),
    loopMode  = 0,
    loopCount = 0,
    selx      = [0, 0],
    selx_sav  = [],
    currentSpeed = CFG.SPEED_DEFAULT,  // 當前播放速度（倍率）
    _refreshToggleLabel = null,
    play = {
      playing:false, stopping:false, stopAt:0,
      si:null, ei:null, repv:0, loop:false,
      abcplay:null, click:null,
      lastNote:0, curNote:0, anchorIdx:0,
      isResume: false
    };

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

function dom_loaded() {
  var abc, a_inc = {}, errtxt = '';

  abc2svg.user = {
    read_file: function (fn) { return a_inc[fn]; },
    errmsg:    function (msg) { errtxt += msg + '\n'; },
    img_out:   function (str) {
      document.getElementById('target').innerHTML += str;
    },
    anno_stop: function (type, start, stop, x, y, w, h, s) {
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
      if (['note', 'rest', 'grace'].indexOf(type) < 0) return;
      syms[start] = s;
      var abc = abc2svg.abc;
      abc.out_svg('<rect class="abcr _' + start + '_" x="');
      abc.out_sxsy(x, '" y="', y);
      abc.out_svg('" width="' + w.toFixed(2) +
                  '" height="' + abc.sh(h).toFixed(2) + '"/>\n');
    },
    page_format: true
  };

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
    syms = []; _allDecoSyms = {}; _allJumpCtxList = []; _tuneCtxMap = [];
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
    tgt.onclick       = onLeftClick;
    tgt.oncontextmenu = onRightClick;
    for (var _k = 0; _k < slots.length; _k++) {
      slots[_k].onclick       = onLeftClick;
      slots[_k].oncontextmenu = onRightClick;
    }
    if (!play.abcplay && (window.AudioContext || window.webkitAudioContext)) {
      var ti = setInterval(function () {
        if (typeof AbcPlay === 'function') {
          clearInterval(ti);
          play.abcplay = AbcPlay({ onend: onPlayEnd, onnote: notehlight });
          updateStatus();
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
// 7. 工具函式
// ══════════════════════════════════════════
function getSymIndex(el) {
  var cl = el && el.getAttribute && el.getAttribute('class');
  var m  = cl && cl.match(/_(\d+)_/);
  return m ? Number(m[1]) : 0;
}

function addTunes() {
  var tunes = abc2svg.abc && abc2svg.abc.tunes, e;
  if (tunes && tunes.length) {
    while ((e = tunes.shift())) {
      var tuneFirst = e[0];
      play.abcplay.add(tuneFirst, e[1], e[3]);
      _patchTune(tuneFirst);
    }
  }
}

function gnrn(s) {
  var C = abc2svg.C;
  while (s) {
    if (s.p_v) switch (s.type) {
      case C.NOTE: case C.REST: case C.GRACE: return s;
      case C.BLOCK: if (s.subtype === 'midictl' || s.subtype === 'midiprog') return s; break;
    }
    s = s.ts_next;
  }
  return null;
}

function gsot(si) {
  var s = syms[si];
  if (!s) return null;
  var root = (s.p_v && s.p_v.sym) ? s.p_v.sym : s;
  return gnrn(root) || gnrn(s);
}

function get_se(si) {
  return syms[si] || null;
}

function gsot_tune_start(si) {
  var s = syms[si];
  if (!s) return null;
  while (s.ts_prev) s = s.ts_prev;
  return gnrn(s);
}

function next_playable(s) {
  var C = abc2svg.C;
  s = s.ts_next;
  while (s) { switch (s.type) { case C.NOTE: case C.REST: case C.GRACE: return s; } s = s.ts_next; }
  return null;
}

function get_ee(si)   { var s = syms[si]; return s ? next_playable(s) : null; }

function get_ee_by_time(si_sym, b_sym) {
  if (!si_sym || !b_sym) return null;
  var s = si_sym;
  while (s.ts_next && s.ts_next.time <= b_sym.time) s = s.ts_next;
  return next_playable(s);
}

function get_measure_end(si) {
  var C = abc2svg.C, s = syms[si];
  if (!s) return null;
  var tuneTail = s;
  while (tuneTail.ts_prev) tuneTail = tuneTail.ts_prev;
  while (s.ts_next) {
    s = s.ts_next;
    if (s.type === C.BAR) break;
    var h = s; while (h.ts_prev) h = h.ts_prev;
    if (h !== tuneTail) { s = s.ts_prev; break; }
  }
  return next_playable(s);
}

function first_sym() {
  for (var i = 0; i < syms.length; i++) {
    if (syms[i]) return syms[i];
  }
}

// ══════════════════════════════════════════
// 8. 點擊事件
// ══════════════════════════════════════════
function onLeftClick(evt) {
  if (ctxMenu.style.display === 'block') { ctxMenu.style.display = 'none'; return; }

  var v = getSymIndex(evt.target);

  if (play.playing && !play.stopping) {
    if (v) {
      // 播放中點到音符：直接切換起播位置（殘存問題由 _playGeneration 守衛解決）
      stopPlay(false);          // 停止舊播放，不存斷點
      setsel(0, v);             // 設新 A 點
      setsel(1, 0);             // 清 B 點
      play.anchorIdx = v;
      play.ei = null;           // 整首從新音符播到結尾
      play_tune(4);             // 從新音符立即起播
    } else {
      stopPlay(true);           // 點空白：正常暫停，存斷點
    }
    return;
  }

  // ── 非播放狀態 ────────────────────────────────────────────────
  // 左鍵 click 同時清除 B 點
  if (v) {
    setsel(0, v); setsel(1, 0);
    play.anchorIdx = v; updateStatus();
    play.ei = null;   // 整首從此音符播到結尾
    play_tune(4);
  } else if (play.stopAt > 0) {
    play_tune(3);
  } else {
    play.click = null;  // 非右鍵觸發，清除上次右鍵殘留
    play.loop = (loopMode !== 0); play.repv = 0; play.stopAt = 0; loopCount = 0;
    play_tune(0);
  }
}

function onRightClick(evt) {
  evt.preventDefault();
  var v = getSymIndex(evt.target);
  if (v) {
    // 右鍵點音符：設 B 點，永遠不開選單
    setsel(1, v); updateStatus();
    if (play.playing) {
      // 播放中即時調整終點
      var a = play.anchorIdx || selx[0], b = v;
      if (a && b) {
        if (b < a) { var t = a; a = b; b = t; }
        var newSi = get_se(a), newEi = get_ee_by_time(newSi, syms[b]);
        if (abc2svg._current_po) abc2svg._current_po.s_end = newEi;
        play.ei = newEi;
      }
    }
    return;  // 不開選單
  }
  // 右鍵點空白：開選單
  play.click = { svg: evt.target };
  var svgEl = evt.target.closest('svg');
  if (svgEl) {
    var first = svgEl.querySelector('.abcr');
    var m = first && first.getAttribute('class').match(/_(\d+)_/);
    if (m) play.click.tuneFirst = Number(m[1]);
  }
  showCtxMenu(evt.clientX, evt.clientY);
}

function setEnabled(el, on) {
  el.style.opacity       = on ? '1'  : '0.35';
  el.style.pointerEvents = on ? ''   : 'none';
}

function showCtxMenu(x, y) {
  setEnabled(document.getElementById('cmpt'), !play.playing);
  setEnabled(document.getElementById('cmpc'), !play.playing && play.stopAt > 0);
  ctxMenu.style.display = 'block';
  requestAnimationFrame(function () {
    var mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
    if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 8;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
    ctxMenu.style.left = x + 'px';
    ctxMenu.style.top  = y + 'px';
  });
}

// ══════════════════════════════════════════
// 9. 播放/暫停按鈕 + 循環開關
// ══════════════════════════════════════════
(function () {
  var btn      = document.getElementById('loopSegBtn'),
      ninput   = document.getElementById('loop-n-input'),
      loopIcon = document.getElementById('loop-icon'),
      ppBtn    = document.getElementById('play-pause-btn');

  // ── Play/Pause 按鈕顯示更新 ─────────────────────────────────────
  function refreshPlayPauseBtn() {
    if (play.playing) {
      ppBtn.textContent = CFG.ICON_PAUSE;
    } else if (play.stopAt > 0) {
      ppBtn.textContent = CFG.ICON_RESUME;
    } else {
      ppBtn.textContent = CFG.ICON_PLAY;
    }
  }

  // ── loop-icon 顯示更新 ──────────────────────────────────────────
  function refreshLoopIcon() {
    var on = loopMode !== 0;
    loopIcon.classList.toggle('active', on);
    if (on && play.playing) {
      if (loopMode === CFG.LOOP_INFINITE) {
        loopIcon.textContent = '×' + (loopCount + 1);
      } else {
        var total = Number(document.getElementById('loop-n-input').value) || loopMode;
        loopIcon.textContent = (loopCount + 1) + '/' + total;
      }
    } else {
      loopIcon.textContent = on ? CFG.ICON_LOOP : CFG.ICON_NOLOOP;
    }
  }

  // ── 統一刷新入口（供外部呼叫）──────────────────────────────────
  function refreshToggleLabel() {
    refreshPlayPauseBtn();
    refreshLoopIcon();
  }
  _refreshToggleLabel = refreshToggleLabel;

  // ── Play/Pause 按鈕 click ───────────────────────────────────────
  ppBtn.addEventListener('click', function () {
    if (play.playing) {
      stopPlay(true);
    } else if (play.stopAt > 0) {
      play_tune(3);
    } else {
      play.click = null;
      play.si = play.si || first_sym();
      play.repv = 0; play.stopAt = 0; loopCount = 0;
      play_tune(0);
    }
  });

  // ── 內部：設定循環模式 ──────────────────────────────────────────
  // dv：CFG.LOOP_DEFAULT（讀 ninput 值）或 CFG.LOOP_INFINITE
  function setLoopMode(dv) {
    loopMode  = (dv === CFG.LOOP_DEFAULT)
                ? (Number(ninput.value) || CFG.LOOP_DEFAULT)
                : dv;
    if (dv === CFG.LOOP_INFINITE) ninput.value = CFG.LOOP_INFINITE;
    play.loop = true;
    loopCount = 0;
    btn.querySelectorAll('.seg[data-val]').forEach(function (s) {
      if (s === loopIcon) return;
      s.classList.toggle('active', Number(s.dataset.val) === dv);
    });
    refreshLoopIcon(); updateStatus();
  }

  // ── 內部：關閉循環（loopMode→0，ninput 保持不動作為記憶）────────
  function clearLoopMode() {
    loopMode  = 0;
    play.loop = false;
    loopCount = 0;
    btn.querySelectorAll('.seg[data-val]').forEach(function (s) {
      if (s === loopIcon) return;
      s.classList.remove('active');
    });
    refreshLoopIcon(); updateStatus();
  }

  // ── loopSegBtn click ────────────────────────────────────────────
  btn.addEventListener('click', function (e) {
    var sp = e.target.closest('.seg[data-val]');
    if (!sp) return;

    // ── loop-icon：主開關 toggle ──────────────────────────────────
    if (sp === loopIcon) {
      if (loopMode !== 0) {
        clearLoopMode();
      } else {
        // ninput.value 就是記憶載體：5（或使用者改過的值）/ 99
        var n = Number(ninput.value) || CFG.LOOP_DEFAULT;
        setLoopMode(n === CFG.LOOP_INFINITE ? CFG.LOOP_INFINITE : CFG.LOOP_DEFAULT);
      }
      return;
    }

    // ── seg-n / seg-infinite：點 ninput 本身只啟用不 toggle ───────
    if (e.target === ninput) {
      if (!sp.classList.contains('active')) setLoopMode(Number(sp.dataset.val));
      return;
    }

    // ── seg-n / seg-infinite：toggle on/off ──────────────────────
    if (sp.classList.contains('active')) {
      clearLoopMode();
    } else {
      setLoopMode(Number(sp.dataset.val));
    }
  });

  ninput.addEventListener('input', function (e) {
    e.stopPropagation();
    var n = Math.max(1, Math.min(CFG.LOOP_INFINITE, parseInt(ninput.value) || 1));
    ninput.value = n;
    if (document.getElementById('seg-n').classList.contains('active')) {
      loopMode = n; updateStatus();
    }
  });
  ninput.addEventListener('click',  function (e) { e.stopPropagation(); });
  ninput.addEventListener('focus',  function () {
    if (!document.getElementById('seg-n').classList.contains('active')) setLoopMode(CFG.LOOP_DEFAULT);
    ninput.select();
  });
  ninput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var n = Math.max(1, Math.min(CFG.LOOP_INFINITE, parseInt(ninput.value) || 1));
    ninput.value = n; loopMode = n; play.loop = true; loopCount = 0;
    refreshToggleLabel(); updateStatus(); ninput.blur();
  });
}());

// ══════════════════════════════════════════
// 9b. 調速面板
// ══════════════════════════════════════════
(function () {
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
    currentSpeed = v;

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
    if (play.abcplay) play.abcplay.set_speed(v);
  }

  // ── 開關面板 ────────────────────────────────────────────────────
  function openPanel() {
    panel.classList.add('open');
    speedBtn.classList.add('active');
  }

  function closePanel() {
    panel.classList.remove('open');
    speedBtn.classList.remove('active');
  }

  // ── 速度 icon 按鈕：toggle panel ────────────────────────────────
  speedBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  });

  // ── 點擊 panel 外關閉（避免 panel 內部操作誤觸發）───────────────
  document.addEventListener('click', function (e) {
    if (panel.classList.contains('open') &&
        !panel.contains(e.target) &&
        e.target !== speedBtn) {
      closePanel();
    }
  });

  // ── 滑桿拖曳 ────────────────────────────────────────────────────
  slider.addEventListener('input', function () {
    applySpeed(parseFloat(slider.value));
  });

  // ── +/- 按鈕 ────────────────────────────────────────────────────
  btnMinus.addEventListener('click', function (e) {
    e.stopPropagation();
    applySpeed(currentSpeed - CFG.SPEED_STEP);
  });
  btnPlus.addEventListener('click', function (e) {
    e.stopPropagation();
    applySpeed(currentSpeed + CFG.SPEED_STEP);
  });

  // ── 預設快速選擇按鈕 ────────────────────────────────────────────
  panel.addEventListener('click', function (e) {
    var btn = e.target.closest('.speed-preset');
    if (!btn) return;
    e.stopPropagation();
    applySpeed(parseFloat(btn.dataset.speed));
  });

  // ── 初始化（設定滑桿填色）───────────────────────────────────────
  updateSliderFill(CFG.SPEED_DEFAULT);
}());

// ══════════════════════════════════════════
// 10. 選取高亮
// ══════════════════════════════════════════
function setOpacity(v, op, cls) {
  if (!v) return;
  var elts = document.getElementsByClassName('_' + v + '_');
  for (var i = elts.length - 1; i >= 0; i--) {
    elts[i].style.fillOpacity = op;
    elts[i].classList.remove('sel', 'selb');
    if (op && cls) elts[i].classList.add(cls);
  }
}

function setsel(idx, v) {
  if (v === selx[idx]) return;
  setOpacity(selx[idx], 0, null);
  setOpacity(v, 0.4, idx === 0 ? 'sel' : 'selb');
  selx[idx] = v;
}

// ══════════════════════════════════════════
// 11. 狀態列
// ══════════════════════════════════════════
function updateStatus() {}

// ══════════════════════════════════════════
// 12. 播放中音符高亮
// ══════════════════════════════════════════
function notehlight(i, on) {
  if (on) {
    if (play.curNote && play.curNote !== i)
      setNoteOp(play.curNote, false);  // 清舊，共用同一套判斷
    play.lastNote = play.curNote;
    play.curNote  = i;
  }
  if (play.stopping && on) return;
  setNoteOp(i, on);
}

function setNoteOp(i, on) {
  var elts = document.getElementsByClassName('_' + i + '_');
  if (!elts || !elts.length) return;
  var isMarker   = (i === selx[0] || i === selx_sav[0] || i === selx[1] || i === selx_sav[1]);
  var keepPaused = !on && play.stopAt > 0 && i === play.curNote;
  var op = on ? 0.4 : (isMarker || keepPaused ? 0.4 : 0);
  for (var j = 0; j < elts.length; j++) elts[j].style.fillOpacity = op;
  if (on) {
    var r = elts[0].getBoundingClientRect();
    if (r.top < 20 || r.bottom > window.innerHeight - 20)
      window.scrollBy({ top: r.top - window.innerHeight / 2, behavior: 'smooth' });
  }
}

// ══════════════════════════════════════════
// 13. 播放控制工具
// ══════════════════════════════════════════
function stopPlay(savePos) {
  play.stopping = true;
  if (savePos) play.stopAt = play.curNote || play.lastNote;
  play.abcplay.stop();
}

function onPlayEnd(repv) {
  if (!play.stopping && play.stopAt === 0) {
    if (loopMode === CFG.LOOP_INFINITE) {
      ++loopCount;
      if (_refreshToggleLabel) _refreshToggleLabel();
      playStart(play.si, play.ei);
      return;
    } else if (loopMode !== 0) {
      var total = Number(document.getElementById('loop-n-input').value) || loopMode;
      if (++loopCount < total) {
        if (_refreshToggleLabel) _refreshToggleLabel();
        playStart(play.si, play.ei);
        return;
      }
      loopCount = 0;
    }
  }
  if (!play.stopping) loopCount = 0;
  play.playing = play.loop = false;
  play.stopping = false;
  play.repv = repv;
  selx_sav[0] = selx[0]; selx_sav[1] = selx[1];
  play.anchorIdx = selx[0];
  updateStatus();
  if (_refreshToggleLabel) _refreshToggleLabel();
}

// ══════════════════════════════════════════
// 14. 播放主函式
// ══════════════════════════════════════════
//
// play_tune(what)
//
//   what=0  整首 / 重播
//             來源 A：右鍵選單「播放」（無 B 點）— play.click.tuneFirst 指定曲子起點
//             來源 B：onLeftClick 空白處重播 — 從 play.si 繼續
//
//   what=1  選段播放
//             從 selx[0]（A 點）到 selx[1]（B 點）之間的範圍
//             來源：右鍵選單「播放」（有 B 點時自動選段）
//
//   what=3  繼續（resume）
//             從 play.stopAt 斷點接續，play.ei 保持不變
//             來源：右鍵選單「繼續」、onLeftClick stopAt、ppBtn stopAt
//
//   what=4  從指定音符起播
//             si 來自 selx[0]，ei 來自 play.ei（呼叫方負責設定）
//             整首播放中點音符：呼叫前 play.ei = null
//             選段播放中點音符：呼叫前 play.ei 保持原終點
//
function play_tune(what) {
  ctxMenu.style.display = 'none';
  if (!play.abcplay) { alert('音效尚未載入，請稍候再試'); return; }
  if (play.playing) {
    if (!play.stopping) stopPlay(false);
    return;
  }
  addTunes();
  var si, ei;

  if (what === 3) {
    // 繼續：從斷點接續，不 reset 跳轉錨點
    if (play.stopAt <= 0) return;
    si = get_se(play.stopAt);
    ei = play.ei; play.stopAt = 0;
    if (!si) return;
    play.repv = 0;
    play.isResume = true;
  } else if (what === 4) {
    // 從指定音符起播
    si = get_se(selx[0]);
    if (!si) return;
    play.si = si;
    ei = play.ei;
    play.loop = (loopMode !== 0);
    play.repv = 0; play.stopAt = 0; loopCount = 0;
  } else {
    play.stopAt = 0;
    if (what === 1) {
      // 選段播放
      var a = selx[0], b = selx[1];
      if (a && b) {
        if (b < a) { var t = a; a = b; b = t; }
        si = get_se(a);
        ei = (a === b) ? get_measure_end(a) : get_ee_by_time(si, syms[b]);
      } else if (a) {
        si = get_se(a); ei = get_measure_end(a);
      } else if (b) {
        si = gsot(b); ei = get_ee(b);
      }
    } else {
      // what=0：整首 / 重播
      //   (A) 右鍵選單「播放」（無 B 點）：play.click.tuneFirst 指定曲子起點
      //   (B) onLeftClick 空白處重播：改用 play.si
      var fromClick = play.click && play.click.tuneFirst;
      play.click = null;
      si = fromClick ? gsot_tune_start(fromClick) : play.si || first_sym();
      ei = fromClick ? null : play.ei;
      if (!si) return;
    }
    if (si && ei && si === ei) ei = get_measure_end(syms.indexOf(si));
    play.si = si; play.ei = ei; play.loop = (loopMode !== 0); play.repv = 0;
    if (!play.loop) loopCount = 0;
  }

  // 狀態重設
  selx_sav[0] = selx[0]; selx_sav[1] = selx[1];
  play.stopping = false; play.curNote = play.lastNote = 0;
  playStart(si, ei);
}
window.play_tune = play_tune;

function playStart(si, ei) {
  if (!si) return;
  if (!play.isResume) _resetAllJumpCtx();
  play.playing = true;
  play.isResume = false;
  updateStatus();
  if (_refreshToggleLabel) _refreshToggleLabel();
  play.abcplay.play(si, ei, play.repv);
}

// ══════════════════════════════════════════
// 15. 啟動
// ══════════════════════════════════════════
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', dom_loaded, { once: true });
else
  dom_loaded();

}());
