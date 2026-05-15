# Architecture TODOs

Incremental slices to keep Resource Manager modules deep and avoid bloated entrypoint/core files.

## Next deepening opportunities

1. ✅ **Resource operations Module** — action orchestration, quarantine/restore, package update/remove command handling, and trusted skill update planning now live behind `src/resource-operations.js`.
2. ✅ **Resource presentation Module** — descriptions, detail panel rendering, action labels, and visible range calculations now live behind `src/resource-presentation.js`.
3. ✅ **Interactive manager Module** — `ResourceManagerComponent`, the interactive UI loop, and list/detail input state now live behind `src/interactive-manager.js` so command registration stays small.
