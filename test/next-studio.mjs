// next studio tier - real pointer and key events

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const here = dirname(fileURLToPath(import.meta.url));
const pbUrl = pathToFileURL(join(here, '..', 'patchbay-next.html')).href;

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
    const r = await js(`T.nodes()[1].states.has('expanded')`);
    return [r === true, r];
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
    return [near && reads === 0, { start, reads }];
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

  ok(uncaught.length === 0, `no uncaught errors (${uncaught})`);
} catch (e) {
  fails++; console.log('  ✗ next studio tier threw:', e.message);
} finally { try { ws.close(); } catch {} cleanup(); }

console.log(fails ? `✗ next-studio: ${fails} failure(s)` : '✓ next-studio');
process.exit(fails ? 1 : 0);
