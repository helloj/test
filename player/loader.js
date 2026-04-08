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
 *      - 左鍵點音符：設 A 點，若 A < B 則保留 B 點（選段播放），否則清 B 點
 *      - 左鍵點空白：非播放中從頭（或上次位置）起播；播放中暫停；暫停中繼續
 *      - 右鍵點音符：設 B 點（選段終點）；播放中即時調整終點
 *
 * 與 HTML 的約定：
 *   - 若頁面有 .tune-block 等父容器包住 <script type="text/vnd.abc">，
 *     SVG 會自然落在容器內，說明文字與樂譜穿插排列
 *   - #target（隱藏）作為殘留 SVG 的暫存容器
 */
;(function () {

// ══════════════════════════════════════════
// 0A. 播放狀態枚舉
// ══════════════════════════════════════════
/**
 * PlayState - 播放器狀態機
 *
 * @enum {number}
 * @readonly
 *
 * 狀態說明：
 *   IDLE     (0) - 閒置，無播放活動（初始狀態 / 播放完成後）
 *   PLAYING  (1) - 正在播放音樂，AudioContext 運行中
 *   PAUSED   (2) - 已暫停，AudioContext suspended，但保留播放進度
 *   STOPPING (3) - 停止中（過渡狀態），等待 onPlayEnd 回調完成清理
 *
 * 合法轉換：
 *   IDLE     → PLAYING   (playStart)
 *   PLAYING  → PAUSED    (pausePlay)
 *   PLAYING  → STOPPING  (stopPlay)
 *   PAUSED   → PLAYING   (resumePlay)
 *   PAUSED   → STOPPING  (stopPlay)
 *   STOPPING → IDLE      (onPlayEnd)
 *   PLAYING  → IDLE      (onPlayEnd, 自然結束)
 */
var PlayState = {
  IDLE:     0,  // 閒置
  PLAYING:  1,  // 播放中
  PAUSED:   2,  // 已暫停
  STOPPING: 3   // 停止中
};

var PlayStateName = ['IDLE', 'PLAYING', 'PAUSED', 'STOPPING'];

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
 * _insertAnchor(refSym, extra, mode)
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

  var insertBefore;  // anchor 將插在此節點之前

  if (mode === 'chain-head') {
    // 找插入點：從 refSym 往 ts_prev 走，找到第一個 _anchor 節點，
    // tuneStart 插在它之前，維護 anchor 鏈的正確 ts_prev/ts_next。
    // 若沒有任何 anchor，則插在當前最前面的節點之前。
    var s = refSym;
    while (s && s.ptim === undefined) s = s.ts_next;
    anchor.ptim = s ? s.ptim : 0;
    anchor.v    = refSym.v;
    anchor.p_v  = refSym.p_v;

    // 往 ts_prev 走，找第一個已有的 _anchor
    var cur = refSym;
    var firstAnchor = null;
    while (cur.ts_prev) {
      cur = cur.ts_prev;
      if (cur._anchor) { firstAnchor = cur; break; }
    }
    insertBefore = firstAnchor || cur;

  } else if (mode === 'chain-tail') {
    // 找整條鏈的鏈尾
    var last = refSym;
    while (last.ts_next) last = last.ts_next;
    anchor.ptim  = last.ptim + (last.pdur || 0);
    anchor.v     = last.v;
    anchor.p_v   = last.p_v;
    // 鏈尾直接接上，不走通用插入路徑
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
        // tuneStart 是絕對起點：永遠不往它之前插入
        insertAfter = cur;
        break;
      }
      if (cur._anchor) {
        // 遇到已有 anchor：停在它後面，保持呼叫順序
        insertAfter = cur;
        break;
      }
      if (rangeMin !== undefined && cur.istart !== undefined && cur.istart < rangeMin) {
        // 遇到 tune 範圍外的節點：停在它後面，不穿越邊界
        insertAfter = cur;
        break;
      }
      if (cur.ptim === undefined || cur.ptim < ptim) {
        // 遇到 ptim 更早的節點：停在它後面
        insertAfter = cur;
        break;
      }
      if (cur.bar_type) {
        // 遇到真正的 BAR（非空字串）：停在它後面
        insertAfter = cur;
        break;
      }
      // cur.ptim === ptim：同群組非 anchor 非 BAR，繼續往前
      insertAfter = cur.ts_prev;
      cur = cur.ts_prev;
    }

    if (insertAfter) {
      insertBefore = insertAfter.ts_next;
    } else {
      // 走到鏈頭（不應發生，tuneStart 保護了邊界）
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
      // 找到 :| ，確認對應的 |: 在 jump 之前
      return s.rep_p.ptim <= jumpSym.ptim;
    }
    s = s.ts_next;
  }
  return false;
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

