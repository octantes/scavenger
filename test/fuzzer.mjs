// fuzzer - the random tier over fresh seeds, for as long as you leave it: node test/fuzzer.mjs [--hours=8] [--seeds=n] [--rounds=6] [--ops=48] [--timeout=420] [--out=path]
// not a tier: all.mjs never runs this. a seed that hangs is killed, written down and stepped over, so a night's run ends with a list of reproducers instead of one stuck browser.

import { spawn } from 'child_process';
import { appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { sweep } from './_cdp.mjs';

const arg = (k, d) => { const m = process.argv.find(a => a.startsWith(`--${k}=`)); return m ? m.split('=').slice(1).join('=') : d; };
const num = (k, d) => { const v = arg(k, null); return v === null ? d : +v; };

const HOURS = num('hours', 8), SEEDS = num('seeds', Infinity);
const ROUNDS = num('rounds', 6), OPS = num('ops', 48), PER_SEED = num('timeout', 420) * 1000; // above the 120s cdp timeout, so a hung tier still prints its own trail first
const here = dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = arg('out', join(tmpdir(), `scv-fuzz-${stamp}.txt`));

const safeEnv = { ...process.env }; // same reason as all.mjs - an inherited proxy reroutes test traffic off localhost
for (const k of Object.keys(safeEnv)) if (/^(https?|all|no)_proxy$/i.test(k)) delete safeEnv[k];

const findings = [];
const write = line => { try { appendFileSync(OUT, line + '\n'); } catch {} };

let current = null, stopping = false;
const kill = child => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }; // own group - the tier's chrome goes too

const runSeed = seed => new Promise(res => {
  const started = Date.now();
  let out = '';
  let hung = false;
  const child = current = spawn(process.execPath, [join(here, 'random.mjs'), `--seed=${seed}`, `--rounds=${ROUNDS}`, `--ops=${OPS}`],
    { stdio: ['ignore', 'pipe', 'pipe'], env: safeEnv, detached: true });
  const timer = setTimeout(() => { hung = true; kill(child); }, PER_SEED); // resolve on exit even here - sweep only reaps a browser whose owner is really gone, and a just-killed pid can still answer
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('error', e => { clearTimeout(timer); res({ seed, verdict: 'SPAWN-FAILED', secs: 0, out: e.message }); });
  child.on('exit', code => { clearTimeout(timer); res({ seed, verdict: hung ? 'HUNG' : code ? 'FAIL' : 'pass', secs: Math.round((Date.now() - started) / 1000), out }); });
});

const summary = () => {
  sweep(); // last word on browsers, however this run ends
  const line = `\n${findings.length} finding(s) over ${done} seed(s) in ${Math.round((Date.now() - t0) / 60000)} min`;
  console.log(line);
  for (const f of findings) console.log(`  ${f.verdict}  --seed=${f.seed}`);
  console.log(findings.length ? `\nfull output: ${OUT}` : `\nnothing found - log: ${OUT}`);
};

for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, () => {
  stopping = true;
  if (current) kill(current);
  write(`\nstopped on ${sig}`);
  summary(); sweep(); process.exit(findings.length ? 1 : code);
});

const t0 = Date.now(), until = t0 + HOURS * 3600000;
let done = 0;
console.log(`fuzzer: ${ROUNDS} rounds x ${OPS} ops per seed, ${PER_SEED / 1000}s cap each, ${SEEDS === Infinity ? `${HOURS}h` : `${SEEDS} seeds`}`);
console.log(`fuzzer: writing to ${OUT}\n`);
write(`fuzzer started ${new Date().toISOString()} - rounds=${ROUNDS} ops=${OPS} timeout=${PER_SEED / 1000}s`);

while (!stopping && done < SEEDS && Date.now() < until) {
  const seed = Math.floor(Math.random() * 1e9);
  const r = await runSeed(seed);
  current = null; done++;
  sweep(); // a killed tier leaves its browser behind
  if (r.verdict === 'pass') { process.stdout.write(`\r${done} seeds, ${findings.length} finding(s) - last ${r.secs}s   `); continue; }
  findings.push(r);
  console.log(`\n✗ ${r.verdict} --seed=${seed} after ${r.secs}s`);
  write(`\n===== ${r.verdict} seed=${seed} rounds=${ROUNDS} ops=${OPS} after ${r.secs}s =====\n${r.out.trim()}`);
}

summary();
process.exit(findings.length ? 1 : 0);
