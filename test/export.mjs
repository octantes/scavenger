// export tier - every logic node type + both export formats round-tripped (saveQuine, exportPublish) + cable geometry

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync, rmSync } from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const pbUrl = pathToFileURL(join(here, '..', 'patchbay.html')).href;
const ALL_NODES = ['clock', 'accumulator', 'gate', 'comparator', 'mutator', 'variable', 'action', 'reader', 'quest'];

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable');
const js = async (e, aw = false) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const load = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await delay(400); };
const tmpFiles = [];
const done = () => { try { ws.close(); } catch {} cleanup(); tmpFiles.forEach(f => { try { rmSync(f, { force: true }); } catch {} }); };

try { // first check each node type behaves
  await load(pbUrl);
  await js(`setMode('edit'); true`);

  // gate: closed passes nothing, 1 opens it, then values pass through
  const gate = await js(`(() => {
    const g = spawnLogicNode('gate', 100, 100); g.setAttribute('data-scv-emits', 'g_out');
    const r = document.createElement('div'); r.id = 'g_rcv'; r.setAttribute('data-scv-receives', 'g_out'); zoomLayer.appendChild(r);
    invalidateCache();
    g.dispatchEvent(new CustomEvent('scv-receive', { detail: 'blocked' })); // closed > nothing passes
    const whenClosed = document.getElementById('g_rcv').textContent;
    g.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // open
    g.dispatchEvent(new CustomEvent('scv-receive', { detail: 'passed' })); // now passes
    return { whenClosed, whenOpen: document.getElementById('g_rcv').textContent };
  })()`);
  ok(gate && gate.whenClosed === '' && gate.whenOpen === 'passed', `gate blocks closed, passes open (${JSON.stringify(gate)})`);

  // reader: stores value, re-emits it on 1 trigger
  const reader = await js(`(() => {
    const rd = spawnLogicNode('reader', 100, 200); rd.setAttribute('data-scv-emits', 'r_out');
    const r = document.createElement('div'); r.id = 'r_rcv'; r.setAttribute('data-scv-receives', 'r_out'); zoomLayer.appendChild(r);
    invalidateCache();
    rd.dispatchEvent(new CustomEvent('scv-receive', { detail: 77 })); // store (no emit)
    const beforeTrigger = document.getElementById('r_rcv').textContent;
    rd.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // trigger > re-emit stored
    return { beforeTrigger, afterTrigger: document.getElementById('r_rcv').textContent };
  })()`);
  ok(reader && reader.beforeTrigger === '' && reader.afterTrigger === '77', `reader stores then re-emits on trigger (${JSON.stringify(reader)})`);

  // variable + mutator: variable names its value into shared store; mutator reads it
  const varMut = await js(`(() => {
    const v = spawnLogicNode('variable', 100, 300); v.querySelector('.scv-logic-input').value = 'freq';
    v.dispatchEvent(new CustomEvent('scv-receive', { detail: 10 })); // freq = 10
    const m = spawnLogicNode('mutator', 300, 300); m.querySelector('.scv-logic-input').value = 'v + freq';
    m.setAttribute('data-scv-emits', 'vm_out');
    const r = document.createElement('div'); r.id = 'vm_rcv'; r.setAttribute('data-scv-receives', 'vm_out'); zoomLayer.appendChild(r);
    invalidateCache();
    m.dispatchEvent(new CustomEvent('scv-receive', { detail: 5 })); // 5 + freq(10) = 15
    return document.getElementById('vm_rcv').textContent;
  })()`);
  ok(String(varMut) === '15', `variable feeds named value mutator reads (v + freq → 15, got ${varMut})`);

  // variable emits on (re)assignment - fans out like source, but name edit must not fire phantom value
  const varEmit = await js(`(() => {
    const v = spawnLogicNode('variable', 100, 350); v.querySelector('.scv-logic-input').value = 'pulse';
    const ch = v.getAttribute('data-scv-emits'); // default source channel present
    const r = document.createElement('div'); r.id = 've_rcv'; r.setAttribute('data-scv-receives', ch); zoomLayer.appendChild(r);
    invalidateCache();
    v.dispatchEvent(new CustomEvent('scv-receive', { detail: 'a' })); // assign > emits
    const assigned = document.getElementById('ve_rcv').textContent;
    v.dispatchEvent(new CustomEvent('scv-receive', { detail: 'b' })); // reassign (let=live) > emits
    const reassigned = document.getElementById('ve_rcv').textContent;
    document.getElementById('ve_rcv').textContent = '';
    v.querySelector('.scv-logic-input').value = 'pulse2'; // rename > must not emit
    v.querySelector('.scv-logic-input').dispatchEvent(new Event('input', { bubbles: true }));
    return { hasChannel: !!ch, assigned, reassigned, afterRename: document.getElementById('ve_rcv').textContent };
  })()`);
  ok(varEmit && varEmit.hasChannel && varEmit.assigned === 'a' && varEmit.reassigned === 'b' && varEmit.afterRename === '',
    `variable emits on (re)assignment as router, no phantom on rename (${JSON.stringify(varEmit)})`);

  // action: applies verb (increment) to plain receiver
  const action = await js(`(() => {
    const a = spawnLogicNode('action', 100, 400); a.querySelector('.scv-logic-input').value = 'increment';
    const ch = a.getAttribute('data-scv-emits');
    const inp = document.createElement('input'); inp.id = 'a_rcv'; inp.value = '5'; inp.setAttribute('data-scv-receives', ch); zoomLayer.appendChild(inp);
    invalidateCache();
    a.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // fire verb
    return document.getElementById('a_rcv').value;
  })()`);
  ok(String(action) === '6', `action 'increment' bumps its receiver 5 → 6 (got ${action})`);

  // clock: clicking icon emits 1 tick
  const clock = await js(`(() => {
    const c = spawnLogicNode('clock', 100, 500); c.setAttribute('data-scv-emits', 'c_out');
    const acc = spawnLogicNode('accumulator', 300, 500); acc.setAttribute('data-scv-receives', 'c_out');
    acc.querySelector('.scv-logic-input').value = '0';
    invalidateCache();
    c.querySelector('.scv-logic-icon').click(); // manual tick > emits 1
    return acc.querySelector('.scv-logic-input').value;
  })()`);
  ok(String(clock) === '1', `clock icon-click emits tick accumulator counts (got ${clock})`);

  // cable geometry: real cubic bezier anchored on node edges
  const geom = await js(`(() => {
    const a = spawnLogicNode('reader', 200, 700), b = spawnLogicNode('accumulator', 600, 700);
    autoWire(a, b); renderCables();
    const p = [...document.querySelectorAll('#static-cables .cable-path')].pop();
    const d = p.getAttribute('d');
    const nums = (d.match(/-?[\\d.]+/g) || []).map(Number);
    const m = d.match(/^M\\s*(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+C/); // starts with moveto then cubic
    const ar = getNodeRect(a), br = getNodeRect(b);
    const sx = m ? +m[1] : NaN, sy = m ? +m[2] : NaN;
    return {
      hasCubic: /C/.test(d),
      allFinite: nums.every(Number.isFinite),
      startNearSource: Math.abs(sx - ar.x) < 60 && Math.abs(sy - ar.y) < 60, // anchors on source, not origin
      startsOffCenter: Math.hypot(sx - ar.x, sy - ar.y) > 4, // on edge, not dead centre
      goesToward: sx < br.x, // heads toward target (to its right)
    };
  })()`);
  ok(geom && geom.hasCubic && geom.allFinite, `cable path is finite cubic Bézier (${JSON.stringify(geom)})`);
  ok(geom && geom.startNearSource && geom.startsOffCenter && geom.goesToward, `cable anchors on source edge and heads to target (${JSON.stringify(geom)})`);

  // build canonical board: one of every node type + computing pipeline
  const built = await js(`(() => {
    document.querySelectorAll('scv-logic, .comp-wrapper, [id$="_rcv"]').forEach(n => n.remove());
    invalidateCache();
    const made = {};
    ${JSON.stringify(ALL_NODES)}.forEach((t, i) => { const n = spawnLogicNode(t, 100 + i * 60, 100); n.dataset.scvId = 'nt_' + t; made[t] = true; });
    // live pipeline: reader(5) > mutator(v*2) > accumulator  (survives both exports)
    const rd = document.querySelector('scv-logic[data-scv-id="nt_reader"]'); rd.querySelector('.scv-logic-input').value = '5';
    const mu = document.querySelector('scv-logic[data-scv-id="nt_mutator"]'); mu.querySelector('.scv-logic-input').value = 'v * 2';
    const ac = document.querySelector('scv-logic[data-scv-id="nt_accumulator"]'); ac.querySelector('.scv-logic-input').value = '0';
    autoWire(rd, mu); autoWire(mu, ac);
    rd.dispatchEvent(new CustomEvent('scv-receive', { detail: 5 })); // store 5 (post-spawn input set doesn't seed _storedValue)
    return Object.keys(made).length;
  })()`);
  ok(built === ALL_NODES.length, `board built with all ${ALL_NODES.length} node types`);

  // pipeline computes live: trigger reader > 5 > *2 > accumulator = 10
  const liveCompute = await js(`(() => {
    const rd = document.querySelector('scv-logic[data-scv-id="nt_reader"]');
    const ac = document.querySelector('scv-logic[data-scv-id="nt_accumulator"]');
    ac.querySelector('.scv-logic-input').value = '0';
    rd.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // reader re-emits 5 > mutator*2 > accumulator
    return ac.querySelector('.scv-logic-input').value;
  })()`);
  ok(String(liveCompute) === '10', `pipeline computes live before export (reader 5 → *2 → 10, got ${liveCompute})`);

  // cable geometry: vertical layout stays finite/anchored; near-overlap > null (skipped)
  const geom2 = await js(`(() => {
    const a = spawnLogicNode('reader', 1500, 100), b = spawnLogicNode('accumulator', 1500, 500); // vertical
    autoWire(a, b); renderCables();
    const p = [...document.querySelectorAll('#static-cables .cable-path')].pop();
    const d = p.getAttribute('d'); const finite = (d.match(/-?[\\d.]+/g) || []).map(Number).every(Number.isFinite);
    const ar = getNodeRect(a), br = getNodeRect(b); const m = d.match(/^M\\s*(-?[\\d.]+)\\s+(-?[\\d.]+)/);
    const vertical = m && Math.abs((+m[2]) - ar.y) < 60 && (+m[2]) < br.y; // starts near source, heads down
    // zero-size (component) endpoints 1px apart > edge gap <2px > cableArrow returns null
    const tooClose = cableArrow(100, 100, 0, 0, 101, 100, 0, 0, null, null);
    return { finite, vertical, tooCloseNull: tooClose === null };
  })()`);
  ok(geom2 && geom2.finite && geom2.vertical, `cable geometry holds for vertical layout (${JSON.stringify(geom2)})`);
  ok(geom2 && geom2.tooCloseNull, `cableArrow returns null for near-overlapping nodes (caller skips cable)`);

  // capture both exports
  const capture = async (fnName) => js(`(async () => {
    let blob = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    URL.createObjectURL = b => { blob = b; return 'blob:x'; }; URL.revokeObjectURL = () => {};
    await ${fnName}();
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
    return blob ? await blob.text() : null;
  })()`, true);
  const quineHtml = await capture('saveQuine');
  const publishHtml = await capture('exportPublish');
  ok(typeof quineHtml === 'string' && quineHtml.includes('data-scv-runtime'), 'saveQuine produced stamped quine');
  ok(typeof publishHtml === 'string' && publishHtml.includes('data-scv-runtime'), 'exportPublish produced stamped artifact');
  // header shape matches the source html files: doctype/license line, blank line, then <html>
  ok(/-->\n\n<html lang="en"/.test(quineHtml || ''), 'quine header is doctype/license, blank line, then <html lang="en">');
  ok(/-->\n\n<html lang="en"/.test(publishHtml || ''), 'publish header is doctype/license, blank line, then <html lang="en">');

  // transient interaction classes and nested wrappers must not leak into publish
  await load(pbUrl); await js(`setMode('edit'); true`);
  const hygiene = await js(`(async () => {
    const outer = document.createElement('div');
    outer.className = 'comp-wrapper'; outer.style.left = '50px'; outer.style.top = '50px';
    const host = document.createElement('div'); host.dataset.scvId = 'w_outer'; outer.appendChild(host);
    const inner = document.createElement('div');
    inner.className = 'comp-wrapper'; inner.style.left = '20px'; inner.style.top = '20px';
    const ihost = document.createElement('div'); ihost.dataset.scvId = 'w_inner'; inner.appendChild(ihost);
    outer.appendChild(inner);
    document.getElementById('zoom-layer').appendChild(outer);
    // paint transient interaction state on board
    outer.classList.add('selected'); inner.classList.add('dimmed');
    outer.querySelector('[data-scv-id]').classList.add('wire-danger');
    let blob = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    URL.createObjectURL = b => { blob = b; return 'blob:x'; }; URL.revokeObjectURL = () => {};
    await exportPublish();
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
    const html = blob ? await blob.text() : '';
    return {
      published: !!html,
      hasSel: /class="[^"]*\\bselected\\b/.test(html),
      hasDim: /class="[^"]*\\bdimmed\\b/.test(html),
      hasDanger: /class="[^"]*\\bwire-danger\\b/.test(html),
      wrapperCount: (html.match(/class="[^"]*\\bcomp-wrapper\\b/g) || []).length,
      html,
    };
  })()`, true);
  ok(hygiene && hygiene.published && !hygiene.hasSel && !hygiene.hasDim && !hygiene.hasDanger,
    `publish strips transient interaction classes (#126 ${JSON.stringify(hygiene)})`);
  ok(hygiene && hygiene.wrapperCount === 2, `publish ships nested wrapper inside its parent's clone - no standalone copy (#342 got ${JSON.stringify(hygiene)})`);

  // transient dom, not just transient classes - value bubble caught mid-fade must not freeze into export
  await load(pbUrl);
  const bubbles = await js(`(async () => {
    setMode('edit');
    const n = spawnLogicNode('accumulator', 120, 120);
    n._showFloat('7'); // pin bubble - this is what saving during tick captures
    const grab = async fn => {
      let blob = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
      URL.createObjectURL = b => { blob = b; return 'blob:x'; }; URL.revokeObjectURL = () => {};
      await fn(); URL.createObjectURL = oc; URL.revokeObjectURL = orv;
      return blob ? await blob.text() : '';
    };
    const read = h => { const d = new DOMParser().parseFromString(h, 'text/html');
      return { floats: d.querySelectorAll('.scv-logic-float').length, empty: d.querySelectorAll('[class=""]').length }; };
    const live = document.querySelectorAll('.scv-logic-float').length;
    return { live, quine: read(await grab(saveQuine)), publish: read(await grab(exportPublish)) };
  })()`, true);
  ok(bubbles && bubbles.live === 1, `value bubble is live on board before export (got ${JSON.stringify(bubbles)})`);
  ok(bubbles && bubbles.quine.floats === 0 && bubbles.publish.floats === 0,
    `neither export freezes transient value bubble (got ${JSON.stringify(bubbles)})`);
  ok(bubbles && bubbles.quine.empty === 0 && bubbles.publish.empty === 0,
    `neither export carries empty class attribute (got ${JSON.stringify(bubbles)})`);
  const nestedNest = await js(`(() => {
    const d = new DOMParser().parseFromString(${JSON.stringify(hygiene && hygiene.html || '')}, 'text/html');
    const outer = d.querySelector('[data-scv-id="w_outer"]');
    const inner = d.querySelector('[data-scv-id="w_inner"]');
    const innerW = inner && inner.closest('.comp-wrapper');
    const outerW = innerW && innerW.parentElement && innerW.parentElement.closest('.comp-wrapper');
    const insideOuter = !!outer && !!innerW && !!outerW && !!outerW.querySelector('[data-scv-id="w_outer"]');
    const noStandalone = !!d.querySelector('#canvas-container') &&
      ![...d.querySelector('#canvas-container').children].some(el => el === innerW);
    return insideOuter && noStandalone;
  })()`);
  ok(nestedNest && nestedNest === true, `nested wrapper is nested under its parent's clone in artifact`);
  await load(pbUrl); await js(`setMode('edit'); true`);

  // studio-only workshop chrome (intro menu/backdrop/bg picker) must never leak into export - authoring aids
  for (const [label, h] of [['quine', quineHtml], ['publish', publishHtml]]) {
    ok(!/id="intro-menu"/.test(h), `${label}: excludes #intro-menu onboarding chrome`);
    ok(!/id="intro-backdrop"/.test(h), `${label}: excludes #intro-backdrop`);
    ok(!/id="bg-dot"/.test(h), `${label}: excludes #bg-dot background picker`);
  }

  // helper: reopen exported doc and assert node survival + live pipeline + studio presence
  const reopenAndCheck = async (html, label, expectStudio) => {
    const f = join(tmpdir(), `scv-${label}-${Date.now()}.html`); tmpFiles.push(f); writeFileSync(f, html);
    await load(pathToFileURL(f).href);
    const r = await js(`(() => {
      const present = ${JSON.stringify(ALL_NODES)}.filter(t => document.querySelector('scv-logic[data-scv-id="nt_' + t + '"]'));
      const rd = document.querySelector('scv-logic[data-scv-id="nt_reader"]');
      const ac = document.querySelector('scv-logic[data-scv-id="nt_accumulator"]');
      let acVal = null;
      if (rd && ac) { ac.querySelector('.scv-logic-input').value = '0'; rd.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); acVal = ac.querySelector('.scv-logic-input').value; }
      return { count: present.length, present, acVal, hasStudio: typeof window.setMode === 'function', hasRouterNodes: !!document.querySelector('scv-logic') };
    })()`);
    ok(r && r.count === ALL_NODES.length, `${label}: all ${ALL_NODES.length} node types survived (got ${r && r.count}: ${JSON.stringify(r && r.present)})`);
    ok(r && String(r.acVal) === '10', `${label}: live pipeline still computes 10 after reopen (got ${r && r.acVal})`);
    ok(r && r.hasStudio === expectStudio, `${label}: studio ${expectStudio ? 'present' : 'absent'} as expected (got ${r && r.hasStudio})`);
  };

  await reopenAndCheck(quineHtml, 'quine', true); // quine = editor + state
  await reopenAndCheck(publishHtml, 'publish', false); // publish = runtime only (no studio globals)

  // custom .scv node survives export: def embedded, instance re-registers + runs (last, fresh page)
  await load(pbUrl); await js(`setMode('edit'); true`);
  const scv = `<!doctype html><script data-scv-node>typeof defineNode==='function' && defineNode({ name:'tripler', icon:'x3', color:'#8ab6bb', onReceive(v,ctx){ ctx.emit(Number(v)*3); } })</scr` + `ipt>`;
  const custom = await js(`(async () => {
    const type = registerScvNodeFile(${JSON.stringify(scv)});
    const n = spawnLogicNode('tripler', 100, 100); n.dataset.scvId = 'nt_custom'; n.setAttribute('data-scv-emits', 'cx_out');
    let blob = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    URL.createObjectURL = b => { blob = b; return 'blob:x'; }; URL.revokeObjectURL = () => {};
    await saveQuine();
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
    return { type, quine: blob ? await blob.text() : null };
  })()`, true);
  ok(custom && custom.type === 'tripler', `custom .scv registered its type (got ${custom && custom.type})`);
  ok(custom && /data-scv-node/.test(custom.quine || '') && /tripler/.test(custom.quine || ''), 'saveQuine embeds custom node definition script');
  if (custom && typeof custom.quine === 'string') {
    const cf = join(tmpdir(), 'scv-custom-' + Date.now() + '.html'); tmpFiles.push(cf); writeFileSync(cf, custom.quine);
    await load(pathToFileURL(cf).href);
    const ran = await js(`(() => {
      const cls = customElements.get('scv-logic');
      const has = !!(cls && cls.nodeTypes && cls.nodeTypes.tripler);
      const n = document.querySelector('scv-logic[data-scv-id="nt_custom"]');
      const r = document.createElement('div'); r.setAttribute('data-scv-receives', 'cx_out'); (document.getElementById('zoom-layer') || document.body).appendChild(r);
      invalidateCache && invalidateCache();
      let out = null; if (n) { n.dispatchEvent(new CustomEvent('scv-receive', { detail: 4 })); out = r.textContent; }
      return { has, out };
    })()`);
    ok(ran && ran.has, 'reopened quine re-registers custom node type');
    ok(ran && String(ran.out) === '12', `custom node runs after reopen (4 × 3 = 12, got ${ran && ran.out})`);
  }

  // wiring on sub-element inside harvested component's shadow must survive publish, not be rebuilt over by def
  await load(pbUrl);
  // same shape kernel.js harvest emits, shadowRoot guard included
  const harvestSrc = '<!-- AUTHOR: t --><scv-sw data-scv-component></scv-sw><script data-scv-def>'
    + 'if(!customElements.get("scv-sw")){customElements.define("scv-sw",class extends HTMLElement{'
    + 'constructor(){super();if(this.shadowRoot)return;'
    + 'this.attachShadow({mode:"open"}).innerHTML=`<style>:host{display:block}</style><span id="disp">idle</span>`}})}'
    + '</scr' + 'ipt>';
  const shadowWire = await js(`(async () => {
    setMode('edit');
    handlePasteData(${JSON.stringify(harvestSrc)});
    const host = document.querySelector('.comp-wrapper [data-scv-id]');
    host.shadowRoot.getElementById('disp').setAttribute('data-scv-receives', 'sw_ch'); // wire a shadow sub-element, as a cable drag does
    const src = spawnLogicNode('reader', 100, 100); src.setAttribute('data-scv-emits', 'sw_ch');
    src.dispatchEvent(new CustomEvent('scv-receive', { detail: 21 }));
    invalidateCache();
    src.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // trigger > re-emits 21 into shadow span
    const live = host.shadowRoot.getElementById('disp').textContent;
    let blob = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
    URL.createObjectURL = b => { blob = b; return 'blob:x'; }; URL.revokeObjectURL = () => {};
    await exportPublish();
    URL.createObjectURL = oc; URL.revokeObjectURL = orv;
    return { live, html: blob ? await blob.text() : null };
  })()`, true);
  ok(shadowWire && shadowWire.live === '21', `shadow sub-element receives on live board (got ${shadowWire && shadowWire.live})`);
  ok(shadowWire && /data-scv-receives="sw_ch"/.test(shadowWire.html || ''), 'publish serializes shadow sub-element wiring into declarative shadow root');
  if (shadowWire && typeof shadowWire.html === 'string') {
    const sf = join(tmpdir(), 'scv-shadowwire-' + Date.now() + '.html'); tmpFiles.push(sf); writeFileSync(sf, shadowWire.html);
    await load(pathToFileURL(sf).href);
    const pub = await js(`(() => {
      const host = document.querySelector('.comp-wrapper [data-scv-id]');
      const span = host && host.shadowRoot && host.shadowRoot.getElementById('disp');
      if (!span) return { err: 'no shadow span' };
      const wired = span.getAttribute('data-scv-receives');
      const n = document.querySelector('scv-logic[data-type="reader"]');
      n.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // re-emit the frozen 21 into the shadow
      return { wired, out: span.textContent, stray: !!host.querySelector('template') };
    })()`);
    ok(pub && pub.wired === 'sw_ch', `reopened publish keeps shadow wiring, def does not rebuild over it (got ${JSON.stringify(pub)})`);
    ok(pub && !pub.stray, `declarative shadow root actually attached, no stray <template> left in light dom (got ${JSON.stringify(pub)})`);
    ok(pub && pub.out === '21', `published artifact routes into shadow sub-element (got ${JSON.stringify(pub)})`);
  }
  await load(pbUrl);
  const prune = await js(`(async () => {
    setMode('edit');
    let cap = ''; window._downloadDoc = h => { cap = h; };
    const quine = async () => { await saveQuine(); return cap; };
    const TAG = 'scv-pruneprobe', PAD = 'B'.repeat(20000);
    const mkDef = (tag) => {
      const s = document.createElement('script');
      s.setAttribute('data-scv-def', 'true'); s.setAttribute('data-scv-tag', tag);
      s.textContent = 'if(!customElements.get("' + tag + '")){customElements.define("' + tag + '", class extends HTMLElement{'
        + 'constructor(){super(); if(this.shadowRoot) return;'
        + 'this.attachShadow({mode:"open"}).innerHTML = "<style>/*' + PAD + '*/</style><b>probe</b>";}});}';
      document.body.appendChild(s); injectedScripts.add(tag);
    };
    const has = (h, tag) => h.includes('data-scv-tag="' + tag + '"');
    mkDef(TAG);
    const w = document.createElement('div'); w.className = 'comp-wrapper'; w.style.left = '60px'; w.style.top = '60px';
    const el = document.createElement(TAG); el.dataset.scvId = 'probe1'; w.appendChild(el); zoomLayer.appendChild(w);
    await new Promise(r => setTimeout(r, 250));
    const withIt = await quine();
    deleteElementWithUndo(w, w.querySelector('[data-scv-id]'));
    await new Promise(r => setTimeout(r, 250));
    const deleted = await quine();
    const liveDefKept = !!document.querySelector('script[data-scv-def][data-scv-tag="' + TAG + '"]');
    undo();
    await new Promise(r => setTimeout(r, 350));
    const back = document.querySelector(TAG);
    const restored = await quine();
    return {
      inWhenUsed: has(withIt, TAG), goneWhenDeleted: !has(deleted, TAG), backAfterUndo: has(restored, TAG),
      liveDefKept, undoElement: !!back, undoShadow: back?.shadowRoot?.querySelector('b')?.textContent || null,
      shed: withIt.length - deleted.length,
    };
  })()`, true);
  ok(prune && prune.inWhenUsed, 'component def ships while instance is on board');
  ok(prune && prune.goneWhenDeleted, `deleting last instance drops its def from quine (shed ${prune && prune.shed} bytes)`);
  ok(prune && prune.liveDefKept, 'live document keeps def - only export drops it');
  ok(prune && prune.undoElement && prune.undoShadow === 'probe', `undo right after delete restores component and its shadow (${JSON.stringify(prune && prune.undoShadow)})`);
  ok(prune && prune.backAfterUndo, 'and def is back in quine once instance is');

  const pruneNested = await js(`(async () => {
    setMode('edit');
    let cap = ''; window._downloadDoc = h => { cap = h; };
    const OUTER = 'scv-outerprobe', INNER = 'scv-innerprobe';
    [OUTER, INNER].forEach(tag => {
      const s = document.createElement('script');
      s.setAttribute('data-scv-def', 'true'); s.setAttribute('data-scv-tag', tag);
      s.textContent = 'if(!customElements.get("' + tag + '")){customElements.define("' + tag + '", class extends HTMLElement{'
        + 'constructor(){super(); if(this.shadowRoot) return; this.attachShadow({mode:"open"}).innerHTML = "'
        + (tag === OUTER ? '<' + INNER + '></' + INNER + '>' : '<i>deep</i>') + '";}});}';
      document.body.appendChild(s); injectedScripts.add(tag);
    });
    const w = document.createElement('div'); w.className = 'comp-wrapper'; w.style.left = '80px'; w.style.top = '300px';
    const el = document.createElement(OUTER); el.dataset.scvId = 'outer1'; w.appendChild(el); zoomLayer.appendChild(w);
    await new Promise(r => setTimeout(r, 300));
    await saveQuine();
    return { outer: cap.includes('data-scv-tag="' + OUTER + '"'), inner: cap.includes('data-scv-tag="' + INNER + '"') };
  })()`, true);
  ok(pruneNested && pruneNested.outer, 'outer component def ships');
  ok(pruneNested && pruneNested.inner, 'def whose only instance lives inside another component shadow is not pruned');

  const pruneDecoy = await js(`(async () => {
    setMode('edit');
    let cap = ''; window._downloadDoc = h => { cap = h; };
    const scv = '<html><body><scr' + 'ipt data-scv-node>typeof defineNode === "function" && defineNode({'
      + 'modes: [{ id: "m1", name: "decoyname" }], name: "realname", icon: "R", color: "#888", init(ctx) {} });</scr' + 'ipt></body></html>';
    const type = registerScvNodeFile(scv);
    const n = spawnLogicNode(type, 300, 2600);
    await new Promise(r => setTimeout(r, 250));
    await saveQuine();
    return { type, live: !!document.querySelector('scv-logic[data-type="realname"]'), kept: cap.includes('decoyname') };
  })()`, true);
  ok(pruneDecoy && pruneDecoy.type === 'realname' && pruneDecoy.live, 'decoy fixture registers under its real name');
  ok(pruneDecoy && pruneDecoy.kept, 'nested name: earlier in source does not decide def is unused');

  // authored component must stay live after reopen - script reruns + rebinds, not just frozen shadow surviving
  await load(pbUrl);
  const emitDef = "<scv-emitprobe data-scv-component></scv-emitprobe>\n"
    + '<script data-scv-comp data-scv-tag="scv-emitprobe">\n'
    + "customElements.define('scv-emitprobe', class extends HTMLElement { constructor() { super();\n"
    + "const _baked = !this.shadowRoot && this.querySelector('template[shadowrootmode], template.custom-shadow');\n"
    + "if (_baked) { this.attachShadow({mode: 'open'}).innerHTML = _baked.innerHTML; _baked.remove(); }\n"
    + "else if (!this.shadowRoot) this.attachShadow({mode: 'open'}).innerHTML = `<button id=\"b\">go</button>`;\n"
    + "const root = this.shadowRoot, host = this, emit = v => this.dispatchEvent(new CustomEvent('scv-emit', { detail: v, bubbles: true, composed: true }));\n"
    + "root.getElementById('b').addEventListener('click', () => emit('EP_LIVE'));\n"
    + "}\nconnectedCallback() { this.setAttribute('data-scv-emitter', ''); } });\n"
    + "<\/script>";
  const tripDef = "<!doctype html><script data-scv-node>typeof defineNode==='function' && defineNode({ name:'triplerx', icon:'x3', color:'#8ab6bb', onReceive(v,ctx){ ctx.emit(Number(v)*3); } })<\/script>";
  const emitBuild = await js(`(async () => {
    setMode('edit');
    const tag = registerComponentFile(${JSON.stringify(emitDef)});
    spawnComponent(tag, 120, 3200);
    await new Promise(r => setTimeout(r, 300));
    const rd = spawnLogicNode('reader', 460, 3200); rd.dataset.scvId = 'nt_emitrd';
    const host = document.querySelector('scv-emitprobe'); // emits on host, where emitter mark is, so the raw-click guard suppresses button's empty value
    host.setAttribute('data-scv-emits', 'ep_ch'); rd.setAttribute('data-scv-receives', 'ep_ch');
    registerScvNodeFile(${JSON.stringify(tripDef)}); // custom node alongside, to test both revive together on paste
    const trip = spawnLogicNode('triplerx', 120, 3400); trip.setAttribute('data-scv-emits', 'tp_ch');
    const trd = spawnLogicNode('reader', 460, 3400); trd.setAttribute('data-scv-receives', 'tp_ch');
    invalidateCache();
    const grab = async fn => { let blob = null; const oc = URL.createObjectURL, orv = URL.revokeObjectURL;
      URL.createObjectURL = b => { blob = b; return 'blob:x'; }; URL.revokeObjectURL = () => {};
      await fn(); URL.createObjectURL = oc; URL.revokeObjectURL = orv; return blob ? await blob.text() : null; };
    return { quine: await grab(saveQuine), publish: await grab(exportPublish) };
  })()`, true);
  const emitReopen = async (html, label) => {
    const f = join(tmpdir(), 'scv-emitlive-' + label + '-' + Date.now() + '.html'); tmpFiles.push(f); writeFileSync(f, html);
    await load(pathToFileURL(f).href); await delay(400);
    const r = await js(`(() => {
      if (typeof setMode === 'function') setMode('use'); // reopened quine is in edit mode - flip to use to exercise running dashboard
      const cell = document.querySelector('scv-emitprobe');
      const rd = document.querySelector('scv-logic[data-scv-id="nt_emitrd"]');
      if (!cell || !cell.shadowRoot) return { err: 'no cell shadow' };
      cell.shadowRoot.getElementById('b').click(); // fires only if component script rebound listener on reopen
      return { stored: rd ? rd._storedValue : 'no-reader' };
    })()`);
    ok(r && r.stored === 'EP_LIVE', `${label}: authored component script reruns on reopen, emit routes (got ${JSON.stringify(r)})`);
  };
  if (emitBuild && emitBuild.quine) await emitReopen(emitBuild.quine, 'quine');
  if (emitBuild && emitBuild.publish) await emitReopen(emitBuild.publish, 'publish');

  // pasting exported file into fresh board must revive custom node and .scv component on both exports
  const pasteParity = async (html, label) => {
    if (!html) return;
    await load(pbUrl);
    const r = await js(`(async () => {
      setMode('edit');
      handlePasteData(${JSON.stringify(html)});
      await new Promise(r => setTimeout(r, 500));
      setMode('use'); // exercise pasted board in use mode
      const readers = () => [...document.querySelectorAll('scv-logic[data-type="reader"]')].map(r => r._storedValue);
      const trip = document.querySelector('scv-logic[data-type="triplerx"]');
      if (trip) trip.dispatchEvent(new CustomEvent('scv-receive', { detail: 4 })); // node live > 12 lands
      const nodeLive = readers().includes(12);
      const cell = document.querySelector('scv-emitprobe');
      if (cell && cell.shadowRoot) cell.shadowRoot.getElementById('b').click(); // component live > EP_LIVE lands
      const compLive = readers().includes('EP_LIVE');
      return { nodeLive, compLive };
    })()`, true);
    ok(r && r.nodeLive, `${label} paste revives custom node (got ${JSON.stringify(r)})`);
    ok(r && r.compLive, `${label} paste revives .scv component (got ${JSON.stringify(r)})`);
  };
  if (emitBuild) { await pasteParity(emitBuild.quine, 'quine'); await pasteParity(emitBuild.publish, 'publish'); }

  await load(pbUrl);
  const quineOf = async () => await js(`(async () => { let cap = ''; window._downloadDoc = h => { cap = h; }; await saveQuine(); return cap; })()`, true);
  await js(`(() => {
    setMode('edit');
    document.querySelectorAll('scv-logic, .comp-wrapper').forEach(n => n.remove());
    const c = spawnLogicNode('clock', 100, 100), a = spawnLogicNode('accumulator', 320, 100);
    autoWire(c, a); invalidateCache(); renderCables(); return true;
  })()`);
  const g1 = await quineOf();
  const f1 = join(tmpdir(), 'scv-fp1.html'); writeFileSync(f1, g1); tmpFiles.push(f1);
  await load(pathToFileURL(f1).href);
  const g2 = await quineOf();
  const f2 = join(tmpdir(), 'scv-fp2.html'); writeFileSync(f2, g2); tmpFiles.push(f2);
  await load(pathToFileURL(f2).href);
  const g3 = await quineOf();
  const apis = h => (h.match(/window\.__QUEST_API__="/g) || []).length; // emitted override, not the template that writes it
  const cables = h => { const m = h.match(/<g id="static-cables">([\s\S]*?)<\/g>/); return m ? (m[1].match(/cable-path/g) || []).length : 0; };
  ok(g1 && g2 && g3, 'three quine generations produced');
  ok(apis(g2) <= 1 && apis(g3) <= 1, `quest-api override does not stack per generation (${apis(g1)}/${apis(g2)}/${apis(g3)})`);
  ok(cables(g1) === 0 && cables(g2) === 0, `rendered cables are not serialized - init re-renders them (${cables(g1)}/${cables(g2)})`);
  ok(g2.length === g3.length, `quine is size-stable across generations, it does not grow on re-save (${g2.length} vs ${g3.length})`);
  await load(pbUrl);

  const GIF = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
  const assetSrv = createServer((q, r) => { r.setHeader('content-type', 'image/gif'); r.setHeader('access-control-allow-origin', '*'); r.end(GIF); });
  await new Promise(r => assetSrv.listen(0, '127.0.0.1', r));
  const assetUrl = `http://127.0.0.1:${assetSrv.address().port}/probe.gif`;
  const assets = await js(`(async () => {
    const u = ${JSON.stringify(assetUrl)};
    const root = document.createElement('div');
    root.innerHTML = '<img id="a_plain" src="' + u + '">'
      + '<template class="custom-shadow"><img id="a_tpl" src="' + u + '"></template>'
      + '<template><template><img id="a_deep" src="' + u + '"></template></template>';
    document.body.appendChild(root);
    await _embedAssets(root);
    const read = el => el ? el.getAttribute('src') : null;
    const t1 = root.querySelector('template.custom-shadow');
    const t2 = root.querySelectorAll('template')[1];
    const r = {
      plain: read(root.querySelector('#a_plain')),
      inTemplate: read(t1.content.querySelector('#a_tpl')),
      nested: read(t2.content.querySelector('template').content.querySelector('#a_deep')),
    };
    root.remove();
    return r;
  })()`, true);
  assetSrv.close();
  ok(assets && (assets.plain || '').startsWith('data:'), `plain remote image inlines to data: (${assets && assets.plain})`);
  ok(assets && (assets.inTemplate || '').startsWith('data:'),
    `image inside custom-shadow template inlines too, instead of pointing home (${assets && (assets.inTemplate || '').slice(0, 40)})`);
  ok(assets && (assets.nested || '').startsWith('data:'),
    `image inside nested template inlines as well (${assets && (assets.nested || '').slice(0, 40)})`);
} catch (e) {
  fails++; console.log('  ✗ export tier threw:', e.message);
}

done();
console.log(fails ? `export: FAIL (${fails})` : 'export: PASS');
process.exit(fails ? 1 : 0);