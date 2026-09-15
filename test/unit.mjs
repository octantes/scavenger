// pure contract checks - no browser: shared parser + assertion logic sniper, quest node, tui, --run share

import { parseTarget, parseQuestLine, sanitizeSteps, checkExpect, unfurl } from '../quests.mjs';
import { isPrivateAddr, isValidQuestUrl } from '../quests.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };
// JSON.stringify eq is key-order sensitive - deepEqual compares keys as sets, arrays by position
const deepEqual = (a, b) => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a !== 'object') return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(k => deepEqual(a[k], b[k]));
};
const eq = (a, b, m) => ok(deepEqual(a, b), `${m} - got ${JSON.stringify(a)}`);

// parseTarget: extraction types + pipeline
eq(parseTarget('.price'), { selector: '.price' }, 'bare selector');
eq(parseTarget('sel:h1'), { selector: 'h1' }, 'sel: prefix');
eq(parseTarget('key:data.p'), { jsonKey: 'data.p' }, 'key:');
eq(parseTarget('ls:auth.token'), { storageKey: 'auth.token' }, 'ls: dot-path');
eq(parseTarget('harvest:.card'), { harvestSel: '.card' }, 'harvest: prefix (whole component, what the quest-steps component verb emits)');
eq(parseTarget('wait:#p | click:.c | sel:.m'), { steps: [{ wait: '#p' }, { click: '.c' }], selector: '.m' }, 'pipeline steps + extraction');
eq(parseTarget('click:.more | harvest:.card'), { steps: [{ click: '.more' }], harvestSel: '.card' }, 'pipeline steps + harvest extraction');
eq(parseTarget('type:#q=hi | key:x'), { steps: [{ type: '#q=hi' }], jsonKey: 'x' }, 'type step keeps =text');

// parseTarget: edge cases
eq(parseTarget(''), {}, 'empty target → {}');
eq(parseTarget(null), {}, 'null target → {}');
eq(parseTarget('sel:.m |'), { selector: '.m' }, 'trailing pipe (empty segment) filtered');
eq(parseTarget('nocolon | sel:.m'), { selector: '.m' }, 'step segment without colon is skipped');
eq(parseTarget('bogus:x | sel:.m'), { selector: '.m' }, 'unknown verb is skipped (only known STEP_VERBS survive)');
ok((parseTarget(Array(30).fill('wait:#x').join(' | ') + ' | sel:.m').steps || []).length === 25, 'more than 25 pipeline steps truncated to 25');

// parseQuestLine: url-first + named
eq(parseQuestLine('https://x/, wait:#p | sel:.m'), { url: 'https://x/', steps: [{ wait: '#p' }], selector: '.m' }, 'line url-first (no channel)');
eq(parseQuestLine('btc, https://x/, key:price'), { channel: 'btc', url: 'https://x/', jsonKey: 'price' }, 'line named channel');
eq(parseQuestLine(', https://x/, .m'), { url: 'https://x/', selector: '.m' }, 'line leading comma still works');
eq(parseQuestLine(''), { url: '' }, 'empty line → { url: "" }');
eq(parseQuestLine('https://only-a-url/'), { url: 'https://only-a-url/' }, 'bare URL is url-first with no target');
eq(parseQuestLine(12345), { channel: '12345', url: '' }, 'non-string line is String()-coerced, not crash');

// sanitizeSteps: drop junk, keep known verbs
eq(sanitizeSteps([{ wait: '#x' }, { bogus: 'y' }, { click: 1 }, { scroll: '9' }]), [{ wait: '#x' }, { click: '1' }, { scroll: '9' }], 'sanitizeSteps filters junk and coerces numeric args');
ok(sanitizeSteps('nope') === undefined, 'sanitizeSteps non-array → undefined');
ok(sanitizeSteps([]) === undefined, 'sanitizeSteps empty → undefined');
eq(sanitizeSteps([null, { wait: '#x' }, undefined, 'str']), [{ wait: '#x' }], 'sanitizeSteps skips null/undefined/non-object items');
ok(sanitizeSteps([{ wait: 'x'.repeat(501) }]) === undefined, 'sanitizeSteps drops arg over 500 chars');
ok(sanitizeSteps(Array(30).fill({ wait: '#x' })).length === 25, 'sanitizeSteps caps at 25 items');

