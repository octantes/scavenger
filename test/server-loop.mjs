// server-loop tier - quests engine scheduling + persistence, no browser: due-logic, atomic persist, onChange, corrupt-file abort

import { chdir } from 'process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import { existsSync } from 'fs';
import { QuestEngine, configure, pinnedGet } from '../quests.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const readQ = () => JSON.parse(readFileSync('quests.json', 'utf8'));
const delay = ms => new Promise(r => setTimeout(r, ms));
chdir(mkdtempSync(join(tmpdir(), 'scv-loop-')));
configure({ allowLocal: true });

let payload = { price: '10.00' };
const srv = createServer((req, res) => { res.setHeader('content-type', 'application/json'); if (req.url === '/notjson') return res.end('<html>not json</html>'); res.end(JSON.stringify(payload)); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;

try {
  // tick(): due jsonKey quest is scraped, value folded in + persisted
  writeFileSync('quests.json', JSON.stringify([{ channel: 'p', url, jsonKey: 'price', interval: 1000 }]));
  const engine = new QuestEngine();
  await engine.tick();
  ok(readQ().find(q => q.channel === 'p')?.result?.value === '10.00', 'tick() scraped due quest and persisted value');
  ok(engine._questStates.get('p')?.lastValue === '10.00', 'tick() folded value into per-channel state');

  // due-scheduling: not-yet-due quest skipped (effective floor is 3000ms)
  payload = { price: '20.00' }; // server value changed
  await engine.tick(); // 'p' was just run > inside interval > not due
  ok(readQ().find(q => q.channel === 'p')?.result?.value === '10.00', 'quest inside its interval is not re-scraped');
  engine.lastRun['p'] = Date.now() - 4000; // simulate elapsed time past 3s floor
  await engine.tick(); // now due > re-scrapes new value
  ok(readQ().find(q => q.channel === 'p')?.result?.value === '20.00', 'quest past its interval is re-scraped');

  // overlapping tick()s must not double-scrape - due-filter checks live 'scraping' status, not just lastRun
  writeFileSync('quests.json', JSON.stringify([{ channel: 'slow', url, jsonKey: 'price', interval: 3000 }]));
  const er = new QuestEngine();
  let executeCount = 0;
  const origExecute = er.execute.bind(er);
  er.execute = async (...args) => { executeCount++; await delay(300); return origExecute(...args); }; // widen overlap window
  const t1 = er.tick();
  await delay(100); // let tick #1 clear due-filter and flip status to 'scraping' before tick #2 starts
  ok(er._questStates.get('slow')?.status === 'scraping', 'tick #1 has flipped status to scraping before tick #2 fires');
  const t2 = er.tick(); // re-entrant tick() call while first is still mid-scrape for this channel
  await Promise.all([t1, t2]);
  ok(executeCount === 1, `two overlapping tick() calls scrape still-in-flight channel only once, not twice (got ${executeCount})`);

  // scrapeOne() also guards re-entry - manual trigger over in-flight scrape is no-op, not second scrape
  writeFileSync('quests.json', JSON.stringify([{ channel: 'slow2', url, jsonKey: 'price', interval: 3000 }]));
  const es = new QuestEngine();
  let execute2Count = 0;
  const origExecute2 = es.execute.bind(es);
  es.execute = async (...args) => { execute2Count++; await delay(300); return origExecute2(...args); };
  const q2 = readQ().find(q => q.channel === 'slow2');
  const s1 = es.scrapeOne(q2);
  await delay(100);
  const s2 = es.scrapeOne(q2); // fires while s1 is still mid-scrape
  const [, r2] = await Promise.all([s1, s2]);
  ok(execute2Count === 1, `scrapeOne() called again mid-scrape is no-op, not second scrape (got ${execute2Count})`);
  ok(r2.error === 'already scraping', `skipped call's result says so, not silent empty success (got ${JSON.stringify(r2)})`);

  // manual channels are never scraped
  writeFileSync('quests.json', JSON.stringify([{ channel: 'm', manual: true, result: { value: 'held', timestamp: Date.now() } }]));
  const e2 = new QuestEngine();
  await e2.tick();
  ok(readQ().find(q => q.channel === 'm')?.result?.value === 'held', 'manual channel is left untouched by tick');

  // onChange.emit: changed value is re-emitted to another channel (quests-as-alerts)
  payload = { price: '99.00' };
  writeFileSync('quests.json', JSON.stringify([{ channel: 'src', url, jsonKey: 'price', interval: 1, onChange: { emit: 'alert_ch' } }]));
  const e3 = new QuestEngine();
  await e3.tick();
  const alert = readQ().find(q => q.channel === 'alert_ch');
  ok(alert && alert.manual === true && alert.result?.value === '99.00', `onChange re-emitted changed value to another channel (${JSON.stringify(alert)})`);

  // onChange does not re-emit when value is unchanged
  const alertTs = readQ().find(q => q.channel === 'alert_ch').result.timestamp;
  e3.lastRun['src'] = Date.now() - 4000;
  await e3.tick(); // same payload (99.00) > no change > alert must not be re-emitted
  ok(readQ().find(q => q.channel === 'alert_ch').result.timestamp === alertTs, 'onChange does not re-emit unchanged value');

  // interval floor: interval below 3000ms is clamped to 3000 for due-scheduling
  payload = { price: 'f1' };
  writeFileSync('quests.json', JSON.stringify([{ channel: 'fl', url, jsonKey: 'price', interval: 100 }]));
  const ef = new QuestEngine();
  await ef.tick(); // scrapes f1
  payload = { price: 'f2' };
  ef.lastRun['fl'] = Date.now() - 500; // 500ms elapsed - well past interval:100, but under 3000 floor
  await ef.tick(); // must not re-scrape (floor not reached)
  ok(readQ().find(q => q.channel === 'fl').result.value === 'f1', 'sub-3000ms interval is clamped to 3000ms floor');

  // multiple due quests in one tick are all scraped
  payload = { price: 'multi' };
  writeFileSync('quests.json', JSON.stringify([
    { channel: 'm1', url, jsonKey: 'price', interval: 1 },
    { channel: 'm2', url, jsonKey: 'price', interval: 1 },
    { channel: 'm3', url, jsonKey: 'price', interval: 1 },
  ]));
  const em = new QuestEngine();
  await em.tick();
  ok(['m1', 'm2', 'm3'].every(c => readQ().find(q => q.channel === c)?.result?.value === 'multi'), 'tick scrapes every due quest');

  // scrapeOne error path: non-json response yields error result, no crash
  writeFileSync('quests.json', JSON.stringify([{ channel: 'err', url: url + 'notjson', jsonKey: 'price', interval: 999999 }]));
  const errRes = await new QuestEngine().scrapeOne({ channel: 'err', url: url + 'notjson', jsonKey: 'price' });
  ok(errRes && errRes.error && errRes.value === null, `scrapeOne surfaces error for failing quest (errored: ${!!(errRes && errRes.error)})`);
  ok(readQ().find(q => q.channel === 'err')?.result?.error, 'error is persisted on quest');

  const timers = () => process.getActiveResourcesInfo().filter(r => r === 'Timeout').length;
  const eDl = new QuestEngine();
  eDl._navigate = async () => {};
  const beforeT = timers();
  await eDl._fetchExtract('https://example.com/', async () => 'v', 'nope', {}, null);
  ok(timers() <= beforeT, `_fetchExtract clears its deadline timer (${beforeT} before, ${timers()} after)`);

  // scrapeOne(): manual/force path also folds + persists
  payload = { price: '55.00' };
  writeFileSync('quests.json', JSON.stringify([{ channel: 'one', url, jsonKey: 'price', interval: 999999 }]));
  const e4 = new QuestEngine();
  const r = await e4.scrapeOne({ channel: 'one', url, jsonKey: 'price' });
  ok(r && r.value === '55.00' && !r.error, 'scrapeOne returns fetched value');
  ok(readQ().find(q => q.channel === 'one')?.result?.value === '55.00', 'scrapeOne persists to quests.json');

  // --output mirror + --history append (set sinks in-process)
  payload = { price: 'aaa' };
  configure({ output: 'feed.json', history: 'hist.jsonl' });
  writeFileSync('quests.json', JSON.stringify([{ channel: 'h', url, jsonKey: 'price', interval: 1 }]));
  const e6 = new QuestEngine();
  await e6.tick(); // scrapes 'aaa' (a change) > writes mirror + one history line
  ok(existsSync('feed.json') && JSON.parse(readFileSync('feed.json', 'utf8')).some(q => q.channel === 'h'), '--output mirrors results to static file');
  const hist1 = readFileSync('hist.jsonl', 'utf8').trim().split('\n').filter(Boolean);
  ok(hist1.length === 1 && JSON.parse(hist1[0]).value === 'aaa', 'change appends one history line');
  payload = { price: 'bbb' };
  e6.lastRun['h'] = Date.now() - 4000;
  await e6.tick(); // value changed > second history line
  const hist2 = readFileSync('hist.jsonl', 'utf8').trim().split('\n').filter(Boolean);
  ok(hist2.length === 2 && JSON.parse(hist2[1]).value === 'bbb', 'each CHANGE appends another history line');
  e6.lastRun['h'] = Date.now() - 4000;
  await e6.tick(); // same value > no new history line (append-on-change only)
  ok(readFileSync('hist.jsonl', 'utf8').trim().split('\n').filter(Boolean).length === 2, 'unchanged value appends nothing');
  configure({ output: null, history: null });

  // pinnedGet: dns-pinned json fetcher's status/redirect/cap branches (allowLocal pins loopback fixture)
  const pgSrv = createServer((req, res) => {
    if (req.url === '/ok')    return res.end('PGBODY');
    if (req.url === '/redir') { res.statusCode = 302; res.setHeader('location', '/ok');    return res.end(); }
    if (req.url === '/spin')  { res.statusCode = 302; res.setHeader('location', '/spin');  return res.end(); } // never resolves
    if (req.url === '/big')   return res.end('x'.repeat(4000));
    if (req.url === '/404')   { res.statusCode = 404; return res.end('nope'); }
    res.statusCode = 500; res.end();
  });
  await new Promise(r => pgSrv.listen(0, '127.0.0.1', r));
  const pg = `http://127.0.0.1:${pgSrv.address().port}`;
  const pgErr = async (u, maxBytes = 1000) => { try { await pinnedGet(u, maxBytes, 2000); return null; } catch (e) { return e.message; } };
  ok(await pinnedGet(pg + '/ok', 1000, 2000) === 'PGBODY', 'pinnedGet returns 200 response body');
  ok(await pinnedGet(pg + '/redir', 1000, 2000) === 'PGBODY', 'pinnedGet follows 3xx redirect (re-validating new host)');
  ok(/HTTP 30/.test(await pgErr(pg + '/spin') || ''), 'pinnedGet gives up after 3-hop redirect budget');
  ok(/too large/.test(await pgErr(pg + '/big', 10) || ''), 'pinnedGet aborts response over byte cap');
  ok(/HTTP 404/.test(await pgErr(pg + '/404') || ''), 'pinnedGet surfaces non-2xx status as "http <code>"');
  ok(/bad url/.test(await pgErr('not a url') || ''), 'pinnedGet rejects malformed url');
  ok(/bad protocol/.test(await pgErr('ftp://example.com/') || ''), 'pinnedGet rejects non-http(s) protocol');
  pgSrv.close();

  // execute() guard branches (no browser needed - both error before any fetch)
  configure({ allowLocal: false });
  const unsafe = await new QuestEngine().execute({ channel: 'u', url: 'http://127.0.0.1:1/', jsonKey: 'x' });
  ok(unsafe && unsafe.value === null && unsafe.error === 'invalid quest URL', 'execute() rejects unsafe (private) url before fetching');
  configure({ allowLocal: true });
  const noMethod = await new QuestEngine().execute({ channel: 'n' });
  ok(noMethod && noMethod.value === null && /no selector/.test(noMethod.error || ''), 'execute() errors when no extraction method is given');

  // _applyOnChange early-returns: non-string target and never-scraped channel are no-ops
  writeFileSync('quests.json', JSON.stringify([]));
  const eoc = new QuestEngine();
  await eoc._applyOnChange({ channel: 'x', onChange: { emit: 123 } }); // non-string target
  await eoc._applyOnChange({ channel: 'never', onChange: { emit: 'tgt' } }); // no prior state
  ok(readQ().length === 0, '_applyOnChange with non-string target or no prior state adds no channel');

  // _setQuestStatus ring-buffers value log at 500 entries
  const eb = new QuestEngine();
  for (let i = 0; i < 600; i++) eb._setQuestStatus('c', 'success', { value: 'v' + i, timestamp: Date.now() });
  ok(eb._log.length === 500, `_setQuestStatus caps log ring buffer at 500 (got ${eb._log.length})`);

  // tick() early-returns on non-array quests.json (distinct from unparseable one)
  writeFileSync('quests.json', JSON.stringify({ not: 'an array' }));
  await new QuestEngine().tick();
  ok(JSON.parse(readFileSync('quests.json', 'utf8')).not === 'an array', 'tick() ignores non-array quests.json (no crash, file intact)');

  // corrupt quests.json aborts write instead of wiping every quest
  writeFileSync('quests.json', '{ this is not valid json');
  const e5 = new QuestEngine();
  await e5.tick(); // tick tolerates corrupt file (returns early) - must not overwrite with []
  ok(readFileSync('quests.json', 'utf8').includes('not valid json'), 'corrupt quests.json is not clobbered by tick');

  payload = { price: '9.99' };
  writeFileSync('quests.json', '{ this is not valid json');
  let wrote = null;
  try { wrote = await new QuestEngine().scrapeOne({ channel: 'cw', url, jsonKey: 'price' }); } catch { wrote = 'threw'; }
  ok(readFileSync('quests.json', 'utf8').includes('not valid json'), 'corrupt quests.json survives scrape that wants to persist');

  writeFileSync('quests.json', JSON.stringify({ not: 'an array' }));
  try { await new QuestEngine().scrapeOne({ channel: 'nw', url, jsonKey: 'price' }); } catch {}
  ok(JSON.parse(readFileSync('quests.json', 'utf8')).not === 'an array', 'non-array quests.json survives scrape that wants to persist');

  const many = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  writeFileSync('quests.json', JSON.stringify(many.map(c => ({ channel: c, url, jsonKey: 'price', interval: 999999 }))));
  const eC = new QuestEngine();
  await Promise.all(many.map(c => eC.scrapeOne({ channel: c, url, jsonKey: 'price' })));
  const landed = readQ().filter(q => q.result?.value === '9.99').length;
  ok(landed === many.length, `concurrent persists are serialized, none lost (${landed}/${many.length} landed)`);

  const { existsSync: exists, mkdtempSync: mkdt } = await import('fs');
  const { tmpdir: tdir } = await import('os');
  const { join: pjoin } = await import('path');
  const eP = new QuestEngine();
  const snapDir = mkdt(pjoin(tdir(), 'scavenger-snapshot-'));
  eP._profileMode = 'snapshot';
  eP._snapshotProfile = async () => snapDir;
  eP._closePool = () => {};
  eP.chrome = null; eP.ws = null;
  let launches = 0;
  eP._launchChrome = async (dir) => { launches++; if (dir === snapDir) throw new Error('launch refused'); };
  try { await eP._relaunchChrome(); } catch {}
  ok(!exists(snapDir), 'snapshot profile whose launch failed is removed, not stranded in tmp');
  ok(launches === 2, `engine still falls back to fresh temp profile (${launches} launch attempts)`);

  try { engine.destroy(); } catch {}
} catch (e) {
  fails++; console.log('  ✗ server-loop tier threw:', e.message);
}

configure({ allowLocal: false });
srv.close();
console.log(fails ? `server-loop: FAIL (${fails})` : 'server-loop: PASS');
process.exit(fails ? 1 : 0);