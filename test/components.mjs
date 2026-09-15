// components tier - composer end to end: author component, morph keeps data, .scv roundtrips, wires in patchbay

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const compilerUrl = pathToFileURL(join(here, '..', 'compiler.html')).href;
const pbUrl = pathToFileURL(join(here, '..', 'patchbay.html')).href;

const COUNTER = `<style>button{cursor:pointer}</style>
<div><button>+</button><span data-scv-slot="count">0</span></div>
<script>
root.querySelector('button').addEventListener('click', () => { const v = root.querySelector('[data-scv-slot=count]'); v.textContent = +v.textContent + 1; emit(+v.textContent); });
</script>`;
const READOUT = `<div><span data-scv-slot="value">-</span></div>
<script>host.addEventListener('scv-receive', e => { root.querySelector('[data-scv-slot=value]').textContent = e.detail; });</script>`;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
const errs = [];
await send('Runtime.enable'); await send('Page.enable');
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
const js = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.result?.value;
const load = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await delay(300); };
const done = () => { try { ws.close(); } catch {} cleanup(); };

try {
  await load(compilerUrl);
  await js(`document.querySelector('.tgt[data-target=component]').click()`); await delay(300);
  ok(errs.length === 0, `component mode boots clean (${errs.slice(0, 2).join(' | ')})`);

  const authored = await js(`(() => {
    $('f-tag').value = 'counter'; fields.code.value = ${JSON.stringify(COUNTER)}; recompile();
    const r = _lastCompile;
    const el = document.querySelector('#cp-stage > *');
    el.shadowRoot.querySelector('button').click();
    el.shadowRoot.querySelector('button').click();
    const before = el.shadowRoot.querySelector('[data-scv-slot=count]').textContent;
    fields.code.value = fields.code.value.replace('pointer', 'default'); recompile();
    const after = document.querySelector('#cp-stage > *').shadowRoot.querySelector('[data-scv-slot=count]').textContent;
    return { ok: r.ok, tag: r.tag, canonical: r.def.includes("attachShadow({mode: 'open'}).innerHTML ="), before, after };
  })()`);
  ok(authored && authored.ok && authored.tag === 'scv-counter', `author + compile yields scv-counter (${JSON.stringify(authored && { ok: authored.ok, tag: authored.tag })})`);
  ok(authored && authored.canonical, `def uses canonical attachShadow().innerHTML form patchbay reads`);
  ok(authored && authored.before === '2' && authored.after === '2', `css-only edit morphs in place, keeping slot data (${authored && authored.before} → ${authored && authored.after})`);

  const round = await js(`(() => {
    const html = _lastCompile.html;
    const markers = { comp: /data-scv-comp\\b/.test(html), source: /data-scv-source="[A-Za-z0-9+/=]+"/.test(html), favicon: /rel="icon"/.test(html) };
    $('f-tag').value = ''; fields.code.value = '';
    const importOk = importScv(html);
    return { markers, importOk, tag: $('f-tag').value, hasSlot: fields.code.value.includes('data-scv-slot') };
  })()`);
  ok(round && round.markers.comp && round.markers.source && round.markers.favicon, `.scv carries comp def + embedded source + favicon (${JSON.stringify(round && round.markers)})`);
  ok(round && round.importOk && round.tag === 'counter' && round.hasSlot, `re-import restores tag + source into component mode (${JSON.stringify(round && { tag: round.tag })})`);

  const stored = await js(`(() => {
    localStorage.removeItem('scav-nodes');
    $('f-tag').value = 'counter'; fields.code.value = ${JSON.stringify(COUNTER)}; recompile(); saveCurrentNode();
    const compRows = document.querySelectorAll('.stored-item').length;
    document.querySelector('.tgt[data-target=node]').click();
    const nodeRows = document.querySelectorAll('.stored-item').length;
    const e = JSON.parse(localStorage.getItem('scav-nodes'))[0];
    return { compRows, nodeRows, kind: e.kind, id: e.id };
  })()`);
  ok(stored && stored.compRows === 1 && stored.nodeRows === 0, `saved list is mode-scoped (${JSON.stringify(stored)})`);
  ok(stored && stored.kind === 'component' && stored.id === 'scv-counter', `saved component records kind + tag id (${JSON.stringify(stored)})`);

  const counterScv = await js(`(() => { document.querySelector('.tgt[data-target=component]').click(); $('f-tag').value='counter'; fields.code.value=${JSON.stringify(COUNTER)}; recompile(); return _lastCompile.html; })()`);
  const readoutScv = await js(`(() => { $('f-tag').value='readout'; fields.code.value=${JSON.stringify(READOUT)}; recompile(); return _lastCompile.html; })()`);

  await load(pbUrl);
  const wired = await js(`(() => {
    spawnComponent(registerComponentFile(${JSON.stringify(counterScv)}), 100, 100);
    spawnComponent(registerComponentFile(${JSON.stringify(readoutScv)}), 300, 100);
    const c = document.querySelector('scv-counter'), r = document.querySelector('scv-readout');
    const rendered = !!c?.shadowRoot?.firstElementChild && !!r?.shadowRoot?.firstElementChild;
    c.setAttribute('data-scv-emits', 'ch_t'); r.setAttribute('data-scv-receives', 'ch_t'); invalidateCache();
    setMode('use'); // exercise wired components in use mode
    const b = c.shadowRoot.querySelector('button'); b.click(); b.click(); b.click();
    return { rendered, out: r.shadowRoot.querySelector('[data-scv-slot=value]').textContent };
  })()`);
  ok(wired && wired.rendered, `both components register + render on patchbay`);
  ok(wired && String(wired.out) === '3', `emit(v) routes through wire to receiver (3 clicks → 3, got ${wired && wired.out})`);

  // wiring from inner element snaps channel to emitter host - emit()'s value routes, not element's raw dom value
  const snap = await js(`(() => {
    setMode('edit');
    spawnComponent('scv-counter', 500, 100);
    const hosts = document.querySelectorAll('scv-counter'); const c2 = hosts[hosts.length - 1]; // fresh instance
    const btn = c2.shadowRoot.querySelector('button');
    const rd = spawnLogicNode('reader', 700, 100);
    autoWire(btn, rd); invalidateCache(); // wire from inner button, not host
    setMode('use');
    btn.click(); btn.click(); // count > 2, emit(2)
    return { btnEmits: btn.hasAttribute('data-scv-emits'), hostEmits: c2.hasAttribute('data-scv-emits'), stored: rd._storedValue };
  })()`);
  ok(snap && !snap.btnEmits && snap.hostEmits, `wiring from inner element puts channel on emitter host (${JSON.stringify(snap)})`);
  ok(snap && String(snap.stored) === '2', `emit(v) routes after snap, not element's raw value (${JSON.stringify(snap)})`);

  ok(errs.length === 0, `no js errors across run (${errs.slice(0, 2).join(' | ')})`);
} catch (e) {
  fails++; console.log('  ✗ components tier threw:', e.message);
}

done();
console.log(fails ? `components: FAIL (${fails})` : 'components: PASS');
process.exit(fails ? 1 : 0);
