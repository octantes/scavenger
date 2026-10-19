// behaviour tier - every kind of input against every kind of receiver and node, as one readable table
// node test/behaviour.mjs [--save] (--save rewrites test/behaviour.md after a reviewed change)

import { launchChrome, connect } from './_cdp.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const tablePath = join(here, 'behaviour.md');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
const errors = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: pathToFileURL(join(here, '..', 'patchbay.html')).href }); await waitEvent('Page.loadEventFired');
const js = async e => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r?.result?.result?.value;
};

// runs in page - each cell built fresh, channel per cell, so cells never see each other
const build = async () => {
  const pb = document.querySelector('scv-patchbay'), kit = customElements.get('scv-patchbay').kit;
  pb.setMode('use');
  const warn = console.warn; console.warn = () => {}; // error states are recorded in cells instead
  const tick = ms => new Promise(r => setTimeout(r, ms));
  const gone = async (...els) => { els.forEach(e => e.remove()); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }; // teardown runs a frame after removal
  let n = 0;
  const say = v => kit.isPulse(v) ? 'pulse' : v === undefined ? 'undefined' : typeof v === 'string' ? JSON.stringify(v) : v instanceof Element ? '<' + v.localName + '>' : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  const VALUES = [['"hi"', () => 'hi'], ['"007"', () => '007'], ['42', () => 42], ['0', () => 0], ['-1.5', () => -1.5], ['true', () => true], ['false', () => false],
    ['""', () => ''], ['{a:1}', () => ({ a: 1 })], ['[1,2]', () => [1, 2]], ['pulse', () => kit.pulse()], ['null', () => null], ['undefined', () => undefined]];
  const def = document.createElement('script'); def.setAttribute('data-scv-def', '');
  def.textContent = "if(!customElements.get('scv-bhost')){customElements.define('scv-bhost', class extends HTMLElement { constructor() { super(); if (this.shadowRoot) return; this.attachShadow({mode: 'open'}).innerHTML = '<p>x</p>'; } });}";
  document.body.append(def); eval(def.textContent);
  const sink = ch => { const d = document.createElement('div'); d.setAttribute('data-scv-receives', ch); d.log = []; d.addEventListener('scv-receive', e => d.log.push(e.detail)); pb.append(d); return d; };
  const shownOf = el => el.localName === 'input' ? (/^(checkbox|radio)$/.test(el.type) ? 'checked ' + el.checked : 'value ' + JSON.stringify(el.value))
    : el.localName === 'textarea' || el.localName === 'select' ? 'value ' + JSON.stringify(el.value) : el.innerHTML ? el.innerHTML : 'empty';
  const out = { delivery: { cols: VALUES.map(v => v[0]), rows: [] }, verbs: { cols: [], rows: [] }, nodes: [], pairs: [] };

  // delivery
  const RECEIVERS = [['div "old"', '<div>old</div>'], ['span "$<small>9</small>"', '<span>$<small>9</small></span>'], ['div holding button', '<div><button>b</button></div>'],
    ['div holding custom element', '<div><x-y></x-y></div>'], ['div holding wired element', '<div><i data-scv-receives="zz">w</i></div>'], ['text input', '<input value="old">'],
    ['number input', '<input type="number" value="1">'], ['checkbox', '<input type="checkbox">'], ['radio', '<input type="radio">'], ['textarea', '<textarea>old</textarea>'],
    ['select a, hi, 42', '<select><option>a</option><option>hi</option><option>42</option></select>'], ['img', '<img alt="">'], ['component host', '<scv-bhost></scv-bhost>']];
  for (const [label, html] of RECEIVERS) {
    const row = [label];
    for (const [, make] of VALUES) {
      const c = 'c' + ++n, t = document.createElement('template'); t.innerHTML = html;
      const el = t.content.firstElementChild; el.setAttribute('data-scv-receives', c); el.setAttribute('data-scv-emits', 'p' + n);
      let ev = 'no event'; el.addEventListener('scv-receive', e => { ev = say(e.detail); });
      pb.append(el); const s = sink('p' + n);
      const v = make(); pb.routeSend(c, v);
      const sent = say(v), pass = s.log.length ? s.log.map(say).join(', ') : 'nothing';
      row.push(shownOf(el) + (ev === sent ? '' : ' · event ' + ev) + (pass === sent ? '' : ' · passes ' + pass));
      el.remove(); s.remove();
    }
    out.delivery.rows.push(row);
  }

  // verbs - value "x" sent to target carrying the verb
  const TARGETS = [['div "5"', () => { const d = document.createElement('div'); d.textContent = '5'; return d; }], ['input "5"', () => { const i = document.createElement('input'); i.value = '5'; return i; }],
    ['gate node, closed', () => { const g = document.createElement('scv-logic'); g.dataset.type = 'gate'; return g; }], ['accumulator node "5"', () => { const a = document.createElement('scv-logic'); a.dataset.type = 'accumulator'; a.setAttribute('value', '5'); return a; }]];
  out.verbs.cols = TARGETS.map(t => t[0]);
  const stateOf = el => el.localName === 'scv-logic' ? [...el.attributes].filter(a => /^(value|open|last)$/.test(a.name)).map(a => a.name + (a.value ? '=' + a.value : '')).join(' ') || 'no state'
    : el.localName === 'input' ? 'value ' + JSON.stringify(el.value) : 'text ' + JSON.stringify(el.textContent);
  for (const verb of ['hide', 'show', 'toggle', 'increment', 'decrement', 'clone', 'delete', 'prop:textContent', 'prop:value', 'prop:style.color', 'method:focus', 'event:custom']) {
    const row = [verb];
    for (const [, make] of TARGETS) {
      const c = 'c' + ++n, el = make(); el.setAttribute('data-scv-receives', c); el.setAttribute('data-scv-action', verb);
      const holder = document.createElement('section'); holder.append(el); pb.append(holder);
      let custom = 0; el.addEventListener('custom', () => custom++);
      pb.routeSend(c, 'x'); await tick(1);
      const kids = holder.children.length, disp = el.style.display;
      row.push(kids === 0 ? 'removed' : stateOf(el) + (disp ? ' · display ' + disp : '') + (kids > 1 ? ' · cloned' : '') + (el.style.color ? ' · color ' + el.style.color : '') + (custom ? ' · event fired' : ''));
      holder.remove();
    }
    out.verbs.rows.push(row);
  }

  // nodes - one input into fresh node, per mode
  const into = v => n => pb.routeSend(n.getAttribute('data-scv-receives'), typeof v === 'function' ? v() : v); // through its wire, fresh object each send
  const INPUTS = [['pulse', n => pb.routeSend(n.getAttribute('data-scv-receives'), kit.pulse())], ['click', n => n.trigger()], ['3', into(3)], ['"3"', into('3')], ['-2', into(-2)],
    ['"x"', into('x')], ['""', into('')], ['true', into(true)], ['{a:1}', into(() => ({ a: 1 }))]];
  const SETUP = { clock: '100000000', variable: 'n', delay: '10' }; // clock never ticks inside table, delay answers inside wait
  const make = (type, mode) => {
    const node = document.createElement('scv-logic'); node.dataset.type = type;
    if (SETUP[type]) node.setAttribute('value', SETUP[type]);
    if (mode) node.setAttribute('mode', mode);
    const ch = 'o' + ++n; node.setAttribute('data-scv-emits', ch); node.setAttribute('data-scv-receives', 'i' + n); pb.append(node);
    return { node, s: sink(ch) };
  };
  const emitted = log => { // timer-driven repeats vary in count - shown once as repeating
    const said = log.map(say);
    return !said.length ? '—' : said.length > 2 && said.every(x => x === said[0]) ? said[0] + ' (repeating)' : said.join(', ');
  };
  const result = (node, s) => emitted(s.log) + ' · ' + stateOf(node) + (node.states.has('error') ? ' · error' : '') + (s.style.display ? ' · receiver display ' + s.style.display : '');
  const types = [...kit.NODE_TYPES.values()].filter(d => d.builtIn && d.name !== 'quest');
  for (const d of types) {
    const modes = d.modes?.length ? d.modes.map((m, i) => i ? m.id : null) : [null];
    const t = { name: d.name, cols: modes.map(m => m || (d.modes ? d.modes[0].id : 'default')), rows: [] };
    for (const [label, send] of INPUTS) {
      const row = [label];
      for (const mode of modes) {
        const { node, s } = make(d.name, mode);
        await tick(1); send(node); await tick(30);
        row.push(result(node, s)); await gone(node, s);
      }
      t.rows.push(row);
    }
    out.nodes.push(t);
  }

  // nodes with memory - second input after first, per mode
  for (const name of ['gate', 'comparator', 'sample']) {
    const d = kit.NODE_TYPES.get(name);
    for (const [i, m] of d.modes.entries()) {
      const t = { name: `${name} (${m.id}) - row first, column second`, cols: INPUTS.map(x => x[0]), rows: [] };
      for (const [label, first] of INPUTS) {
        const row = [label];
        for (const [, second] of INPUTS) {
          const { node, s } = make(name, i ? m.id : null);
          await tick(1); first(node); await tick(1); s.log.length = 0; second(node); await tick(5);
          row.push(result(node, s)); await gone(node, s);
        }
        t.rows.push(row);
      }
      out.pairs.push(t);
    }
  }
  console.warn = warn;
  return out;
};

