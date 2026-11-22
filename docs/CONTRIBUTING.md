# Working on scavenger

This project is **feature-frozen**: new capabilities land as new files, never as changes to the architecture of the three that ship. Only bugfixes and portability fixes touch `kernel.js`, `patchbay.html` and `quests.mjs`.

> The kernel toolkit might expand, but the core architecture will remain untouched

- **Zero dependencies, forever** - no npm, no buildstep, no framework. Every file ships alone and boots on its own.
- **State is a function of the document** - all persistent state serializes into the DOM (attributes, frozen values), and runtime JS is working memory rebuilt at boot and folded back at save. Never introduce a hidden state model.
- **No CSS in JS** - appearance lives in stylesheets or `<style>` tags, while JS carries only geometry (left, top, w, h) and state (display). The only exceptions, by design, are measurement probes and generated artifacts.
- In `patchbay.html`, the **blocks only ever point one way**: the runtime references nothing above it, the canvas references only the runtime, and the studio drives both only while authoring.
- **The kernel is a microkernel** - A tiny privileged core (event bus, process registry, register/start/stop lifecycle) with every tool as a userland process on top. Stopping a process runs its teardown and unsubscribes its bus handlers, so a tool leaves nothing behind - adding one is a single register() call.
- **The [suite](#testing) is the build** - `node test/all.mjs` gates every merge, reading stable values only (class flags, CSS vars, computed geometry), never mid-transition opacity or width, and rebuilding the bookmarklet.
- **No silent catch** - a swallowed failure logs one short line: `console.debug` in the browser files (shown at devtools' Verbose level), and the TUI's `e` view in quests (stderr when headless).

## Testing

The `node test/all.mjs` suite is a zero-dependency internal harness - **21 tiers, each a separate process, aggregated to one exit code.** The browser tiers drive real headless Chromium via `test/_cdp.mjs`. This script finds a browser the same way the server does, so a Chromium-family browser must be installed. The suite shares no state with your `quests.json`.

The `build` tier compares `bookmarklet.js` against a fresh compile of `kernel.js` and rebuilds it in place if it has drifted - so running the suite after editing the kernel keeps the artifact in sync automatically. Every behavior change must land with its own assertion tier.

> The suite tests scavenger; to test other sites, use quests.mjs --run - check the [quests manual](quests.md#quests-for-testing) for more on that.

## Tiers

| Tier | Browser? | Covers |
|------|:--------:|--------|
| `unit` | - | Shared parsers + assertion logic (`parseTarget`, `parseQuestLine`, `checkExpect`). |
| `tokens` | - | Design system: every token identical across the patchbay, kernel theme, and TUI palette - fails on any drift. |
| `security` | - | SSRF guards, the loopback/token write-gate, and the real HTTP API under adversarial input (403/400/413, the 100-quest cap). |
| `build` | ✓ | The comment-stripping lexer's hard cases, and the actual decoded `bookmarklet.js` booting + running a tool. |
| `server-loop` | - | Tick scheduling + due-logic, result persistence, `onChange` alerts, `--output`/`--history`, and corrupt-file abort. |
| `harness` | ✓ | Test browsers never outlive their tier - normal end, throw, rejection, SIG* browsers are swept by the next launch. |
| `tui` | - | The TUI render across every mode + the keymap. |
| `engine` | ✓ | Real `QuestEngine` CDP methods (selector/localStorage/pipeline/drag/screenshot) + `fetchJSON`. |
| `kernel` | ✓ | Palette, the quest-steps sniper, harvest fidelity, quiet and headless harvest, clean teardown. |
| `tools` | ✓ | **Every** kernel tool's lifecycle + sniper pick-actions, prints, effects, palette search. |
| `live-emit` | ✓ | The `quest live-emit` tool end to end (+ no zombie emit after destroy). |
| `patchbay` | ✓ | Runtime: routing, nodes, pulses, clock, quests, components, saves and exports. |
| `studio` | ✓ | Editing with real pointer and key events: modes, gestures, cables, undo, import, paste, drop, live reload. |
| `fractal` | ✓ | A patch (component + node group) re-harvested from its own publish & quine, pasted into a fresh patchbay - nodes kept, publish-hidden nodes visible again. |
| `adversarial` | ✓ | Cycles, self-wires, throwing mutators, XSS, malformed input - no crash, still functional. |
| `connectivity` | ✓ | The seams: patchbay<>quests, kernel>patchbay (clipboard), kernel>quests (grammar). |
| `examples` | ✓ | Every example imports clean, survives its own save and wires to others. |
| `behaviour` | ✓ | Every node and verb fed every kind of value, compared with `test/behaviour.md` - a behaviour change shows up as a diff to review (`--save` rewrites it). |
| `random` | ✓ | Random edits, saves and undos on a fresh seed each run, invariants checked after every step - a failure prints its seed, `--seed=n` replays it. |
| `surface` | ✓ | Every name in the frozen contract exists, each script runs alone in a foreign page, and an in-page mount starts itself in any load order. |
| `cli` | ✓ | The real `--run` runner: assertion modes + exit codes 0/1/2. |

The `tools` tier occasionally flakes with a CDP timeout under full-suite load; it passes in isolation. Re-run it alone (`node test/tools.mjs`) before treating a failure as real.

The `test/harvest.mjs` harness is opt-in and isn't started by `all.mjs` - it **harvests components** off live sites and checks each copy three ways (computed style, forced `:hover` and pixel diff). It needs network and the pages drift, so it measures harvest quality rather than gating the build.

Two runners sit beside the suite and are never part of it:

```
node test/bench.mjs     # timings against test/bench-baseline.json
node test/fuzzer.mjs    # the random tier over fresh seeds, for as long as you leave it
```

`bench` builds a large patchbay from real harvests (40 components with images, 10 instances each, full-page harvests, pasted images, 200 nodes) and records the renderer's peak memory during save and publish, plus forced layouts during a group drag and a fast clock chain. `--save` writes the numbers to `test/bench-baseline.json`, the baseline later changes are measured against.

`fuzzer` runs `random` on a new seed at a time with a wall-clock cap on each, so a seed that hangs the browser is killed, written down and stepped over instead of stopping the run. It prints every finding as a `--seed=` you can replay through `node test/random.mjs --seed=<n>`, and writes the full output to a file in your temp directory. `--hours=`, `--seeds=`, `--rounds=`, `--ops=`, `--timeout=` and `--out=` all have sane defaults.

## Design system

- The patchbay `:root` is the **source of truth** for every design token, and the kernel's `theme` object and quests' `PAL` carry the same names and hues. The `tokens` tier fails on any drift.
- The **two main color currents** are `--output` (pink) for output / emit / travel, and `--input` (teal) for input / hover / touch. One always means signal leaving, the other signal arriving. Node colors follow the **[taxonomy](patchbay.md#logic-nodes)**.
- The **wordmark** `s<av> { slot }` titles windows and modes; favicons for bookmarking are inline data-URI SVGs.
- Every UI copy text should be lowercase and ambient (for example: "no quests logged - press a").

## Workflow

- The `quests.json` file is your setup data - never commit it (should remain git-ignored, auto-created on first write).
- The **bookmark is frozen at paste time** - after an update, re-create the bookmarklet to pick up the changes.
- Capability expansion introduced through authored component and node files, not through new core files.
- Keep commits scoped, with lowercase imperative titles and no description. Code should explain itself with single line comments. Focus on the WHY not WHAT, and default to none.
