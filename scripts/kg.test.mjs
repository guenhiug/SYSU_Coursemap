// 确定性层自动化测试：无模型、无网络。
// 运行：npm test（= node --test）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EDGE_KINDS,
  GRAPH_VERSION,
  ORPHAN_INSTRUCTIONS,
  PACKET_INSTRUCTIONS,
  applyResults,
  buildPackets,
  buildRouteView,
  checkGraph,
  computeFocus,
  edgeKey,
  emptyGraph,
  extractNodes,
  isOutOfOrder,
  mergeEdges,
  mergeMapIndex,
  migrateGraphToV3,
  orphanNodes,
  practiceChainEdges,
  practiceStageNumber,
  removeCycleEdges,
  semesterIndexOf,
  semesterLabelOf,
  shardNodeIds,
  sortNodes,
  stronglyConnectedComponents,
  transitiveReduce,
  validateEdges,
  visibleEdges,
  withPracticeChain,
} from '../src/lib/course-graph.js'
import { ROUTE_GEOMETRY, arrowHead, buildRouteLayout, orthPath, simplifyPoints } from '../src/data/route-layout.js'
import { VERSION_ERROR, normalizeGraphFile, serializeGraph, validateGraphShape } from '../src/lib/graph-file.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exampleRaw = JSON.parse(await fs.readFile(path.join(root, 'data', 'raw', 'example.json'), 'utf8'))
const exampleGraph = JSON.parse(await fs.readFile(path.join(root, 'data', 'maps', 'example.graph.json'), 'utf8'))

const row = (over = {}) => ({
  courseName: '课程',
  courseNumber: 'T100',
  courseCategoryName: '专必',
  courseSubClassModuleName: '平台课模块',
  courseTypeName: '平台课程',
  credit: 2,
  initiationSemesterAnnotation: '2026-1',
  ...over,
})

const mk = (id, module, over = {}) => ({
  id,
  name: id,
  code: id,
  module,
  typeName: module === '实习实践课' ? '实践课' : '专业课',
  category: '专必',
  credits: null,
  semesters: ['2026-1'],
  grade: 1,
  spanning: false,
  styleKey: module === '实习实践课' ? 'practice' : 'core',
  sourceHash: 'x',
  ...over,
})

const nodesOf = (ids) => ids.map((id) => mk(id, 'M'))
const E = (from, to, over = {}) => ({ from, to, kind: 'prereq', confidence: 0.9, evidence: '依赖依据测试', ...over })
const graphOf = (nodes, edges, over = {}) => ({
  version: GRAPH_VERSION,
  id: 't',
  meta: { status: 'built' },
  nodes,
  edges,
  suppressed: [],
  issues: [],
  ...over,
})

// ---------------------------------------------------------------------------
// 1. 节点抽取
// ---------------------------------------------------------------------------

test('节点抽取：同码合并 / 无码用名称 / spanning / W4 / W6 / sourceHash 稳定 / sortNodes', () => {
  const raw = [
    row({ courseNumber: 'T200', courseName: '示例课程（二）上', initiationSemesterAnnotation: '2026-1' }),
    row({ courseNumber: 'T200', courseName: '示例课程（二）上', initiationSemesterAnnotation: '2026-2' }),
    row({
      courseNumber: '',
      courseName: '无码课程',
      courseCategoryName: '专选',
      courseSubClassModuleName: '模块甲',
      courseTypeName: '专业选修课',
      initiationSemesterAnnotation: '2026-1~2027-2',
    }),
    row({ courseNumber: 'NOPE', courseName: '没有学期', initiationSemesterAnnotation: '' }),
    row({ courseNumber: 'PUB1', courseName: '公共课', courseCategoryName: '公必', courseSubClassModuleName: '公共课', courseTypeName: '公共课' }),
    row({ courseNumber: 'X9', courseSubClassModuleName: '模块甲', courseCategoryName: '专选' }),
    row({ courseNumber: 'X9', courseSubClassModuleName: '模块乙', courseCategoryName: '专选' }),
  ]
  const { nodes, issues, startYear } = extractNodes(raw)

  assert.equal(startYear, 2026)
  assert.deepEqual(nodes.map((n) => n.id), ['T200', '无码课程', 'X9'])
  const chm = nodes[0]
  assert.deepEqual(chm.semesters, ['2026-1', '2026-2'])
  assert.equal(chm.grade, 1)
  assert.equal(chm.spanning, false)
  assert.equal(chm.styleKey, 'platform')
  assert.equal(chm.credits, 2)
  assert.equal('kind' in chm, false)
  assert.equal('op' in chm, false)

  const nocode = nodes[1]
  assert.equal(nocode.id, '无码课程')
  assert.equal(nocode.code, '')
  assert.equal(nocode.spanning, true)
  assert.equal(nocode.styleKey, 'mod-slot-0')

  assert.equal(nodes[2].module, '模块甲', 'W4 保留首个模块')
  assert.equal(issues.filter((i) => i.code === 'W6').length, 1)
  assert.ok(issues.some((i) => i.code === 'W4'))

  const a = extractNodes([row()]).nodes[0]
  const b = extractNodes([row()]).nodes[0]
  const c = extractNodes([row({ credit: 9 })]).nodes[0]
  assert.equal(a.sourceHash, b.sourceHash)
  assert.notEqual(a.sourceHash, c.sourceHash)
  assert.match(a.sourceHash, /^[0-9a-f]{8}$/)
  assert.deepEqual(sortNodes([{ id: 'B' }, { id: 'A' }]).map((n) => n.id), ['B', 'A'])
})

// ---------------------------------------------------------------------------
// 2. 硬错误（E1-E5）
// ---------------------------------------------------------------------------