// ── 動態攔截：完整替換 abc2svg.play_next，加入 anchor 處理 ──────

function _handleAnchor(s, po, ctx) {
  if (!ctx) return null;
  var target = null;

  if (s._jumpAnchor) {
    // 方案 C（修正版）：若 anchor 在 repeat 括弧內，且目前是第一次 pass
    // （po.repn === false 表示尚未回彈過，即還在第一次通過），
    // 則 enable 而不跳，等第二次路過再執行跳轉。
    if (s._inRepeat && !po.repn) {
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
    ctx = null
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
      clearOnnoteTimouts(po);
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
      state: PlayState.IDLE,
      si:null, ei:null, repv:0,
      abcplay:null,
      lastNote:0, curNotes:new Set(),
      _pausedPo: null, _resumeGen: 0
    };

var refreshToggleLabel = function() {};

// ══════════════════════════════════════════
// 4b. 輔助函式
// ══════════════════════════════════════════

/**
 * setState(newState, reason) - 狀態轉換函式（帶日誌與合法性檢查）
 *
 * @param {PlayState} newState - 目標狀態
 * @param {string} [reason] - 轉換原因（調試用）
 *
 * 範例：
 *   setState(PlayState.PLAYING, 'playStart');
 *   setState(PlayState.PAUSED, 'user clicked pause');
 */
function setState(newState, reason) {
  var oldState = play.state;
  if (oldState === newState) return;  // 忽略無效轉換

  // ── 合法性檢查（開發環境啟用，生產環境可註解）──
  var validTransitions = {
    0: [1],       // IDLE     → PLAYING
    1: [2, 3, 0], // PLAYING  → PAUSED / STOPPING / IDLE（自然結束）
    2: [1, 3],    // PAUSED   → PLAYING / STOPPING
    3: [0]        // STOPPING → IDLE
  };
  if (validTransitions[oldState].indexOf(newState) === -1) {
    console.error('[狀態機錯誤] 非法轉換：' +
      PlayStateName[oldState] + ' → ' + PlayStateName[newState] +
      (reason ? ' (' + reason + ')' : ''));
    return;
  }

  // ── 執行狀態轉換 ──
  play.state = newState;

  // ── 調試日誌（開發環境啟用，生產環境可註解）──
  if (typeof console !== 'undefined' && console.log) {
    console.log('[狀態機] ' + PlayStateName[oldState] + ' → ' +
                PlayStateName[newState] +
                (reason ? ' (' + reason + ')' : ''));
  }
}

/**
 * isState(state) - 狀態檢查函式（提升可讀性）
 *
 * @param {PlayState} state - 要檢查的狀態
 * @returns {boolean}
 *
 * 範例：
 *   if (isState(PlayState.PLAYING)) { ... }
 */
function isState(state) {
  return play.state === state;
}

/**
 * isActivePlayback() - 檢查是否處於活躍播放週期（PLAYING 或 PAUSED）
 *
 * @returns {boolean}
 */
function isActivePlayback() {
  return play.state === PlayState.PLAYING || play.state === PlayState.PAUSED;
}

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

//
// 清除 po._onnoteTimouts 內所有待觸發的 onnote on/off setTimeout。
// Audio5.stop() 原版只清 po.timouts，_onnoteTimouts 需自行清除。
//
// 注意：pausePlay 不使用此函式，因為它需要將 entry 轉存到
//       play._pausedOnnotes 供 resumePlay 重排，語意不同。
//
function clearOnnoteTimouts(po) {
  if (!po || !po._onnoteTimouts) return;
  po._onnoteTimouts.forEach(function(e) { clearTimeout(e.id); });
  po._onnoteTimouts = [];
}

//
// 使用者點選音符後的統一入口。
//
// 職責：
//   1. 設定 A 點（selx[0] = v）
//   2. B 點保留判斷：v < selx[1] 時保留 B 點，否則清除
//   3. 處理 paused 狀態的非同步起播序列
//   4. 呼叫 play_tune()
//
// paused 路徑說明：
//   必須按照 ac.resume() → stop() → play_tune() 的順序。
//   不能直接呼叫 stopPlay()：stopPlay 的 paused 路徑是
//   resume().then(stop)，play_tune() 若在 then() 外執行，
//   ac 仍 suspended，第一次 click 無聲。
//
function seekTo(v) {
  // ── B 點保留判斷（在任何狀態切換前先決定） ────────────────────
  var keepB = selx[1] && v < selx[1];
  setsel(0, v);
  if (!keepB) setsel(1, 0);
  // play.si 提前更新：即使 play_tune 因 abcplay 未載入而提早 return，
  // 之後按 Play 按鈕仍會從此音符起播，而非回到上次位置。
  play.si = get_se(v);

  // ── [狀態機] paused 狀態：ac.resume() → stop → play_tune ───────
  if (isState(PlayState.PAUSED)) {
    // 清 JS 層殘留的 onnote timouts
    // （pausePlay 已清 po.timouts，只剩 _onnoteTimouts）
    var po = play._pausedPo;
    clearOnnoteTimouts(po);
    play._pausedPo = null;
    ++play._resumeGen;  // 使任何進行中的 resumePlay then() 失效
    setState(PlayState.STOPPING, 'seekTo from PAUSED');

    po.ac.resume().then(function() {
      play.abcplay.stop();  // 同步：清 gain，觸發 onPlayEnd
      // onPlayEnd 已同步執行：play.state=IDLE
      play_tune();
    });
    return;
  }

  // ── [狀態機] idle 狀態：直接起播 ──────────────────────────────
  play_tune();
}

// ══════════════════════════════════════════
// 7. 點擊事件
// ══════════════════════════════════════════
function onLeftClick(evt) {
  var v = getSymIndex(evt.target);

  // ── paused 狀態 ───────────────────────────────────────────────
  if (isState(PlayState.PAUSED)) {
    if (v) seekTo(v);
    else   resumePlay();
    return;
  }

  // ── playing 狀態 ──────────────────────────────────────────────
  if (isState(PlayState.PLAYING)) {
    if (v) {
      // abcplay.stop() 同步呼叫 onPlayEnd，stopPlay() 返回時
      // play.state 已為 IDLE，seekTo() 可安全起播。
      stopPlay(); seekTo(v);
    } else {
      pausePlay();
    }
    return;
  }

  // ── idle 狀態 ─────────────────────────────────────────────────
  if (v) seekTo(v);
  else   play_tune();  // 無音符：從頭（或上次位置）起播，感知 A/B 點
}

function onRightClick(evt) {
  evt.preventDefault();
  var v = getSymIndex(evt.target);
  if (!v) return;
  // 右鍵點音符：設 B 點
  setsel(1, v);
  if (isState(PlayState.PLAYING)) {
    // 播放中即時調整終點：以目前 A 點（selx[0]）和新 B 點重算 ei
    // 與 play_tune 的 A/B 對調保護對齊：b < a 時 swap 後重算
    var a = selx[0], b = v, si;
    if (a) {
      if (b < a) { var t = a; a = b; b = t; }
      si = get_se(a);
    } else {
      si = play.si;
    }
    if (si) {
      var newEi = (a === b) ? get_measure_end(a) : get_ee_by_time(si, syms[b]);
      if (abc2svg._current_po) abc2svg._current_po.s_end = newEi;
      play.ei = newEi;
      // 選段範圍變更：循環計數歸零，UI 從第一圈重新顯示
      if (loopMode !== 0) { loopCount = 0; refreshToggleLabel(); }
    }
  }
}

// ══════════════════════════════════════════
// 8. 播放/暫停按鈕 + 循環開關
// ══════════════════════════════════════════
(function () {
  var loopIcon  = document.getElementById('loop-icon'),
      ppBtn     = document.getElementById('play-pause-btn');

  // ── Play/Pause 按鈕顯示更新 ───────────────────────
  function refreshPlayPauseBtn() {
    var icon;
    switch (play.state) {
      case PlayState.PAUSED:
        icon = CFG.ICON_RESUME;
        break;
      case PlayState.PLAYING:
        icon = CFG.ICON_PAUSE;
        break;
      default:  // IDLE / STOPPING
        icon = CFG.ICON_PLAY;
    }
    ppBtn.textContent = icon;
  }

  // ── loop-icon 顯示更新 ────────────────────────────
  function refreshLoopIcon() {
    var on = loopMode !== 0;
    loopIcon.classList.toggle('active', on);
    if (on && isState(PlayState.PLAYING)) {
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

  // ── Play/Pause 按鈕 click ─────────────────────────
  ppBtn.addEventListener('click', function () {
    if (isState(PlayState.PAUSED)) {
      // paused 狀態：resume（直接接續，不走 play_next）
      resumePlay();
    } else if (isState(PlayState.PLAYING)) {
      // playing 狀態：pause（凍結 ac，保留 po）
      pausePlay();
    } else {
      // idle 狀態：play_tune() 統一感知 A/B 點與 play.si
      play_tune();
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
  if (isState(PlayState.PAUSED) && on) return;

  // ── [B-overshoot] B 點越界偵測 ────────────────────────────────
  // onnote on 觸發時，若當前音符 istart 已超過 B 點（selx[1]），
  // 表示 po.s_end 設置時音符已送進 WebAudio Buffer，無法撤回。
  // 立即停播並從原 A/B 點重新起播，selx 狀態不變，
  // play_tune() 自動感知 A/B 重算 si/ei。
  if (on && selx[1] && i > selx[1] && isState(PlayState.PLAYING)) {
    stopPlay();
    play_tune();
    return;
  }
  // ── [B-overshoot] end ─────────────────────────────────────────

  if (on) {
    // 多聲部：同一時間點多個 istart 都可以亮，不清舊
    play.lastNote = i;
    play.curNotes.add(i);
  } else {
    play.curNotes.delete(i);
  }
  if (isState(PlayState.STOPPING) && on) return;
  setNoteOp(i, on);
}

// ── [scroll] 捲動防抖旗標：smooth 動畫期間（約 500ms）鎖住重複觸發 ──
var _scrollPending = false;

function setNoteOp(i, on) {
  var elts = document.getElementsByClassName('_' + i + '_');
  if (!elts || !elts.length) return;
  var isMarker = (i === selx[0] || i === selx_sav[0] || i === selx[1] || i === selx_sav[1]);
  var op = on ? 0.4 : (isMarker ? 0.4 : 0);
  for (var j = 0; j < elts.length; j++) elts[j].style.fillOpacity = op;
  if (on) {
    var r = elts[0].getBoundingClientRect();
    // ── 觸發條件：音符進入下 1/4（bottom 超過 3/4 高度）或超出上緣（top < 20）──
    // ── 捲動目標：讓音符落在上 1/5（r.top → innerHeight / 5）             ──
    // ── 防抖：_scrollPending 期間不重複觸發，避免 smooth 動畫連續疊加抖動  ──
    var triggerLow  = r.bottom > window.innerHeight * 3 / 4;
    var triggerHigh = r.top < 20;
    if ((triggerLow || triggerHigh) && !_scrollPending) {
      _scrollPending = true;
      window.scrollBy({ top: r.top - window.innerHeight / 5, behavior: 'smooth' });
      setTimeout(function () { _scrollPending = false; }, 500);
    }
  }
}

// ══════════════════════════════════════════
// 11. 播放控制工具
// ══════════════════════════════════════════

/**
 * pausePlay() - 暫停播放
 *
 * 狀態轉換：PLAYING → PAUSED
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
  // ── [狀態機] 只有 PLAYING 狀態才能暫停 ──
  if (!isState(PlayState.PLAYING)) return;

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

  // ── [狀態機] 狀態轉換：PLAYING → PAUSED ──
  setState(PlayState.PAUSED, 'pausePlay');
  play._pausedPo = po;
  refreshToggleLabel();
}

/**
 * resumePlay() - 恢復播放
 *
 * 狀態轉換：PAUSED → PLAYING
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
  // ── [狀態機] 只有 PAUSED 狀態才能恢復 ──
  if (!isState(PlayState.PAUSED)) return;

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

    // ── [狀態機] 狀態轉換：PAUSED → PLAYING ──
    setState(PlayState.PLAYING, 'resumePlay.then');

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

    refreshToggleLabel();
  });
}

/**
 * stopPlay() - 停止播放
 *
 * 狀態轉換：PLAYING / PAUSED → STOPPING
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
  clearOnnoteTimouts(po);

  // ── [狀態機] PAUSED 狀態的特殊處理 ──
  if (isState(PlayState.PAUSED)) {
    // ── [優化3] paused 狀態：ac.resume() 非同步，待恢復後再 stop ──
    play._pausedPo = null;
    ++play._resumeGen;  // 使任何進行中的 resumePlay then() 失效
    if (po && po.ac && po.ac.state !== 'running') {
      po.ac.resume().then(function() { play.abcplay.stop(); });
      setState(PlayState.STOPPING, 'stopPlay from PAUSED');
      return;
    }
  }

  // ── [狀態機] 狀態轉換：PLAYING / PAUSED → STOPPING ──
  setState(PlayState.STOPPING, 'stopPlay');
  play.abcplay.stop();
}

/**
 * onPlayEnd() - 播放結束回調
 *
 * 狀態轉換：
 *   - STOPPING → IDLE（用戶主動停止）
 *   - PLAYING  → IDLE（自然結束）或 → PLAYING（循環重播）
 */
function onPlayEnd(repv) {
  // ── [狀態機] paused 狀態下 onend 不應觸發 ──
  if (isState(PlayState.PAUSED)) return;

  // ── [狀態機] PLAYING 狀態：自然結束，檢查循環 ──
  if (isState(PlayState.PLAYING)) {
    // 循環模式：直接重播（loopMode !== 0 即啟用，無次數上限）
    if (loopMode !== 0) {
      ++loopCount;
      refreshToggleLabel();
      playStart(play.si, play.ei);
      return;  // 保持 PLAYING 狀態
    }
    loopCount = 0;  // 自然結束才重置計數
  }

  // ── [狀態機] STOPPING 狀態：用戶主動停止，不重置 loopCount ──
  // （原版 line 1745: if (!play.stopping) loopCount = 0;）
  // 意即：主動停止保留計數，自然結束才重置

  // ── [狀態機] 狀態轉換：PLAYING / STOPPING → IDLE ──
  setState(PlayState.IDLE, 'onPlayEnd');

  play.repv = repv;
  selx_sav[0] = selx[0]; selx_sav[1] = selx[1];
  refreshToggleLabel();
}

// ══════════════════════════════════════════
// 12. 播放主函式
// ══════════════════════════════════════════
//
// play_tune()
//
//   統一由 selx[0]（A點）/ selx[1]（B點）推算 si / ei，
//   不再使用 what 參數：
//
//   si：有 A點 → get_se(selx[0])
//       無 A點 → play.si || first_sym()（從上次位置或曲首）
//
//   ei：有 A點 且 有 B點 且 A < B → get_ee_by_time()（選段）
//       A === B                   → get_measure_end()（單小節）
//       B < A                     → swap 後同上（對調保護）
//       無 B點，僅有 B點           → gsot(b) 起播到 get_ee(b)
//       否則                      → null（播到結尾）
//
//   呼叫方只需設好 selx（透過 seekTo 或直接操作），不再傳 what 參數。
//
function play_tune() {
  if (!play.abcplay) { alert('音效尚未載入，請稍候再試'); return; }

  // ── [狀態機] PAUSED 狀態下除非明確 resume，否則不重新起播 ──
  if (isState(PlayState.PAUSED)) return;

  // ── [狀態機] PLAYING / STOPPING 狀態：停止播放 ──
  if (isActivePlayback() || isState(PlayState.STOPPING)) {
    // 防止重複調用 stopPlay（原版 line 1778: if (!play.stopping) stopPlay()）
    if (!isState(PlayState.STOPPING)) {
      stopPlay();
    }
    return;
  }

  // ── [狀態機] IDLE 狀態：開始新播放 ──
  addTunes();

  var a = selx[0], b = selx[1], si, ei;

  // ── 決定起點 ──────────────────────────────────────────────────
  if (a) {
    si = get_se(a);
  } else {
    si = play.si || first_sym();
  }
  if (!si) return;

  // ── 決定終點 ──────────────────────────────────────────────────
  if (a && b) {
    // A/B 對調保護
    if (b < a) { var t = a; a = b; b = t; si = get_se(a); }
    ei = (a === b) ? get_measure_end(a) : get_ee_by_time(si, syms[b]);
  } else if (!a && b) {
    // 無 A 點但有 B 點：從 B 點所在序列起播到 B
    si = gsot(b); ei = get_ee(b);
  } else {
    ei = null;  // 播到結尾
  }

  // ── 狀態更新 ──────────────────────────────────────────────────
  play.si = si; play.ei = ei;
  play.repv = 0; loopCount = 0;
  selx_sav[0] = selx[0]; selx_sav[1] = selx[1];
  play.curNotes = new Set(); play.lastNote = 0;
  playStart(si, ei);
}
window.play_tune = play_tune;

/**
 * playStart() - 開始播放
 *
 * 狀態轉換：IDLE → PLAYING
 */
function playStart(si, ei) {
  if (!si) return;
  // 新播放開始時，確保清除任何殘留的 paused 狀態（_pausedPo = null 表示 not paused）
  play._pausedPo = null;
  // resume 時 anchor 狀態存在 sym 節點上，stop 後仍存活，不需要 reset jumpCtx
  _resetAllJumpCtx();

  // ── [狀態機] 狀態轉換：IDLE → PLAYING ──
  setState(PlayState.PLAYING, 'playStart');
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
