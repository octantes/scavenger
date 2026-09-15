# Working on scavenger

This project is **feature-frozen**: new capabilities land as new files, never as changes to the architecture of the four that ship. Only bugfixes and portability fixes touch `kernel.js`, `patchbay.html`, `compiler.html`, and `quests.mjs`. What follows are the laws that keep those files what they are - break one and it stops being scavenger.

> The kernel toolkit might expand, but the core architecture will remain untouched

- **Zero dependencies, forever** - no npm, no buildstep, no framework. Every file ships alone and boots on its own.
- **State is a function of the document** - all persistent state serializes into the DOM (attributes, frozen values), and runtime JS is working memory rebuilt at boot and folded back at save. Never introduce a hidden state model.
- **No CSS in JS** - appearance lives in stylesheets or `<style>` tags, while JS carries only geometry (left, top, w, h) and state (display). The only exceptions, by design, are measurement probes and generated artifacts.
- In `patchbay.html`, the **studio and runtime only ever point one way**: the runtime (routing, clocks, logic nodes) references nothing above it, and the studio (pointer, cables, undo, panels) drives the runtime only while authoring.
- **The kernel is a microkernel** - A tiny privileged core (event bus, process registry, register/start/stop lifecycle) with every tool as a userland process on top. Stopping a process runs its teardown and unsubscribes its bus handlers, so a tool leaves nothing behind - adding one is a single register() call.
- **The [suite](#testing) is the build** - `node test/all.mjs` gates every merge, reading stable values only (class flags, CSS vars, computed geometry), never mid-transition opacity or width, and rebuilding the bookmarklet.

## Testing

The `node test/all.mjs` suite is a zero-dependency internal harness - **20 tiers, each a separate process, aggregated to one exit code.** The browser tiers drive real headless Chromium via `test/_cdp.mjs`. This script finds a browser the same way the server does, so a Chromium-family browser must be installed. The suite shares no state with your `quests.json`.

The `build` tier compares `bookmarklet.js` against a fresh compile of `kernel.js` and rebuilds it in place if it has drifted - so running the suite after editing the kernel keeps the artifact in sync automatically. Every behavior change must land with its own assertion tier.

> The suite tests scavenger; to test other sites, use quests.mjs --run - check the [quests manual](quests.md#quests-for-testing) for more on that.

## Tiers

| Tier | Browser? | Covers |
|------|:--------:|--------|
| `unit` | - | Shared parsers + assertion logic (`parseTarget`, `parseQuestLine`, `checkExpect`). |
| `tokens` | - | Design system: every token identical across the patchbay, compiler, kernel theme, and TUI palette - fails on any drift. |
| `security` | - | SSRF guards, the loopback/token write-gate, and the real HTTP API under adversarial input (403/400/413, the 100-quest cap). |
| `build` | ✓ | The comment-stripping lexer's hard cases, and the actual decoded `bookmarklet.js` booting + running a tool. |
| `server-loop` | - | Tick scheduling + due-logic, result persistence, `onChange` alerts, `--output`/`--history`, and corrupt-file abort. |
| `tui` | - | The TUI render across every mode + the keymap. |
| `engine` | ✓ | Real `QuestEngine` CDP methods (selector/localStorage/pipeline/drag/screenshot) + `fetchJSON`. |
| `kernel` | ✓ | Palette, the quest-steps sniper, harvest fidelity, clean teardown. |
| `tools` | ✓ | **Every** kernel tool's lifecycle + sniper pick-actions, prints, effects, palette search. |
| `live-emit` | ✓ | The `quest live-emit` tool end to end (+ no zombie emit after destroy). |
| `patchbay` | ✓ | Runtime routing, logic-node behaviour, wiring, the save>reopen round-trip. |
| `studio` | ✓ | Real pointer events test for drag / lasso / copy-paste / zoom / undo. |
| `nodes` | ✓ | Deep per-node behaviour: variable modes + const-lock, comparator inequality, clock timing, the full action verb set, fan-out / fan-in. |
| `export` | ✓ | Every node type + both export formats (quine & publish) round-tripped, cable geometry. |
| `fractal` | ✓ | A patch (component + node group) re-harvested from its own publish & quine, pasted into a fresh patchbay - nodes kept, publish-hidden nodes visible again. |
| `adversarial` | ✓ | Cycles, self-wires, throwing mutators, XSS, malformed input - no crash, still functional. |
| `connectivity` | ✓ | The seams: patchbay<>quests, kernel>patchbay (clipboard), kernel>quests (grammar). |
| `compiler` | ✓ | The compiler > `.scv` > registers + runs on the patchbay. |
| `components` | ✓ | The compiler end to end: author a component, morph keeps data, `.scv` roundtrips, wires in the patchbay. |
| `cli` | ✓ | The real `--run` runner: assertion modes + exit codes 0/1/2. |

The `tools` tier occasionally flakes with a CDP timeout under full-suite load; it passes in isolation. Re-run it alone (`node test/tools.mjs`) before treating a failure as real.

The `test/harvest.mjs` harness is opt-in and isn't started by `all.mjs` - it **harvests components** off live sites and checks each copy three ways (computed style, forced `:hover` and pixel diff). It needs network and the pages drift, so it measures harvest quality rather than gating the build.

## Design system

- The patchbay `:root` is the **source of truth** for every design token; `compiler.html` copies it verbatim, and the kernel's `theme` object and quests' `PAL` carry the same names and hues. The `tokens` tier fails on any drift.
- The **two main color currents** are `--output` (pink) for output / emit / travel, and `--input` (teal) for input / hover / touch. One always means signal leaving, the other signal arriving. Node colors follow the **[taxonomy](patchbay.md#logic-nodes)**.
- The **wordmark** `s<av> { slot }` titles windows and modes; favicons for bookmarking are inline data-URI SVGs.
- Every UI copy text should be lowercase and ambient (for example: "no quests logged - press a").

## Workflow

- The `quests.json` file is your setup data - never commit it (should remain git-ignored, auto-created on first write).
- The **bookmark is frozen at paste time** - after an update, re-create the bookmarklet to pick up the changes.
- Capability expansion should live on `.scv` component and node libraries created with compiler, not on the files.
- Keep commits scoped, with lowercase imperative titles and no description. Code should explain itself with single line comments. Focus on the WHY not WHAT, and default to none.
