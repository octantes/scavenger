// engine tier - real QuestEngine cdp methods against local fixture via proxy-less chrome (prod code, just localhost)

import { QuestEngine, configure } from '../quests.mjs';
import { launchChrome } from './_cdp.mjs';
import { createServer } from 'http';
import { stat } from 'fs/promises';
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { chdir } from 'process';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };

// fixture page: spa-delayed content, localStorage (flat + json), click>inject
let seenUA = '';
const html = `<!doctype html><title>t</title><button id="load">load</button>
<style>@font-face{font-family:EngFont;src:url(%FONT%)}</style>
<link rel="stylesheet" href="%XORIGIN%/xo.css">
<div id="src" style="width:40px;height:40px;font-family:XOFont,AdoptFont,EngFont">src<img id="im" src="%IMG%" srcset="/rel.png 2x" width=10 height=10></div><div id="dst" style="width:40px;height:40px">dst</div>
<script>
  const _af = new CSSStyleSheet(); _af.replaceSync('@font-face{font-family:AdoptFont;src:url(%FONT2%)}'); document.adoptedStyleSheets = [_af]; // font only in adopted sheet - harvest must still find it
  localStorage.setItem('greeting','hello');
  localStorage.setItem('auth', JSON.stringify({ token: 'abc123' }));
  setTimeout(() => { const d=document.createElement('div'); d.id='pane'; document.body.appendChild(d); }, 250);
  setTimeout(() => { const d=document.createElement('div'); d.id='late'; d.textContent='  arrived  '; document.body.appendChild(d); }, 400);
  document.getElementById('load').addEventListener('click', () => {
    setTimeout(() => { const r=document.createElement('div'); r.id='result'; r.textContent='PIPELINE OK'; document.body.appendChild(r); }, 300);
  });
  document.getElementById('dst').addEventListener('mouseup', () => { document.getElementById('dst').textContent = 'dropped'; });
</script>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'); // 1x1 png for asset-proxy test
// cross-origin (different port) font server without cors headers - headless page can't read cssRules or refetch, so server must recover @font-face
const xsrv = createServer((req, res) => {
  if (req.url === '/xo.css') { res.setHeader('content-type', 'text/css'); return res.end(`@font-face{font-family:XOFont;src:url(${xorigin()}/xo.woff)}`); }
  if (req.url === '/xo.woff') { res.setHeader('content-type', 'font/woff'); return res.end(PNG); }
  res.writeHead(404); res.end();
});
await new Promise(r => xsrv.listen(0, '127.0.0.1', r));
const xorigin = () => `http://127.0.0.1:${xsrv.address().port}`;
const srv = createServer((req, res) => {
  if (req.url === '/px.png') { res.setHeader('content-type', 'image/png'); return res.end(PNG); }
  if (req.url === '/f.woff' || req.url === '/f2.woff') { res.setHeader('content-type', 'font/woff'); return res.end(PNG); } // bytes irrelevant - test asserts url inlined to data: - not glyph rendering
  seenUA = req.headers['user-agent'] || ''; res.setHeader('content-type', 'text/html');
  const b = `http://127.0.0.1:${srv.address().port}`;
  res.end(html.replace('%IMG%', `${b}/px.png`).replace('%FONT%', `${b}/f.woff`).replace('%FONT2%', `${b}/f2.woff`).replace('%XORIGIN%', xorigin()));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;

// wire proxy-less chrome into real QuestEngine
const { port, pageWsUrl, cleanup } = await launchChrome();
const engine = new QuestEngine();
engine._debugPort = port;
engine.pending = {}; engine.msgId = 0;
engine.ws = new WebSocket(pageWsUrl);
await new Promise((res, rej) => { engine.ws.onopen = res; engine.ws.onerror = rej; });
engine.ws.onmessage = e => { // mirror _launchChrome's handler (clears _send's timeout)
  const m = JSON.parse(e.data);
  if (m.id && engine.pending[m.id]) { clearTimeout(engine.pending[m.id].timer); engine.pending[m.id].resolve(m); delete engine.pending[m.id]; }
};
engine._chromeConnected = true;
await engine._send('Page.enable');
await engine._send('Page.setLifecycleEventsEnabled', { enabled: true }); // _navigate correlates load by frame/loader id - mirrors _launchChrome's real cli path
const rawUA = (await engine._send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }))?.result?.result?.value || '';
engine._ua = rawUA.includes('Headless') ? rawUA.replace(/HeadlessChrome/g, 'Chrome').replace(/\s*Headless/g, '') : null;
await engine._applyUAOverride(engine);

const done = async () => { try { engine.ws.close(); } catch {} cleanup(); srv.close(); xsrv.close(); };

