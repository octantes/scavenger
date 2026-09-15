// fractal tier - dashboard (harvested component + wired node group) survives exports when re-harvested (nodes working)

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, rmSync } from 'fs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const pbUrl = pathToFileURL(join(here, '..', 'patchbay.html')).href;
const bm = readFileSync(join(here, '..', 'bookmarklet.js'), 'utf8').trim();
const decoded = decodeURIComponent(bm.slice('javascript:'.length));

// minimal self-contained harvested component, the shape kernel emits
const COMPONENT = '<scv-frtest data-scv-component></scv-frtest>'
  + '<script data-scv-def>if(!customElements.get(\'scv-frtest\')){customElements.define(\'scv-frtest\',class extends HTMLElement{constructor(){super();if(this.shadowRoot)return;this.attachShadow({mode:\'open\'}).innerHTML=\'<style>:host{display:block;width:40px;height:20px;background:#345}</style><div>x</div>\';}});}<\/script>';

const { pageWsUrl, cleanup } = await launchChrome();
const { ws, send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable'); await send('Runtime.enable');
const js = async (e, aw = false) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: aw }))?.result?.result?.value;
const load = async url => { await send('Page.navigate', { url }); await waitEvent('Page.loadEventFired'); await delay(700); };
const tmpFiles = [];
const done = () => { try { ws.close(); } catch {} cleanup(); tmpFiles.forEach(f => { try { rmSync(f, { force: true }); } catch {} }); };

try {
  // build patch - harvested component + wired two node group
  await load(pbUrl);
  const built = await js(`(() => {
    setMode('edit');
    handlePasteData(${JSON.stringify(COMPONENT)});
    const c = spawnLogicNode('clock', 120, 300), a = spawnLogicNode('accumulator', 300, 300);
    c.setAttribute('data-scv-emits', 'ch_tick'); a.setAttribute('data-scv-receives', 'ch_tick'); // real wiring
    invalidateCache();
    return { comps: document.querySelectorAll('.comp-wrapper').length, nodes: document.querySelectorAll('scv-logic').length };
  })()`);
  ok(built && built.nodes === 2, `board has two-node group (${built && built.nodes})`);
  ok(built && built.comps === 1, `board has harvested component (${built && built.comps})`);

  // capture exports
  const grab = async fn => await js(`(async () => { let c=null; const o=URL.createObjectURL; URL.createObjectURL=b=>{c=b;return 'blob:x';}; URL.revokeObjectURL=()=>{};
    try { await ${fn}(); } catch(e){ return 'ERR '+e.message; } URL.createObjectURL=o; return c?await c.text():'NO-BLOB'; })()`, true);

  for (const [kind, fn] of [['publish', 'exportPublish'], ['quine', 'saveQuine']]) {
    const html = await grab(fn);
    ok(typeof html === 'string' && html.length > 1000 && !html.startsWith('ERR'), `${kind} captured`);
    if (!html || html.startsWith('ERR') || html === 'NO-BLOB') continue;
    const path = join(here, `_fractal_${kind}.html`); writeFileSync(path, html); tmpFiles.push(path);

    // open exported dashboard - publish hides nodes, quine keeps them live
    await load(pathToFileURL(path).href);
    const inExport = await js(`(() => { const ns=[...document.querySelectorAll('scv-logic')];
      return { nodes: ns.length, anyVisible: ns.some(n => getComputedStyle(n).display !== 'none') }; })()`);
    ok(inExport && inExport.nodes === 2, `${kind} still carries two nodes (${inExport && inExport.nodes})`);
    if (kind === 'publish') ok(inExport && !inExport.anyVisible, 'publish hides its nodes (use mode)');

    // re-harvest board through bookmarklet path
    await js(`window.__clip=null; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:t=>{window.__clip=t;return Promise.resolve();}}}); true`);
    await send('Runtime.evaluate', { expression: decoded });
    await delay(700);
    await js(`(() => { const i=document.getElementById('scv-pal-input'); i.value='harvest'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
    await delay(500);
    await js(`(() => { const el=document.getElementById('canvas-container'); const r=el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:r.left+30,clientY:r.top+30})); return true; })()`);
    let clip = null;
    for (let i = 0; i < 45 && !clip; i++) { await delay(1000); clip = await js(`window.__clip`); }
    ok(clip && /<scv-logic/i.test(clip), `${kind} re-harvest carries node group (${clip ? clip.length + 'b' : 'no clip'})`);
    if (!clip) continue;

    // paste harvested dashboard into fresh patchbay - nodes must survive and be visible
    await load(pbUrl);
    const pasted = await js(`(() => { setMode('edit'); handlePasteData(${JSON.stringify(clip)});
      let sn=[], vis=0;
      document.querySelectorAll('[data-scv-component],[data-scv-id]').forEach(c=>{ if(c.shadowRoot){ const s=[...c.shadowRoot.querySelectorAll('scv-logic')]; sn.push(...s); s.forEach(n=>{ if(getComputedStyle(n).display!=='none') vis++; }); }});
      return { comps: document.querySelectorAll('.comp-wrapper').length, shadowNodes: sn.length, shadowVisible: vis }; })()`);
    ok(pasted && pasted.shadowNodes === 2, `${kind} paste keeps two nodes nested (${pasted && pasted.shadowNodes})`);
    ok(pasted && pasted.shadowVisible === 2, `${kind} publish-hidden nodes come back visible on paste (${pasted && pasted.shadowVisible})`);
  }
} catch (e) {
  fails++; console.log('  ✗ fractal tier threw:', e.message);
}

done();
console.log(fails ? `fractal: FAIL (${fails})` : 'fractal: PASS');
process.exit(fails ? 1 : 0);