# authoring - reference manual

Custom **logic nodes** and **UI components** are plain `.html` files you write in any editor. Drop one onto the patchbay to register the type and place an instance, and re-drop an edited file to live-update all instances, keeping data and wiring intact. Start from `examples/template.html`, which holds one component and one node.

Since both can run arbitrary JS, treat any file you find like any program you run. An authored component keeps its script (unlike a harvested one, which is de-fanged).

A curated node and component library lives in [examples](../examples), with many helpful components you can drop into the patchbay.

## Files

A file can hold any number of components and nodes. Opening it directly in a browser does nothing - both shapes are inert until a patchbay reads them:

- A component is a `<template data-scv-comp="name">` holding its `<style>`, markup and `<script>`
- A node is a `<script type="scv/node" data-scv-node>` calling `defineNode({ ... })` - the type is what keeps it from running on its own

Drop the file on a patchbay (or open it with `Ctrl + O`) to register what it holds and place the first instance. Drop it again to update every placed instance, with their slot data kept.

On Chromium the dropped file is followed: saving it in any editor updates the canvas within a second. Following lasts the session - after reloading the patchbay, drop the file once more. Other browsers update when you drop it again.

A patchbay holds its authored components and node types as children of its `<scv-patchbay>` element, placed or not, and its save carries exactly those. Node types are per patchbay, so two patchbays on one page can run different versions of one node. A component is one element per tag on the page, so another patchbay's different version of it is refused. A host can register a node with `pb.import(nodeFileHtml, { redefine: true })` and save it without placing one.

## Logic nodes

A node is a small program with lifecycle hooks over a `ctx` object:

```js
defineNode({
  name: 'twice',               // the only required key

  init(ctx) {                  // called once when the node connects
    ctx.mem.count = 0;
  },

  onReceive(v, ctx) {          // called when a value arrives on the wire
    ctx.output(Number(v) * 2);
  },

  onPulse(ctx) {               // called on a received pulse, and on left click
    ctx.emit(ctx.mem.count++);
  },

  teardown(ctx) {              // called when the node is removed
  },
});
```

Built-in names (`clock`, `gate` ...) and the reserved `inlet` and `outlet` are refused. Placed nodes of a type are re-pointed when a new version of it is dropped.

**Config and Node API** - keys declared alongside the hooks, `ctx` is the live node:

| Name | Meaning |
|------|---------|
| `placeholder` | Input placeholder (default none). |
| `openWidth` | Node width in px when open (`400`). |
| `label` | Hover tooltip (modes override it). |
| `inputType` | The input's type - `'text'` or `'number'`, or `false` for no input. |
| `icon` | The node's face glyph, text or inline `<svg>` (default ◆, a mode icon overrides it). |
| `color` | Accent color, any CSS value (defaults to the standard node color). |
| `defaultVal` | The input's starting value (default empty). |
| `onValue(ctx)` | Called when the input's value changes. |
| `onClick(ctx)` | Replaces `onPulse` on left click, when a click should do something a pulse doesn't. |
| `alt(ctx)` | Called on right click when the node has no modes. |
| `act(verb, ctx)` | Called when an action verb (`show`, `toggle`, `increment` ...) is sent to the node. |
| `glyph(ctx)` | Works out the icon on every paint, instead of a fixed `icon`. |
| `onInput(text, ctx)` | Takes what is typed instead of `ctx.value` - store it in `ctx.last`, which is what undo tracks. |
| `ctx.emit(v, port?)` | Send a value out the wire. |
| `ctx.output(v, port?)` | Send a value and show it above the node. |
| `ctx.value` | The node's stored value - the input's, saved as an attribute. |
| `ctx.last` | The last value the node held - persistent, saved as an attribute. |
| `ctx.mem` | Working memory for this run - rebuilt from `init`, never saved. |
| `ctx.states` | Custom states for transient looks - style them as `:host(:state(x))`, never saved. |
| `ctx.showFloat(v)` | Show overlay text above the node. |
| `ctx.flashError(label, err)` | Turn the ring red + `console.warn`. |
| `ctx.shared(key, create, release)` | One instance per page, shared by every user of the key (an `AudioContext`, say). |
| `ctx.onTeardown(fn)` / `ctx.signal` | Run `fn` or abort `signal` when the node is removed - pass `{ signal }` to every listener you add. |
| `ctx.el` / `ctx.icon` / `ctx.input` | The node's root / icon / input elements. |
| `ctx.id` / `ctx.type` | Unique ID / registered type name. |
| `ctx.x` / `ctx.y` / `ctx.setPosition(x, y)` | Position on the board. |
| `ctx.append(el, x, y)` / `ctx.remove(el)` | Add / remove an element on the board (`init` recreates it, so a save skips it). |

Persistent state lives in `ctx.value`, `ctx.last` or attributes. Transient looks go through `ctx.states`, and extra markup into the node's shadow - a class or child added to `ctx.el` itself is saved with the file.

