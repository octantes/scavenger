// patchbay tier - runtime and exports

import { launchChrome, connect } from './_cdp.mjs';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const here = dirname(fileURLToPath(import.meta.url));
const pbFile = join(here, '..', 'patchbay.html');

// patchbay, exports, image and mock quest api same origin - publish defaults to page origin
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const saved = new Map();
const questPosts = [];
let imgFetches = 0; // fetch() only - img loads ask for image/*
const srv = createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/pb') { res.setHeader('content-type', 'text/html'); return res.end(readFileSync(pbFile)); }
  if (path === '/host') { // host page mounting two patchbays from runtime and canvas pieces - not a patchbay file
    const f = readFileSync(pbFile, 'utf8'), part = id => f.match(new RegExp(`<(style|script) id="${id}">[\\s\\S]*?</\\1>`))[0];
    res.setHeader('content-type', 'text/html');
    return res.end(`<!doctype html><html><head><style>body{background:rgb(1,2,3)} #b{--background-sunk:rgb(9,9,9)}</style>${part('scv-runtime-css')}${part('scv-runtime')}</head><body><scv-patchbay id="a" style="width:200px;height:100px"></scv-patchbay><scv-patchbay id="b" style="width:200px;height:100px"></scv-patchbay>${part('scv-canvas')}</body></html>`);
  }
  if (path.startsWith('/saved/')) { res.setHeader('content-type', 'text/html'); return res.end(saved.get(path.slice(7)) || ''); }
  if (path === '/img.png') { if (!/^image\//.test(req.headers.accept || '')) imgFetches++; res.setHeader('content-type', 'image/png'); res.setHeader('access-control-allow-origin', '*'); return res.end(Buffer.concat([PNG, Buffer.from([0])])); } // trailing byte - own hash, still decodes
  if (req.method === 'GET' && path === '/quests') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify([{ channel: 'q_in', result: { value: 7 } }, { channel: 'q_comp', result: { value: 'live.html#v1' } }])); }
  if (path === '/component/live.html') { res.setHeader('content-type', 'text/html'); return res.end("<scv-qc1 data-scv-component></scv-qc1>\n<script data-scv-def>window.__ran = 1;\nif(!customElements.get('scv-qc1')){\ncustomElements.define('scv-qc1', class extends HTMLElement {\nconstructor() {\nsuper();\nif (this.shadowRoot) return;\nthis.attachShadow({mode: 'open'}).innerHTML = `<p onclick=\"window.__ran = 2\">live</p>`;\n}\n});\n}\n</script>"); } // def code must never run
  if (req.method === 'GET' && path === '/alt/quests') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify([{ channel: 'q_in', result: { value: 9 } }])); }
  if (req.method === 'POST' && path.startsWith('/quests')) { let b = ''; req.on('data', c => b += c); req.on('end', () => { questPosts.push({ path, body: JSON.parse(b || '{}') }); res.end('{}'); }); return; }
  res.statusCode = 404; res.end();
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable'); await send('Runtime.enable');
const uncaught = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') uncaught.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
const js = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { threw: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const nav = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await js('new Promise(r => requestAnimationFrame(() => r()))'); };
const done = () => { try { ws.close(); } catch {} cleanup(); srv.close(); };

// helpers: each test builds its own patchbay, routing never crosses tests
const helpers = () => {
  const kit = customElements.get('scv-patchbay').kit;
  window.T = {
    kit,
    frame: () => new Promise(r => requestAnimationFrame(() => r())),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
    pb() { const p = document.createElement('scv-patchbay'); document.body.append(p); p.setMode?.('use'); return p; }, // studio opens in edit
    node(pb, type, attrs = {}) { const n = document.createElement('scv-logic'); n.dataset.type = type; for (const k in attrs) n.setAttribute(k, attrs[k]); pb.append(n); return n; },
    item(pb, child, x = 0, y = 0) { const it = document.createElement('scv-item'); it.style.left = x + 'px'; it.style.top = y + 'px'; it.append(child); pb.append(it); return child; },
    el(html) { const t = document.createElement('template'); t.innerHTML = html; return t.content.firstElementChild; },
    sink(pb, ch, tag = 'div') { const d = document.createElement(tag); d.setAttribute('data-scv-receives', ch); d.log = []; d.addEventListener('scv-receive', e => d.log.push(e.detail)); pb.append(d); return d; },
    comp(name, body, pb) { const t = document.createElement('template'); t.setAttribute('data-scv-comp', name); t.innerHTML = body; if (pb) return kit.addComponent(pb, t); document.body.append(t); return kit.defineComponent(t); }, // pb holds it, else page-only
    harvestDef(tag, markup) { // canonical kernel shape
      const s = document.createElement('script'); s.setAttribute('data-scv-def', '');
      s.textContent = `if(!customElements.get('${tag}')){\ncustomElements.define('${tag}', class extends HTMLElement {\nconstructor() {\nsuper();\nif (this.shadowRoot) return;\nthis.attachShadow({mode: 'open'}).innerHTML = \`${markup}\`;\n}\n});\n}`;
      document.body.append(s); return s;
    },
  };
  return true;
};
const run = async (name, fn) => { // fn runs in page, returns [pass, detail]
  const r = await js(`(${fn.toString()})()`);
  if (r?.threw) return ok(false, `${name} - threw ${r.threw.split('\n')[0]}`);
  ok(Array.isArray(r) && r[0] === true, `${name} (${JSON.stringify(r?.[1] ?? r)})`);
};

