// harness tier - test browsers never outlive their tier, however it ends

import { spawn, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { orphans } from './_cdp.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const cdp = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '_cdp.mjs')).href;
const delay = ms => new Promise(r => setTimeout(r, ms));
const running = dir => execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' }).split('\n').filter(l => l.includes('--user-data-dir=' + dir)).length;
const ENDS = { // how child tier ends after its browser is up
  done: 'cleanup();',
  throw: "setTimeout(() => { throw new Error('mid-run'); });",
  reject: "Promise.reject(new Error('mid-run'));",
  wait: 'setInterval(() => {}, 1000);', // parent signals it
};
const tier = (end, signal) => new Promise(res => { // > { dir, code } once child is gone
  const p = spawn(process.execPath, ['--input-type=module', '-e', `import { launchChrome } from ${JSON.stringify(cdp)};\nconst { cleanup, userDir } = await launchChrome();\nconsole.log(userDir);\n${ENDS[end]}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  let dir = '';
  p.stdout.on('data', d => { if (!dir) { dir = String(d).trim(); if (signal) p.kill(signal); } });
  p.on('exit', code => res({ dir, code }));
});
const settle = async dir => { for (let i = 0; i < 40 && (running(dir) || existsSync(dir)); i++) await delay(100); }; // killed group takes a moment to leave ps

try {
  for (const [end, signal] of [['done'], ['throw'], ['reject'], ['wait', 'SIGTERM'], ['wait', 'SIGINT']]) {
    const { dir, code } = await tier(end, signal);
    await settle(dir);
    const name = signal || end;
    ok(dir && running(dir) === 0, `${name}: no browser left (${dir && running(dir)} processes)`);
    ok(dir && !existsSync(dir), `${name}: profile removed (${dir})`);
    ok(end === 'done' ? code === 0 : code !== 0, `${name}: tier exits ${end === 'done' ? 'clean' : 'failed'} (${code})`);
  }

  // killed outright, no handler runs - orphan stays until next launch sweeps it
  const { dir } = await tier('wait', 'SIGKILL');
  await delay(300);
  ok(running(dir) > 0 && orphans().some(o => o.dir === dir), `SIGKILL: browser outlives tier, seen as orphan (${running(dir)} processes)`);
  const next = await tier('done');
  await settle(dir); await settle(next.dir);
  ok(running(dir) === 0 && !existsSync(dir), `next launch sweeps orphan and its profile (${running(dir)} processes, dir ${existsSync(dir)})`);
} catch (e) {
  fails++; console.log('  ✗ harness tier threw:', e.message);
}

console.log(fails ? `harness: FAIL (${fails})` : 'harness: PASS');
process.exit(fails ? 1 : 0);
