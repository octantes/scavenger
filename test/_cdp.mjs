// shared test helpers - proxy-less headless chrome + cdp, to reach loopback the ssrf proxy blocks

import { spawn } from 'child_process';
import { mkdtemp } from 'fs/promises';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChrome } from '../quests.mjs';

export const MIN_TOOL_COUNT = 30; // shared floor - tools.mjs + build.mjs assert kernel registers at least this many

export async function launchChrome() {
  const bin = process.env.CHROME_PATH || await findChrome();
  const userDir = await mkdtemp(join(tmpdir(), 'scv-test-'));
  const chrome = spawn(bin, [
    '--headless', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', // container/ci hardening - root refuses sandbox, small /dev/shm crashes; test-only chrome
    `--user-data-dir=${userDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanup = () => { try { chrome.kill('SIGTERM'); } catch {} try { rmSync(userDir, { recursive: true, force: true }); } catch {} };
  try {
    const wsUrl = await new Promise((res, rej) => {
      let b = ''; const to = setTimeout(() => rej(new Error('devtools timeout')), 15000);
      chrome.stderr.on('data', d => { b += d; const m = b.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(to); res(m[1]); } });
    });
    const port = wsUrl.match(/:(\d+)\//)[1];
    const target = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json()).find(t => t.type === 'page');
    if (!target) throw new Error('no page-type target found');
    return { chrome, port, pageWsUrl: target.webSocketDebuggerUrl, cleanup };
  } catch (e) { cleanup(); throw e; } // any failure before return must not leak spawned process + temp dir
}

export async function connect(pageWsUrl) { // raw cdp connection over page's ws - used by kernel harness
  const ws = new WebSocket(pageWsUrl);
  await new Promise((res, rej) => { // socket that never opens/errors (chrome wedged mid-launch) must not hang tier
    const timer = setTimeout(() => rej(new Error('CDP ws-open timeout')), 15000);
    ws.onopen = () => { clearTimeout(timer); res(); };
    ws.onerror = e => { clearTimeout(timer); rej(e); };
  });
  let id = 0; const pend = {};
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; } };
  const send = (method, params = {}) => new Promise((res, rej) => { // reject on timeout - dead command fails one tier, doesn't hang suite (ceiling fits ~100kb eval)
    const i = ++id;
    const timer = setTimeout(() => { delete pend[i]; rej(new Error(`CDP timeout: ${method}`)); }, 120000);
    pend[i] = m => { clearTimeout(timer); res(m); };
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const waitEvent = name => new Promise((res, rej) => { // same as send's timeout - unfired event must not hang tier
    const timer = setTimeout(() => { ws.removeEventListener('message', h); rej(new Error(`CDP event timeout: ${name}`)); }, 120000);
    const h = e => { const m = JSON.parse(e.data); if (m.method === name) { clearTimeout(timer); ws.removeEventListener('message', h); res(m); } };
    ws.addEventListener('message', h);
  });
  return { ws, send, waitEvent };
}