// Pure helpers for the sidenav helper:
//   - parse pasted clipboard HTML into a SitemapNode[] forest
//   - mutate that forest immutably (rename, include, reorder, pick subtree)
//   - emit a paste-ready <nav class="au-sidenav"> block matching the markup
//     authored in the au-sidenav component.
//
// Kept free of React so they can be unit-tested with literal HTML strings.

export interface SitemapNode {
  id: string
  href: string
  defaultLabel: string
  label: string
  included: boolean
  children: SitemapNode[]
  // When true, render the href verbatim (full URL with host) regardless of
  // the global hrefMode. Used to keep external links — to systems on a
  // different host — from being mangled into broken site-root-relative paths.
  external?: boolean
}

export interface ParseResult {
  forest: SitemapNode[]
  pageCount: number
  maxDepth: number
  // Text content of the first `.au-sidenav__header` element in the pasted
  // markup, if any. Empty string when no header was found. Lets the App
  // round-trip a previously-generated menu's custom header back into the
  // "Header text" field.
  detectedHeaderText: string
  // True when the parsed markup carries au-sidenav class markers — i.e. the
  // pasted HTML is output from a previously-generated menu, not a fresh site
  // index. Enables the Compare-with-Site-Index flow in the App.
  isAuSidenavOutput: boolean
}

// ── Parsing ─────────────────────────────────────────────────────────────────

let __idCounter = 0
function nextId(): string {
  __idCounter += 1
  return 'n' + __idCounter
}

// Reset between top-level parses so test runs are deterministic.
function resetIds(): void {
  __idCounter = 0
}

// Parse clipboard HTML → forest of SitemapNodes. The input is whatever lands in
// `clipboardData.getData('text/html')` when the user copies a styled <ul>
// site-index. Strategy: parse with DOMParser, find every <a href> inside any
// <ul>, group them by their nearest enclosing <ul>, recurse.
export function parseSitemapHtml(html: string): ParseResult {
  resetIds()

  if (!html || !html.trim()) {
    return { forest: [], pageCount: 0, maxDepth: 0, detectedHeaderText: '', isAuSidenavOutput: false }
  }

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const baseHref = doc.querySelector('base')?.getAttribute('href') ?? undefined
  const headerEl = doc.querySelector('.au-sidenav__header')
  const detectedHeaderText = (headerEl?.textContent || '').replace(/\s+/g, ' ').trim()
  const isAuSidenavOutput =
    doc.querySelector('.au-sidenav') !== null ||
    doc.querySelector('.au-sidenav__sublist') !== null ||
    doc.querySelector('.au-sidenav__list') !== null

  // Find candidate top-level <ul> elements: every <ul> that is NOT contained
  // inside another <ul>. This covers both "selection includes the wrapper"
  // and "selection is a series of sibling <ul>s" cases.
  const allLists = Array.from(doc.querySelectorAll('ul'))
  const topLists = allLists.filter(ul => !ul.parentElement?.closest('ul'))

  // If there are no <ul>s but we still have <a>s (e.g. pasted as a flat
  // anchor list), fall back to a flat forest of leaf links.
  if (topLists.length === 0) {
    const links = Array.from(doc.querySelectorAll('a[href]'))
    const forest = links
      .map(a => buildLeaf(a as HTMLAnchorElement, baseHref))
      .filter((n): n is SitemapNode => n !== null)
    return summarize(forest, detectedHeaderText, isAuSidenavOutput)
  }

  const forest: SitemapNode[] = []
  for (const ul of topLists) {
    forest.push(...listToNodes(ul, baseHref))
  }
  return summarize(forest, detectedHeaderText, isAuSidenavOutput)
}

