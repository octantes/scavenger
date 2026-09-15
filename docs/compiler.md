# compiler - reference manual

The compiler is a standalone editor with two targets. Build a custom **logic node** or a **UI component**, test it live in the rig, and export a `.scv` - a self-contained file holding the full definition in plain HTML. Drop it onto the patchbay to register the type and place an instance, and re-drop an edited `.scv` to live-update all instances, keeping data and wiring intact.

Since both can run arbitrary JS, treat any `.scv` like any program you run. An authored component keeps its script and runs on trust (unlike a harvested one, which is de-fanged).

A curated node and component library lives in [examples](../examples), with many helpful components you can drop into the patchbay.

## Logic nodes

A node is a small program with three lifecycle hooks over a `ctx` object:

```js
init(ctx) {              // called once when the node connects
  ctx.value = 0;
},

onReceive(value, ctx) {  // called when a value arrives on the wire
  ctx.emit(value * 2);
},

teardown(ctx) {          // called when the node is removed
}
```

**Config and Node API** - keys declared alongside the hooks, `ctx` is the live node (optional keys, plus the full set in [node registration](contract.md#node-registration)):

| Name | Meaning |
|------|---------|
| `placeholder` | Input placeholder (default none). |
| `openWidth` | Node width in px when open (`400`). |
| `label` | Hover tooltip (modes override it). |
| `inputType` | The input's type — `'text'` or `'number'`. |
| `icon` | The node's face glyph (default ◆, a mode icon overrides it). |
| `color` | Accent color, any CSS value (defaults to the standard node color). |
| `defaultVal` | The input's starting value (default empty). |
| `ctx.emit(v)` | Send a value out the wire. |
| `ctx.value` | The node's stored value. |
| `ctx.showFloat(v)` | Show overlay text above the node. |
| `ctx.flashError(label, err)` | Flash a red border + `console.warn`. |
| `ctx.el` / `ctx.icon` / `ctx.input` | The node's root / icon / input elements. |
| `ctx.el.classList` | Toggle state classes: `.active`, `.node-pulse`, `.scv-node-error`. |
| `ctx.id` / `ctx.type` | Unique ID / registered type name. |
| `ctx.x` / `ctx.y` / `ctx.setPosition(x, y)` | Position on the board. |
| `ctx.append(el, x, y)` / `ctx.remove(el)` | Add / remove an element on the board. |

**Modes** are optional toggleable states you can declare with `modes: [{ id, icon, label, color }]`. The active mode id is `ctx.mode`, and `onMode(id, ctx)` fires when the mode changes.

## Components

A component is written as inline HTML with markup, a `<style>` and a `<script>`. The compiler wraps it into a self-contained custom element.

```html
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
    emit(+v.textContent); // send the new count out the wire
  });
</script>
```

**Behavior, shape and wiring** - the script's scope, the slot markers and the DOM attributes:

| Name | Meaning |
|------|---------|
| `root` | The shadow root — query and mutate your markup. |
| `host` | The element itself — `host.addEventListener('scv-receive', …)` to take a wired value. |
| `emit(v)` | Send a value out the wire. |
| `data-scv-slot="name"` on **text** | Editable text, captured as HTML. |
| `data-scv-slot` on **`<img>`** | Keeps its `src`. |
| `data-scv-slot` on **`<input>`** | Keeps its `value`. |
| `data-scv-slot` on **checkbox** | Keeps its `checked` state. |
| `data-scv-emits="ch"` | The element's output travels out on channel `ch`. |
| `data-scv-receives="ch"` | Values on channel `ch` land in the element (fire `scv-receive`). |
| `data-scv-action="verb[:arg][:channel]"` | Runs the verb (`method:click`, `toggle`, `delete`, …) when a signal arrives on the channel. |
| *unmarked* | Pure layout — replaced freely on re-drop. |

## Exports

Export produces one `.scv` - plain HTML carrying the definition, an embedded copy of its source (so it round-trips back into the compiler), and a favicon. It's the **same format the patchbay reads on paste or drop**; see the [external contract](contract.md#external-contract) for the runtime hooks it's built against.
