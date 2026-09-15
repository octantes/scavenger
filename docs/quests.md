# quests - reference manual

The **quests server** headlessly scrapes a URL (CSS selector, JSON key or `localStorage` key) on an interval, and exposes each channel's latest value over HTTP. A `quest` node in the patchbay reads that value and emits it onto a wire - once on setup, then on each received `1`, so wire a `clock` node in to set the emit rhythm.

No background pushes: the node pulls the last-known value, and the scraping stays on the server's own schedule. For the one-minute version, see the [quests section](../README.md#harvesting-the-web-through-quests) of the readme; the write-gate, profile modes and live-emit auth are explained in [security](security.md), and the host-facing symbols in the [external contract](contract.md).

## Usage

**Requires Node ≥ 21** - it uses the built-in global `WebSocket` (to talk to Chromium over the DevTools protocol), only stable from Node 21 on. It auto-detects a Chromium-family browser (Chromium, Chrome, Brave, Edge, Vivaldi, Opera) or honours `CHROME_PATH`. The quest store is a plain `quests.json` you can edit by hand.

```bash
node quests.mjs                    # launches the TUI; API on http://127.0.0.1:9876
node quests.mjs --run tests.json   # quests-as-tests once, exit 1 on failure
```

When hosting on **Docker / WSL**, the write-gate trusts loopback only, so a default-bridge container fails twice - prefer `docker run --network host`; if that's not possible, `--trust-ip <gateway-ip>` re-allows writes and binds `0.0.0.0` (trusting everything through the port - firewall it).

> WSL2 usually arrives as `127.0.0.1` and needs nothing.

Since `quests.mjs` is an ES module, you can `import { QuestEngine, configure }` and **drive it** from your own Node app: `configure({ output, history, trustIps, allowLocal })` mirrors the CLI flags, `engine.init()` brings up the egress proxy, HTTP API and headless Chromium, and `engine.tick()` runs a scrape on your own interval.

## The TUI

When running in a terminal, `quests.mjs` shows a live table of quests you can drive with the keyboard - add/edit/delete quests, filter and sort, watch the value log, and change engine settings. It degrades gracefully to a headless log when stdout isn't a TTY; press `?` to see the key list inside the tool.

| Key | Where | Does |
|-----|-------|------|
| `q` `Ctrl+C` | Anywhere | Quit. |
| `?` `h` | Anywhere | Help overlay. |
| `Esc` | Anywhere | Dismiss the current overlay. |
| `↑↓` `j` `k` | Table | Move the selection. |
| `a` | Table | Add a quest. |
| `Enter` `r` | Table | Edit the selected quest. |
| `d` | Table | Delete it (confirm with `y` / `n`). |
| `s` | Table | Scrape it now. |
| `g` | Table | Screenshot what headless renders. |
| `c` | Table | Chromium settings - profile mode, parallel scrapes. |
| `t` | Table | Override the tick rate. |
| `/` | Table | Search channels (type to filter, `Enter` keeps, `Esc` clears). |
| `<` `>` | Table | Cycle the sort. |
| `v` | Table | Filter all / scheduled / manual. |
| `l` | Table | Value log (then `j`/`k`/`g`/`G` scroll, `g` oldest, `G` tail). |
| `p` `m` | Table | Toggle pinned / manual. |
| `e` | Table | List every active error. |
| `Scroll` | Table or log | Move the selection or scroll the log. |

> The **Chromium menu** sets **parallel scrapes** - each step adds one extra tab, so a slow page no longer stalls the others.

The **add/edit form** fills field by field: `Up`/`Down` moves between rows, `Left`/`Right` cycles the target type (`sel:`, `key:`, `ls:`, `harvest:`), and `Enter` saves. Paste a `channel, url, target` line into the top `kernel quest` row and every field fills in automatically. Long step pipelines won't fit in one field, so `Tab` opens the **steps editor** row-per-step.

When a scrape mysteriously returns nothing, press `g` to **screenshot what headless actually renders** - it loads the quest on a throwaway tab (1280x800) and writes `scavenger-shot-<channel>.png` to the working directory, so you can see at a glance whether you're looking at the real page, a login wall, or an unsupported-browser page.

