// random tier - random edit sequences, fresh seed each run, invariants checked after every step
// node test/random.mjs [--seed=n] [--rounds=n] [--ops=n]

import { launchChrome, connect } from './_cdp.mjs';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const arg = (k, d) => { const m = process.argv.find(a => a.startsWith(`--${k}=`)); return m ? +m.split('=')[1] : d; };
const SEED = arg('seed', Date.now() % 1e9), ROUNDS = arg('rounds', 4), OPS = arg('ops', 36); // ops stay under 50-step undo cap
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } return c; };
const here = dirname(fileURLToPath(import.meta.url));

const rng = (s => () => { s |= 0; s = s + 0x6d2b79f5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; })(SEED); // mulberry32
const int = n => Math.floor(rng() * n);
const pick = list => list[int(list.length)];

const saved = new Map();
const srv = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/pb') return res.end(readFileSync(join(here, '..', 'patchbay.html')));
  const m = req.url.match(/^\/saved\/(\w+)/);
  res.end(m ? saved.get(m[1]) || '' : '');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
const errors = [];
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
});
await send('Page.enable'); await send('Runtime.enable');
const js = async e => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r?.result?.result?.value;
};
const nav = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await js(`(${helpers})()`); };
const done = () => { try { ws.close(); } catch {} cleanup(); srv.close(); };

// fixtures - harvest in kernel shape, authored component, plain html
const harvest = tag => `<${tag} data-scv-component></${tag}>\n<script data-scv-def>\nif(!customElements.get('${tag}')){\ncustomElements.define('${tag}', class extends HTMLElement {\nconstructor() {\nsuper();\nif (this.shadowRoot) return;\nthis.attachShadow({mode: 'open'}).innerHTML = \`<style>.h{padding:6px;background:#334}</style><div class="h"><button class="b">go</button><span class="v">0</span></div>\`;\n}\n});\n}\n<\/script>`;
const FIXTURES = [
  harvest('scv-rzh1'), harvest('scv-rzh2'),
  '<template data-scv-comp="rzc"><style>p{margin:0}</style><p><button>+</button> <b>0</b></p><script>const b = root.querySelector("b"); root.querySelector("button").addEventListener("click", () => { b.textContent = +b.textContent + 1; emit(+b.textContent, b); }, { signal });<\/script></template>',
  '<div style="padding:4px;background:#222;color:#ccc">plain <span>text</span></div>',
];
const TYPES = ['accumulator', 'variable', 'gate', 'comparator', 'mutator', 'sample', 'action']; // clock, delay, quest act on their own - routing would move state undo can't see
const VALUES = ['3', '-2', 'x', 'v + 1', 'v * 2', 'v > 2 ? v : undefined', 'pulse', 'toggle', 'increment', ''];

