// surface tier - every frozen name exists, so a rename fails here instead of breaking hosts

import { launchChrome, connect } from './_cdp.mjs';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const here = dirname(fileURLToPath(import.meta.url));
const pbFile = readFileSync(join(here, '..', 'patchbay.html'), 'utf8');
const kernelSrc = readFileSync(join(here, '..', 'kernel.js'), 'utf8');
const part = id => pbFile.match(new RegExp(`<(style|script) id="${id}">[\\s\\S]*?</(style|script)>`))?.[0] || '';

// foreign document: no patchbay file around it, only the named pieces - runtime, then canvas, then studio
const foreign = ids => `<!doctype html><html><head>${part('scv-runtime-css')}${part('scv-runtime')}</head><body><scv-patchbay style="width:200px;height:100px"></scv-patchbay>${ids.map(part).join('')}</body></html>`;
const srv = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  const path = req.url.split('?')[0];
  if (path === '/pb') return res.end(pbFile);
  if (path === '/runtime') return res.end(foreign([]));
  if (path === '/canvas') return res.end(foreign(['scv-canvas']));
  if (path === '/studio') return res.end(foreign(['scv-canvas', 'scv-studio']));
  if (path === '/page') return res.end('<!doctype html><title>k</title><p id="k">kernel</p>');
  res.statusCode = 404; res.end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable'); await send('Runtime.enable');
const uncaught = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') uncaught.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
const js = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
const nav = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await js('new Promise(r => requestAnimationFrame(() => r()))'); };
const done = () => { try { ws.close(); } catch {} cleanup(); srv.close(); };

const RUNTIME = ['routeSend', 'onRoute', 'invalidate', 'nodeType'];
const CANVAS = ['setView', 'setZoom'];
const STUDIO = ['import', 'copy', 'duplicate', 'save', 'export', 'spawn', 'wire', 'select', 'selection', 'undo', 'redo', 'setMode'];
const missing = names => `(() => { const pb = document.querySelector('scv-patchbay'); return ${JSON.stringify(names)}.filter(n => typeof pb[n] !== 'function'); })()`;

