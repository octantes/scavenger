// studio tier - editing surface: pointer-driven drag/scale/crop/lasso, copy-paste, z-order, zoom - real events end to end

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const pbUrl = pathToFileURL(join(here, '..', 'patchbay.html')).href;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
const errs = [];
await send('Runtime.enable'); await send('Page.enable');
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
const js = async (e, aw = false) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const done = () => { try { ws.close(); } catch {} cleanup(); };

// helpers injected into page: dispatch full pointer drag through document handlers
const HELPERS = `
  window.__pd = (target, x, y) => target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true }));
  window.__pm = (x, y, alt) => document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerId: 1, altKey: !!alt }));
  window.__pu = (x, y) => document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerId: 1 }));
  window.__center = el => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  true;`;

try {
  await send('Page.navigate', { url: pbUrl }); await waitEvent('Page.loadEventFired'); await delay(400);
  await js(`setMode('edit'); true`);
  await js(HELPERS);

  // drag logic node by drag-handle: left/top change to new position
  const drag = await js(`(async () => {
    const n = spawnLogicNode('accumulator', 200, 200);
    await new Promise(r => setTimeout(r, 60));
    const handle = n.querySelector('.scv-logic-drag');
    const [hx, hy] = window.__center(handle);
    const beforeLeft = parseFloat(n.style.left);
    window.__pd(handle, hx, hy);
    window.__pm(hx + 120, hy + 80);
    await new Promise(r => requestAnimationFrame(r));
    window.__pu(hx + 120, hy + 80);
    return { beforeLeft, afterLeft: parseFloat(n.style.left), afterTop: parseFloat(n.style.top) };
  })()`, true);
  ok(drag && Math.abs(drag.afterLeft - (drag.beforeLeft + 120)) < 8, `node drag moves it by pointer delta (${JSON.stringify(drag)})`);

  // lasso-select on empty canvas selects nodes inside box
  const lasso = await js(`(async () => {
    clearSelection();
    const a = spawnLogicNode('gate', 900, 900), b = spawnLogicNode('gate', 960, 940);
    await new Promise(r => setTimeout(r, 60));
    const [ax, ay] = window.__center(a), [bx, by] = window.__center(b);
    const x0 = Math.min(ax, bx) - 40, y0 = Math.min(ay, by) - 40, x1 = Math.max(ax, bx) + 40, y1 = Math.max(ay, by) + 40;
    // pointerdown on empty canvas > lasso; move to grow box; up to commit
    window.__pd(document.getElementById('canvas-container'), x0, y0);
    window.__pm(x1, y1); window.__pm(x1, y1);
    window.__pu(x1, y1);
    return selectedCount();
  })()`, true);
  ok(lasso >= 2, `lasso selects nodes inside box (selected ${lasso})`);

  // copy / paste selection: new node with same value appears
  const copyPaste = await js(`(() => {
    clearSelection();
    const n = spawnLogicNode('accumulator', 300, 500); n.querySelector('.scv-logic-input').value = '42';
    selectEl(n);
    copySelected();
    const before = document.querySelectorAll('scv-logic').length;
    pasteSelected(500, 500);
    const nodes = [...document.querySelectorAll('scv-logic')];
    const pasted = nodes.find(x => x !== n && x.querySelector('.scv-logic-input') && x.querySelector('.scv-logic-input').value === '42' && x.dataset.type === 'accumulator');
    return { grew: document.querySelectorAll('scv-logic').length === before + 1, pastedHasValue: !!pasted };
  })()`);
  ok(copyPaste && copyPaste.grew && copyPaste.pastedHasValue, `copy+paste clones node with its value (${JSON.stringify(copyPaste)})`);

  // zoom about point: session.zoom + layer transform update, clamped to range
  const zoom = await js(`(() => {
    const z0 = session.zoom; setZoom(2, 400, 300); const z2 = session.zoom;
    const tf = zoomLayer.style.transform;
    setZoom(99, 400, 300); const clamped = session.zoom; // clamps to 5
    setZoom(1, 400, 300);
    return { z0, z2, hasScale: /scale\\(2\\)/.test(tf), clamped };
  })()`);
  ok(zoom && zoom.z0 === 1 && zoom.z2 === 2 && zoom.hasScale && zoom.clamped === 5, `zoom sets scale + clamps to 5 (${JSON.stringify(zoom)})`);

  // undo restores dragged node's position
  const undoDrag = await js(`(async () => {
    const n = spawnLogicNode('reader', 1200, 300);
    await new Promise(r => setTimeout(r, 60));
    const handle = n.querySelector('.scv-logic-drag');
    const [hx, hy] = window.__center(handle);
    const start = parseFloat(n.style.left);
    window.__pd(handle, hx, hy); window.__pm(hx + 100, hy); await new Promise(r => requestAnimationFrame(r)); window.__pu(hx + 100, hy);
    const moved = parseFloat(n.style.left);
    undo();
    return { start, moved, restored: parseFloat(n.style.left) };
  })()`, true);
  ok(undoDrag && undoDrag.moved > undoDrag.start && Math.abs(undoDrag.restored - undoDrag.start) < 2, `undo restores dragged node (${JSON.stringify(undoDrag)})`);

  // composer: dropped component def registers reusable type; redrop updates placed instances in place, keeping data + adding field
  const comp = await js(`(async () => {
    const BT = String.fromCharCode(96);
    const def = extra => "<script data-scv-comp data-scv-tag=\\"scv-t\\">customElements.define('scv-t', class extends HTMLElement { constructor(){ super(); if(this.shadowRoot)return; const r = this.attachShadow({mode: 'open'}); r.innerHTML = " + BT + "<h3 data-scv-slot=title>x</h3>" + extra + BT + "; } });</scr" + "ipt>"; // variable-built shadow (non-canonical) exercises render-fallback markup path
    setMode('edit');
    const tag = registerComponentFile(def(''));                         // drop v1
    const a = spawnComponent(tag, 40, 40), b = spawnComponent(tag, 260, 40);
    const w = async ww => { for (let i = 0; i < 40; i++) { const el = ww.querySelector('[data-scv-id]'); if (el && el.shadowRoot && el.shadowRoot.querySelector('[data-scv-slot=title]')) return el; await new Promise(r => setTimeout(r, 50)); } };
    const ea = await w(a), eb = await w(b);
    ea.shadowRoot.querySelector('[data-scv-slot=title]').textContent = 'A';
    eb.shadowRoot.querySelector('[data-scv-slot=title]').textContent = 'B';
    document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }));
    const menuHas = [...document.querySelectorAll('.cmenu *')].some(n => /\\[comp\\]/.test(n.textContent)); document.querySelectorAll('.cmenu').forEach(m => m.remove());
    registerComponentFile(def('<p data-scv-slot=desc>d</p>'));          // drop v2 - adds field
    const g = (el, s) => { const n = el.shadowRoot.querySelector('[data-scv-slot=' + s + ']'); return n ? n.textContent : null; };
    return { menuHas, aT: g(ea, 'title'), aD: g(ea, 'desc'), bT: g(eb, 'title'), bD: g(eb, 'desc'), n: document.querySelectorAll('scv-t').length };
  })()`, true);
  ok(comp && comp.menuHas && comp.aT === 'A' && comp.bT === 'B' && comp.aD === 'd' && comp.bD === 'd' && comp.n === 2,
    `composed component: type registers to menu, redrop updates instances in place keeping data + adding field (${JSON.stringify(comp)})`);

  ok(errs.length === 0, `no uncaught errors during studio gestures (${errs.slice(0, 2).join(' | ')})`);
} catch (e) {
  fails++; console.log('  ✗ studio tier threw:', e.message);
}

