# patchbay - reference manual

This is the **complete reference manual** for the patchbay, covering the editing gestures, keybinds, wiring rules and logic-node behaviors. To embed or extend it, see the **[external contract](contract.md).** If you are just looking for a quick introduction to the project, start with the **[intro guide](../README.md#quick-start---setting-up-a-patchbay-and-harvesting).**

The patchbay has two modes, which you can toggle using `Tab`:

- In **use** mode, the patchbay just runs. Components display data, wires route values, and nothing is editable
- In **edit** mode, you can spawn nodes and wire them, paste components, move, resize, select and cut cables

The distinction matters because a **publish** export strips away the editing layer, so **you are left with a document.** Use mode lets you see how your publish will look and behave, while still keeping the studio ergonomics like pan and zoom.

## Editing

| Key / gesture | Action |
|---------------|--------|
| `Tab` | Toggles between the use / edit modes |
| `Numbers` | Spawns a node at the cursor - `Ctrl` + double click or `Enter` opens its input |
| `Space` | Arms wire from last node - `Ctrl` reverses direction, clicking target connects it |
| `Left-click` on a node | Fires the node, triggering the same action as when receiving a pulse |
| `Right-click` on a node | Cycles between the available modes for the node type |
| `Left-click` on a cable | Cuts the connection, one layer per click |
| Drag from a node | Arms wire from the node - dropping the wire on a target connects it |
| Drag inside component | Wires from the nearest control under the cursor, else the element itself |
| Drag on empty canvas | Lasso select (`Shift` adds to current selection, `Alt` removes) |
| `Ctrl + A` | Selects everything |
| `Ctrl + C` | Copies the selection, including defs and images |
| `Ctrl + V` | Pastes a copy, a harvest, an image or a link |
| `Ctrl + D` | Duplicates the selection one cell off |
| `Ctrl` + `Left-click` | Adds or removes from the selection |
| `Ctrl` + drag | Moves the selection (`Alt` snaps to the dot grid) |
| `Shift` + drag edge | Crops from edge (`Alt` snaps to the dot grid) |
| `Backspace` / `Delete` | Deletes the selection |
| `[` / `]` | Sends the selection backwards / forwards in z-index |
| Drag a corner | Scales the selection (`Alt` snaps to the dot grid) |
| Arrows | Nudges selection 1px, 10px while holding `Shift`, one cell while holding `Alt` |
| `Ctrl + Wheel` | Zooms in/out, centered on cursor |
| `Middle-click` + drag | Pans the canvas |
| `Ctrl + Z` | Undoes (50 steps) |
| `Ctrl + Y` | Redoes (50 steps) |
| `Ctrl + S` | Exports a **quine** (keeps current state on everything) |
| `Ctrl + P` | Exports a **publish** (keeps function as document, removes editing) |
| `Ctrl + I` | Exports a **canvas** (keeps function as infinite canvas, removes editing) |
| `Ctrl + O` | Opens the file picker for imports |
| `?` | Shows or hides the key list |

`Ctrl` is `Cmd` on macOS, except `Ctrl + Wheel`.

The canvas pans by transform, so find-in-page (`Ctrl + F`) won't scroll an off-screen match into view. `Ctrl + Wheel` zooms on macOS too, since a trackpad pinch arrives as one.

Copy, paste, drop and duplicate share one path, so a copy pasted into another patchbay arrives complete (wires inside the copy keep connecting, channel names already used on the canvas are renamed to prevent cross-wiring). A pasted link becomes a styled card the quest server can upgrade with metadata, and a pasted or dropped image is stored only once in the file.

Dropping a component or node file registers its type and places an instance, dropping a new version of the same node/component updates every instance in place, keeping its data and wiring. Each patchbay keeps its own node types, so two patchbays embedded in one page can run different versions of one node. A type loaded into a patchbay stays in its file whether or not an instance is placed, so the right-click menu still offers it after reopening.

- A host can shape or replace the menu: listen for `scv-menu` on the patchbay, edit `detail.items`, or `preventDefault()` and draw your own

## Wiring

Every connection is a **named channel** carrying **one payload**. When a value is emitted on a channel, every receiver and action on it fires. The entire graph lives directly in the DOM attributes, which means a saved HTML file restores itself.

- A data source carries `data-scv-emits="<channel>"`
- A receiver carries `data-scv-receives="<channel>"`
- An action source carries `data-scv-action="<verb>[:<arg>][:<channel>]"`

| Verb | What it does |
|------|--------------|
| `prop` | Writes any property on the target - a `prop:style.--x` prefix sets a CSS custom variable |
| `method` | Calls any function on the element (`method:focus`, `method:click`, `method:reset`, etc) |
| `event` | Dispatches a `CustomEvent` in its name (`event:my-event`) - the payload rides along as detail |
| `clone` | Duplicates the target as an independent, wired copy |
| `delete` | Removes the target |
| `toggle` | Flips the target between hidden and visible |
| `hide` / `show` | Hide or reveal the target |
| `increment` | Steps a numeric value up by one |
| `decrement` | Steps a numeric value down by one |

When one channel feeds several receivers, each fires in **the order the router walks the tree** - don't build graphs that depend on which of two wired receivers fires first: if order matters, implement it through the chain instead of fanning one channel to both.

If a target receives values on a channel and carries its own `data-scv-action` verb, both fire per value - the receive first, the element's own verb after, so the verb takes effect last. This order is deterministic to prevent races and delivery is synchronous. Chains are not truncated: a value travels the whole chain, and only feedback stops it (with a visual warning) - a cascade that comes back round goes round 20 times and then stops. No single cascade delivers more than 20,000 values, and a loop through async nodes is stopped as well.

## Logic nodes

Since nodes are **preserved but not visible on publish**, you can safely implement any logic through them. This is not the case for the components (even authored ones), which will remain visible on export.

You can spawn nodes by pressing a number; you can also automatically trigger a wire from the last placed node by pressing `Space`, and holding `Ctrl` will reverse the direction (so you can easily chain something into the newest node). Clicking on a target node confirms the visually previewed connection.

- Chaining `1 Space 2 Space 3` builds a three-node pipeline in five keystrokes: a number pressed while a wire is armed spawns its node already connected

The node colors signify what each node does to a signal:

- Red and Green are only used by Clock and Quests, since both are the starting point of a chain, often coupled together
- Pink is used by any node that re-emits its held state on every received value, while Teal nodes transform a value in flight
- Grey is used by Sample, which holds a value until a pulse asks for it, and Action, which fires verbs

Every node follows three rules:

- **Pulses are their own kind of signal**: a clock emits a pulse, and data is always just data; pulses never cross the network
- **Left click triggers what a received pulse does**: the gate is the one exception, since a pulse has to pass through it
- **Right click is the node's second action**: a mode where the node has modes

| Node | Left click / Received pulse | Receives data | Right click |
|------|-----------------------------|---------------|-------------|
| **Clock** | Fires a pulse now, without altering the schedule | Numbers set the pulse interval, anything else is ignored | Toggles on-beat / off-beat (half a period off the shared grid) |
| **Accumulator** | Counts +1 | Adds the numeric value, anything that isn't readable as number is ignored | Resets to 0 |
| **Variable** | Re-emits its value | Stores it under a name for mutators to read, and emits it | Toggles between `let` / `const` (a constant can't be overwritten by other nodes) |
| **Gate** | Toggles between opened / closed | Passes it (data or a pulse) while open | Toggles between latch / once (once passes one value, then closes) |
| **Comparator** | Re-compares | Keeps the latest value of each wire and emits a pulse when they're equal/not-equal (one wire compares with previous value) | Toggles between equal / not-equal |
| **Mutator** | Re-runs on last value | Runs expression using the value as `v` (`undefined` doesn't emit, returning `pulse` sends a trigger) | Toggles between map / filter (filter passes `v` when expression is truthy) |
| **Sample** | Re-emits the held value | Holds it quietly | Toggles between sample / follow (follow holds and passes it on) |
| **Delay** | Emits a pulse after *n* ms | Emits the value after *n* ms | Toggles between delay / debounce (debounce sends once values stop arriving for *n* ms) |
| **Action** | Fires its chosen verb on its receivers | Fires its chosen verb with the value as payload | Cycles between the verb options |
| **Quest** | Fetches the quest now | Output mode posts it to the server, input ignores it | Cycles between input / output / component (component brings in a harvested component) |
