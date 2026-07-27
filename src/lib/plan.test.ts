// Node globals are not part of the app's lib set (it targets the browser), and
// TS 6 no longer auto-includes @types/node. This is the only file that touches
// the filesystem — it reads the checked-in example menu + site index.
/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  applyPlan,
  buildMergePlan,
  defaultDecisions,
  isAcronymOf,
  scoreRename,
  type Decisions,
  type MergeChange,
} from './plan'
import { findDuplicateLinks } from './duplicates'
import {
  applySiteUrl,
  detectSiteUrls,
  findNode,
  generateSidenavHtml,
  parseSitemapHtml,
  selectSubtree,
  type SitemapNode,
} from './sitemap'
import { detectMenuScope, detectSiblingModeRoot, filterSiteIndexByScope } from './diff'

function n(id: string, href: string, label: string, children: SitemapNode[] = []): SitemapNode {
  return { id, href, defaultLabel: label, label, included: true, children }
}
function cat(id: string, label: string, children: SitemapNode[]): SitemapNode {
  return { id, href: '', defaultLabel: label, label, included: true, children }
}
function ext(id: string, href: string, label: string): SitemapNode {
  return { ...n(id, href, label), external: true }
}

function kinds(changes: MergeChange[]): string[] {
  return changes.map(c => c.kind)
}
function byKind(changes: MergeChange[], kind: string): MergeChange[] {
  return changes.filter(c => c.kind === kind)
}
function nodeCount(roots: SitemapNode[]): number {
  return roots.reduce((sum, r) => sum + 1 + nodeCount(r.children), 0)
}

// ── Rename scoring ──────────────────────────────────────────────────────────

describe('scoreRename', () => {
  it('rates a slug that gained a suffix as high confidence', () => {
    const m = scoreRename(
      n('a', '/dsw/shadows-and-steel-2045/', 'Shadows and Steel 2045'),
      n('b', '/dsw/shadows-and-steel/', 'Shadows and Steel'),
    )
    expect(m.confidence).toBe('high')
  })

  it('rates an acronym slug as high confidence', () => {
    const m = scoreRename(
      n('a', '/dsw/wargame-designer-course-wdc/', 'Wargame Designer Course (WDC)'),
      n('b', '/dsw/wdc/', 'WDC'),
    )
    expect(m.confidence).toBe('high')
  })

  it('rates an abbreviated word as high confidence', () => {
    const m = scoreRename(
      n('a', '/futures/emerging-tech/', 'Emerging Tech'),
      n('b', '/futures/emerging-technology/', 'Emerging Technology'),
    )
    expect(m.confidence).toBe('high')
  })

  it('rates an appended word as high confidence', () => {
    const m = scoreRename(
      n('a', '/futures/strategic-competition/', 'Strategic Competition'),
      n('b', '/futures/strategic-competition-center/', 'Strategic Competition Center'),
    )
    expect(m.confidence).toBe('high')
  })

  it('rates a merely similar name as medium, not high', () => {
    // 'Mideast' → 'Middle East' has real bigram overlap but no structural
    // evidence. Claiming high confidence here would be overselling it.
    const m = scoreRename(
      n('a', '/global/mideast/', 'Mideast'),
      n('b', '/global/middle-east/', 'Middle East'),
    )
    expect(m.confidence).toBe('medium')
  })

  it('declines to pair unrelated pages', () => {
    const m = scoreRename(n('a', '/a/registrar/', 'Registrar'), n('b', '/a/library/', 'Library'))
    expect(m.confidence).toBeNull()
  })

  it('does not treat a shared word-prefix as an abbreviation', () => {
    // 'news' vs 'newsroom' are different pages, not a rename.
    const m = scoreRename(n('a', '/csl/news/', 'News'), n('b', '/csl/newsroom/', 'Newsroom'))
    expect(m.confidence).not.toBe('high')
  })
})

describe('isAcronymOf', () => {
  it('matches a parenthetical acronym', () => {
    expect(isAcronymOf('SRAD', 'Strategic Research and Assessment Department (SRAD)')).toBe(true)
  })
  it('matches plain initials', () => {
    expect(isAcronymOf('CSL', 'Center Strategic Leadership')).toBe(true)
  })
  it('rejects a transposed acronym', () => {
    expect(isAcronymOf('MFSP', 'Military Spouse and Family Studies Program (MSFP)')).toBe(false)
  })
})