// Pick the clipboard flavor that yields the richer parse. Copying from a
// rendered page puts real DOM in text/html; copying from a source/code view
// puts syntax-highlighted noise in text/html (styling spans with the angle
// brackets escaped to entities) and the real markup in text/plain. Parse both,
// keep whichever produced more pages. Ties prefer text/html so a rendered-page
// paste behaves exactly as before.
//
// Each parseSitemapHtml call resets the id counter from 0, and we only ever use
// one of the two results, so the double parse can't cause id collisions.
export function parseBestSitemap(
  html: string,
  text: string,
): { result: ParseResult; source: string } {
  const fromHtml = html ? parseSitemapHtml(html) : null
  const fromText = text ? parseSitemapHtml(text) : null
  if (fromHtml && fromText) {
    return fromText.pageCount > fromHtml.pageCount
      ? { result: fromText, source: text }
      : { result: fromHtml, source: html }
  }
  if (fromHtml) return { result: fromHtml, source: html }
  if (fromText) return { result: fromText, source: text }
  return { result: parseSitemapHtml(''), source: '' }
}

function listToNodes(ul: Element, baseHref: string | undefined): SitemapNode[] {
  const items: SitemapNode[] = []
  // Direct child <li>s only — recursion handles nested <ul>s.
  for (const li of Array.from(ul.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue
    const node = liToNode(li, baseHref)
    if (node) items.push(node)
  }
  return items
}

function liToNode(li: Element, baseHref: string | undefined): SitemapNode | null {
  // The first <a href> inside this <li> that is NOT inside a nested <ul>
  // is the item's own link. Anything inside a child <ul> belongs to children.
  const ownAnchor = findOwnAnchor(li)

  // Children come from the first nested <ul> directly inside this <li>.
  const childUl = Array.from(li.children).find(c => c.tagName.toLowerCase() === 'ul')
  const children = childUl ? listToNodes(childUl, baseHref) : []

  if (!ownAnchor) {
    // No anchor on this row, but children present — collapse children into
    // the parent's level rather than dropping them. (Common in markup that
    // uses a plain text label as a header above a nested list.)
    if (children.length > 0) {
      // Promote children — caller will still get them via the wrapping list.
      // We represent the headerless row as a no-href node so the user can
      // either rename + include, or exclude it entirely.
      const label = (firstTextLabel(li) || '(no label)').trim()
      return {
        id: nextId(),
        href: '',
        defaultLabel: label,
        label,
        included: true,
        children,
      }
    }
    // Leaf row with no anchor: recognize this helper's own plain-text marker
    // (.au-sidenav__text — emitted for href-less items) so a generated menu
    // re-pasted back into the helper preserves its visual group labels
    // instead of silently dropping them.
    const textEl = Array.from(li.children).find(
      c => (c as HTMLElement).classList?.contains('au-sidenav__text'),
    )
    if (textEl) {
      const label = (textEl.textContent || '').replace(/\s+/g, ' ').trim() || '(no label)'
      return {
        id: nextId(),
        href: '',
        defaultLabel: label,
        label,
        included: true,
        children: [],
      }
    }
    return null
  }

  const label = (ownAnchor.textContent || '').replace(/\s+/g, ' ').trim()
  const href = resolveHref(ownAnchor.getAttribute('href') || '', baseHref)

  return {
    id: nextId(),
    href,
    defaultLabel: label || href || '(no label)',
    label: label || href || '(no label)',
    included: true,
    children,
  }
}

function findOwnAnchor(li: Element): HTMLAnchorElement | null {
  // Scan direct children only, in document order. Stop at the first nested <ul>
  // — anything past that belongs to children, not to this row.
  for (const child of Array.from(li.children)) {
    const tag = child.tagName.toLowerCase()
    if (tag === 'ul') return null
    if (tag === 'a' && child.hasAttribute('href')) return child as HTMLAnchorElement
    // The anchor is often wrapped in a <span>, <strong>, etc. Search inside,
    // but skip anything containing a nested <ul> (that descendant anchor would
    // belong to a child row).
    if ((child as HTMLElement).querySelector?.(':scope ul')) continue
    const nested = (child as HTMLElement).querySelector?.('a[href]')
    if (nested) return nested as HTMLAnchorElement
  }
  return null
}

function firstTextLabel(li: Element): string {
  for (const node of Array.from(li.childNodes)) {
    if (node.nodeType === 3) {
      const t = (node.textContent || '').trim()
      if (t) return t
    }
    if (node.nodeType === 1) {
      const el = node as Element
      if (el.tagName.toLowerCase() === 'ul') break
      const t = (el.textContent || '').trim()
      if (t) return t
    }
  }
  return ''
}

function buildLeaf(a: HTMLAnchorElement, baseHref: string | undefined): SitemapNode | null {
  const label = (a.textContent || '').replace(/\s+/g, ' ').trim()
  const href = resolveHref(a.getAttribute('href') || '', baseHref)
  if (!href && !label) return null
  return {
    id: nextId(),
    href,
    defaultLabel: label || href,
    label: label || href,
    included: true,
    children: [],
  }
}

// Reject schemes that can execute code or read local files when navigated to.
// data: is included because data:text/html can carry inline scripts; even though
// modern browsers block top-level navigation to data:text/html from regular
// links, the helper renders the preview inline and we don't want such hrefs in
// the copied output either.
const REJECTED_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:']

function resolveHref(raw: string, baseHref: string | undefined): string {
  if (!raw) return ''
  const lower = raw.trim().toLowerCase()
  if (lower.startsWith('#')) return ''
  if (REJECTED_SCHEMES.some(s => lower.startsWith(s))) return ''
  try {
    const resolved = baseHref ? new URL(raw, baseHref) : new URL(raw)
    // Re-check after resolution in case the base introduced a rejected scheme.
    if (REJECTED_SCHEMES.some(s => resolved.protocol === s)) return ''
    return resolved.href
  } catch {
    return raw.trim()
  }
}

function summarize(forest: SitemapNode[], detectedHeaderText = '', isAuSidenavOutput = false): ParseResult {
  let pageCount = 0
  let maxDepth = 0
  function walk(nodes: SitemapNode[], depth: number): void {
    if (nodes.length > 0 && depth > maxDepth) maxDepth = depth
    for (const n of nodes) {
      pageCount += 1
      walk(n.children, depth + 1)
    }
  }
  walk(forest, 1)
  return { forest, pageCount, maxDepth, detectedHeaderText, isAuSidenavOutput }
}

// ── Tree mutations (immutable) ──────────────────────────────────────────────

export function findNode(roots: SitemapNode[], id: string): SitemapNode | null {
  for (const n of roots) {
    if (n.id === id) return n
    const child = findNode(n.children, id)
    if (child) return child
  }
  return null
}

export function findParent(roots: SitemapNode[], id: string): SitemapNode | null {
  for (const n of roots) {
    if (n.children.some(c => c.id === id)) return n
    const deeper = findParent(n.children, id)
    if (deeper) return deeper
  }
  return null
}

function mapTree(roots: SitemapNode[], fn: (n: SitemapNode) => SitemapNode): SitemapNode[] {
  return roots.map(n => {
    const next = fn(n)
    return { ...next, children: mapTree(next.children, fn) }
  })
}

export function renameNode(roots: SitemapNode[], id: string, label: string): SitemapNode[] {
  return mapTree(roots, n => n.id === id ? { ...n, label } : n)
}

export function setIncluded(roots: SitemapNode[], id: string, included: boolean): SitemapNode[] {
  // Toggling a node also cascades to descendants — excluding a parent
  // shouldn't leave orphaned children "included" in the output, and re-
  // including a parent restores its subtree.
  return mapTree(roots, n => {
    if (n.id === id) return cascadeIncluded(n, included)
    return n
  })
}

function cascadeIncluded(node: SitemapNode, included: boolean): SitemapNode {
  return {
    ...node,
    included,
    children: node.children.map(c => cascadeIncluded(c, included)),
  }
}

// Reorder siblings under `parentId`. Pass `null` to reorder the top-level forest.
export function reorderSiblings(
  roots: SitemapNode[],
  parentId: string | null,
  fromIndex: number,
  toIndex: number,
): SitemapNode[] {
  if (parentId === null) {
    return reorderArray(roots, fromIndex, toIndex)
  }
  return mapTree(roots, n =>
    n.id === parentId
      ? { ...n, children: reorderArray(n.children, fromIndex, toIndex) }
      : n,
  )
}

function reorderArray<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= arr.length) return arr
  const next = arr.slice()
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
}

