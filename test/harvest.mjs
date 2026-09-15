// harvest tier - harvest live components, check copy by computed style, forced :hover and pixel diff

import { launchChrome, connect } from './_cdp.mjs';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { createServer } from 'http';
import { inflateSync } from 'zlib';

// opt-in - needs network and pages drift, so it measures harvest instead of gating build
const arg = (k, d) => { const m = process.argv.find(a => a.startsWith(`--${k}=`)); return m ? m.split('=')[1] : d; }; // --sites=n --per=n --only=substr --json=path --shots=dir
const PER_SITE = +arg('per', 5);
const JSON_OUT = arg('json', '');
const SHOTS = arg('shots', '');
const VW = 1280, VH = 900;

if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const SITES = [ // spread across frameworks and hand-rolled css - tailwind, bootstrap, vitepress, mdn, mediawiki, plain
  'https://vuejs.org/', 'https://tailwindcss.com/', 'https://getbootstrap.com/docs/5.3/components/buttons/',
  'https://developer.mozilla.org/en-US/', 'https://en.wikipedia.org/wiki/Cascading_Style_Sheets',
  'https://news.ycombinator.com/', 'https://react.dev/', 'https://svelte.dev/', 'https://astro.build/',
  'https://nodejs.org/en', 'https://www.python.org/', 'https://www.rust-lang.org/', 'https://go.dev/',
  'https://bulma.io/', 'https://picocss.com/', 'https://vitejs.dev/', 'https://octantes.github.io/',
  'https://developer.mozilla.org/en-US/docs/Web/CSS', 'https://getbootstrap.com/', 'https://tailwindcss.com/docs/installation/using-vite',
].filter(u => u.includes(arg('only', ''))).slice(0, +arg('sites', 99));

// visually meaningful props
const PROPS = `['color','background-color','background-image','background-size','background-position','background-clip',
 '-webkit-text-fill-color','font-family','font-size','font-weight','font-style','font-variant','letter-spacing',
 'line-height','text-align','text-transform','text-decoration-line','text-decoration-color','text-shadow','white-space',
 'text-overflow','overflow-x','overflow-y','opacity','visibility','display','flex-direction','flex-wrap','justify-content',
 'align-items','gap','grid-template-columns','box-shadow','filter','backdrop-filter','transform','border-top-width',
 'border-right-width','border-bottom-width','border-left-width','border-top-color','border-right-color','border-bottom-color',
 'border-left-color','border-top-style','border-top-left-radius','border-top-right-radius','border-bottom-left-radius',
 'border-bottom-right-radius','padding-top','padding-right','padding-bottom','padding-left','list-style-type','vertical-align',
 'fill','stroke','stroke-width','fill-opacity','stroke-opacity','stroke-dasharray','stop-color','mask-image','clip-path']`;

// never paints alone - filtered out before indexing, or one removed sibling would renumber every later key
const NR = `/^(script|template|defs|symbol|clipPath|mask|linearGradient|radialGradient|pattern|filter|marker|metadata|title|desc)$/i`;

// harvest inlines shadow root as children then slotted light dom - light-only walk calls it missing
const KIDS = `(n => (n.shadowRoot ? [...n.shadowRoot.children, ...n.children] : [...n.children]).filter(c => !${NR}.test(c.tagName)))`;

const SIGNATURE = `(root => {
  const PROPS = ${PROPS};
  const PSEUDO = ['::before','::after','::placeholder','::marker'];
  const rootRect = root.getBoundingClientRect();
  const out = [];
  const walk = (n, key) => {
    if (n.nodeType !== 1) return;
    if (${NR}.test(n.tagName)) return;
    const cs = getComputedStyle(n), r = n.getBoundingClientRect();
    const rec = { tag: n.tagName, key, p: {} };
    // unrendered node reports zero rect at origin - noise, display catches, getClientRects covers hidden subtrees
    rec.box = (cs.display === 'none' || n.getClientRects().length === 0) ? null
      : [Math.round((r.left - rootRect.left) * 2) / 2, Math.round((r.top - rootRect.top) * 2) / 2,
         Math.round(r.width * 2) / 2, Math.round(r.height * 2) / 2];
    for (const p of PROPS) rec.p[p] = cs.getPropertyValue(p);
    for (const q of PSEUDO) {
      const pc = getComputedStyle(n, q);
      if (!pc) continue;
      const content = pc.content;
      if (q === '::placeholder' && !('placeholder' in n)) continue;
      if ((q === '::before' || q === '::after') && (content === 'none' || content === '')) continue;
      rec.p[q + ' content'] = content;
      rec.p[q + ' color'] = pc.color;
      rec.p[q + ' background-color'] = pc.backgroundColor;
      rec.p[q + ' font-size'] = pc.fontSize;
    }
    // measured width catches font fallen back to metric-different face - declared family matches
    const tn = [...n.childNodes].filter(c => c.nodeType === 3 && c.textContent.trim());
    if (tn.length) {
      try {
        const rg = document.createRange(); rg.setStart(tn[0], 0); rg.setEnd(tn[tn.length - 1], tn[tn.length - 1].length);
        const tr = rg.getBoundingClientRect();
        rec.p['#text-width'] = String(Math.round(tr.width * 2) / 2);
        rec.p['#text-height'] = String(Math.round(tr.height * 2) / 2);
      } catch {}
    }
    out.push(rec);
    let i = 0;
    for (const c of ${KIDS}(n)) walk(c, key + '/' + (i++) + c.tagName);
  };
  walk(root, 'r');
  return out;
})`;