test('硬错误：悬空 / 缺 evidence / confidence 越界 / kind 非法 / 自环 / 重复 / Phase A 片外 都被剔除', () => {
  const { kept, issues } = validateEdges(
    [
      { from: 'A', to: 'ZZZ', kind: 'prereq', confidence: 0.9, evidence: '悬空引用测试' },
      { from: 'A', to: 'B', kind: 'prereq', confidence: 0.9, evidence: '' },
      { from: 'A', to: 'C', kind: 'prereq', confidence: 2, evidence: '置信度越界' },
      { from: 'A', to: 'C', kind: 'sequence', confidence: 0.5, evidence: '废弃边类型' },
      { from: 'B', to: 'B', kind: 'prereq', confidence: 0.5, evidence: '自环边测试' },
      { from: 'A', to: 'D', kind: 'prereq', confidence: 0.9, evidence: '片外边依据' },
      { from: 'A', to: 'B', kind: 'prereq', confidence: 0.9, evidence: '合法边测试' },
      { from: 'A', to: 'B', kind: 'prereq', confidence: 0.9, evidence: '重复边测试' },
    ],
    { nodeIds: new Set(['A', 'B', 'C', 'D']), shardNodeIds: new Set(['A', 'B', 'C', 'ZZZ']) },
  )
  assert.deepEqual(kept.map((e) => `${e.from}>${e.to}`), ['A>B'])
  const codes = issues.map((i) => i.code).sort()
  assert.deepEqual(codes, ['E1', 'E2', 'E3', 'E3', 'E4', 'E4', 'E5'])
  assert.ok(issues.every((i) => i.level === 'error'))
})

// ---------------------------------------------------------------------------
// 3. 环路 / 逆时序
// ---------------------------------------------------------------------------

test('环路：SCC → W1；removeCycleEdges 后无环；逆时序 W2 只警告不删边', () => {
  const nodes = nodesOf(['A', 'B', 'C'])
  const edges = [E('A', 'B'), E('B', 'C'), E('C', 'A', { confidence: 0.4 })]
  assert.ok(checkGraph(graphOf(nodes, edges)).warnings.some((w) => w.code === 'W1'))
  assert.equal(stronglyConnectedComponents(nodes.map((n) => n.id), edges).length, 1)

  const { edges: fixed, removed } = removeCycleEdges(edges, nodes.map((n) => n.id))
  assert.equal(removed.length, 1)
  assert.equal(removed[0].confidence, 0.4)
  assert.equal(stronglyConnectedComponents(nodes.map((n) => n.id), fixed).length, 0)

  const late = [mk('A', 'M', { semesters: ['2026-1'] }), mk('B', 'M', { semesters: ['2027-1'], grade: 2 })]
  const backward = E('B', 'A')
  const result = checkGraph(graphOf(late, [backward]))
  assert.equal(result.errors.length, 0)
  assert.equal(result.warnings.filter((w) => w.code === 'W2').length, 1)
  assert.equal(isOutOfOrder(backward, new Map(late.map((n) => [n.id, n]))), true)
})

// ---------------------------------------------------------------------------
// 4. 合并 / manual / suppressed / 来源优先级
// ---------------------------------------------------------------------------

test('合并：A+B 同边合并，manual 不被覆盖，suppressed 只清 agent 边', () => {
  const base = graphOf(nodesOf(['A', 'B']), [])
  const a = applyResults(base, [{ stage: 'A', shard: 'M', edges: [E('A', 'B', { confidence: 0.6, evidence: '依据甲说明' })] }], {
    stage: 'A',
    shardNodeIds: { M: new Set(['A', 'B']) },
    now: 'T1',
  })
  const b = applyResults(a.graph, [{ stage: 'B', edges: [E('A', 'B', { confidence: 0.9, evidence: '依据乙说明' })] }], { stage: 'B', now: 'T2' })
  assert.equal(b.graph.edges.length, 1)
  assert.equal(b.graph.edges[0].confidence, 0.9)
  assert.equal(b.graph.edges[0].pass, 'A+B')
  assert.equal(b.graph.edges[0].evidence, '依据甲说明；依据乙说明')

  const manual = { from: 'A', to: 'B', kind: 'coreq', confidence: 0.5, evidence: '人工确认的依据', source: 'manual' }
  const other = E('B', 'A', { confidence: 0.7, evidence: '原 agent 边' })
  const manualBase = graphOf(nodesOf(['A', 'B']), [manual, other], { suppressed: ['A>B', 'B>A'] })
  const { graph } = applyResults(manualBase, [{ stage: 'A', shard: 'M', edges: [E('A', 'B', { confidence: 0.95, evidence: 'agent 覆盖尝试' })] }], {
    stage: 'A',
    shardNodeIds: { M: new Set(['A', 'B']) },
    now: 'T',
  })
  const kept = graph.edges.find((e) => e.from === 'A')
  assert.ok(kept, 'manual 边必须保留')
  assert.equal(kept.source, 'manual')
  assert.equal(kept.kind, 'coreq')
  assert.equal(kept.confidence, 0.95)
  assert.match(kept.evidence, /人工确认的依据/)
  assert.match(kept.evidence, /agent 覆盖尝试/)
  assert.equal(graph.edges.some((e) => e.from === 'B' && e.to === 'A'), false, 'suppressed 的 agent 边被移除')
})

test('mergeEdges 来源优先级：agent 覆盖 rule 的 kind；manual 最高且不被降级', () => {
  const rule = { from: 'A', to: 'B', kind: 'prereq', confidence: 0.85, evidence: '规则实践链依据', source: 'rule' }
  const agent = { from: 'A', to: 'B', kind: 'coreq', confidence: 0.7, evidence: '模型同修依据', source: 'agent' }
  const merged = mergeEdges(rule, agent)
  assert.equal(merged.kind, 'coreq')
  assert.equal(merged.source, 'agent')
  assert.equal(merged.confidence, 0.85)
  assert.match(merged.evidence, /规则实践链依据/)

  const manual = mergeEdges(merged, { from: 'A', to: 'B', kind: 'prereq', confidence: 0.9, evidence: '人工确认依据', source: 'manual' })
  assert.equal(manual.kind, 'prereq')
  assert.equal(manual.source, 'manual')
  const kept = mergeEdges(manual, { from: 'A', to: 'B', kind: 'coreq', confidence: 0.99, evidence: '模型再改依据', source: 'agent' })
  assert.equal(kept.kind, 'prereq')
  assert.equal(kept.source, 'manual')
})

