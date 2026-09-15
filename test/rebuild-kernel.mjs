// dev build (zero-dep pure node): strip comments from kernel.js + uri-encode into bookmarklet - build tier auto-runs it

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

function stripComments(src) { // scanner tracks strings/templates/regex so only real comments go - drawing chars, https://, css /* */ survive
  const n = src.length;
  let out = '', i = 0, lastSig = '', closedControlParen = false, closedBlockBrace = false;
  const stack = []; // context: 'tmpl' (template text) | 'interp' (code in ${ }, brace depth so matching } pops back)
  const top = () => stack[stack.length - 1];
  const parenIsControl = []; // ( after if/while/for/switch/catch/with is header - its ) is followed by statement, so following / is regex
  const braceIsBlock = []; // { is block (not object literal) after control ), or else/try/do/finally, or statement boundary - common case only

  // / starts regex (not division) when previous significant token can't be value - after operator/opener/nothing
  const regexCtx = () => lastSig === '' || '([{,;:=!&|?+-*%^~<>'.includes(lastSig)
    || (lastSig === ')' && closedControlParen)
    || (lastSig === '}' && closedBlockBrace)
    || /\b(return|typeof|throw|await|yield|case|instanceof|in|of|void|delete|do|else|new)\s*$/.test(out.slice(-16));

  while (i < n) {
    const c = src[i], c2 = src[i + 1];

    // inside template's literal text
    if (top() && top().t === 'tmpl') {
      if (c === '\\') { out += c + (c2 ?? ''); i += 2; continue; }
      if (c === '`') { out += c; i++; stack.pop(); lastSig = '`'; continue; }
      if (c === '$' && c2 === '{') { out += '${'; i += 2; stack.push({ t: 'interp', depth: 0 }); lastSig = '{'; continue; }
      out += c; i++; continue;
    }

    // code (top level or inside interpolation)
    if (c === '/' && c2 === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; out += ' '; continue; }

    if (c === '"' || c === "'") {
      const q = c; out += c; i++;
      while (i < n) { if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; } out += src[i]; if (src[i] === q) { i++; break; } i++; }
      lastSig = q; continue;
    }

    if (c === '`') { out += c; i++; stack.push({ t: 'tmpl' }); continue; }

    if (c === '/' && regexCtx()) {
      out += c; i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { out += d + (src[i + 1] ?? ''); i += 2; continue; }
        if (d === '[') inClass = true; else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { out += d; i++; break; }
        else if (d === '\n') break;
        out += d; i++;
      }
      while (i < n && /[a-z]/i.test(src[i])) { out += src[i]; i++; }
      lastSig = '/'; continue;
    }

    if (top() && top().t === 'interp') {
      if (c === '{') { top().depth++; out += c; i++; lastSig = '{'; continue; }
      if (c === '}') { if (top().depth === 0) { stack.pop(); } else top().depth--; out += c; i++; lastSig = '}'; continue; }
    }

    if (c === '(') { parenIsControl.push(/\b(if|while|for|switch|catch|with)\s*$/.test(out)); out += c; i++; lastSig = '('; continue; }
    if (c === ')') { closedControlParen = parenIsControl.length ? parenIsControl.pop() : false; out += c; i++; lastSig = ')'; continue; }
    if (c === '{') {
      braceIsBlock.push((lastSig === ')' && closedControlParen) || lastSig === ';' || lastSig === '{' || lastSig === '}' || lastSig === ''
        || /\b(else|try|do|finally)\s*$/.test(out));
      out += c; i++; lastSig = '{'; continue;
    }
    if (c === '}') { closedBlockBrace = braceIsBlock.length ? braceIsBlock.pop() : false; out += c; i++; lastSig = '}'; continue; }

    out += c; i++;
    if (!/\s/.test(c)) lastSig = c;
  }
  return out;
}

function buildBookmarklet(kernelSrc) { // pure fn: kernel source in, encoded bookmarklet out - build tier calls it to verify/rewrite sync
  const stripped = stripComments(kernelSrc).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return 'javascript:' + encodeURIComponent(stripped).replace(/'/g, '%27') + '\n';
}

export { stripComments, buildBookmarklet };

// isMain guard - test imports fns without triggering build/write; resolve against repo root so it runs anywhere
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = join(ROOT, 'kernel.js'), OUT = join(ROOT, 'bookmarklet.js');
  const code = readFileSync(SRC, 'utf8');
  const bookmarklet = buildBookmarklet(code);
  writeFileSync(OUT, bookmarklet);
  console.log(`built ${OUT}: ${code.length} source chars, ${bookmarklet.length} bytes encoded`);
}