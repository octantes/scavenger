// runs whole internal suite: node test/all.mjs - each tier a separate process, aggregated to one ci exit code

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { orphans, sweep } from './_cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tiers = [
  'unit.mjs', 'tokens.mjs', 'security.mjs', 'build.mjs', 'server-loop.mjs', 'harness.mjs', // fast: logic, tokens, gate, lexer, artifact, scheduling, browser cleanup
  'tui.mjs', 'engine.mjs', 'kernel.mjs', 'tools.mjs', 'live-emit.mjs',
  'patchbay.mjs', 'studio.mjs', 'fractal.mjs', 'adversarial.mjs',
  'connectivity.mjs', 'examples.mjs', 'behaviour.mjs', 'random.mjs', 'surface.mjs', 'cli.mjs', // integration + real cli
];

// strip *_proxy - _cdp proxy-less on purpose, inherited proxy would reroute test traffic off localhost
const safeEnv = { ...process.env };
for (const k of Object.keys(safeEnv)) if (/^(https?|all|no)_proxy$/i.test(k)) delete safeEnv[k];

const TIER_TIMEOUT = 600000; // generous - loaded machine can push a browser tier past a minute but nothing should take 10

let failed = 0, current = null;
const stop = (child, then) => { // term lets tier reap its browser, kill after grace
  const group = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } }; // negative pid = whole group; fall back to direct child where process groups aren't supported
  group('SIGTERM');
  setTimeout(() => { group('SIGKILL'); then?.(); }, 3000).unref();
};
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, () => { if (current) stop(current, () => { sweep(); process.exit(code); }); else process.exit(code); });
for (const t of tiers) {
  const code = await new Promise(res => {
    const child = current = spawn(process.execPath, [join(here, t)], { stdio: 'inherit', env: safeEnv, detached: true }); // own process group - timeout reaches its whole tree
    const timer = setTimeout(() => {
      console.log(`\n✗ ${t} exceeded ${TIER_TIMEOUT / 1000}s - killing it (and any chrome subprocess it spawned)`);
      stop(child);
      res(1);
    }, TIER_TIMEOUT);
    child.on('error', err => { clearTimeout(timer); console.log(`\n✗ ${t} failed to spawn: ${err.message}`); res(1); }); // example: a bad node path - must not leave this promise unresolved
    child.on('exit', c => { clearTimeout(timer); res(c ?? 1); });
  });
  current = null;
  if (code !== 0) failed++;
}
let leaked = orphans().length; // every tier gone - any test browser still up leaked
if (leaked) { await new Promise(r => setTimeout(r, 1500)); leaked = orphans().length; } // just killed may still be listed
if (leaked) { failed++; console.log(`\n✗ ${leaked} test browser process(es) outlived their tier - swept`); sweep(); }
console.log(failed ? `\n✗ ${failed}/${tiers.length} tier(s) failed` : `\n✓ all ${tiers.length} tiers passed`);
process.exit(failed ? 1 : 0);