// cli tier | --run quests-as-tests runner as users invoke it - assertion modes + ci exit codes

import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'scv-cli-'));

const srv = createServer((_, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ price: '42', name: 'Mo Salah' })); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;

// html page with click>reveal element - for interaction-pipeline test
const pageSrv = createServer((_, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>p</title><button id="btn" onclick="var d=document.createElement('div');d.id='result';d.textContent='REVEALED';document.body.appendChild(d)">go</button>`);
});
await new Promise(r => pageSrv.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${pageSrv.address().port}/`;

// spawn --run on raw (possibly invalid) file body and resolve { code, out }
const rawRun = (body) => new Promise(resolve => {
  const file = join(dir, 'raw-' + Math.random().toString(36).slice(2) + '.json');
  writeFileSync(file, body);
  const p = spawn(process.execPath, [join(root, 'quests.mjs'), '--run', file, '--allow-local'], { cwd: dir });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  p.on('exit', code => resolve({ code, out }));
  // generous | --run spawns chrome + navigates + scrapes - 40s could false-fail on loaded machine
  setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve({ code: -1, out }); }, 120000);
});

const run = (tests) => new Promise(resolve => {
  const file = join(dir, 'tests-' + Math.random().toString(36).slice(2) + '.json');
  writeFileSync(file, JSON.stringify(tests));
  const p = spawn(process.execPath, [join(root, 'quests.mjs'), '--run', file, '--allow-local'], { cwd: dir });
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  p.on('exit', code => resolve({ code, out }));
  // generous | --run spawns chrome + navigates + scrapes - 40s could false-fail on loaded machine
  setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve({ code: -1, out: out + '\n[timeout]' }); }, 120000);
});

try {
  // all-pass - exercises every assertion mode > exit 0
  const pass = await run([
    { name: 'exact', url, jsonKey: 'price', expect: '42' },
    { name: 'substr', url, jsonKey: 'name', contains: 'Salah' },
    { name: 'regex', url, jsonKey: 'price', matches: '^4[0-9]$' },
    { name: 'nonempty', url, jsonKey: 'name' }, // default: resolves non-empty
    { name: 'line-form', line: `${url}, key:price`, expect: '42' }, // a line string expands like the sniper's
  ]);
  ok(pass.code === 0, `--run all-pass exits 0 (got ${pass.code})\n${pass.out.split('\n').filter(l => /passed|failed|✗|Error|not found/.test(l)).join('\n')}`);
  ok(/5 passed/.test(pass.out), `--run reports 5 passed (${(pass.out.match(/\d+ passed[^\n]*/) || [''])[0]})`);

  // one wrong assertion > non-zero exit (ci gate)
  const fail = await run([
    { name: 'good', url, jsonKey: 'price', expect: '42' },
    { name: 'bad', url, jsonKey: 'price', expect: '999' },
  ]);
  ok(fail.code === 1, `--run with failing assertion exits 1 (got ${fail.code})`);
  ok(/1 passed, 1 failed/.test(fail.out), `--run reports exactly one pass and one failure (${(fail.out.match(/\d+ passed, \d+ failed/) || [''])[0]})`);

  // bad test file > usage exit code 2, no crash
  const badFile = await new Promise(resolve => {
    const p = spawn(process.execPath, [join(root, 'quests.mjs'), '--run', join(dir, 'does-not-exist.json'), '--allow-local'], { cwd: dir });
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    p.on('exit', code => resolve({ code, out }));
    // generous | --run spawns chrome + navigates + scrapes - 40s could false-fail on loaded machine
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve({ code: -1 }); }, 120000);
  });
  ok(badFile.code === 2, `--run with missing test file exits 2 (got ${badFile.code})`);

  // invalid json in test file > exit 2 (usage error) not crash
  const badJson = await rawRun('{ this is not json');
  ok(badJson.code === 2, `--run with malformed json exits 2 (got ${badJson.code})`);

  // non-array test file > exit 2
  const notArray = await rawRun('{"a":1}');
  ok(notArray.code === 2, `--run with non-array test file exits 2 (got ${notArray.code})`);

  // empty test array > exit 0 "0 passed, 0 failed"
  const empty = await run([]);
  ok(empty.code === 0 && /0 passed, 0 failed/.test(empty.out), `--run with empty array exits 0 (${(empty.out.match(/\d+ passed, \d+ failed/) || [''])[0]})`);

  // interaction steps pipeline through --run: click > wait > extract
  const steps = await run([
    { name: 'pipeline', url: pageUrl, line: `${pageUrl}, click:#btn | wait:#result | sel:#result`, expect: 'REVEALED' },
  ]);
  ok(steps.code === 0 && /1 passed/.test(steps.out), `--run drives interaction pipeline (click→wait→extract) (${(steps.out.match(/\d+ passed[^\n]*/) || [steps.out.slice(-80)])[0]})`);
} catch (e) {
  fails++; console.log('  ✗ cli tier threw:', e.message);
}

srv.close(); pageSrv.close();
console.log(fails ? `cli: FAIL (${fails})` : 'cli: PASS');
process.exit(fails ? 1 : 0);