// resolve node on both sides from tree path, so hover lines up node for node
const NODE_AT = `((root, key) => {
  let n = root;
  for (const part of key.split('/').slice(1)) {
    n = ${KIDS}(n)[parseInt(part, 10)];
    if (!n) return null;
  }
  return n;
})`;

// :hover is invisible to static computed read - lost hover styling still scores perfect signature
const HOVER_PROPS = `['color','background-color','background-image','border-top-color','border-bottom-color','box-shadow',
 'opacity','transform','text-decoration-line','filter','outline-color']`;
const INTERACTIVE = `(root => {
  const out = [];
  const walk = (n, key) => {
    if (n.nodeType !== 1 || ${NR}.test(n.tagName)) return;
    if (/^(A|BUTTON|INPUT|SELECT|SUMMARY|LABEL)$/.test(n.tagName) || n.getAttribute('role') === 'button') {
      if (n.getClientRects().length) out.push(key);
    }
    let i = 0;
    for (const c of ${KIDS}(n)) walk(c, key + '/' + (i++) + c.tagName);
  };
  walk(root, 'r');
  return out.slice(0, 4); // handful catches a lost hover rule, and each one costs a settle
})`;

const ROOT_EXEMPT = new Set(['transform']); // root placement dropped on purpose - stood against parent we don't carry

const num = v => { const m = /^(-?[\d.]+)px$/.exec(v || ''); return m ? parseFloat(m[1]) : null; };

// remote asset turned into data uri is whole point of harvest - only mask that direction, so svg into png still counts
const inlined = (x, y) => /url\(["']?(?!data:)[a-z][a-z0-9+.-]*:/i.test(x) && /url\(["']?data:/i.test(y);
const same = (a, b) => {
  if (a === b) return true;
  if (inlined(a, b)) return true;
  const na = num(a), nb = num(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) <= 1; // subpixel layout noise, not visible difference
  return false;
};

const decodePng = b64 => { // zero-dep png reader - enough of format for what chrome hands back
  const buf = Buffer.from(b64, 'base64');
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let p = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), tag = buf.toString('ascii', p + 4, p + 8);
    const body = buf.subarray(p + 8, p + 8 + len);
    if (tag === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (tag === 'IDAT') idat.push(body);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || interlace !== 0 || !ch) throw new Error(`unsupported png: depth ${depth} type ${type} interlace ${interlace}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++], line = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev ? prev[x] : 0, c = (x >= ch && prev) ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
};

const PIX_TOL = 12;
const diffPixels = (A, B) => { // text antialiasing never bit-identical twice, so channel must move visibly before count
  if (A.w !== B.w || A.h !== B.h) return null;
  const n = A.w * A.h;
  let bad = 0, sum = 0, max = 0, edge = 0;
  for (let i = 0; i < n; i++) {
    const ai = i * A.ch, bi = i * B.ch;
    let d = 0;
    for (let k = 0; k < 3; k++) { const x = Math.abs(A.data[ai + k] - B.data[bi + k]); if (x > d) d = x; }
    sum += d; if (d > max) max = d;
    if (d > PIX_TOL) { // transparent component showed what parent painted - ancestor border is not copy's to carry
      bad++;
      const x = i % A.w, y = (i / A.w) | 0;
      if (x < 2 || y < 2 || x >= A.w - 2 || y >= A.h - 2) edge++;
    }
  }
  return { total: n, bad, mean: +(sum / n).toFixed(2), max, score: (n - bad) / n, edgeShare: bad ? +(edge / bad).toFixed(3) : 0 };
};

let blankPayload = '<!doctype html><meta charset=utf-8><body style="margin:0">';
const blankSrv = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end(blankPayload); });
await new Promise(r => blankSrv.listen(0, '127.0.0.1', r));
const blankUrl = `http://127.0.0.1:${blankSrv.address().port}/`;

const { pageWsUrl, cleanup } = await launchChrome();
const { send, waitEvent } = await connect(pageWsUrl);
await send('Page.enable'); await send('DOM.enable'); await send('CSS.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

const kernelSrc = readFileSync(new URL('../kernel.js', import.meta.url), 'utf8');

const js = async (expr, aw = false) => {
  try {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: aw });
    if (!r?.result) return { ERR: 'cdp' };
    if (r.result.exceptionDetails) return { ERR: String(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).slice(0, 160) };
    return r.result.result.value;
  } catch (e) { return { ERR: String(e.message).slice(0, 120) }; }
};

const handle = async expr => { // objectId is not value - forcePseudoState needs real node behind
  try {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: false });
    return r?.result?.result?.objectId || null;
  } catch { return null; }
};