try {
  await nav(base + '/pb');
  await js(`(${helpers.toString()})()`);

  // boot

  await run('runtime defines scv-item, scv-logic, scv-patchbay', async () => {
    const t = ['scv-item', 'scv-logic', 'scv-patchbay'].map(n => !!customElements.get(n));
    return [t.every(Boolean), t];
  });

  // router - fan-out order

  await run('two page receivers get channel in document order', async () => {
    const pb = T.pb(), order = [];
    const a = T.sink(pb, 'c'), b = T.sink(pb, 'c');
    a.addEventListener('scv-receive', () => order.push('a')); b.addEventListener('scv-receive', () => order.push('b'));
    pb.routeSend('c', 1);
    return [order.join() === 'a,b', order];
  });

  await run('reordering receivers swaps delivery order', async () => {
    const pb = T.pb(), order = [];
    const a = T.sink(pb, 'c'), b = T.sink(pb, 'c');
    a.addEventListener('scv-receive', () => order.push('a')); b.addEventListener('scv-receive', () => order.push('b'));
    pb.routeSend('c', 1);
    pb.insertBefore(b, a); await 0;
    order.length = 0; pb.routeSend('c', 2);
    return [order.join() === 'b,a', order];
  });

  await run('shadow receiver comes after light dom receivers, whatever its position', async () => {
    const pb = T.pb(), order = [];
    T.harvestDef('scv-ro1', '<p data-scv-receives="c">x</p>');
    const host = T.item(pb, document.createElement('scv-ro1'));
    const light = T.sink(pb, 'c');
    host.shadowRoot.querySelector('p').addEventListener('scv-receive', () => order.push('shadow'));
    light.addEventListener('scv-receive', () => order.push('light'));
    pb.routeSend('c', 1);
    return [order.join() === 'light,shadow', order];
  });

  await run('receive fires before element own verb', async () => {
    const pb = T.pb(), order = [];
    const d = T.sink(pb, 'c'); d.setAttribute('data-scv-action', 'event:custom');
    d.addEventListener('scv-receive', () => order.push('receive')); d.addEventListener('custom', () => order.push('verb'));
    pb.routeSend('c', 1);
    return [order.join() === 'receive,verb', order];
  });

  // router - delivery

  await run('primitives land in text, value and checked', async () => {
    const pb = T.pb();
    const d = T.sink(pb, 'c'), i = T.sink(pb, 'c', 'input'), cb = T.el('<input type="checkbox" data-scv-receives="c">'); pb.append(cb);
    pb.routeSend('c', 'true');
    return [d.textContent === 'true' && i.value === 'true' && cb.checked === true, [d.textContent, i.value, cb.checked]];
  });

  await run('objects arrive by event only, never stringified into dom', async () => {
    const pb = T.pb(), d = T.sink(pb, 'c'); d.textContent = 'kept';
    const obj = { a: 1 };
    pb.routeSend('c', obj);
    return [d.textContent === 'kept' && d.log[0] === obj, d.textContent];
  });

  await run('styled text takes value - span holding small', async () => {
    const pb = T.pb(), d = T.sink(pb, 'c', 'span'); d.innerHTML = '$<small>9</small>';
    pb.routeSend('c', '12');
    return [d.innerHTML === '12', d.innerHTML];
  });

  await run('element holding control, component or wire gets event only, markup kept', async () => {
    const pb = T.pb(), held = ['<button>b</button>', '<scv-kept1></scv-kept1>', '<i data-scv-receives="z">w</i>'];
    const ds = held.map(h => { const d = T.sink(pb, 'c'); d.innerHTML = h; return d; });
    pb.routeSend('c', 'v');
    return [ds.every((d, i) => d.innerHTML === held[i] && d.log[0] === 'v'), ds.map(d => d.innerHTML)];
  });

  await run('component host gets value by event only, no text in light dom', async () => {
    const pb = T.pb(); T.harvestDef('scv-wh1', '<p>x</p>');
    const host = T.item(pb, T.el('<scv-wh1 data-scv-receives="c"></scv-wh1>')); let got;
    host.addEventListener('scv-receive', e => { got = e.detail; });
    pb.routeSend('c', 'v');
    return [host.innerHTML === '' && got === 'v', [host.innerHTML, got]];
  });

  await run('pulse writes nothing, fires receive and verb', async () => {
    const pb = T.pb(), d = T.sink(pb, 'c'); d.textContent = 'kept'; d.setAttribute('data-scv-action', 'hide');
    pb.routeSend('c', T.kit.pulse());
    return [d.textContent === 'kept' && T.kit.isPulse(d.log[0]) && d.style.display === 'none', [d.textContent, d.style.display]];
  });

  await run('scv-receive carries its channel', async () => {
    const pb = T.pb(), d = T.sink(pb, 'c'); let ch;
    d.addEventListener('scv-receive', e => { ch = e.channel; });
    pb.routeSend('c', 1);
    return [ch === 'c', ch];
  });

  await run('pass-through never echoes back on incoming channel', async () => {
    const pb = T.pb(), d = T.sink(pb, 'a'); d.setAttribute('data-scv-emits', 'a b');
    const b = T.sink(pb, 'b'); let echoes = 0;
    d.addEventListener('scv-receive', () => echoes++);
    pb.routeSend('a', 5);
    return [echoes === 1 && b.log[0] === 5, { echoes, b: b.log }];
  });

  await run('cycle stops at depth limit, no hang', async () => {
    const pb = T.pb(), a = T.sink(pb, 'x'); a.setAttribute('data-scv-emits', 'y');
    const b = T.sink(pb, 'y'); b.setAttribute('data-scv-emits', 'x');
    pb.routeSend('x', 1);
    return [a.log.length === 10 && b.log.length === 10, { a: a.log.length, b: b.log.length }];
  });

  await run('wire made this turn routes at once', async () => {
    const pb = T.pb(), a = T.sink(pb, 'c'); pb.routeSend('c', 1);
    const b = T.sink(pb, 'c'); pb.routeSend('c', 2);
    return [b.log.join() === '2', b.log];
  });

  await run('deleted const variable frees its name', async () => {
    const pb = T.pb(), a = T.node(pb, 'variable', { value: 'freed', mode: 'const' });
    a.receive(1, 'x'); a.remove(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b = T.node(pb, 'variable', { value: 'freed', 'data-scv-emits': 'fv' }), d = T.sink(pb, 'fv');
    b.receive(2, 'x');
    return [d.log.join() === '2', d.log];
  });

  await run('nested patchbay keeps its routing - neither side reaches the other', async () => {
    const outer = T.pb(), it = document.createElement('scv-item'), inner = document.createElement('scv-patchbay');
    it.append(inner); outer.append(it); inner.setMode?.('use');
    const o = T.sink(outer, 'nx'), i = T.sink(inner, 'nx'), oc = T.sink(outer, 'nc'), ic = T.sink(inner, 'nc');
    const b = document.createElement('button'); b.setAttribute('data-scv-emits', 'nc'); b.textContent = 'press'; inner.append(b);
    outer.routeSend('nx', 'from outer'); inner.routeSend('nx', 'from inner'); b.click();
    b.dispatchEvent(new CustomEvent('scv-emit', { detail: 'emitted', bubbles: true, composed: true })); // script emit never stops propagation
    return [o.log.join() === 'from outer' && i.log.join() === 'from inner' && oc.log.length === 0 && ic.log.length === 2 && ic.log[1] === 'emitted', [o.log, i.log, oc.log, ic.log]];
  });

  await run('cache follows dom: added receiver gets next value', async () => {
    const pb = T.pb(); T.sink(pb, 'c');
    pb.routeSend('c', 1);
    const late = T.sink(pb, 'c'); await 0;
    pb.routeSend('c', 2);
    return [late.log.join() === '2', late.log];
  });

  await run('cache follows wiring attribute edits', async () => {
    const pb = T.pb(), d = T.sink(pb, 'c');
    pb.routeSend('c', 1);
    d.setAttribute('data-scv-receives', 'other'); await 0;
    pb.routeSend('c', 2);
    return [d.log.join() === '1', d.log];
  });

  await run('two patchbays never share channel', async () => {
    const a = T.pb(), b = T.pb(), da = T.sink(a, 'c'), db = T.sink(b, 'c');
    a.routeSend('c', 1);
    return [da.log.length === 1 && db.log.length === 0, [da.log, db.log]];
  });

  // router - gestures and emitters

  await run('wired native input routes its value', async () => {
    const pb = T.pb(), i = T.el('<input data-scv-emits="c">'); pb.append(i);
    const d = T.sink(pb, 'c');
    i.value = 'hi'; i.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return [d.log.join() === 'hi', d.log];
  });

  await run('raw gestures held in edit mode', async () => {
    const pb = T.pb(), i = T.el('<input data-scv-emits="c">'); pb.append(i);
    const d = T.sink(pb, 'c'); pb.mode = 'edit';
    i.value = 'hi'; i.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return [d.log.length === 0, d.log];
  });

  await run('wired link click never navigates', async () => {
    const pb = T.pb(), a = T.el('<a href="#nowhere" data-scv-emits="c">go</a>'); pb.append(a);
    T.sink(pb, 'c');
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    a.dispatchEvent(ev);
    return [ev.defaultPrevented && location.hash !== '#nowhere', location.hash];
  });

  await run('closest emitter wins: wired input inside component routes its own value', async () => {
    const pb = T.pb();
    const tag = T.comp('ce1', '<input class="i">');
    const host = T.item(pb, document.createElement(tag)); host.setAttribute('data-scv-emits', 'host');
    const i = host.shadowRoot.querySelector('.i'); i.setAttribute('data-scv-emits', 'inner');
    const dh = T.sink(pb, 'host'), di = T.sink(pb, 'inner');
    i.value = 'v'; i.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return [di.log.join() === 'v' && dh.log.length === 0, { inner: di.log, host: dh.log }];
  });

  await run('component host never routes raw inner values', async () => {
    const pb = T.pb();
    const tag = T.comp('ce2', '<input class="i">');
    const host = T.item(pb, document.createElement(tag)); host.setAttribute('data-scv-emits', 'host');
    const dh = T.sink(pb, 'host');
    const i = host.shadowRoot.querySelector('.i'); i.value = 'raw'; i.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return [dh.log.length === 0, dh.log];
  });

  await run('emit(v) routes from host, emit(v, el) from inner element', async () => {
    const pb = T.pb();
    const tag = T.comp('ce3', '<b class="b"></b><script>host.go = () => { emit(1); emit(2, root.querySelector(".b")); };</script>');
    const host = T.item(pb, document.createElement(tag)); host.setAttribute('data-scv-emits', 'host');
    host.shadowRoot.querySelector('.b').setAttribute('data-scv-emits', 'inner');
    const dh = T.sink(pb, 'host'), di = T.sink(pb, 'inner');
    host.go();
    return [dh.log.join() === '1' && di.log.join() === '2', { host: dh.log, inner: di.log }];
  });

  await run('script-emitted element routes once per change', async () => {
    const pb = T.pb();
    const tag = T.comp('ce4', '<input class="i"><script>const i = root.querySelector(".i"); i.addEventListener("input", () => emit(i.value.toUpperCase(), i));</script>');
    const host = T.item(pb, document.createElement(tag));
    const i = host.shadowRoot.querySelector('.i'); i.setAttribute('data-scv-emits', 'c');
    const d = T.sink(pb, 'c');
    i.value = 'x'; i.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    i.value = 'y'; i.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    return [d.log.join() === 'X,Y', d.log];
  });

  await run('emit(pulse) sends fresh pulse', async () => {
    const pb = T.pb();
    const tag = T.comp('ce5', '<script>host.go = () => emit(pulse);</script>');
    const host = T.item(pb, document.createElement(tag)); host.setAttribute('data-scv-emits', 'c');
    const d = T.sink(pb, 'c'); host.go();
    return [T.kit.isPulse(d.log[0]) && typeof d.log[0].t === 'number', d.log];
  });

  // router - verbs

  await run('toggle hides then restores original display', async () => {
    const pb = T.pb(), d = T.sink(pb, 'c'); d.style.display = 'inline-block'; d.setAttribute('data-scv-action', 'toggle');
    pb.routeSend('c', T.kit.pulse()); const hidden = d.style.display;
    pb.routeSend('c', T.kit.pulse());
    return [hidden === 'none' && d.style.display === 'inline-block', [hidden, d.style.display]];
  });

  await run('increment bumps text and announces it', async () => {
    const pb = T.pb(), d = T.sink(pb, 'c'); d.textContent = '4'; d.setAttribute('data-scv-action', 'increment');
    pb.routeSend('c', T.kit.pulse());
    return [d.textContent === '5' && d.log.includes(5), [d.textContent, d.log]];
  });

  await run('clone copies whole item with fresh id and no wiring', async () => {
    const pb = T.pb(), d = T.el('<p data-scv-id="orig" data-scv-receives="c" data-scv-action="clone">x</p>');
    const it = T.item(pb, d, 10, 20).parentElement;
    pb.routeSend('c', T.kit.pulse());
    const items = pb.querySelectorAll('scv-item'), copy = items[1]?.firstElementChild;
    return [items.length === 2 && copy.dataset.scvId !== 'orig' && !copy.hasAttribute('data-scv-receives') && items[1].style.left === '34px', [items.length, copy?.outerHTML, items[1]?.style.left]];
  });

  await run('delete removes whole item', async () => {
    const pb = T.pb(), d = T.el('<p data-scv-receives="c" data-scv-action="delete">x</p>');
    T.item(pb, d);
    pb.routeSend('c', T.kit.pulse());
    return [pb.querySelectorAll('scv-item').length === 0, pb.innerHTML];
  });

  // pulses

  await run('pulse is branded and frozen, data 1 is no pulse', async () => {
    const p = T.kit.pulse(5);
    return [T.kit.isPulse(p) && Object.isFrozen(p) && p.t === 5 && !T.kit.isPulse(1) && !T.kit.isPulse({ t: 5 }), p];
  });

  // clock

  await run('clock pulses on its grid, t in period steps', async () => {
    const pb = T.pb(), c = T.node(pb, 'clock', { value: '40', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    await T.sleep(230); c.remove();
    const steps = d.log.slice(1).map((p, i) => Math.round(p.t - d.log[i].t));
    return [d.log.length >= 3 && d.log.every(T.kit.isPulse) && steps.every(s => s > 0 && s % 40 === 0) && d.log.every(p => Math.round(p.t) % 40 === 0), { n: d.log.length, steps }];
  });

  await run('offbeat clock lands half period off', async () => {
    const pb = T.pb(), c = T.node(pb, 'clock', { value: '60', mode: 'offbeat', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    await T.sleep(150); c.remove();
    return [d.log.length >= 1 && d.log.every(p => Math.round(p.t) % 60 === 30), d.log.map(p => Math.round(p.t) % 60)];
  });

  await run('clock data sets interval attribute', async () => {
    const pb = T.pb(), c = T.node(pb, 'clock', { value: '1000' });
    c.receive(250, 'x'); c.receive('fast', 'x');
    c.remove();
    return [c.getAttribute('value') === '250', c.getAttribute('value')];
  });

  await run('clock click pulses now without moving schedule', async () => {
    const pb = T.pb(), c = T.node(pb, 'clock', { value: '5000', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    const before = c._clkNext; c.trigger(); const after = c._clkNext; c.remove();
    return [d.log.length === 1 && T.kit.isPulse(d.log[0]) && before === after, { n: d.log.length, before, after }];
  });

  await run('removed clock stops, moved clock keeps ticking', async () => {
    const pb = T.pb(), gone = T.node(pb, 'clock', { value: '30', 'data-scv-emits': 'g' }), moved = T.node(pb, 'clock', { value: '30', 'data-scv-emits': 'm' });
    const dg = T.sink(pb, 'g'), dm = T.sink(pb, 'm');
    gone.remove(); pb.append(moved); // same task - move, not delete
    await T.sleep(200);
    const n = dm.log.length; moved.remove();
    return [dg.log.length === 0 && n >= 3, { gone: dg.log.length, moved: n }];
  });

  await run('clock behind resyncs without burst', async () => {
    const pb = T.pb(), c = T.node(pb, 'clock', { value: '20', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    await T.sleep(30); const t0 = performance.now(); while (performance.now() - t0 < 300); // ~15 periods blocked
    const before = d.log.length; await T.sleep(15); c.remove(); // resync: one pulse, maybe next slot
    return [d.log.length - before <= 2, { before, after: d.log.length }];
  });

  // nodes

  await run('accumulator: pulse counts, data sums, alt resets', async () => {
    const pb = T.pb(), a = T.node(pb, 'accumulator', { 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    a.trigger(); a.receive(T.kit.pulse(), 'x'); a.receive(1, 'x'); a.receive(10, 'x'); a.receive(Infinity, 'x');
    const v = a.getAttribute('value'); a.cycleMode();
    return [v === '13' && a.getAttribute('value') === '0' && d.log.join() === '1,2,3,13,13,0', { v, log: d.log }];
  });

  await run('variable: data stores and emits, pulse re-emits, last persists', async () => {
    const pb = T.pb(), v = T.node(pb, 'variable', { value: 'speed', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    v.receive(42, 'x'); v.trigger();
    return [d.log.join() === '42,42' && v.getAttribute('last') === '42', { log: d.log, last: v.getAttribute('last') }];
  });

  await run('variable const locks name to its owner', async () => {
    const pb = T.pb(), a = T.node(pb, 'variable', { value: 'k', mode: 'const' }), b = T.node(pb, 'variable', { value: 'k' });
    const m = T.node(pb, 'mutator', { value: 'k', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    a.receive(5, 'x'); b.receive(9, 'x'); m.receive(0, 'x'); a.receive(7, 'x'); m.receive(0, 'x');
    return [d.log.join() === '5,7', d.log];
  });

  await run('variable rename frees old name', async () => {
    const pb = T.pb(), a = T.node(pb, 'variable', { value: 'old' }), m = T.node(pb, 'mutator', { value: 'typeof old', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    a.receive(1, 'x'); m.receive(0, 'x'); a.setAttribute('value', 'fresh'); m.receive(0, 'x');
    return [d.log.join() === 'number,undefined', d.log];
  });

  await run('gate: click flips, pulses and data pass while open', async () => {
    const pb = T.pb(), g = T.node(pb, 'gate', { 'data-scv-emits': 'c' }), d = T.sink(pb, 'c'), p = T.kit.pulse();
    g.receive(1, 'x'); g.trigger(); const open = g.hasAttribute('open');
    g.receive(1, 'x'); g.receive(p, 'x'); g.trigger(); g.receive(2, 'x');
    return [open && !g.hasAttribute('open') && d.log.length === 2 && d.log[0] === 1 && d.log[1] === p, { open, log: d.log }];
  });

  await run('action show, hide and toggle open, close and flip gate', async () => {
    const pb = T.pb(), g = T.node(pb, 'gate', { 'data-scv-receives': 'c' }), a = T.node(pb, 'action', { 'data-scv-emits': 'c' }), seq = [];
    for (const verb of ['show', 'show', 'hide', 'toggle']) { a.setAttribute('value', verb); a.trigger(); seq.push(g.hasAttribute('open')); }
    return [seq.join() === 'true,true,false,true' && g.style.display === '', seq];
  });

  await run('action increment steps accumulator', async () => {
    const pb = T.pb(), n = T.node(pb, 'accumulator', { 'data-scv-receives': 'c' }), a = T.node(pb, 'action', { value: 'increment', 'data-scv-emits': 'c' });
    a.trigger(); a.trigger();
    return [n.getAttribute('value') === '2', n.getAttribute('value')];
  });

  await run('gate once passes one value then closes', async () => {
    const pb = T.pb(), g = T.node(pb, 'gate', { mode: 'once', open: '', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    g.receive('a', 'x'); g.receive('b', 'x');
    return [d.log.join() === 'a' && !g.hasAttribute('open'), d.log];
  });

  await run('comparator: latest per wire, arrival order stops mattering', async () => {
    const pb = T.pb(), c = T.node(pb, 'comparator', { 'data-scv-receives': 'a b', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    c.receive(3, 'a'); c.receive(4, 'a'); c.receive(4, 'b');
    return [d.log.length === 1 && T.kit.isPulse(d.log[0]), d.log];
  });

  await run('comparator one wire detects change in ne mode', async () => {
    const pb = T.pb(), c = T.node(pb, 'comparator', { mode: 'ne', 'data-scv-receives': 'a', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    c.receive(1, 'a'); c.receive(1, 'a'); c.receive(2, 'a'); c.receive(2, 'a');
    return [d.log.length === 1, d.log.length];
  });

  await run('mutator map: result emitted, undefined emits nothing, pulse in scope', async () => {
    const pb = T.pb(), m = T.node(pb, 'mutator', { value: 'v > 10 ? pulse : (v > 5 ? v * 2 : undefined)', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    m.receive(1, 'x'); m.receive(6, 'x'); m.receive(20, 'x');
    return [d.log.length === 2 && d.log[0] === 12 && T.kit.isPulse(d.log[1]), d.log];
  });

  await run('mutator filter passes v when truthy', async () => {
    const pb = T.pb(), m = T.node(pb, 'mutator', { value: 'v % 2', mode: 'filter', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    [1, 2, 3, 4].forEach(v => m.receive(v, 'x'));
    return [d.log.join() === '1,3', d.log];
  });

  await run('mutator click re-runs on last data, kept across reopen as last', async () => {
    const pb = T.pb(), m = T.node(pb, 'mutator', { value: 'v + 1', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    m.trigger(); m.receive(1, 'x'); m.trigger();
    return [d.log.join() === '2,2' && m.getAttribute('last') === '1', { log: d.log, last: m.getAttribute('last') }];
  });

  await run('error state sticks until next success', async () => {
    const pb = T.pb(), m = T.node(pb, 'mutator', { value: 'v.x.y' });
    const warn = console.warn; console.warn = () => {};
    try { m.receive(null, 'x'); } finally { console.warn = warn; }
    const bad = m.states.has('error'); await T.sleep(50); const still = m.states.has('error');
    m.receive({ x: { y: 1 } }, 'x');
    return [bad && still && !m.states.has('error'), { bad, still, after: m.states.has('error') }];
  });

  await run('sample stores quietly, pulse emits held, follow passes through', async () => {
    const pb = T.pb(), s = T.node(pb, 'sample', { 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    s.receive(1, 'x'); const quiet = d.log.length; s.trigger(); s.cycleMode(); s.receive(2, 'x');
    return [quiet === 0 && d.log.join() === '1,2' && s.getAttribute('mode') === 'follow' && s.getAttribute('last') === '2', { quiet, log: d.log }];
  });

  await run('delay: pulse out later is fresh, data out later as itself', async () => {
    const pb = T.pb(), dl = T.node(pb, 'delay', { value: '30', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    const p = T.kit.pulse(); dl.receive(p, 'x'); dl.receive('v', 'x'); const early = d.log.length;
    await T.sleep(80);
    return [early === 0 && d.log.length === 2 && T.kit.isPulse(d.log[0]) && d.log[0] !== p && d.log[0].t >= p.t + 25 && d.log[1] === 'v', { early, log: d.log }];
  });

  await run('debounce emits only last arrival', async () => {
    const pb = T.pb(), dl = T.node(pb, 'delay', { value: '40', mode: 'debounce', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    dl.receive(1, 'x'); await T.sleep(10); dl.receive(2, 'x'); await T.sleep(10); dl.receive(3, 'x');
    await T.sleep(90);
    return [d.log.join() === '3', d.log];
  });

  await run('removed delay never fires', async () => {
    const pb = T.pb(), dl = T.node(pb, 'delay', { value: '30', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    dl.receive(1, 'x'); dl.remove(); await T.sleep(80);
    return [d.log.length === 0, d.log];
  });

  await run('action: pulse fires verb, data rides as payload, alt cycles verb', async () => {
    const pb = T.pb(), a = T.node(pb, 'action', { value: 'prop:title', 'data-scv-emits': 'c' });
    const t = T.el('<p data-scv-receives="c">x</p>'); pb.append(t);
    a.receive('hello', 'x'); const title = t.title;
    const b = T.node(pb, 'action'); b.cycleMode();
    return [title === 'hello' && b.getAttribute('value') === 'hide', { title, verb: b.getAttribute('value') }];
  });

  await run('reserved variable name shows float', async () => {
    const pb = T.pb(), v = T.node(pb, 'variable', { value: 'ok' });
    v.setAttribute('value', 'pulse'); await T.frame(); await T.frame();
    return [v.shadowRoot.querySelector('.float').textContent === 'reserved', v.shadowRoot.querySelector('.float').textContent];
  });

  await run('escape drops draft, blur commits nothing', async () => {
    const pb = T.pb(), c = T.node(pb, 'clock', { value: '1000' }), i = c.shadowRoot.querySelector('.input');
    pb.mode = 'edit'; c.expand(true); i.value = '5'; // visible, so focus lands
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); i.dispatchEvent(new Event('change'));
    c.remove();
    return [i.value === '1000' && c.getAttribute('value') === '1000', [i.value, c.getAttribute('value')]];
  });

  await run('enter and change commit draft once', async () => {
    const pb = T.pb(); window.__inputs = 0;
    T.kit.addNodeSource(pb, "defineNode({ name: 'cnt', onInput() { window.__inputs++; } })");
    const n = T.node(pb, 'cnt'), i = n.shadowRoot.querySelector('.input');
    n.expand(true); i.value = 'x';
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); i.dispatchEvent(new Event('change'));
    return [window.__inputs === 1, window.__inputs];
  });

  await run('mode cycles back to default and drops attribute', async () => {
    const pb = T.pb(), c = T.node(pb, 'clock', { value: '9000' });
    c.cycleMode(); const off = c.getAttribute('mode'); c.cycleMode(); c.remove();
    return [off === 'offbeat' && !c.hasAttribute('mode'), [off, c.getAttribute('mode')]];
  });

  await run('node state lives only in host attributes, light dom empty', async () => {
    const pb = T.pb(), n = T.node(pb, 'accumulator'); n.trigger();
    return [n.childNodes.length === 0 && n.shadowRoot && n.getAttribute('value') === '1', n.outerHTML];
  });

  await run('float written once per frame for burst', async () => {
    const pb = T.pb(), a = T.node(pb, 'accumulator'), f = a.shadowRoot.querySelector('.float');
    let writes = 0; const animate = f.animate.bind(f); f.animate = (...x) => { writes++; return animate(...x); };
    for (let i = 0; i < 50; i++) a.trigger();
    await T.frame(); await T.frame();
    return [f.textContent === '50' && writes === 1, [f.textContent, writes]];
  });

  await run('async hook: newer call wins, older emit dropped', async () => {
    const pb = T.pb(); T.kit.defineNode(pb, { name: 'as-wins', async onReceive(v, ctx) { await T.sleep(v); ctx.emit(v); } });
    const n = T.node(pb, 'as-wins', { 'data-scv-emits': 'aw' }), d = T.sink(pb, 'aw');
    n.receive(80, 'x'); n.receive(10, 'x'); await T.sleep(150);
    return [d.log.join() === '10', d.log];
  });

  await run('async hook: busy while pending, rejection is error, next success clears it', async () => {
    const pb = T.pb(); T.kit.defineNode(pb, { name: 'as-err', async onReceive(v) { await T.sleep(20); if (v === 'bad') throw new Error('no'); } });
    const n = T.node(pb, 'as-err'), s = () => ['busy', 'error'].filter(k => n.states.has(k)).join('+') || 'idle';
    n.receive('bad', 'x'); const pending = s(); await T.sleep(50); const failed = s();
    n.receive('ok', 'x'); await T.sleep(50);
    return [pending === 'busy' && failed === 'error' && s() === 'idle', [pending, failed, s()]];
  });

  await run('async hook: abort is no error, teardown aborts callSignal', async () => {
    const pb = T.pb(), sigs = [];
    T.kit.defineNode(pb, { name: 'as-abort', onReceive(v, ctx) { sigs.push(ctx.callSignal); return new Promise((_, rej) => ctx.callSignal.addEventListener('abort', () => rej(new DOMException('gone', 'AbortError')))); } });
    const n = T.node(pb, 'as-abort');
    n.receive(1, 'x'); n.receive(2, 'x'); await T.sleep(10);
    const superseded = sigs[0].aborted && !n.states.has('error');
    n.remove(); await T.frame(); await T.frame();
    return [superseded && sigs[1].aborted, [sigs.map(g => g.aborted), n.states.has('error')]];
  });

  await run('ports: each input port heard, emit reaches only its port, bare emit only unported wires', async () => {
    const pb = T.pb();
    T.kit.defineNode(pb, { name: 'pt-select', inputs: [{ name: 'digest' }, { name: 'legal' }], outputs: [{ name: 'verdict' }, { name: 'abstain' }],
      onReceive(v, ctx, port) { if (port === 'digest') ctx.emit(v, 'verdict'); else if (port === 'legal') ctx.emit(T.kit.pulse(), 'abstain'); else ctx.emit(v); } });
    const n = T.node(pb, 'pt-select', { 'data-scv-receives': 'pd@digest pl@legal pu', 'data-scv-emits': 'pv@verdict pa@abstain pb' });
    const v = T.sink(pb, 'pv'), a = T.sink(pb, 'pa'), bare = T.sink(pb, 'pb');
    pb.routeSend('pd', 'case'); pb.routeSend('pl', 'law'); pb.routeSend('pu', 'plain');
    return [v.log.join() === 'case' && a.log.length === 1 && T.kit.isPulse(a.log[0]) && bare.log.join() === 'plain', [v.log, a.log.length, bare.log]];
  });

  await run('ports: paste rename keeps port, @ refused in quest name', async () => {
    const el = document.createElement('i'); el.setAttribute('data-scv-emits', 'old@out plain'); el.setAttribute('data-scv-receives', 'old@in');
    T.kit.remap(el, new Map([['old', 'new']]));
    const pb = T.pb(), q = T.node(pb, 'quest', { value: 'na@me' }); await T.sleep(20);
    return [el.getAttribute('data-scv-emits') === 'new@out plain' && el.getAttribute('data-scv-receives') === 'new@in' && !q.hasAttribute('data-scv-emits') && q.shadowRoot.querySelector('.float').textContent === 'no @ in names',
      [el.getAttribute('data-scv-emits'), el.getAttribute('data-scv-receives'), q.getAttribute('data-scv-emits'), q.shadowRoot.querySelector('.float').textContent]];
  });

  await run('custom node: onPulse, onReceive and re-point on redefine', async () => {
    const pb = T.pb();
    T.kit.addNodeSource(pb, "defineNode({ name: 'dbl', onReceive(v, ctx) { ctx.emit(v * 2); }, onPulse(ctx) { ctx.emit('p'); } })");
    const n = T.node(pb, 'dbl', { 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    n.receive(3, 'x'); n.trigger();
    T.kit.addNodeSource(pb, "defineNode({ name: 'dbl', onReceive(v, ctx) { ctx.emit(v * 3); } })");
    n.receive(3, 'x');
    return [d.log.join() === '6,p,9', d.log];
  });

  await run('custom node arriving before its def picks it up', async () => {
    const pb = T.pb(), n = T.node(pb, 'late', { 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    n.receive(1, 'x');
    T.kit.addNodeSource(pb, "defineNode({ name: 'late', icon: 'L8', onReceive(v, ctx) { ctx.emit(v + 1); } })");
    n.receive(1, 'x');
    return [d.log.join() === '2' && n.shadowRoot.querySelector('.dot').textContent === 'L8', d.log];
  });

  await run('reserved inlet and outlet refused with built-in note, rest of file registers', async () => {
    const pb = T.pb(), warns = [], warn = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    let out; try { out = pb.import('<script type="scv/node" data-scv-node>defineNode({ name: "inlet" }); defineNode({ name: "outlet" }); defineNode({ name: "beside" });</script>'); } finally { console.warn = warn; }
    const types = out.map(u => u.dataset.type), noted = warns.filter(w => /node type (inlet|outlet) is a built-in name, def ignored/.test(w)).length;
    return [types.join() === 'beside' && pb.nodeType('inlet') === null && pb.nodeType('outlet') === null && !!pb.nodeType('beside') && noted === 2, { types, noted }];
  });

  await run('built-in names refused for custom defs', async () => {
    const warn = console.warn; console.warn = () => {};
    let r; try { r = T.kit.defineNode(T.pb(), { name: 'clock' }); } finally { console.warn = warn; }
    return [r === null, r];
  });

  await run('wired checkbox emits 1 checked, 0 unchecked', async () => {
    const pb = T.pb(), cb = T.el('<input type="checkbox" data-scv-emits="c">'); pb.append(cb);
    const d = T.sink(pb, 'c'); cb.click(); cb.click();
    return [d.log.join() === '1,0', d.log];
  });

  await run('method verb calls receiver, a throwing one is contained', async () => {
    const pb = T.pb(), b = T.el('<button data-scv-receives="c" data-scv-action="method:click">x</button>'), s = T.el('<p data-scv-receives="c" data-scv-action="method:setAttribute">x</p>');
    let clicks = 0; b.addEventListener('click', () => clicks++); pb.append(b, s);
    const warn = console.warn; console.warn = () => {};
    try { pb.routeSend('c', 'title'); } finally { console.warn = warn; }
    return [clicks === 1 && s.attributes.length === 2, [clicks, s.attributes.length]];
  });

  await run('event verb dispatches value as detail', async () => {
    const pb = T.pb(), el = T.el('<p data-scv-action="event:ping:c">x</p>'); pb.append(el); let got;
    el.addEventListener('ping', e => { got = e.detail; });
    pb.routeSend('c', 42);
    return [got === 42, got];
  });

  await run('custom def icon renders as text, input type stays safe', async () => {
    const pb = T.pb();
    T.kit.addNodeSource(pb, `defineNode({ name: 'esc1', icon: '<b>x</b>', inputType: 'text" onfocus="window.__x=1' })`);
    const n = T.node(pb, 'esc1'), sr = n.shadowRoot;
    return [sr.querySelector('.dot').textContent === '<b>x</b>' && !sr.querySelector('b') && sr.querySelector('.input').type === 'text' && !sr.querySelector('.input').hasAttribute('onfocus'), sr.innerHTML.length];
  });

  await run('variable refuses globals, v and non-identifiers', async () => {
    const out = [];
    for (const name of ['Math', 'v', '1bad', 'rate']) {
      const pb = T.pb(), v = T.node(pb, 'variable', { value: name }), m = T.node(pb, 'mutator', { value: `typeof ${name === '1bad' ? 'rate' : name}`, 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
      v.receive(5, 'x'); m.receive(0, 'x'); out.push(d.log[0]);
    }
    return [out.join() === 'object,number,undefined,number', out];
  });

  await run('mutator compiles once per expression and variable set, recovers from broken text', async () => {
    const pb = T.pb(), m = T.node(pb, 'mutator', { value: 'v * 2', 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    const F = window.Function; let made = 0; window.Function = function (...a) { if (String(a.at(-1)).startsWith('return (')) made++; return F(...a); }; // mutator compiles only
    const warn = console.warn; console.warn = () => {};
    try {
      for (let i = 0; i < 5; i++) m.receive(i, 'x'); const same = made;
      m.setAttribute('value', 'v * 3'); m.receive(1, 'x'); const edit = made;
      const v = T.node(pb, 'variable', { value: 'k' }); v.receive(1, 'x'); m.receive(1, 'x'); const scope = made;
      m.receive(2, 'x'); const repeat = made;
      m.setAttribute('value', 'v *'); m.receive(3, 'x'); const broke = d.log.at(-1);
      m.setAttribute('value', 'v + 1'); m.receive(3, 'x');
      return [same === 1 && edit === 2 && scope === 3 && repeat === 3 && broke === 6 && d.log.at(-1) === 4, { same, edit, scope, repeat, broke, last: d.log.at(-1) }];
    } finally { window.Function = F; console.warn = warn; }
  });

  await run('sample holds 0 and re-emits it', async () => {
    const pb = T.pb(), sm = T.node(pb, 'sample', { 'data-scv-emits': 'c' }), d = T.sink(pb, 'c');
    sm.receive(0, 'x'); sm.trigger();
    return [d.log.length === 1 && d.log[0] === 0, d.log];
  });

  await run('node chain past 20 hops stops with one warning', async () => {
    const pb = T.pb(); let prev = T.node(pb, 'mutator', { value: 'v + 1', 'data-scv-emits': 'h0' });
    const first = prev;
    for (let i = 1; i < 25; i++) prev = T.node(pb, 'mutator', { value: 'v + 1', 'data-scv-receives': 'h' + (i - 1), 'data-scv-emits': 'h' + i });
    const d = T.sink(pb, 'h24'); const warn = console.warn; let warned = 0; console.warn = () => warned++;
    try { first.receive(0, 'x'); } finally { console.warn = warn; }
    return [d.log.length === 0 && warned === 1, { got: d.log, warned }];
  });

  // component api

  await run('shared: one instance, released one frame after last owner leaves', async () => {
    const pb = T.pb(); window.__made = 0; window.__released = 0;
    const tag = T.comp('sh1', '<script>host.res = shared("k1", () => ({ n: ++window.__made }), () => window.__released++);</script>');
    const a = T.item(pb, document.createElement(tag)), b = T.item(pb, document.createElement(tag));
    const same = a.res === b.res;
    a.parentElement.remove(); await T.frame(); await T.frame(); const afterOne = window.__released;
    b.parentElement.remove(); await T.frame(); await T.frame();
    return [same && window.__made === 1 && afterOne === 0 && window.__released === 1, { same, made: window.__made, afterOne, released: window.__released }];
  });

  await run('onTeardown skips move, fires when really gone', async () => {
    const pb = T.pb(); window.__td = 0;
    const tag = T.comp('td1', '<script>onTeardown(() => window.__td++);</script>');
    const it = T.item(pb, document.createElement(tag)).parentElement;
    it.remove(); pb.append(it); await T.frame(); await T.frame(); const moved = window.__td;
    it.remove(); await T.frame(); await T.frame();
    return [moved === 0 && window.__td === 1, { moved, gone: window.__td }];
  });

  await run('signal aborts at teardown, rerun script never doubles host listener', async () => {
    const pb = T.pb(); window.__pings = 0;
    const tag = T.comp('sg1', '<b></b><script>host.addEventListener("ping", () => window.__pings++, { signal });</script>');
    const host = T.item(pb, document.createElement(tag)), it = host.parentElement;
    it.remove(); await T.frame(); await T.frame(); pb.append(it);
    host.dispatchEvent(new Event('ping'));
    return [window.__pings === 1, window.__pings];
  });

  await run('node signal aborts at teardown', async () => {
    const pb = T.pb(); window.__aborts = 0;
    T.kit.addNodeSource(pb, "defineNode({ name: 'sg2', init(ctx) { ctx.signal.addEventListener('abort', () => window.__aborts++); } })");
    const n = T.node(pb, 'sg2'); n.remove(); await T.frame(); await T.frame();
    return [window.__aborts === 1, window.__aborts];
  });

  await run('component and node scripts show named sources', async () => {
    const pb = T.pb();
    const tag = T.comp('su1', '<script>host.st = new Error().stack;</script>');
    const host = T.item(pb, document.createElement(tag));
    T.kit.addNodeSource(pb, "defineNode({ name: 'su2', init() { window.__st = new Error().stack; } })");
    T.node(pb, 'su2');
    return [host.st.includes('scv/scv-su1') && window.__st.includes('scv/su2'), [host.st.split('\n')[1], window.__st.split('\n')[1]]];
  });

  await run('patch skips unchanged writes', async () => {
    const p = document.createElement('p'); document.body.append(p);
    const recs = []; const mo = new MutationObserver(r => recs.push(...r)); mo.observe(p, { childList: true, attributes: true, characterData: true, subtree: true });
    T.kit.patch(p, { text: 'a', class: 'x' }); T.kit.patch(p, { text: 'a', class: 'x' });
    await 0; mo.disconnect(); p.remove();
    return [recs.length === 2, recs.length];
  });

  await run('component back after teardown: fresh internals, same slot data', async () => {
    const pb = T.pb(); window.__runs = 0;
    const tag = T.comp('rb1', '<b data-scv-slot="n">0</b><script>window.__runs++;</script>');
    const host = T.item(pb, document.createElement(tag)), it = host.parentElement;
    const b0 = host.shadowRoot.querySelector('b'); b0.textContent = '9';
    it.remove(); await T.frame(); await T.frame(); pb.append(it);
    const b1 = host.shadowRoot.querySelector('b');
    return [window.__runs === 2 && b1 !== b0 && b1.textContent === '9', { runs: window.__runs, text: b1.textContent }];
  });

  await run('redrop rebuilds instances on new script, keeps slot data and wiring', async () => {
    const pb = T.pb();
    T.comp('rd1', '<b data-scv-slot="n">0</b><i>v1</i><script>host.ver = 1;</script>');
    const host = T.item(pb, document.createElement('scv-rd1'));
    host.shadowRoot.querySelector('b').textContent = '5'; host.shadowRoot.querySelector('i').setAttribute('data-scv-receives', 'c');
    T.comp('rd1', '<b data-scv-slot="n">0</b><i>v2</i><script>host.ver = 2;</script>');
    const i = host.shadowRoot.querySelector('i');
    return [host.ver === 2 && host.shadowRoot.querySelector('b').textContent === '5' && i.textContent === 'v2' && i.getAttribute('data-scv-receives') === 'c', { ver: host.ver, html: host.shadowRoot.innerHTML }];
  });

  // assets

  await run('same bytes give same ref and one url', async () => {
    const b = () => new Blob([new Uint8Array([1, 2, 3])]);
    const r1 = await T.kit.asset.put(b()), r2 = await T.kit.asset.put(b());
    return [r1 === r2 && r1.startsWith('scv-asset:') && T.kit.asset.url(r1).startsWith('blob:'), [r1, r2]];
  });

  await run('decode runs once per page per decoder', async () => {
    const ref = await T.kit.asset.put(new Blob([new Uint8Array([9, 9])])); let n = 0;
    const fn = buf => { n++; return buf.byteLength; };
    const [a, b] = await Promise.all([T.kit.asset.decode(ref, fn), T.kit.asset.decode(ref, fn)]);
    return [n === 1 && a === 2 && b === 2, { n, a, b }];
  });

  await run('asset ref through prop:src keeps ref in dom, live url beside it', async () => {
    const pb = T.pb(), ref = await T.kit.asset.put(new Blob(['ps'], { type: 'image/png' }));
    const img = T.el('<img data-scv-receives="c" data-scv-action="prop:src">'); pb.append(img);
    pb.routeSend('c', ref);
    return [img.dataset.scvSrc === ref && img.getAttribute('src') === T.kit.asset.url(ref) && img.src.startsWith('blob:'), [img.dataset.scvSrc, img.getAttribute('src')]];
  });

  await run('asset css variable reaches component shadow', async () => {
    const pb = T.pb();
    const ref = await T.kit.asset.put(new Blob([new Uint8Array([7, 7, 7])], { type: 'image/png' }));
    const hash = T.kit.asset.hashOf(ref);
    const tag = T.comp('cv1', `<style>div { background-image: var(--scv-asset-${hash}); }</style><div></div>`);
    const host = T.item(pb, document.createElement(tag));
    const bg = getComputedStyle(host.shadowRoot.querySelector('div')).backgroundImage;
    return [bg.includes('blob:'), bg];
  });

  await run('img with data-scv-src gets src when added', async () => {
    const pb = T.pb(), ref = await T.kit.asset.put(new Blob([new Uint8Array([5])], { type: 'image/png' }));
    const img = T.item(pb, T.el(`<img data-scv-src="${ref}">`)); await 0;
    return [img.getAttribute('src') === T.kit.asset.url(ref), img.getAttribute('src')];
  });

  await run('asset table entry keeps odd mime type intact', async () => {
    const ref = await T.kit.asset.put(new Blob([new Uint8Array([3, 1])], { type: 'text/x"q&' }));
    const t = document.createElement('template'); t.innerHTML = await T.kit.asset.element(T.kit.asset.hashOf(ref));
    return [t.content.firstElementChild.dataset.type === 'text/x"q&', t.innerHTML];
  });

  await run('redropped component instance compared against new def, saved bare', async () => {
    const pb = T.pb();
    T.comp('dk1', '<b>one</b>');
    T.item(pb, document.createElement('scv-dk1'));
    await pb.save('publish');
    T.comp('dk1', '<b>two</b>');
    const html = await (await pb.save('publish')).text();
    return [/<scv-dk1><\/scv-dk1>/.test(html), html.match(/<scv-dk1>.*?<\/scv-dk1>/)?.[0]];
  });

  await run('harvest markup extracted exactly as def builds it', async () => {
    const raw = '<p title="a`b">c\\d ${e} $f <\/script-ish> <!--x--></p>';
    const embed = t => t.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--'); // kernel's escaping
    const def = T.harvestDef('scv-esc1', embed(raw));
    const live = document.createElement('scv-esc1').shadowRoot.innerHTML;
    const t = document.createElement('template'); t.innerHTML = T.kit.extractShadowMarkup(def.textContent);
    return [t.innerHTML === live, { got: t.innerHTML, live }];
  });

  await run('same-length edit keeps its shadow', async () => {
    const pb = T.pb(); T.harvestDef('scv-sl1', '<p>hello</p>');
    const host = T.item(pb, document.createElement('scv-sl1'));
    host.shadowRoot.querySelector('p').textContent = 'jello';
    const html = await (await pb.save('publish')).text();
    return [html.includes('<p>jello</p>'), html.match(/<scv-sl1>.*?<\/scv-sl1>/)?.[0]];
  });

  await run('text that reads like blob src survives save', async () => {
    const pb = T.pb(); T.item(pb, T.el('<pre data-scv-id="code">img src="blob:abc" stays</pre>'));
    const html = await (await pb.save('publish')).text();
    return [html.includes('img src="blob:abc" stays'), html.match(/<pre.*?<\/pre>/)?.[0]];
  });

  // save - one fixture, three exports, each reopened

  const built = await js(`(async () => {
    document.querySelectorAll('scv-patchbay').forEach(p => p.remove());
    const pb = T.pb(), kit = T.kit;
    pb.id = 'main';
    T.harvestDef('scv-hv', '<style>p{color:red}</style><p class="t">hello</p><input value="x">');
    T.harvestDef('scv-unused', '<p>never placed</p>');
    const h1 = T.item(pb, document.createElement('scv-hv'), 10, 10), h2 = T.item(pb, document.createElement('scv-hv'), 300, 10);
    h2.shadowRoot.querySelector('input').value = 'typed';
    h2.shadowRoot.querySelector('p').setAttribute('data-scv-receives', 'ch1');
    T.comp('meter', '<b data-scv-slot="n">0</b><button>+</button><script>const b = root.querySelector("b"); root.querySelector("button").onclick = () => { b.textContent = Number(b.textContent) + 1; emit(Number(b.textContent)); };</script>', pb);
    T.comp('spare', '<i>not placed</i>', pb);
    const m = T.item(pb, document.createElement('scv-meter'), 10, 200); m.setAttribute('data-scv-emits', 'ch1');
    m.shadowRoot.querySelector('button').click(); m.shadowRoot.querySelector('button').click();
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const ref = await kit.asset.put(new Blob([png], { type: 'image/png' }));
    await kit.asset.put(new Blob([new Uint8Array([4, 4])])); // never referenced - pruned
    T.item(pb, T.el('<img data-scv-id="i1" data-scv-src="' + ref + '">'), 500, 200);
    T.item(pb, T.el('<img data-scv-id="i2" data-scv-src="' + ref + '">'), 520, 200);
    T.item(pb, T.el('<img data-scv-id="i3" src="/img.png">'), 540, 200);
    T.item(pb, T.el('<img data-scv-id="i4" src="/img.png">'), 560, 200);
    await Promise.all([...pb.querySelectorAll('img[src]')].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
    kit.addNodeSource(pb, "defineNode({ name: 'twice', icon: '2', onReceive(v, ctx) { ctx.emit(v * 2); } })");
    kit.addNodeSource(pb, "defineNode({ name: 'idle', icon: 'z' })");
    T.node(pb, 'clock', { value: '750', mode: 'offbeat', style: 'left:50px;top:400px' });
    T.node(pb, 'twice', { style: 'left:150px;top:400px' });
    const g = T.node(pb, 'gate', { style: 'left:250px;top:400px' }); g.trigger();
    const v = T.node(pb, 'variable', { value: 'speed', style: 'left:350px;top:400px' }); v.receive(42, 'x');
    const n = T.node(pb, 'accumulator', { style: 'left:450px;top:400px' });
    n.states.add('selected'); n.expand(true); h1.parentElement.states.add('selected');
    T.node(pb, 'mutator', { value: 'v.x', style: 'left:550px;top:400px' }).receive(1, 'x'); // error state
    const appended = document.createElement('scv-item'); appended.setAttribute('data-scv-appended', ''); pb.append(appended);
    pb.mode = 'edit';
    await T.frame();
    const out = {};
    for (const k of ['quine', 'canvas', 'publish']) out[k] = await (await pb.save(k)).text();
    return out;
  })()`);
  ok(built && !built.threw, `fixture saved (${built?.threw})`);
  for (const k of ['quine', 'canvas', 'publish']) saved.set(k, built?.[k] || '');
  const q = saved.get('quine');
  const body = q.slice(q.indexOf('<scv-patchbay'), q.search(/<script data-scv-def>|<script id="scv-canvas">/)); // state only - runtime source holds every word checked below
  const items = body.slice(0, body.indexOf('</scv-patchbay>'));

  ok(/<script id="scv-canvas">/.test(q) && /<script id="scv-studio">/.test(q) && /<script id="scv-runtime">/.test(q), 'quine carries runtime, canvas and studio scripts by id');
  ok(/<script id="scv-canvas">/.test(saved.get('canvas')) && !/id="scv-studio"/.test(saved.get('canvas')), 'canvas export keeps canvas, drops studio');
  ok(!/id="scv-canvas"/.test(saved.get('publish')) && !/id="scv-studio"/.test(saved.get('publish')) && /id="scv-runtime"/.test(saved.get('publish')), 'publish keeps only runtime');
  ok(!body.includes('blob:'), 'no blob url written into file');
  const assets = (body.match(/<script type="scv\/asset"/g) || []).length;
  ok(assets === 2, `each referenced asset once, unreferenced pruned (${assets})`);
  ok(!/<img[^>]*\ssrc=/.test(items) && (items.match(/data-scv-src=/g) || []).length === 4, 'refs never sit in src, remote images interned');
  ok(!q.includes('scv-unused'), 'unused harvest def pruned');
  ok(q.includes('not placed') && q.includes("name: 'idle'"), 'registered component and node types ship unplaced');
  ok(!body.includes('data-scv-appended'), 'items recreated by node init are skipped');
  ok(/<scv-patchbay[^>]*extent="\d+ \d+"/.test(q), 'extent written at save');
  ok(!/<scv-patchbay[^>]*style=/.test(q), 'canvas view state never written to host');
  ok(!/selected|expanded|error|class=""/.test(items), 'transient states never serialize');
  ok(/<scv-logic data-type="gate" style="[^"]*" open=""><\/scv-logic>/.test(q), 'saved node is one line of attributes');
  const shadows = (q.match(/<scv-hv[^>]*>(<template shadowrootmode)?/g) || []).map(s => s.includes('template'));
  ok(shadows.join() === 'false,true', `unchanged harvest instance saved bare, changed one with its shadow (${shadows})`);
  ok(imgFetches === 1, `remote image fetched once into table (${imgFetches})`);

  ok(/^<!DOCTYPE html>  <!-- scavenge\.ar[^\n]*-->\n\n<html lang="en" data-scv-runtime="1\.5\.\d+">/.test(q), 'header: doctype and license, blank line, html lang en stamped');
  ok(!/127\.0\.0\.1:9876/.test(body), 'quine bakes no quest api');

  await run('last instance gone drops its def from save, undo-free live page keeps it', async () => {
    const pb = T.pb(); T.harvestDef('scv-pr1', '<p>prune</p>');
    const it = document.createElement('scv-item'); it.innerHTML = '<scv-pr1 data-scv-id="x"></scv-pr1>'; pb.append(it);
    const withIt = await (await pb.save('publish')).text(); it.remove();
    const without = await (await pb.save('publish')).text();
    return [/customElements\.get\('scv-pr1'\)/.test(withIt) && !/scv-pr1/.test(without) && !!document.querySelector('script[data-scv-def]') && [...document.querySelectorAll('script[data-scv-def]')].some(s => s.textContent.includes('scv-pr1')), without.length];
  });

  await run('two patchbays run their own version of one node type', async () => {
    const a = T.pb(), b = T.pb();
    T.kit.addNodeSource(a, "defineNode({ name: 'adder', onReceive(v, ctx) { ctx.emit(v + 1); } })");
    T.kit.addNodeSource(b, "defineNode({ name: 'adder', onReceive(v, ctx) { ctx.emit(v + 10); } })");
    const na = T.node(a, 'adder', { 'data-scv-emits': 'ad' }), nb = T.node(b, 'adder', { 'data-scv-emits': 'ad' }), da = T.sink(a, 'ad'), db = T.sink(b, 'ad');
    na.receive(1, 'x'); nb.receive(1, 'x');
    return [da.log.join() === '2' && db.log.join() === '11' && T.pb().nodeType('adder') === null, [da.log, db.log]];
  });

  await run('patchbay save carries its own types only', async () => {
    const a = T.pb(), b = T.pb();
    T.comp('own-a', '<i>a</i>', a); T.comp('own-b', '<i>b</i>', b);
    T.kit.addNodeSource(a, "defineNode({ name: 'only-a' })"); T.kit.addNodeSource(b, "defineNode({ name: 'only-b' })");
    const sa = await (await a.save('publish')).text(), body = sa.slice(sa.indexOf('<scv-patchbay'), sa.indexOf('</scv-patchbay>'));
    return [/data-scv-comp="own-a"/.test(body) && /only-a/.test(body) && !/own-b|only-b/.test(sa), body.slice(0, 300)];
  });

  await run('node file defining several types is written once', async () => {
    const pb = T.pb(); T.kit.addNodeSource(pb, "defineNode({ name: 'pair-a' }); defineNode({ name: 'pair-b' });");
    T.node(pb, 'pair-a'); T.node(pb, 'pair-b');
    const html = await (await pb.save('publish')).text(), n = (html.match(/name: 'pair-a'/g) || []).length;
    return [n === 1, n];
  });

  await run('def used only inside a bare component shadow still ships', async () => {
    const pb = T.pb(); T.harvestDef('scv-inner1', '<i>inner</i>');
    T.comp('outer1', '<scv-inner1></scv-inner1>');
    const it = document.createElement('scv-item'); it.innerHTML = '<scv-outer1 data-scv-id="o"></scv-outer1>'; pb.append(it); await T.frame();
    const html = await (await pb.save('publish')).text();
    return [/<scv-outer1 data-scv-id="o"><\/scv-outer1>/.test(html) && /customElements\.get\('scv-inner1'\)/.test(html), html.match(/<scv-outer1.*?<\/scv-outer1>/)?.[0]];
  });

  for (const k of ['quine', 'canvas', 'publish']) {
    uncaught.length = 0;
    await nav(`${base}/saved/${k}`);
    const r = await js(`(async () => {
      const pb = document.querySelector('scv-patchbay');
      const nodes = [...pb.querySelectorAll('scv-logic')].map(n => [n.dataset.type, n.getAttribute('value'), n.getAttribute('mode'), n.hasAttribute('open'), n.getAttribute('last')].join('|'));
      const hv = pb.querySelectorAll('scv-hv'), m = pb.querySelector('scv-meter'), imgs = [...pb.querySelectorAll('img')];
      await Promise.all(imgs.map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
      const table = [...document.querySelectorAll('script[type="scv/asset"]')].every(s => s.textContent === '');
      m.shadowRoot.querySelector('button').click();
      return {
        nodes, items: pb.querySelectorAll('scv-item').length,
        bare: hv[0].shadowRoot?.querySelector('p')?.textContent, typed: hv[1].shadowRoot?.querySelector('input')?.value,
        meter: m.shadowRoot.querySelector('b').textContent, routed: hv[1].shadowRoot.querySelector('p').textContent,
        imgs: imgs.map(i => i.naturalWidth), table, twice: !!customElements.get('scv-logic') && pb.querySelector('[data-type="twice"]').shadowRoot.querySelector('.dot').textContent,
        canvas: typeof pb.setView, studio: typeof pb.save, api: customElements.get('scv-patchbay').kit.quests.api(pb),
        unplaced: [pb.nodeType('idle')?.icon, !!customElements.get('scv-spare')],
      };
    })()`);
    ok(r && !r.threw, `${k} reopens (${r?.threw})`);
    if (!r || r.threw) continue;
    ok(r.nodes.join() === 'clock|750|offbeat|false|,twice|||false|,gate|||true|,variable|speed||false|42,accumulator|||false|,mutator|v.x||false|1', `${k}: node attributes round-trip (${r.nodes})`);
    ok(r.items === 7, `${k}: items round-trip (${r.items})`);
    ok(r.bare === 'hello' && r.typed === 'typed', `${k}: bare instance rebuilt by def, typed value kept (${r.bare}, ${r.typed})`);
    ok(r.meter === '3' && r.routed === '3', `${k}: authored component keeps slot data and still routes (${r.meter}, ${r.routed})`);
    ok(r.imgs.join() === '1,1,1,1' && r.table, `${k}: table images load, live dom drops base64 (${r.imgs}, ${r.table})`);
    ok(r.twice === '2', `${k}: custom node def travels with file (${r.twice})`);
    ok(r.unplaced.join() === 'z,true', `${k}: unplaced node and component types registered after reopen (${r.unplaced})`);
    ok(r.canvas === (k === 'publish' ? 'undefined' : 'function') && r.studio === (k === 'quine' ? 'function' : 'undefined'), `${k}: behaviour matches script set (${r.canvas}, ${r.studio})`);
    ok(r.api === (k === 'quine' ? 'http://127.0.0.1:9876' : base), `${k}: quest api default (${r.api})`);
    ok(uncaught.length === 0, `${k}: no uncaught errors (${uncaught})`);
  }

  // quine generations: re-saving a reopened quine never grows it

  {
    let prev = q, sizes = [];
    for (let g = 2; g <= 3; g++) {
      saved.set('gen', prev);
      await nav(`${base}/saved/gen`);
      prev = await js(`(async () => (await document.querySelector('scv-patchbay').save('quine')).text())()`);
      sizes.push(prev.length);
    }
    ok(sizes[0] === sizes[1], `quine size stable across generations (${sizes})`);
  }

  // nested patchbay carries its own types - outer never learns them

  await nav(`${base}/pb`);
  saved.set('nested', await js(`(async () => {
    const outer = document.querySelector('scv-patchbay'), kit = customElements.get('scv-patchbay').kit, it = document.createElement('scv-item'), inner = document.createElement('scv-patchbay');
    it.append(inner); outer.append(it);
    kit.addNodeSource(inner, "defineNode({ name: 'inner-only', icon: 'in' })");
    const n = document.createElement('scv-logic'); n.dataset.type = 'inner-only'; inner.append(n);
    return (await outer.save('quine')).text();
  })()`));
  await nav(`${base}/saved/nested`);
  const nested = await js(`(() => { const outer = document.querySelector('scv-patchbay'), inner = outer.querySelector('scv-patchbay'), n = inner.querySelector('scv-logic');
    return [n.def.name, outer.nodeType('inner-only'), !!outer.querySelector(':scope > script[data-scv-node]'), !!inner.querySelector(':scope > script[data-scv-node]')]; })()`);
  ok(nested?.join() === 'inner-only,,false,true', `nested patchbay reopens with its own types, outer never learns them (${nested})`);

  // script elements removed by hand

  const strip = (html, id) => html.replace(new RegExp(`<script id="${id}">[\\s\\S]*?</script>\\n`), '');
  saved.set('handcanvas', strip(q, 'scv-studio'));
  saved.set('handpub', strip(strip(q, 'scv-studio'), 'scv-canvas'));
  for (const [k, canvas] of [['handcanvas', 'function'], ['handpub', 'undefined']]) {
    await nav(`${base}/saved/${k}`);
    const r = await js(`(() => { const pb = document.querySelector('scv-patchbay'); return [typeof pb.setView, typeof pb.save, getComputedStyle(pb.querySelector('scv-logic')).display]; })()`);
    ok(r && r[0] === canvas && r[1] === 'undefined', `quine with scripts removed by hand behaves as ${k === 'handcanvas' ? 'canvas' : 'publish'} (${r})`);
  }

  await run('nodes hidden without studio even in edit state', async () => {
    const pb = document.querySelector('scv-patchbay'); pb.mode = 'edit';
    return [getComputedStyle(pb.querySelector('scv-logic')).display === 'none', getComputedStyle(pb.querySelector('scv-logic')).display];
  });

  // canvas export

  await nav(`${base}/saved/canvas`);
  const view = await js(`(async () => {
    const pb = document.querySelector('scv-patchbay');
    pb.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, deltaY: 20, bubbles: true, cancelable: true }));
    const panned = pb.view;
    pb.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
    const at = pb.toCanvas(100, 100);
    return { panned, zoom: pb.zoom, at };
  })()`);
  ok(view && view.panned.x === -10 && view.panned.y === -20, `canvas: wheel pans (${JSON.stringify(view?.panned)})`);
  ok(view && view.zoom > 1 && Math.abs(view.at.x - 110) < 0.01 && Math.abs(view.at.y - 120) < 0.01, `canvas: ctrl-wheel zooms about pointer (${JSON.stringify(view)})`);

  // quests

  await nav(`${base}/saved/publish`);
  await js(`(${helpers.toString()})()`);
  await run('standalone publish keeps window.routeSend', async () => {
    const pb = document.querySelector('scv-patchbay'), d = document.createElement('div'); d.setAttribute('data-scv-receives', 'outside'); pb.append(d); await 0;
    window.routeSend('outside', 'in');
    return [d.textContent === 'in', d.textContent];
  });
  questPosts.length = 0;
  await js(`(async () => {
    const pb = document.querySelector('scv-patchbay'), q = document.createElement('scv-logic');
    q.dataset.type = 'quest'; q.setAttribute('mode', 'output'); q.setAttribute('value', 'outch'); pb.append(q);
    await new Promise(r => setTimeout(r, 20));
    q.receive(customElements.get('scv-patchbay').kit.pulse(), 'x'); q.receive(5, 'x');
    await new Promise(r => setTimeout(r, 100));
  })()`);
  ok(questPosts.length === 1 && questPosts[0].path === '/quests/emit' && questPosts[0].body.value === 5, `quest output posts data only (${JSON.stringify(questPosts)})`);

  const qin = await js(`(async () => {
    const pb = document.querySelector('scv-patchbay'), q = document.createElement('scv-logic');
    q.dataset.type = 'quest'; q.setAttribute('value', 'q_in'); pb.append(q);
    const d = document.createElement('div'); d.setAttribute('data-scv-receives', 'q_in'); pb.append(d);
    await new Promise(r => setTimeout(r, 300));
    return [d.textContent, q.getAttribute('last'), q.getAttribute('data-scv-emits')];
  })()`);
  ok(qin && qin[0] === '7' && qin[1] === '7' && qin[2] === 'q_in', `quest input polls, emits and keeps last (${qin})`);

  const qc = await js(`(async () => {
    const pb = document.querySelector('scv-patchbay'), q = document.createElement('scv-logic');
    q.dataset.type = 'quest'; q.setAttribute('mode', 'component'); q.setAttribute('value', 'q_comp'); q.style.left = '40px'; q.style.top = '40px'; pb.append(q);
    await new Promise(r => setTimeout(r, 400));
    const it = pb.querySelector('scv-item[data-scv-quest-channel="q_comp"]'), p = it?.firstElementChild?.shadowRoot?.querySelector('p'); p?.click();
    return [it?.style.top, p?.textContent, window.__ran ?? null];
  })()`);
  ok(qc && qc[0] === '80px' && qc[1] === 'live' && qc[2] === null, `quest component renders below node, its def code never runs (${qc})`);

  const perPb = await js(`(async () => {
    const make = api => {
      const pb = document.createElement('scv-patchbay'); pb.questApi = api; document.body.append(pb);
      const q = document.createElement('scv-logic'); q.dataset.type = 'quest'; q.setAttribute('value', 'q_in'); pb.append(q);
      const d = document.createElement('div'); d.setAttribute('data-scv-receives', 'q_in'); pb.append(d);
      return d;
    };
    const alt = make(location.origin + '/alt'), own = make(location.origin);
    await new Promise(r => setTimeout(r, 300));
    return [alt.textContent, own.textContent];
  })()`);
  ok(perPb && perPb[0] === '9' && perPb[1] === '7', `each patchbay reads its own quest api (${perPb})`);

  // in-page mount

  await nav(base + '/host');
  const host = await js(`(async () => {
    const a = document.getElementById('a'), b = document.getElementById('b'), r = a.getBoundingClientRect(), kit = customElements.get('scv-patchbay').kit;
    window.scvShared = { lent: { id: 'page' } };
    const got = kit.shared('lent', () => ({ id: 'own' })); kit.unshare('lent');
    return { body: getComputedStyle(document.body).backgroundColor, routeSend: typeof window.routeSend, a: getComputedStyle(a).getPropertyValue('--background-sunk').trim(),
      b: getComputedStyle(b).getPropertyValue('--background-sunk').trim(), size: r.width + 'x' + r.height, position: getComputedStyle(a).position, lent: got.id, kept: window.scvShared.lent === got };
  })()`);
  ok(host?.body === 'rgb(1, 2, 3)' && host.routeSend === 'undefined', `mounted patchbay leaves host page background and window alone (${JSON.stringify(host)})`);
  ok(host?.a === '#1A1C1C' && host.b === 'rgb(9,9,9)', `host themes one patchbay, other keeps tokens (${host?.a}, ${host?.b})`);
  ok(host?.size === '200x100' && host.position !== 'fixed', `mounted canvas fills its own box, not window (${host?.size}, ${host?.position})`);
  ok(host?.lent === 'page' && host.kept, `page lends to its own patchbay through window.scvShared (${host?.lent})`);
  await nav(base + '/pb');
  const unbridged = await js(`(async () => {
    const f = document.createElement('iframe'); f.src = location.origin + '/host'; document.body.append(f); await new Promise(r => { f.onload = r; });
    const got = []; addEventListener('message', e => { if (e.data?.scv === 'receive') got.push(e.data); });
    f.contentWindow.postMessage({ scv: 'listen', channel: 'hx' }, '*'); f.contentWindow.postMessage({ scv: 'route', channel: 'hx', value: 1 }, '*');
    await new Promise(r => setTimeout(r, 200)); f.remove();
    return [got.length, getComputedStyle(document.body).backgroundColor, typeof window.routeSend];
  })()`);
  ok(unbridged?.join() === '0,rgb(26, 28, 28),function', `host page never answers bridge, patchbay file keeps page look and routeSend (${unbridged})`);

  // embedding - parent talks to framed file by message

  await nav(base + '/pb');
  const bridged = await js(`(async () => {
    const f = document.createElement('iframe'); f.sandbox = 'allow-scripts'; f.src = location.origin + '/pb'; document.body.append(f);
    await new Promise(r => { f.onload = r; });
    const got = [], post = m => f.contentWindow.postMessage(m, '*');
    addEventListener('message', e => { if (e.source === f.contentWindow && e.data?.scv === 'receive') got.push(e.data); });
    const t = performance.timeOrigin + performance.now();
    post({ scv: 'listen', channel: 'x' });
    post({ scv: 'route', channel: 'x', value: 5 });
    post({ scv: 'route', channel: 'x', value: { scv: 'pulse', t } });
    post({ scv: 'route', channel: 'y', value: 6 });
    post({ scv: 'unlisten', channel: 'x' });
    post({ scv: 'route', channel: 'x', value: 7 });
    await new Promise(r => setTimeout(r, 300));
    f.remove();
    return { values: got.map(g => g.channel + ':' + (g.value?.scv || g.value)), dt: Math.abs((got[1]?.value?.t ?? 1e9) - t) };
  })()`);
  ok(bridged?.values.join() === 'x:5,x:pulse' && bridged.dt < 0.01, `sandboxed frame routes parent messages, sends back only listened channel, pulse keeps its time (${JSON.stringify(bridged)})`);

  const foreign = await js(`(async () => {
    const f = document.createElement('iframe'); f.src = location.origin + '/pb'; document.body.append(f);
    await new Promise(r => { f.onload = r; });
    const got = []; addEventListener('message', e => { if (e.data?.scv === 'receive') got.push(e.data.value); });
    f.contentWindow.postMessage({ scv: 'listen', channel: 'z' }, '*');
    await new Promise(r => setTimeout(r, 50));
    f.contentWindow.Function("postMessage({ scv: 'route', channel: 'z', value: 'self' }, '*')")(); // source is frame itself
    f.contentWindow.postMessage({ scv: 'route', channel: 'z', value: 'parent' }, '*');
    await new Promise(r => setTimeout(r, 200));
    f.remove();
    return got;
  })()`);
  ok(foreign?.join() === 'parent', `frame ignores messages not from its parent (${foreign})`);

  const described = await js(`(async () => {
    const f = document.createElement('iframe'); f.src = location.origin + '/pb'; document.body.append(f); await new Promise(r => { f.onload = r; });
    const w = f.contentWindow, ipb = w.document.querySelector('scv-patchbay'), kit = w.customElements.get('scv-patchbay').kit;
    kit.defineNode(ipb, { name: 'ds-port', inputs: [{ name: 'in', type: 'text' }], outputs: [{ name: 'out' }] });
    ipb.insertAdjacentHTML('beforeend', '<scv-logic data-type="ds-port" data-scv-receives="price@in" data-scv-emits="verdict@out"></scv-logic><scv-logic data-type="accumulator" data-scv-receives="verdict"></scv-logic>');
    const got = new Promise(r => addEventListener('message', e => { if (e.source === w && e.data?.scv === 'description') r(e.data); }));
    w.postMessage({ scv: 'describe' }, '*');
    const d = await Promise.race([got, new Promise(r => setTimeout(() => r(null), 500))]); f.remove();
    return d && { version: d.version, channels: d.channels.map(c => c.name + (c.emits ? '>' : '') + (c.receives ? '<' : '') + (c.ports.length ? '@' + c.ports.join('|') : '')).sort().join(), nodes: d.nodes.map(n => n.type + ':' + n.inputs.map(p => p.name + '/' + (p.type || '')).join() + '>' + n.outputs.map(p => p.name).join()).sort().join() };
  })()`);
  ok(described?.version === '1.5.0' && described.channels === 'price<@in,verdict><@out' && described.nodes === 'accumulator:>,ds-port:in/text>out', `describe lists channels with ports and node types with declared ports (${JSON.stringify(described)})`);

  const lent = await js(`(async () => {
    const kit = customElements.get('scv-patchbay').kit, own = { id: 'host' };
    kit.shared('lend', () => own);
    const f = document.createElement('iframe'); f.src = location.origin + '/pb'; document.body.append(f);
    await new Promise(r => { f.onload = r; });
    const fk = f.contentWindow.customElements.get('scv-patchbay').kit;
    const got = fk.shared('lend', () => ({ id: 'frame' })), fresh = fk.shared('solo', () => ({ id: 'frame' }));
    fk.unshare('lend'); const kept = kit.isShared('lend');
    kit.unshare('lend'); const gone = !kit.isShared('lend');
    f.remove();
    window.scvShared = { audio: { id: 'daw' } };
    const g = document.createElement('iframe'); g.src = location.origin + '/pb'; document.body.append(g);
    await new Promise(r => { g.onload = r; });
    const gk = g.contentWindow.customElements.get('scv-patchbay').kit, offered = gk.shared('audio', () => ({ id: 'frame' }));
    gk.unshare('audio'); const again = gk.shared('audio', () => ({ id: 'frame' }));
    g.remove(); delete window.scvShared;
    return [got === own, fresh.id, kept, gone, offered.id, again.id];
  })()`);
  ok(lent?.slice(0, 4).join() === 'true,frame,true,true', `same-origin frame borrows host's shared instance, makes its own when host has none (${lent})`);
  ok(lent?.[4] === 'daw' && lent[5] === 'daw', `frame takes instance plain host page offers in window.scvShared (${lent})`);

  // teardown - a hidden tab paints no frames, so the timer has to be what releases

  await nav(base + '/pb'); // earlier blocks navigated away - helpers live per document
  await js(`(${helpers.toString()})()`);

  await run('timer in a node removed while no frames come stops', async () => {
    const pb = T.pb(), n = T.node(pb, 'delay', { value: '30' });
    await T.frame();
    const fired = [];
    n.emit = v => fired.push(v); // detached node routes nowhere, so watch the node itself
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0; // what a hidden tab does to the callback
    try { n.receive(5, 'in'); n.remove(); await T.sleep(150); } finally { window.requestAnimationFrame = raf; }
    return [fired.length === 0, { fired, live: n._live }];
  });

  await run('component removed while no frames come runs its onTeardown', async () => {
    const pb = T.pb();
    window.__torn = 0;
    T.comp('tdn', '<b>t</b><script>onTeardown(() => { window.__torn++; });<\/script>', pb);
    const el = T.item(pb, document.createElement('scv-tdn'));
    await T.frame();
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    try { el.closest('scv-item').remove(); await T.sleep(80); } finally { window.requestAnimationFrame = raf; }
    return [window.__torn === 1, { torn: window.__torn }];
  });

  await run('moved node and component never tear down', async () => {
    const pb = T.pb(), box = document.createElement('div');
    document.body.append(box);
    window.__torn2 = 0;
    T.comp('mvd', '<b>m</b><script>onTeardown(() => { window.__torn2++; });<\/script>', pb);
    const el = T.item(pb, document.createElement('scv-mvd'));
    const n = T.node(pb, 'clock', { value: '1000' });
    await T.frame();
    box.append(el.closest('scv-item'), n); // append moves - disconnect then connect, same task
    await T.frame(); await T.sleep(40);
    return [window.__torn2 === 0 && n._live === true, { torn: window.__torn2, live: n._live }];
  });

  await run('node removed and re-added in one task keeps running', async () => {
    const pb = T.pb(), n = T.node(pb, 'delay', { value: '30', 'data-scv-emits': 'back' });
    const sink = T.sink(pb, 'back');
    await T.frame();
    n.receive(7, 'in');
    n.remove(); pb.append(n); // same task
    await T.sleep(150);
    return [sink.log.length === 1 && sink.log[0] === 7, { emitted: sink.log, live: n._live }];
  });

  // shadow wiring - wiring moving in reaches the cache, unwired re-renders never drop it

  await run('wired element added to a shadow after routing gets the next value', async () => {
    const pb = T.pb();
    T.comp('shw', '<div class="box"></div>', pb);
    const el = T.item(pb, document.createElement('scv-shw'));
    await T.frame();
    pb.routeSend('sh', 'first'); // warms the cache with nothing wired in that shadow
    const span = document.createElement('span');
    span.setAttribute('data-scv-receives', 'sh');
    el.shadowRoot.querySelector('.box').append(span);
    pb.routeSend('sh', 'second');
    return [span.textContent === 'second', { got: span.textContent }];
  });

  await run('unwired shadow re-render never rebuilds the router cache', async () => {
    const pb = T.pb();
    T.comp('shr', '<div class="box"><i>a</i></div>', pb);
    const el = T.item(pb, document.createElement('scv-shr'));
    const sink = T.sink(pb, 'rr');
    await T.frame();
    pb.routeSend('rr', 'warm');
    let walks = 0; // a rebuild walks this shadow, nothing else does
    const sr = el.shadowRoot, real = sr.querySelectorAll.bind(sr);
    Object.defineProperty(sr, 'querySelectorAll', { configurable: true, value: sel => { walks++; return real(sel); } });
    for (let i = 0; i < 5; i++) { sr.querySelector('.box').innerHTML = '<i>' + i + '</i>'; pb.routeSend('rr', i); } // the shape patch(el, { html }) makes
    const unwired = walks;
    const span = document.createElement('span'); span.setAttribute('data-scv-receives', 'rr');
    sr.querySelector('.box').append(span);
    pb.routeSend('rr', 'wired');
    return [unwired === 0 && walks > 0 && span.textContent === 'wired' && sink.log.length === 7, { unwired, afterWiring: walks, got: span.textContent, delivered: sink.log.length }];
  });

  // clock wakes

  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__timeouts = 0; const _st = window.setTimeout; window.setTimeout = (...a) => { window.__timeouts++; return _st(...a); };` });
  await nav(base + '/pb');
  const wakes = await js(`(async () => {
    const pb = document.querySelector('scv-patchbay'), c = document.createElement('scv-logic');
    c.dataset.type = 'clock'; c.setAttribute('value', '250'); pb.append(c);
    const t0 = window.__timeouts; await new Promise(r => requestAnimationFrame(r));
    const start = window.__timeouts; let n = 0; const id = setInterval(() => n++, 1000);
    await new Promise(r => { const s = performance.now(); (function wait() { performance.now() - s > 1000 ? r() : requestAnimationFrame(wait); })(); });
    clearInterval(id); c.remove();
    return window.__timeouts - start;
  })()`);
  ok(typeof wakes === 'number' && wakes <= 6, `one clock at 250ms wakes page about 4 times per second (${wakes})`);

  ok(uncaught.length === 0, `no uncaught errors (${uncaught})`);
} catch (e) {
  fails++; console.log('  ✗ patchbay tier threw:', e.message);
} finally { done(); }

console.log(fails ? `patchbay: FAIL (${fails})` : 'patchbay: PASS');
process.exit(fails ? 1 : 0);
