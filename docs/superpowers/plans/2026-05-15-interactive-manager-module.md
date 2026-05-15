# Interactive Manager Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Resource Manager interactive UI state and UI loop behavior from `src/index.ts` into `src/interactive-manager.js` while preserving behavior.

**Architecture:** `src/index.ts` becomes a small Pi extension entrypoint that only registers commands. `src/interactive-manager.js` owns `openResourceManager`, the interactive discovery/action loop, and a private component class exposed through a small `createResourceManagerComponent` test seam. Existing discovery, operations, and presentation modules remain the dependencies for resource data, actions, and rendered text.

**Tech Stack:** Node.js ESM, TypeScript extension entrypoint, Pi extension API, `@earendil-works/pi-tui`, built-in `node:test`, `npm test`, `node --check` syntax verification.

---

## File structure

- Create `src/interactive-manager.js`: interactive Resource Manager module. Exports `openResourceManager(pi, ctx, startTab)` for production and `createResourceManagerComponent(discovery, tab, theme, done)` as a narrow direct-test seam.
- Modify `src/index.ts`: remove UI loop and component code; import `openResourceManager`; keep only default extension registration.
- Modify `test/resource-manager-core.test.mjs`: add direct interactive module tests for non-UI rejection, rendering, list action input, and detail action input.
- Modify `package.json`: include `src/interactive-manager.js` in the syntax check script.
- Modify `docs/architecture-todos.md`: mark the Interactive manager Module complete.

---

### Task 1: Add direct interactive module tests before production code

**Files:**
- Modify: `test/resource-manager-core.test.mjs`
- Create later: `src/interactive-manager.js`

- [ ] **Step 1: Add the future interactive module import**

In `test/resource-manager-core.test.mjs`, add this import below the existing direct presentation import:

```js
import {
  createResourceManagerComponent,
  openResourceManager,
} from "../src/interactive-manager.js";
```

- [ ] **Step 2: Add a theme fixture helper**

Add this helper after `makeOperationHarness`:

```js
function makeTheme() {
  return {
    bold: (value) => `**${value}**`,
    fg: (_color, value) => value,
  };
}
```

- [ ] **Step 3: Add a component harness helper**

Add this helper after `makeTheme`:

```js
function makeInteractiveComponentHarness(discovery, tab = "extensions") {
  const doneValues = [];
  const component = createResourceManagerComponent(discovery, tab, makeTheme(), (value) => {
    doneValues.push(value);
  });
  return { component, doneValues };
}
```

- [ ] **Step 4: Add a non-interactive mode test**

Add this test after `formats action and command failures with useful details`:

```js
test("interactive manager rejects non-interactive contexts", async () => {
  const notifications = [];
  await openResourceManager({}, {
    hasUI: false,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
    },
  }, "extensions");

  assert.deepEqual(notifications, [{
    message: "Resource Manager requires interactive UI mode.",
    level: "error",
  }]);
});
```

- [ ] **Step 5: Add an empty-list render test**

Add this test after the non-interactive mode test:

```js
test("interactive manager component renders an empty resource list", () => {
  const { component } = makeInteractiveComponentHarness({ packages: [], extensions: [], skills: [] });

  const rendered = component.render(80, 24).join("\n");

  assert.match(rendered, /Resource Manager/);
  assert.match(rendered, /No extensions found\./);
  assert.match(rendered, /Tab switch tabs/);
});
```

- [ ] **Step 6: Add a list action input test**

Add this test after the empty-list render test:

```js
test("interactive manager component returns list action results", () => {
  const resource = {
    kind: "package",
    name: "npm:@scope/example",
    source: "npm:@scope/example",
    scope: "settings",
  };
  const { component, doneValues } = makeInteractiveComponentHarness({
    packages: [resource],
    extensions: [],
    skills: [],
  });

  component.handleInput("u");

  assert.deepEqual(doneValues, [{
    action: "update",
    tab: "extensions",
    resource,
  }]);
});
```

- [ ] **Step 7: Add a detail action input test**

Add this test after the list action input test:

