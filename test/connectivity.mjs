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

// static server: patchbay, captured publish, small harvest fixture
const fixture = `<!doctype html><title>fix</title><div id="widget" class="w" style="width:120px;padding:10px;background:#222;color:#eee">Live 42<span id="val">42</span></div>`;
let publishDoc = '';
const web = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(req.url.startsWith('/patchbay') ? patchbayHtml : req.url.startsWith('/publish') ? publishDoc : fixture);
});
await new Promise(r => web.listen(0, '127.0.0.1', r));
const webPort = web.address().port;

// quest component file as kernel emits it - val changes between versions, v4 nests node
let compVer = 1;
const BT = String.fromCharCode(96);
const compFile = n => `<scv-cvtest data-scv-component></scv-cvtest>
<script data-scv-def>
if(!customElements.get('scv-cvtest')){
customElements.define('scv-cvtest', class extends HTMLElement {
constructor() {
super();
if (this.shadowRoot) return;
this.attachShadow({mode: 'open'}).innerHTML = ${BT}<style>:host{display:block;width:60px;height:30px;background:#345}</style><div id="cv">v<span class="val">${n}</span></div><button class="wireme">go</button>${n === 4 ? '<scv-logic data-type="variable"></scv-logic>' : ''}${BT};
}
});
}
<\/script>`;

// mock quests server: register (post /quests), read (get /quests), emit (post /quests/emit)
const store = new Map(), posted = [], emitted = [];
let listReads = 0;
const cors = res => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, scv-token'); };
const quests = createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.method === 'GET' && req.url === '/quests') { listReads++; res.writeHead(200); return res.end(JSON.stringify([...store.values()])); }
  if (req.method === 'GET' && req.url.startsWith('/component/')) { res.setHeader('content-type', 'text/html'); res.writeHead(200); return res.end(compFile(compVer)); }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    let input = {}; try { input = JSON.parse(body || '{}'); } catch {}
    if (req.method === 'POST' && req.url === '/quests') { posted.push(input); store.set(input.channel, Object.assign(store.get(input.channel) || {}, input)); }
    else if (req.method === 'POST' && req.url === '/quests/emit') emitted.push(input);
    res.writeHead(200); res.end('{"ok":true}');
  });
});
await new Promise(r => quests.listen(0, '127.0.0.1', r));
const questApi = `http://127.0.0.1:${quests.address().port}`;
const ref = (ch, hash) => store.set(ch, { channel: ch, result: { value: 'component/' + ch + '.html#' + hash, timestamp: Date.now() } });

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable');
await send('Runtime.enable');
const pageErrors = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
const js = async (expr, aw = true) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const HELPERS = `(() => {
  const pb = window.pb = document.querySelector('scv-patchbay'), kit = window.kit = customElements.get('scv-patchbay').kit;
  pb.setMode?.('edit');
  window.quest = (value, x = 100, y = 100) => { const n = document.createElement('scv-logic'); n.dataset.type = 'quest'; n.setAttribute('value', value); n.style.left = x + 'px'; n.style.top = y + 'px'; pb.append(n); return n; };
  window.sink = ch => { const d = document.createElement('div'); d.setAttribute('data-scv-receives', ch); pb.append(d); return d; };
  window.until = async (fn, ms = 6000) => { for (const end = performance.now() + ms; performance.now() < end; await new Promise(r => setTimeout(r, 20))) { const v = fn(); if (v) return v; } return null; };
  window.floatOf = n => n.shadowRoot.querySelector('.float').textContent;
  window.liveOf = ch => pb.querySelector('scv-item[data-scv-quest-channel="' + ch + '"]');
  window.valOf = it => it?.firstElementChild?.shadowRoot?.querySelector('.val')?.textContent;
  return true;
})()`;
const load = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await delay(300); return js(HELPERS); };
const pbAt = api => `http://127.0.0.1:${webPort}/patchbay?quest-api=${encodeURIComponent(api)}`;
const done = () => { try { ws.close(); } catch {} cleanup(); web.close(); quests.close(); };

