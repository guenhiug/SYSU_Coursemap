// 课程路线图 v5 · dagre 分层布局 + 学期色带 + coreq 同列（纯函数，无 DOM 依赖；浏览器与 Node 共用）。
//
// 版面引擎换成 @dagrejs/dagre（Sugiyama：rank 分配 + dummy 节点 + 交叉最小化）：
//   - 节点 = unit（同修组；coreq 并查集收缩后同列纵向堆叠）；
//   - 边 = unit 之间的 prereq（组内 coreq 不进 dagre，只画虚线配套连接器）；
//   - dagre 只提供「列（rank）+ 列内顺序（order）」，走线由本模块自己画正交折线。
//
// 坐标与走线（全部为纯计算，不读 DOM）：
//   - 列 = rank 归一化后的序号；列内 unit 自上而下堆叠，列整体垂直居中；
//   - 每张卡片左上角有学期标签，左侧有学期色条，画布上方由 RouteMap 画学期色带轴；
//   - 走线是正交折线：竖直段只出现在「列间空隙」（lane 分配避免重叠），
//     水平段只保留「卡片边 → 通道」的短 stub；跨多列的长边在中间列的空隙高度上横穿，
//     因此任何线段（端点除外）都不会落进卡片矩形。
//   - 同列（环内 / 反向边）→ 从该列右侧空隙绕行，箭头指向左。
//   - 端口扇出：同一卡片同一侧的多条边在卡片高度内 ±portGap 均匀铺开。
//
// 确定性：unit / 边按稳定键排序后喂给 dagre，同输入逐字段一致。

import dagre from '@dagrejs/dagre'
import {
  DEFAULT_MODULE_ORDER,
  compareCourseNodes,
  edgeKey,
  gradeLabel,
  semesterLabelOf,
  sortSemesterKeys,
} from '../lib/course-graph.js'
import { parseSemesterKey } from '../lib/normalize.js'

export const ROUTE_GEOMETRY = {
  card: { w: 180, h: 58 },
  nodeGapY: 8,
  rankSep: 84,
  laneGap: 6,
  lanePad: 12,
  portGap: 8,
  portPad: 9,
  cardPad: 3,
  corner: 5,
  margin: 20,
}

// 未标注模块的兜底名
export const DEFAULT_MODULE = '未分模块'

const round = (n) => Math.round(n * 100) / 100
const EPS = 1e-6

const moduleKeyOf = (node) => node?.module || DEFAULT_MODULE

// 学期色带：8 档固定色，超出按 HSL 轮转扩展。
const SEMESTER_COLORS = [
  '#d9534f',
  '#e08a37',
  '#c9b037',
  '#6aa84f',
  '#3fa39b',
  '#4a80c4',
  '#7a63c0',
  '#b9629b',
]