const settle = () => js(`(async()=>{try{await document.fonts.ready}catch{}
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return 1})()`, true);

const load = async (url, ms) => {
  await send('Page.navigate', { url });
  try { await waitEvent('Page.loadEventFired'); } catch {}
  await new Promise(r => setTimeout(r, ms));
  await settle();
};

// clip is page coords, not viewport - measured, viewport-relative silently shoots wrong band
const shoot = async clip => (await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } }))?.result?.data || null;

const forceHover = async (rootExpr, keys, on) => {
  for (const k of keys) {
    const oid = await handle(`${NODE_AT}(${rootExpr}, ${JSON.stringify(k)})`);
    if (!oid) continue;
    try {
      const { result } = await send('DOM.requestNode', { objectId: oid });
      if (result?.nodeId) await send('CSS.forcePseudoState', { nodeId: result.nodeId, forcedPseudoClasses: on ? ['hover'] : [] });
    } catch {}
  }
};

const readHover = (rootExpr, keys) => js(`(() => {
  const P = ${HOVER_PROPS};
  return JSON.stringify(${JSON.stringify(keys)}.map(k => {
    const n = ${NODE_AT}(${rootExpr}, k);
    if (!n) return null;
    const cs = getComputedStyle(n);
    const o = {}; for (const p of P) o[p] = cs.getPropertyValue(p);
    return o;
  }));})()`);

// candidates - visible, own class, sane size, not nested in already taken or we score same pixels twice
const PICK = `((per) => {
  document.documentElement.style.scrollBehavior = 'auto';
  for (const o of document.querySelectorAll('body *')) { // cookie walls and splash overlays cover every pick under
    const c = getComputedStyle(o), r = o.getBoundingClientRect();
    if ((c.position === 'fixed' || c.position === 'sticky') && r.width > innerWidth * 0.8 && r.height > innerHeight * 0.5) o.remove();
  }
  const taken = [], out = [];
  const sweep = () => {
    for (const e of document.querySelectorAll('body *[class]')) {
      const r = e.getBoundingClientRect(), c = getComputedStyle(e);
      if (r.width < 60 || r.width > 900 || r.height < 24 || r.height > 600) continue;
      if (c.visibility === 'hidden' || c.opacity === '0' || r.top < 0 || r.top > innerHeight - 10) continue;
      if (/^(SCRIPT|STYLE|SVG|PATH|BR|HR)$/.test(e.tagName)) continue;
      const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!t || !(t === e || e.contains(t) || t.contains(e))) continue;
      if (taken.some(p => p.contains(e) || e.contains(p))) continue;
      taken.push(e); out.push(e);
      if (out.length >= per) return true;
    }
    return false;
  };
  // one screenful is thin sample and skews to navbars - walk down for spread of real components
  for (let y = 0; y < 5; y++) {
    window.scrollTo(0, y * innerHeight * 0.9);
    if (sweep()) break;
  }
  window.scrollTo(0, 0);
  window.__cand = out;
  return out.map((e, i) => i + ':' + e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/)[0] : ''));
})`;

const results = [];
let siteOk = 0;

