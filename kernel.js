// scavenge.ar - © 2026 octantes.ar - SPDX-License-Identifier: Apache-2.0

(function () { // bookmarklet microkernel - privileged core with every tool registered as userland process
  if (window.$kernel) { // destroy existing instance on re-execution - makes bookmarklet act as a toggle
    if (window.$kernel.destroy) window.$kernel.destroy();
    return;
  }

  const theme = { // matches patchbay and compiler theme - enforced by token tests
    backgroundSunk: '#1A1C1C',
    output:         '#986C98',
    input:          '#8AB6BB',
    textBase:       '#AAABAC',
    danger:         '#985954',
    success:        '#6FAC67',
    border:         'rgba(170, 171, 172, 0.25)',
    fontMono:       "'SF Mono', 'Consolas', 'Menlo', 'DejaVu Sans Mono', monospace"
  };

  const IDS = { // element ids
    sysStyles:     'scv-sys-styles',
    masterWrapper: 'scv-master-wrapper',
    sharedOv:      'scv-shared-ov',
    sharedLbl:     'scv-shared-lbl',
    notify:        'scv-notify',
    capOv:         'scv-cap-ov',
    capBox:        'scv-cap-box',
    recUi:         'scv-rec-ui',
    xray:          'scv-xray',
    wirePanel:     'scv-wire-panel',
  };

  // INJECTED UI STYLES - theme interpolates once into namespaced custom properties

  const EXT_UI_CSS = `
    :root {
      --scv-background-sunk: ${theme.backgroundSunk};
      --scv-output:          ${theme.output};
      --scv-input:           ${theme.input};
      --scv-text-base:       ${theme.textBase};
      --scv-danger:          ${theme.danger};
      --scv-success:         ${theme.success};
      --scv-border:          ${theme.border};
      --scv-font-mono:       ${theme.fontMono};
      --scv-output-15:       ${theme.output}26;
      --scv-output-31:       ${theme.output}50;
      --scv-output-40:       ${theme.output}66;
      --scv-input-25:        ${theme.input}40;
      --scv-input-31:        ${theme.input}50;
      --scv-input-40:        ${theme.input}66;
      --scv-danger-40:       ${theme.danger}66;
    }
    #${IDS.masterWrapper} { position: fixed; top: 50%; left: 50%; transform: translate3d(-50%,-50%,0); z-index: 2147483647; display: flex; gap: 15px; align-items: stretch; pointer-events: auto; width: max-content; height: auto; user-select: none; -webkit-user-select: none; }
    #${IDS.masterWrapper} *::-webkit-scrollbar { display: none; }
    #${IDS.masterWrapper} * { scrollbar-width: none; }
    .scv-palette { background: var(--scv-background-sunk); border-radius: 5px; padding: 6px; min-width: 320px; max-width: 80vw; max-height: 70vh; display: flex; flex-direction: column; box-shadow: 0 0 24px rgba(0,0,0,0.55); font-family: var(--scv-font-mono); color: var(--scv-text-base); pointer-events: auto; }
    .scv-palette-input { width: 100%; box-sizing: border-box; margin: 0 0 6px; padding: 9px 10px; background: rgba(255,255,255,0.05); color: var(--scv-input); border: none; border-radius: 5px; font-family: inherit; font-size: 13px; outline: none; -webkit-user-select: text; user-select: text; }
    #${IDS.masterWrapper} :is(input, textarea, select, button):focus, #${IDS.masterWrapper} :is(input, textarea, select, button):focus-visible { outline: none !important; box-shadow: none !important; }
    .scv-palette-list { overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
    .scv-cmd { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 5px; cursor: pointer; font-size: 12px; white-space: nowrap; transition: background 0.15s, transform 0.15s cubic-bezier(.25,.75,.45,1); }
    .scv-cmd.scv-sel { background: rgba(255,255,255,0.10); }
    .scv-cmd-lbl { flex-grow: 1; color: var(--scv-text-base); padding-right: 16px; }
    .scv-cmd.scv-on .scv-cmd-lbl { color: var(--scv-input); }
    .scv-cmd-hint { color: var(--scv-text-base); opacity: 0.4; font-size: 10px; flex-shrink: 0; }
    .scv-cmd-empty { padding: 10px; opacity: 0.5; font-size: 12px; }
    .scv-pal-bar { display: flex; gap: 1px; flex-shrink: 0; margin-top: 6px; }
    .scv-pal-bar .scv-cmd { flex: 1 1 0; justify-content: center; }
    .scv-pal-bar .scv-cmd-lbl { flex: 0 1 auto; padding-right: 0; text-align: center; }
    .scv-pal-bar .scv-cmd:hover { background: rgba(255,255,255,0.10); }
    .scv-cmd-accent .scv-cmd-lbl { color: var(--scv-output); }
    .scv-cmd-alt .scv-cmd-lbl { color: var(--scv-input); }
    .scv-cmd-danger .scv-cmd-lbl { color: var(--scv-danger); }
    .scv-cmd-ok .scv-cmd-lbl { color: var(--scv-success); }
    .scv-view { outline: none; pointer-events: auto; display: none; }
    .scv-viewer { position: relative; display: flex; flex-direction: column; background: var(--scv-background-sunk); border-radius: 5px; padding: 6px; width: max-content; min-width: 380px; max-width: min(760px, 80vw); max-height: 70vh; color: var(--scv-text-base); font-family: var(--scv-font-mono); font-size: 12px; box-shadow: 0 0 24px rgba(0,0,0,0.55); pointer-events: auto; }
    .scv-viewer-wide { max-width: min(860px, 80vw); }
    .scv-viewer-term { width: 700px; height: 70vh; }
    .scv-v-head { display: flex; align-items: center; gap: 8px; flex-shrink: 0; padding: 7px 8px 7px 10px; margin-bottom: 6px; border-radius: 5px; background: rgba(255,255,255,0.05); }
    .scv-v-title { flex: 1 1 auto; min-width: 0; color: var(--scv-output); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .scv-v-count { flex-shrink: 0; margin-right: 8px; color: var(--scv-text-base); opacity: 0.4; font-size: 10px; }
    .scv-view-close, .scv-view-copy, .scv-grp-btn { flex-shrink: 0; width: 20px; height: 20px; padding: 0; border: none; border-radius: 5px; background: rgba(255,255,255,0.06); color: var(--scv-text-base); font-family: inherit; font-size: 12px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .scv-view-close:hover, .scv-view-copy:hover, .scv-grp-btn:hover { background: rgba(255,255,255,0.14); }
    .scv-v-body { overflow-y: auto; padding: 0 2px 2px; }
    .scv-v-list { display: flex; flex-direction: column; gap: 6px; }
    .scv-tree-wrap, .scv-tree-item, .scv-tree-item > div:not(.scv-tree-row):not(.scv-tree-info) { display: flex; flex-direction: column; gap: 6px; }
    .scv-tree-wrap { margin-bottom: -6px; }
    .scv-v-row, .scv-v-empty, .scv-tree-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 5px; font-size: 12px; cursor: pointer; transition: background 0.15s; -webkit-user-select: text; user-select: text; }
    .scv-v-row:nth-child(even) { background: rgba(255,255,255,0.03); }
    .scv-v-row:hover, .scv-v-empty:hover, .scv-tree-row:hover { background: rgba(255,255,255,0.10); }
    .scv-v-empty { cursor: default; }
    .scv-v-row.scv-took { background: var(--scv-input-25); }
    .scv-tree-row:hover .scv-grp { opacity: 1 !important; }
    .scv-v-idx { flex-shrink: 0; min-width: 2.5ch; text-align: right; color: var(--scv-text-base); opacity: 0.3; font-size: 10px; }
    .scv-v-txt { flex: 1 1 auto; overflow-wrap: anywhere; }
    .scv-v-kv { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 3px 12px; padding: 4px 6px; -webkit-user-select: text; user-select: text; }
    .scv-v-k { color: var(--scv-input); white-space: nowrap; }
    .scv-v-v { color: var(--scv-text-base); overflow-wrap: anywhere; }
    .scv-v-grp { grid-column: 1 / -1; margin-top: 8px; color: var(--scv-text-base); opacity: 0.45; font-size: 10px; }
    .scv-v-sub { display: block; margin-bottom: 6px; color: var(--scv-output); opacity: 0.75; }
    .scv-btn { padding: 3px 8px; background: transparent; color: var(--scv-output); border: 1px solid var(--scv-output-40) !important; border-radius: 5px; cursor: pointer; min-width: 50px; font-family: inherit; font-size: 12px; outline: none; transition: all 0.2s; }
    .scv-term-row { position: relative; display: flex; flex-shrink: 0; }
    .scv-textarea { flex: 1 1 auto; height: 40px; max-height: 40vh; box-sizing: border-box; background: transparent; color: var(--scv-input); border: none; border-radius: 5px; padding: 10px 38px 10px 10px; font-family: inherit; font-size: 13px; line-height: 1.5; resize: none; outline: none; overflow-y: auto; -webkit-user-select: text; user-select: text; }
    .scv-textarea::placeholder { color: var(--scv-input); opacity: 0.45; }
    .scv-term-run { position: absolute; right: 8px; bottom: 8px; }
    .scv-out-box { flex: 1 1 0; overflow-y: auto; background: rgba(255,255,255,0.03); border-radius: 5px; padding: 8px 10px; margin-bottom: 6px; color: var(--scv-text-base); font-size: 13px; -webkit-user-select: text; user-select: text; }
    .scv-pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; color: inherit; font-size: inherit; -webkit-user-select: text; user-select: text; }
    .scv-tree-line { opacity: 0.3; font-family: monospace; }
    .scv-tree-tag { color: var(--scv-output); font-weight: bold; }
    .scv-tree-evs { color: var(--scv-text-base); opacity: 0.5; font-size: 10px; max-width: 100px; overflow: hidden; white-space: nowrap; }
    .scv-grp { margin-left: auto; display: flex; gap: 8px; opacity: 0; transition: opacity 0.2s; }
    .scv-copy  { color: var(--scv-input); }
    .scv-harv  { color: var(--scv-input); }
    .scv-quest { color: var(--scv-input); border-color: var(--scv-input-31); }
    .scv-purge { color: var(--scv-output); }
    .scv-push  { color: var(--scv-output); border-color: var(--scv-output-31); }
    .scv-flash-input { background: var(--scv-input) !important; color: var(--scv-background-sunk) !important; }
    .scv-flash-output { background: var(--scv-output) !important; color: var(--scv-background-sunk) !important; }
    .scv-tree-info { display: none; margin: 0 0 6px; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 5px; font-family: var(--scv-font-mono); font-size: 12px; color: var(--scv-input); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; width: 0; min-width: 100%; box-sizing: border-box; }
    .scv-tree-info strong { font-family: inherit; font-size: inherit; font-weight: 700; color: var(--scv-text-base); }
    .scv-f-bar { position: sticky; top: 0; background: var(--scv-background-sunk); padding: 0 0 6px; display: flex; gap: 6px; z-index: 10; align-items: stretch; }
    .scv-f-bar > * { flex: 1 1 0; min-width: 0; }
    .scv-select { background: rgba(255,255,255,0.05); color: var(--scv-input); border: none; border-radius: 5px; font-family: var(--scv-font-mono); font-size: 12px; padding: 6px 8px; text-align: center; text-align-last: center; outline: none; cursor: pointer; -webkit-appearance: none; appearance: none; transition: background 0.15s; }
    .scv-select:hover { background: rgba(255,255,255,0.10); }
    .scv-select option { background: var(--scv-background-sunk); color: var(--scv-text-base); }
    #${IDS.notify} { position: fixed; right: 14px; bottom: 14px; height: 20px; width: 20px; padding: 0 20px 0 0; box-sizing: border-box; background: var(--scv-background-sunk); border-radius: 10px; display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; z-index: 2147483646; box-shadow: 0 2px 8px rgba(0,0,0,0.6); transition: width 0.2s ease, padding-left 0.2s ease; font-family: var(--scv-font-mono); font-size: 12px; pointer-events: none; }
    .scv-notify-status { color: var(--scv-input); }
    .scv-notify-label { color: var(--scv-output); margin-right: 6px; }
    #${IDS.capOv} { position: fixed; inset: 0; z-index: 2147483647; cursor: crosshair; pointer-events: auto; }
    #${IDS.capBox} { position: absolute; border: 2px dashed var(--scv-output); background: var(--scv-output-15); pointer-events: none; display: none; will-change: transform, width, height; top: 0; left: 0; }
    #${IDS.recUi} { position: fixed; bottom: 20px; right: 20px; z-index: 2147483647; background: var(--scv-background-sunk); border: 1px solid var(--scv-output-40); border-radius: 5px; padding: 10px; display: flex; gap: 10px; box-shadow: 0 0 15px rgba(0,0,0,0.7); font-family: var(--scv-font-mono); color: var(--scv-text-base); align-items: center; pointer-events: auto; }
    .scv-rec-stop { padding: 5px 10px; border: 1px solid var(--scv-border); border-radius: 5px; cursor: pointer; background: #333; color: #fff; }
    .scv-rec-label { font-size: 12px; color: var(--scv-danger); font-weight: bold; }
    #${IDS.sharedOv} { position: fixed; top: 0; left: 0; pointer-events: none; background: var(--scv-input-25); box-shadow: inset 0 0 0 1px var(--scv-output); display: none; transition: transform 0.1s, width 0.1s, height 0.1s; z-index: 2147483646; }
    #${IDS.sharedLbl} { position: fixed; top: 0; left: 0; pointer-events: none; padding: 3px 8px; border: 1px solid var(--scv-output-40); background: var(--scv-background-sunk); color: var(--scv-text-base); font-family: var(--scv-font-mono); font-size: 12px; white-space: nowrap; display: none; transition: transform 0.1s; z-index: 2147483647; }
    .scv-spatial-ov { width: 100%; overflow: hidden; position: absolute; pointer-events: none; z-index: 2147483640; top: 0; left: 0; }
    .scv-temp-line { position: absolute; top: 0; left: 0; pointer-events: none; z-index: 2147483646; opacity: 0.7; background: var(--scv-output); }
    .scv-pinned-line { pointer-events: auto; cursor: pointer; }
    .scv-grid-line { position: absolute; background: var(--scv-input); }
    .scv-grid-line-h { left: 0; height: 1px; width: 100%; }
    .scv-grid-line-v { top: 0; width: 1px; height: 100%; }
    .scv-xray-line { position: absolute; }
    .scv-xray-top { background: var(--scv-danger-40); }
    .scv-xray-mid { background: var(--scv-input-40); }
    .scv-xray-deep { background: var(--scv-output-40); }
    #${IDS.notify}.scv-ok .scv-notify-label { color: var(--scv-input); }
    #${IDS.notify}.scv-bad .scv-notify-label { color: var(--scv-danger); }
    .scv-wire-row { display: flex; flex-direction: column; gap: 3px; font-size: 10px; color: var(--scv-text-base); opacity: 0.75; }
    .scv-wire-input { background: rgba(255,255,255,0.05); color: var(--scv-input); border: none; border-radius: 5px; padding: 7px 8px; font-family: inherit; font-size: 12px; outline: none; }
    .scv-asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 8px; }
    .scv-asset-cell { padding: 5px; display: flex; align-items: center; justify-content: center; cursor: pointer; border-radius: 5px; min-height: 64px; }
    .scv-asset-img { max-width: 100%; max-height: 64px; object-fit: contain; }
    .scv-asset-holder { max-height: 64px; overflow: hidden; display: flex; align-items: center; }
    .scv-qs-badge { position: fixed; z-index: 2147483646; pointer-events: auto; cursor: pointer; width: 22px; height: 22px; border-radius: 50%; background: var(--scv-output); color: var(--scv-background-sunk); font: bold 12px var(--scv-font-mono); display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 4px rgba(0,0,0,0.5); }
    .scv-qs-badge:hover { background: var(--scv-danger); }
    .scv-qs-finalize { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647; pointer-events: auto; width: 44px; height: 44px; border-radius: 50%; background: var(--scv-output); color: var(--scv-background-sunk); font: 20px var(--scv-font-mono); display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 12px rgba(0,0,0,0.5); }
    #scv-qs-rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; padding: 6px; }
    .scv-qs-row { display: flex; align-items: center; gap: 8px; }
    .scv-qs-num { width: 18px; text-align: right; opacity: 0.6; font-size: 12px; }
    .scv-qs-arg, .scv-qs-text { flex: 1; min-width: 0; height: 26px; box-sizing: border-box; background: rgba(255,255,255,0.05); color: var(--scv-text-base); border: none; border-radius: 5px; font: 12px var(--scv-font-mono); padding: 0 7px; outline: none; -webkit-user-select: text; user-select: text; }
    .scv-qs-verb { height: 26px; box-sizing: border-box; font: 12px var(--scv-font-mono); padding: 0 8px; background: rgba(255,255,255,0.05); color: var(--scv-input); }
    .scv-qs-to { height: 26px; flex: 1; min-width: 0; box-sizing: border-box; display: inline-flex; align-items: center; background: rgba(255,255,255,0.05); color: var(--scv-input); border: 1px dashed var(--scv-input-40); border-radius: 5px; padding: 0 8px; cursor: pointer; font: 12px var(--scv-font-mono); overflow: hidden; white-space: nowrap; }
    .scv-qs-del { height: 26px; width: 26px; flex: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.06); color: var(--scv-text-base); border: none; border-radius: 5px; cursor: pointer; font: 12px var(--scv-font-mono); line-height: 1; }
    .scv-qs-del:hover { background: rgba(255,255,255,0.14); color: var(--scv-input); }
    .scv-qs-actions { display: flex; gap: 6px; align-items: center; margin-top: 6px; padding: 0 6px; }
    .scv-qe-panel { padding: 2px 6px 6px; }
    .scv-qs-btn { height: 26px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; }
    .scv-flex-1 { flex: 1; }
    #scv-qs-test { width: auto; white-space: nowrap; background: transparent; color: var(--scv-input); border: 1px solid var(--scv-input-40) !important; }
    #scv-qs-copy { width: 72px; }
    #scv-qs-out { min-height: 120px; width: calc(100% + 4px); margin-left: -2px; box-sizing: border-box; padding: 10px; margin-bottom: 6px; }
    .scv-qe-badge { position: fixed; z-index: 2147483646; pointer-events: auto; cursor: pointer; width: 14px; height: 14px; border-radius: 50%; background: var(--scv-input); box-shadow: 0 0 6px var(--scv-input); border: 2px solid var(--scv-background-sunk); }
    .scv-qe-badge.scv-bad { background: var(--scv-danger); box-shadow: none; }
    .scv-qe-sel { font-size: 10px; color: var(--scv-text-base); opacity: 0.7; word-break: break-all; }
    .scv-qe-label { display: block; margin: 8px 0 3px; font-size: 12px; color: var(--scv-input); }
    .scv-qe-input { width: 100%; box-sizing: border-box; height: 28px; background: rgba(255,255,255,0.05); color: var(--scv-text-base); border: 1px solid transparent; border-radius: 5px; font: 12px var(--scv-font-mono); padding: 0 8px; outline: none; -webkit-user-select: text; user-select: text; }
    .scv-qe-input.scv-bad { border-color: var(--scv-danger); }
    .scv-qe-actions { display: flex; gap: 6px; justify-content: center; margin-top: 8px; }
    #${IDS.wirePanel} { position: fixed; z-index: 2147483646; width: 220px; padding: 6px; display: flex; flex-direction: column; gap: 6px; background: var(--scv-background-sunk); border: none; border-radius: 5px; box-shadow: 0 0 24px rgba(0,0,0,0.55); font-family: var(--scv-font-mono); pointer-events: auto; }
    #scv-min-dot { position: fixed; bottom: 16px; right: 16px; width: 16px; height: 16px; border-radius: 50%; background: var(--scv-output); cursor: pointer; z-index: 2147483647; box-shadow: 0 2px 8px rgba(0,0,0,0.6); }
    .scv-btn:active, .scv-grp-btn:active, .scv-view-close:active, .scv-view-copy:active, .scv-cmd:active { transform: scale(0.94); }
    .scv-overlay-reveal { animation: scv-overlay-reveal 0.25s cubic-bezier(.34,1.56,.64,1) both; }
    @keyframes scv-overlay-reveal { 0% { opacity: 0; transform: scale(0.97); } 100% { opacity: 1; transform: scale(1); } }
  `;

  const sysStyle = document.createElement('style');
  sysStyle.id = IDS.sysStyles;
  sysStyle.textContent = EXT_UI_CSS;
  document.head.appendChild(sysStyle);

  // EVENT BUS

  class Bus { // minimal event bus - routes events to priority-ordered subscribers
    constructor() { this.subscribers = {}; }
    on(ev, id, fn, prio = 0) { // register handler for event - inserts into list ordered by priority descending
      const list = (this.subscribers[ev] = this.subscribers[ev] ?? []);
      let i = list.length;
      while (i > 0 && list[i - 1].prio < prio) i--;
      list.splice(i, 0, { id, fn, prio });
    }
    offAll(id) { // remove all handlers matching id across all events - prevents zombie listeners on tool teardowns
      Object.keys(this.subscribers).forEach(e => {
        this.subscribers[e] = this.subscribers[e].filter(s => s.id !== id);
      });
    }
    emit(ev, evObj) { // broadcast event to subscribers - swallows handler errors to prevent chain disruption
      (this.subscribers[ev] ?? []).forEach(s => {
        try {
          s.fn(evObj);
        } catch (err) {
          console.warn('bus handler error', err);
        }
      });
    }
  }

  const bus = new Bus();
  const globalEvents = ['click', 'mousemove', 'keydown', 'keyup', 'wheel', 'mousedown', 'mouseup', 'contextmenu'];
  const boundHandlers = {};

  globalEvents.forEach(ev => { // bind global events to bus - ensures kernel intercepts before host blocks propagation
    boundHandlers[ev] = e => bus.emit(ev, e);
    document.addEventListener(ev, boundHandlers[ev], true);
  });

  // MICROKERNEL CORE (register, start, stop)

  const registry = {};

  const kernel = { // privileged core - manages tool lifecycle and event bindings
    bus,
    processes: registry,
    register: (spec) => { // add tool to registry - populates defaults and binds lifecycle hooks
      registry[spec.id] = {
        ...spec,
        active: false,
        label: spec.label || spec.id,
        type: spec.type || 'toggle',
        category: spec.category || 'system',
        defaultVal: spec.defaultVal ?? '',
        start: spec.start || (() => {}),
        stop: spec.stop || (() => {})
      };
    },
    start: (id, args) => { // launch tool - executes start hook and stores teardown function
      const p = registry[id];
      if (p && !p.active) {
        p.active = true;
        delete p._teardown;
        kernel._starting = id; // so snipe started here can find its owner
        try {
          const result = p.start(args);
          if (typeof result === 'function') p._teardown = result;
          bus.emit('sys_process_changed', id);
          return result;
        } catch (err) {
          p.active = false;
          bus.offAll(id);
          throw err;
        } finally {
          kernel._starting = null;
        }
      }
    },
    stop: (id) => { // halt tool - executes teardown hook and drops event subscriptions
      const p = registry[id];
      if (p && p.active) {
        p.active = false;
        try {
          if (typeof p._teardown === 'function') p._teardown();
        } catch (err) { console.warn('teardown error', err); }
        delete p._teardown;
        try { p.stop(); } catch (err) { console.warn('stop error', err); }
        bus.offAll(id);
        bus.emit('sys_process_changed', id);
      }
    },
    toggle: (id, args) => registry[id]?.active ? kernel.stop(id) : kernel.start(id, args), // invert tool state
    destroy: () => { // tear down kernel entirely - executes all destroy hooks and strips host page bindings
      if (kernel._shiftHandler) document.removeEventListener('keydown', kernel._shiftHandler, true);
      globalEvents.forEach(ev => document.removeEventListener(ev, boundHandlers[ev], true));
      // destroy hooks before clearRegistry - if tool leaves something running past stop(), registers hook for destroy()
      (kernel._destroyHooks ?? []).forEach(fn => { try { fn(); } catch {} });
      Object.keys(registry).forEach(id => kernel.stop(id));
      utils.clearRegistry();
      delete window.$kernel;
    },
    _destroyHooks: []
  };

  window.$kernel = kernel;

  // UTILITIES & HARVEST

  const remPx = (() => {
    const ruler = document.createElement('div');
    ruler.style.cssText = 'width: 1rem; height: 1rem; visibility: hidden;';
    document.body.appendChild(ruler);
    const px = ruler.offsetWidth;
    ruler.remove();
    return px;
  })();

  const utils = { // shared tool helpers - manages dom injection, extraction and encoding

    uiNodes:  new Set(), // track mounted ui elements - ensures removal on teardown
    b64Cache: new Map(), // store encoded asset strings - prevents redundant network requests
    _iframe:  null, // hold hidden document reference
    _trustedHTML: window.trustedTypes?.createPolicy ? window.trustedTypes.createPolicy('scav', { createHTML: s => s }) : null,

    esc: (v) => { // escape html entities - prevents injection when rendering untrusted text
      return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    setHTML: (el, s) => { el.innerHTML = utils._trustedHTML ? utils._trustedHTML.createHTML(s) : s; },
    insertHTML: (el, pos, s) => { el.insertAdjacentHTML(pos, utils._trustedHTML ? utils._trustedHTML.createHTML(s) : s); },
    getIframe: () => { // spawns synchronous hidden iframe - provides computed style baseline for harvest
      if (!utils._iframe) {
        utils._iframe = document.createElement('iframe');
        utils._iframe.style.cssText = 'visibility:hidden;width:0;height:0;position:absolute;border:0;';
        document.body.appendChild(utils._iframe);
        try { // force document to initialise now (chrome/safari can defer navigation leaving contentDocument null when read)
          const d = utils._iframe.contentDocument;
          if (d) { d.open(); d.write('<!doctype html><html><head></head><body></body></html>'); d.close(); }
        } catch {}
      }
      return utils._iframe;
    },
    mount: (el) => { // append element to body and track it - ensures proper cleanup on teardown
      document.body.appendChild(el);
      utils.uiNodes.add(el);
      return el;
    },
    unmount: (idOrEl) => { // remove tracked element from dom and registry - frees memory
      const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
      if (el) {
        utils.uiNodes.delete(el);
        el.remove();
      }
    },
    clearRegistry: () => { // purge all tracked ui nodes and caches - resets kernel footprint
      utils.uiNodes.forEach(el => el.remove());
      utils.uiNodes.clear();
      utils.b64Cache.clear();
      if (utils._iframe) {
        utils._iframe.remove();
        utils._iframe = null;
      }
      utils.unmount(IDS.sysStyles);
    },
    createOverlay: (id, cls = '', parent = document.body) => { // instantiate tracked container - isolates ui from host styles
      utils.unmount(id);
      const el = document.createElement('div');
      el.id = id;
      if (cls) el.className = cls;
      parent.appendChild(el);
      if (parent === document.body) utils.uiNodes.add(el);
      return el;
    },
    notify: { // status grows out of minimized dot - stays until dot is dismissed
      _ensureDot: () => {
        if (document.getElementById('scv-min-dot')) return;
        const dot = utils.createOverlay('scv-min-dot', '', document.documentElement);
        utils.uiNodes.add(dot);
        dot.onclick = () => summon();
      },
      _ensurePill: () => {
        utils.notify._ensureDot();
        let pill = document.getElementById(IDS.notify);
        if (!pill) { pill = utils.createOverlay(IDS.notify, '', document.documentElement); utils.uiNodes.add(pill); }
        pill.classList.remove('scv-ok', 'scv-bad');
        return pill;
      },
      _resize: (pill) => {
        pill.style.paddingLeft = '10px';
        pill.style.width = pill.scrollWidth + 'px';
      },
      start: (label, initialStatus) => { // opens live row for multi-phase op - resolves once painted, so a hang can't hide it
        const pill = utils.notify._ensurePill();
        pill.style.transitionDuration = '0.1s'; // reveal faster than mid-harvest updates
        utils.setHTML(pill, `<span class="scv-notify-status">${utils.esc(initialStatus || '')}</span><span class="scv-notify-label"> - ${utils.esc(label)}</span>`);
        utils.notify._resize(pill);
        return new Promise(res => _raf(() => _raf(() => _st(() => { pill.style.transitionDuration = ''; res(); }, 100))));
      },
      setStatus: (text) => { // updates changing half of already-started row
        const pill = document.getElementById(IDS.notify);
        if (!pill) return;
        const s = pill.querySelector('.scv-notify-status');
        if (s) s.textContent = text;
        utils.notify._resize(pill);
      },
      finish: (message, ok) => { // collapses row to outcome message - only summon() clears
        const pill = utils.notify._ensurePill();
        utils.setHTML(pill, `<span class="scv-notify-label">${utils.esc(message)}</span>`);
        pill.classList.add(ok ? 'scv-ok' : 'scv-bad');
        utils.notify._resize(pill);
      },
    },
    createSpatialOverlay: (id, buildFn) => { // build full page overlay - supports grid and structural visualization tools
      const ov = utils.createOverlay(id, 'scv-spatial-ov');
      ov.style.height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) + 'px';
      const frag = document.createDocumentFragment();
      buildFn(frag);
      ov.appendChild(frag);
    },
    getSelector: (el) => { // compute precise css selector from element - enables stable targeting across sessions
      if (el.id) return `#${CSS.escape(el.id)}`;
      const path = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        let name = cur.nodeName.toLowerCase();
        if (cur.id) {
          path.unshift(`${name}#${CSS.escape(cur.id)}`);
          break;
        }
        let nth = 1;
        for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) {
          if (s.nodeName === cur.nodeName) nth++;
        }
        path.unshift(`${name}:nth-of-type(${nth})`);
        cur = cur.parentElement;
      }
      return path.join(' > ');
    },
    getDepthCategory: d => { // map numeric depth to band - tags tree rows for depth filter
      if (d <= 4) return 'top';
      if (d <= 8) return 'mid';
      if (d <= 12) return 'bot';
      return 'deep';
    },
    toB64: async (url) => { // fetch and encode remote asset as base64 - makes exported artifacts offline capable
      if (url.startsWith('data:')) return url;
      if (utils.b64Cache.has(url)) return utils.b64Cache.get(url);
      let href;
      try { href = new URL(url, document.baseURI).href; } catch { return url; }
      const p = fetch(href)
        .then(r => { // 404 page is html not asset - inlining bloats artifact and renders nothing
          if (!r.ok) throw new Error(r.status);
          if ((r.headers.get('content-type') || '').toLowerCase().startsWith('text/html')) throw new Error('not an asset');
          return r.blob();
        })
        .then(b => new Promise(rs => {
          const rd = new FileReader();
          rd.onloadend = () => rs(rd.result);
          rd.readAsDataURL(b);
        }))
        .catch(() => {
          utils.b64Cache.delete(url);
          return url;
        });
      utils.b64Cache.set(url, p);
      return p;
    },
    copy: async (text) => { // write to system clipboard with fallback - ensures data extraction succeeds across security contexts
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.top = '0';
          ta.style.left = '0';
          ta.style.width = '0';
          ta.style.height = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          if (ok) return true;
        } catch {}
        prompt('ctrl + c:', text);
        return false;
      }
    },
    purge: (el) => { // strip executable attributes and scripts - sanitizes harvested doms
      el.querySelectorAll('script').forEach(s => s.remove());
      [el, ...el.querySelectorAll('*')].forEach(n => {
        Array.from(n.attributes || []).forEach(a => {
          if (a.name.startsWith('on')) n.removeAttribute(a.name);
        });
      });
      const INERT = 'javascript:void(0);';
      el.querySelectorAll('a[href]').forEach(a => {
        const h = a.getAttribute('href');
        if (h && !h.startsWith('#') && h !== INERT) { // sentinel is skipped - javascript: href is what must not survive
          a.dataset.origHref = h;
          a.setAttribute('href', INERT);
        }
      });
      el.querySelectorAll('a[ping]').forEach(a => a.removeAttribute('ping')); // ping fires background post to third party on click - pure beacon
      el.querySelectorAll('[formaction]').forEach(n => n.setAttribute('formaction', INERT));
      el.querySelectorAll('iframe[srcdoc]').forEach(f => f.removeAttribute('srcdoc')); // inline document runs its scripts in pasting page
      // kept frame embeds real remote page - strip data:/blob:/javascript:
      el.querySelectorAll('iframe[src]').forEach(n => { const s = n.getAttribute('src') || '';
        if (!/^\s*((https?:)?\/\/|about:)/i.test(s)) n.removeAttribute('src'); });
      // a[href] never catches xlink form - neutralise both like every link
      const XLINK = 'http://www.w3.org/1999/xlink';
      [el, ...el.querySelectorAll('*')].forEach(n => {
        if (!n.getAttribute) return;
        const x = (n.getAttributeNS && n.getAttributeNS(XLINK, 'href')) || n.getAttribute('xlink:href');
        if (x && /^\s*javascript:/i.test(x)) {
          n.dataset.origHref = x;
          try { n.setAttributeNS(XLINK, 'xlink:href', INERT); } catch {}
          n.setAttribute('xlink:href', INERT); // whichever form serialised, overwrite it too
        }
      });
      // self-contained component needs no <link> or <base> - refresh <meta> redirects page
      el.querySelectorAll('link, base').forEach(n => n.remove());
      el.querySelectorAll('meta[http-equiv]').forEach(m => { if (/refresh/i.test(m.getAttribute('http-equiv') || '')) m.remove(); });
      // inline css phones home - @import and url() in rule fetch remote - drop both, keep local
      const REMOTE = v => /^\s*(https?:)?\/\//i.test(v || '') || /^\s*\/[^/]/.test(v || '');
      el.querySelectorAll('style').forEach(s => { s.textContent = s.textContent
        .replace(/@import[^;]*;/gi, '')
        .replace(/url\((['"]?)(.*?)\1\)/gi, (m, q, u) => REMOTE(u.trim()) ? 'none' : m); }); // same url() shape harvest inlines with
      // svg <image>/<feImage> phone home by href/xlink:href - <img> strip never saw them; drop off-origin refs
      el.querySelectorAll('image, feImage, feimage').forEach(im => {
        if (REMOTE(im.getAttribute('href'))) im.removeAttribute('href');
        const xh = (im.getAttributeNS && im.getAttributeNS(XLINK, 'href')) || im.getAttribute('xlink:href');
        if (REMOTE(xh)) { try { im.removeAttributeNS(XLINK, 'href'); } catch {} im.removeAttribute('xlink:href'); }
      });
      // input[type=image] and <track> fetch by src, and the deprecated background= attr by url - all beacons
      el.querySelectorAll('input[type=image][src], track[src]').forEach(n => { if (REMOTE(n.getAttribute('src'))) n.removeAttribute('src'); });
      el.querySelectorAll('[background]').forEach(n => { if (REMOTE(n.getAttribute('background'))) n.removeAttribute('background'); });
      el.querySelectorAll('embed, object, portal').forEach(n => n.remove()); // no visible-embed idiom worth risk - only <iframe> keep, these always go
      // invisible iframe shows nothing; visible is content - keep only that
      el.querySelectorAll('iframe').forEach(n => {
        const w = parseFloat(n.getAttribute('width')), h = parseFloat(n.getAttribute('height'));
        const st = (n.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
        let hidden = w <= 4 || h <= 4 || /display:none|visibility:hidden|(^|;)width:0|(^|;)height:0/.test(st);
        if (!hidden && n.isConnected) { try { const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
          hidden = r.width <= 4 || r.height <= 4 || cs.display === 'none' || cs.visibility === 'hidden'; } catch {} }
        if (hidden) n.remove();
      });
      el.querySelectorAll('form').forEach(f => {
        f.setAttribute('action', INERT);
        f.addEventListener('submit', e => e.preventDefault(), { capture: true });
      });
      el.querySelectorAll('template').forEach(t => utils.purge(t.content));
      [el, ...el.querySelectorAll('*')].forEach(n => { if (n.shadowRoot) utils.purge(n.shadowRoot); });
      return el;
    },
    captureShadows: (original, clone) => { // recursively flatten shadow doms into light dom - captures styles and markup
      let hostSeq = 0; // nested shadow's :host rules end in one shadow once flattened - rescope each to real element, not outer host
      const walk = (orig, cl) => {
        if (!orig || !cl) return;
        const ol = orig.children, ll = cl.children; // light dom children before prepending shadow content to cl
        for (let i = 0; i < ol.length && i < ll.length; i++) walk(ol[i], ll[i]);
        const sr = orig.shadowRoot;
        if (sr) {
          let inner = sr.innerHTML;
          if (orig !== original) { // harvest root's own shadow becomes final :host - only descendants need rescope
            const mark = `scv-h${hostSeq++}`;
            cl.classList.add(mark);
            inner = inner.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) =>
              `<style${attrs}>${css.replace(/:host\(([^)]*)\)/g, `.${mark}:is($1)`).replace(/:host\b/g, `.${mark}`)}</style>`);
          }
          const before = cl.children.length;
          utils.insertHTML(cl, 'afterbegin', inner);
          const inserted = cl.children.length - before;
          const sk = sr.children;
          for (let i = 0; i < inserted && i < sk.length; i++) walk(sk[i], cl.children[i]);
        }
      };
      walk(original, clone);
    },
    preserveScvNodes: (original, clone) => { // protect logic nodes from structural mutation - keeps patchbays functional
      const keep = new Set();
      const protect = el => { keep.add(el); el.querySelectorAll('*').forEach(d => keep.add(d)); };
      const oLogics = original.querySelectorAll('scv-logic');
      const cLogics = clone.querySelectorAll('scv-logic');
      cLogics.forEach((c, i) => {
        protect(c);
        const oi = oLogics[i]?.querySelector('input'), ci = c.querySelector('input');
        if (oi && ci) ci.setAttribute('value', oi.value);
      });
      clone.querySelectorAll('[data-scv-emits],[data-scv-receives],[data-scv-action]').forEach(protect);
      return keep;
    },
    freezeFormState: (orig, clone) => { // bake live form state onto clone so harvest carries what user actually sees
      const t = orig.tagName;
      if (t === 'INPUT') {
        if (orig.type === 'checkbox' || orig.type === 'radio') orig.checked ? clone.setAttribute('checked', '') : clone.removeAttribute('checked');
        else clone.setAttribute('value', orig.value);
      } else if (t === 'TEXTAREA') { clone.textContent = orig.value; }
      else if (t === 'OPTION') { orig.selected ? clone.setAttribute('selected', '') : clone.removeAttribute('selected'); }
    },
    harvest: async (el, opts = {}) => { // produces standalone portable web component (opts.refMode keeps remote assets as urls for quest transport)
      await utils.notify.start('harvesting', 'cloning element'); // on screen before hang is possible
      const _hadFreeze = registry.freeze?.active; // freeze if present and not on - stops page moving during harvest
      if (registry.freeze && !_hadFreeze) kernel.start('freeze');
      try {
      const _realm = utils.getIframe().contentWindow;
      const uid = (opts.uid && /^[0-9a-z]+$/.test(opts.uid)) ? opts.uid : Math.random().toString(36).slice(2, 8); // stable id per quest channel makes re-harvests diffable so morph in place works
      const cl = el.cloneNode(true);
      utils.captureShadows(el, cl); // fold shadow in, then pair composed - querySelectorAll never reaches nested shadow nodes
      const ao = [], ac = [];
      (function pair(o, c) {
        ao.push(o); ac.push(c);
        const ok = o.shadowRoot ? [...o.shadowRoot.children, ...o.children] : [...o.children]; // same order captureShadows splices them
        const ck = [...c.children];
        for (let i = 0; i < ok.length && i < ck.length; i++) pair(ok[i], ck[i]);
      })(el, cl);
      const keepScv = utils.preserveScvNodes(el, cl); // logic nodes and wired elements keep their markup
      const origSet = new Set(), nodeMap = new Map();

      for (let i = 0; i < ao.length; i++) {
        if (ao[i].nodeType !== 1) continue;
        utils.freezeFormState(ao[i], ac[i]); // live value/checked/selected are properties, cloneNode only copies attributes
        if (keepScv.has(ac[i])) continue;
        origSet.add(ao[i]);
        ac[i].setAttribute('class', `scv-${uid}-${i}`); // setAttribute not .className - on svg node className is read-only SVGAnimatedString
        nodeMap.set(ao[i], { clone: ac[i], props: new Set(), ctx: new Map(), imp: new Set(), css: '', pseudo: {}, media: {} });
      }

      let cssText = `:host { display: block; position: relative; }\n`;
      const rootSt = window.getComputedStyle(el);
      let hostCss = '';

      const customProps = new Map(); // root visible custom props - theme tokens on :root, outside subtree - only ones referenced by var() stay
      for (let prop of rootSt) {
        if (prop.startsWith('--') && !prop.startsWith('--scv-') && rootSt.getPropertyValue(prop)) { // never our own ui tokens
          customProps.set(prop, rootSt.getPropertyValue(prop));
        }
      }

      const HOST_INHERITED = ['font-family', 'font-size', 'color', 'line-height', 'letter-spacing', 'text-align'];
      HOST_INHERITED.forEach(p => {
        hostCss += `${p}: ${rootSt.getPropertyValue(p)};\n`;
      });

      const rgb = c => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null;
        const p = m[1].split(',').map(v => parseFloat(v)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      const opaque = c => { const p = rgb(c); return !!p && p.a >= 0.999; };
      const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
      if (!opaque(rootSt.backgroundColor) && rootSt.backgroundImage === 'none') { // paints nothing - carry backdrop
        let back = '', carried = false;
        const rr = el.getBoundingClientRect();
        const painters = []; // whoever painted behind
        try {
          const cx = Math.min(Math.max(rr.left + rr.width / 2, 1), window.innerWidth - 1);
          const cy = Math.min(Math.max(rr.top + rr.height / 2, 1), window.innerHeight - 1);
          const stack = document.elementsFromPoint(cx, cy) || [];
          const self = stack.findIndex(n => n === el || el.contains(n)); // everything before us in stack paints above - overlay is not backdrop
          for (const n of stack.slice(self < 0 ? 0 : self)) if (n !== el && !el.contains(n)) painters.push(n);
        } catch {}
        for (let a = el.parentElement; a; a = a.parentElement) if (!painters.includes(a)) painters.push(a);

        const layers = []; // every translucent sheet down to first solid one
        for (const n of painters) {
          let hit = null;
          for (const p of [null, '::before', '::after']) {
            const c = window.getComputedStyle(n, p || undefined);
            if (p && c.content === 'none') continue;
            const col = rgb(c.backgroundColor);
            if ((c.backgroundImage && c.backgroundImage !== 'none') || (col && col.a > 0)) { hit = c; break; }
          }
          if (!hit) continue;
          if (!carried && hit.backgroundImage && hit.backgroundImage !== 'none') {
            const b = n.getBoundingClientRect(); // pin to box that drew it
            hostCss += `background-image: ${hit.backgroundImage};\n`
              + `background-size: ${b.width}px ${b.height}px;\n`
              + `background-position: ${b.left - rr.left}px ${b.top - rr.top}px;\n`
              + `background-repeat: ${hit.backgroundRepeat};\n`;
            carried = true; // keep walking - gradient with alpha still shows whatever solid sits underneath
          }
          const col = rgb(hit.backgroundColor);
          if (col && col.a > 0) layers.push(col);
          if (col && col.a >= 0.999) break;
        }
        if (layers.length && layers[layers.length - 1].a >= 0.999) {
          let acc = layers[layers.length - 1];
          for (let i = layers.length - 2; i >= 0; i--) acc = over(layers[i], acc);
          back = `rgb(${Math.round(acc.r)}, ${Math.round(acc.g)}, ${Math.round(acc.b)})`;
        }
        if (!back && !carried) { // nothing opaque up to <html> - backdrop is browser canvas, resolved here so it can't re-resolve
          try {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;background-color:Canvas';
            document.body.appendChild(probe);
            const c = window.getComputedStyle(probe).backgroundColor;
            probe.remove();
            let acc = rgb(c);
            if (acc && acc.a >= 0.999) { // fold found translucent sheets over canvas beneath them
              for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
              back = `rgb(${Math.round(acc.r)}, ${Math.round(acc.g)}, ${Math.round(acc.b)})`;
            }
          } catch {}
        }
        if (back) hostCss += `background-color: ${back};\n`;
      }

      cssText += `:host {\n${hostCss}}\n`;
      const allRules = [];
      let fontCss = ''; // @font-face is inert inside shadow root - only registers document-side, so it ships separately

      const fontName = v => (v || '').trim().replace(/^["']|["']$/g, '').toLowerCase();
      const usedFonts = new Set(), usedSlants = new Set(); // only families/slants subtree renders with
      const addFonts = v => (v || '').split(',').forEach(f => { const n = fontName(f); if (n) usedFonts.add(n); });
      const addSlant = v => usedSlants.add(/italic|oblique/i.test(v || '') ? 'italic' : 'normal');
      addFonts(rootSt.getPropertyValue('font-family')); addSlant(rootSt.getPropertyValue('font-style'));
      origSet.forEach(o => { const c = window.getComputedStyle(o); addFonts(c.fontFamily); addSlant(c.fontStyle);
        for (const p of ['::before', '::after']) { try { const pc = window.getComputedStyle(o, p); addFonts(pc.fontFamily); if (pc.content !== 'none') addSlant(pc.fontStyle); } catch {} } });
      // unicode-range subsets kept - component receives routed values, so text is not fixed at harvest
      const faceUsed = r => usedFonts.has(fontName(r.style.getPropertyValue('font-family')))
        && usedSlants.has(/italic|oblique/i.test(r.style.getPropertyValue('font-style') || '') ? 'italic' : 'normal');

      // recurse - @layer/@supports wrap almost everything frameworks ship, flat pass sees few percent of rules
      const SKIP_GROUP = /Container|StartingStyle/; // condition-bound on state we can't reproduce flat - computed styles cover them
      // url() relative to sheet that wrote it, not to page - webfont one directory up 404s and face silently errors
      const absUrls = (t, base) => !base ? t : t.replace(/url\((['"]?)(.*?)\1\)/g, (m, q, u) =>
        (!u || /^(data:|#|[a-z]+:)/i.test(u)) ? m : `url(${q}${(() => { try { return new URL(u, base).href; } catch { return u; } })()}${q})`);

      const collectRules = (rules, media, base) => {
        for (let rule of rules) {
          if (rule.type === 1) { allRules.push({ media, rule, base }); continue; }
          if (rule.type === 5) { if (faceUsed(rule)) fontCss += absUrls(rule.cssText, base) + '\n'; continue; }
          if (rule.type === 7) { cssText += absUrls(rule.cssText, base) + '\n'; continue; } // @keyframes rides along whole
          if (rule.type === 4) { collectRules(rule.cssRules, rule.conditionText || media, base); continue; }
          if (rule.type === 12) { // @supports - only descend when it actually applies here, else we'd flatten dead rules
            let on = true; try { on = CSS.supports(rule.conditionText); } catch {}
            if (on) collectRules(rule.cssRules, media, base);
            continue;
          }
          // descend anything else grouping rules (@layer, @scope, next thing)
          if (rule.cssRules && !SKIP_GROUP.test(rule.constructor.name)) collectRules(rule.cssRules, media, base);
        }
      };
      utils.notify.setStatus('reading stylesheets');
      const sheets = []; // cross-origin sheet throws on cssRules - refetch as text
      try {
        // adopted (constructable) sheets carry @font-face + rules but never appear in document.styleSheets
        for (let sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
          if (sheet.ownerNode?.id?.startsWith('scv-')) continue; // our injected styles are never page content
          try { sheet.cssRules; sheets.push(sheet); }
          catch { if (sheet.href) sheets.push(sheet.href); }
        }
      } catch (e) { console.warn('styleSheets access denied', e); }
      const readable = await _realm.Promise.all(sheets.map(async s => {
        if (typeof s !== 'string') return { sheet: s, base: s.href || document.baseURI };
        try {
          const ss = new CSSStyleSheet();
          ss.replaceSync(await (await fetch(s)).text());
          return { sheet: ss, base: s };
        } catch { return { blocked: s }; } // csp can forbid fetch even where browser loaded sheet
      }));
      const blockedSheets = [];
      for (let r of readable) {
        if (!r) continue;
        if (r.blocked) { if (typeof r.blocked === 'string') blockedSheets.push(r.blocked); continue; } // can't read cross-origin css headless - record it so quest server refetches
        try { collectRules(r.sheet.cssRules, null, r.base); } catch {}
      }

      for (let { media, rule, base } of allRules) {
        if (!rule.selectorText) continue;
        const sels = rule.selectorText.split(',');

        for (let s of sels) {
          let cleanSel = s.trim(), pseudo = '';
          const pRe = /(?<!\\)::?[a-zA-Z0-9-]+(?:\([^()]*\))?/g; // pseudo regex for tailwind like css
          const pMatch = cleanSel.match(pRe); // match pseudos including functional arguments
          if (pMatch) { // strip only what can't match statically and re-attach it to flat class; structural pseudos must stay, or rule over-matches every sibling
            const dyn = pMatch.filter(p => /^::|^:(hover|focus|focus-visible|focus-within|active|visited|target|checked|disabled|enabled|indeterminate|placeholder-shown|default|required|optional|valid|invalid|read-only|read-write)\b/i.test(p));
            for (const d of dyn) cleanSel = cleanSel.split(d).join('');
            cleanSel = cleanSel.trim();
            pseudo = dyn.join('');
          }

          if (!cleanSel || cleanSel === '*' || cleanSel === ':root' || cleanSel === 'html' || cleanSel === 'body') continue;

          try {
            const processMatch = (m) => {
              if (origSet.has(m)) {
                const st = nodeMap.get(m);
                const cssBlock = absUrls(rule.style.cssText, base);
                // resolved against env we leave behind - copied it re-resolves, calc(1.375rem + 1.5vw) shrinks
                const CTX_DEP = /var\(|\d\s*(rem|rlh|vw|vh|vmin|vmax|dvw|dvh|svw|svh|lvw|lvh|cqw|cqh|cqi|cqb|cqmin|cqmax)\b/i;
                for (let k = 0; k < rule.style.length; k++) {
                  const p = rule.style[k];
                  // remember priority too - copied 1rem !important outranks later plain resolved value
                  if (CTX_DEP.test(rule.style.getPropertyValue(p))) st.ctx.set(p, st.ctx.get(p) || rule.style.getPropertyPriority(p) === 'important');
                  if (rule.style.getPropertyPriority(p) === 'important') st.imp.add(p); // framework utilities are !important - plain resolved value never outranks
                  st.props.add(p);
                }

                if (media) {
                  st.media[media] = st.media[media] ?? {};
                  st.media[media][pseudo] = (st.media[media][pseudo] ?? '') + cssBlock;
                } else {
                  if (pseudo) st.pseudo[pseudo] = (st.pseudo[pseudo] ?? '') + cssBlock;
                  else st.css += cssBlock;
                }
              }
            };
            if (el.matches(cleanSel)) processMatch(el);
            const desc = el.querySelectorAll(cleanSel);
            for (let d = 0; d < desc.length; d++) processMatch(desc[d]);
          } catch {}
        }
      }

      utils.notify.setStatus('creating iframe for diffing');
      let idoc = null, iwin = null;
      try {
        const ifr = utils.getIframe();
        idoc = ifr.contentDocument;
        iwin = ifr.contentWindow;
      } catch {}

      const dummyCache = new Map();
      let probeHost = null; // probe must sit in context copy lands in - loose in iframe would match by luck and bake nothing
      if (idoc) {
        try {
          probeHost = idoc.createElement('div');
          probeHost.style.cssText = HOST_INHERITED.map(p => `${p}:${rootSt.getPropertyValue(p)}`).join(';');
          idoc.body.appendChild(probeHost);
        } catch {}
      }
      const rootRect = el.getBoundingClientRect();

      // probe is shallow clone of element - rebuilding from tag name guesses which attrs drive ua styling
      const PROBE_STRIP = ['class', 'style', 'id', 'src', 'srcset', 'poster', 'data']; // author styling, plus what would fetch
      let _diffIdx = 0;
      for (const orig of origSet) {
        if (++_diffIdx % 40 === 0) await new Promise(res => _raf(res)); // let tab breathe on big harvests - freeze already stops page from drifting
        const data = nodeMap.get(orig);
        const key = `${orig.namespaceURI}|${orig.tagName}|${[...orig.attributes].map(a => `${a.name}=${a.value}`).sort().join('|')}`;
        if (idoc && !dummyCache.has(key)) {
          let d = null;
          try { d = idoc.importNode(orig.cloneNode(false), false); } catch {}
          if (d) {
            PROBE_STRIP.forEach(a => { try { d.removeAttribute(a); } catch {} });
            (probeHost || idoc.body).appendChild(d); dummyCache.set(key, d); // keep node - pseudo baselines need it
          }
        }

        const dNode = dummyCache.get(key);
        const dSt = dNode ? iwin.getComputedStyle(dNode) : null, oSt = window.getComputedStyle(orig);
        let diff = '';
        const diffProps = new Set();
        // default to currentColor - baked value turns keyword into fixed colour that inherits over child's
        const CC_DERIVED = /^(-webkit-text-fill-color|-webkit-text-stroke-color|text-decoration-color|text-emphasis-color|caret-color|outline-color|column-rule-color|border-(top|right|bottom|left)-color)$/;
        const ownColor = oSt.getPropertyValue('color');
        const ALWAYS_BAKE = new Set(['box-sizing']); // blank-iframe baseline for prop can misreport under rare engine conditions - bake live value

        const enumSeen = new Set();
        for (let prop of oSt) {
          enumSeen.add(prop);
          if (prop.startsWith('--')) continue;
          if (orig === el && prop === 'transform') continue; // don't bake harvest root's transform into snapshot
          if (prop === 'animation-play-state') continue; // never bake freeze pause - authored pausing comes through matched rules
          const oVal = oSt.getPropertyValue(prop), dVal = dSt ? dSt.getPropertyValue(prop) : oVal;
          // computed wins even equal default - flat, copied display:none resolves by order and hides rendered
          if (oVal && (CC_DERIVED.test(prop) ? oVal !== ownColor : (ALWAYS_BAKE.has(prop) || oVal !== dVal || data.props.has(prop)))) { // w/h values quantized to 1/64px but reported at three decimals
            const bake = (prop === 'width' || prop === 'height') && /^[\d.]+px$/.test(oVal) ? Math.round(parseFloat(oVal) * 64) / 64 + 'px' : oVal;
            diff += `${prop}:${bake}${(data.ctx.get(prop) || data.imp.has(prop)) ? ' !important' : ''};`; diffProps.add(prop);
          }
        }

        // never enumerated (-webkit-mask-image, -webkit-background-clip) - rule setting one beats value never written
        for (const p of data.props) {
          if (p.startsWith('--') || enumSeen.has(p) || diffProps.has(p)) continue;
          const v = oSt.getPropertyValue(p);
          if (v) { diff += `${p}:${v};`; diffProps.add(p); }
        }

        const _borderGroups = [ // capture interdependent property groups atomically - bring siblings on capture
          ['border-top-style','border-top-width','border-top-color'],
          ['border-right-style','border-right-width','border-right-color'],
          ['border-bottom-style','border-bottom-width','border-bottom-color'],
          ['border-left-style','border-left-width','border-left-color'],
          ['outline-style','outline-width','outline-color'],
        ];
        for (const grp of _borderGroups) {
          if (!grp.some(p => diffProps.has(p))) continue;
          for (const gp of grp) {
            if (diffProps.has(gp) || data.props.has(gp)) continue;
            const gv = oSt.getPropertyValue(gp);
            if (gv) { diff += `${gp}:${gv};`; diffProps.add(gp); }
          }
          // specificity collapse - declarations resolved by specificity resolve by source order here
          const widthProp = grp[1], wv = oSt.getPropertyValue(widthProp);
          if (wv) diff += `${widthProp}:${wv} !important;`;
        }

        if (orig !== el) { // out-of-flow descendant anchored above now resolves against :host
          const pos = oSt.getPropertyValue('position');
          if (pos === 'absolute' || pos === 'fixed') {
            let cb = orig.parentElement, inside = false;
            while (cb) {
              const cs = window.getComputedStyle(cb);
              const anchors = pos === 'fixed'
                ? (cs.transform !== 'none' || cs.filter !== 'none' || /transform|filter/.test(cs.willChange))
                : (cs.position !== 'static' || cs.transform !== 'none' || cs.filter !== 'none' || /transform|filter/.test(cs.willChange));
              if (anchors) { inside = origSet.has(cb); break; }
              cb = cb.parentElement;
            }
            if (!inside) {
              const r = orig.getBoundingClientRect();
              diff += 'position:absolute !important;'; // fixed, or it escapes to viewport of page host
              if (pos === 'fixed') { // viewport was its containing block and lone component takes that role
                const bot = data.props.has('bottom') && !data.props.has('top');
                const rgt = data.props.has('right') && !data.props.has('left');
                const vh = document.documentElement.clientHeight, vw = document.documentElement.clientWidth; // client, inner counts scrollbar and offsets bar by width
                diff += bot ? `bottom:${vh - r.bottom}px !important;top:auto !important;`
                            : `top:${r.top}px !important;bottom:auto !important;`;
                diff += rgt ? `right:${vw - r.right}px !important;left:auto !important;`
                            : `left:${r.left}px !important;right:auto !important;`;
              } else {
                diff += `left:${r.left - rootRect.left}px !important;top:${r.top - rootRect.top}px !important;right:auto !important;bottom:auto !important;`;
              }
            }
          }
        }

        if (orig === el) { // root stands alone - out of flow collapses host to zero height
          const f = oSt.getPropertyValue('float'), p = oSt.getPropertyValue('position');
          if (f && f !== 'none') diff += 'float:none !important;';
          if (p === 'absolute' || p === 'fixed') diff += 'position:relative !important;';
          diff += 'margin:0 !important;';
        }

        if (orig.style.cssText) { // same for inline style (zoom is set inline)
          diff += (orig === el) ? orig.style.cssText.replace(/(^|;)\s*transform\s*:[^;]*/gi, '') : orig.style.cssText;
        }
        // pseudo-elements computed pass
        const pseudoBake = {};
        for (const pe of ['::before', '::after', '::placeholder', '::marker']) {
          let pSt = null; try { pSt = window.getComputedStyle(orig, pe); } catch {}
          if (!pSt) continue;
          if (pe === '::placeholder') { if (!('placeholder' in orig) || !orig.placeholder) continue; }
          else if (pe === '::marker') { if (oSt.display !== 'list-item') continue; }
          else { const c = pSt.getPropertyValue('content'); if (!c || c === 'none' || c === 'normal') continue; }
          let dPs = null; try { dPs = dNode ? iwin.getComputedStyle(dNode, pe) : null; } catch {}
          let pd = '';
          for (const p of pSt) {
            if (p.startsWith('--')) continue;
            const pv = pSt.getPropertyValue(p);
            if (!pv) continue;
            if (dPs && pv === dPs.getPropertyValue(p)) continue;
            pd += `${p}:${pv};`;
          }
          if (pd) pseudoBake[pe] = pd;
        }

        const uClass = data.clone.getAttribute('class');

        for (let m in data.media) { // media first, base after - same specificity, order decides, pseudo outranks both
          cssText += `@media ${m} {\n`;
          for (let p in data.media[m]) cssText += `  .${uClass}${p} { ${data.media[m][p]} }\n`;
          cssText += `}\n`;
        }

        if (data.css || diff) cssText += `.${uClass} { ${data.css} ${diff} }\n`;
        for (let p in data.pseudo) cssText += `.${uClass}${p} { ${data.pseudo[p]} ${pseudoBake[p] || ''} }\n`;
        for (let p in pseudoBake) if (!data.pseudo[p]) cssText += `.${uClass}${p} { ${pseudoBake[p]} }\n`;
        data.clone.removeAttribute('style');
      }

      cl.querySelectorAll('use').forEach(u => { // <use href="#id"> points at sprite left on page - carried alone renders nothing
        const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
        if (!href.startsWith('#')) return;
        const id = href.slice(1);
        let owner = u.parentElement;
        while (owner && owner.tagName.toLowerCase() !== 'svg') owner = owner.parentElement;
        if (!owner) return;
        let sel; try { sel = `[id="${CSS.escape(id)}"]`; } catch { return; }
        if (owner.querySelector(sel) || cl.querySelector(sel)) return; // already inside component
        let src = null; try { src = document.getElementById(id); } catch {}
        if (!src || el.contains(src)) return;
        // into <defs> at end - referenced <g> would paint itself twice, prepending renumbers every sibling
        let defs = owner.querySelector(':scope > defs[data-scv-sprite]');
        if (!defs) {
          defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
          defs.setAttribute('data-scv-sprite', '');
          owner.appendChild(defs);
        }
        defs.appendChild(src.cloneNode(true));
      });

      utils.notify.setStatus('snapshotting canvases');
      [cl, ...cl.querySelectorAll('canvas')].filter(n => n.tagName === 'CANVAS').forEach(cn => {
        const live = ao[ac.indexOf(cn)]; // clone never carries drawn pixels - pull bitmap from paired live node
        if (!live || live.tagName !== 'CANVAS') return;
        let dataUrl; try { dataUrl = live.toDataURL('image/png'); } catch { return; } // tainted (cross-origin draw) - leave canvas empty
        const img = document.createElement('img');
        for (const a of cn.attributes) img.setAttribute(a.name, a.value);
        img.setAttribute('src', dataUrl);
        cn.replaceWith(img);
      });

      utils.notify.setStatus('inlining assets');
      const urlRe = /url\((['"]?)(.*?)\1\)/g; // shared: ref-mode inlines fonts, normal inlines everything
      if (opts.refMode) { // quest transport - images stay absolute urls for patchbay resolve, but fonts inline
        [cl, ...cl.querySelectorAll('img')].forEach(i => { if (i.matches?.('img[src]') && !i.src.startsWith('data:')) i.setAttribute('src', i.src); });
        // srcset to absolute too - browser leaves it unresolved, so relative candidate would slip past server proxy and 404
        [cl, ...cl.querySelectorAll('img[srcset], source[srcset]')].forEach(n => {
          const v = n.getAttribute?.('srcset'); if (!v || v.includes('data:')) return;
          n.setAttribute('srcset', v.split(',').map(c => { const p = c.trim().split(/\s+/); if (p[0] && !/^data:/.test(p[0])) { try { p[0] = new URL(p[0], document.baseURI).href; } catch {} } return p.join(' '); }).join(', '));
        });
        // fonts inline even here - browser is on page, so fetch reaches session/referer-gated faces server proxy can't, matching normal harvest fidelity
        const fUrls = [...new Set(_realm.Array.from(fontCss.matchAll(urlRe), m => m[2]).filter(u => !u.startsWith('data:') && !u.startsWith('#')))];
        const fB64 = await _realm.Promise.all(fUrls.map(u => utils.toB64(u)));
        const fMap = new Map(fUrls.map((u, i) => [u, fB64[i]]));
        fontCss = fontCss.replace(urlRe, (m, q, u) => { const v = fMap.get(u); return v?.startsWith('data:') ? `url(${q}${v}${q})` : m; });
      } else {
      // fontCss counts too - left cssText to ship document-side, but urls have to inline for offline use
      const urls = [...new Set(_realm.Array.from((cssText + fontCss).matchAll(urlRe), m => m[2]).filter(u => !u.startsWith('data:') && !u.startsWith('#')))];
      // root counts as image - querySelectorAll only looks down, so harvesting <img> left src pointing home
      const imgNodes = [cl, ...cl.querySelectorAll('img')];
      (function tpls(r) { r.querySelectorAll?.('template').forEach(t => { imgNodes.push(...t.content.querySelectorAll('img')); tpls(t.content); }); })(cl);
      const imgs = imgNodes.filter(i => i.tagName === 'IMG' && i.src && !i.src.startsWith('data:'));
      // srcset outranks src, inlining src alone renders nothing - candidate list left pointing home defeats it
      const ssNodes = [];
      const takeSs = n => { const v = n.getAttribute('srcset'); if (v && !v.includes('data:')) ssNodes.push(n); };
      (function ss(r) { r.querySelectorAll?.('img[srcset], source[srcset]').forEach(takeSs);
        r.querySelectorAll?.('template').forEach(t => ss(t.content)); })(cl);
      if (cl.matches?.('img[srcset], source[srcset]')) takeSs(cl);
      const ssCands = ssNodes.map(n => n.getAttribute('srcset').split(',').map(p => p.trim()).filter(Boolean)
        .map(p => { const bits = p.split(/\s+/); return { url: bits[0], desc: bits.slice(1).join(' ') }; }));
      const ssUrls = [...new Set(ssCands.flat().map(c => c.url).filter(Boolean))];

      const [b64Urls, b64Imgs, b64Ss] = await _realm.Promise.all([
        _realm.Promise.all(urls.map(u => utils.toB64(u))),
        _realm.Promise.all(imgs.map(i => utils.toB64(i.src))),
        _realm.Promise.all(ssUrls.map(u => utils.toB64(u)))
      ]);

      const b64 = new Map(urls.map((u, i) => [u, b64Urls[i]]));
      // inlined url ships as data; would not inline = stays remote - beacon that phones home breaks offline, drop it
      const inline = t => t.replace(urlRe, (m, q, u) => {
        const v = b64.get(u);
        if (v?.startsWith('data:')) return `url(${q}${v}${q})`;
        if (/^(data:|#)/.test(u)) return m; // never fetched - local reference stays
        return 'none';
      });
      cssText = inline(cssText); fontCss = inline(fontCss);
      imgs.forEach((img, i) => img.src = b64Imgs[i]);
      const ssMap = new Map(ssUrls.map((u, i) => [u, b64Ss[i]]));
      ssNodes.forEach((n, i) => n.setAttribute('srcset',
        ssCands[i].map(c => (ssMap.get(c.url) || c.url) + (c.desc ? ' ' + c.desc : '')).join(', ')));

      // anything pointing off-origin never inlined - phones home and broken offline - strip it
      const remote = v => /^\s*(https?:)?\/\//i.test(v || '') || /^\s*\/[^/]/.test(v || '');
      const imgPlaceholder = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%23ccc'/%3E%3C/svg%3E"; // no url survives - keeps layout
      const stripNodes = [cl, ...cl.querySelectorAll('img, video, audio, source')];
      (function tpls(r) { r.querySelectorAll?.('template').forEach(t => { stripNodes.push(...t.content.querySelectorAll('img, video, audio, source')); tpls(t.content); }); })(cl);
      stripNodes.forEach(n => {
        if (n.tagName === 'IMG' || n.tagName === 'SOURCE' || n.tagName === 'VIDEO' || n.tagName === 'AUDIO') {
          if (remote(n.getAttribute('src'))) { if (n.tagName === 'IMG') n.setAttribute('src', imgPlaceholder); else n.removeAttribute('src'); }
          if (remote(n.getAttribute('srcset'))) n.removeAttribute('srcset');
          const p = n.getAttribute('poster'); if (remote(p)) n.removeAttribute('poster'); // video poster is image too
        }
      });
      }

      // embed/object always go, iframe stays only if user can see it - strip by live geometry
      for (let i = 0; i < ao.length; i++) {
        const o = ao[i], t = o.tagName || '';
        if (!ac[i]) continue;
        if (t === 'EMBED' || t === 'OBJECT') { ac[i].remove(); continue; }
        if (t !== 'IFRAME') continue;
        let hidden = false;
        try { const r = o.getBoundingClientRect(), cs = window.getComputedStyle(o);
          hidden = r.width <= 4 || r.height <= 4 || cs.display === 'none' || cs.visibility === 'hidden'; } catch {}
        if (hidden) ac[i].remove();
      }

      if (el.querySelector('scv-logic')) { // constrain live nodes to fixed-size frame and clip
        // size frame to contain every node
        let w = el.offsetWidth, h = el.offsetHeight;
        el.querySelectorAll('.comp-wrapper, scv-logic').forEach(n => {
          w = Math.max(w, (parseFloat(n.style.left) || 0) + n.offsetWidth);
          h = Math.max(h, (parseFloat(n.style.top) || 0) + n.offsetHeight);
        });
        cssText += `:host { width: ${Math.round(w)}px; height: ${Math.round(h)}px; overflow: hidden; }\n`;
      } else if (rootSt.position === 'fixed' || rootSt.position === 'absolute') { // prevents shadow host collapse to zero
        // pin :host to element's measured border box so wrapper frames true footprint and force baked root into normal flow
        const rootClass = nodeMap.get(el)?.clone.className;
        const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
        if (rootClass && w && h) {
          cssText += `.${rootClass} { position: relative !important; inset: auto !important; margin: 0 !important; }\n`;
          cssText += `:host { width: ${w}px; height: ${h}px; }\n`;
        }
      }

      const usedVars = new Set(_realm.Array.from((cssText + fontCss).matchAll(/var\(\s*(--[\w-]+)/g), m => m[1])); // only vars css reads - computed value one var already resolved, never carries var() to chase
      let varsCss = '';
      for (const [prop, val] of customProps) if (usedVars.has(prop)) varsCss += `${prop}: ${val};\n`;
      if (varsCss) cssText += `:host {\n${varsCss}}\n`;

      utils.notify.setStatus('purging scripts');
      utils.purge(cl); // re-purge - spliced-in shadow markup has not been through it

      utils.notify.setStatus('packaging component');
      const embed = t => t.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--'); // backslash first - css icon escape before backtick would corrupt def literal
      const escCss = embed(cssText);
      const escFonts = embed(fontCss);
      const escHtml = embed(cl.outerHTML);
      const tg = `scv-${uid}`;
      // source: where component was scavenged from - origin + pathname so shared harvest can't leak session tokens
      const author = (location.origin + location.pathname).replace(/-->/g, '--%3E');
      // cross-origin sheets page couldn't read - server refetches them (no cors) to recover @font-face; only in ref-mode
      const rfMarker = (opts.refMode && blockedSheets.length) ? `<!-- SCV-RF ${JSON.stringify({ s: blockedSheets, f: [...usedFonts] }).replace(/-->/g, '--%3E')} -->\n` : '';

      // shadowRoot guard keeps declarative shadow root (published artifact's live wiring) from being rebuilt over
      const fontBoot = fontCss // @font-face is inert inside shadow root, so faces we could read ship document-side
        ? `\nif(!document.getElementById('scv-fonts-${uid}')){\nconst f=document.createElement('style');\nf.id='scv-fonts-${uid}';\nf.textContent=\`${escFonts}\`;\ndocument.head.appendChild(f);\n}\n`
        : '';
      return `${rfMarker}<!-- AUTHOR: ${author} -->\n<${tg} data-scv-component></${tg}>\n<script data-scv-def>${fontBoot}\nif(!customElements.get('${tg}')){\ncustomElements.define('${tg}', class extends HTMLElement {\nconstructor() {\nsuper();\nif (this.shadowRoot) return;\nthis.attachShadow({mode: 'open'}).innerHTML = \`<style>${escCss}</style>${escHtml}\`;\n}\n});\n}\n<\/script>`;
      } finally { if (registry.freeze && !_hadFreeze) kernel.stop('freeze'); }
    },
    download: (html, name) => { // trigger file download from html string - saves extracted artifact to disk
      const blob = new Blob([`<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>scav component</title>\n<style>body { margin: 0; padding: 0; width: 100vw; height: 100vh; background-color: ${theme.backgroundSunk}; display: flex; align-items: center; justify-content: center; }</style>\n</head>\n<body>\n${html}\n</body>\n</html>`], { type: 'text/html' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url;
      a.download = `scavenge_${name}_${Date.now()}.html`;
      a.click();
      _st(() => URL.revokeObjectURL(url), 1000);
    }
  };

  kernel.harvest = async (selOrEl, opts) => { // programmatic entry - headless quest scrape drives harvest, no palette
    try {
      const html = await utils.harvest(typeof selOrEl === 'string' ? document.querySelector(selOrEl) : selOrEl, opts);
      utils.notify.finish('component harvested!', true);
      return html;
    } catch (e) { utils.notify.finish('harvest failed.', false); throw e; }
  };

  // HOVER ENGINE - caches native timing fns before freeze tool overrides them, keeping hover alive on frozen pages

  const _origRAF = window.requestAnimationFrame; // native animation frame (cached before freeze)
  const _origST  = window.setTimeout; // native timeout (cached before freeze)
  const _origSI  = window.setInterval; // native interval (cached before freeze)
  const _raf     = _origRAF.bind(window); // bound frame request (ensures proper execution context)
  const _caf     = window.cancelAnimationFrame.bind(window); // bound frame cancel (ensures proper execution context)
  const _st      = _origST.bind(window); // bound timeout (ensures proper execution context)
  const _ct      = window.clearTimeout.bind(window); // bound timeout cancel (freeze never touches clearTimeout)

  const hoverEngine = { // tracks pointer to draw spatial bounds and intercept host events without mutating page

    active:  false, // engine status - prevents redundant start/stop cycles
    ov:      null,  // spatial highlight overlay node
    lbl:     null,  // floating dimensions label node
    lastTgt: null,  // currently hovered element - prevents redundant dom reads/repaints
    frame:   null,  // active animation frame request for smooth tracking

    initNodes: () => { // lazily instantiate shared dom elements - saves footprint if hover is never used
      if (!hoverEngine.ov) {
        hoverEngine.ov = utils.createOverlay(IDS.sharedOv);
        hoverEngine.lbl = utils.createOverlay(IDS.sharedLbl);
      }
    },
    highlight: (el, show, text = null) => { // sync overlay geometry to target element and update label text
      hoverEngine.initNodes();
      if (!show || !el) {
        hoverEngine.ov.style.display = 'none';
        hoverEngine.lbl.style.display = 'none';
        return;
      }
      const r = el.getBoundingClientRect();
      hoverEngine.ov.style.display = 'block';
      hoverEngine.ov.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
      hoverEngine.ov.style.width = r.width + 'px';
      hoverEngine.ov.style.height = r.height + 'px';

      if (text) {
        hoverEngine.lbl.style.display = 'block';
        hoverEngine.lbl.innerText = text;
        hoverEngine.lbl.style.transform = `translate3d(${r.left}px, ${r.top - 24}px, 0)`;
      } else {
        hoverEngine.lbl.style.display = 'none';
      }
    },
    start: (actionFn = null) => { // arm hover tracking, bind pointer interception and setup teardown
      const prev = hoverEngine._owner;
      hoverEngine.stop();
      if (prev && prev !== kernel._starting && kernel._starting) { const pp = registry[prev]; if (pp && pp.active) kernel.stop(prev); }
      hoverEngine.active = true;
      hoverEngine._owner = kernel._starting || null;
      document.body.style.cursor = 'crosshair';
      hoverEngine.initNodes();

      kernel.bus.on('keydown', 'hover-eng', (e) => { // escape cancels snipe, enter ends - both land back on palette
        if (e.key !== 'Escape' && e.key !== 'Enter') return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        e.preventDefault();
        hoverEngine._owner ? kernel.stop(hoverEngine._owner) : hoverEngine.stop();
        if (document.getElementById('scv-min-dot')) summon(); // bring back palette
      });

      const visualParent = (tgt) => { // parent can be boxless or same size (same label) - climb past both
        const cw = Math.round(tgt.offsetWidth), ch = Math.round(tgt.offsetHeight);
        let p = tgt.parentElement;
        while (p && p.parentElement) {
          const r = p.getBoundingClientRect();
          if ((r.width || r.height) && (Math.round(p.offsetWidth) !== cw || Math.round(p.offsetHeight) !== ch)) return p;
          p = p.parentElement;
        }
        return p || tgt;
      };
      const withParentKey = (e, tgt) => (e.ctrlKey || e.metaKey) ? visualParent(tgt) : tgt;

      let lastRawTgt = null, lastX = 0, lastY = 0; // ctrl press/release alone fires no mousemove - cache point to recompute on the key event itself
      const updateHighlight = (rawTgt, ctrlActive, x, y) => {
        if (rawTgt.closest('#' + IDS.masterWrapper) || rawTgt.closest('[id^="scv-"]')) {
          hoverEngine.highlight(null, false);
          hoverEngine.lastTgt = null;
          return;
        }
        const tgt = ctrlActive ? visualParent(rawTgt) : rawTgt;
        if (tgt === hoverEngine.lastTgt) {
          hoverEngine.lbl.style.transform = `translate3d(${x + 15}px, ${y + 15}px, 0)`;
          return;
        }
        hoverEngine.lastTgt = tgt;
        if (hoverEngine.frame) _ct(hoverEngine.frame);
        hoverEngine.frame = _st(() => hoverEngine.highlight(tgt, true, `${Math.round(tgt.offsetWidth)} × ${Math.round(tgt.offsetHeight)}`), 16);
      };

      kernel.bus.on('mousemove', 'hover-eng', (e) => {
        lastRawTgt = e.target; lastX = e.clientX; lastY = e.clientY;
        updateHighlight(e.target, e.ctrlKey || e.metaKey, e.clientX, e.clientY);
      });

      kernel.bus.on('keydown', 'hover-eng', (e) => { // ctrl held over a static cursor still needs the parent swap to land
        if ((e.key === 'Control' || e.key === 'Meta') && lastRawTgt) updateHighlight(lastRawTgt, true, lastX, lastY);
      });
      kernel.bus.on('keyup', 'hover-eng', (e) => { // and revert the instant it's released, static cursor or not
        if ((e.key === 'Control' || e.key === 'Meta') && lastRawTgt) updateHighlight(lastRawTgt, false, lastX, lastY);
      });

      if (actionFn) {
        kernel.bus.on('click', 'hover-eng', (e) => {
          if (e.target.closest('#' + IDS.masterWrapper) || e.target.closest('[id^="scv-"]')) return;
          e.preventDefault();
          e.stopPropagation();
          actionFn(withParentKey(e, e.target));
        }, 100);
        // swallow press events on page while sniping so pick works but page can't react
        const isOurs = t => t && t.closest && (t.closest('#' + IDS.masterWrapper) || t.closest('[id^="scv-"]'));
        hoverEngine._blockers = ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].map(ev => {
          const fn = e => { if (isOurs(e.target)) return; e.preventDefault(); e.stopImmediatePropagation(); };
          document.addEventListener(ev, fn, true);
          return { ev, fn };
        });
      }
    },
    stop: () => { // disarm tracking, clear dom bindings and hide overlays
      hoverEngine.active = false;
      hoverEngine._owner = null;
      hoverEngine.lastTgt = null;
      if (hoverEngine.frame) _ct(hoverEngine.frame);
      document.body.style.cursor = '';
      kernel.bus.offAll('hover-eng');
      (hoverEngine._blockers || []).forEach(({ ev, fn }) => document.removeEventListener(ev, fn, true));
      hoverEngine._blockers = [];
      hoverEngine.highlight(null, false);
    }
  };

  // TOOLS - each block registers userland process with start/stop lifecycles

  kernel.register({ // xray - visualizes dom depth via color coded crosshairs
    id:         'xray',
    label:      '[dom & grids] x-ray center',
    category:   'DOM & GRIDS',
    type:       'cycle',
    options:   ['full', 'top', 'mid', 'bot'],
    defaultVal: 'full',
    start: (val) => { // traverse document and draw bounding boxes color-coded by node depth
      const m = val === 'top' ? [1, 4] : val === 'mid' ? [5, 8] : val === 'bot' ? [9, 12] : [1, 8];
      utils.createSpatialOverlay(IDS.xray, frag => {
        const bandCls = n => n <= 4 ? 'scv-xray-top' : n <= 8 ? 'scv-xray-mid' : 'scv-xray-deep';
        const walk = (el, d) => { // recursively walk dom tree, skipping system nodes and evaluating depth bands
          // svg elements report lowercase tagName
          if (d > m[1] || el.id?.includes('scv-') || ['SCRIPT', 'STYLE', 'SVG', 'PATH'].includes(el.tagName.toUpperCase())) return;
          const r = el.getBoundingClientRect();
          if (r.width > 5 && r.height > 5 && d >= m[0]) {
            const h = document.createElement('div'), v = document.createElement('div');
            h.className = v.className = `scv-xray-line ${bandCls(d)}`;
            h.style.cssText = `height: 1px; width: ${r.width}px; transform: translate3d(${r.left + window.scrollX}px, ${r.top + window.scrollY + r.height / 2}px, 0)`;
            v.style.cssText = `width: 1px; height: ${r.height}px; transform: translate3d(${r.left + window.scrollX + r.width / 2}px, ${r.top + window.scrollY}px, 0)`;
            frag.append(h, v);
          }
          for (let i = 0; i < el.children.length; i++) walk(el.children[i], d + 1);
        };
        walk(document.body, 1);
      });
    },
    stop: () => utils.unmount(IDS.xray) // purge spatial overlay from dom
  });

  kernel.register({ // sniper - deletes clicked elements sequentially until aborted
    id: 'el-sniper',
    label: '[elements] delete',
    category: 'ELEMENTS',
    type: 'toggle',
    start: () => hoverEngine.start((tgt) => { tgt.remove(); }),
    stop: () => hoverEngine.stop() // escape stops it and brings palette back
  });

  kernel.register({ // harvester - copies scavenged standalone component of clicked element
    id: 'harvester',
    label: '[scavenge] harvest',
    category: 'SCAVENGE',
    type: 'toggle',
    start: () => hoverEngine.start(async (tgt) => {
      kernel.stop('harvester');
      try {
        await utils.copy(await utils.harvest(tgt));
        utils.notify.finish('component harvested to clipboard!', true);
      } catch { utils.notify.finish('failed.', false); }
    }),
    stop: () => hoverEngine.stop()
  });

  kernel.register({ // quest selector - copies stable css selector for clicked element
    id: 'quest-sel',
    label: '[scavenge] quest selector',
    category: 'SCAVENGE',
    type: 'toggle',
    start: () => hoverEngine.start(async (tgt) => {
      kernel.stop('quest-sel');
      try {
        await utils.copy(`${window.location.href}, ${utils.getSelector(tgt)}`);
        utils.notify.finish('quest selected!', true);
      } catch { utils.notify.finish('failed.', false); }
    }),
    stop: () => hoverEngine.stop()
  });

  let qsCleanup = null; // scroll/resize reposition teardown, cleared in stop()
  let qsSeed    = null; // steps carried across an "add step" re-snipe (see finalize/showMenu)
  kernel.register({ // quest steps - records multi-step interaction pipeline ending in an extraction
    id: 'quest-steps',
    label: '[scavenge] quest steps',
    category: 'SCAVENGE',
    type: 'toggle',
    start: () => {
      const seq = []; // [{ sel, el, badge }]  - this session's picks
      const carried = Array.isArray(qsSeed) ? qsSeed : []; // steps from prior "add step"
      qsSeed = null;

      const reposition = () => seq.forEach(s => { // badges are fixed but re-placed from element's live rect
        if (!s.badge) return;
        const r = s.el.getBoundingClientRect();
        s.badge.style.left = Math.max(2, r.left) + 'px';
        s.badge.style.top = Math.max(2, r.top) + 'px';
      });

      const drawBadges = () => { // re-draw every badge from seq, numbered past carried steps
        document.querySelectorAll('[id^="scv-qs-step-"]').forEach(el => utils.unmount(el.id));
        seq.forEach((step, i) => {
          const num = carried.length + i + 1;
          const r = step.el.getBoundingClientRect();
          const el = utils.createOverlay(`scv-qs-step-${i}`, 'scv-qs-badge');
          el.style.left = Math.max(2, r.left) + 'px';
          el.style.top = Math.max(2, r.top) + 'px';
          el.textContent = num;
          el.title = 'delete this step';
          el.onmouseenter = () => { el.textContent = '✕'; };
          el.onmouseleave = () => { el.textContent = num; };
          el.onclick = e => { e.preventDefault(); e.stopPropagation(); seq.splice(i, 1); drawBadges(); };
          step.badge = el;
        });
      };

      const showMenu = (segs) => { // picks > editable pipeline segments (default: click each, extract last) in shared viewer
        const VERBS = ['click', 'wait sel', 'wait ms', 'scroll', 'type', 'drag', 'sel', 'key', 'ls', 'component']; // wait sel + wait ms both emit wait: - only arg differs (selector vs number); component harvests the whole element, not a value
        const seg2str = x => x.verb === 'type' ? `type:${x.arg}=${x.text || ''}` // two-field verbs stitch primary + second: type>type:sel=text, drag>drag:from=>to
          : x.verb === 'drag' ? `drag:${x.arg}=>${x.text || ''}`
          : x.verb === 'component' ? `harvest:${x.arg}` // whole component, not a value - the server harvests it in ref-mode
          : `${(x.verb === 'wait sel' || x.verb === 'wait ms') ? 'wait' : x.verb}:${x.arg}`;
        const serialize = () => `${window.location.href}, ${segs.map(seg2str).join(' | ')}`;
        const opt = (v, label, sel) => `<option value="${utils.esc(v)}"${sel ? ' selected' : ''}>${utils.esc(label)}</option>`;

        const argControl = (s, i) => { // primary field = what verb points at; type adds a text field, drag a re-snipe button for drop target
          const ph = s.verb === 'wait ms' ? 'ms' : s.verb === 'wait sel' ? 'selector to wait for'
            : s.verb === 'key' ? 'json.path' : s.verb === 'ls' ? 'localStorageKey.json.path'
            : s.verb === 'drag' ? 'drag from (selector)' : 'CSS selector';
          let out = `<input data-i="${i}" class="scv-qs-arg" placeholder="${ph}" value="${utils.esc(s.arg)}" />`;
          if (s.verb === 'type') out += `<input data-i="${i}" class="scv-qs-text" placeholder="text to type" value="${utils.esc(s.text)}" />`;
          else if (s.verb === 'drag') out += `<button data-i="${i}" class="scv-qs-to">${s.text ? utils.esc('→ ' + s.text) : '＋ pick drop target'}</button>`;
          return out;
        };
        const rowHtml = (s, i) =>
          `<div class="scv-qs-row">`
          + `<span class="scv-qs-num">${String(i + 1).padStart(2, '0')}</span>`
          + `<select data-i="${i}" class="scv-qs-verb scv-select">` + VERBS.map(v => opt(v, v, v === s.verb)).join('') + `</select>`
          + argControl(s, i)
          + `<button data-i="${i}" class="scv-qs-del" title="delete step">×</button>`
          + `</div>`;

        // render config in shared viewer (summon, palette minimized) - supplies ×/title chrome + scroll
        const node = document.createElement('div');
        utils.setHTML(node, // line built is the point - reads first, steps produced after
          `<textarea id="scv-qs-out" class="scv-textarea" spellcheck="false"></textarea>`
          + `<div id="scv-qs-rows"></div>`
          + `<div class="scv-qs-actions">`
          + `<button class="scv-btn scv-qs-btn" id="scv-qs-add">+ step</button>`
          + `<button class="scv-btn scv-qs-btn" id="scv-qs-wait">+ wait</button>`
          + `<span class="scv-flex-1"></span>`
          + `<button class="scv-btn scv-qs-btn" id="scv-qs-test">copy as test</button>`
          + `<button class="scv-btn scv-qs-btn" id="scv-qs-copy">extract</button>`
          + `</div>`);
        kernel.summon();
        kernel.showView('[scavenge] quest steps', node);
        const out = node.querySelector('#scv-qs-out'), rows = node.querySelector('#scv-qs-rows');
        const refresh = () => { out.value = serialize(); };
        const pickTo = (i) => { // drag drop target - hide menu, snipe one element into segs[i].text, restore; esc cancels
          const view = document.getElementById('scv-view');
          view.style.display = 'none'; // hide viewer so page is clear for pick
          const restore = () => { if (view.isConnected) { view.style.display = 'block'; renderRows(); } };
          const esc = e => { if (e.key === 'Escape') { document.removeEventListener('keydown', esc, true); hoverEngine.stop(); restore(); } };
          document.addEventListener('keydown', esc, true);
          hoverEngine.start(tgt => { document.removeEventListener('keydown', esc, true); hoverEngine.stop(); segs[i].text = utils.getSelector(tgt); restore(); });
        };
        const renderRows = () => {
          utils.setHTML(rows, segs.map(rowHtml).join(''));
          // verb change keeps arg, re-renders so type/drag second field appears/disappears
          rows.querySelectorAll('.scv-qs-verb').forEach(el => el.onchange = () => { segs[+el.dataset.i].verb = el.value; renderRows(); });
          rows.querySelectorAll('.scv-qs-arg').forEach(el => { const h = () => { segs[+el.dataset.i].arg = el.value; refresh(); }; el.oninput = h; el.onchange = h; });
          rows.querySelectorAll('.scv-qs-text').forEach(el => { const h = () => { segs[+el.dataset.i].text = el.value; refresh(); }; el.oninput = h; el.onchange = h; });
          rows.querySelectorAll('.scv-qs-to').forEach(el => el.onclick = () => pickTo(+el.dataset.i));
          rows.querySelectorAll('.scv-qs-del').forEach(el => el.onclick = () => { segs.splice(+el.dataset.i, 1); renderRows(); });
          refresh();
        };
        renderRows();
        const rowCp = node.querySelector('#scv-qs-copy');
        const doCopy = async (btn, orig, done) => { await utils.copy(out.value); btn.textContent = done; _st(() => { btn.textContent = orig; }, 1200); }; // same-footprint confirm + rev, copy never resizes
        node.querySelector('#scv-qs-add').onclick = () => { qsSeed = segs; kernel.minimize(); kernel.start('quest-steps'); }; // "+ step" re-enters pick flow with current segs - minimize, restart tool
        node.querySelector('#scv-qs-wait').onclick = () => { segs.push({ verb: 'wait ms', arg: '', text: '' }); renderRows(); };
        rowCp.onclick = () => doCopy(rowCp, 'extract', 'extracted!');
        const testCp = node.querySelector('#scv-qs-test'); // "copy as test" --run entry, expect pre-filled from extraction's live text at pick time
        testCp.onclick = async () => {
          const ext = segs[segs.length - 1] || {};
          const entry = { line: out.value };
          if (ext.val) entry.expect = ext.val; // else test just asserts non-empty value
          await utils.copy(JSON.stringify(entry, null, 2));
          testCp.textContent = 'extracted!'; _st(() => { testCp.textContent = 'copy as test'; }, 1200);
        };
        // viewer's own × closes back to palette - no bespoke close needed
      };

      const finalize = () => {
        const picks = seq.slice();
        kernel.stop('quest-steps'); // tears down badges, tick button and listeners
        if (!picks.length && !carried.length) return;
        // carried steps keep verbs; fresh picks default to click, last pick is extraction if none carried
        const fresh = picks.map((s, i) => ({ verb: (!carried.length && i === picks.length - 1) ? 'sel' : 'click', arg: s.sel, text: '', val: s.val }));
        showMenu([...carried, ...fresh]);
      };

      // bottom-centre finalize - ✓ that also answers enter
      const fin = utils.createOverlay('scv-qs-finalize', 'scv-qs-finalize');
      fin.textContent = '✓';
      fin.title = 'finalize (enter)';
      fin.onclick = finalize;

      kernel.bus.on('keydown', 'quest-steps', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        if (e.key === 'Backspace') { e.preventDefault(); seq.pop(); drawBadges(); }
        else if (e.key === 'Enter') { e.preventDefault(); finalize(); }
      });

      window.addEventListener('scroll', reposition, true); // capture > catches nested scrollers too
      window.addEventListener('resize', reposition);
      qsCleanup = () => { window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition); };

      hoverEngine.start((tgt) => {
        seq.push({ sel: utils.getSelector(tgt), el: tgt, val: (tgt.textContent || '').trim().slice(0, 200) }); // val: live text, for "copy as test"
        drawBadges(); // redraw so numbering (past carried) stays correct
      });
    },
    stop: () => {
      hoverEngine.stop();
      if (qsCleanup) { qsCleanup(); qsCleanup = null; }
      document.querySelectorAll('[id^="scv-qs-step-"]').forEach(el => utils.unmount(el.id));
      utils.unmount('scv-qs-finalize'); // finalize menu persists until closed
    }
  });

  // live emit - bypasses headless auth using active tab as scraper via mutationobserver, posting changes to server
  let qeToken      = '';
  let qeApi        = 'http://127.0.0.1:9876';
  const qeWatchers = []; // active observers - { el, sel, channel, token, api, observer, badge, reposition }

  kernel._destroyHooks.push(() => qeWatchers.slice().forEach(qeStop)); // watchers outlive tool but die with kernel

  function qeEmit(w, value) { // post watcher event to quests server
    return fetch(`${w.api}/quests/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'scv-token': w.token },
      body: JSON.stringify({ channel: w.channel, value }),
    }).then(r => { // 403 = token no longer authorizes (server restarted) - stop watcher and notify
      if (r.status === 403) {
        if (w.badge) { w.badge.classList.add('scv-bad'); w.badge.title = 'live-emit stopped: token rejected (restart? re-pick with new token)'; }
        qeStop(w, true); // keepBadge - leave red dot so failure stays visible
        return;
      }
      if (w.badge) w.badge.classList.toggle('scv-bad', !r.ok); // transient error - keep trying
    }).catch(() => { if (w.badge) w.badge.classList.add('scv-bad'); });
  }

  function qeStop(w, keepBadge) { // disconnect watcher and remove badge
    w.stopped = true;
    try { w.observer.disconnect(); } catch {}
    _ct(w._t); // drop debounce pending from mutation in last 300ms, else it emits after stop
    window.removeEventListener('scroll', w.reposition, true);
    window.removeEventListener('resize', w.reposition);
    if (w.badge && !keepBadge) utils.unmount(w.badge.id);
    const i = qeWatchers.indexOf(w); if (i >= 0) qeWatchers.splice(i, 1);
  }

  function qeWatch(el, sel, channel, token, api) { // attach mutation observer watcher
    qeToken = token; qeApi = api; // remember for next pick this session
    const w = { el, sel, channel, token, api };
    w.badge = utils.createOverlay(`scv-qe-${Math.random().toString(36).slice(2, 8)}`, 'scv-qe-badge');
    w.badge.title = `live-emit → ${channel} (click to stop)`;
    w.reposition = () => { const r = el.getBoundingClientRect(); w.badge.style.left = Math.max(2, r.left) + 'px'; w.badge.style.top = Math.max(2, r.top) + 'px'; };
    w.reposition();
    window.addEventListener('scroll', w.reposition, true);
    window.addEventListener('resize', w.reposition);
    w._t = null; // debounce fast mutations (on w so qeStop can cancel pending one)
    w.stopped = false;
    w.observer = new MutationObserver(() => { if (w.stopped) return; _ct(w._t); w._t = _st(() => qeEmit(w, (el.textContent || '').trim()), 300); });
    w.observer.observe(el, { subtree: true, childList: true, characterData: true });
    w.badge.onclick = () => qeStop(w);
    qeWatchers.push(w);
    qeEmit(w, (el.textContent || '').trim()); // emit current value immediately
  }

  function qeConfig(el, sel) { // render watcher config panel inside viewer
    const field = (id, label, val, ph) => `<label class="scv-qe-label">${label}</label>`
      + `<input id="${id}" class="scv-qe-input" value="${utils.esc(val)}" placeholder="${ph || ''}" />`;
    const node = document.createElement('div'); node.className = 'scv-qe-panel'; // build config as content and render in shared viewer
    utils.setHTML(node,
      `<div class="scv-qe-sel">selector: ${utils.esc(sel)}</div>`
      + field('scv-qe-ch', 'channel', '', 'channel name')
      + field('scv-qe-tok', 'scv-token (from quests tui / startup log)', qeToken, 'paste token')
      + field('scv-qe-api', 'quest api', qeApi, 'http://127.0.0.1:9876')
      + `<div class="scv-qe-actions"><button class="scv-btn" id="scv-qe-go">watch</button></div>`);
    kernel.summon();
    kernel.showView('[scavenge] quest live-emit', node);
    const v = id => node.querySelector(`#${id}`).value.trim();
    node.querySelector('#scv-qe-go').onclick = () => {
      const ch = v('scv-qe-ch'), tok = v('scv-qe-tok'), api = (v('scv-qe-api') || 'http://127.0.0.1:9876').replace(/\/+$/, '');
      if (!ch || !tok) { const bad = node.querySelector(!ch ? '#scv-qe-ch' : '#scv-qe-tok'); bad.classList.add('scv-bad'); bad.focus(); return; }
      qeWatch(el, sel, ch, tok, api);
      kernel.hideView();
    }; // viewer's X icon closes back to palette
  }

  kernel.register({ // quest live-emit - attaches mutation observer to stream live text changes to quest server
    id: 'quest-emit',
    label: '[scavenge] quest live-emit',
    category: 'SCAVENGE',
    type: 'toggle',
    start: () => hoverEngine.start((tgt) => { kernel.stop('quest-emit'); qeConfig(tgt, utils.getSelector(tgt)); }),
    stop: () => hoverEngine.stop(), // watchers persist past tool
  });

  kernel.register({ // element size - enables pointer inspection of element dimensions
    id: 'el-size',
    label: '[elements] size',
    category: 'ELEMENTS',
    type: 'toggle',
    start: () => hoverEngine.start(),
    stop: () => hoverEngine.stop()
  });

  // CHANNEL EDITOR - snipe element and edit its wiring attributes

  const WIRE_ATTRS = [
    { attr: 'data-scv-emits',    label: 'emits',    ph: 'channel names' },
    { attr: 'data-scv-receives', label: 'receives', ph: 'channel names' },
    { attr: 'data-scv-action',   label: 'action',   ph: 'verb:channel' },
  ];

  function openWirePanel(tgt) { // show wiring panel anchored to target element
    const el = tgt.closest('scv-logic, .comp-wrapper, [data-scv-id]') || tgt;
    const r = el.getBoundingClientRect();
    const panel = utils.createOverlay(IDS.wirePanel);
    panel.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 110, window.innerWidth - 236)) + 'px'; // centred on target, not hung off corner
    panel.style.top = Math.max(8, Math.min(r.top + r.height / 2 - 88, window.innerHeight - 184)) + 'px';

    WIRE_ATTRS.forEach((f, i) => {
      const row = document.createElement('label');
      row.className = 'scv-wire-row';
      row.textContent = f.label;
      const inp = document.createElement('input');
      inp.className = 'scv-wire-input';
      inp.placeholder = f.ph;
      inp.spellcheck = false;
      inp.autocomplete = 'off';
      inp.value = el.getAttribute(f.attr) || '';
      inp.addEventListener('input', () => { // live write-through - non empty value sets attr, empty removes it
        const v = inp.value.trim();
        if (v) el.setAttribute(f.attr, v); else el.removeAttribute(f.attr);
      });
      row.appendChild(inp);
      panel.appendChild(row);
      if (i === 0) _st(() => inp.focus(), 0);
    });

    // keep panel's pointer/keyboard activity from reaching snipe, host page or global shortcuts
    ['pointerdown', 'mousedown'].forEach(ev => panel.addEventListener(ev, e => e.stopPropagation()));
    panel.addEventListener('keydown', e => { // enter commits and lands back on palette, escape backs out of field first
      if (e.key === 'Escape' && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) { e.stopPropagation(); e.preventDefault(); e.target.blur(); return; }
      if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); kernel.stop('wiring'); summon(); return; }
      e.stopPropagation();
    });
    hoverEngine.highlight(el, true, el.dataset.type || el.tagName.toLowerCase());
  }

  kernel.register({ // wiring channels - display and edit patchbay channel attributes
    id: 'wiring',
    label: '[scavenge] wiring channels',
    category: 'SCAVENGE',
    type: 'toggle',
    start: () => hoverEngine.start(openWirePanel),
    stop: () => { hoverEngine.stop(); utils.unmount(IDS.wirePanel); }
  });

  kernel.register({ // text edit - toggles document design mode for direct text mutation
    id: 'el-write',
    label: '[elements] text edit',
    category: 'ELEMENTS',
    type: 'toggle',
    start: () => {
      document.body.contentEditable = 'true';
      document.designMode = 'on';
      const w = document.getElementById(IDS.masterWrapper);
      if (w) w.contentEditable = 'false';
    },
    stop: () => {
      document.body.contentEditable = 'false';
      document.designMode = 'off';
      const w = document.getElementById(IDS.masterWrapper);
      if (w) w.contentEditable = '';
    }
  });

  kernel.register({ // image flip - rotates media elements by 45deg incrementally
    id: 'img-flip',
    label: '[elements] image flip',
    category: 'ELEMENTS',
    type: 'oneshot',
    start: () => {
      const a = parseInt(document.body.dataset.scvFlip || 0) + 45;
      const wrap = a % 360 === 0;
      document.querySelectorAll('img, video, svg').forEach(el => {
        if (!el.dataset.scvBaseTransform) {
          el.dataset.scvBaseTransform = el.style.transform || '';
          el.dataset.scvBaseTransition = el.style.transition || '';
        }
        const base = el.dataset.scvBaseTransform;
        el.style.transform = wrap ? base : `${base} rotate(${a}deg)`;
        el.style.transition = wrap ? el.dataset.scvBaseTransition : 'transform 0.3s ease';
      });
      document.body.dataset.scvFlip = a;
    }
  });

  const drawGrid = (isH, remSize) => { // draws an overlay of horizontal or vertical grid lines
    const p = remSize * remPx;
    if (p <= 0) return;

    utils.createSpatialOverlay(`scv-grid-${isH ? 'h' : 'v'}`, frag => {
      const limit = Math.floor((isH ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) : Math.max(document.body.scrollWidth, document.documentElement.scrollWidth)) / p);
      for (let j = 0; j < limit; j++) {
        const l = document.createElement('div');
        l.className = `scv-grid-line ${isH ? 'scv-grid-line-h' : 'scv-grid-line-v'}`;
        l.style.transform = isH ? `translate3d(0, ${j * p}px, 0)` : `translate3d(${j * p}px, 0, 0)`;
        frag.appendChild(l);
      }
    });
  };

  kernel.register({ // h-grid - draws horizontal grid lines
    id: 'grid-h',
    label: '[dom & grids] h-grid',
    category: 'DOM & GRIDS',
    type: 'param',
    defaultVal: 5,
    start: (val) => drawGrid(true, parseFloat(val) || 5),
    stop: () => utils.unmount('scv-grid-h')
  });

  kernel.register({ // v-grid - draws vertical grid lines
    id: 'grid-v',
    label: '[dom & grids] v-grid',
    category: 'DOM & GRIDS',
    type: 'param',
    defaultVal: 5,
    start: (val) => drawGrid(false, parseFloat(val) || 5),
    stop: () => utils.unmount('scv-grid-v')
  });

  const createLineTool = (type) => ({ // factory for infinite draggable crosshair lines pinned on click
    id: `${type}-line`,
    label: `[dom & grids] ${type}-line`,
    category: 'DOM & GRIDS',
    type: 'toggle',
    start: () => {
      const l = utils.createOverlay(`scv-temp-${type}`, 'scv-temp-line');
      let lineFrame;
      kernel.bus.on('mousemove', `${type}-line`, e => {
        if (lineFrame) _caf(lineFrame);
        lineFrame = _raf(() => {
          if (type === 'v') {
            l.style.transform = `translate3d(${e.clientX + window.scrollX}px, 0, 0)`;
            l.style.width = '1px';
            l.style.height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) + 'px';
          } else {
            l.style.transform = `translate3d(0, ${e.clientY + window.scrollY}px, 0)`;
            l.style.height = '1px';
            l.style.width = '100%';
          }
        });
      });
      kernel.bus.on('click', `${type}-line`, e => {
        if (e.target.closest(`#${IDS.masterWrapper}`) || e.target.id?.includes('scv-')) return;
        e.preventDefault();
        e.stopPropagation();
        const f = l.cloneNode();
        f.id = '';
        f.classList.add('scv-pinned-line'); // clone keeps .scv-temp-line's look - this re-enables interaction
        f.ondblclick = () => utils.unmount(f);
        utils.mount(f);
        kernel.stop(`${type}-line`);
      }, 100);
    },
    stop: () => {
      kernel.bus.offAll(`${type}-line`);
      utils.unmount(`scv-temp-${type}`);
    }
  });

  kernel.register(createLineTool('v'));
  kernel.register(createLineTool('h'));

  kernel.register({ // layout colors - assigns high-contrast random backgrounds to all elements to reveal box models
    id: 'layout-colors',
    label: '[dom & grids] box-layout',
    category: 'DOM & GRIDS',
    type: 'toggle',
    start: () => Array.from(document.querySelectorAll('*')).forEach(el => {
      if (el.closest(`#${IDS.masterWrapper}`) || el.id?.includes('scv-')) return;
      el.dataset.scvBg = el.style.backgroundColor || '';
      el.dataset.scvCol = el.style.color || '';
      const bg = `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`;
      el.style.backgroundColor = bg;
      el.style.color = (parseInt(bg.slice(1, 3), 16) * 299 + parseInt(bg.slice(3, 5), 16) * 587 + parseInt(bg.slice(5, 7), 16) * 114) / 1000 >= 128 ? '#000' : '#FFF';
    }),
    stop: () => Array.from(document.querySelectorAll('*')).forEach(el => {
      if (el.closest(`#${IDS.masterWrapper}`) || el.id?.includes('scv-')) return;
      if (typeof el.dataset.scvBg !== 'undefined') el.style.backgroundColor = el.dataset.scvBg;
      if (typeof el.dataset.scvCol !== 'undefined') el.style.color = el.dataset.scvCol;
      delete el.dataset.scvBg;
      delete el.dataset.scvCol;
      if (!el.getAttribute('style')) el.removeAttribute('style');
    })
  });

  kernel.register({ // blur - toggles 5px blur filter on document body
    id: 'blur',
    label: '[effects] blur',
    category: 'EFFECTS',
    type: 'toggle',
    start: () => { if (!(document.body.style.filter || '').includes('blur(5px)')) { document.body.style.filter = (document.body.style.filter || '') + ' blur(5px)'; document.body.dataset.scvBlur = '1'; } },
    stop: () => { if (document.body.dataset.scvBlur) { document.body.style.filter = (document.body.style.filter || '').replace(/blur\(5px\)/ig, '').trim(); delete document.body.dataset.scvBlur; } }
  });

  kernel.register({ // grayscale - toggles 100% grayscale filter on document body
    id: 'grayscale',
    label: '[effects] grayscale',
    category: 'EFFECTS',
    type: 'toggle',
    start: () => { if (!(document.body.style.filter || '').includes('grayscale(100%)')) { document.body.style.filter = (document.body.style.filter || '') + ' grayscale(100%)'; document.body.dataset.scvGray = '1'; } },
    stop: () => { if (document.body.dataset.scvGray) { document.body.style.filter = (document.body.style.filter || '').replace(/grayscale\(100\%\)/ig, '').trim(); delete document.body.dataset.scvGray; } }
  });

  kernel.register({ // log fonts - extracts loaded font families
    id: 'log-fonts',
    label: '[prints] fonts',
    category: 'PRINTS',
    type: 'oneshot',
    start: () => Array.from(document.fonts.keys()).map(f => f.family).join('\n') || 'no fonts found'
  });

  kernel.register({ // log global - dumps window object properties
    id: 'log-global',
    label: '[prints] props',
    category: 'PRINTS',
    type: 'oneshot',
    start: () => Object.getOwnPropertyNames(window).join('\n')
  });

  kernel.register({ // storage dump - extracts local/session storage and cookies
    id: 'storage-dump',
    label: '[prints] storage',
    category: 'PRINTS',
    type: 'oneshot',
    start: () => {
      const dump = store => { try { const o = {}; for (let i = 0; i < store.length; i++) { const k = store.key(i); o[k] = store.getItem(k); } return o; } catch (e) { return `(${e.message})`; } };
      const cookies = {};
      document.cookie.split('; ').filter(Boolean).forEach(c => { const i = c.indexOf('='); const k = i === -1 ? c : c.slice(0, i); try { cookies[k] = i === -1 ? '' : decodeURIComponent(c.slice(i + 1)); } catch {} });
      return JSON.stringify({ localStorage: dump(localStorage), sessionStorage: dump(sessionStorage), cookies }, null, 2);
    }
  });

  kernel.register({ // meta harvest - extracts page title, meta tags, and ld+json schemas
    id: 'meta-harvest',
    label: '[prints] metadata',
    category: 'PRINTS',
    type: 'oneshot',
    start: () => {
      const out = { title: document.title };
      const meta = {};
      document.querySelectorAll('meta[content]').forEach(m => {
        const k = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('itemprop');
        if (k) meta[k] = m.getAttribute('content');
      });
      if (Object.keys(meta).length) out.meta = meta;
      const ld = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
        try { ld.push(JSON.parse(s.textContent)); } catch {}
      });
      if (ld.length) out['ld+json'] = ld;
      return JSON.stringify(out, null, 2);
    }
  });

  kernel.register({ // capture zone - draws bounding box to capture screenshot via getDisplayMedia
    id: 'capture-zone',
    label: '[prints] capture image',
    category: 'PRINTS',
    type: 'toggle',
    start: () => {
      const ov = utils.createOverlay(IDS.capOv);
      const box = utils.createOverlay(IDS.capBox, '', ov);
      let sX = 0, sY = 0, drag = false, capFrame;

      kernel.bus.on('keydown', 'capture-zone', e => { if (e.key === 'Escape') { kernel.stop('capture-zone'); if (document.getElementById('scv-min-dot')) summon(); } }); // esc cancels zone - palette minimized while active, bring back

      kernel.bus.on('mousedown', 'capture-zone', e => {
        sX = e.clientX;
        sY = e.clientY;
        drag = true;
        box.style.transform = `translate3d(${sX}px, ${sY}px, 0)`;
        box.style.width = '0px';
        box.style.height = '0px';
        box.style.display = 'block';
      }, 100);

      kernel.bus.on('mousemove', 'capture-zone', e => {
        if (!drag) return;
        if (capFrame) _caf(capFrame);
        capFrame = _raf(() => {
          box.style.transform = `translate3d(${Math.min(sX, e.clientX)}px, ${Math.min(sY, e.clientY)}px, 0)`;
          box.style.width = Math.abs(sX - e.clientX) + 'px';
          box.style.height = Math.abs(sY - e.clientY) + 'px';
        });
      });

      kernel.bus.on('mouseup', 'capture-zone', async () => {
        if (!drag) return;
        drag = false;
        const w = parseInt(box.style.width), h = parseInt(box.style.height);
        const mat = new DOMMatrixReadOnly(box.style.transform);
        const ax = mat.m41, ay = mat.m42;
        ov.style.cursor = 'wait';

        if (w > 5 && h > 5) {
          (async () => {
            let stream;
            try {
              stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
              const video = document.createElement('video');
              video.srcObject = stream;
              await video.play();
              await new Promise(r => _raf(r));
              const c = document.createElement('canvas');
              c.width = w;
              c.height = h;
              c.getContext('2d').drawImage(video, ax, ay, w, h, 0, 0, w, h);
              const a = document.createElement('a');
              a.href = c.toDataURL();
              a.download = 'capture.png';
              a.click();
            } catch (err) {
              console.warn('capture cancelled', err);
            } finally {
              if (stream) stream.getTracks().forEach(t => t.stop());
            }
            kernel.stop('capture-zone');
          })();
        } else {
          kernel.stop('capture-zone');
        }
      });
    },
    stop: () => utils.unmount(IDS.capOv)
  });

  kernel.register({ // screen record - captures video stream of screen/window to webm via MediaRecorder
    id: 'screen-record',
    label: '[prints] capture video',
    category: 'PRINTS',
    type: 'toggle',
    start: async () => {
      const wrap = document.getElementById(IDS.masterWrapper);
      const orig = wrap ? wrap.style.display : '';
      const token = (kernel.processes['screen-record']._recToken = (kernel.processes['screen-record']._recToken || 0) + 1);
      let stream;
      try {
        if (wrap) wrap.style.display = 'none';
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
        if (!registry['screen-record']?.active || kernel.processes['screen-record']._recToken !== token) { stream.getTracks().forEach(t => t.stop()); if (wrap) wrap.style.display = orig; return; }
        const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
        const chunks = [];

        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        mediaRecorder.onstop = () => {
          const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = 'capture.webm';
          a.click();
          _st(() => URL.revokeObjectURL(url), 1000);
          kernel.stop('screen-record');
        };

        mediaRecorder.start();
        if (wrap) wrap.style.display = orig;

        const ui = utils.createOverlay(IDS.recUi);
        utils.setHTML(ui, `<div class="scv-rec-label">rec</div><button class="scv-rec-stop">&#9632;</button>`);
        ui.querySelector('.scv-rec-stop').onclick = () => {
          mediaRecorder.stop();
          stream.getTracks().forEach(t => t.stop());
        };

        kernel.processes['screen-record']._teardown = () => {
          if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
          stream.getTracks().forEach(t => t.stop());
          utils.unmount(IDS.recUi);
        };

        const vt = stream.getVideoTracks();
        if (vt[0]) vt[0].onended = () => {
          if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        };
      } catch {
        if (stream) stream.getTracks().forEach(t => t.stop()); // mid-setup throw (eg Safari's MediaRecorder) must not leak share stream
        if (wrap) wrap.style.display = orig;
        kernel.stop('screen-record');
      }
    },
    stop: () => {
      kernel.processes['screen-record']._recToken = (kernel.processes['screen-record']._recToken || 0) + 1;
      utils.unmount(IDS.recUi);
    }
  });

  kernel.register({ // scavenge tree - interactive spatial dom inspector with filterable event and class views
    id: 'scavenge-tree',
    label: '[scavenge] tree',
    category: 'SCAVENGE',
    type: 'oneshot',
    start: () => {
      const allEvents = new Set(), allClasses = new Set();
      hoverEngine.initNodes();

      const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const buildHtml = (node, depth = 0) => {
        if (node.nodeType !== 1 || node.id?.includes('scv-') || depth > 16) return '';
        const evs = Array.from(node.attributes).filter(a => a.name.startsWith('on')).map(a => a.name);
        const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
        const sel = utils.getSelector(node);

        evs.forEach(e => allEvents.add(e));
        cls.forEach(c => allClasses.add(c));

        let childHtml = '';
        for (let i = 0; i < node.children.length; i++) childHtml += buildHtml(node.children[i], depth + 1);

        const row = `<div class="scv-tree-row" data-ref="${esc(sel)}"><span class="scv-tree-line">${'│ '.repeat(depth)}├─</span><span class="scv-tree-tag">${esc(node.tagName.toLowerCase())}</span><span class="scv-tree-evs">${evs.length ? `[${evs.map(esc).join(' ')}]` : ''}</span><div class="scv-grp"><button class="scv-grp-btn scv-copy" data-action="copy" data-sel="${esc(sel)}" title="copy this element's css selector">⧉</button><button class="scv-grp-btn scv-purge" data-action="purge" data-sel="${esc(sel)}" title="purge - strip scripts &amp; inline event handlers">⊘</button><button class="scv-grp-btn scv-harv" data-action="harvest" data-sel="${esc(sel)}" title="harvest - copy this component to clipboard">⇣</button><button class="scv-grp-btn scv-quest" data-action="quest" data-sel="${esc(sel)}" title="quest - copy a quest selector line for this element">↻</button><button class="scv-grp-btn scv-push" data-action="push" data-sel="${esc(sel)}" title="download - save this component as a standalone .html">⤓</button></div></div><div class="scv-tree-info"><div><strong>path:</strong> ${esc(sel)}</div><div><strong>id/class:</strong> ${node.id ? `#${esc(node.id)}` : ''} ${cls.length ? `.${cls.map(esc).join('.')}` : ''}</div><div><strong>events:</strong> ${evs.length ? evs.map(esc).join(' ') : 'none'}</div><div><strong>size:</strong> ${node.offsetWidth}x${node.offsetHeight}px</div></div>`;
        return `<div class="scv-tree-item" data-events="${esc(evs.join(' '))}" data-classes="${esc(cls.join(' '))}" data-depthcat="${utils.getDepthCategory(depth + 1)}">${row}<div>${childHtml}</div></div>`;
      };

      const root = document.createElement('div');
      root.className = 'scv-tree-wrap'; // container owns row rhythm, so last row adds nothing at bottom
      utils.setHTML(root, buildHtml(document.body, 0));

      root.addEventListener('mouseover', e => {
        const r = e.target.closest('.scv-tree-row');
        if (r) {
          let el = null; try { el = document.querySelector(r.dataset.ref); } catch {} // gone / invalid selector
          if (el) hoverEngine.highlight(el, true, `${Math.round(el.offsetWidth)}x${Math.round(el.offsetHeight)}`);
        }
      });

      root.addEventListener('mouseout', e => {
        if (e.target.closest('.scv-tree-row') && !e.relatedTarget?.closest('.scv-tree-row')) hoverEngine.highlight(null, false);
      });

      root.onclick = async (e) => {
        const btn = e.target.closest('.scv-grp-btn');
        if (!btn) {
          const r = e.target.closest('.scv-tree-row');
          if (r) {
            e.preventDefault();
            const info = r.nextElementSibling;
            info.style.display = getComputedStyle(info).display === 'none' ? 'block' : 'none';
          }
          return;
        }
        e.preventDefault();
        const el = document.querySelector(btn.dataset.sel);
        if (!el) return;
        const act = btn.dataset.action;

        // feedback flash - button fills with its own current, matching resting glyph/border color
        const flash = (cls) => { btn.classList.add(cls); _st(() => btn.classList.remove(cls), 500); };

        if (act === 'copy') {
          utils.copy(btn.dataset.sel);
          flash('scv-flash-input');
        } else if (act === 'purge') {
          utils.purge(el);
          flash('scv-flash-output');
        } else if (act === 'harvest') {
          btn.textContent = '...';
          try {
            await utils.copy(await utils.harvest(el));
            flash('scv-flash-input');
            utils.notify.finish('component harvested to clipboard!', true);
          } catch (e) { utils.notify.finish('failed.', false); throw e; } finally {
            btn.textContent = '⇣';
          }
        } else if (act === 'push') {
          btn.textContent = '...';
          try {
            utils.download(await utils.harvest(el), el.tagName.toLowerCase());
            flash('scv-flash-output');
            utils.notify.finish('component downloaded!', true);
          } catch (e) { utils.notify.finish('failed.', false); throw e; } finally {
            btn.textContent = '⤓';
          }
        } else if (act === 'quest') {
          const quest = `${window.location.href}, ${btn.dataset.sel}`;
          await utils.copy(quest);
          flash('scv-flash-input');
        }
      };

      const uiWrap = document.createElement('div');
      utils.setHTML(uiWrap, `<div class="scv-f-bar"><select class="scv-select" id="scv-ev-filter"><option value="">events</option>${Array.from(allEvents).sort().map(e => `<option value="${esc(e)}">${esc(e)}</option>`).join('')}</select><select class="scv-select" id="scv-cl-filter"><option value="">classes</option>${Array.from(allClasses).sort().map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select><select class="scv-select" id="scv-dp-filter"><option value="">depth</option><option value="top">top (1-4)</option><option value="mid">mid (5-8)</option><option value="bot">bot (9-12)</option><option value="deep">deep (13+)</option></select><button class="scv-view-copy" id="scv-tree-reset" data-scv-head-action title="reset filters">⟳</button></div>`);
      uiWrap.appendChild(root);

      _st(() => {
        // query uiWrap not document - start() is direct call, doesn't attach to live doc
        const sEv = uiWrap.querySelector('#scv-ev-filter'), sCl = uiWrap.querySelector('#scv-cl-filter'), sDp = uiWrap.querySelector('#scv-dp-filter');
        const applyFilters = () => {
          const ev = sEv.value, cl = sCl.value, dp = sDp.value, items = root.querySelectorAll('.scv-tree-item');
          if (!ev && !cl && !dp) {
            items.forEach(i => { i.style.display = 'block'; i.querySelector('.scv-tree-row').style.opacity = '1'; });
            return;
          }
          items.forEach(i => { i.style.display = 'none'; i.dataset.match = 'false'; i.querySelector('.scv-tree-row').style.opacity = '1'; });
          items.forEach(i => {
            if ((!ev || i.dataset.events.split(' ').includes(ev)) && (!cl || i.dataset.classes.split(' ').includes(cl)) && (!dp || i.dataset.depthcat === dp)) {
              i.dataset.match = 'true';
              i.style.display = 'block';
              let p = i.parentElement.closest('.scv-tree-item');
              while (p) {
                p.style.display = 'block';
                if (p.dataset.match !== 'true') p.querySelector('.scv-tree-row').style.opacity = '0.3';
                p = p.parentElement.closest('.scv-tree-item');
              }
            }
          });
        };
        sEv.onchange = applyFilters;
        sCl.onchange = applyFilters;
        sDp.onchange = applyFilters;
        // reset carries data-scv-head-action - showView lifts to viewer header - direct start() leaves it in uiWrap
        const resetBtn = uiWrap.querySelector('#scv-tree-reset') || document.getElementById('scv-tree-reset');
        if (resetBtn) resetBtn.onclick = () => { sEv.value = ''; sCl.value = ''; sDp.value = ''; applyFilters(); };
      }, 0);

      return uiWrap;
    }
  });

  kernel.register({ // eyedropper - native color picker overlay returning hex to clipboard
    id: 'eyedropper',
    label: '[elements] eyedropper',
    category: 'ELEMENTS',
    type: 'oneshot',
    start: () => {
      if (!window.EyeDropper) return 'EyeDropper API not available in this browser';
      minimize(); // modal native picker - tuck palette away, else stranded open behind it
      new EyeDropper().open().then(async (r) => {
        await utils.copy(r.sRGBHex);
        utils.notify.finish(`${r.sRGBHex} extracted!`, true); // stays minimized until dismissed
      }).catch(() => summon()); // esc-cancel - bring palette back
    }
  });

  kernel.register({ // type siphon - extracts computed typography styles from hovered element
    id: 'type-siphon',
    label: '[elements] typography',
    category: 'ELEMENTS',
    type: 'toggle',
    start: () => hoverEngine.start(async (tgt) => {
      kernel.stop('type-siphon');
      const s = getComputedStyle(tgt);
      const css = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'font-style', 'text-transform', 'color']
        .map(p => `${p}: ${s.getPropertyValue(p)};`).join('\n');
      await utils.copy(css);
      utils.notify.finish('typography extracted!', true);
    }),
    stop: () => hoverEngine.stop()
  });

  kernel.register({ // skeleton - strips backgrounds/shadows and outlines all elements for wireframe view
    id: 'skeleton',
    label: '[dom & grids] skeleton',
    category: 'DOM & GRIDS',
    type: 'toggle',
    start: () => {
      const st = document.createElement('style');
      st.id = 'scv-skeleton';
      st.textContent = `body *:not([id^="scv-"]) { background: none !important; background-image: none !important; box-shadow: none !important; text-shadow: none !important; color: var(--scv-text-base) !important; outline: 1px solid var(--scv-output-40) !important; outline-offset: -1px !important; }`;
      utils.mount(st);
    },
    stop: () => utils.unmount('scv-skeleton')
  });

  (() => { // freeze - pauses css animations and hijacks requestAnimationFrame/timeouts
    let frozenRAF = [];
    const restore = () => {
      window.requestAnimationFrame = _origRAF;
      window.setTimeout = _origST;
      window.setInterval = _origSI;
      utils.unmount('scv-freeze-style');
      const q = frozenRAF; frozenRAF = [];
      q.forEach(cb => { try { _raf(cb); } catch {} });
    };
    kernel.register({
      id: 'freeze',
      label: '[effects] freeze',
      category: 'EFFECTS',
      type: 'toggle',
      start: () => {
        frozenRAF = [];
        window.requestAnimationFrame = (cb) => { if (frozenRAF.length < 128) frozenRAF.push(cb); return 0; };
        window.setTimeout = () => 0;
        window.setInterval = () => 0;
        const st = document.createElement('style');
        st.id = 'scv-freeze-style';
        st.textContent = `body *:not([id^="scv-"]), body *:not([id^="scv-"])::before, body *:not([id^="scv-"])::after { animation-play-state: paused !important; }`;
        utils.mount(st);
        window.addEventListener('pagehide', restore);
      },
      stop: () => {
        window.removeEventListener('pagehide', restore);
        restore();
      }
    });
  })();

  (() => { // isolate - accumulates clicked elements and hides rest via visibility:hidden
    let hidden = [];
    kernel.register({
      id: 'isolate',
      label: '[elements] isolate',
      category: 'ELEMENTS',
      type: 'toggle',
      start: () => { // persistent + accumulating sniper, each click adds target to running keep set
        const keepAll = new Set();
        hoverEngine.start((tgt) => {
          let n = tgt;
          while (n && n !== document.body) { keepAll.add(n); n = n.parentElement; }
          tgt.querySelectorAll('*').forEach(d => keepAll.add(d));
          // restore and re-hide against grown keep-set using visibility:hidden to preserve layout
          hidden.forEach(([el, v]) => el.style.visibility = v); hidden = [];
          document.querySelectorAll('body *').forEach(el => {
            if ((el.id && el.id.startsWith('scv-')) || keepAll.has(el)) return;
            hidden.push([el, el.style.visibility]); el.style.visibility = 'hidden';
          });
        });
      },
      stop: () => { hidden.forEach(([el, v]) => el.style.visibility = v); hidden = []; hoverEngine.stop(); }
    });
  })();

  kernel.register({ // asset vac - extracts all images, videos, svgs, and background-urls into gallery
    id: 'asset-vac',
    label: '[scavenge] assets',
    category: 'SCAVENGE',
    type: 'oneshot',
    start: () => {
      const urls = new Set();
      document.querySelectorAll('img').forEach(i => { const u = i.currentSrc || i.src; if (u) urls.add(u); });
      document.querySelectorAll('video[src], video source[src]').forEach(v => v.src && urls.add(v.src));
      document.querySelectorAll('*').forEach(el => {
        if (el.id && el.id.startsWith('scv-')) return;
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') { const m = /url\(["']?(.*?)["']?\)/.exec(bg); if (m && !m[1].startsWith('data:')) urls.add(m[1]); }
      });
      const svgs = Array.from(document.querySelectorAll('svg')).filter(s => !s.closest('#' + IDS.masterWrapper));
      const grid = document.createElement('div');
      grid.className = 'scv-asset-grid';
      const cell = (inner, openFn) => {
        const c = document.createElement('div');
        c.className = 'scv-asset-cell';
        c.title = 'click to open in a new tab';
        inner.style.pointerEvents = 'none';
        c.appendChild(inner);
        c.onclick = openFn;
        grid.appendChild(c);
      };
      urls.forEach(url => {
        const img = document.createElement('img'); img.src = url; img.className = 'scv-asset-img';
        cell(img, () => window.open(url, '_blank', 'noopener'));
      });
      svgs.forEach(svg => {
        const holder = document.createElement('div'); holder.className = 'scv-asset-holder'; holder.appendChild(svg.cloneNode(true));
        cell(holder, () => {
          const url = URL.createObjectURL(new Blob([svg.outerHTML], { type: 'image/svg+xml' }));
          window.open(url, '_blank', 'noopener');
          _st(() => URL.revokeObjectURL(url), 5000);
        });
      });
      if (!grid.children.length) { const e = document.createElement('div'); e.className = 'scv-v-empty'; e.textContent = 'no assets found'; grid.appendChild(e); }
      return grid;
    }
  });

  let stackingT;
  kernel.register({ // stacking - climbs dom to find and highlight nearest stacking context root
    id: 'stacking',
    label: '[dom & grids] stacking',
    category: 'DOM & GRIDS',
    type: 'toggle',
    start: () => hoverEngine.start((tgt) => {
      const makesCtx = el => {
        if (el === document.body || el === document.documentElement) return true;
        const c = getComputedStyle(el);
        if (c.position !== 'static' && c.zIndex !== 'auto') return true;
        if (c.position === 'fixed' || c.position === 'sticky') return true;
        if (+c.opacity < 1) return true;
        if (c.transform !== 'none' || c.filter !== 'none' || c.perspective !== 'none') return true;
        if (c.mixBlendMode !== 'normal' || c.isolation === 'isolate') return true;
        if (/transform|opacity|filter/.test(c.willChange)) return true;
        return false;
      };
      let root = tgt;
      while (root && !makesCtx(root)) root = root.parentElement;
      root = root || document.body;
      kernel.stop('stacking');
      // root's z-index not tgt's - tgt is usually non-context descendant with z-index 'auto', useless here
      hoverEngine.highlight(root, true, `z:${getComputedStyle(root).zIndex} - ctx:<${root.tagName.toLowerCase()}${root.id ? '#' + root.id : ''}>`);
      _ct(stackingT);
      stackingT = _st(() => hoverEngine.highlight(null, false), 2600);
    }),
    stop: () => { _ct(stackingT); hoverEngine.stop(); }
  });

  (() => { // z-layers - isolates elements by z-index bands while preserving ancestor visibility
    let hidden = [];
    const restore = () => { hidden.forEach(([el, d]) => el.style.display = d); hidden = []; };
    kernel.register({
      id: 'z-layers',
      label: '[dom & grids] z-layers',
      category: 'DOM & GRIDS',
      type: 'cycle',
      options: ['all'],
      defaultVal: 'all',
      start: (val) => {
        restore();
        const zmap = new Map();
        document.querySelectorAll('body *').forEach(el => {
          if (el.id && el.id.startsWith('scv-')) return;
          const z = getComputedStyle(el).zIndex;
          if (z !== 'auto') { if (!zmap.has(z)) zmap.set(z, []); zmap.get(z).push(el); }
        });
        kernel.processes['z-layers'].options = ['all', ...[...zmap.keys()].map(Number).sort((a, b) => a - b).map(String)];
        if (val == null || val === 'all') { kernel.processes['z-layers']._cur = 'all'; return; }
        if (!zmap.has(val)) { kernel.processes['z-layers']._cur = 'all'; return; } // stale selection vs this page's zmap
        // keep selected layer elements, their ancestor chain, and subtrees visible; hide rest
        const keep = new Set();
        (zmap.get(val) || []).forEach(el => {
          let n = el;
          while (n && n !== document.body) { keep.add(n); n = n.parentElement; }
          el.querySelectorAll('*').forEach(d => keep.add(d));
        });
        document.querySelectorAll('body *').forEach(el => {
          if ((el.id && el.id.startsWith('scv-')) || keep.has(el)) return;
          hidden.push([el, el.style.display]); el.style.display = 'none';
        });
      },
      stop: restore
    });
  })();

  // LAUNCH FLAGS - read once at boot from host page (set window.scvLaunch before script)

  const launch = (typeof window.scvLaunch === 'object' && window.scvLaunch) || {};
  const launchSeed = typeof launch.search === 'string' ? launch.search.trim() : '';

  // COMMAND PALETTE - main ui for tool launching

  function renderPalette(seed) { // mounts command palette, filters tools, and manages view routing
    const SUITE = ['harvester', 'quest-sel', 'quest-steps', 'quest-emit', 'wiring', 'scavenge-tree', 'asset-vac']; // what feeds suite, in the flow order runs
    const PAGE_TOOLS = ['harvester', 'el-sniper', 'quest-sel', 'quest-steps', 'quest-emit', 'el-size', 'type-siphon', 'isolate', 'stacking', 'capture-zone', 'wiring'];

    const cmds = Object.values(kernel.processes)
      .map(p => ({ id: p.id, label: p.label, tool: p, hay: `${p.label} ${p.id} ${p.category} ${p.type}`.toLowerCase() }))
      .sort((a, b) => { // scav block first, then alphabetical - every label carries category, tail regroups itself
        const ai = SUITE.indexOf(a.id), bi = SUITE.indexOf(b.id);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        return a.label.localeCompare(b.label);
      });
    cmds.push({ id: '__console', label: 'console', hay: 'console terminal repl js eval system' });
    cmds.push({ id: '__hide', label: 'hide', hay: 'hide minimize dot system' });
    cmds.push({ id: '__close', label: 'close', hay: 'close exit quit destroy kill system' });

    const wrapper = utils.createOverlay(IDS.masterWrapper, '', document.documentElement);
    utils.uiNodes.add(wrapper);
    utils.setHTML(wrapper, `<div class="scv-palette scv-overlay-reveal" id="scv-pal"><input class="scv-palette-input" id="scv-pal-input" placeholder="command: toggle, param, cycle, oneshot" autocomplete="off" spellcheck="false" /><div class="scv-palette-list" id="scv-pal-list"></div><div class="scv-pal-bar" id="scv-pal-bar"></div></div><div class="scv-view" id="scv-view" tabindex="-1"></div>`);
    const palette = wrapper.querySelector('#scv-pal');
    const palInput = wrapper.querySelector('#scv-pal-input');
    const palList = wrapper.querySelector('#scv-pal-list');
    const palBar = wrapper.querySelector('#scv-pal-bar');
    const viewEl = wrapper.querySelector('#scv-view');
    let viewOpen = false;
    viewEl.addEventListener('click', e => { if (e.target.closest('.scv-view-close')) hideView(); });
    kernel.showView = showView; kernel.hideView = hideView; kernel.summon = summon; kernel.minimize = minimize; // showview
    kernel.run = (cmdString) => { // programmatic launch - same dispatch as a palette enter, no ui required
      const parts = String(cmdString || '').trim().split(/\s+/);
      const id = parts.shift(), arg = parts.join(' ');
      const p = registry[id];
      if (!p) return 'unknown command: ' + id;
      return run({ id, label: p.label, tool: p }, arg);
    };
    kernel.bus.offAll('__pal');
    kernel.bus.on('sys_process_changed', '__pal', () => { if (!viewOpen && document.getElementById(IDS.masterWrapper)) render(); });

    function kvNode(obj) { // key/value grid - vs pretty printed, data as pairs reads as report
      const wrap = document.createElement('div');
      wrap.className = 'scv-v-kv';
      let n = 0;
      const put = (k, v) => {
        const kd = document.createElement('span'); kd.className = 'scv-v-k'; kd.textContent = k;
        const vd = document.createElement('span'); vd.className = 'scv-v-v'; vd.textContent = typeof v === 'string' ? v : JSON.stringify(v);
        wrap.append(kd, vd); n++;
      };
      const walk = (o, depth) => {
        for (const [k, v] of Object.entries(o)) {
          if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2 && Object.keys(v).length) {
            const g = document.createElement('span'); g.className = 'scv-v-grp'; g.textContent = k;
            wrap.appendChild(g); walk(v, depth + 1);
          } else put(k, v);
        }
      };
      if (Array.isArray(obj)) obj.forEach((v, i) => put(String(i + 1), v)); else walk(obj, 0);
      return { node: wrap, count: n, unit: 'keys' };
    }

    function listNode(lines) { // one row per line, dim ordinal - font list is list, not paragraph
      const wrap = document.createElement('div');
      wrap.className = 'scv-v-list';
      lines.forEach((l, i) => {
        const row = document.createElement('div'); row.className = 'scv-v-row';
        const idx = document.createElement('span'); idx.className = 'scv-v-idx'; idx.textContent = String(i + 1);
        const txt = document.createElement('span'); txt.className = 'scv-v-txt'; txt.textContent = l;
        row.append(idx, txt);
        row.onclick = async () => { // row is whole item - taking one shouldn't take rest of dump
          await utils.copy(l);
          row.classList.add('scv-took');
          _st(() => row.classList.remove('scv-took'), 500);
        };
        wrap.appendChild(row);
      });
      return { node: wrap, count: lines.length, unit: 'lines' };
    }

    function payloadNode(text) { // shape dump by what it is - falls back to raw text when neither
      const t = text.trim();
      if (/^[[{]/.test(t)) { let p = null; try { p = JSON.parse(t); } catch {} if (p && typeof p === 'object') return kvNode(p); }
      const lines = text.split('\n');
      if (lines.length === 1) { // lines get same row command gets
        const row = document.createElement('div'); row.className = 'scv-v-empty'; row.textContent = text;
        return { node: row, count: 0, unit: '' };
      }
      if (lines.every(l => l.length <= 160)) return listNode(lines);
      const pre = document.createElement('pre'); pre.className = 'scv-pre'; pre.textContent = text;
      return { node: pre, count: 0, unit: '', wide: true };
    }

    function showView(label, content, term) { // swaps palette for content viewer with optional copy button
      const isText = typeof content === 'string';
      const shaped = isText ? payloadNode(content) : null;
      const copyBtn = isText ? '<button class="scv-view-copy" title="copy">⧉</button>' : '';
      const count = shaped && shaped.count ? `<span class="scv-v-count">${shaped.count} ${shaped.unit}</span>` : '';
      const cls = term ? ' scv-viewer-term' : (shaped && shaped.wide ? ' scv-viewer-wide' : '');
      utils.setHTML(viewEl, `<div class="scv-viewer${cls}"><div class="scv-v-head"><span class="scv-v-title">${utils.esc(label)}</span>${count}${copyBtn}<button class="scv-view-close" title="back (esc)">×</button></div><div class="scv-v-body" id="scv-v-content"></div></div>`);
      const c = viewEl.querySelector('#scv-v-content');
      if (isText) { // textContent throughout shapers - string payload renders raw markup instead of injecting
        c.appendChild(shaped.node);
        const btn = viewEl.querySelector('.scv-view-copy');
        btn.onclick = async () => { await utils.copy(content); btn.textContent = '✓'; _st(() => { btn.textContent = '⧉'; }, 1000); };
      } else c.appendChild(content);
      const lifted = c.querySelector('[data-scv-head-action]');
      if (lifted) viewEl.querySelector('.scv-view-close').before(lifted); // panels hand one action up to title bar
      palette.style.display = 'none';
      viewEl.style.display = 'block';
      const viewer = viewEl.querySelector('.scv-viewer');
      if (viewer) { viewer.classList.remove('scv-overlay-reveal'); void viewer.offsetWidth; viewer.classList.add('scv-overlay-reveal'); }
      viewOpen = true;
      viewEl.focus();
    }

    function hideView() { // clears viewer, unmounts hover overlays, and restores palette
      hoverEngine.highlight(null, false);
      viewEl.style.display = 'none';
      utils.setHTML(viewEl, '');
      palette.style.display = 'flex';
      viewOpen = false;
      render();
      palInput.focus();
    }

    function openConsole() { // mounts integrated repl for js evaluation and system commands
      // prompt sits under output and never scrolls away
      utils.setHTML(viewEl, `<div class="scv-viewer scv-viewer-term"><div class="scv-v-head"><span class="scv-v-title">console</span><button class="scv-view-copy" id="m-h" title="help">?</button><button class="scv-view-close" title="back (esc)">×</button></div><div class="scv-out-box" id="m-o"><span class="scv-v-sub">output:</span><pre class="scv-pre">\nresults appear here</pre></div><div class="scv-term-row"><textarea class="scv-textarea" id="m-t" rows="1" placeholder="// js code. :cmds (:ps, :start, :stop, :harvest, :purge, :push)"></textarea><button class="scv-view-copy scv-term-run" id="m-e" title="execute (ctrl+enter)">▶</button></div></div>`);
      palette.style.display = 'none';
      viewEl.style.display = 'block';
      viewOpen = true;
      viewEl.focus();
      const ta = viewEl.querySelector('#m-t');
      const grow = () => { ta.style.height = ''; if (ta.scrollHeight > ta.clientHeight) ta.style.height = Math.min(ta.scrollHeight, Math.round(innerHeight * 0.4)) + 'px'; }; // only when text truly overflows, first keystroke does not resize field
      ta.addEventListener('input', grow);
      ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); viewEl.querySelector('#m-e').onclick(); } });
      const exec = async () => {
        const cmd = ta.value.trim();
        let res;
        if (!cmd) return;
        if (cmd === 'clear' || cmd === ':clear') { // wipe log, same as any terminal
          utils.setHTML(document.getElementById('m-o'), `<span class="scv-v-sub">output:</span><pre class="scv-pre">\nresults appear here</pre>`);
          ta.value = ''; grow(); return;
        }
        try {
          if (cmd.startsWith(':')) {
            const parts = cmd.slice(1).split(' '), action = parts[0], arg = parts.slice(1).join(' ');
            if (action === 'ps') res = JSON.stringify(Object.keys(kernel.processes), null, 2);
            else if (action === 'start' && arg) { kernel.start(arg); res = `started ${arg}`; }
            else if (action === 'stop' && arg) { kernel.stop(arg); res = `stopped ${arg}`; }
            else if (['purge', 'harvest', 'push'].includes(action) && arg) {
              const tgt = document.querySelector(arg);
              if (!tgt) res = 'error: element not found';
              else if (action === 'purge') { utils.purge(tgt); res = `purged: ${arg}`; }
              else if (action === 'harvest') {
                try { await utils.copy(await utils.harvest(tgt)); utils.notify.finish('component harvested to clipboard!', true); res = 'component harvested!'; }
                catch (e) { utils.notify.finish('failed.', false); throw e; }
              } else {
                try { utils.download(await utils.harvest(tgt), tgt.tagName.toLowerCase()); utils.notify.finish('component downloaded!', true); res = 'downloaded fragment'; }
                catch (e) { utils.notify.finish('failed.', false); throw e; }
              }
            } else res = 'unknown command';
          } else {
            const sR = eval(cmd);
            res = typeof sR === 'undefined' ? 'executed: undefined' : typeof sR === 'object' && sR !== null ? JSON.stringify(sR, (k, v) => ['window', 'document', 'globalThis'].includes(k) ? '...' : v instanceof HTMLElement ? `<${v.tagName.toLowerCase()}>` : v, 2) : typeof sR === 'function' ? `[function] ${sR.name || 'anonymous'}` : String(sR);
          }
        } catch (err) {
          res = err.toString();
        }
        const outBox = document.getElementById('m-o');
        utils.setHTML(outBox, `<span class="scv-v-sub">output:</span>`);
        res = '\n' + res; // blank row under label, same as resting state
        const pre = document.createElement('pre'); pre.className = 'scv-pre'; pre.textContent = res; outBox.appendChild(pre);
      };
      viewEl.querySelector('#m-e').onclick = exec;
      viewEl.querySelector('#m-h').onclick = () => utils.setHTML(document.getElementById('m-o'), `<span class="scv-v-sub">help:</span><pre class="scv-pre">\n:ps                 - list processes\n:start [id]         - start process\n:stop [id]          - stop process\n:purge [selector]   - strip scripts/events\n:harvest [sel]      - extract web component\n:push [sel]         - dl web component\n\nany other input evaluates as js</pre>`);
    }

    function run(cmd, arg) { // dispatches tool execution based on lifecycle type
      if (cmd.id === '__close') return kernel.destroy();
      if (cmd.id === '__console') return openConsole();
      if (cmd.id === '__hide') return minimize();
      const p = cmd.tool;
      if (p.type === 'oneshot') {
        let res;
        try { res = kernel.start(p.id); } catch (err) { res = err.toString(); }
        kernel.stop(p.id);
        if (res) showView(p.label, res);
        return;
      }
      if (p.type === 'toggle') {
        kernel.toggle(p.id);
      } else {
        const opts = p.type === 'cycle' ? (p.options || [p.defaultVal]) : null;
        let val = (arg !== undefined && arg !== '') ? arg : null;
        if (opts && val !== null && !opts.includes(val)) val = null;
        if (val !== null) {
          if (p.active) kernel.stop(p.id);
          p._cur = val; kernel.start(p.id, val);
        } else if (p.active) {
          kernel.stop(p.id);
        } else {
          val = p._cur != null ? p._cur : p.defaultVal;
          p._cur = val; kernel.start(p.id, val);
        }
      }
      if (PAGE_TOOLS.includes(p.id) && p.active) { minimize(); return; }
      render();
    }

    function adjust(cmd, dir) { // increments param values or cycles options for active tool
      const p = cmd.tool;
      if (p.type === 'cycle') {
        const opts = p.options || [p.defaultVal];
        const i = opts.indexOf(p._cur != null ? p._cur : p.defaultVal);
        p._cur = opts[(i + dir + opts.length) % opts.length];
      } else {
        const v = Number(p._cur != null ? p._cur : p.defaultVal) + dir;
        p._cur = v < 1 ? 1 : v;
      }
      if (p.active) { kernel.stop(p.id); kernel.start(p.id, p._cur); }
      render();
    }

    const accent = id => id === '__close' ? ' scv-cmd-danger' // leaving is destructive, hiding is not
      : id === '__hide' ? ' scv-cmd-ok'
      : id === '__console' ? ' scv-cmd-alt'
      : ['scavenge-tree', 'asset-vac'].includes(id) ? ' scv-cmd-accent'
      : ['harvester', 'quest-sel', 'quest-steps', 'quest-emit', 'wiring'].includes(id) ? ' scv-cmd-alt' : '';

    let sel = 0, shown = [], pendingArg;

    function render() { // filters registry by search tokens and updates dom list
      const tokens = palInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let search = tokens, arg;
      let list = cmds.filter(c => search.every(t => c.hay.includes(t)));
      if (!list.length && tokens.length > 1) {
        search = tokens.slice(0, -1);
        arg = tokens[tokens.length - 1];
        list = cmds.filter(c => search.every(t => c.hay.includes(t)));
      }
      const SYS = ['__console', '__hide', '__close'];
      if (!tokens.length) list = list.filter(c => !SYS.includes(c.id)); // pinned in bar - only worth row when searched for
      shown = list;
      pendingArg = arg;
      if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
      utils.setHTML(palList, shown.map((c, i) => {
        const p = c.tool, on = p && p.active;
        const val = p && p._cur != null ? p._cur : (p ? p.defaultVal : '');
        const hint = !p ? '' : (p.type === 'param' || p.type === 'cycle') ? `${val} - ${p.type}` : p.type;
        return `<div class="scv-cmd${i === sel ? ' scv-sel' : ''}${on ? ' scv-on' : ''}${accent(c.id)}" data-i="${i}"><span class="scv-cmd-lbl">${utils.esc(c.label)}</span><span class="scv-cmd-hint">${utils.esc(hint)}</span></div>`;
      }).join('') || `<div class="scv-cmd-empty">no commands</div>`);
    }

    function renderBar() { // console/hide/close never scroll away - one row, same gaps, pinned under list
      utils.setHTML(palBar, ['__hide', '__console', '__close'].map(id => {
        const c = cmds.find(x => x.id === id);
        if (!c) return '';
        return `<div class="scv-cmd${accent(id)}" data-sys="${id}"><span class="scv-cmd-lbl">${utils.esc(c.label)}</span></div>`;
      }).join(''));
    }
    palBar.addEventListener('click', e => {
      const row = e.target.closest('.scv-cmd');
      if (!row) return;
      const c = cmds.find(x => x.id === row.dataset.sys);
      if (c) run(c, '');
    });

    const applySel = () => palList.querySelectorAll('.scv-cmd').forEach(el => el.classList.toggle('scv-sel', +el.dataset.i === sel));
    const scrollSel = () => { const el = palList.querySelector('.scv-cmd.scv-sel'); if (el) el.scrollIntoView({ block: 'nearest' }); };

    palInput.addEventListener('input', () => { sel = 0; render(); });

    palList.addEventListener('mousemove', e => {
      const row = e.target.closest('.scv-cmd');
      if (row && row.dataset.i !== undefined && +row.dataset.i !== sel) { sel = +row.dataset.i; applySel(); }
    });

    palList.addEventListener('mousedown', e => e.preventDefault()); // keep focus on input so arrow-nav doesn't fall through

    palList.addEventListener('click', e => {
      const row = e.target.closest('.scv-cmd');
      if (!row || row.dataset.i === undefined) return;
      run(shown[+row.dataset.i], pendingArg);
    });

    const inField = t => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

    // escape lives on bus (document level) not wrapper - tool can move focus off palette, escape must still back out
    kernel.bus.on('keydown', '__pal', e => { // back out one layer at a time - focused field, then view, then active tools, then palette
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) && e.target !== palInput) { e.target.blur(); return; } // real field blurs first - contentEditable page (el-write) is tool state, falls through to close tool
      if (viewOpen) { hideView(); return; }
      const live = Object.keys(registry).filter(id => registry[id].active); // stateful tools close on escape before palette tucks away
      if (live.length) { live.forEach(id => kernel.stop(id)); return; }
      minimize();
    });

    wrapper.addEventListener('keydown', e => { // nav lives on wrapper, not input, so keys work regardless of focused element
      if (e.key === 'Escape') return; // handled on bus above
      if (viewOpen) { if (e.key === 'Enter' && !inField(e.target)) { e.preventDefault(); hideView(); } return; }
      const cur = shown[sel];
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, Math.max(0, shown.length - 1)); applySel(); scrollSel(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); applySel(); scrollSel(); }
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && cur && cur.tool && (cur.tool.type === 'param' || cur.tool.type === 'cycle')) { e.preventDefault(); adjust(cur, e.key === 'ArrowRight' ? 1 : -1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (cur) run(cur, pendingArg); }
    });

    if (seed) palInput.value = seed;
    renderBar();
    render();
    palInput.focus();
  }

  // MINIMIZE & SUMMON

  function summon(seed) { // restores palette and drops minimized indicator + pending notification
    utils.unmount('scv-min-dot');
    utils.unmount(IDS.notify);
    renderPalette(seed ?? launchSeed);
  }

  function minimize() { // hides palette and leaves interaction dot
    kernel.bus.offAll('__pal');
    utils.unmount(IDS.masterWrapper);
    if (document.getElementById('scv-min-dot')) return;
    const dot = utils.createOverlay('scv-min-dot', '', document.documentElement);
    utils.uiNodes.add(dot);
    dot.onclick = () => summon(); // bare call - passing handler leaks click event in as search seed
  }

  let _shiftLast = 0;
  kernel._shiftHandler = (e) => { // toggles palette state on shift double-tap, aborted by interleaved keys
    if (e.key !== 'Shift') { _shiftLast = 0; return; }
    if (e.repeat) return;
    if (e.target.closest?.('[id^="scv-"]')) return;
    const n = Date.now();
    if (n - _shiftLast < 400) {
      _shiftLast = 0;
      if (document.getElementById(IDS.masterWrapper)) minimize();
      else if (document.getElementById('scv-min-dot')) summon();
    } else _shiftLast = n;
  };

  document.addEventListener('keydown', kernel._shiftHandler, true);

  // BOOT

  renderPalette(launchSeed);
  if (launch.run && launchSeed) kernel.run(launchSeed);

})();