// Move `id` out of its current parent and insert immediately after that parent
// at the grandparent's level. If the node's parent is at the top of the forest,
// the node is inserted into the forest right after its parent. No-op when the
// node is already a top-level forest entry (nothing to promote into).
export function promoteNode(roots: SitemapNode[], id: string): SitemapNode[] {
  const parent = findParent(roots, id)
  if (!parent) return roots
  const node = parent.children.find(c => c.id === id)
  if (!node) return roots

  const removeFrom = (siblings: SitemapNode[]) =>
    siblings.filter(c => c.id !== id)

  const grandparent = findParent(roots, parent.id)
  if (!grandparent) {
    const parentIdx = roots.findIndex(n => n.id === parent.id)
    if (parentIdx === -1) return roots
    const nextRoots = roots.map(n =>
      n.id === parent.id ? { ...n, children: removeFrom(n.children) } : n,
    )
    nextRoots.splice(parentIdx + 1, 0, node)
    return nextRoots
  }

  return mapTree(roots, n => {
    if (n.id === parent.id) return { ...n, children: removeFrom(n.children) }
    if (n.id === grandparent.id) {
      const parentIdx = n.children.findIndex(c => c.id === parent.id)
      if (parentIdx === -1) return n
      const children = n.children.slice()
      children.splice(parentIdx + 1, 0, node)
      return { ...n, children }
    }
    return n
  })
}

