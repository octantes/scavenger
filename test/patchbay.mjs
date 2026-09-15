// patchbay tier - drive patchbay.html headless, exercise runtime (routing, logic nodes, wiring) + quine reopen round-trip

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const pbUrl = pathToFileURL(join(here, '..', 'patchbay.html')).href;

// 1x1 red png, pasted via clipboard in tiers below
const PNG_1PX = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,6,0,0,0,31,21,196,137,0,0,0,13,73,68,65,84,8,215,99,248,207,192,240,31,0,5,0,1,255,137,74,166,9,0,0,0,0,73,69,78,68,174,66,96,130]);

const { ws, send, waitEvent, cleanup } = await (async () => {
  const { pageWsUrl, cleanup } = await launchChrome();
  const c = await connect(pageWsUrl);
  return { ...c, cleanup };
})();

const jsRaw = async (expr, awaitPromise = false) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }))?.result?.result?.value;
const errs = []; // Runtime.exceptionThrown - genuine uncaught js exceptions in our page code, real signal
const browserLogErrs = []; // Log.entryAdded - browser-internal diagnostics (network/csp/deprecation), not our throws
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') browserLogErrs.push(m.params.entry.text);
});
// mid-tier reset must account for what's there first - only named benign noise is filtered, anything else fails tier here
const checkpointErrs = (label, allowPattern) => {
  const unexpected = allowPattern ? errs.filter(e => !allowPattern.test(e || '')) : errs.slice();
  ok(unexpected.length === 0, `no unexpected errors before ${label} (${unexpected.slice(0, 3).join(' | ')})`);
  errs.length = 0;
};

const load = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await delay(400); };
let quineFile = null;
const done = () => { try { ws.close(); } catch {} cleanup(); if (quineFile) try { rmSync(quineFile, { force: true }); } catch {} };

