# sidenavHelper

A web tool that turns a pasted, styled site-index page into a paste-ready `<nav class="au-sidenav">` block for the **au-sidenav** component.

## What it does

1. **Paste** — paste the visible site index from any site (e.g. https://www.army.edu/Site-Index/) into the paste-target. The browser preserves the nested `<ul>`/`<li>`/`<a href>` structure on the clipboard's `text/html` payload, even though plain-text paste would discard it.
2. **Pick a root** — click any page in the captured tree to make it the top of your sidenav. Skip this to use the entire sitemap.
3. **Edit pages** — rename labels, exclude pages with a checkbox (cascades to descendants), drag rows to reorder within a level. Set the heading text for the `<h3>`.
4. **Live preview** — the menu renders inline using the real `sidenav.css` / `sidenav.js`, so you see exactly what the DNN page will get. Preview links open in a new tab.
5. **Copy HTML** — one paste-ready `<nav>…</nav>` block.

## Development

```bash
npm install
npm run dev         # http://localhost:5173
npm run build       # tsc --noEmit && vite build → dist/
npm run preview     # serve dist/ locally
npm run test        # vitest in watch mode
npm run test:run    # one-shot vitest
npm run typecheck
npm run lint
```

## au-sidenav assets

The preview and the generated output target the **au-sidenav** component. A copy of `sidenav.css` and `sidenav.js` lives under [src/vendor/au-sidenav/](src/vendor/au-sidenav/) and is bundled at build time. To refresh after the upstream component changes, copy the two files over the vendored copies.

## XSS notes

User-pasted HTML is parsed with `DOMParser` (which never executes scripts), and only `href`/label text are extracted. Both are escaped on output, and a scheme deny-list (`javascript:`, `data:`, `vbscript:`, `file:`) is enforced at parse time *and* render time. See `sitemap.generateSidenavHtml.test.ts` for the XSS-hardening fixture.