const helpers = () => {
  const pb = window.pb = document.querySelector('scv-patchbay'), kit = window.kit = customElements.get('scv-patchbay').kit;
  const deep = root => { const out = []; const rec = r => r.querySelectorAll('*').forEach(e => { out.push(e); if (e.shadowRoot && e.localName !== 'scv-logic') rec(e.shadowRoot); }); rec(root); return out; };
  const units = () => [...pb.children].filter(c => c.localName === 'scv-item' || c.localName === 'scv-logic');
  const ends = () => deep(pb).filter(e => (e.localName === 'scv-logic' || e.localName === 'scv-item' || e.getRootNode() !== document) && !/^(style|script|template|link)$/.test(e.localName)); // what a pointer can land on
  const key = (k, o = {}) => pb.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true, ...o }));
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.F = {
    frame, units, key,
    snap() { // light dom plus wiring inside shadows - everything state lives in
      const inner = deep(pb).filter(e => e.getRootNode() !== document && e.matches(kit.WIRING_SEL)).map(e => e.localName + [...e.attributes].map(a => ` ${a.name}=${a.value}`).join(''));
      return pb.getHTML() + '\n' + inner.join('\n');
    },
    cables() { // drawn cables against wiring attributes - every pair once, no extra
      const want = new Set(), rc = new Map();
      deep(pb).forEach(e => { const r = new Set(); kit.collectChannels(e, new Set(), r); r.forEach(c => { if (!rc.has(c)) rc.set(c, []); rc.get(c).push(e); }); });
      const ids = new Map(); let n = 0; const id = e => ids.get(e) ?? (ids.set(e, ++n), n);
      deep(pb).forEach(src => kit.splitWords(src.getAttribute('data-scv-emits')).forEach(c => (rc.get(c) || []).forEach(t => { if (t !== src) want.add(c + ' ' + id(src) + ' ' + id(t)); })));
      const got = pb.cables().map(c => c.ch + ' ' + id(c.src) + ' ' + id(c.tgt));
      const missing = [...want].filter(k => !got.includes(k)), extra = got.filter(k => !want.has(k));
      return missing.length || extra.length || got.length !== new Set(got).size ? { want: want.size, got: got.length, missing: missing.slice(0, 3), extra: extra.slice(0, 3) } : null;
    },
    async op(kind, a, b, c) { // a, b, c are random draws - page maps them onto what exists
      const us = units(), u = us.length ? us[a % us.length] : null, nodes = us.filter(x => x.localName === 'scv-logic'), n = nodes.length ? nodes[a % nodes.length] : null;
      switch (kind) {
        case 'spawn': pb.spawn(window.TYPES[a % window.TYPES.length], 40 + b % 900, 40 + c % 600); return 'spawn ' + window.TYPES[a % window.TYPES.length];
        case 'import': pb.import(window.FIXTURES[a % window.FIXTURES.length], { at: { x: 40 + b % 900, y: 40 + c % 600 } }); return 'import ' + a % window.FIXTURES.length;
        case 'wire': { const es = ends(); if (es.length < 2) return 'wire -'; const s = es[a % es.length], t = es[b % es.length]; pb.wire(s, t); return `wire ${s.localName} > ${t.localName}`; }
        case 'delete': if (!u) return 'delete -'; pb.select([u]); key('Delete'); return 'delete ' + u.localName;
        case 'duplicate': if (!u) return 'duplicate -'; pb.select([u]); pb.duplicate(); return 'duplicate ' + u.localName;
        case 'copypaste': { if (!u) return 'copypaste -'; pb.select([u]); const t = await (await pb.copy()).text(); pb.import(t, { at: { x: 40 + b % 900, y: 40 + c % 600 } }); return 'copypaste ' + u.localName; }
        case 'nudge': if (!u) return 'nudge -'; pb.select([u]); key(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'][b % 4], { shiftKey: !!(c % 2) }); return 'nudge';
        case 'zorder': if (!u) return 'zorder -'; pb.select([u]); key(b % 2 ? ']' : '['); return 'zorder';
        case 'commit': { if (!n) return 'commit -'; const inp = n.shadowRoot.querySelector('.input'); n.expand(true); inp.value = window.VALUES[b % window.VALUES.length]; inp.dispatchEvent(new Event('change')); n.expand(false); return `commit ${n.dataset.type} ${JSON.stringify(inp.value)}`; }
        case 'mode': { if (!n) return 'mode -'; const r = n.getBoundingClientRect(); n.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 8 })); return 'mode ' + n.dataset.type; }
        case 'undo': pb.undo(); return 'undo';
        case 'redo': pb.redo(); return 'redo';
      }
    },
    channels() { const s = new Set(); deep(pb).forEach(e => kit.collectChannels(e, s, s)); return [...s]; },
  };
  return true;
};

const OPS_W = [['spawn', 4], ['import', 3], ['wire', 6], ['delete', 2], ['duplicate', 1], ['copypaste', 1], ['nudge', 2], ['zorder', 1], ['commit', 3], ['mode', 2], ['undo', 2], ['redo', 1]];
const total = OPS_W.reduce((s, [, w]) => s + w, 0);
const drawOp = () => { let r = rng() * total; for (const [k, w] of OPS_W) if ((r -= w) < 0) return k; return 'wire'; };
const STORM = ['1', 2, -3, 'x', '', true, { a: 1 }, 'pulse'];
const first = (a, b) => { if (a === b) return ''; const i = [...a].findIndex((ch, k) => ch !== b[k]); return JSON.stringify({ was: a.slice(Math.max(0, i - 80), i + 80), now: b.slice(Math.max(0, i - 80), i + 80) }); };