// checkExpect: assertion modes
ok(checkExpect({ expect: '42' }, { value: '42' }).ok, 'expect exact pass');
ok(!checkExpect({ expect: '42' }, { value: '41' }).ok, 'expect mismatch fail');
ok(checkExpect({ contains: 'ell' }, { value: 'hello' }).ok, 'contains pass');
ok(!checkExpect({ contains: 'zzz' }, { value: 'hello' }).ok, 'contains fail');
ok(checkExpect({ matches: '^h.*o$' }, { value: 'hello' }).ok, 'matches pass');
ok(!checkExpect({ matches: '^z' }, { value: 'hello' }).ok, 'matches fail');
ok(checkExpect({}, { value: 'x' }).ok, 'default non-empty pass');
ok(!checkExpect({}, { value: '' }).ok, 'default empty fail');
ok(!checkExpect({ expect: 'x' }, { value: null, error: 'boom' }).ok, 'engine error always fails');
const badRe = checkExpect({ matches: '(' }, { value: 'x' });
ok(!badRe.ok && /bad regex/.test(badRe.detail), 'matches with invalid regex → { ok:false, detail:"bad regex..." } (no throw)');
ok(!checkExpect({ contains: 'x' }, { value: null }).ok, 'contains against null value fails (no crash)');
ok(checkExpect({ matches: '^$' }, { value: null }).ok, 'matches coerces null value to "" before testing');

// unfurl: link-card page metadata extraction (og/twitter/<title>, absolute image, truncation)
const OG = '<html><head><title>Tab Title</title><meta property="og:title" content="Real Title"><meta name="description" content="The description."><meta property="og:description" content="The og description."><meta property="og:image" content="/img/cover.png"></head><body>…</body></html>';
eq(unfurl(OG, 'https://example.com/a/b'), { title: 'Real Title', description: 'The og description.', image: 'https://example.com/img/cover.png' }, 'unfurl prefers og:title/og:description and absolute-izes relative og:image');
const PLAIN = '<html><head><title>Only Title</title><meta name="description" content="Plain desc."></head></html>';
eq(unfurl(PLAIN, 'https://example.com/'), { title: 'Only Title', description: 'Plain desc.', image: '' }, 'unfurl falls back to <title>/<meta name="description"> and empty image');
eq(unfurl('<meta property="twitter:image" content="//cdn.example/t.png"><title>T</title>', 'https://example.com/'), { title: 'T', description: '', image: 'https://cdn.example/t.png' }, 'unfurl accepts twitter:image and protocol-relative // URLs');
eq(unfurl('<title>' + 'x'.repeat(500) + '</title><meta name="description" content="' + 'y'.repeat(500) + '">', 'https://e.com/').title.length, 120, 'unfurl truncates 500-char title to 120');
eq(unfurl('<meta name="description" content="' + 'y'.repeat(500) + '">', 'https://e.com/').description.length, 300, 'unfurl truncates 500-char description to 300');
eq(unfurl('', 'https://e.com/'), { title: '', description: '', image: '' }, 'unfurl empty markup → all-empty fields');
eq(unfurl('<meta property="og:image" content="https://h/a.png?x=1&amp;y=2"><title>T</title>', 'https://h/').image,
   'https://h/a.png?x=1&y=2', 'unfurl decodes entities in the image url - a raw &amp; makes a bogus query param');


// fuzz: every exported parser must answer, never throw, on hostile or non-string input
{
  const hostile = ['', ' ', '\n', '\0', '\\', '"', "'", '`', '${}', '</scr' + 'ipt>', '<!--',
    'a'.repeat(50000), '|'.repeat(2000), ':'.repeat(2000), 'https://', 'http://[', '0x', '1e309',
    '__proto__', 'constructor', '%', '%zz', '../../', '\ud800', '👻', 'https://x,,,', 'key:', 'ls:', 'sel:'];
  const values = [...hostile, undefined, null, 0, 1, true, [], {}];
  const parsers = [
    ['parseTarget', v => parseTarget(v)],
    ['parseQuestLine', v => parseQuestLine(v)],
    ['sanitizeSteps', v => sanitizeSteps(v)],
    ['sanitizeSteps[]', v => sanitizeSteps([v, { wait: v }, { [v]: v }, null, 0])],
    ['isPrivateAddr', v => isPrivateAddr(v)],
    ['isValidQuestUrl', v => isValidQuestUrl(v)],
    ['checkExpect', v => checkExpect({ expect: v }, { value: v })],
  ];
  const threw = [];
  for (const [name, fn] of parsers) for (const v of values) {
    try { fn(v); } catch (e) { threw.push(name + ': ' + e.message); }
  }
  ok(threw.length === 0, `parsers survive hostile and non-string input (${[...new Set(threw)].slice(0, 3).join(' | ')})`);
}


console.log(fails ? `unit: FAIL (${fails})` : 'unit: PASS');
process.exit(fails ? 1 : 0);