// Move `id` into the previous sibling's children (appended at the end). No-op
// when the node is already the first child of its parent (or first in the forest).
export function demoteNode(roots: SitemapNode[], id: string): SitemapNode[] {
  const parent = findParent(roots, id)
  const siblings = parent ? parent.children : roots
  const idx = siblings.findIndex(n => n.id === id)
  if (idx <= 0) return roots
  const node = siblings[idx]
  const newParent = siblings[idx - 1]

  const transform = (arr: SitemapNode[]): SitemapNode[] => {
    const next = arr.slice()
    next.splice(idx, 1)
    return next.map(n =>
      n.id === newParent.id ? { ...n, children: [...n.children, node] } : n,
    )
  }

  if (!parent) return transform(roots)
  return mapTree(roots, n =>
    n.id === parent.id ? { ...n, children: transform(n.children) } : n,
  )
}

// Returns the subtree rooted at `id` as a one-element forest (so the caller
// can treat the result as the "active forest" the same way as the full one).
// If `id` doesn't match anything, returns the original forest unchanged.
export function selectSubtree(roots: SitemapNode[], id: string): SitemapNode[] {
  const node = findNode(roots, id)
  return node ? [node] : roots
}

// Construct a fresh node with a generated id. Exported so the App can grab
// the new id (e.g. to mark it as user-added) before handing the forest back
// to setState.
export function makeNode(label = 'New page', href = ''): SitemapNode {
  return { id: nextId(), href, defaultLabel: label, label, included: true, children: [] }
}

// Advance the internal id counter past the largest numeric id in the given
// forests. Needed when a second parse happens (e.g. the Compare-with-Site-Index
// flow parses a fresh site index after the menu was already parsed) — without
// this, the counter resets to 0 and subsequent makeNode() calls would generate
// ids that collide with existing menu nodes.
export function ensureIdsPast(...forests: SitemapNode[][]): void {
  let max = __idCounter
  function walk(nodes: SitemapNode[]): void {
    for (const n of nodes) {
      const m = /^n(\d+)$/.exec(n.id)
      if (m) {
        const v = parseInt(m[1], 10)
        if (v > max) max = v
      }
      walk(n.children)
    }
  }
  for (const f of forests) walk(f)
  __idCounter = max
}

// Append `node` as the last child of `parentId`. Pass `parentId === null` to
// append at the top level of the forest.
export function addChild(roots: SitemapNode[], parentId: string | null, node: SitemapNode): SitemapNode[] {
  if (parentId === null) return [...roots, node]
  return mapTree(roots, n => n.id === parentId ? { ...n, children: [...n.children, node] } : n)
}

