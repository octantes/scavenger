// security tier - checks project guarantees: ssrf guards, loopback-only write-gate + scv-token, api under attack

import { chdir } from 'process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import {
  QuestEngine, isPrivateAddr, isValidQuestUrl, questUrlIsSafe, resolvePublicIP,
  isOwnerWrite, isLocalOrigin, pinnedGet, SCV_TOKEN, API_PORT, configure,
} from '../quests.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
chdir(mkdtempSync(join(tmpdir(), 'scv-sec-'))); // isolate quests.json writes

// ssrf: private / internal targets are rejected
for (const h of ['127.0.0.1', '127.5.5.5', 'localhost', '::1', '0.0.0.0', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.1', '169.254.1.1', '::ffff:127.0.0.1', 'fc00::1', 'fd12::9'])
  ok(isPrivateAddr(h) === true, `isPrivateAddr flags ${h}`);
for (const h of ['8.8.8.8', '1.1.1.1', '203.0.113.9', 'example.com', '172.32.0.1', '172.15.0.1'])
  ok(isPrivateAddr(h) === false, `isPrivateAddr allows public ${h}`);
for (const [h, why] of [['2130706433', 'bare decimal'], ['0x7f000001', 'bare hex'], ['0177.0.0.1', 'octal first octet'],
                        ['127.0.0.1', 'plain'], ['0xa000001', 'hex 10.0.0.1'], ['3232235777', 'decimal 192.168.1.1']])
  ok(isPrivateAddr(h) === true, `isPrivateAddr canonicalizes ${why} (${h}) back to private address`);
for (const [h, why] of [['134744072', 'decimal 8.8.8.8'], ['0x8080808', 'hex 8.8.8.8']])
  ok(isPrivateAddr(h) === false, `isPrivateAddr still allows encoded public address (${why}, ${h})`);
ok(isValidQuestUrl('http://2130706433/') === false, 'isValidQuestUrl rejects decimal-encoded loopback');
ok(isValidQuestUrl('http://0x7f000001/') === false, 'isValidQuestUrl rejects hex-encoded loopback');

ok(isValidQuestUrl('https://example.com/x') === true, 'isValidQuestUrl accepts public https url');
ok(isValidQuestUrl('https://example.com:8443/x') === true, 'isValidQuestUrl accepts public url with explicit port');
ok(isValidQuestUrl('http://127.0.0.1/x') === false, 'isValidQuestUrl rejects loopback');
ok(isValidQuestUrl('file:///etc/passwd') === false, 'isValidQuestUrl rejects non-http(s) scheme');
ok(isValidQuestUrl('ftp://example.com') === false, 'isValidQuestUrl rejects ftp');
ok(isValidQuestUrl(null) === false, 'isValidQuestUrl rejects null (malformed url > false)');
ok(isValidQuestUrl('not a url') === false, 'isValidQuestUrl rejects malformed string (isPrivateIP catch path)');
ok(await questUrlIsSafe('http://192.168.0.1/') === false, 'questUrlIsSafe rejects literal private ip');
ok(await questUrlIsSafe('http://localhost:9876/') === false, 'questUrlIsSafe rejects localhost');

// resolvePublicIP is anti-rebinding pin: throws for anything private
let threw = false; try { await resolvePublicIP('127.0.0.1'); } catch { threw = true; }
ok(threw, 'resolvePublicIP throws on private literal (the pin fails closed)');
threw = false; try { await resolvePublicIP(''); } catch { threw = true; }
ok(threw, 'resolvePublicIP throws on empty hostname (no host)');
const pin = await resolvePublicIP('8.8.8.8'); // literal public ipv4 validated in place, no dns
ok(pin && pin.address === '8.8.8.8' && pin.family === 4, `resolvePublicIP pins literal public IPv4 (${JSON.stringify(pin)})`);
threw = false; try { await pinnedGet('http://127.0.0.1:1/', 1000, 500); } catch { threw = true; }
ok(threw, 'pinnedGet refuses loopback url (ssrf pin)');
threw = false; try { await pinnedGet('file:///etc/passwd', 1000, 500); } catch { threw = true; }
ok(threw, 'pinnedGet refuses non-http scheme');

configure({ allowLocal: true });
const hops = createServer((q, r) => {
  if (q.url === '/a') { r.writeHead(302, { location: '/b' }); return r.end(); }
  if (q.url === '/b') { r.writeHead(302, { location: '/c' }); return r.end(); }
  if (q.url === '/c') { r.writeHead(200); return r.end('ARRIVED'); }
  if (q.url === '/loop') { r.writeHead(302, { location: '/loop' }); return r.end(); }
  if (q.url === '/big') { r.writeHead(200); return r.end('x'.repeat(5000)); }
  r.writeHead(404); r.end();
});
await new Promise(r => hops.listen(0, '127.0.0.1', r));
const hb = `http://127.0.0.1:${hops.address().port}`;
ok(await pinnedGet(hb + '/a', 100000, 4000) === 'ARRIVED', 'pinnedGet follows redirect chain to body');
threw = false; try { await pinnedGet(hb + '/loop', 100000, 4000); } catch { threw = true; }
ok(threw, 'pinnedGet gives up on endless redirect instead of looping');
threw = false; try { await pinnedGet(hb + '/big', 100, 4000); } catch { threw = true; }
ok(threw, 'pinnedGet aborts body past maxBytes');
hops.close();
configure({ allowLocal: false });

// write-gate unit: only direct loopback connection with no proxy hop
const req = (ra, headers = {}) => ({ socket: { remoteAddress: ra }, headers });
ok(isOwnerWrite(req('127.0.0.1')) === true, 'owner write: direct ipv4 loopback');
ok(isOwnerWrite(req('::1')) === true, 'owner write: direct ipv6 loopback');
ok(isOwnerWrite(req('::ffff:127.0.0.1')) === true, 'owner write: ipv4-mapped ipv6 loopback');
ok(isOwnerWrite(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })) === false, 'reject: loopback but proxied (X-Forwarded-For)');
ok(isOwnerWrite(req('127.0.0.1', { 'forwarded': 'for=1.2.3.4' })) === false, 'reject: loopback but proxied (Forwarded)');
ok(isOwnerWrite(req('203.0.113.9')) === false, 'reject: non-loopback remote address');
ok(isLocalOrigin('http://localhost:9876', 9876) === true, 'isLocalOrigin: localhost');
ok(isLocalOrigin('https://evil.example', 9876) === false, 'isLocalOrigin: public origin is not local');
ok(isLocalOrigin(null, 9876) === true, 'isLocalOrigin: absent Origin (null) is treated as local (same-origin/non-browser)');
ok(isLocalOrigin('http://127.0.0.1:9876', 9876) === true, 'isLocalOrigin: exact bound origin fast-path');
ok(isLocalOrigin('http://[::1]:9876', 9876) === true, 'isLocalOrigin: bracketed ipv6 loopback in url, matching port');
ok(isLocalOrigin('http://[::1]:5000', 9876) === false, 'isLocalOrigin: local hostname but wrong port is not api server itself');
ok(isLocalOrigin('http://localhost:5000', 9876) === false, 'isLocalOrigin: same port-mismatch check applies to localhost form');
ok(isLocalOrigin('::not a url', 9876) === false, 'isLocalOrigin: malformed origin > false (catch)');

