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
