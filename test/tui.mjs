// tui harness - no browser: drives QuestTUI._paint across modes + _keyHandler across keymap, fake stdout

import { QuestEngine, QuestTUI } from '../quests.mjs';
import { chdir } from 'process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
chdir(mkdtempSync(join(tmpdir(), 'scv-tui-'))); // isolate quests.json writes from add/delete/pin flows
const readQ = () => { try { return JSON.parse(readFileSync('quests.json', 'utf8')); } catch { return []; } };
const tick = () => new Promise(r => setTimeout(r, 60)); // let async updateQuests().then() settle

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  ✗', m); } };

const engine = new QuestEngine();
engine._questsCache = [
  { channel: 'btc', url: 'https://x/', selector: '.p', interval: 30000, result: { value: '42', timestamp: Date.now() } },
  { channel: 'wa', url: 'https://web.whatsapp.com/', selector: '#pane', interval: 30000, result: { value: null, timestamp: Date.now(), error: 'selector matched nothing after 12s' } },
  { channel: 'note', interval: 30000, manual: true, pinned: true },
];
engine._setQuestStatus('btc', 'success', { value: '42', timestamp: Date.now() });
engine._setQuestStatus('wa', 'error', { value: null, timestamp: Date.now(), error: 'selector matched nothing after 12s' });
engine._chromeConnected = true;
engine._lastTickMs = 1200; engine._durations = [1000, 1400];

const tui = new QuestTUI(engine);
engine.onRender = () => {};

// delegating getters/setters route to engine
ok(tui._questsCache === engine._questsCache, 'getter _questsCache');
ok(tui._chromeConnected === true, 'getter _chromeConnected');
tui._notice = 'hi'; ok(engine._notice === 'hi', 'setter _notice → engine'); tui._notice = null;
tui._profileMode = 'snapshot'; ok(engine._profileMode === 'snapshot', 'setter _profileMode → engine'); tui._profileMode = 'temp';

// paint across modes with captured stdout
tui._tui = true; process.stdout.columns = 100; process.stdout.rows = 30;
const realWrite = process.stdout.write.bind(process.stdout);
let out = ''; process.stdout.write = s => { out += s; return true; };
const strip = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const paint = (label, setup) => {
  try { setup && setup(); out = ''; tui._paint(); const p = strip(out);
    ok(out.length > 0, `${label}: output`); ok(!p.includes('undefined'), `${label}: no "undefined"`); return p;
  } catch (e) { fails++; process.stdout.write = realWrite; console.log(`  ✗ ${label} threw: ${e.message}`); process.stdout.write = s => { out += s; return true; }; return ''; }
};
const key = (b, l) => { try { tui._keyHandler(Buffer.from(b)); } catch (e) { fails++; process.stdout.write = realWrite; console.log(`  ✗ key ${l} threw: ${e.message}`); process.stdout.write = s => { out += s; return true; }; } };

let p = paint('normal', () => { tui._mode = 'normal'; tui._cursor = 0; });
ok(p.includes('btc') && p.includes('wa'), 'normal shows channels');
paint('help', () => { tui._mode = 'help'; });
paint('log', () => { tui._mode = 'log'; });
paint('search', () => { tui._mode = 'search'; tui._search = 'bt'; });
paint('chromium', () => { tui._mode = 'chromium'; });
const perr = paint('error', () => { tui._mode = 'error'; });
ok(perr.toLowerCase().includes('selector'), 'error view lists failure');
paint('add-quest', () => { tui._mode = 'add-quest'; tui._inputStep = 0; tui._addData = { kernel: '', channel: '', url: '', selector: '', interval: '30000' }; });
paint('edit-quest', () => { tui._mode = 'edit-quest'; tui._editingChannel = 'btc'; tui._startEdit(); });
paint('tick-rate', () => { tui._mode = 'tick-rate'; tui._input = '5000'; });
paint('confirm', () => { tui._mode = 'confirm'; tui._pendingConfirm = { action: 'delete', channel: 'btc' }; tui._prevMode = 'normal'; });

// keys (avoid q / ctrl-c which exit)
tui._mode = 'normal'; tui._dismiss();
key('j', 'down'); key('k', 'up'); key('/', 'search'); tui._dismiss();
key('c', 'chromium'); key('j', 'sel'); key('l', '+'); key('h', '-'); key('2', 'conc 2'); tui._dismiss();
ok(engine._concurrency === 2, 'chromium 2 → engine._concurrency');
key('e', 'error'); tui._dismiss(); key('l', 'log'); tui._dismiss(); key('t', 'tick'); tui._dismiss();
key('v', 'filter'); key('<', 'sort'); key('>', 'sort');

// steps sub-mode: edit > tab > parse > paint > cycle verb > type > append > delete > esc
tui._mode = 'normal'; tui._cursor = 0; tui._startEdit();
ok(tui._addData.selector === '.p', 'edit prefilled target');
key('\t', 'tab → steps'); ok(tui._mode === 'steps', 'Tab opened steps');
paint('steps', null);
tui._stepCursor = tui._stepsList.length; // extraction row (btc has no steps, just extraction)
key('\x1b[D', 'cycle ext prefix');
key('\r', 'add step'); ok(tui._stepsList.length >= 1, 'enter appended step');
key('\x7f', 'backspace empty → delete'); ok(tui._stepsList.length === 0, 'backspace deletes empty step');
key('\x1b', 'esc → back to edit'); ok(tui._mode === 'edit-quest', 'esc returned to edit'); ok(tui._editingChannel === 'btc', 'edit state preserved');

