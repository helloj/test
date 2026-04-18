/**
 * state-manager.js – AB Loop 中心狀態管理
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
 * ──────────────────────────────────────────────────────────────────────
 *
 * 職責：
 *   AB Loop 功能的唯一狀態真值源（Single Source of Truth）。
 *   各模組（PassageMarkPackage / UIController / AbcplayDriver）
 *   透過本模組的 API 讀寫狀態，不直接互相依賴。
 *
 * 狀態結構：
 *   passage  – 記錄一次播放會話中的音符序列（Pause 時保存，Resume/Stop 時清除）
 *   selection – A/B 點（istart）選段，0 表示未設
 *   playback  – 循環模式與循環計數
 *
 * 公開 API：
 *   getState()                       – 取得完整狀態快照（唯讀引用）
 *   setPassage(start, end, notes)    – 記錄播放會話（onPause 時呼叫）
 *   getPassageSpan()                 – 取得 passage 的起終點（UIController 用）
 *   setSelection(a, b)               – 同時設 A 和 B（Loop OFF→AB / Back 重置）
 *   setSelectionA(a)                 – 只設 A 點（seekTo / Back）
 *   setSelectionB(b)                 – 只設 B 點（右鍵 / Loop AB→OFF）
 *   setLoopMode(mode)                – 設循環模式（0=OFF, 非0=ON）
 *   setLoopCount(count)              – 設循環計數（onPlaybackEnd 遞增）
 *   clear()                          – 清除 passage（onResume / onStop 時呼叫）
 *
 * 載入順序：
 *   必須在 abcplay-driver.js 和 ui-controller.js 之前載入。
 *
 *   <script src="state-manager.js"></script>   ← 最先
 *   <script src="abcplay-driver.js"></script>
 *   <script src="ui-controller.js"></script>
 *   <script src="loader.js"></script>
 */

;(function (root) {
  'use strict';

  var StateManager = (function () {

    // ── 核心狀態物件 ──────────────────────────────────────────────────
    var state = {
      // passage：記錄一次播放會話中的音符序列
      //   startIstart – 第一個音符的 istart（0 表示無記錄）
      //   endIstart   – 最後一個音符的 istart
      //   notes       – istart 陣列（完整序列，供未來擴充用）
      passage: {
        startIstart: 0,
        endIstart:   0,
        notes:       []
      },

      // selection：A/B 點（0 表示未設）
      //   A – 起播點 istart（seekTo / Loop OFF→AB / Back 設定）
      //   B – 終播點 istart（右鍵 / Loop OFF→AB 設定，0 表示播到曲尾）
      selection: {
        A: 0,
        B: 0
      },

      // lastNote：最後一個亮起的音符 istart（播放中由 Driver 持續更新）
      lastNote: 0,

      // playback：循環控制
      //   loopMode  – 0 = OFF；非 0（LOOP_INFINITE=99）= 無限循環
      //   loopCount – 本次播放已循環次數（每次自然結束後遞增）
      playback: {
        loopMode:  0,
        loopCount: 0
      }
    };

    // ── 公開 API ──────────────────────────────────────────────────────
    return {

      /**
       * getState() - 取得完整狀態（唯讀引用，請勿直接修改）
       * @returns {object}
       */
      getState: function () {
        return state;
      },

      /**
       * setPassage(start, end, notes) - 記錄播放會話
       *
       * 由 PassageMarkPackage.onPause() 呼叫，保存本次播放走過的範圍。
       *
       * @param {number}   start – 第一個音符的 istart
       * @param {number}   end   – 最後一個音符的 istart
       * @param {number[]} notes – istart 陣列副本（slice()）
       */
      setPassage: function (start, end, notes) {
        state.passage.startIstart = start || 0;
        state.passage.endIstart   = end   || 0;
        state.passage.notes       = notes ? notes.slice() : [];
      },

      /**
       * getPassageSpan() - 取得 passage 的起終點
       *
       * 供 UIController Loop 按鈕 / Back 按鈕讀取 passage 範圍。
       * 無 passage 時（startIstart === 0）回傳 null。
       *
       * @returns {{ startIstart: number, endIstart: number }|null}
       */
      getPassageSpan: function () {
        if (!state.passage.startIstart) return null;
        return {
          startIstart: state.passage.startIstart,
          endIstart:   state.passage.endIstart
        };
      },

      /**
       * setSelection(a, b) - 同時設 A 和 B 點
       *
       * 用途：Loop OFF→AB（自動設 A=passage.start, B=passage.end）
       *       Back 按鈕在 AB 模式下（同時重置 A 和 B）
       *
       * @param {number} a – A 點 istart（0 = 清除）
       * @param {number} b – B 點 istart（0 = 清除）
       */
      setSelection: function (a, b) {
        state.selection.A = a || 0;
        state.selection.B = b || 0;
      },

      /**
       * setSelectionA(a) - 只設 A 點，保留 B 點
       *
       * 用途：seekTo（左鍵點音符）、Back 按鈕的 A 點重置
       *
       * @param {number} a – A 點 istart（0 = 清除）
       */
      setSelectionA: function (a) {
        state.selection.A = a || 0;
      },

      /**
       * setSelectionB(b) - 只設 B 點，保留 A 點
       *
       * 用途：右鍵設新 B 點、Loop AB→OFF 清除 B 點
       *
       * @param {number} b – B 點 istart（0 = 清除）
       */
      setSelectionB: function (b) {
        state.selection.B = b || 0;
      },

      /**
       * setLoopMode(mode) - 設循環模式
       *
       * @param {number} mode – 0 = OFF；CFG.LOOP_INFINITE（99）= ON
       */
      setLoopMode: function (mode) {
        state.playback.loopMode = mode || 0;
      },

      /**
       * setLoopCount(count) - 設循環計數
       *
       * 由 onPlaybackEnd 在每次循環結束後呼叫（+1）。
       * Loop OFF→AB 或 B 點變更時由 UIController 歸零。
       *
       * @param {number} count
       */
      setLoopCount: function (count) {
        state.playback.loopCount = count || 0;
      },

      /**
       * clear() - 清除 passage 記錄
       *
       * 由 PassageMarkPackage.onResume() 和 onStop() 呼叫。
       * 只清 passage，不動 selection 和 playback（設計原則：Resume 保留狀態）。
       */
      /**
       * setLastNote(i) - 記錄最後一個亮起的音符 istart
       *
       * 由 Driver pipe_curNotesOn 在每個音符 on 時呼叫。
       * disableLoopAB 讀取作為新 A 點。
       *
       * @param {number} i – symbol istart（0 表示無）
       */
      setLastNote: function (i) {
        state.lastNote = i || 0;
      },

      clear: function () {
        state.passage.startIstart = 0;
        state.passage.endIstart   = 0;
        state.passage.notes       = [];
      }
    };

  }());

  // ── 掛載到全域 ────────────────────────────────────────────────────
  root.StateManager = StateManager;

}(typeof globalThis !== 'undefined' ? globalThis : this));
