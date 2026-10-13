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
  const peakMB = +((kb(pid, 'VmHWM') - before) / 1024).toFixed(1);
  await send('HeapProfiler.collectGarbage'); await delay(200); // what stays after collection - peak minus this is garbage
  return { peakMB, retainedMB: +((kb(pid, 'VmRSS') - before) / 1024).toFixed(1), beforeMB: +(before / 1024).toFixed(1), ms, ...out };
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
  results.fixture.built = await js(`(async () => {
    const pb = document.querySelector('scv-patchbay'), kit = customElements.get('scv-patchbay').kit;
    pb.setMode('edit');
    let x = 0, y = 0;
    const at = () => { const p = { x: 40 + x * 380, y: 40 + y * 260 }; if (++x === 12) { x = 0; y++; } return p; };
    const mount = text => { const d = new DOMParser().parseFromString(text, 'text/html'); const c = d.querySelector('[data-scv-component]'), s = d.querySelector('script[data-scv-def]'); return kit.mountHarvest(pb, { tag: c.localName, script: kit.boxScopeCss(s.textContent), ...at() }); };
    const node = (type, nx, ny, attrs = {}) => { const n = document.createElement('scv-logic'); n.dataset.type = type; n.style.left = nx + 'px'; n.style.top = ny + 'px'; for (const k in attrs) n.setAttribute(k, attrs[k]); pb.append(n); return n; };
    let made = 0, ch = 0;
    for (const p of window.__payloads) for (let n = 0; n < ${INSTANCES}; n++) {
      const it = mount(p);
      if (n < ${WIRED}) { const t = it.firstElementChild.shadowRoot?.querySelector('button, .n'); if (t) { const c = 'w' + ch++; t.setAttribute('data-scv-receives', c); node('accumulator', kit.px(it, 'left') - 60, kit.px(it, 'top'), { 'data-scv-emits': c }); made++; } }
    }
    for (const f of window.__fulls) mount(f);
    const bytes = Uint8Array.from(atob(window.__img.split(',')[1]), c => c.charCodeAt(0));
    const ref = await kit.asset.put(new Blob([bytes], { type: 'image/png' }));
    for (let i = 0; i < ${PASTED}; i++) { const it = document.createElement('scv-item'); const p = at(); it.style.left = p.x + 'px'; it.style.top = p.y + 'px'; it.innerHTML = '<img data-scv-id="img' + i + '" data-scv-src="' + ref + '">'; pb.append(it); }
    window.__clock = node('clock', 40, 3400, { value: '1000000', 'data-scv-emits': 'k0' }); made++;
    node('accumulator', 120, 3400, { 'data-scv-receives': 'k0', 'data-scv-emits': 'k1' }); made++; // pulses become data for the chain
    for (let i = 1; i <= ${CHAIN}; i++) { node('mutator', 120 + i * 90, 3400, { value: 'v + 1', 'data-scv-receives': 'k' + i, 'data-scv-emits': 'k' + (i + 1) }); made++; }
    const types = ['accumulator', 'variable', 'gate', 'comparator', 'mutator', 'sample', 'action', 'delay'];
    while (made < ${NODES}) { node(types[made % types.length], 40 + (made % 25) * 70, 3600 + Math.floor(made / 25) * 60); made++; }
    await new Promise(r => setTimeout(r, 500));
    return { items: pb.querySelectorAll('scv-item').length, nodes: pb.querySelectorAll('scv-logic').length };
  })()`, true);
  console.log('fixture', JSON.stringify(results.fixture));
  const pid = await rendererPid();
  const grab = kind => () => js(`(async () => { const b = await document.querySelector('scv-patchbay').save('${kind}'); return { fileMB: +(b.size / 1048576).toFixed(1) }; })()`, true);
  results.save = await peakDuring(pid, grab('quine'));
  console.log('save   ', JSON.stringify(results.save));
  results.publish = await peakDuring(pid, grab('publish'));
  console.log('publish', JSON.stringify(results.publish));
  const live = await metrics();
  results.liveHeapMB = +(live.JSHeapUsedSize / 1048576).toFixed(1);
  results.liveRssMB = +(kb(pid, 'VmRSS') / 1024).toFixed(1);
  console.log('live   ', JSON.stringify({ heapMB: results.liveHeapMB, rssMB: results.liveRssMB }));

  // group drag: 120 items and 60 nodes moved by real ctrl-drag
  const MOVES = 30, KEYS = ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'];
  const start = await js(`(async () => {
    const pb = document.querySelector('scv-patchbay');
    pb.select([...pb.querySelectorAll('scv-item')].slice(0, 120).concat([...pb.querySelectorAll('scv-logic')].slice(0, 60)));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = pb.geometry(pb.querySelector('scv-item'));
    return { x: b.x + b.w / 2, y: b.y + b.h / 2, selected: pb.selection().length };
  })()`, true);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, button: 'none', modifiers: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1, modifiers: 2 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 8, y: start.y + 4, button: 'left', buttons: 1, modifiers: 2 }); // past drag threshold
  await js(`new Promise(r => requestAnimationFrame(() => r(1)))`, true);
  const m0 = await metrics(); const t0 = Date.now();
  for (let i = 1; i <= MOVES; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 8 + i * 4, y: start.y + 4 + i * 2, button: 'left', buttons: 1, modifiers: 2 }); await js(`new Promise(r => requestAnimationFrame(() => r(1)))`, true); }
  const m1 = await metrics();
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: start.x + 8 + MOVES * 4, y: start.y + 4 + MOVES * 2, button: 'left', clickCount: 1, modifiers: 2 });
  const d = diff(m0, m1, KEYS);
  results.drag = { selected: start.selected, moves: MOVES, msPerMove: +((Date.now() - t0) / MOVES).toFixed(1), layoutsPerMove: +(d.LayoutCount / MOVES).toFixed(1), styleRecalcsPerMove: +(d.RecalcStyleCount / MOVES).toFixed(1), layoutMsPerMove: +(d.LayoutDuration * 1000 / MOVES).toFixed(2), styleMsPerMove: +(d.RecalcStyleDuration * 1000 / MOVES).toFixed(2), scriptMsPerMove: +(d.ScriptDuration * 1000 / MOVES).toFixed(2), taskMsPerMove: +(d.TaskDuration * 1000 / MOVES).toFixed(2), firstLeft: await js(`document.querySelector('scv-item').style.left`) };
  console.log('drag   ', JSON.stringify(results.drag));

  // fast clock chain: 10ms clock through accumulator and 20 mutators
  await js(`(() => { const pb = document.querySelector('scv-patchbay'); pb.select([]); window.__routed = 0; pb.onRoute(() => window.__routed++); return true; })()`);
  const c0 = await metrics();
  await js(`(() => { window.__clock.setAttribute('value', '10'); return true; })()`);
  await delay(2000);
  await js(`(() => { window.__clock.setAttribute('value', '1000000'); return true; })()`);
  const c1 = await metrics(), routed = await js(`window.__routed`), dc = diff(c0, c1, KEYS);
  results.clock = { routed, layouts: dc.LayoutCount, styleRecalcs: dc.RecalcStyleCount, layoutsPerRouted: routed ? +(dc.LayoutCount / routed).toFixed(3) : null, layoutMs: +(dc.LayoutDuration * 1000).toFixed(1), styleMs: +(dc.RecalcStyleDuration * 1000).toFixed(1), scriptMs: +(dc.ScriptDuration * 1000).toFixed(1) };
  console.log('clock  ', JSON.stringify(results.clock));

  // same clock to wired el inside component - text changes must not re-measure cable end
  await js(`(() => { const acc = document.querySelector('scv-logic[data-scv-emits="w0"]'); acc.setAttribute('data-scv-receives', 'k0'); window.__clock.setAttribute('data-scv-emits', 'k0'); window.__routed = 0; return true; })()`);
  await delay(300);
  const n0 = await metrics();
  await js(`(() => { window.__clock.setAttribute('value', '10'); return true; })()`);
  await delay(2000);
  await js(`(() => { window.__clock.setAttribute('value', '1000000'); return true; })()`);
  const n1 = await metrics(), nRouted = await js(`window.__routed`), dn = diff(n0, n1, KEYS);
  results.inner = { routed: nRouted, layouts: dn.LayoutCount, layoutMs: +(dn.LayoutDuration * 1000).toFixed(1), styleMs: +(dn.RecalcStyleDuration * 1000).toFixed(1), scriptMs: +(dn.ScriptDuration * 1000).toFixed(1) };
  console.log('inner  ', JSON.stringify(results.inner));
  const old = JSON.parse(readFileSync(join(here, 'bench-baseline.json'), 'utf8'));
  console.log('baseline', JSON.stringify({ save: old.save, publish: old.publish, drag: old.drag, clock: old.clock, inner: old.inner }));

  if (process.argv.includes('--save')) { writeFileSync(join(here, 'bench-baseline.json'), JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), ...results }, null, 2) + '\n'); console.log('saved test/bench-baseline.json'); }
} catch (e) {
  console.log('bench failed:', e.message); process.exitCode = 1;
}
done();