// snap to grid - held alt magnetises: a node rides the dot by its centre, a component hangs its corner on it
const onLattice = v => ((v - 12) % 24 + 24) % 24 === 0;
const snap = await js(`(async () => {
  setMode('edit');
  const R = {};
  R.lattice = [0, 5, 11, 13, 23, 24, 37, 100].map(snapAxis);
  const altDrag = async (el, handle, dx, dy, alt) => {
    const [hx, hy] = window.__center(handle);
    window.__pd(handle, hx, hy);
    window.__pm(hx + dx, hy + dy, alt);
    await new Promise(r => requestAnimationFrame(r));
    const previewed = el.style.transform; // what the frame drew, before the drop bakes it
    window.__pu(hx + dx, hy + dy);
    return { previewed, left: parseFloat(el.style.left), top: parseFloat(el.style.top) };
  };
  const n = spawnLogicNode('accumulator', 200, 200);
  await new Promise(r => setTimeout(r, 60));
  const held = await altDrag(n, n.querySelector('.scv-logic-drag'), 53, 47, true);
  R.nodeCentreX = held.left + n.offsetWidth / 2;
  R.nodeCentreY = held.top + n.offsetHeight / 2;
  R.previewMatchesDrop = held.previewed.includes(String(Math.round(held.left - 200))); // frame drew the landing delta
  const free = await altDrag(n, n.querySelector('.scv-logic-drag'), 53, 47, false);
  R.freeLeft = free.left;
  // a component hangs its corner on the dot instead
  const w = document.createElement('div'); w.className = 'comp-wrapper';
  w.style.left = '300px'; w.style.top = '300px';
  const host = document.createElement('div'); host.dataset.scvId = 'snap_c';
  host.style.cssText = 'width:60px;height:40px;background:#333'; w.appendChild(host);
  w.insertAdjacentHTML('beforeend', COMP_CHROME); zoomLayer.appendChild(w);
  await new Promise(r => setTimeout(r, 60));
  const comp = await altDrag(w, w.querySelector('.comp-drag-handle'), 41, 41, true);
  R.compLeft = comp.left; R.compTop = comp.top;
  // arrows: alt walks a cell and pulls an off-lattice node on
  // scale: alt quantises the rendered width to whole cells (uniform scale, so height follows the aspect ratio)
  const sh = w.querySelector('.comp-scale-handle'); const [shx, shy] = window.__center(sh);
  window.__pd(sh, shx, shy); window.__pm(shx + 70, shy + 70, true);
  await new Promise(r => requestAnimationFrame(r)); window.__pu(shx + 70, shy + 70);
  R.scaledCells = (host.offsetWidth * parseFloat(w.style.scale)) / 24;
  // crop: alt lands the cut edge itself on the lattice
  w.style.left = '12px'; w.style.top = '12px'; w.style.scale = '1';
  await new Promise(r => setTimeout(r, 60));
  const ce = w.querySelector('.comp-drag-edge.r'); const [cx, cy] = window.__center(ce);
  window.__pd(ce, cx, cy); window.__pm(cx - 30, cy, true);
  await new Promise(r => requestAnimationFrame(r)); window.__pu(cx - 30, cy);
  R.cutEdge = 12 + host.offsetWidth - parseFloat(getComputedStyle(w).getPropertyValue('--c-r'));
  // a link card crops as a whole card, so the snap has to measure that box and not its thumbnail
  linkCard('https://example.com/a/deep/path', 12, 12);
  await new Promise(r => setTimeout(r, 300));
  const lw = [...document.querySelectorAll('.comp-wrapper')].find(x => x.querySelector('.scv-link-card'));
  lw.style.left = '12px'; lw.style.top = '12px';
  const le = lw.querySelector('.comp-drag-edge.r'); const [lx, ly] = window.__center(le);
  window.__pd(le, lx, ly); window.__pm(lx - 30, ly, true);
  await new Promise(r => requestAnimationFrame(r)); window.__pu(lx - 30, ly);
  R.cardCut = 12 + lw.querySelector('.scv-link-card').offsetWidth - parseFloat(getComputedStyle(lw).getPropertyValue('--c-r'));
  // an open node has to snap by the same point a cable leaves from, not by the middle of the wide pill
  const o = spawnLogicNode('gate', 300, 300); o.classList.add('open');
  await new Promise(r => setTimeout(r, 120));
  const oh = await altDrag(o, o.querySelector('.scv-logic-drag'), 29, 29, true);
  const icon = o.querySelector('.scv-logic-icon');
  R.openIconCentre = oh.left + icon.offsetWidth / 2;
  R.openPillWider = o.offsetWidth > icon.offsetWidth; // proves the pill really is open, so the two anchors differ
  R.cardBox = (() => { const lc = document.querySelector('.scv-link-card'), th = document.querySelector('.scv-lc-thumb');
    if (!lc || !th) return null;
    const inner = lc.clientHeight - parseFloat(getComputedStyle(lc).paddingTop) * 2;
    return { cells: [lc.offsetWidth / 24, lc.offsetHeight / 24], square: th.offsetWidth === th.offsetHeight, fills: th.offsetHeight === inner };
  })();
  const c = spawnLogicNode('reader', 200, 200); clearSelection(); selectEl(c);
  nudgeSelected(24, 0, true); R.nudged = parseInt(c.style.left);
  nudgeSelected(1, 0, false); R.fineStep = parseInt(c.style.left);
  return R;
})()`, true);
ok(snap && snap.lattice.every(onLattice), `snapAxis lands every input on dot lattice, 12 + 24k (${JSON.stringify(snap && snap.lattice)})`);
ok(snap && onLattice(snap.nodeCentreX) && onLattice(snap.nodeCentreY),
  `alt-drag rides node on dot by its centre (centre ${snap && snap.nodeCentreX}, ${snap && snap.nodeCentreY})`);
