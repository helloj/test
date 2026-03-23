/**
 * player.js – abc2svg 播放器（自包含版）
 *
 * HTML 中只需：
 *   <script type="text/vnd.abc" id="abc-source">…ABC 樂譜…</script>
 *   <script src="abc2svg-1.js"></script>
 *   <script src="snd-1.js"></script>
 *   <script src="player.js"></script>
 *
 * 本檔負責：
 *   1. 注入 <link> stylesheet（player.css）
 *   2. 建立全部 DOM 結構（header、target、ctxMenu…）
 *   3. 修補 abc2svg.play_next
 *   4. 渲染 ABC → SVG
 *   5. 播放 / 循環 / 選段 / 音符高亮 等完整邏輯
 */
;(function () {

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
    "header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 24px;background:var(--panel);border-bottom:1px solid var(--muted);z-index:50;box-shadow:0 2px 8px rgba(139,58,58,0.08)}",
    "header h1{font-size:1.5rem;color:var(--accent);letter-spacing:.1em;white-space:nowrap}",
    "#header-right{display:flex;align-items:center;gap:14px;flex-shrink:0}",
    "#status{font-size:.78rem;color:var(--muted);letter-spacing:.05em;min-width:0;flex:1 1 auto}",
    "#loop-switch{display:flex;align-items:center;user-select:none}",
    ".seg-btn{display:flex;border:1px solid var(--muted);border-radius:3px;overflow:hidden;cursor:pointer}",
    ".seg-btn .seg{padding:2px 6px;font-size:.7rem;font-family:inherit;background:transparent;color:var(--muted);transition:background .12s,color .12s;line-height:1.5;white-space:nowrap}",
    ".seg-btn .seg:not(:last-child){border-right:1px solid var(--muted)}",
    ".seg-btn .seg:hover{background:rgba(139,58,58,0.10);color:var(--ink)}",
    ".seg-btn .seg.active{background:var(--accent);color:#fff;font-weight:600}",
    "#loop-n-input{width:2em;border:none;background:transparent;color:inherit;font:inherit;font-size:.7rem;text-align:center;outline:none;padding:0;cursor:pointer;-moz-appearance:textfield}",
    "#loop-n-input::-webkit-inner-spin-button,#loop-n-input::-webkit-outer-spin-button{-webkit-appearance:none}",
    ".seg.active #loop-n-input{color:#fff;cursor:text}",
    "#dright{position:relative;max-width:860px;margin:0 auto;padding:28px 20px 60px;z-index:1}",
    "#dright svg{display:block;background:transparent;width:100%;height:auto}",
    "#ctxMenu{position:fixed;display:none;z-index:200;background:var(--panel);border:1px solid var(--muted);border-radius:6px;box-shadow:0 6px 24px rgba(26,18,11,0.18);overflow:hidden;min-width:130px;font-size:.85rem}",
    "#ctxMenu ul{list-style:none}",
    "#ctxMenu li{padding:9px 18px;cursor:pointer;color:var(--ink);transition:background .12s;white-space:nowrap}",
    "#ctxMenu li:hover{background:var(--accent);color:#fff}",
    "#ctxMenu li+li{border-top:1px solid rgba(194,169,122,.3)}",
    ".abcr{fill:#8b3a3a;fill-opacity:0;z-index:15}",
    ".abcr.sel{fill:#3cc878}",
    ".abcr.selb{fill:#e07b00}",
    "#errbanner{display:none;background:#c0392b;color:#fff;padding:6px 16px;font-size:.82rem;cursor:pointer}"
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
    '<header>',
    '  <h1 id="page-title">…</h1>',
    '  <div id="header-right">',
    '    <span id="status">左鍵點音符：設 A 點並從此播放；右鍵點音符：設 B 點（選段終點）</span>',
    '    <div id="loop-switch">',
    '      <div class="seg-btn" id="loopSegBtn">',
    '        <span class="seg active" data-val="0" id="seg-toggle" title="播放 / 切換循環">▶</span>',
    '        <span class="seg" data-val="2" id="seg-n" title="循環 N 次（點數字可修改）">',
    '          <input id="loop-n-input" type="number" min="1" max="99" value="2" title="循環次數"/>',
    '        </span>',
    '        <span class="seg" data-val="99" title="不停止（無限循環）">∞</span>',
    '      </div>',
    '    </div>',
    '  </div>',
    '</header>',
    '<div id="errbanner"></div>',
    '<div id="dright">',
    '  <div id="target">',
    '    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="60" viewBox="0 0 800 60">',
    '      <text x="300" y="40" font-family="serif" font-size="14" fill="#c2a97a">載入中…</text>',
    '    </svg>',
    '  </div>',
    '</div>',
    '<div id="ctxMenu">',
    '  <ul>',
    '    <li id="cmpt">▶ 整首</li>',
    '    <li id="cmps">▶ 選段</li>',
    '    <li id="cmpc">➔ 繼續</li>',
    '  </ul>',
    '</div>'
  ].join('\n'));

  document.getElementById('errbanner').onclick = function () { this.style.display = 'none'; };
  document.getElementById('cmpt').onclick = function () { play_tune(0); };
  document.getElementById('cmps').onclick = function () { play_tune(1); };
  document.getElementById('cmpc').onclick = function () { play_tune(3); };
}());

