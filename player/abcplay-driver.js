/**
 * abcplay-driver.js – abc2svg 播放驅動層
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
 *
 * ──────────────────────────────────────────────────────────────────────
 *
 * 職責：
 *   播放狀態機、符號索引（syms）、播放控制（pause / resume / stop）、
 *   選段邏輯（A/B 點）、音符高亮中介（notehlight）、速度 / 循環管理。
 *
 *   本模組是後端無關的驅動層：具體播放後端（AbcPlay / snd-1.js 或其他）
 *   透過 setBackend() 注入，Driver 不直接引用 AbcPlay 的建構子或 config key。
 *
 * 公開 API（後端無關語意）：
 *
 *   初始化與後端注入
 *   ─────────────────
 *   AbcplayDriver.init(cfg)
 *     注入 UIController 引用與播放常數（CFG）。必須在 setBackend() 之前呼叫。
 *     cfg 欄位：{ uiController, CFG }
 *
 *   AbcplayDriver.setBackend(backendInstance)
 *     注入具體播放後端實例。後端須實作：
 *       backend.add(first, last, cfmt)
 *       backend.play(si, ei, repv)
 *       backend.stop()
 *       backend.set_speed(v)
 *     由 loader.js 在 AbcPlay 可用後呼叫（setInterval 或 onload）。
 *
 *   符號索引（渲染階段）
 *   ──────────────────────
 *   AbcplayDriver.registerSymbol(istart, sym)
 *     登記一個可播放符號（由 loader.js anno_stop 呼叫）。
 *
 *   AbcplayDriver.onRenderStart()
 *     渲染即將開始，重置符號索引與 JumpEngine（由 loader.js doRender 呼叫）。
 *
 *   播放命令集（供 UIController 使用）
 *   ─────────────────────────────────
 *   AbcplayDriver.getCommands()
 *     回傳播放命令物件 { pause, resume, play, stop, seekTo, setSpeed,
 *                       getSe, getPlaySi, getMeasureEnd, getEeByTime,
 *                       getSymbol, setCurrentPoEnd, setPlayEi }
 *     loader.js §13 組裝時填入 play.api.*，UIController 透過 play.api.* 呼叫。
 *
 *   狀態上下文（供 UIController 使用）
 *   ─────────────────────────────────
 *   AbcplayDriver.getContext(CFG)
 *     回傳給 UIController.init 用的 cfg 物件（含 getState / getLoopMode 等存取器）。
 *     CFG 由 loader.js 傳入（UI 圖示 / 速度範圍常數）。
 *
 *   UI 回調注入（Player → UI）
 *   ──────────────────────────
 *   AbcplayDriver.setUICallbacks(callbacks)
 *     注入 UI 事件監聽器，Driver 自行填入 play.on*。
 *     callbacks: { onStateChange, onNoteHighlight, onClearHighlight, onPauseHighlight }
 *
 * 依賴（全域）：
 *   abc2svg        – symbol 結構、abc2svg.C 常數、abc2svg._current_po
 *   JumpEngine     – resetAllContexts / buildContextForTune / suspendPlayback /
 *                    resumePlayback（jump-engine.js）
 *   UIController   – setsel（ui-controller.js，透過 init cfg 注入）
 *
 * HTML 載入順序：
 *   <script src="abc2svg-1.js"></script>
 *   <script src="snd-1.js"></script>
 *   <script src="jump-engine.js"></script>
 *   <script src="hook-bridge.js"></script>
 *   <script src="abcplay-driver.js"></script>   ← 必須在 ui-controller.js 之前
 *   <script src="ui-controller.js"></script>
 *   <script src="loader.js"></script>
 */

