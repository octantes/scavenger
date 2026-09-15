// connectivity tier - cross-subsystem seams: patchbay<>quests, kernel>patchbay clipboard harvest, kernel>quests grammar

import { launchChrome, connect } from './_cdp.mjs';
import { parseQuestLine } from '../quests.mjs';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const patchbayHtml = readFileSync(join(here, '..', 'patchbay.html'), 'utf8');
const kernelSrc = readFileSync(join(here, '..', 'kernel.js'), 'utf8');

// static server: patchbay + small harvest fixture
const fixture = `<!doctype html><title>fix</title><div id="widget" class="w" style="width:120px;padding:10px;background:#222;color:#eee">Live 42<span id="val">42</span></div>`;
const web = createServer((req, res) => {
  if (req.url.startsWith('/patchbay')) { res.setHeader('content-type', 'text/html'); res.end(patchbayHtml); }
  else { res.setHeader('content-type', 'text/html'); res.end(fixture); }
});
await new Promise(r => web.listen(0, '127.0.0.1', r));
const webPort = web.address().port;

// harvested component file as real kernel emits it - stable tag + backtick innerHTML literal - morph extractor matches, val changes between versions
let compVer = 1;
const BT = String.fromCharCode(96); // real backtick for def's own template literal - morph extractor keys off it
const compFile = n => `<scv-cvtest data-scv-component></scv-cvtest>
<script data-scv-def>
if(!customElements.get('scv-cvtest')){
customElements.define('scv-cvtest', class extends HTMLElement {
constructor() {
super();
if (this.shadowRoot) return;
this.attachShadow({mode: 'open'}).innerHTML = ${BT}<style>:host{display:block;width:60px;height:30px;background:#345}</style><div id="cv">v<span class="val">${n}</span></div><button class="wireme">go</button>${BT};
}
});
}
<\/script>`;

// mock quests server: register (post /quests), read (get /quests), emit (post /emit)
const store   = new Map(); // channel > entry
const posted  = []; // log of register posts
const emitted = []; // log of emit posts
const quests = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, scv-token');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && req.url === '/quests') { res.writeHead(200); return res.end(JSON.stringify([...store.values()])); }
  if (req.method === 'GET' && req.url.startsWith('/component/')) { res.setHeader('content-type', 'text/html'); res.writeHead(200); return res.end(compFile(compVer)); } // harvest: quest component file (compVer bumps to simulate a changed layout)

  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    let input = {}; try { input = JSON.parse(body || '{}'); } catch {}
    if (req.method === 'POST' && req.url === '/quests') { posted.push(input); const e = store.get(input.channel) || { channel: input.channel }; Object.assign(e, input); store.set(input.channel, e); }
    else if (req.method === 'POST' && req.url === '/quests/emit') { emitted.push(input); store.set(input.channel, { channel: input.channel, manual: true, result: { value: input.value, timestamp: Date.now() } }); }
    res.writeHead(200); res.end('{"ok":true}');
  });
});
await new Promise(r => quests.listen(0, '127.0.0.1', r));
const questApi = `http://127.0.0.1:${quests.address().port}`;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable');
const js = async (expr, aw = false) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const load = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await delay(400); };
const done = () => { try { ws.close(); } catch {} cleanup(); web.close(); quests.close(); };

