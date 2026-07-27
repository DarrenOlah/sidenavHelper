// Full-screen review workspace for merging a fresh site index into a
// customized menu.
//
// It replaces the whole four-column editor rather than sitting beside it,
// because the old side-by-side compare could not express what the merge
// actually does. Reviewing a menu tree and a 342-page site index next to each
// other, with accept buttons scattered over both, made a single editorial event
// ("this heading is a real page now") look like 38 unrelated decisions.
//
// Three panes, left to right:
//   PLAN       every consolidated change, grouped by phase, always visible
//   DETAIL     the focused change on its own, with before/after and options
//   MENU AFTER the staged result, so the outcome is visible before committing
//
// Nothing here mutates the menu. Decisions accumulate in a plain map owned by
// App; the forest is only rewritten when Apply is pressed.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  decisionFor,
  isStaged,
  planCounts,
  previewPlan,
  type ChangePhase,
  type Decisions,
  type MergeChange,
  type MergePlan,
  type PlanCounts,
} from './lib/plan'
import { findDuplicateLinks } from './lib/duplicates'
import { selectSubtree, type SitemapNode } from './lib/sitemap'

// ── Presentation vocabulary ─────────────────────────────────────────────────

const PHASES: Array<{ id: ChangePhase; n: number; title: string; blurb: string }> = [
  {
    id: 'identity',
    n: 1,
    title: 'Identity',
    blurb: 'What a page is. Decided first because everything else can depend on it.',
  },
  {
    id: 'structure',
    n: 2,
    title: 'Structure',
    blurb: 'Where pages live.',
  },
  {
    id: 'labels',
    n: 3,
    title: 'Labels',
    blurb: 'Page names. Yours are kept unless you say otherwise.',
  },
]

const KIND_GLYPH: Record<MergeChange['kind'], string> = {
  promote: '⬆',
  demote: '⬇',
  'url-rename': '⇄',
  'add-subtree': '＋',
  move: '→',
  remove: '−',
  relabel: '✎',
}

const KIND_TITLE: Record<MergeChange['kind'], string> = {
  promote: 'Group → real page',
  demote: 'Real page → group',
  'url-rename': 'Renamed (new URL)',
  'add-subtree': 'New page',
  move: 'Moved',
  remove: 'Gone from site index',
  relabel: 'Different label',
}

