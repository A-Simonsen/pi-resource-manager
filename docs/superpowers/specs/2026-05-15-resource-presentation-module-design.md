# Resource Presentation Module Design

## Goal

Extract Resource Manager presentation helpers into a focused Resource Presentation Module so display-oriented behavior lives behind one pure seam while command registration, discovery, and operations stay separate.

## Current friction

`src/resource-manager-core.js` currently acts as a compatibility barrel, but it still owns presentation behavior:

1. resource summary descriptions,
2. visible list range calculation,
3. detail action labels and action-selection wrapping,
4. detail panel line construction.

These helpers are pure and already tested, which makes them a low-risk extraction. Keeping them in core makes the compatibility seam look like a domain module and obscures the next boundary: UI state in `src/index.ts` should consume presentation helpers rather than owning presentation rules itself.

## Chosen approach

Create `src/resource-presentation.js` as the Resource Presentation Module. It will export:

```js
export function describeResource(resource)
export function calculateVisibleRange(totalItems, selectedIndex, maxVisibleItems)
export function getDetailActionLabels()
export function moveDetailActionSelection(currentIndex, direction)
export function buildResourceDetailPanel(resource, options = {})
```

`src/resource-manager-core.js` remains a compatibility seam for tests and existing consumers by re-exporting these functions from `src/resource-presentation.js`.

`src/index.ts` may continue importing through `resource-manager-core.js` for this slice. That keeps the change narrow and avoids mixing this extraction with the later Interactive Manager Module slice.

`src/resource-operations.js` should import `describeResource` from `src/resource-presentation.js` directly. This avoids a circular conceptual dependency where operations reaches through the compatibility core for presentation text.

## Data flow

The Resource Manager UI loop remains unchanged:

1. Discover resources.
2. Render list and detail views.
3. Use presentation helpers for summaries, visible ranges, detail panels, and detail actions.
4. Return a selected action to the operations seam.

The new module is pure: it accepts plain resource objects and primitive options, returns strings or simple range/action values, and performs no filesystem, command, or TUI side effects.

## Error handling

Presentation helpers keep their current tolerant behavior:

- missing resources render as unknown values,
- invalid counts and indexes are clamped,
- detail mode defaults to `summary`,
- selected detail action is clamped to the action list.

No new user-facing errors are introduced.

## Tests

Keep the existing `test/resource-manager-core.test.mjs` behavior tests passing through compatibility re-exports.

Add a direct module import test for `src/resource-presentation.js` that verifies the new module exposes the presentation seam independently of `resource-manager-core.js`. The existing visible range and detail panel tests continue to cover behavior.

## Out of scope

- Moving `ResourceManagerComponent` out of `src/index.ts`.
- Extracting themed list row rendering or tab rendering.
- Changing labels, detail panel text, visible range behavior, or action semantics.
- Removing compatibility re-exports from `src/resource-manager-core.js`.
