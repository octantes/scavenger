// bench - opt-in: large patchbay, records numbers to beat
// node test/bench.mjs [--save] (--save writes test/bench-baseline.json)

import { launchChrome, connect } from './_cdp.mjs';
import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { deflateSync, crc32 } from 'zlib';
import { randomBytes } from 'crypto';

const here = dirname(fileURLToPath(import.meta.url));
const kernelSrc = readFileSync(join(here, '..', 'kernel.js'), 'utf8');
const patchbayHtml = readFileSync(join(here, '..', 'patchbay.html'), 'utf8');
const delay = ms => new Promise(r => setTimeout(r, ms));

const COMPS = 40, INSTANCES = 10, WIRED = 2, FULL = 3, FULL_CARDS = 400, PASTED = 10, NODES = 200, CHAIN = 20;

const png = (w, h) => { // stored (incompressible) png - random rgb, so base64 size tracks pixel count
  const raw = [];
  for (let y = 0; y < h; y++) raw.push(Buffer.concat([Buffer.from([0]), randomBytes(w * 3)]));
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(raw), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
};

const imgs = new Map(); // path > png bytes, generated on first request
const site = i => `<!doctype html><title>s${i}</title><style>.card${i}{width:340px;padding:12px;background:#223;color:#dde;font:14px sans-serif;border-radius:8px}.card${i} img{width:160px;height:160px;display:inline-block;margin:2px}.card${i} .v{font-size:22px}</style>
<div id="card" class="card${i}"><h3>component ${i}</h3><img src="/img/c${i}a.png"><img src="/img/c${i}b.png"><div class="v">value <span class="n">${i}</span></div><button class="go">go</button></div>`;
const full = k => `<!doctype html><title>f${k}</title><style>.grid{display:grid;grid-template-columns:repeat(8,120px);gap:6px}.c{background:#334;color:#eef;padding:6px;font:12px sans-serif}.c img{width:100px;height:60px}.c .t{font-weight:bold}.c .p{color:#9c9}</style>
<main id="main" class="grid">${Array.from({ length: FULL_CARDS }, (_, j) => `<div class="c"><img src="/img/f${k}.png"><div class="t">item ${j}</div><div class="p">${(j * 1.37).toFixed(2)}</div></div>`).join('')}</main>`;

