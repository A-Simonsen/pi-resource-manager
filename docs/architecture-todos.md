# Architecture TODOs

Incremental slices to keep Resource Manager modules deep and avoid bloated entrypoint/core files.

## Next deepening opportunities

1. **Resource operations Module** — move quarantine/restore, package update/remove command handling, and trusted skill update planning behind one operations seam.
2. **Resource presentation Module** — move descriptions, detail panel rendering, action labels, and visible range calculations behind one presentation seam.
3. **Interactive manager Module** — move `ResourceManagerComponent` and list/detail input state out of `src/index.ts` so command registration stays small.