try {
  // a - patchbay <> quests
  await load(`http://127.0.0.1:${webPort}/patchbay?quest-api=${encodeURIComponent(questApi)}`);
  ok(await js(`window.__QUEST_API__ === ${JSON.stringify(questApi)}`), 'patchbay picked up ?quest-api override');

  // configure input quest node > should post registration to server
  await js(`(() => {
    setMode('edit');
    const n = spawnLogicNode('quest', 100, 100);
    const inp = n.querySelector('.scv-logic-input');
    inp.value = 'price, http://shop.example/item, sel:.price';
    inp.dispatchEvent(new Event('change', { bubbles: true })); // quest nodes commit config on change/enter, not per keystroke
    window.__qnode = n;
    return true;
  })()`);
  await delay(300); // applyCfg + post round-trip
  const reg = posted.find(p => p.channel === 'price');
  ok(reg && reg.url === 'http://shop.example/item' && reg.target === 'sel:.price',
    `patchbay quest node registered scrape on server (${JSON.stringify(reg)})`);

  // server now has value for that channel; trigger node (receive 1) > fetches + emits
  store.set('price', { channel: 'price', url: 'http://shop.example/item', result: { value: '$9.99', timestamp: Date.now() } });
  const emitVal = await js(`(async () => {
    const n = window.__qnode;
    const ch = n.getAttribute('data-scv-emits').split(' ').find(c => c.startsWith('ch_q_') || c === 'price') || n.getAttribute('data-scv-emits').split(' ')[0];
    const r = document.createElement('div'); r.id = 'qrcv'; r.setAttribute('data-scv-receives', ch); document.getElementById('zoom-layer').appendChild(r);
    invalidateCache && invalidateCache();
    n.dispatchEvent(new CustomEvent('scv-receive', { detail: 1 })); // trigger a fetch
    let tries = 0; while (!document.getElementById('qrcv').textContent && tries++ < 40) await new Promise(r => setTimeout(r, 20)); // poll for the fetch to land instead of guessing a fixed wait
    return document.getElementById('qrcv').textContent;
  })()`, true);
  ok(emitVal === '$9.99', `quest node fetched server value and emitted it downstream (got ${JSON.stringify(emitVal)})`);

  // output mode: flip node, feed value > posts /quests/emit
  await js(`(async () => {
    const n = window.__qnode;
    n.querySelector('.scv-logic-icon').click(); // input > output
    let tries = 0; while (n.dataset.questMode !== 'output' && tries++ < 40) await new Promise(r => setTimeout(r, 20)); // poll for the mode flip to take effect instead of guessing a fixed wait
    n.dispatchEvent(new CustomEvent('scv-receive', { detail: 'pushed-out' }));
    return true;
  })()`, true);
  // post lands on node-side mock server (async, off page) - poll from here, not inside page
  let pollTries = 0;
  while (!emitted.find(e => e.value === 'pushed-out') && pollTries++ < 40) await delay(20);
  const pushed = emitted.find(e => e.value === 'pushed-out');
  ok(!!pushed, `output-mode quest node POSTed value to /quests/emit (${JSON.stringify(pushed || emitted)})`);

  // component mode: third icon click > component - url, selector registers harvest: scrape; ref mounts component in place of node
  await js(`(async () => {
    const n = window.__qnode;
    n.querySelector('.scv-logic-icon').click(); // output > component
    let t = 0; while (n.dataset.questMode !== 'component' && t++ < 40) await new Promise(r => setTimeout(r, 20));
    const inp = n.querySelector('.scv-logic-input');
    inp.value = 'http://shop.example/page, .widget'; inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, true);
  await delay(300);
  const compReg = posted.find(p => p.target === 'harvest:.widget');
  ok(compReg && compReg.url === 'http://shop.example/page', `component-mode node registered harvest: scrape (${JSON.stringify(compReg)})`);
  // before value lands, component mode floats same wait wording input node shows
  const waitFloat = await js(`(() => { const f = window.__qnode.querySelector('.scv-logic-float'); return f && f.textContent; })()`);
  ok(waitFloat === '[waiting]', `component node with no value yet shows same [waiting] float as input node (${JSON.stringify(waitFloat)})`);
  if (compReg) {
    store.set(compReg.channel, { channel: compReg.channel, url: 'http://shop.example/page', result: { value: 'component/' + compReg.channel + '.html#abc123', timestamp: Date.now() } });
    const mounted = await js(`(async () => {
      const n = window.__qnode;
      for (let t = 0; t < 60; t++) { // poll (2s) + fetch + spawn
        const w = document.querySelector('.comp-wrapper [data-scv-id^="live_"]');
        if (w) return { mounted: true, nodeVisible: n.style.display !== 'none' };
        await new Promise(r => setTimeout(r, 100));
      }
      return { mounted: false, ch: n._questChannel };
    })()`, true);
    ok(mounted && mounted.mounted, `component ref spawns live component (${JSON.stringify(mounted)})`);
    ok(mounted && mounted.nodeVisible, 'quest node stays visible - it spawns component, it does not turn into it');
    // wire a real cable (autoWire) from a source node onto an inner element, move the component, then let a changed layout arrive
    const before = await js(`(async () => {
      const w = document.querySelector('.comp-wrapper');
      const el = w.querySelector('[data-scv-id^="live_"]');
      const src = spawnLogicNode('quest', 40, 400); src.dataset.scvId = 'src_wire'; // input-mode node, inert - never emits on its own
      const btn = el.shadowRoot.querySelector('.wireme');
      autoWire(src, btn); renderCables(); // real wire-commit path drag ends in
      w.style.left = '777px'; w.style.top = '333px'; window.__compId = w.dataset.compId; // user drags it
      return { val: el.shadowRoot.querySelector('.val').textContent, wire: btn.getAttribute('data-scv-receives'), cables: document.querySelectorAll('#static-cables .cable-path:not(.cable-temp)').length };
    })()`, true);
    ok(before && before.val === '1' && /ch_/.test(before.wire || '') && before.cables >= 1, `component mounted at v1 with real cable wired onto inner node (${JSON.stringify(before)})`);
    compVer = 2; // layout changes - value advances, wiring and position must survive
    store.set(compReg.channel, { channel: compReg.channel, url: 'http://shop.example/page', result: { value: 'component/' + compReg.channel + '.html#v2', timestamp: Date.now() } });
    const morphed = await js(`(async () => {
      for (let t = 0; t < 40; t++) { // wait for the poll to pick up the changed layout
        const w = document.querySelector('.comp-wrapper'), el = w && w.querySelector('[data-scv-id^="live_"]');
        const val = el && el.shadowRoot && el.shadowRoot.querySelector('.val');
        if (val && val.textContent === '2') { const btn = el.shadowRoot.querySelector('.wireme');
          return { sameWrapper: w.dataset.compId === window.__compId, wireKept: btn && /ch_/.test(btn.getAttribute('data-scv-receives') || ''), cables: document.querySelectorAll('#static-cables .cable-path:not(.cable-temp)').length, l: w.style.left, top: w.style.top }; }
        await new Promise(r => setTimeout(r, 100));
      }
      return { timeout: true };
    })()`, true);
    ok(morphed && morphed.sameWrapper && morphed.wireKept && morphed.cables >= 1 && morphed.l === '777px' && morphed.top === '333px',
      `refresh morphs in place - real cable to inner node survives (attr + cable), no destroy/recreate (${JSON.stringify(morphed)})`);
    // structural change (skeleton swap - wired element's ancestor changes tag) must not wipe cables inside
    const structural = await js(`(() => {
      const host = document.createElement('div'), root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>.x{}</style><section class="c"><div class="cell">A</div><div class="cell">B</div></section>';
      root.querySelectorAll('.cell').forEach((c, i) => { c.setAttribute('data-scv-id', 'p' + i); c.setAttribute('data-scv-receives', 'ch'); });
      const before = root.querySelectorAll('[data-scv-receives]').length;
      morphLiveShadow(host, '<style>.x{}</style><div class="loading">…</div>'); // section -> div: the wired cells' ancestor changes tag
      return { before, after: root.querySelectorAll('[data-scv-receives]').length };
    })()`);
    ok(structural && structural.before === 2 && structural.after === 2,
      `structural change keeps cables wired to elements inside replaced-tag container - stale beats disconnected (${JSON.stringify(structural)})`);
    // reload: with the exported component already on the canvas, the node re-binds to it instead of spawning a duplicate
    const adopted = await js(`(async () => {
      const n = window.__qnode, wrap = document.querySelector('.comp-wrapper'), id = wrap.dataset.compId;
      const before = document.querySelectorAll('.comp-wrapper').length;
      n._pollCancel && n._pollCancel(); n._questChannel = null; n._liveWrapper = null; n._liveRef = null; // as fresh boot leaves it before applyCfg re-runs
      n.querySelector('.scv-logic-input').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      return { before, after: document.querySelectorAll('.comp-wrapper').length, bound: n._liveWrapper && n._liveWrapper.dataset.compId === id };
    })()`, true);
    ok(adopted && adopted.after === adopted.before && adopted.bound,
      `on reload node adopts exported component by channel, no duplicate spawn (${JSON.stringify(adopted)})`);
    // component is normal component: corner delete removes it (node keeps polling and respawns on next ref)
    const del = await js(`(async () => { const d = document.querySelector('.comp-wrapper .comp-del'); if (!d) return { noDel: true };
      d.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise(r => setTimeout(r, 150));
      return { wrappers: document.querySelectorAll('.comp-wrapper').length, nodeThere: !!document.body.contains(window.__qnode) }; })()`, true);
    ok(del && del.wrappers === 0 && del.nodeThere, `deleting spawned component removes it and leaves node (${JSON.stringify(del)})`);
  }

  // write-until-lands: node set up before server is reachable retries until write lands - no mode change or re-edit
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const downPort = probe.address().port; await new Promise(r => probe.close(r)); // nothing listens here yet - writes are refused
  const downApi = `http://127.0.0.1:${downPort}`; const latePosted = [];
  await load(`http://127.0.0.1:${webPort}/patchbay?quest-api=${encodeURIComponent(downApi)}`);
  await js(`(() => {
    setMode('edit');
    const n = spawnLogicNode('quest', 60, 300);
    const inp = n.querySelector('.scv-logic-input');
    inp.value = 'http://retry.example/x, .thing'; inp.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await delay(1200);
  ok(latePosted.length === 0, 'write to unreachable server has not landed (the retry is exercised, not no-op)');
  const late = createServer((req, res) => { // server comes up on same port the node has been retrying against
    res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, scv-token');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET') { res.writeHead(200); return res.end('[]'); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { latePosted.push(JSON.parse(b || '{}')); } catch {} res.writeHead(200); res.end('{"ok":true}'); });
  });
  await new Promise(r => late.listen(downPort, '127.0.0.1', r));
  let landed = false;
  for (let t = 0; t < 45 && !landed; t++) { landed = latePosted.some(p => p.url === 'http://retry.example/x'); if (!landed) await delay(200); }
  ok(landed, 'node retried registration on its own until it landed - not stuck waiting until mode change');
  await new Promise(r => late.close(r));

  // b - kernel > patchbay (clipboard bridge)
  await load(`http://127.0.0.1:${webPort}/fixture`); // harvest element on plain page, capture clipboard payload
  await send('Runtime.evaluate', { expression: kernelSrc });
  const harvestPayload = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      setTimeout(() => document.getElementById('widget').click(), 120);
      setTimeout(() => resolve('__timeout__'), 3500);
    });
  })()` }))?.result?.result?.value;
  ok(typeof harvestPayload === 'string' && /data-scv-component/.test(harvestPayload), 'kernel harvest produced component payload');

  // ingest exact payload into fresh patchbay via handlePasteData
  await load(`http://127.0.0.1:${webPort}/patchbay`);
  const ingested = await js(`(async () => {
    setMode('edit');
    const before = document.querySelectorAll('.comp-wrapper').length;
    handlePasteData(${JSON.stringify(harvestPayload)});
    const after = document.querySelectorAll('.comp-wrapper').length;
    // renderComponent re-hosts the harvest keyed by data-scv-id + injects its def script
    const host = document.querySelector('.comp-wrapper [data-scv-id]');
    const defined = !!(host && customElements.get(host.tagName.toLowerCase()));
    const wrapper = document.querySelector('.comp-wrapper');
    const bornHidden = wrapper.classList.contains('hydrating'); // hidden instant it mounts, before shadow fills
    let revealed = false;
    for (let t = 0; t < 40 && !(revealed = !wrapper.classList.contains('hydrating')); t++) await new Promise(r => setTimeout(r, 25));
    return { before, after, hasHost: !!host, defined, bornHidden, revealed };
  })()`, true);
  ok(ingested && ingested.after === ingested.before + 1 && ingested.hasHost && ingested.defined,
    `patchbay ingested harvested component onto canvas as defined element (${JSON.stringify(ingested)})`);
  ok(ingested && ingested.bornHidden && ingested.revealed,
    `spawned component born hidden and revealed once shadow hydrates - no empty pre-hydration box (${JSON.stringify(ingested)})`);
  // morph extractor must read real kernel def's shadow - guards kernel<>patchbay format coupling
  const extractable = await js(`(() => {
    const def = new DOMParser().parseFromString(${JSON.stringify(harvestPayload)}, 'text/html').querySelector('script[data-scv-def]');
    const m = extractShadowMarkup(boxScopeCss(def.textContent));
    return { got: m != null, hasStyle: !!m && m.includes('<style>') };
  })()`);
  ok(extractable && extractable.got && extractable.hasStyle,
    `extractShadowMarkup reads real kernel def's shadow markup - morph format contract holds (${JSON.stringify(extractable)})`);

  // c - kernel > quests (grammar agreement across clipboard)
  await load(`http://127.0.0.1:${webPort}/fixture`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const questLine = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('quest-sel');
      setTimeout(() => document.getElementById('val').click(), 120);
      setTimeout(() => resolve('__timeout__'), 3500);
    });
  })()` }))?.result?.result?.value;
  ok(typeof questLine === 'string' && questLine.includes(','), `kernel quest-sel produced config line (${JSON.stringify(questLine)})`);
  // same parser server uses must accept kernel's line
  const parsed = typeof questLine === 'string' ? parseQuestLine(questLine) : null;
  ok(parsed && /^https?:\/\//.test(parsed.url || '') && !!parsed.selector,
    `quests.mjs parseQuestLine accepts kernel's line → ${JSON.stringify(parsed)}`);
} catch (e) {
  fails++; console.log('  ✗ connectivity tier threw:', e.message);
}

done();
console.log(fails ? `connectivity: FAIL (${fails})` : 'connectivity: PASS');
process.exit(fails ? 1 : 0);