function semesterColorAt(index) {
  if (index < SEMESTER_COLORS.length) return SEMESTER_COLORS[index]
  const hue = (index * 47) % 360
  return `hsl(${hue} 52% 56%)`
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function makeUnionFind(ids) {
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (x) => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  return { find, union }
}

// 模块显示顺序 = route.columns（缺省 DEFAULT_MODULE_ORDER）里出现过的优先，其余按首现顺序。
function moduleOrderOf(courseNodes, route) {
  const present = []
  for (const node of courseNodes) {
    const module = moduleKeyOf(node)
    if (!present.includes(module)) present.push(module)
  }
  const preferred = (route.columns ?? DEFAULT_MODULE_ORDER).filter((module) => present.includes(module))
  return [...new Set([...preferred, ...present])]
}

// 学期 key → 年级。优先用节点上已算好的 grade（与卡片角标一致），否则按最早年份兜底。
function gradeMapOf(courseNodes, keys) {
  const out = new Map()
  const years = keys.map((key) => parseSemesterKey(key)?.year).filter((y) => y != null)
  const startYear = years.length ? Math.min(...years) : null
  for (const node of courseNodes) {
    const sems = sortSemesterKeys(node?.semesters ?? [])
    if (!sems.length) continue
    const base = parseSemesterKey(sems[0])
    for (const key of keys) {
      if (out.has(key)) continue
      const parsed = parseSemesterKey(key)
      if (!parsed) continue
      if (node?.grade != null && base) out.set(key, node.grade + (parsed.year - base.year))
      else if (startYear != null) out.set(key, parsed.year - startYear + 1)
    }
  }
  if (startYear != null) {
    for (const key of keys) {
      if (out.has(key)) continue
      const parsed = parseSemesterKey(key)
      if (parsed) out.set(key, parsed.year - startYear + 1)
    }
  }
  return out
}

function semesterLabelForKey(key, grade) {
  const parsed = parseSemesterKey(key)
  if (!parsed) return String(key)
  const prefix = grade == null ? '' : gradeLabel(grade)
  return `${prefix}${parsed.num === 1 ? '上' : '下'}`
}

function makeSemesterApi({ nodeById, keys, indexOfKey, gradeByKey }) {
  const firstSemesterOf = (id) => sortSemesterKeys(nodeById.get(id)?.semesters ?? [])[0] ?? null
  return {
    keys: [...keys],
    labelOf: (id) => semesterLabelOf(nodeById.get(id)),
    colorOf: (id) => {
      const first = firstSemesterOf(id)
      const index = first == null ? -1 : indexOfKey.get(first) ?? -1
      return index < 0 ? '' : semesterColorAt(index)
    },
    indexOf: (id) => {
      const first = firstSemesterOf(id)
      return first == null ? -1 : indexOfKey.get(first) ?? -1
    },
    ruler: keys.map((key, index) => ({
      key,
      label: semesterLabelForKey(key, gradeByKey.get(key)),
      color: semesterColorAt(index),
    })),
  }
}

// ---------------------------------------------------------------------------
// coreq 收缩：并查集 → unit（同列纵向堆叠）
// ---------------------------------------------------------------------------

function buildUnits(courseNodes, coreqEdges) {
  const ids = courseNodes.map((node) => node.id)
  const byId = new Map(courseNodes.map((node) => [node.id, node]))
  const uf = makeUnionFind(ids)
  for (const edge of coreqEdges) uf.union(edge.from, edge.to)

  const byRoot = new Map()
  for (const id of ids) {
    const root = uf.find(id)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root).push(id)
  }

  const unitMembers = new Map()
  const unitOf = new Map()
  for (const members of byRoot.values()) {
    const sorted = [...members].sort(
      (a, b) => compareCourseNodes(byId.get(a), byId.get(b)) || String(a).localeCompare(String(b)),
    )
    const unitId = sorted.join('\u0001')
    unitMembers.set(unitId, sorted)
    for (const id of sorted) unitOf.set(id, unitId)
  }
  return { unitMembers, unitOf }
}

// ---------------------------------------------------------------------------
// dagre：unit → rank（列）+ order（列内顺序）
// ---------------------------------------------------------------------------