test('传递约简：冗余 prereq 被删除，coreq 不参与', () => {
  const edges = [E('A', 'B'), E('B', 'C'), E('A', 'C', { confidence: 0.6 }), E('A', 'C', { kind: 'coreq', confidence: 0.6 })]
  const { edges: reduced, removed } = transitiveReduce(edges)
  assert.equal(removed.length, 1)
  assert.equal(reduced.length, 3)
  assert.ok(reduced.some((e) => e.kind === 'coreq'))
})

// ---------------------------------------------------------------------------
// 5. 任务包 / Stage C
// ---------------------------------------------------------------------------

test('任务包：schemaVersion 3 / 无 logic / Phase B 含 stageAEdges；shardNodeIds 按模块分片', () => {
  const nodes = [mk('A', 'M1'), mk('B', 'M1', { semesters: ['2027-1'], grade: 2 }), mk('C', 'M2')]
  const graph = graphOf(nodes, [E('A', 'B')], { id: 'demo', meta: {} })

  const a = buildPackets(graph, { stage: 'A' })
  assert.equal(a.length, 2)
  const m1 = a.find((p) => p.shard === 'M1')
  assert.equal(m1.schemaVersion, 3)
  assert.equal('logic' in m1, false)
  assert.deepEqual(m1.nodes.map((n) => n.id), ['A', 'B'])
  assert.deepEqual(m1.context.allNodes.find((n) => n.id === 'B').semesters, ['2027-1'])
  assert.match(m1.outputPath, /result\.A\.M1\.json$/)

  const b = buildPackets(graph, { stage: 'B' })
  assert.equal(b.length, 1)
  assert.equal(b[0].context.stageAEdges.length, 1)
  assert.match(b[0].outputPath, /result\.B\.json$/)

  const map = shardNodeIds(graphOf([mk('A', 'M1'), mk('B', 'M2')], []))
  assert.deepEqual([...map.M1], ['A'])
  assert.deepEqual([...map.M2], ['B'])
})

test('Stage C：orphanNodes 只算无关联课程；任务包只含孤儿；apply 写 built', () => {
  const graph = graphOf([mk('A', 'M'), mk('B', 'M'), mk('C', 'M')], [E('A', 'B')])
  assert.deepEqual(orphanNodes(graph).map((n) => n.id), ['C'])
  assert.deepEqual(orphanNodes({ nodes: [mk('A', 'M'), mk('B', 'M')], edges: [E('B', 'A', { kind: 'coreq' })] }), [])

  const packets = buildPackets(graph, { stage: 'C' })
  assert.equal(packets.length, 1)
  assert.deepEqual(packets[0].nodes.map((n) => n.id), ['C'])
  assert.deepEqual(packets[0].context.orphanIds, ['C'])
  assert.match(packets[0].instructions, /孤儿课程/)
  assert.match(packets[0].outputPath, /result\.C\.json$/)
  assert.equal(buildPackets(graphOf([mk('A', 'M'), mk('B', 'M')], [E('A', 'B')]), { stage: 'C' }).length, 0)

  const { graph: next, stats } = applyResults(graph, [{ stage: 'C', shard: '__orphans__', edges: [E('A', 'C')] }], { stage: 'C', now: 'T' })
  assert.equal(stats.added, 1)
  assert.equal(next.meta.status, 'built')
  assert.equal(next.meta.passes[0].stage, 'C')
})

test('Prompt 纠偏：实验课 coreq / 整合实验多 coreq / 基础课→专业应用课 / 终结点', () => {
  const graph = graphOf([mk('A', 'M')], [])
  const [packetA] = buildPackets(graph, { stage: 'A' })
  assert.match(packetA.instructions, /不得写成 prereq/)
  assert.match(packetA.instructions, /整合实验/)
  assert.match(packetA.instructions, /基础课 → 专业应用课/)
  assert.match(packetA.instructions, /毕业论文/)
  assert.match(packetA.instructions, /终结点/)

  const [packetB] = buildPackets(graph, { stage: 'B' })
  assert.match(packetB.instructions, /跨模块/)
  assert.match(packetB.instructions, /整合实验/)
  assert.match(packetB.instructions, /基础课/)

  assert.match(ORPHAN_INSTRUCTIONS, /孤儿课程/)
  assert.match(ORPHAN_INSTRUCTIONS, /大一基础课/)
  assert.match(ORPHAN_INSTRUCTIONS, /终结点/)
  assert.match(PACKET_INSTRUCTIONS, /课程编号/)
})

// ---------------------------------------------------------------------------
// 6. 确定性实践链
// ---------------------------------------------------------------------------