const cell = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (head, cols, rows) => `| ${cell(head)} | ${cols.map(cell).join(' | ')} |\n|${' --- |'.repeat(cols.length + 1)}\n` + rows.map(r => `| ${r.map(cell).join(' | ')} |`).join('\n') + '\n';

try {
  const t = await js(`(${build})()`);
  let md = '# behaviour\n\nGenerated by `node test/behaviour.mjs --save`. Each cell is built fresh. Review a diff here like a code change.\n\n';
  md += '## delivery - value routed into receiver\n\nCell: what receiver shows, then `event` / `passes` only where they differ from value sent.\n\n' + table('receiver', t.delivery.cols, t.delivery.rows);
  md += '\n## verbs - "x" routed into target carrying verb\n\n' + table('verb', t.verbs.cols, t.verbs.rows);
  md += '\n## nodes - one input into fresh node\n\nCell: what node emits, then its state.\n';
  for (const n of t.nodes) md += `\n### ${n.name}\n\n` + table('input', n.cols, n.rows);
  md += '\n## nodes with memory - two inputs\n';
  for (const p of t.pairs) md += `\n### ${p.name}\n\n` + table('first', p.cols, p.rows);
  ok(!errors.length, `table builds without uncaught errors (${errors.slice(0, 2).join(' | ')})`);
  if (process.argv.includes('--save')) { writeFileSync(tablePath, md); console.log('saved test/behaviour.md'); }
  else if (!existsSync(tablePath)) ok(false, 'no test/behaviour.md yet - run with --save and review it');
  else {
    const want = readFileSync(tablePath, 'utf8').split('\n'), got = md.split('\n');
    const changed = got.map((l, i) => l === want[i] ? null : `  line ${i + 1}\n    was ${want[i] ?? '(none)'}\n    now ${l}`).filter(Boolean);
    if (want.length !== got.length) changed.push(`  ${want.length} lines before, ${got.length} now`);
    ok(!changed.length, `behaviour matches test/behaviour.md - ${changed.length} lines differ, review and --save if intended\n${changed.slice(0, 8).join('\n')}`);
  }
} catch (e) {
  fails++; console.log('  ✗ behaviour tier threw:', e.message);
}

try { ws.close(); } catch {}
cleanup();
console.log(fails ? `behaviour: FAIL (${fails})` : 'behaviour: PASS');
process.exit(fails ? 1 : 0);
