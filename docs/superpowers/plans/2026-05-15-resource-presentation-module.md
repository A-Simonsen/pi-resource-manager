# Resource Presentation Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Resource Manager presentation helpers into `src/resource-presentation.js` while preserving existing behavior and compatibility imports.

**Architecture:** `src/resource-presentation.js` owns pure presentation helpers for resource summaries, visible ranges, detail action labels/selection, and detail panel line construction. `src/resource-manager-core.js` becomes a thinner compatibility barrel that re-exports discovery, operations, and presentation helpers. `src/resource-operations.js` imports `describeResource` directly from the presentation module to avoid relying on the compatibility barrel for presentation text.

**Tech Stack:** Node.js ESM, TypeScript entrypoint consuming JavaScript modules, built-in `node:test`, `npm test`, `node --check` syntax verification.

---

## File structure

- Create `src/resource-presentation.js`: pure presentation helper module. No filesystem, TUI, Pi, or process side effects.
- Modify `src/resource-manager-core.js`: remove local presentation helper implementations and re-export them from `src/resource-presentation.js`.
- Modify `src/resource-operations.js`: change `describeResource` import from `resource-manager-core.js` to `resource-presentation.js`.
- Modify `test/resource-manager-core.test.mjs`: add a direct import from `src/resource-presentation.js` and one direct seam test.
- Modify `docs/architecture-todos.md`: mark Resource presentation Module complete.

---

### Task 1: Add a direct presentation module test before production code

**Files:**
- Modify: `test/resource-manager-core.test.mjs`
- Create later: `src/resource-presentation.js`

- [ ] **Step 1: Add a direct import for the future presentation module**

In `test/resource-manager-core.test.mjs`, add this import below the existing import from `../src/resource-manager-core.js`:

```js
import {
  buildResourceDetailPanel as buildResourceDetailPanelDirect,
  calculateVisibleRange as calculateVisibleRangeDirect,
  describeResource as describeResourceDirect,
  getDetailActionLabels as getDetailActionLabelsDirect,
  moveDetailActionSelection as moveDetailActionSelectionDirect,
} from "../src/resource-presentation.js";
```

- [ ] **Step 2: Add a direct seam test**

Add this test after `formats action and command failures with useful details`:

```js
test("exposes presentation helpers from the Resource Presentation Module", () => {
  const resource = {
    kind: "skill",
    name: "direct-skill",
    scope: "global-agents",
    path: "/tmp/direct-skill",
    trusted: true,
    updateStatus: "trusted-lock",
    source: "https://github.com/example/skills.git",
  };

  assert.equal(
    describeResourceDirect(resource),
    "skill · global-agents · trusted source · trusted-lock · https://github.com/example/skills.git",
  );
  assert.deepEqual(calculateVisibleRangeDirect(10, 9, 3), { start: 7, end: 10 });
  assert.deepEqual(getDetailActionLabelsDirect(), ["Update", "Delete", "Read", "Locate", "Back"]);
  assert.equal(moveDetailActionSelectionDirect(0, -1), 4);
  assert.match(buildResourceDetailPanelDirect(resource, { selectedAction: 3 }).join("\n"), /direct-skill/);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` or equivalent because `src/resource-presentation.js` does not exist yet.

---

### Task 2: Create the Resource Presentation Module and re-export it through core

**Files:**
- Create: `src/resource-presentation.js`
- Modify: `src/resource-manager-core.js`
- Test: `test/resource-manager-core.test.mjs`

- [ ] **Step 1: Create `src/resource-presentation.js`**

Create `src/resource-presentation.js` with the presentation helpers exactly matching current behavior:

