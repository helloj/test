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
 *   <script src="https://cdn.jsdelivr.net/gh/helloj/test@main/abc2svg/abc2svg_files/abc2svg-1.js"></script>
 *   <script src="https://cdn.jsdelivr.net/gh/helloj/test@main/abc2svg/abc2svg_files/snd-1.js"></script>
 *   <script src="https://cdn.jsdelivr.net/gh/helloj/test@main/player/loader.js"></script>
 *
 *   <!-- 每首曲子放在獨立的區塊 -->
 *   <script type="text/vnd.abc">
 *   X:1
 *   T:曲名
 *   ...
 *   </script>
 *
 * 本檔負責：
 *   1. 注入 CSS（浮動工具列樣式）
 *   2. 建立 DOM 結構（#fab-toolbar、#target）
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
  ICON_NOLOOP:   '➔',   // 非循環模式狀態指示（不可按）
  ICON_INFINITE: '♾️',  // 無限循環
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
// 1. 注入 CSS
// ══════════════════════════════════════════
(function () {
  var style = document.createElement('style');
  style.textContent = [
    "/* player.css – abc2svg Player 樣式 */",
    "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}",
    ":root{--ink:#1a120b;--paper:#f5efe6;--accent:#8b3a3a;--muted:#c2a97a;--panel:rgba(245,239,230,0.66);--panel-solid: rgb(245,239,230)}",
    "html,body{height:100%;background:var(--paper);color:var(--ink);font-family:'Noto Serif TC','Kaiti TC','STKaiti',serif}",
    /* fab-toolbar：水平浮動，固定在右上角 */
    "#fab-toolbar{position:fixed;top:16px;right:100px;z-index:50;display:flex;flex-direction:row;align-items:center;gap:6px;background:var(--panel);border:1px solid var(--muted);border-radius:8px;padding:6px 8px;box-shadow:0 4px 16px rgba(139,58,58,0.15);user-select:none}",
    ".fab-divider{width:1px;height:1.8em;background:var(--muted);opacity:.4;margin:0 2px}",
    "#play-pause-btn{display:flex;align-items:center;justify-content:center;width:2.4em;height:2.4em;border:1px solid var(--muted);border-radius:4px;background:transparent;color:var(--muted);font-size:.85rem;cursor:pointer;transition:background .12s,color .12s;line-height:1;padding:0;font-family:inherit}",
    "#play-pause-btn:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
    "#loopSegBtn{position:relative;display:flex;align-items:center}",
    "#loop-icon{display:flex;align-items:center;justify-content:center;width:2.4em;height:2.4em;border:1px solid var(--muted);border-radius:4px;background:transparent;color:var(--muted);font-size:.85rem;cursor:pointer;transition:background .12s,color .12s;line-height:1;padding:0;font-family:inherit;white-space:nowrap}",
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
 *
 * 方案 B：多聲部（V:1,2 等）時，同一個時間點（ptim）在 ts_next 鏈上
 * 會有多個不同 voice 的 sym 節點。若只插在 refSym 的緊前面，其他
 * voice 的 sym 在鏈上可能排在 anchor 之前，導致播放推進時直接越過
 * anchor（例如 `|1 rep_s` 跳轉在 [B2] 觸發之前就發生）。
 *
 * 修正：往 ts_prev 方向回溯，找到第一個 ptim 嚴格小於 refSym.ptim
 * 的節點（或鏈頭），然後把 anchor 插在該節點的 ts_next 位置，
 * 確保 anchor 是同 ptim 群組的最前面節點，任何 voice 走到這個
 * 時間點都一定先經過 anchor。
 *
 * 注意：已存在的 anchor（_anchor=true）與 ptim 相同的節點一律跳過，
 * 讓多個 anchor 按照呼叫順序依序排列（ptim 去重由呼叫端 codaAnchors
 * 等陣列保證，這裡不重複檢查）。
 */
function _insertAnchorBefore(refSym, extra) {
  var C = abc2svg.C;
  var ptim = refSym.ptim;

  // 往前回溯，找到同 ptim 群組的最前節點之前的插入點。
  // 停止條件：
  //   1. 到達鏈頭（ts_prev 為 null/undefined）
  //   2. 遇到 ptim 嚴格小於目標 ptim 的節點（非 anchor）
  // 已插入的 anchor（_anchor=true）視為透明，繼續往前回溯。
  var insertAfter = refSym.ts_prev;  // 預設：緊前面
  var cur = refSym.ts_prev;
  while (cur) {
    if (cur._anchor) {
      // 跳過已有的 anchor，繼續往前看
      cur = cur.ts_prev;
      continue;
    }
    if (cur.ptim === undefined || cur.ptim < ptim) {
      // 找到 ptim 更早的節點，停止；anchor 插在 cur 之後
      insertAfter = cur;
      break;
    }
    // cur.ptim === ptim：還在同 ptim 群組，繼續往前
    insertAfter = cur.ts_prev;  // 暫定插在更前面
    cur = cur.ts_prev;
  }
  // cur === null 表示走到鏈頭，insertAfter 為 null，anchor 插到最前

  var anchor = {
    _anchor:  true,
    ptim:     ptim,
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

  // 插入：anchor 放在 insertAfter 與 insertAfter.ts_next 之間
  var insertBefore = insertAfter ? insertAfter.ts_next : refSym;
  // 若 insertAfter 為 null，insertBefore 取鏈頭
  if (!insertAfter) {
    // 找鏈頭
    insertBefore = refSym;
    while (insertBefore.ts_prev) insertBefore = insertBefore.ts_prev;
  }
  var prev = insertBefore.ts_prev;
  anchor.ts_prev = prev;
  anchor.ts_next = insertBefore;
  if (prev) prev.ts_next = anchor;
  insertBefore.ts_prev = anchor;
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
        _pushIfNewPtim(segnoAnchors, a);
      }

      if (name === 'fine') {
        var a = _insertAnchorBefore(s, { _landAnchor: true, _fineAnchor: true, jumpFine: false });
        _pushIfNewPtim(fineAnchors, a);
      }

      if (name === 'coda') {
        var a = _insertAnchorBefore(s, { _codaAnchor: true, jumpCoda: false });
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
//
// patch 說明：
//   do_tie / set_ctrl / play_cont / get_part 直接複製自 snd-1.js 原文，
//   不做任何修改。僅在 play_cont 的以下位置插入修補：
//     [GEN]    play_cont 開頭：init po._gen + 遞增世代號 + 版本守衛，
//              過濾殘存的舊世代 setTimeout
//     [B1]     noplay while 之後：處理播放起點本身落在 anchor 的情況
//     [B2]     內層 while 的 s=s.ts_next 之後：中途遇到 anchor 時跳轉
//     [pause]  NOTE/REST 排程：onnote on/off 存入 po._onnoteTimouts（帶 at/on）
//     [pause]  批次重置：po._onnoteTimouts=[] 與 po.timouts=[] 同步
//     [pause]  play_cont 末尾：記錄 po._nextT 供 pausePlay 計算 _nextContAt
//     [pause]  play_next 末尾：存 po._play_cont reference 供 resumePlay 呼叫
//   未來 snd-1.js 更新時，重新複製四個函數後貼回上述 [GEN][B1][B2][pause] 即可。

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

  // ── 以下為 snd-1.js 原文（play_cont）+ [GEN][B1][B2][pause] patch ──
  function play_cont(po){var d,i,st,m,note,g,s2,t,maxt,now,p_v,C=abc2svg.C,s=po.s_cur

    // ── [GEN] 首次進入（po 剛建立）：init + 遞增世代號
    //         後續 setTimeout(play_cont,...) 再進來時 po._gen 已有值，跳過遞增。
    //         版本不符表示這是殘存的舊世代排程，直接丟棄。
    if(po._gen === undefined){
      po._gen = ++_playGeneration;
    }
    if(po._gen !== _playGeneration){
      po.timouts.forEach(function(id){ clearTimeout(id); });
      po.timouts = [];
      if(po._onnoteTimouts){ po._onnoteTimouts.forEach(function(e){ clearTimeout(e.id); }); po._onnoteTimouts=[]; }
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

    // ── [B1] 起點落在 anchor 時走過並取得落點 ────────────────────
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
    // ── [pause] po._onnoteTimouts 與 po.timouts 同步重置 ──────────
    po._onnoteTimouts=[]
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
          // ── [pause] onnote on/off 存入 po._onnoteTimouts（帶觸發絕對時間 at、on 旗標）
          // po.timouts 只存 play_cont reschedule，相容 Audio5.stop() 原版。
          // pause 時兩者分別處理：play_cont 丟棄，onnote 存下剩餘 delay 供 resume 重排。
          if(!po._onnoteTimouts) po._onnoteTimouts=[]
          po._onnoteTimouts.push({id:setTimeout(po.onnote,st,i,true),at:now+st/1000,i:i,on:true})
          if(d>2)
            d-=.1
          var doff=st+d*1000
          po._onnoteTimouts.push({id:setTimeout(po.onnote,doff,i,false),at:now+doff/1000,i:i,on:false})}
        break}}
    while(1){if(!s||s==po.s_end||!s.ts_next||s.ts_next==po.s_end||po.stop){if(po.onend)
        setTimeout(po.onend,(t-now+d)*1000,po.repv)
        po.s_cur=s
        return}
      s=s.ts_next

      // ── [B2] 中途遇到 anchor 時跳轉 ──────────────────────────
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
  // ── [pause] 記錄下一批 play_cont 應觸發的絕對時間，供 pausePlay 使用 ──
  po._nextT = t;
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
  // ── [pause] 把 play_cont reference 存到 po，供 resumePlay 直接呼叫 ──
  po._play_cont = play_cont;
  // ── [pause] end ────────────────────────────────────────────────
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
    loopMode  = 0,
    loopCount = 0,
    selx      = [0, 0],
    selx_sav  = [],
    currentSpeed = CFG.SPEED_DEFAULT,  // 當前播放速度（倍率）
    play = {
      playing:false, stopping:false,
      si:null, ei:null, repv:0,
      abcplay:null,
      lastNote:0, curNotes:new Set(),
      // ── pause/resume ───────────────────────────────────────────
      // _pausedPo: paused 時存下的 po reference；null = not paused。
      //            用 play._pausedPo !== null 判斷 paused 狀態，
      //            不另設 paused boolean，確保兩者永遠同步。
      // _resumeGen: resume 世代號，防止快速 pause/resume race condition
      _pausedPo: null, _resumeGen: 0
    };

// refreshToggleLabel：Section 8 IIFE 初始化時設定，此後直接呼叫
var refreshToggleLabel = function() {};

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
// 6. 工具函式
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
  return gnrn(root) || (root !== s ? gnrn(s) : null);
}

function get_se(si) {
  return syms[si] || null;
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
// 7. 點擊事件
// ══════════════════════════════════════════
function onLeftClick(evt) {
  var v = getSymIndex(evt.target);

  if (play._pausedPo !== null) {
    if (v) {
      // paused 中點音符：取消 pause，從該音符重新播
      var po = play._pausedPo;
      if (po && po.ac) po.ac.resume();
      play._pausedPo = null;
      play.playing   = false;  // 讓 play_tune 可以進入
      play.stopping  = false;
      setsel(0, v); setsel(1, 0);
      play.ei = null;
      play_tune(4);
    } else {
      // paused 中點空白：resume
      resumePlay();
    }
    return;
  }

  if (play.playing && !play.stopping) {
    if (v) {
      // 播放中點到音符：直接切換起播位置（殘存問題由 _playGeneration 守衛解決）
      stopPlay();                // 停止舊播放
      setsel(0, v);             // 設新 A 點
      setsel(1, 0);             // 清 B 點
      play.ei = null;           // 整首從新音符播到結尾
      play_tune(4);             // 從新音符立即起播
    } else {
      // 點空白：pause（新構想，保留 po）
      pausePlay();
    }
    return;
  }

  // ── 非播放狀態 ────────────────────────────────────────────────
  // 左鍵 click 同時清除 B 點
  if (v) {
    setsel(0, v); setsel(1, 0);
    play.ei = null;   // 整首從此音符播到結尾
    play_tune(4);
  } else {
    play.repv = 0; loopCount = 0;
    play_tune(0);
  }
}

function onRightClick(evt) {
  evt.preventDefault();
  var v = getSymIndex(evt.target);
  if (!v) return;
  // 右鍵點音符：設 B 點
  setsel(1, v);
  if (play.playing) {
    // 播放中即時調整終點
    var a = selx[0], b = v;
    if (a && b) {
      if (b < a) { var t = a; a = b; b = t; }
      var newSi = get_se(a), newEi = get_ee_by_time(newSi, syms[b]);
      if (abc2svg._current_po) abc2svg._current_po.s_end = newEi;
      play.ei = newEi;
    }
  }
}

// ══════════════════════════════════════════
// 8. 播放/暫停按鈕 + 循環開關
// ══════════════════════════════════════════
(function () {
  var loopIcon  = document.getElementById('loop-icon'),
      ppBtn     = document.getElementById('play-pause-btn');

  // ── Play/Pause 按鈕顯示更新 ─────────────────────────────────────
  function refreshPlayPauseBtn() {
    if (play._pausedPo !== null) {
      ppBtn.textContent = CFG.ICON_RESUME;
    } else if (play.playing) {
      ppBtn.textContent = CFG.ICON_PAUSE;
    } else {
      ppBtn.textContent = CFG.ICON_PLAY;
    }
  }

  // ── loop-icon 顯示更新 ──────────────────────────────────────────
  function refreshLoopIcon() {
    var on = loopMode !== 0;
    loopIcon.classList.toggle('active', on);
    if (on && play.playing) {
      // 播放中顯示累計循環次數
      loopIcon.textContent = '×' + (loopCount + 1);
    } else {
      loopIcon.textContent = on ? CFG.ICON_LOOP : CFG.ICON_NOLOOP;
    }
  }

  // ── 統一刷新入口（賦值給外層 refreshToggleLabel 變數）────────────
  refreshToggleLabel = function() {
    refreshPlayPauseBtn();
    refreshLoopIcon();
  };

  // ── Play/Pause 按鈕 click ───────────────────────────────────────
  ppBtn.addEventListener('click', function () {
    if (play._pausedPo !== null) {
      // paused 狀態：resume（直接接續，不走 play_next）
      resumePlay();
    } else if (play.playing) {
      // playing 狀態：pause（凍結 ac，保留 po）
      pausePlay();
    } else {
      play.si = play.si || first_sym();
      play.repv = 0; loopCount = 0;
      play_tune(0);
    }
  });

  // ── 內部：啟用循環 ──────────────────────────────────────────────
  function setLoopMode() {
    loopMode  = CFG.LOOP_INFINITE;
    loopCount = 0;
    refreshLoopIcon();
  }

  // ── 內部：關閉循環 ──────────────────────────────────────────────
  function clearLoopMode() {
    loopMode  = 0;
    loopCount = 0;
    refreshLoopIcon();
  }

  // ── loop-icon click：直接 toggle loopMode ───────────────────────
  loopIcon.addEventListener('click', function (e) {
    e.stopPropagation();
    if (loopMode !== 0) clearLoopMode();
    else setLoopMode();
  });

}());

// ══════════════════════════════════════════
// 8b. 調速面板
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
// 9. 選取高亮
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

// resume 後清除所有播放高亮，由下一批 onnote 自然接管
function clearAllHighlight() {
  play.curNotes.forEach(function(i) { setNoteOp(i, false); });
  play.curNotes = new Set();
}

// ══════════════════════════════════════════
// 10. 播放中音符高亮
// ══════════════════════════════════════════
function notehlight(i, on) {
  // ── [pause-guard] paused 中 on 回呼已在 task queue 排隊清不掉，在此攔截 ──
  // off 回呼不攔截：讓音符暗掉是正確的，避免殘留高亮。
  if (play._pausedPo && on) return;
  if (on) {
    // 多聲部：同一時間點多個 istart 都可以亮，不清舊
    play.lastNote = i;
    play.curNotes.add(i);
  } else {
    play.curNotes.delete(i);
  }
  if (play.stopping && on) return;
  setNoteOp(i, on);
}

function setNoteOp(i, on) {
  var elts = document.getElementsByClassName('_' + i + '_');
  if (!elts || !elts.length) return;
  var isMarker = (i === selx[0] || i === selx_sav[0] || i === selx[1] || i === selx_sav[1]);
  var op = on ? 0.4 : (isMarker ? 0.4 : 0);
  for (var j = 0; j < elts.length; j++) elts[j].style.fillOpacity = op;
  if (on) {
    var r = elts[0].getBoundingClientRect();
    if (r.top < 20 || r.bottom > window.innerHeight - 20)
      window.scrollBy({ top: r.top - window.innerHeight / 2, behavior: 'smooth' });
  }
}

// ══════════════════════════════════════════
// 11. 播放控制工具
// ══════════════════════════════════════════

/**
 * pausePlay()
 *
 * 不破壞 po 狀態，直接凍結 AudioContext。
 *
 * 1. ac.suspend()       — 凍結 WebAudio 時鐘；已排進佇列的 Buffer Source 暫停發聲
 * 2. clearTimeout       — 清除 po.timouts（play_cont reschedule）
 *                         清除 po._onnoteTimouts（onnote on/off）
 * 3. _nextContAt        — 記錄 play_cont 原本應觸發的絕對時間，resume 時重排
 * 4. _pausedOnnotes     — 存下尚未觸發的 onnote on/off（at > nowAc），resume 時重排
 * 5. 高亮               — clearAllHighlight() 清殘留，setNoteOp(lastNote) 補亮暫停位置
 *
 * po.stim / po.s_cur / po.repv / po.repn / anchor 狀態完全不動。
 */
function pausePlay() {
  var po = abc2svg._current_po;
  if (!po) return;
  var ac = po.ac;
  if (!ac) return;

  // 凍結 WebAudio 時鐘
  if (ac.state === 'running') ac.suspend();
  // suspend 後 currentTime 凍結，此值即暫停點
  var nowAc = ac.currentTime;

  // 記錄 play_cont 下一次應觸發的絕對時間（t - 0.3）
  play._nextContAt = (po._nextT !== undefined) ? (po._nextT - 0.3) : null;

  // 清除 play_cont reschedule
  po.timouts.forEach(function(id) { clearTimeout(id); });
  po.timouts = [];

  // 清除 onnote on/off，存下全部 entry 供 resume 重排
  // 不在此用 e.at > nowAc 過濾：高速播放接近曲尾時 nowAc 誤判範圍大，
  // 改由 resumePlay remaining > 0 決定是否重排，已過期的立刻補亮（delay=0）。
  play._pausedOnnotes = [];
  if (po._onnoteTimouts) {
    po._onnoteTimouts.forEach(function(e) {
      clearTimeout(e.id);
      play._pausedOnnotes.push({at:e.at, i:e.i, on:e.on});
    });
    po._onnoteTimouts = [];
  }

  // 清殘留高亮，補亮暫停位置
  clearAllHighlight();
  if (play.lastNote) setNoteOp(play.lastNote, true);

  play.stopping  = false;
  play._pausedPo = po;
  refreshToggleLabel();
}

/**
 * resumePlay()
 *
 * 恢復 AudioContext，重排 onnote on/off 與 play_cont reschedule，不走 play_next。
 *
 * 1. _resumeGen guard  — 防止快速 pause/resume race condition：
 *                        ac.resume() 是非同步，若 then() 執行前又 pause，
 *                        世代號不符則放棄，不重排任何 setTimeout
 * 2. clearAllHighlight() — 清除 pause 補亮的 lastNote
 * 3. ac.resume()        — 恢復 WebAudio 時鐘；已凍結的 Buffer Source 自動接續
 * 4. 重排 onnote on/off — 用 at - ac.currentTime 算剩餘 delay，重新 setTimeout
 * 5. 重排 play_cont     — 用 _nextContAt 算剩餘 delay，重新 setTimeout
 *
 * po.s_cur / po.stim / repv / repn / anchor 完全不動，無丟失，無重疊。
 */
function resumePlay() {
  var po = play._pausedPo;
  if (!po) return;
  var ac = po.ac;
  if (!ac) return;

  play._pausedPo = null;

  // ── [優化4] 遞增世代號，then() 內比對，防止快速 pause/resume race condition ──
  var myGen = ++play._resumeGen;

  // 清除 pause 補亮的 lastNote
  clearAllHighlight();

  ac.resume().then(function() {
    // ── [優化4] 世代號不符：then() 執行前已再次 pause，放棄本次 resume ──
    if (play._resumeGen !== myGen) return;

    // 重排尚未觸發的 onnote on/off
    if (play._pausedOnnotes) {
      if (!po._onnoteTimouts) po._onnoteTimouts = [];
      play._pausedOnnotes.forEach(function(e) {
        var remaining = (e.at - ac.currentTime) * 1000;
        if (remaining > 0)
          po._onnoteTimouts.push({id:setTimeout(po.onnote,remaining,e.i,e.on), at:e.at, i:e.i, on:e.on});
      });
      play._pausedOnnotes = [];
    }

    // 重排 play_cont reschedule
    var delay = 0;
    if (play._nextContAt !== null && play._nextContAt !== undefined)
      delay = Math.max(0, (play._nextContAt - ac.currentTime) * 1000);
    play._nextContAt = null;
    po.timouts.push(setTimeout(po._play_cont, delay, po));
  });
}

/**
 * stopPlay()
 *
 * 停止播放。
 *
 * [優化3] paused 狀態下先 ac.resume().then(stop)，確保 ac 真正恢復後再執行 stop，
 *         避免 AudioContext 在 suspended 狀態下 stop 行為不確定。
 *
 * [優化5] 主動清除 po._onnoteTimouts：Audio5.stop() 原版只清 po.timouts，
 *         無法清除 _onnoteTimouts，舊的 onnote off 會在新播放開始後才觸發，
 *         造成視覺混亂。stopPlay 主動清除，不需要動 Audio5.stop() 原版。
 */
function stopPlay() {
  var po = abc2svg._current_po;

  // ── [優化5] 主動清除 onnote on/off setTimeout，Audio5.stop() 原版清不到 ──
  if (po && po._onnoteTimouts) {
    po._onnoteTimouts.forEach(function(e) { clearTimeout(e.id); });
    po._onnoteTimouts = [];
  }

  if (play._pausedPo !== null) {
    // ── [優化3] paused 狀態：ac.resume() 非同步，待恢復後再 stop ──
    play._pausedPo = null;
    ++play._resumeGen;  // 使任何進行中的 resumePlay then() 失效
    if (po && po.ac && po.ac.state !== 'running') {
      po.ac.resume().then(function() { play.abcplay.stop(); });
      play.stopping = true;
      return;
    }
  }
  play.stopping = true;
  play.abcplay.stop();
}

function onPlayEnd(repv) {
  // paused 狀態下 onend 不應觸發
  if (play._pausedPo !== null) return;
  if (!play.stopping) {
    // 循環模式：直接重播（loopMode !== 0 即啟用，無次數上限）
    if (loopMode !== 0) {
      ++loopCount;
      refreshToggleLabel();
      playStart(play.si, play.ei);
      return;
    }
  }
  if (!play.stopping) loopCount = 0;
  play.playing = false;
  play.stopping = false;
  play.repv = repv;
  selx_sav[0] = selx[0]; selx_sav[1] = selx[1];
  refreshToggleLabel();
}

// ══════════════════════════════════════════
// 12. 播放主函式
// ══════════════════════════════════════════
//
// play_tune(what)
//
//   what=0  整首 / 重播
//             從 play.si 繼續，或從第一個音符起播
//
//   what=1  選段播放
//             從 selx[0]（A 點）到 selx[1]（B 點）之間的範圍
//             來源：右鍵選單「播放」（有 B 點時自動選段）
//
//   what=4  從指定音符起播
//             si 來自 selx[0]，ei 來自 play.ei（呼叫方負責設定）
//             整首播放中點音符：呼叫前 play.ei = null
//             選段播放中點音符：呼叫前 play.ei 保持原終點
//
function play_tune(what) {
  if (!play.abcplay) { alert('音效尚未載入，請稍候再試'); return; }
  // paused 狀態下除非明確 resume，否則不重新起播
  if (play._pausedPo !== null) return;
  if (play.playing) {
    if (!play.stopping) stopPlay();
    return;
  }
  addTunes();
  var si, ei;

  if (what === 4) {
    // 從指定音符起播
    si = get_se(selx[0]);
    if (!si) return;
    play.si = si;
    ei = play.ei;
    play.repv = 0; loopCount = 0;
  } else {
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
      // what=0：整首 / 重播，從 play.si 或第一個音符起播
      si = play.si || first_sym();
      ei = play.ei;
      if (!si) return;
    }
    if (si && ei && si === ei) ei = get_measure_end(syms.indexOf(si));
    play.si = si; play.ei = ei; play.repv = 0;
    if (loopMode === 0) loopCount = 0;
  }

  // 狀態重設
  selx_sav[0] = selx[0]; selx_sav[1] = selx[1];
  play.stopping = false; play.curNotes = new Set(); play.lastNote = 0;
  playStart(si, ei);
}
window.play_tune = play_tune;

function playStart(si, ei) {
  if (!si) return;
  // 新播放開始時，確保清除任何殘留的 paused 狀態（_pausedPo = null 表示 not paused）
  play._pausedPo = null;
  // resume 時 anchor 狀態存在 sym 節點上，stop 後仍存活，不需要 reset jumpCtx
  _resetAllJumpCtx();
  play.playing = true;
  refreshToggleLabel();
  play.abcplay.play(si, ei, play.repv);
}

// ══════════════════════════════════════════
// 13. 啟動
// ══════════════════════════════════════════
if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', dom_loaded, { once: true });
else
  dom_loaded();

}());
