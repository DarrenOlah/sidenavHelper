# CLAUDE.md

## Commands

```bash
npm run dev         # Vite dev server (localhost:5173)
npm run build       # tsc --noEmit && vite build → dist/
npm run test:run    # one-shot vitest (happy-dom env)
npm run typecheck
```

## Architecture

Single-page React app: React 19 + Vite + Tailwind v4 + Vitest. All state in a single `useState<State>` at the `App` root; pure helpers live in `src/lib/sitemap.ts` with co-located vitest files.

### Pipeline

```
clipboard text/html
   ↓ parseSitemapHtml (DOMParser → walk <ul>/<li>/<a>)
SitemapNode[]                      ←── editable in App via rename/toggle/reorder/selectSubtree
   ↓ generateSidenavHtml
<nav class="au-sidenav">…</nav>    ←── targets the au-sidenav component
   ↓ inline preview (dangerouslySetInnerHTML + window.AuSidenav.initNav)
```

### Merge pipeline (site index → existing menu)

When a previously-generated menu is pasted and then a fresh site index is pasted on top, the app opens a **staged review** instead of editing anything:

```
diffForests()      raw entries: added / removed / renamed / moved        lib/diff.ts
   ↓
buildMergePlan()   MergeChange[] grouped into phases, with dependsOn     lib/plan.ts
   ↓
applyPlan()        one transactional forest rewrite, on Apply only       lib/plan.ts
   ↓
<ReviewMode/>      full-screen: plan list + stepper + staged result      ReviewMode.tsx
```

The merge policy: **the site index is authoritative for structure and URLs; the existing menu is authoritative for page names and for logical groupings that have no counterpart in the site hierarchy.**

`diff.ts` answers "what is textually different". It cannot answer "what happened", and consolidating the two is the point of `plan.ts`. A single editorial event — an href-less group page becoming a real page — produces one add plus a move for *every* descendant in the raw diff. On the checked-in example that is 38 entries for one decision.

`buildMergePlan` folds those into three phases, which fall out of a real dependency graph (you cannot place a page inside a container before deciding what that container is):

| phase | means | change kinds |
|---|---|---|
| `identity` | what a node **is** | `promote`, `demote`, `url-rename` |
| `structure` | where nodes **live** | `add-subtree`, `move`, `remove`, `reorder` |
| `labels` | cosmetic | `relabel` |

Consolidation rules, in order: promote a menu-only group whose internal pages all sit under a new site page (suppressing the descendant "moves" that were only describing the missing level); turn a **label-matched pair whose hrefs differ** into a `url-rename`; pair a same-parent leftover remove + add into one `url-rename`; fold descendant adds into their ancestor; ignore site-index shortcut links; suppress the tool's own sibling-mode `" Home"` suffix.

That second rule exists because `diffForests` cannot express it. Its label fallback pairs "same name, no URL match" nodes, and from then on the href difference has nowhere to go — `renamed` is href-matched-only and `moved` compares *ancestor* paths, which don't change when only the node's own URL did. The pair is reported on `DiffResult.matched` and `plan.ts` decides it is a rename. Before that rule existed these pages vanished from the review entirely and the merged menu kept a dead link.

`reorder` is the one rule that reads position rather than identity, and it is per-container by construction: one change per parent, naming only the complement of the longest increasing subsequence of the site-side indices, so a single displaced page reads as one page moving rather than a list being rewritten around it. Two guards keep it off the href-less-category tolerance that `UrlPath` already encodes — a menu parent with no site counterpart is skipped whole, and a child whose counterpart is not a *direct* child of that counterpart is not a participant. Without them the `Audiences` fixture and the forest top level both report phantom reorders. Applying it is slot-preserving (`reorderChildrenSubset`): only participants move, and only among the slots they already occupy, which is why the change carries no `dependsOn` and composes with an add or a removal under the same parent either way. It does need to run *first* among them, though — `insertAtSitePosition` anchors a new page against the siblings already in the menu, so resequencing before inserting is what lets an accepted add land where the site index puts it. An add and a reorder under one parent share a `docOrder`, so `orderChanges` breaks that tie explicitly (`kindRank`) rather than leaving it to the order `buildMergePlan` pushed them in.