## CLI reference

The CLI in one table - a flag, its alias, and the env var that sets the same thing:

| Flag / Env | Argument | What it does |
|------------|----------|--------------|
| `--port` `-p` | Port number | API/bind port (default `9876`). |
| `--output` `-o` | File path | Mirror every quest result to a static JSON file each tick - for a fully static deploy (serve the file, no server). |
| `--history` | File path (optional) | Append one `{ channel, value, ts }` line **on every change**. Bare `--history` auto-names `quest-history-YYYY-MM-DD.jsonl` - pass a name to override. |
| `--trust-ip` | IP (CSV) | Add non-loopback IP(s) to the **write allowlist** and bind `0.0.0.0`. `SCAV_TRUST_IP` sets the same. |
| `--run` | Test file path | Run quests-as-tests once, report `✓` or `✗`, exit non-zero on failure. Brings up the engine but not the API/TUI. |
| `--allow-local` | With `--run` | Relax the scrape SSRF guard so `--run` can target a local dev server. Never affects the running server or the write-gate. |
| `CHROME_PATH` | - | Browser path, overriding auto-detection. |

> Env vars mirror flags: `SCAV_TRUST_IP=172.17.0.1 node quests.mjs` does what `--trust-ip 172.17.0.1` does

**Historic data** (`--history`) is written only when a value changes - a flat value emits nothing - and only at the scrape interval. The quest node reads just the latest value, not this log, so charts are DIY: point a small consumer at the `.jsonl`.

## Quests for testing

A **quest with an expected value is a test**. The `--run` flag runs a JSON array of entries from `tests.json`, printing `✓`/`✗` per entry, and exiting non-zero if any of them fail - so it drops straight into a CI or cron job. Each entry is one quest plus one assertion.

```json
[
  { "name": "price shows", "url": "https://shop/item", "selector": ".price", "matches": "^\\$[0-9]" },
  { "name": "logged in",   "line": "https://app/, wait:#app | sel:.user-name", "contains": "Mo" }
]
```

Assertions, tried in priority: `expect` (exact), `contains` (substring), `matches` (regex) - else the quest just has to resolve non-empty with no error. Authoring is one click: the kernel's **quest steps** sniper has a `copy as test` button that drops a ready `--run` entry - `line` plus `expect` pre-filled from the element's live text.

