// next studio tier - real pointer and key events

import { launchChrome, connect } from './_cdp.mjs';
import { createServer } from 'http';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const here = dirname(fileURLToPath(import.meta.url));
const pbUrl = pathToFileURL(join(here, '..', 'patchbay-next.html')).href;

const unfurls = []; // mock quest server: link cards ask it for page meta
const qs = createServer((req, res) => { res.setHeader('access-control-allow-origin', '*'); if (req.url.startsWith('/unfurl')) { unfurls.push(req.url); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ title: 'Example Page', description: 'about it' })); } res.statusCode = 404; res.end(); });
await new Promise(r => qs.listen(0, '127.0.0.1', r));
const qsBase = `http://127.0.0.1:${qs.address().port}`;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
const uncaught = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') uncaught.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
const js = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { threw: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const frames = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))');

// modifiers bitmask: alt 1, ctrl 2, meta 4, shift 8
const ALT = 1, CTRL = 2, SHIFT = 8;
const mouse = (type, x, y, mod = 0, button = 'left', clickCount = 1) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, buttons: 0, clickCount, modifiers: mod });
const hover = async (x, y, mod = 0) => { await mouse('mouseMoved', x, y, mod); await frames(); };
const click = async (x, y, mod = 0, button = 'left') => { await mouse('mouseMoved', x, y, mod); await mouse('mousePressed', x, y, mod, button); await mouse('mouseReleased', x, y, mod, button); await frames(); };
const press = async (x, y, mod = 0) => { await mouse('mouseMoved', x, y, mod); await mouse('mousePressed', x, y, mod); };
const moveTo = async (x0, y0, x1, y1, mod = 0, steps = 6) => { for (let i = 1; i <= steps; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps, button: 'left', buttons: 1, modifiers: mod }); await js('new Promise(r => requestAnimationFrame(r))'); } };
const drag = async (x0, y0, x1, y1, mod = 0) => { await press(x0, y0, mod); await moveTo(x0, y0, x1, y1, mod); await mouse('mouseReleased', x1, y1, mod); await frames(); };
const KEYS = { Tab: 9, Enter: 13, Escape: 27, ' ': 32, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, '[': 219, ']': 221, '?': 191 };
const key = async (k, mod = 0) => {
  const vk = KEYS[k] ?? k.toUpperCase().charCodeAt(0), code = /^[0-9]$/.test(k) ? 'Digit' + k : /^[a-z]$/i.test(k) ? 'Key' + k.toUpperCase() : k === ' ' ? 'Space' : k === '?' ? 'Slash' : k;
  const text = k.length === 1 && !(mod & CTRL) ? k : undefined;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mod, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mod });
  await frames();
};

const helpers = () => {
  const pb = document.querySelector('scv-patchbay'), kit = customElements.get('scv-patchbay').kit;
  window.T = {
    pb, kit,
    nodes: () => [...pb.querySelectorAll('scv-logic')],
    node(type, x, y, attrs = {}) { const n = document.createElement('scv-logic'); n.dataset.type = type; n.style.left = x + 'px'; n.style.top = y + 'px'; for (const k in attrs) n.setAttribute(k, attrs[k]); pb.append(n); return n; },
    item(html, x, y) { const it = document.createElement('scv-item'); it.style.left = x + 'px'; it.style.top = y + 'px'; it.innerHTML = html; pb.append(it); return it; },
    comp(name, body) { const t = document.createElement('template'); t.setAttribute('data-scv-comp', name); t.innerHTML = body; document.body.append(t); return kit.defineComponent(t); },
    shadow: sel => pb.shadowRoot.querySelector(sel),
    frame: () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  };
  return true;
};
const fresh = async () => { await send('Page.navigate', { url: pbUrl }); await waitEvent('Page.loadEventFired'); await js(`(${helpers.toString()})()`); await frames(); };
const run = async (name, fn) => { // fn: async () => [pass, detail], may drive real input between page calls
  try { const r = await fn(); ok(Array.isArray(r) && r[0] === true, `${name} (${JSON.stringify(r?.[1] ?? r)})`); }
  catch (e) { ok(false, `${name} - threw ${e.message}`); }
};