```js
test("interactive manager component returns detail action results", () => {
  const resource = {
    kind: "skill",
    name: "example-skill",
    path: "/tmp/example-skill",
    scope: "global-agents",
  };
  const { component, doneValues } = makeInteractiveComponentHarness({
    packages: [],
    extensions: [],
    skills: [resource],
  }, "skills");

  component.handleInput("\r");
  const detail = component.render(80, 24).join("\n");
  component.handleInput("\r");

  assert.match(detail, /Resource details/);
  assert.deepEqual(doneValues, [{
    action: "update",
    tab: "skills",
    resource,
  }]);
});
```

- [ ] **Step 8: Run tests and verify RED**

Run:

```bash
npm test
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/interactive-manager.js` because the module has not been created yet.

---

### Task 2: Create the Interactive Manager Module

**Files:**
- Create: `src/interactive-manager.js`
- Test: `test/resource-manager-core.test.mjs`

- [ ] **Step 1: Create `src/interactive-manager.js` with the extracted UI code**

Create `src/interactive-manager.js` with this full content:

```js
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildResourceDetailPanel,
  calculateVisibleRange,
  describeResource,
  discoverResources,
  formatActionFailure,
  getDefaultEnv,
  getDetailActionLabels,
  moveDetailActionSelection,
  performResourceAction,
} from "./resource-manager-core.js";

export async function openResourceManager(pi, ctx, startTab) {
  if (!ctx.hasUI) {
    ctx.ui.notify("Resource Manager requires interactive UI mode.", "error");
    return;
  }

  let tab = startTab;

  while (true) {
    const env = getDefaultEnv();
    const discovery = await discoverResources(env);
    const result = await ctx.ui.custom((tui, theme, _keybindings, done) => {
      const component = createResourceManagerComponent(discovery, tab, theme, done);
      return {
        render: (width) => component.render(width, tui.terminal.rows),
        invalidate: () => component.invalidate(),
        handleInput: (data) => {
          component.handleInput(data);
          tui.requestRender();
        },
      };
    });

    if (!result || result.action === "close") return;
    tab = result.tab;

    try {
      const shouldContinue = await performResourceAction({ pi, ctx, env, discovery, result });
      if (!shouldContinue) return;
    } catch (error) {
      ctx.ui.notify(formatActionFailure(result.action, result.resource, error), "error");
    }
  }
}

export function createResourceManagerComponent(discovery, tab, theme, done) {
  return new ResourceManagerComponent(discovery, tab, theme, done);
}

class ResourceManagerComponent {
  selected = 0;
  view = "list";
  detailAction = 0;
  detailMode = "summary";
  cacheKey;
  cacheLines;

  constructor(discovery, tab, theme, done) {
    this.discovery = discovery;
    this.tab = tab;
    this.theme = theme;
    this.done = done;
  }

  render(width, terminalRows = 24) {
    const cacheKey = `${width}:${terminalRows}`;
    if (this.cacheLines && this.cacheKey === cacheKey) return this.cacheLines;

    const items = this.items();
    if (this.selected >= items.length) this.selected = Math.max(0, items.length - 1);

    if (this.view === "detail") return this.renderDetail(width, items[this.selected]);

    const maxVisibleItems = this.maxVisibleItems(terminalRows);
    const range = calculateVisibleRange(items.length, this.selected, maxVisibleItems);
    const visibleItems = items.slice(range.start, range.end);

    const lines = [
      this.theme.fg("accent", this.theme.bold("Resource Manager")),
      this.renderTabs(),
      "",
    ];

    if (items.length === 0) {
      lines.push(this.theme.fg("muted", `No ${this.tab} found.`));
    } else {
      for (let offset = 0; offset < visibleItems.length; offset += 1) {
        const index = range.start + offset;
        const item = visibleItems[offset];
        const selected = index === this.selected;
        const icon = item.enabled === false ? "○" : "●";
        const label = `${selected ? ">" : " "} ${icon} ${item.name}`;
        const detail = `  ${describeResource(item)}`;
        const labelColor = item.enabled === false ? "muted" : item.kind === "package" ? "warning" : "text";
        lines.push(truncateToWidth(selected ? this.theme.fg("accent", label) : this.theme.fg(labelColor, label), width));
        lines.push(truncateToWidth(this.theme.fg("dim", detail), width));
      }

      if (items.length > visibleItems.length) {
        lines.push(this.theme.fg("dim", `Showing ${range.start + 1}-${range.end} of ${items.length}`));
      }
    }

    lines.push("");
    lines.push(this.theme.fg("dim", "Tab switch tabs • ↑↓ navigate • Enter details • x enable/disable • u update • d quarantine/remove • r reload • Esc close"));

    this.cacheKey = cacheKey;
    this.cacheLines = lines.map((line) => truncateToWidth(line, width));
    return this.cacheLines;
  }

  handleInput(data) {
    const items = this.items();
    if (matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }
    if (this.view === "detail") {
      this.handleDetailInput(data, items[this.selected]);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.tab = this.tab === "extensions" ? "skills" : "extensions";
      this.selected = 0;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected -= 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down) && this.selected < items.length - 1) {
      this.selected += 1;
      this.invalidate();
      return;
    }

    const resource = items[this.selected];
    if (!resource) return;

    if (matchesKey(data, Key.enter)) {
      this.view = "detail";
      this.detailAction = 0;
      this.detailMode = "summary";
      this.invalidate();
      return;
    }
    if (data === "x" || matchesKey(data, Key.alt("x"))) this.done({ action: "toggle", tab: this.tab, resource });
    if (data === "u" || matchesKey(data, Key.alt("u"))) this.done({ action: "update", tab: this.tab, resource });
    if (data === "d" || matchesKey(data, Key.alt("d"))) this.done({ action: "delete", tab: this.tab, resource });
    if (data === "r" || matchesKey(data, Key.alt("r"))) this.done({ action: "reload", tab: this.tab, resource });
  }

  invalidate() {
    this.cacheKey = undefined;
    this.cacheLines = undefined;
  }

  renderDetail(width, resource) {
    if (!resource) {
      this.view = "list";
      return this.render(width);
    }

    const lines = [
      this.theme.fg("accent", this.theme.bold("Resource Manager")),
      this.renderTabs(),
      "",
      ...buildResourceDetailPanel(resource, {
        mode: this.detailMode,
        selectedAction: this.detailAction,
      }),
    ];

    this.cacheKey = `${width}:detail:${this.selected}:${this.detailAction}:${this.detailMode}`;
    this.cacheLines = lines.map((line) => truncateToWidth(line, width));
    return this.cacheLines;
  }

  handleDetailInput(data, resource) {
    if (!resource) {
      this.view = "list";
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.detailAction = moveDetailActionSelection(this.detailAction, -1);
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.detailAction = moveDetailActionSelection(this.detailAction, 1);
      this.invalidate();
      return;
    }
    if (!matchesKey(data, Key.enter)) return;

    const action = getDetailActionLabels()[this.detailAction]?.toLowerCase();
    if (action === "back") {
      this.view = "list";
      this.detailMode = "summary";
      this.invalidate();
      return;
    }
    if (action === "read") {
      this.detailMode = "read";
      this.invalidate();
      return;
    }
    if (action === "locate") {
      this.detailMode = "locate";
      this.invalidate();
      return;
    }
    if (action === "update" || action === "delete") {
      this.done({ action, tab: this.tab, resource });
    }
  }

  items() {
    if (this.tab === "skills") return this.discovery.skills;
    return [...this.discovery.packages, ...this.discovery.extensions];
  }

  maxVisibleItems(terminalRows) {
    const reservedRows = 6;
    return Math.max(1, Math.floor((terminalRows - reservedRows) / 2));
  }

  renderTabs() {
    const extensions = this.tab === "extensions" ? this.theme.fg("accent", "[ Extensions ]") : this.theme.fg("muted", "  Extensions  ");
    const skills = this.tab === "skills" ? this.theme.fg("accent", "[ Skills ]") : this.theme.fg("muted", "  Skills  ");
    return `${extensions} ${skills}`;
  }
}
```