try {
  // a - patchbay <> quests
  await load(pbAt(questApi));
  ok(await js(`kit.quests.api(pb) === ${JSON.stringify(questApi)}`), 'patchbay picked up ?quest-api override');

  await js(`(() => { window.q = quest('price, http://shop.example/item, sel:.price'); return true; })()`);
  await delay(300);
  const reg = posted.find(p => p.channel === 'price');
  ok(reg && reg.url === 'http://shop.example/item' && reg.target === 'sel:.price', `input node registered scrape on server (${JSON.stringify(reg)})`);

  store.set('price', { channel: 'price', result: { value: '$9.99', timestamp: Date.now() } });
  const pulled = await js(`(async () => { const d = sink('price'); q.receive(kit.pulse(), 'x'); return await until(() => d.textContent, 1500); })()`);
  ok(pulled === '$9.99', `pulsed input node fetched server value and emitted it downstream (${JSON.stringify(pulled)})`);

  await js(`(() => { q.cycleMode(); q.receive(kit.pulse(), 'x'); q.receive('pushed-out', 'x'); return true; })()`);
  for (let t = 0; t < 40 && !emitted.length; t++) await delay(20);
  ok(emitted.length === 1 && emitted[0].channel === 'price' && emitted[0].value === 'pushed-out', `output node posted data to /quests/emit, pulse stayed local (${JSON.stringify(emitted)})`);

  const compUrl = 'http://shop.example/page';
  const waitFloat = await js(`(async () => { q.cycleMode(); q.setAttribute('value', '${compUrl}, .widget'); return await until(() => floatOf(q) === '[waiting]' && floatOf(q)); })()`);
  const compReg = posted.find(p => p.target === 'harvest:.widget');
  ok(compReg && compReg.url === compUrl, `component node registered harvest: scrape (${JSON.stringify(compReg)})`);
  ok(waitFloat === '[waiting]', `component node with no value shows [waiting] float (${JSON.stringify(waitFloat)})`);
  const ch = compReg?.channel;
  if (ch) {
    ref(ch, 'abc123');
    const mounted = await js(`(async () => { const it = await until(() => valOf(liveOf('${ch}')) === '1' && liveOf('${ch}'));
      return it && { top: it.style.top, nodeShown: q.isConnected && getComputedStyle(q).display !== 'none' }; })()`);
    ok(mounted && mounted.top === '140px', `component ref spawns live component below node (${JSON.stringify(mounted)})`);
    ok(mounted && mounted.nodeShown, 'quest node stays - it spawns component, does not turn into it');

    const wired = await js(`(async () => {
      const it = window.__it = liveOf('${ch}'), btn = it.firstElementChild.shadowRoot.querySelector('.wireme');
      const src = quest('', 40, 400); pb.wire(src, btn);
      it.style.left = '777px'; it.style.top = '333px';
      await new Promise(r => requestAnimationFrame(r));
      return { wire: btn.getAttribute('data-scv-receives'), cable: pb.cables().some(c => c.tgt === btn) };
    })()`);
    ok(wired && /^ch_/.test(wired.wire || '') && wired.cable, `cable wired onto inner element of live component (${JSON.stringify(wired)})`);

    compVer = 2; ref(ch, 'v2');
    const morphed = await js(`(async () => {
      const it = await until(() => valOf(liveOf('${ch}')) === '2' && liveOf('${ch}')); if (!it) return null;
      const btn = it.firstElementChild.shadowRoot.querySelector('.wireme');
      return { same: it === window.__it, wireKept: /^ch_/.test(btn.getAttribute('data-scv-receives') || ''), cable: pb.cables().some(c => c.tgt === btn), at: it.style.left + ',' + it.style.top };
    })()`);
    ok(morphed && morphed.same && morphed.wireKept && morphed.cable && morphed.at === '777px,333px', `new layout morphs in place - inner cable and position survive (${JSON.stringify(morphed)})`);

    const structural = await js(`(() => {
      const host = document.createElement('div'), root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>.x{}</style><section class="c"><div class="cell">A</div><div class="cell">B</div></section>';
      root.querySelectorAll('.cell').forEach(c => c.setAttribute('data-scv-receives', 'ch'));
      const t = document.createElement('template'); t.innerHTML = '<style>.x{}</style><div class="loading">…</div>';
      const morphed = kit.morphShadow(host, t.content);
      return { morphed, kept: root.querySelectorAll('[data-scv-receives]').length };
    })()`);
    ok(structural && structural.morphed && structural.kept === 2, `container changing tag keeps wired elements inside - stale beats disconnected (${JSON.stringify(structural)})`);

    const grab = () => js(`pb.save('publish').then(b => b.text())`);
    const publishWithLive = await grab();
    const del = await js(`(() => { pb.select([liveOf('${ch}')]); pb.removeSelection(); return { gone: !liveOf('${ch}'), node: q.isConnected }; })()`);
    ok(del && del.gone && del.node, `deleting live component leaves its node (${JSON.stringify(del)})`);
    const publishNoLive = await grab();
    compVer = 3; ref(ch, 'v3');
    const back = await js(`(async () => { const it = await until(() => valOf(liveOf('${ch}')) === '3' && liveOf('${ch}')); return it && it.style.top; })()`);
    ok(back === '140px', `deleted component respawns below node on next layout (${JSON.stringify(back)})`);
    ok(!pageErrors.length, `studio quest flow throws nothing (${pageErrors.slice(0, 2).join(' | ')})`);

    // publish has no studio - live component still follows server
    const livePub = async doc => {
      publishDoc = doc; pageErrors.length = 0;
      await send('Page.navigate', { url: `http://127.0.0.1:${webPort}/publish?quest-api=${encodeURIComponent(questApi)}` }); await waitEvent('Page.loadEventFired');
      await js(HELPERS);
      return js(`(async () => { const it = await until(() => valOf(liveOf('${ch}')) === '3' && liveOf('${ch}'));
        return it ? { items: pb.querySelectorAll('scv-item').length, at: it.style.left + ',' + it.style.top, inPb: it.parentElement === pb } : { val: valOf(liveOf('${ch}')) ?? null }; })()`);
    };
    const adopt = await livePub(publishWithLive);
    ok(adopt && adopt.items === 1 && adopt.at === '777px,333px' && !pageErrors.length, `publish: node adopts saved live component and morphs it in place (${JSON.stringify(adopt)}, ${pageErrors.slice(0, 2).join(' | ')})`);
    compVer = 4; ref(ch, 'v4');
    const remount = await js(`(async () => { const it = await until(() => valOf(liveOf('${ch}')) === '4' && liveOf('${ch}')); if (!it) return null;
      return { items: pb.querySelectorAll('scv-item').length, at: it.style.left + ',' + it.style.top, node: !!it.querySelector(':scope > scv-logic'), inShadow: !!it.firstElementChild.shadowRoot.querySelector('scv-logic') }; })()`);
    ok(remount && remount.items === 1 && remount.at === '777px,333px' && remount.node && !remount.inShadow && !pageErrors.length,
      `publish: layout with nested node remounts over defined tag in place, node comes back real (${JSON.stringify(remount)}, ${pageErrors.slice(0, 2).join(' | ')})`);
    compVer = 3;
    const fresh = await livePub(publishNoLive);
    ok(fresh && fresh.items === 1 && fresh.inPb && fresh.at === '100px,140px' && !pageErrors.length, `publish: node with no saved copy mounts its own (${JSON.stringify(fresh)}, ${pageErrors.slice(0, 2).join(' | ')})`);
  }

  // registration retries until server answers
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const downPort = probe.address().port; await new Promise(r => probe.close(r));
  const latePosted = [];
  await load(pbAt(`http://127.0.0.1:${downPort}`));
  const down = await js(`(async () => { window.q = quest('http://retry.example/x, .thing'); return await until(() => /answering/.test(floatOf(q)) && floatOf(q), 3000); })()`);
  ok(down === `nothing's answering at 127.0.0.1:${downPort}`, `unreachable server named in float (${JSON.stringify(down)})`);
  const late = createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method === 'GET') { res.writeHead(200); return res.end('[]'); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { latePosted.push(JSON.parse(b || '{}')); } catch {} res.writeHead(200); res.end('{"ok":true}'); });
  });
  await new Promise(r => late.listen(downPort, '127.0.0.1', r));
  let landed = false;
  for (let t = 0; t < 45 && !landed; t++) { landed = latePosted.some(p => p.url === 'http://retry.example/x'); if (!landed) await delay(200); }
  ok(landed, 'node retried registration on its own until it landed');
  await new Promise(r => late.close(r));

  // shared poll - waiting nodes cost one list read per tick
  await load(pbAt(questApi));
  await js(`(() => { window.ns = [0, 1, 2, 3, 4].map(i => quest('sp' + i + ', https://poll.example/' + i + ', sel:.v', 60 + i * 50, 500)); return true; })()`);
  await delay(200); listReads = 0;
  await delay(4100);
  const waitingReads = listReads;
  ok(waitingReads >= 1 && waitingReads <= 3, `5 waiting nodes share one list read per tick (${waitingReads} reads in ~4s)`);
  await js(`(() => { ns[3].remove(); ns[4].remove(); return true; })()`);
  [0, 1, 2].forEach(i => store.set('sp' + i, { channel: 'sp' + i, result: { value: 'v' + i, timestamp: Date.now() } }));
  const shared = await js(`(async () => (await until(() => ns.slice(0, 3).every((n, i) => floatOf(n) === 'v' + i), 4000)) && true || ns.map(floatOf))()`);
  ok(shared === true, `each node gets own channel's value from shared read (${JSON.stringify(shared)})`);
  await delay(300); listReads = 0;
  await delay(4100);
  ok(listReads === 0, `poll stops once every watcher landed or left (${listReads} reads after)`);
  store.set('sp0', { channel: 'sp0', result: { value: 'fresh', timestamp: Date.now() } });
  const freshVal = await js(`(async () => { const d = sink('sp0'); ns[0].receive(kit.pulse(), 'x'); return await until(() => d.textContent, 1500); })()`);
  ok(freshVal === 'fresh', `pulsed read fetches now, not from last shared list (${JSON.stringify(freshVal)})`);

  // b, c - kernel clipboard payloads on plain page
  const kernelClip = async (tool, target) => {
    await send('Page.navigate', { url: `http://127.0.0.1:${webPort}/fixture` }); await waitEvent('Page.loadEventFired');
    await send('Runtime.evaluate', { expression: kernelSrc });
    return js(`new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('${tool}');
      setTimeout(() => document.getElementById('${target}').click(), 120);
      setTimeout(() => resolve('__timeout__'), 3500);
    })`);
  };
  const harvestPayload = await kernelClip('harvester', 'widget');
  ok(/data-scv-component/.test(harvestPayload || ''), 'kernel harvest produced component payload');
  const questLine = await kernelClip('quest-sel', 'val');
  ok(typeof questLine === 'string' && questLine.includes(','), `kernel quest-sel produced config line (${JSON.stringify(questLine)})`);
  const parsed = typeof questLine === 'string' ? parseQuestLine(questLine) : null;
  ok(parsed && /^https?:\/\//.test(parsed.url || '') && !!parsed.selector, `quests.mjs parseQuestLine accepts kernel's line (${JSON.stringify(parsed)})`);

  await load(`http://127.0.0.1:${webPort}/patchbay`);
  const ingested = await js(`(() => {
    const before = pb.querySelectorAll('scv-item').length;
    pb.import(${JSON.stringify(harvestPayload)});
    const host = pb.querySelector('scv-item > [data-scv-id]');
    const def = new DOMParser().parseFromString(${JSON.stringify(harvestPayload)}, 'text/html').querySelector('script[data-scv-def]');
    const m = kit.extractShadowMarkup(kit.boxScopeCss(def.textContent));
    return { added: pb.querySelectorAll('scv-item').length - before, defined: !!(host && customElements.get(host.localName)), filled: !!host?.shadowRoot?.childElementCount, markup: !!m && m.includes('<style>') };
  })()`);
  ok(ingested && ingested.added === 1 && ingested.defined && ingested.filled, `patchbay imports kernel harvest as defined, filled element (${JSON.stringify(ingested)})`);
  ok(ingested && ingested.markup, `extractShadowMarkup reads kernel def's shadow - morph format holds (${JSON.stringify(ingested)})`);
  const sameUrl = await js(`kit.quests.parseInputLine(${JSON.stringify(questLine)})?.url`);
  ok(parsed && sameUrl === parsed.url, `patchbay reads kernel's line to same url as server (${sameUrl})`);
} catch (e) {
  fails++; console.log('  ✗ connectivity tier threw:', e.message);
}

done();
console.log(fails ? `connectivity: FAIL (${fails})` : 'connectivity: PASS');
process.exit(fails ? 1 : 0);
