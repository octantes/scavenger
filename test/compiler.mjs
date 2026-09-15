// compiler tier - compiler.html end to end + patchbay integration: author node, compile .scv, register + run it

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const compilerUrl = pathToFileURL(join(here, '..', 'compiler.html')).href;
const pbUrl = pathToFileURL(join(here, '..', 'patchbay.html')).href;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
const errs = [];
await send('Runtime.enable'); await send('Page.enable');
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
});
const js = async (e, aw = false) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const load = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await delay(300); };
const done = () => { try { ws.close(); } catch {} cleanup(); };

try {
  await load(compilerUrl);
  ok(errs.length === 0, `compiler boots with no js errors (${errs.slice(0, 2).join(' | ')})`);
  ok(await js(`typeof compile === 'function' && !!fields`), 'compiler exposes compile() + fields');

  const builds = await js(`(() => {
    const n = () => (document.getElementById('pipeline').textContent.match(/built #(\\d+)/) || [])[1];
    fields.code.value = 'onReceive(v, ctx) { ctx.emit(v); }'; recompile();
    const first = n();
    fields.code.value = 'onReceive(v, ctx) { ctx.emit(v + 1); }'; recompile();
    const second = n();
    fields.code.value = 'onReceive(v, ctx) { ctx.emit(v'; recompile();
    const broken = document.getElementById('pipeline').textContent;
    return { first: +first, second: +second, broken };
  })()`);
  ok(builds && builds.second === builds.first + 1, `build counter advances on each successful build (${builds && builds.first} → ${builds && builds.second})`);
  ok(builds && /parse error/.test(builds.broken), `failed parse reports parse error instead of build (${JSON.stringify(builds && builds.broken)})`);

  const lines = await js(`({
    unclosed: findSyntaxErrorLine('init(ctx) {\\n  ctx.value = 0;\\n},\\n\\nonReceive(v, ctx) {\\n  ctx.emit(v);\\n'),
    mismatch: findSyntaxErrorLine('init(ctx) {\\n  ctx.value = 0;\\n]'),
    missingComma: findSyntaxErrorLine('init(ctx) {\\n}\\nonReceive(v, ctx) {\\n}'),
    clean: findSyntaxErrorLine('init(ctx) {\\n  ctx.value = 0;\\n}'),
    regexNotDivision: findSyntaxErrorLine('init(ctx) {\\n  const r = /[{(]/;\\n}'),
  })`);
  ok(lines && lines.unclosed === 4, `unclosed brace points at line that opened it (got ${lines && lines.unclosed})`);
  ok(lines && lines.mismatch === 2, `mismatched closer points at its own line (got ${lines && lines.mismatch})`);
  ok(lines && lines.missingComma === 2, `bare identifier after depth-0 close flags missing comma (got ${lines && lines.missingComma})`);
  ok(lines && lines.clean === -1, `balanced source reports no error line (got ${lines && lines.clean})`);
  ok(lines && lines.regexNotDivision === -1, `brackets inside regex literal are not counted as depth (got ${lines && lines.regexNotDivision})`);

  const store = await js(`(() => {
    localStorage.removeItem('scav-nodes'); localStorage.removeItem('scav-wip');
    fields.name.value = 'keeper'; fields.icon.value = 'k'; fields.color.value = '#8ab6bb';
    fields.code.value = 'init(ctx) { ctx.value = 1; }';
    saveCurrentNode();
    fields.name.value = '!!!';
    saveCurrentNode();
    const saved = JSON.parse(localStorage.getItem('scav-nodes') || '[]');
    writeWip();
    const wip = JSON.parse(localStorage.getItem('scav-wip') || 'null');
    return { count: saved.length, ids: saved.map(n => n.id), wipCode: wip && wip.code };
  })()`);
  ok(store && store.count === 2, `all-punctuation name saves alongside, it does not overwrite (${store && store.count} entries)`);
  ok(store && store.ids.every(id => id && id.length), `no saved node gets empty id (${JSON.stringify(store && store.ids)})`);
  ok(store && store.wipCode === 'init(ctx) { ctx.value = 1; }', `draft autosave writes current code (${JSON.stringify(store && store.wipCode)})`);

  const closer = await js(`(() => {
    fields.name.value = 'closer'; fields.icon.value = 'c'; fields.color.value = '#8ab6bb';
    fields.code.value = 'init(ctx) { ctx.tag = "<' + '/script><img src=x onerror=1>"; ctx.c = "<' + '!--"; }';
    const res = compile();
    if (!res.ok) return { ok: false };
    const body = res.html.slice(res.html.indexOf(String.fromCharCode(10)) + 1, res.html.lastIndexOf('<' + '/script>'));
    const back = parseScv(res.html);
    return { ok: true, raw: /<\\/script>/i.test(body), rawComment: /<!--/.test(body), roundTrips: !!back && !!back.def };
  })()`);
  ok(closer && closer.ok, 'node whose code contains script closer still compiles');
  ok(closer && closer.raw === false, 'node code cannot close emitted .scv script tag');
  ok(closer && closer.rawComment === false, 'node code cannot open html comment in emitted .scv');
  ok(closer && closer.roundTrips, 'escaped artifact still parses back into definition');

  // author triple node and compile it > .scv artifact
  const compiled = await js(`(() => {
    fields.name.value = 'triple'; fields.icon.value = '×3'; fields.color.value = '#8ab6bb';
    fields.code.value = 'onReceive(value, ctx) { ctx.emit(Number(value) * 3); }';
    const res = compile();
    return { ok: res.ok, hasDefine: /defineNode\\(/.test(res.html || ''), hasName: /triple/.test(res.html || ''), scv: res.ok ? res.html : null };
  })()`);
  ok(compiled && compiled.ok && compiled.hasDefine && compiled.hasName, `compile() emits valid .scv artifact (${JSON.stringify({ ok: compiled && compiled.ok, def: compiled && compiled.hasDefine })})`);
  ok(compiled && /-->\n\n<html lang="en">/.test(compiled.scv || ''), '.scv header keeps blank line under doctype before <html>, matching source files');

  // error path: broken code reported, not thrown
  const bad = await js(`(() => { fields.code.value = 'onReceive(v, ctx) { this is not valid js'; const res = compile(); return { ok: res.ok, hasError: !!res.error }; })()`);
  ok(bad && bad.ok === false && bad.hasError, `broken node code → compile reports error (${JSON.stringify(bad)})`);

  // documented rig config keys (placeholder/openWidth/label/inputType) must apply to preview
  const cfgKeys = await js(`(() => {
    fields.name.value = 'cfgnode'; fields.icon.value = 'C'; fields.color.value = '#8ab6bb';
    fields.code.value = "placeholder: 'ph text', openWidth: 222, label: 'hover label', inputType: 'number', onReceive(v, ctx) {}";
    recompile();
    const input = $('p-input');
    return {
      placeholder: input.placeholder,
      inputType: input.type,
      openWidth: getComputedStyle($('p-open')).width,
      label: $('p-icon-open').title,
    };
  })()`);
  ok(cfgKeys && cfgKeys.placeholder === 'ph text', `def.placeholder applies to rig's input placeholder (${JSON.stringify(cfgKeys)})`);
  ok(cfgKeys && cfgKeys.inputType === 'number', `def.inputType applies to rig's input type (${JSON.stringify(cfgKeys)})`);
  ok(cfgKeys && cfgKeys.openWidth === '222px', `def.openWidth drives open preview's width (${JSON.stringify(cfgKeys)})`);
  ok(cfgKeys && cfgKeys.label === 'hover label', `def.label applies as closed-icon hover tooltip when there are no modes (${JSON.stringify(cfgKeys)})`);

  // makeCtx stubs (ctx.value/type/x/y/setPosition, node-pulse/scv-node-error) must match real kernel
  const ctxContract = await js(`(() => {
    fields.name.value = 'ctxnode'; fields.icon.value = 'X'; fields.color.value = '#8ab6bb';
    fields.code.value = "init(ctx) { ctx.value = 42; window.__v1 = ctx.value; ctx.setPosition(10, 20); window.__pos1 = [ctx.x, ctx.y]; ctx.setPosition(30, 40); window.__pos2 = [ctx.x, ctx.y]; window.__type = ctx.type; }";
    recompile();
    const baseShadow = getComputedStyle($('p-open')).boxShadow; // before either class - the control value
    $('p-open').classList.add('scv-node-error');
    const errShadow = getComputedStyle($('p-open')).boxShadow;
    $('p-open').classList.remove('scv-node-error');
    return {
      valueType: typeof window.__v1, valueStr: window.__v1,
      pos1: window.__pos1, pos2: window.__pos2,
      type: window.__type,
      baseShadow, errShadow,
    };
  })()`);
  ok(ctxContract && ctxContract.valueType === 'string' && ctxContract.valueStr === '42',
    `ctx.value assigned number reads back as string, same as real <input>.value round-trip (${JSON.stringify(ctxContract && { t: ctxContract.valueType, v: ctxContract.valueStr })})`);
  ok(ctxContract && JSON.stringify(ctxContract.pos1) === '[10,20]' && JSON.stringify(ctxContract.pos2) === '[30,40]',
    `setPosition(x,y) round-trips through ctx.x/ctx.y instead of silently no-op'ing (${JSON.stringify(ctxContract && { p1: ctxContract.pos1, p2: ctxContract.pos2 })})`);
  ok(ctxContract && ctxContract.type === 'ctxnode', `ctx.type is node's own def.name, not literal string 'custom' (${JSON.stringify(ctxContract && ctxContract.type)})`);
  ok(ctxContract && ctxContract.baseShadow !== ctxContract.errShadow,
    `adding scv-node-error to ctx.el's classList (the node-pulse/error convention any custom node can use) actually changes rendered box-shadow, not class landing with no matching css (${JSON.stringify(ctxContract && { base: ctxContract.baseShadow, err: ctxContract.errShadow })})`);

  // integration: emitted .scv registers on patchbay and node runs
  const scv = compiled && compiled.scv;
  ok(typeof scv === 'string', 'captured .scv text for patchbay round-trip');
  if (typeof scv === 'string') {
    await load(pbUrl);
    const ran = await js(`(() => {
      setMode('edit');
      const type = registerScvNodeFile(${JSON.stringify(scv)});
      if (type !== 'triple') return { type };
      const n = spawnLogicNode('triple', 100, 100);
      n.setAttribute('data-scv-emits', 'trip_out');
      const r = document.createElement('div'); r.id = 'trip_rcv'; r.setAttribute('data-scv-receives', 'trip_out'); zoomLayer.appendChild(r);
      invalidateCache();
      n.dispatchEvent(new CustomEvent('scv-receive', { detail: 7 })); // custom node: 7 * 3 = 21
      return { type, out: document.getElementById('trip_rcv').textContent };
    })()`);
    ok(ran && ran.type === 'triple', `compiled .scv registers its type on patchbay (got ${JSON.stringify(ran && ran.type)})`);
    ok(ran && String(ran.out) === '21', `registered custom node runs (7 × 3 = 21, got ${ran && ran.out})`);
  }

  // ctx api: showFloat / flashError / icon don't crash node
  await load(compilerUrl);
  const ctxApi = await js(`(() => {
    fields.name.value = 'ctx-test'; fields.icon.value = '⚡'; fields.color.value = '#986c98';
    fields.code.value = 'init(ctx) { ctx.showFloat("hello"); ctx.flashError("test", new Error("oops")); const i = ctx.icon; }';
    const res = compile();
    return { ok: res.ok, scv: res.ok ? res.html : null };
  })()`);
  ok(ctxApi && ctxApi.ok, 'compile() succeeds with ctx.showFloat/flashError/icon');
  if (ctxApi && ctxApi.scv) {
    await load(pbUrl);
    const ctxRan = await js(`(() => {
      setMode('edit');
      const type = registerScvNodeFile(${JSON.stringify(ctxApi.scv)});
      if (type !== 'ctx-test') return { type };
      const n = spawnLogicNode('ctx-test', 200, 200);
      return { type, ok: !!n };
    })()`);
    ok(ctxRan && ctxRan.type === 'ctx-test', `ctx api node registers (got ${JSON.stringify(ctxRan?.type)})`);
    ok(ctxRan && ctxRan.ok, `ctx api node spawns without crash`);
  }

  // .scv html escaping: malicious name/icon escaped in html context
  await load(compilerUrl);
  const esc = await js(`(() => {
    fields.name.value = '<img src=x onerror=alert(1)>'; fields.icon.value = '</script><script>alert(2)</script>'; fields.color.value = '#ff0000';
    fields.code.value = 'onReceive(value, ctx) { ctx.emit(value); }';
    const res = compile();
    return { ok: res.ok, scv: res.ok ? res.html : null };
  })()`);
  ok(esc && esc.ok, 'compile() succeeds with adversarial name/icon');
  if (esc && esc.scv) {
    // html parts must be escaped; match script-tag boundary by pattern not literal, so tag tweak can't make split() miss
    const scriptTagMatch = /<script[^>]*\bdata-scv-node\b[^>]*>/.exec(esc.scv);
    ok(!!scriptTagMatch, '.scv contains data-scv-node script tag');
    const htmlPart = scriptTagMatch ? esc.scv.slice(0, scriptTagMatch.index) : esc.scv;
    ok(htmlPart.includes('&lt;img'), '.scv html escapes < to &lt; in name');
    ok(htmlPart.includes('&lt;/script&gt;'), '.scv html escapes </script> in icon');
    ok(!htmlPart.includes('<img src=x'), '.scv html does not contain raw <img> tag');
  }
  // importScv recovers original source verbatim (not lossy) - fn in array + closure must survive round-trip
  await load(compilerUrl);
  const roundtrip = await js(`(() => {
    fields.name.value = 'roundtrip'; fields.icon.value = 'R'; fields.color.value = '#8ab6bb';
    fields.code.value = "handlers: [ v => v + 1, v => v * 2 ],\\n  onReceive: (() => { const bonus = 100; return (v, ctx) => ctx.emit(v + bonus); })(),";
    const res = compile();
    if (!res.ok) return { compileErr: res.error };
    let emittedBefore = null;
    res.def.onReceive(5, { emit: v => { emittedBefore = v; } });

    fields.name.value = ''; fields.icon.value = ''; fields.color.value = ''; fields.code.value = '';
    const importOk = importScv(res.html);
    const res2 = compile();
    if (!res2.ok) return { importOk, compileErr2: res2.error };
    let emittedAfter = null, threw = null;
    try { res2.def.onReceive(5, { emit: v => { emittedAfter = v; } }); } catch (e) { threw = e.message; }
    const handlersOk = Array.isArray(res2.def.handlers) && res2.def.handlers.length === 2
      && res2.def.handlers[0](3) === 4 && res2.def.handlers[1](3) === 6;
    return { importOk, emittedBefore, emittedAfter, threw, handlersOk };
  })()`);
  ok(roundtrip && roundtrip.importOk, `importScv succeeds on self-exported .scv (${JSON.stringify(roundtrip)})`);
  ok(roundtrip && roundtrip.threw === null && roundtrip.emittedAfter === roundtrip.emittedBefore && roundtrip.emittedBefore === 105,
    `re-imported onReceive keeps its iife-captured closure (5+100=105 both before and after, no ReferenceError) (${JSON.stringify(roundtrip)})`);
  ok(roundtrip && roundtrip.handlersOk, `re-imported handlers array keeps its function elements, not json-flattened to null (${JSON.stringify(roundtrip)})`);

  // ctx.append returns .append-wrap not bare el (kernel shape); x/y unused, pointercancel stops drag
  await load(compilerUrl);
  const append = await js(`(() => {
    fields.name.value = 'appender'; fields.icon.value = 'A'; fields.color.value = '#8ab6bb';
    fields.code.value = "init(ctx) { window.__wrap = ctx.append(document.createElement('div'), 999, 999); }";
    recompile();
    const wrap = window.__wrap;
    const isWrapClass = wrap.classList.contains('append-wrap');
    const containsEl = wrap.children.length > 0 && wrap.contains(wrap.querySelector('div'));
    const handle = wrap.querySelector('div');
    const before = { left: wrap.style.left, top: wrap.style.top };
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 50, clientY: 50, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 90, pointerId: 1, bubbles: true }));
    const midDrag = { left: wrap.style.left, top: wrap.style.top };
    handle.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 500, clientY: 500, pointerId: 1, bubbles: true }));
    const afterCancel = { left: wrap.style.left, top: wrap.style.top };
    return { isWrapClass, containsEl, before, midDrag, afterCancel, moved: midDrag.left !== before.left, stoppedOnCancel: afterCancel.left === midDrag.left };
  })()`);
  ok(append && append.isWrapClass, `ctx.append() returns .append-wrap, not bare el (${JSON.stringify(append)})`);
  ok(append && append.containsEl, `.append-wrap contains appended el (${JSON.stringify(append)})`);
  ok(append && append.moved, `dragging handle moves wrap (${JSON.stringify(append)})`);
  ok(append && append.stoppedOnCancel, `pointercancel stops drag - hijacked gesture doesn't leave box following pointer forever (${JSON.stringify(append)})`);

  // highlightCode: escaped quote mustn't end string early, multi-line ` template threads inTemplate across lines
  await load(compilerUrl);
  const hl = await js(`(() => {
    const escStr = highlightCode('const s = "she said \\\\"hi\\\\" ok";', false, false);
    const spanCount = (escStr.html.match(/class="hl-str"/g) || []).length;
    const line1 = highlightCode('const t = \\\`line one', false, false);
    const line2 = highlightCode('line two\\\`;', line1.inComment, line1.inTemplate);
    return {
      spanCount,
      wholeStringHighlighted: /<span class="hl-str">[^<]*hi[^<]*<\\/span>/.test(escStr.html) || (spanCount === 1),
      inTemplateAfterLine1: line1.inTemplate,
      inTemplateAfterLine2: line2.inTemplate,
    };
  })()`);
  ok(hl && hl.spanCount === 1, `escaped quote inside string doesn't split it into two spans (${JSON.stringify(hl)})`);
  ok(hl && hl.inTemplateAfterLine1 === true && hl.inTemplateAfterLine2 === false,
    `inTemplate threads true across open template literal's first line, then closes on line that terminates it (${JSON.stringify(hl)})`);
} catch (e) {
  fails++; console.log('  ✗ compiler tier threw:', e.message);
}

done();
console.log(fails ? `compiler: FAIL (${fails})` : 'compiler: PASS');
process.exit(fails ? 1 : 0);