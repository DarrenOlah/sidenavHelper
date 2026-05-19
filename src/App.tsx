import { useState, useMemo, useRef, useEffect, type ChangeEvent, type ClipboardEvent as RClipboardEvent } from 'react'

import { HELPER_URL, REPO_URL, HERO_IMAGE_URL, HERO_VIDEO_URL } from './lib/config'

type NavItem =
  | { kind: 'current'; id: string; label: string }
  | { kind: 'external'; id: string; label: string; href: string }

const NAV_ITEMS: NavItem[] = [
  { kind: 'external', id: 'image', label: 'Hero Image', href: HERO_IMAGE_URL },
  { kind: 'external', id: 'video', label: 'Hero Video', href: HERO_VIDEO_URL },
  { kind: 'current', id: 'sidenav', label: 'SideNav' },
]

import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// Vendored copies of the au-sidenav component. To refresh after the upstream
// component changes, copy sidenav.css/sidenav.js from au-components/sidenav/
// over the files in src/vendor/au-sidenav/.
import sidenavCss from './vendor/au-sidenav/sidenav.css?raw'
// Side-effect import: the sidenav IIFE registers window.AuSidenav for the
// in-helper preview. The same source is also imported as a raw string so we
// can optionally embed it in the copied output as a <script> block.
import './vendor/au-sidenav/sidenav.js'
import sidenavJs from './vendor/au-sidenav/sidenav.js?raw'

declare global {
  interface Window {
    AuSidenav?: {
      init: () => void
      initNav: (nav: Element) => void
    }
  }
}

import {
  parseSitemapHtml,
  generateSidenavHtml,
  renameNode,
  setIncluded,
  reorderSiblings,
  promoteNode,
  demoteNode,
  selectSubtree,
  findNode,
  makeNode,
  addChild,
  removeNode,
  setHref,
  setExternal,
  type SitemapNode,
  type RootMode,
  type HrefMode,
} from './lib/sitemap'
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  applyAccentColor,
  normalizeHex,
} from './lib/accent'

// ── State ────────────────────────────────────────────────────────────────────

interface State {
  forest: SitemapNode[]
  rootId: string | null
  headerText: string
  rootMode: RootMode
  hrefMode: HrefMode
  includeCss: boolean
  includeJs: boolean
  accentColor: string
  pageCount: number
  maxDepth: number
  parseError: string
  // Href of the link the user clicked in the preview to simulate "you are
  // currently on this page". Fed through data-au-current-path to the vendored
  // sidenav.js so the preview shows the gold accent bar + current-link styling.
  previewCurrentPath: string | null
  // Ids of nodes the user added (vs. parsed from the pasted sitemap). Drives
  // delete-button visibility and auto-opens the URL editor on those rows.
  addedIds: Set<string>
}

const INITIAL_STATE: State = {
  forest: [],
  rootId: null,
  headerText: 'In this section',
  rootMode: 'sibling',
  hrefMode: 'site-root-relative',
  includeCss: true,
  includeJs: true,
  accentColor: DEFAULT_ACCENT,
  pageCount: 0,
  maxDepth: 0,
  parseError: '',
  previewCurrentPath: null,
  addedIds: new Set(),
}

// ── Asset download (panel 4) ─────────────────────────────────────────────────

