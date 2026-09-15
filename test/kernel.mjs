// kernel tier - inject real kernel, drive palette + quest-steps via dispatched dom events, assert badges/menu/pipeline

import { launchChrome, connect } from './_cdp.mjs';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const pollUntil = async (check, timeout = 3000, interval = 25) => { // wait for real condition instead of fixed guess
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return true; await delay(interval); }
  return false;
};
const kernelSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../kernel.js'), 'utf8');

const html = `<!doctype html><title>t</title>
  <a id="a" href="/navigated-away">Alpha link</a>
  <button id="b">Beta button</button>
  <div id="trap" onmousedown="window.__md=1" style="width:80px;height:20px">trap</div>`;
const quirks = `<title>q</title><style>body{font-size:12px}</style>
  <div id="qwrap"><table id="qt"><tr><td>cell</td></tr></table></div>`; // no doctype - table stops inheriting font-size
const srv = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(req.url === '/quirks' ? quirks : html); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/`;

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable');
await send('Page.navigate', { url });
await waitEvent('Page.loadEventFired');
const js = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.result?.value;

const done = () => { try { ws.close(); } catch {} cleanup(); srv.close(); };

try {
  await send('Runtime.evaluate', { expression: kernelSrc }); // inject real kernel
  ok(await js(`!!document.querySelector('.scv-palette')`), 'kernel injected - palette rendered');
  ok(await js(`[...document.querySelectorAll('.scv-cmd')].some(e => /quest steps/i.test(e.textContent))`), 'quest-steps command listed');

  // param arg lands in row hint - markup must render as text, not dom
  await js(`(() => { const i = document.getElementById('scv-pal-input');
    i.value = 'h-grid <img/src="x"/onerror="window.__pwned=1">';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })(); true`);
  await delay(150);
  ok(await js(`!document.querySelector('.scv-cmd-hint img')`), 'palette hint escapes markup argument');
  ok(await js(`!window.__pwned`), 'palette hint argument does not execute');
  await js(`(() => { const i = document.getElementById('scv-pal-input'); i.value = '';
    i.dispatchEvent(new Event('input', { bubbles: true })); })(); window.$kernel.stop('grid-h'); true`);

  // start tool by clicking palette row
  await js(`[...document.querySelectorAll('.scv-cmd')].find(e => /quest steps/i.test(e.textContent)).click(); true`);
  await pollUntil(async () => await js(`window.$kernel.processes['quest-steps']?.active === true`)); // tool armed, not just "some time has passed"

  // press-blocking: mousedown on page must be swallowed while sniping
  await js(`document.getElementById('trap').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
  ok(await js(`window.__md !== 1`), 'press-block: page mousedown swallowed during snipe');

  // pick two elements (clicking link must not navigate - sniper preventDefaults)
  await js(`document.getElementById('a').click(); true`);
  await js(`document.getElementById('b').click(); true`);
  await pollUntil(async () => await js(`document.querySelectorAll('[id^="scv-qs-step-"]').length === 2`));
  ok(await js(`location.pathname === '/'`), 'clicking link during snipe did not navigate');
  ok(await js(`document.querySelectorAll('[id^="scv-qs-step-"]').length`) === 2, 'two badges after two picks');

  // finalize with enter > menu
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
  await pollUntil(async () => await js(`!!document.querySelector('#scv-view #scv-qs-rows')`));
  ok(await js(`!!document.querySelector('#scv-view #scv-qs-rows') && getComputedStyle(document.getElementById('scv-view')).display !== 'none'`), 'finalize menu opened inside shared viewer');

  const nums = await js(`[...document.querySelectorAll('#scv-qs-rows > div > span')].map(s => s.textContent)`);
  ok(JSON.stringify(nums) === JSON.stringify(['01', '02']), `2-digit numbers - got ${JSON.stringify(nums)}`);

  const heightsEqual = await js(`[...document.querySelectorAll('#scv-qs-rows > div')].every(r => { const s = r.querySelector('select.scv-qs-verb'), i = r.querySelector('input.scv-qs-arg'); return s && i && Math.abs(s.offsetHeight - i.offsetHeight) <= 1; })`);
  ok(heightsEqual, 'verb dropdown height matches input');

  const verbOpts = await js(`[...document.querySelectorAll('#scv-qs-rows select.scv-qs-verb option')].map(o => o.value)`);
  ok(verbOpts.length > 0 && verbOpts.every(v => typeof v === 'string' && v.length > 0 && v !== 'undefined'), `verb options render real verbs - got ${JSON.stringify(verbOpts)}`);

  const line = await js(`document.querySelector('#scv-qs-out').value`);
  ok(line.startsWith(url), 'serialized line starts with page url');
  const parts = line.slice((url + ', ').length).split(' | ');
  ok(parts.length === 2 && parts[0].startsWith('click:') && parts[1].startsWith('sel:'), `pipeline is click + sel extraction - got "${line}"`);

  // copy as test: --run entry, expect pre-filled from last pick's live text - intercept clipboard to read it
  const testJson = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    let cap = null;
    Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { cap = String(t); return Promise.resolve(); }, configurable: true });
    document.querySelector('#scv-qs-test').click();
    const start = Date.now();
    while (cap === null && Date.now() - start < 3000) await new Promise(r => setTimeout(r, 25));
    return cap;
  })()` }))?.result?.result?.value;
  let te = null; try { te = JSON.parse(testJson); } catch {}
  ok(te && te.line === line && te.expect === 'Beta button', `copy-as-test entry: line + expect from live text - got ${testJson}`);

  // harvesting out-of-flow root (position:fixed) must not collapse frame - pin :host to real box, force into flow
  await js(`(window.$kernel && window.$kernel.destroy(), true)`); // clean slate - prior sniper left menu/hover state
  await send('Runtime.evaluate', { expression: kernelSrc }); // fresh kernel for harvest sub-test
  // harvest resolves through clipboard, so intercept it - fixture has fixed-position root + escaped-colon icon rule
  const harvested = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '.fx{position:fixed;top:0;left:0;width:55px;height:120px;background:#000} '
      + String.fromCharCode(46) + 'i-ph' + String.fromCharCode(92, 58) + 'globe{--un-icon:url(data:image/svg+xml,%3Csvg%3E%3C/svg%3E);-webkit-mask:var(--un-icon);mask:var(--un-icon)}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<aside id="fx" class="fx"><span class="iconify i-ph:globe">i</span>x</aside>');
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: (t) => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => {
        while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('fx').click();
      })();
      setTimeout(() => resolve('__timeout__'), 3500);
    });
  })()` }))?.result?.result?.value;
  ok(typeof harvested === 'string' && harvested.includes('<style>'), 'harvest produced component');
  ok(/:host\s*\{[^}]*width:\s*55px[^}]*height:\s*120px/.test(harvested), ':host pinned to fixed element box (frame keeps real shape)');
  ok(/position:\s*relative\s*!important/.test(harvested), 'out-of-flow root forced back into flow (relative)');
  ok(/inset:\s*auto\s*!important/.test(harvested), 'root inset neutralized so it does not escape to origin');
  ok(harvested.includes('--un-icon'), 'escaped-colon icon rule (.i-ph\\:globe → --un-icon) survives, not mangled to broken selector');

  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const breakout = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '#bo::before{content:"</scr' + 'ipt><img src=x onerror=window.__pwned=1>"}'
      + ' #bo::after{content:"' + String.fromCharCode(92) + '2764"}'
      + ' #bo{width:30px;height:30px}';
    document.head.appendChild(st);
    // title carries backslash immediately before backtick - baked raw it would close def template literal early
    document.body.insertAdjacentHTML('beforeend', '<div id="bo" title="x' + String.fromCharCode(92) + String.fromCharCode(96) + ' end">b</div>');
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const armB = Date.now();
      (async () => {
        while (!window.$kernel.processes['harvester']?.active && Date.now() - armB < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('bo').click();
      })();
      setTimeout(() => resolve('__timeout__'), 3500);
    });
  })()` }))?.result?.result?.value;
  const bodyOnly = typeof breakout === 'string' ? breakout.slice(0, breakout.lastIndexOf('<\\/script>')) : '';
  ok(typeof breakout === 'string' && breakout.includes('<style>'), 'harvest produced component for breakout fixture');
  ok(!/<\/script/i.test(bodyOnly), 'page css cannot close artifact def script (</script is escaped)');
  // def is template literal; stray backslash from css must not corrupt it, or component silently fails to define
  const defBody = typeof breakout === 'string'
    ? breakout.slice(breakout.indexOf('data-scv-def>') + 'data-scv-def>'.length, breakout.lastIndexOf('<' + '/script>'))
    : '';
  let defParses = false; try { new Function(defBody); defParses = true; } catch (e) { defParses = e.message; }
  ok(defParses === true, `harvested def parses with css backslash escape in it (got ${defParses})`);

  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const purged = await js(`(() => {
    document.body.insertAdjacentHTML('beforeend',
      '<div id="pz"><script>window.__ran=1<\\/script>' +
      '<b id="pz_h" onclick="window.__click=1">h</b>' +
      '<a id="pz_a" href="https://elsewhere.example/leak">go</a>' +
      '<a id="pz_f" href="#frag">frag</a>' +
      '<form id="pz_fm" action="https://elsewhere.example/post">' +
      '<button id="pz_fa" formaction="javascript:window.__fa=1">go</button></form>' +
      // visible frames (offscreen but sized) stay - hostile srcdoc/js src neutralised in place
      '<iframe id="pz_sd" srcdoc="&lt;script&gt;parent.__sd=1&lt;/script&gt;" style="position:fixed;left:-9999px;width:60px;height:40px"></iframe>' +
      '<iframe id="pz_if" src="javascript:parent.__if=1" style="position:fixed;left:-9999px;width:60px;height:40px"></iframe>' +
      // 0x0 frame shows nothing, only phones home - purge removes whole
      '<iframe id="pz_hid" src="about:blank" width="0" height="0"></iframe>' +
      // kept frame only loads real remote page - data: src (script) stripped, http(s) src stays
      '<iframe id="pz_data" src="data:text/html,x" style="position:fixed;left:-9999px;width:60px;height:40px"></iframe>' +
      '<iframe id="pz_http" src="https://beacon.invalid/ok" style="position:fixed;left:-9999px;width:60px;height:40px"></iframe>' +
      // visible object still stripped - only <iframe> keeps visible-embed pass
      '<object id="pz_obj" data="https://beacon.invalid/o.html" style="position:fixed;left:-9999px;width:50px;height:50px"></object>' +
      // hidden so no paint layer added - backdrop fixtures below sample stack at a point
      '<div style="display:none">' +
      '<a id="pz_js" href="javascript:window.__js=1">js link</a>' +
      '<svg width=8 height=8><a id="pz_svg" xlink:href="javascript:window.__svg=1"><circle r=3/></a></svg>' +
      '<link id="pz_lnk" rel="preload" as="image" href="https://beacon.invalid/pl.png">' +
      '<base id="pz_base" href="https://beacon.invalid/base/">' +
      '<meta id="pz_meta" http-equiv="refresh" content="9999;url=https://beacon.invalid/r">' +
      '<style id="pz_sty">@import url(https://beacon.invalid/imp.css); .zz{color:red;background:url(https://beacon.invalid/bg.png)}</style>' +
      '<svg width=10 height=10><image id="pz_svgimg" href="https://beacon.invalid/i.png" width=10 height=10/></svg>' +
      '<input type="image" id="pz_iimg" src="https://beacon.invalid/ii.png">' +
      '<video id="pz_vid" width=20 height=20><track id="pz_trk" src="https://beacon.invalid/t.vtt" default></video>' +
      '<table id="pz_tbl" background="https://beacon.invalid/tb.png"><tr><td>c</td></tr></table>' +
      '<svg width=10 height=10><filter id="pz_flt"><feImage id="pz_fei" href="https://beacon.invalid/fe.png"/></filter></svg>' +
      '<portal id="pz_portal" src="https://beacon.invalid/p.html"></portal></div></div>');
    window.$kernel.run('scavenge-tree');
    return true;
  })()`);
  await pollUntil(async () => await js(`!!document.querySelector('.scv-grp-btn[data-action="purge"]')`));
  await js(`(() => {
    const b = [...document.querySelectorAll('.scv-grp-btn[data-action="purge"]')].find(x => x.dataset.sel.includes('pz') || x.dataset.sel === '#pz');
    if (b) b.click();
    return !!b;
  })()`);
  const after = await js(`(() => {
    const z = document.getElementById('pz');
    return {
      scripts: z.querySelectorAll('script').length,
      onclick: document.getElementById('pz_h').hasAttribute('onclick'),
      href: document.getElementById('pz_a').getAttribute('href'),
      kept: document.getElementById('pz_a').dataset.origHref,
      frag: document.getElementById('pz_f').getAttribute('href'),
      action: document.getElementById('pz_fm').getAttribute('action'),
      jsHref: document.getElementById('pz_js').getAttribute('href'),
      jsKept: document.getElementById('pz_js').dataset.origHref,
      formAction: document.getElementById('pz_fa').getAttribute('formaction'),
      srcdoc: document.getElementById('pz_sd').getAttribute('srcdoc'),
      frameSrc: document.getElementById('pz_if').getAttribute('src'),
      hidRemoved: !document.getElementById('pz_hid'),
      visFrameKept: !!document.getElementById('pz_sd') && !!document.getElementById('pz_if'),
      objRemoved: !document.getElementById('pz_obj'),
      linkRemoved: !document.getElementById('pz_lnk'),
      baseRemoved: !document.getElementById('pz_base'),
      metaRemoved: !document.getElementById('pz_meta'),
      styleBeacon: (document.getElementById('pz_sty')?.textContent || '').includes('beacon.invalid'),
      styleLocalKept: (document.getElementById('pz_sty')?.textContent || '').includes('color:red'),
      svgImgHref: document.getElementById('pz_svgimg')?.getAttribute('href') || document.getElementById('pz_svgimg')?.getAttribute('xlink:href') || null,
      inputImgSrc: document.getElementById('pz_iimg')?.getAttribute('src') || null,
      trackSrc: document.getElementById('pz_trk')?.getAttribute('src') || null,
      tableBg: document.getElementById('pz_tbl')?.getAttribute('background') || null,
      feImageHref: document.getElementById('pz_fei')?.getAttribute('href') || document.getElementById('pz_fei')?.getAttribute('xlink:href') || null,
      dataFrameSrc: document.getElementById('pz_data')?.getAttribute('src') || null,
      dataFrameKept: !!document.getElementById('pz_data'),
      httpFrameSrc: document.getElementById('pz_http')?.getAttribute('src') || null,
      portalGone: !document.getElementById('pz_portal'),
      svgXlink: (() => { const a = document.getElementById('pz_svg'); return a ? (a.getAttributeNS('http://www.w3.org/1999/xlink','href') || a.getAttribute('xlink:href')) : 'no-a'; })(),
      svgXlinkKept: document.getElementById('pz_svg')?.dataset.origHref,
    };
  })()`);
  ok(after && after.scripts === 0, `purge removes script elements (${after && after.scripts} left)`);
  ok(after && after.onclick === false, 'purge strips inline on* handlers');
  ok(after && after.href === 'javascript:void(0);', `purge neutralizes outbound href (${after && after.href})`);
  ok(after && after.kept === 'https://elsewhere.example/leak', 'purge keeps original href on data-orig-href');
  ok(after && after.frag === '#frag', `purge leaves in-page fragment links alone (${after && after.frag})`);
  ok(after && after.action === 'javascript:void(0);', `purge neutralizes form action (${after && after.action})`);
  // javascript: href used to be skipped, purge defused benign links and let hostile ones through
  ok(after && after.jsHref === 'javascript:void(0);', `purge neutralizes javascript: href too (${after && after.jsHref})`);
  ok(after && after.jsKept === 'javascript:window.__js=1', 'javascript: url it replaced is kept inertly on data-orig-href');
  ok(after && after.formAction === 'javascript:void(0);', `purge neutralizes formaction (${after && after.formAction})`);
  ok(after && !after.srcdoc, `purge drops iframe srcdoc - inline document runs its scripts in host (${JSON.stringify(after && after.srcdoc)})`);
  ok(after && after.frameSrc === null, `purge drops javascript: frame src (${JSON.stringify(after && after.frameSrc)})`);
  // 0x0 frame is a beacon - removed whole; frame user can see is content - kept de-fanged
  ok(after && after.hidRemoved, 'purge removes invisible (0x0) iframe whole');
  ok(after && after.visFrameKept, 'purge keeps visible iframe');
  // beacons that phone home from component with nothing user chose - all removed
  ok(after && after.objRemoved, 'purge strips <object> even when visible - only <iframe> keeps visible-embed pass');
  ok(after && after.linkRemoved, 'purge strips <link> - stylesheet/preload/prefetch/dns-prefetch all phone home');
  ok(after && after.baseRemoved, 'purge strips <base> - it rewrites every relative url');
  ok(after && after.metaRemoved, 'purge strips refresh <meta> - it redirects page');
  ok(after && !after.styleBeacon, 'purge strips @import and off-origin url() from inline <style> - both fetch remote');
  ok(after && after.styleLocalKept, 'purge keeps local rules in inline <style> - only remote refs go');
  ok(after && !after.svgImgHref, 'purge drops off-origin svg <image> href - <img> strip never saw it');
  ok(after && !after.inputImgSrc, 'purge drops off-origin input[type=image] src');
  ok(after && !after.trackSrc, 'purge drops off-origin <track> src');
  ok(after && !after.tableBg, 'purge drops deprecated off-origin background= attribute');
  ok(after && !after.feImageHref, 'purge drops off-origin svg <feImage> href');
  ok(after && after.dataFrameKept && !after.dataFrameSrc, 'purge strips data: src from kept iframe - only real remote page may load');
  ok(after && after.httpFrameSrc === 'https://beacon.invalid/ok', 'purge keeps http(s) src on visible iframe - real embed still loads');
  ok(after && after.portalGone, 'purge removes <portal> - iframe-like frame with no place in component');
  // a[href] never catches svg, so javascript: url is neutralised
  ok(after && after.svgXlink === 'javascript:void(0);', `purge neutralizes svg xlink:href too (${after && after.svgXlink})`);
  ok(after && after.svgXlinkKept === 'javascript:window.__svg=1', 'svg xlink url it replaced is kept inertly on data-orig-href');
  // fixture page runs srcdoc on insert, so clear flags and try to trigger what purge left behind
  const stillInert = await js(`(() => { window.__js = window.__sd = window.__if = window.__fa = 0;
    document.getElementById('pz_js').click();
    document.getElementById('pz_fa').click();
    return !window.__js && !window.__sd && !window.__if && !window.__fa; })()`);
  ok(stillInert, 'clicking what purge left behind executes nothing');

  const tplPurge = await js(`(() => {
    document.body.insertAdjacentHTML('beforeend',
      '<div id="pt"><template><img src="x" onerror="window.__tp=1">' +
      '<scr' + 'ipt>window.__ts=1<\\/scr' + 'ipt><i onclick="window.__tc=1">x</i></template></div>');
    const b = [...document.querySelectorAll('.scv-grp-btn[data-action="purge"]')];
    window.$kernel.stop('scavenge-tree'); window.$kernel.run('scavenge-tree');
    return true;
  })()`);
  await pollUntil(async () => await js(`[...document.querySelectorAll('.scv-grp-btn[data-action="purge"]')].some(b => b.dataset.sel.includes('pt'))`));
  await js(`[...document.querySelectorAll('.scv-grp-btn[data-action="purge"]')].find(b => b.dataset.sel.includes('pt')).click(); true`);
  const tp = await js(`(() => {
    const t = document.querySelector('#pt template');
    return { onerror: !!t.content.querySelector('img[onerror]'), script: !!t.content.querySelector('script'), onclick: !!t.content.querySelector('i[onclick]') };
  })()`);
  ok(tp && tp.script === false, 'purge removes script nested inside template');
  ok(tp && tp.onerror === false && tp.onclick === false, `purge strips on* handlers inside template (${JSON.stringify(tp)})`);

  await js(`(() => {
    customElements.define('x-purgesh', class extends HTMLElement { connectedCallback() { if (this.shadowRoot) return;
      this.attachShadow({ mode: 'open' }).innerHTML = '<img src="x" onerror="window.__sp=1"><i onclick="window.__sc=1">s</i>'; } });
    document.body.insertAdjacentHTML('beforeend', '<div id="psh"><x-purgesh></x-purgesh></div>');
    window.$kernel.stop('scavenge-tree'); window.$kernel.run('scavenge-tree');
    return true;
  })()`);
  await pollUntil(async () => await js(`[...document.querySelectorAll('.scv-grp-btn[data-action="purge"]')].some(b => b.dataset.sel.includes('psh'))`));
  await js(`[...document.querySelectorAll('.scv-grp-btn[data-action="purge"]')].find(b => b.dataset.sel.includes('psh')).click(); true`);
  const sh = await js(`(() => {
    const sr = document.querySelector('x-purgesh').shadowRoot;
    return { onerror: !!sr.querySelector('img[onerror]'), onclick: !!sr.querySelector('i[onclick]') };
  })()`);
  ok(sh && sh.onerror === false && sh.onclick === false, `purge strips on* handlers inside shadow root (${JSON.stringify(sh)})`);

  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  await js(`(() => {
    document.body.insertAdjacentHTML('beforeend',
      '<ul id="sib"><li>one</li><li>two</li><li>three</li></ul>');
    window.$kernel.run('scavenge-tree');
    return true;
  })()`);
  await pollUntil(async () => await js(`!!document.querySelector('.scv-grp-btn[data-action="copy"]')`));
  const sel = await js(`(() => {
    const lis = [...document.querySelectorAll('#sib li')];
    const sels = lis.map(li => {
      const row = [...document.querySelectorAll('.scv-tree-row')].find(r => { try { return document.querySelector(r.dataset.ref) === li; } catch { return false; } });
      return row ? row.dataset.ref : null;
    });
    return { sels, unique: new Set(sels).size === 3, resolves: sels.every((s, i) => { try { return document.querySelector(s) === lis[i]; } catch { return false; } }) };
  })()`);
  ok(sel && sel.unique, `sibling elements of same tag get distinct selectors (${JSON.stringify(sel && sel.sels)})`);
  ok(sel && sel.resolves, 'each generated selector resolves back to element it came from');

  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  await js(`window.$kernel.minimize(); true`);
  await pollUntil(async () => await js(`!!document.getElementById('scv-min-dot')`));
  const mini = await js(`({
    dot: !!document.getElementById('scv-min-dot'),
    mounted: !!document.getElementById('scv-min-dot')?.isConnected,
    paletteGone: !document.getElementById('scv-master-wrapper'),
  })`);
  ok(mini && mini.dot && mini.mounted, 'minimize leaves mounted dot to summon from');
  ok(mini && mini.paletteGone, 'minimize unmounts palette wrapper');
  await js(`document.getElementById('scv-min-dot').click(); true`);
  await pollUntil(async () => await js(`!!document.querySelector('.scv-palette')`));
  const back = await js(`({
    palette: !!document.querySelector('.scv-palette'),
    dotGone: !document.getElementById('scv-min-dot'),
    seed: document.getElementById('scv-pal-input')?.value,
  })`);
  ok(back && back.palette && back.dotGone, 'clicking dot restores palette and drops dot');
  ok(back && back.seed === '', `summoning by click does not paste event into search box (got ${JSON.stringify(back && back.seed)})`);

  const rollback = await js(`(() => {
    window.$kernel.register({ id: 'boom', label: 'boom', type: 'toggle', start: () => { window.$kernel.bus.on('click', 'boom', () => {}); throw new Error('nope'); } });
    let threw = false;
    try { window.$kernel.start('boom'); } catch { threw = true; }
    return { threw, active: window.$kernel.processes['boom'].active, subs: (window.$kernel.bus.subscribers['click'] || []).filter(s => s.id === 'boom').length };
  })()`);
  ok(rollback && rollback.threw, 'throwing start() surfaces error to caller');
  ok(rollback && rollback.active === false, 'tool whose start() threw is not left marked active');
  ok(rollback && rollback.subs === 0, `tool whose start() threw leaves no bus subscriptions behind (${rollback && rollback.subs})`);

  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const quant = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '#qw{width:257px;display:flex} #qw > i{flex:1 1 0;height:11px;background:#123}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="qw"><i></i><i></i><i></i></div>');
    const live = getComputedStyle(document.querySelector('#qw > i')).width;
    const h = await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const a = Date.now();
      (async () => {
        while (!window.$kernel.processes['harvester']?.active && Date.now() - a < 2000) await new Promise(r => setTimeout(r, 10));
        document.querySelector('#qw > i').click();
      })();
      setTimeout(() => resolve('__timeout__'), 3500);
    });
    return { live, baked: (h.match(/[^-]width:\\s*([\\d.]+)px/) || [])[1] };
  })()` }))?.result?.result?.value;
  const q64 = quant && quant.baked !== undefined && Number.isInteger(Math.round(parseFloat(quant.baked) * 64)) && Math.abs(parseFloat(quant.baked) * 64 - Math.round(parseFloat(quant.baked) * 64)) < 1e-9;
  ok(quant && /\.\d/.test(quant.live), `fixture really produced fractional width (live ${quant && quant.live})`);
  ok(q64, `baked width is snapped to exact 1/64px multiple (live ${quant && quant.live}, baked ${quant && quant.baked}px)`);

  // specificity-collapse: high-specificity 0!important that wins live must not lose to source-later 1px!important once flattened
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const phantom = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    // preflight (border solid everywhere), then trap: id+class 0!important earlier, bare class 1px!important later
    st.textContent = '*{box-sizing:border-box;border:0 solid #888} #nav.item{border-bottom-width:0px !important} .item{border-bottom-width:1px !important} #host{width:120px}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="host"><a id="nav" class="item">x</a></div>');
    const liveBottom = getComputedStyle(document.getElementById('nav')).borderBottomWidth;
    const h = await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: (t) => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm2 = Date.now();
      (async () => {
        while (!window.$kernel.processes['harvester']?.active && Date.now() - arm2 < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('host').click();
      })();
      setTimeout(() => resolve('__timeout__'), 3500);
    });
    window.$kernel.destroy();
    const box = document.createElement('div'); document.body.appendChild(box);
    box.innerHTML = h;
    box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
    const settleStart = Date.now();
    while (!document.querySelector('[data-scv-component]')?.shadowRoot?.querySelector('a') && Date.now() - settleStart < 2000) await new Promise(r => setTimeout(r, 25));
    const comp = document.querySelector('[data-scv-component]');
    const a = comp && comp.shadowRoot && comp.shadowRoot.querySelector('a');
    return { live: liveBottom, harvested: a ? getComputedStyle(a).borderBottomWidth : null };
  })()` }))?.result?.result?.value;
  ok(phantom && parseFloat(phantom.live) < 0.5, `fixture sanity: live nav bottom border is 0 (specificity wins) - got ${phantom && phantom.live}`);
  ok(phantom && parseFloat(phantom.harvested) < 0.5, `harvested nav has NO phantom bottom border (specificity collapse pinned to computed) - got ${phantom && phantom.harvested}`);

  // harvest fidelity: structural pseudo must stay match-time filter (stripping leaks rule to siblings), live form state must ride along, box sizing must not be forced
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const fidelity = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = 'table.f{border-collapse:collapse} table.f td{border:1px solid #999;padding:3px}'
      + ' table.f tr:nth-child(2) td{background:rgb(255,255,221)}'
      + ' .fbox{box-sizing:content-box;width:100px;padding:10px;border:5px solid #000}' // removes global border
      // frameworks ship almost everything inside @layer/@supports - ::before only walker reaches proves we descend
      + ' @layer base { .flayer::before { content: "LAYERED"; color: rgb(1,2,3); } .fsvg { width: 11px; height: 11px; vertical-align: middle; } }'
      + ' @supports (display: grid) { .fsup { outline: 3px solid rgb(4,5,6); } }'
      // reset lives on * selector walker skips, so only computed diff can carry it - and only if probe has href
      + ' * { text-decoration-line: none; }'
      // ffake applied below so src is fetched - server answers text/html, must not inline as font
      + ' @font-face { font-family: ffake; src: url("/not-a-font.woff2") format("woff2"); }'
      + ' @font-face { font-family: funused; src: url("/unused.woff2") format("woff2"); }' // no element uses it - must not ship
      + ' .ffont { font-family: ffake, sans-serif; }';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend',
      '<div id="fx2"><table class="f"><tbody><tr><td id="r1c1">a</td></tr><tr><td id="r2c1">b</td></tr></tbody></table>'
      + '<div class="fbox" id="fbox">box</div><input id="fi" value="attr"><input type="checkbox" id="fc">'
      + '<div class="flayer">L</div><div class="fsup">S</div><a class="flink" href="/somewhere">link</a><div class="ffont">F</div>'
      + '<svg class="fsvg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></div>');
    document.getElementById('fi').value = 'typed-live'; // property only - not attribute
    document.getElementById('fc').checked = true;
    const liveBoxW = document.getElementById('fbox').getBoundingClientRect().width;
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve({ html: String(t), liveBoxW }); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => {
        while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('fx2').click();
      })();
      setTimeout(() => resolve({ html: '__timeout__', liveBoxW }), 3500);
    });
  })()` }))?.result?.result?.value;
  ok(fidelity && fidelity.html !== '__timeout__', 'fidelity fixture harvested');
  if (fidelity && fidelity.html !== '__timeout__') {
    const rendered = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const box = document.createElement('div'); document.body.appendChild(box);
      box.innerHTML = ${JSON.stringify(fidelity.html)};
      box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
      await new Promise(r => setTimeout(r, 250));
      const host = box.querySelector('[data-scv-component]'), sr = host && host.shadowRoot; // scope to this box - earlier harvest tests left their own components on page
      if (!sr) return { err: 'no shadow' };
      const tds = [...sr.querySelectorAll('td')];
      const fb = sr.querySelector('div[class]:not([class*="scv-"]), .fbox') || [...sr.querySelectorAll('div')].find(d => d.textContent === 'box');
      const inp = [...sr.querySelectorAll('input')];
      const layered = [...sr.querySelectorAll('div')].find(d => d.textContent === 'L');
      const supped = [...sr.querySelectorAll('div')].find(d => d.textContent === 'S');
      const link = sr.querySelector('a');
      const svg = sr.querySelector('svg');
      return {
        row1Bg: tds[0] ? getComputedStyle(tds[0]).backgroundColor : null,
        row2Bg: tds[1] ? getComputedStyle(tds[1]).backgroundColor : null,
        boxW: fb ? fb.getBoundingClientRect().width : null,
        textVal: inp[0] ? inp[0].value : null,
        checked: inp[1] ? inp[1].checked : null,
        layerBefore: layered ? getComputedStyle(layered, '::before').content : null,
        supOutline: supped ? getComputedStyle(supped).outlineColor : null,
        linkDecoration: link ? getComputedStyle(link).textDecorationLine : null,
        svgClass: svg ? svg.getAttribute('class') : null,
        svgW: svg ? getComputedStyle(svg).width : null,
      };
    })()` }))?.result?.result?.value;
    ok(rendered && rendered.row2Bg === 'rgb(255, 255, 221)', `:nth-child(2) rule still reaches row it targets (got ${JSON.stringify(rendered)})`);
    ok(rendered && rendered.row1Bg !== 'rgb(255, 255, 221)', `:nth-child(2) rule does not leak onto row 1 - structural pseudos stay match-time filters (got ${JSON.stringify(rendered)})`);
    ok(rendered && Math.abs(rendered.boxW - fidelity.liveBoxW) <= 1, `content-box element keeps live width, box-sizing is not forced to border-box (live ${fidelity.liveBoxW} vs harvest ${rendered && rendered.boxW})`);
    ok(rendered && rendered.textVal === 'typed-live', `typed input value rides along with harvest (got ${JSON.stringify(rendered && rendered.textVal)})`);
    ok(rendered && rendered.checked === true, `checked box rides along with harvest (got ${JSON.stringify(rendered && rendered.checked)})`);
    ok(rendered && /LAYERED/.test(rendered.layerBefore || ''), `::before declared inside @layer survives - rule walker descends grouping rules (got ${JSON.stringify(rendered && rendered.layerBefore)})`);
    ok(rendered && rendered.supOutline === 'rgb(4, 5, 6)', `rule inside matching @supports survives (got ${JSON.stringify(rendered && rendered.supOutline)})`);
    ok(rendered && rendered.linkDecoration === 'none', `a[href] keeps text-decoration reset - default probe carries href, ua link styling is not mistaken for default (got ${JSON.stringify(rendered && rendered.linkDecoration)})`);
    ok(rendered && /^scv-/.test(rendered.svgClass || ''), `svg node gets flat class - className is read-only on svg, so must be set via setAttribute (got ${JSON.stringify(rendered && rendered.svgClass)})`);
    ok(rendered && rendered.svgW === '11px', `svg keeps styled size instead of falling back to intrinsic (got ${JSON.stringify(rendered && rendered.svgW)})`);
    ok(fidelity && !/data:text\/html/.test(fidelity.html), '@font-face src that answers text/html is not inlined as font');
    ok(fidelity && /font-family:\s*ffake/i.test(fidelity.html), '@font-face for family subtree renders with is kept');
    ok(fidelity && !/funused/i.test(fidelity.html), '@font-face no element uses is dropped - pages ship megabytes of webfonts');

  // rem/vw resolve against document root and viewport - patchbay renders at 13px, copied 1rem shrinks
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const ctxDep = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '.cdep{font-size:2rem;padding:1rem;width:calc(10rem + 2vw);margin:1rem} .cdkid{margin-bottom:1rem !important}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="cdep" class="cdep">ctx<div class="cdkid" id="cdkid">kid</div></div>');
    const c = getComputedStyle(document.getElementById('cdep'));
    const live = { fs: c.fontSize, pad: c.paddingLeft, w: c.width, mb: getComputedStyle(document.getElementById('cdkid')).marginBottom };
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve({ html: String(t), live }); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('cdep').click(); })();
      setTimeout(() => resolve({ html: '__timeout__', live }), 3500);
    });
  })()` }))?.result?.result?.value;
  // @font-face inert in shadow root, registers document-side only - and bare component carries backdrop
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const shipped = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '@font-face{font-family:HvFont;src:url("data:font/woff2;base64,AAAA") format("woff2")}'
      + ' #hvwrap{background:rgb(7,8,9)} .hvkid{font-family:HvFont,serif;background:rgba(0,0,0,0)}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="hvwrap"><div class="hvkid" id="hvkid">glyphs</div></div>');
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('hvkid').click(); })();
      setTimeout(() => resolve('__timeout__'), 3500);
    });
  })()` }))?.result?.result?.value;
  ok(shipped && shipped !== '__timeout__', 'font/backdrop fixture harvested');
  if (shipped && shipped !== '__timeout__') {
    const applied = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const box = document.createElement('div'); document.body.appendChild(box);
      box.innerHTML = ${JSON.stringify(shipped)};
      box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
      await new Promise(r => setTimeout(r, 250));
      const host = box.querySelector('[data-scv-component]');
      return { registered: [...document.fonts].some(f => f.family === 'HvFont'),
               inShadow: /@font-face/.test(host?.shadowRoot?.querySelector('style')?.textContent || ''),
               hostBg: host ? getComputedStyle(host).backgroundColor : null };
    })()` }))?.result?.result?.value;
    ok(applied && applied.registered, `@font-face component needs is shipped document-side where it registers (got ${JSON.stringify(applied)})`);
    ok(applied && !applied.inShadow, `@font-face not left in shadow stylesheet, where browser ignores it (got ${JSON.stringify(applied)})`);
    ok(applied && applied.hostBg === 'rgb(7, 8, 9)', `transparent component carries backdrop (got ${JSON.stringify(applied && applied.hostBg)})`);
  }

  // backdrop is whatever painted behind, often gradient on parent ::after - re-anchored it paints other colours
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const grad = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '#gdouter{background:rgb(9,80,7)}' // gradient sits on wrapper's ::after with solid below it
      + ' #gdwrap{position:relative;width:400px;height:200px}'
      + ' #gdwrap::after{content:"";position:absolute;inset:0;z-index:-1;background-image:linear-gradient(to right,rgba(0,0,255,.5),rgba(255,0,0,.5))}'
      + ' .gdkid{position:absolute;left:200px;top:80px;width:100px;height:40px;background:rgba(0,0,0,0)}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="gdouter"><div id="gdwrap"><div class="gdkid" id="gdkid">g</div></div></div>');
    await new Promise(r => setTimeout(r, 60));
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('gdkid').click(); })();
      setTimeout(() => resolve('__timeout__'), 4000);
    });
  })()` }))?.result?.result?.value;
  ok(grad && grad !== '__timeout__', 'gradient-backdrop fixture harvested');
  if (grad && grad !== '__timeout__') {
    const host = (grad.match(/:host\s*\{[^}]*\}/g) || []).join(' ');
    ok(/background-image:\s*linear-gradient/.test(host), `gradient painted by ancestor's ::after is carried as backdrop (host: ${host.slice(0, 90)})`);
    ok(/background-size:\s*400px 200px/.test(host), `gradient keeps size of box that drew it (got ${(host.match(/background-size:[^;]*/) || [''])[0]})`);
    ok(/background-position:\s*-200px -80px/.test(host), `offset to slice component sat on, not restarted at its corner (got ${(host.match(/background-position:[^;]*/) || [''])[0]})`);
    ok(/background-color:\s*rgb\(9, 80, 7\)/.test(host), `gradient with alpha keeps solid under it - alone composites over whatever copy lands on (got ${(host.match(/background-color:[^;]*/) || [''])[0]})`);
  }

  // three ways it renders wrong with every node present - sprite left behind, !important utility, unstyled nested shadow
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const deep = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '.util{display:inline-block !important} @media (min-width:1px){.util{display:block !important}}'; // query matched at capture, so block is what showed
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend',
      '<svg id="dpsprite" width="0" height="0"><symbol id="dpicon" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></symbol></svg>' +
      '<div id="dpwrap"><span class="util" id="dputil">u</span>' +
      '<svg width="20" height="20"><use href="#dpicon"/></svg>' +
      '<div id="dphost"></div></div>');
    const sh = document.getElementById('dphost').attachShadow({ mode: 'open' });
    sh.innerHTML = '<style>:host > button{color:rgb(9,80,7)}</style><button>b</button>'; // flattened, button no longer direct child so rule stops matching
    await new Promise(r => setTimeout(r, 60));
    const live = { util: getComputedStyle(document.getElementById('dputil')).display,
                   btn: getComputedStyle(sh.querySelector('button')).color };
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve({ html: String(t), live }); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('dpwrap').click(); })();
      setTimeout(() => resolve({ html: '__timeout__', live }), 4500);
    });
  })()` }))?.result?.result?.value;
  ok(deep && deep.html !== '__timeout__', 'sprite/important/nested-shadow fixture harvested');
  if (deep && deep.html !== '__timeout__') {
    const drawn = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const box = document.createElement('div'); document.body.appendChild(box);
      box.innerHTML = ${JSON.stringify(deep.html)};
      box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
      await new Promise(r => setTimeout(r, 250));
      const sr = box.querySelector('[data-scv-component]')?.shadowRoot;
      if (!sr) return { err: 'no component' };
      const use = sr.querySelector('use'), btn = sr.querySelector('button');
      const util = [...sr.querySelectorAll('*')].find(n => n.textContent === 'u' && n.tagName === 'SPAN');
      return { sprite: !!sr.querySelector('#dpicon'), useW: use ? Math.round(use.getBoundingClientRect().width) : -1,
               util: util ? getComputedStyle(util).display : null, btn: btn ? getComputedStyle(btn).color : null };
    })()` }))?.result?.result?.value;
    ok(drawn && drawn.sprite, `<symbol> <use> points at rides along, though it lived outside component (got ${JSON.stringify(drawn)})`);
    ok(drawn && drawn.useW > 0, `icon actually paints - <use> whose sprite stayed behind renders nothing (width ${drawn && drawn.useW})`);
    ok(drawn && drawn.util === deep.live.util, `resolved value outranks copied !important utility class (live ${deep.live.util} vs ${drawn && drawn.util})`);
    ok(drawn && drawn.btn === deep.live.btn, `nested shadow root's nodes get styled like every other node (live ${deep.live.btn} vs ${drawn && drawn.btn})`);
  }

  // cross-origin sheet throws on cssRules so webfonts vanish unless refetched - url() is relative to sheet, not page
  const cdn = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*'); // what real font cdn sends - makes refetch possible
    if (req.url === '/css/sheet.css') {
      res.setHeader('content-type', 'text/css');
      return res.end('@font-face{font-family:XoFont;src:url(sub/xo.woff2) format("woff2")} .xo::placeholder{color:rgb(9,9,9)}');
    }
    if (req.url === '/css/sub/xo.woff2') { res.setHeader('content-type', 'font/woff2'); return res.end(Buffer.from('wOF2fake-font-bytes')); }
    if (req.url === '/pic.png') {
      res.setHeader('content-type', 'image/png');
      return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    }
    if (req.url === '/nocors.css') { // sheet browser loads but script may not read or refetch, like csp-blocked font cdn
      res.removeHeader('access-control-allow-origin');
      res.setHeader('content-type', 'text/css');
      return res.end('.nocors{letter-spacing:0px}');
    }
    res.statusCode = 404; res.end('nope');
  });
  await new Promise(r => cdn.listen(0, '127.0.0.1', r));
  const cdnBase = `http://127.0.0.1:${cdn.address().port}`;

  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const xorigin = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '${cdnBase}/css/sheet.css';
    document.head.appendChild(l);
    const l2 = document.createElement('link'); l2.rel = 'stylesheet'; l2.href = '${cdnBase}/nocors.css';
    document.head.appendChild(l2);
    await new Promise(r => { l.onload = r; l.onerror = r; setTimeout(r, 2000); });
    await new Promise(r => { l2.onload = r; l2.onerror = r; setTimeout(r, 1500); });
    let denied = false; try { l.sheet.cssRules; } catch { denied = true; } // whole point - must be unreadable normal way
    const st = document.createElement('style');
    st.textContent = '.xo{font-family:XoFont,serif}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="xowrap"><input class="xo" id="xoel" placeholder="hi"></div>');
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve({ html: String(t), denied }); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('xowrap').click(); })();
      setTimeout(() => resolve({ html: '__timeout__', denied }), 4500);
    });
  })()` }))?.result?.result?.value;
  // harvesting <img> itself - querySelectorAll only looks down, so root src never inlined and artifact pointed home
  const imgRoot = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    document.body.insertAdjacentHTML('beforeend', '<img id="imgroot" src="${cdnBase}/pic.png" width="40" height="20">');
    const im = document.getElementById('imgroot');
    await new Promise(r => { if (im.complete) return r(); im.onload = r; im.onerror = r; setTimeout(r, 2000); });
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        im.click(); })();
      setTimeout(() => resolve('__timeout__'), 4000);
    });
  })()` }))?.result?.result?.value;
  // srcset outranks src, stale candidate list defeats inlined src and artifact renders nothing
  const ssRoot = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    document.body.insertAdjacentHTML('beforeend',
      '<div id="ssroot"><picture><source srcset="${cdnBase}/pic.png" media="(min-width: 1px)">'
      + '<img src="${cdnBase}/pic.png" width="8" height="8"></picture>'
      + '<img id="ssimg" srcset="${cdnBase}/pic.png 1x, ${cdnBase}/pic.png 2x" src="${cdnBase}/pic.png" width="8" height="8"></div>');
    const im = document.getElementById('ssimg');
    await new Promise(r => { if (im.complete) return r(); im.onload = r; im.onerror = r; setTimeout(r, 2000); });
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('ssroot').click(); })();
      setTimeout(() => resolve('__timeout__'), 4000);
    });
  })()` }))?.result?.result?.value;
  cdn.close();
  ok(ssRoot && ssRoot !== '__timeout__', 'picture/srcset fixture harvested');
  if (ssRoot && ssRoot !== '__timeout__') {
    ok(!/srcset=\\?"[^"\\]*\/pic\.png/.test(ssRoot), `srcset candidates inlined, none left pointing home (got ${(ssRoot.match(/srcset=\\?"[^"\\]{0,50}/) || [''])[0]})`);
    ok(/srcset=\\?"data:image\/png;base64,/.test(ssRoot), 'srcset rewritten to data: urls');
    ok(/2x/.test(ssRoot), 'srcset descriptors survive rewrite');
  }
  ok(imgRoot && imgRoot !== '__timeout__', 'image-root fixture harvested');
  if (imgRoot && imgRoot !== '__timeout__') {
    ok(/<img[^>]+src="data:image\/png;base64,/.test(imgRoot), `harvesting <img> inlines root's own src (got ${(imgRoot.match(/<img[^>]{0,60}/) || [''])[0]})`);
    ok(!imgRoot.includes('/pic.png'), 'leaves no link back to page it was taken from');
  }

  // image or media not inlined phones home and breaks offline, harvest drops it (renders broken box)
  const stripInput = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="stz" style="padding:8px">'
      + '<img id="szin" src="${cdnBase}/pic.png" width="20" height="10">'                                   // reachable + cors: inlines
      + '<img id="szout" src="https://beacon.invalid/pixel.png" width="8" height="8">'                       // unreachable: tracker pixel
      + '<video id="szvid" src="https://beacon.invalid/clip.mp4" poster="https://beacon.invalid/p.png" width="40"></video>' // media never inlines
      + '<b id="szbg" style="display:block;width:6px;height:6px;background-image:url(https://beacon.invalid/bg.png)">bg</b>' // css url() never inlines
      + '<a id="szpg" ping="https://beacon.invalid/ping" href="#z">p</a>'   // ping POSTs to third party on click
      + '<p>keep me</p></div>');
    const im = document.getElementById('szin');
    await new Promise(r => { if (im.complete && im.naturalWidth) return r(); im.onload = r; im.onerror = r; setTimeout(r, 2000); });
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10)); document.getElementById('stz').click(); })();
      setTimeout(() => resolve('__timeout__'), 5000);
    });
  })()` }))?.result?.result?.value;
  ok(stripInput && stripInput !== '__timeout__', 'strip fixture harvested');
  if (stripInput && stripInput !== '__timeout__') {
    ok(/data:image\/png;base64,/.test(stripInput), 'reachable image inlined and is kept');
    ok(stripInput.includes('keep me'), 'content is preserved');
    ok(!/beacon\.invalid\/pixel/.test(stripInput), 'un-inlinable image src is stripped, not shipped as beacon');
    ok(!/beacon\.invalid\/clip/.test(stripInput) && !/beacon\.invalid\/p\.png/.test(stripInput), 'un-inlinable video src and poster are stripped too - harvest never inlines media');
    ok(!/beacon\.invalid\/bg/.test(stripInput), 'un-inlinable css url() is dropped to none, not shipped as beacon');
    ok(!/beacon\.invalid\/ping/.test(stripInput) && !/\sping=/.test(stripInput), 'ping attribute is stripped - it POSTs to third party on click');
  }

  ok(xorigin && xorigin.html !== '__timeout__', 'cross-origin sheet fixture harvested');
  if (xorigin && xorigin.html !== '__timeout__') {
    ok(xorigin.denied, 'fixture sheet really is cross-origin (cssRules threw) - otherwise test proves nothing');
    ok(/@font-face[^}]*XoFont/.test(xorigin.html), 'webfont declared in cross-origin sheet recovered by refetching');
    ok(/XoFont[^}]*url\(["']?data:/.test(xorigin.html), `url() relative to sheet resolves against it and inlines, not against page (got ${(xorigin.html.match(/src:url\([^)]{0,40}/) || [''])[0]})`);
    ok(/::placeholder\s*\{[^}]*rgb\(9, 9, 9\)/.test(xorigin.html), 'pseudo-element rule from that sheet comes across too, not just fonts');
    // sheet we cannot read/refetch is opaque - importing phones home and breaks offline; dropped (host was never restyled by it)
    ok(!xorigin.html.includes('/nocors.css'), 'unreadable cross-origin sheet is dropped, not shipped as beacon');
    ok(!/@import\s+url\(/.test(xorigin.html), 'no @import of remote sheet survives into component');
    ok(!/scv-link-/.test(xorigin.html), 'nothing injected into host document on its behalf');
  }

  // query that missed at capture must not re-evaluate in paste target, baked currentColor inherits over child's
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  const ctxWin = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '.mqbox{display:block;color:rgb(10,20,30)} @media (max-width:800px){.mqbox{display:none}}'
      + ' .mqkid{color:rgb(0,0,0)}'; // black is what bare probe defaults to, nothing pins it and ancestor colour inherits
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="mqbox" class="mqbox">mq<span class="mqkid" id="mqkid">kid</span></div>');
    const kc = getComputedStyle(document.getElementById('mqkid'));
    const live = { d: getComputedStyle(document.getElementById('mqbox')).display, kidFill: kc.webkitTextFillColor, kidColor: kc.color };
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve({ html: String(t), live }); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('mqbox').click(); })();
      setTimeout(() => resolve({ html: '__timeout__', live }), 3500);
    });
  })()` }))?.result?.result?.value;
  await send('Emulation.setDeviceMetricsOverride', { width: 500, height: 800, deviceScaleFactor: 1, mobile: false }); // paste target narrower than capture
  ok(ctxWin && ctxWin.html !== '__timeout__', 'media/currentColor fixture harvested');
  if (ctxWin && ctxWin.html !== '__timeout__') {
    const won = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const box = document.createElement('div'); document.body.appendChild(box);
      box.innerHTML = ${JSON.stringify(ctxWin.html)};
      box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
      await new Promise(r => setTimeout(r, 250));
      const host = box.querySelector('[data-scv-component]'), sr = host && host.shadowRoot;
      const root = sr && [...sr.children].find(n => n.tagName !== 'STYLE');
      if (!root) return { err: 'no root' };
      const kid = sr.querySelector('span');
      return { d: getComputedStyle(root).display, kidFill: kid ? getComputedStyle(kid).webkitTextFillColor : null,
               kidColor: kid ? getComputedStyle(kid).color : null };
    })()` }))?.result?.result?.value;
    await send('Emulation.clearDeviceMetricsOverride');
    ok(won && won.d === ctxWin.live.d, `media rule that didn't match at capture does not overrule captured value in narrower target (live ${ctxWin.live.d} vs ${won && won.d})`);
    ok(won && won.kidColor === ctxWin.live.kidColor, `child keeps its color when rule declared it (live ${ctxWin.live.kidColor} vs ${won && won.kidColor})`);
    ok(won && won.kidFill === ctxWin.live.kidFill, `text-fill-color stays currentColor - one resolved and baked upstream inherits past child's own color (live ${ctxWin.live.kidFill} vs ${won && won.kidFill})`);
  }

  // pseudo carried copied rule text only - walker misses vanished, rem sized ::before re-resolved in target
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const pseudo = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '#pbwrap{position:relative;width:200px;height:60px}'
      + ' #pbwrap::before{content:"";display:block;width:4rem;height:1rem;background:rgb(3,4,5)}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="pbwrap">p</div>');
    await new Promise(r => setTimeout(r, 60));
    const pc = getComputedStyle(document.getElementById('pbwrap'), '::before');
    const live = { w: pc.width, h: pc.height, bg: pc.backgroundColor };
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve({ html: String(t), live }); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('pbwrap').click(); })();
      setTimeout(() => resolve({ html: '__timeout__', live }), 4000);
    });
  })()` }))?.result?.result?.value;
  ok(pseudo && pseudo.html !== '__timeout__', 'pseudo fixture harvested');
  if (pseudo && pseudo.html !== '__timeout__') {
    const drew = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      document.documentElement.style.fontSize = '13px'; // same root size patchbay renders at
      const box = document.createElement('div'); document.body.appendChild(box);
      box.innerHTML = ${JSON.stringify(pseudo.html)};
      box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
      await new Promise(r => setTimeout(r, 250));
      const sr = box.querySelector('[data-scv-component]')?.shadowRoot;
      const root = sr && [...sr.children].find(n => n.tagName !== 'STYLE');
      if (!root) return { err: 'no root' };
      const pc = getComputedStyle(root, '::before');
      const out = { w: pc.width, h: pc.height, bg: pc.backgroundColor };
      document.documentElement.style.fontSize = '';
      return out;
    })()` }))?.result?.result?.value;
    ok(drew && drew.bg === pseudo.live.bg, `::before survives at all (live ${pseudo.live.bg} vs ${drew && drew.bg})`);
    ok(drew && drew.w === pseudo.live.w, `and its rem width is baked, not re-resolved against target's root (live ${pseudo.live.w} vs ${drew && drew.w})`);
  }

  // fixed bar placed against viewport - in tall layout it must re-anchor to component bottom, not fold
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const fixedBar = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '#fbwrap{position:relative;height:1600px;width:300px;background:#eee}'
      + ' .fbar{position:fixed;bottom:0;left:0;right:0;height:40px;background:#123}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="fbwrap">tall<div class="fbar" id="fbar">bar</div></div>');
    await new Promise(r => setTimeout(r, 60));
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('fbwrap').click(); })();
      setTimeout(() => resolve('__timeout__'), 4000);
    });
  })()` }))?.result?.result?.value;
  ok(fixedBar && fixedBar !== '__timeout__', 'fixed-bar fixture harvested');
  if (fixedBar && fixedBar !== '__timeout__') {
    const placed = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const box = document.createElement('div'); document.body.appendChild(box);
      box.innerHTML = ${JSON.stringify(fixedBar)};
      box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
      await new Promise(r => setTimeout(r, 250));
      const sr = box.querySelector('[data-scv-component]')?.shadowRoot;
      const root = sr && [...sr.children].find(n => n.tagName !== 'STYLE');
      const bar = root && root.querySelector('div');
      if (!root || !bar) return { err: 'missing' };
      const rr = root.getBoundingClientRect(), br = bar.getBoundingClientRect();
      return { gap: Math.round(rr.bottom - br.bottom), pos: getComputedStyle(bar).position, rootH: Math.round(rr.height) };
    })()` }))?.result?.result?.value;
    ok(placed && placed.pos === 'absolute', `fixed bar stops being fixed, or it pins to viewport of whatever page hosts copy (got ${placed && placed.pos})`);
    ok(placed && Math.abs(placed.gap) <= 2, `and re-anchors to component's own bottom, not where fold was at capture (gap ${placed && placed.gap} of ${placed && placed.rootH})`);
  }

  // both end rendering nothing - rule losing on specificity wins by order once flat, floated root gives host zero height
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const flow = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const st = document.createElement('style');
    st.textContent = '#flowwrap .flowbox{display:table} .flowbox{display:none}' // hide rule loses on specificity live, wins by order once flattened
      + ' .flowbox{float:right;width:80px;height:60px;background:#123}';
    document.head.appendChild(st);
    document.body.insertAdjacentHTML('beforeend', '<div id="flowwrap"><table class="flowbox" id="flowel"><tbody><tr><td>f</td></tr></tbody></table></div>');
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve(String(t)); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('flowel').click(); })();
      setTimeout(() => resolve('__timeout__'), 3500);
    });
  })()` }))?.result?.result?.value;
  ok(flow && flow !== '__timeout__', 'out-of-flow fixture harvested');
  if (flow && flow !== '__timeout__') {
    const laid = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const box = document.createElement('div'); box.style.cssText = 'display:inline-block'; document.body.appendChild(box);
      box.innerHTML = ${JSON.stringify(flow)};
      box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
      await new Promise(r => setTimeout(r, 250));
      const host = box.querySelector('[data-scv-component]'), sr = host && host.shadowRoot;
      const root = sr && [...sr.children].find(n => n.tagName !== 'STYLE');
      if (!root) return { err: 'no root' };
      const hr = host.getBoundingClientRect(), c = getComputedStyle(root);
      return { hostH: Math.round(hr.height), disp: c.display, float: c.float };
    })()` }))?.result?.result?.value;
    ok(laid && laid.disp === 'table', `display:none rule that lost on specificity does not win once flattened - computed value is ground truth (got ${JSON.stringify(laid)})`);
    ok(laid && laid.float === 'none', `root's float is neutralized - it placed it against siblings we don't carry (got ${laid && laid.float})`);
    ok(laid && laid.hostH >= 55, `host measures root's real height, not zero from out-of-flow child (got ${laid && laid.hostH})`);
  }

  ok(ctxDep && ctxDep.html !== '__timeout__', 'context-dependent fixture harvested');
  if (ctxDep && ctxDep.html !== '__timeout__') {
    const reRendered = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      document.documentElement.style.fontSize = '13px'; // same root size patchbay renders at
      const box = document.createElement('div'); document.body.appendChild(box);
      box.innerHTML = ${JSON.stringify(ctxDep.html)};
      box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
      await new Promise(r => setTimeout(r, 250));
      const host = box.querySelector('[data-scv-component]'), sr = host && host.shadowRoot;
      const root = sr && [...sr.children].find(n => n.tagName !== 'STYLE');
      if (!root) return { err: 'no root' };
      const c = getComputedStyle(root);
      const kid = sr.querySelector('.cdkid') || [...sr.querySelectorAll('*')].find(n => n.textContent.trim() === 'kid');
      const out = { fs: c.fontSize, pad: c.paddingLeft, w: c.width, rootM: c.margin,
                    mb: kid ? getComputedStyle(kid).marginBottom : null };
      document.documentElement.style.fontSize = '';
      return out;
    })()` }))?.result?.result?.value;
    ok(reRendered && reRendered.fs === ctxDep.live.fs, `rem font-size survives 13px document root (live ${ctxDep.live.fs} vs ${reRendered && reRendered.fs})`);
    ok(reRendered && reRendered.pad === ctxDep.live.pad, `rem padding survives (live ${ctxDep.live.pad} vs ${reRendered && reRendered.pad})`);
    ok(reRendered && reRendered.w === ctxDep.live.w, `calc() mixing rem and vw survives (live ${ctxDep.live.w} vs ${reRendered && reRendered.w})`);
    ok(reRendered && reRendered.mb === ctxDep.live.mb, `!important rem margin survives on child - baked value carries same priority (live ${ctxDep.live.mb} vs ${reRendered && reRendered.mb})`);
    ok(reRendered && /^0px/.test(reRendered.rootM || ''), `root's own outer margin is dropped - spaced from siblings we don't carry, and inflates host wherever paste target traps it (got ${reRendered && reRendered.rootM})`);
  }
  }

  // probe has to sit in the context copy lands in - loose in iframe would inherit browser defaults, match live value by luck and bake nothing
  await js(`(window.$kernel && window.$kernel.destroy(), true)`);
  await send('Page.navigate', { url: url + 'quirks' });
  await waitEvent('Page.loadEventFired');
  await delay(200);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const quirkPage = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const live = { mode: document.compatMode,
                   body: getComputedStyle(document.body).fontSize,
                   table: getComputedStyle(document.getElementById('qt')).fontSize };
    return await new Promise(resolve => {
      Object.defineProperty(navigator.clipboard, 'writeText', { value: t => { resolve({ html: String(t), live }); return Promise.resolve(); }, configurable: true });
      window.$kernel.start('harvester');
      const arm = Date.now();
      (async () => { while (!window.$kernel.processes['harvester']?.active && Date.now() - arm < 2000) await new Promise(r => setTimeout(r, 10));
        document.getElementById('qwrap').click(); })();
      setTimeout(() => resolve({ html: '__timeout__', live }), 4000);
    });
  })()` }))?.result?.result?.value;
  await send('Page.navigate', { url }); // back to standards-mode document, which is what paste target is
  await waitEvent('Page.loadEventFired');
  await delay(200);
  ok(quirkPage && quirkPage.html !== '__timeout__', 'quirks-mode fixture harvested');
  if (quirkPage && quirkPage.html !== '__timeout__') {
    ok(quirkPage.live.mode === 'BackCompat' && quirkPage.live.table !== quirkPage.live.body,
       `fixture really diverges from inheritance (${quirkPage.live.mode}, body ${quirkPage.live.body} vs table ${quirkPage.live.table})`);
    const landed = (await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const box = document.createElement('div'); document.body.appendChild(box);
      box.innerHTML = ${JSON.stringify(quirkPage.html)};
      box.querySelectorAll('script').forEach(s => { const n = document.createElement('script'); n.textContent = s.textContent; document.body.appendChild(n); });
      await new Promise(r => setTimeout(r, 250));
      const t = box.querySelector('[data-scv-component]')?.shadowRoot?.querySelector('table');
      return { mode: document.compatMode, table: t ? getComputedStyle(t).fontSize : null };
    })()` }))?.result?.result?.value;
    ok(landed && landed.mode === 'CSS1Compat', 'copy renders in standards mode, or test proves nothing');
    ok(landed && landed.table === quirkPage.live.table,
       `value that diverges from what :host provides is baked, not left to re-resolve (live ${quirkPage.live.table} vs ${landed && landed.table})`);
  }

  // microkernel invariants: bus routing contract + start/stop/toggle lifecycle (fresh kernel so prior state can't skew)
  await js(`window.$kernel && window.$kernel.destroy(); true`);
  await send('Runtime.evaluate', { expression: kernelSrc });
  const micro = (await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const k = window.$kernel, bus = k.bus, out = {};
    // priority: higher prio fires first regardless of registration order
    const order = [];
    bus.on('t_ev', 'lo', () => order.push('lo'), 0);
    bus.on('t_ev', 'hi', () => order.push('hi'), 100);
    bus.on('t_ev', 'mid', () => order.push('mid'), 50);
    bus.emit('t_ev');
    out.prio = order.join(',');
    // throwing handler is caught - later handlers still run
    let reached = false;
    bus.on('t_err', 'boom', () => { throw new Error('x'); });
    bus.on('t_err', 'after', () => { reached = true; });
    bus.emit('t_err');
    out.survivedThrow = reached;
    // offAll(id) removes only that id's subscribers
    bus.on('t_scope', 'keep', () => {});
    bus.on('t_scope', 'drop', () => {});
    bus.offAll('drop');
    out.scoped = (bus.subscribers['t_scope'] || []).map(s => s.id).join(',');
    // lifecycle: probe tool whose start() returns teardown fn
    let started = 0, stopped = 0, tore = 0;
    k.register({ id: '__probe', label: 'p', start: () => { started++; return () => tore++; }, stop: () => { stopped++; } });
    k.start('__probe'); k.start('__probe'); // 2nd start: already active > no-op
    out.startOnce = started; out.activeAfterStart = k.processes['__probe'].active;
    k.stop('__probe'); k.stop('__probe'); // 2nd stop: not active > no-op
    out.stopOnce = stopped; out.teardownCalled = tore; out.activeAfterStop = k.processes['__probe'].active;
    k.toggle('__probe'); const mid = k.processes['__probe'].active;
    k.toggle('__probe'); const end = k.processes['__probe'].active;
    out.toggle = mid === true && end === false;
    return out;
  })()` }))?.result?.result?.value;
  ok(micro && micro.prio === 'hi,mid,lo', `bus fires handlers in priority order (got ${micro && micro.prio})`);
  ok(micro && micro.survivedThrow, 'throwing bus handler is caught - later handlers still run');
  ok(micro && micro.scoped === 'keep', `bus.offAll(id) unsubscribes only that id (got ${micro && micro.scoped})`);
  ok(micro && micro.startOnce === 1 && micro.activeAfterStart, 'kernel.start is no-op when already active');
  ok(micro && micro.stopOnce === 1 && !micro.activeAfterStop, 'kernel.stop is no-op when not active');
  ok(micro && micro.teardownCalled === 1, 'start() returning function has it run as teardown on stop');
  ok(micro && micro.toggle, 'kernel.toggle flips active via start/stop');

  // clean teardown: destroy() must leave nothing - no scv-* dom, no injected stylesheet, no $kernel, listeners released
  const teardown = await js(`(() => {
    window.$kernel && window.$kernel.destroy(); // clear any prior
    return null;
  })()`);
  await js(`(() => { document.querySelectorAll('[id^="scv-"]').forEach(n=>n.remove()); return true; })()`);
  await send('Runtime.evaluate', { expression: kernelSrc }); // fresh kernel
  const clean = (await send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    // arm several subsystems: palette (auto), page-tool sniper, grid, effect
    window.$kernel.start('xray'); window.$kernel.start('grid-h'); window.$kernel.start('el-sniper');
    window.$kernel.destroy();
    return {
      kernelGone: typeof window.$kernel === 'undefined',
      scvNodes: document.querySelectorAll('[id^="scv-"]').length,
      sysStyle: !!document.getElementById('scv-sys-styles'),
      bodyCursor: document.body.style.cursor, // el-sniper set crosshair; must be reset
    };
  })()` }))?.result?.result?.value;
  ok(clean && clean.kernelGone, 'destroy removes window.$kernel');
  ok(clean && clean.scvNodes === 0, `destroy leaves no scv-* dom nodes (found ${clean && clean.scvNodes})`);
  ok(clean && !clean.sysStyle, 'destroy removes injected sys stylesheet');
  ok(clean && !clean.bodyCursor, `destroy resets body cursor left by sniper (got ${JSON.stringify(clean && clean.bodyCursor)})`);
} catch (e) {
  fails++; console.log('  ✗ kernel tier threw:', e.message);
}

done();
console.log(fails ? `kernel: FAIL (${fails})` : 'kernel: PASS');
process.exit(fails ? 1 : 0);