// ══════════════════════════════════════════
// 3. 修補 abc2svg.play_next
// ══════════════════════════════════════════
var orig_play_next = abc2svg.play_next;
abc2svg.play_next = function (po) {
  if (po && po.note_run) {
    var _orig = po.note_run;
    po.note_run = function (po2, s, key, t, d) {
      var instr = po2.c_i[po2.v_c[s.v]];
      if (po2.params[instr] && po2.params[instr][key | 0]) _orig(po2, s, key, t, d);
    };
  }
  abc2svg._current_po = po;
  orig_play_next(po);
};

// ══════════════════════════════════════════
// 4. 狀態變數
// ══════════════════════════════════════════
var abcSrc     = document.getElementById('abc-source').textContent,
    abc_images = '',
    syms       = [],
    abc_obj,
    ctxMenu    = document.getElementById('ctxMenu'),
    loopMode   = 0,
    loopCount  = 0,
    selx       = [0, 0],
    selx_sav   = [],
    play = {
      playing:false, stopping:false, stopAt:0,
      si:null, ei:null, repv:0, loop:false,
      abcplay:null, click:null,
      lastNote:0, curNote:0, anchorIdx:0
    };

// ══════════════════════════════════════════
// 5. abc2svg user 物件
// ══════════════════════════════════════════
var user = {
  read_file: function () { return ''; },
  errbld: function (sev, txt) {
    var b = document.getElementById('errbanner');
    b.textContent = sev + ' ' + txt;
    b.style.display = 'block';
  },
  img_out: function (str) { abc_images += str; },
  anno_stop: function (type, start, stop, x, y, w, h, s) {
    if (['beam', 'slur', 'tuplet'].indexOf(type) >= 0) return;
    syms[start] = s;
    abc_obj.out_svg('<rect class="abcr _' + start + '_" x="');
    abc_obj.out_sxsy(x, '" y="', y);
    abc_obj.out_svg('" width="' + w.toFixed(2) + '" height="' + abc_obj.sh(h).toFixed(2) + '"/>\n');
  },
  page_format: true
};

// ══════════════════════════════════════════
// 6. 渲染
// ══════════════════════════════════════════
function waitAndRender() {
  if (typeof abc2svg !== 'object' || !abc2svg.modules) { setTimeout(waitAndRender, 300); return; }
  abc2svg.abc_end = function () {};
  abc2svg.loadjs = function (fn, relay, onerror) {
    var s = document.createElement('script');
    s.src  = /^https?:\/\//.test(fn) ? fn : 'https://cdn.jsdelivr.net/npm/abc2svg@1/' + fn;
    s.type = 'text/javascript';
    if (relay)  s.onload  = relay;
    s.onerror = onerror || function () { console.warn('load error: ' + fn); };
    document.head.appendChild(s);
  };
  doRender();
}

