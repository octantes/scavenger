// tools tier - drive every registered kernel tool: generic start/stop (no throw, clean destroy), then per-category behaviour checks

import { launchChrome, connect, MIN_TOOL_COUNT } from './_cdp.mjs';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const kernelSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../kernel.js'), 'utf8');

// fixture with real content for print/effect/asset tools
const html = `<!doctype html><html><head><title>Fixture Title</title>
  <meta name="description" content="a test page">
  <script type="application/ld+json">{"@type":"WebSite","name":"x"}</script>
  <style>.card{border:1px solid #ccc;padding:8px} .card:hover{color:red}</style></head>
  <body>
  <header id="hdr"><h1 id="h">Heading</h1></header>
  <div class="card" id="c1">card one <a href="/x">link</a></div>
  <div class="card" id="c2" style="z-index:5;position:relative">card two <span id="c2-child">nested</span></div>
  <img id="img" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" width="20" height="20">
  <input id="inp" value="hi">
  <div id="sizebox" style="width:140px;height:65px"></div>
  </body></html>`;
const srv = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable'); await send('Runtime.enable');
// this tier drives async-heavy tools (screen-record, eyedropper) - add exceptionThrown monitor so rejection isn't missed
const uncaught = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') uncaught.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); });
await send('Page.navigate', { url });
await waitEvent('Page.loadEventFired');
const js = async (expr, awaitPromise = false) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise }))?.result?.result?.value;
const done = () => { try { ws.close(); } catch {} cleanup(); srv.close(); };