test('practiceChainEdges：编号主干 → 非编号并入 → 终结点收尾 = 单条链，幂等', () => {
  const nodes = [
    mk('P2', '实习实践课', { name: '示例实践2', semesters: ['2027-1'], grade: 2 }),
    mk('P1', '实习实践课', { name: '示例实践1', semesters: ['2026-2'], grade: 1 }),
    mk('PB', '实习实践课', { name: '示例综合实践', semesters: ['2028-1'], grade: 3 }),
    mk('T', '专必课', { name: '毕业论文', semesters: ['2029-1'], grade: 4 }),
    mk('O', '专必课', { name: '独立前沿专题' }),
  ]
  const chain = practiceChainEdges(nodes, {})
  assert.deepEqual(chain.map((e) => edgeKey(e)), ['P1>P2', 'P2>PB', 'PB>T'])
  assert.equal(chain.every((e) => e.kind === 'prereq' && e.source === 'rule'), true)
  assert.equal(chain.find((e) => edgeKey(e) === 'P1>P2').confidence, 0.85)
  assert.equal(chain.find((e) => edgeKey(e) === 'P2>PB').confidence, 0.6)
  assert.equal(chain.find((e) => edgeKey(e) === 'PB>T').confidence, 0.8)
  assert.equal(chain.some((e) => e.from === 'T'), false, '终结点不得有后置')
  assert.equal(chain.some((e) => e.from === 'O'), false, '非实践模块的普通课程不产边')

  // 幂等：第二次合并（不同 now）逐字节一致
  const first = withPracticeChain({ nodes, edges: [], config: {}, now: 'T1' }).edges
  const second = withPracticeChain({ nodes, edges: first, config: {}, now: 'T2' }).edges
  assert.deepEqual(second, first)

  // 已有 agent 边不被降级 / 覆盖
  const agentCoreq = { from: 'P1', to: 'PB', kind: 'coreq', confidence: 0.9, evidence: '模型判定同修', source: 'agent' }
  const mixed = withPracticeChain({ nodes, edges: [agentCoreq], config: {}, now: 'T3' }).edges
  const kept = mixed.find((e) => edgeKey(e) === 'P1>PB')
  assert.equal(kept.kind, 'coreq')
  assert.equal(kept.source, 'agent')
})

test('practiceChainEdges：无编号时按首学期成链；非实践模块不产边；终结点全局识别', () => {
  const un = [
    mk('U1', '实习实践课', { name: '实践甲', semesters: ['2028-1'], grade: 3 }),
    mk('U2', '实习实践课', { name: '实践乙', semesters: ['2026-1'], grade: 1 }),
    mk('X', '专必课', { name: '普通专业课' }),
  ]
  const chain = practiceChainEdges(un, {})
  assert.deepEqual(chain.map((e) => edgeKey(e)), ['U2>U1'])
  assert.equal(chain[0].confidence, 0.55)

  // 终结点即使不在实践模块也收尾；实践链自动满足 W13
  const nodes = [
    mk('P1', '实习实践课', { name: '示例实践1' }),
    mk('P2', '实习实践课', { name: '示例实践2' }),
    mk('T', '专必课', { name: '毕业论文' }),
  ]
  const result = checkGraph(graphOf(nodes, practiceChainEdges(nodes, {})))
  assert.equal(result.warnings.some((w) => w.code === 'W13'), false)
  assert.equal(result.warnings.some((w) => w.code === 'W12'), false)
})

test('checkGraph：W11 孤儿 / W12 终结点后置 / W13 实践链断裂', () => {
  const nodes = [
    mk('P1', '实习实践课', { name: '示例实践1' }),
    mk('P2', '实习实践课', { name: '示例实践2' }),
    mk('T', '专必课', { name: '毕业论文' }),
    mk('X', '专必课', { name: '独立前沿专题' }),
  ]
  const broken = graphOf(nodes, [E('P2', 'T'), E('T', 'X')])
  const result = checkGraph(broken)
  assert.equal(result.errors.length, 0)
  assert.ok(result.warnings.some((w) => w.code === 'W11'))
  assert.ok(result.warnings.some((w) => w.code === 'W12'))
  assert.ok(result.warnings.some((w) => w.code === 'W13'))

  const fixed = checkGraph(graphOf(nodes, [E('P1', 'P2'), E('P2', 'T')]))
  assert.equal(fixed.warnings.some((w) => w.code === 'W12'), false)
  assert.equal(fixed.warnings.some((w) => w.code === 'W13'), false)
  assert.ok(fixed.warnings.some((w) => w.code === 'W11'))
  assert.equal(practiceStageNumber('示例实践1'), 1)
  assert.equal(practiceStageNumber('实践十一'), 11)
  assert.equal(practiceStageNumber('示例课程（二）上'), null)
})

// ---------------------------------------------------------------------------
// 7. 布局：dagre 分层 / coreq 同列 / 学期色带 / rankMode / 确定性
// ---------------------------------------------------------------------------

const placementSnapshot = (layout) =>
  JSON.stringify({
    size: layout.size,
    units: layout.units.map((u) => [u.id, u.col, u.x, u.y, u.h]),
    placements: layout.placements.map((p) => [p.id, p.col, p.x, p.y]),
    routes: layout.routes.map((r) => [r.key, r.type, r.points]),
    companions: layout.companions.map((c) => [c.key, c.x1, c.y1, c.y2]),
  })

const EXAMPLE = { nodes: exampleGraph.nodes, edges: exampleGraph.edges, config: {} }

function crossingCount(layout, shrink = 1) {
  const hits = []
  for (const route of layout.routes) {
    for (let i = 0; i < route.points.length - 1; i += 1) {
      const a = route.points[i]
      const b = route.points[i + 1]
      const x1 = Math.min(a.x, b.x)
      const x2 = Math.max(a.x, b.x)
      const y1 = Math.min(a.y, b.y)
      const y2 = Math.max(a.y, b.y)
      for (const card of layout.placements) {
        const rx1 = card.x + shrink
        const rx2 = card.x + card.w - shrink
        const ry1 = card.y + shrink
        const ry2 = card.y + card.h - shrink
        if (rx1 >= rx2 || ry1 >= ry2) continue
        if (x1 < rx2 && x2 > rx1 && y1 < ry2 && y2 > ry1) hits.push(`${route.key}#${i}→${card.id}`)
      }
    }
  }
  return hits
}

