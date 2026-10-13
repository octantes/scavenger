// fractal tier - patchbay (harvest + wired node pair) survives its exports and a re-harvest, nodes working

import { launchChrome, connect } from './_cdp.mjs';
import { pathToFileURL, fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, rmSync } from 'fs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
const delay = ms => new Promise(r => setTimeout(r, ms));
const here = dirname(fileURLToPath(import.meta.url));
const pbUrl = pathToFileURL(join(here, '..', 'patchbay-next.html')).href;
const bm = readFileSync(join(here, '..', 'bookmarklet.js'), 'utf8').trim();
const decoded = decodeURIComponent(bm.slice('javascript:'.length));

// minimal self-contained harvested component, the shape kernel emits
const COMPONENT = '<scv-frtest data-scv-component></scv-frtest>\n<script data-scv-def>\nif(!customElements.get(\'scv-frtest\')){\ncustomElements.define(\'scv-frtest\', class extends HTMLElement {\nconstructor() {\nsuper();\nif (this.shadowRoot) return;\nthis.attachShadow({mode: \'open\'}).innerHTML = `<style>:host{display:block;width:40px;height:20px;background:#345}</style><div>x</div>`;\n}\n});\n}\n<\/script>';

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
    const pb = document.querySelector('scv-patchbay');
    pb.import(${JSON.stringify(COMPONENT)}, { at: { x: 40, y: 40 } });
    const n = (type, x) => { const e = document.createElement('scv-logic'); e.dataset.type = type; e.style.left = x + 'px'; e.style.top = '200px'; pb.append(e); return e; };
    const c = n('clock', 120), a = n('accumulator', 300);
    c.setAttribute('value', '50'); c.setAttribute('data-scv-emits', 'ch_tick'); a.setAttribute('data-scv-receives', 'ch_tick');
    return { comps: pb.querySelectorAll('scv-item').length, nodes: pb.querySelectorAll('scv-logic').length };
  })()`);
  ok(built && built.nodes === 2, `board has two-node group (${built && built.nodes})`);
  ok(built && built.comps === 1, `board has harvested component (${built && built.comps})`);

  const grab = async kind => await js(`(async () => { try { return await (await document.querySelector('scv-patchbay').save('${kind}')).text(); } catch (e) { return 'ERR ' + e.message; } })()`, true);

  for (const kind of ['publish', 'quine']) {
    const html = await grab(kind);
    ok(typeof html === 'string' && html.length > 1000 && !html.startsWith('ERR'), `${kind} captured`);
    if (!html || html.startsWith('ERR')) continue;
    const path = join(here, `_fractal_${kind}.html`); writeFileSync(path, html); tmpFiles.push(path);

    // open exported patchbay - publish hides nodes, quine shows them in edit mode
    await load(pathToFileURL(path).href);
    const inExport = await js(`(() => { const ns = [...document.querySelectorAll('scv-logic')];
      return { nodes: ns.length, anyVisible: ns.some(n => getComputedStyle(n).display !== 'none') }; })()`);
    ok(inExport && inExport.nodes === 2, `${kind} still carries two nodes (${inExport && inExport.nodes})`);
    if (kind === 'publish') ok(inExport && !inExport.anyVisible, 'publish hides its nodes (use mode)');

    // re-harvest board through bookmarklet path
    await js(`window.__clip=null; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:t=>{window.__clip=t;return Promise.resolve();}}}); true`);
    await send('Runtime.evaluate', { expression: decoded });
    await delay(700);
    await js(`(() => { const i=document.getElementById('scv-pal-input'); i.value='harvest'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return true; })()`);
    await delay(500);
    await js(`(() => { const el = document.querySelector('scv-patchbay'), r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: r.left + 30, clientY: r.top + 30 })); return true; })()`);
    let clip = null;
    for (let i = 0; i < 45 && !clip; i++) { await delay(1000); clip = await js(`window.__clip`); }
    ok(clip && /<scv-logic/i.test(clip), `${kind} re-harvest carries node group (${clip ? clip.length + 'b' : 'no clip'})`);
    if (!clip) continue;

    // paste re-harvest into fresh patchbay - nodes come back real, visible and wired
    await load(pbUrl);
    const pasted = await js(`(async () => { const pb = document.querySelector('scv-patchbay'); pb.import(${JSON.stringify(clip)}, { at: { x: 100, y: 100 } });
      await new Promise(r => setTimeout(r, 300));
      const ns = [...pb.querySelectorAll('scv-item scv-logic')], acc = ns.find(n => n.dataset.type === 'accumulator');
      return { nodes: ns.length, visible: ns.filter(n => getComputedStyle(n).display !== 'none').length, ticking: +(acc?.getAttribute('value') || 0) > 0,
        inShadow: [...pb.querySelectorAll('scv-item > *')].some(h => h.shadowRoot?.querySelector('scv-logic')) }; })()`, true);
    ok(pasted && pasted.nodes === 2 && !pasted.inShadow, `${kind} paste brings both nodes back as real nodes (${JSON.stringify(pasted)})`);
    ok(pasted && pasted.visible === 2, `${kind} publish-hidden nodes come back visible on paste (${pasted && pasted.visible})`);
    ok(pasted && pasted.ticking, `${kind} pasted clock still drives accumulator (${JSON.stringify(pasted)})`);
  }
} catch (e) {
  fails++; console.log('  ✗ fractal tier threw:', e.message);
}

done();
console.log(fails ? `fractal: FAIL (${fails})` : 'fractal: PASS');
process.exit(fails ? 1 : 0);