> `--run` tests the sites you want - to test scavenger itself, run `node test/all.mjs` for the 20-tier [internal suite](CONTRIBUTING.md#testing).

The engine comes up (egress proxy + headless Chromium), but not the API server or TUI. Target URLs must be public - the SSRF pin blocks loopback - so it verifies a live site still behaves; `--allow-local` aims it at a local dev server instead.

## Add a quest

Spawn a **quest** node and set it with one comma-separated line - `url, target`, or `channel-name, url, target`:

```
https://news.ycombinator.com/, sel:.titleline > a
btc, https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT, key:price
my-session, https://app.example.com/, ls:auth_token
```

The node talks HTTP to `window.__QUEST_API__` (default `http://127.0.0.1:9876`) - override with `?quest-api=<url>`, or proxy `/quests` under your own origin; the write boundary is the [external contract](contract.md#quest-server).

| Field | Optional | What it does |
|-------|:--------:|--------------|
| `channel-name` | ✓ | The human name the node reads. Omit it and the channel hashes from the URL - starting the line with `http(s)://` signals the omission. |
| `url` | ✓ | Registers a server-side scrape feeding the channel when present; a bare `channel-name` only subscribes. |
| `target` | ✗ | What to lift: `sel:` a CSS selector, `key:` a JSON key, `ls:` a `localStorage` key, `harvest:` a whole [live component](#component-quests). The shorthand and `ls:` rules are in [how a scrape runs](#how-a-scrape-runs). |

The node shows the channel's value, or `[waiting]` until the first one lands (scrape errors go to the browser's console, not the node). A channel value is always a **string** - `key:` and `ls:` JSON-stringify objects and arrays (`ls:auth > {"token":"..."}`); a JSON-API scalar arrives in its string form, and `JSON.parse` restores structure. The scrape **interval is server-side**, per quest in `quests.json`.

> The line splits on commas into `name, url, target` - the target keeps its commas (`sel:.a, .b` works), while a literal comma inside the URL must be percent-encoded (`%2C`).

## How a scrape runs

A selector (or `ls:`) scrape waits for the page's `load` event, then **polls for up to ~12s** for the element/key to appear - SPAs paint their real content seconds after load, so a one-shot read misses it. If the window is missed, the quest reports a visible **error** (`selector matched nothing after 12s`) instead of returning empty.

The target field can be a `|`-separated pipeline with zero or more **interaction steps**, finishing with the **extraction** (the last segment must be a `sel:`, `key:`, `ls:` or `harvest:`). Steps let you reach content that only exists after you act on the page:

```
wa-last, https://web.whatsapp.com/, wait:#pane-side // wrapped here for reading
  | click:span[title="Mom"]
  | wait:.message-in
  | sel:.message-in:last-child .copyable-text
```

Each step verb addresses an element by CSS selector, and each **waits** for it, so they survive re-renders between steps:

| Verb | What it does |
|------|--------------|
| `wait:<selector>` `wait:<ms>` | Waits for an element to appear or for a fixed pause. |
| `click:<selector>` | Clicks the element. |
| `scroll:<selector>` `scroll:<px>` | Scrolls the element into view or scrolls the window. |
| `type:<selector>=<text>` | Focuses and sets a field's value, firing `input`/`change`. |
| `drag:<from-selector>=><to-selector>` | Pointer + mouse down/move/up gesture between element centres - node wiring, sliders. Covers mouse/pointer drag, not native HTML5 drag-and-drop. |

The flow is **linear - no loops or conditionals**. A step that never resolves fails the quest with a readable error; press `g` to screenshot and debug the pipeline. Steps only apply to page scrapes: a `key:` fetch has no page. `|` is the step separator, so a literal `|` inside a selector or text must be avoided.

## Component quests

A target starting with `harvest:` lifts a **whole live component** instead of a value. The server navigates (running any pipeline steps), injects the bookmarklet kernel into headless Chromium, and harvests the selector in ref-mode with a stable per-channel `uid` - tags and classes stay identical across polls, so the patchbay applies each new harvest as a **diff-morph in place**, and **wires survive**.

The channel's value is a *ref*, not the component: `component/<channel>.html#<hash>`, written to disk only when the layout actually changes (the hash is the change check and keeps `quests.json` readable), and served read-public at `GET /component/<channel>.html` for the patchbay node to load.

> A component quest is heavier than a value scrape (a full page load and a harvest per poll), so budget its interval accordingly.

## Channel lifecycle

A channel is a **named value slot** the server owns. Reads pull, the node holds the last value, and every receiver wired to the name fires when a new value lands. Because the slot lives on the server, it can be subscribed to from multiple patchbays.

The node reads by default; clicking the icon cycles between `input` / `output` / `component` modes - **output** publishes each value received to the server (`POST /quests/emit`, `scv-token` for cross-origin writes); **component** turns a `url, selector` line into a whole live component.

The kernel's quest live-emit tool feeds a channel the same way, from inside a real logged-in tab. A push replaces the target's whole entry, so an emit-fed channel runs manual until a scrape registration reclaims it.

The server holds at most 100 quests - re-registering a channel never counts against it, and a refused write carries a status: 

- 403 for a non-loopback (or token-less) write.
- 400 for a malformed write (bad JSON, missing channel, non-public URL, the max 100 quests cap).
- 413 for an oversized body - see [security](security.md#live-emit---skip-impersonation-entirely) for how live-emit and cross-origin writes are gated.

**Pinned** quests are delete-protected, not scrape config: `p` locks a quest and the server refuses the delete, so the scrape keeps feeding the other patchbays when the local node goes. Value pushes don't unpin a locked quest.

Finally, **quests as alerts**: an `onChange` target re-emits to that channel only when the value changes - it fans the value and nothing else, so the target keeps its own scrape config and pinned flag, and no emit loop can form. Set the target in the quest's edit form.
