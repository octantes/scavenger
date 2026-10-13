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
const js = async (e, aw = true) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const done = () => { try { ws.close(); } catch {} cleanup(); };

try {
  await send('Page.navigate', { url: pbUrl }); await waitEvent('Page.loadEventFired'); await delay(300);
  await js(`(() => { const pb = document.querySelector('scv-patchbay'); window.pb = pb; window.node = (type, x, y, attrs = {}) => { const n = document.createElement('scv-logic'); n.dataset.type = type; n.style.left = x + 'px'; n.style.top = y + 'px'; for (const k in attrs) n.setAttribute(k, attrs[k]); pb.append(n); return n; }; window.sink = ch => { const d = document.createElement('div'); d.setAttribute('data-scv-receives', ch); pb.append(d); return d; }; return true; })()`);

  ok(await js(`(() => { try { pb.routeSend('nope_channel', 42); return true; } catch (e) { return false; } })()`), 'routeSend to nonexistent channel is safe no-op');
  ok(await js(`(() => { const n = node('accumulator', 100, 100); pb.wire(n, n); return !n.hasAttribute('data-scv-emits'); })()`), 'self-wire is refused (no self-cable)');

  const cycle = await js(`(() => {
    const a = node('accumulator', 200, 100), b = node('accumulator', 400, 100);
    pb.wire(a, b); pb.wire(b, a);
    const warn = console.warn; console.warn = () => {};
    const t0 = performance.now();
    try { a.receive(1, 'x'); } catch (e) { return { threw: e.message }; } finally { console.warn = warn; }
    return { ms: performance.now() - t0 };
  })()`);
  ok(cycle && !cycle.threw && cycle.ms < 1000, `wiring cycle terminates (hop guard), no hang/overflow (${JSON.stringify(cycle)})`);

  const mutThrow = await js(`(() => {
    const m = node('mutator', 200, 300, { value: 'undefined_variable_xyz + 1', 'data-scv-receives': 'adv_ch' }), sib = sink('adv_ch');
    const warn = console.warn; console.warn = () => {};
    try { pb.invalidate(); pb.routeSend('adv_ch', 5); } finally { console.warn = warn; }
    return sib.textContent;
  })()`);
  ok(mutThrow === '5', `throwing mutator is caught and does not halt sibling receiver (got ${JSON.stringify(mutThrow)})`);

  const varLoop = await js(`(() => {
    const v = node('variable', 200, 450, { value: 'loopv', 'data-scv-emits': 'loop_a', 'data-scv-receives': 'loop_b' });
    node('mutator', 400, 450, { value: 'v + 1', 'data-scv-receives': 'loop_a', 'data-scv-emits': 'loop_b' });
    pb.invalidate();
    const warn = console.warn; console.warn = () => {};
    const t0 = performance.now();
    try { v.receive(1, 'x'); } catch (e) { return { threw: e.message }; } finally { console.warn = warn; }
    return { ms: performance.now() - t0 };
  })()`);
  ok(varLoop && !varLoop.threw && varLoop.ms < 1000, `emitting-variable feedback loop terminates via hop guard (${JSON.stringify(varLoop)})`);

  const xss = await js(`(() => {
    window.__xss = false;
    const r = sink('xss_ch'); pb.invalidate();
    pb.routeSend('xss_ch', '<img src=x onerror="window.__xss=true">');
    return { childImgs: r.querySelectorAll('img').length, executed: window.__xss };
  })()`);
  ok(xss && xss.childImgs === 0 && xss.executed === false, `routed markup is inert text, not executed (${JSON.stringify(xss)})`);

  ok(await js(`(() => { try { const n = pb.children.length; pb.import('<div>totally not a scavenger payload</div>'); return pb.children.length === n; } catch (e) { return false; } })()`), 'garbage paste does not throw, adds nothing');
  ok(await js(`(() => { try { return pb.import('<html><body>no node here</body></html>').length === 0; } catch (e) { return false; } })()`), 'file with no def imports nothing, no throw');
  ok(await js(`(() => { const warn = console.warn; console.warn = () => {}; try { pb.import('<script data-scv-node>defineNode({ /* missing name */ icon: "x" })<\\/script>'); return true; } catch (e) { return false; } finally { console.warn = warn; } })()`), 'node file whose def is invalid is caught');
  ok(await js(`(() => { const warn = console.warn; console.warn = () => {}; try { pb.import('<script data-scv-node>this is not javascript (<\\/script>'); return true; } catch (e) { return false; } finally { console.warn = warn; } })()`), 'node file that does not parse is caught');
  ok(await js(`(() => { const warn = console.warn; console.warn = () => {}; try { pb.import('<template data-scv-comp="brk"><b>x</b><script>this is ( broken<\\/script></template>'); return !!customElements.get('scv-brk'); } catch (e) { return false; } finally { console.warn = warn; } })()`), 'component whose script does not parse still defines, no throw');

  ok(await js(`(() => { try { for (let i = 0; i < 200; i++) pb.undo(); for (let i = 0; i < 200; i++) pb.redo(); return true; } catch (e) { return false; } })()`), 'undo/redo past stack bounds never throws');
  ok(await js(`(() => { try { const r = sink('big_ch'); pb.invalidate(); pb.routeSend('big_ch', 'z'.repeat(1000000)); return r.textContent.length === 1000000; } catch (e) { return false; } })()`), '1MB routed value is handled');

  const nan = await js(`(() => { const a = node('accumulator', 600, 300); a.receive('not-a-number', 'x'); return a.getAttribute('value'); })()`);
  ok(nan === '0', `accumulator treats non-numeric received value as 0, not NaN (got ${JSON.stringify(nan)})`);

  const storm = await js(`(async () => {
    try {
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await frame(); const baseline = pb.cables().length;
      const nodes = [];
      for (let i = 0; i < 40; i++) nodes.push(node('gate', 50 + i, 600));
      for (let i = 1; i < nodes.length; i++) pb.wire(nodes[i - 1], nodes[i]);
      await frame(); const peak = pb.cables().length;
      nodes.forEach(n => n.remove());
      await frame();
      return { baseline, peak, remaining: pb.cables().length, paths: pb.shadowRoot.querySelectorAll('.cable').length };
    } catch (e) { return { threw: e.message }; }
  })()`);
  ok(storm && !storm.threw && storm.peak === storm.baseline + 39, `40-node spawn+wire+delete storm doesn't crash (${JSON.stringify(storm)})`);
  ok(storm && storm.remaining === storm.baseline && storm.paths === storm.baseline, `deleting every node also clears cables it added (${JSON.stringify(storm)})`);

  const stillWorks = await js(`(() => { const r = sink('ok_ch'); pb.invalidate(); pb.routeSend('ok_ch', 'healthy'); return r.textContent; })()`);
  ok(stillWorks === 'healthy', `patchbay still routes normally after all abuse (got ${JSON.stringify(stillWorks)})`);

  await delay(300); // late async or timer exception may still be in flight over cdp
  ok(uncaught.length === 0, `no uncaught exceptions across all adversarial cases (${uncaught.slice(0, 3).join(' | ')})`);
} catch (e) {
  fails++; console.log('  ✗ adversarial tier threw:', e.message);
}

done();
console.log(fails ? `adversarial: FAIL (${fails})` : 'adversarial: PASS');
process.exit(fails ? 1 : 0);