const saveReopenSave = async name => { // file opened from its own save writes itself back unchanged
  saved.set(name, await js(`pb.save('quine').then(b => b.text())`));
  await nav(`${base}/saved/${name}`);
  await js(`pb.setMode('edit'), F.frame()`);
  const again = await js(`pb.save('quine').then(b => b.text())`);
  const a = saved.get(name), i = [...a].findIndex((ch, k) => ch !== again[k]);
  return a === again ? null : { at: i, was: a.slice(Math.max(0, i - 60), i + 60), now: again.slice(Math.max(0, i - 60), i + 60) };
};

console.log(`random: seed ${SEED}, ${ROUNDS} rounds x ${OPS} ops`);
try {
  for (let round = 0; round < ROUNDS && fails < 3; round++) {
    await nav(`${base}/pb`);
    await js(`window.TYPES = ${JSON.stringify(TYPES)}; window.FIXTURES = ${JSON.stringify(FIXTURES)}; window.VALUES = ${JSON.stringify(VALUES)}; pb.setMode('edit'), F.frame()`);
    errors.length = 0;
    const start = await js(`F.snap()`), log = [];
    for (let i = 0; i < OPS && fails < 3; i++) {
      const kind = drawOp();
      log.push(await js(`F.op(${JSON.stringify(kind)}, ${int(1e6)}, ${int(1e6)}, ${int(1e6)})`));
      await js(`F.frame()`);
      const bad = await js(`F.cables()`);
      const trail = `(seed ${SEED}, round ${round}, step ${i}: ${log.slice(-4).join(' | ')})`;
      ok(!bad, `cables match wiring attributes ${JSON.stringify(bad)} ${trail}`);
      ok(!errors.length, `edit throws nothing - ${errors.slice(0, 2).join(' | ')} ${trail}`);
      errors.length = 0;
    }
    const end = await js(`(async () => { for (let i = 0; i < 120; i++) pb.redo(); await F.frame(); return F.snap(); })()`); // run may end on undo - redo steps still ahead
    const undone = await js(`(async () => { for (let i = 0; i < 120; i++) pb.undo(); await F.frame(); return [F.snap(), F.cables()]; })()`);
    ok(undone[0] === start && !undone[1], `undoing everything returns starting patchbay ${first(start, undone[0])} ${JSON.stringify(undone[1])} (seed ${SEED}, round ${round}: ${log.join(' | ')})`);
    const redone = await js(`(async () => { for (let i = 0; i < 120; i++) pb.redo(); await F.frame(); return [F.snap(), F.cables()]; })()`);
    ok(redone[0] === end && !redone[1], `redoing everything returns finished patchbay ${first(end, redone[0])} ${JSON.stringify(redone[1])} (seed ${SEED}, round ${round}: ${log.join(' | ')})`);
    ok(!errors.length, `undo and redo throw nothing - ${errors.slice(0, 2).join(' | ')} (seed ${SEED}, round ${round})`);

    errors.length = 0;
    const diff = await saveReopenSave(`r${round}`);
    ok(!diff, `save, reopen, save writes same file ${JSON.stringify(diff)} (seed ${SEED}, round ${round})`);
    ok(!await js(`F.cables()`), `reopened file draws cables its wiring names (seed ${SEED}, round ${round})`);

    const chans = await js(`F.channels()`);
    errors.length = 0;
    await js(`pb.setMode('use')`);
    for (let i = 0; i < 120 && chans.length; i++) { const v = pick(STORM); await js(`pb.routeSend(${JSON.stringify(pick(chans))}, ${v === 'pulse' ? 'kit.pulse()' : JSON.stringify(v)})`); }
    await js(`F.frame()`);
    ok(!errors.length, `routing storm throws nothing - ${errors.slice(0, 2).join(' | ')} (seed ${SEED}, round ${round})`);
    const after = await saveReopenSave(`s${round}`);
    ok(!after, `after storm, save, reopen, save writes same file ${JSON.stringify(after)} (seed ${SEED}, round ${round})`);
  }
} catch (e) {
  fails++; console.log(`  ✗ random tier threw (seed ${SEED}):`, e.message);
}

done();
console.log(fails ? `random: FAIL (${fails}) - rerun with --seed=${SEED}` : 'random: PASS');
process.exit(fails ? 1 : 0);
