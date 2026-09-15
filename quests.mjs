// scavenge.ar - © 2026 octantes.ar - SPDX-License-Identifier: Apache-2.0

import { spawn } from 'child_process';
import { readFile, writeFile, appendFile, mkdtemp, stat, rename, unlink, mkdir, copyFile, cp } from 'fs/promises';
import { rmSync, readlinkSync, realpathSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, basename, dirname } from 'path';
import { createServer, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { connect as netConnect } from 'net';
import { lookup } from 'dns/promises';
import { pathToFileURL, fileURLToPath } from 'url';
import { createHash } from 'crypto';

const SCV_QUESTS_VERSION  = '1.0.0';             // server version - logged at boot and served at get /version
const QUESTS_FILE         = 'quests.json';       // persisted quests json file name
const COMPONENT_DIR       = 'component';         // harvest - quests write each component to readable html here
const ASSET_CACHE_MAX     = 200;                 // proxied component assets kept in memory (evict oldest past this)
const MAX_ASSET_BYTES     = 6 * 1024 * 1024;     // per-asset cap for /asset proxy
const BROWSER_UA          = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'; // asset-proxy fallback ua when no de-headlessed chrome ua yet
const _assetCache         = new Map();           // source url -> { buffer, contentType } - component's remote assets, served from loopback
const HERE                = dirname(fileURLToPath(import.meta.url));
let _bookmarklet = null, _bookmarkletMtime = 0;

async function harvestScript() { // shipped kernel, decoded - injected into headless page to run harvest, same artifact browser runs (reference, not copy)
  const mtime = await stat(join(HERE, 'bookmarklet.js')).then(s => s.mtimeMs, () => 0); // re-read on rebuild - long-running server must not harvest with old cached kernel
  if (_bookmarklet === null || mtime !== _bookmarkletMtime) {
    _bookmarklet = decodeURIComponent((await readFile(join(HERE, 'bookmarklet.js'), 'utf8')).trim().slice('javascript:'.length));
    _bookmarkletMtime = mtime;
  }
  return _bookmarklet;
}

const TEMP_PROFILE_PREFIX = 'scavenger-quests-'; // throwaway --user-data-dir (mkdtemp under tmpdir)
const MAX_JSON_BYTES      = 10 * 1024 * 1024;    // hard cap on a json quest body and a post body
const MAX_QUESTS          = 100;                 // hard cap on registered quests
const CHROME_TIMEOUT      = 15000;               // max ms to wait for chromium devtools websocket connection
const PAGE_TIMEOUT        = 25000;               // cdp round-trip cap - must exceed SELECTOR_WAIT so in-page poll wins
const SELECTOR_WAIT       = 12000;               // how long a selector / key may take to appear (spas render post-load)
let   SCRAPE_DEADLINE     = 60000;               // wall-clock cap on one quest's whole navigate+steps+extract pipeline - each step is individually bounded, but nothing capped the sum, so a many-step quest full of long waits could hold a worker for minutes - configure()-able so tests don't wait out the real default
const SCREENSHOT_SETTLE   = 2500;                // pause after load before a screenshot, so spa has painted
const DEFAULT_INTERVAL    = 30000;               // interval used when a quest omits one
const MIN_INTERVAL        = 3000;                // scrape-interval floor - due-scheduling clamps anything lower
const DEFAULT_PORT        = 9876;                // default http api port
const SCV_TOKEN           = crypto.randomUUID(); // per-run write token - bypasses origin gate for trusted cors writes
let   TICK_INTERVAL       = 5000;                // base polling interval in ms for engine's scrape scheduler
const MAX_TICK_RATE       = 86400000;            // 24h cap on tick interval - >=2^31-1 overflows setInterval into a 1ms busy-loop

const ansi         = /\x1b\[[0-9;?]*[a-zA-Z]/g; // ansi escape sequence matcher - strips terminal formatting codes

function flagValue(names) { // last-wins cli flag lookup supporting both `--flag value` and `--flag=value` forms
  let val = null;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    for (const n of names) {
      if (a === n) { const next = process.argv[i + 1]; val = (next !== undefined && !next.startsWith('-')) ? next : ''; i++; }
      else if (a.startsWith(n + '=')) val = a.slice(n.length + 1);
    }
  }
  return val;
}

const portArg  = flagValue(['--port', '-p']); // cli port argument
const API_PORT = (portArg !== null && portArg !== '' && /^\d+$/.test(portArg)) ? parseInt(portArg, 10) : DEFAULT_PORT; // http api listen port, defaults to 9876
const outArg   = flagValue(['--output', '-o']); // cli output file argument
let OUTPUT_FILE = outArg ? outArg : null; // optional json mirror written after each tick

const T = { // tui tokens
  reset: '\x1b[0m',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  cls: '\x1b[2J',
  home: '\x1b[H',
  eol: '\x1b[K',
  ed: '\x1b[J',
  fg(r,g,b) { return `\x1b[38;2;${r};${g};${b}m`; }, // truecolor foreground escape
  bg(r,g,b) { return `\x1b[48;2;${r};${g};${b}m`; }, // truecolor background escape
};

const PAL = { // matches patchbay and kernel theme - enforced by token tests
  text:      T.fg(0xaa, 0xab, 0xac),
  accent:    T.fg(0x98, 0x6c, 0x98), // output
  secondary: T.fg(0x8a, 0xb6, 0xbb), // input
  danger:    T.fg(0x98, 0x59, 0x54),
  muted:     T.fg(0x88, 0x88, 0x88),
  reader:    T.fg(0x66, 0x66, 0x66),
  success:   T.fg(0x6f, 0xac, 0x67),
};

function sLen(s) { return s.replace(ansi, '').length; } // return visible length of s ignoring ansi escapes

function sPad(s, w) { // pad to visible width w
  const n = sLen(s);
  return n >= w ? s : s + ' '.repeat(w - n);
}

function sTrunc(s, w) { // truncate to visible width w with a trailing ellipsis
  const p = s.replace(ansi, '');
  return p.length <= w ? s : p.slice(0, Math.max(0, w - 3)) + '...';
}

const historyVal = flagValue(['--history']);
let HISTORY_FILE = null;
if (historyVal !== null) { // opt in append only history - one line per change - argument --history autonames, name overrides
  HISTORY_FILE = historyVal || `quest-history-${new Date().toISOString().slice(0, 10)}.jsonl`;
}

// escape hatch for non-loopback local topologies - argument --trust-ip adds write-ips and binds - loopback is always trusted
let TRUST_IPS = (flagValue(['--trust-ip']) || process.env.SCAV_TRUST_IP || '')
  .split(',').map(s => s.trim()).filter(Boolean);
let BIND_HOST = TRUST_IPS.length ? '0.0.0.0' : '127.0.0.1';

async function findChrome() { // locate chromium binary - checks all os well-known paths
  if (process.env.CHROME_PATH) {
    try { await stat(process.env.CHROME_PATH); return process.env.CHROME_PATH; }
    catch { throw new Error(`CHROME_PATH not found: ${process.env.CHROME_PATH}`); }
  }
  const firstExisting = async (paths) => { for (const p of paths) { try { await stat(p); return p; } catch {} } return null; };

  if (process.platform === 'darwin') {
    const found = await firstExisting([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    ]);
    if (found) return found;
    throw new Error('chromium not found - install chrome/chromium or set CHROME_PATH');
  }
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const found = await firstExisting([
      join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      join(la, 'Chromium', 'Application', 'chrome.exe'),
    ]);
    if (found) return found;
    throw new Error('chromium not found - install chrome/edge or set CHROME_PATH');
  }
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'chrome', 'brave-browser', 'brave',
                      'microsoft-edge', 'msedge', 'vivaldi', 'vivaldi-stable', 'opera'];
  for (const cmd of candidates) {
    try {
      const proc = spawn('which', [cmd]);
      let out = '';
      proc.stdout.on('data', d => out += d.toString());
      await new Promise((resolve, reject) => { proc.on('close', code => code === 0 ? resolve() : reject()); proc.on('error', reject); });
      return out.trim();
    } catch {}
  }
  throw new Error('chromium not found - install it or set CHROME_PATH');
}

function defaultUserDataDir(bin) { // map discovered chromium bin to user profile directory to reuse cookies/sessions
  const home = homedir();
  const name = basename(bin).toLowerCase();
  const brave = name.includes('brave'), edge = name.includes('edge') || name.includes('msedge'),
        vivaldi = name.includes('vivaldi'), opera = name.includes('opera'),
        chrome = name.includes('google chrome') || name.includes('google-chrome')
              || (name.includes('chrome') && !name.includes('chromium'));
  if (process.platform === 'darwin') {
    const lib = join(home, 'Library', 'Application Support');
    if (brave)   return join(lib, 'BraveSoftware', 'Brave-Browser');
    if (chrome)  return join(lib, 'Google', 'Chrome');
    if (edge)    return join(lib, 'Microsoft Edge');
    if (vivaldi) return join(lib, 'Vivaldi');
    if (opera)   return join(lib, 'com.operasoftware.Opera');
    return join(lib, 'Chromium');
  }
  if (process.platform === 'win32') {
    const la = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    if (brave)   return join(la, 'BraveSoftware', 'Brave-Browser', 'User Data');
    if (chrome)  return join(la, 'Google', 'Chrome', 'User Data');
    if (edge)    return join(la, 'Microsoft', 'Edge', 'User Data');
    if (vivaldi) return join(la, 'Vivaldi', 'User Data');
    if (opera)   return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Opera Software', 'Opera Stable');
    return join(la, 'Chromium', 'User Data');
  }
  // linux
  if (brave)   return join(home, '.config', 'BraveSoftware', 'Brave-Browser');
  if (chrome)  return join(home, '.config', 'google-chrome');
  if (edge)    return join(home, '.config', 'microsoft-edge');
  if (vivaldi) return join(home, '.config', 'vivaldi');
  if (opera)   return join(home, '.config', 'opera');
  return join(home, '.config', 'chromium');
}

function streamWait(stream, pattern, timeout) { // resolve when stream emits data matching pattern, reject on timeout
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => { // detach listeners so a chrome that died silently can't hold the process or fire on later stderr
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('error', onError);
    };
    const onData = (data) => {
      const m = data.toString().match(pattern);
      if (m) { cleanup(); resolve(m[1]); }
    };
    const onError = (e) => { cleanup(); reject(e); };
    timer = setTimeout(() => { cleanup(); reject(new Error('stream wait timeout')); }, timeout);
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

function isLocalOrigin(origin, port) { // report whether http origin header refers to local api server itself, on our port
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    const originPort = u.port || (u.protocol === 'https:' ? '443' : '80');
    return local && originPort === String(port);
  } catch { return false; }
}

let ALLOW_LOCAL = false; // relaxed only by --run --allow-local so tests can hit local dev server - loopback write gate is separate

function decimalOrHexIPv4(hostname) { // canonicalize inet_aton-style encodings (decimal/hex/octal) some resolvers accept - classic ssrf-filter bypass
  const toQuad = n => (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) ? [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.') : null;
  if (/^\d+$/.test(hostname)) return toQuad(Number(hostname)); // bare decimal, e.g. 2130706433 -> 127.0.0.1
  if (/^0x[0-9a-f]+$/i.test(hostname)) return toQuad(parseInt(hostname, 16)); // bare hex, e.g. 0x7f000001 -> 127.0.0.1
  if (/^(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)(\.(0x[0-9a-f]+|0[0-7]*|[1-9]\d*)){1,3}$/i.test(hostname)) { // per-octet hex/octal, e.g. 0177.0.0.1
    const parts = hostname.split('.').map(p => /^0x/i.test(p) ? parseInt(p, 16) : parseInt(p, /^0/.test(p) ? 8 : 10));
    if (parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255)) return parts.join('.');
  }
  return null;
}

function isPrivateAddr(host) { // report whether host is loopback / private / link-local address (ssrf deny-list)
  if (ALLOW_LOCAL) return false; // disables whole deny-list process-wide - accepted: only --allow-local sets it, never network input
  const bare = String(host || '').replace(/^\[|\]$/g, ''); // exported predicate - non-string caller must get answer, not throw
  const hostname = decimalOrHexIPv4(bare) || bare;
  if (hostname === 'localhost' || /^127\./.test(hostname) || hostname === '::1' || hostname === '0.0.0.0') return true;
  if (/^0*(:0*)*:0*$/.test(hostname)) return true; // ipv6 unspecified - :: routes to dual-stack local listeners, same as 0.0.0.0
  if (/^::ffff:/i.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(hostname)) return true; // fe80::/10 link-local - ipv6 twin of 169.254
  return false;
}

function isPrivateIP(urlStr) { // report whether url's hostname is private address (false on a malformed url)
  try { return isPrivateAddr(new URL(urlStr).hostname); } catch { return false; }
}

function isValidQuestUrl(urlStr) { // report whether url is public http(s) target safe to scrape (syntactic check)
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    return !isPrivateIP(urlStr);
  } catch { return false; }
}

async function questUrlIsSafe(urlStr) { // ssrf fast fail-fast - resolve name and reject if any address is private
  if (!isValidQuestUrl(urlStr)) return false;
  try {
    const bare = new URL(urlStr).hostname.replace(/^\[|\]$/g, '');
    if (/^[0-9.]+$/.test(bare) || bare.includes(':')) return true; // literal ip's already vetted, only names need dns
    const addrs = await lookup(bare, { all: true });
    return addrs.length > 0 && addrs.every(a => !isPrivateAddr(a.address));
  } catch { return false; }
}

async function resolvePublicIP(hostname) { // resolve hostname to validated public ip - callers pin this address
  const bare = (hostname || '').replace(/^\[|\]$/g, '');
  if (!bare) throw new Error('no host');
  if (/^[0-9.]+$/.test(bare) || bare.includes(':')) {
    if (isPrivateAddr(bare)) throw new Error('private address');
    return { address: bare, family: bare.includes(':') ? 6 : 4 };
  }
  const addrs = await lookup(bare, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateAddr(a.address))) throw new Error('resolves to private address');
  return addrs.find(a => a.family === 4) || addrs[0]; // ipv4-first - a host answering only aaaa on an ipv6-less network still connects
}

const pinnedLookup = ip => (host, opts, cb) => // lookup override, returns pre validated ip - node calls it with all:true
  (opts && opts.all) ? cb(null, [{ address: ip.address, family: ip.family }]) : cb(null, ip.address, ip.family);

function pinnedGet(urlStr, maxBytes, timeoutMs, redirectsLeft = 3, truncate = false, binary = false, headers = null) { // get url as text (or {buffer, contentType} when binary), dns pinned to validated public ip - truncate keeps what arrived instead of failing
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('bad url')); }
    if (!['http:', 'https:'].includes(u.protocol)) return reject(new Error('bad protocol'));
    let req;
    const deadline = setTimeout(() => { // hard wall-clock cap - a trickling/streaming body can't extend forever past it
      if (req) req.destroy(new Error('deadline timeout')); else reject(new Error('deadline timeout'));
    }, timeoutMs);
    const clear = () => clearTimeout(deadline);
    resolvePublicIP(u.hostname).then(ip => {
      const mod = u.protocol === 'https:' ? httpsRequest : httpRequest;
      req = mod({
        protocol: u.protocol, hostname: u.hostname, servername: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'GET',
        headers: headers || { 'User-Agent': 'Scavenger-Quest/1.0' },
        lookup: pinnedLookup(ip), // pin: connect to validated ip, never re-resolve
        timeout: timeoutMs,
      }, res => {
        const st = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(st) && res.headers.location && redirectsLeft > 0) {
          res.resume(); // drain
          clear();
          let next; try { next = new URL(res.headers.location, urlStr).toString(); } catch { return reject(new Error('bad redirect')); }
          return resolve(pinnedGet(next, maxBytes, timeoutMs, redirectsLeft - 1, truncate, binary, headers)); // re-validate new host too
        }
        if (st < 200 || st >= 300) { res.resume(); clear(); return reject(new Error(`HTTP ${st}`)); }
        const chunks = []; let total = 0, capped = false;
        res.on('data', c => {
          if (capped) return;
          chunks.push(c); total += c.length;
          if (total > maxBytes) { // cap hit - truncating caller wants prefix, everyone else wants failure
            capped = true; clear(); req.destroy();
            if (truncate) resolve(Buffer.concat(chunks).toString('utf8'));
            else reject(new Error('response too large'));
          }
        });
        res.on('end', () => { clear(); resolve(binary ? { buffer: Buffer.concat(chunks), contentType: res.headers['content-type'] || 'application/octet-stream' } : Buffer.concat(chunks).toString('utf8')); });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', e => { clear(); reject(e); });
      req.end();
    }).catch(e => { clear(); reject(e); });
  });
}

function isOwnerWrite(req) { // owner only write guard - write accepted only on direct loopback connection without proxy
  const ra = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const loopback = ra === '127.0.0.1' || ra === '::1';
  const trusted = TRUST_IPS.includes(ra);
  const proxied = !!req.headers['x-forwarded-for'] || !!req.headers['forwarded'];
  return (loopback || trusted) && !proxied;
}

async function readQuests() { // load quest list from disk - returns [] on any read/parse error
  try { const q = JSON.parse(await readFile(QUESTS_FILE, 'utf-8')); return Array.isArray(q) ? q : []; } catch { return []; }
}

let _questQueue = Promise.resolve();

