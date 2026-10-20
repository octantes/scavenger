// shared test helpers - proxy-less headless chrome + cdp, to reach loopback the ssrf proxy blocks

import { spawn, execFileSync } from 'child_process';
import { mkdtemp } from 'fs/promises';
import { rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findChrome } from '../quests.mjs';

export const MIN_TOOL_COUNT = 30; // shared floor - tools.mjs + build.mjs assert kernel registers at least this many

// browsers die with this process - profile names carry owner pid, next launch sweeps orphans

export const PROFILE = join(tmpdir(), 'scv-test-');
const live = new Set();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killGroup = (pid, sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } }; // own group - renderers and zygote go too
const owned = dir => { const pid = +(dir.slice(PROFILE.length).match(/^(\d+)-/)?.[1] || 0); return pid > 0 && alive(pid); }; // legacy names carry none - orphan
export const orphans = () => { // test browsers whose owning node is gone > [{ pid, dir }]
  let ps = '';
  try { ps = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }); } catch { return []; } // no ps - nothing swept
  return ps.split('\n').flatMap(l => {
    const m = l.match(/^\s*(\d+)\s.*--user-data-dir=(\S+)/);
    return m && m[2].startsWith(PROFILE) && !owned(m[2]) ? [{ pid: +m[1], dir: m[2] }] : [];
  });
};
export const sweep = () => { // kill orphans, drop their profiles - and profiles no browser holds
  const found = orphans();
  found.forEach(o => { try { process.kill(o.pid, 'SIGKILL'); } catch {} });
  const held = new Set(found.map(o => o.dir));
  let dirs = [];
  try { dirs = readdirSync(tmpdir()).map(n => join(tmpdir(), n)).filter(d => d.startsWith(PROFILE)); } catch {}
  dirs.forEach(d => { if (held.has(d) || !owned(d)) try { rmSync(d, { recursive: true, force: true }); } catch {} });
  return found.length;
};
const reap = () => live.forEach(b => b.kill('SIGKILL'));
let hooked = false;
const hook = () => { // on first launch only - suite runner imports sweep and keeps its own handlers
  if (hooked) return; hooked = true;
  process.on('exit', reap);
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, () => { reap(); process.exit(code); });
  for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.error(e); reap(); process.exit(1); });
};

export async function launchChrome() {
  const bin = process.env.CHROME_PATH || await findChrome();
  hook(); sweep();
  const userDir = await mkdtemp(PROFILE + process.pid + '-');
  const chrome = spawn(bin, [
    '--headless', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', // container/ci hardening - root refuses sandbox, small /dev/shm crashes; test-only chrome
    `--user-data-dir=${userDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const b = { kill: sig => { killGroup(chrome.pid, sig); if (sig === 'SIGKILL') try { rmSync(userDir, { recursive: true, force: true }); } catch {} } };
  live.add(b);
  chrome.on('exit', () => { live.delete(b); try { rmSync(userDir, { recursive: true, force: true }); } catch {} });
  const cleanup = () => { // term, then kill if still up - grace never holds process open
    b.kill('SIGTERM');
    setTimeout(() => { if (live.has(b)) b.kill('SIGKILL'); }, 1000).unref();
  };
  try {
    const wsUrl = await new Promise((res, rej) => {
      let b = ''; const to = setTimeout(() => rej(new Error('devtools timeout')), 15000);
      chrome.stderr.on('data', d => { b += d; const m = b.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(to); res(m[1]); } });
    });
    const port = wsUrl.match(/:(\d+)\//)[1];
    const target = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) })).json()).find(t => t.type === 'page');
    if (!target) throw new Error('no page-type target found');
    return { chrome, port, pageWsUrl: target.webSocketDebuggerUrl, cleanup, userDir };
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