// Insert `node` as the first child of `parentId` so it renders directly below
// the parent label rather than at the bottom of an existing children list.
export function addFirstChild(roots: SitemapNode[], parentId: string, node: SitemapNode): SitemapNode[] {
  return mapTree(roots, n => n.id === parentId ? { ...n, children: [node, ...n.children] } : n)
}

// Insert `node` immediately after the sibling identified by `siblingId`,
// regardless of where in the tree that sibling lives.
export function addSiblingAfter(roots: SitemapNode[], siblingId: string, node: SitemapNode): SitemapNode[] {
  const topIdx = roots.findIndex(n => n.id === siblingId)
  if (topIdx !== -1) {
    const next = roots.slice()
    next.splice(topIdx + 1, 0, node)
    return next.map(n => ({ ...n, children: n.children.slice() }))
  }
  return mapTree(roots, n => {
    const idx = n.children.findIndex(c => c.id === siblingId)
    if (idx === -1) return n
    const children = n.children.slice()
    children.splice(idx + 1, 0, node)
    return { ...n, children }
  })
}

// Insert `node` immediately before the sibling identified by `siblingId`,
// regardless of where in the tree that sibling lives. Mirror of
// addSiblingAfter; used by the compare flow's forward-search placement.
export function addSiblingBefore(roots: SitemapNode[], siblingId: string, node: SitemapNode): SitemapNode[] {
  const topIdx = roots.findIndex(n => n.id === siblingId)
  if (topIdx !== -1) {
    const next = roots.slice()
    next.splice(topIdx, 0, node)
    return next.map(n => ({ ...n, children: n.children.slice() }))
  }
  return mapTree(roots, n => {
    const idx = n.children.findIndex(c => c.id === siblingId)
    if (idx === -1) return n
    const children = n.children.slice()
    children.splice(idx, 0, node)
    return { ...n, children }
  })
}

// Remove a node (and its subtree) by id. The App restricts this to user-added
// rows so a misclick can't lose pasted structure.
export function removeNode(roots: SitemapNode[], id: string): SitemapNode[] {
  const filtered = roots.filter(n => n.id !== id)
  return filtered.map(n => ({ ...n, children: removeNode(n.children, id) }))
}

// Update the href of a single node. The render path (safeHref + escapeAttr)
// neutralizes dangerous values, so we don't filter while the user is typing.
export function setHref(roots: SitemapNode[], id: string, href: string): SitemapNode[] {
  return mapTree(roots, n => n.id === id ? { ...n, href } : n)
}

// Mark a node's href as external — its host will not be stripped even when
// the global hrefMode is 'site-root-relative'.
export function setExternal(roots: SitemapNode[], id: string, external: boolean): SitemapNode[] {
  return mapTree(roots, n => n.id === id ? { ...n, external } : n)
}

