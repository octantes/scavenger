# External contract

This document is the **boundary contract** for embedding the tool in other software and extending it through plugins. Anything that wraps the patchbay as a primitive should be built against the symbols below.

After **1.0** they are breaking changes: never rename them silently. Everything not listed here is internal **and may change in any release** - don't build against names you find by reading the source if you expect to be able to update the embedded version. Every exported file carries the version stamp `<html data-scv-runtime="<version>">` on the snapshot.

## Wire surface

Wiring attributes are part of the contract - **don't rename them** - routing, harvested components, and `.scv` definitions are all built against them.

- The `data-scv-emits` / `data-scv-receives` / `data-scv-action` attributes are the public surface of a wire
- `data-scv-action` takes `<verb>[:<arg>][:<channel>]` - `prop` / `method` / `event` are core extension verbs
- `data-scv-port` marks an element as the visual anchor cables should connect to, checked in light and shadow DOM
- The [rest of the action node verbs](patchbay.md#wiring) - like `toggle`, `delete` or `increment` - are predefined conveniences

## Programmatic routing

The only injection point on a **published** document is `routeSend`. The rest of the editor surface - `window.autoWire`, `window.defineNode`, and the studio controls below - exists in the editor/quine only. Publishing strips it.

```js
window.routeSend(channel, value)
```

Inject a value into a channel. Every receiver and action wired to `<channel>` fires with the **same semantics as the router firing from a user gesture**, and delivery is synchronous - one call runs the entire cascade and returns when it completes (chains cap at depth 20).

No channel needs declaring first: routing is derived from the DOM attributes at emit time, so injecting on a silent channel is a safe no-op - call it cross-frame from a same-origin parent `iframe.contentWindow.routeSend(...)`, or directly from any same-origin script.

```js
window.autoWire(srcEl, targetEl, channel?)
```
Connect a source node to a target node programmatically - on a fresh generated channel, or the one passed as the optional third argument. Creates or reuses cables without user interaction.

## Node registration

```js
window.defineNode(def)
```

Register a custom node type at runtime - only `name` is required, everything else (`icon`, `color`, `defaultVal`, `placeholder`, `openWidth`, and more) is optional with built-in defaults.

Existing instances with a matching `data-type` are re-pointed automatically, and because the name is embedded into a `querySelectorAll` selector, `__proto__` and names with quotes or brackets are refused. The def script is re-embedded in exported files, so a custom node survives round-trip.

## Cache and Invalidation

The router indexes which channels map to which elements, so a value doesn't re-scan the DOM on every emit. The index is derived from the DOM, never the source of truth - it rebuilds automatically when `data-scv-*` attributes change, but programmatic mutations the observer can't see leave it stale.

```js
window.invalidateCache()
```

Drop the index so the next emit rebuilds it from the live DOM. Call it after a mutation the observer can't see, like moving a wired subtree, or re-rendering an element that carries `data-scv-*` through a shadow root that's still unattached.

## Routing observation

Every delivered value raises a `scv-receive` event whose `detail` is the value. It **bubbles** on any receiver that isn't a logic node, so a host can catch it on the document or an iframe's `contentDocument`; a logic node dispatches it without bubbling, so a host that needs those emissions listens on the node itself.

## Quest Server

The editor defaults to `http://127.0.0.1:9876` (the local quest server, so authoring needs no config); a saved quine carries that value with it, while a publish makes no assumption and falls back to the page's own origin, for **hosting behind a proxy** of `/quests`. Either can be overridden with `?quest-api=<url>`.

```js
window.__QUEST_API__  // base URL for the quest server (read per call so host can retarget traffic at any time)
```

Registering a scrape job, emitting a value, or deleting a channel are all **server writes** - a patchbay's nodes can make them, and they all flow through the runtime's `questWrite` (injected into the quest client, editor and publish alike) - but quests only honors a write that arrives on a **direct loopback connection** (or an explicit `--trust-ip`) with no proxy hop (`X-Forwarded-For` absent).

A hosted artifact, or any non-local client (hand-edited or not), is refused server-side: only the owner on the host machine can write. The boundary is physical - the connection, not a capability the client lacks.

> reverse-proxy GET /quests only; never proxy POST/DELETE - writes are loopback-gated, so proxy-hop breaks them

## Editor controls (studio surface)

These top-level `window` globals drive the canvas; an overlay can use them to **pilot the editor** - editor/quine only, not present on a published document - so they're part of the contract and not renamed after 1.0 either.

```js
setMode('use' | 'edit')                                // switch mode
setZoom(zoom, cx, cy)                                  // zoom about a client point
spawnLogicNode(type, x, y)                             // spawn a logic node (doc coords)
registerScvNodeFile(scvText)                           // register a dropped .scv node type
registerComponentFile(scvText)                         // register a dropped .scv component type
handlePasteData(htmlText)                              // import a quine / publish / harvest
copySelected() / pasteSelected(cx, cy)                 // clipboard of the selection
clearSelection()                                       // drop the current selection
undo() / redo() / pushUndo(forward, backward, label)   // history management
renderCables()                                         // redraw all cables (after a wiring mutation)
getNodeRect(el)                                        // bounding rect of a scv-logic or data-scv-port, doc coords
```

## DOM Contracts

These are stable by id, class or attribute:

- `#canvas-container` - the scroll surface; `mode-edit` reflects edit mode, pan is native overflow
- `#zoom-layer` - the transformed content layer, scaled in and out about the `transform-origin`
- `.selected` on `scv-logic` / `.comp-wrapper` - the selection marker, carried by the DOM

## Kernel Controls

These top-level `window` globals drive a **running kernel session** on the page it was dropped on - a host page or automation script can pilot the palette the same way a user would, so they're part of the contract and not renamed after 1.0 either.

```js
window.scvLaunch                 // set before injecting the bookmarklet: { search: 'blur', run: true }
                                 // opens the palette pre-filtered, optionally running the top match immediately

kernel.run(id)                   // dispatch a tool by id, exactly like a palette Enter, no UI shown
kernel.summon()                  // restore the palette from its minimized dot
kernel.minimize()                // collapse the palette to its dot
```

`scvLaunch` is read once, at boot, before the bookmarklet renders anything - set it on `window` prior to injection (e.g. from an automation script driving the page) to skip the manual search-and-enter step. `kernel.run` takes the same id shown in the palette's tool list; an unknown id is a no-op. `summon`/`minimize` mirror clicking the dot or pressing `Esc`, and are safe to call regardless of the palette's current state.

## Reserved for host overlays

Attributes prefixed `data-x-*` are never read, routed, or stripped by the runtime, in any version.
