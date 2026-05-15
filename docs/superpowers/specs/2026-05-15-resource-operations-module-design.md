# Resource Operations Module Design

## Goal

Extract Resource Manager action execution into a focused Resource Operations Module so `src/index.ts` owns interactive UI state and command registration, while operation behavior lives behind one deep seam.

## Current friction

`src/index.ts` currently mixes three responsibilities:

1. Pi command registration and interactive UI loop.
2. List/detail UI state in `ResourceManagerComponent`.
3. Resource action orchestration: toggle, delete, package update/remove, trusted skill update, git-managed skill update, self-extension protection, and reload prompts.

The third responsibility is the next deepening opportunity from `docs/architecture-todos.md`. It has useful leverage because a small operation interface can hide confirmation prompts, filesystem moves, command execution, cleanup, and user notifications.

## Chosen approach

Create `src/resource-operations.js` as the Resource Operations Module. Its primary interface is:

```js
export async function performResourceAction({ pi, ctx, env, discovery, result })
```

The function returns the same boolean currently returned by `handleAction`: `false` means the Resource Manager loop should close because Pi reloaded; `true` means continue the loop.

The Module owns:

- `quarantineResource(resource, env)`
- `restoreQuarantinedResource(resource, env)`
- `buildPackageCommand(action, source)`
- `getSkillUpdatePlan(resource, discovery, env)`
- package update/remove command execution
- trusted lock-based skill update execution
- git-managed skill update execution
- self-extension quarantine protection
- reload prompt behavior

`src/resource-manager-core.js` remains the compatibility seam for tests and current imports. It re-exports operations from `src/resource-operations.js` and keeps presentation helpers until the later Resource Presentation Module slice.

## Data flow

`src/index.ts` keeps the UI loop:

1. Build `env` with `getDefaultEnv()`.
2. Discover resources with `discoverResources(env)`.
3. Render and collect a `ManagerResult` from the TUI.
4. Call `performResourceAction({ pi, ctx, env, discovery, result })`.
5. Continue or exit based on the returned boolean.

The Resource Operations Module receives already-discovered data and the selected result. It performs confirmations, calls filesystem helpers or `pi.exec`, emits notifications, and asks for reload when an operation changes resources.

## Error handling

`performResourceAction` intentionally does not swallow unexpected errors from filesystem helpers or other non-command failures. The existing `openResourceManager` try/catch continues to format those with `formatActionFailure`.

Expected command failures remain user-facing notifications inside the operations Module:

- package command non-zero exit becomes `formatCommandFailure(...)`
- `git status` failure becomes `Git status failed: ...`
- dirty git repositories refuse update with a warning
- clone failure and copy/update failures produce error notifications

## Tests

Keep all existing `test/resource-manager-core.test.mjs` imports passing through compatibility re-exports.

Add tests for `performResourceAction` using fake `pi` and `ctx` adapters:

1. Package update success confirms, runs `pi update <source>`, notifies success, asks reload, and returns `false` when reload is accepted.
2. Package remove failure confirms, runs `pi remove <source>`, notifies formatted failure, and returns `true`.
3. Trusted skill update without source metadata warns and returns `true` without running commands.
4. Self-extension delete/toggle warns and returns `true` without quarantining itself.

These tests exercise the operations seam rather than the TUI.

## Out of scope

- Moving presentation helpers out of `src/resource-manager-core.js`.
- Moving `ResourceManagerComponent` or list/detail state out of `src/index.ts`.
- Adding permanent deletion for quarantined resources.
- Changing package or skill update behavior.
