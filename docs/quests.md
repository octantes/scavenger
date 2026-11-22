# quests - reference manual

The **quests server** headlessly scrapes a URL (CSS selector, JSON key or `localStorage` key) on an interval, and exposes each channel's latest value over HTTP. A `quest` node in the patchbay reads that value and emits it onto a wire - once on setup, then on each received pulse, so wire a `clock` node in to set the emit rhythm.

No background pushes: the node pulls the last-known value, and the scraping stays on the server's own schedule. For the one-minute version, see the [quests section](tutorial.md#harvesting-the-web-through-quests) of the tutorial; the write-gate, profile modes and live-emit auth are explained in [security](security.md), and the host-facing symbols in the [external contract](contract.md).

## Usage

**Requires Node ≥ 21.** It auto-detects a Chromium-family browser (Chromium, Chrome, Brave, Edge, Vivaldi, Opera) or honours `CHROME_PATH`. The quest store is a plain `quests.json` you can edit by hand.

```bash
node quests.mjs                    # launches the TUI; API on http://127.0.0.1:9876
node quests.mjs --run tests.json   # quests-as-tests once, exit 1 on failure
```

When hosting on **Docker / WSL**, the write-gate trusts loopback only, so a default-bridge container fails twice - prefer `docker run --network host`, else `--trust-ip <gateway-ip>` (it trusts everything through the port - firewall it).

> WSL2 usually arrives as `127.0.0.1` and needs nothing.

Since `quests.mjs` is an ES module, you can `import { QuestEngine, configure }` and **drive it** from your own Node app: `configure({ output, history, trustIps, allowLocal })` mirrors the CLI flags, `engine.init()` brings up the egress proxy, HTTP API and headless Chromium, and `engine.tick()` runs a scrape on your own interval.

## The TUI

When running in a terminal, `quests.mjs` shows a live table of quests you can drive with the keyboard - add/edit/delete quests, filter and sort, watch the value log, and change engine settings. It degrades gracefully to a headless log when stdout isn't a TTY; press `?` to see the key list inside the tool.