function dagreRanks(unitIds, unitMembers, prereqEdges, unitOf, { rankMode = 'dependency', unitSemesterIndex = null, semesterCount = 0 } = {}) {
  const card = ROUTE_GEOMETRY.card
  const unitHeight = (unitId) => {
    const n = unitMembers.get(unitId).length
    return n * card.h + Math.max(0, n - 1) * ROUTE_GEOMETRY.nodeGapY
  }

  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({
    rankdir: 'LR',
    ranker: 'network-simplex',
    nodesep: 16,
    ranksep: ROUTE_GEOMETRY.rankSep,
    edgesep: 12,
    marginx: 0,
    marginy: 0,
  })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const unitId of unitIds) graph.setNode(unitId, { width: card.w, height: unitHeight(unitId) })

  const pairSet = new Set()
  for (const edge of prereqEdges) {
    const a = unitOf.get(edge.from)
    const b = unitOf.get(edge.to)
    if (!a || !b || a === b) continue
    pairSet.add(`${a}\u0000${b}`)
  }
  const pairList = [...pairSet]
    .map((pair) => {
      const at = pair.indexOf('\u0000')
      return [pair.slice(0, at), pair.slice(at + 1)]
    })
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  pairList.forEach(([a, b], index) => {
    graph.setEdge(a, b, {}, `e${index}`)
  })

  if (unitIds.length) dagre.layout(graph)

  const rankByUnit = new Map(unitIds.map((unitId) => [unitId, graph.node(unitId)?.rank ?? 0]))

  // 列分配：
  //   dependency（默认）：rank = min(dagre rank, 源出发最长路径深度)。两者都沿合法边严格递增，
  //     逐点取小仍严格递增；同时把所有源节点（含平台课链起始）拉到第 0 列。
  //   semester：列 = 节点首学期在 sortedKeys 中的序号；无学期节点进末尾一列。
  let colOfUnit
  let colCount
  if (rankMode === 'semester' && typeof unitSemesterIndex === 'function') {
    const raw = new Map(unitIds.map((unitId) => [unitId, unitSemesterIndex(unitId)]))
    const hasNone = [...raw.values()].some((index) => index < 0)
    const noneCol = Math.max(semesterCount, ...[...raw.values()].filter((index) => index >= 0).map((i) => i + 1))
    colOfUnit = new Map([...raw].map(([unitId, index]) => [unitId, index < 0 ? noneCol : index]))
    colCount = noneCol + (hasNone ? 1 : 0)
  } else {
    const depth = longestPathDepths(unitIds, rankByUnit, pairList)
    const combined = new Map(
      unitIds.map((unitId) => [unitId, Math.min(rankByUnit.get(unitId) ?? 0, depth.get(unitId) ?? 0)]),
    )
    const levels = [...new Set(combined.values())].sort((a, b) => a - b)
    colOfUnit = new Map(unitIds.map((unitId) => [unitId, levels.indexOf(combined.get(unitId))]))
    colCount = levels.length
  }
  if (!unitIds.length) colCount = 0

  const byCol = Array.from({ length: colCount }, () => [])
  for (const unitId of unitIds) byCol[colOfUnit.get(unitId)].push(unitId)
  for (const list of byCol) {
    list.sort((a, b) => {
      const oa = graph.node(a)?.order ?? 0
      const ob = graph.node(b)?.order ?? 0
      if (oa !== ob) return oa - ob
      const ya = graph.node(a)?.y ?? 0
      const yb = graph.node(b)?.y ?? 0
      if (ya !== yb) return ya - yb
      return a.localeCompare(b)
    })
  }

  return { byCol, colOfUnit, colCount, unitHeight }
}

// 单位级 prereq DAG（按 dagre rank 定向：低于 rank 的边视为环内反向边并忽略，定向子图必为 DAG）
// 上从源出发的最长路径深度；源 = 0。
function longestPathDepths(unitIds, rankByUnit, pairList) {
  const adj = new Map(unitIds.map((unitId) => [unitId, []]))
  const indeg = new Map(unitIds.map((unitId) => [unitId, 0]))
  for (const [a, b] of pairList) {
    if (!adj.has(a) || !adj.has(b)) continue
    if ((rankByUnit.get(a) ?? 0) >= (rankByUnit.get(b) ?? 0)) continue
    adj.get(a).push(b)
    indeg.set(b, indeg.get(b) + 1)
  }
  const depth = new Map(unitIds.map((unitId) => [unitId, 0]))
  const queue = unitIds.filter((unitId) => indeg.get(unitId) === 0).sort()
  let head = 0
  while (head < queue.length) {
    const u = queue[head]
    head += 1
    for (const v of adj.get(u)) {
      depth.set(v, Math.max(depth.get(v), depth.get(u) + 1))
      indeg.set(v, indeg.get(v) - 1)
      if (indeg.get(v) === 0) queue.push(v)
    }
  }
  return depth
}

// ---------------------------------------------------------------------------
// 走线工具
// ---------------------------------------------------------------------------