try {
  await nav(base + '/pb');
  ok((await js(missing([...RUNTIME, ...CANVAS, ...STUDIO])))?.length === 0, `element methods present (missing ${await js(missing([...RUNTIME, ...CANVAS, ...STUDIO]))})`);
  const misc = await js(`(() => {
    const pb = document.querySelector('scv-patchbay'), P = customElements.get('scv-patchbay');
    pb.questApi = 'http://x.test'; const qa = pb.questApi;
    return {
      qa, use: typeof P.use === 'function', helpers: ['harvestOf', 'defineHarvest', 'defang'].every(n => typeof P.kit[n] === 'function'),
      scripts: ['scv-runtime', 'scv-canvas', 'scv-studio'].filter(id => document.getElementById(id)?.localName === 'script'),
      routeSend: typeof window.routeSend === 'function',
    };
  })()`);
  ok(misc?.qa === 'http://x.test', `questApi reads back what host set (${misc?.qa})`);
  ok(misc?.use, 'static ScvPatchbay.use present');
  ok(misc?.helpers, 'harvest helpers harvestOf, defineHarvest, defang present');
  ok(misc?.scripts?.length === 3, `script ids scv-runtime, scv-canvas, scv-studio stable (found ${misc?.scripts})`);
  ok(misc?.routeSend, 'patchbay file keeps window.routeSend');

  // nodeType: def as registered, ports included, unknown is null, a copy can't rewrite registry
  const nt = await js(`(async () => {
    const pb = document.querySelector('scv-patchbay');
    pb.import('<script data-scv-node>defineNode({ name: "surf-port", inputs: [{ name: "a", type: "text" }], outputs: [{ name: "v" }], kind: "probe", onReceive() {} });<\\/script>', { redefine: true });
    const d = pb.nodeType('surf-port'), clock = pb.nodeType('clock');
    const inputs = JSON.parse(JSON.stringify(d.inputs)), outputs = d.outputs;
    d.kind = 'rewritten'; d.inputs.push({ name: 'x' }); d.inputs[0].name = 'zz';
    const again = pb.nodeType('surf-port'), saved = await (await pb.save('publish')).text();
    return { inputs, outputs, kept: [again.kind, again.inputs.map(p => p.name).join()].join(), clock: clock?.name, unknown: pb.nodeType('no-such'),
      placed: !!pb.querySelector('scv-logic[data-type="surf-port"]'), saved: saved.includes('name: "surf-port"') };
  })()`);
  ok(nt?.inputs?.[0]?.type === 'text' && nt?.outputs?.[0]?.name === 'v', `nodeType gives declared ports with extra fields (${JSON.stringify(nt && { i: nt.inputs, o: nt.outputs })})`);
  ok(nt?.kept === 'probe,a', `nodeType hands a copy, port lists too - registry keeps its def (got ${nt?.kept})`);
  ok(nt && !nt.placed && nt.saved, `import with redefine registers node type without placing one, save keeps it (${JSON.stringify(nt && { p: nt.placed, s: nt.saved })})`);
  ok(nt?.clock === 'clock' && nt?.unknown === null, `nodeType knows built-ins, unknown is null (${JSON.stringify(nt && { c: nt.clock, u: nt.unknown })})`);

  // each script runs standalone in foreign document - runtime routes alone, canvas and studio add their methods
  for (const [path, has, lacks] of [['/runtime', RUNTIME, [...CANVAS, ...STUDIO]], ['/canvas', [...RUNTIME, ...CANVAS], STUDIO], ['/studio', [...RUNTIME, ...CANVAS, ...STUDIO], []]]) {
    uncaught.length = 0;
    await nav(base + path);
    const gone = await js(missing(has)), extra = lacks.length ? (await js(missing(lacks))).length : 0;
    ok(gone?.length === 0, `${path}: methods present (missing ${gone})`);
    ok(extra === lacks.length, `${path}: later pieces' methods absent (${lacks.length - extra} leaked)`);
    const routed = await js(`(() => {
      const pb = document.querySelector('scv-patchbay'), it = document.createElement('scv-item'), out = document.createElement('output');
      out.setAttribute('data-scv-receives', 'surf'); it.append(out); pb.append(it);
      pb.routeSend('surf', 'hi'); return out.value;
    })()`);
    ok(routed === 'hi', `${path}: routes in foreign document (got ${JSON.stringify(routed)})`);
    ok(await js(`typeof window.routeSend === 'undefined'`), `${path}: foreign document gets no window.routeSend`);
    ok(uncaught.length === 0, `${path}: no page errors (${uncaught.join(' | ')})`);
  }

  // runtime-only host takes in harvest by hand: def read as data, element defined, its code never runs
  await nav(base + '/runtime');
  const def = "window.__ran = 1;\nif(!customElements.get('scv-surf1')){\ncustomElements.define('scv-surf1', class extends HTMLElement {\nconstructor() {\nsuper();\nif (this.shadowRoot) return;\nthis.attachShadow({mode: 'open'}).innerHTML = `<p onclick=\"window.__ran = 2\">surf</p><script>window.__ran = 3<\/script>`;\n}\n});\n}\n";
  const hv = await js(`(() => {
    const k = customElements.get('scv-patchbay').kit, h = k.harvestOf(${JSON.stringify(def)});
    k.defineHarvest(h);
    const el = document.createElement('scv-surf1'); document.body.append(el); el.shadowRoot.querySelector('p').click();
    return { tag: h.tag, text: el.shadowRoot.textContent, code: /onclick|script/.test(el.shadowRoot.innerHTML), ran: window.__ran ?? 0 };
  })()`);
  ok(hv?.tag === 'scv-surf1' && hv?.text === 'surf', `harvestOf + defineHarvest build harvest in runtime-only host (${JSON.stringify(hv)})`);
  ok(hv && !hv.code && hv.ran === 0, `harvest code never runs - handlers and scripts defanged (${JSON.stringify(hv)})`);

  // kernel controls
  await nav(base + '/page');
  await js(`window.scvLaunch = { headless: true }; true`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const k = await js(`['run', 'harvest', 'summon', 'minimize'].filter(n => typeof window.$kernel?.[n] !== 'function')`);
  ok(k?.length === 0, `$kernel controls present headless (missing ${k})`);
} catch (e) {
  fails++; console.log('  ✗ surface tier threw:', e.message);
}

done();
console.log(fails ? `surface: FAIL (${fails})` : 'surface: PASS');