try {
  // selector poll waits for spa-injected content
  ok(await engine.fetchPage(url, '#late', engine) === 'arrived', 'fetchPage waits for late element');

  // ua override reached the server (real _applyUAOverride)
  ok(seenUA.includes('Chrome/') && !seenUA.includes('Headless'), `UA de-headlessed (saw: ${seenUA.slice(0, 40)}...)`);

  // missing selector > visible error, not silent ''
  let threw = false;
  try { await engine.fetchPage(url, '#never-ever', engine); } catch (e) { threw = /matched nothing/.test(e.message); }
  ok(threw, 'missing selector throws "matched nothing"');

  // localStorage: flat + json dot-path
  ok(await engine.fetchStorage(url, 'greeting', engine) === 'hello', 'fetchStorage flat key');
  ok(await engine.fetchStorage(url, 'auth.token', engine) === 'abc123', 'fetchStorage json dot-path (auth.token)');

  // interaction pipeline: wait > click > wait > extract (real _runSteps)
  const piped = await engine.fetchPage(url, '#result', engine, [{ wait: '#pane' }, { click: '#load' }, { wait: '#result' }]);
  ok(piped === 'PIPELINE OK', `pipeline wait|click|wait → extract (got: ${piped})`);

  // drag gesture: from #src to #dst fires mouseup on target (real _runSteps drag)
  const dragged = await engine.fetchPage(url, '#dst', engine, [{ drag: '#src=>#dst' }]);
  ok(dragged === 'dropped', `drag #src=>#dst fired drop on target (got: ${dragged})`);

  // many long waits must not hold worker unbounded - wall-clock deadline aborts (shrunk via configure())
  configure({ scrapeDeadline: 500 });
  const t0 = Date.now();
  let deadlineErr = null;
  try { await engine.fetchPage(url, '#result', engine, [{ wait: '2000' }, { wait: '2000' }, { wait: '2000' }]); }
  catch (e) { deadlineErr = e.message; }
  const deadlineElapsed = Date.now() - t0;
  configure({ scrapeDeadline: 60000 }); // restore default for anything after
  ok(/deadline/i.test(deadlineErr || ''), `many-step quest past deadline aborts with deadline error, not silently running long (got: ${deadlineErr})`);
  ok(deadlineElapsed < 2000, `abort happens near deadline, not after all steps finish (~6s worth of waits, took ${deadlineElapsed}ms)`);

  // screenshot writes valid png (loopback fixture - relax ssrf gate as --allow-local does)
  configure({ allowLocal: true });
  const file = await engine.captureScreenshot({ url, channel: 'shot' });
  configure({ allowLocal: false });
  const st = await stat(file); const head = readFileSync(file).subarray(0, 4);
  ok(st.size > 500 && head[0] === 0x89 && head[1] === 0x50, 'captureScreenshot writes PNG');
  try { rmSync(file, { force: true }); } catch {}

  // fetchJSON (key: api path) - pinnedGet + dot-path key + stringify, loopback fixture so relax ssrf pin
  const jsonSrv = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/bad') return res.end('<html>not json</html>');
    res.end(JSON.stringify({ price: '42.50', data: { nested: 7 }, obj: { a: 1, b: 2 } }));
  });
  await new Promise(r => jsonSrv.listen(0, '127.0.0.1', r));
  const jurl = `http://127.0.0.1:${jsonSrv.address().port}/`;
  configure({ allowLocal: true });
  try {
    ok(await engine.fetchJSON(jurl, 'price') === '42.50', 'fetchJSON reads top-level key');
    ok(await engine.fetchJSON(jurl, 'data.nested') === '7', 'fetchJSON reads nested dot-path key');
    ok(await engine.fetchJSON(jurl, 'obj') === '{"a":1,"b":2}', 'fetchJSON stringifies object value');
    let threw = false; try { await engine.fetchJSON(jurl, 'missing'); } catch { threw = true; }
    ok(threw, 'fetchJSON throws for missing key (a missing jsonKey is scrape error, not empty success)');
    // non-json response fails quest gracefully via execute(), not crash
    const badResult = await engine.execute({ channel: 'x', url: jurl + 'bad', jsonKey: 'price' });
    ok(badResult && badResult.value === null && !!badResult.error, 'non-json api response fails quest cleanly (no crash)');
  } finally {
    configure({ allowLocal: false });
    jsonSrv.close();
  }

  // dom-scrape through tick(): due selector quest is scraped + persisted (allow-local for fixture, restored in finally)
  configure({ allowLocal: true });
  const origCwd = process.cwd();
  const engTmpDir = mkdtempSync(join(tmpdir(), 'scv-eng-'));
  try {
    chdir(engTmpDir);
    writeFileSync('quests.json', JSON.stringify([{ channel: 'dom', url, selector: '#late', interval: 1 }]));
    await engine.tick();
    const domResult = JSON.parse(readFileSync('quests.json', 'utf8')).find(q => q.channel === 'dom');
    ok(domResult && domResult.result?.value === 'arrived', `tick() ran dom (selector) scrape end to end (${JSON.stringify(domResult?.result)})`);
    // storageKey through tick too
    writeFileSync('quests.json', JSON.stringify([{ channel: 'st', url, storageKey: 'greeting', interval: 1 }]));
    await engine.tick();
    const stResult = JSON.parse(readFileSync('quests.json', 'utf8')).find(q => q.channel === 'st');
    ok(stResult && stResult.result?.value === 'hello', `tick() ran localStorage scrape end to end (${JSON.stringify(stResult?.result)})`);

    // harvest - through tick, component lands as file, json carries only readable path#hash ref
    writeFileSync('quests.json', JSON.stringify([{ channel: 'comp', url, harvestSel: '#src', interval: 1 }]));
    await engine.tick();
    const compQ = JSON.parse(readFileSync('quests.json', 'utf8')).find(q => q.channel === 'comp');
    ok(compQ && /^component\/comp\.html#[0-9a-f]{12}$/.test(compQ.result?.value || ''), `harvest: stores path#hash ref, not markup (${compQ?.result?.value})`);
    const compHtml = compQ?.result?.value ? readFileSync(compQ.result.value.split('#')[0], 'utf8') : '';
    ok(/data-scv-def/.test(compHtml) && /<style>/.test(compHtml), 'harvested component is its own real .html def');
    ok(!/data:image\/(png|jpeg|gif)/.test(compHtml), 'ref-mode keeps asset urls - no inlined blobs in file');
    ok(/\/asset\?url=http/.test(compHtml) && !/src="http:\/\/127\.0\.0\.1:\d+\/px\.png"/.test(compHtml), 'remote asset is rewritten through /asset proxy, not left pointing at source');
    ok(/@font-face[\s\S]*?url\(["']?data:font/i.test(compHtml) && !/url\([^)]*\/f\.woff/.test(compHtml), 'font inlines to data: even in ref-mode - browser-context fetch reaches gated faces server proxy would miss, matching normal harvest');
    ok(/AdoptFont/.test(compHtml) && !/url\([^)]*\/f2\.woff/.test(compHtml), 'font defined only in adopted (constructable) stylesheet captured and inlined - not just ones in document.styleSheets');
    ok(/@font-face[\s\S]*?XOFont[\s\S]*?data:font|XOFont[\s\S]*?@font-face/i.test(compHtml) && /XOFont/.test(compHtml) && !/url\([^)]*\/xo\.woff/.test(compHtml) && !/SCV-RF/.test(compHtml), '@font-face in cross-origin sheet page could not read is recovered server-side and inlined (marker consumed)');
    ok(/srcset="[^"]*\/asset\?url=[^"]*rel\.png/.test(compHtml) && !/srcset="\/rel\.png/.test(compHtml), 'relative srcset candidate is made absolute then proxied - not left relative to 404');
    const { createHash } = await import('crypto');
    const expectUid = createHash('sha256').update('comp').digest('hex').slice(0, 8);
    ok(compHtml.includes(`scv-${expectUid}`), `harvested tag is stable id derived from channel, not random - so re-harvests are diffable (expected scv-${expectUid})`);
    await engine.tick(); // unchanged re-harvest yields same stable hash - no false update
    const compQ2 = JSON.parse(readFileSync('quests.json', 'utf8')).find(q => q.channel === 'comp');
    ok(compQ2?.result?.value === compQ?.result?.value, `unchanged component keeps its ref hash (${compQ2?.result?.value})`);
  } finally {
    configure({ allowLocal: false });
    chdir(origCwd); // must restore before removing - can't rmSync dir that's still process cwd
    try { rmSync(engTmpDir, { recursive: true, force: true }); } catch {}
  }

  // _setConcurrency clamps to 1..8
  const e2 = new QuestEngine();
  e2._setConcurrency(0);  const lo = e2._concurrency;
  e2._setConcurrency(99); const hi = e2._concurrency;
  e2._setConcurrency(4);  const mid = e2._concurrency;
  ok(lo === 1 && hi === 8 && mid === 4, `_setConcurrency clamps to 1..8 (got ${lo}/${hi}/${mid})`);
  e2.destroy(); // no real chrome/ws here, but destroy() not just for engines holding real resources
} catch (e) {
  fails++; console.log('  ✗ engine tier threw:', e.message);
}

await done();
console.log(fails ? `engine: FAIL (${fails})` : 'engine: PASS');
process.exit(fails ? 1 : 0);