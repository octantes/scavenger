// build tier - comment-stripping lexer + shipped bookmarklet.js - lexer hard cases, then decode + boot payload

import { launchChrome, connect, MIN_TOOL_COUNT } from './_cdp.mjs';
import { stripComments, buildBookmarklet } from './rebuild-kernel.mjs';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// lexer: removes real comments, preserves everything else
const strip = s => stripComments(s).replace(/\s+/g, ' ').trim();
ok(strip('a // line\nb') === 'a b', 'line comment removed');
ok(strip('a /* block */ b') === 'a b', 'block comment removed');
ok(stripComments('const u = "http://x.com/a//b";').includes('http://x.com/a//b'), 'url inside string is not comment');
ok(stripComments("const s = 'a /* not */ b';").includes('a /* not */ b'), 'comment markers inside string are preserved');
ok(stripComments('const t = `x ${a} // still text`;').includes('// still text'), 'slashes in template TEXT are preserved');
ok(stripComments('const re = /a\\/b\\/c/g;').includes('/a\\/b\\/c/g'), 'regex literal with escaped slashes preserved');
ok(stripComments('x = a / b; // c').replace(/\s+/g,' ').trim() === 'x = a / b;', 'division kept, trailing comment removed');
ok(stripComments('const box = `│ ├─ ${x}`;').includes('│ ├─'), 'box-drawing chars in template survive');
ok(stripComments('const css = `a{color:red} /* keep */`;').includes('/* keep */'), 'css comment inside template literal survives');

// return-then-regex (classic regex-vs-division trap)
ok(stripComments('function f(){ return /x/.test(s); } // gone').includes('/x/.test'), 'regex after return preserved');

// after control keyword takes statement, so regex there mustn't be read as division (a /* would eat file)
ok(stripComments('if (x) /[/*]/.test(s); TAIL();').includes('TAIL()'), ') after if - regex containing /* does not eat rest of file');
ok(stripComments('while (x) /re/.exec(s); // gone').includes('/re/.exec'), ') after while - regex preserved');
ok(stripComments('for (;;) /re/.test(s); // gone').includes('/re/.test'), ') after for - regex preserved');
ok(stripComments('switch (x) { default: /re/.test(s); } // gone').includes('/re/.test'), ') after switch (nested in default case) - regex preserved');

// non-control shape must still divide - ) closing call/grouping followed by expression continuation
ok(strip('a(b) / 2; // c') === 'a(b) / 2;', ') after function call - stays division, not misread as regex start');
ok(strip('if (x) (y) / 2; // c') === 'if (x) (y) / 2;', 'grouping ) inside if-body (not if\'s own condition paren) stays division too');

// } closing block is statement boundary too - same trap, needs /* inside regex to actually prove it
ok(stripComments('if (x) { } /[/*]/.test(s); TAIL();').includes('TAIL()'), '} closing if-block - regex containing /* does not eat rest of file');
ok(stripComments('while (x) { } /re/.exec(s); // gone').includes('/re/.exec'), '} closing while-block - regex preserved');
ok(stripComments('try { } catch (e) { } /re/.test(s); // gone').includes('/re/.test'), '} closing try/catch block - regex preserved');

// object-literal } must still divide, same shape as ) call-vs-header split above
ok(strip('const o = {a:1}; o.a / 2; // c') === 'const o = {a:1}; o.a / 2;', '} closing object literal - stays division, not misread as regex start');
ok(strip('foo({a:1}) / 2; // c') === 'foo({a:1}) / 2;', '} closing object literal passed as call argument - stays division too');

// stripping is idempotent-ish: output has no line comments left
ok(!/(^|[^:])\/\/[^\n]*$/m.test(stripComments('a=1; // x\nb=2; // y')), 'no line comments remain in output');

// full kernel round-trips through lexer to still-valid js
const kernelSrc = readFileSync(join(root, 'kernel.js'), 'utf8');
const strippedKernel = stripComments(kernelSrc);
ok(strippedKernel.length > 0 && strippedKernel.length < kernelSrc.length, 'stripped kernel is smaller but non-empty');
let parseOk = true; try { new Function(strippedKernel); } catch (e) { parseOk = false; console.log('  ✗ stripped kernel does not parse:', e.message); }
ok(parseOk, 'stripped kernel still parses as valid JS');

// every shipped file is plain text - stray control byte turns source binary to grep and rides into exports as U+FFFD
for (const f of ['kernel.js', 'patchbay.html', 'compiler.html', 'quests.mjs', 'bookmarklet.js']) {
  const bytes = readFileSync(join(root, f));
  const bad = [...bytes].findIndex(c => c < 9 || (c > 13 && c < 32) || c === 127);
  ok(bad === -1, `${f} carries no control bytes (found 0x${bytes[bad]?.toString(16)} at offset ${bad})`);
}

// bookmarklet.js - generated from kernel.js, self-healed if drifted, then decode + boot
const bmPath = join(root, 'bookmarklet.js');
const fresh = buildBookmarklet(kernelSrc);
const wasStale = readFileSync(bmPath, 'utf8') !== fresh;
if (wasStale) {
  writeFileSync(bmPath, fresh);
  console.log('  ⟳ bookmarklet.js was stale - rebuilt from kernel.js (commit refreshed artifact)');
}
const bm = readFileSync(bmPath, 'utf8').trim();
ok(bm.startsWith('javascript:'), 'bookmarklet.js is javascript: URL');
const decoded = decodeURIComponent(bm.slice('javascript:'.length));
let decodeParses = true; try { new Function(decoded); } catch (e) { decodeParses = false; console.log('  ✗ decoded bookmarklet does not parse:', e.message); }
ok(decodeParses, 'decoded bookmarklet parses as valid JS');
// wasStale is the real signal - self-heal writes fix, but run that had to heal is flagged so ci catches forgotten git add
ok(!wasStale, 'bookmarklet.js was already in sync with kernel.js (no self-heal needed this run)');

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable');
await send('Page.navigate', { url: 'data:text/html,<!doctype html><title>t</title><div id=x>hi</div>' });
await waitEvent('Page.loadEventFired');
const js = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.result?.value;
try {
  // execute decoded payload exactly as browser would when bookmarklet is clicked
  await send('Runtime.evaluate', { expression: decoded });
  ok(await js(`!!window.$kernel`), 'shipped bookmarklet boots kernel');
  ok(await js(`!!document.querySelector('.scv-palette')`), 'shipped bookmarklet renders command palette');
  ok(await js(`Object.keys(window.$kernel.processes).length >= ${MIN_TOOL_COUNT}`), 'all tools registered from shipped payload');
  // tool works end to end from shipped payload
  ok(await js(`(() => { window.$kernel.start('grid-h'); const on = !!document.getElementById('scv-grid-h'); window.$kernel.stop('grid-h'); return on; })()`), 'tool runs from shipped payload');
  // and tears down cleanly (re-press)
  await js(`window.$kernel.destroy(); true`);
  ok(await js(`typeof window.$kernel === 'undefined' && document.querySelectorAll('[id^="scv-"]').length === 0`), 'shipped bookmarklet destroys cleanly');
} catch (e) {
  fails++; console.log('  ✗ build tier threw:', e.message);
}

try { ws.close(); } catch {} cleanup();
console.log(fails ? `build: FAIL (${fails})` : 'build: PASS');
process.exit(fails ? 1 : 0);