let _historyQueue = Promise.resolve(); // serialize history-log appends so a slow disk queues writes instead of piling up unbounded fire-and-forgets
let _historyPending = 0;
const HISTORY_QUEUE_MAX = 200; // best-effort log - past this, drop rather than let a stalled disk grow memory without bound
function appendHistory(file, line) {
  if (_historyPending >= HISTORY_QUEUE_MAX) return;
  _historyPending++;
  _historyQueue = _historyQueue.then(() => appendFile(file, line).catch(() => {})).finally(() => { _historyPending--; });
}

let _tmpSeq = 0; // temp file + atomic rename on posix to prevent mid write crash leaving file truncated, never partial result
async function atomicWrite(file, data) { // write data to file atomically via a unique temp + rename
  const tmp = `${file}.${process.pid}.${_tmpSeq++}.tmp`; // unique temp per call - write overlap safety
  try { await writeFile(tmp, data); }
  catch (e) { await unlink(tmp).catch(() => {}); throw e; } // stray partial tmp on a failed write must not linger
  try {
    await rename(tmp, file); // atomic on posix
  } catch (e) { // windows rename can't replace existing file, locking target, so unlink then rename and retry
    if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EBUSY') {
      for (let attempt = 0; ; attempt++) {
        await new Promise(r => setTimeout(r, 10)); // give whatever holds lock (av scanner, indexer) a moment to release
        try { await rename(tmp, file); break; } // retry non-destructive path - original stays put as long as this keeps failing
        catch (e2) {
          if (attempt < 3) continue;
          // out of retries: original is still intact - copy tmp's bytes over it instead of unlinking first and risking a lost write
          try { await copyFile(tmp, file); await unlink(tmp).catch(() => {}); break; }
          catch { await unlink(tmp).catch(() => {}); throw e2; }
        }
      }
    }
    else { await unlink(tmp).catch(() => {}); throw e; }
  }
}

function updateQuests(fn) { // serialize read-modify-write of json onto queue (fn mutates parsed list)
  const result = _questQueue.then(async () => { // serialize onto queue, reassigning gate synchronously so concurrent call chains
    // corrupt json aborts write, missing file is legitimately empty - prevents [] persist on corrupt file
    let q;
    try { q = JSON.parse(await readFile(QUESTS_FILE, 'utf-8')); }
    catch (e) {
      if (e.code === 'ENOENT') q = [];
      else if (e.code === 'EACCES' || e.code === 'EISDIR') throw new Error(`cannot read quests.json (${e.code}) - refusing to overwrite it`);
      else throw new Error(`quests.json is not valid JSON - refusing to overwrite it: ${e.message}`);
    }
    if (!Array.isArray(q)) throw new Error('quests.json must contain an array - refusing to overwrite it');
    const r = fn(q);
    await atomicWrite(QUESTS_FILE, JSON.stringify(q, null, 2));
    return r;
  });
  _questQueue = result.catch(() => {}); // swallowed copy, caller gets real result or error through 'result'
  return result;
}

const ADD_DATA_DEFAULTS = { kernel: '', channel: '', url: '', selector: '', interval: String(DEFAULT_INTERVAL) };

const SORT_KEYS         = ['default', 'channel', 'status', 'age', 'value']; // cycled by < / >
const FILTERS           = ['all', 'scheduled', 'manual'];                   // cycled by v
const STEP_VERBS        = ['wait', 'click', 'scroll', 'type', 'drag'];      // interaction pipeline verbs (before extraction)

function sanitizeSteps(arr) { // coerce untrusted steps array into clean single-verb steps - drop unknowns, cap count + arg length
  if (!Array.isArray(arr)) return undefined;
  const out = [];
  for (const s of arr.slice(0, 25)) {
    if (!s || typeof s !== 'object') continue;
    const v = Object.keys(s)[0];
    const arg = s[v];
    // numeric args like {wait: 500} are equivalent to "500" - coerce instead of silently dropping step
    if (STEP_VERBS.includes(v) && (typeof arg === 'string' || typeof arg === 'number') && String(arg).length <= 500)
      out.push({ [v]: String(arg) });
  }
  return out.length ? out : undefined; // returns undefined for an empty list
}

