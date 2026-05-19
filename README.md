# sidenavHelper

A web tool that turns a pasted, styled site-index page into a paste-ready `<nav class="au-sidenav">` block for the **au-sidenav** component.

## What it does

1. **Paste** — paste the visible site index from any site (e.g. https://www.army.edu/Site-Index/) into the paste-target. The browser preserves the nested `<ul>`/`<li>`/`<a href>` structure on the clipboard's `text/html` payload. A "raw HTML" textarea is available as a fallback.
2. **Pick a root** — click any page in the captured tree to make it the top of your sidenav. Skip this to use the entire sitemap. Choose how the root is rendered:
   - **Sibling (default)** — root pinned at the top with " Home" appended, its children listed below as siblings.
   - **Omit** — root is hidden; only its children appear.
   - **Parent** / **Parent (expanded)** — root appears as a parent item with its children nested underneath, collapsed or expanded by default.
3. **Edit pages** — rename labels, uncheck to exclude pages from the menu, drag rows to reorder within a level, edit per-page URLs, add or delete pages, and mark individual links as external (preserves the full URL even when site-root-relative output is selected). Set the heading text for the `<h3>`.
4. **Live preview** — the menu renders inline using the real `sidenav.css` / `sidenav.js`, so you see exactly what the DNN page will get. Preview links open in a new tab so you don't navigate away from the helper.
5. **Copy HTML** — one paste-ready block. By default the CSS and JS are inlined as `<style>` and `<script>` tags so the snippet works in a DNN HTML module with no skin changes. Untick either toggle to drop the inline asset (and download the matching `sidenav.css` / `sidenav.js` separately if you'd rather reference them from the page skin). Output hrefs default to site-root-relative (`/about/team`); tick "Include full URLs" to keep protocol + host.

## For developers

```bash
npm install
npm run dev         # http://localhost:5173
npm run build       # tsc --noEmit && vite build → dist/
npm run test:run    # one-shot vitest (happy-dom)
npm run typecheck
```

Stack: React 19 + Vite + Tailwind v4 + Vitest. All app state lives in a single `useState<State>` at the `App` root; the parse / transform / generate pipeline lives in pure helpers under [src/lib/sitemap.ts](src/lib/sitemap.ts) with co-located vitest files.