```js
export function describeResource(resource) {
  const parts = [resource.kind, resource.scope];
  if (resource.trusted) parts.push("trusted source");
  if (resource.updateStatus) parts.push(resource.updateStatus);
  if (resource.source) parts.push(resource.source);
  return parts.filter(Boolean).join(" · ");
}

export function calculateVisibleRange(totalItems, selectedIndex, maxVisibleItems) {
  const total = Math.max(0, Number(totalItems) || 0);
  if (total === 0) return { start: 0, end: 0 };

  const visible = Math.max(1, Math.min(total, Math.floor(Number(maxVisibleItems) || 1)));
  const selected = Math.max(0, Math.min(total - 1, Math.floor(Number(selectedIndex) || 0)));
  const start = Math.max(0, Math.min(selected - visible + 1, total - visible));
  return { start, end: start + visible };
}

const DETAIL_ACTION_LABELS = ["Update", "Delete", "Read", "Locate", "Back"];

export function getDetailActionLabels() {
  return [...DETAIL_ACTION_LABELS];
}

export function moveDetailActionSelection(currentIndex, direction) {
  const total = DETAIL_ACTION_LABELS.length;
  const current = Math.max(0, Math.min(total - 1, Math.floor(Number(currentIndex) || 0)));
  const delta = direction < 0 ? -1 : 1;
  return (current + delta + total) % total;
}

export function buildResourceDetailPanel(resource, options = {}) {
  const mode = options.mode || "summary";
  const selectedAction = Math.max(0, Math.min(DETAIL_ACTION_LABELS.length - 1, Math.floor(Number(options.selectedAction) || 0)));
  const lines = [
    "Resource details",
    `Name: ${resource?.name || "<unknown>"}`,
    `Kind: ${resource?.kind || "unknown"}`,
    `Status: ${resource?.enabled === false ? "disabled/quarantined" : "enabled"}`,
  ];

  const summary = describeResource(resource || {});
  if (summary) lines.push(`Summary: ${summary}`);
  if (resource?.description) lines.push(`Description: ${resource.description}`);
  if (resource?.source) lines.push(`Source: ${resource.source}`);
  if (resource?.path) lines.push(`Path: ${resource.path}`);
  if (resource?.originalPath) lines.push(`Original path: ${resource.originalPath}`);
  if (resource?.skillFile) lines.push(`Skill file: ${resource.skillFile}`);

  if (mode === "read") {
    lines.push("", "Read", summary || "No additional readable metadata is available for this resource.");
  }

  if (mode === "locate") {
    lines.push("", "Location", resource?.path || resource?.source || resource?.originalPath || "No path or source is available for this resource.");
  }

  lines.push("", `Actions: ${DETAIL_ACTION_LABELS.map((label, index) => `${index === selectedAction ? "> " : "  "}[ ${label} ]`).join(" ")}`);
  lines.push("Use ←/→ to choose an action, Enter to run it, Esc to close Resource Manager.");
  return lines;
}
```

- [ ] **Step 2: Replace local presentation implementations in core with re-exports**

In `src/resource-manager-core.js`, after the existing discovery and operations re-exports, add:

```js
export {
  buildResourceDetailPanel,
  calculateVisibleRange,
  describeResource,
  getDetailActionLabels,
  moveDetailActionSelection,
} from "./resource-presentation.js";
```

Then delete the local presentation block from `src/resource-manager-core.js`, starting at:

```js
export function describeResource(resource) {
```

and ending after the closing brace of:

```js
export function buildResourceDetailPanel(resource, options = {}) {
```

This removes the local `DETAIL_ACTION_LABELS` constant too. Leave `formatActionFailure`, `formatCommandFailure`, and its private `getErrorMessage` helper in `src/resource-manager-core.js`.

- [ ] **Step 3: Run tests and verify GREEN**

Run:

```bash
npm test
```

Expected: all tests PASS, including both compatibility imports from `resource-manager-core.js` and direct imports from `resource-presentation.js`.

---

### Task 3: Point operations at the presentation module directly

**Files:**
- Modify: `src/resource-operations.js`
- Test: `test/resource-manager-core.test.mjs`

- [ ] **Step 1: Update imports in `src/resource-operations.js`**

Replace this import:

```js
import { describeResource, formatCommandFailure } from "./resource-manager-core.js";
```

with these imports:

```js
import { formatCommandFailure } from "./resource-manager-core.js";
import { describeResource } from "./resource-presentation.js";
```

- [ ] **Step 2: Run tests**

Run:

```bash
npm test
```

Expected: all tests PASS.

- [ ] **Step 3: Run syntax check**

Run:

```bash
npm run check
```

Expected: exits 0 with no syntax errors.

---

### Task 4: Mark the architecture TODO complete

**Files:**
- Modify: `docs/architecture-todos.md`

- [ ] **Step 1: Update the Resource presentation TODO line**

Replace this line in `docs/architecture-todos.md`:

```markdown
2. **Resource presentation Module** — move descriptions, detail panel rendering, action labels, and visible range calculations behind one presentation seam.
```

with:

```markdown
2. ✅ **Resource presentation Module** — descriptions, detail panel rendering, action labels, and visible range calculations now live behind `src/resource-presentation.js`.
```

- [ ] **Step 2: Run final verification**

Run:

```bash
npm test
npm run check
```

Expected: both commands PASS.

- [ ] **Step 3: Commit the completed slice**

Run:

```bash
git add src/resource-presentation.js src/resource-manager-core.js src/resource-operations.js test/resource-manager-core.test.mjs docs/architecture-todos.md
git commit -m "refactor: extract resource presentation module"
```

Expected: commit succeeds.

---

## Self-review

- Spec coverage: Task 1 adds direct seam coverage; Task 2 creates and re-exports the module; Task 3 updates operations to import presentation directly; Task 4 marks the architecture TODO complete.
- Placeholder scan: no TBD/TODO/fill-in placeholders remain.
- Type consistency: exported names match the spec exactly: `describeResource`, `calculateVisibleRange`, `getDetailActionLabels`, `moveDetailActionSelection`, and `buildResourceDetailPanel`.