try {
  await load(pbUrl);

  // public api surface (stable contract)
  const api = await jsRaw(`['routeSend','setMode','spawnLogicNode','autoWire','renderCables','saveQuine','exportPublish','defineNode','handlePasteData'].filter(n => typeof window[n] !== 'function')`);
  ok(Array.isArray(api) && api.length === 0, `all public api functions present (missing: ${JSON.stringify(api)})`);
  ok(await jsRaw(`typeof session === 'object' && 'mode' in session`), 'session object with mode exposed');

  // routing: routeSend reaches receiver and applies value
  const routed = await jsRaw(`(() => {
    setMode('edit');
    const d = document.createElement('div'); d.id = 'rcv'; d.setAttribute('data-scv-receives', 'ch_test'); document.getElementById('zoom-layer').appendChild(d);
    routeSend('ch_test', 'hello');
    return document.getElementById('rcv').textContent;
  })()`);
  ok(routed === 'hello', `routeSend applies value to receiver (got ${JSON.stringify(routed)})`);

  // accumulator: sums received values
  const acc = await jsRaw(`(() => {
    const n = spawnLogicNode('accumulator', 100, 100);
    n.dispatchEvent(new CustomEvent('scv-receive', { detail: 5 }));
    n.dispatchEvent(new CustomEvent('scv-receive', { detail: 3 }));
    return n.querySelector('.scv-logic-input').value;
  })()`);
  ok(String(acc) === '8', `accumulator sums 5+3 → 8 (got ${acc})`);

  // mutator: evaluates expression and emits result to wired receiver
  const mut = await jsRaw(`(() => {
    const m = spawnLogicNode('mutator', 100, 200);
    m.querySelector('.scv-logic-input').value = 'v * 2';
    m.setAttribute('data-scv-emits', 'ch_mut');
    const r = document.createElement('div'); r.id = 'mrcv'; r.setAttribute('data-scv-receives', 'ch_mut'); document.getElementById('zoom-layer').appendChild(r);
    invalidateCache && invalidateCache();
    m.dispatchEvent(new CustomEvent('scv-receive', { detail: 21 }));
    return document.getElementById('mrcv').textContent;
  })()`);
  ok(String(mut) === '42', `mutator 'v * 2' on 21 → 42 downstream (got ${mut})`);

  // comparator: emits 1 when two inputs are equal
  const cmp = await jsRaw(`(() => {
    const c = spawnLogicNode('comparator', 100, 300);
    c.setAttribute('data-scv-emits', 'ch_cmp');
    const r = document.createElement('div'); r.id = 'crcv'; r.setAttribute('data-scv-receives', 'ch_cmp'); document.getElementById('zoom-layer').appendChild(r);
    invalidateCache && invalidateCache();
    c.dispatchEvent(new CustomEvent('scv-receive', { detail: 7 }));
    c.dispatchEvent(new CustomEvent('scv-receive', { detail: 7 }));
    return document.getElementById('crcv').textContent;
  })()`);
  ok(String(cmp) === '1', `comparator 7==7 → emits 1 (got ${cmp})`);

  // autoWire: creates cable + routes source>target end to end (accumulators only emit is wire)
  const wired = await jsRaw(`(() => {
    const a = spawnLogicNode('accumulator', 500, 100);
    const b = spawnLogicNode('accumulator', 700, 100);
    autoWire(a, b);
    renderCables();
    const cable = document.querySelector('#static-cables .cable-path');
    const ch = cable && cable.getAttribute('data-channel'); // wire's actual channel
    const srcEmits = (a.getAttribute('data-scv-emits') || '').split(' ');
    const tgtRecv = (b.getAttribute('data-scv-receives') || '').split(' ');
    b.querySelector('.scv-logic-input').value = '0';
    if (ch) routeSend(ch, 4); // push value down wire's channel
    return { hasCable: !!cable, shared: !!ch && srcEmits.includes(ch) && tgtRecv.includes(ch), accVal: b.querySelector('.scv-logic-input').value };
  })()`);
  ok(wired && wired.hasCable && wired.shared, 'autoWire creates cable on channel shared by source emit + target receive');
  ok(wired && String(wired.accVal) === '4', `value routes through wire to target (got ${wired && wired.accVal})`);

  // space-chain onto toggle node wires without toggling mode (completing click must be swallowed, not reach icon)
  const chain = await jsRaw(`(() => {
    const move = (x,y) => document.dispatchEvent(new PointerEvent('pointermove', { clientX:x, clientY:y, bubbles:true }));
    const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key:k, bubbles:true }));
    move(400,500); key('4'); // spawn gate (target - its icon click toggles .active)
    move(650,500); key('1'); // spawn clock (source > lastSpawned)
    key(' '); // arm chain from clock
    const gate = [...document.querySelectorAll('scv-logic')].filter(n => n.dataset.type === 'gate').pop();
    const icon = gate.querySelector('.scv-logic-icon');
    const before = gate.classList.contains('active');
    const r = icon.getBoundingClientRect(), opt = { clientX: r.left + r.width/2, clientY: r.top + r.height/2, bubbles:true, composed:true };
    const cablesBefore = document.querySelectorAll('#static-cables .cable-path').length;
    icon.dispatchEvent(new PointerEvent('pointerdown', opt)); // completes chain wire
    icon.dispatchEvent(new MouseEvent('click', opt)); // must be swallowed (no toggle)
    const afterChain = gate.classList.contains('active');
    const wiredNow = document.querySelectorAll('#static-cables .cable-path').length > cablesBefore;
    // control: plain click (no chain) does toggle - proves this check can detect toggle
    const t0 = gate.classList.contains('active'); icon.dispatchEvent(new MouseEvent('click', { bubbles:true }));
    return { wiredNow, unchanged: before === afterChain, toggles: t0 !== gate.classList.contains('active') };
  })()`);
  ok(chain && chain.wiredNow, 'Space-chain click wires onto target node');
  ok(chain && chain.toggles, 'target node\'s icon click still toggles normally (control)');
  ok(chain && chain.unchanged, 'Space-chain click does not toggle wired node\'s mode');

  // freshly-spawned node under cursor mutes first hover-tooltip, then shows it
  const spawnMute = await jsRaw(`(() => {
    const cc = document.getElementById('canvas-container');
    document.dispatchEvent(new PointerEvent('pointermove', { clientX:420, clientY:560, bubbles:true, composed:true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key:'1', bubbles:true })); // spawn clock under cursor
    const node = [...document.querySelectorAll('scv-logic')].pop();
    const r = node.getBoundingClientRect(), cx = r.left + r.width/2, cy = r.top + r.height/2;
    const t = document.getElementById('wiring-tooltip');
    node.dispatchEvent(new PointerEvent('pointermove', { clientX:cx, clientY:cy, bubbles:true, composed:true }));       const first = t.style.display;
    cc.dispatchEvent(new PointerEvent('pointermove', { clientX:r.right+300, clientY:r.bottom+200, bubbles:true, composed:true }));
    node.dispatchEvent(new PointerEvent('pointermove', { clientX:cx, clientY:cy, bubbles:true, composed:true }));       const second = t.style.display;
    return { first, second };
  })()`);
  ok(spawnMute && spawnMute.first === 'none', `fresh node's first hover is muted (got ${spawnMute && spawnMute.first})`);
  ok(spawnMute && spawnMute.second === 'block', `after cursor leaves and returns, tooltip shows (got ${spawnMute && spawnMute.second})`);

  // cable draw-in fires on new wire - assert dashoffset == --cable-length, not guessed mid-animation snapshot
  const drew = await jsRaw(`(async () => {
    const a = spawnLogicNode('clock', 900, 100), b = spawnLogicNode('gate', 1100, 100);
    await new Promise(r => setTimeout(r, 120)); // let geometry settle so cable isn't skipped
    autoWire(a, b); renderCables();
    const p = [...document.querySelectorAll('#static-cables .cable-path')].pop();
    if (!p) return null;
    const cs = getComputedStyle(p);
    const varLen = parseFloat(cs.getPropertyValue('--cable-length')) || 0;
    return { cls: p.classList.contains('cable-draw-in'), off: parseFloat(cs.strokeDashoffset), varLen };
  })()`, true);
  // exact equality too strict - sliver of animation can elapse even at zero wait; >= 90% still proves "read at animation start"
  ok(drew && drew.cls && drew.varLen > 0 && drew.off >= drew.varLen * 0.9,
    `new wire animates in from near its full length (draw-in class + dashoffset ≈ --cable-length, not timing-guessed snapshot: ${JSON.stringify(drew)})`);

  // setMode('use'): hides wire canvas, detaches editor pointer listeners, still routes
  const useMode = await jsRaw(`(() => {
    setMode('use');
    const canvasClass = document.getElementById('canvas-container').className; // no 'mode-edit'
    const wireHidden = document.getElementById('wire-canvas').classList.contains('hidden');
    // routing still works in use mode (runtime runs); spawn stays edit-only
    const r = document.createElement('div'); r.id = 'um_r'; r.setAttribute('data-scv-receives', 'um_ch'); document.getElementById('zoom-layer').appendChild(r);
    invalidateCache();
    routeSend('um_ch', 'live');
    const mode = session.mode;
    setMode('edit');
    return { mode, notEdit: !/mode-edit/.test(canvasClass), wireHidden, routed: document.getElementById('um_r').textContent };
  })()`);
  ok(useMode && useMode.mode === 'use' && useMode.notEdit && useMode.wireHidden && useMode.routed === 'live',
    `setMode('use') hides cables, drops edit chrome, still routes (${JSON.stringify(useMode)})`);

  // wired checkbox emits 1 on check / 0 on uncheck, toggles wired gate once per click (follow-up change must not re-emit)
  const chkBox = await jsRaw(`(() => {
    setMode('use');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'chk';
    cb.setAttribute('data-scv-emits', 'chk_ch'); document.getElementById('zoom-layer').appendChild(cb);
    const r = document.createElement('div'); r.id = 'chk_r'; r.setAttribute('data-scv-receives', 'chk_ch'); document.getElementById('zoom-layer').appendChild(r);
    const g = spawnLogicNode('gate', 0, 0); g.setAttribute('data-scv-receives', 'chk_ch');
    invalidateCache();
    cb.click(); // check: routes 1, change fires but must not re-route
    const v1 = document.getElementById('chk_r').textContent;
    const g1 = g.classList.contains('active'); // active only if single 1 arrived once (no double-fire)
    cb.click(); // uncheck: routes 0
    const v0 = document.getElementById('chk_r').textContent;
    setMode('edit');
    return { v1, v0, g1, checked: cb.checked };
  })()`);
  ok(chkBox && String(chkBox.v1) === '1', `wired checkbox emits 1 when checked (got ${chkBox && JSON.stringify(chkBox.v1)})`);
  ok(chkBox && String(chkBox.v0) === '0', `wired checkbox emits 0 when unchecked (got ${chkBox && JSON.stringify(chkBox.v0)})`);
  ok(chkBox && chkBox.g1 === true, `single checkbox click toggles wired gate exactly once (got active=${chkBox && chkBox.g1})`);

  // radio carries picked option - checkbox is boolean, radio group is range
  const radio = await jsRaw(`(() => {
    setMode('use');
    const zl = document.getElementById('zoom-layer');
    const mk = v => { const r = document.createElement('input'); r.type = 'radio'; r.name = 'rg'; r.value = v; r.id = 'rad' + v;
      r.setAttribute('data-scv-emits', 'rad_ch'); zl.appendChild(r); return r; };
    const a = mk('10'), b = mk('20'), c = mk('30');
    const out = document.createElement('div'); out.id = 'rad_r'; out.setAttribute('data-scv-receives', 'rad_ch'); zl.appendChild(out);
    const acc = spawnLogicNode('accumulator', 0, 0); acc.setAttribute('data-scv-receives', 'rad_ch');
    acc.querySelector('.scv-logic-input').value = '0';
    invalidateCache();
    a.click(); const v10 = document.getElementById('rad_r').textContent;
    b.click(); const v20 = document.getElementById('rad_r').textContent;
    c.click(); const v30 = document.getElementById('rad_r').textContent;
    const sum = acc.querySelector('.scv-logic-input').value; // 60 only if each emitted once, carrying its own value
    setMode('edit');
    return { v10, v20, v30, sum };
  })()`);
  ok(radio && radio.v10 === '10' && radio.v20 === '20' && radio.v30 === '30',
    `wired radio emits value that picked it, not bare 1 (got ${radio && JSON.stringify([radio.v10, radio.v20, radio.v30])})`);
  ok(radio && String(radio.sum) === '60',
    `each radio pick routes exactly once, carrying its value (accumulator ${radio && radio.sum}, want 60)`);

  // renderCables with zero cables is safe no-op
  const zeroCables = await jsRaw(`(() => {
    document.querySelectorAll('scv-logic, .comp-wrapper, [id$="_r"], #rcv, #mrcv, #crcv, #vr, #qrcv').forEach(n => n.remove());
    invalidateCache();
    try { renderCables(); return { threw: false, paths: document.querySelectorAll('#static-cables .cable-path').length }; }
    catch (e) { return { threw: e.message }; }
  })()`);
  ok(zeroCables && !zeroCables.threw && zeroCables.paths === 0, `renderCables with no wires is safe no-op (${JSON.stringify(zeroCables)})`);

  // handlePasteData with full quine document: parts import, channels remap, no cross-wire
  const quinePaste = await jsRaw(`(async () => {
    // build tiny 2-node wired board and capture its quine
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const a = spawnLogicNode('reader', 100, 100); a.querySelector('.scv-logic-input').value = '3'; a.dispatchEvent(new CustomEvent('scv-receive', { detail: 3 }));
    const b = spawnLogicNode('accumulator', 300, 100); b.querySelector('.scv-logic-input').value = '0';
    autoWire(a, b);
    let blob = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    URL.createObjectURL = x => { blob = x; return 'blob:x'; }; URL.revokeObjectURL = () => {};
    await saveQuine();
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
    const quine = await blob.text();
    // now clear and import quine document via handlePasteData (drop == open)
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const before = document.querySelectorAll('scv-logic').length;
    handlePasteData(quine);
    await new Promise(r => setTimeout(r, 200));
    const after = document.querySelectorAll('scv-logic').length;
    // imported pair still routes internally (channels remapped) - store in reader, trigger it, it emits through restored wire
    const rd = [...document.querySelectorAll('scv-logic')].find(n => n.dataset.type === 'reader');
    const acc = [...document.querySelectorAll('scv-logic')].find(n => n.dataset.type === 'accumulator');
    let acVal = null, crossWired = null;
    if (rd && acc) {
      acc.querySelector('.scv-logic-input').value = '0';
      rd.dispatchEvent(new CustomEvent('scv-receive', { detail: 5 })); // store 5
      rd.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // trigger > 5 down wire
      acVal = acc.querySelector('.scv-logic-input').value;
      // imported reader's emit channel must be fresh id, not original (no cross-wire risk)
      crossWired = (rd.getAttribute('data-scv-emits') || '').includes('ch_reader_');
    }
    return { before, after, acVal, crossWired };
  })()`, true);
  ok(quinePaste && quinePaste.before === 0 && quinePaste.after === 2 && String(quinePaste.acVal) === '5' && quinePaste.crossWired === false,
    `handlePasteData imports full quine doc, wiring intact and routing (${JSON.stringify(quinePaste)})`);

  // central claim: saveQuine > reopen restores graph and live routing
  const quineHtml = await jsRaw(`(async () => {
    // fresh, minimal board: one accumulator wired from reader, plus plain receiver
    document.querySelectorAll('scv-logic, .comp-wrapper, #rcv, #mrcv, #crcv').forEach(n => n.remove());
    invalidateCache && invalidateCache();
    const rd = spawnLogicNode('reader', 120, 120); rd.dataset.scvId = 'q_reader';
    rd.querySelector('.scv-logic-input').value = '9';
    const ac = spawnLogicNode('accumulator', 360, 120); ac.dataset.scvId = 'q_acc';
    autoWire(rd, ac);
    let captured = null;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return 'blob:capture'; };
    const origRevoke = URL.revokeObjectURL; URL.revokeObjectURL = () => {};
    await saveQuine();
    URL.createObjectURL = origCreate; URL.revokeObjectURL = origRevoke;
    return captured ? await captured.text() : null;
  })()`, true);
  ok(typeof quineHtml === 'string' && quineHtml.includes('data-scv-runtime'), 'saveQuine produced stamped quine document');

  if (typeof quineHtml === 'string') {
    quineFile = join(tmpdir(), 'scv-quine-' + Date.now() + '.html');
    writeFileSync(quineFile, quineHtml);
    checkpointErrs('reopening the saved quine'); // no known noisy pattern named here, strict checkpoint (nothing filtered)
    await load(pathToFileURL(quineFile).href);
    const restored = await jsRaw(`(() => {
      const nodes = [...document.querySelectorAll('scv-logic')];
      const rd = document.querySelector('scv-logic[data-scv-id="q_reader"]');
      const ac = document.querySelector('scv-logic[data-scv-id="q_acc"]');
      const readerVal = rd && rd.querySelector('.scv-logic-input') ? rd.querySelector('.scv-logic-input').value : null;
      const emits = (rd ? rd.getAttribute('data-scv-emits') : '') || '';
      const receives = (ac ? ac.getAttribute('data-scv-receives') : '') || '';
      // wire is channel target receives; source must also emit it
      const wireCh = receives.split(' ').filter(Boolean)[0];
      const wired = !!wireCh && emits.split(' ').includes(wireCh);
      // live routing in reopened quine: send through restored wire > accumulator sums
      let acVal = null;
      if (ac && wireCh) { ac.querySelector('.scv-logic-input').value = '0'; routeSend(wireCh, 6); acVal = ac.querySelector('.scv-logic-input').value; }
      return { count: nodes.length, readerVal, wired, acVal };
    })()`);
    ok(restored && restored.count === 2, `reopened quine restored both nodes (got ${restored && restored.count})`);
    ok(restored && restored.readerVal === '9', `reader value persisted through save/reopen (got ${restored && restored.readerVal})`);
    ok(restored && restored.wired, 'wiring (shared channel) survived round-trip');
    ok(restored && String(restored.acVal) === '6', `live routing works in reopened quine (got ${restored && restored.acVal})`);
  }

  // pasted/dropped clipboard bitmap > b64 <img> inside handled comp-wrapper (harvest-style import)
  const imgPaste = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const png = new Uint8Array([${PNG_1PX}]);
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'pixel.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    const w = document.querySelector('.comp-wrapper');
    const img = w && w.querySelector('img[data-scv-id]');
    const src = img && img.getAttribute('src') || '';
    return {
      hasW: !!w, isData: src.startsWith('data:image/png;base64,'), hasId: !!img,
      handles: w ? w.querySelectorAll('.comp-handles .comp-drag-handle, .comp-drag-edge').length > 0 : false,
      selected: !!w && w.classList.contains('selected'),
    };
  })()`, true);
  ok(imgPaste && imgPaste.hasW && imgPaste.isData && imgPaste.hasId && imgPaste.handles,
    `clipboard bitmap paste spawns handled comp-wrapper <img> (${JSON.stringify(imgPaste)})`);
  ok(imgPaste && imgPaste.selected, 'pasted image is active selection (handles shown)');
  const imgUndo = await jsRaw(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    return document.querySelectorAll('.comp-wrapper img[src^="data:image/"]').length === 0;
  })()`);
  ok(imgUndo, 'undo removes pasted image wrapper');

  // drop branch shares same import path: image file dropped on canvas
  const imgDrop = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const png = new Uint8Array([${PNG_1PX}]);
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'pixel.png', { type: 'image/png' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 140, clientY: 90, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    const w = document.querySelector('.comp-wrapper');
    const img = w && w.querySelector('img[data-scv-id]');
    const src = img && img.getAttribute('src') || '';
    return {
      hasW: !!w, isData: src.startsWith('data:image/png;base64,'), hasId: !!img,
      handles: w ? w.querySelectorAll('.comp-handles .comp-drag-handle, .comp-drag-edge').length > 0 : false,
      selected: !!w && w.classList.contains('selected'),
    };
  })()`, true);
  ok(imgDrop && imgDrop.hasW && imgDrop.isData && imgDrop.hasId && imgDrop.handles,
    `dropped bitmap spawns handled comp-wrapper <img> (${JSON.stringify(imgDrop)})`);
  ok(imgDrop && imgDrop.selected, 'dropped image is active selection (handles shown)');
  const imgDropUndo = await jsRaw(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    return document.querySelectorAll('.comp-wrapper img[src^="data:image/"]').length === 0;
  })()`);
  ok(imgDropUndo, 'undo removes dropped image wrapper');

  // small-fix batch assertions
  const smallFixes = await jsRaw(`(async () => {
    const out = {};
    // url holding commas parses whole - no phantom tail target
    const qc = createScavQuestClient(); // quests client instance (patchbay's own is closure-local, not reachable)
    const line = qc.parseInputLine('https://api.example.com/?ids=1,2,3');
    out.line = line && line.url === 'https://api.example.com/?ids=1,2,3' && line.target === '';

    // reader round-trips: '007' stays string, plain '7' stays numeric
    const mkReader = val => {
      const r = document.createElement('scv-logic');
      r.setAttribute('data-type', 'reader');
      r.innerHTML = '<div class="scv-logic-icon"></div><input class="scv-logic-input" value="' + val + '"><div class="scv-logic-caret"></div><button class="scv-logic-del"></button><div class="scv-logic-drag"></div>';
      document.getElementById('zoom-layer').appendChild(r);
      return r;
    };
    const r007 = mkReader('007'), r7 = mkReader('7');
    out.readerStr = r007._storedValue === '007';
    out.readerNum = r7._storedValue === 7;
    r007.remove(); r7.remove();

    // paste path: copied+pasted reader must round-trip '007' same string-exact way typed one does
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const src007 = spawnLogicNode('reader', 120, 120);
    src007.querySelector('.scv-logic-input').value = '007';
    clearSelection(); selectEl(src007); updateSelectionDim();
    copySelected(); pasteSelected(400, 400);
    const pasted007 = [...document.querySelectorAll('scv-logic[data-type="reader"]')].find(n => n !== src007);
    out.readerPasteStr = !!pasted007 && pasted007._storedValue === '007';
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();

    // ctrl+shift+z redo works with uppercase 'Z' shift key produces
    const pre = document.querySelectorAll('scv-logic').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); // real spawn path pushes undo pair
    const s1 = document.querySelectorAll('scv-logic').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    const s2 = document.querySelectorAll('scv-logic').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true }));
    const s3 = document.querySelectorAll('scv-logic').length;
    out.redo = s1 === pre + 1 && s2 === pre && s3 === pre + 1;

    // ctrl+digit must not spawn (tab-switch left alone); held repeat must not repeat-spawn
    const b = document.querySelectorAll('scv-logic').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', ctrlKey: true, bubbles: true }));
    const c1 = document.querySelectorAll('scv-logic').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', repeat: true, bubbles: true }));
    const c2 = document.querySelectorAll('scv-logic').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }));
    const c3 = document.querySelectorAll('scv-logic').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    out.digit = c1 === b && c2 === b && c3 === b + 1;

    // single click selects alone and dims rest
    const mkWrap = (id, l, t) => {
      const w = document.createElement('div');
      w.className = 'comp-wrapper'; w.style.left = l + 'px'; w.style.top = t + 'px';
      const h = document.createElement('div'); h.dataset.scvId = id; w.appendChild(h);
      document.getElementById('zoom-layer').appendChild(w);
      return w;
    };
    const wa = mkWrap('w_sa', 300, 300), wb = mkWrap('w_sb', 420, 300);
    wa.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 305, clientY: 305 }));
    out.singleDim = wa.classList.contains('selected') && wb.classList.contains('dimmed');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    wa.remove(); wb.remove();

    // space-chain hover node clears when pointer moves onto empty canvas
    const stub = document.createElement('div'); stub.className = 'comp-wrapper';
    document.getElementById('zoom-layer').appendChild(stub);
    stub.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const armed = session.chainHoverNode === stub;
    stub.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: canvasContainer }));
    const cleared = session.chainHoverNode === null;
    stub.remove();
    out.chain = armed && cleared;

    // menu replacing open one fires onClose - ctxLockDir must not stay locked
    session.ctxLockDir = 'rt';
    showMenu([{ label: 'one', fn: () => {} }], 10, 10, ctxLockClear);
    showMenu([{ label: 'two', fn: () => {} }], 10, 10, ctxLockClear);
    out.menuLock = session.ctxLockDir === null;
    document.body.click(); // outside click dismisses second menu (handler attached via setTimeout)
    await new Promise(r => setTimeout(r, 20));
    out.menuDismiss = session.ctxLockDir === null;

    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    return out;
  })()`, true);
  ok(smallFixes && smallFixes.line, `parseInputLine keeps commas inside url (#334 ${JSON.stringify(smallFixes && smallFixes.line)})`);
  ok(smallFixes && smallFixes.readerStr && smallFixes.readerNum, `reader round-trips '007' as string and '7' as number (#319 ${JSON.stringify(smallFixes)})`);
  ok(smallFixes && smallFixes.readerPasteStr, `pasted reader preserves '007' string-exact, same as typed one (#319 paste path ${JSON.stringify(smallFixes && smallFixes.readerPasteStr)})`);
  ok(smallFixes && smallFixes.redo, `ctrl+shift+z redoes with uppercase 'Z' (#293 got ${JSON.stringify(smallFixes && smallFixes.redo)})`);
  ok(smallFixes && smallFixes.digit, `ctrl+digit and held-repeat don't spawn, plain digit does (#303/#297 got ${JSON.stringify(smallFixes && smallFixes.digit)})`);
  ok(smallFixes && smallFixes.singleDim, `single click selects alone and dims rest (#125 got ${JSON.stringify(smallFixes && smallFixes.singleDim)})`);
  ok(smallFixes && smallFixes.chain, `space-chain hover node clears on moving to empty canvas (#122 got ${JSON.stringify(smallFixes && smallFixes.chain)})`);
  ok(smallFixes && smallFixes.menuLock && smallFixes.menuDismiss, `replacing menu runs old onClose - ctxLockDir never stays locked (#304 got ${JSON.stringify(smallFixes)})`);

  // arrow-key nudge, ctrl+a select all, ctrl+d duplicate, pasted-image size clamp
  const canvasBasics = await jsRaw(`(() => {
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const out = {};

    // nudge: 1px per tap, 10px with shift, one undo step per tap (not per os key-repeat)
    const n = spawnLogicNode('reader', 200, 200);
    clearSelection(); selectEl(n); updateSelectionDim();
    const before = { x: px(n, 'left'), y: px(n, 'top') };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    out.step1 = px(n, 'left') - before.x === 1 && px(n, 'top') === before.y;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    out.step10 = px(n, 'top') - before.y === 10;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }));
    out.repeatIgnored = px(n, 'left') - before.x === 1; // repeat event above must not have moved it again
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    out.undone = px(n, 'left') === before.x && px(n, 'top') === before.y;
    n.remove();

    // select all - edit mode only
    const a = spawnLogicNode('reader', 100, 100), b = spawnLogicNode('gate', 300, 100);
    clearSelection();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    out.selectAll = isSelected(a) && isSelected(b);
    setMode('use'); clearSelection();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    out.selectAllUseModeNoop = !isSelected(a) && !isSelected(b); // selection is edit-only - use mode must not arm it invisibly
    setMode('edit');
    a.remove(); b.remove();

    // duplicate - same copy+paste machinery, standard 30px cursor-less offset, dup becomes new selection
    const d = spawnLogicNode('reader', 150, 150);
    clearSelection(); selectEl(d); updateSelectionDim();
    const countBefore = document.querySelectorAll('scv-logic').length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
    const dup = [...document.querySelectorAll('scv-logic')].find(x => x !== d);
    out.duplicated = document.querySelectorAll('scv-logic').length === countBefore + 1;
    out.dupOffset = !!dup && Math.abs(px(dup, 'left') - px(d, 'left') - 30) < 1 && Math.abs(px(dup, 'top') - px(d, 'top') - 30) < 1;
    out.dupIsNewSelection = !!dup && isSelected(dup) && !isSelected(d);
    d.remove(); dup?.remove();

    // pasted image is clamped to sane on-canvas size, not native pixel dimensions
    const markup = imgWrapperMarkup('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 400, 300);
    out.imgClamped = /max-width:\\s*400px/.test(markup) && /max-height:\\s*400px/.test(markup);

    invalidateCache();
    return out;
  })()`);
  ok(canvasBasics && canvasBasics.step1, `arrow-key nudges 1px (${JSON.stringify(canvasBasics)})`);
  ok(canvasBasics && canvasBasics.step10, 'shift+arrow nudges 10px');
  ok(canvasBasics && canvasBasics.repeatIgnored, 'held (repeat) arrow key does not re-nudge - one undo step per tap');
  ok(canvasBasics && canvasBasics.undone, 'two ctrl+z fully undoes both nudges');
  ok(canvasBasics && canvasBasics.selectAll, 'ctrl+a selects every node/wrapper in edit mode');
  ok(canvasBasics && canvasBasics.selectAllUseModeNoop, 'ctrl+a is no-op in use mode (selection is invisible there)');
  ok(canvasBasics && canvasBasics.duplicated, 'ctrl+d duplicates selection');
  ok(canvasBasics && canvasBasics.dupOffset, 'duplicate is offset by standard 30px cursor-less paste offset');
  ok(canvasBasics && canvasBasics.dupIsNewSelection, 'duplicate becomes new selection, original deselected');
  ok(canvasBasics && canvasBasics.imgClamped, 'pasted/dropped image is clamped to 400px max-width/max-height, not native pixel size');

  // pasted bare url > link card (host/path base, quest-enriched in place, bakes into quine)
  const linkPaste = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const origFetch = window.fetch;
    window.fetch = async () => { throw new Error('quests down'); }; // no quests: refused enrich fetch > host card stays, no console noise
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://www.example.com/alpha/beta');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    _stopCardRetry(); // down-server fetch armed silent-upgrade poll - stop for this block
    window.fetch = origFetch;
    const w = document.querySelector('.comp-wrapper');
    const card = w && w.querySelector('.scv-link-card');
    return {
      hasW: !!w, hasCard: !!card,
      title: card ? card.querySelector('.scv-lc-title').textContent : null,
      desc: card ? card.querySelector('.scv-lc-desc').textContent : null,
      thumbSrc: card ? card.querySelector('.scv-lc-thumb').getAttribute('src') : null,
      href: card ? card.querySelector('.scv-lc-open').getAttribute('href') : null,
      hostOnImg: card ? !!card.querySelector('.scv-lc-thumb[data-scv-id]') : false,
      handles: w ? w.querySelectorAll('.comp-handles .comp-drag-handle, .comp-drag-edge').length > 0 : false,
      selected: !!w && w.classList.contains('selected'),
      miss: card ? (() => { const t = card.querySelector('.scv-lc-thumb'); const before = t.getAttribute('src'); t.dispatchEvent(new Event('error')); return { before, after: t.getAttribute('src'), gif: t.getAttribute('src').startsWith('data:image/gif') }; })() : null,
    };
  })()`, true);
  const favSrc = 'https://www.example.com/favicon.ico';
  ok(linkPaste && linkPaste.hasW && linkPaste.hasCard && linkPaste.title === 'example.com' && linkPaste.desc === 'alpha / beta' && (linkPaste.thumbSrc === favSrc || linkPaste.thumbSrc.startsWith('data:image/gif')) && linkPaste.href === 'https://www.example.com/alpha/beta' && linkPaste.hostOnImg && linkPaste.handles,
    `pasted bare url spawns handled link card (${JSON.stringify(linkPaste)})`);
  ok(linkPaste && linkPaste.selected, 'pasted link card is active selection (handles shown)');
  ok(linkPaste && linkPaste.miss && linkPaste.miss.gif,
    `failed thumb swaps to transparent pixel - no broken-image white box (before ${linkPaste && linkPaste.miss.before}, after ${linkPaste && linkPaste.miss.after})`);

  // quest enrichment: stubbed unfurl fetch fills real title/description/image in place (no quests = host card stays)
  const enriched = await jsRaw(`(async () => {
    const png = new Uint8Array([${PNG_1PX}]);
    const card = document.querySelector('.comp-wrapper .scv-link-card');
    window.__QUEST_API__ = 'http://127.0.0.1:9876';
    const origFetch = window.fetch;
    window.fetch = async (u, o) => {
      if (String(u).includes('/unfurl?')) return { ok: true, json: async () => ({ title: 'Real Title', description: 'A real description.', image: 'https://cdn.example/img.png' }) };
      return new Response(new Blob([png], { type: 'image/png' })); // toBase64 fetch
    };
    await enrichCard(card.closest('.comp-wrapper'), 'https://www.example.com/alpha/beta');
    const title = card.querySelector('.scv-lc-title').textContent;
    const desc = card.querySelector('.scv-lc-desc').textContent;
    const src = card.querySelector('.scv-lc-thumb').getAttribute('src');
    window.fetch = origFetch;
    delete window.__QUEST_API__;
    return { title, desc, baked: src.startsWith('data:image/png;base64,') };
  })()`, true);
  ok(enriched && enriched.title === 'Real Title' && enriched.desc === 'A real description.' && enriched.baked,
    `quest enrichment fills card title/description and b64s image (${JSON.stringify(enriched)})`);

  // enriched card bakes into quine: reopened without quests keeps title/desc + data: thumb
  const linkBake = await jsRaw(`(async () => {
    let captured = null;
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = blob => { captured = blob; return 'blob:capture'; };
    const origRevoke = URL.revokeObjectURL; URL.revokeObjectURL = () => {};
    await saveQuine();
    URL.createObjectURL = origCreate; URL.revokeObjectURL = origRevoke;
    return captured ? await captured.text() : null;
  })()`, true);
  ok(typeof linkBake === 'string' && linkBake.includes('Real Title') && linkBake.includes('A real description.') && linkBake.includes('data:image/png;base64,'),
    'enriched card bakes title/description/data: thumb into quine');
  checkpointErrs('the linked-card quine capture', /blob:/i); // known noise: quine-capture download click's blob: href

  const linkUndo = await jsRaw(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    return document.querySelectorAll('.comp-wrapper .scv-link-card').length === 0;
  })()`);
  ok(linkUndo, 'undo removes pasted link card');

  // silent upgrade: host-grade card enriches in place once server answers, survives quine round-trip so init() re-upgrades
  const silentUp = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const png = new Uint8Array([${PNG_1PX}]);
    const origFetch = window.fetch;
    window.fetch = async () => { throw new Error('quests down'); };
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://www.example.com/alpha/beta');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    _stopCardRetry();
    window.fetch = origFetch;
    // host-grade card round-trips through quine unmarked - reopened quine's boot sweep would re-upgrade it
    let quine = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    URL.createObjectURL = x => { quine = x; return 'blob:q'; }; URL.revokeObjectURL = () => {};
    await saveQuine();
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
    const qtext = await quine.text();
    // now server answers: enrichCards upgrades old card in place, no re-paste
    window.__QUEST_API__ = 'http://127.0.0.1:9876';
    window.fetch = async (u, o) => {
      if (String(u).includes('/unfurl?')) return { ok: true, json: async () => ({ title: 'Upgraded Title', description: 'Now with data.', image: 'https://cdn.example/img.png' }) };
      return new Response(new Blob([png], { type: 'image/png' }));
    };
    await enrichCards();
    await new Promise(r => setTimeout(r, 120));
    const card = document.querySelector('.comp-wrapper .scv-link-card');
    const title = card.querySelector('.scv-lc-title').textContent;
    const desc = card.querySelector('.scv-lc-desc').textContent;
    const baked = card.querySelector('.scv-lc-thumb').getAttribute('src').startsWith('data:image/png;base64,');
    const marked = card.dataset.scvLc === '1';
    window.fetch = origFetch; delete window.__QUEST_API__; _stopCardRetry();
    return { title, desc, baked, marked, reopenable: qtext.includes('example.com') && !qtext.includes('data-scv-lc="1"') };
  })()`, true);
  ok(silentUp && silentUp.title === 'Upgraded Title' && silentUp.desc === 'Now with data.' && silentUp.baked && silentUp.marked && silentUp.reopenable,
    `silent upgrade: old host card enriches once quests answers, stays unmarked through quine (${JSON.stringify(silentUp)})`);
  checkpointErrs('silent-upgrade quine capture', /blob:/i); // known noise: same quine-capture download click's blob: href

  const linkUpUndo = await jsRaw(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    return document.querySelectorAll('.comp-wrapper .scv-link-card').length === 0;
  })()`);
  ok(linkUpUndo, 'undo removes upgraded link card');

  // crop edges: cropping link card clips whole card, not just thumbnail host
  const cropCard = await jsRaw(`(() => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const origFetch = window.fetch;
    window.fetch = async () => { throw new Error('quests down'); };
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://www.example.com/alpha/beta');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    window.fetch = origFetch; _stopCardRetry();
    const w = document.querySelector('.comp-wrapper');
    if (!w) return null;
    const card = w.querySelector('.scv-link-card'), img = w.querySelector('.scv-lc-thumb');
    applyCrop(w, img, { top: 8, right: 12, bottom: 4, left: 6 });
    const rail = w.querySelector('.comp-rail'),
          up = w.querySelector('.comp-z-up'), down = w.querySelector('.comp-z-down'),
          move = w.querySelector('.comp-drag-handle');
    const wRect = w.getBoundingClientRect(), rRect = rail.getBoundingClientRect();
    const rel = r => ({ x: r.left - wRect.left + r.width / 2, y: r.top - wRect.top + r.height / 2 });
    const u = rel(up.getBoundingClientRect()), d = rel(down.getBoundingClientRect()),
          m = rel(move.getBoundingClientRect());
    return {
      cardClip: getComputedStyle(card).clipPath,
      imgClip: getComputedStyle(img).clipPath,
      edgeR: getComputedStyle(w).getPropertyValue('--c-r').trim(),
      handlesZ: getComputedStyle(w.querySelector('.comp-handles')).zIndex,
      edgeZ: getComputedStyle(w.querySelector('.comp-drag-edge')).zIndex,
      railDisplay: getComputedStyle(rail).display,
      zUp: getComputedStyle(up).backgroundColor,
      zUpRound: getComputedStyle(up).borderRadius,
      zUpAfter: getComputedStyle(up, '::after').inset,
      upSvg: !!up.querySelector('svg'), downSvg: !!down.querySelector('svg'),
      moveSvg: !!move.querySelector('svg'),
      delSvg: !!w.querySelector('.comp-del svg'), scaleSvg: !!w.querySelector('.comp-scale-handle svg'),
      upSvgW: getComputedStyle(up.querySelector('svg')).width,
      downSvgW: getComputedStyle(down.querySelector('svg')).width,
      moveSvgW: getComputedStyle(move.querySelector('svg')).width,
      delSvgW: getComputedStyle(w.querySelector('.comp-del svg')).width,
      scaleSvgW: getComputedStyle(w.querySelector('.comp-scale-handle svg')).width,
      onLeftEdge: Math.abs(u.x + 24) < 1 && Math.abs(d.x + 24) < 1 && Math.abs(m.x + 24) < 1, // buttons center one grid cell left of edge - lands on dot column when snapped
      gap: u.x + 9,
      upAboveDown: u.y < d.y,
      moveCenteredY: Math.abs(m.y - wRect.height / 2) < 1,
      stackCentered: Math.abs((u.y + d.y) / 2 - wRect.height / 2) < 1,
      pitch: d.y - u.y,
      railLeft: rRect.left - wRect.left,
      cornerOffY: (() => {
        const del = w.querySelector('.comp-del'), scale = w.querySelector('.comp-scale-handle');
        const dr = del.getBoundingClientRect(), sr = scale.getBoundingClientRect();
        const dIcon = del.querySelector('svg').getBoundingClientRect(), sIcon = scale.querySelector('svg').getBoundingClientRect();
        return {
          del: (dIcon.top + dIcon.height / 2) - (dr.top + dr.height / 2),
          scale: (sIcon.top + sIcon.height / 2) - (sr.top + sr.height / 2),
          railUp: (() => { const u2 = up.querySelector('svg').getBoundingClientRect(); return (u2.top + u2.height / 2) - (uRect2().top + uRect2().height / 2); })(),
        };
        function uRect2() { return up.getBoundingClientRect(); }
      })(),
    };
  })()`);
  ok(cropCard && /^inset\(8px 12px 4px 6px\)$/.test(cropCard.cardClip) && cropCard.imgClip === 'none' && cropCard.edgeR === '12px',
    `crop edges clip whole link card, not just thumbnail (${JSON.stringify(cropCard)})`);
  ok(cropCard && cropCard.handlesZ === '2147483647' && cropCard.edgeZ === '2147483646',
    `corner buttons sit above crop edges where strips overlap them (handles z ${cropCard && cropCard.handlesZ}, edge z ${cropCard && cropCard.edgeZ})`);
  ok(cropCard && cropCard.railDisplay === 'flex' && cropCard.zUp === 'rgb(26, 28, 28)'
    && cropCard.zUpRound === '50%' && cropCard.zUpAfter === '-6px'
    && cropCard.upSvg && cropCard.downSvg && cropCard.moveSvg && cropCard.delSvg && cropCard.scaleSvg
    && parseFloat(cropCard.upSvgW) === 12 && parseFloat(cropCard.downSvgW) === 12
    && Math.abs(parseFloat(cropCard.moveSvgW) - 10.2) < 0.1
    && Math.abs(parseFloat(cropCard.delSvgW) - 10.2) < 0.1
    && Math.abs(parseFloat(cropCard.scaleSvgW) - 10.2) < 0.1
    && cropCard.onLeftEdge && cropCard.upAboveDown && cropCard.moveCenteredY && cropCard.stackCentered
    && Math.abs(cropCard.pitch - 48) < 1 && Math.abs(cropCard.railLeft + 33) < 1
    && Math.abs(cropCard.gap + 15) < 1,
    `left-edge rail hovering outside wrapper, vertically centered, ▲ + ▼ stacked around move handle, all svg icons, no shared boundary so no zoom seam (pitch ${cropCard && cropCard.pitch.toFixed(1)}, gap ${cropCard && cropCard.gap.toFixed(1)}, up ${cropCard && cropCard.upSvgW}/${cropCard && cropCard.downSvgW}/${cropCard && cropCard.moveSvgW}/${cropCard && cropCard.delSvgW}/${cropCard && cropCard.scaleSvgW}, cornerOff ${cropCard && JSON.stringify(cropCard.cornerOffY)})`);

  // button hitboxes beat crop edges - ::after enlarges corner button above strips, so corner probe hits button
  const hitProbe = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const origFetch = window.fetch;
    window.fetch = async () => { throw new Error('quests down'); };
    const dt = new DataTransfer();
    dt.setData('text/plain', 'https://www.example.com/alpha/beta');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    window.fetch = origFetch; _stopCardRetry();
    const w = document.querySelector('.comp-wrapper');
    if (!w) return null;
    w.style.left = '160px'; w.style.top = '160px'; // pull on-screen so hit-testing works
    const del = w.querySelector('.comp-del');
    const c = del.getBoundingClientRect();
    const hit = document.elementFromPoint(c.left + c.width / 2 - 8.5, c.top + c.height / 2 + 8.5); // down-left: inside t/r strips, outside 18px circle, inside enlarged hitbox
    const up = w.querySelector('.comp-z-up');
    const u = up.getBoundingClientRect();
    const hitUp = document.elementFromPoint(u.left + u.width / 2 + 9, u.top + u.height / 2 - 4); // in gap beside wrapper: outside 18px circle, inside enlarged rail-button hitbox, clear of move button below
    return {
      hitIsDel: hit === del || del.contains(hit),
      hitClass: hit && (hit.className || hit.tagName),
      afterInset: getComputedStyle(del, '::after').inset,
      scaleInset: getComputedStyle(w.querySelector('.comp-scale-handle'), '::after').inset,
      railInset: getComputedStyle(up, '::after').inset,
      hitIsRailUp: hitUp === up || up.contains(hitUp),
      hitUpClass: hitUp && (hitUp.className || hitUp.tagName),
      edgeZ: getComputedStyle(w.querySelector('.comp-drag-edge')).zIndex,
    };
  })()`, true);
  ok(hitProbe && hitProbe.hitIsDel && hitProbe.afterInset === '-6px' && hitProbe.scaleInset === '-6px',
    `corner buttons grow bigger invisible hitbox (::after inset ${hitProbe && hitProbe.afterInset}) and win crop-edge overlap (probe hit ${hitProbe && hitProbe.hitClass})`);
  ok(hitProbe && hitProbe.hitIsRailUp && hitProbe.railInset === '-6px',
    `left-rail buttons grow same invisible hitbox reaching toward edge (probe hit ${hitProbe && hitProbe.hitUpClass})`);

  // scavenged component with baked z-index: chrome stays on top - mirror harvest's baked z with :host-positioned widget
  const scavZ = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const tag = 'scv-zoverlay';
    if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<div style="position:relative;z-index:99999;width:200px;height:80px;background:#123">z</div>';
      }
    });
    const comp = { tag, scvId: 'z_000000001', script: '',
      x: (200 + canvasContainer.scrollLeft) / session.zoom, y: (200 + canvasContainer.scrollTop) / session.zoom, scale: 1, zIndex: 1 };
    const w = renderComponent(comp);
    await new Promise(r => setTimeout(r, 60));
    if (!w.isConnected) return null;
    const del = w.querySelector('.comp-del'), dragH = w.querySelector('.comp-drag-handle');
    const probe = el => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === el || el.contains(h); };
    const shadowRootZ = w.querySelector(tag).shadowRoot.querySelector('div');
    return { baked: getComputedStyle(shadowRootZ).zIndex, hitIsDel: probe(del), hitIsDrag: probe(dragH) };
  })()`, true);
  ok(scavZ && scavZ.baked === '99999', `scavenged widget bakes z-index onto shadow root (${scavZ && JSON.stringify(scavZ)})`);
  ok(scavZ && scavZ.hitIsDel && scavZ.hitIsDrag,
    `corner buttons stay clickable over z-indexed scavenged component (del ${scavZ && scavZ.hitIsDel}, drag ${scavZ && scavZ.hitIsDrag})`);

  // wire-delete peels one layer per click - both receives + action on one channel share cable, so one click mustn't drop both
  const wireDelete = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const out = {};
    const click = sel => {
      const c = document.querySelector(sel);
      c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    };

    // dual-layer: receives + action on same channel - first click peels receives, second peels action
    const a = spawnLogicNode('reader', 100, 100), b = spawnLogicNode('action', 400, 100);
    a.setAttribute('data-scv-emits', 'ch_dual'); b.setAttribute('data-scv-receives', 'ch_dual'); b.setAttribute('data-scv-action', 'toggle:ch_dual');
    invalidateCache(); renderCables();
    await new Promise(r => setTimeout(r, 60));
    click('.cable-path[data-channel="ch_dual"]');
    await new Promise(r => setTimeout(r, 60));
    out.firstClick = { recv: b.getAttribute('data-scv-receives'), act: b.getAttribute('data-scv-action') };
    click('.cable-path[data-channel="ch_dual"]');
    await new Promise(r => setTimeout(r, 60));
    out.secondClick = { recv: b.getAttribute('data-scv-receives'), act: b.getAttribute('data-scv-action') };
    a.remove(); b.remove();

    // action-token: compound verb has channel at index 2 - whole-token compare never matches it (old bug), sibling survives
    const c = spawnLogicNode('reader', 100, 300), d = spawnLogicNode('action', 400, 300);
    c.setAttribute('data-scv-emits', 'ch_tok'); d.setAttribute('data-scv-action', 'prop:style.color:ch_tok hide:ch_other');
    invalidateCache(); renderCables();
    await new Promise(r => setTimeout(r, 60));
    click('.cable-path[data-channel="ch_tok"]');
    await new Promise(r => setTimeout(r, 60));
    out.tokenParsed = d.getAttribute('data-scv-action');
    c.remove(); d.remove();

    invalidateCache();
    return out;
  })()`, true);
  ok(wireDelete && wireDelete.firstClick?.recv === null && wireDelete.firstClick?.act === 'toggle:ch_dual',
    `first click on dual-layer cable peels only receives wiring, leaving action wiring intact (${JSON.stringify(wireDelete && wireDelete.firstClick)})`);
  ok(wireDelete && wireDelete.secondClick?.act === null,
    `second click on now action-only cable peels action wiring too (${JSON.stringify(wireDelete && wireDelete.secondClick)})`);
  ok(wireDelete && wireDelete.tokenParsed === 'hide:ch_other',
    `compound action verb's embedded channel (index 2, not whole token) is what gets matched and removed - unrelated sibling token survives (${JSON.stringify(wireDelete && wireDelete.tokenParsed)})`);

  // harvested @container widget must not collapse - container-type:inline-size zeroes shrink-to-fit host with no size yet
  const containerScope = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const tag = 'scv-flexwidget';
    if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<style>.row{display:flex;flex-wrap:wrap}.sq{width:100px;height:100px;background:#333}.wide{width:200px;height:60px;background:#666}</style>'
          + '<div class="row"><div class="sq"></div><div class="sq"></div><div class="wide"></div></div>';
      }
    });
    const comp = { tag, scvId: 'fw_000000001', script: '/* @container (min-width: 10px) { } */',
      x: (200 + canvasContainer.scrollLeft) / session.zoom, y: (200 + canvasContainer.scrollTop) / session.zoom, scale: 1, zIndex: 1 };
    const w = renderComponent(comp);
    await new Promise(r => setTimeout(r, 80));
    if (!w.isConnected) return null;
    const el = w.querySelector(tag);
    return { hostContainerType: el.style.containerType, wrapperWidth: w.getBoundingClientRect().width, hostWidth: el.getBoundingClientRect().width };
  })()`, true);
  ok(containerScope && containerScope.hostContainerType === 'inline-size', `@container-scoped harvest gets container-type set (${containerScope && JSON.stringify(containerScope)})`);
  ok(containerScope && containerScope.wrapperWidth > 300 && containerScope.hostWidth > 300,
    `host is frozen at its natural width before containment applies, so wrapper doesn't collapse (${containerScope && JSON.stringify(containerScope)})`);

  // same, zoomed out - frozen width is css px but getBoundingClientRect reads post-zoom px, so freeze must divide zoom back out
  const containerScopeZoomed = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    session.zoom = 0.5; zoomLayer.style.transform = 'scale(0.5)';
    const tag = 'scv-wide1920';
    if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<div style="width:1920px;height:400px;background:#333"></div>';
      }
    });
    const comp = { tag, scvId: 'w1920_00001', script: '/* @container (min-width: 10px) { } */', x: 0, y: 0, scale: 1, zIndex: 1 };
    const w = renderComponent(comp);
    await new Promise(r => setTimeout(r, 100));
    const el = w.querySelector(tag);
    const out = { hostCssWidth: parseFloat(el.style.width), wrapperScreenWidth: w.getBoundingClientRect().width };
    session.zoom = 1; zoomLayer.style.transform = 'scale(1)'; // restore for subsequent tests
    return out;
  })()`, true);
  ok(containerScopeZoomed && Math.abs(containerScopeZoomed.hostCssWidth - 1920) < 2,
    `at 0.5x zoom, frozen width is still true 1920px css size, not zoomed screen size (${containerScopeZoomed && JSON.stringify(containerScopeZoomed)})`);
  ok(containerScopeZoomed && Math.abs(containerScopeZoomed.wrapperScreenWidth - 960) < 2,
    `...so on-screen box renders at exactly 0.5x that (960px), matching real visual size at this zoom (${containerScopeZoomed && JSON.stringify(containerScopeZoomed)})`);

  // number-key spawn during armed space-chain must still connect - setMode('edit') runs per spawn, mustn't reset chain
  const chainThroughSpawn = await jsRaw(`(() => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const key = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('1');
    const n1 = session.lastSpawned;
    key(' ');
    const armed = session.isChainPending;
    key('2');
    const n2 = session.lastSpawned;
    // real mode switch (edit->use) must still tear chain down - only redundant same-mode call preserves it
    key('1'); key(' ');
    const armedBeforeSwitch = session.isChainPending;
    setMode('use'); const armedAfterSwitch = session.isChainPending, spawnedAfterSwitch = session.lastSpawned;
    setMode('edit');
    return { armed, n2Wired: !!(n2 && n2.getAttribute('data-scv-receives')),
             switchResets: armedBeforeSwitch === true && armedAfterSwitch === false && spawnedAfterSwitch === null };
  })()`);
  ok(chainThroughSpawn && chainThroughSpawn.armed, 'space arms chain while already in edit mode');
  ok(chainThroughSpawn && chainThroughSpawn.n2Wired, `spawning next node via number key completes chain, not just spawns unconnected (${JSON.stringify(chainThroughSpawn)})`);
  ok(chainThroughSpawn && chainThroughSpawn.switchResets, `real edit->use mode switch still tears down armed chain, while redundant same-mode call preserves it (${JSON.stringify(chainThroughSpawn)})`);

  // ctrl+digit during chain inverts direction; outside chain must not spawn - falls through to browser tab-switch
  const ctrlChain = await jsRaw(`(() => {
    const key = (k, extra={}) => document.dispatchEvent(new KeyboardEvent('keydown', { key:k, bubbles:true, cancelable:true, ...extra }));
    // inverse: ctrl+digit while chaining - spawned node emits, previous receives
    setMode('edit'); document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    key('1'); const a1 = session.lastSpawned;
    key(' ');
    key('2', { ctrlKey: true }); const a2 = session.lastSpawned;
    const inverseCh = a2 && a2.getAttribute('data-scv-emits');
    const inverted = !!inverseCh && (a1.getAttribute('data-scv-receives') || '').split(' ').includes(inverseCh) && !a2.getAttribute('data-scv-receives');
    // no-chain: ctrl+digit with nothing armed must not spawn and must not preventDefault (browser tab-switch wins)
    setMode('edit'); document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const before = document.querySelectorAll('scv-logic').length;
    const ev = new KeyboardEvent('keydown', { key:'3', ctrlKey:true, bubbles:true, cancelable:true });
    document.dispatchEvent(ev);
    return { inverted, noChainSpawned: document.querySelectorAll('scv-logic').length - before, noChainPrevented: ev.defaultPrevented };
  })()`);
  ok(ctrlChain && ctrlChain.inverted, `ctrl+digit during chain wires new node back into previous (inverse direction) (${JSON.stringify(ctrlChain)})`);
  ok(ctrlChain && ctrlChain.noChainSpawned === 0 && ctrlChain.noChainPrevented === false,
    `ctrl+digit with no chain armed spawns nothing and lets browser handle it (tab-switch) (${JSON.stringify(ctrlChain)})`);

  // every path calling setMode('edit') already in edit mode (paste/drop) mustn't disrupt chain - only real switch tears down
  const chainThroughPaste = await jsRaw(`(async () => {
    const key = (k, extra={}) => document.dispatchEvent(new KeyboardEvent('keydown', { key:k, bubbles:true, cancelable:true, ...extra }));
    setMode('edit'); document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove()); invalidateCache();
    key('1'); key(' '); // arm chain
    const before = document.querySelectorAll('scv-logic').length;
    const dt = new DataTransfer();
    dt.setData('text/plain', '<scv-logic data-scv-id="chain_paste_probe"></scv-logic>'); // triggers harvest/.scv paste branch - handlePasteData mints fresh id, so check by count
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 60));
    return { chainSurvivedPaste: session.isChainPending, pastedProbe: document.querySelectorAll('scv-logic').length > before };
  })()`, true);
  ok(chainThroughPaste && chainThroughPaste.pastedProbe, `harvest paste mid-chain still imports payload (${JSON.stringify(chainThroughPaste)})`);
  ok(chainThroughPaste && chainThroughPaste.chainSurvivedPaste,
    `pasting harvest payload mid-chain (setMode('edit') called while already in edit mode) does not disarm chain (${JSON.stringify(chainThroughPaste)})`);

  // workshop chrome (studio-only): intro menu, bg picker, dot grid, edge tooltip - robust reads only, never mid-transition value
  const hexToRgb = h => { const n = parseInt(h.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; };
  await load(pbUrl); // clean, empty canvas in edit mode
  ok(await jsRaw(`session.mode === 'edit'`), 'patchbay boots in edit mode');

  // intro menu: two columns (9 node keys left, 9 commands right) each internally aligned, ctrl
  const intro = await jsRaw(`(() => {
    const m = document.getElementById('intro-menu'); if (!m) return null;
    const colAligned = sel => {
      const dt = new Set([...m.querySelectorAll(sel + ' dt')].map(d => Math.round(d.getBoundingClientRect().right)));
      const dd = new Set([...m.querySelectorAll(sel + ' dd')].map(d => Math.round(d.getBoundingClientRect().left)));
      return dt.size === 1 && dd.size === 1;
    };
    const all = [...m.querySelectorAll('.intro-cols dt')];
    const twoCols = m.querySelectorAll('.intro-cols dl').length === 2;
    return {
      onEmpty: m.classList.contains('on'),
      keysN: m.querySelectorAll('.intro-keys dt').length, nodesN: m.querySelectorAll('.intro-nodes dt').length,
      twoCols, aligned: colAligned('.intro-keys') && colAligned('.intro-nodes'),
      ctrl: all.some(d => d.textContent.includes('ctrl + z')) && all.every(d => !d.textContent.includes('⌘')),
    };
  })()`);
  ok(intro && intro.onEmpty, 'intro menu shows as empty-state (edit + empty canvas)');
  ok(intro && intro.twoCols && intro.keysN === 9 && intro.nodesN === 9, `intro is two columns of 9 (keys ${intro && intro.keysN} / nodes ${intro && intro.nodesN})`);
  ok(intro && intro.aligned, 'within each column, keys and meanings align');
  ok(intro && intro.ctrl, 'shortcuts show ctrl (with spaces), not command icon');
  const sig = await jsRaw(`getComputedStyle(document.documentElement).getPropertyValue('--output').trim()`);
  const att = await jsRaw(`getComputedStyle(document.documentElement).getPropertyValue('--input').trim()`);
  const keyCols = await jsRaw(`[...document.querySelectorAll('#intro-menu .intro-keys dt')].map(d=>getComputedStyle(d).color)`);
  const nodeCols = await jsRaw(`[...document.querySelectorAll('#intro-menu .intro-nodes dt')].map(d=>getComputedStyle(d).color)`);
  ok(Array.isArray(nodeCols) && nodeCols.length === 9 && nodeCols.every(c => c === hexToRgb(sig)), 'left column (node numbers) uses primary accent (pink)');
  ok(Array.isArray(keyCols) && keyCols.length === 9 && keyCols.every(c => c === hexToRgb(att)), 'right column (commands) uses attention color (teal)');

  // ? overlay toggles (tint-free) backdrop and dismisses via ? / esc
  const overlay = await jsRaw(`(() => {
    const bd = document.getElementById('intro-backdrop');
    const fire = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    fire('?'); const opened = bd.classList.contains('on');
    fire('?'); const off = !bd.classList.contains('on');
    fire('?'); fire('Escape'); const esc = !bd.classList.contains('on');
    return { opened, off, esc, tint: getComputedStyle(bd).backgroundColor };
  })()`);
  ok(overlay.opened, '? opens help overlay');
  ok(overlay.off, '? again closes it');
  ok(overlay.esc, 'Escape closes overlay');
  ok(overlay.tint === 'rgba(0, 0, 0, 0)', 'backdrop has no color tint (blur only)');

  // bg picker: opens, validates, drives grid luminance, uppercase, caret-editable
  const picker = await jsRaw(`(() => {
    const dot = document.getElementById('bg-dot'), sw = document.getElementById('bg-swatch'), hx = document.getElementById('bg-hex');
    sw.click(); const opened = dot.classList.contains('open');
    hx.value = '#334455'; hx.dispatchEvent(new Event('input'));
    const applied = document.documentElement.style.getPropertyValue('--background-sunk').trim() === '#334455';
    hx.value = '#eeeeee'; hx.dispatchEvent(new Event('input'));
    // parse rgb triple out, don't match exact string - 'rgba(0,0,0' would break the moment css-var gains spaces
    const gridMatch = /rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/.exec(document.documentElement.style.getPropertyValue('--background-grid'));
    const darkDots = !!gridMatch && gridMatch[1] === '0' && gridMatch[2] === '0' && gridMatch[3] === '0'; // light bg (#eeeeee) picks dark (black) dots
    hx.value = 'zzz'; hx.dispatchEvent(new Event('input'));
    const flagged = hx.classList.contains('bad') && document.documentElement.style.getPropertyValue('--background-sunk').trim() === '#eeeeee';
    hx.value = '#111111'; hx.focus(); hx.setSelectionRange(2, 2); hx.setRangeText('A', 2, 2, 'end');
    const editable = document.activeElement === hx && hx.value.includes('A');
    return { opened, applied, darkDots, flagged, editable, upper: getComputedStyle(hx).textTransform };
  })()`);
  ok(picker.opened, 'swatch click opens hex pill');
  ok(picker.applied, 'valid hex applies to --background-sunk');
  ok(picker.darkDots, 'light bg flips grid dots dark (luminance)');
  ok(picker.flagged, 'invalid hex is flagged and does not change --background-sunk');
  ok(picker.editable, 'hex field is focusable + caret-editable');
  ok(picker.upper === 'uppercase', 'hex field renders uppercase');

  // dot grid: single layer, uniform scale (dot radius tracks zoom)
  const grid = await jsRaw(`(() => {
    const layers = getComputedStyle(document.getElementById('canvas-container'), '::before').backgroundImage.split('radial-gradient').length - 1;
    setZoom(1, 400, 300); const s1 = getComputedStyle(document.documentElement).getPropertyValue('--grid-size').trim();
    setZoom(0.5, 400, 300); const r = getComputedStyle(document.documentElement).getPropertyValue('--background-grid-r').trim();
    setZoom(1, 400, 300);
    return { layers, s1, r };
  })()`);
  ok(grid.layers === 1, `grid is single dot layer (got ${grid.layers})`);
  ok(grid.s1 === '24px', 'grid spacing is 24px at zoom 1');
  ok(grid.r === '0.5px', 'dot radius scales with zoom (uniform, continuous)');

  // edge-aware tooltip mirrors away from corner it is near, staying in viewport
  const tip = await jsRaw(`(() => {
    const t = document.getElementById('wiring-tooltip'); t.textContent = '#x'; t.style.display = 'block';
    placeTooltip(t, innerWidth - 10, innerHeight - 10);
    const l = parseFloat(t.style.left), tp = parseFloat(t.style.top);
    return { mirrored: l < innerWidth - 10 && tp < innerHeight - 10, inView: l >= 0 && tp >= 0 };
  })()`);
  ok(tip.mirrored, 'tooltip near bottom-right mirrors up-left');
  ok(tip.inView, 'tooltip stays within viewport');

  const undoCap = await jsRaw(`(() => {
    session.undoStack.length = 0; session.undoPos = -1;
    let last = null;
    for (let i = 0; i < 60; i++) pushUndo(() => {}, ((n) => () => { last = n; })(i), 'm' + i);
    const len = session.undoStack.length, pos = session.undoPos;
    undo();
    return { len, pos, last, label: session.undoStack[session.undoStack.length - 1].label };
  })()`);
  ok(undoCap && undoCap.len === 50, `undo stack is capped at UNDO_MAX (got ${undoCap && undoCap.len})`);
  ok(undoCap && undoCap.last === 59, `undo after cap replays newest action, not shifted one (got ${undoCap && undoCap.last})`);
  ok(undoCap && undoCap.label === 'm59', `newest action survives shift (got ${undoCap && undoCap.label})`);

  const pasteText = async (txt) => await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('.comp-wrapper').forEach(n => n.remove()); invalidateCache();
    const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(txt)});
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 150));
    const card = document.querySelector('.scv-link-card');
    return { card: !!card, href: card ? card.querySelector('.scv-lc-open').getAttribute('href') : null,
             title: card ? card.querySelector('.scv-lc-title').textContent : null };
  })()`, true);

  const plain = await pasteText('just some notes, not a url');
  ok(plain && plain.card === false, 'plain text does not become link card');
  const jsUrl = await pasteText('javascript:window.__pwn3=1');
  ok(jsUrl && jsUrl.card === false, 'javascript: url does not become link card');
  ok(await jsRaw(`!window.__pwn3`), 'pasted javascript: url never reaches href');
  const dataUrl = await pasteText('data:text/html,<script>window.__pwn4=1<\\/script>');
  ok(dataUrl && dataUrl.card === false, 'data: url does not become link card');

  const quoted = await pasteText('https://example.com/a"onmouseover="window.__pwn5=1');
  ok(quoted && quoted.card === true, 'normal https url still becomes link card');
  ok(quoted && quoted.href === 'https://example.com/a"onmouseover="window.__pwn5=1',
    `quote in pasted url stays inside href instead of ending it (${JSON.stringify(quoted && quoted.href)})`);
  ok(await jsRaw(`!document.querySelector('.scv-lc-open[onmouseover]')`), 'quote in pasted url cannot open new attribute on card');
  const marked = await pasteText('https://example.com/<img src=x>');
  ok(await jsRaw(`!document.querySelector('.scv-link-card img[src="x"]')`), 'markup in pasted url renders as text, not as element');

  const dsdPaste = await jsRaw(`(async () => {
    setMode('edit');
    document.querySelectorAll('.comp-wrapper').forEach(n => n.remove()); invalidateCache();
    delete window.__dsdPwn;
    handlePasteData('<div class="comp-wrapper" style="left:40px;top:40px" data-comp-id="dsd1">'
      + '<scv-dsdprobe data-scv-id="d1"><template shadowrootmode="open">'
      + '<img src="x" onerror="window.__dsdPwn=1"><b onclick="window.__dsdClick=1">i</b>'
      + '</template></scv-dsdprobe></div>');
    await new Promise(r => setTimeout(r, 900));
    const host = document.querySelector('scv-dsdprobe');
    const sr = host && host.shadowRoot;
    return { pasted: !!host, hydrated: !!sr,
             img: sr ? !!sr.querySelector('img[onerror]') : null,
             click: sr ? !!sr.querySelector('b[onclick]') : null,
             fired: !!window.__dsdPwn };
  })()`, true);
  ok(dsdPaste && dsdPaste.pasted && dsdPaste.hydrated, 'pasted declarative shadow root still hydrates');
  ok(dsdPaste && dsdPaste.img === false && dsdPaste.click === false,
    `on* handlers inside pasted declarative shadow template are stripped (${JSON.stringify(dsdPaste)})`);
  ok(dsdPaste && dsdPaste.fired === false, 'handler inside pasted shadow template never runs');

  const caps = await jsRaw(`(() => {
    const hit = {};
    const realSave = window.saveQuine, realPub = window.exportPublish, realRedo = window.redo;
    window.saveQuine = () => { hit.save = true; };
    window.exportPublish = () => { hit.publish = true; };
    window.redo = () => { hit.redo = true; };
    const tap = k => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }));
    ['S', 'P', 'Y'].forEach(tap);
    window.saveQuine = realSave; window.exportPublish = realPub; window.redo = realRedo;
    return hit;
  })()`);
  ok(caps && caps.save, 'ctrl + S (caps lock on) still saves quine');
  ok(caps && caps.publish, 'ctrl + P (caps lock on) still publishes');
  ok(caps && caps.redo, 'ctrl + Y (caps lock on) still redoes');

  const churn = `(async () => {
    setMode('edit');
    const types = ['clock','accumulator','gate','comparator','mutator','reader','action','variable'];
    const made = types.map((t, i) => spawnLogicNode(t, 100 + i * 90, 2200));
    for (let i = 0; i < made.length - 1; i++) autoWire(made[i], made[i + 1]);
    invalidateCache(); renderCables();
    made.forEach(n => n.classList.add('open')); renderCables();
    clearSelection(); made.forEach(selectEl); updateSelectionDim();
    copySelected(); pasteSelected(400, 2400);
    nudgeSelected(5, 5); nudgeSelected(-5, -5);
    deleteSelected(); undo(); redo(); undo();
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove());
    session.undoStack.length = 0; session.undoPos = -1;
    invalidateCache(); renderCables();
    await new Promise(r => setTimeout(r, 30));
  })()`;
  const counts = async () => {
    await send('HeapProfiler.collectGarbage').catch(() => {});
    const m = (await send('Performance.getMetrics'))?.result?.metrics || [];
    const g = k => (m.find(x => x.name === k) || {}).value ?? 0;
    return { listeners: g('JSEventListeners'), nodes: g('Nodes') };
  };
  await send('Performance.enable');
  await jsRaw(churn, true);                       // warm up - first cycle allocates one-time structures
  const soakBefore = await counts();
  for (let i = 0; i < 12; i++) await jsRaw(churn, true);
  const soakAfter = await counts();
  ok(soakAfter.listeners <= soakBefore.listeners, `twelve spawn/wire/paste/delete/undo cycles leak no listeners (${soakBefore.listeners} → ${soakAfter.listeners})`);
  ok(soakAfter.nodes <= soakBefore.nodes, `and leak no detached nodes (${soakBefore.nodes} → ${soakAfter.nodes})`);

  ok(errs.length === 0, `no uncaught js errors during run (${errs.slice(0, 3).join(' | ')})`);
  if (browserLogErrs.length) console.log(`  (info: ${browserLogErrs.length} browser-internal Log.entryAdded error(s), not our code - not counted against tier: ${browserLogErrs.slice(0, 2).join(' | ')})`);
} catch (e) {
  fails++; console.log('  ✗ patchbay tier threw:', e.message);
}

done();
console.log(fails ? `patchbay: FAIL (${fails})` : 'patchbay: PASS');
process.exit(fails ? 1 : 0);