// ── Rule A: promotion ───────────────────────────────────────────────────────

describe('buildMergePlan — a menu-only group becomes a real page', () => {
  const menu = () => [
    n('root', '/usawc/', 'USAWC Home', [
      cat('carlisle', 'Carlisle Experience', [
        n('rs', '/usawc/carlisle-experience/resident-student/', 'Resident Student', [
          n('rs1', '/usawc/carlisle-experience/resident-student/arrival/', 'Arrival'),
        ]),
        n('fam', '/usawc/carlisle-experience/families/', 'Families'),
        ext('dunham', 'https://dunham.tricare.mil/', 'Dunham Army Health Clinic'),
      ]),
    ]),
  ]
  const site = () => [
    n('s-root', '/usawc/', 'USAWC', [
      n('s-carlisle', '/usawc/carlisle-experience/', 'Carlisle Experience', [
        n('s-rs', '/usawc/carlisle-experience/resident-student/', 'Resident Student', [
          n('s-rs1', '/usawc/carlisle-experience/resident-student/arrival/', 'Arrival'),
        ]),
        n('s-fam', '/usawc/carlisle-experience/families/', 'Families'),
        ext('s-dunham', 'https://dunham.tricare.mil/', 'Dunham Army Health Clinic'),
      ]),
    ]),
  ]

  it('emits one promote instead of an add plus a move per descendant', () => {
    const plan = buildMergePlan(menu(), site(), { rootId: 'root' })
    expect(byKind(plan.changes, 'promote')).toHaveLength(1)
    expect(byKind(plan.changes, 'move')).toHaveLength(0)
    expect(byKind(plan.changes, 'add-subtree')).toHaveLength(0)
    // All four descendants gained a level: the three internal pages and the
    // external clinic link, which also hangs off the group.
    expect(plan.suppressed.moveArtifacts).toBe(4)
  })

  it('keeps the menu label, children and order when applied', () => {
    const menuForest = menu()
    const plan = buildMergePlan(menuForest, site(), { rootId: 'root' })
    const result = applyPlan(menuForest, plan, defaultDecisions(plan), {
      rootId: 'root',
      menuSiteUrl: '/',
    })
    const promoted = findNode(result.forest, 'carlisle')!
    expect(promoted.href).toBe('/usawc/carlisle-experience/')
    expect(promoted.label).toBe('Carlisle Experience')
    expect(promoted.children.map(c => c.id)).toEqual(['rs', 'fam', 'dunham'])
    expect(nodeCount(result.forest)).toBe(nodeCount(menuForest))
  })

  it('does not promote a group whose pages are not all under the new page', () => {
    const mixed = [
      n('root', '/usawc/', 'USAWC Home', [
        cat('audiences', 'Audiences', [
          n('cs', '/usawc/current-students/', 'Current Students'),
          n('al', '/usawc/alumni/', 'Alumni'),
        ]),
      ]),
    ]
    const withNewPage = [
      n('s-root', '/usawc/', 'USAWC', [
        n('s-aud', '/usawc/audiences/', 'Audiences'),
        n('s-cs', '/usawc/current-students/', 'Current Students'),
        n('s-al', '/usawc/alumni/', 'Alumni'),
      ]),
    ]
    const plan = buildMergePlan(mixed, withNewPage, { rootId: 'root' })
    expect(byKind(plan.changes, 'promote')).toHaveLength(0)
  })
})

// ── Rule B: url renames ─────────────────────────────────────────────────────