- [ ] **Step 2: Run tests and verify the new seam works**

Run:

```bash
npm test
```

Expected: PASS. The new direct interactive tests should pass while `src/index.ts` still contains the old duplicate implementation.

- [ ] **Step 3: Commit the new module and tests**

Run:

```bash
git add src/interactive-manager.js test/resource-manager-core.test.mjs
git commit -m "test: cover interactive manager module"
```

Expected: commit succeeds.

---

### Task 3: Reduce `src/index.ts` to command registration

**Files:**
- Modify: `src/index.ts`
- Test: `test/resource-manager-core.test.mjs`

- [ ] **Step 1: Replace the `src/index.ts` imports**

Replace the import block at the top of `src/index.ts`:

```ts
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildResourceDetailPanel,
  calculateVisibleRange,
  describeResource,
  discoverResources,
  formatActionFailure,
  getDefaultEnv,
  getDetailActionLabels,
  moveDetailActionSelection,
  performResourceAction,
} from "./resource-manager-core.js";
```

with:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openResourceManager } from "./interactive-manager.js";
```

- [ ] **Step 2: Remove now-local type aliases**

Delete these type aliases from `src/index.ts`:

```ts
type Tab = "extensions" | "skills";
type ManagerAction = "inspect" | "toggle" | "update" | "delete" | "reload" | "close";
type DetailMode = "summary" | "read" | "locate";
type ManagerResult = { action: ManagerAction; tab: Tab; resource?: any };
```

- [ ] **Step 3: Remove extracted implementation code**

Delete everything in `src/index.ts` after the closing brace of `resourceManagerExtension`:

```ts
async function openResourceManager(pi: ExtensionAPI, ctx: ExtensionCommandContext, startTab: Tab) {
```

through the final closing brace of the `ResourceManagerComponent` class.

After this edit, the full file should be:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openResourceManager } from "./interactive-manager.js";

export default function resourceManagerExtension(pi: ExtensionAPI) {
  pi.registerCommand("resources", {
    description: "Manage Pi extensions, packages, and skills",
    handler: async (_args, ctx) => openResourceManager(pi, ctx, "extensions"),
  });

  pi.registerCommand("skills", {
    description: "Manage Pi skills",
    handler: async (_args, ctx) => openResourceManager(pi, ctx, "skills"),
  });

  pi.registerCommand("resource-extensions", {
    description: "Manage Pi extensions and packages",
    handler: async (_args, ctx) => openResourceManager(pi, ctx, "extensions"),
  });
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test
```

Expected: PASS. Existing package entrypoint tests still pass because `extensions/resource-manager/index.ts` continues to re-export `src/index.ts`.

- [ ] **Step 5: Commit the entrypoint reduction**

Run:

```bash
git add src/index.ts
git commit -m "refactor: move interactive manager out of entrypoint"
```

Expected: commit succeeds.

---

### Task 4: Verify syntax checks cover the new module

**Files:**
- Modify: `package.json`
- Test: `src/interactive-manager.js`

- [ ] **Step 1: Expand the `check` script**

In `package.json`, replace this script:

```json
"check": "node --check src/resource-manager-core.js"
```

with:

```json
"check": "node --check src/resource-manager-core.js && node --check src/interactive-manager.js"
```

- [ ] **Step 2: Run the syntax check**

Run:

```bash
npm run check
```

Expected: PASS with both `node --check` commands exiting 0 and no syntax errors.

- [ ] **Step 3: Run tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Commit the check script update**

Run:

```bash
git add package.json
git commit -m "chore: check interactive manager syntax"
```

Expected: commit succeeds.

---

### Task 5: Mark the architecture TODO complete

**Files:**
- Modify: `docs/architecture-todos.md`

- [ ] **Step 1: Update the Interactive manager TODO line**

In `docs/architecture-todos.md`, replace this line:

```markdown
3. **Interactive manager Module** — move `ResourceManagerComponent` and list/detail input state out of `src/index.ts` so command registration stays small.
```

with:

```markdown
3. ✅ **Interactive manager Module** — `ResourceManagerComponent`, the interactive UI loop, and list/detail input state now live behind `src/interactive-manager.js` so command registration stays small.
```

- [ ] **Step 2: Run final verification**

Run:

```bash
npm test
npm run check
```

Expected: both commands PASS.

- [ ] **Step 3: Commit the completed architecture TODO**

Run:

```bash
git add docs/architecture-todos.md
git commit -m "docs: complete interactive manager module todo"
```

Expected: commit succeeds.

---

## Self-review

- Spec coverage: Task 1 adds direct tests for non-interactive rejection, empty rendering, list action input, and detail action input. Task 2 creates the Interactive Manager Module. Task 3 makes `src/index.ts` command-registration-only. Task 4 verifies the new module is covered by syntax checks. Task 5 marks the architecture TODO complete.
- Placeholder scan: no placeholder work remains; all code snippets and commands are concrete.
- Type consistency: production entrypoint imports `openResourceManager` from `src/interactive-manager.js`; the test seam is consistently named `createResourceManagerComponent`; manager result action strings match the existing operations seam.
