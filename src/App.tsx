import { useState, useMemo, useRef, useEffect, type ChangeEvent, type ClipboardEvent as RClipboardEvent } from 'react'
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
// Side-effect import: the sidenav IIFE registers window.AuSidenav.
import './vendor/au-sidenav/sidenav.js'

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
  selectSubtree,
  findNode,
  type SitemapNode,
} from './lib/sitemap'

// ── State ────────────────────────────────────────────────────────────────────

interface State {
  forest: SitemapNode[]
  rootId: string | null
  headerText: string
  pageCount: number
  maxDepth: number
  parseError: string
}

const INITIAL_STATE: State = {
  forest: [],
  rootId: null,
  headerText: 'In this section',
  pageCount: 0,
  maxDepth: 0,
  parseError: '',
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

  const { forest, rootId, headerText, pageCount, maxDepth, parseError } = state

  const hasForest = forest.length > 0
  const activeForest = useMemo(() => rootId ? selectSubtree(forest, rootId) : forest, [forest, rootId])

  const generatedHtml = useMemo(
    () => hasForest ? generateSidenavHtml(activeForest, { headerText }) : '',
    [hasForest, activeForest, headerText],
  )


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

  const handleSetRoot = (id: string | null) =>
    setState(s => ({ ...s, rootId: id }))

  const handleRename = (id: string, label: string) =>
    setState(s => ({ ...s, forest: renameNode(s.forest, id, label) }))

  const handleToggleInclude = (id: string, included: boolean) =>
    setState(s => ({ ...s, forest: setIncluded(s.forest, id, included) }))

  const handleReorder = (parentId: string | null, fromIndex: number, toIndex: number) =>
    setState(s => ({ ...s, forest: reorderSiblings(s.forest, parentId, fromIndex, toIndex) }))

  const handleHeaderText = (val: string) =>
    setState(s => ({ ...s, headerText: val }))

  const handleCopy = () => {
    if (!generatedHtml) return
    navigator.clipboard.writeText(generatedHtml).then(() => {
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

  const hasRoot = rootId !== null && findNode(forest, rootId) !== null

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex flex-col">
      <div className="flex-1 w-full py-2 px-4">

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
                Open a styled site-index page in your browser, select the visible list, copy, then paste here.
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
              <SectionLabel number={2} title="Choose the root" done={hasRoot} />
              <p className="text-xs text-gray-500 mb-2">
                Click a page to make it the top of your sidenav. The selected page becomes the visible parent; its children become the menu items.
              </p>
              <div className="border border-gray-200 rounded-lg max-h-64 overflow-auto">
                <RootPicker forest={forest} rootId={rootId} onPick={handleSetRoot} />
              </div>
              {hasRoot && (
                <button
                  onClick={() => handleSetRoot(null)}
                  className="mt-2 text-xs text-blue-600 hover:text-blue-800 underline"
                >
                  Use entire sitemap
                </button>
              )}
            </div>

          </div>

          {/* ── COL 2: Edit pages ── */}
          <div className="w-full lg:flex-1 lg:min-w-0">
            <div className={`bg-white rounded-xl shadow-sm border border-gray-100 p-4 transition-opacity
              ${hasForest ? 'opacity-100' : 'opacity-50 pointer-events-none'}`}>
              <SectionLabel number={3} title="Edit pages" done={hasForest} />
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
                  nodes={activeForest}
                  parentId={null}
                  onRename={handleRename}
                  onToggle={handleToggleInclude}
                  onReorder={handleReorder}
                />
              </div>
            </div>
          </div>

          {/* ── COL 3: Live preview ── */}
          <div className="w-full lg:flex-1 lg:min-w-0">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
              <h2 className="text-base font-semibold text-gray-800 mb-2">Live preview</h2>
              {hasForest ? (
                <SidenavPreview html={generatedHtml} />
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
                      {generatedHtml}
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
      <footer className="px-2 py-1 bg-white flex-shrink-0 flex justify-center sm:justify-end">
        <span className="text-[10px] text-gray-400 leading-none">
          Sidenav Helper v{__APP_VERSION__} •{' '}
          <a className="underline hover:text-blue-500" href="https://github.com/" target="_blank" rel="noreferrer">View on GitHub</a>
        </span>
      </footer>
    </div>
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
  onRename: (id: string, label: string) => void
  onToggle: (id: string, included: boolean) => void
  onReorder: (parentId: string | null, from: number, to: number) => void
}

function EditableTree({ nodes, parentId, onRename, onToggle, onReorder }: EditableTreeProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = nodes.findIndex(n => n.id === active.id)
    const to = nodes.findIndex(n => n.id === over.id)
    if (from === -1 || to === -1) return
    onReorder(parentId, from, to)
  }

  if (nodes.length === 0) return null

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={nodes.map(n => n.id)} strategy={verticalListSortingStrategy}>
        <ul className="space-y-1">
          {nodes.map(node => (
            <SortableEditableRow
              key={node.id}
              node={node}
              onRename={onRename}
              onToggle={onToggle}
              onReorder={onReorder}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

interface SortableEditableRowProps {
  node: SitemapNode
  onRename: (id: string, label: string) => void
  onToggle: (id: string, included: boolean) => void
  onReorder: (parentId: string | null, from: number, to: number) => void
}

function SortableEditableRow({ node, onRename, onToggle, onReorder }: SortableEditableRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  }

  return (
    <li ref={setNodeRef} style={style}>
      <div className={`flex items-center gap-2 px-2 py-1 rounded border ${node.included ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50 opacity-60'}`}>
        <button
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          className="cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 px-1"
          type="button"
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
      </div>
      {node.children.length > 0 && (
        <div className="ml-6 mt-1">
          <EditableTree
            nodes={node.children}
            parentId={node.id}
            onRename={onRename}
            onToggle={onToggle}
            onReorder={onReorder}
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
// so it can't leak onto the helper's own UI.
let __sidenavCssInjected = false
function ensureSidenavCss() {
  if (__sidenavCssInjected || typeof document === 'undefined') return
  __sidenavCssInjected = true
  const style = document.createElement('style')
  style.setAttribute('data-au-sidenav-preview', '')
  style.textContent = sidenavCss
  document.head.appendChild(style)
}

function SidenavPreview({ html }: { html: string }) {
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { ensureSidenavCss() }, [])

  // After every HTML change, (1) initialize the sidenav (chevron toggles +
  // depth indents) and (2) force preview links to open in a new tab so
  // clicking one doesn't navigate away from the helper. Step 2 is preview-
  // only — it doesn't touch the generated HTML the user copies.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const nav = wrap.querySelector('.au-sidenav')
    if (nav && window.AuSidenav) window.AuSidenav.initNav(nav)
    wrap.querySelectorAll('a[href]').forEach(a => {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    })
  }, [html])

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