try {
  await js(`localStorage.setItem('tkey','tval'); true`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  ok(await js(`!!window.$kernel`), 'kernel injected');

  const ids = await js(`Object.keys(window.$kernel.processes)`);
  ok(Array.isArray(ids) && ids.length >= MIN_TOOL_COUNT, `enumerated all tools (${ids.length})`);

  // generic lifecycle: start + stop every tool, no throw, toggles flip active (getDisplayMedia/EyeDropper absent headless)
  const life = await js(`(() => {
    const out = {}; const k = window.$kernel;
    for (const id of Object.keys(k.processes)) {
      const p = k.processes[id];
      try { // don't await async start (screen-record's getDisplayMedia never resolves headless) - assert only sync lifecycle
        k.start(id);
        const activeAfterStart = p.active;
        k.stop(id);
        out[id] = { ok: true, type: p.type, flips: p.type === 'oneshot' ? true : (activeAfterStart && !p.active) };
      } catch (e) { out[id] = { ok: false, err: String(e && e.message || e) }; }
    }
    return out;
  })()`);
  const threw = Object.entries(life).filter(([, v]) => !v.ok);
  ok(threw.length === 0, `every tool starts+stops without throwing (threw: ${threw.map(([k, v]) => k + ':' + v.err).join(', ')})`);
  const noFlip = Object.entries(life).filter(([, v]) => v.ok && !v.flips);
  ok(noFlip.length === 0, `every toggle/param/cycle flips active on start→stop (didn't: ${noFlip.map(([k]) => k).join(', ')})`);

  // hover tool's start>stop must leave no stale click-arm - bus.on/off are sync, no delay needed
  const stale = await js(`(() => {
    const k = window.$kernel; k.start('harvester'); k.stop('harvester');
    return !(k.bus.subscribers['click'] || []).some(s => s.id === 'hover-eng');
  })()`);
  ok(stale === true, `hover-engine teardown removes click-handler arm (stale: ${stale})`);

  // overlay tools: create overlay on start, remove on stop
  const overlays = { 'xray': 'scv-xray', 'grid-h': 'scv-grid-h', 'grid-v': 'scv-grid-v', 'v-line': 'scv-temp-v', 'h-line': 'scv-temp-h', 'capture-zone': 'scv-cap-ov' };
  for (const [id, ovId] of Object.entries(overlays)) {
    const r = await js(`(() => { const k = window.$kernel; k.start(${JSON.stringify(id)}); const on = !!document.getElementById(${JSON.stringify(ovId)}); k.stop(${JSON.stringify(id)}); const off = !document.getElementById(${JSON.stringify(ovId)}); return { on, off }; })()`);
    ok(r && r.on && r.off, `${id}: overlay #${ovId} appears on start, gone on stop (${JSON.stringify(r)})`);
  }

  // effects: mutate body filter / inject style, fully restore on stop
  const blur = await js(`(() => { const k = window.$kernel; k.start('blur'); const on = getComputedStyle(document.body).filter; k.stop('blur'); const off = document.body.style.filter; return { on: on.includes('blur'), off: !/blur/.test(off) }; })()`);
  ok(blur && blur.on && blur.off, `blur: filter applied then cleared (${JSON.stringify(blur)})`);
  const gray = await js(`(() => { const k = window.$kernel; k.start('grayscale'); const on = document.body.style.filter.includes('grayscale'); k.stop('grayscale'); const off = !document.body.style.filter.includes('grayscale'); return { on, off }; })()`);
  ok(gray && gray.on && gray.off, `grayscale: filter applied then cleared (${JSON.stringify(gray)})`);
  const skel = await js(`(() => { const k = window.$kernel; k.start('skeleton'); const on = !!document.getElementById('scv-skeleton'); k.stop('skeleton'); const off = !document.getElementById('scv-skeleton'); return { on, off }; })()`);
  ok(skel && skel.on && skel.off, `skeleton: style injected then removed (${JSON.stringify(skel)})`);

  // freeze: overrides timing globals, restores exact originals on stop
  const frz = await js(`(() => {
    const k = window.$kernel; const nativeSI = window.setInterval;
    k.start('freeze'); const overridden = window.setInterval !== nativeSI;
    k.stop('freeze'); const restored = window.setInterval === nativeSI;
    return { overridden, restored };
  })()`);
  ok(frz && frz.overridden && frz.restored, `freeze: overrides then restores setInterval (${JSON.stringify(frz)})`);

  // layout-colors: recolors elements, restores inline style on stop
  const lc = await js(`(() => {
    const k = window.$kernel; const el = document.getElementById('c1'); const before = el.style.backgroundColor;
    k.start('layout-colors'); const changed = el.style.backgroundColor !== before && !!el.style.backgroundColor;
    k.stop('layout-colors'); const back = el.style.backgroundColor === before;
    return { changed, back };
  })()`);
  ok(lc && lc.changed && lc.back, `layout-colors: recolors then restores (${JSON.stringify(lc)})`);

  // img-flip (oneshot action): rotates images
  const flip = await js(`(() => { window.$kernel.start('img-flip'); const t = document.getElementById('img').style.transform; window.$kernel.stop('img-flip'); return t; })()`);
  ok(typeof flip === 'string' && /rotate/.test(flip), `img-flip: applies rotation (${JSON.stringify(flip)})`);

  // prints (oneshot): start() returns content
  const prints = await js(`(() => {
    const k = window.$kernel; const grab = id => { const r = k.start(id); k.stop(id); return r; };
    const fonts = grab('log-fonts'), globals = grab('log-global'), storage = grab('storage-dump'), meta = grab('meta-harvest');
    const tree = grab('scavenge-tree'), assets = grab('asset-vac');
    return {
      fonts: typeof fonts === 'string',
      globals: typeof globals === 'string' && globals.includes('document'),
      storageHasKey: typeof storage === 'string' && storage.includes('tval'),
      metaHasTitle: typeof meta === 'string' && meta.includes('Fixture Title'),
      treeEl: tree && tree.nodeType === 1,
      assetsEl: assets && assets.nodeType === 1,
    };
  })()`);
  ok(prints && prints.fonts, 'log-fonts returns text');
  ok(prints && prints.globals, 'log-global returns window prop dump');
  ok(prints && prints.storageHasKey, 'storage-dump includes localStorage value');
  ok(prints && prints.metaHasTitle, 'meta-harvest includes page title');
  ok(prints && prints.treeEl, 'scavenge-tree returns dom tree');
  ok(prints && prints.assetsEl, 'asset-vac returns asset grid');

  // scavenge-tree row buttons: glyph grammar, each with hover title
  const treeBtns = await js(`(() => {
    const tree = window.$kernel.start('scavenge-tree'); window.$kernel.stop('scavenge-tree');
    const b = [...tree.querySelectorAll('.scv-grp-btn')].slice(0, 5);
    return { labels: b.map(x => x.textContent).join(''), allTitled: b.length === 5 && b.every(x => x.title && x.title.length > 3) };
  })()`);
  ok(treeBtns && treeBtns.labels === '⧉⊘⇣↻⤓', `tree row buttons use glyph grammar (got ${treeBtns && treeBtns.labels})`);
  ok(treeBtns && treeBtns.allTitled, 'every tree row button has explanatory hover title');

  // tree reset (data-scv-head-action) - showView lifts to viewer header, out of uiWrap before tool's setTimeout wires
  // regression: wiring queried uiWrap post-lift, found null, threw uncaught - reach it by id in live doc
  const resetBefore = uncaught.length;
  await js(`window.$kernel.run('scavenge-tree')`);
  await new Promise(r => setTimeout(r, 60)); // let tool's setTimeout(0) fire on lifted button
  const resetWired = await js(`(() => { const b = document.getElementById('scv-tree-reset'); return !!b && !!b.closest('.scv-v-head') && typeof b.onclick === 'function'; })()`);
  await js(`window.$kernel.stop('scavenge-tree')`);
  ok(resetWired, 'tree reset button wires onclick after showView lifts it to header');
  ok(uncaught.length === resetBefore, `no uncaught error opening scavenge-tree (${uncaught.slice(resetBefore).join(' | ')})`);

  // eyedropper: graceful message when api is absent (headless)
  const eye = await js(`(() => { const r = window.$kernel.start('eyedropper'); window.$kernel.stop('eyedropper'); return r; })()`);
  // headless exposes window.EyeDropper, start() takes open()-await branch - .open() rejects with no gesture, caught silently
  ok(eye === undefined, `eyedropper: start() has no sync return once window.EyeDropper exists (${JSON.stringify(eye)})`);

  // el-write: toggles design mode on, off
  const write = await js(`(() => { const k = window.$kernel; k.start('el-write'); const on = document.designMode === 'on'; k.stop('el-write'); const off = document.designMode === 'off'; return { on, off }; })()`);
  ok(write && write.on && write.off, `el-write: designMode on→off (${JSON.stringify(write)})`);

  // sniper pick-actions: start, click target, assert action - poll processes[id].active, keep post-click wait
  const armed = id => `{ const s = Date.now(); while (!window.$kernel.processes[${JSON.stringify(id)}]?.active && Date.now() - s < 2000) await new Promise(r => setTimeout(r, 10)); }`;
  const pick = async (id, targetSel) => js(`(async () => {
    window.$kernel.start(${JSON.stringify(id)});
    await (async () => ${armed(id)})();
    document.querySelector(${JSON.stringify(targetSel)}).click();
    await new Promise(r => setTimeout(r, 60));
    return true;
  })()`, true);

  // isolate: after picking #c1, unrelated siblings become visibility:hidden; #c1 stays visible
  const iso = await js(`(async () => {
    window.$kernel.start('isolate');
    await (async () => ${armed('isolate')})();
    document.getElementById('c1').click();
    await new Promise(r => setTimeout(r, 60));
    const kept = getComputedStyle(document.getElementById('c1')).visibility;
    const hiddenSib = getComputedStyle(document.getElementById('c2')).visibility;
    window.$kernel.stop('isolate');
    const restored = getComputedStyle(document.getElementById('c2')).visibility;
    return { kept, hiddenSib, restored };
  })()`, true);
  ok(iso && iso.kept === 'visible' && iso.hiddenSib === 'hidden' && iso.restored === 'visible', `isolate hides siblings on pick, restores on stop (${JSON.stringify(iso)})`);

  // wiring: picking element opens channel-editor panel
  const wired = await js(`(async () => {
    window.$kernel.start('wiring');
    await (async () => ${armed('wiring')})();
    document.getElementById('c1').click();
    await new Promise(r => setTimeout(r, 60));
    const panel = !!document.getElementById('scv-wire-panel');
    window.$kernel.stop('wiring');
    const gone = !document.getElementById('scv-wire-panel');
    return { panel, gone };
  })()`, true);
  ok(wired && wired.panel && wired.gone, `wiring opens channel panel on pick, closes on stop (${JSON.stringify(wired)})`);

  // type-siphon: picking copies computed typography to clipboard
  const typ = await js(`(async () => {
    let cap = null;
    Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { cap = String(t); return Promise.resolve(); }, configurable: true });
    window.$kernel.start('type-siphon');
    await (async () => ${armed('type-siphon')})();
    document.getElementById('h').click();
    const s = Date.now(); while (cap === null && Date.now() - s < 2000) await new Promise(r => setTimeout(r, 20));
    return cap;
  })()`, true);
  ok(typeof typ === 'string' && /font-family/.test(typ), `type-siphon copies typography on pick (${JSON.stringify((typ || '').slice(0, 30))})`);

  // stacking - non-context descendant must climb to nearest stacking-context root (#c2) and label z-index
  const stackPick = await js(`(async () => {
    window.$kernel.start('stacking');
    const s = Date.now(); while (!window.$kernel.processes['stacking']?.active && Date.now() - s < 2000) await new Promise(r => setTimeout(r, 10));
    document.getElementById('c2-child').click();
    await new Promise(r => setTimeout(r, 60));
    const lbl = document.getElementById('scv-shared-lbl');
    return { text: lbl ? lbl.innerText : null };
  })()`, true);
  ok(stackPick && /z:5/.test(stackPick.text) && /#c2/.test(stackPick.text),
    `stacking climbs from non-context child to its stacking-context ancestor (#c2, z:5) (${JSON.stringify(stackPick)})`);
  await js(`window.$kernel.stop('stacking'); true`);

  // el-size - hovering element shows real computed dimensions, not placeholder
  const sizeHover = await js(`(async () => {
    window.$kernel.start('el-size');
    const s = Date.now(); while (!window.$kernel.processes['el-size']?.active && Date.now() - s < 2000) await new Promise(r => setTimeout(r, 10));
    const box = document.getElementById('sizebox'), r = box.getBoundingClientRect();
    box.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
    await new Promise(res => setTimeout(res, 60));
    const lbl = document.getElementById('scv-shared-lbl');
    window.$kernel.stop('el-size');
    return { text: lbl ? lbl.innerText : null };
  })()`, true);
  ok(sizeHover && /140/.test(sizeHover.text) && /65/.test(sizeHover.text),
    `el-size shows hovered element's real width/height (140 × 65) (${JSON.stringify(sizeHover)})`);

  // z-layers - selecting band keeps layer (+ancestors) visible, hides siblings, restores on stop
  const zLayers = await js(`(() => {
    const k = window.$kernel;
    k.start('z-layers'); // val=null seeds options list from live page
    const options = k.processes['z-layers'].options.slice();
    k.stop('z-layers'); k.start('z-layers', '5'); // cycle tools restart (not re-call start while active) to change val - matches palette's own adjust()/run()
    const c1Hidden = getComputedStyle(document.getElementById('c1')).display === 'none';
    const c2Visible = getComputedStyle(document.getElementById('c2')).display !== 'none';
    k.stop('z-layers');
    const c1Restored = getComputedStyle(document.getElementById('c1')).display !== 'none';
    return { options, c1Hidden, c2Visible, c1Restored };
  })()`);
  ok(zLayers && zLayers.options.includes('5'), `z-layers populates its options from page's real z-index values (${JSON.stringify(zLayers && zLayers.options)})`);
  ok(zLayers && zLayers.c1Hidden && zLayers.c2Visible, `z-layers isolating band "5" hides unrelated #c1, keeps #c2 visible (${JSON.stringify(zLayers)})`);
  ok(zLayers && zLayers.c1Restored, `z-layers stop() restores hidden siblings (${JSON.stringify(zLayers)})`);

  // harvest depth: component with shadow root is captured with shadow content
  const shadowHarvest = await js(`(async () => {
    const host = document.createElement('div'); host.id = 'shost';
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<style>.inner{color:red}</style><span class="inner">shadow-content-xyz</span>';
    document.body.appendChild(host);
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      (async () => {
        const s = Date.now();
        while (!window.$kernel.processes['harvester']?.active && Date.now() - s < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('shost').click();
      })();
      setTimeout(() => resolve('__timeout__'), 3000);
    });
  })()`, true);
  ok(typeof shadowHarvest === 'string' && shadowHarvest.includes('shadow-content-xyz'), 'harvest captures shadow-dom component with shadow content');

  // command palette: search box filters tool list
  const palette = await js(`(() => {
    const input = document.getElementById('scv-pal-input'); if (!input) return { noInput: true };
    input.value = 'blur'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [...document.querySelectorAll('#scv-pal-list .scv-cmd')].map(r => r.textContent.toLowerCase());
    const onlyBlur = rows.length > 0 && rows.every(t => t.includes('blur'));
    input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    const restored = document.querySelectorAll('#scv-pal-list .scv-cmd').length;
    return { onlyBlur, matched: rows.length, restored };
  })()`);
  ok(palette && palette.onlyBlur && palette.restored > palette.matched, `palette search filters tool list (${JSON.stringify(palette)})`);

  // programmatic launch: summon(seed) prefilters palette, run(cmd) executes without ui
  const launchApi = await js(`(() => {
    const k = window.$kernel;
    k.summon('gray');
    const v1 = document.getElementById('scv-pal-input').value;
    const rows1 = [...document.querySelectorAll('#scv-pal-list .scv-cmd')].map(r => r.textContent.toLowerCase());
    k.summon('');
    const v2 = document.getElementById('scv-pal-input').value;
    const rows2 = document.querySelectorAll('#scv-pal-list .scv-cmd').length;
    k.run('blur');
    const on = document.body.style.filter.includes('blur');
    k.run('blur');
    const off = !document.body.style.filter.includes('blur');
    return { v1, onlyGray: v1 === 'gray' && rows1.length > 0 && rows1.every(t => t.includes('gray')), cleared: v2 === '' && rows2 > rows1.length, on, off };
  })()`);
  ok(launchApi && launchApi.onlyGray && launchApi.cleared, `summon(seed) prefilters palette and summon('') restores it (${JSON.stringify(launchApi)})`);
  ok(launchApi && launchApi.on && launchApi.off, `run(cmd) executes toggle tool and second run stops it (${JSON.stringify(launchApi)})`);

  // escape cancels active snipe (stops owning tool)
  const escCancel = await js(`(() => {
    window.$kernel.start('el-sniper');
    const armed = window.$kernel.processes['el-sniper'].active;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return { armed, cancelled: !window.$kernel.processes['el-sniper'].active };
  })()`);
  ok(escCancel && escCancel.armed && escCancel.cancelled, `escape cancels active snipe (${JSON.stringify(escCancel)})`);

  // escape inside focused input leaves snipe armed (wiring panel survives)
  const escInInput = await js(`(() => {
    window.$kernel.start('el-sniper');
    const inp = document.createElement('input');
    document.body.appendChild(inp); inp.focus();
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const survived = window.$kernel.processes['el-sniper'].active;
    inp.remove(); window.$kernel.stop('el-sniper');
    return { survived };
  })()`);
  ok(escInInput && escInInput.survived, `Escape inside focused input leaves snipe armed (${JSON.stringify(escInInput)})`);

  // escape closes any active stateful tool even when focus left the palette - handled on the bus, not the wrapper - and palette persists
  const escFromOutside = await js(`(() => {
    window.$kernel.run('blur'); // passive overlay - palette stays open (not a page tool)
    const armed = window.$kernel.processes['blur'].active;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // focus off the palette
    const closed = !window.$kernel.processes['blur'].active, palStill = !!document.getElementById('scv-master-wrapper');
    if (window.$kernel.processes['blur'].active) window.$kernel.stop('blur');
    return { armed, closed, palStill };
  })()`);
  ok(escFromOutside && escFromOutside.armed && escFromOutside.closed, `escape closes active tool from outside the palette (${JSON.stringify(escFromOutside)})`);
  ok(escFromOutside && escFromOutside.palStill, `palette persists after escape closes a tool (${JSON.stringify(escFromOutside)})`);

  // el-write flips the page to contentEditable - escape must read that as tool state and close it, not just blur a field
  const escClosesWrite = await js(`(() => {
    window.$kernel.run('el-write');
    const on = window.$kernel.processes['el-write'].active && document.designMode === 'on';
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const off = !window.$kernel.processes['el-write'].active;
    if (window.$kernel.processes['el-write'].active) window.$kernel.stop('el-write');
    return { on, off };
  })()`);
  ok(escClosesWrite && escClosesWrite.on && escClosesWrite.off, `escape closes el-write despite contentEditable page (${JSON.stringify(escClosesWrite)})`);

  // screen-record: mid-setup throw (eg MediaRecorder on safari) must stop share stream
  const recLeak = await js(`(async () => {
    let stopped = 0;
    const fakeTracks = [{ stop: () => { stopped++; } }];
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: async () => ({ getTracks: () => fakeTracks, getVideoTracks: () => fakeTracks }) }, configurable: true });
    window.MediaRecorder = function () { throw new Error('vp9 unsupported'); };
    window.$kernel.start('screen-record');
    const s = Date.now(); while (stopped === 0 && Date.now() - s < 2000) await new Promise(r => setTimeout(r, 20));
    delete navigator.mediaDevices; // restore prototype getter
    return { stopped };
  })()`, true);
  ok(recLeak && recLeak.stopped === 1, `screen-record stops share stream when MediaRecorder throws (${JSON.stringify(recLeak)})`);

  // screen-record success path - working MediaRecorder shows rec overlay, stop runs full teardown chain
  const recSuccess = await js(`(async () => {
    let tracksStopped = 0, recorderStopped = 0, downloadClicked = false, onstopFired = false;
    const fakeTracks = [{ stop: () => { tracksStopped++; } }];
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: async () => ({ getTracks: () => fakeTracks, getVideoTracks: () => fakeTracks }) }, configurable: true });
    window.MediaRecorder = function () {
      this.state = 'recording';
      this.start = () => {};
      this.stop = () => { recorderStopped++; this.state = 'inactive'; onstopFired = true; if (this.onstop) this.onstop(); };
    };
    const origCreateEl = document.createElement.bind(document);
    document.createElement = tag => { const el = origCreateEl(tag); if (tag === 'a') { const oc = el.click.bind(el); el.click = () => { downloadClicked = true; }; } return el; };
    window.$kernel.start('screen-record');
    const s = Date.now(); while (!document.getElementById('scv-rec-ui') && Date.now() - s < 2000) await new Promise(r => setTimeout(r, 20));
    const uiShown = !!document.getElementById('scv-rec-ui');
    document.getElementById('scv-rec-ui')?.querySelector('.scv-rec-stop')?.click();
    const s2 = Date.now(); while (!downloadClicked && Date.now() - s2 < 2000) await new Promise(r => setTimeout(r, 20));
    document.createElement = origCreateEl;
    delete navigator.mediaDevices;
    return { uiShown, tracksStopped, recorderStopped, onstopFired, downloadClicked, uiGoneAfterStop: !document.getElementById('scv-rec-ui') };
  })()`, true);
  ok(recSuccess && recSuccess.uiShown, `screen-record shows rec overlay on successful start (${JSON.stringify(recSuccess)})`);
  // tracksStopped can be 2 - stop onclick + onstop's kernel.stop() teardown both stop them (idempotent, harmless)
  ok(recSuccess && recSuccess.recorderStopped === 1 && recSuccess.tracksStopped >= 1,
    `clicking stop button stops both recorder and share stream tracks (${JSON.stringify(recSuccess)})`);
  ok(recSuccess && recSuccess.onstopFired && recSuccess.downloadClicked,
    `onstop fires and triggers capture.webm download (${JSON.stringify(recSuccess)})`);

  // _recToken race guard - stop() before getDisplayMedia resolves makes late stream no-op, no rec ui
  const recRace = await js(`(async () => {
    let tracksStopped = 0;
    const fakeTracks = [{ stop: () => { tracksStopped++; } }];
    let resolveMedia;
    Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia: () => new Promise(r => { resolveMedia = r; }) }, configurable: true });
    window.$kernel.start('screen-record');
    window.$kernel.stop('screen-record'); // cancel before getDisplayMedia ever resolves
    resolveMedia({ getTracks: () => fakeTracks, getVideoTracks: () => fakeTracks });
    const s = Date.now(); while (tracksStopped === 0 && Date.now() - s < 2000) await new Promise(r => setTimeout(r, 20));
    delete navigator.mediaDevices;
    return { tracksStopped, uiShown: !!document.getElementById('scv-rec-ui') };
  })()`, true);
  ok(recRace && recRace.tracksStopped === 1 && !recRace.uiShown,
    `stop() before getDisplayMedia resolves stops late stream and never shows rec ui (${JSON.stringify(recRace)})`);

  // utils.copy falls back to prompt() when clipboard api rejects
  const copyFallback = await js(`(async () => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.reject(new Error('denied')), configurable: true });
    let prompted = null; const op = window.prompt; window.prompt = (label, text) => { prompted = text; return null; };
    // scavenge-tree 'C' button copies selector via utils.copy > will hit fallback
    const tree = window.$kernel.start('scavenge-tree'); window.$kernel.stop('scavenge-tree');
    document.body.appendChild(tree);
    const cbtn = tree.querySelector('.scv-grp-btn.scv-copy');
    if (cbtn) cbtn.click();
    const s = Date.now(); while (prompted === null && Date.now() - s < 2000) await new Promise(r => setTimeout(r, 20));
    window.prompt = op; tree.remove();
    return prompted;
  })()`, true);
  ok(typeof copyFallback === 'string' && copyFallback.length > 0, `utils.copy falls back to prompt() on clipboard failure (${JSON.stringify(copyFallback)})`);

  // re-injecting kernel while it's live destroys it (bookmarklet re-press guard)
  const hadKernel = await js(`!!window.$kernel`);
  await send('Runtime.evaluate', { expression: kernelSrc }); // second injection > top-of-file guard calls destroy()
  const afterRepress = await js(`typeof window.$kernel === 'undefined'`);
  ok(hadKernel === true && afterRepress === true, 're-pressing bookmarklet (re-inject) destroys live kernel');

  // boot flags: scvLaunch.search seeds first palette, run:true auto-executes command
  await js(`window.scvLaunch = { search: 'blur', run: true }; true`);
  await send('Runtime.evaluate', { expression: kernelSrc }); // re-inject so teardown check below has kernel
  const seeded = await js(`(() => {
    const input = document.getElementById('scv-pal-input'); if (!input) return { noInput: true };
    const v = input.value;
    const rows = [...document.querySelectorAll('#scv-pal-list .scv-cmd')].map(r => r.textContent.toLowerCase());
    return { v, filtered: v === 'blur' && rows.length > 0 && rows.every(t => t.includes('blur')), autoRan: document.body.style.filter.includes('blur') };
  })()`);
  ok(seeded && seeded.filtered, `scvLaunch.search prefilters boot palette (${JSON.stringify(seeded)})`);
  ok(seeded && seeded.autoRan, `scvLaunch.run executes seeded command at launch (${JSON.stringify(seeded)})`);
  await js(`delete window.scvLaunch; true`);

  // after all churn, destroy leaves page pristine
  const clean = await js(`(() => {
    window.$kernel.destroy();
    return { kernelGone: typeof window.$kernel === 'undefined', scv: document.querySelectorAll('[id^="scv-"]').length, filter: document.body.style.filter, cursor: document.body.style.cursor };
  })()`);
  ok(clean && clean.kernelGone, 'destroy removes window.$kernel');
  ok(clean && clean.scv === 0, `destroy leaves no scv-* nodes (found ${clean && clean.scv})`);
  ok(clean && !clean.filter && !clean.cursor, `destroy leaves no residual body filter/cursor (${JSON.stringify(clean)})`);

  await new Promise(r => setTimeout(r, 300)); // grace period - late async rejection may still be in flight over websocket
  ok(uncaught.length === 0, `no uncaught exceptions across whole tools run (${uncaught.slice(0, 3).join(' | ')})`);
} catch (e) {
  fails++; console.log('  ✗ tools tier threw:', e.message);
}

done();
console.log(fails ? `tools: FAIL (${fails})` : 'tools: PASS');
process.exit(fails ? 1 : 0);