describe('buildMergePlan — URL renames', () => {
  it('pairs a same-parent remove and add into one change', () => {
    const menu = [
      n('p', '/futures/', 'Futures', [n('old', '/futures/emerging-tech/', 'Emerging Tech')]),
    ]
    const site = [
      n('sp', '/futures/', 'Futures', [
        n('new', '/futures/emerging-technology/', 'Emerging Technology'),
      ]),
    ]
    const plan = buildMergePlan(menu, site)
    expect(kinds(plan.changes)).toEqual(['url-rename'])
    expect(byKind(plan.changes, 'remove')).toHaveLength(0)
    expect(byKind(plan.changes, 'add-subtree')).toHaveLength(0)
  })

  it('keeps the menu label by default and adopts the new URL', () => {
    const menu = [
      n('p', '/csl/', 'CSL', [
        n('old', '/csl/srad/', 'Strategic Research and Assessment Department (SRAD)', [
          n('kid', '/csl/srad/futures/', 'Futures'),
        ]),
      ]),
    ]
    const site = [
      n('sp', '/csl/', 'CSL', [
        n('new', '/csl/srad-dept/', 'SRAD', [n('skid', '/csl/srad/futures/', 'Futures')]),
      ]),
    ]
    const plan = buildMergePlan(menu, site)
    const rename = byKind(plan.changes, 'url-rename')[0]
    expect(rename.defaultOptionId).toBe('keep-label')
    const result = applyPlan(menu, plan, defaultDecisions(plan))
    const node = findNode(result.forest, 'old')!
    expect(node.href).toBe('/csl/srad-dept/')
    expect(node.label).toBe('Strategic Research and Assessment Department (SRAD)')
    // The child came along because the node itself was never removed.
    expect(node.children.map(c => c.id)).toEqual(['kid'])
  })

  it('adopts the site label when asked to', () => {
    const menu = [n('p', '/f/', 'F', [n('old', '/f/mideast/', 'Mideast')])]
    const site = [n('sp', '/f/', 'F', [n('new', '/f/middle-east/', 'Middle East')])]
    const plan = buildMergePlan(menu, site)
    const rename = byKind(plan.changes, 'url-rename')[0]
    const decisions: Decisions = { [rename.id]: 'take-label' }
    const result = applyPlan(menu, plan, decisions)
    expect(findNode(result.forest, 'old')!.label).toBe('Middle East')
  })

  it('splits back into a removal and an addition on request', () => {
    const menu = [n('p', '/f/', 'F', [n('old', '/f/mideast/', 'Mideast')])]
    const site = [n('sp', '/f/', 'F', [n('new', '/f/middle-east/', 'Middle East')])]
    const plan = buildMergePlan(menu, site)
    const rename = byKind(plan.changes, 'url-rename')[0]
    const result = applyPlan(menu, plan, { [rename.id]: 'split' })
    expect(findNode(result.forest, 'old')).toBeNull()
    const parent = findNode(result.forest, 'p')!
    expect(parent.children).toHaveLength(1)
    expect(parent.children[0].label).toBe('Middle East')
  })

  it('pairs the only leftover removal and addition even without a textual clue', () => {
    const menu = [n('p', '/f/', 'F', [n('old', '/f/xyzzy/', 'Xyzzy')])]
    const site = [n('sp', '/f/', 'F', [n('new', '/f/quux/', 'Quux')])]
    const plan = buildMergePlan(menu, site)
    const renames = byKind(plan.changes, 'url-rename')
    expect(renames).toHaveLength(1)
    expect(renames[0].kind === 'url-rename' && renames[0].confidence).toBe('low')
  })

  it('does NOT pair across different parents', () => {
    const menu = [
      n('p1', '/a/', 'A', [n('old', '/a/emerging-tech/', 'Emerging Tech')]),
      n('p2', '/b/', 'B'),
    ]
    const site = [
      n('sp1', '/a/', 'A'),
      n('sp2', '/b/', 'B', [n('new', '/b/emerging-technology/', 'Emerging Technology')]),
    ]
    const plan = buildMergePlan(menu, site)
    expect(byKind(plan.changes, 'url-rename')).toHaveLength(0)
    expect(byKind(plan.changes, 'remove')).toHaveLength(1)
    expect(byKind(plan.changes, 'add-subtree')).toHaveLength(1)
  })

  it('assigns the best pairing when a parent has two of each', () => {
    const menu = [
      n('p', '/dsw/', 'DSW', [
        n('r1', '/dsw/shadows-and-steel-2045/', 'Shadows and Steel 2045'),
        n('r2', '/dsw/wargame-designer-course-wdc/', 'Wargame Designer Course (WDC)'),
      ]),
    ]
    const site = [
      n('sp', '/dsw/', 'DSW', [
        n('a1', '/dsw/shadows-and-steel/', 'Shadows and Steel'),
        n('a2', '/dsw/wdc/', 'WDC'),
      ]),
    ]
    const plan = buildMergePlan(menu, site)
    const renames = byKind(plan.changes, 'url-rename')
    expect(renames).toHaveLength(2)
    const mapping = new Map(
      renames.map(c => [
        c.kind === 'url-rename' ? c.menuNode.id : '',
        c.kind === 'url-rename' ? c.siteNode.id : '',
      ]),
    )
    expect(mapping.get('r1')).toBe('a1')
    expect(mapping.get('r2')).toBe('a2')
  })
})

