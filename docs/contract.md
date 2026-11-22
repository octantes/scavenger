# External contract

This document is the **boundary contract** for embedding the tool in other software and extending it through plugins. Anything that wraps the patchbay as a primitive should be built against the symbols below.

From **2.0** they are frozen: renaming one is a breaking change. Everything not listed here is internal **and may change in any release** - don't build against names you find by reading the source if you expect to be able to update the embedded version. Every exported file carries the version stamp `<html data-scv-runtime="<version>">` on the snapshot.

## Frozen surface

The `<scv-patchbay>` element:

```js
pb.routeSend(channel, value) / pb.onRoute(fn) / pb.invalidate()   // runtime
pb.questApi                                                       // runtime
pb.nodeType(name)                                                 // runtime
pb.setView(x, y, zoom) / pb.setZoom(zoom, cx, cy)                 // canvas
pb.import(html) / pb.copy() / pb.duplicate()                      // studio
pb.save(kind) / pb.export(kind)                                   // studio
pb.spawn(type, x, y) / pb.wire(src, target)                       // studio
pb.select(elements) / pb.selection() / pb.undo() / pb.redo()      // studio
pb.setMode('use' | 'edit')                                        // studio
```

The events it raises:

```js
scv-menu       // cancelable, does not bubble - detail { items, kind, x, y, target, from, reverse, port, wire }
scv-overload   // does not bubble - detail { node, channel, reason } - the router stopped a cascade, or cleared a mark (reason null)
scv-receive    // bubbles out of shadow roots - detail is the value, event.channel the channel
```

The class, `customElements.get('scv-patchbay')`:

```js
ScvPatchbay.use(addon)     // addon(pb, kit) runs on every patchbay
```

For a host taking in harvests by hand, with the same run-nothing rule as paste - all on `ScvPatchbay.kit`:

```js
kit.harvestOf(defText)     // a harvest's def read as data > { tag, markup, fonts }, defanged
kit.defineHarvest(h)       // defines the element from that markup
kit.defang(root)           // strips scripts, handlers and javascript: links from a tree
```

- The ids `scv-runtime-css` (the theme, a `<style>`), `scv-runtime`, `scv-canvas` and `scv-studio` stay: each runs on its own in a page that isn't a patchbay file, in any order
- The runtime alone routes, the canvas adds pan and zoom, the studio editing - a patchbay starts itself when it connects, there is no boot call to make
- Each script block is one self-contained function - `(function scvRuntime() { ... })()`, likewise `scvCanvas`, `scvStudio` - which lets a save write it back whole
- The theme's token rule carries `--scv-theme: <version>`, which is how a save finds it wherever the page loaded it
- Also frozen: wiring attributes, `window.routeSend` in a patchbay file, bridge messages and the `$kernel` controls below
- Everything else in `kit` is internal and can change without notice

## Right-click menu

The right-click menu, on the `<scv-patchbay>` element, is the `scv-menu` event. Edit `detail.items` before it opens to add, remove or reorder items, or `preventDefault()` to draw your own. It doesn't bubble - listen on each patchbay.

| Field | Meaning |
|-------|---------|
| `items` | The menu, as `{ id, label, key?, fn }` - `key` is a node's spawn number; ids are `mode`, `node:<type>`, `comp:<tag>`, `save:quine`, `save:canvas`, `save:publish` and `cycle` |
| `kind` | `'canvas'` for a right click, `'wire'` for a wire dropped on empty canvas, `'node'` for a right click on a node |
| `x` / `y` | Where it opened, in canvas coordinates |
| `target` | The item or node under the pointer, or `null` |
| `from` / `reverse` / `port` | The wire waiting to be finished, if any - its start, whether `Ctrl` reversed it, and the port it leaves by |
| `wire(node)` | Finishes that wire into `node`, exactly as a built-in item would |

A node's menu holds only `cycle`: left untouched it runs at once and no menu opens. A suppressed menu still cancels a waiting wire, so nothing is left half-drawn.

## Wire surface

Wiring attributes are part of the contract - **don't rename them** - routing, harvested components, and authored components and nodes are all built against them.

