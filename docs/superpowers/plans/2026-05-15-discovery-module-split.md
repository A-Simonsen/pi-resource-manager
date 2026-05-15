# Discovery Module Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract resource discovery into a focused module without changing public imports or behavior.

**Architecture:** `src/resource-discovery.js` becomes the discovery Module for packages, skills, extensions, quarantine state, git metadata, and skill frontmatter. `src/resource-manager-core.js` keeps operations/presentation helpers and re-exports discovery to preserve the current interface.

**Tech Stack:** Node.js ESM, built-in `node:test`, JavaScript modules consumed by TypeScript entrypoint.

---

### Task 1: Extract discovery module

**Files:**
- Create: `src/resource-discovery.js`
- Modify: `src/resource-manager-core.js`
- Test: `test/resource-manager-core.test.mjs`

- [ ] **Step 1: Preserve current discovery tests**

Run: `npm test`
Expected: existing discovery tests pass before refactor.

- [ ] **Step 2: Create `src/resource-discovery.js`**

Move these exports/private helpers from `src/resource-manager-core.js` into `src/resource-discovery.js` with the same behavior:

```js
export function getDefaultEnv() { /* existing implementation */ }
export async function discoverResources(env = getDefaultEnv()) { /* existing implementation */ }
```

Also move discovery-only private helpers: `discoverSkills`, `discoverQuarantinedResources`, `findGitInfo`, `readGitOriginUrl`, `discoverExtensions`, `discoverPackages`, `findSkillFiles`, `parseSkillFrontmatter`, `readJson`, `readDirSafe`, `exists`, `isTrustedPackageSource`, `normalizePath`, and `sepAgnostic`.

Keep `SKILL_LOCK_FILE` private in the new module.

- [ ] **Step 3: Re-export discovery from core**

At the top of `src/resource-manager-core.js`, import/re-export discovery:

```js
import { getDefaultEnv } from "./resource-discovery.js";
export { discoverResources, getDefaultEnv } from "./resource-discovery.js";
```

Keep `getDefaultEnv` imported locally because operation functions use it as a default parameter.

- [ ] **Step 4: Remove unused imports and moved helpers from core**

`src/resource-manager-core.js` should retain only imports needed for operation/presentation helpers: filesystem operations for quarantine/restore/update helpers, `existsSync`, `basename`, `dirname`, `join`, and no discovery-only helpers.

- [ ] **Step 5: Add architecture TODO file**

Create `docs/architecture-todos.md` with the remaining refactor slices:

```markdown
# Architecture TODOs

Incremental slices to keep Resource Manager modules deep and avoid bloated entrypoint/core files.

## Next deepening opportunities

1. **Resource operations Module** — move quarantine/restore, package update/remove command handling, and trusted skill update planning behind one operations seam.
2. **Resource presentation Module** — move descriptions, detail panel rendering, action labels, and visible range calculations behind one presentation seam.
3. **Interactive manager Module** — move `ResourceManagerComponent` and list/detail input state out of `src/index.ts` so command registration stays small.
```

- [ ] **Step 6: Verify**

Run: `npm test`
Expected: all tests pass.

Run: `npm run check`
Expected: syntax check exits 0.