function doRender() {
  if (!abc2svg.modules.load(abcSrc, doRender)) return;
  abc_obj = new abc2svg.Abc(user);
  abc_images = ''; syms = [];
  try { abc_obj.tosvg('player', abcSrc); } catch (e) { console.error(e); return; }
  abc2svg.abc_end();

  var m = abcSrc.match(/^T:[ \t]*(.+)/m);
  if (m) {
    var t = m[1].trim();
    document.getElementById('page-title').textContent = t;
    document.title = t + ' – abc2svg Player';
  }

  var tgt = document.getElementById('target');
  try { tgt.innerHTML = abc_images; } catch (e) { console.error(e); }

  if (!play.abcplay && (window.AudioContext || window.webkitAudioContext)) {
    var ti = setInterval(function () {
      if (typeof AbcPlay === 'function') {
        clearInterval(ti);
        play.abcplay = AbcPlay({ onend: endplay, onnote: notehlight });
        updateStatus();
      }
    }, 100);
  }
  tgt.oncontextmenu = onRightClick;
  tgt.onclick       = onLeftClick;
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
  var tunes = abc_obj && abc_obj.tunes, e;
  if (tunes && tunes.length) while ((e = tunes.shift())) play.abcplay.add(e[0], e[1], e[3]);
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
  var s = syms[si];
  if (!s) return null;
  while (s.ts_prev && !s.seqst) s = s.ts_prev;
  return s;
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
  while (s.ts_next) { s = s.ts_next; if (s.type === C.BAR) break; }
  return next_playable(s);
}

function first_sym() {
  for (var i = 0; i < syms.length; i++) {
    var s = syms[i]; if (!s) continue;
    while (s.ts_prev) s = s.ts_prev;
    return gnrn(s);
  }
}

// ══════════════════════════════════════════
// 8. 點擊事件
// ══════════════════════════════════════════
function onLeftClick(evt) {
  if (ctxMenu.style.display === 'block') { ctxMenu.style.display = 'none'; return; }
  if (play.playing && !play.stopping) {
    play.stopAt   = play.curNote || play.lastNote;
    play.stopping = true;
    play.abcplay.stop();
    return;
  }
  if (!play.abcplay) { alert('音效尚未載入，請稍候再試'); return; }
  addTunes();
  var v = getSymIndex(evt.target), si, ei;
  if (v) {
    // 點到音符：從該音符開始播放
    setsel(0, v); setsel(1, 0);
    play.anchorIdx = v; updateStatus();
    si = get_se(v); ei = null;
    play.si = si; play.ei = ei;
    play.loop = (loopMode !== 0); play.repv = 0; play.stopAt = 0; loopCount = 0;
    playStart(si, ei);
  } else {
    // 點到空白：若有暫停位置則繼續，否則從頭播放
    if (play.stopAt > 0) {
      si = get_se(play.stopAt); ei = play.ei; play.stopAt = 0;
      playStart(si, ei);
    } else {
      si = play.si || first_sym(); ei = play.ei || null;
      if (!si) return;
      play.loop = (loopMode !== 0); play.repv = 0; play.stopAt = 0; loopCount = 0;
      playStart(si, ei);
    }
  }
}

function onRightClick(evt) {
  evt.preventDefault();
  var v = getSymIndex(evt.target);
  if (v) {
    setsel(1, v); updateStatus();
    if (play.playing) {
      var a = play.anchorIdx || selx[0], b = v;
      if (a && b) {
        if (b < a) { var t = a; a = b; b = t; }
        var newSi = get_se(a), newEi = get_ee_by_time(newSi, syms[b]);
        if (abc2svg._current_po) abc2svg._current_po.s_end = newEi;
        play.ei = newEi;
        return;
      }
    }
  }
  play.click = { svg: evt.target };
  showCtxMenu(evt.clientX, evt.clientY);
}