const denseFixture = () => {
  const nodes = []
  const edges = []
  for (let i = 0; i < 24; i += 1) {
    nodes.push(mk(`D${i}`, `模块${i % 3}`, { semesters: [`202${6 + (i % 3)}-${(i % 2) + 1}`], grade: (i % 3) + 1 }))
  }
  for (let i = 0; i < 20; i += 1) edges.push(E(`D${i}`, `D${i + 4}`))
  edges.push(E('D3', 'D1'), E('D0', 'D2', { kind: 'coreq' }), E('D5', 'D6', { kind: 'coreq' }))
  return { nodes, edges }
}

test('布局：example 结构性断言（单元 / 卡片 / 列 / 模块）且两次运行一致', () => {
  const layout = buildRouteLayout(EXAMPLE)
  assert.equal(layout.rankMode, 'dependency')
  assert.equal(layout.placements.length, exampleGraph.nodes.length)
  assert.equal(layout.units.length, 16, 'EX201 + SM202 因 coreq 合并为一个 unit')
  assert.equal(layout.colCount, 6)
  assert.ok(layout.modules.length > 0)
  for (const m of layout.modules) assert.ok(m.minCol <= m.maxCol && m.count > 0)
  assert.ok(layout.size.w > 0 && layout.size.h > 0)
  assert.equal(placementSnapshot(layout), placementSnapshot(buildRouteLayout(EXAMPLE)))
})

test('依赖模式：源节点全部落在第 0 列，非反向边的列号严格递增', () => {
  const layout = buildRouteLayout(EXAMPLE)
  const incoming = new Set()
  for (const edge of exampleGraph.edges) {
    if (edge.kind !== 'prereq') continue
    const a = layout.unitOf.get(edge.from)
    const b = layout.unitOf.get(edge.to)
    assert.ok(layout.colOfUnit.get(a) < layout.colOfUnit.get(b), `${edge.from}>${edge.to} 必须向右`)
    incoming.add(b)
  }
  for (const unit of layout.units) {
    if (!incoming.has(unit.id)) assert.equal(unit.col, 0, `源节点 ${unit.id} 必须在第 0 列`)
  }
})

test('rankMode=semester：unit 列号 = 首学期序号；无学期节点进末尾列', () => {
  const layout = buildRouteLayout({ ...EXAMPLE, config: { route: { rankMode: 'semester' } } })
  assert.equal(layout.rankMode, 'semester')
  assert.equal(layout.colCount, layout.semester.keys.length)
  assert.equal(layout.placeOf.get('SM101').col, layout.semester.keys.indexOf('2026-1'))
  assert.equal(layout.placeOf.get('SM402').col, layout.semester.keys.indexOf('2028-1'))

  const noSem = buildRouteLayout({
    nodes: [mk('A', 'M', { semesters: ['2026-1'] }), mk('B', 'M', { semesters: [], grade: null })],
    edges: [],
    config: { route: { rankMode: 'semester' } },
  })
  assert.equal(noSem.placeOf.get('A').col, 0)
  assert.equal(noSem.placeOf.get('B').col, noSem.colCount - 1)
})

test('列只由依赖决定（学期先后不影响）；excludeModules 整模块剔除', () => {
  const late = mk('P', '专选块', { semesters: ['2029-2'], grade: 4 })
  const early = mk('S', '专选块', { semesters: ['2026-1'], grade: 1 })
  const noEdge = buildRouteLayout({ nodes: [late, early], edges: [], config: {} })
  assert.equal(noEdge.placeOf.get('P').col, 0)
  assert.equal(noEdge.placeOf.get('S').col, 0)
  const withEdge = buildRouteLayout({ nodes: [late, early], edges: [E('P', 'S')], config: {} })
  assert.equal(withEdge.placeOf.get('P').col, 0)
  assert.equal(withEdge.placeOf.get('S').col, 1)

  const nodes = [mk('A', '甲'), mk('B', '乙'), mk('C', '丙')]
  const edges = [E('A', 'B'), E('B', 'C')]
  const custom = buildRouteLayout({ nodes, edges, config: { route: { columns: ['丙', '甲'] } } })
  const base = buildRouteLayout({ nodes, edges, config: {} })
  assert.deepEqual(custom.moduleOrder.slice(0, 2), ['丙', '甲'])
  assert.deepEqual([...custom.moduleOrder].sort(), [...base.moduleOrder].sort())
  assert.deepEqual(custom.routes.map((r) => r.key), base.routes.map((r) => r.key))

  const excluded = buildRouteLayout({ nodes, edges, config: { route: { excludeModules: ['乙'] } } })
  assert.equal(excluded.placeOf.has('B'), false)
  assert.equal(excluded.routes.some((r) => r.from === 'B' || r.to === 'B'), false)
})

test('无压卡性：折线段（端点除外）不进入任何卡片矩形（dependency 与 semester 都成立）', () => {
  const dense = denseFixture()
  const samples = [
    { label: 'example-dep', layout: buildRouteLayout(EXAMPLE) },
    { label: 'example-sem', layout: buildRouteLayout({ ...EXAMPLE, config: { route: { rankMode: 'semester' } } }) },
    { label: 'dense', layout: buildRouteLayout({ nodes: dense.nodes, edges: dense.edges, config: {} }) },
    { label: 'dense-sem', layout: buildRouteLayout({ nodes: dense.nodes, edges: dense.edges, config: { route: { rankMode: 'semester' } } }) },
  ]
  for (const { label, layout } of samples) {
    assert.deepEqual(crossingCount(layout), [], `${label}: 折线压到了卡片`)
  }
})

