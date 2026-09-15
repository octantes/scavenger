# kernel - reference manual

The bookmarklet drops a **command palette** onto any page - a single search box over a suite of tools. `bookmarklet.js` is generated from `kernel.js`, so edit the source, not the generated file. Type to filter by name, ID, category, or type, navigate with arrows and `Enter`, or just click and scroll. The core scavenger tools sit colored at the top.

Every tool is one of four lifecycle types:

- **Toggle** tools are persistent on/off processes; click the tool again or press `Esc` to stop it.
- **Oneshot** tools fire once and the result lands in a viewer or on the clipboard.
- **Param** tools take numbers and can be stepped using `Left` and `Right` arrows.
- **Cycle** tools step through a fixed set of values, also using the arrows.

It's a persistent session, not a throwaway menu: launching opens the palette focused; `Esc` (or any page-reading tool like a sniper or capture) minimizes it to a dot in the bottom-right corner. `Esc` again closes active tools first; click the dot or double-tap `Shift` to summon it back. Press the bookmarklet again or run `close` to end it.

## Tools

These are all the tools in the kernel, grouped and ordered in the same way you see in the palette.

> You can press `Ctrl` on any tool with the "sniper-hover" mode to select the parent of the element under the cursor. This makes otherwise inaccessible containers interactable.

| Tool | Type | What it does |
|------|------|--------------|
| **[scavenge]** | - | Take things off the page - a component, a quest line, a quest line test, a watcher, or the page's whole tree and its assets. |
| `harvest` | `toggle` | Snipe an element and get a self-contained standalone copy of it (shadow DOM and all) in your clipboard - scripts stripped and network access purged, [visible iframes kept](security.md#harvest-output). |
| `quest selector` | `toggle` | Snipe an element for a `url, selector` line a quest can replay. |
| `quest steps` | `toggle` | Click a sequence of elements to script a multi-step interaction; finalize into a pipeline you edit per-step (`click`, `wait`, `type`, `drag`, `scroll`, ...) and copy as a quest line or test. |
| `quest live-emit` | `toggle` | Attach a watcher to an element; each text change `POST`s to the quest server as it happens. |
| `wiring channels` | `toggle` | Snipe a component to edit its `data-scv-emits` / `data-scv-receives` / `data-scv-action` attributes in place. |
| `tree` | `oneshot` | Interactive DOM tree in a viewer; hover to inspect, filter by event/class/depth, act per row - copy selector, purge, harvest, quest it, or download as standalone `.html` file. |
| `assets` | `oneshot` | Every image, video source, background image, and inline `svg` on the page as a click-to-open grid. |
| **[elements]** | - | Edit and inspect what's on the page: delete, resize, retype, rotate, sample a color, lift typography, or visualize isolated elements. |
| `delete` | `toggle` | Snipe-click elements off the page. |
| `size` | `toggle` | Hover an element; its real computed dimensions show in a label. |
| `text edit` | `toggle` | Flips the page to `designMode` so you can rewrite any text in place. |
| `image flip` | `oneshot` | Tilt every image and video 45°, compounding to a full rotation. |
| `eyedropper` | `oneshot` | Opens the platform's native picker; the rgba lands on your clipboard. |
| `typography` | `toggle` | Snipe an element; its computed font stack - family, size, weight, leading, letterspacing, color - copies as CSS. |
| `isolate` | `toggle` | Snipe a keep-set of elements; everything else goes `visibility: hidden`, layout intact, restored on stop. |
| **[dom & grids]** | - | Page geometry: color-coded DOM depth, rem grids and draggable crosshairs, box-model and skeleton views, stacking contexts and z-layers. |
| `x-ray center` | `cycle` | Color-coded crosshair bounds by DOM depth; cycle `full`/`top`/`mid`/`bot` bands. |
| `h-grid` | `param` | Horizontal grid lines, rem-spaced, stepped with `Left`/`Right`. |
| `v-grid` | `param` | Vertical grid lines, same control. |
| `v-line` / `h-line` | `toggle` | An infinite draggable crosshair; click to pin, double-click to unpin. |
| `box-layout` | `toggle` | A random high-contrast background on every element to expose the box model; restores on stop. |
| `skeleton` | `toggle` | Strips backgrounds and fills, outlines every element - a wireframe of the page. |
| `stacking` | `toggle` | Snipe any element; the kernel climbs to its nearest stacking-context root and labels its z-index. |
| `z-layers` | `cycle` | Options are the page's real z-index values; keep one band visible, hide the rest, restore on stop. |
| **[prints]** | - | The page's facts: fonts, props, storage, metadata, plus image and video captures. |
| `fonts` | `oneshot` | Lists the page's loaded font families. |
| `props` | `oneshot` | Dumps the window's own named properties. |
| `storage` | `oneshot` | `localStorage`, `sessionStorage`, and cookies as JSON. |
| `metadata` | `oneshot` | The page's title, meta tags, and `ld+json` schemas. |
| `capture image` | `toggle` | Drag a region; a platform picker captures it to a `.png` download. |
| `capture video` | `toggle` | Screen-records to a `.webm` via `MediaRecorder`, stopped from a rec overlay. |
| **[effects]** | - | Whole-page visual filters. |
| `blur` | `toggle` | A `5px` blur filter over the whole page. |
| `grayscale` | `toggle` | A `100%` grayscale filter over the whole page. |
| `freeze` | `toggle` | Pauses CSS animations and hijacks `rAF`/timers; everything restores on stop. |

## Console and Launch

The palette's `console` opens a tiny REPL that evaluates JS, or runs `:`-commands that can access all tools:

- `:ps` - list running processes
- `:start <id>` / `:stop <id>` - start and stop a tool
- `:purge <selector>` - strip scripts and inline event handlers
- `:harvest <selector>` - extract a component to the clipboard
- `:push <selector>` - download a component as `.html`
- `clear` wipes the log

The kernel boots from `window.scvLaunch`, which you can set before dropping the bookmarklet with: `{ search: 'blur', run: true }` to open the palette already filtered and run the command. Programmatically, `kernel.run('x-ray top')` dispatches exactly like a palette `Enter` without UI, and `kernel.summon()` / `kernel.minimize()` move between palette, viewer, and dot.