ok(snap && snap.previewMatchesDrop, `magnetised frame draws exactly where drop lands (${JSON.stringify(snap && snap.previewed)})`);
ok(snap && !onLattice(snap.freeLeft), `without alt same drag stays free of lattice (got ${snap && snap.freeLeft})`);
ok(snap && onLattice(snap.compLeft) && onLattice(snap.compTop),
  `alt-drag hangs component's corner on dot centre (${snap && snap.compLeft}, ${snap && snap.compTop})`);
ok(snap && Math.abs(snap.scaledCells - Math.round(snap.scaledCells)) < 0.001 && snap.scaledCells >= 1,
  `alt-scale quantises rendered width to whole cells (got ${snap && snap.scaledCells})`);
ok(snap && onLattice(snap.cutEdge), `alt-crop lands cut edge on lattice (got ${snap && snap.cutEdge})`);
ok(snap && onLattice(snap.cardCut), `alt-crop measures link card whole, not by its thumbnail (got ${snap && snap.cardCut})`);
ok(snap && snap.openPillWider && onLattice(snap.openIconCentre),
  `open node still snaps by its icon centre, where cables leave (got ${snap && snap.openIconCentre})`);
ok(snap && snap.cardBox && snap.cardBox.cells.every(n => Number.isInteger(n)) && snap.cardBox.square && snap.cardBox.fills,
  `link card measures whole grid cells and its thumbnail fills them square (got ${JSON.stringify(snap && snap.cardBox)})`);
ok(snap && onLattice(snap.nudged), `alt-arrow walks cell and pulls off-lattice node onto grid (got ${snap && snap.nudged})`);
ok(snap && snap.fineStep === snap.nudged + 1, `plain arrow still nudges one pixel (got ${snap && snap.fineStep})`);

done();
console.log(fails ? `studio: FAIL (${fails})` : 'studio: PASS');
process.exit(fails ? 1 : 0);