test('coreq：两端同列纵向堆叠 + 配套连接器；同一卡片同侧端口扇出', () => {
  const nodes = [mk('T', '甲'), mk('L', '甲'), mk('Z', '乙', { semesters: ['2027-1'], grade: 2 })]
  const edges = [E('T', 'L', { kind: 'coreq' }), E('T', 'Z')]
  const layout = buildRouteLayout({ nodes, edges, config: {} })
  assert.equal(layout.unitOf.get('T'), layout.unitOf.get('L'))
  assert.equal(layout.placeOf.get('T').col, layout.placeOf.get('L').col)
  assert.equal(layout.companions.length, 1)
  assert.equal(layout.companions[0].adjacent, true)
  assert.ok(layout.companions[0].y2 > layout.companions[0].y1)

  const chain = buildRouteLayout({
    nodes: [mk('A', '甲'), mk('B', '甲'), mk('C', '甲')],
    edges: [E('A', 'B', { kind: 'coreq' }), E('B', 'C', { kind: 'coreq' })],
    config: {},
  })
  assert.equal(chain.units.length, 1)
  assert.equal(chain.companions.length, 2)
  assert.equal(chain.routes.length, 0)

  const fan = [mk('P', '专选块'), mk('Q', '专选块'), mk('R', '专选块')]
  const fanLayout = buildRouteLayout({ nodes: fan, edges: [E('P', 'Q', { evidence: '扇出依据甲' }), E('P', 'R', { evidence: '扇出依据乙' })], config: {} })
  const ys = fanLayout.routes.filter((r) => r.from === 'P').map((r) => r.points[0].y).sort((a, b) => a - b)
  assert.equal(ys.length, 2)
  assert.notEqual(ys[0], ys[1])
  const card = fanLayout.placeOf.get('P')
  for (const y of ys) assert.ok(y > card.y && y < card.y + card.h)
})

test('学期标签 / ruler / gradeHints / semesterBand 只影响展示', () => {
  assert.equal(semesterLabelOf({ semesters: ['2026-1'], grade: 1 }), '大一上')
  assert.equal(semesterLabelOf({ semesters: ['2026-1', '2027-2'], grade: 1 }), '大一上–大二下')
  assert.equal(semesterLabelOf({ semesters: [], grade: null }), '')
  assert.equal(semesterIndexOf({ semesters: ['2027-1'], grade: 2 }, ['2026-1', '2027-1']), 1)
  assert.equal(semesterIndexOf({ semesters: [], grade: null }, ['2026-1']), -1)

  const layout = buildRouteLayout(EXAMPLE)
  assert.deepEqual(layout.semester.ruler.map((c) => c.label), ['大一上', '大一下', '大二上', '大二下', '大三上', '大三下'])
  assert.equal(layout.semester.labelOf('SM101'), '大一上')
  assert.equal(layout.semester.labelOf('SM205'), '大三上–大三下')

  const off = buildRouteLayout({ ...EXAMPLE, config: { route: { gradeHints: false, semesterBand: false } } })
  assert.equal(placementSnapshot(off), placementSnapshot(layout))
})

test('空布局：无节点时 size 为 0 且各集合为空', () => {
  const layout = buildRouteLayout({ nodes: [], edges: [], config: {} })
  assert.deepEqual(layout.size, { w: 0, h: 0 })
  assert.deepEqual(layout.placements, [])
  assert.deepEqual(layout.units, [])
  assert.deepEqual(layout.modules, [])
  assert.deepEqual(layout.routes, [])
  assert.deepEqual(layout.companions, [])
})

// ---------------------------------------------------------------------------
// 8. 走线图元（正交折线 / 箭头）
// ---------------------------------------------------------------------------

test('arrowHead / orthPath / simplifyPoints：闭合箭头路径 + 圆角正交折线', () => {
  const d = arrowHead([10, 10], [1, 0])
  assert.match(d, /^M [\d.-]+ [\d.-]+/)
  assert.ok(d.includes('L'))
  assert.ok(d.endsWith('Z'))

  assert.equal(simplifyPoints([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]).length, 3)
  const path = orthPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
  assert.match(path, / Q /)
  assert.ok(path.startsWith('M 0 0'))
})

test('走线：跨列边从源卡右侧到目标卡左侧（箭头向右）；环内反向边绕行（箭头向左）', () => {
  const layout = buildRouteLayout({ nodes: [mk('A', '甲'), mk('B', '乙')], edges: [E('A', 'B')], config: {} })
  assert.equal(layout.routes.length, 1)
  const route = layout.routes[0]
  assert.equal(route.type, 'forward')
  assert.equal(route.points[0].x, layout.placeOf.get('A').x + ROUTE_GEOMETRY.card.w)
  assert.equal(route.points[route.points.length - 1].x, layout.placeOf.get('B').x)
  assert.deepEqual(route.dir, [1, 0])

  const cycle = buildRouteLayout({ nodes: [mk('X', '甲'), mk('Y', '甲')], edges: [E('X', 'Y'), E('Y', 'X')], config: {} })
  const backward = cycle.routes.find((r) => r.type === 'backward')
  assert.ok(backward, '环内必有一条反向边')
  assert.deepEqual(backward.dir, [-1, 0])
  for (const r of cycle.routes) {
    for (const point of r.points) {
      assert.ok(point.x >= 0 && point.x <= cycle.size.w)
      assert.ok(point.y >= 0 && point.y <= cycle.size.h)
    }
  }
})

// ---------------------------------------------------------------------------
// 9. 可见性 / 聚焦
// ---------------------------------------------------------------------------

test('visibleEdges / computeFocus：≥阈值才可见，非 prereq/coreq 一律不可见', () => {
  const edges = [
    E('A', 'B', { confidence: 0.9 }),
    E('B', 'C', { confidence: 0.4 }),
    E('C', 'D', { confidence: 0.6 }),
    E('D', 'E', { kind: 'sequence', confidence: 0.9 }),
  ]
  const visible = visibleEdges(edges, { minConfidence: 0.6 })
  assert.deepEqual(visible.map(edgeKey), ['A>B', 'C>D'])
  assert.equal(visibleEdges(edges, { minConfidence: 0 }).length, 3, 'sequence 永远不可见')

  const focus = computeFocus(edges, 'C', { minConfidence: 0.6 })
  assert.deepEqual([...focus.allNext], ['D'])
  assert.deepEqual([...focus.allPrev], [])
  assert.deepEqual(focus.edges.map(edgeKey), ['C>D'])
})