| Key | Where | Does |
|-----|-------|------|
| `q` `Ctrl+C` | Anywhere | Quit. |
| `?` `h` | Anywhere | Help overlay. |
| `↑↓` `j` `k` | Table | Move the selection. |
| `a` | Table | Add a quest. |
| `Enter` `r` | Table | Edit the selected quest. |
| `d` | Table | Delete it (confirm with `y` / `n`). |
| `s` | Table | Scrape it now. |
| `g` | Table | Screenshot what headless renders. |
| `c` | Table | Chromium settings - profile mode, parallel scrapes (each adds a tab, so a slow page doesn't stall the others). |
| `t` | Table | Override the tick rate. |
| `/` | Table | Search channels (type to filter, `Enter` keeps, `Esc` clears). |
| `<` `>` | Table | Cycle the sort. |
| `v` | Table | Filter all / scheduled / manual. |
| `l` | Table | Value log (then `j`/`k`/`g`/`G` scroll, `g` oldest, `G` tail). |
| `p` `m` | Table | Toggle pinned / manual. |
| `e` | Table | List every active error, then engine-side failures. |

The **add/edit form** fills field by field: `Up`/`Down` moves between rows, `Left`/`Right` cycles the target type (`sel:`, `key:`, `ls:`, `harvest:`), and `Enter` saves. Paste a `channel, url, target` line into the top `kernel quest` row and every field fills in automatically. Long step pipelines won't fit in one field, so `Tab` opens the **steps editor** row-per-step.

When a scrape mysteriously returns nothing, press `g` to **screenshot what headless actually renders** - it loads the quest on a throwaway tab (1280x800) and writes `scavenger-shot-<channel>.png` to the working directory, so you can see at a glance whether you're looking at the real page, a login wall, or an unsupported-browser page.

## CLI reference

| Flag / Env | Argument | What it does |
|------------|----------|--------------|
| `--port` `-p` | Port number | API/bind port (default `9876`). |
| `--output` `-o` | File path | Mirror every quest result to a static JSON file each tick - for a fully static deploy (serve the file, no server). |
| `--history` | File path (optional) | Append one `{ channel, value, ts }` line **on every change**. Bare `--history` auto-names `quest-history-YYYY-MM-DD.jsonl` - pass a name to override. |
| `--trust-ip` | IP (CSV) | Add non-loopback IP(s) to the **write allowlist** and bind `0.0.0.0`. `SCAV_TRUST_IP` sets the same. |
| `--allow-origin` | Origin (CSV) | Let a publish served from another origin read quests - the only way in for any non-local origin, browser extensions included. `SCAV_ALLOW_ORIGIN` sets the same. |
| `--run` | Test file path | Run quests-as-tests once, report `✓` or `✗`, exit non-zero on failure. Brings up the engine but not the API/TUI. |
| `--allow-local` | With `--run` | Relax the scrape SSRF guard so `--run` can target a local dev server. Never affects the running server or the write-gate. |
| `CHROME_PATH` | - | Browser path, overriding auto-detection. |

**Historic data** (`--history`) is written only at the scrape interval. The quest node reads just the latest value, not this log, so charts are DIY: point a small consumer at the `.jsonl`.

## Quests for testing

A **quest with an expected value is a test**. The `--run` flag runs a JSON array of entries from `tests.json`, printing `✓`/`✗` per entry, and exiting non-zero if any of them fail - so it drops straight into a CI or cron job. Each entry is one quest plus one assertion.

```json
[
  { "name": "price shows", "url": "https://shop/item", "selector": ".price", "matches": "^\\$[0-9]" },
  { "name": "logged in",   "line": "https://app/, wait:#app | sel:.user-name", "contains": "Mo" }
]
```

Assertions, tried in priority: `expect` (exact), `contains` (substring), `matches` (regex) - else the quest just has to resolve non-empty with no error. Authoring is one click: the kernel's **quest steps** sniper has a `copy as test` button that drops a ready `--run` entry - `line` plus `expect` pre-filled from the element's live text.

Target URLs must be public - the SSRF pin blocks loopback - so it verifies a live site still behaves.

## Add a quest

Spawn a **quest** node and set it with one comma-separated line - `url, target`, or `channel-name, url, target`:

```
https://news.ycombinator.com/, sel:.titleline > a
btc, https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT, key:price
my-session, https://app.example.com/, ls:auth_token
```

The node talks HTTP to the patchbay's `questApi` (default `http://127.0.0.1:9876`) - override with `?quest-api=<url>`, or proxy `/quests` under your own origin; the write boundary is in [security](security.md).

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

The flow is **linear - no loops or conditionals**. A step that never resolves fails the quest with a readable error. Steps only apply to page scrapes: a `key:` fetch has no page. `|` is the step separator, so a literal `|` inside a selector or text must be avoided.

## Component quests

A target starting with `harvest:` lifts a **whole live component** instead of a value. The server navigates (running any pipeline steps), injects the bookmarklet kernel into headless Chromium, and harvests the selector in ref-mode with a stable per-channel `uid` - tags and classes stay identical across polls, so the patchbay applies each new harvest as a **diff-morph in place**, and **wires survive**.

The channel's value is a *ref*, not the component: `component/<channel>.html#<hash>`, written to disk only when the layout actually changes (the hash is the change check and keeps `quests.json` readable), and served at `GET /component/<channel>.html`, under the same read rule as quests, for the patchbay node to load.

## Channel lifecycle

A channel is a **named value slot** the server owns, so multiple patchbays can subscribe to it. A node in **output** mode publishes each value received to the server (`POST /quests/emit`, `scv-token` for cross-origin writes).

The kernel's quest live-emit tool feeds a channel the same way, from inside a real logged-in tab. A push replaces the target's whole entry, so an emit-fed channel runs manual until a scrape registration reclaims it.

The server holds at most 100 quests - re-registering a channel never counts against it, and a refused write carries a status:

- 403 for a non-loopback (or token-less) write.
- 400 for a malformed write (bad JSON, missing channel, non-public URL, the max 100 quests cap).
- 413 for an oversized body.

[Security](security.md#live-emit---skip-impersonation-entirely) covers how live-emit and cross-origin writes are gated.

**Pinned** quests are delete-protected, not scrape config: `p` locks a quest and the server refuses the delete, so the scrape keeps feeding the other patchbays when the local node goes. Value pushes don't unpin a locked quest.

Finally, **quests as alerts**: an `onChange` target re-emits to that channel only when the value changes - it fans the value and nothing else, so the target keeps its own scrape config and pinned flag, and no emit loop can form. Set the target in the quest's edit form.