// ── Rule C / D / E ──────────────────────────────────────────────────────────

describe('buildMergePlan — absorption and suppression', () => {
  it('folds descendant additions into their ancestor', () => {
    const menu = [n('p', '/dde/', 'DDE')]
    const site = [
      n('sp', '/dde/', 'DDE', [
        n('nss', '/dde/nss/', 'National Security Seminar', [
          n('o', '/dde/nss/objectives/', 'Objectives'),
          n('r', '/dde/nss/recent/', 'Most Recent Seminar'),
        ]),
      ]),
    ]
    const plan = buildMergePlan(menu, site)
    const adds = byKind(plan.changes, 'add-subtree')
    expect(adds).toHaveLength(1)
    expect(adds[0].kind === 'add-subtree' && adds[0].descendantCount).toBe(2)
    expect(plan.suppressed.absorbedAdds).toBe(2)
  })

  it('never proposes adding a page the index merely links twice', () => {
    const menu = [
      n('root', '/usawc/', 'USAWC', [
        n('carlisle', '/usawc/carlisle/', 'Carlisle Experience'),
        n('dde', '/usawc/dde/', 'Department of Distance Education (DDE)'),
      ]),
    ]
    const site = [
      n('s-root', '/usawc/', 'USAWC', [
        n('s-carlisle', '/usawc/carlisle/', 'Carlisle Experience', [
          n('s-shortcut', '/usawc/dde/', 'DDE'),
        ]),
        n('s-dde', '/usawc/dde/', 'DDE'),
      ]),
    ]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    expect(byKind(plan.changes, 'add-subtree')).toHaveLength(0)
    expect(byKind(plan.changes, 'move')).toHaveLength(0)
    expect(plan.suppressed.duplicateLinks).toBe(1)
  })

  it('suppresses the tool\'s own " Home" suffix on the picked root', () => {
    const menu = [n('root', '/usawc/', 'USAWC Home')]
    const site = [n('s', '/usawc/', 'USAWC')]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    expect(byKind(plan.changes, 'relabel')).toHaveLength(0)
    expect(plan.suppressed.autoHomeRelabels).toBe(1)
  })

  it('still reports a genuine relabel on the root', () => {
    const menu = [n('root', '/usawc/', 'Army War College')]
    const site = [n('s', '/usawc/', 'USAWC')]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    expect(byKind(plan.changes, 'relabel')).toHaveLength(1)
  })
})

// ── Labels and removals ─────────────────────────────────────────────────────