// ---------------------------------------------------------------------------
// 10. schema v3 / graph-file / emptyGraph / buildRouteView
// ---------------------------------------------------------------------------

test('schema：v1 / v2 / v3 校验与可执行报错文案；v3 只允许 course 与 prereq/coreq', () => {
  assert.deepEqual(validateGraphShape({ version: 3, nodes: [], edges: [] }), [])
  for (const version of [1, 2, undefined]) {
    const errors = validateGraphShape({ version, nodes: [], edges: [] })
    assert.ok(errors.some((e) => e.includes('rebuild')))
    assert.ok(errors.some((e) => e.includes(VERSION_ERROR.slice(0, 10))))
  }
  const logicErrors = validateGraphShape({
    version: 3,
    nodes: [{ id: 'AND#00000001', kind: 'logic', op: 'and', semesters: [] }],
    edges: [],
  })
  assert.ok(logicErrors.some((e) => /逻辑节点已移除/.test(e)))
  const kindErrors = validateGraphShape({
    version: 3,
    nodes: [{ id: 'A', semesters: [] }],
    edges: [{ from: 'A', to: 'B', kind: 'sequence' }],
  })
  assert.ok(kindErrors.some((e) => /edges\[0\] kind 非法/.test(e)))
  assert.equal(EDGE_KINDS.length, 2)
})

test('graph-file：写盘升为 v3、不含 kind / op，round-trip 逐字节一致', () => {
  const normalized = normalizeGraphFile({
    ...exampleGraph,
    version: 2,
    nodes: exampleGraph.nodes.map((n) => ({ ...n, kind: 'course', op: null })),
  })
  assert.equal(normalized.version, 3)
  assert.equal('kind' in normalized.nodes[0], false)
  assert.equal('op' in normalized.nodes[0], false)
  const round = serializeGraph(normalized)
  assert.equal(round, serializeGraph(normalizeGraphFile(JSON.parse(round))))
})

test('emptyGraph：17 节点 + 自动实践链 rule 边，status 保持 nodes-only；buildRouteView 容错', () => {
  const graph = emptyGraph({ id: 'example', raw: exampleRaw, now: 'T' })
  assert.equal(graph.version, 3)
  assert.equal(graph.nodes.length, 17)
  assert.equal(graph.edges.length, 1)
  assert.equal(graph.edges[0].source, 'rule')
  assert.equal(graph.meta.status, 'nodes-only')

  const view = buildRouteView({ raw: exampleRaw, graph, config: {} })
  assert.equal(view.status, 'nodes-only')
  assert.equal(buildRouteLayout({ nodes: view.nodes, edges: view.edges, config: view.config }).placements.length, 17)

  const missing = buildRouteView({ raw: exampleRaw, graph: null, config: {} })
  assert.equal(missing.status, 'missing')
  assert.equal(missing.nodes.length, 17)
  assert.equal(missing.edges.length, 0)
  assert.equal(missing.minConfidence, 0.6)

  const configured = buildRouteView({ raw: exampleRaw, graph: null, config: { route: { minConfidence: 0.8 } } })
  assert.equal(configured.minConfidence, 0.8)

  const empty = buildRouteView({ raw: [], graph: null, config: {} })
  assert.equal(empty.nodes.length, 0)
  assert.deepEqual(buildRouteLayout({ nodes: empty.nodes, edges: empty.edges, config: empty.config }).units, [])
})

// ---------------------------------------------------------------------------
// 11. applyResults 细节 / checkGraph 细节
// ---------------------------------------------------------------------------

test('applyResults：废弃 logic 字段记 W10；分片名未知记 W7；固定 now 两次一致', () => {
  const base = graphOf(nodesOf(['A', 'B', 'C']), [])
  const withLogic = applyResults(base, [{
    stage: 'A',
    shard: 'M',
    edges: [E('A', 'B')],
    logic: [{ op: 'and', members: ['A', 'B'], targets: ['C'], confidence: 0.8, evidence: '废弃逻辑依据' }],
  }], { stage: 'A', shardNodeIds: { M: new Set(['A', 'B', 'C']) }, now: 'T' })
  assert.equal(withLogic.graph.edges.length, 1)
  assert.equal(withLogic.issues.filter((i) => i.code === 'W10').length, 1)

  const unknown = applyResults(graphOf(nodesOf(['A', 'B']), []), [{ stage: 'A', shard: '不存在', edges: [E('A', 'B')] }], {
    stage: 'A',
    shardNodeIds: { M: new Set(['A']) },
    now: 'T',
  })
  assert.equal(unknown.graph.edges.length, 1)
  assert.equal(unknown.issues.filter((i) => i.code === 'W7').length, 1)

  const opts = { stage: 'A', shardNodeIds: { M: new Set(['A', 'B']) }, now: 'FIXED' }
  const one = applyResults(base, [{ stage: 'A', shard: 'M', edges: [E('A', 'B')] }], opts).graph
  const two = applyResults(base, [{ stage: 'A', shard: 'M', edges: [E('A', 'B')] }], opts).graph
  assert.equal(serializeGraph(one), serializeGraph(two))
})

