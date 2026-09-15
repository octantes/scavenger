// live-emit tier - quest-emit tool: snipe element, watch it, mutate it, assert mock got both values via scv-token

import { launchChrome, connect } from './_cdp.mjs';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
// poll instead of fixed wait - only for "wait until X" checks, negative check still needs real wait
const pollUntil = async (check, timeout = 3000, interval = 25) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return true; await delay(interval); }
  return false;
};
const kernelSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../kernel.js'), 'utf8');

// fixture page: element whose text we'll mutate
const page = `<!doctype html><title>t</title><div id="v" style="width:100px">initial</div>`;
const pageSrv = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(page); });
await new Promise(r => pageSrv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${pageSrv.address().port}/`;

// mock quest server: capture post /quests/emit; cors like real one (acao * + scv-token)
const emits = [];
const mock = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, scv-token');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    if (req.url === '/quests/emit') { try { emits.push({ token: req.headers['scv-token'], ...JSON.parse(b) }); } catch {} }
    res.writeHead(200); res.end('{"ok":true}');
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${mock.address().port}`;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable');
await send('Page.navigate', { url });
await waitEvent('Page.loadEventFired');
const js = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.result?.value;
const done = () => { try { ws.close(); } catch {} cleanup(); pageSrv.close(); mock.close(); };

try {
  await send('Runtime.evaluate', { expression: kernelSrc });
  ok(await js(`[...document.querySelectorAll('.scv-cmd')].some(e => /live-emit/i.test(e.textContent))`), 'quest-emit command listed');

  await js(`[...document.querySelectorAll('.scv-cmd')].find(e => /live-emit/i.test(e.textContent)).click(); true`);
  await pollUntil(async () => await js(`window.$kernel.processes['quest-emit']?.active === true`)); // tool armed (hover-picker ready), not just "some time has passed"
  await js(`document.getElementById('v').click(); true`); // pick > config menu
  await pollUntil(async () => await js(`!!document.querySelector('#scv-qe-ch')`));
  ok(await js(`!!document.querySelector('#scv-view #scv-qe-ch') && getComputedStyle(document.getElementById('scv-view')).display !== 'none'`), 'config opened inside shared viewer after pick');

  // fill channel / token / api and start watching
  await js(`document.querySelector('#scv-qe-ch').value='live'; document.querySelector('#scv-qe-tok').value='tok123'; document.querySelector('#scv-qe-api').value=${JSON.stringify(api)}; document.querySelector('#scv-qe-go').click(); true`);
  await pollUntil(() => emits.length >= 1);
  ok(emits.length >= 1, 'initial value emitted on watch');
  ok(emits[0] && emits[0].channel === 'live' && emits[0].value === 'initial' && emits[0].token === 'tok123', `initial emit: ${JSON.stringify(emits[0])}`);
  // [id^="scv-qe-"] also matches panel inputs - .scv-qe-badge is real pin, tracking #v's rect
  const badgePos = await js(`(() => {
    const badge = document.querySelector('.scv-qe-badge');
    if (!badge) return null;
    const br = badge.getBoundingClientRect(), er = document.getElementById('v').getBoundingClientRect();
    return { dx: Math.abs(br.left - er.left), dy: Math.abs(br.top - er.top) };
  })()`);
  ok(badgePos && badgePos.dx < 5 && badgePos.dy < 5, `.scv-qe-badge exists and is positioned at watched element's corner, not just present somewhere (${JSON.stringify(badgePos)})`);

  // mutate watched element > debounced emit of new value (300ms debounce in kernel.js)
  await js(`document.getElementById('v').textContent = 'changed!'; true`);
  await pollUntil(() => emits.length >= 2, 3000, 25);
  const last = emits[emits.length - 1];
  ok(emits.length >= 2 && last.value === 'changed!' && last.channel === 'live', `change emitted: ${JSON.stringify(last)}`);

  // destroy kernel - watchers persist past tool but must die with it, else observer keeps posting
  await js(`window.$kernel.destroy(); true`);
  await delay(50);
  const nAfterDestroy = emits.length;
  await js(`document.getElementById('v').textContent = 'zombie'; true`);
  await delay(500);
  ok(emits.length === nAfterDestroy, `no zombie emit after destroy (was ${nAfterDestroy}, now ${emits.length})`);
} catch (e) {
  fails++; console.log('  ✗ live-emit tier threw:', e.message);
}

done();
console.log(fails ? `live-emit: FAIL (${fails})` : 'live-emit: PASS');
process.exit(fails ? 1 : 0);