function setEnabled(el, on) {
  el.style.opacity       = on ? '1'  : '0.35';
  el.style.pointerEvents = on ? ''   : 'none';
}

function showCtxMenu(x, y) {
  setEnabled(document.getElementById('cmpt'), !play.playing);
  setEnabled(document.getElementById('cmps'), !play.playing);
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
// 9. 三段式循環開關
// ══════════════════════════════════════════
(function () {
  var btn       = document.getElementById('loopSegBtn'),
      ninput    = document.getElementById('loop-n-input'),
      segToggle = document.getElementById('seg-toggle');

  function refreshToggleLabel() {
    if (play.playing) {
      segToggle.textContent = loopMode === 0 ? '➔' : '⭯';
      segToggle.title       = loopMode === 0 ? '點擊開啟循環' : '點擊關閉循環';
    } else if (play.stopAt > 0) {
      segToggle.textContent = '➔'; segToggle.title = '繼續播放';
    } else {
      segToggle.textContent = '▶'; segToggle.title = '開始播放';
    }
  }
  window._refreshToggleLabel = refreshToggleLabel;

  function setLoopMode(dv) {
    loopMode  = (dv === 2) ? (Number(ninput.value) || 2) : dv;
    play.loop = (loopMode !== 0);
    loopCount = 0;
    btn.querySelectorAll('.seg').forEach(function (s) {
      if (s === segToggle) return;
      s.classList.toggle('active', Number(s.dataset.val) === dv && dv !== 0);
    });
    refreshToggleLabel(); updateStatus();
  }

  btn.addEventListener('click', function (e) {
    var sp = e.target.closest('.seg[data-val]');
    if (!sp) return;
    var dv = Number(sp.dataset.val);

    if (sp === segToggle) {
      if (play.playing) {
        if (loopMode === 0) {
          var activeSeg = btn.querySelector('.seg:not(#seg-toggle).active');
          var newDv     = activeSeg ? Number(activeSeg.dataset.val) : 2;
          loopMode      = newDv === 99 ? 99 : (Number(ninput.value) || 2);
          play.loop     = true;
        } else {
          loopMode = 0; play.loop = false;
        }
        loopCount = 0; refreshToggleLabel(); updateStatus();
      } else if (play.stopAt > 0) {
        if (!play.abcplay) return;
        addTunes();
        var si = get_se(play.stopAt), ei = play.ei;
        play.stopAt = 0; playStart(si, ei);
      } else {
        if (!play.abcplay) return;
        addTunes();
        var si = play.si || first_sym();
        if (!si) return;
        play.si = si; play.repv = 0; play.stopAt = 0; loopCount = 0;
        playStart(si, play.ei);
      }
      return;
    }

    if (e.target === ninput) { if (!sp.classList.contains('active')) setLoopMode(dv); return; }
    setLoopMode(dv);
  });

  ninput.addEventListener('input', function (e) {
    e.stopPropagation();
    var n = Math.max(1, Math.min(99, parseInt(ninput.value) || 1));
    ninput.value = n;
    if (document.getElementById('seg-n').classList.contains('active')) { loopMode = n; updateStatus(); }
  });
  ninput.addEventListener('click',  function (e) { e.stopPropagation(); });
  ninput.addEventListener('focus',  function () {
    if (!document.getElementById('seg-n').classList.contains('active')) setLoopMode(2);
    ninput.select();
  });
  ninput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var n = Math.max(1, Math.min(99, parseInt(ninput.value) || 1));
    ninput.value = n; loopMode = n; play.loop = true; loopCount = 0;
    refreshToggleLabel(); updateStatus(); ninput.blur();
  });
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
function loopLabel() {
  if (loopMode === 0)  return '';
  if (loopMode === 99) return ' ⭯ ∞';
  return ' ⭯ ' + (loopCount + 1) + '/' + (Number(document.getElementById('loop-n-input').value) || loopMode);
}

function updateStatus() {
  var s;
  if (play.playing)         s = '▶ 播放中' + loopLabel() + '… (左鍵停止)';
  else if (play.stopAt > 0) s = '已暫停，左鍵空白處或 ➔ 繼續；右鍵選單可選段';
  else                      s = '左鍵點音符從該處播放，點空白處從上次位置播放；右鍵選段';
  document.getElementById('status').textContent = s;
}

// ══════════════════════════════════════════
// 12. 播放中音符高亮
// ══════════════════════════════════════════
function notehlight(i, on) {
  if (on) { play.lastNote = play.curNote; play.curNote = i; }
  if (play.stopping) { if (on) return; play.stopping = false; return; }
  var elts = document.getElementsByClassName('_' + i + '_');
  if (elts && elts[0]) {
    var isMarker = (i === selx[0] || i === selx_sav[0] || i === selx[1] || i === selx_sav[1]);
    elts[0].style.fillOpacity = on ? 0.4 : (isMarker ? 0.4 : 0);
    if (on) {
      var r = elts[0].getBoundingClientRect();
      if (r.top < 80 || r.bottom > window.innerHeight - 20)
        window.scrollBy(0, r.top - window.innerHeight / 2);
    }
  }
}

// ══════════════════════════════════════════
// 13. 播放結束回呼
// ══════════════════════════════════════════
function endplay(repv) {
  var shouldLoop = false;
  if (!play.stopping && play.stopAt === 0) {
    if (loopMode === 99) {
      shouldLoop = true;
    } else if (loopMode !== 0) {
      var total = Number(document.getElementById('loop-n-input').value) || loopMode;
      if (++loopCount < total) shouldLoop = true;
      else loopCount = 0;
    }
  }
  if (shouldLoop) { updateStatus(); play.abcplay.play(play.si, play.ei); return; }
  play.playing = play.stopping = play.loop = false;
  play.repv = repv; loopCount = 0;
  selx_sav[0] = selx[0]; selx_sav[1] = selx[1];
  play.anchorIdx = selx[0];
  updateStatus();
  if (window._refreshToggleLabel) _refreshToggleLabel();
}

// ══════════════════════════════════════════
// 14. 播放主函式
// ══════════════════════════════════════════
function play_tune(what) {
  ctxMenu.style.display = 'none';
  if (!play.abcplay) { alert('音效尚未載入，請稍候再試'); return; }
  if (play.playing) { if (!play.stopping) { play.stopping = true; play.abcplay.stop(); } return; }
  addTunes();
  var si, ei;

  if (what === 3) {
    if (play.stopAt <= 0) return;
    si = get_se(play.stopAt); ei = play.ei; play.stopAt = 0;
    playStart(si, ei); return;
  }

  play.stopAt = 0;

  if (what === 1) {
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
    var cl = play.click && play.click.svg && play.click.svg.getAttribute && play.click.svg.getAttribute('class');
    si = (cl && cl.substr(0, 4) === 'abcr') ? (gsot(Number(cl.slice(6, -1))) || first_sym()) : first_sym();
    ei = null;
    if (!si) return;
  }

  if (si && ei && si === ei) ei = get_measure_end(syms.indexOf(si));
  play.si = si; play.ei = ei; play.loop = (loopMode !== 0); play.repv = 0; loopCount = 0;
  playStart(si, ei);
}
window.play_tune = play_tune;

function playStart(si, ei) {
  if (!si) return;
  selx_sav[0] = selx[0]; selx_sav[1] = selx[1];
  play.playing = true; play.stopping = false; play.curNote = play.lastNote = 0;
  updateStatus();
  if (window._refreshToggleLabel) _refreshToggleLabel();
  play.abcplay.play(si, ei, play.repv);
}

// ══════════════════════════════════════════
// 15. 啟動
// ══════════════════════════════════════════
window.addEventListener('load', waitAndRender);

}());