// 箭头用显式闭合 <path> 而非 <marker>/<polygon>：
// html-to-image 不会给 foreignObject 内嵌套 <svg> 的子元素复制计算样式，
// 且 Chrome 对 <polygon> 的计算值会破坏几何（导出会变成巨大黑三角）。
export function arrowHead(tip, dir, len = 9, half = 4.5) {
  const norm = Math.hypot(dir[0], dir[1]) || 1
  const ux = dir[0] / norm
  const uy = dir[1] / norm
  const bx = tip[0] - ux * len
  const by = tip[1] - uy * len
  const px = -uy
  const py = ux
  return [
    `M ${round(tip[0])} ${round(tip[1])}`,
    `L ${round(bx + px * half)} ${round(by + py * half)}`,
    `L ${round(bx - px * half)} ${round(by - py * half)}`,
    'Z',
  ].join(' ')
}

// 去掉重复点与共线中间点，保留正交折线的关键拐点。
export function simplifyPoints(points) {
  const dedup = []
  for (const p of points ?? []) {
    const last = dedup[dedup.length - 1]
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue
    dedup.push({ x: p.x, y: p.y })
  }
  const out = []
  for (let i = 0; i < dedup.length; i += 1) {
    const prev = out[out.length - 1]
    const cur = dedup[i]
    const next = dedup[i + 1]
    if (prev && next) {
      const vertical = Math.abs(prev.x - cur.x) < EPS && Math.abs(cur.x - next.x) < EPS
      const horizontal = Math.abs(prev.y - cur.y) < EPS && Math.abs(cur.y - next.y) < EPS
      if (vertical || horizontal) continue
    }
    out.push(cur)
  }
  return out
}