// long steps pipeline must window like quest list, not push footer off-screen
tui._mode = 'steps';
tui._stepsList = Array.from({ length: 25 }, (_, i) => ({ verb: 'wait', arg: 'x' + i }));
tui._stepCursor = 0; tui._stepsScrollTop = 0;
process.stdout.rows = 12; // small terminal - 25 rows + extraction row can't fit
const stepsSmall = paint('steps (25 rows, small terminal)', null);
ok(/more ↓/.test(stepsSmall), `windowed steps show "more ↓" marker when list overflows terminal (${JSON.stringify(stepsSmall.slice(0, 200))})`);
ok(stepsSmall.includes('extract'), 'extraction row stays visible (pinned) even while steps list is windowed');
tui._stepCursor = 24; // jump cursor to last step - window must follow it
const stepsFollowed = paint('steps (cursor at last step)', null);
ok(/more ↑/.test(stepsFollowed), `scrolling to last step shows "more ↑" marker, window followed cursor (${JSON.stringify(stepsFollowed.slice(0, 200))})`);
process.stdout.rows = 30; tui._stepsList = []; tui._stepCursor = 0; tui._stepsScrollTop = 0; tui._mode = 'edit-quest';

// key flows that mutate store (reset to known state, seed quests.json)
tui._mode = 'normal'; tui._dismiss(); tui._filter = 'all'; tui._sortKey = 'default'; tui._search = ''; tui._cursor = 0;
engine._questsCache = [
  { channel: 'btc', url: 'https://x/', selector: '.p', interval: 30000, result: { value: '42', timestamp: Date.now() } },
  { channel: 'wa', url: 'https://x/', selector: '#pane', interval: 30000, result: { value: 'v', timestamp: Date.now() } },
  { channel: 'note', interval: 30000, manual: true, pinned: true },
];
writeFileSync('quests.json', JSON.stringify(engine._questsCache));

// d > delete confirm on selected channel
tui._cursor = 0; key('d', 'delete');
ok(tui._mode === 'confirm' && tui._pendingConfirm?.action === 'delete' && tui._pendingConfirm.channel === 'btc', 'd → delete confirm on cursor channel');
key('y', 'confirm delete'); await tick();
ok(!readQ().some(q => q.channel === 'btc'), 'y confirms delete (btc removed from store)');

// a > add-quest mode with fresh form
tui._mode = 'normal'; tui._dismiss(); key('a', 'add');
ok(tui._mode === 'add-quest' && tui._inputStep === 0 && tui._addData.channel === '', '→ add-quest mode with fresh form');
// on target field, left/right cycles extraction type so prefix is visible
tui._addData = { kernel: '', channel: '', url: '', selector: '.card', interval: '30000' }; tui._inputStep = 3;
key('\x1b[D', 'target ‹ cycles type'); // one left from bare value = component
ok(tui._addData.selector === 'harvest:.card', `target type cycles to harvest: component (got ${tui._addData.selector})`);
tui._dismiss();

// complete url-led line pasted into quick fill commits on one enter - channel derives
tui._mode = 'normal'; tui._dismiss(); key('a', 'add');
tui._addData = { kernel: 'http://ex.com/, #p', channel: '', url: 'http://ex.com/', selector: '#p', interval: '30000' }; tui._inputStep = 0;
key('\r', 'quick-fill enter');
ok(tui._mode === 'confirm' && tui._pendingConfirm?.action === 'add' && /^ch_q_[a-z0-9]+$/.test(tui._addData.channel),
  `quick-fill enter derives channel + reaches add confirm (mode ${tui._mode}, ch ${tui._addData.channel})`);
tui._dismiss();

// r > edit selected quest (prefills fields from it)
tui._mode = 'normal'; tui._cursor = 0; key('r', 'edit');
ok(tui._mode === 'edit-quest' && tui._editingChannel != null, `r → edit-quest mode for selected quest (${tui._editingChannel})`);
tui._dismiss();

// p > toggle pinned on selected quest
tui._mode = 'normal'; tui._cursor = 0;
const chan = tui._view()[0].channel; const wasPinned = !!tui._view()[0].pinned;
key('p', 'pin'); await tick();
ok(!!readQ().find(q => q.channel === chan)?.pinned === !wasPinned, `p toggles pinned on ${chan} (${wasPinned} → ${!wasPinned})`);

// s scrape-now dispatches real scrape; stub execute() - no real chrome, real run would hit dns.lookup
tui._mode = 'normal'; tui._cursor = 0;
const schan = tui._view()[0].channel;
const realExecute = engine.execute.bind(engine);
engine.execute = async () => ({ value: 'stub-scrape-result', timestamp: Date.now() });
key('s', 'scrape'); await tick();
engine.execute = realExecute;
const scraped = tui.e._questStates.get(schan);
ok(scraped?.status === 'success' && scraped?.lastValue === 'stub-scrape-result', `s (scrape now) dispatches scrape on ${schan} and folds result into state (${JSON.stringify(scraped)})`);

// viewport overflow: many quests in short terminal shows "more ↓" indicator
engine._questsCache = Array.from({ length: 30 }, (_, i) => ({ channel: 'q' + i, interval: 30000, manual: true, result: { value: i, timestamp: Date.now() } }));
process.stdout.rows = 10; tui._mode = 'normal'; tui._cursor = 0;
const overflow = paint('overflow', null);
ok(/more ↓/.test(overflow), 'viewport overflow shows "more ↓" indicator when quests exceed height');
process.stdout.rows = 30;

process.stdout.write = realWrite;
console.log(fails ? `tui: FAIL (${fails})` : 'tui: PASS');
process.exit(fails ? 1 : 0);