function proxyAssets(html) { // rewrite component's remote asset urls through /asset - patchbay then loads them from loopback (cached, no cors, sovereign) instead of source cdn
  const base = `http://127.0.0.1:${API_PORT}/asset?url=`;
  const proxy = u => base + encodeURIComponent(u);
  return html
    .replace(/(\ssrc=")(https?:\/\/[^"]+)(")/gi, (m, a, u, b) => a + proxy(u) + b)
    .replace(/(url\((['"]?))(https?:\/\/[^)'"]+)(\2\))/gi, (m, a, q, u, b) => a + proxy(u) + b)
    .replace(/(\ssrcset=")([^"]+)(")/gi, (m, a, set, b) => a + set.split(',').map(c => { const p = c.trim().split(/\s+/); if (/^https?:/i.test(p[0] || '')) p[0] = proxy(p[0]); return p.join(' '); }).join(', ') + b);
}

function parseExtraction(s) { // parse one extraction segment (pipeline's last) by prefix
  if (s.startsWith('key:'))     return { jsonKey: s.slice(4).trim() };
  if (s.startsWith('ls:'))      return { storageKey: s.slice(3).trim() };
  if (s.startsWith('sel:'))     return { selector: s.slice(4).trim() };
  if (s.startsWith('harvest:')) return { harvestSel: s.slice(8).trim() }; // full component, not value - harvested live in ref-mode
  return { selector: s };
}

function parseTarget(raw) { // parse a |-separated target pipeline into steps object, shared by tui and tests runner
  const segs = String(raw || '').split('|').map(s => s.trim()).filter(Boolean);
  if (!segs.length) return {};
  const extraction = parseExtraction(segs.pop());
  const steps = [];
  for (const seg of segs.slice(0, 25)) {
    const ci = seg.indexOf(':');
    if (ci < 0) continue;
    const verb = seg.slice(0, ci).trim().toLowerCase();
    const arg = seg.slice(ci + 1).trim();
    if (STEP_VERBS.includes(verb) && arg) steps.push({ [verb]: arg });
  }
  return steps.length ? { steps, ...extraction } : extraction;
}

function shortHash(str) { // stable short channel id from url/name - byte-identical to patchbay's, so unnamed quest keys same across both
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
  return Math.abs(h).toString(36).slice(0, 6);
}

function parseQuestLine(line) { // parse config into quest object - no channel name if first field is url - mirrors patchbay + kernel
  const trimmed = String(line).trim();
  if (/^https?:\/\//i.test(trimmed)) { // url-led line: url may itself contain commas - take it verbatim, rest is target
    const url = (trimmed.match(/^https?:\/\/\S+/i) || [''])[0].replace(/,\s*$/, '');
    const target = trimmed.slice(trimmed.indexOf(url) + url.length).replace(/^\s*,?\s*/, '').trim();
    return { url, ...parseTarget(target) };
  }
  const parts = trimmed.split(',');
  const channel = (parts[0] || '').trim();
  const url = (parts[1] || '').trim();
  const target = parts.slice(2).join(',').trim();
  return { ...(channel ? { channel } : {}), url, ...parseTarget(target) };
}

function unfurl(html, base) { // extract title/description/og:image from page for patchbay link-cards
  const metas = [...String(html).matchAll(/<meta[^>]*>/gi)].map(m => m[0]);
  const metaOf = key => { // attribute order or quote style - content of meta where property/name matches key
    for (const t of metas) {
      const n = t.match(/property=["']([^"']+)["']/i) || t.match(/name=["']([^"']+)["']/i);
      if (!n || n[1].toLowerCase() !== key) continue;
      const c = t.match(/content=["']([^"']*)["']/i);
      if (c) return c[1];
    }
    return '';
  };
  const clean = s => String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  let image = clean(metaOf('og:image') || metaOf('twitter:image'));
  if (image && !/^https?:/i.test(image)) { try { image = new URL(image, base).href; } catch { image = ''; } }
  return {
    title: clean(metaOf('og:title') || metaOf('twitter:title') || (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').slice(0, 120),
    description: clean(metaOf('og:description') || metaOf('description') || '').slice(0, 300),
    image,
  };
}

function readJsonBody(req, send, maxBytes, onBody) { // stream request body under byte cap, then parse json for onBody
  const chunks = []; let bytes = 0, tooBig = false;
  req.on('error', () => { chunks.length = 0; }); // client abort/truncate mid-body - must never surface as an uncaughtException
  req.on('aborted', () => { chunks.length = 0; }); // same - body stream died before 'end'
  req.on('data', c => {
    if (tooBig) return; // over cap: discard further chunks (memory-safe) - let body drain to term
    bytes += c.length;
    if (bytes > maxBytes) { tooBig = true; chunks.length = 0; send(413, { error: 'body too large' }); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (tooBig) return;
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
      await onBody(input);
    } catch (err) { try { send(400, { error: err.message }); } catch {} } // bad json returns 400 - already-sent guard for a late throw
  });
}

// ENGINE + TUI (presentation layer over engine, reads state, drives it through methods - coupling is thin)

class QuestEngine {
  constructor() { // initialize engine state - browser is launched later in init/start
    this.ws               = null;       // primary cdp websocket connection for headless browser page
    this.chrome           = null;       // child process of running chromium instance
    this.msgId            = 0;          // auto-incrementing id for cdp json-rpc messages
    this.pending          = {};         // map of in-flight cdp requests keyed by msgId
    this.lastRun          = Object.create(null); // map of channel names to their last scrape timestamp - null proto so `__proto__` channels can't hit Object.prototype
    this._startTime       = Date.now(); // engine boot timestamp for uptime display
    this._questStates     = new Map();  // real time volatile state per channel
    this._questsCache     = [];         // in memory array copy of parsed quests.json entries
    this._lastTickMs      = 0;          // duration of most recent scrape cycle
    this._durations       = [];         // ring buffer of recent tick durations to calculate rolling average
    this._chromeConnected = false;      // true when primary cdp websocket is established and healthy
    this._engineError     = null;       // engine-down message (notif bar) - cleared on successful connect
    this._profileMode     = 'temp';     // temp (fresh) | live (lock real profile) | snapshot (copy cookies)
    this._chromeBin       = null;       // file path to discovered chromium executable
    this._userDir         = null;       // current --user-data-dir (temp/snapshot/live) - set in init/relaunch
    this._log             = [];         // scrape history for log view
    this._componentHash   = new Map();  // channel > last written component hash - unchanged harvest skips disk write
    this._concurrency     = 1;          // parallel dom scrapes amount (configurable in chromium help menu)
    this._extraPages      = [];         // extra cdp pages beyond primary (pool)
    this._debugPort       = null;       // local port number for chromium's remote debugging server
    this._ua              = null;       // de-headlessed user-agent applied to every page (see _launchChrome)
    this._notice          = null;       // persistent notif-bar message (survives reconnect that clears _engineError)
    this._proxy           = null;       // egress proxy server (ssrf-pinned) - started in init
    this.server           = null;       // http api server
    this._retryTimer      = null;       // crash-recovery backoff timer
    this._retryN          = 0;          // crash-recovery attempt count
    this.onRender         = null;       // set by tui: called after any state change worth repainting
  }

  async init() { // start engine: egress proxy + api + headless chromium (chrome failure is non-fatal)
    await this._startEgressProxy();
    await this.startAPI();
    try { // engine bring-up is best effort since json-key quests run browserless - record failures
      this._chromeBin = await findChrome();
      this._userDir = await this._freshProfileDir();
      await this._launchChrome(this._userDir);
      this._setCrashHandler();
    } catch (e) {
      this._chromeConnected = false;
      this._engineError = e.message;
    }
  }

  async _launchChrome(userDir) { // launch headless chromium with given --user-data-dir, wire up devtools ws and set cdp msg handlers
    const args = [
      '--headless',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--mute-audio',
      `--proxy-server=http://127.0.0.1:${this._proxy.address().port}`,
      '--proxy-bypass-list=<-loopback>',
      `--user-data-dir=${userDir}`,
      'about:blank'
    ];

    this.chrome = spawn(this._chromeBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const spawnErr = new Promise((_, rej) => this.chrome.on('error', rej)); // binary missing/denied fails fast instead of unhandled 'error'

    const wsUrl = await Promise.race([streamWait(this.chrome.stderr, /DevTools listening on (ws:\/\/[^\s]+)/, CHROME_TIMEOUT), spawnErr]);
    const port = wsUrl.match(/:(\d+)\//)[1];
    this._debugPort = port;
    this._extraPages = []; // fresh browser has no pool yet - (re)built lazily by _ensurePool

    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(CHROME_TIMEOUT) });
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page');
    if (!page) throw new Error('no page target');

    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { // ws handshake needs its own deadline - a silent devtools never opens or errors
      const to = setTimeout(() => { this.ws.onopen = null; this.ws.onerror = null; this.ws.close(); reject(new Error('devtools ws timeout')); }, CHROME_TIMEOUT);
      this.ws.onopen = () => { clearTimeout(to); resolve(); };
      this.ws.onerror = () => { clearTimeout(to); reject(new Error('devtools ws error')); };
    });
    this._chromeConnected = true;
    this._engineError = null;     // cleared on a successful (re)connect
    this._retryN = 0;             // reset crash-recovery backoff

    this.ws.onmessage = e => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.id && this.pending[msg.id]) {
        clearTimeout(this.pending[msg.id].timer);
        this.pending[msg.id].resolve(msg);
        delete this.pending[msg.id];
      }
    };

    this.ws.onclose = () => {
      this._chromeConnected = false;
      Object.values(this.pending).forEach(p => { clearTimeout(p.timer); p.reject(new Error('ws closed')); });
      this.pending = {};
    };

    await this._send('Page.enable');
    await this._send('Page.setLifecycleEventsEnabled', { enabled: true }); // frame/loader-correlated load events for _navigate

    try { // sites that sniff ua refuse to load for headless - present a normal chrome ua, stripping headless
      const ua = (await this._send('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }))?.result?.result?.value || '';
      this._ua = ua.includes('Headless') ? ua.replace(/HeadlessChrome/g, 'Chrome').replace(/\s*Headless/g, '') : null;
    } catch { this._ua = null; }
    await this._applyUAOverride(this);
  }

  async _applyUAOverride(page) { // apply de-headlessed ua to page target (network domain must be on it) - best effort
    if (!this._ua) return;
    try {
      await this._send('Network.enable', {}, page);
      await this._send('Network.setUserAgentOverride', { userAgent: this._ua }, page);
    } catch {}
  }

  async _relaunchChrome() { // tear down chrome + ws, pick new user-data-dir per _profileMode and re-launch (proxy stays up)
    clearTimeout(this._retryTimer); this._retryN = 0; // deliberate relaunch cancels crash-retry backoff
    this._notice = null; // fresh attempt, drop any stale profile-fallback notice
    this._closePool(); // extra tabs belong to dying browser, new one rebuilds lazily
    if (this.ws) { this.ws.onclose = null; this.ws.onmessage = null; this.ws.close(); }
    this.chrome?.removeAllListeners('exit'); // disarm crash retry before deliberate kill, else a fast exit re-schedules a stale one
    this.chrome?.kill('SIGTERM');
    if (this.chrome) { // wait for old process to fully die so user-profile re-launch doesn't colide with live instance on same dir
      await new Promise(resolve => {
        const to = setTimeout(() => { this.chrome?.kill('SIGKILL'); resolve(); }, 3000);
        this.chrome.on('exit', () => { clearTimeout(to); resolve(); });
        if (this.chrome.exitCode != null) { clearTimeout(to); resolve(); } // already dead, don't wait for stuck listener
      });
    }

    const oldDir = this._userDir;
    this._userDir = await this._resolveUserDir();
    if (oldDir && oldDir.startsWith(tmpdir())) { // clean up old temp/snapshot dir
      try { rmSync(oldDir, { recursive: true, force: true }); } catch {}
    }

    try {
      await this._launchChrome(this._userDir);
    } catch (e) { // profile-backed launch failed - keep engine alive on fresh temp profile, without changing _profileMode
      const failedDir = this._userDir;
      const wasTempFallback = basename(failedDir).startsWith(TEMP_PROFILE_PREFIX);
      if (!wasTempFallback) {
        this._notice = this._notice || 'profile launch failed - using a temporary profile';
        this._userDir = await this._freshProfileDir();
        if (failedDir && failedDir.startsWith(tmpdir())) { // snapshot dir holds cookies and local state key - never strand nor touch live profile
          try { rmSync(failedDir, { recursive: true, force: true }); } catch {}
        }
        await this._launchChrome(this._userDir);
      } else {
        throw e;
      }
    }
    this._setCrashHandler();
  }

  _freshProfileDir() { return mkdtemp(join(tmpdir(), TEMP_PROFILE_PREFIX)); } // fresh throwaway --user-data-dir under tempdir()

  async _resolveUserDir() { // pick next launch's --user-data-dir from _profileMode - never throws/mutates mode
    if (this._profileMode === 'live') {
      try { // snapshot branch guards its source lookup; live must too - a browserless engine (no _chromeBin) can't basename(null)
        const profileDir = defaultUserDataDir(this._chromeBin);
        if (this._profileLockFree(profileDir)) return profileDir;
        // live chrome holds profile (sharing corrupts it), so fall back to temp dir and point user at snapshot mode
        this._notice = 'profile in use by another Chrome - close it, or cycle to snapshot';
      } catch {
        this._notice = 'no live profile to use - using a temporary profile';
      }
      return this._freshProfileDir();
    }
    if (this._profileMode === 'snapshot') {
      try { return await this._snapshotProfile(); }
      catch {
        this._notice = 'no cookies to snapshot - using a temporary profile';
        return this._freshProfileDir();
      }
    }
    return this._freshProfileDir();
  }

  async _snapshotProfile() { // copy session state into fresh scavenger-owned profile so headless scrapes auth without locking live
    const src = defaultUserDataDir(this._chromeBin);
    const dir = await mkdtemp(join(tmpdir(), 'scavenger-snapshot-'));
    try {
      await copyFile(join(src, 'Local State'), join(dir, 'Local State')); // throws if absent, caller falls back
      await mkdir(join(dir, 'Default'), { recursive: true });
      let got = false;

      for (const rel of ['Default/Cookies', 'Default/Network/Cookies']) { // cookies live in default profile - copy whichever + sidecars
        try {
          const to = join(dir, rel);
          await mkdir(dirname(to), { recursive: true });
          await copyFile(join(src, rel), to);
          for (const ext of ['-wal', '-shm', '-journal']) {
            try { await copyFile(join(src, rel + ext), to + ext); } catch {}
          }
          got = true;
        } catch {}
      }

      // not cookies session state - localstorage + indexed recursive copy - best effort
      for (const rel of ['Default/Local Storage', 'Default/Session Storage', 'Default/IndexedDB']) {
        try { await cp(join(src, rel), join(dir, rel), { recursive: true }); got = true; } catch {}
      }

      if (!got) throw new Error('no session state found to snapshot');
      return dir;
    } catch (err) { // failed snapshot must not orphan temp dir - it holds a full session copy (cookies + encryption key)
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      throw err;
    }
  }

  _profileLockFree(dir) { // is --user-data-dir free to launch into? chrome guards it, live pid means browser owns it
    let target;
    try { target = readlinkSync(join(dir, 'SingletonLock')); }
    catch { return true; }                                     // no lock: free
    const pid = parseInt((target.split('-').pop() || ''), 10);
    if (pid > 0) {
      try { process.kill(pid, 0); return false; }              // alive: in use, leave it
      catch (e) { if (e.code === 'EPERM') return false; }      // exists but not ours: in use
    } else return false; // symlink-form lock without a parseable pid - assume a live profile holds it
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      try { rmSync(join(dir, f), { force: true }); } catch {}
    }
    return true;
  }

  _setCrashHandler() { // on chromium exit, flag engine down + schedule relaunch (never kills process)
    this.chrome?.on('exit', () => { // engine down, don't kill process - keeps quests running - try self heal with relaunch
      this._chromeConnected = false;
      this._scheduleEngineRetry();
    });
  }

  _scheduleEngineRetry() { // relaunch chromium with backoff, giving up (with notice) after five tries
    const n = (this._retryN || 0) + 1;
    if (n > 5) { this._engineError = 'chromium keeps crashing - press c to relaunch'; return this.onRender?.(); }
    this._retryN = n;
    const delay = Math.min(30000, 1000 * 2 ** (n - 1)); // 1s - 2s - 4s - 8s - 16s
    this._engineError = `chromium exited - retry ${n}/5 in ${delay / 1000}s`;
    this.onRender?.();
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => {
      this._launchChrome(this._userDir).then(() => this._setCrashHandler()).catch(() => this._scheduleEngineRetry());
    }, delay);
  }

  startAPI() { // start http api: reads are open, writes are owner-loopback / scv-token gated
    this.server = createServer(async (req, res) => {
      const send = (code, data) => {
        if (res.headersSent) return; // idempotent - an async callback sending after reply went out must not throw ERR_HTTP_HEADERS_SENT
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, scv-token');
        if (typeof data === 'object') {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(code);
          res.end(JSON.stringify(data));
        } else {
          res.writeHead(code);
          res.end(data);
        }
      };

      if (req.method === 'OPTIONS') return send(204, ''); // always allow preflight - auth happens on actual write below

      if (req.method !== 'GET' && !isOwnerWrite(req)) { // owner only write guard - every non-get must arrive on direct loopback, no proxy
        return send(403, { error: 'writes are local-only' });
      }

      // defence in depth on loopback gate: allow null origins for file:// - loopback gated so residual is only same-machine griefing
      const origin = req.headers['origin'];
      const tokened = req.headers['scv-token'] === SCV_TOKEN;
      if (origin && req.method !== 'GET' && !tokened) {
        if (!isLocalOrigin(origin, API_PORT) && origin !== 'null') {
          return send(403, { error: 'forbidden' });
        }
      }

      if (req.method === 'GET' && req.url === '/version') {
        return send(200, { version: SCV_QUESTS_VERSION });
      }

      if (req.method === 'GET' && (req.url === '/unfurl' || req.url.startsWith('/unfurl?'))) { // page metadata for patchbay link cards
        let u; try { u = new URL(req.url, 'http://x').searchParams.get('url'); } catch { u = null; }
        if (!u || !isValidQuestUrl(u)) return send(400, { error: 'invalid url' });
        let html = '';
        try { html = await pinnedGet(u, 512 * 1024, 6000, 3, true); } catch {} // truncating: og tags sit in <head>, so 2mb article must not fail whole
        return send(200, html ? unfurl(html, u) : {});
      }

      if (req.method === 'GET' && req.url === '/quests') {
        return send(200, await readQuests());
      }

      if (req.method === 'GET' && req.url.startsWith('/asset?')) { // proxy component's remote asset - fetch it ssrf-safe, cache, serve from loopback (reliable, no cors, sovereign)
        let target; try { target = new URL(req.url, 'http://x').searchParams.get('url'); } catch { target = null; }
        if (!target || !isValidQuestUrl(target)) return send(400, { error: 'bad asset url' });
        const serve = a => { if (res.headersSent) return; res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Content-Type', a.contentType); res.setHeader('Cache-Control', 'max-age=3600'); res.writeHead(200); res.end(a.buffer); };
        const hit = _assetCache.get(target);
        if (hit) return serve(hit);
        const bh = this._browserHeaders(target);
        try {
          const a = await pinnedGet(target, MAX_ASSET_BYTES, 8000, 3, false, true, bh);
          if (_assetCache.size >= ASSET_CACHE_MAX) _assetCache.delete(_assetCache.keys().next().value); // evict oldest
          _assetCache.set(target, a);
          return serve(a);
        } catch { return send(502, { error: 'asset fetch failed' }); }
      }

      if (req.method === 'GET' && req.url.startsWith('/component/')) { // serve harvested component file (public read)
        const name = decodeURIComponent(req.url.slice('/component/'.length).split(/[#?]/)[0]);
        if (!/^[\w-]+\.html$/.test(name)) return send(400, { error: 'bad component name' }); // bare filename, no path traversal
        try { res.setHeader('Content-Type', 'text/html'); return send(200, await readFile(join(COMPONENT_DIR, name), 'utf8')); }
        catch { return send(404, { error: 'no such component' }); }
      }

      if (req.method === 'POST' && req.url === '/quests') {
        readJsonBody(req, send, MAX_JSON_BYTES, async (input) => {
            if (!input.channel || typeof input.channel !== 'string') return send(400, { error: 'channel required' });
            if (input.url && !isValidQuestUrl(input.url)) return send(400, { error: 'invalid quest URL' });
            if (input.url && !(await questUrlIsSafe(input.url))) return send(400, { error: 'quest URL must resolve to a public address' }); // fail-fast at write, not per-scrape death
            const quests = await updateQuests(q => {
              const idx = q.findIndex(x => x.channel === input.channel);
              if (idx < 0 && q.length >= MAX_QUESTS) throw new Error(`max ${MAX_QUESTS} quests`);
              const rawIv = input.interval != null ? Number(input.interval) : NaN;
              const interval = Number.isFinite(rawIv) && rawIv > 0 ? rawIv : DEFAULT_INTERVAL; // NaN/Infinity strings must not persist as garbage
              const entry = { channel: input.channel, url: input.url, interval: Math.max(MIN_INTERVAL, interval) };
              // clients send raw target pipeline and server parses it; a structured target object is used as-is, never String()'d into "[object Object]"
              const t = input.target != null ? (typeof input.target === 'string' ? parseTarget(input.target) : input.target) : {};
              const selector = t.selector ?? input.selector;
              const jsonKey = t.jsonKey ?? input.jsonKey;
              const storageKey = t.storageKey ?? input.storageKey;
              const harvestSel = t.harvestSel ?? input.harvestSel;
              const steps = sanitizeSteps(t.steps ?? input.steps);
              if (selector) entry.selector = selector;
              if (jsonKey) entry.jsonKey = jsonKey;
              if (storageKey) entry.storageKey = storageKey;
              if (harvestSel) entry.harvestSel = harvestSel;
              if (steps) entry.steps = steps;
              // onChange re-emit - only the safe emit: <channel> form is accepted over http, no exec from network write
              if (input.onChange && typeof input.onChange.emit === 'string') entry.onChange = { emit: input.onChange.emit };
              if (idx >= 0) { // registering scrape un-launches emit-fed channel: manual - revives patchbay nodes on toggle
                delete q[idx].manual;
                // clear extraction fields + stale emit target + stale value - entry only has the ones new registration set
                delete q[idx].selector; delete q[idx].jsonKey; delete q[idx].storageKey; delete q[idx].harvestSel; delete q[idx].steps;
                delete q[idx].onChange; delete q[idx].result;
                const url = input.url ?? q[idx].url; // partial update without url keeps working one instead of wiping it
                Object.assign(q[idx], entry, { url });
              } else {
                q.push(entry);
              }
              return q;
            });
            this._questsCache = quests;
            send(200, quests);
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/quests/emit') { // manual value push: store value as channel result with no scrape
        readJsonBody(req, send, MAX_JSON_BYTES, async (input) => {
          if (!input.channel || typeof input.channel !== 'string') return send(400, { error: 'channel required' });
          const emitted = await updateQuests(q => {
            const idx = q.findIndex(x => x.channel === input.channel);
            const entry = { channel: input.channel, manual: true, result: { value: input.value, timestamp: Date.now() } };
            if (idx >= 0) { // replace entry entirely - spreading old would keep stale scrape config beside manual flag
              if (q[idx].pinned) entry.pinned = true; // pinned is delete-protection, not scrape config - value push must not silently unpin
              q[idx] = entry;
            } else {
              if (q.length >= MAX_QUESTS) throw new Error(`max ${MAX_QUESTS} quests`);
              q.push(entry);
            }
            return q;
          });
          this._questsCache = emitted;
          send(200, { ok: true });
        });
        return;
      }

      const del = req.url?.match(/^\/quests\/(.+)$/);
      if (req.method === 'DELETE' && del) {
        try { // decode inside try - malformed sequence throws - outside try would reject async handler with no send() hanging client
          const channel = decodeURIComponent(del[1]);
          let removed = false, notFound = false;
          const afterDel = await updateQuests(q => {
            const idx = q.findIndex(x => x.channel === channel);
            if (idx < 0) { notFound = true; return q; } // unknown channel - distinct from pinned, so client can tell them apart
            if (q[idx].pinned) return q; // pinned keeps channel scraping headlessly so patchbay node-removal delete is no-op
            q.splice(idx, 1);
            removed = true;
            return q;
          });
          this._questsCache = afterDel;
          if (notFound) return send(404, { error: 'not found' });
          if (removed) { // else scrape-throttle + volatile state keys leak across create/delete cycles
            delete this.lastRun[channel];
            this._questStates.delete(channel);
          }
          return send(200, { ok: removed, pinned: !removed });
        } catch (err) {
          return send(400, { error: err.message });
        }
      }

      send(404, { error: 'not found' });
    });

    return new Promise((resolve, reject) => {
      this.server.once('error', reject); // EADDRINUSE etc - surface failure instead of an unhandled 'error' crash
      this.server.listen(API_PORT, BIND_HOST, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  _send(method, params = {}, page = this) { // page is cdp connection, engine is primary page, pool adds more so dom scrapes run parallel
    const id = ++page.msgId;
    return new Promise((resolve, reject) => { // engine down: reject cleanly so dom scrape path surfaces 'unavailable'
      if (!page.ws || page.ws.readyState !== 1) return reject(new Error('engine unavailable'));
      const timer = setTimeout(() => {
        if (page.pending[id]) {
          reject(new Error(`timeout: ${method}`));
          delete page.pending[id];
        }
      }, PAGE_TIMEOUT);
      page.pending[id] = { resolve, reject, timer };
      page.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  _waitEvent(eventName, timeout = PAGE_TIMEOUT, page = this, matches) { // resolve on next matching cdp event, reject on timeout - matches(params) further filters beyond method name
    return new Promise((resolve, reject) => { // cleanup runs on both paths - prevents socket parsing every future message forever
      const cleanup = () => { page.ws.removeEventListener('message', handler); clearTimeout(timer); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout: ${eventName}`)); }, timeout);
      const handler = e => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.method === eventName && (!matches || matches(msg.params))) { cleanup(); resolve(msg.params); }
      };
      page.ws.addEventListener('message', handler);
    });
  }

  async _navigate(url, page) { // navigate page to url and wait for load, shared by selector and ls scrapes
    const nav = await this._send('Page.navigate', { url }, page);
    if (nav.error) throw new Error(nav.error.message);
    if (nav.result && nav.result.errorText) throw new Error(nav.result.errorText);
    // correlate load by frameId+loaderId - loadEventFired carries neither, so stale event can't be told apart
    const { frameId, loaderId } = nav.result || {};
    await this._waitEvent('Page.lifecycleEvent', PAGE_TIMEOUT, page,
      p => p.name === 'load' && p.frameId === frameId && (loaderId == null || p.loaderId === loaderId));
  }

  async _pollInPage(probe, page) { // poll probe in page until non null or wait elapses (spa render seconds after load)
    const expr = `new Promise((res) => {
      const end = Date.now() + ${SELECTOR_WAIT};
      (function poll() {
        let v = null; try { v = (${probe}); } catch { v = null; }
        if (v != null) return res(v);
        if (Date.now() > end) return res(null);
        setTimeout(poll, 200);
      })();
    })`;
    const r = await this._send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, page);
    return r.result?.result?.value ?? null;
  }

  _evalSelector(sel, page) { // scrape selector's trimmed textContent in-page ('' if empty, null if missing)
    return this._pollInPage(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? (el.textContent.trim() || '') : null; })()`, page);
  }

  _evalStorage(key, page) { // drill read localstorage from loaded page - arg is plain key or json path - literal key wins
    const probe = `(() => {
      const raw = ${JSON.stringify(key)};
      if (localStorage.getItem(raw) !== null) return localStorage.getItem(raw);
      const parts = raw.split('.');
      for (let i = parts.length - 1; i >= 1; i--) {
        const k = parts.slice(0, i).join('.');
        if (localStorage.getItem(k) === null) continue;
        try {
          let v = JSON.parse(localStorage.getItem(k));
          for (const p of parts.slice(i)) v = (v == null) ? undefined : v[p];
          if (v == null) return null;
          return (typeof v === 'object') ? JSON.stringify(v) : String(v);
        } catch { continue; } // non-json at this prefix - a shorter prefix may still be the real key, keep drilling
      }
      return null;
    })()`;
    return this._pollInPage(probe, page);
  }

  async _runSteps(steps, page, deadline) { // linear interaction pipeline before extraction - each adressing + waiting for el to survive re-renders
    for (const step of steps) {
      if (deadline && Date.now() > deadline) throw new Error('scrape deadline exceeded mid-steps'); // cooperative check between steps - caller's Promise.race is a backstop for one step overrunning, this stops the next one from starting
      const [verb] = Object.keys(step);
      const arg = String(step[verb]);
      if (verb === 'wait') {
        if (/^\d+$/.test(arg)) { await new Promise(r => setTimeout(r, Math.min(30000, +arg))); continue; }
        if (await this._pollInPage(`document.querySelector(${JSON.stringify(arg)}) ? true : null`, page) === null)
          throw new Error(`wait: "${arg}" never appeared`);
      } else if (verb === 'click') {
        if (await this._pollInPage(`(() => { const el = document.querySelector(${JSON.stringify(arg)}); if (!el) return null; el.click(); return true; })()`, page) === null)
          throw new Error(`click: "${arg}" matched nothing`);
      } else if (verb === 'scroll') {
        if (/^-?\d+$/.test(arg)) { await this._send('Runtime.evaluate', { expression: `window.scrollBy(0, ${+arg})` }, page); continue; }
        if (await this._pollInPage(`(() => { const el = document.querySelector(${JSON.stringify(arg)}); if (!el) return null; el.scrollIntoView(); return true; })()`, page) === null)
          throw new Error(`scroll: "${arg}" matched nothing`);
      } else if (verb === 'type') {
        const eq = arg.indexOf('=', arg.lastIndexOf(']') + 1); // a ] in selector means the = lives inside brackets - split after them
        const sel = eq < 0 ? arg : arg.slice(0, eq);
        if (!sel) throw new Error('type: empty selector'); // querySelector('') throws inside probe - say it plainly instead
        const text = eq < 0 ? '' : arg.slice(eq + 1);
        const probe = `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true})); el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true})); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`;
        if (await this._pollInPage(probe, page) === null) throw new Error(`type: "${sel}" matched nothing`);
      } else if (verb === 'drag') { // drag:<from>=><to> - pointer + mouse down/move/up gesture from one el centre to another's
        const [from, to] = arg.split('=>').map(s => s.trim());
        const probe = `(() => {
          const a = document.querySelector(${JSON.stringify(from || '')}), b = document.querySelector(${JSON.stringify(to || '')});
          if (!a || !b) return null;
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          const x1 = ra.left + ra.width/2, y1 = ra.top + ra.height/2, x2 = rb.left + rb.width/2, y2 = rb.top + rb.height/2;
          const fire = (el, kind, x, y, down) => {
            const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: down ? 1 : 0 };
            el.dispatchEvent(new PointerEvent('pointer' + kind, { ...o, pointerId: 1, isPrimary: true }));
            el.dispatchEvent(new MouseEvent('mouse' + kind, o));
          };
          fire(a, 'down', x1, y1, true);
          fire(document, 'move', (x1 + x2) / 2, (y1 + y2) / 2, true);
          fire(b, 'move', x2, y2, true);
          fire(b, 'up', x2, y2, false);
          return true;
        })()`;
        if (await this._pollInPage(probe, page) === null) throw new Error(`drag: "${from}" or "${to}" matched nothing`);
      }
    }
  }

  async _fetchExtract(url, extract, errorMsg, page, steps) { // navigate, run steps, extract a value, throw on null
    const deadline = Date.now() + SCRAPE_DEADLINE;
    const run = async () => {
      await this._navigate(url, page);
      if (steps?.length) await this._runSteps(steps, page, deadline); // cooperative check between steps - stops a many-step quest from starting step N+1 once already over budget
      const v = await extract(page);
      if (v === null) throw new Error(`${errorMsg} after ${SELECTOR_WAIT / 1000}s`);
      return v;
    };
    let cap;
    try { // wall-clock deadline on pipeline - steps bounded but sum wasn't, stalling worker
      return await Promise.race([
        run(),
        new Promise((_, reject) => { cap = setTimeout(() => reject(new Error(`scrape exceeded ${SCRAPE_DEADLINE / 1000}s deadline`)), SCRAPE_DEADLINE); }),
      ]);
    } finally { clearTimeout(cap); }
  }

  async fetchPage(url, selector, page, steps) { // navigate, run steps, then scrape css selector's trimmed textContent
    return this._fetchExtract(url, p => this._evalSelector(selector, p), 'selector matched nothing', page, steps);
  }

  async fetchStorage(url, key, page, steps) { // navigate, run steps, then read a localStorage key's value
    return this._fetchExtract(url, p => this._evalStorage(key, p), 'localStorage key absent', page, steps);
  }

  async fetchJSON(url, key) { // fetch url as json and extract value by dotpath (no browser needed) - pinnedGet, not fetch
    const data = JSON.parse(await pinnedGet(url, MAX_JSON_BYTES, PAGE_TIMEOUT));
    const v = String(key).split('.').reduce((o, k) => o?.[k], data);
    if (v == null) throw new Error(`jsonKey "${key}" not found`); // a missing key is a scrape error, not a silent empty success
    return typeof v === 'object' ? JSON.stringify(v) : String(v); // objects as json, matching ls:
  }

  async fetchHarvest(url, sel, page, steps, channel = '') { // navigate, run steps, inject the kernel, harvest selector in ref-mode - returns component html
    const uid = channel ? createHash('sha256').update(channel).digest('hex').slice(0, 8) : ''; // stable id per channel - re-harvests share tags/classes morphs in place doesn't rebuild
    return this._fetchExtract(url, async p => {
      if (await this._pollInPage(`document.querySelector(${JSON.stringify(sel)}) ? true : null`, p) === null) return null; // let spa paint element first, like selector scrape
      await this._pollInPage(`(() => { // best-effort - never fails quest, gives lazy thumbnails/avatars a chance before snapshot
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return true;
        for (const im of el.querySelectorAll('img')) if (!(im.complete && im.naturalWidth > 0)) return null;
        return true;
      })()`, p);
      await this._send('Runtime.evaluate', { expression: await harvestScript() }, p); // inject shipped kernel
      const r = await this._send('Runtime.evaluate', { expression: `window.$kernel.harvest(${JSON.stringify(sel)}, { refMode: true, uid: ${JSON.stringify(uid)} })`, awaitPromise: true, returnByValue: true }, p);
      const html = r.result?.result?.value ?? null;
      return html ? proxyAssets(await this._recoverFonts(html, url)) : null; // recover cross-origin @font-face page couldn't read, then route remaining remote assets through /asset
    }, 'harvest selector matched nothing', page, steps);
  }

  _browserHeaders(url) { // browser ua + origin referer - hotlink/bot filters 403 bare server fetch, dropping fonts and thumbnails
    let ref; try { ref = new URL(url).origin + '/'; } catch {}
    return { 'User-Agent': this._ua || BROWSER_UA, 'Accept': '*/*', ...(ref && { 'Referer': ref }) };
  }

  async _recoverFonts(html, pageUrl) { // recover @font-face from cross-origin sheets headless page can't read - refetch server-side (no cors), inline fonts, inject document-side via def
    const m = html.match(/^<!-- SCV-RF (\{[\s\S]*?\}) -->\n?/);
    if (!m) return html;
    html = html.slice(m[0].length); // strip marker whether or not recovery yields anything
    let spec; try { spec = JSON.parse(m[1]); } catch { return html; }
    const wanted = new Set((spec.f || []).map(x => String(x).toLowerCase())); // only families component actually renders
    const hdr = this._browserHeaders(pageUrl);
    const faces = [];
    for (const sheetUrl of (Array.isArray(spec.s) ? spec.s : []).slice(0, 8)) { // cap fanout
      if (!isValidQuestUrl(sheetUrl)) continue;
      let css; try { css = await pinnedGet(sheetUrl, 2 * 1024 * 1024, 8000, 3, true, false, hdr); } catch { continue; }
      for (const face of css.match(/@font-face\s*\{[^}]*\}/gi) || []) {
        const fam = (face.match(/font-family\s*:\s*([^;}]+)/i) || [])[1];
        if (!fam) continue;
        if (wanted.size && !wanted.has(fam.trim().replace(/^["']|["']$/g, '').toLowerCase())) continue;
        faces.push(await this._inlineFaceUrls(face, sheetUrl, hdr));
      }
    }
    if (!faces.length) return html;
    const esc = faces.join('\n').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
    const id = createHash('sha256').update(esc).digest('hex').slice(0, 8);
    const inject = `\nif(!document.getElementById('scv-rf-${id}')){\nconst rf=document.createElement('style');\nrf.id='scv-rf-${id}';\nrf.textContent=\`${esc}\`;\ndocument.head.appendChild(rf);\n}\n`;
    return html.replace('<script data-scv-def>', '<script data-scv-def>' + inject); // rides in def so renderComponent runs it, adding faces document-side like fontBoot
  }

  async _inlineFaceUrls(face, base, hdr) { // fetch each font file in @font-face server-side and inline to data:
    const urls = [...face.matchAll(/url\((['"]?)([^)'"]+)\1\)/gi)].map(x => x[2]).filter(u => !/^(data:|#)/i.test(u));
    const map = new Map();
    for (const u of urls) {
      let abs; try { abs = new URL(u, base).href; } catch { continue; }
      if (!isValidQuestUrl(abs)) continue;
      try { const a = await pinnedGet(abs, MAX_ASSET_BYTES, 8000, 3, false, true, hdr); map.set(u, `data:${a.contentType};base64,${a.buffer.toString('base64')}`); } catch {}
    }
    return face.replace(/url\((['"]?)([^)'"]+)\1\)/gi, (mm, q, u) => map.has(u) ? `url(${q}${map.get(u)}${q})` : mm);
  }

  async _storeComponent(channel, html) { // write component to readable html, return path#hash ref - hash drives change detection and keeps json readable
    const hash = createHash('sha256').update(html).digest('hex').slice(0, 12); // stable per-channel tag means identical content hashes identically - change detection is just content

    const file = `${COMPONENT_DIR}/${channel.replace(/[^\w-]/g, '_')}.html`;
    if (this._componentHash.get(channel) !== hash) { // only changed layout touches disk
      await mkdir(COMPONENT_DIR, { recursive: true });
      await writeFile(file, html);
      this._componentHash.set(channel, hash);
    }
    return `${file}#${hash}`;
  }

  async execute(q, page) { // run one quest's full scrape pipeline: url safety check, extract, persist
    try {
      if (q.url && !(await questUrlIsSafe(q.url))) throw new Error('invalid quest URL');
      if (q.harvestSel) // full component, not value - store as file and carry readable path#hash ref
        return { value: await this._storeComponent(q.channel, await this.fetchHarvest(q.url, q.harvestSel, page, q.steps, q.channel)), timestamp: Date.now() };
      const value = q.jsonKey
        ? await this.fetchJSON(q.url, q.jsonKey)
        : q.selector
          ? await this.fetchPage(q.url, q.selector, page, q.steps)
          : q.storageKey
            ? await this.fetchStorage(q.url, q.storageKey, page, q.steps)
            : null;
      if (value === null) throw new Error('no selector, jsonKey, or storageKey');
      return { value, timestamp: Date.now() };
    } catch (err) {
      return { value: null, timestamp: Date.now(), error: err.message };
    }
  }

  async scrapeOne(q) { // scrape single quest now, fold result into state and persist it to quests.json to survive re-read
    if (this._questStates.get(q.channel)?.status === 'scraping') return { value: null, timestamp: Date.now(), error: 'already scraping' }; // reentrancy guard - lastRun only updates on completion, so a due tick() and a manual scrape can otherwise overlap the same channel
    this._setQuestStatus(q.channel, 'scraping');
    this.onRender?.();
    const result = await this.execute(q);
    this._setQuestStatus(q.channel, result.error ? 'error' : 'success', result);
    this.lastRun[q.channel] = Date.now();
    this._questsCache = await updateQuests(qs => { // write result back under queue lock then refresh cache
      const x = qs.find(e => e.channel === q.channel);
      if (x && !x.manual) x.result = result;
      return qs;
    });
    if (!result.error) await this._applyOnChange(q);
    return result;
  }

  _setQuestStatus(channel, status, result) { // fold scrape result into per channel display state - written by tick() and scrapeOne()
    let s = this._questStates.get(channel);
    if (!s) {
      s = { status, lastValue: null, prevValue: null, lastRun: null, lastChange: null, changed: false };
      this._questStates.set(channel, s);
    }
    s.status = status;
    if (result) {
      s.lastRun = result.timestamp || Date.now();
      if (result.value != null) {
        s.prevValue = s.lastValue;
        s.lastValue = result.value;
        s.changed = s.lastValue !== s.prevValue;
        if (s.changed) {
          s.lastChange = Date.now();
          // append only history - one json line per change - fire and forget so slow disk never stalls tick - appends ordered by os
          if (HISTORY_FILE) appendHistory(HISTORY_FILE, `${JSON.stringify({ channel, value: s.lastValue, ts: s.lastChange })}\n`);
        }
      } else s.changed = false; // an error scrape must not keep last success's changed flag live
      if (status === 'success' || status === 'error') { // record each completed scrape for log view - ring-buffered
        this._log.push({ ts: result.timestamp || Date.now(), channel, error: result.error || null, value: result.value ?? null, changed: !!s.changed });
        if (this._log.length > 500) this._log.shift();
      }
    }
  }

  async _applyOnChange(q) { // quests as alerts - when quest value changes, re-emit to another channel - no loop risk, emit marks manual
    try {
      const target = q.onChange?.emit;
      if (!target || typeof target !== 'string') return;
      const s = this._questStates.get(q.channel);
      if (!s || !s.changed) return;
      const value = s.lastValue;
      this._questsCache = await updateQuests(qs => {
        if (!qs.some(x => x.channel === q.channel)) return qs; // source was deleted mid-scrape - don't resurrect a stale alert
        const idx = qs.findIndex(x => x.channel === target);
        if (idx >= 0) { // alert only fans a value - keeps target's own scrape config + pinned flag
          qs[idx].manual = true;
          qs[idx].result = { value, timestamp: Date.now() };
        } else if (qs.length < MAX_QUESTS) {
          qs.push({ channel: target, manual: true, result: { value, timestamp: Date.now() } });
        }
        return qs;
      });
      // seed target's display state - _valInfo prefers lastValue over result, so a stale row must not linger
      const ts = this._questStates.get(target);
      if (ts) { ts.lastValue = value; ts.changed = false; }
      else this._questStates.set(target, { status: 'success', lastValue: value, prevValue: null, lastRun: Date.now(), lastChange: null, changed: false });
    } catch {}
  }

  async captureScreenshot(q) { // diagnostic capture - load quest url on fresh throwaway tab - settle and write png, returns saved path
    if (!(await questUrlIsSafe(q.url))) throw new Error('invalid quest URL'); // mirror execute - no private/file:// screenshot via cdp
    const page = await this._addPoolPage();
    try {
      await this._send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, page);
      await this._navigate(q.url, page);
      await new Promise(r => setTimeout(r, SCREENSHOT_SETTLE)); // let spa paint (can't poll unknown element)
      const r = await this._send('Page.captureScreenshot', { format: 'png' }, page);
      const b64 = r.result?.data;
      if (!b64) throw new Error('capture returned no data');
      const safe = (q.channel || 'quest').replace(/[^a-z0-9_-]/gi, '_');
      const file = join(process.cwd(), `scavenger-shot-${safe}.png`);
      await writeFile(file, Buffer.from(b64, 'base64'));
      return file;
    } finally {
      this._closePage(page); // dedicated tab, close it (never touches scrape pool)
    }
  }

  async _addPoolPage() { // open extra browser tab as self contained cdp page - page is duck-typed, primary page is just 'this'
    const { result } = await this._send('Target.createTarget', { url: 'about:blank' });
    const targetId = result?.targetId;
    if (!targetId) throw new Error('createTarget: no targetId');
    let t;
    for (let attempt = 0; attempt < 2 && !t; attempt++) { // per-target ws url in /json not createTarget reply - look up by id, one retry for race
      if (attempt) await new Promise(r => setTimeout(r, 100));
      const list = await (await fetch(`http://127.0.0.1:${this._debugPort}/json`)).json();
      t = list.find(x => x.id === targetId && x.webSocketDebuggerUrl);
    }
    if (!t) throw new Error('createTarget: no ws url');

    const page = { ws: new WebSocket(t.webSocketDebuggerUrl), pending: {}, msgId: 0, targetId };
    try {
      await new Promise((resolve, reject) => {
        const to = setTimeout(() => { page.ws.onopen = null; page.ws.onerror = null; page.ws.close(); reject(new Error('pool ws timeout')); }, CHROME_TIMEOUT);
        page.ws.onopen = () => { clearTimeout(to); resolve(); };
        page.ws.onerror = () => { clearTimeout(to); reject(new Error('pool ws error')); };
      });
      page.ws.onmessage = e => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; } // a non-json frame must never crash engine
        if (msg.id && page.pending[msg.id]) {
          clearTimeout(page.pending[msg.id].timer);
          page.pending[msg.id].resolve(msg);
          delete page.pending[msg.id];
        }
      };
      page.ws.onclose = () => {
        const i = this._extraPages.indexOf(page); // a dead page must not keep being routed to - prune it so pool heals on next tick
        if (i >= 0) this._extraPages.splice(i, 1);
        Object.values(page.pending).forEach(p => { clearTimeout(p.timer); p.reject(new Error('ws closed')); });
        page.pending = {};
      };
      await this._send('Page.enable', {}, page);
      await this._send('Page.setLifecycleEventsEnabled', { enabled: true }, page); // frame/loader-correlated load events for _navigate
      await this._applyUAOverride(page); // pool tabs present same de-headlessed ua
    } catch (err) {
      try { page.ws.close(); } catch {}
      throw err;
    }
    return page;
  }

  async _ensurePool(n) { // grow extra-page pool toward n total pages - best effort, keeps what we have - tick() caps to pool size
    const want = Math.max(1, n) - 1; // extras beyond primary 'this'
    while (this._extraPages.length < want) {
      try { this._extraPages.push(await this._addPoolPage()); }
      catch { break; }
    }
  }

  _closePool() { // close and drop every extra pool page - called on relaunch and teardown so stale tabs don't linger
    for (const p of this._extraPages) { try { p.ws?.close(); } catch {} }
    this._extraPages = [];
  }

  _closePage(p) { // close one pool page's actual browser tab, then drop debugger socket - best effort
    if (p.targetId) this._send('Target.closeTarget', { targetId: p.targetId }, this).catch(() => {});
    try { p.ws?.close(); } catch {}
  }

  _setConcurrency(n) { // set parallel scrape count - raising it lets tick() grow pool lazily - lowering closes surplus tabs
    const next = Math.max(1, Math.min(8, n));
    if (next < this._concurrency) {
      const drop = this._extraPages.splice(next - 1); // keep next-1 extras (primary is 'this')
      for (const p of drop) this._closePage(p);
    }
    this._concurrency = next;
  }

  async tick() { // run one scrape cycle: load quests from disk, filter for due, scrape in parallel, persist results
    let quests;
    try {
      quests = JSON.parse(await readFile(QUESTS_FILE, 'utf-8'));
      if (!Array.isArray(quests)) throw new Error('not an array');
    } catch {
      return;
    }

    this._questsCache = quests;
    const now = Date.now();
    const due = quests.filter(q => q && !q.manual && this._questStates.get(q.channel)?.status !== 'scraping' // lastRun alone isn't enough - it only updates on completion, so a still-running scrape (this tick's own overlap, or a concurrent manual scrapeOne) must not be picked up again
      && now - (this.lastRun[q.channel] || 0) >= Math.max(MIN_INTERVAL, q.interval || DEFAULT_INTERVAL));

    if (due.length > 0) {
      const tickStart = Date.now();
      const results = new Map();

      // size worker pool to how many quests are due this tick - capped by _concurrency - growth is best-effort
      const target = Math.min(this._concurrency, due.length);
      if (target > 1) await this._ensurePool(target); // best-effort internally; never throws
      const pages = [this, ...this._extraPages];

      const runOne = async (q, page) => {
        this._setQuestStatus(q.channel, 'scraping');
        this.onRender?.();
        const result = await this.execute(q, page);
        results.set(q.channel, result);
        this.lastRun[q.channel] = Date.now();
        this._setQuestStatus(q.channel, result.error ? 'error' : 'success', result);
        if (!result.error) await this._applyOnChange(q);
      };

      // each worker owns one page and pulls from shared 'due' queue, so no two concurrent dom navigations share a page
      let next = 0;
      const worker = async (page) => {
        while (next < due.length) { await runOne(due[next++], page); }
      };
      const nWorkers = Math.max(1, Math.min(target, pages.length));
      await Promise.all(pages.slice(0, nWorkers).map(p => worker(p)));

      this._lastTickMs = Date.now() - tickStart;
      this._durations.push(this._lastTickMs);
      if (this._durations.length > 20) this._durations.shift();
      // capture freshly-written array back into 'quests' so output file mirror reflects this tick - prevents writing pre-scrape state
      quests = await updateQuests(q => {
        for (const x of q) { // skip channel that turned 'manual' during execute window - writing stale scrape would destroy it
          if (x && results.has(x.channel) && !x.manual) x.result = results.get(x.channel);
        }
        return q;
      });
      this._questsCache = quests;
    }
    this.onRender?.();

    if (OUTPUT_FILE) {
      await atomicWrite(OUTPUT_FILE, JSON.stringify(quests, null, 2));
    }
  }

  _startEgressProxy() { // ssrf guarding forward proxy for headless chromium: resolves host, rejects privates, connects to validated ip
    const proxy = createServer((req, res) => {
      let u; try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
      resolvePublicIP(u.hostname).then(ip => {
        const isHttps = u.protocol === 'https:'; // absolute-form https:// requests must go out over tls, not plain http
        const upReq = isHttps ? httpsRequest : httpRequest;
        const up = upReq({
          hostname: u.hostname, servername: isHttps ? u.hostname : undefined,
          port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search,
          method: req.method, headers: req.headers,
          lookup: pinnedLookup(ip),
          timeout: PAGE_TIMEOUT,
        }, upRes => {
          res.writeHead(upRes.statusCode, upRes.headers);
          upRes.on('error', () => { try { res.destroy(); } catch {} }); // upstream reset mid-body - never an unhandled 'error' crash
          upRes.pipe(res);
        });
        up.on('timeout', () => up.destroy(new Error('upstream timeout')));
        up.on('error', () => { try { res.writeHead(502); } catch {} res.end(); });
        req.on('error', () => { try { up.destroy(); } catch {} }); // client abort mid-body - stop piping upstream, don't die
        req.pipe(up);
      }).catch(() => { try { res.writeHead(403); } catch {} res.end(); });
    });
    proxy.on('connect', (req, clientSocket, head) => {
      const i = req.url.lastIndexOf(':');
      const host = req.url.slice(0, i), port = parseInt(req.url.slice(i + 1)) || 443;
      resolvePublicIP(host).then(ip => {
        const upstream = netConnect({ port, host: ip.address, timeout: PAGE_TIMEOUT }, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head && head.length) upstream.write(head);
          upstream.pipe(clientSocket); clientSocket.pipe(upstream);
        });
        upstream.on('timeout', () => upstream.destroy());
        upstream.on('error', () => clientSocket.destroy());
        clientSocket.on('error', () => upstream.destroy());
      }).catch(() => { try { clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch {} clientSocket.destroy(); });
    });
    proxy.on('clientError', (e, sock) => { try { sock.destroy(); } catch {} });
    this._proxy = proxy;
    return new Promise((resolve, reject) => {
      proxy.once('error', reject); // a listen failure must reject - not an unhandled 'error' crash
      proxy.listen(0, '127.0.0.1', () => { proxy.removeListener('error', reject); resolve(proxy.address().port); });
    });
  }

  _killChromeSync() { // kill chromium process (sigterm - sigkill) so it can't linger holding profile lock
    if (!this.chrome) return;
    // sigterm asks nicely - sigkill ensures it can't linger holding lockfile
    this.chrome.kill('SIGTERM');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    this.chrome.kill('SIGKILL');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }

  destroy() { // tear engine down: clear timers, disarm crash retry, close proxy + api server, kill chromium
    clearTimeout(this._retryTimer);
    this.chrome?.removeAllListeners('exit'); // disarmed before kill so no crash-retry relaunch fires and no double-kill
    this._proxy?.close();
    this.server?.close();
    this._closePool();
    this.ws?.close();
    this._killChromeSync();
    if (this._userDir && this._userDir.startsWith(tmpdir())) { // remove our own temp/snapshot dir - never live profile
      try { rmSync(this._userDir, { recursive: true, force: true }); } catch {}
    }
  }
}

class QuestTUI {
  constructor(engine) { // wire tui to engine + seed view/mode state (tty detected later in start)
    this.e               = engine;                   // reference to underlying quest engine instance
    this._tui            = false;                    // set in start(): is stdout an interactive tty?
    this._renderTimer    = null;                     // interval timer driving periodic tui repainting
    this._renderQueued   = false;                    // flag to batch and coalesce multiple render requests
    this._cursor         = 0;                        // selected index within currently displayed quest list view
    this._mode           = 'normal';                 // active tui operating mode (normal, help, add-quest, etc)
    this._input          = '';                       // general-purpose text buffer for input/search prompts
    this._inputStep      = 0;                        // currently active field index in add/edit quest form
    this._addData        = { ...ADD_DATA_DEFAULTS }; // form data container for adding or editing a quest
    this._pendingConfirm = null;                     // holds pending action details requiring user confirmation (y/n)
    this._prevMode       = 'normal';                 // previous tui mode to return to upon dismissing an overlay
    this._editingChannel = null;                     // channel name of quest currently being edited inline
    this._search         = '';                       // active channel filter (/)
    this._sortKey        = 'default';                // active sort criteria: default, channel, status, age, value
    this._filter         = 'all';                    // active row filter: all, scheduled, manual
    this._scrollTop      = 0;                        // viewport top index into derived quest list view
    this._logScroll      = 0;                        // number of log entries hidden below tail (0 = newest)
    this._chromiumSel    = 0;                        // selected chromium menu setting (0 = profile, 1 = parallel scrapes)
    this._stepsList      = [];                       // steps sub-mode: array of interaction steps being edited
    this._stepsExt       = '';                       // steps sub-mode: terminal extraction segment string
    this._stepCursor     = 0;                        // steps sub-mode: selected row index (reaches extraction row at end)
    this._stepsScrollTop = 0;                        // steps sub-mode: viewport top index, follows _stepCursor (mirrors _scrollTop)
    this._stepReturnMode = 'edit-quest';             // target mode to return to when exiting steps editor (add-quest, edit-quest)
  }

  // read through to engine state, so render/key code reads it as plain 'this._x'
  get _questsCache()     { return this.e._questsCache;     } set _questsCache(v) { this.e._questsCache = v; }
  get _questStates()     { return this.e._questStates;     }
  get _chromeConnected() { return this.e._chromeConnected; }
  get _engineError()     { return this.e._engineError;     }
  get _notice()          { return this.e._notice;          } set _notice(v)      { this.e._notice = v; }
  get _profileMode()     { return this.e._profileMode;     } set _profileMode(v) { this.e._profileMode = v; }
  get _concurrency()     { return this.e._concurrency;     }
  get _log()             { return this.e._log;             }
  get _durations()       { return this.e._durations;       }
  get _lastTickMs()      { return this.e._lastTickMs;      }
  get _startTime()       { return this.e._startTime;       }
  get _chromeBin()       { return this.e._chromeBin;       }
  get _userDir()         { return this.e._userDir;         }
  get ws()               { return this.e.ws;               }
  get chrome()           { return this.e.chrome;           }

  start() { // start tui - raw-mode key handling + render loop (no-op when headless)
    this._tui = !!(process.stdin.isTTY && process.stdout.isTTY);
    if (!this._tui) { // no tty (piped, service, 'docker run' without -it, ci) - run headless, api + tick loop unaffected
      console.log(`[quests] v${SCV_QUESTS_VERSION} on http://${BIND_HOST}:${API_PORT} - headless (no TTY)`);
      console.log(`[quests] scv-token: ${SCV_TOKEN}   (for cross-origin writes, e.g. the kernel live-emit tool)`);
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', chunk => this._keyHandler(chunk));
    process.stdout.write('\x1b[?1000h\x1b[?1006h'); // mouse tracking + sgr encoding: scroll wheel events
    this._renderTimer = setInterval(() => this._tuiRender(), 1000);
    process.stdout.on('resize', () => this._tuiRender()); // redraw immediately on resize, not up to 1s later
    this._tuiRender();
  }

  stop() { // stop tui - clear render timer, restore cooked mode + show cursor
    if (this._renderTimer) { clearInterval(this._renderTimer); this._renderTimer = null; }
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    if (this._tui) process.stdout.write('\x1b[?1006l\x1b[?1000l'); // release mouse tracking
    process.stdout.write(T.show);
  }

  _quit() { // quit tui - let in-flight write finish first - same as sig handlers, so adding quest and quitting doesn't drop save
    (async () => {
      try { await Promise.race([_questQueue, new Promise(r => setTimeout(r, 2000))]); } catch {} // never let a stalled write block quit
      this.stop(); this.e.destroy(); process.exit(0);
    })();
  }

  _tuiRender() { // coalesce paints: batches tick progress, keystroke and timer render requests (avoids flicker)
    if (!this._tui || this._renderQueued) return;
    this._renderQueued = true;
    queueMicrotask(() => { this._renderQueued = false; this._paint(); });
  }

  _paint() { // render whole tui frame to stdout (skipped when headless)
    if (!this._tui) return; // headless: never paint ansi into pipe/log
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const qs = this._view();
    this._cursor = qs.length === 0 ? 0 : Math.min(Math.max(0, this._cursor), qs.length - 1);
    const nl = s => (s.match(/\n/g) || []).length;

    // build fixed chrome first so list gets exactly leftover height - overlay grows/shrinks reserved space
    const title = T.eol + this._title(cols) + '\n';
    const searchLine = this._searchLine(cols);
    const notif = this._notifBar(cols);
    const footer = this._footer(cols);
    const overlay = (this._mode !== 'normal' ? '\n' : '') + this._modeOverlay(cols);

    // reserve for inline field form: add = 1 header + 4 fields | edit = 4 fields
    const formLines = this._addingRow() ? 6 : this._editingRow() ? 4 : 0; // add: header + kernel + 4 fields | edit: 4 fields
    const chrome = nl(title) + nl(searchLine) + 1 + 1
      + nl(notif) + nl(footer) + nl(overlay) + formLines + 1;
    let cap = Math.max(3, rows - chrome);

    let out = T.hide + T.home + T.cls + title + searchLine + '\n';
    if (this._mode === 'steps') {
      out += this._renderSteps(cols, cap);
    } else if (this._mode === 'log') {
      out += this._renderLog(cap, cols);
    } else if (qs.length === 0 && !this._addingRow()) {
      out += T.eol + ' ' + PAL.muted + (this._search || this._filter !== 'all' ? '(no matches)' : 'no quests logged - press a') + T.reset + '\n';
    } else { // new-quest form on placeholder top row - its confirm shows in header (row's value)
      if (this._addingRow()) {
        const confirming = this._mode === 'confirm' && this._pendingConfirm?.action === 'add';
        const head = PAL.accent + '+ new quest' + T.reset + (confirming ? '   ' + PAL.danger + 'add? (y/n)' + T.reset : '');
        out += T.eol + '   ' + head + '\n' + this._editInlineLines(cols);
      }
      const flagW = qs.reduce((m, q) => Math.max(m, sLen(this._flagsLabel(q))), 0);
      let start = 0, end = qs.length, up = false, down = false;
      if (qs.length > cap) {
        const inner = Math.max(1, cap - 2); // reserve overflow rows
        if (this._cursor < this._scrollTop) this._scrollTop = this._cursor;
        if (this._cursor >= this._scrollTop + inner) this._scrollTop = this._cursor - inner + 1;
        this._scrollTop = Math.max(0, Math.min(this._scrollTop, qs.length - inner));
        start = this._scrollTop; end = Math.min(qs.length, start + inner);
        up = start > 0; down = end < qs.length;
      } else this._scrollTop = 0;
      if (up)   out += T.eol + '   ' + PAL.muted + '⋯ ' + start + ' more ↑' + T.reset + '\n';
      for (let i = start; i < end; i++) {
        out += T.eol + this._row(qs[i], cols, flagW, i === this._cursor) + '\n';
        if (i === this._cursor && this._editingRow()) out += this._editInlineLines(cols);
      }
      if (down) out += T.eol + '   ' + PAL.muted + '⋯ ' + (qs.length - end) + ' more ↓' + T.reset + '\n';
    }
    out += '\n' + footer + notif + overlay + T.ed; // status bar, then error bar under, then overlay slot
    process.stdout.write(out);
  }

  _layoutName() { // map current mode to title-bar label
    switch (this._mode) {
      case 'normal':     return 'quests';
      case 'search':     return 'search';
      case 'log':        return 'value log';
      case 'help':       return 'help';
      case 'add-quest':  return 'add-quest';
      case 'edit-quest': return 'edit-quest';
      case 'steps':      return 'steps';
      case 'error':      return 'error';
      case 'confirm':    return 'confirm';
      case 'chromium':   return 'chromium';
      case 'tick-rate':  return 'tick-rate';
      default:           return 'quests';
    }
  }

  _title(cols) { // build s<av> { mode } title-bar line
    const name = this._layoutName();
    const title = ' ' + PAL.secondary + 's' + PAL.accent + '<' + PAL.secondary + 'av' + PAL.accent + '>' + PAL.text + ' ' + PAL.accent + '{' + PAL.secondary + ' ' + name + ' ' + PAL.accent + '}' + T.reset;
    const uptime = PAL.muted + 'uptime - ' + PAL.success + this._fmtUptime() + T.reset;
    const gap = Math.max(1, cols - sLen(title) - sLen(uptime) - 3);
    return title + ' ' + PAL.muted + '─'.repeat(gap) + T.reset + ' ' + uptime + ' ';
  }

  _row(q, cols, flagW, selected) { // build one quest's table row (icon, channel, value, flags, age)
    const icon = this._icon(q);
    const chRaw = sTrunc(q.channel || '?', 16).padEnd(16);
    const ch = this._hlChannel(chRaw);
    const marker = selected ? ' ' + PAL.reader + '>' + T.reset + ' ' : '   ';

    const hasFlags   = cols >= 80;
    const hasRuntime = cols >= 60;
    const hasAge     = cols >= 40;
    const vi = this._valInfo(q);
    const valW = hasFlags ? Math.max(3, cols - 47 - flagW) : hasRuntime ? Math.max(3, cols - 45) : hasAge ? Math.max(3, cols - 33) : Math.max(3, cols - 24);
    const val = vi.color + sTrunc(vi.text, valW).padEnd(valW) + T.reset;

    let row = marker + icon + ' ' + ch + '  ' + val;
    if (hasAge) row += '  ' + PAL.muted + this._age(q).padStart(7) + T.reset;
    if (hasFlags) row += '  ' + this._flagsColor(q) + sPad(this._flagsLabel(q), flagW) + T.reset;
    if (hasRuntime) {
      const ri = this._runtimeInfo(q);
      row += '  ' + ri.color + sPad(ri.label, 10) + T.reset;
    }
    if (selected) {
      const bgD = T.bg(0x25, 0x27, 0x27);
      row = bgD + row.replaceAll(T.reset, T.reset + bgD) + T.reset;
    }
    return row + ' ';
  }

  _icon(q) { // pick status glyph for a quest (scraping, ok, error, idle)
    const s = this._questStates.get(q.channel);
    const status = s?.status || 'idle';
    switch (status) {
      case 'scraping': return PAL.accent + '◎' + T.reset;
      case 'error':    return PAL.danger + '⊗' + T.reset;
      case 'success':  return s?.changed ? PAL.success + '●' + T.reset : PAL.secondary + '○' + T.reset;
      default:         return PAL.muted  + '-' + T.reset;
    }
  }

  _valInfo(q) { // build value column - value or confirmation - update keys off original channel since edit may rename it
    if (this._mode === 'confirm' && this._pendingConfirm?.action === 'delete' && this._pendingConfirm.channel === q.channel)
      return { text: 'delete? (y/n)', color: PAL.danger };
    if (this._mode === 'confirm' && this._pendingConfirm?.action === 'update' && this._editingChannel === q.channel)
      return { text: 'update? (y/n)', color: PAL.danger };
    const s = this._questStates.get(q.channel);
    if (s?.status === 'scraping') return { text: '[fetching]', color: PAL.accent };
    if (q.result?.error || s?.status === 'error') return { text: 'error: ' + (q.result?.error || 'failed'), color: PAL.danger };
    const v = s?.lastValue ?? q.result?.value;
    if (v == null) return { text: '-', color: PAL.muted };
    return { text: String(v), color: PAL.text };
  }

  _age(q) { // format time since a quest last ran, for age column
    const s = this._questStates.get(q.channel);
    const ts = s?.lastRun ?? q.result?.timestamp;
    if (!ts) return '-';
    const totalSec = Math.floor((Date.now() - ts) / 1000);
    if (totalSec < 60) return totalSec + 's';
    const totalMin = Math.floor(totalSec / 60);
    const remSec = totalSec % 60;
    if (totalMin < 60) return totalMin + 'm' + remSec + 's';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h < 24) return h + 'h' + m + 'm';
    const d = Math.floor(h / 24);
    return d + 'd' + (h % 24) + 'h';
  }

  _runtimeInfo(q) { // build a runtime label + color (waiting, interval, error)
    const s = this._questStates.get(q.channel);
    if (!s) return { label: 'waiting', color: PAL.muted };
    switch (s.status) {
      case 'scraping': return { label: 'scraping', color: PAL.accent };
      case 'error':    return { label: 'failed',   color: PAL.danger };
      case 'success':  return { label: s.changed ? 'changed' : 'unchanged', color: s.changed ? PAL.success : PAL.secondary };
      default:         return { label: 'waiting',  color: PAL.muted };
    }
  }

  _flagsLabel(q) { // join quest flag tags (manual, pinned, ...) into a label
    const tags = [];
    if (q.manual) tags.push('manual');
    if (q.pinned) tags.push('pinned');
    return tags.length ? tags.join(', ') : 'unset';
  }

  _flagsColor(q) { // pick flags-column color (accent when manual/pinned, else muted)
    return (q.manual || q.pinned) ? PAL.accent : PAL.muted;
  }

  _formFields() { // form fields as rows - add mode gets an extra quest row at top - paste into it and rows below fill live
    const base = [['channel', 'channel'], ['url', 'url'], ['selector', 'target'], ['interval', 'interval (ms)']];
    return this._addingRow() ? [['kernel', 'quick fill'], ...base] : base;
  }

  _applyKernel() { // split pasted "channel, url, target" line into form fields - name is optional, skips fields user already hand-edited
    const parts = (this._addData.kernel || '').split(',');
    const firstIsUrl = /^https?:\/\//i.test((parts[0] || '').trim());
    const touched = this._kernelTouched;
    if (!touched?.has('channel')) this._addData.channel = firstIsUrl ? '' : (parts[0] || '').trim();
    if (!touched?.has('url')) this._addData.url = (firstIsUrl ? parts[0] : parts[1] || '').trim();
    if (!touched?.has('selector')) this._addData.selector = parts.slice(firstIsUrl ? 1 : 2).join(',').trim();
  }

  _fieldDesc(key) { // short right-aligned hint per field - target's follows extraction type, which ‹/› cycles
    switch (key) {
      case 'kernel':   return 'paste a full quest line';
      case 'channel':  return 'topic your dashboard wires to';
      case 'url':      return 'page to read from';
      case 'interval': return 'ms between reads';
      case 'selector': {
        const s = this._addData.selector || '';
        return (s.startsWith('key:') ? 'a json key or dot-path'
              : s.startsWith('ls:') ? 'a localstorage key'
              : s.startsWith('harvest:') ? 'a whole live component'
              : 'a value from a css selector') + ' ‹/›';
      }
      default: return '';
    }
  }

  _editInlineLines(cols) { // expanded edit fields shown as rows under quest being edited
    const fields = this._formFields();
    const labelW = 20;
    const descW = cols >= 56 ? 30 : 0; // right-aligned hint column, dropped on narrow terminal
    const room = Math.max(12, cols - labelW - descW - 10);
    let out = '';
    for (let i = 0; i < fields.length; i++) {
      const [key, label] = fields[i];
      const active = i === this._inputStep;
      const raw = this._addData[key] || '';
      const shownVal = raw.length > room ? '…' + raw.slice(raw.length - room + 1) : raw;
      const arrow = active ? PAL.accent + '›' + T.reset : ' ';
      // two cols, left aligned, no colon - label col, then value col to its right
      const lbl = (active ? PAL.secondary : PAL.accent) + label.padEnd(labelW) + T.reset;
      const body = active ? PAL.text + shownVal + PAL.accent + '▌' + T.reset
                          : (raw ? PAL.text + shownVal + T.reset : PAL.muted + '-' + T.reset);
      let row = '   ' + arrow + ' ' + lbl + ' ' + body; // three space indent, arrow aligns with row icons
      if (descW) { const d = this._fieldDesc(key); row += ' '.repeat(Math.max(1, cols - sLen(row) - sLen(d) - 1)) + PAL.muted + d + T.reset; }
      out += T.eol + row + '\n';
    }
    return out; // key hint lives in overlay slot (below status)
  }

  _renderSteps(cols, cap) { // steps editor - one row per interaction step (number, verb, arg) then extraction row - windowed like quest list once pipeline (up to 25 steps) outgrows terminal
    const labelW = 10, room = Math.max(12, cols - labelW - 12);
    const shown = raw => raw.length > room ? '…' + raw.slice(raw.length - room + 1) : raw;
    const line = (numTxt, verbTxt, arg, active, verbCol) => {
      const arrow = active ? PAL.accent + '›' + T.reset : ' ';
      const num = PAL.muted + numTxt.padStart(2) + T.reset;
      const lbl = verbCol + verbTxt.padEnd(labelW) + T.reset;
      const body = active ? PAL.text + shown(arg) + PAL.accent + '▌' + T.reset
                          : (arg ? PAL.text + shown(arg) + T.reset : PAL.muted + '-' + T.reset);
      return T.eol + '  ' + arrow + ' ' + num + ' ' + lbl + ' ' + body + '\n';
    };
    let out = '';
    let start = 0, end = this._stepsList.length, up = false, down = false;
    if (cap && this._stepsList.length > cap) {
      const inner = Math.max(1, cap - 2); // reserve for up/down markers, same budget shape as quest list
      if (this._stepCursor < this._stepsScrollTop) this._stepsScrollTop = this._stepCursor;
      if (this._stepCursor >= this._stepsScrollTop + inner) this._stepsScrollTop = this._stepCursor - inner + 1;
      this._stepsScrollTop = Math.max(0, Math.min(this._stepsScrollTop, this._stepsList.length - inner));
      start = this._stepsScrollTop; end = Math.min(this._stepsList.length, start + inner);
      up = start > 0; down = end < this._stepsList.length;
    } else this._stepsScrollTop = 0;
    if (up) out += T.eol + '  ' + PAL.muted + '⋯ ' + start + ' more ↑' + T.reset + '\n';
    for (let i = start; i < end; i++) {
      const active = i === this._stepCursor;
      out += line(String(i + 1), this._stepsList[i].verb, this._stepsList[i].arg, active, active ? PAL.secondary : PAL.accent);
    }
    if (down) out += T.eol + '  ' + PAL.muted + '⋯ ' + (this._stepsList.length - end) + ' more ↓' + T.reset + '\n';
    const extActive = this._onExtractionRow();
    out += '\n' + line('', 'extract', this._stepsExt || 'sel:/key:/ls:', extActive, extActive ? PAL.secondary : PAL.accent);
    return out;
  }

  _view() { // quests actually shown - source list narrowed by auto/manual filter and search, then sorted
    let list = this._questsCache || [];
    if (this._filter === 'scheduled') list = list.filter(q => !q.manual);
    else if (this._filter === 'manual') list = list.filter(q => q.manual);
    const query = (this._search || '').trim().toLowerCase();
    if (query) list = list.filter(q => (q.channel || '').toLowerCase().includes(query));
    if (this._sortKey !== 'default') {
      const rank = q => this._questStates.get(q.channel)?.status === 'error' || q.result?.error ? 0
        : this._questStates.get(q.channel)?.status === 'scraping' ? 1 : 2;
      const by = {
        channel: (a, b) => (a.channel || '').localeCompare(b.channel || ''),
        status:  (a, b) => rank(a) - rank(b) || (a.channel || '').localeCompare(b.channel || ''),
        age:     (a, b) => (b.result?.timestamp || 0) - (a.result?.timestamp || 0),
        value:   (a, b) => String(a.result?.value ?? '').localeCompare(String(b.result?.value ?? '')),
      }[this._sortKey];
      if (by) list = list.slice().sort(by);
    }
    return list;
  }

  _hlChannel(chRaw) { // channel text with / query substring lifted into accent color
    const q = (this._search || '').trim().toLowerCase();
    const idx = q ? chRaw.toLowerCase().indexOf(q) : -1;
    if (idx < 0) return PAL.text + chRaw + T.reset;
    return PAL.text + chRaw.slice(0, idx) + T.reset
      + PAL.accent + chRaw.slice(idx, idx + q.length) + T.reset
      + PAL.text + chRaw.slice(idx + q.length) + T.reset;
  }

  _notifBar(cols) { // always visible line above footer - current engine error, else most recent failed quest, else muted no errors
    let text, color;
    if (this._engineError) { text = 'engine: ' + this._engineError; color = PAL.danger; }
    else if (this._notice) { text = this._notice; color = PAL.danger; }
    else {
      const failed = (this._questsCache || []).filter(q => q.result?.error);
      const last = failed.slice().sort((a, b) => (b.result?.timestamp || 0) - (a.result?.timestamp || 0))[0];
      if (last) { text = (failed.length > 1 ? '⊗ ' + failed.length + ' failing - ' : '⊗ ') + last.channel + ': ' + last.result.error; color = PAL.danger; }
      else { text = '✓  no errors'; color = PAL.muted; }
    }
    // right aligned view state so active filter/sort is always visible
    const status = PAL.secondary + this._filter + T.reset
      + (this._sortKey !== 'default' ? PAL.muted + ' - by ' + PAL.secondary + this._sortKey + T.reset : '');
    const left = color + sTrunc(text, Math.max(4, cols - sLen(status) - 3)) + T.reset;
    const gap = Math.max(1, cols - sLen(left) - sLen(status) - 2);
    return T.eol + ' ' + left + ' '.repeat(gap) + status + '\n';
  }

  _searchLine(cols) { // the / search input line (only while searching) - shows live query + count
    if (this._mode !== 'search') return '';
    const n = this._view().length;
    return T.eol + ' ' + PAL.accent + '/' + T.reset + PAL.text + this._search + PAL.accent + '▌' + T.reset
      + '  ' + PAL.muted + n + ' match' + (n === 1 ? '' : 'es') + ' - enter keep - esc clear' + T.reset + '\n';
  }

  _renderLog(cap, cols) { // value log - every completed scrape, newest at bottom
    const log = this._log;
    if (!log.length) return T.eol + ' ' + PAL.muted + '(no scrapes logged yet)' + T.reset + '\n';
    const avail = Math.max(1, cap - 2); // reserve up/down indicator rows
    this._logScroll = Math.max(0, Math.min(this._logScroll, Math.max(0, log.length - avail)));
    const end = log.length - this._logScroll;
    const start = Math.max(0, end - avail);
    let out = '';
    if (start > 0)               out += T.eol + '   ' + PAL.muted + '⋯ ' + start + ' older ↑' + T.reset + '\n';
    for (let i = start; i < end; i++) out += T.eol + this._logLine(log[i], cols) + '\n';
    if (this._logScroll > 0)     out += T.eol + '   ' + PAL.muted + '⋯ ' + this._logScroll + ' newer ↓' + T.reset + '\n';
    return out;
  }

  _logLine(e, cols) { // format one scrape-log entry (time, status dot, channel, value/error)
    const t = new Date(e.ts).toTimeString().slice(0, 8);
    const dot = e.error ? PAL.danger + '⊗' + T.reset : e.changed ? PAL.success + '●' + T.reset : PAL.secondary + '○' + T.reset;
    const ch = sTrunc(e.channel || '?', 16).padEnd(16);
    const room = Math.max(6, cols - 32);
    const valRaw = e.error ? 'error: ' + e.error : String(e.value ?? '-');
    const valCol = e.error ? PAL.danger : (e.changed ? PAL.success : PAL.text);
    return ' ' + PAL.muted + t + T.reset + ' ' + dot + ' ' + PAL.text + ch + T.reset + '  ' + valCol + sTrunc(valRaw, room) + T.reset;
  }

  _fmtUptime() { // format server's uptime as HH:MM:SS
    const sec = Math.floor((Date.now() - this._startTime) / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  _avgDuration() { // format mean recent scrape duration for footer
    if (this._durations.length === 0) return '0s';
    const avg = this._durations.reduce((a, b) => a + b, 0) / this._durations.length;
    return Math.round(avg / 1000) + 's';
  }

  _footer(cols) { // build status footer (counts, uptime, avg duration, key hints)
    const pipe = PAL.muted + ' | ' + T.reset;
    const dot = PAL.muted + ' - ' + T.reset;
    // current ok/err - count quests failing/succeeding, not lifetime totals
    const errCount = (this._questsCache || []).filter(q => q.result?.error).length;
    const okCount  = (this._questsCache || []).filter(q => q.result && !q.result.error).length;
    const bEngine  = (this._chromeConnected ? PAL.success + '● engine' : PAL.danger + '○ engine') + T.reset;
    const bQuests  = PAL.accent + this._questsCache.length + ' quests' + T.reset;
    const bOk      = PAL.success + okCount + ' ok' + T.reset;
    const bErr     = (errCount ? PAL.danger : PAL.muted) + errCount + ' err' + T.reset;
    const bLast    = PAL.text + 'last ' + Math.round(this._lastTickMs / 1000) + 's' + T.reset;
    const bAvg     = PAL.text + 'avg ' + this._avgDuration() + T.reset;
    const bTick    = PAL.secondary + 'tick ' + TICK_INTERVAL / 1000 + 's' + T.reset;

    const left  = bEngine + pipe + bQuests + dot + bOk + dot + bErr;
    const right = bLast + dot + bAvg + pipe + bTick + ' ';
    const lLen = sLen(left);
    const rLen = sLen(right);

    if (lLen + rLen + 4 <= cols) {
      const gap = Math.max(1, cols - lLen - rLen - 3);
      return T.eol + ' ' + left + ' ' + PAL.muted + '─'.repeat(gap) + T.reset + ' ' + right + '\n';
    }

    const blocks = [
      { t: bEngine, s: '' }, { t: bQuests, s: pipe }, { t: bOk, s: dot },
      { t: bErr, s: dot }, { t: bLast, s: dot }, { t: bAvg, s: dot }, { t: bTick, s: pipe },
    ];
    let out = '', line = '', lineLen = 0;
    for (const b of blocks) {
      const tLen = sLen(b.t);
      if (lineLen > 0) {
        const sL = sLen(b.s);
        if (lineLen + sL + tLen > cols - 1) {
          out += T.eol + ' ' + line + '\n';
          line = ''; lineLen = 0;
        } else {
          line += b.s; lineLen += sL;
        }
      }
      line += b.t; lineLen += tLen;
    }
    if (lineLen > 0) out += T.eol + ' ' + line + '\n';
    return out;
  }

  _modeOverlay(cols) { // render active sub-mode's overlay (add, steps, help, confirm)
    switch (this._mode) {
      case 'help': {
        let out = T.eol + '  ' + PAL.danger + 'make sure to run the original quests script, modified versions might be security compromised' + T.reset + '\n';
        out += '\n';
        const rows = [
          'j/↓  next              p  toggle pinned',
          'k/↑  previous          m  toggle manual',
          '↵/r  edit quest        a  add quest',
          'd    delete quest      s  scrape now',
          '/    search            g  screenshot (what headless renders)',
          '< >  sort              v  filter all/scheduled/manual',
          'e    view error        l  value log',
          'c    chromium info     t  tick rate',
          '                       q  quit',
          '',
          '?/h  hide help (scroll wheel scrolls the list / log)',
        ];
        out += rows.map(r => T.eol + '  ' + PAL.muted + r + T.reset + '\n').join('');
        return out;
      }
      case 'error': { // every active error, one row each - chcol + errcol - opens from anywhere
        const errs = (this._questsCache || []).filter(x => x.result?.error);
        if (!errs.length) return T.eol + '  ' + PAL.muted + 'no active errors' + T.reset
          + '\n' + T.eol + '  ' + PAL.muted + 'e or esc to dismiss' + T.reset + '\n';
        const chW = Math.min(20, errs.reduce((m, x) => Math.max(m, (x.channel || '?').length), 0));
        const errW = Math.max(10, cols - chW - 5);
        const shown = errs.slice(0, 12);
        let out = shown.map(x =>
          T.eol + '  ' + PAL.danger + sTrunc(x.channel || '?', chW).padEnd(chW) + T.reset
          + '  ' + PAL.text + sTrunc(x.result.error, errW) + T.reset + '\n').join('');
        if (errs.length > shown.length) out += T.eol + '  ' + PAL.muted + '… +' + (errs.length - shown.length) + ' more' + T.reset + '\n';
        return out + '\n' + T.eol + '  ' + PAL.muted + 'e or esc to dismiss' + T.reset + '\n';
      }
      case 'confirm': { // delete/add/update confirm on row
        const a = this._pendingConfirm?.action;
        if (a === 'delete' || a === 'add' || a === 'update') return '';
        const msg = a === 'tick' ? 'set tick rate to ' + (this._pendingConfirm?.value || '?') + 'ms? (y/n)' : 'confirm? (y/n)';
        return T.eol + '  ' + PAL.danger + msg + T.reset + '\n';
      }
      case 'chromium': {
        const ch = this.chrome;
        const info = [ // read only diagnostics up top - single blank line splits from two editable strings below
          'chrome pid: ' + (ch?.pid || '-'),
          'connected: ' + (this._chromeConnected ? 'yes' : 'no'),
          'user data: ' + (this._userDir || '-'),
          'ws url: ' + (this.ws?.url || '-'),
          'scv-token: ' + SCV_TOKEN,
        ];
        const modeLabel = { temp: 'temporary', live: 'your profile (live)', snapshot: 'snapshot cookies' };
        const modeHint = {
          temp: 'a clean throwaway profile',
          live: 'shares cookies - needs the browser closed',
          snapshot: 'copies your cookies - browser can stay open',
        };
        const settings = [
          { label: 'profile: ' + modeLabel[this._profileMode], hint: modeHint[this._profileMode] },
          { label: 'parallel scrapes: ' + this._concurrency, hint: 'each is one extra browser tab' },
        ];
        const labelW = Math.max(...settings.map(s => s.label.length)); // align both hints to one x
        let out = info.map(l => T.eol + '  ' + PAL.muted + l + T.reset + '\n').join('');
        out += '\n'; // data/settings split
        settings.forEach((s, i) => {
          const sel = i === this._chromiumSel;
          const arrow = sel ? PAL.accent + '›' + T.reset : ' '; // selection marker, aligned across rows
          const lbl = (sel ? PAL.secondary : PAL.accent) + s.label.padEnd(labelW) + T.reset;
          out += T.eol + '  ' + arrow + ' ' + lbl + '  ' + PAL.muted + s.hint + T.reset + '\n';
        });
        // errors/notices live in notif bar only - not duplicated here
        return out + '\n' + T.eol + '  ' + PAL.muted + '↑↓/jk select - ←→/hl cycle - 1-8 scrapes - c/esc dismiss' + T.reset + '\n';
      }
      case 'add-quest':
      case 'edit-quest': { // both render their fields inline - only key hint sits in overlay slot, below status
        const enterHint = this._formCommitsNow() ? (this._mode === 'edit-quest' ? 'enter: save' : 'enter: add') : 'enter: next';
        return T.eol + '  ' + PAL.muted + 'target = [steps |] sel:/key:/ls:  -  tab: steps editor  -  ' + enterHint + ' - esc: cancel' + T.reset + '\n';
      }
      case 'steps':
        return T.eol + '  ' + PAL.muted + '↑↓ row - ←→ verb - type: arg - enter: +step - backspace(empty): del - esc: done' + T.reset + '\n';
      case 'tick-rate': {
        return T.eol + '  ' + PAL.accent + 'tick rate (ms): ' + T.reset + PAL.text + this._input + ' ' + T.reset + '\n';
      }
      default:
        return '';
    }
  }

  _keyHandler(chunk) { // dispatch raw stdin keypress to current mode's action
    const buf = chunk;
    const qs = this._view(); // cursor + row actions index derived (filtered/sorted) list
    const FIELDS = this._formFields().map(f => f[0]); // add: kernel + 4 fields | edit: 4 fields

    if (buf[0] === 0x03) { this._quit(); return; } // ctrl + c - quit from any mode, raw-mode delivers it as 0x03

    // scroll wheel - scrolls log in log mode, else moves quest selection - other mouse events ignored
    if (buf[0] === 0x1b && buf[1] === 0x5b && buf[2] === 0x3c) {
      const m = buf.toString('utf8').match(/\[<(\d+);\d+;\d+[Mm]/);
      const btn = m ? parseInt(m[1], 10) : -1;
      if (btn === 64 || btn === 65) {
        const dir = btn === 64 ? -1 : 1;
        if (this._mode === 'log') this._logScroll = Math.max(0, this._logScroll - dir * 3); // up = older
        else if (this._mode === 'normal' || this._mode === 'help') {
          this._cursor = Math.max(0, Math.min((qs.length || 1) - 1, this._cursor + dir));
        }
        return this._tuiRender();
      }
      return; // clicks, drags, ignored
    }

    if (this._mode === 'search') { // search mode - live-filter by channel as you type, enter keeps filter, esc clears it
      if (buf[0] === 0x1b) { // esc (clear) - or ignore arrows/nav
        if (buf.length === 1) { this._search = ''; this._dismiss(); }
        return this._tuiRender();
      }
      if (buf.length === 1 && buf[0] === 0x0d) { this._dismiss(); this._cursor = 0; return this._tuiRender(); } // enter: keep filter
      if (buf.length === 1 && (buf[0] === 0x7f || buf[0] === 0x08)) { this._search = this._search.slice(0, -1); this._cursor = 0; return this._tuiRender(); }
      for (const chr of buf.toString('utf8')) if (chr >= ' ' && chr <= '~' && this._search.length < 60) this._search += chr;
      this._cursor = 0;
      return this._tuiRender();
    }

    if (this._mode === 'log') { // log view: scroll scrape history (up = older)
      if (buf[0] === 0x1b && buf.length === 3) { // arrows
        if (buf[2] === 0x41) this._logScroll += 1;
        else if (buf[2] === 0x42) this._logScroll = Math.max(0, this._logScroll - 1);
        return this._tuiRender();
      }
      if (buf.length !== 1) return;
      const k = buf[0];
      if (k === 0x1b || k === 0x6c || k === 0x4c) { this._dismiss(); return this._tuiRender(); } // esc / l
      if (k === 0x71 || k === 0x51) { this._quit(); return; }                                    // q
      if (k === 0x6b || k === 0x4b) this._logScroll += 1;                                        // k - older
      else if (k === 0x6a || k === 0x4a) this._logScroll = Math.max(0, this._logScroll - 1);     // j - newer
      else if (k === 0x67) this._logScroll = Infinity;                                           // g - oldest (clamped on render)
      else if (k === 0x47) this._logScroll = 0;                                                  // G - newest (tail)
      return this._tuiRender();
    }

    if (buf[0] === 0x1b && buf[1] === 0x5b && buf.length === 3) { // arrow keys - navigate in normal/help, dismiss error
      if (this._mode === 'normal' || this._mode === 'help') {
        if (buf[2] === 0x41) this._cursor = Math.max(0, this._cursor - 1);
        if (buf[2] === 0x42 && qs.length > 0) this._cursor = Math.min(qs.length - 1, this._cursor + 1);
        return this._tuiRender();
      }
      if (this._mode === 'add-quest' || this._mode === 'edit-quest') { // up/down move between fields, left/right cycles target type
        if (buf[2] === 0x41) this._inputStep = Math.max(0, this._inputStep - 1);
        else if (buf[2] === 0x42) this._inputStep = Math.min(FIELDS.length - 1, this._inputStep + 1);
        else if ((buf[2] === 0x43 || buf[2] === 0x44) && FIELDS[this._inputStep] === 'selector')
          this._addData.selector = this._cycleExtractionPrefix(this._addData.selector, buf[2] === 0x43 ? 1 : -1);
        return this._tuiRender();
      }
      if (this._mode === 'chromium') { // up/down select setting, left/right adjust it
        if (buf[2] === 0x41) this._chromiumSel = Math.max(0, this._chromiumSel - 1);
        if (buf[2] === 0x42) this._chromiumSel = Math.min(1, this._chromiumSel + 1);
        if (buf[2] === 0x44) this._chromiumAdjust(-1);
        if (buf[2] === 0x43) this._chromiumAdjust(1);
        return this._tuiRender();
      }
      if (this._mode === 'steps') { // up/down row, left/right cycle verb (or extraction prefix)
        if (buf[2] === 0x41) this._stepCursor = Math.max(0, this._stepCursor - 1);
        else if (buf[2] === 0x42) this._stepCursor = Math.min(this._stepsList.length, this._stepCursor + 1);
        else if (buf[2] === 0x43 || buf[2] === 0x44) {
          const dir = buf[2] === 0x43 ? 1 : -1;
          if (this._onExtractionRow()) this._stepsExt = this._cycleExtractionPrefix(this._stepsExt, dir);
          else { const s = this._stepsList[this._stepCursor]; const i = STEP_VERBS.indexOf(s.verb); s.verb = STEP_VERBS[(i + dir + STEP_VERBS.length) % STEP_VERBS.length]; }
        }
        return this._tuiRender();
      }
      if (this._mode === 'error') { this._dismiss(); return this._tuiRender(); }
      return;
    }

    // text input modes are handled before global shortcuts - url pastes would toggle help/quit instead of typing otherwise
    if (this._mode === 'steps') { // arrows (up/down row, left/right verb) handled in arrow block above
      if (buf.length === 1 && buf[0] === 0x1b) { this._closeSteps(); return; } // esc - back to form
      if (buf.length === 1 && buf[0] === 0x0d) { // enter - append a step
        const at = this._onExtractionRow() ? this._stepsList.length : this._stepCursor + 1;
        this._stepsList.splice(at, 0, { verb: 'wait', arg: '' });
        this._stepCursor = at;
        return this._tuiRender();
      }
      if (buf.length === 1 && (buf[0] === 0x7f || buf[0] === 0x08)) { // backspace
        if (this._onExtractionRow()) { this._stepsExt = this._stepsExt.slice(0, -1); }
        else {
          const s = this._stepsList[this._stepCursor];
          if (s.arg) s.arg = s.arg.slice(0, -1);
          else { // empty arg - delete step. keep cursor in place so next row slides up into view - only pull back at list end
            this._stepsList.splice(this._stepCursor, 1);
            if (this._stepCursor >= this._stepsList.length) this._stepCursor = Math.max(0, this._stepsList.length - 1);
          }
        }
        return this._tuiRender();
      }
      const add = chr => { if (chr < ' ' || chr > '~') return; if (this._onExtractionRow()) { if (this._stepsExt.length < 2000) this._stepsExt += chr; } else if (this._stepsList[this._stepCursor].arg.length < 2000) this._stepsList[this._stepCursor].arg += chr; };
      for (const chr of buf.toString('utf8')) add(chr);
      return this._tuiRender();
    }

    if (this._mode === 'add-quest' || this._mode === 'edit-quest') {
      if (buf.length === 1 && buf[0] === 0x09) { this._openSteps(); return; } // tab - steps sub-mode
      if (buf.length === 1 && buf[0] === 0x1b) { this._dismiss(); return this._tuiRender(); } // esc
      if (buf.length === 1 && buf[0] === 0x0d) { this._formEnter(); return; } // enter
      if (buf.length === 1 && (buf[0] === 0x7f || buf[0] === 0x08)) { // backspace
        const f = FIELDS[this._inputStep]; this._addData[f] = this._addData[f].slice(0, -1);
        if (f === 'kernel') this._applyKernel();
        else (this._kernelTouched ||= new Set()).add(f); // typed directly in a derived field - kernel paste must stop clobbering it
        return this._tuiRender();
      }
      const f = FIELDS[this._inputStep];
      // cap generously - deep css selector (or full kernel line) is easily >250 chars
      for (const chr of buf.toString('utf8')) if (chr >= ' ' && chr <= '~' && this._addData[f].length < 2000) this._addData[f] += chr;
      if (f === 'kernel') this._applyKernel(); // paste whole line, rows below fill live
      else (this._kernelTouched ||= new Set()).add(f);
      return this._tuiRender();
    }
    if (this._mode === 'tick-rate') {
      if (buf.length === 1 && buf[0] === 0x1b) { this._dismiss(); return this._tuiRender(); }
      if (buf.length === 1 && buf[0] === 0x0d) { this._tickRateEnter(); return; }
      if (buf.length === 1 && (buf[0] === 0x7f || buf[0] === 0x08)) { this._input = this._input.slice(0, -1); return this._tuiRender(); }
      for (const chr of buf.toString('utf8')) if (chr >= '0' && chr <= '9' && this._input.length < 10) this._input += chr;
      return this._tuiRender();
    }

    // remaining modes are single-key
    if (buf.length !== 1) return;
    const c = buf[0];

    if (c === 0x1b) { this._dismiss(); return this._tuiRender(); } // esc - dismiss submenu
    if (c === 0x3f || ((c === 0x68 || c === 0x48) && this._mode !== 'chromium')) { // ?/h - help toggle (h is left/decrement inside chromium mode, not this)
      this._mode = this._mode === 'help' ? 'normal' : 'help';
      return this._tuiRender();
    }
    if (c === 0x71 || c === 0x51) { this._quit(); return; } // q - quit (text modes handled above)

    if (this._mode === 'error') {
      if (c === 0x65 || c === 0x45) { this._dismiss(); return this._tuiRender(); }
      return;
    }
    if (this._mode === 'chromium') {
      if (c === 0x63 || c === 0x43) { this._dismiss(); return this._tuiRender(); }
      if (c === 0x6b || c === 0x4b) { this._chromiumSel = Math.max(0, this._chromiumSel - 1); return this._tuiRender(); } // k - select up
      if (c === 0x6a || c === 0x4a) { this._chromiumSel = Math.min(1, this._chromiumSel + 1); return this._tuiRender(); } // j - select down
      if (c === 0x68 || c === 0x48) { this._chromiumAdjust(-1); return this._tuiRender(); } // h - left / decrement
      if (c === 0x6c || c === 0x4c) { this._chromiumAdjust(1); return this._tuiRender();  } // l - right / increment
      if (c === 0x0d || c === 0x20) { this._chromiumAdjust(1); return this._tuiRender();  } // enter/space act on selection
      if (c >= 0x31 && c <= 0x38) { this._chromiumSel = 1; this.e._setConcurrency(c - 0x30); return this._tuiRender(); } // 1-8 set scrapes
      return;
    }

    if (this._mode === 'normal' || this._mode === 'help') { // normal + help - keys work transparently through help overlay
      if (c === 0x6a || c === 0x4a) { if (qs.length > 0) this._cursor = Math.min(qs.length - 1, this._cursor + 1); } // j / J
      else if (c === 0x6b || c === 0x4b) this._cursor = Math.max(0, this._cursor - 1); // k / K
      else if (c === 0x70 || c === 0x50) { this._togglePinned(); return; } // p / P
      else if (c === 0x6d || c === 0x4d) { this._toggleManual(); return; } // m / M
      else if (c === 0x64 || c === 0x44) { // d / D
        this._pendingConfirm = { action: 'delete', channel: qs[this._cursor]?.channel };
        this._enterSubMode('confirm'); return this._tuiRender();
      }
      else if (c === 0x61 || c === 0x41) { // a / A
        this._enterSubMode('add-quest'); this._inputStep = 0; this._addData = { ...ADD_DATA_DEFAULTS }; this._kernelTouched = null;
      }
      else if (c === 0x65 || c === 0x45) { this._enterSubMode('error'); }                       // e / E - all active errors
      else if (c === 0x0d || c === 0x72 || c === 0x52) { this._startEdit(); }                   // enter / r - edit selected inline
      else if (c === 0x73 || c === 0x53) { this._scrapeNow(); }                                 // s / S - scrape now
      else if (c === 0x67 || c === 0x47) { this._screenshot(); return; }                        // g / G - screenshot (what headless renders)
      else if (c === 0x63 || c === 0x43) { this._enterSubMode('chromium'); }                    // c / C
      else if (c === 0x74 || c === 0x54) { this._enterSubMode('tick-rate'); this._input = ''; } // t / T
      else if (c === 0x2f) { this._enterSubMode('search'); return this._tuiRender(); }          // / - search channels
      else if (c === 0x3c) { this._cycleSort(-1); }                                             // < - prev sort
      else if (c === 0x3e) { this._cycleSort(1); }                                              // > - next sort
      else if (c === 0x76 || c === 0x56) { this._cycleFilter(); }                               // v / V - all/scheduled/manual
      else if (c === 0x6c || c === 0x4c) { this._enterSubMode('log'); this._logScroll = 0; }    // l / L - value log
      else return;
      return this._tuiRender();
    }

    if (this._mode === 'confirm') {
      if (c === 0x79 && this._pendingConfirm) {
        const a = this._pendingConfirm.action;
        if (a === 'delete') { this._doDelete(); return; }
        if (a === 'add') { this._doAddQuest(); return; }
        if (a === 'update') { this._doUpdateQuest(); return; }
        if (a === 'tick') { this._doSetTickRate(); return; }
      }
      this._dismiss(); return this._tuiRender(); // n/esc - cancel
    }
  }

  _enterSubMode(mode) { // switch into sub-mode, remembering mode to return to
    if (this._mode === 'help') this._prevMode = 'help';
    else this._prevMode = 'normal';
    this._mode = mode;
  }

  // parse |-separated target pipeline - zero+ steps then terminal extraction, prefix encoded
  _parseTarget(raw) { return parseTarget(raw); } // shared module parser (see parseTarget)

  _targetField(q) { // inverse of _parseTarget - rebuild pipeline string frm quest so edit round-trips both steps and extraction type
    const ext = q.jsonKey ? `key:${q.jsonKey}` : q.storageKey ? `ls:${q.storageKey}` : (q.selector || '');
    if (!q.steps?.length) return ext;
    const stepStrs = q.steps.map(st => { const [v] = Object.keys(st); return `${v}:${st[v]}`; });
    return [...stepStrs, ext].join(' | ');
  }

  _openSteps() { // steps sub-mode - row per step editor over target pipeline - deserializes target into step list + extraction row
    const parsed = this._parseTarget(this._addData.selector);
    this._stepsList = (parsed.steps || []).map(st => { const [v] = Object.keys(st); return { verb: v, arg: st[v] }; });
    this._stepsExt = parsed.jsonKey ? 'key:' + parsed.jsonKey : parsed.storageKey ? 'ls:' + parsed.storageKey : (parsed.selector || '');
    this._stepCursor = 0;
    this._stepsScrollTop = 0;
    this._stepReturnMode = this._mode; // add-quest, edit-quest
    this._mode = 'steps';
    this._tuiRender();
  }

  _closeSteps() { // leave steps editor, folding steps back into add-form target
    this._addData.selector = this._serializeSteps();
    this._mode = this._stepReturnMode;
    this._tuiRender();
  }

  _serializeSteps() { // join steps editor's rows back into a verb:arg target string
    const parts = this._stepsList.filter(s => s.arg.trim()).map(s => s.verb + ':' + s.arg.trim());
    if (this._stepsExt.trim()) parts.push(this._stepsExt.trim());
    return parts.join(' | ');
  }

  _cycleExtractionPrefix(s, dir) { // cycle extraction row's type, preserving arg
    const prefixes = ['', 'key:', 'ls:', 'harvest:']; // '' = bare css selector (value); harvest: = whole component
    let arg = s, cur = 0;
    if (s.startsWith('key:')) { arg = s.slice(4); cur = 1; }
    else if (s.startsWith('ls:')) { arg = s.slice(3); cur = 2; }
    else if (s.startsWith('harvest:')) { arg = s.slice(8); cur = 3; }
    else if (s.startsWith('sel:')) { arg = s.slice(4); cur = 0; }
    return prefixes[(cur + dir + prefixes.length) % prefixes.length] + arg;
  }

  _onExtractionRow() { return this._stepCursor === this._stepsList.length; } // true when steps cursor is on trailing extraction row

  _startEdit() { // load selected quest into edit form - target field is prefix-encoded, so steps + extraction round-trip
    const q = this._view()[this._cursor];
    if (!q) return;
    this._addData = {
      channel: q.channel || '',
      url: q.url || '',
      selector: this._targetField(q),
      interval: String(q.interval || DEFAULT_INTERVAL),
    };
    this._editingChannel = q.channel;
    this._inputStep = 0;
    this._kernelTouched = null;
    this._enterSubMode('edit-quest');
  }

  _editingRow() { // selected quest is being edited inline during edit-quest mode and through update confirmation
    if (this._editingChannel == null) return false;
    return this._mode === 'edit-quest' || (this._mode === 'confirm' && this._pendingConfirm?.action === 'update');
  }

  _addingRow() { // adding a quest - same two-column form as edit, but on placeholder row at top of list
    return this._mode === 'add-quest' || (this._mode === 'confirm' && this._pendingConfirm?.action === 'add');
  }

  _cycleSort(dir) { // step sort key forward/back through SORT_KEYS
    const i = SORT_KEYS.indexOf(this._sortKey);
    this._sortKey = SORT_KEYS[(i + dir + SORT_KEYS.length) % SORT_KEYS.length];
    this._cursor = 0; this._scrollTop = 0;
  }

  _cycleFilter() { // step row filter to next value in FILTERS
    const i = FILTERS.indexOf(this._filter);
    this._filter = FILTERS[(i + 1) % FILTERS.length];
    this._cursor = 0; this._scrollTop = 0;
  }

  _chromiumAdjust(dir) { // apply adjustment to whichever chromium menu setting is selected (temp/live/snapshot) and relaunch
    if (this._chromiumSel === 0) {
      if (this._relaunching) return; // h/l held or repeated before prior relaunch lands must not overlap teardowns
      const modes = ['temp', 'live', 'snapshot'];
      const i = Math.max(0, modes.indexOf(this._profileMode)); // a non-cycling mode must not modulo-wrap from -1 into a wrong mode
      this._profileMode = modes[(i + (dir > 0 ? 1 : modes.length - 1)) % modes.length];
      this._relaunching = true;
      this.e._relaunchChrome().then(() => this._tuiRender()).catch(err => { // surface relaunch failure
        this._notice = 'chromium relaunch failed: ' + (err?.message || err);
        this._tuiRender();
      }).finally(() => { this._relaunching = false; });
    } else {
      this.e._setConcurrency(this._concurrency + dir);
    }
  }

  _dismiss() { // close current overlay/sub-mode back to previous mode
    this._mode = this._prevMode || 'normal';
    this._prevMode = 'normal';
    this._input = '';
    this._inputStep = 0;
    this._pendingConfirm = null;
    this._editingChannel = null;
  }

  _mutateAndRefresh(fn, after) { // run quests.json mutation, refresh cache from disk, then repaint - errors surface as a notice
    updateQuests(fn).then(() => readQuests()).then(qs => {
      this._questsCache = qs;
      if (after) after(qs);
      this._tuiRender();
    }).catch(err => {
      this._notice = 'save failed: ' + (err?.message || err); // swallowed write makes user believe mutation committed
      this._tuiRender();
    });
  }

  _toggleFlag(flag) { // flip boolean flag on cursor's quest, then persist and refresh
    const q = this._view()[this._cursor];
    if (!q) return;
    this._mutateAndRefresh(quests => {
      const found = quests.find(x => x.channel === q.channel);
      if (found) found[flag] = !found[flag];
    });
  }

  _togglePinned() { this._toggleFlag('pinned'); } // toggle pinned flag on cursor's quest
  _toggleManual() { this._toggleFlag('manual'); } // toggle manual (no auto-scrape) flag on cursor's quest

  _doDelete() { // delete confirmed channel (by name, not cursor - view can re-sort mid-confirm)
    const channel = this._pendingConfirm?.channel;
    if (!channel) { this._dismiss(); this._tuiRender(); return; }
    this._mutateAndRefresh(quests => {
      const idx = quests.findIndex(x => x.channel === channel);
      if (idx >= 0 && !quests[idx].pinned) quests.splice(idx, 1);
    }, qs => {
      if (!qs.find(x => x.channel === channel)) { // really gone - clear throttle + volatile state so a re-add starts fresh
        delete this.e.lastRun[channel];
        this.e._questStates.delete(channel);
      }
      this._cursor = qs.length === 0 ? 0 : Math.min(this._cursor, qs.length - 1);
      this._dismiss();
    });
  }

  _formCommitsNow() { // enter commits on complete line pasted into quick fill, or last field reached walking down
    const fields = this._formFields();
    const onKernel = fields[this._inputStep]?.[0] === 'kernel';
    return (onKernel && this._addData.url.trim() && this._addData.selector.trim()) || this._inputStep >= fields.length - 1;
  }
  _formEnter() { // handle enter in quest form - advance field, or commit (from complete quick-fill line or on last field)
    if (!this._formCommitsNow()) { this._inputStep++; return this._tuiRender(); } // advance to next field
    const d = this._addData;
    if (!d.channel.trim() && d.url.trim()) d.channel = 'ch_q_' + shortHash(d.url.trim()); // unnamed url-led quest - derive stable channel so paste-and-commit reaches confirm
    if (!d.channel.trim()) return; // nothing to key on - no channel and no url to derive from
    this._pendingConfirm = { action: this._editingChannel ? 'update' : 'add', channel: d.channel.trim() };
    this._mode = 'confirm';
    this._tuiRender();
  }

  _buildQuestFromForm() { // build a quest object from add/edit form fields
    const d = this._addData;
    return {
      channel: d.channel.trim(),
      ...(d.url.trim() ? { url: d.url.trim() } : {}),
      ...this._parseTarget(d.selector),
      interval: Math.max(MIN_INTERVAL, parseInt(d.interval) || DEFAULT_INTERVAL),
    };
  }

  _doAddQuest() { // commit add form - register new quest + refresh view
    const form = this._buildQuestFromForm(); // snapshot now - _addData may belong to a different form by the time queued write runs
    this._mutateAndRefresh(quests => {
      if (quests.length >= MAX_QUESTS) throw new Error(`max ${MAX_QUESTS} quests`); // mirror api gate - surfaces via save-failed notice
      quests.unshift(form); // new quests go to top
    }, () => {
      this._cursor = 0; // select newly added top row
      this._scrollTop = 0;
      this._dismiss();
    });
  }

  _doUpdateQuest() { // commit edit - rewrite quest (renaming channel if changed) and refresh
    const oldChannel = this._editingChannel;
    const form = this._buildQuestFromForm(); // snapshot now - write is queued, and _addData may belong to a different edit by the time it runs
    const newChannel = form.channel;
    this._mutateAndRefresh(quests => {
      const idx = quests.findIndex(x => x.channel === oldChannel);
      if (idx < 0) return;
      if (newChannel && newChannel !== oldChannel && quests.some(x => x.channel === newChannel)) {
        throw new Error(`channel "${newChannel}" already in use`); // rename must not silently collide with another quest
      }
      quests[idx] = {
        ...form,
        pinned: quests[idx].pinned, manual: quests[idx].manual,
        onChange: quests[idx].onChange, result: quests[idx].result, // edit must not drop alert wiring or last scraped value
      };
    }, () => {
      if (oldChannel && newChannel && newChannel !== oldChannel) { // a rename must carry throttle + volatile state to new key
        this.e.lastRun[newChannel] = this.e.lastRun[oldChannel];
        delete this.e.lastRun[oldChannel];
        const st = this.e._questStates.get(oldChannel);
        if (st) { this.e._questStates.delete(oldChannel); this.e._questStates.set(newChannel, st); }
      }
      this._dismiss();
    });
  }

  _scrapeNow() { // force immediate scrape of cursor's quest
    const q = this._view()[this._cursor];
    if (!q || !q.url) return this._tuiRender();
    if (this._questStates.get(q.channel)?.status === 'scraping') return; // already in flight - don't overlap
    this.e.scrapeOne(q).then(() => this._tuiRender()).catch(() => {});
  }

  _screenshot() { // save png of what headless renders for selected quest's url - captured on throwaway tab
    const q = this._view()[this._cursor];
    if (!q) return this._tuiRender();
    if (!this._chromeConnected) { this._notice = 'screenshot: engine offline'; return this._tuiRender(); }
    if (!q.url) { this._notice = 'screenshot: quest has no URL'; return this._tuiRender(); }
    this._notice = 'capturing ' + q.channel + '…';
    this._tuiRender();
    this.e.captureScreenshot(q)
      .then(file => { this._notice = 'saved ' + file; this._tuiRender(); })
      .catch(err => { this._notice = 'screenshot failed: ' + err.message; this._tuiRender(); });
  }

  _tickRateEnter() { // validate typed tick-rate and open its confirm
    const v = parseInt(this._input);
    if (!v || v < 1000 || v > MAX_TICK_RATE) { this._dismiss(); return this._tuiRender(); } // upper cap - huge values overflow setInterval to a 1ms busy-loop
    this._pendingConfirm = { action: 'tick', value: v };
    this._mode = 'confirm';
    this._tuiRender();
  }

  _doSetTickRate() { // apply confirmed global tick interval
    if (this._pendingConfirm?.value) TICK_INTERVAL = Math.min(this._pendingConfirm.value, MAX_TICK_RATE);
    this._dismiss();
    this._tuiRender();
  }
}

// TEST RUNNER (compare scrape against assertion - engine error fails - exact expect, substring contains, regex matches, else default)

function checkExpect(t, result) { // check --run test's scrape result against expectation
  if (result.error) return { ok: false, detail: 'error: ' + result.error };
  const v = result.value;
  if (t.expect !== undefined)   return { ok: v === String(t.expect), detail: `expected "${t.expect}", got "${v}"` };
  if (t.contains !== undefined) return { ok: v != null && String(v).includes(t.contains), detail: `expected to contain "${t.contains}", got "${v}"` };
  if (t.matches !== undefined)  { let re; try { re = new RegExp(t.matches); } catch { return { ok: false, detail: 'bad regex: ' + t.matches }; } return { ok: re.test(String(v ?? '')), detail: `expected to match /${t.matches}/, got "${v}"` }; }
  return { ok: v != null && v !== '', detail: `expected a non-empty value, got "${v}"` };
}

async function runTests(file) { // run a --run spec file: scrape each quest live and assert its expectation
  if (!file) { console.error('[quests] --run needs a test file'); process.exit(2); }
  if (process.argv.includes('--allow-local')) { // test-only: reach local dev server (bypasses scrape ssrf guard)
    ALLOW_LOCAL = true;
    console.log('[quests] --allow-local: scrape ssrf guard relaxed for private/loopback (test mode only)');
  }
  let tests;
  try { tests = JSON.parse(await readFile(file, 'utf-8')); }
  catch (e) { console.error('[quests] cannot read test file:', e.message); process.exit(2); }
  if (!Array.isArray(tests)) { console.error('[quests] test file must be a json array'); process.exit(2); }

  const engine = new QuestEngine();
  try {
    await engine._startEgressProxy();
    engine._chromeBin = await findChrome();
    engine._userDir = await engine._freshProfileDir();
    await engine._launchChrome(engine._userDir);
  } catch (e) {
    console.error('[quests] engine bring-up failed:', e.message);
    try { engine.destroy(); } catch {}
    process.exit(2);
  }

  let passed = 0, failed = 0;
  for (const t of tests) {
    const q = t.line ? { ...parseQuestLine(t.line), ...t } : t; // a 'line' expands - explicit fields still win
    const name = t.name || q.channel || q.url || '(unnamed)';
    let result;
    try { result = await engine.execute(q); }
    catch (e) { result = { value: null, timestamp: Date.now(), error: e.message }; }
    const { ok, detail } = checkExpect(t, result);
    if (ok) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name} - ${detail}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  try { engine.destroy(); } catch {}
  process.exit(failed ? 1 : 0);
}

// entry point: only run server/cli when executed directly, imported by a test it just exposes exports without booting

let     isMain = false;
try   { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
catch { isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href; }

if (isMain) {
  const runIdx = process.argv.indexOf('--run');
  if (runIdx >= 0) await runTests(process.argv[runIdx + 1]); // runs + exits - never falls through

  const engine = new QuestEngine();
  const tui = new QuestTUI(engine);
  engine.onRender = () => tui._tuiRender(); // engine state changes > repaint (no-op until start())
  const teardown = () => { try { tui.stop(); } catch {} try { engine.destroy(); } catch {} };
  // let any in-flight write finish (its rename land) before we tear down and exit
  process.on('SIGINT', async () => { await Promise.race([_questQueue, new Promise(r => setTimeout(r, 2000))]); teardown(); process.exit(0); }); // never let a stalled write block the exit
  process.on('SIGTERM', async () => { await Promise.race([_questQueue, new Promise(r => setTimeout(r, 2000))]); teardown(); process.exit(0); });
  // last-resort sync safety: exit fires on every termination sig handlers miss, only sync runs here, ensures chromium isn't orphaned
  process.on('exit', () => { try { engine._killChromeSync(); } catch {} });

  try {
    await engine.init();
    tui.start();
    const started = Date.now(); // drift-corrected cadence: each tick starts on a whole multiple of TICK_INTERVAL, not TICK_INTERVAL + tick duration
    let cycle = 0;
    while (true) {
      try { await engine.tick(); }
      catch (err) { // a single tick rejection must never kill the loop - record it and keep cadence
        engine._engineError = `tick failed: ${err instanceof Error ? err.message : String(err)}`;
        engine.onRender?.();
      }
      const next = started + ++cycle * TICK_INTERVAL;
      await new Promise(r => setTimeout(r, Math.max(0, next - Date.now())));
    }
  } catch (err) {
    process.stdout.write(T.show);
    console.error('[quests] fatal:', err instanceof Error ? err.message : String(err));
    teardown();
    process.exit(1);
  }
}

// exposed for test harness - isMain guard above keeps importing this file from booting server
export { QuestEngine, QuestTUI, parseTarget, parseQuestLine, sanitizeSteps, checkExpect, unfurl, findChrome };

// security model internals, exported for security test tier (ssrf guards + write-gate)
export { isLocalOrigin, isPrivateAddr, isValidQuestUrl, questUrlIsSafe, resolvePublicIP, isOwnerWrite, pinnedGet, SCV_TOKEN, API_PORT };

// usage: configure({ output: 'feed.json' }); const e = new QuestEngine(); await e.init(); setInterval(() => e.tick(), 5000);
export function configure({ // programmatic config to embed engine (same knobs as cli flags/env) - test suite drives this too
  output,        // equivalent to --output
  history,       // equivalent to --history (change-log)
  trustIps,      // equivalent to --trust-ip
  allowLocal,    // equivalent to --allow-local
  scrapeDeadline // test-only: shrink wall-clock scrape cap so a deadline test doesn't wait out the real 60s
} = {}) {
  if (output         !== undefined) OUTPUT_FILE     = output;
  if (history        !== undefined) HISTORY_FILE    = history;
  if (allowLocal     !== undefined) ALLOW_LOCAL     = !!allowLocal;
  if (trustIps       !== undefined) TRUST_IPS       = Array.isArray(trustIps) ? trustIps : String(trustIps || '').split(',').map(s => s.trim()).filter(Boolean);
  if (scrapeDeadline !== undefined) SCRAPE_DEADLINE = scrapeDeadline;
}