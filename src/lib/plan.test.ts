// Node globals are not part of the app's lib set (it targets the browser), and
// TS 6 no longer auto-includes @types/node. This is the only file that touches
// the filesystem — it reads the checked-in golden fixtures under __fixtures__,
// and, when they happen to be present, the working pastes in example/.
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

// ── Rule A2 ─────────────────────────────────────────────────────────────────

// A page whose NAME and SLOT are unchanged but whose address moved. diffForests
// pairs these via its label fallback and emits no entry at all — the href
// difference lives only on DiffResult.matched. These used to vanish from the
// review entirely, leaving a dead link in the merged menu.
describe('buildMergePlan — a matched page at a new address', () => {
  // The real shape this was found with: menu "Parameters" sits directly under
  // SRAD but its href still carries the old /Research-and-Commentary/ level.
  const parametersMenu = () => [
    n('srad', '/csl/srad/', 'SRAD', [
      n('rc', '/csl/srad/research-and-commentary/', 'Research and Commentary'),
      n('param', '/csl/srad/research-and-commentary/parameters/', 'Parameters'),
    ]),
  ]
  const parametersSite = () => [
    n('s-srad', '/csl/srad/', 'SRAD', [
      n('s-rc', '/csl/srad/research-and-commentary/', 'Research and Commentary'),
      n('s-param', '/csl/srad/parameters/', 'Parameters'),
    ]),
  ]

  it('emits a url-rename when a label-matched pair has different hrefs', () => {
    const plan = buildMergePlan(parametersMenu(), parametersSite())
    const renames = byKind(plan.changes, 'url-rename')
    expect(renames).toHaveLength(1)
    const r = renames[0]
    expect(r.kind === 'url-rename' && r.menuNode.id).toBe('param')
    expect(r.kind === 'url-rename' && r.newHref).toBe('/csl/srad/parameters/')
    expect(r.phase).toBe('identity')
    // Nothing spurious alongside it.
    expect(byKind(plan.changes, 'remove')).toHaveLength(0)
    expect(byKind(plan.changes, 'add-subtree')).toHaveLength(0)
    expect(byKind(plan.changes, 'move')).toHaveLength(0)
  })

  it('rates an unchanged tree position as high confidence', () => {
    const plan = buildMergePlan(parametersMenu(), parametersSite())
    const r = byKind(plan.changes, 'url-rename')[0]
    expect(r.kind === 'url-rename' && r.confidence).toBe('high')
  })

  it('rates a page that also moved as medium, and still reports the move', () => {
    const menu = [
      n('root', '/hq/', 'HQ', [
        n('a', '/hq/research/', 'Research', [n('polar', '/hq/research/polar/', 'Polar')]),
        n('b', '/hq/library/', 'Library'),
      ]),
    ]
    const site = [
      n('s-root', '/hq/', 'HQ', [
        n('s-a', '/hq/research/', 'Research'),
        n('s-b', '/hq/library/', 'Library', [n('s-polar', '/hq/library/polar/', 'Polar')]),
      ]),
    ]
    const plan = buildMergePlan(menu, site)
    const r = byKind(plan.changes, 'url-rename')[0]
    expect(r.kind === 'url-rename' && r.confidence).toBe('medium')
    // The two changes are complementary, not duplicates: identity fixes the
    // address, structure re-parents.
    const moves = byKind(plan.changes, 'move')
    expect(moves).toHaveLength(1)
    expect(moves[0].kind === 'move' && moves[0].menuNode.id).toBe('polar')
  })

  it('offers a plain accept when the labels are identical', () => {
    const plan = buildMergePlan(parametersMenu(), parametersSite())
    const r = byKind(plan.changes, 'url-rename')[0]
    // "keep my label" vs "take theirs" is a distinction without a difference
    // when the labels match, so it is not offered.
    expect(r.defaultOptionId).toBe('accept')
    expect(r.options.map(o => o.id)).toEqual(['accept', 'split', 'skip'])
    expect(r.title).toBe('Parameters has a new address')
  })

  it('adopts the new URL by default and keeps children, order and include state', () => {
    const menu = [
      n('srad', '/csl/srad/', 'SRAD', [
        n('rc', '/csl/srad/research-and-commentary/', 'Research and Commentary'),
        {
          ...n('param', '/csl/srad/research-and-commentary/parameters/', 'Parameters', [
            n('kid', '/csl/srad/research-and-commentary/parameters/archive/', 'Archive'),
          ]),
          included: false,
        },
      ]),
    ]
    const plan = buildMergePlan(menu, parametersSite())
    const result = applyPlan(menu, plan, defaultDecisions(plan))
    const node = findNode(result.forest, 'param')!
    expect(node.href).toBe('/csl/srad/parameters/')
    expect(node.label).toBe('Parameters')
    expect(node.included).toBe(false)
    expect(node.children.map(c => c.id)).toEqual(['kid'])
    // Still the second child of SRAD — the node was never removed.
    expect(findNode(result.forest, 'srad')!.children.map(c => c.id)).toEqual(['rc', 'param'])
  })

  it('splits into a removal plus an addition in the same slot on request', () => {
    const menu = parametersMenu()
    const plan = buildMergePlan(menu, parametersSite())
    const r = byKind(plan.changes, 'url-rename')[0]
    const result = applyPlan(menu, plan, { [r.id]: 'split' })
    expect(findNode(result.forest, 'param')).toBeNull()
    const kids = findNode(result.forest, 'srad')!.children
    expect(kids).toHaveLength(2)
    expect(kids[1].label).toBe('Parameters')
    expect(kids[1].href).toBe('/csl/srad/parameters/')
    expect(kids[1].id).not.toBe('param')
  })

  it('emits nothing when the hrefs already agree', () => {
    const menu = [n('srad', '/csl/srad/', 'SRAD', [n('param', '/csl/srad/parameters/', 'Parameters')])]
    const site = [n('s', '/csl/srad/', 'SRAD', [n('sp', '/csl/srad/parameters/', 'Parameters')])]
    const plan = buildMergePlan(menu, site)
    expect(byKind(plan.changes, 'url-rename')).toHaveLength(0)
    expect(plan.changes).toHaveLength(0)
  })

  it('keeps an external page absolute and flagged when its address changes', () => {
    const menu = [
      n('root', '/hq/', 'HQ', [ext('press', 'https://press.example.mil/old/', 'Press')]),
    ]
    const site = [
      n('s-root', '/hq/', 'HQ', [ext('s-press', 'https://press.example.mil/new/', 'Press')]),
    ]
    const plan = buildMergePlan(menu, site)
    expect(byKind(plan.changes, 'url-rename')).toHaveLength(1)
    // menuSiteUrl '/' means the menu uses root-relative hrefs. rebaseHref would
    // strip the host off an off-site URL and leave a broken '/new/' link.
    const result = applyPlan(menu, plan, defaultDecisions(plan), { menuSiteUrl: '/' })
    const node = findNode(result.forest, 'press')!
    expect(node.href).toBe('https://press.example.mil/new/')
    expect(node.external).toBe(true)
  })

  it('still resolves a child added under the renamed page', () => {
    // The real knock-on: site PACOM gained an "Affiliates" child while its own
    // address moved. The add must land under the existing menu node.
    const menu = [
      n('srad', '/csl/srad/', 'SRAD', [
        n('global', '/csl/srad/global/', 'Global', [
          n('pacom', '/csl/srad/research-and-commentary/pacom/', 'PACOM'),
        ]),
      ]),
    ]
    const site = [
      n('s-srad', '/csl/srad/', 'SRAD', [
        n('s-global', '/csl/srad/global/', 'Global', [
          n('s-pacom', '/csl/srad/global/pacom/', 'PACOM', [
            n('s-aff', '/csl/srad/global/pacom/affiliates/', 'Affiliates'),
          ]),
        ]),
      ]),
    ]
    const plan = buildMergePlan(menu, site)
    const add = byKind(plan.changes, 'add-subtree')[0]
    expect(add.kind === 'add-subtree' && add.parentMenuNodeId).toBe('pacom')
    expect(add.blockedReason).toBeUndefined()
    // The add is deliberately NOT gated on the rename: the parent node exists
    // either way, so skipping the URL fix must not block adding the child.
    expect(add.dependsOn).toEqual([])

    const result = applyPlan(menu, plan, defaultDecisions(plan))
    expect(result.blocked).toEqual([])
    const pacom = findNode(result.forest, 'pacom')!
    expect(pacom.href).toBe('/csl/srad/global/pacom/')
    expect(pacom.children.map(c => c.label)).toEqual(['Affiliates'])
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

// ── Golden test ─────────────────────────────────────────────────────────────

// Reproduces exactly what App.tsx does between the two pastes and the plan.
// Paths are relative to the project root, which is where vitest runs.
function pipeline(menuPath: string, sitePath: string) {
  const menuParse = parseSitemapHtml(readFileSync(menuPath, 'utf8'))
  const siteParse = parseSitemapHtml(readFileSync(sitePath, 'utf8'))

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

// A hand-authored pair, checked in so this actually runs in CI. Every node in
// it exists to exercise one rule — see the comments in the fixtures themselves.
//
// Covered here (end-to-end, through the parser and scope detection):
//   sibling-mode rooting + " Home" suffix suppression
//   promote, and the descendant "moves" it makes evaporate
//   an add that depends on that promote
//   url-rename from a remove + add pair          (high and medium confidence)
//   url-rename from a LABEL match — Rule A2      (high and medium confidence)
//   add-subtree with descendants folded in
//   a duplicate link in the index, suppressed
//   an href-less menu group with no site counterpart, NOT read as a move
//   a removal, never staged by default
//   relabel, both the acronym-expanding and the plain kind
//   an external link surviving intact
//   a site branch outside the menu's scope, dropped entirely
//
// Deliberately NOT here, because a focused unit test says it better:
// the no-orphan insert, the duplicate-link refusal, the blocked-parent add,
// and the unique-residual rename pairing.
const GOLDEN_MENU = 'src/lib/__fixtures__/golden-menu.html'
const GOLDEN_SITE = 'src/lib/__fixtures__/golden-site-index.html'
const golden = () => pipeline(GOLDEN_MENU, GOLDEN_SITE)

describe('golden: a customized menu vs a fresh site index', () => {
  it('consolidates the raw diff into twelve decisions', () => {
    const { plan } = golden()
    expect(plan.changes.filter(c => c.phase === 'identity')).toHaveLength(5)
    expect(plan.changes.filter(c => c.phase === 'structure')).toHaveLength(5)
    expect(plan.changes.filter(c => c.phase === 'labels')).toHaveLength(2)

    expect(plan.suppressed).toEqual({
      // Alpha and Bravo only looked "moved" because Programs had no URL.
      moveArtifacts: 2,
      // The index links /HQ/News/ twice.
      duplicateLinks: 1,
      // Maps and Rare Books ride along with Special Collections.
      absorbedAdds: 2,
      // "HQ Home" vs the index's "HQ" is this tool's own suffix.
      autoHomeRelabels: 1,
    })
  })

  it('promotes the href-less group instead of adding a second copy', () => {
    const { plan } = golden()
    const promotes = byKind(plan.changes, 'promote')
    expect(promotes).toHaveLength(1)
    expect(promotes[0].kind === 'promote' && promotes[0].menuNode.label).toBe('Programs')
    expect(promotes[0].kind === 'promote' && promotes[0].newHref).toBe(
      'https://example.mil/HQ/Programs/',
    )
    // And the page the index added under it waits on that decision.
    const charlie = byKind(plan.changes, 'add-subtree').find(
      c => c.kind === 'add-subtree' && c.siteNode.label === 'Charlie',
    )!
    expect(charlie.dependsOn).toEqual([promotes[0].id])
  })

  it('reports every URL change, whether or not the page was also renamed', () => {
    const { plan } = golden()
    const renames = byKind(plan.changes, 'url-rename')
    const summary = renames
      .map(c =>
        c.kind === 'url-rename'
          ? `${c.menuNode.label}|${c.confidence}|${c.newHref.replace('https://example.mil', '')}`
          : '',
      )
      .sort()
    expect(summary).toEqual([
      // Paired from a leftover remove + add (Rule B).
      'Emerging Tech|high|/HQ/Research/Emerging-Technology/',
      'Mideast|medium|/HQ/Research/Middle-East/',
      // Matched by label, so the raw diff emitted no entry at all (Rule A2).
      // These are the ones that used to disappear from the review.
      'Parameters|high|/HQ/Research/Parameters/',
      'Polar|medium|/HQ/Library/Polar/',
    ])
  })

  it('offers no label choice on a rename where the label did not change', () => {
    const { plan } = golden()
    const byLabel = new Map(
      byKind(plan.changes, 'url-rename').map(c => [c.kind === 'url-rename' ? c.menuNode.label : '', c]),
    )
    // Same name on both sides — "keep mine" and "take theirs" are the same act.
    expect(byLabel.get('Parameters')!.options.map(o => o.id)).toEqual(['accept', 'split', 'skip'])
    expect(byLabel.get('Parameters')!.title).toBe('Parameters has a new address')
    // Genuinely renamed, so the choice is real and defaults to the menu's name.
    expect(byLabel.get('Mideast')!.options.map(o => o.id)).toEqual([
      'keep-label',
      'take-label',
      'split',
      'skip',
    ])
    expect(byLabel.get('Mideast')!.defaultOptionId).toBe('keep-label')
  })

  it('separates a page that moved from a page that merely changed address', () => {
    const { plan } = golden()
    const moves = byKind(plan.changes, 'move')
    // Polar changed BOTH: identity fixes the address, structure re-parents it.
    expect(moves).toHaveLength(1)
    expect(moves[0].kind === 'move' && moves[0].menuNode.label).toBe('Polar')
    expect(moves[0].kind === 'move' && moves[0].toMenuParentLabel).toBe('Library')
    // Students and Alumni sit under an href-less "Audiences" heading in the
    // menu and directly under HQ in the index. That is not a move.
    expect(moves.some(c => c.kind === 'move' && c.menuNode.label === 'Students')).toBe(false)
  })

  it('adds only the genuinely new branches, never a second link to a known page', () => {
    const { plan } = golden()
    const summary = byKind(plan.changes, 'add-subtree')
      .map(c => (c.kind === 'add-subtree' ? `${c.siteNode.label}+${c.descendantCount}` : ''))
      .sort()
    expect(summary).toEqual(['Charlie+0', 'Directory+0', 'Special Collections+2'])
    // The index's second /HQ/News/ link never becomes an add, and the whole
    // out-of-scope "Other Division" branch is filtered out before diffing.
    expect(summary.some(s => s.startsWith('News'))).toBe(false)
    expect(summary.some(s => s.startsWith('Staff') || s.startsWith('Contact'))).toBe(false)
  })

  it('never stages a removal, and keeps the menu label on every relabel', () => {
    const { plan } = golden()
    const removes = byKind(plan.changes, 'remove')
    expect(removes).toHaveLength(1)
    expect(removes[0].kind === 'remove' && removes[0].menuNode.label).toBe('Legacy Report Archive')
    expect(removes[0].defaultOptionId).toBe('skip')

    const labels = byKind(plan.changes, 'relabel')
    expect(labels.every(c => c.defaultOptionId === 'keep')).toBe(true)
    const expanding = new Map(
      labels.map(c => [
        c.kind === 'relabel' ? c.menuNode.label : '',
        c.kind === 'relabel' ? c.menuLabelExpandsSite : false,
      ]),
    )
    expect(expanding.get('Research and Analysis Directorate (RAD)')).toBe(true)
    expect(expanding.get('Journals')).toBe(false)
    // "HQ Home" → "HQ" is the tool's own suffix and must never be offered.
    expect(labels.some(c => c.kind === 'relabel' && c.menuNode.label === 'HQ Home')).toBe(false)
  })

  it('applies the defaults cleanly and loses nothing', () => {
    const { menuForest, rootId, plan } = golden()
    const before = selectSubtree(menuForest, rootId!)
    const result = applyPlan(menuForest, plan, defaultDecisions(plan), {
      rootId,
      menuSiteUrl: '/',
    })
    expect(result.blocked).toEqual([])
    const after = selectSubtree(result.forest, rootId!)

    // The four URL changes landed, rebased to the menu's root-relative form,
    // and every page kept the name the user gave it.
    const parameters = findNodeByLabel(after, 'Parameters')!
    expect(parameters.href).toBe('/HQ/Research/Parameters/')
    expect(findNodeByHref(after, '/HQ/Research/Reports/Parameters/')).toBeNull()
    expect(findNodeByLabel(after, 'Mideast')!.href).toBe('/HQ/Research/Middle-East/')
    expect(findNodeByLabel(after, 'Emerging Tech')!.href).toBe(
      '/HQ/Research/Emerging-Technology/',
    )

    // Polar took both changes: new address AND a new parent.
    const library = findNodeByLabel(after, 'Library')!
    const polar = library.children.find(c => c.label === 'Polar')!
    expect(polar.href).toBe('/HQ/Library/Polar/')

    // Promote kept the heading's own children rather than replacing them.
    const programs = findNodeByLabel(after, 'Programs')!
    expect(programs.href).toBe('/HQ/Programs/')
    expect(programs.children.map(c => c.label)).toEqual(['Alpha', 'Bravo', 'Charlie'])

    // The off-site link keeps its host — rebasing would have broken it.
    const partner = findNodeByLabel(after, 'Partner Site')!
    expect(partner.href).toBe('https://partner.example.org/')
    expect(partner.external).toBe(true)

    // Nothing was dropped, and the removal was not staged. Exactly five nodes
    // arrive: Charlie, Directory, Special Collections and its two children.
    // Polar was re-used in place, not removed and re-added.
    expect(findNodeByLabel(after, 'Legacy Report Archive')).not.toBeNull()
    expect(nodeCount(before)).toBe(18)
    expect(nodeCount(after)).toBe(23)

    // And the result cannot break "you are here".
    expect(findDuplicateLinks(after).filter(g => g.severity === 'error')).toEqual([])
  })

  it('round-trips through the generator without structural loss', () => {
    const { menuForest, rootId, plan } = golden()
    const result = applyPlan(menuForest, plan, defaultDecisions(plan), {
      rootId,
      menuSiteUrl: '/',
    })
    const applied = selectSubtree(result.forest, rootId!)
    const html = generateSidenavHtml(applied, { rootMode: 'sibling' })
    const reparsed = parseSitemapHtml(html)
    expect(reparsed.pageCount).toBe(nodeCount(applied))
  })
})

// ── Invariant smoke test over whatever is in example/ ───────────────────────

// example/ holds real pastes the maintainer is working with, not engineered
// fixtures — its contents change without notice, so asserting on counts or
// labels here would only produce false failures. What IS worth checking is
// that applyPlan's invariants survive contact with real-world markup.
const REAL_MENU = 'example/old menu.html'
const REAL_SITE = 'example/site index.html'
const haveRealFixtures = existsSync(REAL_MENU) && existsSync(REAL_SITE)

describe.skipIf(!haveRealFixtures)('invariants against the working example files', () => {
  it('builds and applies a plan without losing a node or duplicating a link', () => {
    const { menuForest, rootId, plan } = pipeline(REAL_MENU, REAL_SITE)
    expect(plan.changes.length).toBeGreaterThan(0)

    const before = selectSubtree(menuForest, rootId!)
    const errorsBefore = findDuplicateLinks(before).filter(g => g.severity === 'error').length

    // applyPlan throws if a node vanishes that no accepted change removed.
    const result = applyPlan(menuForest, plan, defaultDecisions(plan), {
      rootId,
      menuSiteUrl: '/',
    })
    const after = selectSubtree(result.forest, rootId!)

    // No removal is staged by default, so nothing may shrink.
    expect(nodeCount(after)).toBeGreaterThanOrEqual(nodeCount(before))
    expect(findDuplicateLinks(after).filter(g => g.severity === 'error').length).toBeLessThanOrEqual(
      errorsBefore,
    )
    // Whatever the plan refused, it refused with a reason rather than guessing.
    for (const b of result.blocked) expect(b.reason).toBeTruthy()
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