// Find every distinct site URL in the forest, ranked by frequency descending.
// Absolute hrefs contribute their `origin + '/'` (e.g. 'https://www.army.edu/').
// Root-relative / relative hrefs ('/about/', 'about/') contribute '/', the
// root-relative site URL — they live on whatever host serves the page, so a
// menu built entirely from relative links detects '/' as its dominant site URL
// instead of latching onto a stray absolute off-site link (the bug where every
// row then gets marked external). Ties broken by first-encountered tree order.
// Returns [] if the forest has no usable hrefs.
export function detectSiteUrls(roots: SitemapNode[]): string[] {
  const counts = new Map<string, number>()
  const order: string[] = []
  function bump(key: string): void {
    if (!counts.has(key)) order.push(key)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  function walk(nodes: SitemapNode[]): void {
    for (const n of nodes) {
      if (n.href) {
        try {
          bump(new URL(n.href).origin + '/')
        } catch {
          // Not an absolute URL — a site-relative path. Bucket under '/'.
          bump('/')
        }
      }
      walk(n.children)
    }
  }
  walk(roots)
  // Stable sort: order[] preserves first-encountered, sort by count desc keeps
  // ties in original order.
  return order
    .slice()
    .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
}

// Convenience wrapper: the single most common origin (with trailing /) or ''.
export function detectSiteUrl(roots: SitemapNode[]): string {
  return detectSiteUrls(roots)[0] ?? ''
}

// A Site URL is required and must parse via new URL() AND end with '/'.
// Blank is invalid because without a site URL, applySiteUrl marks every link
// as internal, and `Internal link format` would then strip the host off
// cross-origin hrefs and break them. The trailing slash prevents the
// partial-host bug: 'https://www.army' is a prefix of both
// 'https://www.army.edu/' and 'https://www.armywarcollege.edu/'; requiring a
// trailing slash means a typo matches nothing instead of silently mis-classifying.
//
// '/' is also valid: it's the root-relative site URL for a menu whose links are
// all site-relative paths ('/about/'). applySiteUrl then treats every href
// starting with '/' as internal and only absolute (cross-host) links as external.
export function isValidSiteUrl(value: string): boolean {
  if (value === '') return false
  if (!value.endsWith('/')) return false
  if (value === '/') return true
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

// Set `external` on every node with a non-empty href based on whether the href
// starts with `siteUrl`. Nodes with empty hrefs (plain-text rows) are left
// alone — they don't render as anchors, so the flag has no meaning for them.
export function applySiteUrl(roots: SitemapNode[], siteUrl: string): SitemapNode[] {
  return mapTree(roots, n => {
    if (n.href.trim() === '') return n
    return { ...n, external: !n.href.startsWith(siteUrl) }
  })
}

// ── Output ──────────────────────────────────────────────────────────────────

export type RootMode = 'parent' | 'parent-expanded' | 'hide' | 'sibling'
export type HrefMode = 'absolute' | 'site-root-relative'

export interface GenerateOptions {
  headerText?: string
  // How to render the picked root (only applies when `roots.length === 1`):
  //   'parent'          — root is a top-level <li> with its children as a sublist (legacy default)
  //   'parent-expanded' — same as 'parent', but tagged with data-au-default-expanded
  //                       so sidenav.js starts the root expanded instead of collapsed
  //   'hide'            — root is omitted; its children become the top-level items
  //   'sibling'         — root is a leaf <li> first, followed by its children as siblings
  rootMode?: RootMode
  // 'absolute' keeps hrefs verbatim. 'site-root-relative' strips protocol+host
  // (e.g. https://example.com/a/b → /a/b), keeping path+query+hash.
  hrefMode?: HrefMode
  // Optional override for the root's label when rootMode === 'sibling'.
  rootSiblingLabel?: string
}

// Emit a <nav class="au-sidenav"> block matching the markup format authored
// in the au-sidenav component (vendored under src/vendor/au-sidenav/).
//
// Rules:
//   - Skip nodes (and descendants) whose `included === false`.
//   - A parent (with at least one included child) gets the chevron <button>
//     and a <ul class="au-sidenav__sublist">.
//   - A leaf is just <li class="au-sidenav__item"><a href="...">Label</a></li>.
//   - Indentation matches the example file (2 spaces per level).
export function generateSidenavHtml(
  roots: SitemapNode[],
  options: GenerateOptions = {},
): string {
  const headerText = options.headerText?.trim() || 'In this section'
  const header = escapeHtml(headerText)
  const hrefMode: HrefMode = options.hrefMode ?? 'site-root-relative'
  const rootMode: RootMode = options.rootMode ?? 'parent'

  const topLevel = applyRootMode(roots, rootMode, options.rootSiblingLabel)
  // 'parent-expanded' adds data-au-default-expanded to the root <li> only.
  // Only meaningful when a single root is rendered as a parent.
  const expandRoot = rootMode === 'parent-expanded' && roots.length === 1

  const itemsHtml = topLevel
    .filter(n => n.included)
    .map((n, i) => renderItem(n, 2, hrefMode, expandRoot && i === 0))
    .join('\n\n')

  const inner = itemsHtml ? '\n\n' + itemsHtml + '\n\n  ' : '\n  '

  return `<nav class="au-sidenav" aria-label="${header}">
  <h3 class="au-sidenav__header">${header}</h3>
  <ul class="au-sidenav__list">${inner}</ul>
</nav>`
}

// Reshape the top-level forest based on rootMode. Only takes effect when a
// single root has been picked (roots.length === 1) — whole-sitemap mode is
// always rendered as-is.
function applyRootMode(
  roots: SitemapNode[],
  mode: RootMode,
  siblingLabel: string | undefined,
): SitemapNode[] {
  if (roots.length !== 1) return roots
  const root = roots[0]
  if (mode === 'hide') return root.children
  if (mode === 'sibling') {
    const label = siblingLabel?.trim() || root.label
    const rootAsLeaf: SitemapNode = { ...root, label, children: [] }
    return [rootAsLeaf, ...root.children]
  }
  return roots
}

function renderItem(
  node: SitemapNode,
  indent: number,
  hrefMode: HrefMode,
  defaultExpanded = false,
): string {
  const pad = ' '.repeat(indent)
  const label = escapeHtml(node.label || node.defaultLabel || '')
  // External links keep their host even when the global mode would strip it.
  const effectiveMode: HrefMode = node.external ? 'absolute' : hrefMode
  const href = escapeAttr(safeHref(transformHref(node.href, effectiveMode)))

  // A node whose href is blank renders as plain text instead of an anchor,
  // so users can build visual groupings without a real underlying page.
  // safeHref returns '#' for unsafe schemes too — we still emit those as <a>
  // (going to '#') so the user can see the row exists and is broken.
  const isPlainText = node.href.trim() === ''
  // External links open in a new tab. rel="noopener noreferrer" prevents the
  // opened page from accessing window.opener or leaking the referrer. The
  // "external" class lets the menu style them distinctly (e.g. an outbound icon).
  const anchorAttrs = node.external
    ? ` class="external" target="_blank" rel="noopener noreferrer"`
    : ''
  const linkHtml = isPlainText
    ? `<span class="au-sidenav__text">${label}</span>`
    : `<a href="${href}"${anchorAttrs}>${label}</a>`

  const includedChildren = node.children.filter(c => c.included)

  if (includedChildren.length === 0) {
    // defaultExpanded only meaningful for parents — leaves ignore it.
    return `${pad}<li class="au-sidenav__item">\n${pad}  ${linkHtml}\n${pad}</li>`
  }

  const childrenHtml = includedChildren
    .map(c => renderItem(c, indent + 4, hrefMode))
    .join('\n')

  // Marker honored by sidenav.js to start this <li> expanded instead of the
  // default collapsed state. Kept as a data attribute (not a class) so we
  // don't violate the "don't pre-set --collapsed/--expanded" rule.
  const liAttrs = defaultExpanded
    ? 'class="au-sidenav__item" data-au-default-expanded="true"'
    : 'class="au-sidenav__item"'

  return [
    `${pad}<li ${liAttrs}>`,
    `${pad}  ${linkHtml}`,
    `${pad}  <button type="button" class="au-sidenav__toggle" aria-label="Toggle submenu"></button>`,
    `${pad}  <ul class="au-sidenav__sublist">`,
    childrenHtml,
    `${pad}  </ul>`,
    `${pad}</li>`,
  ].join('\n')
}

// Strip protocol+host when in site-root-relative mode. Anything that doesn't
// parse as an absolute URL (e.g. already-relative hrefs, empty strings) is
// returned untouched — safeHref/REJECTED_SCHEMES still gate the result.
function transformHref(href: string, mode: HrefMode): string {
  if (mode === 'absolute' || !href) return href
  try {
    const u = new URL(href)
    return (u.pathname || '/') + u.search + u.hash
  } catch {
    return href
  }
}

// Defense-in-depth: even though resolveHref strips dangerous schemes during
// parsing, callers can construct SitemapNodes directly (e.g. in tests or
// future codepaths). Re-check at render time so dangerouslySetInnerHTML
// never receives a navigatable javascript:/data:/vbscript:/file: href.
function safeHref(href: string): string {
  if (!href) return '#'
  const lower = href.trim().toLowerCase()
  if (REJECTED_SCHEMES.some(s => lower.startsWith(s))) return '#'
  return href
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}