describe('buildMergePlan — defaults', () => {
  it('keeps the menu label by default and flags the expansion', () => {
    const menu = [n('a', '/csl/', 'Center for Strategic Leadership (CSL)')]
    const site = [n('s', '/csl/', 'CSL')]
    const plan = buildMergePlan(menu, site)
    const relabel = byKind(plan.changes, 'relabel')[0]
    expect(relabel.phase).toBe('labels')
    expect(relabel.defaultOptionId).toBe('keep')
    expect(relabel.kind === 'relabel' && relabel.menuLabelExpandsSite).toBe(true)
    const result = applyPlan(menu, plan, defaultDecisions(plan))
    expect(findNode(result.forest, 'a')!.label).toBe('Center for Strategic Leadership (CSL)')
  })

  it('never stages a removal by default', () => {
    const menu = [n('root', '/a/', 'A', [n('gone', '/a/gone/', 'Gone', [n('k', '/a/gone/k/', 'K')])])]
    const site = [n('s', '/a/', 'A')]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    const remove = byKind(plan.changes, 'remove')[0]
    expect(remove.defaultOptionId).toBe('skip')
    expect(remove.kind === 'remove' && remove.childCount).toBe(1)
    const result = applyPlan(menu, plan, defaultDecisions(plan), { rootId: 'root' })
    expect(findNode(result.forest, 'gone')).not.toBeNull()
  })

  it('removes when explicitly accepted', () => {
    const menu = [n('root', '/a/', 'A', [n('gone', '/a/gone/', 'Gone')])]
    const site = [n('s', '/a/', 'A')]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    const remove = byKind(plan.changes, 'remove')[0]
    const result = applyPlan(menu, plan, { [remove.id]: 'accept' }, { rootId: 'root' })
    expect(findNode(result.forest, 'gone')).toBeNull()
  })
})

// ── Ordering ────────────────────────────────────────────────────────────────

describe('buildMergePlan — ordering', () => {
  it('orders identity before structure before labels', () => {
    const menu = [
      n('root', '/u/', 'U', [
        cat('grp', 'Group', [n('kid', '/u/grp/kid/', 'Kid')]),
        n('lbl', '/u/lbl/', 'Long Name (LN)'),
      ]),
    ]
    const site = [
      n('s-root', '/u/', 'U', [
        n('s-grp', '/u/grp/', 'Group', [
          n('s-kid', '/u/grp/kid/', 'Kid'),
          n('s-new', '/u/grp/new/', 'New Page'),
        ]),
        n('s-lbl', '/u/lbl/', 'LN'),
      ]),
    ]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    const phases = plan.changes.map(c => c.phase)
    expect(phases).toEqual([...phases].sort((a, b) => {
      const rank = { identity: 0, structure: 1, labels: 2 } as const
      return rank[a] - rank[b]
    }))
  })

  it('puts a promotion before the page added underneath it', () => {
    const menu = [n('root', '/u/', 'U', [cat('grp', 'Group', [n('kid', '/u/grp/kid/', 'Kid')])])]
    const site = [
      n('s-root', '/u/', 'U', [
        n('s-grp', '/u/grp/', 'Group', [
          n('s-kid', '/u/grp/kid/', 'Kid'),
          n('s-new', '/u/grp/new/', 'New Page'),
        ]),
      ]),
    ]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    const promoteIdx = plan.changes.findIndex(c => c.kind === 'promote')
    const addIdx = plan.changes.findIndex(c => c.kind === 'add-subtree')
    expect(promoteIdx).toBeGreaterThanOrEqual(0)
    expect(addIdx).toBeGreaterThan(promoteIdx)
    const add = plan.changes[addIdx]
    expect(add.dependsOn).toContain(plan.changes[promoteIdx].id)
  })

  it('blocks a dependent change when its dependency is skipped', () => {
    const menu = [n('root', '/u/', 'U', [cat('grp', 'Group', [n('kid', '/u/grp/kid/', 'Kid')])])]
    const site = [
      n('s-root', '/u/', 'U', [
        n('s-grp', '/u/grp/', 'Group', [
          n('s-kid', '/u/grp/kid/', 'Kid'),
          n('s-new', '/u/grp/new/', 'New Page'),
        ]),
      ]),
    ]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    const promote = plan.changes.find(c => c.kind === 'promote')!
    const add = plan.changes.find(c => c.kind === 'add-subtree')!
    const result = applyPlan(menu, plan, { ...defaultDecisions(plan), [promote.id]: 'skip' }, {
      rootId: 'root',
    })
    expect(result.blocked.map(b => b.id)).toContain(add.id)
    expect(result.forest).toEqual(menu)
  })
})

// ── applyPlan invariants ────────────────────────────────────────────────────