const srv = createServer((req, res) => {
  const u = req.url;
  if (u.startsWith('/patchbay')) { res.setHeader('content-type', 'text/html'); return res.end(patchbayHtml); }
  let m = u.match(/^\/site\/(\d+)/); if (m) { res.setHeader('content-type', 'text/html'); return res.end(site(+m[1])); }
  m = u.match(/^\/full\/(\d+)/); if (m) { res.setHeader('content-type', 'text/html'); return res.end(full(+m[1])); }
  m = u.match(/^\/img\/(\w+)\.png/);
  if (m) {
    if (!imgs.has(m[1])) imgs.set(m[1], m[1].startsWith('f') ? png(100, 60) : png(160, 160));
    res.setHeader('content-type', 'image/png'); return res.end(imgs.get(m[1]));
  }
  res.writeHead(404); res.end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const { port, pageWsUrl, cleanup } = await launchChrome();
const page = await connect(pageWsUrl);
const browser = await connect((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
const { send, waitEvent } = page;
await send('Page.enable'); await send('Runtime.enable'); await send('Performance.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const js = async (e, aw = false) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw });
  if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r?.result?.result?.value;
};
const load = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await delay(300); };
const done = () => { try { page.ws.close(); browser.ws.close(); } catch {} cleanup(); srv.close(); };

const harvest = async (url, sel) => { // real kernel harvest of one element, payload as clipboard gets it
  await load(url);
  await send('Runtime.evaluate', { expression: kernelSrc });
  return js(`(async () => new Promise(resolve => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
    window.$kernel.start('harvester');
    (async () => { const a = Date.now(); while (!window.$kernel.processes['harvester']?.active && Date.now() - a < 2000) await new Promise(r => setTimeout(r, 10)); document.querySelector(${JSON.stringify(sel)}).click(); })();
    setTimeout(() => resolve(null), 20000);
  }))()`, true);
};

// renderer peak rss - kernel tracks high-water mark per process, clear_refs 5 resets it to current
const rendererPid = async () => {
  const info = (await browser.send('SystemInfo.getProcessInfo'))?.result?.processInfo || [];
  const rss = pid => { try { return +(readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/) || [])[1] || 0; } catch { return 0; } };
  return info.filter(p => p.type === 'renderer').map(p => p.id).sort((a, b) => rss(b) - rss(a))[0];
};
const kb = (pid, key) => +(readFileSync(`/proc/${pid}/status`, 'utf8').match(new RegExp(key + ':\\s+(\\d+)')) || [])[1] || 0;
const peakDuring = async (pid, fn) => {
  await send('HeapProfiler.enable'); await send('HeapProfiler.collectGarbage'); await delay(200);
  const before = kb(pid, 'VmRSS');
  writeFileSync(`/proc/${pid}/clear_refs`, '5');
  const t0 = Date.now(); const out = await fn(); const ms = Date.now() - t0;
  return { peakMB: +((kb(pid, 'VmHWM') - before) / 1024).toFixed(1), beforeMB: +(before / 1024).toFixed(1), ms, ...out };
};
const metrics = async () => Object.fromEntries(((await send('Performance.getMetrics'))?.result?.metrics || []).map(m => [m.name, m.value]));
const diff = (a, b, keys) => Object.fromEntries(keys.map(k => [k, +((b[k] - a[k]) || 0).toFixed(k.endsWith('Duration') ? 4 : 0)]));

const results = { fixture: { COMPS, INSTANCES, WIRED, FULL, FULL_CARDS, PASTED, NODES, CHAIN } };
try {
  // fixture: real harvests
  const payloads = [];
  for (let i = 0; i < COMPS; i++) payloads.push(await harvest(`${base}/site/${i}`, '#card'));
  const fulls = [];
  for (let k = 0; k < FULL; k++) fulls.push(await harvest(`${base}/full/${k}`, '#main'));
  if (payloads.some(p => !p) || fulls.some(p => !p)) throw new Error('harvest timed out');
  results.fixture.harvestKB = Math.round([...payloads, ...fulls].reduce((s, p) => s + p.length, 0) / 1024);
  const pastedImg = 'data:image/png;base64,' + png(300, 300).toString('base64');

  await load(`${base}/patchbay`);
  await js(`window.__payloads = ${JSON.stringify(payloads)}; window.__fulls = ${JSON.stringify(fulls)}; window.__img = ${JSON.stringify(pastedImg)}; true`);
  const built = await js(`(async () => {
    setMode('edit');
    const settle = () => new Promise(r => setTimeout(r, 30));
    let x = 0, y = 0;
    const place = w => { w.style.left = (40 + x * 380) + 'px'; w.style.top = (40 + y * 260) + 'px'; if (++x === 12) { x = 0; y++; } };
    const wiredTargets = [];
    for (const p of window.__payloads) {
      for (let n = 0; n < ${INSTANCES}; n++) { const [w] = handlePasteData(p) || []; if (w) { place(w); if (n < ${WIRED}) wiredTargets.push(w); } }
      await settle();
    }
    for (const f of window.__fulls) { const [w] = handlePasteData(f) || []; if (w) place(w); await settle(); }
    for (let i = 0; i < ${PASTED}; i++) { const [w] = handlePasteData(imgWrapperMarkup(window.__img, 0, 0)) || []; if (w) place(w); }
    await new Promise(r => setTimeout(r, 500));
    clearSelection();
    // nodes: wired component inputs, a clock chain, the rest loose
    const types = ['accumulator', 'variable', 'gate', 'comparator', 'mutator', 'reader', 'action'];
    let made = 0;
    const node = (t, nx, ny) => { made++; return spawnLogicNode(t, nx, ny); };
    for (const w of wiredTargets) {
      const btn = w.querySelector('[data-scv-id]')?.shadowRoot?.querySelector('button, .n');
      if (btn) autoWire(node('accumulator', px(w, 'left') - 60, px(w, 'top')), btn);
    }
    const chain = [node('clock', 40, 3400)];
    for (let i = 0; i < ${CHAIN}; i++) { const m = node('mutator', 120 + i * 90, 3400); autoWire(chain[chain.length - 1], m); chain.push(m); }
    const rd = node('reader', 120 + ${CHAIN} * 90, 3400); autoWire(chain[chain.length - 1], rd); chain.push(rd);
    window.__clock = chain[0];
    while (made < ${NODES}) node(types[made % types.length], 40 + (made % 25) * 70, 3600 + Math.floor(made / 25) * 60);
    renderCables(); await new Promise(r => setTimeout(r, 300));
    return { wrappers: document.querySelectorAll('.comp-wrapper').length, nodes: document.querySelectorAll('scv-logic').length, cables: document.querySelectorAll('#static-cables .cable-path:not(.cable-temp)').length };
  })()`, true);
  results.fixture.built = built;
  console.log('fixture', JSON.stringify(results.fixture));

  const pid = await rendererPid();
  const grab = fn => js(`(async () => {
    let blob = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    URL.createObjectURL = b => { blob = b; return 'blob:x'; }; URL.revokeObjectURL = () => {};
    await ${fn}();
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
    return { fileMB: blob ? +(blob.size / 1048576).toFixed(1) : null };
  })()`, true);

  results.save = await peakDuring(pid, () => grab('saveQuine'));
  console.log('save   ', JSON.stringify(results.save));
  results.publish = await peakDuring(pid, () => grab('exportPublish'));
  console.log('publish', JSON.stringify(results.publish));
  const live = await metrics();
  results.liveHeapMB = +(live.JSHeapUsedSize / 1048576).toFixed(1);
  results.liveRssMB = +(kb(pid, 'VmRSS') / 1024).toFixed(1);
  console.log('live   ', JSON.stringify({ heapMB: results.liveHeapMB, rssMB: results.liveRssMB }));

  // group drag: 120 selected items moved by real pointer events through the handle
  const MOVES = 30, KEYS = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'];
  const handle = await js(`(async () => {
    clearSelection();
    const ws = [...document.querySelectorAll('.comp-wrapper')].slice(0, 120);
    ws.forEach(selectEl); document.querySelectorAll('scv-logic').forEach((n, i) => { if (i < 60) selectEl(n); });
    updateSelectionDim();
    canvasContainer.scrollLeft = 0; canvasContainer.scrollTop = 0;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const h = ws[0].querySelector('.comp-drag-handle'); const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, selected: selectedCount() };
  })()`, true);
  const m0 = await metrics(); const t0 = Date.now();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= MOVES; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + i * 4, y: handle.y + i * 2, button: 'left', buttons: 1 }); await js(`new Promise(r => requestAnimationFrame(() => r(1)))`, true); }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + MOVES * 4, y: handle.y + MOVES * 2, button: 'left', clickCount: 1 });
  const m1 = await metrics();
  const moved = await js(`(() => { const w = document.querySelector('.comp-wrapper'); return w.style.left; })()`);
  const d = diff(m0, m1, KEYS);
  results.drag = { selected: handle.selected, moves: MOVES, msPerMove: +((Date.now() - t0) / MOVES).toFixed(1), layoutsPerMove: +(d.LayoutCount / MOVES).toFixed(1), styleRecalcsPerMove: +(d.RecalcStyleCount / MOVES).toFixed(1), layoutMsPerMove: +(d.LayoutDuration * 1000 / MOVES).toFixed(2), styleMsPerMove: +(d.RecalcStyleDuration * 1000 / MOVES).toFixed(2), firstLeft: moved };
  console.log('drag   ', JSON.stringify(results.drag));

  // fast clock chain: 10ms clock through 20 mutators into reader
  await js(`(() => { clearSelection(); updateSelectionDim(); window.__routed = 0; const orig = _scavRouter.routeSend; _scavRouter.routeSend = (c, v) => { window.__routed++; return orig(c, v); }; window.__unroute = () => { _scavRouter.routeSend = orig; }; return true; })()`);
  const c0 = await metrics();
  await js(`(() => { const inp = window.__clock.querySelector('.scv-logic-input'); inp.value = '10'; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); window.__clock.querySelector('.scv-logic-icon').click(); return true; })()`);
  await delay(2000);
  await js(`(() => { window.__clock.querySelector('.scv-logic-icon').click(); window.__unroute(); return true; })()`);
  const c1 = await metrics();
  const routed = await js(`window.__routed`);
  const dc = diff(c0, c1, KEYS);
  results.clock = { routed, layouts: dc.LayoutCount, styleRecalcs: dc.RecalcStyleCount, layoutsPerRouted: routed ? +(dc.LayoutCount / routed).toFixed(3) : null, layoutMs: +(dc.LayoutDuration * 1000).toFixed(1), styleMs: +(dc.RecalcStyleDuration * 1000).toFixed(1), scriptMs: +(dc.ScriptDuration * 1000).toFixed(1) };
  console.log('clock  ', JSON.stringify(results.clock));

  if (process.argv.includes('--save')) { writeFileSync(join(here, 'bench-baseline.json'), JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), ...results }, null, 2) + '\n'); console.log('saved test/bench-baseline.json'); }
} catch (e) {
  console.log('bench failed:', e.message);
  process.exitCode = 1;
}
done();