test('checkGraph：v3 只允许 course（E7），不再有 E6 / W8 / W9；W5 漂移与 W3 低置信', () => {
  const base = graphOf(nodesOf(['A', 'B', 'C']), [E('A', 'B'), E('B', 'C')])
  const clean = checkGraph(base)
  assert.equal(clean.errors.length, 0)
  const codes = [...clean.errors, ...clean.warnings].map((i) => i.code)
  for (const gone of ['E6', 'W8', 'W9']) assert.equal(codes.includes(gone), false)

  const bad = graphOf([...nodesOf(['A']), { id: 'OR#1', kind: 'logic', op: 'or', semesters: [], grade: null, styleKey: 'core', sourceHash: '' }], [])
  assert.equal(checkGraph(bad).errors.filter((e) => e.code === 'E7').length, 1)

  const raw = [row({ courseNumber: 'A', courseName: 'A课' }), row({ courseNumber: 'B', courseName: 'B课', initiationSemesterAnnotation: '2027-1' })]
  const { nodes } = extractNodes(raw)
  const drifted = nodes.map((n, i) => (i === 0 ? { ...n, sourceHash: 'deadbeef' } : n))
  const result = checkGraph(graphOf(drifted, [E('A', 'B', { confidence: 0.2 })]), { raw, minConfidence: 0.5 })
  assert.equal(result.warnings.filter((w) => w.code === 'W5').length, 1)
  assert.equal(result.warnings.filter((w) => w.code === 'W3').length, 1)
})

// ---------------------------------------------------------------------------
// 12. 迁移 / 隐私
// ---------------------------------------------------------------------------

test('migrateGraphToV3：丢弃 logic 节点 / sequence，保留 prereq + coreq，round-trip 稳定', () => {
  const legacy = {
    version: 2,
    id: 't',
    meta: { status: 'built' },
    nodes: [
      { id: 'A', name: 'A', code: 'A', module: 'M', semesters: ['2026-1'], grade: 1, styleKey: 'core', sourceHash: 'x', kind: 'course' },
      { id: 'AND#1', name: 'AND', kind: 'logic', op: 'and', semesters: [] },
      { id: 'B', name: 'B', code: 'B', module: 'M', semesters: ['2026-1'], grade: 1, styleKey: 'core', sourceHash: 'x', kind: 'course' },
      { id: 'C', name: 'C', code: 'C', module: 'M', semesters: ['2026-1'], grade: 1, styleKey: 'core', sourceHash: 'x', kind: 'course' },
    ],
    edges: [
      { from: 'A', to: 'B', kind: 'prereq', confidence: 0.8, evidence: '依赖依据甲', source: 'agent' },
      { from: 'A', to: 'C', kind: 'coreq', confidence: 0.7, evidence: '同修依据乙', source: 'agent' },
      { from: 'B', to: 'C', kind: 'sequence', confidence: 0.9, evidence: '顺序依据丙', source: 'agent' },
      { from: 'A', to: 'AND#1', kind: 'prereq', confidence: 0.9, evidence: '逻辑悬空依据', source: 'agent' },
    ],
    suppressed: [],
    issues: [],
  }
  const migrated = migrateGraphToV3(legacy)
  assert.equal(migrated.version, 3)
  assert.deepEqual(migrated.nodes.map((n) => n.id), ['A', 'B', 'C'])
  assert.deepEqual(migrated.edges.map((e) => e.kind).sort(), ['coreq', 'prereq'])
  assert.equal(migrated.edges.some((e) => e.to === 'AND#1'), false)
  assert.deepEqual(migrateGraphToV3(migrated), migrated)
})

test('隐私：mergeMapIndex local 覆盖同名 id；导入只写 index.local.json；入库 index.json 只含 example', async () => {
  const committed = [{ id: 'example', title: 'committed' }, { id: 'kept', title: 'kept' }]
  const local = [{ id: 'example', title: 'local' }, { id: 'demo', title: 'demo' }]
  assert.deepEqual(mergeMapIndex(committed, local), [
    { id: 'example', title: 'local' },
    { id: 'kept', title: 'kept' },
    { id: 'demo', title: 'demo' },
  ])
  assert.deepEqual(mergeMapIndex(null, local), local)

  const source = await fs.readFile(path.join(root, 'plugins', 'import-map.js'), 'utf8')
  assert.match(source, /index\.local\.json/)
  assert.equal(/fs\.writeFile\(indexPath/.test(source), false, '不得再写 index.json')

  const index = JSON.parse(await fs.readFile(path.join(root, 'data', 'maps', 'index.json'), 'utf8'))
  assert.deepEqual(index.map((e) => e.id), ['example'])
})

// ---------------------------------------------------------------------------
// 13. 导出安全守卫（唯一源码字符串守卫）
// ---------------------------------------------------------------------------

test('导出回归：RouteMap 用 presentation attribute、无 <marker>/<polygon>、无「--」注释', async () => {
  const source = await fs.readFile(path.join(root, 'src', 'components', 'RouteMap.vue'), 'utf8')
  assert.match(source, /:fill="styleOf\(p\.key\)\.fill"/)
  assert.match(source, /:stroke="styleOf\(p\.key\)\.stroke"/)
  assert.match(source, /:stroke-dasharray="styleOf\(p\.key\)\.dasharray"/)
  assert.match(source, /companionPaths/)
  assert.match(source, /route-semester-axis/)
  assert.match(source, /captureSvgStyles/)
  assert.match(source, /<Teleport/)
  assert.equal(/<marker\b/.test(source), false, '不能使用 <marker>：导出会变成巨大黑三角')
  assert.equal(/<polygon\b/.test(source), false, '箭头必须是 <path>')
  assert.equal(/scrollIntoView/.test(source), false, '点击聚焦不得触发页面滚动')

  const files = (await fs.readdir(path.join(root, 'src', 'components')))
    .filter((f) => f.endsWith('.vue'))
    .map((f) => path.join(root, 'src', 'components', f))
  files.push(path.join(root, 'src', 'App.vue'))
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    for (const match of text.matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.equal(match[1].includes('--'), false, `${path.basename(file)} 的 HTML 注释内容含「--」`)
    }
  }
})