describe('applyPlan — no orphans', () => {
  it('inserts a top-level page inside the picked root, not beside it', () => {
    // The forest is [root] and rootId is set, so anything appended to the
    // forest would be discarded by selectSubtree — invisible in the editor and
    // absent from the generated HTML.
    const menu = [n('root', '/usawc/', 'USAWC Home', [n('a', '/usawc/about/', 'About')])]
    const site = [n('s-root', '/usawc/', 'USAWC', [
      n('s-a', '/usawc/about/', 'About'),
      n('s-news', '/usawc/news/', 'News'),
    ])]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    const result = applyPlan(menu, plan, defaultDecisions(plan), { rootId: 'root', menuSiteUrl: '/' })
    expect(result.forest).toHaveLength(1)
    const visible = selectSubtree(result.forest, 'root')
    expect(nodeCount(visible)).toBe(3)
    expect(findNode(visible, 'root')!.children.map(c => c.label)).toEqual(['About', 'News'])
  })

  it('blocks rather than guesses when the target parent is missing', () => {
    const menu = [n('root', '/u/', 'U')]
    const site = [
      n('s-root', '/u/', 'U', [
        n('s-mid', '/u/mid/', 'Mid', [n('s-leaf', '/u/mid/leaf/', 'Leaf')]),
      ]),
    ]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    // Mid is added with Leaf absorbed, so nothing is orphaned here.
    const result = applyPlan(menu, plan, defaultDecisions(plan), { rootId: 'root' })
    expect(result.blocked).toEqual([])
    expect(nodeCount(selectSubtree(result.forest, 'root'))).toBe(3)
  })

  it('refuses a change that would put the same link in the menu twice', () => {
    // A hand-built plan that tries to add a page the menu already has.
    const menu = [n('root', '/u/', 'U', [n('dde', '/u/dde/', 'DDE')])]
    const site = [n('s-root', '/u/', 'U', [n('s-dde', '/u/dde/', 'DDE')])]
    const plan = buildMergePlan(menu, site, { rootId: 'root' })
    const forced: typeof plan = {
      ...plan,
      changes: [
        {
          id: 'add:forced',
          kind: 'add-subtree',
          phase: 'structure',
          title: 'Add DDE again',
          detail: '',
          dependsOn: [],
          defaultOptionId: 'accept',
          options: [{ id: 'accept', label: 'Accept', description: '' }],
          absorbedCount: 1,
          siteNode: n('s-dupe', '/u/dde/', 'DDE'),
          parentMenuNodeId: 'root',
          parentLabel: 'U',
          descendantCount: 0,
          siteSiblingHrefs: [],
          siteSiblingIndex: 0,
        },
      ],
    }
    const result = applyPlan(menu, forced, defaultDecisions(forced), { rootId: 'root' })
    expect(result.applied).toEqual([])
    expect(result.blocked).toHaveLength(1)
    expect(result.blocked[0].reason).toMatch(/same link in the menu twice/)
    expect(findDuplicateLinks(result.forest)).toEqual([])
  })

  it('refuses to move a page inside itself', () => {
    const menu = [n('root', '/u/', 'U', [n('a', '/u/a/', 'A', [n('b', '/u/a/b/', 'B')])])]
    const plan = {
      changes: [
        {
          id: 'move:a',
          kind: 'move' as const,
          phase: 'structure' as const,
          title: 'Move A',
          detail: '',
          dependsOn: [],
          defaultOptionId: 'accept',
          options: [{ id: 'accept', label: 'Accept', description: '' }],
          absorbedCount: 1,
          menuNode: findNode(menu, 'a')!,
          toMenuParentId: 'b',
          toMenuParentLabel: 'B',
        },
      ],
      suppressed: { moveArtifacts: 0, duplicateLinks: 0, absorbedAdds: 0, autoHomeRelabels: 0 },
    }
    const result = applyPlan(menu, plan, defaultDecisions(plan), { rootId: 'root' })
    expect(result.blocked).toHaveLength(1)
    expect(result.forest).toEqual(menu)
  })
})

// ── Golden test on the real example ─────────────────────────────────────────

const MENU_FIXTURE = 'example/old menu.html'
const SITE_FIXTURE = 'example/site index.html'
const haveFixtures = existsSync(MENU_FIXTURE) && existsSync(SITE_FIXTURE)