try {
  // modes

  await fresh();
  await run('opens in edit mode with nodes shown', async () => {
    const r = await js(`(() => { const n = T.node('clock', 100, 100); return [T.pb.mode, getComputedStyle(n).display]; })()`);
    return [r[0] === 'edit' && r[1] === 'flex', r];
  });
  await run('tab switches to use mode, nodes and cables hidden', async () => {
    await key('Tab');
    const r = await js(`[T.pb.mode, getComputedStyle(T.nodes()[0]).display, getComputedStyle(T.shadow('.cables')).display]`);
    await key('Tab');
    return [r.join() === 'use,none,none', r];
  });
  await run('component shadows get hover outline only while editing', async () => {
    const r = await js(`(async () => { const tag = T.comp('hv1', '<b>x</b>'); const it = T.item('<' + tag + ' data-scv-id="h"></' + tag + '>', 400, 400); await T.frame();
      const sr = it.firstElementChild.shadowRoot, edit = sr.adoptedStyleSheets.length; T.pb.setMode('use'); const use = sr.adoptedStyleSheets.length; T.pb.setMode('edit'); return [edit, use]; })()`);
    return [r[0] === 1 && r[1] === 0, r];
  });

  // spawn

  await fresh();
  await run('digit spawns its node at pointer, 0 is quest', async () => {
    await hover(300, 300); await key('0'); await key('Escape'); await hover(400, 300); await key('1'); await key('Escape');
    const r = await js(`T.nodes().map(n => n.dataset.type + '@' + n.style.left + ',' + n.style.top)`);
    return [r.join() === 'quest@284px,284px,clock@384px,284px', r];
  });
  await run('spawn opens input of nodes that need filling', async () => {
    await hover(500, 300); await key('8'); const r = await js(`T.nodes().at(-1).states.has('expanded')`);
    await key('Escape'); await key('z', CTRL);
    return [r === true, r];
  });
  await run('spawn is one undo step', async () => {
    await key('z', CTRL);
    const r = await js(`T.nodes().map(n => n.dataset.type)`);
    return [r.join() === 'quest', r];
  });

  // node gestures

  await fresh();
  await run('click triggers node, one undo step', async () => {
    await js(`T.node('accumulator', 200, 200)`); await frames();
    await click(216, 216); const v = await js(`T.nodes()[0].getAttribute('value')`);
    await key('z', CTRL); const u = await js(`T.nodes()[0].getAttribute('value')`);
    return [v === '1' && u === null, [v, u]];
  });
  await run('right click cycles mode, undoable', async () => {
    await js(`T.node('clock', 400, 200)`); await frames();
    await click(416, 216, 0, 'right'); const m = await js(`T.nodes()[1].getAttribute('mode')`);
    await key('z', CTRL); const u = await js(`T.nodes()[1].getAttribute('mode')`);
    return [m === 'offbeat' && u === null, [m, u]];
  });
  await run('drag node onto node wires them, undo unwires', async () => {
    await drag(216, 216, 416, 216);
    const w = await js(`[T.nodes()[0].getAttribute('data-scv-emits'), T.nodes()[1].getAttribute('data-scv-receives')]`);
    await key('z', CTRL);
    const u = await js(`[T.nodes()[0].getAttribute('data-scv-emits'), T.nodes()[1].getAttribute('data-scv-receives')]`);
    return [w[0] && w[0] === w[1] && u[0] === null && u[1] === null, { w, u }];
  });
  await run('wire dropped on empty canvas offers nodes, choice spawns and wires', async () => {
    await drag(216, 216, 600, 500);
    const items = await js(`T.pb.menu()`);
    const at = await js(`(() => { const b = [...T.pb.shadowRoot.querySelectorAll('.menu button')].find(b => b.firstChild.textContent === '[node] - gate'), r = b.getBoundingClientRect(); return [r.x + 10, r.y + 5]; })()`);
    await click(at[0], at[1]);
    const r = await js(`(() => { const g = T.nodes().find(n => n.dataset.type === 'gate'); return g && [g.style.left, g.getAttribute('data-scv-receives') === T.nodes()[0].getAttribute('data-scv-emits')]; })()`);
    return [items?.includes('[node] - gate') && r && r[0] === '584px' && r[1] === true, { items: items?.length, r }];
  });
  await run('ctrl-drag moves node, alt lands glyph on dot', async () => {
    await drag(216, 216, 263, 251, CTRL | ALT);
    const r = await js(`[parseFloat(T.nodes()[0].style.left), parseFloat(T.nodes()[0].style.top)]`);
    return [(r[0] + 16 - 12) % 24 === 0 && (r[1] + 16 - 12) % 24 === 0 && r[0] !== 200, r];
  });
  await run('ctrl-click toggles selection', async () => {
    await js(`T.pb.select([])`);
    await click(416, 216, CTRL); const a = await js(`T.pb.selection().length`);
    await click(416, 216, CTRL); const b = await js(`T.pb.selection().length`);
    return [a === 1 && b === 0, [a, b]];
  });
  await run('ctrl-double-click opens node input', async () => {
    await mouse('mouseMoved', 416, 216, CTRL);
    for (const n of [1, 2]) { await mouse('mousePressed', 416, 216, CTRL, 'left', n); await mouse('mouseReleased', 416, 216, CTRL, 'left', n); }
    await frames();
    const r = await js(`[T.nodes()[1].states.has('expanded'), T.nodes()[1].states.has('selected')]`);
    return [r.join() === 'true,true', r];
  });
  await run('enter opens selected node', async () => {
    await key('Escape');
    await js(`(() => { const n = T.node('variable', 600, 100); T.pb.select([n]); })()`); await frames();
    await key('Enter');
    const r = await js(`T.nodes().at(-1).states.has('expanded')`);
    return [r === true, r];
  });
  await run('plain click never opens node', async () => {
    await js(`T.node('mutator', 700, 100)`); await frames();
    await click(716, 116); await click(716, 116);
    const r = await js(`T.nodes().at(-1).states.has('expanded')`);
    return [r === false, r];
  });

  // items

  await fresh();
  await js(`(() => { const tag = T.comp('pad', '<style>button{width:60px;height:30px}</style><button class="go">go</button><b class="out">0</b>'); T.item('<' + tag + ' data-scv-id="p1"></' + tag + '>', 100, 400); T.item('<' + tag + ' data-scv-id="p2"></' + tag + '>', 300, 400); T.node('accumulator', 600, 400); })()`);
  await frames();
  await run('drag inside component wires from element under pointer', async () => {
    const at = await js(`(() => { const r = T.pb.querySelector('[data-scv-id=p1]').shadowRoot.querySelector('.go').getBoundingClientRect(); return [r.x + 10, r.y + 10]; })()`);
    await drag(at[0], at[1], 616, 416);
    const r = await js(`[T.pb.querySelector('[data-scv-id=p1]').shadowRoot.querySelector('.go').getAttribute('data-scv-emits'), T.nodes()[0].getAttribute('data-scv-receives')]`);
    return [r[0] && r[0] === r[1], r];
  });
  await run('wire started on text inside button leaves from button', async () => {
    const at = await js(`(() => { const tag = T.comp('bt1', '<button class="b"><span class="s">press me</span></button>'); T.item('<' + tag + ' data-scv-id="bt"></' + tag + '>', 100, 600); return new Promise(r => requestAnimationFrame(() => { const q = T.pb.querySelector('[data-scv-id=bt]').shadowRoot.querySelector('.s').getBoundingClientRect(); r([q.x + 5, q.y + 5]); })); })()`);
    await drag(at[0], at[1], 616, 416);
    const r = await js(`(() => { const sr = T.pb.querySelector('[data-scv-id=bt]').shadowRoot; return [!!sr.querySelector('.b').getAttribute('data-scv-emits'), sr.querySelector('.s').hasAttribute('data-scv-emits')]; })()`);
    await key('z', CTRL); await js(`T.pb.querySelector('[data-scv-id=bt]').parentElement.remove()`); await frames();
    return [r.join() === 'true,false', r];
  });
  await run('click selects item alone, shift adds', async () => {
    await click(130, 420); const a = await js(`T.pb.selection().length`);
    await click(330, 420, SHIFT); const b = await js(`T.pb.selection().length`);
    await click(130, 420); const c = await js(`T.pb.selection().length`);
    return [a === 1 && b === 2 && c === 1, [a, b, c]];
  });
  await run('ctrl-drag moves selection together, one undo step', async () => {
    await click(330, 420, SHIFT);
    await drag(130, 420, 180, 470, CTRL);
    const m = await js(`[...T.pb.querySelectorAll('scv-item')].map(i => i.style.left + ',' + i.style.top)`);
    await key('z', CTRL);
    const u = await js(`[...T.pb.querySelectorAll('scv-item')].map(i => i.style.left + ',' + i.style.top)`);
    return [m.join() === '150px,450px,350px,450px' && u.join() === '100px,400px,300px,400px', { m, u }];
  });
  await run('corner diamond scales item, alt in whole cells, undo', async () => {
    await click(130, 420);
    const c = await js(`(() => { const r = T.shadow('.corner[data-c="se"]').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await drag(c[0], c[1], c[0] + 40, c[1] + 20, ALT);
    const s = await js(`(() => { const i = T.pb.querySelector('scv-item'); return [parseFloat(i.style.scale), T.pb.geometry(i).w, i.style.left]; })()`);
    await key('z', CTRL);
    const u = await js(`T.pb.querySelector('scv-item').style.scale`);
    return [s[0] > 1 && Math.abs(s[1] / 24 - Math.round(s[1] / 24)) < 0.01 && s[2] === '100px' && u === '', { s, u }];
  });
  await run('shift-drag border edge crops, undo', async () => {
    const b = await js(`T.pb.geometry(T.pb.querySelector('scv-item'))`);
    await drag(b.x + b.w - 2, b.y + b.h - 9, b.x + b.w - 22, b.y + b.h - 9, SHIFT); // off the cable leaving this item
    const r = await js(`[T.pb.querySelector('[data-scv-id=p1]').style.clipPath, T.pb.geometry(T.pb.querySelector('scv-item')).w]`);
    await key('z', CTRL);
    const u = await js(`T.pb.querySelector('[data-scv-id=p1]').style.clipPath`);
    return [/^inset\(0px 2\d(\.\d+)?px 0px 0px\)$/.test(r[0]) && Math.abs(r[1] - (b.w - 20)) < 1 && u === '', { r, u, w: b.w }];
  });
  await run('[ and ] change z-order', async () => {
    await click(130, 420); await key(']'); await key(']'); const up = await js(`T.pb.querySelector('scv-item').style.zIndex`);
    await key('['); const down = await js(`T.pb.querySelector('scv-item').style.zIndex`);
    return [up === '3' && down === '2', [up, down]];
  });
  await run('arrows nudge 1, shift 10, alt to grid, one undo each', async () => {
    await key('ArrowRight'); const a = await js(`T.pb.querySelector('scv-item').style.left`);
    await key('ArrowRight', SHIFT); const b = await js(`T.pb.querySelector('scv-item').style.left`);
    await key('ArrowRight', ALT); const c = await js(`T.pb.querySelector('scv-item').style.left`);
    await key('z', CTRL); const u = await js(`T.pb.querySelector('scv-item').style.left`);
    return [a === '101px' && b === '111px' && c === '132px' && u === '111px', [a, b, c, u]];
  });
  await run('held arrow keeps moving, whole hold is one undo step', async () => {
    const before = await js(`T.pb.querySelector('scv-item').style.left`);
    for (let i = 0; i < 4; i++) await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, autoRepeat: i > 0 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }); await frames();
    const held = await js(`T.pb.querySelector('scv-item').style.left`);
    await key('z', CTRL); const u = await js(`T.pb.querySelector('scv-item').style.left`);
    return [parseFloat(held) === parseFloat(before) + 4 && u === before, [before, held, u]];
  });
  await run('backspace deletes selection, undo restores dom order', async () => {
    await click(130, 420); await click(330, 420, SHIFT);
    const before = await js(`[...T.pb.children].map(c => c.localName + (c.firstElementChild?.dataset.scvId || ''))`);
    await key('Backspace'); const gone = await js(`T.pb.querySelectorAll('scv-item').length`);
    await key('z', CTRL);
    const after = await js(`[...T.pb.children].map(c => c.localName + (c.firstElementChild?.dataset.scvId || ''))`);
    return [gone === 0 && before.join() === after.join(), { gone, before, after }];
  });

  // lasso

  await run('lasso selects units it touches, click on empty clears', async () => {
    await key('Escape');
    await drag(80, 380, 250, 470);
    const a = await js(`T.pb.selection().map(u => u.firstElementChild?.dataset.scvId || u.dataset.type)`);
    await click(900, 700); const b = await js(`T.pb.selection().length`);
    return [a.join() === 'p1' && b === 0, [a, b]];
  });

  // cables

  await fresh();
  await js(`(() => { const a = T.node('accumulator', 100, 100), b = T.node('accumulator', 400, 100), c = T.node('accumulator', 100, 400), d = T.node('accumulator', 400, 400); T.pb.wire(a, b); T.pb.wire(c, d); })()`);
  await frames();
  await run('one cable per wire, wired state on sources', async () => {
    const r = await js(`[T.pb.shadowRoot.querySelectorAll('.cable').length, T.nodes().map(n => n.states.has('wired'))]`);
    return [r[0] === 2 && r[1].join() === 'true,false,true,false', r];
  });
  await run('moving node rewrites only its own cables', async () => {
    await js(`(() => { const ps = [...T.pb.shadowRoot.querySelectorAll('.cable')]; window.__paths = ps; window.__writes = ps.map(() => 0); new MutationObserver(rs => rs.forEach(r => { const i = ps.indexOf(r.target); if (i >= 0) window.__writes[i]++; })).observe(T.shadow('.cables'), { subtree: true, attributes: true, attributeFilter: ['d'] }); })()`);
    await drag(116, 116, 156, 146, CTRL);
    const r = await js(`[window.__writes, [...T.pb.shadowRoot.querySelectorAll('.cable')].every((p, i) => p === window.__paths[i])]`);
    return [r[0][0] > 0 && r[0][1] === 0 && r[1], r];
  });
  await run('hovered cable reddens its source ring', async () => {
    const at = await js(`(() => { const p = T.pb.shadowRoot.querySelector('.cable'), q = p.getPointAtLength(p.getTotalLength() * 0.4); return [q.x, q.y]; })()`);
    await hover(at[0], at[1]); const on = await js(`T.nodes()[0].states.has('danger')`);
    await hover(900, 700); const off = await js(`T.nodes()[0].states.has('danger')`);
    return [on === true && off === false, [on, off]];
  });
  await run('click on cable cuts it, undo restores', async () => {
    await js(`T.nodes()[3].setAttribute('data-scv-action', 'increment:' + T.nodes()[2].getAttribute('data-scv-emits'))`); await frames();
    const at = await js(`(() => { const p = [...T.pb.shadowRoot.querySelectorAll('.cable')].find(p => p._cable.tgt === T.nodes()[3]), l = p.getTotalLength(), q = p.getPointAtLength(l * 0.4); return [q.x, q.y]; })()`);
    await click(at[0], at[1]); const one = await js(`[T.nodes()[3].getAttribute('data-scv-receives'), !!T.nodes()[3].getAttribute('data-scv-action')]`);
    await click(at[0], at[1]); const two = await js(`[T.nodes()[3].getAttribute('data-scv-action'), T.nodes()[2].states.has('wired')]`);
    await key('z', CTRL); await key('z', CTRL); const back = await js(`!!T.nodes()[3].getAttribute('data-scv-receives')`);
    return [one[0] === null && one[1] === true && two[0] === null && two[1] === false && back === true, { one, two, back }];
  });
  await run('route flashes each cable once per frame', async () => {
    await js(`(async () => { [...T.pb.querySelectorAll('scv-logic')].forEach(n => n.remove()); let prev = T.node('accumulator', 100, 600); for (let i = 1; i < 5; i++) { const n = T.node('accumulator', 100 + i * 150, 600); T.pb.wire(prev, n); prev = n; } await new Promise(r => setTimeout(r, 450)); })()`);
    const r = await js(`(async () => { T.nodes()[0].trigger(); T.nodes()[0].trigger(); await T.frame(); return [...T.pb.shadowRoot.querySelectorAll('.cable')].map(p => p.getAnimations().length); })()`);
    return [r.length === 4 && r.every(n => n === 1), r];
  });
  await run('emitting node ring flashes with its cable', async () => {
    const r = await js(`(async () => { await new Promise(r => setTimeout(r, 450)); T.nodes()[1].trigger(); await T.frame(); return T.nodes().map(n => n.getAnimations().length); })()`);
    return [r[1] === 1 && r[0] === 0, r];
  });
  await run('fast routing restarts flash, never stacks', async () => {
    const r = await js(`(async () => { for (let i = 0; i < 5; i++) { T.nodes()[0].trigger(); await T.frame(); } return [...T.pb.shadowRoot.querySelectorAll('.cable')].map(p => p.getAnimations().length).concat(T.nodes()[0].getAnimations().length); })()`);
    return [r.every(n => n === 1), r];
  });
  await run('pulse flashes dashed, data solid', async () => {
    const r = await js(`(async () => { const [a, b] = T.nodes(); T.pb.routeSend(a.getAttribute('data-scv-emits'), T.kit.pulse()); await T.frame(); const p = [...T.pb.shadowRoot.querySelectorAll('.cable')][0]; return p.getAnimations().at(-1).effect.getKeyframes()[0].strokeDasharray; })()`);
    return [r?.replace(',', '') === '6 6', r];
  });

  // inner ends

  await fresh();
  await js(`(() => { const tag = T.comp('pad2', '<style>button{width:60px;height:30px;margin:20px}</style><button class="go">go</button>'); T.item('<' + tag + ' data-scv-id="p"></' + tag + '>', 100, 300); const n = T.node('accumulator', 500, 300); T.pb.wire(T.pb.querySelector('[data-scv-id=p]').shadowRoot.querySelector('.go'), n); })()`);
  await frames();
  await run('cable leaves inner element, drag reads no layout', async () => {
    const start = await js(`(() => { const d = T.pb.cables()[0].d.split(' '), r = T.pb.querySelector('[data-scv-id=p]').shadowRoot.querySelector('.go').getBoundingClientRect(); return [+d[1], +d[2], r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await press(105, 305, CTRL);
    await js(`(() => { window.__reads = 0; const g = Element.prototype.getBoundingClientRect; Element.prototype.getBoundingClientRect = function () { window.__reads++; return g.call(this); }; })()`);
    await moveTo(105, 305, 205, 355, CTRL); await mouse('mouseReleased', 205, 355, CTRL); await frames();
    const reads = await js(`window.__reads`);
    const near = Math.hypot(start[0] - start[2], start[1] - start[3]) < 40;
    const baked = await js(`T.pb.querySelector('scv-item').style.translate`);
    return [near && reads === 0 && baked === '', { start, reads, baked }];
  });
  await run('routed text never measures inside frame callback', async () => {
    const r = await js(`(async () => {
      const out = T.pb.querySelector('[data-scv-id=p]').shadowRoot.querySelector('.go'), n = T.nodes()[0];
      out.setAttribute('data-scv-receives', 'txt'); n.setAttribute('data-scv-emits', 'txt'); await T.frame(); await T.frame();
      let inFrame = false, frameReads = 0; const raf = window.requestAnimationFrame, g = Element.prototype.getBoundingClientRect;
      window.requestAnimationFrame = cb => raf(t => { inFrame = true; try { cb(t); } finally { inFrame = false; } });
      Element.prototype.getBoundingClientRect = function () { if (inFrame) frameReads++; return g.call(this); };
      for (let i = 0; i < 10; i++) { T.pb.routeSend('txt', 'value ' + 'x'.repeat(i)); await T.frame(); }
      window.requestAnimationFrame = raf; Element.prototype.getBoundingClientRect = g;
      return frameReads;
    })()`);
    return [r === 0, r];
  });
  await run('cable end follows inner element as it grows', async () => {
    const r = await js(`(async () => {
      const out = T.pb.querySelector('[data-scv-id=p]').shadowRoot.querySelector('.go'), n = T.node('accumulator', 500, 600);
      out.style.width = 'auto'; out.setAttribute('data-scv-emits', 'fromout'); n.setAttribute('data-scv-receives', 'fromout'); await T.frame(); await T.frame();
      T.pb.routeSend('txt', 'a much longer label than before'); await T.frame(); await T.frame(); await T.frame();
      const c = T.pb.cables().find(c => c.src === out), q = out.getBoundingClientRect(), d = c.d.split(' ');
      return [+d[1], q.x + q.width / 2];
    })()`);
    return [Math.abs(r[0] - r[1]) < 2, r];
  });

  // hover and selection dimming

  await fresh();
  await js(`(() => { const a = T.node('accumulator', 100, 100), b = T.node('accumulator', 300, 100); T.node('accumulator', 500, 100); T.pb.wire(a, b); })()`);
  await frames();
  await run('hover dims units not wired to hovered one', async () => {
    await hover(116, 116);
    const r = await js(`T.nodes().map(n => n.states.has('dimmed'))`);
    await hover(900, 700);
    const off = await js(`T.nodes().map(n => n.states.has('dimmed'))`);
    return [r.join() === 'false,false,true' && off.every(x => !x), { r, off }];
  });
  await run('selection dims the rest', async () => {
    await click(516, 116, CTRL);
    const r = await js(`T.nodes().map(n => n.states.has('dimmed'))`);
    return [r.join() === 'true,true,false', r];
  });
  await run('tooltip labels wire end under pointer', async () => {
    await key('Escape'); await hover(116, 116);
    const r = await js(`[T.shadow('.tip').hidden, T.shadow('.tip').textContent]`);
    return [r[0] === false && r[1] === 'accumulator', r];
  });

  // node input

  await fresh();
  await run('committed node edit is one undo step', async () => {
    await hover(300, 300); await key('1');
    await key('Backspace'); await key('Backspace'); await key('Backspace'); await key('Backspace');
    await key('5'); await key('Enter');
    const v = await js(`T.nodes()[0].getAttribute('value')`);
    await key('Escape'); await js(`T.pb.shadowRoot.querySelector('.layer').focus()`);
    await key('z', CTRL); const u = await js(`T.nodes()[0]?.getAttribute('value')`);
    await key('y', CTRL); const r = await js(`T.nodes()[0]?.getAttribute('value')`);
    return [v === '5' && u === null && r === '5', [v, u, r]];
  });
  await run('typing in node input never deletes node', async () => {
    const r = await js(`T.nodes().length`);
    return [r === 1, r];
  });
  await run('undo keeps last 50 steps', async () => {
    await js(`(() => { for (let i = 0; i < 60; i++) T.pb.spawn('gate', 10 * i, 600); })()`);
    for (let i = 0; i < 55; i++) await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: CTRL });
    await frames();
    const r = await js(`T.nodes().filter(n => n.dataset.type === 'gate').length`);
    return [r === 10, r];
  });

  // escape, menu, chain

  await fresh();
  await js(`(() => { T.node('accumulator', 200, 200); T.node('accumulator', 500, 200); })()`);
  await frames();
  await run('escape mid-drag puts unit back', async () => {
    await press(216, 216, CTRL); await moveTo(216, 216, 316, 316, CTRL);
    await key('Escape'); await mouse('mouseReleased', 316, 316, CTRL); await frames();
    const r = await js(`T.nodes()[0].style.left + ',' + T.nodes()[0].style.top`);
    return [r === '200px,200px', r];
  });
  await run('right click on canvas lists modes, nodes with keys and three saves', async () => {
    await click(900, 600, 0, 'right');
    const r = await js(`[...T.pb.shadowRoot.querySelectorAll('.menu button')].map(b => b.textContent)`);
    await key('Escape'); const closed = await js(`!T.pb.shadowRoot.querySelector('.menu')`);
    return [r[0] === '[mode] - use' && r.includes('[node] - clock1') && r.includes('[node] - quest0') && r.slice(-3).join() === '[save] - quine,[save] - view,[save] - publish' && closed, { r, closed }];
  });
  await run('space chains last spawned into clicked node', async () => {
    await hover(700, 500); await key('2');
    await key(' '); await click(216, 216);
    const r = await js(`[T.nodes().at(-1).getAttribute('data-scv-emits'), T.nodes()[0].getAttribute('data-scv-receives'), T.nodes()[0].getAttribute('value')]`);
    return [r[0] && r[0] === r[1] && r[2] === null, r];
  });
  await run('ctrl+digit while chained spawns reversed wire', async () => {
    await key(' '); await hover(700, 650); await key('3', CTRL);
    const r = await js(`(() => { const v = T.nodes().at(-1), prev = T.nodes().at(-2); return [v.dataset.type, v.getAttribute('data-scv-emits') && v.getAttribute('data-scv-emits') === prev.getAttribute('data-scv-receives')?.split(' ').at(-1)]; })()`);
    return [r[0] === 'variable' && r[1] === true, r];
  });
  await run('ctrl+0 prevented only while chained', async () => {
    const r = await js(`(() => { const l = T.pb.shadowRoot.querySelector('.layer'), k = () => { const e = new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, composed: true, cancelable: true }); l.dispatchEvent(e); return e.defaultPrevented; }; const free = k(); T.pb.spawn('gate', 50, 50); l.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true, cancelable: true })); return [free, k()]; })()`);
    return [r[0] === false && r[1] === true, r];
  });

  await fresh();
  await run('? toggles intro, escape closes it', async () => {
    await key('?', SHIFT); const on = await js(`T.shadow('.intro').classList.contains('open')`);
    await key('Escape'); const off = await js(`T.shadow('.intro').classList.contains('open')`);
    return [on === true && off === false, [on, off]];
  });

  // focus

  await fresh();
  await run('keys reach focused patchbay only', async () => {
    await js(`(() => { const p = document.createElement('scv-patchbay'); p.id = 'second'; document.body.append(p); T.pb.shadowRoot.querySelector('.layer').focus(); })()`);
    await hover(300, 300); await key('2');
    const r = await js(`[T.pb.querySelectorAll('scv-logic').length, document.getElementById('second').querySelectorAll('scv-logic').length]`);
    return [r.join() === '1,0', r];
  });

  // background

  await fresh();
  await run('background picker sets saved background, undoable', async () => {
    const at = await js(`(() => { const r = T.shadow('.bg button').getBoundingClientRect(); return [r.x + 8, r.y + 8]; })()`);
    await click(at[0], at[1]);
    await js(`T.shadow('.bg input').value = '#203040'`);
    await key('Enter');
    const set = await js(`T.pb.style.getPropertyValue('--background-sunk')`);
    await js(`T.pb.shadowRoot.querySelector('.layer').focus()`); await key('z', CTRL);
    const u = await js(`T.pb.style.getPropertyValue('--background-sunk')`);
    return [set === '#203040' && u === '', [set, u]];
  });

  // off-screen

  await fresh();
  await run('far item skipped, restored before it reaches screen', async () => {
    await js(`T.item('<p data-scv-id="far" style="width:100px;height:50px;margin:0">far</p>', 3000, 100)`); await frames(); await frames();
    const far = await js(`T.pb.querySelector('scv-item').states.has('far')`);
    await js(`T.pb.setView(-1300, 0)`); await frames(); await frames(); // still off screen, inside margin
    const near = await js(`[T.pb.querySelector('scv-item').states.has('far'), T.pb.querySelector('scv-item').getBoundingClientRect().left > innerWidth]`);
    return [far === true && near[0] === false && near[1] === true, { far, near }];
  });

  // save

  await run('save carries no studio chrome', async () => {
    await js(`(() => { const a = T.node('accumulator', 100, 100), b = T.node('accumulator', 300, 100); T.pb.wire(a, b); T.pb.select([a]); })()`); await frames();
    const r = await js(`(async () => { const t = await (await T.pb.save('quine')).text(); const body = t.slice(t.indexOf('<scv-patchbay'), t.indexOf('</scv-patchbay>')); return [/class="(cable|box|corner|lasso|tip|menu)/.test(body), /selected|dimmed|wired/.test(body)]; })()`);
    return [r.join() === 'false,false', r];
  });

  // import - paste, drop, duplicate share one path

  await fresh();
  const copied = await js(`(async () => {
    const t = document.createElement('template'); t.setAttribute('data-scv-comp', 'meter'); t.innerHTML = '<b data-scv-slot="n">0</b><script>host.ok = 1;<\\/script>'; T.kit.defineComponent(t);
    T.kit.runNodeSource("defineNode({ name: 'twice', icon: '2', onReceive(v, ctx) { ctx.emit(v * 2); } })");
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const ref = await T.kit.asset.put(new Blob([png], { type: 'image/png' }));
    const m = T.item('<scv-meter data-scv-id="m"></scv-meter>', 100, 100), i1 = T.item('<img data-scv-id="a" data-scv-src="' + ref + '">', 200, 100), i2 = T.item('<img data-scv-id="b" data-scv-src="' + ref + '">', 250, 100);
    const n = T.node('twice', 300, 300), out = T.node('accumulator', 500, 300), far = T.node('accumulator', 700, 300);
    await T.frame(); m.firstElementChild.shadowRoot.querySelector('b').textContent = '7';
    T.pb.wire(m.firstElementChild, n); T.pb.wire(n, out); far.setAttribute('data-scv-receives', 'btc'); n.setAttribute('data-scv-emits', n.getAttribute('data-scv-emits') + ' btc');
    T.pb.select([m, i1, i2, n, out]);
    return (await T.pb.copy()).text();
  })()`);
  await run('copy is mini save: items, defs and each asset once', async () => {
    const c = copied;
    return [c.includes('<scv-patchbay>') && c.includes('data-scv-comp="meter"') && c.includes("name: 'twice'") && (c.match(/type="scv\/asset"/g) || []).length === 1 && c.includes('shadowrootmode') && !c.includes('blob:'), c.length];
  });
  await fresh();
  await js(`(() => { const a = T.node('accumulator', 50, 50); a.setAttribute('data-scv-receives', 'clash'); })()`);
  await run('paste in another window brings defs, slot data and assets', async () => {
    const r = await js(`(async () => { T.pb.import(${JSON.stringify(copied)}, { at: { x: 600, y: 400 } }); await T.frame(); await T.frame();
      const m = T.pb.querySelector('scv-meter'), img = T.pb.querySelector('img');
      return [m?.shadowRoot?.querySelector('b')?.textContent, m?.ok, T.pb.querySelector('scv-logic[data-type=twice]')?.shadowRoot.querySelector('.dot').textContent, img?.src.slice(0, 5)]; })()`);
    return [r.join() === '7,1,2,blob:', r];
  });
  await run('pasted wires keep their pairs, one-ended named channel kept', async () => {
    const r = await js(`(() => { const m = T.pb.querySelector('scv-meter'), n = T.pb.querySelector('scv-logic[data-type=twice]'), out = T.nodes().at(-1);
      return [m.getAttribute('data-scv-emits') === n.getAttribute('data-scv-receives'), 0, n.getAttribute('data-scv-emits').split(' ').includes('btc'), n.getAttribute('data-scv-emits').split(' ')[0] === out.getAttribute('data-scv-receives')]; })()`);
    return [r[0] === true && r[2] === true && r[3] === true, r];
  });
  await run('paste lands centred on pointer, selected, one undo step', async () => {
    const r = await js(`[T.pb.selection().length, (() => { const us = T.pb.selection(); return [us.reduce((s, u) => s + parseFloat(u.style.left), 0) / us.length, us.reduce((s, u) => s + parseFloat(u.style.top), 0) / us.length].map(Math.round); })()]`);
    await key('z', CTRL); const after = await js(`T.pb.querySelectorAll('scv-item, scv-logic').length`);
    await key('y', CTRL);
    return [r[0] === 5 && r[1].join() === '600,400' && after === 1, { r, after }];
  });
  await run('colliding channel re-minted on paste', async () => {
    const r = await js(`(() => { T.pb.import('<scv-patchbay><scv-logic data-type="gate" data-scv-emits="clash" style="left:0px;top:0px"></scv-logic></scv-patchbay>', { at: { x: 50, y: 600 } }); return T.nodes().at(-1).getAttribute('data-scv-emits'); })()`);
    return [r && r !== 'clash', r];
  });
  await run('pasted harvest runs no pasted code, saves executable def', async () => {
    const r = await js(`(async () => {
      const def = "window.__ran = 1;\\nif(!customElements.get('scv-hx1')){\\ncustomElements.define('scv-hx1', class extends HTMLElement {\\nconstructor() {\\nsuper();\\nif (this.shadowRoot) return;\\nthis.attachShadow({mode: 'open'}).innerHTML = \\\`<p onclick=\\"window.__ran=2\\">harvested</p><script>window.__ran=3<\\\\/script>\\\`;\\n}\\n});\\n}";
      T.pb.import('<scv-hx1 data-scv-component></scv-hx1><script data-scv-def>' + def + '<\\/script>', { at: { x: 100, y: 600 } }); await T.frame();
      const el = T.pb.querySelector('scv-hx1'); el.shadowRoot.querySelector('p')?.click();
      const saved = await (await T.pb.save('publish')).text();
      return [window.__ran ?? null, el.shadowRoot.textContent, /<script data-scv-def>[\\s\\S]*scv-hx1/.test(saved)];
    })()`);
    return [r[0] === null && r[1] === 'harvested' && r[2] === true, r];
  });
  await run('duplicate leaves other instances of its type running', async () => {
    const r = await js(`(async () => {
      window.__runs = 0; window.__inits = 0;
      const t = document.createElement('template'); t.setAttribute('data-scv-comp', 'live1'); t.innerHTML = '<b>x</b><script>window.__runs++;<\\/script>'; T.kit.defineComponent(t);
      T.kit.runNodeSource("defineNode({ name: 'live2', init() { window.__inits++; } })");
      const a = T.item('<scv-live1 data-scv-id="la"></scv-live1>', 100, 700), b = T.item('<scv-live1 data-scv-id="lb"></scv-live1>', 200, 700), n1 = T.node('live2', 300, 700), n2 = T.node('live2', 400, 700);
      await T.frame(); const bInner = b.firstElementChild.shadowRoot.firstElementChild, runs = window.__runs, inits = window.__inits;
      T.pb.select([a, n1]); await T.pb.duplicate(); await T.frame();
      return [window.__runs - runs, window.__inits - inits, b.firstElementChild.shadowRoot.firstElementChild === bInner];
    })()`);
    return [r.join() === '1,1,true', r];
  });
  await run('pasted markup drops srcdoc, disguised javascript urls and meta refresh', async () => {
    const r = await js(`(async () => {
      T.pb.import('<scv-patchbay><scv-item style="left:0px;top:0px"><div data-scv-id="d"><iframe srcdoc="<script>parent.__ran = 4<\\/script>"></iframe><a href="jav&#x09;ascript:parent.__ran = 5">x</a><meta http-equiv="refresh" content="0;url=#refreshed"></div></scv-item></scv-patchbay>', { at: { x: 900, y: 700 } });
      await new Promise(r => setTimeout(r, 300));
      const d = T.pb.selection()[0].firstElementChild;
      return [d.querySelector('iframe').hasAttribute('srcdoc'), d.querySelector('a').hasAttribute('href'), !!d.querySelector('meta'), location.hash, window.__ran ?? null];
    })()`);
    return [r.join() === 'false,false,false,,', r];
  });
  await run('unrecognized harvest places nothing, says so', async () => {
    const r = await js(`(() => { const n = T.pb.children.length, out = T.pb.import('<scv-odd data-scv-component></scv-odd><script data-scv-def>customElements.define("scv-odd", class extends HTMLElement {})<\\/script>'); return [out.length, T.pb.children.length === n, T.shadow('.tip').textContent]; })()`);
    return [r[0] === 0 && r[1] && r[2] === 'harvest not recognized', r];
  });
  await run('pasted @media harvest becomes container of its own queries', async () => {
    const r = await js(`(async () => {
      const def = "if(!customElements.get('scv-box1')){\\ncustomElements.define('scv-box1', class extends HTMLElement {\\nconstructor() {\\nsuper();\\nif (this.shadowRoot) return;\\nthis.attachShadow({mode: 'open'}).innerHTML = \\\`<style>p{width:150px} @media (max-width: 100px) { p { color: red } }</style><p>box</p>\\\`;\\n}\\n});\\n}";
      T.pb.import('<scv-box1 data-scv-component></scv-box1><script data-scv-def>' + def + '<\\/script>', { at: { x: 800, y: 100 } }); await T.frame(); await T.frame();
      const h = T.pb.querySelector('scv-box1'); return [h.style.containerType, h.style.width, h.shadowRoot.querySelector('style').textContent.includes('@container')];
    })()`);
    return [r.join() === 'inline-size,150px,true', r];
  });
  await run('1.x file refused with note', async () => {
    const r = await js(`(() => { const n = T.pb.children.length, out = T.pb.import('<html data-scv-runtime="1.0.0"><body><div class="comp-wrapper"></div></body></html>'); return [out.length, T.pb.children.length === n, T.shadow('.tip').textContent]; })()`);
    return [r[0] === 0 && r[1] && r[2] === '1.x file, open it directly', r];
  });
  await run('ctrl+d duplicates selection one cell off, wires fresh', async () => {
    await js(`(() => { const [n, out] = [T.pb.querySelector('scv-logic[data-type=twice]'), T.nodes().find(x => x.dataset.type === 'accumulator' && x.getAttribute('data-scv-receives') !== 'clash')]; T.pb.select([n, out]); T.pb.shadowRoot.querySelector('.layer').focus(); })()`);
    const before = await js(`[T.nodes().length, T.pb.querySelector('scv-logic[data-type=twice]').style.left]`);
    await key('d', CTRL); await js('new Promise(r => setTimeout(r, 100))');
    const r = await js(`(() => { const all = T.nodes(), [n2, o2] = all.slice(-2), n = T.pb.querySelector('scv-logic[data-type=twice]'); return [all.length, n2.style.left, n2.getAttribute('data-scv-emits').split(' ')[0] === o2.getAttribute('data-scv-receives'), n2.getAttribute('data-scv-emits').split(' ')[0] !== n.getAttribute('data-scv-emits').split(' ')[0]]; })()`);
    return [r[0] === before[0] + 2 && parseFloat(r[1]) === parseFloat(before[1]) + 24 && r[2] && r[3], { before, r }];
  });
  await run('pasted image goes through asset table', async () => {
    const r = await js(`(async () => { const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([png, new Uint8Array([1])], 'a.png', { type: 'image/png' }));
      T.pb.shadowRoot.querySelector('.layer').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, composed: true, cancelable: true })); await new Promise(r => setTimeout(r, 100));
      const img = T.pb.selection()[0]?.querySelector('img'); return [img?.dataset.scvSrc?.startsWith('scv-asset:'), img?.src.slice(0, 5)]; })()`);
    return [r.join() === 'true,blob:', r];
  });
  await run('pasted link becomes card, quest server fills it', async () => {
    const r = await js(`(async () => { T.pb.questApi = '${qsBase}'; const dt = new DataTransfer(); dt.setData('text/plain', 'https://example.com/docs/intro.');
      T.pb.shadowRoot.querySelector('.layer').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, composed: true, cancelable: true })); await new Promise(r => setTimeout(r, 300));
      const c = T.pb.querySelector('.scv-link-card'); return [c?.querySelector('.scv-lc-title').textContent, c?.querySelector('.scv-lc-open').getAttribute('href'), c?.hasAttribute('data-scv-lc')]; })()`);
    return [r[0] === 'Example Page' && r[1] === 'https://example.com/docs/intro' && r[2] === true && unfurls.length === 1, { r, unfurls }];
  });
  await run('paste into a typed field stays text', async () => {
    const r = await js(`(() => { const n = T.pb.spawn('clock', 900, 100), i = n.shadowRoot.querySelector('.input'), before = T.pb.children.length; const dt = new DataTransfer(); dt.setData('text/plain', 'https://example.com');
      const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, composed: true, cancelable: true }); i.dispatchEvent(e); return [e.defaultPrevented, T.pb.children.length === before]; })()`);
    return [r.join() === 'false,true', r];
  });

  await fresh();
  await run('dropped component file defines type and places first instance', async () => {
    const r = await js(`(async () => { const f = new File(['<template data-scv-comp="dropped"><i>hi</i></template>'], 'dropped.html', { type: 'text/html' }); const dt = new DataTransfer(); dt.items.add(f);
      T.pb.shadowRoot.querySelector('.layer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 300, clientY: 300, bubbles: true, composed: true, cancelable: true })); await new Promise(r => setTimeout(r, 100));
      const el = T.pb.querySelector('scv-dropped'); return [!!el, el?.shadowRoot?.textContent, el?.parentElement.style.left]; })()`);
    return [r[0] === true && r[1] === 'hi' && r[2] === '300px', r];
  });
  await run('dropped node file defines type and spawns it', async () => {
    const r = await js(`(async () => { const f = new File(["<script data-scv-node>defineNode({ name: 'dropnode', icon: 'D' })<\\/script>"], 'n.html', { type: 'text/html' }); const dt = new DataTransfer(); dt.items.add(f);
      T.pb.shadowRoot.querySelector('.layer').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: 500, clientY: 300, bubbles: true, composed: true, cancelable: true })); await new Promise(r => setTimeout(r, 100));
      const n = T.pb.querySelector('scv-logic[data-type=dropnode]'); return [!!n, n?.shadowRoot.querySelector('.dot').textContent]; })()`);
    return [r.join() === 'true,D', r];
  });

  await run('followed file: save rebuilds instances keeping data, places none, stops when file is gone', async () => {
    const r = await js(`(async () => {
      let text = '<template data-scv-comp="lf"><b data-scv-slot="n">0</b><i>v1</i></template>', at = 1, gone = false, reads = 0;
      const handle = { getFile: async () => { reads++; if (gone) throw new DOMException('gone', 'NotFoundError'); return new File([text], 'lf.html', { lastModified: at }); }, isSameEntry: async o => o === handle };
      T.pb.import(text, { at: { x: 100, y: 700 } }); await T.pb.follow(handle, text);
      const host = T.pb.querySelector('scv-lf'); host.shadowRoot.querySelector('b').textContent = '5';
      await new Promise(r => setTimeout(r, 1200)); const idle = T.pb.querySelectorAll('scv-lf').length;
      text = text.replace('v1', 'v2'); at = 2; await new Promise(r => setTimeout(r, 1300));
      const after = [host.shadowRoot.querySelector('i').textContent, host.shadowRoot.querySelector('b').textContent, T.pb.querySelectorAll('scv-lf').length];
      host.parentElement.remove(); text = text.replace('v2', 'v3'); at = 3; await new Promise(r => setTimeout(r, 1300)); const deleted = T.pb.querySelectorAll('scv-lf').length;
      gone = true; await new Promise(r => setTimeout(r, 1200)); const n = reads; await new Promise(r => setTimeout(r, 1200));
      return [idle, ...after, deleted, reads === n];
    })()`);
    return [r.join() === '1,v2,5,1,0,true', r];
  });

  // shortcuts, chrome and canvas details

  await fresh();
  await run('ctrl+shift+z and caps-lock shortcuts still work', async () => {
    await js(`(() => { T.pb.export = kind => { window.__exported = (window.__exported || []).concat(kind); }; T.pb.spawn('gate', 100, 100); })()`);
    await key('z', CTRL); const undone = await js(`T.nodes().length`);
    await key('Z', CTRL | SHIFT); const redone = await js(`T.nodes().length`);
    await key('z', CTRL); await key('Y', CTRL); const capsY = await js(`T.nodes().length`);
    await key('S', CTRL); await key('P', CTRL);
    return [undone === 0 && redone === 1 && capsY === 1 && (await js(`window.__exported?.join()`)) === 'quine,publish', { undone, redone, capsY }];
  });
  await run('ctrl+a selects nothing in use mode', async () => {
    await key('Tab'); await key('a', CTRL); const use = await js(`T.pb.selection().length`);
    await key('Tab'); await key('a', CTRL); const edit = await js(`T.pb.selection().length`);
    return [use === 0 && edit === 1, [use, edit]];
  });
  await run('only http links become cards, and their text stays text', async () => {
    const r = await js(`(async () => { const layer = T.pb.shadowRoot.querySelector('.layer'), paste = t => { const dt = new DataTransfer(); dt.setData('text/plain', t); layer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, composed: true, cancelable: true })); };
      const before = T.pb.querySelectorAll('.scv-link-card').length;
      ['just words', 'javascript:alert(1)', 'data:text/html,<b>x</b>'].forEach(paste);
      const none = T.pb.querySelectorAll('.scv-link-card').length === before;
      paste('https://ex.com/a"onmouseover="x/<b>y</b>'); await T.frame();
      const c = [...T.pb.querySelectorAll('.scv-link-card')].at(-1);
      return [none, !!c && !c.querySelector('[onmouseover], b') && c.querySelector('.scv-lc-open').getAttribute('href').includes('"onmouseover')]; })()`);
    return [r.join() === 'true,true', r];
  });
  await run('handler inside pasted declarative shadow never runs', async () => {
    const r = await js(`(async () => { T.comp('sh2', '<i>x</i>');
      T.pb.import('<scv-patchbay><scv-item style="left:0px;top:0px"><scv-sh2 data-scv-id="s"><template shadowrootmode="open"><img src="data:," onerror="window.__ran = 1"><i>x</i></template></scv-sh2></scv-item></scv-patchbay>', { at: { x: 500, y: 500 } });
      await new Promise(r => setTimeout(r, 200)); return [window.__ran ?? null, !!T.pb.querySelector('scv-sh2').shadowRoot.querySelector('img')]; })()`);
    return [r.join() === ',true', r];
  });
  await fresh();
  await run('intro lists all ten keyed nodes', async () => {
    const r = await js(`[...T.shadow('.intro .nodes').querySelectorAll('dt')].map(d => d.textContent).join('')`);
    return [r === '1234567890', r];
  });
  await run('bad hex flagged and ignored, light background turns grid dots dark', async () => {
    const at = await js(`(() => { const r = T.shadow('.bg button').getBoundingClientRect(); return [r.x + 8, r.y + 8]; })()`);
    await click(at[0], at[1]); await js(`T.shadow('.bg input').value = 'zzz'`); await key('Enter');
    const bad = await js(`[T.shadow('.bg input').classList.contains('bad'), T.pb.style.getPropertyValue('--background-sunk')]`);
    await js(`T.shadow('.bg input').value = '#f0f0f0'`); await key('Enter');
    const grid = await js(`T.pb.style.getPropertyValue('--background-grid')`);
    return [bad[0] === true && bad[1] === '' && grid.startsWith('rgba(0,0,0'), { bad, grid }];
  });
  await run('grid cell 24px at zoom 1, dots and cells scale with zoom, zoom clamps at 5', async () => {
    const r = await js(`(() => { const g = T.shadow('.grid'), read = () => [g.style.getPropertyValue('--cell'), g.style.getPropertyValue('--dot')]; const one = read(); T.pb.setView(0, 0, 2); const two = read(); T.pb.setZoom(50, 0, 0); const z = T.pb.zoom; T.pb.setView(0, 0, 1); return [one, two, z]; })()`);
    return [r[0].join() === '24px,1px' && r[1].join() === '48px,2px' && r[2] === 5, r];
  });
  await run('spawn, wire, paste, delete and undo cycles leak no listeners or nodes', async () => {
    const cycle = `(async () => { for (let i = 0; i < 12; i++) { const a = T.pb.spawn('accumulator', 100, 100), b = T.pb.spawn('accumulator', 300, 100); T.pb.wire(a, b); T.pb.select([a, b]); await T.pb.duplicate(); await T.frame(); T.pb.select([...T.pb.querySelectorAll('scv-logic')]); T.pb.removeSelection(); T.pb.undo(); T.pb.select([...T.pb.querySelectorAll('scv-logic')]); T.pb.removeSelection(); await T.frame(); } return 1; })()`;
    const counters = async () => { await send('HeapProfiler.enable'); await send('HeapProfiler.collectGarbage'); await js('new Promise(r => setTimeout(r, 100))'); return (await send('Memory.getDOMCounters')).result; };
    await js(cycle); const before = await counters();
    await js(cycle); const after = await counters();
    return [after.jsEventListeners <= before.jsEventListeners && after.nodes <= before.nodes * 1.05, { before, after }];
  });

  // real clipboard - copy and paste editing commands

  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await run('real copy and paste round-trip through system clipboard', async () => {
    await js(`(() => { T.pb.select([T.node('comparator', 500, 300)]); T.pb.shadowRoot.querySelector('.layer').focus(); })()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: CTRL, commands: ['copy'] });
    await js('new Promise(r => setTimeout(r, 300))');
    await hover(700, 500);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: CTRL, commands: ['paste'] });
    await js('new Promise(r => setTimeout(r, 300))');
    const r = await js(`[...T.pb.querySelectorAll('scv-logic[data-type=comparator]')].map(n => n.style.left)`);
    return [r.length === 2 && r[1] === '700px', r];
  });

  ok(uncaught.length === 0, `no uncaught errors (${uncaught})`);
} catch (e) {
  fails++; console.log('  ✗ next studio tier threw:', e.message);
} finally { try { ws.close(); } catch {} cleanup(); qs.close(); }

console.log(fails ? `✗ next-studio: ${fails} failure(s)` : '✓ next-studio');
process.exit(fails ? 1 : 0);