for (const site of SITES) {
  let names;
  try {
    await load(site, 3000);
    names = await js(`${PICK}(${PER_SITE})`);
  } catch (e) { names = { ERR: String(e.message).slice(0, 80) }; }
  if (!Array.isArray(names) || !names.length) {
    console.log(`  - ${site} :: no candidates (${names?.ERR || 'empty'})`);
    continue;
  }
  siteOk++;
  await send('Runtime.evaluate', { expression: kernelSrc });

  for (let i = 0; i < names.length; i++) {
    const label = `${new URL(site).hostname}#${names[i]}`;
    const row = { site, label, ok: false };
    try {
      const live = await js(`(()=>{const e=window.__cand[${i}]; if(!e) return null; window.__t=e; return JSON.stringify(${SIGNATURE}(e));})()`);
      if (!live || live.ERR) { row.note = 'live signature failed'; results.push(row); continue; }
      const hoverKeys = await js(`${INTERACTIVE}(window.__t)`) || [];

      // page coords, only worth shooting if it fits viewport whole
      const geo = await js(`(()=>{window.__t.scrollIntoView({block:'center'});
        const r=window.__t.getBoundingClientRect();
        return JSON.stringify({x:r.left+scrollX,y:r.top+scrollY,lx:r.left,ly:r.top,w:r.width,h:r.height});})()`);
      const g = geo && !geo.ERR ? JSON.parse(geo) : null;
      await settle();

      let liveShot = null, stable = false;
      if (g && g.w >= 4 && g.h >= 4 && g.w <= VW - 8 && g.h <= VH - 8) {
        const a1 = await shoot({ x: g.x, y: g.y, width: g.w, height: g.h });
        await new Promise(r => setTimeout(r, 350));
        const a2 = await shoot({ x: g.x, y: g.y, width: g.w, height: g.h });
        // self-animating can't be pixel-compared against one later capture - prevent scoring noise
        stable = !!a1 && a1 === a2;
        liveShot = a1;
        if (!stable) row.unstable = true;
      } else if (g) row.tooBig = true;

      const html = await js(`(async()=>{return await new Promise(res=>{
        Object.defineProperty(navigator.clipboard,'writeText',{value:t=>{res(String(t));return Promise.resolve();},configurable:true});
        window.$kernel.start('harvester');
        const a=Date.now();
        (async()=>{while(!window.$kernel.processes['harvester']?.active&&Date.now()-a<2500)await new Promise(r=>setTimeout(r,10));
          window.__t.dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true,cancelable:true}));})();
        setTimeout(()=>res('__timeout__'),25000);});})()`, true);
      if (!html || html.ERR || html === '__timeout__') { row.note = 'harvest failed'; results.push(row); continue; }
      row.bytes = html.length;

      let liveHover = null;
      if (hoverKeys.length) { // hover live after harvesting - earlier bakes hover state into copy
        await forceHover('window.__t', hoverKeys, true);
        await new Promise(r => setTimeout(r, 450)); // let transitions land
        liveHover = await readHover('window.__t', hoverKeys);
        await forceHover('window.__t', hoverKeys, false);
      }

      // backdrop behind live element, transparent corners compare against same ground
      const bg = await js(`(()=>{const op=c=>!!c&&c!=='transparent'&&!/,\\s*0\\s*\\)$/.test(c);
        const e=window.__t, r=e.getBoundingClientRect();
        const cx=Math.min(Math.max(r.left+r.width/2,1),innerWidth-1), cy=Math.min(Math.max(r.top+r.height/2,1),innerHeight-1);
        for(const n of document.elementsFromPoint(cx,cy)||[]){ if(n===e||e.contains(n))continue;
          const c=getComputedStyle(n).backgroundColor; if(op(c))return c; }
        let a=e.parentElement; while(a){const c=getComputedStyle(a).backgroundColor; if(op(c))return c; a=a.parentElement;}
        return 'rgb(255,255,255)';})()`);

      // re-render neutral at same subpixel offset - different fractional x/y rasterises differently
      blankPayload = `<!doctype html><meta charset=utf-8><body style="margin:0;background:${typeof bg === 'string' ? bg : '#fff'}">`
        + `<div id="pit" style="position:absolute;left:${g ? g.lx : 0}px;top:${g ? g.ly : 0}px">${html}</div>`;

      await load(blankUrl, 700);
      const shot = await js(`(async()=>{
        const box=document.getElementById('pit'); if(!box) return null;
        try{await document.fonts.ready}catch{}
        await new Promise(r=>setTimeout(r,300));
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const host=box.querySelector('[data-scv-component]'), sr=host&&host.shadowRoot;
        const root=sr&&[...sr.children].find(n=>n.tagName!=='STYLE');
        if(!root) return null;
        window.__h=root;
        return JSON.stringify(${SIGNATURE}(root));})()`, true);
      if (!shot || shot.ERR) { row.note = 'render failed'; results.push(row); continue; }

      const A = JSON.parse(live), B = JSON.parse(shot);
      row.nodes = A.length;

      // pair by tree path - one dropped node shifts later indexes and scores noise
      const Bmap = new Map(B.map(r => [r.key, r]));
      let total = 0, bad = 0, missing = 0;
      const deltas = [];
      for (const a of A) {
        const b = Bmap.get(a.key);
        if (!b) { missing++; continue; }
        for (const p in a.p) {
          if (a.key === 'r' && ROOT_EXEMPT.has(p)) continue;
          total++;
          if (!same(a.p[p], b.p[p])) {
            bad++;
            if (deltas.length < 6) deltas.push(`${a.tag.toLowerCase()} ${p}: ${String(a.p[p]).slice(0, 28)} > ${String(b.p[p]).slice(0, 28)}`);
          }
        }
        if (a.box && b.box) for (let d = 0; d < 4; d++) { total++; if (Math.abs(a.box[d] - b.box[d]) > 1) { bad++; if (deltas.length < 6) deltas.push(`${a.tag.toLowerCase()} box${d}: ${a.box[d]} > ${b.box[d]}`); } }
      }

      // node that never made it across is worst miss - weigh it above one wrong property
      const extra = B.length - (A.length - missing);
      row.missing = missing; row.extra = extra;
      if (missing || extra) { const m = missing + Math.abs(extra); total += m * 20; bad += m * 20; deltas.unshift(`structure: ${missing} node(s) missing, ${extra} extra`); }

      // same forced hover on copy, node for node against what page did
      if (hoverKeys.length && liveHover && !liveHover.ERR) {
        await forceHover('window.__h', hoverKeys, true);
        await new Promise(r => setTimeout(r, 450));
        const copyHover = await readHover('window.__h', hoverKeys);
        await forceHover('window.__h', hoverKeys, false);
        if (copyHover && !copyHover.ERR) {
          const LH = JSON.parse(liveHover), CH = JSON.parse(copyHover);
          let hTotal = 0, hBad = 0;
          for (let k = 0; k < LH.length; k++) {
            if (!LH[k] || !CH[k]) continue;
            for (const p in LH[k]) { hTotal++; if (!same(LH[k][p], CH[k][p])) { hBad++; if (deltas.length < 8) deltas.push(`:hover ${p}: ${String(LH[k][p]).slice(0, 24)} > ${String(CH[k][p]).slice(0, 24)}`); } }
          }
          row.hoverTotal = hTotal; row.hoverBad = hBad;
          row.hoverScore = hTotal ? (hTotal - hBad) / hTotal : null;
          total += hTotal; bad += hBad;
        }
      }

      row.total = total; row.bad = bad;
      row.score = total ? (total - bad) / total : 0;
      row.perfect = bad === 0;
      row.deltas = deltas;

      if (liveShot && stable) { // rasterise copy in same place and count pixels that moved
        // nudge container until root box lands where live one was - inline root sits on baseline and shoots shifted
        await js(`(()=>{const pit=document.getElementById('pit'), r=window.__h.getBoundingClientRect();
          pit.style.left=(parseFloat(pit.style.left||0)+(${g.lx}-r.left))+'px';
          pit.style.top=(parseFloat(pit.style.top||0)+(${g.ly}-r.top))+'px'; return 1;})()`);
        await settle();
        const copyShot = await shoot({ x: g.lx, y: g.ly, width: g.w, height: g.h }); // neutral page unscrolled, page coords same numbers
        if (copyShot) {
          try {
            const px = diffPixels(decodePng(liveShot), decodePng(copyShot));
            if (px) {
              row.pixels = px;
              row.pixelScore = px.score;
              if (SHOTS && px.score < 0.999) {
                const safe = label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
                writeFileSync(`${SHOTS}/${safe}-a.png`, Buffer.from(liveShot, 'base64'));
                writeFileSync(`${SHOTS}/${safe}-b.png`, Buffer.from(copyShot, 'base64'));
              }
            } else row.note = 'shot size mismatch';
          } catch (e) { row.note = 'png: ' + String(e.message).slice(0, 60); }
        }
      }
      row.ok = true;
    } catch (e) { row.note = 'threw: ' + String(e.message).slice(0, 80); }
    results.push(row);
    const px = row.pixelScore != null ? ` px ${(row.pixelScore * 100).toFixed(2)}%` : (row.unstable ? ' px animating' : (row.tooBig ? ' px oversize' : ''));
    console.log(`  ${row.ok ? (row.perfect ? '✓' : '~') : '✗'} ${label.padEnd(48).slice(0, 48)} ${row.ok ? (row.score * 100).toFixed(1) + '%' : (row.note || 'fail')}${px}${row.deltas?.length ? '  | ' + row.deltas[0] : ''}`);

    if (i < names.length - 1) { // page left for neutral render - reload and re-pick for next component
      await load(site, 2500);
      await js(`${PICK}(${PER_SITE})`);
      await send('Runtime.evaluate', { expression: kernelSrc });
    }
  }
}