Defaults that encode the policy: renames keep **your** label, removals are **never** staged automatically, **order is yours** and is never rewritten without a click, adds and promotions are staged.

Two invariants in `applyPlan`, each enforced per change with the change refused rather than half-applied:

- **No orphans.** Every insert resolves a concrete parent id; nothing is ever appended to the forest top level. With a picked root the forest is `[rootNode]` and `App` renders `selectSubtree(forest, rootId)`, so a node appended beside the root is invisible in the editor *and* absent from the copied HTML. Blocked changes report a reason instead of guessing.
- **No duplicate links.** See below.

### Duplicate links break "you are here"

`sidenav.js`'s `findCurrentLink` returns on the **first** anchor whose path matches the visitor's, then walks up marking `--current-section` and expanding that branch. So the same page linked from two places leaves the second copy permanently unreachable *and* expands the wrong section — with nothing visibly wrong in the markup.

`lib/duplicates.ts` guards this. `normalizeMenuPath` **must** stay a mirror of `normalizePath` in `sidenav.js`: path only (`new URL(href, origin).pathname` — the host is discarded), lowercased, trailing slash forced. Neither `normalizeHref` (host-aware) nor `normalizeHrefForMatch` (keeps `?search`) produces the same buckets.

- `error` — two or more **internal** links share a path.
- `warning` — an internal and an external link share a path.
- **Not reported** — external-only groups. Off-site links commonly point at a host root, so several normalize to `/`; that is expected and flagging it is noise.

Surfaced as a standing banner over the Edit Menu (not just during a merge — duplicates can be introduced by hand), as a per-row marker, and as a hard block in `applyPlan`. `sidenav.test.ts` pins the first-wins behavior as a deliberate regression test: it is a property of the vendored component, so the helper's job is to refuse to emit menus that trigger it.

### Vendored au-sidenav

`src/vendor/au-sidenav/sidenav.css` and `src/vendor/au-sidenav/sidenav.js` are vendored copies of the **au-sidenav** component. They are imported at build time:

- `sidenav.css` via `?raw` and injected once into `<head>` so the inline preview matches the real DNN deployment.
- `sidenav.js` as a side-effect import — its IIFE registers `window.AuSidenav` which the preview re-invokes via `initNav(navEl)` after every state change.

These files are the authoritative copy of au-sidenav's CSS and JS — edit them here as the source of truth. There is no upstream to refresh from.

### Why dnd-kit

Reorder is sibling-only (within one `<ul>` level). Each `EditableTree` instance is its own `DndContext` + `SortableContext`. Cross-level drag is intentionally out of scope.

### XSS surface

The preview uses `dangerouslySetInnerHTML`, so `generateSidenavHtml`'s output must be safe by construction:

- Label text is escaped via `escapeHtml`.
- Hrefs are escaped via `escapeAttr` AND filtered against `REJECTED_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:']` at both parse time (`resolveHref`) and render time (`safeHref`).
- Preview-only: anchors get `target="_blank" rel="noopener noreferrer"` added via DOM walk after init, so clicks don't navigate the helper away. The copied output is unchanged.

The `XSS hardening` describe block in `sitemap.generateSidenavHtml.test.ts` exercises malicious labels and hrefs and asserts no script tags, no rejected-scheme hrefs, and no `on*` attributes survive.

### Output format contract

`generateSidenavHtml` must produce markup that au-sidenav's `sidenav.js` can initialize. The hard rules:

- Every parent `<li>` needs **all three**: `<a>`, `<button class="au-sidenav__toggle">`, `<ul class="au-sidenav__sublist">`.
- Leaf `<li>` is just `<a>`.
- Don't pre-set `--collapsed` / `--expanded` / `--current-section` / `__link--current` — `sidenav.js` adds those on init.

The round-trip test in `sitemap.generateSidenavHtml.test.ts` re-parses the output to assert structural fidelity.
