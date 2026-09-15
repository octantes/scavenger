# patchbay - reference manual

This is the **complete reference manual** for the patchbay, covering the editing gestures, keybinds, wiring rules and logic-node behaviors. To embed or extend it, see the **[external contract](contract.md).** If you are just looking for a quick introduction to the project, start with the **[intro guide](../README.md#quick-start---setting-up-a-patchbay-and-harvesting).**

The patchbay has two modes, which you can toggle using `Tab`:

- In **use** mode, the patchbay just runs. Components display data, wires route values, and nothing is editable
- In **edit** mode, you can spawn nodes and wire them, paste components, move, resize, select and cut cables

The distinction matters because a **publish** export strips away the editing layer, so **you are left with a document.** Use mode lets you see how your publish will look and behave, while still keeping the studio ergonomics like pan and zoom.

> Publish strips the infinite canvas in the same pass; an export mode that preserves it is coming

## Editing

You can `click-drag` on empty canvas space to **lasso-select** multiple nodes and drag them as a group. Selected nodes can be copied and pasted at the cursor, and double clicking the drag handle in one of them flips the open state of every other selected node.

| Key | Action |
|-----|--------|
| `Tab` | Toggles use / edit modes |
| `1` to `9` | Spawns node at cursor (automatically toggles to edit mode) |
| `Space` | Arms wiring from last spawned node and establishes a connection when clicking a target |
| `Backspace` | Deletes the selected nodes and components |
| `Ctrl + C` | Copies selected nodes with their wiring |
| `Ctrl + V` | Pastes a harvested component - or copied nodes - at cursor |
| `Ctrl + Z/Y` | Undo / Redo (capped at 50 steps) |
| `Ctrl + S` | Export a quine (editor + work) |
| `Ctrl + P` | Export a publish (runtime document) |
| Held `Alt` | Snaps to the dot grid while dragging, scaling, cropping or arrow-nudging |
| `Ctrl + Wheel` | Zooms in/out (by 0.1×-5×), centered on cursor |
| `Wheel` | Pans the canvas vertically |
| `Middle-click` | Pans the canvas in any direction |

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

When one channel feeds several receivers, each fires in **DOM document order**, not canvas position or spawn order, and a paste or z-order change can reorder them - **don't build graphs that depend on which of two wired receivers fires first** - if order matters, implement it through the chain instead of fanning one channel to both.

If a target receives values on a channel and carries its own `data-scv-action` verb, both fire per value - the receive first, the element's own verb after, so the verb takes effect last. This order is deterministic to prevent races and delivery is synchronous. Chains truncate at depth 20 to prevent infinite loops.

## Logic nodes

Since nodes are **preserved but not visible on publish**, you can safely implement any logic through them. This is not the case for the components (even authored ones), which will remain visible on export.

You can spawn nodes by pressing a number; you can also automatically trigger a wire from the last placed node by pressing `Space`, and holding `Ctrl` will reverse the direction (so you can easily chain something into the newest node). Clicking on a target node confirms the visually previewed connection.

- Chaining `1 Space 2 Space 3` builds a three-node pipeline in six keystrokes

The node colors signify what each node does to a signal:

- Red and Green are only used by Clock and Quests, since both are the starting point of a chain, often coupled together
- Pink is used by any node that re-emits its held state on every received value, while Blue nodes transform a value in flight
- Grey is used by nodes that hold a value and re-emit it on demand - Reader and Action, the ending point of a chain

| Node | What it does |
|------|--------------|
| **Clock** | Emits a pulse every *n* ms on a shared grid. A negative interval keeps that period, but sits half a beat off the grid (`1000` and `-1000` alternate). Clicking the icon fires an extra pulse without moving the schedule. |
| **Accumulator** | Sums incoming values and emits the running total on every receive; click to reset. |
| **Variable** | Names the received value into a shared store any mutator can read by name (`v + variable`) and emits that value on each reassignment - click on the icon to toggle between `let/const` - a constant can't be overwritten by other nodes, its store name and the channel it emits on are independent. |
| **Gate** | Opens or closes a channel, passing values only while open; click or a received `1` toggles the gate. |
| **Comparator** | Emits 1 when its received inputs are equal; click to toggle to inequality. |
| **Mutator** | Runs `return <expr>` over each value (received value can be used as `v`, and variable-nodes are in scope too) - this is arbitrary JS execution, so treat third-party patchbays as executables. |
| **Reader** | Stores a value and re-emits it on demand. |
| **Action** | Applies an action verb to its receivers. |
| **Quest** | Subscribes to a live data channel from the quest server; the icon cycles `input` / `output` / `component` - output publishes received values back to the server, component turns a `url, selector` line into a whole live component that diff-morphs in place on each poll (see [component quests](quests.md#component-quests)). |