cleanup(); blankSrv.close();

const scored = results.filter(r => r.ok);
const perfect = scored.filter(r => r.perfect).length;
const near = scored.filter(r => r.score >= 0.98).length;
const avg = scored.length ? scored.reduce((s, r) => s + r.score, 0) / scored.length : 0;
const shot1 = scored.filter(r => r.pixelScore != null);
const pxAvg = shot1.length ? shot1.reduce((s, r) => s + r.pixelScore, 0) / shot1.length : 0;
const hov = scored.filter(r => r.hoverScore != null);

console.log('\n' + '-'.repeat(72));
console.log(`sites reached      ${siteOk}/${SITES.length}`);
console.log(`components scored  ${scored.length}/${results.length}  (${results.length - scored.length} harvest/render failures)`);
console.log(`clean (no delta)   ${perfect}/${scored.length}  (${(perfect / (scored.length || 1) * 100).toFixed(1)}%)`);
console.log(`>=98% of checks    ${near}/${scored.length}  (${(near / (scored.length || 1) * 100).toFixed(1)}%)`);
console.log(`mean fidelity      ${(avg * 100).toFixed(2)}%`);
console.log(`\npixel diff         ${shot1.length} shot, ${scored.filter(r => r.unstable).length} animating, ${scored.filter(r => r.tooBig).length} oversize`);
console.log(`  mean pixels equal  ${(pxAvg * 100).toFixed(3)}%   (channel tolerance ${PIX_TOL}/255)`);
console.log(`  byte-perfect       ${shot1.filter(r => r.pixels.bad === 0).length}/${shot1.length}`);
console.log(`  >=99.9% pixels     ${shot1.filter(r => r.pixelScore >= 0.999).length}/${shot1.length}`);
console.log(`  >=99% pixels       ${shot1.filter(r => r.pixelScore >= 0.99).length}/${shot1.length}`);
const edgeOnly = shot1.filter(r => r.pixels.bad && r.pixels.edgeShare >= 0.9);
console.log(`  edge-only diffs    ${edgeOnly.length}  (all differing pixels hug border - ancestor painting under transparent component)`);
console.log(`  clean or edge-only ${shot1.filter(r => r.pixels.bad === 0).length + edgeOnly.length}/${shot1.length}`);
console.log(`\nhover states       ${hov.length} components, ${hov.reduce((s, r) => s + r.hoverTotal, 0)} props`);
console.log(`  matching           ${hov.filter(r => r.hoverBad === 0).length}/${hov.length} components clean`);

const worst = scored.filter(r => !r.perfect).sort((a, b) => a.score - b.score).slice(0, 12);
if (worst.length) {
  console.log('\nworst offenders:');
  for (const w of worst) console.log(`  ${(w.score * 100).toFixed(1)}%  ${w.label}\n      ${w.deltas.join('\n      ')}`);
}
const pxWorst = shot1.filter(r => r.pixelScore < 0.999).sort((a, b) => a.pixelScore - b.pixelScore).slice(0, 10);
if (pxWorst.length) {
  console.log('\nworst by pixels:');
  for (const w of pxWorst) console.log(`  ${(w.pixelScore * 100).toFixed(2)}%  ${w.label}  (${w.pixels.bad}/${w.pixels.total} px, mean ${w.pixels.mean}, max ${w.pixels.max}${w.pixels.edgeShare >= 0.9 ? ', edge-only' : ''})`);
}

if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ when: new Date().toISOString(), viewport: [VW, VH], sites: SITES, results }, null, 1));
process.exit(0);