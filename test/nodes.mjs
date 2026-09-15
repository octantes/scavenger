// nodes tier - deep per-node behaviour: variable lock/modes, comparator, clock, full action verb set, fan-out/in

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const here = dirname(fileURLToPath(import.meta.url));
const pbUrl = pathToFileURL(join(here, '..', 'patchbay.html')).href;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable'); await send('Runtime.enable');
const uncaught = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') uncaught.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
const js = async (e, aw = false) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const done = () => { try { ws.close(); } catch {} cleanup(); };

try {
  await send('Page.navigate', { url: pbUrl }); await waitEvent('Page.loadEventFired'); await new Promise(r => setTimeout(r, 400));
  await js(`setMode('edit'); true`);
  // helper in-page: read variable's current store value via throwaway mutator
  await js(`window.__readVar = (name) => { const m = spawnLogicNode('mutator', -999, -999); m.querySelector('.scv-logic-input').value = name; m.setAttribute('data-scv-emits', '__rv'); const r = document.createElement('div'); r.setAttribute('data-scv-receives', '__rv'); const old = document.getElementById('__rvout'); if (old) old.remove(); r.id = '__rvout'; zoomLayer.appendChild(r); invalidateCache(); m.dispatchEvent(new CustomEvent('scv-receive', { detail: 0 })); const v = r.textContent; m.remove(); return v; }; true`);

  // variable const-lock: another node can't overwrite; owner still can
  const constLock = await js(`(() => {
    const a = spawnLogicNode('variable', 100, 100); a.querySelector('.scv-logic-input').value = 'clk';
    a.querySelector('.scv-logic-icon').click(); // let > const (a owns the lock)
    a.dispatchEvent(new CustomEvent('scv-receive', { detail: 5 })); // const clk = 5
    const owned = window.__readVar('clk');
    const b = spawnLogicNode('variable', 300, 100); b.querySelector('.scv-logic-input').value = 'clk'; // let mode
    b.dispatchEvent(new CustomEvent('scv-receive', { detail: 9 })); // blocked - clk is const-locked by a
    const afterOther = window.__readVar('clk');
    a.dispatchEvent(new CustomEvent('scv-receive', { detail: 7 })); // owner reassigns - allowed
    const afterOwner = window.__readVar('clk');
    return { owned, afterOther, afterOwner };
  })()`);
  ok(constLock && constLock.owned === '5' && constLock.afterOther === '5' && constLock.afterOwner === '7',
    `const locks name to its owner: other node blocked, owner updates (${JSON.stringify(constLock)})`);

  // variable mode cycling: icon click toggles let <> const (only two modes)
  const cycle = await js(`(() => {
    const v = spawnLogicNode('variable', 100, 300); const icon = v.querySelector('.scv-logic-icon');
    const seq = [v._varMode];
    for (let i = 0; i < 3; i++) { icon.click(); seq.push(v._varMode); }
    return seq;
  })()`);
  ok(JSON.stringify(cycle) === JSON.stringify(['let', 'const', 'let', 'const']), `mode cycles let⇄const (got ${JSON.stringify(cycle)})`);

  // comparator inequality (≠) mode: 0 when equal, 1 when not
  const neq = await js(`(() => {
    const c = spawnLogicNode('comparator', 100, 400); c.querySelector('.scv-logic-icon').click(); // = > ≠
    c.setAttribute('data-scv-emits', 'neq_out');
    const r = document.createElement('div'); r.id = 'neq_r'; r.setAttribute('data-scv-receives', 'neq_out'); zoomLayer.appendChild(r);
    invalidateCache();
    c.dispatchEvent(new CustomEvent('scv-receive', { detail: 4 }));
    c.dispatchEvent(new CustomEvent('scv-receive', { detail: 4 })); // equal > ≠ emits 0
    const whenEqual = document.getElementById('neq_r').textContent;
    c.dispatchEvent(new CustomEvent('scv-receive', { detail: 4 }));
    c.dispatchEvent(new CustomEvent('scv-receive', { detail: 9 })); // unequal > ≠ emits 1
    const whenNot = document.getElementById('neq_r').textContent;
    return { mode: c._invert, whenEqual, whenNot };
  })()`);
  ok(neq && neq.mode === true && neq.whenEqual === '0' && neq.whenNot === '1', `comparator ≠ mode: equal→0, unequal→1 (${JSON.stringify(neq)})`);

  // clock timer emission: running clock ticks accumulator over real time
  const timer = await js(`(async () => {
    const c = spawnLogicNode('clock', 100, 500); c.setAttribute('data-scv-emits', 'clk_out');
    const inp = c.querySelector('.scv-logic-input'); inp.value = '40'; inp.dispatchEvent(new Event('change', { bubbles: true })); // 40ms period, reset schedule
    const acc = spawnLogicNode('accumulator', 300, 500); acc.setAttribute('data-scv-receives', 'clk_out'); acc.querySelector('.scv-logic-input').value = '0';
    invalidateCache();
    await new Promise(r => setTimeout(r, 350)); // ~8 ticks; assert loosely for jitter/clamping
    return Number(acc.querySelector('.scv-logic-input').value);
  })()`, true);
  ok(timer >= 3, `clock timer fires repeatedly, accumulator counts ticks (got ${timer} in 350ms @40ms)`);

  const stopped = await js(`(async () => {
    const c = spawnLogicNode('clock', 100, 700); c.setAttribute('data-scv-emits', 'clk_stop');
    const inp = c.querySelector('.scv-logic-input'); inp.value = '30'; inp.dispatchEvent(new Event('change', { bubbles: true }));
    const acc = spawnLogicNode('accumulator', 300, 700); acc.setAttribute('data-scv-receives', 'clk_stop'); acc.querySelector('.scv-logic-input').value = '0';
    invalidateCache();
    await new Promise(r => setTimeout(r, 250));
    const ran = Number(acc.querySelector('.scv-logic-input').value);
    c.remove(); invalidateCache();
    await new Promise(r => setTimeout(r, 250));
    const after = Number(acc.querySelector('.scv-logic-input').value);
    return { ran, after };
  })()`, true);
  ok(stopped && stopped.ran >= 2, `clock was actually ticking before removal (${stopped && stopped.ran})`);
  ok(stopped && stopped.after === stopped.ran, `removed clock stops ticking (${stopped && stopped.ran} → ${stopped && stopped.after})`);

  const grid = await js(`(async () => {
    document.querySelectorAll('scv-logic').forEach(n => n.remove()); invalidateCache();
    const stamps = {};
    const mk = (val, tag, x, delayFirst) => {
      const c = spawnLogicNode('clock', x, 1800);
      const i = c.querySelector('.scv-logic-input'); i.value = String(val); i.dispatchEvent(new Event('change', { bubbles: true }));
      const ch = 'grid_' + tag; c.setAttribute('data-scv-emits', ch);
      const r = document.createElement('div'); r.setAttribute('data-scv-receives', ch); zoomLayer.appendChild(r);
      stamps[tag] = [];
      new MutationObserver(() => stamps[tag].push(performance.now())).observe(r, { childList: true, characterData: true, subtree: true });
      return c;
    };
    mk(200, 'a', 100);
    await new Promise(r => setTimeout(r, 130)); // land mid-period so alignment cannot be luck
    mk(200, 'b', 300);
    mk(-200, 'off', 500);
    mk(-250, 'negp', 700);
    invalidateCache();
    await new Promise(r => setTimeout(r, 1500));
    document.querySelectorAll('scv-logic').forEach(n => n.remove()); invalidateCache();
    const gap = (x, y) => {
      if (!stamps[x].length || !stamps[y].length) return null;
      const d = stamps[y].map(t => Math.min(...stamps[x].map(u => Math.abs(u - t))));
      return +(d.reduce((p, q) => p + q, 0) / d.length).toFixed(1);
    };
    const period = a => a.length < 2 ? null : +((a[a.length - 1] - a[0]) / (a.length - 1)).toFixed(0);
    return { ticks: Object.fromEntries(Object.entries(stamps).map(([k, v]) => [k, v.length])),
             sameGap: gap('a', 'b'), offGap: gap('a', 'off'), negPeriod: period(stamps.negp) };
  })()`, true);
  ok(grid && grid.ticks.a >= 4 && grid.ticks.b >= 4 && grid.ticks.off >= 4, `every clock ticked (${JSON.stringify(grid && grid.ticks)})`);
  ok(grid && grid.sameGap !== null && grid.sameGap < 20,
    `two clocks of same interval share beat however each was spawned (${grid && grid.sameGap}ms apart)`);
  ok(grid && grid.offGap !== null && Math.abs(grid.offGap - 100) < 30,
    `negative interval sits half beat off grid, so pair alternates (${grid && grid.offGap}ms of 100ms half-period)`);
  ok(grid && grid.negPeriod !== null && Math.abs(grid.negPeriod - 250) < 40,
    `negative interval keeps its own magnitude as period, it no longer collapses to 1000ms default (${grid && grid.negPeriod}ms)`);

  const tickBtn = await js(`(async () => {
    document.querySelectorAll('scv-logic').forEach(n => n.remove()); invalidateCache();
    const c = spawnLogicNode('clock', 900, 1800);
    const i = c.querySelector('.scv-logic-input'); i.value = '300'; i.dispatchEvent(new Event('change', { bubbles: true }));
    c.setAttribute('data-scv-emits', 'grid_btn');
    const r = document.createElement('div'); r.setAttribute('data-scv-receives', 'grid_btn'); zoomLayer.appendChild(r);
    const s = []; new MutationObserver(() => s.push(performance.now())).observe(r, { childList: true, characterData: true, subtree: true });
    invalidateCache();
    await new Promise(x => setTimeout(x, 450));
    const beforeClick = c._clkNext;
    c.querySelector('.scv-logic-icon').click();
    const afterClick = c._clkNext;
    await new Promise(x => setTimeout(x, 700));
    c.remove(); invalidateCache();
    return { scheduleUntouched: beforeClick === afterClick, ticks: s.length };
  })()`, true);
  ok(tickBtn && tickBtn.scheduleUntouched, 'clicking icon does not move next scheduled tick');
  ok(tickBtn && tickBtn.ticks >= 4, `click adds tick on top of scheduled ones (${tickBtn && tickBtn.ticks} in ~1150ms at 300ms)`);

  // action verbs beyond increment: hide / show / toggle / delete / clone / decrement
  const verbs = await js(`(() => {
    const mk = (verb) => {
      const a = spawnLogicNode('action', 100, 600); a.querySelector('.scv-logic-input').value = verb;
      const ch = a.getAttribute('data-scv-emits');
      const r = document.createElement('input'); r.className = 'verbtgt'; r.value = '5'; r.style.display = 'block'; r.setAttribute('data-scv-receives', ch); zoomLayer.appendChild(r);
      invalidateCache();
      a.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // fire verb
      return { a, ch, r };
    };
    const hide = mk('hide'); const hidden = hide.r.style.display;
    hide.a.querySelector('.scv-logic-input').value = 'show'; hide.a.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); const shown = hide.r.style.display;
    const del = mk('delete'); const deleted = !del.r.isConnected;
    const dec = mk('decrement'); const decVal = dec.r.value;
    // clone: _macro strips wiring attrs from clone - count by marker class it copies, mark before firing
    const ca = spawnLogicNode('action', 100, 650); ca.querySelector('.scv-logic-input').value = 'clone';
    const cr = document.createElement('div'); cr.className = 'clone_marker'; cr.setAttribute('data-scv-receives', ca.getAttribute('data-scv-emits')); zoomLayer.appendChild(cr);
    invalidateCache();
    const beforeClone = document.querySelectorAll('.clone_marker').length;
    ca.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 }));
    const cloneCount = document.querySelectorAll('.clone_marker').length - beforeClone + 1; // 2 if it duplicated
    return { hidden, shown, deleted, cloneCount, decVal };
  })()`);
  ok(verbs && verbs.hidden === 'none', `action 'hide' hides receiver (${JSON.stringify(verbs.hidden)})`);
  ok(verbs && verbs.shown !== 'none', `action 'show' restores it (${JSON.stringify(verbs.shown)})`);
  ok(verbs && verbs.deleted === true, `action 'delete' removes receiver`);
  ok(verbs && verbs.cloneCount >= 2, `action 'clone' duplicates receiver (count ${verbs.cloneCount})`);
  ok(verbs && String(verbs.decVal) === '4', `action 'decrement' 5 → 4 (got ${verbs.decVal})`);

  // compound verbs via data-scv-action: prop / event (method covered structurally)
  const compound = await js(`(() => {
    // prop: set property from routed value
    const p = document.createElement('div'); p.id = 'cmp_prop'; p.setAttribute('data-scv-action', 'prop:textContent:pc'); zoomLayer.appendChild(p);
    // event: dispatch CustomEvent carrying value
    let heard = null;
    const ev = document.createElement('div'); ev.id = 'cmp_ev'; ev.setAttribute('data-scv-action', 'event:ping:ec'); ev.addEventListener('ping', e => { heard = e.detail; }); zoomLayer.appendChild(ev);
    invalidateCache();
    routeSend('pc', 'hello-prop');
    routeSend('ec', 'hello-event');
    return { prop: document.getElementById('cmp_prop').textContent, event: heard };
  })()`);
  ok(compound && compound.prop === 'hello-prop', `compound prop: sets property from value (${JSON.stringify(compound.prop)})`);
  ok(compound && compound.event === 'hello-event', `compound event: dispatches CustomEvent with value (${JSON.stringify(compound.event)})`);

  // fan-out: one channel > many receivers, all updated by one emit
  const fanOut = await js(`(() => {
    const ids = ['fo1', 'fo2', 'fo3'].map(id => { const d = document.createElement('div'); d.id = id; d.setAttribute('data-scv-receives', 'fo'); zoomLayer.appendChild(d); return id; });
    invalidateCache();
    routeSend('fo', 'broadcast');
    return ids.map(id => document.getElementById(id).textContent);
  })()`);
  ok(fanOut && fanOut.every(t => t === 'broadcast'), `fan-out: one emit reaches every receiver (${JSON.stringify(fanOut)})`);

  const iconEsc = await js(`(() => {
    defineScavNode({ name: 'esc_probe', icon: '<img src=x onerror="window.__pwn=1">', color: '#888', init() {} });
    const n = spawnLogicNode('esc_probe', 900, 600);
    return { img: !!n.querySelector('.scv-logic-icon img'), ran: !!window.__pwn, text: n.querySelector('.scv-logic-icon').textContent };
  })()`);
  ok(iconEsc && !iconEsc.img && !iconEsc.ran, `def-supplied icon renders as text, not markup (${JSON.stringify(iconEsc)})`);

  const inputType = await js(`(() => {
    defineScavNode({ name: 'it_probe', icon: 'i', color: '#888', inputType: 'text" onfocus="window.__pwn2=1', init() {} });
    const n = spawnLogicNode('it_probe', 1100, 600);
    const i = n.querySelector('.scv-logic-input');
    return { type: i.getAttribute('type'), onfocus: i.hasAttribute('onfocus') };
  })()`);
  ok(inputType && inputType.type === 'text', `def inputType outside safe list falls back to text (got ${JSON.stringify(inputType && inputType.type)})`);
  ok(inputType && inputType.onfocus === false, 'def inputType cannot smuggle in extra attribute');

  const varNames = await js(`(() => {
    const mk = (name) => {
      const n = spawnLogicNode('variable', 1300, 600);
      const i = n.querySelector('.scv-logic-input');
      i.value = name; i.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new CustomEvent('scv-receive', { detail: 7 }));
      const held = n._varName;
      n.remove();
      return held;
    };
    return { math: mk('Math'), v: mk('v'), bad: mk('1bad'), good: mk('rate') };
  })()`);
  ok(varNames && varNames.math === null, `variable cannot take global's name (Math → ${JSON.stringify(varNames && varNames.math)})`);
  ok(varNames && varNames.v === null, `variable cannot be named v, received value (→ ${JSON.stringify(varNames && varNames.v)})`);
  ok(varNames && varNames.bad === null, `variable cannot take non-identifier name (1bad → ${JSON.stringify(varNames && varNames.bad)})`);
  ok(varNames && varNames.good === 'rate', `valid identifier is accepted (rate → ${JSON.stringify(varNames && varNames.good)})`);

  const mutCache = await js(`(() => {
    const NativeFn = window.Function;
    let compiles = 0;
    window.Function = new Proxy(NativeFn, { construct: (t, a) => { compiles++; return new t(...a); } });
    const out = [];
    const delta = (f) => { const b = compiles; f(); return compiles - b; };
    try {
      const m = spawnLogicNode('mutator', 1500, 600); m.setAttribute('data-scv-emits', 'mc_out');
      const r = document.createElement('div'); r.id = 'mc_r'; r.setAttribute('data-scv-receives', 'mc_out'); zoomLayer.appendChild(r);
      const inp = m.querySelector('.scv-logic-input');
      invalidateCache();
      inp.value = 'v * 2';
      const dSame = delta(() => { for (let i = 1; i <= 5; i++) { m.dispatchEvent(new CustomEvent('scv-receive', { detail: i })); out.push(r.textContent); } });
      inp.value = 'v + 100';
      const dEdit = delta(() => { m.dispatchEvent(new CustomEvent('scv-receive', { detail: 7 })); out.push(r.textContent); });
      const vn = spawnLogicNode('variable', 1700, 600); vn.querySelector('.scv-logic-input').value = 'bonus';
      vn.dispatchEvent(new CustomEvent('scv-receive', { detail: 5 }));
      inp.value = 'v + bonus';
      const dVar = delta(() => { m.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); out.push(r.textContent); });
      const dRepeat = delta(() => { m.dispatchEvent(new CustomEvent('scv-receive', { detail: 2 })); out.push(r.textContent); });
      inp.value = 'v +';
      m.dispatchEvent(new CustomEvent('scv-receive', { detail: 3 }));
      const brokeOut = r.textContent;
      inp.value = 'v * 10';
      m.dispatchEvent(new CustomEvent('scv-receive', { detail: 3 }));
      const healed = r.textContent;
      return { out, dSame, dEdit, dVar, dRepeat, brokeOut, healed };
    } finally { window.Function = NativeFn; }
  })()`);
  ok(mutCache && JSON.stringify(mutCache.out) === JSON.stringify(['2', '4', '6', '8', '10', '107', '6', '7']),
    `mutator results are unchanged by caching (${JSON.stringify(mutCache && mutCache.out)})`);
  ok(mutCache && mutCache.dSame === 1, `five values through one expression compile it once (${mutCache && mutCache.dSame})`);
  ok(mutCache && mutCache.dEdit === 1, `editing expression recompiles (${mutCache && mutCache.dEdit})`);
  ok(mutCache && mutCache.dVar === 1, `new variable name in scope recompiles (${mutCache && mutCache.dVar})`);
  ok(mutCache && mutCache.dRepeat === 0, `further value on same expression compiles nothing (${mutCache && mutCache.dRepeat})`);
  ok(mutCache && mutCache.brokeOut === '7', `broken expression emits nothing, leaving last good output (${mutCache && mutCache.brokeOut})`);
  ok(mutCache && mutCache.healed === '30', `fixing expression works again - failed compile is not cached (${mutCache && mutCache.healed})`);

  // fan-in: two sources > one comparator channel; gets both values and compares
  const fanIn = await js(`(() => {
    const c = spawnLogicNode('comparator', 500, 600); c.setAttribute('data-scv-receives', 'fin'); c.setAttribute('data-scv-emits', 'fin_out');
    const r = document.createElement('div'); r.id = 'fin_r'; r.setAttribute('data-scv-receives', 'fin_out'); zoomLayer.appendChild(r);
    // two distinct sources emitting into same 'fin' channel
    const s1 = spawnLogicNode('reader', 500, 500); s1.setAttribute('data-scv-emits', 'fin');
    const s2 = spawnLogicNode('reader', 700, 500); s2.setAttribute('data-scv-emits', 'fin');
    invalidateCache();
    routeSend('fin', 6); // source 1's value
    routeSend('fin', 6); // source 2's value > comparator has [6,6] > equal > 1
    return document.getElementById('fin_r').textContent;
  })()`);
  ok(fanIn === '1', `fan-in: two sources feed one comparator, which compares them (equal 6,6 → 1, got ${JSON.stringify(fanIn)})`);

  // gate open>close>open cycle: 1 toggles gate each time
  const gateCycle = await js(`(() => {
    const g = spawnLogicNode('gate', 900, 100); g.setAttribute('data-scv-emits', 'gc_out');
    const r = document.createElement('div'); r.id = 'gc_r'; r.setAttribute('data-scv-receives', 'gc_out'); zoomLayer.appendChild(r);
    invalidateCache();
    const pass = (v) => { g.dispatchEvent(new CustomEvent('scv-receive', { detail: v })); return document.getElementById('gc_r').textContent; };
    g.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // open
    const opened = pass('x'); // passes > 'x'
    g.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // 1 again > close
    document.getElementById('gc_r').textContent = '';
    const closed = pass('y'); // blocked > ''
    g.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // 1 again > re-open
    const reopened = pass('z'); // passes > 'z'
    return { opened, closed, reopened };
  })()`);
  ok(gateCycle && gateCycle.opened === 'x' && gateCycle.closed === '' && gateCycle.reopened === 'z',
    `gate toggles open→close→open on each 1 (${JSON.stringify(gateCycle)})`);

  // action 'toggle' verb: flips receiver's display each fire
  const toggleVerb = await js(`(() => {
    const a = spawnLogicNode('action', 900, 200); a.querySelector('.scv-logic-input').value = 'toggle';
    const r = document.createElement('div'); r.id = 'tg_r'; r.style.display = 'block'; r.setAttribute('data-scv-receives', a.getAttribute('data-scv-emits')); zoomLayer.appendChild(r);
    invalidateCache();
    a.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); const off = getComputedStyle(r).display;
    a.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); const on = getComputedStyle(r).display;
    return { off, on };
  })()`);
  ok(toggleVerb && toggleVerb.off === 'none' && toggleVerb.on !== 'none', `action 'toggle' flips display each fire (${JSON.stringify(toggleVerb)})`);

  // reader stores 0 (falsy) and re-emits on 1 trigger - 0 is value, not "no value"
  const readerZero = await js(`(() => {
    const rd = spawnLogicNode('reader', 900, 300); rd.setAttribute('data-scv-emits', 'rz_out');
    const r = document.createElement('div'); r.id = 'rz_r'; r.setAttribute('data-scv-receives', 'rz_out'); zoomLayer.appendChild(r);
    invalidateCache();
    rd.dispatchEvent(new CustomEvent('scv-receive', { detail: 0 })); // store 0 (not a trigger - trigger is 1)
    const beforeTrigger = document.getElementById('rz_r').textContent;
    rd.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // trigger > re-emit stored 0
    return { beforeTrigger, afterTrigger: document.getElementById('rz_r').textContent };
  })()`);
  ok(readerZero && readerZero.beforeTrigger === '' && readerZero.afterTrigger === '0', `reader stores 0 and re-emits it (falsy-safe) (${JSON.stringify(readerZero)})`);

  // comparator buffers single value silently - no output until two values
  const cmpBuffer = await js(`(() => {
    const c = spawnLogicNode('comparator', 900, 400); c.setAttribute('data-scv-emits', 'cb_out');
    const r = document.createElement('div'); r.id = 'cb_r'; r.textContent = 'unset'; r.setAttribute('data-scv-receives', 'cb_out'); zoomLayer.appendChild(r);
    invalidateCache();
    c.dispatchEvent(new CustomEvent('scv-receive', { detail: 5 })); // only one value > buffered, no emit
    const afterOne = document.getElementById('cb_r').textContent;
    c.dispatchEvent(new CustomEvent('scv-receive', { detail: 5 })); // second > now emits
    return { afterOne, afterTwo: document.getElementById('cb_r').textContent };
  })()`);
  ok(cmpBuffer && cmpBuffer.afterOne === 'unset' && cmpBuffer.afterTwo === '1', `comparator buffers one value silently, emits on second (${JSON.stringify(cmpBuffer)})`);

  // compound method: verb - call dom method on receiver with value
  const methodVerb = await js(`(() => {
    const inp = document.createElement('input'); inp.id = 'mv_in'; inp.setAttribute('data-scv-action', 'method:setAttribute:mvc'); zoomLayer.appendChild(inp);
    invalidateCache();
    // router calls node[name](value) one-arg, so setAttribute (needs 2) throws in try/catch - never asserted before
    const btn = document.createElement('button'); btn.id = 'mv_btn'; let clicked = 0; btn.addEventListener('click', () => clicked++); btn.setAttribute('data-scv-action', 'method:click:mvc'); zoomLayer.appendChild(btn);
    invalidateCache();
    routeSend('mvc', null); // fans out to both inp (setAttribute, throws-and-caught) and btn (click, works) on same channel
    return { clicked, inpAttrs: inp.attributes.length };
  })()`);
  ok(methodVerb && methodVerb.clicked === 1, `compound method: calls dom method on receiver (btn.click fired ${methodVerb && methodVerb.clicked}×)`);
  ok(methodVerb && methodVerb.inpAttrs === 2, `compound method: >=2-arg method (setAttribute) throws internally but router contains it, gaining no new attribute (has ${methodVerb && methodVerb.inpAttrs}, expected id+data-scv-action=2)`);
  await new Promise(r => setTimeout(r, 100)); // grace period, same as adversarial/tools - caught error is sync but cdp report may not have arrived
  ok(uncaught.length === 0, `compound method's contained setAttribute failure never surfaces as UNCAUGHT exception (${uncaught.slice(0, 2).join(' | ')})`);

  // autoWire on already-wired pair is idempotent - no duplicate channel
  const idempotent = await js(`(() => {
    const a = spawnLogicNode('reader', 1100, 100), b = spawnLogicNode('accumulator', 1300, 100);
    autoWire(a, b);
    const emits1 = (a.getAttribute('data-scv-emits') || '').split(' ').filter(Boolean).length;
    autoWire(a, b); // again - must not add second identical channel
    const emits2 = (a.getAttribute('data-scv-emits') || '').split(' ').filter(Boolean).length;
    const recv = (b.getAttribute('data-scv-receives') || '').split(' ').filter(Boolean).length;
    return { emits1, emits2, recv };
  })()`);
  ok(idempotent && idempotent.emits1 === idempotent.emits2 && idempotent.recv === 1, `autoWire on already-wired pair is idempotent (${JSON.stringify(idempotent)})`);

  // _chDepth 20-hop cycle guard: long linear chain terminates at limit with warn
  const hopGuard = await js(`(() => {
    const warns = [];
    const orig = console.warn; console.warn = (...a) => { warns.push(a.join(' ')); };
    // build 25-long linear mutator chain m0 > m1 > ... each just forwards v; then emit into m0
    let prev = null, first = null;
    for (let i = 0; i < 25; i++) {
      const m = spawnLogicNode('mutator', 1500 + i, 100); m.querySelector('.scv-logic-input').value = 'v';
      m.setAttribute('data-scv-receives', 'hop' + i); m.setAttribute('data-scv-emits', 'hop' + (i + 1));
      if (i === 0) first = 'hop0';
      prev = m;
    }
    const tail = document.createElement('div'); tail.id = 'hop_tail'; tail.setAttribute('data-scv-receives', 'hop25'); zoomLayer.appendChild(tail);
    invalidateCache();
    routeSend('hop0', 42); // propagates until depth guard cuts it
    console.warn = orig;
    return { tailReached: document.getElementById('hop_tail').textContent, warned: warns.some(w => /depth limit/.test(w)) };
  })()`);
  ok(hopGuard && hopGuard.tailReached === '' && hopGuard.warned, `chain past 20 hops is cut at limit with console.warn (${JSON.stringify(hopGuard)})`);
} catch (e) {
  fails++; console.log('  ✗ nodes tier threw:', e.message);
}

done();
console.log(fails ? `nodes: FAIL (${fails})` : 'nodes: PASS');
process.exit(fails ? 1 : 0);