**Modes** are optional toggleable states you can declare with `modes: [{ id, icon, label, color }]`. The active mode id is `ctx.mode`, and `onMode(id, ctx)` fires when the mode changes. Right click cycles them.

**Named ports** let a node tell its wires apart:

```js
inputs:  [{ name: 'digest' }, { name: 'legal' }],
outputs: [{ name: 'verdict' }, { name: 'abstain' }],
```

Each shows as a small anchor on the ring, with inputs on the left and outputs on the right. Dragging from or dropping on the node's body uses its first port, and dragging from or to an anchor picks that specific port.

- `onReceive(v, ctx, port, channel)` and `onPulse(ctx, p, port)` tell you which input it came in on (empty for an unported wire)
- `ctx.emit(v, 'verdict')` sends on that output only, a bare `ctx.emit(v)` on unported wires

Abstaining is just a pulse on its own output, and extra fields on a port (`type`, anything) ride along as data. The runtime never reads them - read them back with `pb.nodeType(name)`, which answers for that patchbay's own types.

**Async hooks** - any hook can be `async`:

- While it runs the node shows a green ring (`busy`); a rejection shows an error above the node and turns the ring red - an `AbortError` doesn't
- A newer `onReceive` or `onPulse` supersedes a pending one: whatever the older call emits from then on is dropped, and its `ctx.callSignal` aborts - pass it to `fetch` and the request stops
- `ctx.signal` stays the node's lifetime, `ctx.callSignal` one call's
- Once a node's run ends - deleted, or restarted by a new definition - nothing from that run gets out: a late result or a leftover timer emits nothing, and a late failure never marks the next run
- A loop through awaited hooks is stopped like any feedback loop; one through a timer runs on, like a clock

## Components

A component is written as inline HTML with markup, a `<style>` and a `<script>`, inside its template. The patchbay wraps it into a self-contained custom element.

```html
<template data-scv-comp="counter">
<style>
  button { cursor: pointer }
</style>

<div>
  <button>+</button>
  <span data-scv-slot="count">0</span>
</div>

<script>
  root.querySelector('button').addEventListener('click', () => {
    const v = root.querySelector('[data-scv-slot=count]');
    v.textContent = +v.textContent + 1;
    emit(+v.textContent, v); // send the new count out the wire
  }, { signal });
</script>
</template>
```

**Behavior, shape and wiring** - the script's scope, the slot markers and the DOM attributes:

| Name | Meaning |
|------|---------|
| `root` | The shadow root - query and mutate your markup. |
| `host` | The element itself - `host.addEventListener('scv-receive', …)` to take a wired value. |
| `emit(v, el?)` | Send a value out the wire, from `el` when given. |
| `pulse` / `isPulse(v)` | Make a pulse / tell a pulse from data. |
| `patch(el, { text, value, html, class })` | Write to an element, skipping writes that change nothing. |
| `shared(key, create, release)` | One instance per page, shared by every user of the key. |
| `onTeardown(fn)` / `signal` | Run `fn` or abort `signal` when the component is removed. |
| `asset` | The file's asset table - `asset.put(blob)` stores bytes that survive a save. |
| `data-scv-slot="name"` on **text** | Editable text, captured as HTML. |
| `data-scv-slot` on **`<img>`** | Keeps its `src`. |
| `data-scv-slot` on **`<input>`** | Keeps its `value`. |
| `data-scv-slot` on **checkbox** | Keeps its `checked` state. |
| `data-scv-emits="ch"` | The element's output travels out on channel `ch`. |
| `data-scv-receives="ch"` | Values on channel `ch` land in the element (fire `scv-receive`). |
| `data-scv-action="verb[:arg][:channel]"` | Runs the verb (`method:click`, `toggle`, `delete`, …) when a signal arrives on the channel. |
| `data-scv-port` | Where host-level cables meet the component - a drawing anchor only, routing never reads it. |
| *unmarked* | Pure layout - replaced freely on re-drop. |

A few things the scope doesn't say on its own:

- Emit from the element that holds the value - `emit(v, el)`: a wire drawn inside a component starts at the control or script emitter under the pointer, so a bare `emit(v)` only reaches wires drawn to the component itself
- A value wired into a form control lands in its value, into a plain element in its text; an element holding markup, or a component, gets it as the `scv-receive` event only - listen on `host` and every wire into the component reaches the script
- Pass `{ signal }` to every listener added on `host` or the page - the script runs again on a re-drop or an undo, and would double them otherwise
- The script also runs over a saved copy of the component: reuse elements already in `root` instead of adding them again
- Anything meant to survive a save goes through attributes, text, slots or `asset.put` - a `blob:` url made by hand dies with the page
- One `AudioContext` per page: `shared('audio', () => new AudioContext(), ac => ac.close())` - the last user leaving closes it, the next one opens a fresh context