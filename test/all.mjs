// runs whole internal suite: node test/all.mjs - each tier a separate process, aggregated to one ci exit code

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const tiers = [
  'unit.mjs', 'tokens.mjs', 'security.mjs', 'build.mjs', 'server-loop.mjs', // fast: logic, tokens, gate, lexer, artifact, scheduling
  'tui.mjs', 'engine.mjs', 'kernel.mjs', 'tools.mjs', 'live-emit.mjs',
  'patchbay.mjs', 'studio.mjs', 'nodes.mjs', 'export.mjs', 'fractal.mjs', 'adversarial.mjs',
  'connectivity.mjs', 'compiler.mjs', 'components.mjs', 'cli.mjs', // integration + real cli
];

// strip *_proxy - _cdp proxy-less on purpose, inherited proxy would reroute test traffic off localhost
const safeEnv = { ...process.env };
for (const k of Object.keys(safeEnv)) if (/^(https?|all|no)_proxy$/i.test(k)) delete safeEnv[k];

const TIER_TIMEOUT = 600000; // generous - loaded machine can push a browser tier past a minute but nothing should take 10

let failed = 0;
for (const t of tiers) {
  const code = await new Promise(res => {
    const child = spawn(process.execPath, [join(here, t)], { stdio: 'inherit', env: safeEnv, detached: true }); // own process group - timeout kills from top, not walking chrome grandchildren by hand
    const timer = setTimeout(() => {
      console.log(`\n✗ ${t} exceeded ${TIER_TIMEOUT / 1000}s - killing it (and any chrome subprocess it spawned)`);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } // negative pid = whole group; fall back to direct child where process groups aren't supported
      res(1);
    }, TIER_TIMEOUT);
    child.on('error', err => { clearTimeout(timer); console.log(`\n✗ ${t} failed to spawn: ${err.message}`); res(1); }); // example: a bad node path - must not leave this promise unresolved
    child.on('exit', c => { clearTimeout(timer); res(c ?? 1); });
  });
  if (code !== 0) failed++;
}
console.log(failed ? `\n✗ ${failed}/${tiers.length} tier(s) failed` : `\n✓ all ${tiers.length} tiers passed`);
process.exit(failed ? 1 : 0);