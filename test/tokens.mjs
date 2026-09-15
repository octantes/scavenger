// tokens tier - design-system guarantee: tokens identical across patchbay (source), compiler, kernel, tui

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const kernel = readFileSync(join(root, 'kernel.js'), 'utf8');
const dash = readFileSync(join(root, 'patchbay.html'), 'utf8');
const tui = readFileSync(join(root, 'quests.mjs'), 'utf8');
const nc = readFileSync(join(root, 'compiler.html'), 'utf8');

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };

// extract --name: value; custom-property defs from stylesheet
const defsOf = s => { const m = {}; const re = /--([\w-]+)\s*:\s*([^;{}]+);/g; let x; while ((x = re.exec(s))) m['--' + x[1]] = x[2].trim(); return m; };
const dashDefs = defsOf(dash), ncDefs = defsOf(nc);

// shared design system: patchbay is source of truth; compiler is copy
const SYSTEM = [
  '--output', '--input', '--danger', '--success',
  '--background-sunk', '--background-raised',
  '--text-base', '--text-dim', '--text-faint', '--border',
  '--corner-low', '--corner-high',
  '--ease-out', '--ease-swift', '--duration-fast', '--duration-base', '--duration-slow',
  '--font-mono', '--fs-a', '--fs-b', '--fs-c', '--fs-d',
];
for (const t of SYSTEM) {
  ok(dashDefs[t] !== undefined, `patchbay :root defines ${t}`);
  ok(ncDefs[t] === dashDefs[t], `compiler ${t} matches patchbay (${ncDefs[t]} vs ${dashDefs[t]})`);
}

// system is hand-maintained - also check every shared patchbay/compiler token, so forgotten one can't drift
for (const t of Object.keys(ncDefs)) {
  if (dashDefs[t] === undefined) continue;
  ok(ncDefs[t] === dashDefs[t], `compiler ${t} matches patchbay - full :root intersection, not just named system list (${ncDefs[t]} vs ${dashDefs[t]})`);
}

// kernel uses js theme object - must carry same names + brand values
for (const [key, hex] of [['backgroundSunk', '#1a1c1c'], ['output', '#986c98'], ['input', '#8ab6bb'], ['textBase', '#aaabac'], ['danger', '#985954']])
  ok(new RegExp(`${key}\\s*:\\s*'#${hex.slice(1)}'`, 'i').test(kernel), `kernel theme.${key} = ${hex}`);

// tui stores brand hues as T.fg(0xRR,0xGG,0xBB) triples
const hasTriple = (s, hex) => new RegExp(`0x${hex.slice(0, 2)}\\s*,\\s*0x${hex.slice(2, 4)}\\s*,\\s*0x${hex.slice(4, 6)}`, 'i').test(s);
for (const [name, hex] of [['output', '986c98'], ['input', '8ab6bb'], ['danger', '985954'], ['success', '6fac67']])
  ok(hasTriple(tui, hex), `tui PAL carries ${name} 0x${hex.slice(0, 2)},0x${hex.slice(2, 4)},0x${hex.slice(4, 6)}`);

// no old token names survive rename - nothing aliases
for (const [name, s] of [['patchbay', dash], ['compiler', nc]])
  for (const old of ['--signal', '--attention', '--surface', '--ink', '--ink-dim', '--ink-faint',
                     '--edge', '--r-sm', '--r-md', '--r-lg', '--dur-fast', '--dur-base', '--dur-slow',
                     '--ease-spring', '--fs-xs', '--fs-sm', '--fs-2', '--fs-base', '--fs-md', '--fs-lg',
                     '--fs-xl', '--tracking-wide', '--grid-dot', '--on-danger', '--accent', '--secondary', '--panel-bg'])
    ok(!new RegExp(`${old}\\b`).test(s), `${name}: no old token name ${old}`);
for (const old of ['theme.surface', 'theme.signal', 'theme.attention', 'theme.ink', 'theme.edge'])
  ok(!kernel.includes(old), `kernel: no old theme key ${old}`);

// no pre-unification drift hues survive on any surface
const hasHex = (s, hex) => new RegExp(`(?<![0-9a-fx])${hex}(?![0-9a-f])`, 'i').test(s);
for (const [name, s] of [['kernel', kernel], ['patchbay', dash], ['tui', tui], ['compiler', nc]]) {
  ok(!hasHex(s, '1b1c1c'), `${name}: no old bg #1B1C1C`);
  ok(!hasHex(s, 'ff5050'), `${name}: no old danger #FF5050`);
  ok(!/#c44\b/.test(s), `${name}: no old danger #c44 shorthand`);
  ok(!hasHex(s, '6a9955'), `${name}: no old success #6a9955`);
}
ok(!hasTriple(tui, 'cc4444'), 'tui: no old danger 0xcc,0x44,0x44');
ok(!hasTriple(tui, '6a9955'), 'tui: no old success 0x6a,0x99,0x55');

console.log(fails ? `tokens: FAIL (${fails})` : 'tokens: PASS');
process.exit(fails ? 1 : 0);