// Reproduces exactly what App.tsx does between the two pastes and the plan.
function pipeline() {
  const menuParse = parseSitemapHtml(readFileSync(MENU_FIXTURE, 'utf8'))
  const siteParse = parseSitemapHtml(readFileSync(SITE_FIXTURE, 'utf8'))

  let menuForest = applySiteUrl(menuParse.forest, detectSiteUrls(menuParse.forest)[0] ?? '')
  let rootId: string | null = null
  if (menuParse.isAuSidenavOutput) {
    const sibling = detectSiblingModeRoot(menuForest)
    if (sibling) {
      const root = menuForest[sibling.rootIndex]
      const rest = menuForest.filter((_, i) => i !== sibling.rootIndex)
      menuForest = [{ ...root, children: rest }]
      rootId = root.id
    }
  }
  const siteForest = applySiteUrl(siteParse.forest, detectSiteUrls(siteParse.forest)[0] ?? '')
  const scope = detectMenuScope(menuForest)
  const scoped = filterSiteIndexByScope(siteForest, scope, menuForest)
  return { menuForest, scoped, rootId, plan: buildMergePlan(menuForest, scoped, { rootId }) }
}

describe.skipIf(!haveFixtures)('golden: USAWC menu vs a fresh site index', () => {
  it('collapses 70 raw diff entries into 9 structural decisions', () => {
    const { plan } = pipeline()
    const identity = plan.changes.filter(c => c.phase === 'identity')
    const structure = plan.changes.filter(c => c.phase === 'structure')
    const labels = plan.changes.filter(c => c.phase === 'labels')

    expect(identity).toHaveLength(6)
    expect(structure).toHaveLength(3)
    expect(identity.length + structure.length).toBe(9)
    expect(labels).toHaveLength(11)

    // Every "move" in the raw diff was an artifact of Carlisle Experience
    // having had no URL, or of the DDE shortcut mismatch.
    expect(byKind(plan.changes, 'move')).toHaveLength(0)
    expect(byKind(plan.changes, 'remove')).toHaveLength(0)
    expect(plan.suppressed.moveArtifacts).toBe(37)
    expect(plan.suppressed.duplicateLinks).toBe(1)
    expect(plan.suppressed.autoHomeRelabels).toBe(1)
  })

  it('promotes Carlisle Experience with no follow-up work', () => {
    const { plan } = pipeline()
    const promotes = byKind(plan.changes, 'promote')
    expect(promotes).toHaveLength(1)
    const p = promotes[0]
    expect(p.kind === 'promote' && p.menuNode.label).toBe('Carlisle Experience')
    expect(p.kind === 'promote' && p.newHref).toMatch(/\/USAWC\/Carlisle-Experience\/$/)
    // Its real children are identical in both files, so nothing is added under it.
    const addsUnderCarlisle = byKind(plan.changes, 'add-subtree').filter(
      c => c.kind === 'add-subtree' && c.parentLabel === 'Carlisle Experience',
    )
    expect(addsUnderCarlisle).toHaveLength(0)
  })

  it('pairs all five slug renames instead of listing 5 removes and 5 adds', () => {
    const { plan } = pipeline()
    const renames = byKind(plan.changes, 'url-rename')
    expect(renames).toHaveLength(5)
    const pairs = renames.map(c =>
      c.kind === 'url-rename' ? `${c.menuNode.label} → ${c.siteNode.label}` : '',
    )
    expect(pairs.sort()).toEqual([
      'Emerging Tech → Emerging Technology',
      'Mideast → Middle East',
      'Shadows and Steel 2045 → Shadows and Steel',
      'Strategic Competition → Strategic Competition Center',
      'Wargame Designer Course (WDC) → WDC',
    ])
    const confidence = new Map(
      renames.map(c => [
        c.kind === 'url-rename' ? c.menuNode.label : '',
        c.kind === 'url-rename' ? c.confidence : '',
      ]),
    )
    expect(confidence.get('Mideast')).toBe('medium')
    expect(confidence.get('Emerging Tech')).toBe('high')
    expect(confidence.get('Wargame Designer Course (WDC)')).toBe('high')
  })

  it('adds exactly the three genuinely new branches', () => {
    const { plan } = pipeline()
    const adds = byKind(plan.changes, 'add-subtree')
    const summary = adds
      .map(c => (c.kind === 'add-subtree' ? `${c.siteNode.label}+${c.descendantCount}` : ''))
      .sort()
    expect(summary).toEqual(['National Security Seminar+4', 'News+0', 'PACOM+1'])
  })

  it('keeps every canonical label and never offers the "USAWC Home" non-rename', () => {
    const { plan } = pipeline()
    const labels = byKind(plan.changes, 'relabel')
    expect(labels.every(c => c.defaultOptionId === 'keep')).toBe(true)
    expect(labels.some(c => c.kind === 'relabel' && c.menuNode.label === 'USAWC Home')).toBe(false)
    const expanding = labels.filter(c => c.kind === 'relabel' && c.menuLabelExpandsSite)
    expect(expanding.length).toBeGreaterThanOrEqual(9)
  })

  it('applies cleanly: DDE survives intact and no page is lost', () => {
    const { menuForest, rootId, plan } = pipeline()
    const before = selectSubtree(menuForest, rootId!)
    const result = applyPlan(menuForest, plan, defaultDecisions(plan), {
      rootId,
      menuSiteUrl: '/',
    })
    expect(result.blocked).toEqual([])

    const after = selectSubtree(result.forest, rootId!)
    // The regression that motivated this rework: accepting the old diff's
    // bogus DDE move deleted the Department of Distance Education branch.
    const dde = findNodeByLabel(after, 'Department of Distance Education (DDE)')
    expect(dde).not.toBeNull()
    expect(dde!.href).toBe('/USAWC/DDE/')
    const childLabels = dde!.children.map(c => c.label)
    expect(childLabels).toContain('Faculty and Staff')
    expect(childLabels).toContain('Distance Education Program')
    expect(childLabels).toContain('Defense Strategy Online')
    expect(childLabels).toContain('Tech Support')
    expect(childLabels).toContain('National Security Seminar')

    // Carlisle Experience is a real page now, with its original subtree.
    const carlisle = findNodeByLabel(after, 'Carlisle Experience')!
    expect(carlisle.href).toBe('/USAWC/Carlisle-Experience/')
    expect(carlisle.children).toHaveLength(5)

    // Renamed pages moved to their new address but kept the menu's name, which
    // is the whole point of the keep-my-label default.
    expect(findNodeByHref(after, '/USAWC/CSL/SRAD/Global/Mideast/')).toBeNull()
    const middleEast = findNodeByHref(after, '/USAWC/CSL/SRAD/Global/Middle-East/')
    expect(middleEast).not.toBeNull()
    expect(middleEast!.label).toBe('Mideast')

    // Nothing vanished. Exactly 8 nodes arrive — News (1), PACOM plus its
    // child (2), National Security Seminar plus its four (5). The five renamed
    // pages are re-used in place rather than removed and re-added.
    expect(nodeCount(before)).toBe(174)
    expect(nodeCount(after)).toBe(182)
    // And the result is free of the collision that breaks "you are here".
    expect(findDuplicateLinks(after).filter(g => g.severity === 'error')).toEqual([])
  })

  it('round-trips through the generator without structural loss', () => {
    const { menuForest, rootId, plan } = pipeline()
    const result = applyPlan(menuForest, plan, defaultDecisions(plan), {
      rootId,
      menuSiteUrl: '/',
    })
    const html = generateSidenavHtml(selectSubtree(result.forest, rootId!), { rootMode: 'sibling' })
    const reparsed = parseSitemapHtml(html)
    expect(reparsed.forest.length).toBeGreaterThan(0)
    expect(reparsed.pageCount).toBeGreaterThan(150)
  })
})

function findNodeByLabel(roots: SitemapNode[], label: string): SitemapNode | null {
  for (const r of roots) {
    if (r.label === label) return r
    const hit = findNodeByLabel(r.children, label)
    if (hit) return hit
  }
  return null
}

function findNodeByHref(roots: SitemapNode[], href: string): SitemapNode | null {
  for (const r of roots) {
    if (r.href === href) return r
    const hit = findNodeByHref(r.children, href)
    if (hit) return hit
  }
  return null
}
