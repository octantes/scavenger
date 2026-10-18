// examples tier - each example imports clean, survives its save, wires to others

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'fs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const here = dirname(fileURLToPath(import.meta.url));
const ex = join(here, '..', 'examples');
const pbUrl = pathToFileURL(join(here, '..', 'patchbay.html')).href;
const files = ['components', 'nodes', 'tools'].flatMap(d => readdirSync(join(ex, d)).filter(f => f.endsWith('.html')).map(f => join(d, f))).concat('template.html');
const savedPath = join(here, '_examples_quine.html');

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
const errors = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && /warning|error/.test(m.params.type)) errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
});
await send('Page.enable'); await send('Runtime.enable');
const js = async (e, aw = true) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const nav = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); };
const done = () => { try { ws.close(); } catch {} cleanup(); rmSync(savedPath, { force: true }); };

try {
  await nav(pbUrl);
  await js(`window.pb = document.querySelector('scv-patchbay'); pb.setMode('edit'); true`);
  let x = 0;
  for (const f of files) {
    errors.length = 0;
    const r = await js(`(async () => {
      const out = pb.import(${JSON.stringify(readFileSync(join(ex, f), 'utf8'))}, { at: { x: ${x}, y: 40 } });
      await new Promise(r => setTimeout(r, 50));
      return out.map(u => u.localName === 'scv-logic' ? { node: u.dataset.type, error: u.states.has('error') } : { comp: u.firstElementChild?.localName, filled: !!u.firstElementChild?.shadowRoot?.childElementCount });
    })()`);
    ok(r?.length && r.every(u => u.node ? !u.error : u.filled), `${f} places a working instance (${JSON.stringify(r)})`);
    ok(!errors.length, `${f} imports with no warning or exception (${errors.slice(0, 2).join(' | ')})`);
    x += 520;
  }

  const took = await js(`(async () => { // 0.2s tone as wav, added through track file input
    const n = 1600, b = new DataView(new ArrayBuffer(44 + n * 2)), str = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
    b.setUint32(24, 8000, true); b.setUint32(28, 16000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); str(36, 'data'); b.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.sin(i / 8000 * 2 * Math.PI * 440) * 12000, true);
    const tr = pb.querySelector('scv-audio-track').shadowRoot, input = tr.querySelector('[data-at="file"]'), dt = new DataTransfer();
    dt.items.add(new File([b.buffer], 'tone.wav', { type: 'audio/wav' })); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return [tr.querySelectorAll('.at-row').length, tr.querySelector('[data-scv-slot="takes"]').value.split('\t')[1]];
  })()`);
  ok(took?.[0] === 1 && /^scv-asset:/.test(took[1]), `track keeps added take as asset ref (${took})`);

  const counts = `({ items: pb.querySelectorAll('scv-item').length, nodes: pb.querySelectorAll('scv-logic').length,
    pads: pb.querySelector('scv-launchpad').shadowRoot.querySelectorAll('.pad').length, takes: pb.querySelector('scv-audio-track').shadowRoot.querySelectorAll('.at-row').length })`;
  const before = await js(counts);
  writeFileSync(savedPath, await js(`pb.save('quine').then(b => b.text())`));
  errors.length = 0;
  await nav(pathToFileURL(savedPath).href);
  await js(`new Promise(r => setTimeout(r, 300))`);
  await js(`window.pb = document.querySelector('scv-patchbay'); true`);
  const after = await js(counts);
  ok(JSON.stringify(after) === JSON.stringify(before), `saved quine reopens with same items, nodes, pads and takes (${JSON.stringify(before)} > ${JSON.stringify(after)})`);
  ok(!errors.length, `saved quine opens with no warning or exception (${errors.slice(0, 2).join(' | ')})`);

  await js(`pb.setMode('use'); true`);
  const pp = await js(`(async () => { // audio starts on real gesture only
    const it = pb.querySelector('scv-audio-track').closest('scv-item'), tr = it.firstElementChild.shadowRoot;
    pb.wire(tr.querySelector('[data-out="take"]'), pb.querySelector('scv-audio-sampler'));
    pb.setView(40 - parseFloat(it.style.left), 40 - parseFloat(it.style.top), 1);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = tr.querySelector('.at-pp').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: pp.x, y: pp.y, button: 'left', clickCount: 1 });
  const sampled = await js(`(async () => {
    const sp = pb.querySelector('scv-audio-sampler');
    for (let i = 0; i < 40 && sp.shadowRoot.querySelector('[data-sp="canvas"]').hidden; i++) await new Promise(r => setTimeout(r, 50));
    return [!sp.shadowRoot.querySelector('[data-sp="canvas"]').hidden, sp.shadowRoot.querySelector('[data-scv-slot="state"]').value.split('|').pop()];
  })()`);
  ok(sampled?.[0] && /^scv-asset:/.test(sampled[1]), `saved take plays and loads into wired sampler by ref (${sampled})`);
  const counted = await js(`(() => {
    const c = pb.querySelector('scv-counter').shadowRoot, ro = pb.querySelector('scv-readout');
    pb.wire(c.querySelector('[data-scv-slot=count]'), ro);
    c.querySelector('[data-op="+"]').click(); c.querySelector('[data-op="+"]').click();
    return ro.shadowRoot.querySelector('[data-scv-slot=value]').textContent;
  })()`);
  ok(counted === '2', `counter count wired to readout shows clicks (${counted})`);

  const picked = await js(`(() => {
    const sel = pb.querySelector('scv-dropdown').shadowRoot.querySelector('select'), ro = pb.querySelector('scv-readout'), src = document.createElement('div');
    pb.wire(sel, ro); pb.wire(src, sel); pb.append(src);
    pb.routeSend(src.getAttribute('data-scv-emits'), 'b');
    return [sel.value, ro.shadowRoot.querySelector('[data-scv-slot=value]').textContent];
  })()`);
  ok(picked?.[0] === 'b' && picked[1] === 'b', `dropdown takes wired value and passes it on (${picked})`);

  const beats = await js(`(async () => {
    const tr = pb.querySelector('scv-audio-transport').shadowRoot, got = [];
    const sink = document.createElement('div'); pb.append(sink); sink.addEventListener('scv-receive', e => got.push(e.detail));
    pb.wire(tr.querySelector('[data-out="beat"]'), sink);
    tr.querySelector('[data-tr="playbtn"]').click();
    await new Promise(r => setTimeout(r, 900));
    tr.querySelector('[data-tr="playbtn"]').click();
    return got.map(b => b.beat + ':' + b.play);
  })()`);
  ok(beats?.length >= 2 && beats.at(-1).endsWith(':0'), `transport play sends beats, stop sends play 0 (${beats})`);
  const shaped = await js(`(() => { // signals told apart by shape
    const tr = pb.querySelector('scv-audio-transport'), sr = tr.shadowRoot, src = document.createElement('div'); pb.append(src); pb.wire(src, tr);
    const ch = src.getAttribute('data-scv-emits'), label = () => sr.querySelector('[data-tr="playbtn"] span').textContent;
    pb.routeSend(ch, 90); const bpm = sr.querySelector('[data-tr="bpm"]').value;
    pb.routeSend(ch, { t: 'start', beat: 3 }); const started = label();
    pb.routeSend(ch, { t: 'stop', beat: 4 }); const stopped = label();
    return [bpm, started, stopped];
  })()`);
  ok(shaped?.[0] === '90', `number reaching transport sets bpm (${shaped})`);
  ok(shaped?.[1] === 'stop' && shaped[2] === 'play', `object with t and beat reaches transport as command (${shaped})`);
  const shown = await js(`(async () => { // gallery ref lands in plain img through prop:src
    const ga = pb.querySelector('scv-store-images').shadowRoot, input = ga.querySelector('[data-ga="file"]'), dt = new DataTransfer();
    const c = document.createElement('canvas'); c.width = c.height = 4;
    dt.items.add(new File([await new Promise(r => c.toBlob(r))], 'dot.png', { type: 'image/png' })); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const img = document.createElement('img'); img.setAttribute('data-scv-action', 'prop:src'); pb.append(img);
    pb.wire(ga.querySelector('[data-ga="img"]'), img);
    ga.querySelector('[data-ga="img"]').click();
    return [img.dataset.scvSrc, img.getAttribute('src')?.slice(0, 5)];
  })()`);
  ok(/^scv-asset:/.test(shown?.[0] || '') && shown[1] === 'blob:', `gallery emits ref, img receiver keeps it and shows live url (${shown})`);
  ok(!errors.length, `wiring examples throws nothing (${errors.slice(0, 2).join(' | ')})`);
} catch (e) {
  fails++; console.log('  ✗ examples tier threw:', e.message);
}

done();
console.log(fails ? `examples: FAIL (${fails})` : 'examples: PASS');
process.exit(fails ? 1 : 0);