// Trigger a browser download of `content` as `filename`. Stamps a header
// comment with the helper version + URL so a recipient can trace where the
// file came from. The /* … */ form is valid in both CSS and JS.
function downloadAsset(filename: string, content: string, mimeType: string) {
  const stamped =
    `/* ${filename} — bundled with sidenavHelper v${__APP_VERSION__}\n` +
    `   ${HELPER_URL}\n` +
    `   This is a vendored copy of the au-sidenav asset. */\n\n` +
    content
  const blob = new Blob([stamped], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// ── Section label (mirrors heroHelper) ───────────────────────────────────────

interface SectionLabelProps {
  number: number
  title: string
  done: boolean
}

function SectionLabel({ number, title, done }: SectionLabelProps) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0
        ${done ? 'bg-green-500 text-white' : 'bg-blue-600 text-white'}`}>
        {done ? '✓' : number}
      </div>
      <h2 className="text-base font-semibold text-gray-800">{title}</h2>
    </div>
  )
}

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [state, setState] = useState<State>(INITIAL_STATE)
  const [copied, setCopied] = useState(false)
  const pasteRef = useRef<HTMLDivElement | null>(null)

  const { forest, rootId, headerText, rootMode, hrefMode, includeCss, includeJs, accentColor, pageCount, maxDepth, parseError, previewCurrentPath, addedIds } = state

  const hasForest = forest.length > 0
  const hasPickedRoot = rootId !== null && findNode(forest, rootId) !== null
  const activeForest = useMemo(() => rootId ? selectSubtree(forest, rootId) : forest, [forest, rootId])

  // The editable tree mirrors what the generated HTML will contain. When a
  // root is picked, reshape based on rootMode so what the user edits matches
  // what they'll get. Top-level reorders in 'sibling' mode are translated
  // to operate on the underlying root.children (see handleReorder).
  const displayedForest = useMemo(() => {
    if (!hasPickedRoot || activeForest.length !== 1) return activeForest
    const root = activeForest[0]
    if (rootMode === 'hide') return root.children
    if (rootMode === 'sibling') return [{ ...root, children: [] }, ...root.children]
    return activeForest
  }, [activeForest, hasPickedRoot, rootMode])

  const generatedHtml = useMemo(
    () => hasForest
      ? generateSidenavHtml(activeForest, {
          headerText,
          rootMode: hasPickedRoot ? rootMode : 'parent',
          hrefMode,
        })
      : '',
    [hasForest, activeForest, headerText, rootMode, hrefMode, hasPickedRoot],
  )

  // The bare <nav> is what the live preview consumes — its CSS and JS are
  // already attached to the helper's document. The output panel optionally
  // wraps that nav with <style>/<script> blocks for users whose deployment
  // can't reference the assets externally. The provenance comment is always
  // first so it's the first thing a future reader sees regardless of which
  // embed toggles are on.
  const outputHtml = useMemo(() => {
    if (!generatedHtml) return ''
    const provenance = `<!-- Generated by sidenavHelper v${__APP_VERSION__} — ${HELPER_URL} -->\n`
    const css = includeCss ? `<style>\n${applyAccentColor(sidenavCss, accentColor)}\n</style>\n` : ''
    const js = includeJs ? `\n<script>\n${sidenavJs}\n</script>` : ''
    return provenance + css + generatedHtml + js
  }, [generatedHtml, includeCss, includeJs, accentColor])


  // ── Handlers ───────────────────────────────────────────────────────────────

  const ingestHtml = (html: string) => {
    const result = parseSitemapHtml(html)
    if (result.forest.length === 0) {
      setState(s => ({
        ...s,
        forest: [],
        rootId: null,
        pageCount: 0,
        maxDepth: 0,
        parseError: 'No links or list items found. Try copying the rendered site index page (not the source HTML).',
      }))
      return
    }
    setState(s => ({
      ...s,
      forest: result.forest,
      rootId: null,
      pageCount: result.pageCount,
      maxDepth: result.maxDepth,
      parseError: '',
    }))
  }

  const handlePaste = (e: RClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const html = e.clipboardData.getData('text/html')
    if (html) {
      ingestHtml(html)
      return
    }
    // Fallback: plain text might still be a hand-typed list of URLs.
    const text = e.clipboardData.getData('text/plain')
    if (text) ingestHtml(text)
  }

  const handlePasteAreaTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    ingestHtml(e.target.value)
  }

  // Strip the auto-added " Home" suffix from a root, but only when we know we
  // added it ourselves (label is exactly `${defaultLabel} Home`). If the user
  // edited the label further, or "Home" was part of the original label, this
  // is a no-op.
  const stripAutoHomeSuffix = (forest: SitemapNode[], id: string | null): SitemapNode[] => {
    if (!id) return forest
    const node = findNode(forest, id)
    if (!node || node.label !== `${node.defaultLabel} Home`) return forest
    return renameNode(forest, id, node.defaultLabel)
  }

  // Auto-suggest "${defaultLabel} Home" as the root's label, but only if the
  // user hasn't customized it. Reused by handleSetRoot and handleRootMode.
  const applyAutoHomeSuffix = (forest: SitemapNode[], id: string): SitemapNode[] => {
    const node = findNode(forest, id)
    if (!node || node.label !== node.defaultLabel) return forest
    return renameNode(forest, id, `${node.defaultLabel} Home`)
  }

  // When picking a root in 'sibling' mode, suggest "{name} Home" as the
  // root's label. When switching away from a previously-picked root, undo
  // any auto-added " Home" suffix on the old root so it doesn't linger.
  const handleSetRoot = (id: string | null) =>
    setState(s => {
      const oldRootId = s.rootId
      let forest = oldRootId !== id ? stripAutoHomeSuffix(s.forest, oldRootId) : s.forest
      if (id !== null && s.rootMode === 'sibling') {
        forest = applyAutoHomeSuffix(forest, id)
      }
      return { ...s, rootId: id, forest }
    })

  const handleRename = (id: string, label: string) =>
    setState(s => ({ ...s, forest: renameNode(s.forest, id, label) }))

  const handleToggleInclude = (id: string, included: boolean) =>
    setState(s => ({ ...s, forest: setIncluded(s.forest, id, included) }))

  // In 'sibling' mode, the displayed top-level mixes the pinned root row
  // (index 0) with the root's actual children (indices 1+). Translate any
  // top-level drag into a reorder of root.children with both indices shifted
  // by -1. Drags that involve the pinned root row never reach this handler
  // because the root's drag handle is disabled.
  const handleReorder = (parentId: string | null, fromIndex: number, toIndex: number) =>
    setState(s => {
      if (parentId === null && s.rootMode === 'sibling' && s.rootId) {
        return {
          ...s,
          forest: reorderSiblings(s.forest, s.rootId, fromIndex - 1, toIndex - 1),
        }
      }
      return { ...s, forest: reorderSiblings(s.forest, parentId, fromIndex, toIndex) }
    })

  const handlePromote = (id: string) =>
    setState(s => ({ ...s, forest: promoteNode(s.forest, id) }))

  const handleDemote = (id: string) =>
    setState(s => ({ ...s, forest: demoteNode(s.forest, id) }))

  // Adds a child under the named parent. The new id is recorded in addedIds
  // so the row gets a delete button and an auto-opened URL editor.
  const handleAddChild = (parentId: string) =>
    setState(s => {
      const node = makeNode()
      const nextAdded = new Set(s.addedIds)
      nextAdded.add(node.id)
      return { ...s, forest: addChild(s.forest, parentId, node), addedIds: nextAdded }
    })

  // Adds a sibling at the level identified by parentId. The 'sibling' rootMode
  // shows the picked root pinned at index 0 of the displayed top level, with
  // the root's actual children below it — so a top-level "+ Add page" in that
  // mode must append to the underlying root's children, not to the forest.
  const handleAddSibling = (parentId: string | null) =>
    setState(s => {
      const node = makeNode()
      const nextAdded = new Set(s.addedIds)
      nextAdded.add(node.id)
      if (parentId === null && s.rootMode === 'sibling' && s.rootId) {
        return { ...s, forest: addChild(s.forest, s.rootId, node), addedIds: nextAdded }
      }
      return { ...s, forest: addChild(s.forest, parentId, node), addedIds: nextAdded }
    })

  const handleDelete = (id: string) =>
    setState(s => {
      const nextAdded = new Set(s.addedIds)
      nextAdded.delete(id)
      return { ...s, forest: removeNode(s.forest, id), addedIds: nextAdded }
    })

  const handleSetHref = (id: string, href: string) =>
    setState(s => ({ ...s, forest: setHref(s.forest, id, href) }))

  const handleSetExternal = (id: string, external: boolean) =>
    setState(s => ({ ...s, forest: setExternal(s.forest, id, external) }))

  const handleHeaderText = (val: string) =>
    setState(s => ({ ...s, headerText: val }))

  const handleRootMode = (mode: RootMode) =>
    setState(s => {
      if (mode === s.rootMode || !s.rootId) return { ...s, rootMode: mode }
      // Apply the suffix when entering sibling mode; remove it when leaving.
      const forest = mode === 'sibling'
        ? applyAutoHomeSuffix(s.forest, s.rootId)
        : stripAutoHomeSuffix(s.forest, s.rootId)
      return { ...s, rootMode: mode, forest }
    })

  const handleHrefMode = (mode: HrefMode) =>
    setState(s => ({ ...s, hrefMode: mode }))

  const handleIncludeCss = (val: boolean) =>
    setState(s => ({ ...s, includeCss: val }))

  const handleIncludeJs = (val: boolean) =>
    setState(s => ({ ...s, includeJs: val }))

  const handleAccentColor = (color: string) =>
    setState(s => ({ ...s, accentColor: color }))

  const handleSelectPreviewPath = (href: string) =>
    setState(s => ({ ...s, previewCurrentPath: href }))

  const handleCopy = () => {
    if (!outputHtml) return
    navigator.clipboard.writeText(outputHtml).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleReset = () => {
    setState(INITIAL_STATE)
    setCopied(false)
    if (pasteRef.current) pasteRef.current.innerHTML = ''
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex flex-col">
      <div className="flex-1 w-full py-2 px-4">

        {/* Nav: SideNav | Hero */}
        <nav className="mb-4 text-sm" aria-label="Tool selector">
          {NAV_ITEMS.map((item, i) => (
            <span key={item.id}>
              {i > 0 && <span className="mx-2 text-gray-300">|</span>}
              {item.kind === 'external' ? (
                <a href={item.href} className="text-gray-500 hover:text-blue-600 hover:underline">{item.label}</a>
              ) : (
                <span className="font-semibold text-blue-600" aria-current="page">{item.label}</span>
              )}
            </span>
          ))}
        </nav>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Sidenav Helper</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Paste a styled site-index page, pick a root, edit pages, copy a paste-ready sidenav.
          </p>
        </div>

        <div className="flex flex-col lg:flex-row gap-4 items-start">

          {/* ── COL 1: Paste + Choose root ── */}
          <div className="w-full lg:flex-1 lg:min-w-0 space-y-4">

            {/* Section 1: Paste */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
              <SectionLabel number={1} title="Paste your site index" done={hasForest} />
              <p className="text-xs text-gray-500 mb-2">
                Open a styled site-index page in your browser, select the visible list, copy, then paste here. Works best with a hierarchical sitemap based on <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700 font-mono text-[11px]">&lt;ul&gt;</code>, <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700 font-mono text-[11px]">&lt;li&gt;</code>, and <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700 font-mono text-[11px]">&lt;a&gt;</code> tags.
              </p>
              <div
                ref={pasteRef}
                contentEditable
                suppressContentEditableWarning
                onPaste={handlePaste}
                className="min-h-[80px] w-full px-3 py-2 border-2 border-dashed border-blue-300 rounded-lg text-xs text-gray-600 bg-blue-50/40 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-text"
                aria-label="Paste site index here"
              />
              {hasForest && (
                <p className="mt-2 text-xs text-green-700 font-medium">
                  ✓ Captured {pageCount} page{pageCount === 1 ? '' : 's'} across {maxDepth} level{maxDepth === 1 ? '' : 's'}.
                </p>
              )}
              {parseError && (
                <p className="mt-2 text-xs text-red-600">{parseError}</p>
              )}
              <details className="mt-2">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">Or paste raw HTML</summary>
                <textarea
                  className="mt-2 w-full h-24 px-2 py-1 border border-gray-300 rounded text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="<ul><li><a href='...'>...</a></li></ul>"
                  onChange={handlePasteAreaTextChange}
                />
              </details>
            </div>

            {/* Section 2: Choose root */}
            <div className={`bg-white rounded-xl shadow-sm border border-gray-100 p-4 transition-opacity
              ${hasForest ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
              <SectionLabel number={2} title="Choose the root" done={hasPickedRoot} />
              <p className="text-xs text-gray-500 mb-2">
                Select the root—the page which is the parent of the pages that should appear in the menu.
              </p>
              <div className="border border-gray-200 rounded-lg max-h-48 overflow-auto">
                <RootPicker forest={forest} rootId={rootId} onPick={handleSetRoot} />
              </div>

              {hasPickedRoot && (
                <fieldset className="mt-3">
                  <legend className="text-xs font-medium text-gray-700 mb-1">Root display</legend>
                  <div className="space-y-1">
                    {([
                      ['sibling', 'Show root as sibling (default)', 'Root appears as the first item, with its children as siblings, with "Home" appended.'],
                      ['hide', 'Omit root', 'Root is omitted; only its children appear.'],
                      ['parent', 'Show root as parent', 'Root appears as a parent item, with its children collapsed.'],
                      ['parent-expanded', 'Show root as parent (children expanded)', 'Root appears as a parent item, with its children expanded by default.'],
                    ] as const).map(([value, label, hint]) => (
                      <label key={value} className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                        <input
                          type="radio"
                          name="rootMode"
                          value={value}
                          checked={rootMode === value}
                          onChange={() => handleRootMode(value)}
                          className="mt-0.5 shrink-0"
                        />
                        <span>
                          <span className="font-medium">{label}</span>
                          <span className="block text-[11px] text-gray-500">{hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              <fieldset className="mt-3">
                <legend className="text-xs font-medium text-gray-700 mb-1">Link format</legend>
                <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hrefMode === 'absolute'}
                    onChange={e => handleHrefMode(e.target.checked ? 'absolute' : 'site-root-relative')}
                    className="mt-0.5 shrink-0"
                  />
                  <span>
                    <span className="font-medium">Include full URLs (protocol + host)</span>
                    <span className="block text-[11px] text-gray-500">
                      Off (default): generated hrefs are site-root-relative (e.g. <code>/about/team</code>).
                    </span>
                  </span>
                </label>
              </fieldset>

              {hasPickedRoot && (
                <button
                  onClick={() => handleSetRoot(null)}
                  className="mt-3 text-xs text-blue-600 hover:text-blue-800 underline"
                >
                  Use entire sitemap
                </button>
              )}
            </div>

          </div>

          {/* ── COL 2: Edit Menu ── */}
          <div className="w-full lg:flex-1 lg:min-w-0">
            <div className={`bg-white rounded-xl shadow-sm border border-gray-100 p-4 transition-opacity
              ${hasForest ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
              <SectionLabel number={3} title="Edit Menu" done={hasForest} />
              <div className="mb-3">
                <AccentColorPicker value={accentColor} onChange={handleAccentColor} />
              </div>
              <div className="mb-3">
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Header text
                </label>
                <input
                  type="text"
                  value={headerText}
                  onChange={e => handleHeaderText(e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <p className="text-xs text-gray-500 mb-2">
                Drag rows to reorder within a level. Uncheck to exclude. Type to override the page name.
              </p>
              <div className="border border-gray-200 rounded-lg max-h-[640px] overflow-auto p-2">
                <EditableTree
                  nodes={displayedForest}
                  parentId={null}
                  pinnedId={hasPickedRoot && rootMode === 'sibling' ? rootId : null}
                  promoteBoundaryId={hasPickedRoot ? rootId : null}
                  addedIds={addedIds}
                  onRename={handleRename}
                  onToggle={handleToggleInclude}
                  onReorder={handleReorder}
                  onAddChild={handleAddChild}
                  onAddSibling={handleAddSibling}
                  onDelete={handleDelete}
                  onSetHref={handleSetHref}
                  onSetExternal={handleSetExternal}
                  onPromote={handlePromote}
                  onDemote={handleDemote}
                />
              </div>
            </div>
          </div>

          {/* ── COL 3: Live preview ── */}
          <div className="w-full lg:flex-1 lg:min-w-0">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
              <h2 className="text-base font-semibold text-gray-800 mb-2">Live preview</h2>
              {hasForest ? (
                <SidenavPreview
                  html={generatedHtml}
                  accentColor={accentColor}
                  currentPath={previewCurrentPath}
                  onSelectPath={handleSelectPreviewPath}
                />
              ) : (
                <div className="rounded-lg border-2 border-dashed border-gray-200 bg-gray-50 flex items-center justify-center h-32">
                  <p className="text-xs text-gray-400">Preview will appear once you paste a site index.</p>
                </div>
              )}
            </div>
          </div>

          {/* ── COL 4: HTML output ── */}
          <div className="w-full lg:flex-1 lg:min-w-0">
            <div className={`bg-white rounded-xl shadow-sm border p-4 transition-opacity
              ${hasForest ? 'border-gray-100 opacity-100' : 'border-gray-100 opacity-50 pointer-events-none'}`}>
              <SectionLabel number={4} title="Your HTML code" done={false} />
              {hasForest ? (
                <>
                  <p className="text-xs text-gray-500 mb-3">
                    Copy and paste this into your DNN HTML module.
                  </p>
                  <fieldset className="mb-3 space-y-1">
                    <legend className="text-xs font-medium text-gray-700 mb-1">Include assets inline</legend>
                    <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeCss}
                        onChange={e => handleIncludeCss(e.target.checked)}
                        className="mt-0.5 shrink-0"
                      />
                      <span>
                        <span className="font-medium">Embed CSS in a <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700 font-mono text-[11px]">&lt;style&gt;</code> tag</span>
                        <span className="block text-[11px] text-gray-500">
                          Useful when you can't reference <code className="font-mono">sidenav.css</code> from the page skin.
                        </span>
                        {!includeCss && (
                          <button
                            type="button"
                            onClick={e => { e.preventDefault(); downloadAsset('sidenav.css', applyAccentColor(sidenavCss, accentColor), 'text/css') }}
                            className="mt-1 text-[11px] text-blue-600 hover:text-blue-800 underline"
                          >
                            Download sidenav.css
                          </button>
                        )}
                      </span>
                    </label>
                    <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={includeJs}
                        onChange={e => handleIncludeJs(e.target.checked)}
                        className="mt-0.5 shrink-0"
                      />
                      <span>
                        <span className="font-medium">Embed JS in a <code className="px-1 py-0.5 rounded bg-gray-100 text-gray-700 font-mono text-[11px]">&lt;script&gt;</code> tag</span>
                        <span className="block text-[11px] text-gray-500">
                          Useful when you can't reference <code className="font-mono">sidenav.js</code> from the page skin.
                        </span>
                        {!includeJs && (
                          <button
                            type="button"
                            onClick={e => { e.preventDefault(); downloadAsset('sidenav.js', sidenavJs, 'text/javascript') }}
                            className="mt-1 text-[11px] text-blue-600 hover:text-blue-800 underline"
                          >
                            Download sidenav.js
                          </button>
                        )}
                      </span>
                    </label>
                  </fieldset>
                  <div className="bg-gray-900 rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
                      <span className="text-xs text-gray-400 font-medium">HTML</span>
                      <button
                        onClick={handleCopy}
                        className={`text-xs font-medium px-3 py-1 rounded-md transition-colors
                          ${copied ? 'bg-green-500 text-white' : 'bg-gray-700 text-gray-200 hover:bg-gray-600'}`}
                      >
                        {copied ? '✓ Copied!' : 'Copy to clipboard'}
                      </button>
                    </div>
                    <pre className="p-3 text-xs text-green-300 overflow-x-auto overflow-y-auto whitespace-pre font-mono leading-relaxed max-h-[500px]">
                      {outputHtml}
                    </pre>
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      onClick={handleReset}
                      className="px-4 py-1.5 bg-gray-800 text-white rounded-lg font-medium text-xs hover:bg-gray-700 transition-colors"
                    >
                      Start over
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-gray-400">
                  Paste a site index to generate the code.
                </p>
              )}
            </div>
          </div>
        </div>

      </div>
      <footer className="sticky bottom-0 px-2 py-1 bg-white border-t border-gray-200 flex-shrink-0 flex justify-center sm:justify-end">
        <span className="text-[10px] text-gray-400 leading-none">
          Sidenav Helper v{__APP_VERSION__} •{' '}
          <a className="underline hover:text-blue-500" href={REPO_URL} target="_blank" rel="noreferrer">View on GitHub</a>
        </span>
      </footer>
    </div>
  )
}

// ── Accent color picker ─────────────────────────────────────────────────────

// The text input keeps its own draft so users can type freely (e.g. "#FF" on
// the way to "#FF8800") without the parent state flapping back to the last
// valid value on every keystroke. We commit upstream only when normalizeHex
// accepts the input. When the parent value changes (preset click, native
// picker), we sync the draft back so the field stays in step.
interface AccentColorPickerProps {
  value: string
  onChange: (color: string) => void
}

function AccentColorPicker({ value, onChange }: AccentColorPickerProps) {
  const [draft, setDraft] = useState(value)

  useEffect(() => { setDraft(value) }, [value])

  const handleDraft = (raw: string) => {
    setDraft(raw)
    const normalized = normalizeHex(raw)
    if (normalized) onChange(normalized)
  }

  const activePreset = ACCENT_PRESETS.find(p => p.hex.toUpperCase() === value.toUpperCase())
  const isValidDraft = normalizeHex(draft) !== null

  return (
    <fieldset>
      <legend className="text-xs font-medium text-gray-700 mb-1">
        Accent bar color
        {activePreset && <span className="ml-1 text-gray-500 font-normal">— {activePreset.name}</span>}
      </legend>
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {ACCENT_PRESETS.map(preset => {
          const isActive = preset.hex.toUpperCase() === value.toUpperCase()
          return (
            <button
              key={preset.hex}
              type="button"
              onClick={() => onChange(preset.hex)}
              aria-label={preset.name}
              aria-pressed={isActive}
              title={`${preset.name} (${preset.hex})`}
              className={`w-6 h-6 rounded border transition-all ${
                isActive
                  ? 'border-gray-800 ring-2 ring-offset-1 ring-blue-500 scale-110'
                  : 'border-gray-300 hover:border-gray-500'
              }`}
              style={{ backgroundColor: preset.hex }}
            />
          )
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={e => handleDraft(e.target.value)}
          placeholder="#RRGGBB"
          spellCheck={false}
          className={`flex-1 min-w-0 px-2 py-1 border rounded text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isValidDraft ? 'border-gray-300' : 'border-red-400'
          }`}
          aria-label="Custom hex color"
          aria-invalid={!isValidDraft}
        />
        <input
          type="color"
          value={normalizeHex(value) ?? '#FFCC33'}
          onChange={e => onChange(e.target.value.toUpperCase())}
          aria-label="Pick a custom color"
          className="w-8 h-8 rounded border border-gray-300 cursor-pointer"
        />
      </div>
    </fieldset>
  )
}

// ── Root picker (read-only tree, click a row to set it as root) ─────────────

interface RootPickerProps {
  forest: SitemapNode[]
  rootId: string | null
  onPick: (id: string | null) => void
}

function RootPicker({ forest, rootId, onPick }: RootPickerProps) {
  return (
    <ul className="text-xs">
      {forest.map(node => (
        <RootPickerRow key={node.id} node={node} rootId={rootId} onPick={onPick} depth={0} />
      ))}
    </ul>
  )
}

interface RootPickerRowProps {
  node: SitemapNode
  rootId: string | null
  onPick: (id: string | null) => void
  depth: number
}

function RootPickerRow({ node, rootId, onPick, depth }: RootPickerRowProps) {
  const isRoot = rootId === node.id
  return (
    <li>
      <button
        onClick={() => onPick(isRoot ? null : node.id)}
        className={`w-full text-left px-2 py-1 rounded transition-colors
          ${isRoot ? 'bg-blue-100 text-blue-800 font-medium' : 'hover:bg-gray-100 text-gray-700'}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {node.label || '(no label)'}
      </button>
      {node.children.length > 0 && (
        <ul>
          {node.children.map(child => (
            <RootPickerRow key={child.id} node={child} rootId={rootId} onPick={onPick} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

// ── Editable tree (sortable, includes per-node controls) ────────────────────

interface EditableTreeProps {
  nodes: SitemapNode[]
  parentId: string | null
  // When set, the row whose id matches is rendered without a working drag
  // handle and is excluded from reorders. Used by 'sibling' rootMode to pin
  // the synthetic root row at index 0.
  pinnedId?: string | null
  // When set, promote is disabled for any row whose displayed parent matches
  // this id. Used to keep edits inside the picked subtree (the picked root
  // itself is the boundary; promoting one of its children would lift the
  // node out of the visible editor).
  promoteBoundaryId?: string | null
  addedIds: Set<string>
  onRename: (id: string, label: string) => void
  onToggle: (id: string, included: boolean) => void
  onReorder: (parentId: string | null, from: number, to: number) => void
  onAddChild: (parentId: string) => void
  onAddSibling: (parentId: string | null) => void
  onDelete: (id: string) => void
  onSetHref: (id: string, href: string) => void
  onSetExternal: (id: string, external: boolean) => void
  onPromote: (id: string) => void
  onDemote: (id: string) => void
}

function EditableTree({
  nodes,
  parentId,
  pinnedId = null,
  promoteBoundaryId = null,
  addedIds,
  onRename,
  onToggle,
  onReorder,
  onAddChild,
  onAddSibling,
  onDelete,
  onSetHref,
  onSetExternal,
  onPromote,
  onDemote,
}: EditableTreeProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    if (pinnedId && (active.id === pinnedId || over.id === pinnedId)) return
    const from = nodes.findIndex(n => n.id === active.id)
    const to = nodes.findIndex(n => n.id === over.id)
    if (from === -1 || to === -1) return
    onReorder(parentId, from, to)
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={nodes.map(n => n.id)} strategy={verticalListSortingStrategy}>
        <ul className="space-y-1">
          {nodes.map((node, idx) => (
            <SortableEditableRow
              key={node.id}
              node={node}
              pinned={pinnedId === node.id}
              isAdded={addedIds.has(node.id)}
              addedIds={addedIds}
              // Promote crosses out of the current level — disable when there
              // is no level above to land in: at the top of the forest, or at
              // the picked-root boundary in a rooted view.
              canPromote={parentId !== null && parentId !== promoteBoundaryId}
              // Demote moves into the previous sibling — needs one to exist,
              // and never operates on the pinned (root) row in sibling mode.
              canDemote={idx > (pinnedId ? 1 : 0) && pinnedId !== node.id}
              promoteBoundaryId={promoteBoundaryId}
              onRename={onRename}
              onToggle={onToggle}
              onReorder={onReorder}
              onAddChild={onAddChild}
              onAddSibling={onAddSibling}
              onDelete={onDelete}
              onSetHref={onSetHref}
              onSetExternal={onSetExternal}
              onPromote={onPromote}
              onDemote={onDemote}
            />
          ))}
          <li>
            <button
              type="button"
              onClick={() => onAddSibling(parentId)}
              className="w-full text-left px-2 py-1 rounded border border-dashed border-gray-300 text-[11px] text-gray-500 hover:text-blue-700 hover:border-blue-400 hover:bg-blue-50/40 transition-colors"
            >
              + Add sibling page
            </button>
          </li>
        </ul>
      </SortableContext>
    </DndContext>
  )
}

interface SortableEditableRowProps {
  node: SitemapNode
  pinned?: boolean
  isAdded: boolean
  addedIds: Set<string>
  canPromote: boolean
  canDemote: boolean
  promoteBoundaryId?: string | null
  onRename: (id: string, label: string) => void
  onToggle: (id: string, included: boolean) => void
  onReorder: (parentId: string | null, from: number, to: number) => void
  onAddChild: (parentId: string) => void
  onAddSibling: (parentId: string | null) => void
  onDelete: (id: string) => void
  onSetHref: (id: string, href: string) => void
  onSetExternal: (id: string, external: boolean) => void
  onPromote: (id: string) => void
  onDemote: (id: string) => void
}

function SortableEditableRow({
  node,
  pinned = false,
  isAdded,
  addedIds,
  canPromote,
  canDemote,
  promoteBoundaryId = null,
  onRename,
  onToggle,
  onReorder,
  onAddChild,
  onAddSibling,
  onDelete,
  onSetHref,
  onSetExternal,
  onPromote,
  onDemote,
}: SortableEditableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.id, disabled: pinned })

  // Newly-added rows always need a URL — open the editor by default for those.
  // Existing rows keep it collapsed; the user clicks "URL" to reveal it.
  const [urlOpen, setUrlOpen] = useState(isAdded)

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }

  return (
    <li ref={setNodeRef} style={style}>
      <div className={`flex items-center gap-2 px-2 py-1 rounded border ${node.included ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50 opacity-60'}`}>
        <button
          {...(pinned ? {} : attributes)}
          {...(pinned ? {} : listeners)}
          aria-label={pinned ? 'Pinned (root)' : 'Drag to reorder'}
          className={`px-1 ${pinned ? 'cursor-not-allowed text-gray-300' : 'cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600'}`}
          type="button"
          disabled={pinned}
        >
          ⋮⋮
        </button>
        <input
          type="checkbox"
          checked={node.included}
          onChange={e => onToggle(node.id, e.target.checked)}
          className="shrink-0"
          aria-label={node.included ? 'Exclude from menu' : 'Include in menu'}
        />
        <input
          type="text"
          value={node.label}
          placeholder={node.defaultLabel}
          onChange={e => onRename(node.id, e.target.value)}
          className="flex-1 min-w-0 px-2 py-0.5 text-xs border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          type="button"
          onClick={() => setUrlOpen(o => !o)}
          aria-expanded={urlOpen}
          title={urlOpen ? 'Hide URL' : 'Edit URL'}
          className={`shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded border ${urlOpen ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-500 hover:text-blue-700 hover:border-blue-300'}`}
        >
          URL
        </button>
        <button
          type="button"
          onClick={() => onPromote(node.id)}
          disabled={!canPromote || pinned}
          aria-label="Promote (outdent)"
          title="Promote (outdent)"
          className="shrink-0 px-1.5 py-0.5 text-xs rounded border border-gray-200 text-gray-500 enabled:hover:text-blue-700 enabled:hover:border-blue-300 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ⇤
        </button>
        <button
          type="button"
          onClick={() => onDemote(node.id)}
          disabled={!canDemote || pinned}
          aria-label="Demote (indent)"
          title="Demote (indent)"
          className="shrink-0 px-1.5 py-0.5 text-xs rounded border border-gray-200 text-gray-500 enabled:hover:text-blue-700 enabled:hover:border-blue-300 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          ⇥
        </button>
        <button
          type="button"
          onClick={() => onAddChild(node.id)}
          aria-label="Add child page"
          title="Add child page"
          className="shrink-0 px-1.5 py-0.5 text-xs rounded border border-gray-200 text-gray-500 hover:text-green-700 hover:border-green-300"
        >
          +
        </button>
        {isAdded && (
          <button
            type="button"
            onClick={() => onDelete(node.id)}
            aria-label="Delete page"
            title="Delete page"
            className="shrink-0 px-1.5 py-0.5 text-xs rounded border border-gray-200 text-gray-500 hover:text-red-700 hover:border-red-300"
          >
            ×
          </button>
        )}
      </div>
      {urlOpen && (
        <div className="ml-6 mt-1 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-gray-400 shrink-0">URL</span>
            <input
              type="text"
              value={node.href}
              placeholder="path/to/page"
              onChange={e => onSetHref(node.id, e.target.value)}
              className="flex-1 min-w-0 px-2 py-0.5 text-xs font-mono border border-gray-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer pl-9">
            <input
              type="checkbox"
              checked={!!node.external}
              onChange={e => onSetExternal(node.id, e.target.checked)}
              className="shrink-0"
            />
            <span>External link <span className="text-gray-400">(keep full URL even when site-root-relative is selected)</span></span>
          </label>
        </div>
      )}
      {node.children.length > 0 && (
        <div className="ml-6 mt-1">
          <EditableTree
            nodes={node.children}
            parentId={node.id}
            promoteBoundaryId={promoteBoundaryId}
            addedIds={addedIds}
            onRename={onRename}
            onToggle={onToggle}
            onReorder={onReorder}
            onAddChild={onAddChild}
            onAddSibling={onAddSibling}
            onDelete={onDelete}
            onSetHref={onSetHref}
            onSetExternal={onSetExternal}
            onPromote={onPromote}
            onDemote={onDemote}
          />
        </div>
      )}
    </li>
  )
}

// ── Live preview (inline, no iframe) ────────────────────────────────────────

// One <style> tag per app load, injected into <head> so it's outside React's
// virtual DOM and can't be removed/reapplied on re-renders. The sidenav CSS
// is fully scoped under .au-sidenav (designed for drop-in DNN deployment),
// so it can't leak onto the helper's own UI. Updating textContent on each
// color change is how the live preview reflects the chosen accent without
// re-rendering the nav itself (so initNav state survives).
function applyPreviewSidenavCss(color: string) {
  if (typeof document === 'undefined') return
  let style = document.head.querySelector<HTMLStyleElement>('style[data-au-sidenav-preview]')
  if (!style) {
    style = document.createElement('style')
    style.setAttribute('data-au-sidenav-preview', '')
    document.head.appendChild(style)
  }
  style.textContent = applyAccentColor(sidenavCss, color)
}

interface SidenavPreviewProps {
  html: string
  accentColor: string
  currentPath: string | null
  onSelectPath: (href: string) => void
}

// Class modifiers that sidenav.js applies during initNav based on the current
// path. On a re-init with a different path we strip them first so the new
// init runs against a clean slate (initNav uses classList.add, not replace).
const SIDENAV_INIT_CLASSES = [
  'au-sidenav__link--current',
  'au-sidenav__item--current-section',
  'au-sidenav__item--expanded',
  'au-sidenav__item--collapsed',
]

function SidenavPreview({ html, accentColor, currentPath, onSelectPath }: SidenavPreviewProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { applyPreviewSidenavCss(accentColor) }, [accentColor])

  // After every HTML or current-path change, (re)initialize the sidenav so
  // chevron toggles + depth indents + current-page highlighting reflect the
  // latest state. When html changed the DOM is fresh from
  // dangerouslySetInnerHTML so the cleanup is a no-op; when only currentPath
  // changed we strip the previous init's class modifiers and clear the init
  // flag so initNav re-evaluates against the new path.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const nav = wrap.querySelector<HTMLElement>('.au-sidenav')
    if (!nav || !window.AuSidenav) return
    if (currentPath) nav.setAttribute('data-au-current-path', currentPath)
    else nav.removeAttribute('data-au-current-path')
    for (const cls of SIDENAV_INIT_CLASSES) {
      nav.querySelectorAll('.' + cls).forEach(el => el.classList.remove(cls))
    }
    delete nav.dataset.auSidenavInit
    window.AuSidenav.initNav(nav)
  }, [html, currentPath])

  // Intercept link clicks: a plain click sets the previewed current page;
  // ctrl/cmd/shift-click and middle-click fall through so the browser's
  // native "open in new tab/window" still works. Chevron toggles are
  // <button>s, not anchors, so sidenav.js's own delegated handler is
  // unaffected.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null
      const a = target?.closest('a[href]') as HTMLAnchorElement | null
      if (!a || !wrap.contains(a)) return
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      onSelectPath(a.getAttribute('href') || '')
    }
    wrap.addEventListener('click', onClick)
    return () => wrap.removeEventListener('click', onClick)
  }, [onSelectPath])

  return (
    <div
      ref={wrapRef}
      className="border border-gray-200 rounded bg-white p-4 max-w-[320px]"
      // Preview HTML is generated by us from parsed clipboard data; rendered
      // directly so the real sidenav.js can wire up state on actual DOM nodes.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