function ConfidenceChip({ level }: { level: 'high' | 'medium' | 'low' }) {
  const map = {
    high: { dots: '●●●', cls: 'text-green-700 bg-green-50 border-green-200', word: 'high' },
    medium: { dots: '●●○', cls: 'text-amber-700 bg-amber-50 border-amber-200', word: 'medium' },
    low: { dots: '●○○', cls: 'text-gray-600 bg-gray-50 border-gray-300', word: 'low' },
  }[level]
  return (
    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border font-mono ${map.cls}`}>
      {map.dots} {map.word}
    </span>
  )
}

// ── Staged-result markers ───────────────────────────────────────────────────

type Marker = 'added' | 'changed' | null

function collectById(roots: SitemapNode[], out = new Map<string, SitemapNode>()): Map<string, SitemapNode> {
  for (const n of roots) {
    out.set(n.id, n)
    collectById(n.children, out)
  }
  return out
}

// Compare the staged forest against the current one so the preview can mark
// what the accepted decisions would actually do.
function diffMarkers(before: SitemapNode[], after: SitemapNode[]): Map<string, Marker> {
  const prev = collectById(before)
  const markers = new Map<string, Marker>()
  function walk(nodes: SitemapNode[]): void {
    for (const n of nodes) {
      const old = prev.get(n.id)
      if (!old) markers.set(n.id, 'added')
      else if (old.href !== n.href || old.label !== n.label) markers.set(n.id, 'changed')
      walk(n.children)
    }
  }
  walk(after)
  return markers
}

// Nodes the focused change is about, so the result tree can highlight them.
// Additions have no menu id until they are applied, so they are found by href.
function focusTargets(change: MergeChange | undefined): { ids: Set<string>; hrefs: Set<string> } {
  const ids = new Set<string>()
  const hrefs = new Set<string>()
  if (!change) return { ids, hrefs }
  if ('menuNode' in change) ids.add(change.menuNode.id)
  if (change.kind === 'add-subtree') hrefs.add(lastPath(change.siteNode.href))
  if (change.kind === 'url-rename') hrefs.add(lastPath(change.newHref))
  return { ids, hrefs }
}

function lastPath(href: string): string {
  try {
    return new URL(href, 'https://x.invalid').pathname.toLowerCase().replace(/\/$/, '')
  } catch {
    return href.toLowerCase().replace(/\/$/, '')
  }
}

// ── Panes ───────────────────────────────────────────────────────────────────

function PlanPane({
  plan,
  decisions,
  cursor,
  onFocus,
}: {
  plan: MergePlan
  decisions: Decisions
  cursor: number
  onFocus: (index: number) => void
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  return (
    <div className="space-y-3">
      {PHASES.map(phase => {
        const rows = plan.changes
          .map((c, index) => ({ c, index }))
          .filter(({ c }) => c.phase === phase.id)
        if (rows.length === 0) return null
        return (
          <div key={phase.id}>
            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-[11px] font-semibold text-gray-700">
                {phase.n} {phase.title.toUpperCase()}
              </span>
              <span className="text-[11px] text-gray-400">{rows.length}</span>
            </div>
            <p className="text-[10px] text-gray-400 mb-1.5 leading-snug">{phase.blurb}</p>
            <ul className="space-y-0.5">
              {rows.map(({ c, index }) => {
                const staged = isStaged(c, decisions)
                const focused = index === cursor
                const mark = c.blockedReason ? '⚠' : staged ? '✓' : '○'
                const markCls = c.blockedReason
                  ? 'text-amber-600'
                  : staged
                    ? 'text-green-600'
                    : 'text-gray-300'
                return (
                  <li key={c.id}>
                    <button
                      ref={focused ? activeRef : undefined}
                      type="button"
                      onClick={() => onFocus(index)}
                      aria-current={focused ? 'step' : undefined}
                      className={`w-full text-left flex items-start gap-1.5 px-1.5 py-1 rounded text-[11px] border ${
                        focused
                          ? 'bg-blue-50 border-blue-300 text-blue-900'
                          : 'border-transparent text-gray-600 hover:bg-gray-50'
                      }`}
                    >
                      <span className={`shrink-0 ${markCls}`}>{mark}</span>
                      <span className="shrink-0 text-gray-400">{KIND_GLYPH[c.kind]}</span>
                      <span className="min-w-0 flex-1 truncate" title={c.title}>
                        {c.title}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

// How many siblings to show either side of the focused page.
const CONTEXT_RADIUS = 3

// Where a page sits in the site index: its parent plus the handful of siblings
// around it. Windowed rather than complete — a real site index section can hold
// forty pages, and pasting all of them into the detail pane buries the change
// the user is supposed to be looking at.
function SiteContext({
  siteNode,
  siteParents,
}: {
  siteNode: SitemapNode
  siteParents: Map<string, SitemapNode | null>
}) {
  const parent = siteParents.get(siteNode.id) ?? null
  const all = parent ? parent.children : [siteNode]
  const at = all.findIndex(s => s.id === siteNode.id)
  const centre = at === -1 ? 0 : at
  const start = Math.max(0, centre - CONTEXT_RADIUS)
  const end = Math.min(all.length, centre + CONTEXT_RADIUS + 1)
  const window = all.slice(start, end)

  return (
    <div className="mt-3 rounded border border-gray-200 bg-gray-50/60 p-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">
        In the site index
      </div>
      <div className="text-[11px] text-gray-600">{parent ? parent.label : 'Top level'}</div>
      <ul className="mt-1 ml-3 space-y-0.5">
        {start > 0 && <li className="text-[11px] text-gray-400">… {start} more above</li>}
        {window.map(s => (
          <li
            key={s.id}
            className={`text-[11px] truncate ${
              s.id === siteNode.id ? 'text-blue-800 font-medium' : 'text-gray-500'
            }`}
          >
            {s.id === siteNode.id ? '▸ ' : '  '}
            {s.label}
          </li>
        ))}
        {end < all.length && (
          <li className="text-[11px] text-gray-400">… {all.length - end} more below</li>
        )}
      </ul>
    </div>
  )
}

// Terminal step, reached by advancing past the last change. Without it the
// final Accept has nowhere to go and appears to do nothing.
function CompletionPane({
  counts,
  total,
  canApply,
  onPrev,
  onApply,
}: {
  counts: PlanCounts
  total: number
  canApply: boolean
  onPrev: () => void
  onApply: () => void
}) {
  const keeping = total - counts.staged - counts.blocked
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-semibold text-gray-700">✓ ALL CHANGES REVIEWED</span>
        <span className="text-[11px] text-gray-400">{total} of {total}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex flex-col items-center justify-center text-center px-4">
        <p className="text-sm font-semibold text-gray-900">
          You’ve been through all {total} change{total === 1 ? '' : 's'}.
        </p>
        <ul className="mt-3 space-y-1 text-xs text-gray-600">
          <li>
            <span className="text-green-700 font-medium">{counts.staged}</span> staged to apply
          </li>
          {keeping > 0 && (
            <li>
              <span className="font-medium">{keeping}</span> left as-is
            </li>
          )}
          {counts.blocked > 0 && (
            <li className="text-amber-700">
              <span className="font-medium">{counts.blocked}</span> can’t be applied
            </li>
          )}
        </ul>
        <p className="mt-3 text-[11px] text-gray-500 max-w-xs">
          Nothing has changed yet. Applying rewrites the menu in one step, and you can undo it
          afterwards.
        </p>
        <button
          type="button"
          onClick={onApply}
          disabled={!canApply}
          className="mt-4 px-4 py-1.5 text-xs rounded border border-green-500 bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:hover:bg-green-600"
        >
          Apply {counts.staged} change{counts.staged === 1 ? '' : 's'}
        </button>
        {counts.staged === 0 && (
          <p className="mt-2 text-[11px] text-gray-400">
            Nothing is staged — go back and accept a change, or cancel the review.
          </p>
        )}
      </div>
      <div className="mt-3 pt-2 border-t border-gray-100 flex items-center">
        <button
          type="button"
          onClick={onPrev}
          className="px-2 py-1 text-[11px] rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
        >
          ◀ Back to last change
        </button>
      </div>
    </div>
  )
}

function DetailPane({
  change,
  index,
  total,
  decisions,
  siteParents,
  onChoose,
  onPrev,
  onNext,
  onSkip,
}: {
  change: MergeChange | undefined
  index: number
  total: number
  decisions: Decisions
  siteParents: Map<string, SitemapNode | null>
  onChoose: (optionId: string) => void
  onPrev: () => void
  onNext: () => void
  onSkip: () => void
}) {
  if (!change) {
    return (
      <div className="h-full flex items-center justify-center text-center p-6">
        <p className="text-sm text-gray-500">
          No differences to review — your menu already matches the site index.
        </p>
      </div>
    )
  }
  const chosen = decisionFor(change, decisions)
  const blocked = !!change.blockedReason
  const chosenOption = change.options.find(o => o.id === chosen)
  const chosenIsSkip = !!chosenOption?.isSkip

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-700">
          <span className="text-base leading-none">{KIND_GLYPH[change.kind]}</span>
          {KIND_TITLE[change.kind].toUpperCase()}
        </span>
        <span className="text-[11px] text-gray-400">
          {index + 1} of {total}
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto pr-1">
        <h3 className="text-sm font-semibold text-gray-900 break-words">{change.title}</h3>
        <p className="mt-1.5 text-xs text-gray-600 leading-relaxed">{change.detail}</p>

        {change.kind === 'url-rename' && (
          <>
            <div className="mt-2">
              <ConfidenceChip level={change.confidence} />
            </div>
            <BeforeAfter
              beforeLabel={change.menuNode.label}
              beforeHref={change.menuNode.href}
              afterLabel={change.siteLabel}
              afterHref={change.newHref}
            />
          </>
        )}
        {change.kind === 'promote' && (
          <BeforeAfter
            beforeLabel={change.menuNode.label}
            beforeHref=""
            afterLabel={change.menuNode.label}
            afterHref={change.newHref}
          />
        )}
        {change.kind === 'relabel' && (
          <BeforeAfter
            beforeLabel={change.menuNode.label}
            beforeHref={change.menuNode.href}
            afterLabel={change.siteLabel}
            afterHref={change.menuNode.href}
          />
        )}
        {change.kind === 'add-subtree' && change.descendantCount > 0 && (
          <div className="mt-3 rounded border border-green-200 bg-green-50/50 p-2">
            <div className="text-[10px] uppercase tracking-wide text-green-700 mb-1">
              Comes with {change.descendantCount} sub-page
              {change.descendantCount === 1 ? '' : 's'}
            </div>
            <SubtreeOutline node={change.siteNode} />
          </div>
        )}
        {change.absorbedCount > 2 && change.kind === 'promote' && (
          <p className="mt-2 text-[11px] text-gray-500">
            {change.absorbedCount - 1} “moved” entries hidden — they only existed because the
            heading had no address of its own.
          </p>
        )}

        {'siteNode' in change && <SiteContext siteNode={change.siteNode} siteParents={siteParents} />}

        {blocked && (
          <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
            <strong className="font-semibold">Can’t apply this one.</strong> {change.blockedReason}
          </div>
        )}

        {!blocked && (
          <fieldset className="mt-4">
            <legend className="text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              What should happen
            </legend>
            <div className="space-y-1">
              {change.options.map(o => (
                <label
                  key={o.id}
                  className={`flex items-start gap-2 rounded border px-2 py-1.5 cursor-pointer ${
                    chosen === o.id
                      ? 'border-blue-300 bg-blue-50/60'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name={`opt-${change.id}`}
                    checked={chosen === o.id}
                    onChange={() => onChoose(o.id)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs text-gray-800">{o.label}</span>
                    {o.description && (
                      <span className="block text-[11px] text-gray-500">{o.description}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>

      {/* The radio group is the only thing that sets a decision. These buttons
          confirm what it already says and move on — a green "Accept" that
          silently overrode a deliberate keep-my-label default would be the same
          trap as a bulk "accept all renames". The label tells you which it is. */}
      <div className="mt-3 pt-2 border-t border-gray-100 flex items-center gap-2">
        <button
          type="button"
          onClick={onPrev}
          disabled={index === 0}
          className="px-2 py-1 text-[11px] rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
        >
          ◀ Prev
        </button>
        <div className="flex-1" />
        {!blocked && !chosenIsSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="px-2.5 py-1 text-[11px] rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            Skip
          </button>
        )}
        <button
          type="button"
          onClick={onNext}
          className={`px-2.5 py-1 text-[11px] rounded border ${
            blocked || chosenIsSkip
              ? 'border-gray-300 text-gray-700 hover:bg-gray-50'
              : 'border-green-300 bg-green-50 text-green-800 hover:bg-green-100'
          }`}
        >
          {blocked ? 'Next ▶' : chosenIsSkip ? 'Keep as-is ▶' : 'Accept ▶'}
        </button>
      </div>
    </div>
  )
}

function BeforeAfter({
  beforeLabel,
  beforeHref,
  afterLabel,
  afterHref,
}: {
  beforeLabel: string
  beforeHref: string
  afterLabel: string
  afterHref: string
}) {
  return (
    <div className="mt-3 space-y-1">
      <div className="rounded border border-red-200 bg-red-50/50 px-2 py-1">
        <div className="text-[10px] uppercase tracking-wide text-red-700">Now</div>
        <div className="text-xs text-gray-800 break-words">{beforeLabel || '(no label)'}</div>
        <code className="block text-[10px] font-mono text-gray-500 break-all">
          {beforeHref || '(no link — heading only)'}
        </code>
      </div>
      <div className="rounded border border-green-200 bg-green-50/50 px-2 py-1">
        <div className="text-[10px] uppercase tracking-wide text-green-700">Site index</div>
        <div className="text-xs text-gray-800 break-words">{afterLabel || '(no label)'}</div>
        <code className="block text-[10px] font-mono text-gray-500 break-all">
          {afterHref || '(no link)'}
        </code>
      </div>
    </div>
  )
}

function SubtreeOutline({ node, depth = 0 }: { node: SitemapNode; depth?: number }) {
  if (depth > 2) return null
  return (
    <ul className={depth === 0 ? '' : 'ml-3'}>
      {node.children.map(c => (
        <li key={c.id}>
          <span className="text-[11px] text-gray-600 truncate block">{c.label}</span>
          {c.children.length > 0 && <SubtreeOutline node={c} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  )
}

function ResultTree({
  nodes,
  markers,
  focus,
  depth = 0,
}: {
  nodes: SitemapNode[]
  markers: Map<string, Marker>
  focus: { ids: Set<string>; hrefs: Set<string> }
  depth?: number
}) {
  return (
    <ul className={depth === 0 ? 'space-y-0.5' : 'ml-3 space-y-0.5'}>
      {nodes.map(n => {
        const marker = markers.get(n.id) ?? null
        const isFocused = focus.ids.has(n.id) || focus.hrefs.has(lastPath(n.href))
        const glyph = marker === 'added' ? '+' : marker === 'changed' ? '~' : ' '
        const cls = !n.included
          ? 'text-gray-300 line-through'
          : marker === 'added'
            ? 'text-green-800'
            : marker === 'changed'
              ? 'text-amber-800'
              : n.href.trim() === ''
                ? 'text-gray-400 italic'
                : 'text-gray-600'
        return (
          <li key={n.id}>
            <div
              data-focused={isFocused ? 'true' : undefined}
              className={`flex items-start gap-1 text-[11px] rounded px-1 ${
                isFocused ? 'bg-blue-100 ring-1 ring-blue-300' : ''
              }`}
            >
              <span
                className={`shrink-0 w-2 font-mono ${
                  marker === 'added'
                    ? 'text-green-600'
                    : marker === 'changed'
                      ? 'text-amber-600'
                      : 'text-transparent'
                }`}
              >
                {glyph}
              </span>
              <span className={`min-w-0 truncate ${cls}`} title={n.href || n.label}>
                {n.label || '(no label)'}
              </span>
            </div>
            {n.children.length > 0 && (
              <ResultTree nodes={n.children} markers={markers} focus={focus} depth={depth + 1} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ── ReviewMode ──────────────────────────────────────────────────────────────

export interface ReviewModeProps {
  menuForest: SitemapNode[]
  siteForest: SitemapNode[]
  rootId: string | null
  menuSiteUrl: string
  plan: MergePlan
  decisions: Decisions
  onSetDecision: (changeId: string, optionId: string) => void
  onCancel: () => void
  onApply: (forest: SitemapNode[]) => void
  // Site-index URL + compare-scope controls, injected by App so this component
  // does not have to re-implement them.
  settings: ReactNode
  settingsSummary: string
}

export default function ReviewMode({
  menuForest,
  siteForest,
  rootId,
  menuSiteUrl,
  plan,
  decisions,
  onSetDecision,
  onCancel,
  onApply,
  settings,
  settingsSummary,
}: ReviewModeProps) {
  const [cursorRaw, setCursor] = useState(0)
  const [showSettings, setShowSettings] = useState(false)
  const changes = plan.changes
  const total = changes.length
  // Clamp during render rather than in an effect: rebuilding the plan (a scope
  // change, a re-paste) can shorten the list underneath the cursor, and
  // correcting that with setState would cost an extra render pass.
  //
  // `cursor === total` is the terminal "all reviewed" step, so advancing past
  // the last change lands somewhere real instead of appearing to do nothing.
  const cursor = Math.min(cursorRaw, total)
  const atEnd = total > 0 && cursor >= total
  const change = changes[cursor]

  const counts = useMemo(() => planCounts(plan, decisions), [plan, decisions])

  const preview = useMemo(
    () => previewPlan(menuForest, plan, decisions, { rootId, menuSiteUrl }),
    [menuForest, plan, decisions, rootId, menuSiteUrl],
  )
  const previewForest = preview?.forest ?? menuForest
  const visibleBefore = useMemo(
    () => (rootId ? selectSubtree(menuForest, rootId) : menuForest),
    [menuForest, rootId],
  )
  const visibleAfter = useMemo(
    () => (rootId ? selectSubtree(previewForest, rootId) : previewForest),
    [previewForest, rootId],
  )
  const markers = useMemo(() => diffMarkers(visibleBefore, visibleAfter), [visibleBefore, visibleAfter])
  const focus = useMemo(() => focusTargets(change), [change])

  // Parent lookup for the site index, used by the detail pane's context slice.
  const siteParents = useMemo(() => {
    const map = new Map<string, SitemapNode | null>()
    function walk(nodes: SitemapNode[], parent: SitemapNode | null): void {
      for (const n of nodes) {
        map.set(n.id, parent)
        walk(n.children, n)
      }
    }
    walk(siteForest, null)
    return map
  }, [siteForest])

  const resultDupes = useMemo(
    () => findDuplicateLinks(visibleAfter).filter(g => g.severity === 'error'),
    [visibleAfter],
  )

  // Keep the focused row in view in the result tree.
  const treeRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    treeRef.current?.querySelector('[data-focused="true"]')?.scrollIntoView({ block: 'center' })
  }, [cursor])

  const go = (next: number) => setCursor(Math.max(0, Math.min(next, total)))

  const handleSkip = () => {
    if (!change) return
    const skipOption = change.options.find(o => o.isSkip)
    if (skipOption) onSetDecision(change.id, skipOption.id)
    go(cursor + 1)
  }

  const handleApply = () => {
    if (preview) onApply(preview.forest)
  }

  const blockedCount = preview ? preview.blocked.length : counts.blocked

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100">
        <h2 className="text-base font-semibold text-gray-800">Review changes against site index</h2>
        <span className="text-xs text-gray-500">
          {counts.staged} of {total} staged
          {blockedCount > 0 && <span className="text-amber-700"> · {blockedCount} blocked</span>}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setShowSettings(s => !s)}
          aria-expanded={showSettings}
          className="text-[11px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:text-blue-700 hover:border-blue-300"
          title={settingsSummary}
        >
          ⚙ Compare settings
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleApply}
          disabled={!preview || counts.staged === 0}
          className="text-[11px] px-3 py-1 rounded border border-green-500 bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 disabled:hover:bg-green-600"
        >
          Apply {counts.staged} change{counts.staged === 1 ? '' : 's'}
        </button>
      </div>

      {showSettings && (
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/60">{settings}</div>
      )}

      {plan.suppressed.moveArtifacts +
        plan.suppressed.duplicateLinks +
        plan.suppressed.absorbedAdds >
        0 && (
        <p className="px-4 pt-2 text-[11px] text-gray-500">
          Consolidated automatically:{' '}
          {[
            plan.suppressed.moveArtifacts > 0 &&
              `${plan.suppressed.moveArtifacts} move${plan.suppressed.moveArtifacts === 1 ? '' : 's'} caused by a heading gaining its own address`,
            plan.suppressed.absorbedAdds > 0 &&
              `${plan.suppressed.absorbedAdds} sub-page${plan.suppressed.absorbedAdds === 1 ? '' : 's'} folded into their parent`,
            plan.suppressed.duplicateLinks > 0 &&
              `${plan.suppressed.duplicateLinks} duplicate link${plan.suppressed.duplicateLinks === 1 ? '' : 's'} in the site index ignored`,
          ]
            .filter(Boolean)
            .join(' · ')}
          .
        </p>
      )}

      {/* Three panes */}
      <div className="flex flex-col lg:flex-row gap-4 p-4">
        <div className="lg:w-64 lg:shrink-0 max-h-[70vh] overflow-auto border border-gray-200 rounded-lg p-2">
          <PlanPane plan={plan} decisions={decisions} cursor={cursor} onFocus={go} />
          {total > 0 && (
            <button
              type="button"
              onClick={() => go(total)}
              aria-current={atEnd ? 'step' : undefined}
              className={`mt-3 w-full text-left px-1.5 py-1 rounded text-[11px] border ${
                atEnd
                  ? 'bg-blue-50 border-blue-300 text-blue-900'
                  : 'border-transparent text-gray-500 hover:bg-gray-50'
              }`}
            >
              ✓ Finish &amp; apply
            </button>
          )}
        </div>

        <div className="flex-1 min-w-0 max-h-[70vh] border border-gray-200 rounded-lg p-3">
          {atEnd ? (
            <CompletionPane
              counts={counts}
              total={total}
              canApply={!!preview && counts.staged > 0}
              onPrev={() => go(total - 1)}
              onApply={handleApply}
            />
          ) : (
            <DetailPane
              change={change}
              index={cursor}
              total={total}
              decisions={decisions}
              siteParents={siteParents}
              onChoose={id => change && onSetDecision(change.id, id)}
              onPrev={() => go(cursor - 1)}
              onNext={() => go(cursor + 1)}
              onSkip={handleSkip}
            />
          )}
        </div>

        <div className="lg:w-80 lg:shrink-0 flex flex-col min-w-0">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[11px] font-semibold text-gray-700">MENU AFTER</span>
            <span className="text-[10px] text-gray-400">
              <span className="text-green-600">+</span> added{' '}
              <span className="text-amber-600">~</span> changed
            </span>
          </div>
          {!preview && (
            <p className="mb-1 text-[11px] text-red-700">
              Could not build a preview for these decisions — nothing has been applied.
            </p>
          )}
          {resultDupes.length > 0 && (
            <p className="mb-1 text-[11px] text-red-700">
              {resultDupes.length} duplicate link{resultDupes.length === 1 ? '' : 's'} in the result.
            </p>
          )}
          <div
            ref={treeRef}
            className="flex-1 max-h-[70vh] overflow-auto border border-gray-200 rounded-lg p-2"
          >
            <ResultTree nodes={visibleAfter} markers={markers} focus={focus} />
          </div>
        </div>
      </div>
    </div>
  )
}