- The `data-scv-emits` / `data-scv-receives` / `data-scv-action` attributes are the public surface of a wire
- `data-scv-action` takes `<verb>[:<arg>][:<channel>]` - `prop` / `method` / `event` are core extension verbs
- `data-scv-port` marks an element as the visual anchor cables should connect to, checked in light and shadow DOM
- A wiring token may carry a port: `data-scv-receives="ch_a@digest"`, `data-scv-emits="ch_c@verdict"`. Routing matches the channel before `@`, and the port only tells a node which input or output it is. `@` is therefore never part of a channel name, and a quest name with one is refused
- The [rest of the action node verbs](patchbay.md#wiring) - like `toggle`, `delete` or `increment` - are predefined conveniences

## Programmatic routing

The only injection point on a **published** document is `routeSend`, a method of the `<scv-patchbay>` element - several patchbays on one page each route their own channels.

```js
pb.routeSend(channel, value)
```

A standalone file also keeps `window.routeSend`, pointing at its one patchbay, so a same-origin parent can still call `iframe.contentWindow.routeSend(...)` - a frame from another origin takes [messages](#embedding) instead.

Inject a value into a channel: every receiver and action wired to `<channel>` fires with the **same semantics as the router firing from a user gesture**, and delivery is synchronous. One call runs the entire cascade and returns when it completes. A chain runs its whole length - only feedback stops: a cascade that comes back round goes round 20 times, one cascade delivers at most 20,000 values, and one task starts at most 10,000 cascades, which is what catches a loop through async nodes. Delivery is a recursive call, so the browser's own stack is the ceiling on a single chain.

When the router stops a cascade, the node responsible shows the reason above it, its outgoing cables turn red, and the console warns once with the channel. A `scv-overload` event fires on the patchbay, with `node: null` when there is no node to blame. The mark stays until that same channel is sent again and gets through cleanly, or until the wiring changes so it can no longer happen.

No channel needs declaring first: routing is derived from the DOM attributes at emit time, so injecting on a silent channel is a safe no-op.

## Embedding

The simplest embed is the whole file in a frame - nothing to take apart:

```html
<iframe src="my-patchbay.html"></iframe>
```

Once the frame's `load` event has fired, talk to it with messages - a message sent before the file has booted is lost. Only the frame's parent window is listened to and answered:

```js
frame.contentWindow.postMessage({ scv: 'route', channel, value }, '*')   // send a value into a channel
frame.contentWindow.postMessage({ scv: 'listen', channel }, '*')         // get every value on a channel back
frame.contentWindow.postMessage({ scv: 'unlisten', channel }, '*')       // stop getting them
frame.contentWindow.postMessage({ scv: 'describe' }, '*')                // ask what the patch offers
```

A listened channel answers with `{ scv: 'receive', channel, value }` for every value. `describe` answers with `{ scv: 'description', version, channels: [{ name, emits, receives, ports }], nodes: [{ type, inputs, outputs }] }`, read from the page - nothing runs.

- Values are copied, not moved - the frame's own receivers still get them
- A pulse crosses as `{ scv: 'pulse', t }`, with `t` in milliseconds since the epoch, so you can schedule against it directly
- Audio crosses as `{ scv: 'audio', sampleRate, channels }`

A frame from your own origin shares your instances - one `AudioContext` for you and the patch. A page running its own patchbay lends every key it already holds; any other page offers them before loading frames, and the runtime never releases what you lend:

```js
window.scvShared = { audio: myAudioContext }
```

Mounting the patchbay straight into your own page, without a frame, is for hosts that need it to share their DOM: copy the `scv-runtime-css` style and the `scv-runtime` script (plus `scv-canvas` and `scv-studio` for pan, zoom and editing) and place `<scv-patchbay>` anywhere - it starts itself. A mounted patchbay keeps its own theme and ignores your page's text styles, installs no globals, and its saves are complete files. Taking it out of the page ends it; to park one, hide it.

## Cache and Invalidation

The router indexes which channels map to which elements, so a value doesn't re-scan the DOM on every emit. The index is derived from the DOM, never the source of truth - it rebuilds automatically when `data-scv-*` attributes change, when items are added and removed, and when a component adds or removes a wired element inside its own shadow, but programmatic mutations the observer can't see leave it stale.

```js
pb.invalidate()
```

Drop the index so the next emit rebuilds it from the live DOM. Call it after a mutation the observer can't see, like moving a wired subtree, or re-rendering an element that carries `data-scv-*` through a shadow root that's still unattached.

## Routing observation

Every value delivered to an element raises a `scv-receive` event that bubbles out of shadow roots - `detail` is the value and `event.channel` the channel it arrived on - so a host can catch it on the document or an iframe's `contentDocument`.

An `undefined` value arrives as `null` (an event's `detail` can't hold `undefined`) and a mutator returning `undefined` sends nothing (only `routeSend` can send one). Strings, numbers and booleans are also written into a form control's value or an element's text; objects and pulses arrive by the event only.

An element that is a component, or holds controls, components or wired elements, gets the event only too (so a value never wipes them). Logic nodes take values directly and raise no event - to watch a node's output, wire a receiver to it.

## Quest Server

The editor defaults to `http://127.0.0.1:9876` (the local quest server, so authoring needs no config) - the default lives in the editor, so a quine has it and a canvas or publish doesn't: those fall back to the page's own origin, for **hosting behind a proxy** of its reads. Either can be overridden with `?quest-api=<url>` - a quest server on another origin only answers if it was launched with `--allow-origin`.

```js
pb.questApi  // base URL for this patchbay's quest server - read per call so a host can retarget traffic at any time
```

Registering a scrape job, emitting a value, or deleting a channel are all **server writes** - a patchbay's nodes can make them - but quests only honors a write that arrives on a **direct loopback connection** (or an explicit `--trust-ip`) with no proxy hop (`X-Forwarded-For` absent).

A hosted artifact, or any non-local client (hand-edited or not), is refused server-side: only the owner on the host machine can write. The boundary is physical - the connection, not a capability the client lacks.

## DOM Contracts

These are stable by element and state:

- the patchbay is `<scv-patchbay>`
- items are `<scv-item>`
- nodes are `<scv-logic>`
- selection is `:state(selected)`
- state while an async hook runs is `:state(busy)`
- state after a hook failed is `:state(error)`
- state while the router holds a node responsible for a stopped cascade is `:state(stalled)`
- edit mode is `scv-patchbay:state(edit)`

A nested `<scv-patchbay>` is an item, and its parent moves, scales, copies and saves it as one unit, without ever selecting or wiring into it. Routing never crosses inside it, and node/component types stay separated. Everything travels inside the parent, but the parent never learns them. While the nested patchbay is focused and in edit mode, the pointer and keys are its own. In use mode, the parent treats it as plain content, except `Tab`, which always switches the focused patchbay.

## Saved files

A save writes one HTML file, in this order:

- the head: charset, viewport, title and icon, then anything you added to the head yourself where you put it, with the theme and the runtime in their places - `<base>` is dropped, and anything with an id starting `scv-` is scav's own and rebuilt on load, never copied
- the `<scv-patchbay>`: its own component templates and node scripts first, then items and nodes
- the asset table (`<script type="scv/asset">`), each image once
- harvest definitions, then the canvas and studio scripts the export kind keeps

The three kinds are the same file with fewer scripts: a **quine** keeps runtime, canvas and studio (editing), a **canvas** keeps runtime and canvas (infinite pan and zoom, no editing), a **publish** keeps the runtime only (a plain document). Deleting the script elements by hand gives the same files.

- The theme and the three scripts are written by the runtime from its own copy, never copied out of the page
- `extent="W H"` on the patchbay is the page size a publish scrolls to, written at every save
- Remote images are copied into the file when their server allows cross-origin reads (CORS); the rest stay links and need the network
- What a browser extension injected into the head can't be told apart from your own, so it is kept too

## Kernel Controls

The `window.$kernel` object drives a **running kernel session** on the page it was dropped on - a host page or automation script can pilot the palette the same way a user would, so it's part of the contract and frozen from 2.0 like the rest.

```js
window.scvLaunch                        // set before injecting the bookmarklet: { search: 'blur', run: true }
                                        // opens the palette pre-filtered, optionally running the top match immediately

window.scvLaunch = { headless: true }   // boot with no palette, dot or viewer

$kernel.run(id)                         // dispatch a tool by id, exactly like a palette Enter, no UI shown
$kernel.summon()                        // restore the palette from its minimized dot
$kernel.minimize()                      // collapse the palette to its dot
$kernel.harvest(target, { quiet })      // element or selector > the component's html, as the harvest tool makes it
```

`scvLaunch` is read once, at boot, before the bookmarklet renders anything - set it on `window` prior to injection (e.g. from an automation script driving the page) to skip the manual search-and-enter step. `$kernel.run` takes a tool id, plus a mode for cycle tools (`'xray top'`) - an unknown id returns `unknown command: <id>`. `summon`/`minimize` mirror clicking the dot or pressing `Esc`, and are safe to call regardless of the palette's current state.

A kernel booted in headless draws nothing while `$kernel.run` and `$kernel.harvest` still answer, and a oneshot tool's result comes back from `run` instead of opening the viewer. `summon()` or `minimize()` ends headless, and so does running a tool that needs the screen (wiring, eyedropper, quest steps).

- `$kernel.harvest` resolves to the same html the harvest tool copies
- `{ quiet: true }` keeps its status off the page

## Reserved for host overlays

Attributes prefixed `data-x-*` are never read, routed, or stripped by the runtime, in any version.