// --trust-ip write path: configured non-loopback ip is trusted (but still not if proxied)
configure({ trustIps: ['9.9.9.9'] });
ok(isOwnerWrite(req('9.9.9.9')) === true, 'trusted-ip write path: --trust-ip address is allowed');
ok(isOwnerWrite(req('9.9.9.9', { 'x-forwarded-for': '1.2.3.4' })) === false, 'trusted ip still rejected when proxied');
ok(isOwnerWrite(req('8.8.8.8')) === false, 'untrusted non-loopback ip rejected');
configure({ trustIps: [] }); // restore

// real http api end-to-end (gate as server actually applies it)
const engine = new QuestEngine();
let apiUp = false;
try { await engine.startAPI(); apiUp = true; }
catch (e) { fails++; console.log(`  ✗ startAPI() failed - ~20 live write-gate/CORS/cap assertions below were skipped: ${e.message}`); }

if (apiUp) try {
  const base = `http://127.0.0.1:${API_PORT}`;
  const call = (method, path, { headers = {}, body } = {}) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body });

  // reads are open
  ok((await call('GET', '/quests')).status === 200, 'GET /quests is open (read-public)');
  ok((await call('GET', '/version')).status === 200, 'GET /version is open');

  // get /component: serves harvested component file, rejects traversal + missing
  mkdirSync('component', { recursive: true });
  writeFileSync('component/route_test.html', '<b>hi component</b>');
  const cGet = await call('GET', '/component/route_test.html');
  ok(cGet.status === 200 && (await cGet.text()).includes('hi component'), 'GET /component/<name> serves component file');
  ok((await call('GET', '/component/nope.html')).status === 404, 'GET /component of missing file → 404');
  ok((await call('GET', '/component/..%2f..%2fquests.json')).status === 400, 'GET /component rejects path traversal → 400');

  // get /asset: proxies component's remote asset (fetch ssrf-safe, serve from loopback) - rejects non-url, serves reachable one
  ok((await call('GET', '/asset?url=not-a-url')).status === 400, 'GET /asset rejects bad url → 400');
  let assetSeen = {};
  const assetSrv = createServer((q, r) => { assetSeen = q.headers; r.setHeader('content-type', 'image/gif'); r.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')); });
  await new Promise(r => assetSrv.listen(0, '127.0.0.1', r));
  const assetUrl = `http://127.0.0.1:${assetSrv.address().port}/x.gif`;
  configure({ allowLocal: true }); // loopback fixture, relax ssrf like real public asset would pass
  const aGet = await call('GET', '/asset?url=' + encodeURIComponent(assetUrl));
  configure({ allowLocal: false });
  assetSrv.close();
  ok(aGet.status === 200 && (aGet.headers.get('content-type') || '').includes('image/gif'), `GET /asset proxies asset with its content-type (${aGet.status})`);
  ok(/Mozilla/.test(assetSeen['user-agent'] || '') && !!assetSeen['referer'], `proxy fetch carries browser ua + referer, so hotlink/bot filters serve fonts and thumbnails (ua ${(assetSeen['user-agent'] || '').slice(0, 20)}..., ref ${assetSeen['referer']})`);

  // get /unfurl (link-card metadata): open, public-http(s) only, graceful-empty on fetch failure
  ok((await call('GET', '/unfurl?url=' + encodeURIComponent('not a url'))).status === 400, 'unfurl with malformed url → 400');
  ok((await call('GET', '/unfurl?url=' + encodeURIComponent('http://127.0.0.1/' ))).status === 400, 'unfurl with loopback url → 400 (ssrf guard)');
  ok((await call('GET', '/unfurl')).status === 400, 'unfurl with no url → 400');
  ok((await call('GET', '/unfurl-junk')).status === 404, '/unfurl prefix that is not route → 404 (no fuzzy match)');
  const unf = await call('GET', '/unfurl?url=' + encodeURIComponent('https://unreachable.invalid/'));
  ok(unf.status === 200 && JSON.stringify(await unf.json()) === '{}', 'unfurl on unreachable public host → 200 {} (never leaks fetch error)');

  // direct loopback write is accepted (owner)
  const reg = await call('POST', '/quests', { body: JSON.stringify({ channel: 'sec_a', url: 'https://example.com/', target: 'sel:.p' }) });
  ok(reg.status === 200, `owner (loopback) register accepted (${reg.status})`);

  // proxied write is rejected even though socket is loopback
  const proxied = await call('POST', '/quests', { headers: { 'x-forwarded-for': '9.9.9.9' }, body: JSON.stringify({ channel: 'sec_b', url: 'https://example.com/' }) });
  ok(proxied.status === 403, `proxied write rejected 403 (${proxied.status})`);

  // cross-origin write with no token is rejected; with valid token it passes
  const noTok = await call('POST', '/quests/emit', { headers: { origin: 'https://evil.example' }, body: JSON.stringify({ channel: 'sec_c', value: 1 }) });
  ok(noTok.status === 403, `cross-origin write without token rejected 403 (${noTok.status})`);
  const withTok = await call('POST', '/quests/emit', { headers: { origin: 'https://evil.example', 'scv-token': SCV_TOKEN }, body: JSON.stringify({ channel: 'sec_c', value: 1 }) });
  ok(withTok.status === 200, `cross-origin write with scv-token accepted (${withTok.status})`);

  // adversarial: malformed json > 400, not crash
  const badJson = await call('POST', '/quests', { body: '{not json' });
  ok(badJson.status === 400, `malformed json body → 400 (${badJson.status})`);

  // adversarial: channel is required
  const noChan = await call('POST', '/quests', { body: JSON.stringify({ url: 'https://example.com/' }) });
  ok(noChan.status === 400, `missing channel → 400 (${noChan.status})`);

  // adversarial: oversized body is refused (413), never buffered whole
  const huge = 'x'.repeat(11 * 1024 * 1024);
  const big = await call('POST', '/quests', { body: JSON.stringify({ channel: 'big', pad: huge }) });
  ok(big.status === 413, `oversized body → 413 (${big.status})`);

  // adversarial: private scrape url is refused at registration
  const priv = await call('POST', '/quests', { body: JSON.stringify({ channel: 'sec_priv', url: 'http://169.254.169.254/latest/meta-data/' }) });
  ok(priv.status === 400, `private/link-local scrape url rejected at register → 400 (${priv.status})`);

  // ipv6 twins of 0.0.0.0 and 169.254 - :: reaches dual-stack local listeners
  for (const [host, why] of [['[::]', 'ipv6 unspecified'], ['[fe80::1]', 'ipv6 link-local'], ['[::1]', 'ipv6 loopback']]) {
    const r = await call('POST', '/quests', { body: JSON.stringify({ channel: 'sec_v6_' + host.replace(/\W/g, ''), url: `http://${host}/` }) });
    ok(r.status === 400, `${why} ${host} rejected at register → 400 (${r.status})`);
  }

  // cors preflight: options > 204
  const opt = await call('OPTIONS', '/quests', { headers: { origin: 'https://x.example', 'access-control-request-method': 'POST' } });
  ok(opt.status === 204, `OPTIONS preflight → 204 (${opt.status})`);

  // re-registration clears stale extraction fields: register key:, then re-register with sel:
  await call('POST', '/quests', { body: JSON.stringify({ channel: 're_reg', url: 'https://example.com/', jsonKey: 'price', onChange: { emit: 're_reg_alert' } }) });
  await call('POST', '/quests', { body: JSON.stringify({ channel: 're_reg', url: 'https://example.com/', target: 'sel:.p' }) });
  const reReg = (await (await call('GET', '/quests')).json()).find(q => q.channel === 're_reg');
  ok(reReg && reReg.selector === '.p' && reReg.jsonKey === undefined, `re-register clears stale jsonKey (${JSON.stringify(reReg)})`);
  ok(reReg && reReg.onChange === undefined, `re-register without onChange clears stale alert wiring, not just extraction fields (${JSON.stringify(reReg)})`);

  // string "Infinity" interval must not persist - would wedge due-filter forever
  await call('POST', '/quests', { body: JSON.stringify({ channel: 'inf_iv', url: 'https://example.com/', interval: 'Infinity' }) });
  const infQ = (await (await call('GET', '/quests')).json()).find(q => q.channel === 'inf_iv');
  ok(infQ && Number.isFinite(infQ.interval) && infQ.interval >= 3000, `non-finite interval falls back to sane value (${infQ?.interval})`);

  // structured target object is used as-is - never stringified into "[object Object]"
  await call('POST', '/quests', { body: JSON.stringify({ channel: 'obj_tgt', url: 'https://example.com/', target: { selector: '.price' } }) });
  const objQ = (await (await call('GET', '/quests')).json()).find(q => q.channel === 'obj_tgt');
  ok(objQ && objQ.selector === '.price' && !String(objQ.selector).includes('object Object'), 'structured target object is stored as-is, not "[object Object]"');

  // delete: registered channel is removed; nonexistent one is 404, distinct from pinned no-op
  await call('POST', '/quests', { body: JSON.stringify({ channel: 'del_me', url: 'https://example.com/' }) });
  const delOk = await call('DELETE', '/quests/del_me');
  ok(delOk.status === 200 && (await delOk.json()).ok === true, 'DELETE removes registered channel');
  const delMissing = await call('DELETE', '/quests/nope_nope');
  ok(delMissing.status === 404, `DELETE of nonexistent channel → 404 (${delMissing.status})`);

  // delete with malformed %-escape decodes inside try > 400, never hangs socket
  const delBad = await call('DELETE', '/quests/%E0%A4%A');
  ok(delBad.status === 400, `DELETE with malformed URI → 400 (${delBad.status})`);

  // delete no-ops on pinned channel - pinned isn't http-settable, so set it by direct disk write (updateQuests reads fresh each call)
  await call('POST', '/quests', { body: JSON.stringify({ channel: 'pinned_ch', url: 'https://example.com/' }) });
  const disk = JSON.parse(readFileSync('quests.json', 'utf8'));
  disk.find(q => q.channel === 'pinned_ch').pinned = true;
  writeFileSync('quests.json', JSON.stringify(disk));
  const delPinned = await call('DELETE', '/quests/pinned_ch');
  const stillThere = (await (await call('GET', '/quests')).json()).some(q => q.channel === 'pinned_ch');
  ok((await delPinned.json()).ok === false && stillThere, 'DELETE is no-op for pinned channel (it survives)');

  // pinnedGet timeout: server that never responds is aborted, not left hanging
  configure({ allowLocal: true });
  const hang = createServer(() => { /* never responds */ });
  await new Promise(r => hang.listen(0, '127.0.0.1', r));
  let timedOut = false;
  try { await pinnedGet(`http://127.0.0.1:${hang.address().port}/`, 1000, 200); } catch (e) { timedOut = /timeout/i.test(e.message); }
  ok(timedOut, 'pinnedGet aborts non-responding host on timeout');
  hang.close(); configure({ allowLocal: false });

  // byte cap: truncating caller keeps prefix, everyone else fails - link-card metadata lives in first few kb
  configure({ allowLocal: true });
  const capSrv = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>head</title>' + 'x'.repeat(400000)); });
  await new Promise(r => capSrv.listen(0, '127.0.0.1', r));
  const bigUrl = `http://127.0.0.1:${capSrv.address().port}/`;
  let capThrew = false;
  try { await pinnedGet(bigUrl, 4096, 4000); } catch (e) { capThrew = /too large/i.test(e.message); }
  ok(capThrew, 'pinnedGet still fails caller that did not ask to truncate');
  let prefix = null;
  try { prefix = await pinnedGet(bigUrl, 4096, 4000, 3, true); } catch {}
  ok(typeof prefix === 'string' && prefix.startsWith('<title>head</title>') && prefix.length < 400000,
    `pinnedGet truncate keeps prefix instead of discarding it (got ${prefix === null ? 'throw' : prefix.length + ' bytes'})`);
  capSrv.close(); configure({ allowLocal: false });

  // adversarial: 100-quest cap holds (register up to limit, then refuse)
  for (let i = 0; i < 110; i++) await call('POST', '/quests', { body: JSON.stringify({ channel: 'cap_' + i, url: 'https://example.com/' }) });
  const list = await (await call('GET', '/quests')).json();
  ok(Array.isArray(list) && list.length <= 100, `quest count capped at 100 (got ${list.length})`);

} catch (e) {
  fails++;
  console.log(`  ✗ live-server block threw: ${e.message}`); // rejected fetch must not crash tier without closing server
} finally {
  if (engine.server) await new Promise(r => engine.server.close(r));
}

try { engine.destroy(); } catch {}
console.log(fails ? `security: FAIL (${fails})` : 'security: PASS');
process.exit(fails ? 1 : 0);