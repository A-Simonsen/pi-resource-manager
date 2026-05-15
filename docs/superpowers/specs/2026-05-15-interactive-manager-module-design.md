# Interactive Manager Module Design

## Goal

Extract Resource Manager interactive UI behavior into a focused Interactive Manager Module so `src/index.ts` stays limited to command registration.

## Current friction

`src/index.ts` currently owns two responsibilities:

1. registering Resource Manager commands with Pi, and
2. running the interactive manager UI loop, including discovery, rendering, input state, detail/list transitions, and action dispatch.

This makes the entrypoint larger than it needs to be and hides the UI boundary behind command registration code. The previous architecture slices already moved operations and presentation behavior into focused modules; this slice completes the same direction for interactive state.

## Chosen approach

Create `src/interactive-manager.js` and move the interactive seam into it:

```js
export async function openResourceManager(pi, ctx, startTab)
```

The new module owns:

- the interactive UI loop,
- non-interactive UI rejection,
- resource discovery for each loop iteration,
- `ctx.ui.custom` component construction,
- `ResourceManagerComponent` list/detail state,
- key handling and manager-result completion.

`src/index.ts` will import `openResourceManager` and remain a small extension entrypoint that registers:

- `resources`,
- `skills`,
- `resource-extensions`.

Behavior should remain unchanged. This is a pure extraction, not a UI redesign.

## Module boundaries

`src/interactive-manager.js` depends on existing seams:

- `getDefaultEnv` and `discoverResources` for discovery,
- `performResourceAction` and `formatActionFailure` for actions and action errors,
- presentation helpers for list/detail rendering,
- Pi TUI key and truncation helpers.

`src/index.ts` depends only on the Interactive Manager Module plus Pi extension types.

The `ResourceManagerComponent` class should stay private to `src/interactive-manager.js` unless tests need a small exported test seam. Prefer testing through `openResourceManager` or pure exported helper seams before exposing the component publicly.

## Data flow

1. A registered command calls `openResourceManager(pi, ctx, startTab)`.
2. If `ctx.hasUI` is false, the function notifies the user and returns.
3. The module discovers resources using the default environment.
4. `ctx.ui.custom` hosts `ResourceManagerComponent`, which renders either list view or detail view and returns a manager result through `done`.
5. `openResourceManager` sends the result to `performResourceAction`.
6. If the action says to continue, the loop refreshes discovery and reopens the UI. If the action closes or reloads, the function returns.

## Error handling

Error behavior remains unchanged:

- non-interactive mode reports `Resource Manager requires interactive UI mode.`,
- cancelled or close results return without action,
- action failures are caught and displayed through `formatActionFailure`,
- missing selected resources are ignored in list actions,
- missing detail resources fall back to list view.

No new user-facing errors are introduced.

## Tests

Add direct coverage for `src/interactive-manager.js` so the new module has its own seam independent of `src/index.ts`.

Target tests:

- `openResourceManager` rejects non-interactive contexts with the existing error notification,
- rendering an empty list still displays the Resource Manager header and empty-state text,
- list input returns the expected manager result for an action key such as `u`,
- detail input can enter detail view and return a detail action such as update.

Existing tests that verify package metadata and compatibility behavior should continue passing.

## Out of scope

- Changing Resource Manager keybindings.
- Changing labels, colors, detail text, or visible range behavior.
- Changing action semantics for update, delete, toggle, reload, or close.
- Removing compatibility exports from `src/resource-manager-core.js`.
- Redesigning the UI layout.
