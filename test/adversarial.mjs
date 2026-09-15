// adversarial tier - try to break patchbay - contract: nothing uncaught, no hang, graph never corrupts

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const pbUrl = pathToFileURL(join(here, '..', 'patchbay.html')).href;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
const uncaught = [];
await send('Runtime.enable'); await send('Page.enable');
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') uncaught.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
const js = async (e, aw = false) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const done = () => { try { ws.close(); } catch {} cleanup(); };

try {
  await send('Page.navigate', { url: pbUrl }); await waitEvent('Page.loadEventFired'); await delay(400);
  await js(`setMode('edit'); true`);

  // routeSend to channel with no receivers > no-op, no throw
  ok(await js(`(() => { try { routeSend('nope_channel', 42); return true; } catch (e) { return false; } })()`), 'routeSend to nonexistent channel is safe no-op');

  // node cannot wire to itself
  ok(await js(`(() => { const n = spawnLogicNode('accumulator', 100, 100); autoWire(n, n); return (n.getAttribute('data-scv-emits') || '') === '' || !n.getAttribute('data-scv-receives'); })()`), 'self-wire is refused (no self-cable)');

  // cycle terminates via hop guard instead of hanging / overflowing stack
  const cycle = await js(`(() => {
    const a = spawnLogicNode('accumulator', 200, 100), b = spawnLogicNode('accumulator', 400, 100);
    autoWire(a, b); autoWire(b, a); // A > B > A
    const t0 = performance.now();
    try { a.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); } catch (e) { return { threw: e.message }; }
    return { ms: performance.now() - t0 };
  })()`);
  ok(cycle && !cycle.threw && cycle.ms < 1000, `wiring cycle terminates (hop guard), no hang/overflow (${JSON.stringify(cycle)})`);

  // throwing / undefined-referencing mutator caught and doesn't halt sibling receivers
  const mutThrow = await js(`(() => {
    const m = spawnLogicNode('mutator', 200, 300); m.querySelector('.scv-logic-input').value = 'undefined_variable_xyz + 1';
    m.setAttribute('data-scv-receives', 'adv_ch');
    const sib = document.createElement('div'); sib.id = 'adv_sib'; sib.setAttribute('data-scv-receives', 'adv_ch'); zoomLayer.appendChild(sib);
    invalidateCache();
    routeSend('adv_ch', 5); // mutator throws (caught), sibling must still receive
    return document.getElementById('adv_sib').textContent;
  })()`);
  ok(mutThrow === '5', `throwing mutator is caught and does not halt sibling receiver (got ${JSON.stringify(mutThrow)})`);

  // emitting-variable feedback loop (V > mutator > V) terminates via same hop guard
  const varLoop = await js(`(() => {
    const v = spawnLogicNode('variable', 200, 450); v.querySelector('.scv-logic-input').value = 'loopv';
    const vch = v.getAttribute('data-scv-emits');
    const m = spawnLogicNode('mutator', 400, 450); m.querySelector('.scv-logic-input').value = 'v';
    m.setAttribute('data-scv-receives', vch); m.setAttribute('data-scv-emits', 'loop_back');
    v.setAttribute('data-scv-receives', 'loop_back'); // close the loop back into the variable
    invalidateCache();
    const t0 = performance.now();
    try { v.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); } catch (e) { return { threw: e.message }; }
    return { ms: performance.now() - t0 };
  })()`);
  ok(varLoop && !varLoop.threw && varLoop.ms < 1000, `emitting-variable feedback loop terminates via hop guard (${JSON.stringify(varLoop)})`);

  // xss: routed string applied as text, never parsed as markup / executed
  const xss = await js(`(() => {
    window.__xss = false;
    const r = document.createElement('div'); r.id = 'adv_xss'; r.setAttribute('data-scv-receives', 'xss_ch'); zoomLayer.appendChild(r);
    invalidateCache();
    routeSend('xss_ch', '<img src=x onerror="window.__xss=true">');
    const el = document.getElementById('adv_xss');
    return { childImgs: el.querySelectorAll('img').length, executed: window.__xss, text: el.textContent.slice(0, 8) };
  })()`);
  ok(xss && xss.childImgs === 0 && xss.executed === false, `routed markup is inert text, not executed (${JSON.stringify(xss)})`);

  // malformed paste / .scv handled gracefully (return null-ish, no throw)
  ok(await js(`(() => { try { handlePasteData('<div>totally not a scavenger payload</div>'); return true; } catch (e) { return false; } })()`), 'garbage paste does not throw');
  ok(await js(`(() => { try { const r = registerScvNodeFile('<html><body>no node here</body></html>'); return r === null; } catch (e) { return false; } })()`), 'malformed .scv returns null, no throw');
  ok(await js(`(() => { try { registerScvNodeFile('<script data-scv-node>defineNode({ /* missing name */ icon: "x" })</scr'+'ipt>'); return true; } catch (e) { return false; } })()`), '.scv whose def is invalid is caught');

  // undo/redo underflow/overflow safe
  ok(await js(`(() => { try { for (let i=0;i<200;i++) undo(); for (let i=0;i<200;i++) redo(); return true; } catch (e) { return false; } })()`), 'undo/redo past stack bounds never throws');

  // huge value routes without crashing
  ok(await js(`(() => { try { const r = document.createElement('div'); r.id='adv_big'; r.setAttribute('data-scv-receives','big_ch'); zoomLayer.appendChild(r); invalidateCache(); routeSend('big_ch', 'z'.repeat(1000000)); return document.getElementById('adv_big').textContent.length === 1000000; } catch(e){ return false; } })()`), '1MB routed value is handled');

  // non-numeric value into accumulator degrades to 0, not thrown crash
  const nan = await js(`(() => { const a = spawnLogicNode('accumulator', 600, 300); a.querySelector('.scv-logic-input').value='0'; a.dispatchEvent(new CustomEvent('scv-receive', { detail: 'not-a-number' })); const v = a.querySelector('.scv-logic-input').value; return v; })()`);
  ok(nan === '0', `accumulator treats non-numeric received value as 0, not NaN (got ${JSON.stringify(nan)})`); // _setupAccumulator's num() coerces non-finite to 0

  // spawn/delete storm: create many nodes then delete them all - no crash, cables consistent
  const storm = await js(`(() => {
    try {
      const baselineCables = document.querySelectorAll('#static-cables .cable-path').length; // earlier sections in this file leave their own wired nodes standing
      const nodes = [];
      for (let i = 0; i < 40; i++) nodes.push(spawnLogicNode('gate', 50 + i, 600));
      for (let i = 1; i < nodes.length; i++) autoWire(nodes[i-1], nodes[i]);
      renderCables();
      nodes.forEach(n => n.remove());
      invalidateCache(); renderCables();
      return { baselineCables, remainingCables: document.querySelectorAll('#static-cables .cable-path').length };
    } catch (e) { return { threw: e.message }; }
  })()`);
  ok(storm && !storm.threw, `40-node spawn+wire+delete storm doesn't crash (${JSON.stringify(storm)})`);
  ok(storm && storm.remainingCables === storm.baselineCables, `deleting every node also clears cables it added (${JSON.stringify(storm)})`);

  // after all abuse, board still routes normally
  const stillWorks = await js(`(() => {
    const r = document.createElement('div'); r.id = 'adv_ok'; r.setAttribute('data-scv-receives', 'ok_ch'); zoomLayer.appendChild(r);
    invalidateCache();
    routeSend('ok_ch', 'healthy');
    return document.getElementById('adv_ok').textContent;
  })()`);
  ok(stillWorks === 'healthy', `patchbay still routes normally after all abuse (got ${JSON.stringify(stillWorks)})`);

  await delay(300); // grace period - late async/timer exception may still be in flight over cdp ws, not just snapshot
  ok(uncaught.length === 0, `no uncaught exceptions across all adversarial cases (${uncaught.slice(0, 3).join(' | ')})`);
} catch (e) {
  fails++; console.log('  ✗ adversarial tier threw:', e.message);
}

done();
console.log(fails ? `adversarial: FAIL (${fails})` : 'adversarial: PASS');
process.exit(fails ? 1 : 0);