// 正交折线 → 圆角 path（M/L/Q；不用 <marker>/<polygon>）。
export function orthPath(points, radius = ROUTE_GEOMETRY.corner) {
  const pts = simplifyPoints(points)
  if (pts.length < 2) return pts.length ? `M ${round(pts[0].x)} ${round(pts[0].y)}` : ''
  let d = `M ${round(pts[0].x)} ${round(pts[0].y)}`
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const v1x = cur.x - prev.x
    const v1y = cur.y - prev.y
    const v2x = next.x - cur.x
    const v2y = next.y - cur.y
    const l1 = Math.hypot(v1x, v1y) || 1
    const l2 = Math.hypot(v2x, v2y) || 1
    const r = Math.max(0, Math.min(radius, l1 / 2, l2 / 2))
    const ax = cur.x - (v1x / l1) * r
    const ay = cur.y - (v1y / l1) * r
    const bx = cur.x + (v2x / l2) * r
    const by = cur.y + (v2y / l2) * r
    d += ` L ${round(ax)} ${round(ay)} Q ${round(cur.x)} ${round(cur.y)} ${round(bx)} ${round(by)}`
  }
  const last = pts[pts.length - 1]
  d += ` L ${round(last.x)} ${round(last.y)}`
  return d
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function buildRouteLayout({ nodes, edges, config = {} } = {}) {
  const route = config.route ?? config
  const card = ROUTE_GEOMETRY.card
  const excluded = new Set(route.excludeModules ?? [])

  const all = (nodes ?? []).filter((node) => node?.id && !excluded.has(moduleKeyOf(node)))
  const nodeById = new Map(all.map((node) => [node.id, node]))
  const moduleOf = new Map(all.map((node) => [node.id, moduleKeyOf(node)]))
  const moduleOrder = moduleOrderOf(all, route)

  const semesterKeys = sortSemesterKeys(all.flatMap((node) => node.semesters ?? []))
  const indexOfKey = new Map(semesterKeys.map((key, index) => [key, index]))
  const gradeByKey = gradeMapOf(all, semesterKeys)
  const semester = makeSemesterApi({ nodeById, keys: semesterKeys, indexOfKey, gradeByKey })

  const idSet = new Set(all.map((node) => node.id))
  const inputEdges = (edges ?? []).filter(
    (edge) => edge?.from && edge?.to && idSet.has(edge.from) && idSet.has(edge.to) && edge.from !== edge.to,
  )
  const coreqEdges = inputEdges.filter((edge) => edge.kind === 'coreq')
  const prereqEdges = inputEdges.filter((edge) => edge.kind !== 'coreq')

  const { unitMembers, unitOf } = buildUnits(all, coreqEdges)
  const unitIds = [...unitMembers.keys()].sort()
  const rankMode = route.rankMode === 'semester' ? 'semester' : 'dependency'
  // 单位所在列（学期模式）= 组内成员首学期序号的最小值；无学期 → -1。
  const unitSemesterIndex = (unitId) => {
    let best = -1
    for (const id of unitMembers.get(unitId) ?? []) {
      const first = sortSemesterKeys(nodeById.get(id)?.semesters ?? [])[0]
      const index = first == null ? -1 : indexOfKey.get(first) ?? -1
      if (index < 0) continue
      if (best < 0 || index < best) best = index
    }
    return best
  }
  const { byCol, colOfUnit, colCount, unitHeight } = dagreRanks(unitIds, unitMembers, prereqEdges, unitOf, {
    rankMode,
    unitSemesterIndex,
    semesterCount: semesterKeys.length,
  })

  const issues = []

  // --- 列内纵向堆叠（列整体垂直居中）---
  const colHeights = byCol.map((list) =>
    list.reduce((sum, unitId, index) => sum + unitHeight(unitId) + (index ? ROUTE_GEOMETRY.nodeGapY : 0), 0),
  )
  const maxHeight = colHeights.length ? Math.max(...colHeights) : 0
  const unitBox = new Map()
  byCol.forEach((list, col) => {
    let y = (maxHeight - colHeights[col]) / 2
    list.forEach((unitId, orderInCol) => {
      const h = unitHeight(unitId)
      unitBox.set(unitId, { col, orderInCol, y, h })
      y += h + ROUTE_GEOMETRY.nodeGapY
    })
  })

  const cardYOf = new Map()
  for (const unitId of unitIds) {
    const box = unitBox.get(unitId)
    unitMembers.get(unitId).forEach((id, index) => {
      cardYOf.set(id, box.y + index * (card.h + ROUTE_GEOMETRY.nodeGapY))
    })
  }

  // --- 端口扇出：同一卡片同一侧的多条边在卡片高度内均匀铺开 ---
  const sideBuckets = new Map()
  const plans = []
  for (const edge of prereqEdges) {
    const unitA = unitOf.get(edge.from)
    const unitB = unitOf.get(edge.to)
    if (!unitA || !unitB) continue
    const colA = colOfUnit.get(unitA)
    const colB = colOfUnit.get(unitB)
    if (unitA === unitB) {
      issues.push({
        code: 'W14',
        level: 'warning',
        edge: edgeKey(edge),
        message: `同一同修组内出现先修边（相互矛盾），已忽略：${edgeKey(edge)}`,
      })
      continue
    }
    let startSide
    let endSide
    if (colA === colB) {
      startSide = 'right'
      endSide = 'right'
    } else if (colA < colB) {
      startSide = 'right'
      endSide = 'left'
    } else {
      startSide = 'left'
      endSide = 'right'
    }
    const plan = {
      key: edgeKey(edge),
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      source: edge.source,
      confidence: edge.confidence,
      evidence: edge.evidence,
      unitA,
      unitB,
      colA,
      colB,
      startSide,
      endSide,
      lanes: {},
    }
    plans.push(plan)
    const add = (id, side, role) => {
      const key = `${id}\u0000${side}`
      if (!sideBuckets.has(key)) sideBuckets.set(key, [])
      sideBuckets.get(key).push({ plan, role })
    }
    add(edge.from, startSide, 'start')
    add(edge.to, endSide, 'end')
  }
  plans.sort((a, b) => a.key.localeCompare(b.key))

  const portY = new Map()
  for (const [bucketKey, list] of sideBuckets) {
    const at = bucketKey.indexOf('\u0000')
    const id = bucketKey.slice(0, at)
    const top = cardYOf.get(id) ?? 0
    const center = top + card.h / 2
    const lo = top + ROUTE_GEOMETRY.portPad
    const hi = top + card.h - ROUTE_GEOMETRY.portPad
    list.sort((a, b) => a.plan.key.localeCompare(b.plan.key))
    const count = list.length
    list.forEach((item, index) => {
      const offset = count > 1 ? (index - (count - 1) / 2) * ROUTE_GEOMETRY.portGap : 0
      const y = Math.max(lo, Math.min(hi, center + offset))
      portY.set(`${item.plan.key}\u0000${item.role}`, y)
    })
  }

  // --- 区间合并（用于给跨列长边找一条「中间列全部空出来」的横向走廊）---
  function mergeIntervals(intervals) {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0])
    const merged = []
    for (const interval of sorted) {
      const last = merged[merged.length - 1]
      if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1])
      else merged.push([interval[0], interval[1]])
    }
    return merged
  }

  function corridorFor(colLo, colHi, ideal) {
    if (colLo > colHi) return ideal
    const intervals = []
    for (let col = colLo; col <= colHi; col += 1) {
      for (const unitId of byCol[col]) {
        for (const id of unitMembers.get(unitId)) {
          const top = (cardYOf.get(id) ?? 0) - ROUTE_GEOMETRY.cardPad
          intervals.push([top, top + card.h + ROUTE_GEOMETRY.cardPad * 2])
        }
      }
    }
    const merged = mergeIntervals(intervals)
    for (const [lo, hi] of merged) {
      if (ideal >= lo && ideal <= hi) {
        return ideal - lo <= hi - ideal ? lo - 2 : hi + 2
      }
    }
    return ideal
  }

  // --- 每条边的走线骨架（先算 y，再算 lane，最后算 x）---
  const gapSegments = new Map()
  const pushSegment = (gap, y1, y2, plan, which) => {
    if (!gapSegments.has(gap)) gapSegments.set(gap, [])
    gapSegments.get(gap).push({ minY: Math.min(y1, y2), maxY: Math.max(y1, y2), plan, which })
  }

  for (const plan of plans) {
    const ys = portY.get(`${plan.key}\u0000start`)
    const yt = portY.get(`${plan.key}\u0000end`)
    const { colA, colB } = plan
    if (colA === colB) {
      pushSegment(colA, ys, yt, plan, 'single')
      plan.shape = { type: 'single', gap: colA, ys, yt }
      continue
    }
    const forward = colA < colB
    const gapA = forward ? colA : colA - 1
    const gapB = forward ? colB - 1 : colB
    if (gapA === gapB) {
      pushSegment(gapA, ys, yt, plan, 'single')
      plan.shape = { type: 'single', gap: gapA, ys, yt }
    } else {
      const corridor = corridorFor(Math.min(colA, colB) + 1, Math.max(colA, colB) - 1, (ys + yt) / 2)
      pushSegment(gapA, ys, corridor, plan, 'A')
      pushSegment(gapB, corridor, yt, plan, 'B')
      plan.shape = { type: 'two', gapA, gapB, ys, yt, corridor }
    }
  }

  // --- lane 分配：同一空隙内的竖直段按 y 区间做 first-fit，避免重叠 ---
  const gapLaneCount = new Map()
  for (const gap of [...gapSegments.keys()].sort((a, b) => a - b)) {
    const segments = gapSegments.get(gap)
    segments.sort(
      (a, b) =>
        a.minY - b.minY ||
        a.maxY - b.maxY ||
        a.plan.key.localeCompare(b.plan.key) ||
        a.which.localeCompare(b.which),
    )
    const lanes = []
    for (const segment of segments) {
      const lo = segment.minY - ROUTE_GEOMETRY.laneGap / 2
      const hi = segment.maxY + ROUTE_GEOMETRY.laneGap / 2
      let lane = 0
      for (;;) {
        const occupied = lanes[lane] ?? []
        if (!occupied.some(([a, b]) => lo < b - EPS && a < hi - EPS)) {
          if (!lanes[lane]) lanes[lane] = []
          lanes[lane].push([lo, hi])
          segment.lane = lane
          segment.plan.lanes[segment.which] = lane
          break
        }
        lane += 1
      }
    }
    gapLaneCount.set(gap, lanes.length)
  }

  // --- 空隙宽度 = max(rankSep, 2*lanePad + lanes*laneGap) ---
  const gapWidth = []
  for (let col = 0; col < colCount; col += 1) {
    const lanes = gapLaneCount.get(col) ?? 0
    gapWidth.push(
      Math.max(ROUTE_GEOMETRY.rankSep, ROUTE_GEOMETRY.lanePad * 2 + Math.max(1, lanes) * ROUTE_GEOMETRY.laneGap),
    )
  }

  const colX = []
  let cursor = 0
  for (let col = 0; col < colCount; col += 1) {
    colX.push(cursor)
    cursor += card.w + gapWidth[col]
  }
  const contentWidth = colCount ? cursor : 0

  const leftOf = (id) => colX[colOfUnit.get(unitOf.get(id))] ?? 0
  const rightOf = (id) => leftOf(id) + card.w
  const laneX = (gap, lane) =>
    (colX[gap] ?? 0) + card.w + ROUTE_GEOMETRY.lanePad + (lane ?? 0) * ROUTE_GEOMETRY.laneGap + ROUTE_GEOMETRY.laneGap / 2

  // --- 组装折线（此时仍是未平移的原始坐标）---
  const routes = []
  for (const plan of plans) {
    const shape = plan.shape
    const startX = plan.startSide === 'right' ? rightOf(plan.from) : leftOf(plan.from)
    const endX = plan.endSide === 'left' ? leftOf(plan.to) : rightOf(plan.to)
    let points
    if (shape.type === 'single') {
      const x = laneX(shape.gap, plan.lanes.single)
      points = [
        { x: startX, y: shape.ys },
        { x, y: shape.ys },
        { x, y: shape.yt },
        { x: endX, y: shape.yt },
      ]
    } else {
      const xa = laneX(shape.gapA, plan.lanes.A)
      const xb = laneX(shape.gapB, plan.lanes.B)
      points = [
        { x: startX, y: shape.ys },
        { x: xa, y: shape.ys },
        { x: xa, y: shape.corridor },
        { x: xb, y: shape.corridor },
        { x: xb, y: shape.yt },
        { x: endX, y: shape.yt },
      ]
    }
    const simplified = simplifyPoints(points)
    const tip = simplified[simplified.length - 1]
    const dir = plan.endSide === 'left' ? [1, 0] : [-1, 0]
    routes.push({
      key: plan.key,
      from: plan.from,
      to: plan.to,
      kind: plan.kind,
      source: plan.source,
      confidence: plan.confidence,
      evidence: plan.evidence,
      type: plan.colA === plan.colB ? 'same-col' : plan.colA < plan.colB ? 'forward' : 'backward',
      colFrom: plan.colA,
      colTo: plan.colB,
      startSide: plan.startSide,
      endSide: plan.endSide,
      points: simplified.map((p) => ({ x: round(p.x), y: round(p.y) })),
      d: orthPath(simplified),
      dir,
      tip: { x: round(tip.x), y: round(tip.y) },
      arrow: arrowHead([tip.x, tip.y], dir),
    })
  }
  routes.sort((a, b) => a.key.localeCompare(b.key))

  // --- 平移：把内容放进 margin，负坐标（上方走廊）不会溢出画布 ---
  let minY = 0
  let maxY = maxHeight
  for (const route of routes) {
    for (const p of route.points) {
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
  }
  const offsetY = ROUTE_GEOMETRY.margin - minY
  const offsetX = ROUTE_GEOMETRY.margin
  const shift = (value, offset) => round(value + offset)

  const placements = []
  const units = []
  byCol.forEach((list, col) => {
    list.forEach((unitId, orderInCol) => {
      const box = unitBox.get(unitId)
      const members = unitMembers.get(unitId)
      units.push({
        id: unitId,
        col,
        orderInCol,
        memberIds: [...members],
        x: shift(colX[col], offsetX),
        y: shift(box.y, offsetY),
        w: card.w,
        h: round(box.h),
      })
      members.forEach((id, memberIndex) => {
        placements.push({
          id,
          kind: 'course',
          module: moduleOf.get(id) ?? DEFAULT_MODULE,
          unitId,
          col,
          orderInCol,
          memberIndex,
          w: card.w,
          h: card.h,
          x: shift(colX[col], offsetX),
          y: shift(box.y + memberIndex * (card.h + ROUTE_GEOMETRY.nodeGapY), offsetY),
        })
      })
    })
  })
  const placeOf = new Map(placements.map((placement) => [placement.id, placement]))

  for (const route of routes) {
    route.points = route.points.map((p) => ({ x: shift(p.x, offsetX), y: shift(p.y, offsetY) }))
    route.d = orthPath(route.points)
    route.tip = { x: shift(route.tip.x, offsetX), y: shift(route.tip.y, offsetY) }
    route.arrow = arrowHead([route.tip.x, route.tip.y], route.dir)
  }

  // --- coreq 配套连接器（组内虚线，每条 coreq 边一根）---
  const companions = []
  for (const edge of coreqEdges) {
    const unitId = unitOf.get(edge.from)
    if (!unitId || unitId !== unitOf.get(edge.to)) continue
    const members = unitMembers.get(unitId)
    const i = members.indexOf(edge.from)
    const j = members.indexOf(edge.to)
    if (i < 0 || j < 0 || i === j) continue
    const lo = Math.min(i, j)
    const hi = Math.max(i, j)
    const box = unitBox.get(unitId)
    const adjacent = hi - lo === 1
    const x = adjacent ? shift(colX[box.col] + card.w / 2, offsetX) : shift(colX[box.col] - 7, offsetX)
    const y1 = adjacent
      ? shift(cardYOf.get(members[lo]) + card.h, offsetY)
      : shift(cardYOf.get(members[lo]) + card.h / 2, offsetY)
    const y2 = adjacent
      ? shift(cardYOf.get(members[hi]), offsetY)
      : shift(cardYOf.get(members[hi]) + card.h / 2, offsetY)
    companions.push({
      key: `companion:${edgeKey(edge)}`,
      from: edge.from,
      to: edge.to,
      unitId,
      adjacent,
      x1: x,
      y1,
      x2: x,
      y2,
    })
  }
  companions.sort((a, b) => a.key.localeCompare(b.key))

  // --- 模块摘要（配色 + 图例 + 邻域信息）---
  const moduleCols = new Map()
  for (const unit of units) {
    const module = moduleOf.get(unit.memberIds[0]) ?? DEFAULT_MODULE
    if (!moduleCols.has(module)) moduleCols.set(module, new Set())
    moduleCols.get(module).add(unit.col)
  }
  const modules = moduleOrder
    .filter((module) => moduleCols.has(module))
    .map((module) => {
      const colsOfModule = [...moduleCols.get(module)].sort((a, b) => a - b)
      const memberIds = all.filter((node) => moduleOf.get(node.id) === module).map((node) => node.id)
      return {
        id: module,
        title: module,
        styleKey: nodeById.get(memberIds[0])?.styleKey ?? 'core',
        nodeIds: memberIds,
        count: memberIds.length,
        minCol: colsOfModule[0],
        maxCol: colsOfModule[colsOfModule.length - 1],
      }
    })

  const size = colCount
    ? { w: round(contentWidth + ROUTE_GEOMETRY.margin * 2), h: round(maxY - minY + ROUTE_GEOMETRY.margin * 2) }
    : { w: 0, h: 0 }

  return {
    geometry: ROUTE_GEOMETRY,
    size,
    placements,
    placeOf,
    units,
    unitOf,
    unitMembers,
    modules,
    moduleOf,
    moduleOrder,
    colOfUnit,
    colCount,
    rankMode,
    routes,
    companions,
    semester,
    issues,
  }
}