;(function (root) {
  'use strict';


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
   *   PLAYING  (1) - 正在播放音樂，後端運行中
   *   PAUSED   (2) - 已暫停，AudioContext suspended，但保留播放進度
   *   STOPPING (3) - 停止中（過渡狀態），等待 onPlaybackEnd 回調完成清理
   *
   * 合法轉換：
   *   IDLE     → PLAYING   (playStart)
   *   PLAYING  → PAUSED    (pausePlay)
   *   PLAYING  → STOPPING  (stopPlay)
   *   PAUSED   → PLAYING   (resumePlay)
   *   PAUSED   → STOPPING  (stopPlay)
   *   STOPPING → IDLE      (onPlaybackEnd)
   *   PLAYING  → IDLE      (onPlaybackEnd, 自然結束)
   */
  var PlayState = {
    IDLE:     0,  // 閒置
    PLAYING:  1,  // 播放中
    PAUSED:   2,  // 已暫停
    STOPPING: 3   // 停止中
  };

  var PlayStateName = ['IDLE', 'PLAYING', 'PAUSED', 'STOPPING'];

  // ══════════════════════════════════════════
  // 模組私有狀態
  // ══════════════════════════════════════════

  var _uiController = null;   // init() 注入的 UIController 引用
  var _backend      = null;   // setBackend() 注入的播放後端實例

  // ── 符號索引（渲染階段由 anno_stop 填入）──────────────────────────
  // syms[istart] = symbol 物件；稀疏陣列，索引為 ABC 原始碼字元位置
  var syms = [];

  // ── 播放狀態（核心物件）──────────────────────────────────────────
  var loopMode     = 0;                 // 0 = 無循環，非 0 = 無限循環
  var loopCount    = 0;                 // 本次播放已循環次數
  var selx         = [0, 0];           // [A點 istart, B點 istart]（0 表示未設）
  var selx_sav     = [];               // play_tune 時快照，供 onPlaybackEnd 還原
  var currentSpeed = 1.0;              // 當前播放速度倍率（init 後由 CFG.SPEED_DEFAULT 覆寫）

  var play = {
    state:   PlayState.IDLE,
    si:      null,    // 起播 symbol
    ei:      null,    // 終播 symbol（null = 播到曲尾）
    repv:    0,       // 重播參數（傳給 backend.play 的第三引數）
    lastNote: 0,      // 最後亮起的音符 istart（pause 補亮用）
    curNotes: new Set(),  // 目前亮起的所有音符 istart（多聲部）
    _pausedPo:   null,  // pausePlay 時凍結的 po 物件，resumePlay 用
    _resumeGen:  0,     // 世代號，防止快速 pause/resume race condition
    _nextContAt: null,  // play_cont 下一次絕對觸發時間（pause 快照）
    _pausedOnnotes: [], // pause 時存下的 onnote on/off 列表（resume 重排用）

    // ── Player → UI callbacks（由 setUICallbacks() 填入）────────────
    // 預設空函式，確保未初始化時不爆錯。
    onStateChange:    function () {},
    onNoteHighlight:  function (i, on) {},
    onClearHighlight: function () {},
    onPauseHighlight: function (i) {}
  };

  // ══════════════════════════════════════════
  // 狀態機輔助函式（私有）
  // ══════════════════════════════════════════

  /**
   * setState(newState, reason) - 狀態轉換（帶日誌與合法性檢查）
   *
   * @param {number} newState
   * @param {string} [reason] - 轉換原因（調試用）
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
   * isState(state) - 狀態檢查（提升可讀性）
   * @param {number} state
   * @returns {boolean}
   */
  function isState(state) {
    return play.state === state;
  }

  /**
   * isActivePlayback() - 是否處於活躍播放週期（PLAYING 或 PAUSED）
   * @returns {boolean}
   */
  function isActivePlayback() {
    return play.state === PlayState.PLAYING || play.state === PlayState.PAUSED;
  }

  // ══════════════════════════════════════════
  // 工具函式（私有）
  // ══════════════════════════════════════════

  /**
   * addTunes() - 將 abc2svg 解析出的曲子登記到後端並建立 JumpEngine 上下文
   *
   * 在 play_tune() 的 IDLE 路徑呼叫（每次起播前）。
   * abc2svg.abc.tunes 在 tosvg() 後填入，此函式消耗（shift）整個 tunes 陣列。
   */
  function addTunes() {
    var tunes = abc2svg.abc && abc2svg.abc.tunes, e;
    if (tunes && tunes.length) {
      while ((e = tunes.shift())) {
        var tuneFirst = e[0];
        _backend.add(tuneFirst, e[1], e[3]);
        JumpEngine.buildContextForTune(tuneFirst);
      }
    }
  }

  /**
   * gnrn(s) - 從 s 開始，找第一個有 p_v 且為可播類型的 symbol
   * 可播類型：NOTE / REST / GRACE / BLOCK(midictl|midiprog)
   */
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

  /**
   * gsot(si) - 取 si 對應 symbol 所在聲部的序列起點，再找第一個可播 sym
   * 用途：「無 A 點但有 B 點」時，從 B 點所在序列開頭起播。
   */
  function gsot(si) {
    var s = syms[si];
    if (!s) return null;
    var root = (s.p_v && s.p_v.sym) ? s.p_v.sym : s;
    return gnrn(root) || (root !== s ? gnrn(s) : null);
  }

  /**
   * get_se(si) - 取 si 對應的 symbol（起播點）
   * @returns {symbol|null}
   */
  function get_se(si) {
    return syms[si] || null;
  }

  /**
   * next_playable(s) - 從 s.ts_next 起找第一個可播 sym（NOTE/REST/GRACE）
   * @returns {symbol|null}
   */
  function next_playable(s) {
    var C = abc2svg.C;
    s = s.ts_next;
    while (s) { switch (s.type) { case C.NOTE: case C.REST: case C.GRACE: return s; } s = s.ts_next; }
    return null;
  }

  /** get_ee(si) - 取 si 的下一個可播 sym（終播點） */
  function get_ee(si) { var s = syms[si]; return s ? next_playable(s) : null; }

  /**
   * get_ee_by_time(si_sym, b_sym) - 找 si_sym 之後、time ≤ b_sym.time 的最後 sym，
   * 再取其 next_playable（選段終點）。
   */
  function get_ee_by_time(si_sym, b_sym) {
    if (!si_sym || !b_sym) return null;
    var s = si_sym;
    while (s.ts_next && s.ts_next.time <= b_sym.time) s = s.ts_next;
    return next_playable(s);
  }

  /**
   * get_measure_end(si) - 取 si 對應音符所在小節的終點（下一小節起點前的可播 sym）
   * 用途：A === B 時，播放單一小節。
   */
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

  /** first_sym() - 取 syms 中第一個非空 symbol（曲首起播點） */
  function first_sym() {
    for (var i = 0; i < syms.length; i++) {
      if (syms[i]) return syms[i];
    }
  }

  /**
   * clearOnnoteTimouts(po) - 清除 po._onnoteTimouts 內所有待觸發的 setTimeout。
   *
   * Audio5.stop() 原版只清 po.timouts，_onnoteTimouts 需自行清除。
   * 注意：pausePlay 不使用此函式，因為它需要將 entry 轉存到
   *       play._pausedOnnotes 供 resumePlay 重排，語意不同。
   */
  function clearOnnoteTimouts(po) {
    if (!po || !po._onnoteTimouts) return;
    po._onnoteTimouts.forEach(function(e) { clearTimeout(e.id); });
    po._onnoteTimouts = [];
  }

  // ══════════════════════════════════════════
  // 選取高亮（setsel）
  // ══════════════════════════════════════════

  /**
   * setsel(idx, v) - 設定 selx[idx] = v，並委派 UIController 更新 DOM 高亮
   *
   * selx 保留在 Driver（Player 側），原因：
   *   notehlight 的 B-overshoot 偵測需要直接讀取 selx[1]，跨模組呼叫會增加延遲。
   *   UIController.setsel 透過 cfg.getSelx() 取得 selx 引用後直接寫入。
   */
  function setsel(idx, v) {
    _uiController.setsel(idx, v);
  }

  // ══════════════════════════════════════════
  // 音符高亮中介（notehlight）
  // ══════════════════════════════════════════

  /**
   * notehlight(i, on) - 音符亮/暗的中介層（由後端的 onnote callback 觸發）
   *
   * 三項職責（均需讀取 Driver 私有狀態，不適合放在 UIController）：
   *   1. pause-guard：paused 中 on 回呼已在 task queue 排隊清不掉，在此攔截
   *   2. B-overshoot：音符 istart 超過 B 點時立即停播重播
   *   3. curNotes 維護：多聲部計數
   *
   * DOM 操作委派給 UIController（play.onNoteHighlight 由 setUICallbacks 填入）。
   */
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

    // DOM 高亮操作委派給 UIController
    play.onNoteHighlight(i, on);

    // ── [ball:on-note] ────────────────────────────────────────────
    // on=true 時通知 BallController 落地並起飛向 next 音符。
    // onPlayStart（drop_wait 排程）已在 hook-bridge play_cont 排程階段呼叫，
    // 此處只需觸發落地動作。
    // isAtB：當前音符正好是 B 點（選段終點），球應原地跳躍，不飛向 next。
    if (on && root.BallController) {
      var isAtB = !!(selx[1] && i === selx[1]);
      root.BallController.onNoteOn(i, isAtB);
    }
    // ── [ball:on-note] end ────────────────────────────────────────
  }

  // ══════════════════════════════════════════
  // 播放控制
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
    var nowAc = ac.currentTime;  // eslint-disable-line no-unused-vars

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
    play.onClearHighlight();
    if (play.lastNote) play.onPauseHighlight(play.lastNote);

    // 保存 anchor 跳轉狀態快照，確保 resume 後跳轉邏輯可完整還原
    JumpEngine.suspendPlayback(po.s_cur);

    // ── [狀態機] 狀態轉換：PLAYING → PAUSED ──
    setState(PlayState.PAUSED, 'pausePlay');
    play._pausedPo = po;
    play.onStateChange();

    // ── [ball:pause] ──────────────────────────────────────────────
    if (root.BallController) root.BallController.onPause();
    // ── [ball:pause] end ──────────────────────────────────────────
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
    play.onClearHighlight();

    ac.resume().then(function() {
      // ── [優化4] 世代號不符：then() 執行前已再次 pause，放棄本次 resume ──
      if (play._resumeGen !== myGen) return;

      // ── [狀態機] 狀態轉換：PAUSED → PLAYING ──
      // 恢復 anchor 跳轉狀態快照（對應 pausePlay 的 suspendPlayback）
      JumpEngine.resumePlayback(po.s_cur);
      setState(PlayState.PLAYING, 'resumePlay.then');
      play.onStateChange();

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

      // ── [ball:resume] ─────────────────────────────────────────
      if (root.BallController) root.BallController.onResume();
      // ── [ball:resume] end ─────────────────────────────────────

      play.onStateChange();
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
        po.ac.resume().then(function() { _backend.stop(); });
        setState(PlayState.STOPPING, 'stopPlay from PAUSED');
        return;
      }
    }

    // ── [狀態機] 狀態轉換：PLAYING / PAUSED → STOPPING ──
    setState(PlayState.STOPPING, 'stopPlay');
    _backend.stop();
  }

  /**
   * onPlaybackEnd(repv) - 播放結束回調（由後端觸發，對應 AbcPlay 的 onend）
   *
   * 狀態轉換：
   *   - STOPPING → IDLE（用戶主動停止）
   *   - PLAYING  → IDLE（自然結束）或 → PLAYING（循環重播）
   */
  function onPlaybackEnd(repv) {
    // ── [狀態機] paused 狀態下 onend 不應觸發 ──
    if (isState(PlayState.PAUSED)) return;

    // ── [狀態機] PLAYING 狀態：自然結束，檢查循環 ──
    if (isState(PlayState.PLAYING)) {
      // 循環模式：直接重播（loopMode !== 0 即啟用，無次數上限）
      if (loopMode !== 0) {
        ++loopCount;
        play.onStateChange();
        playStart(play.si, play.ei);
        return;  // 保持 PLAYING 狀態
      }
      loopCount = 0;  // 自然結束才重置計數
    }

    // ── [狀態機] STOPPING 狀態：用戶主動停止，不重置 loopCount ──
    // （原版 line 1745: if (!play.stopping) loopCount = 0;）
    // 意即：主動停止保留計數，自然結束才重置

    // ── [狀態機] 狀態轉換：PLAYING / STOPPING → IDLE ──
    setState(PlayState.IDLE, 'onPlaybackEnd');

    // ── [ball:play-end] ───────────────────────────────────────────
    if (root.BallController) root.BallController.onPlayEnd();
    // ── [ball:play-end] end ───────────────────────────────────────

    play.repv = repv;
    selx_sav[0] = selx[0]; selx_sav[1] = selx[1];
    play.onStateChange();
  }

  // ══════════════════════════════════════════
  // 播放主函式
  // ══════════════════════════════════════════

  /**
   * seekTo(v) - 使用者點選音符後的統一入口
   *
   * 職責：
   *   1. 設定 A 點（selx[0] = v）
   *   2. B 點保留判斷：v < selx[1] 時保留 B 點，否則清除
   *   3. 處理 paused 狀態的非同步起播序列
   *   4. 呼叫 play_tune()
   *
   * paused 路徑說明：
   *   必須按照 ac.resume() → stop() → play_tune() 的順序。
   *   不能直接呼叫 stopPlay()：stopPlay 的 paused 路徑是
   *   resume().then(stop)，play_tune() 若在 then() 外執行，
   *   ac 仍 suspended，第一次 click 無聲。
   */
  function seekTo(v) {
    // ── B 點保留判斷（在任何狀態切換前先決定） ────────────────────
    var keepB = selx[1] && v < selx[1];
    setsel(0, v);
    if (!keepB) setsel(1, 0);
    // play.si 提前更新：即使 play_tune 因後端未載入而提早 return，
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
        _backend.stop();  // 同步：清 gain，觸發 onPlaybackEnd
        // onPlaybackEnd 已同步執行：play.state=IDLE
        play_tune();
      });
      return;
    }

    // ── [狀態機] idle 狀態：直接起播 ──────────────────────────────
    play_tune();
  }

  /**
   * play_tune() - 播放主函式
   *
   * 統一由 selx[0]（A點）/ selx[1]（B點）推算 si / ei：
   *
   *   si：有 A點 → get_se(selx[0])
   *       無 A點 → play.si || first_sym()（從上次位置或曲首）
   *
   *   ei：有 A點 且 有 B點 且 A < B → get_ee_by_time()（選段）
   *       A === B                   → get_measure_end()（單小節）
   *       B < A                     → swap 後同上（對調保護）
   *       無 A點，僅有 B點           → gsot(b) 起播到 get_ee(b)
   *       否則                      → null（播到結尾）
   *
   *   呼叫方只需設好 selx（透過 seekTo 或直接操作），不再傳 what 參數。
   */
  function play_tune() {
    if (!_backend) { alert('音效尚未載入，請稍候再試'); return; }

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

  /**
   * playStart(si, ei) - 開始播放
   *
   * 狀態轉換：IDLE → PLAYING
   */
  function playStart(si, ei) {
    if (!si) return;
    // 新播放開始時，確保清除任何殘留的 paused 狀態（_pausedPo = null 表示 not paused）
    play._pausedPo = null;
    // resume 時 anchor 狀態存在 sym 節點上，stop 後仍存活，不需要 reset jumpCtx
    JumpEngine.resetAllContexts();

    // ── [GEN] 遞增播放世代號 ──────────────────────────────────────
    // 通知 HookBridge 進入新世代，讓上一輪播放殘存的 play_cont 排程
    // 在下次觸發時自動識別並靜默退出，不干擾新播放。
    if (root.HookBridge) root.HookBridge.newGeneration();
    // ── [GEN] end ─────────────────────────────────────────────────

    // ── [狀態機] 狀態轉換：IDLE → PLAYING ──
    setState(PlayState.PLAYING, 'playStart');
    play.onStateChange();

    _backend.play(si, ei, play.repv);
  }

  // ══════════════════════════════════════════
  // 公開 API
  // ══════════════════════════════════════════

  var AbcplayDriver = {

    // ── 狀態枚舉（供 loader.js 組裝時傳給 UIController）────────────
    PlayState: PlayState,

    /**
     * init(cfg) - 初始化 Driver
     *
     * 注入 UIController 引用與播放常數。必須在 setBackend() 之前呼叫。
     *
     * @param {object} cfg
     *   cfg.uiController {object}  – UIController 引用（setsel 委派用）
     *   cfg.CFG          {object}  – 播放常數（SPEED_DEFAULT 等）
     */
    init: function (cfg) {
      _uiController = cfg.uiController;
      currentSpeed  = cfg.CFG.SPEED_DEFAULT;
      // window 暴露（保留向下相容，外部頁面可能直接呼叫 play_tune()）
      window.play_tune = play_tune;
    },

    /**
     * setBackend(backendInstance) - 注入具體播放後端
     *
     * 後端須實作：
     *   backend.add(first, last, cfmt)
     *   backend.play(si, ei, repv)
     *   backend.stop()
     *   backend.set_speed(v)
     *
     * 由 loader.js 在後端可用後呼叫（setInterval / onload）。
     * 換後端時可再次呼叫（例如從 AbcPlay 切換到 MIDI 後端）。
     *
     * @param {object} backendInstance
     */
    setBackend: function (backendInstance) {
      _backend = backendInstance;
    },

    /**
     * registerSymbol(istart, sym) - 登記一個可播放符號
     *
     * 由 loader.js anno_stop 在渲染階段呼叫（對應原本的 syms[start] = s）。
     *
     * @param {number} istart  – ABC 原始碼字元位置（即 SVG rect class `_N_` 中的 N）
     * @param {symbol} sym     – abc2svg symbol 物件
     */
    registerSymbol: function (istart, sym) {
      syms[istart] = sym;
    },

    /**
     * onRenderStart() - 渲染即將開始，重置符號索引與 JumpEngine
     *
     * 由 loader.js doRender() 呼叫（對應原本的 syms = []; JumpEngine.reset()）。
     */
    onRenderStart: function () {
      syms = [];
      JumpEngine.reset();
    },

    /**
     * getCommands() - 取得播放命令集
     *
     * 回傳給 loader.js §13 組裝，填入 play.api.*，
     * UIController 透過 play.api.* 呼叫，不直接引用 Driver 內部函式。
     *
     * @returns {object} 播放命令物件
     */
    getCommands: function () {
      return {
        pause:    function ()        { pausePlay(); },
        resume:   function ()        { resumePlay(); },
        play:     function ()        { play_tune(); },
        stop:     function ()        { stopPlay(); },
        seekTo:   function (v)       { seekTo(v); },
        setSpeed: function (v) {
          currentSpeed = v;
          if (_backend) _backend.set_speed(v);
        },
        // ── 供 UIController.onRightClick 計算新 ei 用的查詢函式 ──
        getSe:          function (v)       { return get_se(v); },
        getPlaySi:      function ()        { return play.si; },
        getMeasureEnd:  function (v)       { return get_measure_end(v); },
        getEeByTime:    function (si, sym) { return get_ee_by_time(si, sym); },
        getSymbol:      function (v)       { return syms[v]; },
        setCurrentPoEnd:function (ei) {
          if (abc2svg._current_po) abc2svg._current_po.s_end = ei;
        },
        setPlayEi:      function (ei) { play.ei = ei; }
      };
    },

    /**
     * getContext(CFG) - 取得給 UIController.init 用的狀態上下文
     *
     * 回傳含 getState / getLoopMode / setLoopMode 等存取器的 cfg 物件，
     * UIController 透過這些存取器讀寫 Driver 的私有狀態，不直接引用變數名稱。
     *
     * @param {object} CFG – 播放常數（ICON_*、SPEED_* 等，由 loader.js 傳入）
     * @returns {object}
     */
    getContext: function (CFG) {
      return {
        getState:     function ()  { return play.state; },
        getLoopMode:  function ()  { return loopMode; },
        setLoopMode:  function (v) { loopMode = v; },
        getLoopCount: function ()  { return loopCount; },
        setLoopCount: function (v) { loopCount = v; },
        getSelx:      function ()  { return selx; },       // 回傳陣列引用，setsel 可直接寫入
        getSelxSav:   function ()  { return selx_sav; },
        getSpeed:     function ()  { return currentSpeed; },
        getCurNotes:  function ()  { return play.curNotes; },
        clearCurNotes:function ()  { play.curNotes = new Set(); },
        PlayState:    PlayState,
        CFG:          CFG
      };
    },

    /**
     * setUICallbacks(callbacks) - 注入 UI 事件監聽器（Player → UI）
     *
     * Driver 自行填入 play.on*，loader.js §13 不需要知道 play 物件的存在。
     *
     * @param {object} callbacks
     *   callbacks.onStateChange    {function}        – PlayState 變化後更新 UI
     *   callbacks.onNoteHighlight  {function(i, on)} – 音符亮/暗
     *   callbacks.onClearHighlight {function}        – 清除全部高亮
     *   callbacks.onPauseHighlight {function(i)}     – pause 時補亮最後音符
     */
    setUICallbacks: function (callbacks) {
      if (callbacks.onStateChange)    play.onStateChange    = callbacks.onStateChange;
      if (callbacks.onNoteHighlight)  play.onNoteHighlight  = callbacks.onNoteHighlight;
      if (callbacks.onClearHighlight) play.onClearHighlight = callbacks.onClearHighlight;
      if (callbacks.onPauseHighlight) play.onPauseHighlight = callbacks.onPauseHighlight;
    },

    // ── 後端橋接點（供 loader.js setBackend 注入時使用）────────────
    //
    // 命名使用通用語意（onPlaybackEnd / onNoteActivate），
    // 不綁死 AbcPlay 的 config key 名稱（onend / onnote）。
    // loader.js 負責將這兩個函式對應到後端實際要求的 config key：
    //
    //   AbcPlay({ onend: AbcplayDriver._onPlaybackEnd,
    //             onnote: AbcplayDriver._onNoteActivate })
    //
    // 若換用其他後端，只需在 loader.js 的 setBackend 段調整 key 名稱，
    // Driver 本體不需要修改。
    //
    _onPlaybackEnd:  onPlaybackEnd,   // 播放自然結束 / 主動停止後的結束回調
    _onNoteActivate: notehlight       // 音符亮/暗回調（中介層，含 pause-guard / B-overshoot）
  };

  // ── 掛載到全域 ────────────────────────────────────────────────────
  root.AbcplayDriver = AbcplayDriver;

}(typeof globalThis !== 'undefined' ? globalThis : this));
