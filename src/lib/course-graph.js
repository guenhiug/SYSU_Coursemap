// 课程知识图谱：确定性层（纯函数，无判断）。
// 负责：raw rows → 节点抽取；任务包生成；agent 结果 → 图代数校验/合并/落盘结构；
//       路线图数据准备（全局分层布局在 src/data/route-layout.js）；点击聚焦的子图闭包。
// 本模块不依赖任何 Node 内置模块，浏览器（路线图视图）与 Node（scripts/kg.mjs）共用。
//
// 关系的「判断」完全由大模型 subagent 在工作流中完成（见 docs/kg-workflow.md），
// 本模块只做机械的抽取、校验与合并，避免用规则表猜先修关系。
//
// schema v3：节点只有课程（无 AND/OR 逻辑节点）；边只有 prereq（先修）与 coreq（同修）。

import { bandOf, createModuleStyleResolver } from '../data/palette.js'
import { extractRows, expandAnnotation, parseSemesterKey } from './normalize.js'

export const GRAPH_VERSION = 3

// 边类型：prereq 先修（实线 + 箭头）/ coreq 同修（虚线 + 箭头）。两类都绘制。
export const EDGE_KINDS = ['prereq', 'coreq']

// 边的来源：manual（人工，最高）> agent（模型判定）> rule（确定性规则，最低）。
// 合并同一条 (from,to) 时，来源优先级高的一侧决定 kind / source，confidence 取 max。
export const EDGE_SOURCE_PRIORITY = { manual: 2, agent: 1, rule: 0 }

export function edgeSourcePriority(source) {
  return EDGE_SOURCE_PRIORITY[source] ?? EDGE_SOURCE_PRIORITY.agent
}

// 节点类型：只有 course（课程）。v3 起逻辑节点（AND/OR 菱形）已移除。
export const NODE_KINDS = ['course']

// 模块显示顺序的内置缺省值（`route.columns` 的缺省值）：只影响图例顺序与列内同模块聚类顺序。
// 只列与渲染语义绑定的模块名；其余模块按数据首现顺序排列（不预设任何具体专业的模块结构）。
export const DEFAULT_MODULE_ORDER = ['平台课模块', '专业核心课', '专必课', '实习实践课']

// 无 courseSubClassModuleName 时用 courseTypeName 兜底的模块名。
export const MODULE_BY_TYPE = {
  平台课程: '平台课模块',
  专业课: '专业核心课',
  实践课: '实习实践课',
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

// FNV-1a 32 位，输出 8 位十六进制，用于节点漂移检测（稳定、无依赖）。
export function stableHash(input) {
  const s = String(input)
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// 参与 sourceHash 的行字段（名称/代码/模块/学分/学期注记）。
export function canonicalRow(row) {
  return [
    row?.courseName ?? '',
    row?.courseNumber ?? '',
    row?.courseSubClassModuleName ?? '',
    row?.courseTypeName ?? '',
    row?.courseCategoryName ?? '',
    row?.credit ?? '',
    row?.initiationSemesterAnnotation ?? '',
  ].join('\u0001')
}

export function sourceHashOf(row) {
  return stableHash(canonicalRow(row))
}

export function nodeIdOf(row) {
  return String(row?.courseNumber ?? '').trim() || String(row?.courseName ?? '').trim()
}

export function moduleOf(row) {
  return (
    row?.courseSubClassModuleName ||
    MODULE_BY_TYPE[row?.courseTypeName] ||
    row?.courseCategoryName ||
    '未分模块'
  )
}

// 路线图配色键：与海报保持同一套 styleKey 语义（platform / core / practice / mod-slot-N）。
export function styleKeyForNode(node, resolveModuleStyle) {
  const module = node?.module ?? ''
  const typeName = node?.typeName ?? ''
  if (node?.category === '专选') return resolveModuleStyle(module)
  if (module === '实习实践课' || typeName === '实践课') return 'practice'
  if (module === '平台课模块' || typeName === '平台课程') return 'platform'
  return 'core'
}

export function compareSemesterKey(a, b) {
  const pa = parseSemesterKey(a)
  const pb = parseSemesterKey(b)
  if (!pa && !pb) return String(a).localeCompare(String(b))
  if (!pa) return -1
  if (!pb) return 1
  return pa.year - pb.year || pa.num - pb.num
}

export function sortSemesterKeys(keys) {
  return [...new Set(keys)].sort(compareSemesterKey)
}

// 年级序号 = 学年 - 起始年 + 1（第 1 学年 = 大一）。
export function gradeOfSemesterKey(key, startYear) {
  const parsed = parseSemesterKey(key)
  if (!parsed || startYear == null) return null
  return parsed.year - startYear + 1
}

export function gradeLabel(grade) {
  const fixed = { 1: '大一', 2: '大二', 3: '大三', 4: '大四', 5: '大五', 6: '大六' }
  return fixed[grade] ?? `第${grade}学年`
}

// 学期标签：单学期「大一上」，跨学期「大一上–大四下」，无学期 → ''。
export function semesterLabelOf(node) {
  const sems = sortSemesterKeys(node?.semesters ?? [])
  if (!sems.length) return ''
  const grade = node?.grade
  const labelAt = (key) => {
    const parsed = parseSemesterKey(key)
    if (!parsed) return String(key)
    let g = null
    if (grade != null) {
      const base = parseSemesterKey(sems[0])
      g = base ? grade + (parsed.year - base.year) : grade
    }
    return `${g == null ? '' : gradeLabel(g)}${parsed.num === 1 ? '上' : '下'}`
  }
  const first = labelAt(sems[0])
  const last = labelAt(sems[sems.length - 1])
  return first === last ? first : `${first}–${last}`
}

// 节点首学期在 sortedKeys 中的下标；无学期 → -1。sortedKeys 可为数组或 Map(key→index)。
export function semesterIndexOf(node, sortedKeys) {
  const first = sortSemesterKeys(node?.semesters ?? [])[0]
  if (first == null) return -1
  if (sortedKeys instanceof Map) return sortedKeys.get(first) ?? -1
  if (Array.isArray(sortedKeys)) return sortedKeys.indexOf(first)
  return -1
}

function numericCode(node) {
  const m = /\d+/.exec(String(node?.code ?? ''))
  return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER
}

// 课程节点的稳定排序：年级 → 首学期 → 课码数字 → id。
export function compareCourseNodes(a, b) {
  const ga = a?.grade ?? Number.MAX_SAFE_INTEGER
  const gb = b?.grade ?? Number.MAX_SAFE_INTEGER
  if (ga !== gb) return ga - gb
  const sa = a?.semesters?.[0] ?? ''
  const sb = b?.semesters?.[0] ?? ''
  if (sa !== sb) return compareSemesterKey(sa, sb)
  return numericCode(a) - numericCode(b) || String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
}

// ---------------------------------------------------------------------------
// 节点抽取：bandOf(row) !== 1 的行（专必 + 专选，排除公必/公选）
// ---------------------------------------------------------------------------

export function extractNodes(raw, config = {}) {
  const rows = extractRows(raw)
  const resolveModuleStyle = createModuleStyleResolver(config.moduleOrder ?? [])
  const issues = []

  let startYear = null
  for (const row of rows) {
    for (const key of expandAnnotation(row?.initiationSemesterAnnotation)) {
      const year = parseSemesterKey(key)?.year
      if (year != null && (startYear == null || year < startYear)) startYear = year
    }
  }

  const groups = new Map()
  rows.forEach((row, index) => {
    if (bandOf(row) === 1) return
    const id = nodeIdOf(row)
    const keys = expandAnnotation(row?.initiationSemesterAnnotation)
    if (!id) {
      issues.push({
        code: 'W6',
        level: 'warning',
        nodeId: null,
        message: `课程既无 courseNumber 也无 courseName，已跳过（第 ${index + 1} 行）`,
      })
      return
    }
    if (!keys.length) {
      issues.push({
        code: 'W6',
        level: 'warning',
        nodeId: id || null,
        message: `缺少可解析的学期注记，已跳过：${row?.courseName ?? row?.courseNumber ?? '(未命名)'}`,
      })
      return
    }
    if (!groups.has(id)) groups.set(id, { id, rows: [] })
    groups.get(id).rows.push({ row, keys, index })
  })

  const nodes = []
  for (const group of groups.values()) {
    const first = group.rows[0].row
    const semesters = sortSemesterKeys(group.rows.flatMap((r) => r.keys))
    const modules = [...new Set(group.rows.map((r) => moduleOf(r.row)))]
    if (modules.length > 1) {
      issues.push({
        code: 'W4',
        level: 'warning',
        nodeId: group.id,
        message: `同码课程归属多个子模块：${group.id} → ${modules.join(' / ')}（按首次出现取「${modules[0]}」）`,
      })
    }
    const module = modules[0]
    const spanning = group.rows.some((r) => String(r.row?.initiationSemesterAnnotation ?? '').includes('~'))
    const category = first.courseCategoryName ?? ''
    const typeName = first.courseTypeName ?? ''
    nodes.push({
      id: group.id,
      name: first.courseName ?? '',
      code: String(first.courseNumber ?? '').trim(),
      module,
      typeName,
      category,
      credits: toNumber(first.credit),
      semesters,
      grade: gradeOfSemesterKey(semesters[0], startYear),
      spanning,
      styleKey: styleKeyForNode({ category, typeName, module }, resolveModuleStyle),
      sourceHash: stableHash(group.rows.map((r) => canonicalRow(r.row)).join('\u0002')),
    })
  }

  return { nodes, issues, startYear }
}

function toNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// 校验：硬错误 E1-E5（拒绝该边）/ 警告 W1-W7（保留并报告）
// ---------------------------------------------------------------------------

const asSet = (v) => (v instanceof Set ? v : new Set(v ?? []))

export function edgeKey(edge) {
  return `${edge?.from}>${edge?.to}`
}

const splitEvidence = (evidence) =>
  String(evidence ?? '')
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter(Boolean)

// 课程节点按 id 之外的原有顺序写入（写入时的固定顺序，保证逐字节确定性）。
export function sortNodes(nodes) {
  return [...(nodes ?? [])]
}

export function normalizeEdge(raw) {
  const confidence = Number(raw?.confidence)
  return {
    from: String(raw?.from ?? '').trim(),
    to: String(raw?.to ?? '').trim(),
    kind: String(raw?.kind ?? 'prereq').trim(),
    confidence: Number.isFinite(confidence) ? confidence : NaN,
    evidence: String(raw?.evidence ?? '').trim(),
    source: raw?.source === 'manual' ? 'manual' : raw?.source ?? 'agent',
    pass: raw?.pass ?? null,
    shard: raw?.shard ?? null,
    model: raw?.model ?? null,
    createdAt: raw?.createdAt ?? null,
  }
}

// 校验一批 agent 边。hard 错误剔除该边并计入 issues，W3 保留但警告。
export function validateEdges(edges, { nodeIds, shardNodeIds, minConfidence = 0 } = {}) {
  const ids = asSet(nodeIds)
  const shard = shardNodeIds ? asSet(shardNodeIds) : null
  const kept = []
  const issues = []
  const seen = new Set()

  for (const raw of edges ?? []) {
    const edge = normalizeEdge(raw)
    const key = edgeKey(edge)
    const hard = []
    if (!ids.has(edge.from)) hard.push(['E1', `先修边起点不存在于节点集合（悬空引用）：${edge.from || '(空)'}`])
    if (!ids.has(edge.to)) hard.push(['E1', `先修边终点不存在于节点集合（悬空引用）：${edge.to || '(空)'}`])
    if (shard && !(shard.has(edge.from) && shard.has(edge.to))) {
      hard.push(['E5', `Phase A 分片只接受片内边，跨模块边应交给 Phase B：${key}`])
    }
    if (edge.evidence.length < 4) hard.push(['E2', `evidence 缺失或少于 4 字：${key}`])
    if (!Number.isFinite(edge.confidence) || edge.confidence < 0 || edge.confidence > 1) {
      hard.push(['E3', `confidence 必须是 [0,1] 的数字：${key} → ${raw?.confidence}`])
    }
    if (!EDGE_KINDS.includes(edge.kind)) {
      hard.push(['E3', `kind 非法（${raw?.kind}）：${key}；v3 只允许 ${EDGE_KINDS.join(' / ')}`])
    }
    if (edge.from && edge.from === edge.to) hard.push(['E4', `自环边：${edge.from}`])
    if (seen.has(key)) hard.push(['E4', `重复边：${key}`])

    if (hard.length) {
      for (const [code, message] of hard) {
        issues.push({ code, level: 'error', edge: key, message })
      }
      continue
    }
    seen.add(key)
    if (edge.confidence < minConfidence) {
      issues.push({
        code: 'W3',
        level: 'warning',
        edge: key,
        message: `置信度 ${edge.confidence} 低于阈值 ${minConfidence}：${key}`,
      })
    }
    kept.push(edge)
  }

  return { kept, issues }
}

// SCC（Tarjan）：返回节点数 > 1 的强连通分量（即环路）。
export function stronglyConnectedComponents(nodeIds, edges) {
  const adj = new Map()
  for (const id of nodeIds) adj.set(id, [])
  for (const e of edges ?? []) {
    if (adj.has(e.from) && adj.has(e.to)) adj.get(e.from).push(e.to)
  }
  let counter = 0
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const out = []

  const visit = (v) => {
    index.set(v, counter)
    low.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)))
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = []
      let w
      do {
        w = stack.pop()
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      out.push(comp)
    }
  }

  for (const id of nodeIds) if (!index.has(id)) visit(id)
  return out.filter((c) => c.length > 1)
}

export function isOutOfOrder(edge, nodeById) {
  const from = nodeById?.get?.(edge.from) ?? nodeById?.[edge.from]
  const to = nodeById?.get?.(edge.to) ?? nodeById?.[edge.to]
  if (!from?.semesters?.length || !to?.semesters?.length) return false
  return compareSemesterKey(to.semesters[0], from.semesters[0]) < 0
}

// 实践课：模块名与终结点默认值（可被 config.route.practiceModule / terminalPatterns 覆盖）。
export const DEFAULT_PRACTICE_MODULE = '实习实践课'
export const DEFAULT_TERMINAL_PATTERNS = ['毕业论文', '毕业设计']

const CN_STAGE = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15,
}

// 课程名末尾的阶段编号（阿拉伯数字 / 中文数字）；无编号 → null。
export function practiceStageNumber(name) {
  const s = String(name ?? '').trim()
  const cn = /([一二三四五六七八九十]+)\s*$/.exec(s)
  if (cn) return CN_STAGE[cn[1]] ?? null
  const ar = /(\d+)\s*$/.exec(s)
  if (ar) return Number(ar[1])
  return null
}

// 罗马数字与中文数字不参与确定性实践链：链主干只认名称末尾的阿拉伯数字。
function arabicStageNumber(name) {
  const m = /(\d+)\s*$/.exec(String(name ?? '').trim())
  return m ? Number(m[1]) : null
}

function firstSemesterSortKey(node) {
  return sortSemesterKeys(node?.semesters ?? [])[0] ?? '\uffff'
}

// 确定性实践链：把「实习实践课」模块整模块串成**单条** prereq 链（source: "rule"）。
// 顺序 = 阿拉伯编号主干（N → N+1）→ 非编号课（按首学期）→ 终结点（按学期）收尾。
// 纯函数：只依据节点数据与 config，不读 DOM、不联网。
export function practiceChainEdges(nodes, config = {}) {
  const routeConfig = config?.route ?? config ?? {}
  const practiceModule = routeConfig.practiceModule ?? DEFAULT_PRACTICE_MODULE
  const terminalPatterns = routeConfig.terminalPatterns ?? DEFAULT_TERMINAL_PATTERNS
  const list = (nodes ?? []).filter((node) => node?.id)
  const isTerminal = (node) =>
    terminalPatterns.some(
      (pattern) => String(node?.name ?? '').includes(pattern) || String(node?.id ?? '').includes(pattern),
    )
  const bySemesterThenId = (a, b) =>
    compareSemesterKey(firstSemesterSortKey(a), firstSemesterSortKey(b)) || String(a.id).localeCompare(String(b.id))

  const terminals = list.filter(isTerminal).sort(bySemesterThenId)
  const terminalIds = new Set(terminals.map((node) => node.id))
  const practice = list
    .filter((node) => (node.module ?? '') === practiceModule && !terminalIds.has(node.id))
    .sort(bySemesterThenId)
  const numbered = practice
    .filter((node) => arabicStageNumber(node.name) != null)
    .sort((a, b) => arabicStageNumber(a.name) - arabicStageNumber(b.name) || bySemesterThenId(a, b))
  const unnumbered = practice.filter((node) => arabicStageNumber(node.name) == null)
  const hasBackbone = numbered.length > 0

  const ordered = [
    ...numbered.map((node) => ({ node, tier: 'numbered', stage: arabicStageNumber(node.name) })),
    ...unnumbered.map((node) => ({ node, tier: 'unnumbered', stage: null })),
    ...terminals.map((node) => ({ node, tier: 'terminal', stage: null })),
  ]

  const confidenceFor = (a, b) => {
    if (b.tier === 'terminal' || a.tier === 'terminal') return 0.8
    if (a.tier === 'numbered' && b.tier === 'numbered') return 0.85
    if (b.tier === 'unnumbered') return hasBackbone ? 0.6 : 0.55
    return 0.6
  }
  const evidenceFor = (a, b) => {
    if (b.tier === 'terminal') return `终结点前置（${practiceModule} → ${b.node.name}）`
    if (a.tier === 'numbered' && b.tier === 'numbered')
      return `实践课阶段链（${practiceModule}）：${a.node.name} → ${b.node.name}（阶段 ${a.stage} → ${b.stage}）`
    if (b.tier === 'unnumbered') return `实践课模块内按开课学期排序（${practiceModule}）：${a.node.name} → ${b.node.name}`
    return `实践课阶段链（${practiceModule}）：${a.node.name} → ${b.node.name}`
  }

  const out = []
  const seen = new Set()
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const a = ordered[i]
    const b = ordered[i + 1]
    if (!a.node?.id || !b.node?.id || a.node.id === b.node.id) continue
    const key = `${a.node.id}>${b.node.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      from: a.node.id,
      to: b.node.id,
      kind: 'prereq',
      confidence: confidenceFor(a, b),
      evidence: evidenceFor(a, b),
      source: 'rule',
      pass: null,
      shard: null,
      model: null,
      createdAt: null,
    })
  }
  return out
}

// 把确定性实践链合并进边集合（按来源优先级合并，幂等：重复运行结果逐字节一致）。
export function withPracticeChain({ nodes, edges = [], config = {}, now } = {}) {
  const byKey = new Map()
  for (const edge of edges ?? []) {
    if (!edge?.from || !edge?.to) continue
    const normalized = normalizeEdge(edge)
    const key = edgeKey(normalized)
    const prev = byKey.get(key)
    byKey.set(key, prev ? mergeEdges(prev, normalized) : normalized)
  }
  const at = now ?? null
  for (const edge of practiceChainEdges(nodes, config)) {
    const incoming = { ...edge, createdAt: edge.createdAt ?? at }
    const key = edgeKey(incoming)
    const prev = byKey.get(key)
    byKey.set(key, prev ? mergeEdges(prev, incoming) : incoming)
  }
  return { edges: sortEdges([...byKey.values()]) }
}

// 全图检查：硬错误 + 警告（含可选 raw 漂移检测）。
export function checkGraph(graph, { raw, minConfidence = 0, config = {} } = {}) {
  const nodes = graph?.nodes ?? []
  const nodeIds = new Set(nodes.map((n) => n.id))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const errors = []
  const warnings = []

  const { kept, issues } = validateEdges(graph?.edges ?? [], { nodeIds, minConfidence: 0 })
  for (const issue of issues) (issue.level === 'error' ? errors : warnings).push(issue)

  const cycles = stronglyConnectedComponents(nodeIds, kept)
  for (const comp of cycles) {
    warnings.push({
      code: 'W1',
      level: 'warning',
      nodes: comp,
      message: `检测到环路（${comp.length} 个节点）：${comp.join(' → ')}`,
    })
  }

  for (const edge of kept) {
    // W2 只针对模型/人工边：确定性实践链（rule）按课程系列阶段排序，
    // 跨学年长课（spanning 实践课）可能因此晚于编号主干，属于预期行为。
    if (edge.source !== 'rule' && isOutOfOrder(edge, nodeById)) {
      warnings.push({
        code: 'W2',
        level: 'warning',
        edge: edgeKey(edge),
        message: `逆时序边（目标学期早于源）：${edgeKey(edge)}`,
      })
    }
    if (edge.confidence < minConfidence) {
      warnings.push({
        code: 'W3',
        level: 'warning',
        edge: edgeKey(edge),
        message: `置信度 ${edge.confidence} 低于阈值 ${minConfidence}：${edgeKey(edge)}`,
      })
    }
  }

  for (const issue of graph?.issues ?? []) {
    if (issue.level === 'error') errors.push(issue)
    else warnings.push(issue)
  }

  // 节点类型（E7）：v3 只允许 course；kind 缺省视为 course，显式非 course 报错。
  for (const node of nodes) {
    const kind = node.kind ?? 'course'
    if (!NODE_KINDS.includes(kind)) {
      errors.push({
        code: 'E7',
        level: 'error',
        nodeId: node.id,
        message: `节点 kind 非法（${node.kind}）：${node.id}；v3 已移除逻辑节点，请运行 rebuild --replace 并重跑工作流`,
      })
    }
  }

  if (raw) {
    const fresh = extractNodes(raw, graph?.config ?? {})
    const freshById = new Map(fresh.nodes.map((n) => [n.id, n]))
    for (const node of nodes) {
      const now = freshById.get(node.id)
      if (!now) {
        warnings.push({ code: 'W5', level: 'warning', nodeId: node.id, message: `节点已不在数据中：${node.id} ${node.name}` })
      } else if (now.sourceHash !== node.sourceHash) {
        warnings.push({ code: 'W5', level: 'warning', nodeId: node.id, message: `节点与原始数据不一致（需 rebuild）：${node.id} ${node.name}` })
      }
    }
  }

  // ---- W11 孤儿课程 / W12 终结点后置 / W13 实践课阶段链 ----
  const routeConfig = config?.route ?? config ?? {}
  const practiceModule = routeConfig.practiceModule ?? DEFAULT_PRACTICE_MODULE
  const terminalPatterns = routeConfig.terminalPatterns ?? DEFAULT_TERMINAL_PATTERNS
  const isTerminal = (node) =>
    terminalPatterns.some(
      (pattern) => String(node?.name ?? '').includes(pattern) || String(node?.id ?? '').includes(pattern),
    )

  const linked = new Set()
  for (const edge of kept) {
    linked.add(edge.from)
    linked.add(edge.to)
  }
  const orphans = nodes.filter((node) => !linked.has(node.id)).map((node) => node.id)
  if (orphans.length) {
    warnings.push({
      code: 'W11',
      level: 'warning',
      nodes: orphans,
      message: `存在无任何前后置关系的课程（${orphans.length}）：${orphans.join(', ')}`,
    })
  }

  for (const edge of kept) {
    const from = nodeById.get(edge.from)
    if (from && isTerminal(from)) {
      warnings.push({
        code: 'W12',
        level: 'warning',
        edge: edgeKey(edge),
        message: `终结点（毕业论文 / 毕业设计）不应有后置：${edgeKey(edge)}`,
      })
    }
  }

  const practiceStages = new Map()
  for (const node of nodes) {
    if ((node.module ?? '') !== practiceModule) continue
    const stage = practiceStageNumber(node.name)
    if (stage != null && !practiceStages.has(stage)) practiceStages.set(stage, node)
  }
  const stageKeys = [...practiceStages.keys()].sort((a, b) => a - b)
  for (let i = 1; i < stageKeys.length; i += 1) {
    if (stageKeys[i] !== stageKeys[i - 1] + 1) continue
    const prev = practiceStages.get(stageKeys[i - 1])
    const next = practiceStages.get(stageKeys[i])
    if (!kept.some((edge) => edge.from === prev.id && edge.to === next.id)) {
      warnings.push({
        code: 'W13',
        level: 'warning',
        edge: `${prev.id}>${next.id}`,
        message: `实践课阶段链缺 prereq（${practiceModule}）：${prev.id} ${prev.name} → ${next.id} ${next.name}`,
      })
    }
  }
  for (const node of nodes) {
    if (isTerminal(node) && !kept.some((edge) => edge.to === node.id)) {
      warnings.push({
        code: 'W13',
        level: 'warning',
        nodeId: node.id,
        message: `终结点缺少前置（不可达）：${node.id} ${node.name}`,
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

// 删环：反复取出环路（SCC）中置信度最低的边，直到无环。返回 { edges, removed }。
export function removeCycleEdges(edges, nodeIds) {
  let current = [...(edges ?? [])]
  const removed = []
  for (let guard = 0; guard < 1000; guard += 1) {
    const cycles = stronglyConnectedComponents(nodeIds, current)
    if (!cycles.length) break
    const inCycle = new Set(cycles.flat())
    const candidates = current.filter((e) => inCycle.has(e.from) && inCycle.has(e.to))
    if (!candidates.length) break
    let weakest = candidates[0]
    for (const edge of candidates) {
      if ((edge.confidence ?? 0) < (weakest.confidence ?? 0)) weakest = edge
    }
    current = current.filter((e) => e !== weakest)
    removed.push(weakest)
  }
  return { edges: current, removed }
}

// 传递约简（默认关闭：模型边的语义未必等价于可达性）。仅作用于 prereq 边。
export function transitiveReduce(edges) {
  const list = [...(edges ?? [])]
  const prereq = list.filter((e) => e.kind === 'prereq')
  const rest = list.filter((e) => e.kind !== 'prereq')
  const order = prereq
    .map((e, i) => [e, i])
    .sort((a, b) => (b[0].confidence ?? 0) - (a[0].confidence ?? 0))

  const adj = new Map()
  const connected = (from, to) => {
    const seen = new Set()
    const queue = [...(adj.get(from) ?? [])]
    while (queue.length) {
      const id = queue.pop()
      if (id === to) return true
      if (seen.has(id)) continue
      seen.add(id)
      for (const next of adj.get(id) ?? []) if (!seen.has(next)) queue.push(next)
    }
    return false
  }

  const keep = new Set()
  const removed = []
  for (const [edge, idx] of order) {
    if (connected(edge.from, edge.to)) {
      removed.push(edge)
      continue
    }
    keep.add(idx)
    if (!adj.has(edge.from)) adj.set(edge.from, [])
    adj.get(edge.from).push(edge.to)
  }

  const kept = prereq.filter((_, i) => keep.has(i))
  return { edges: [...kept, ...rest], removed }
}

// ---------------------------------------------------------------------------
// 合并 / apply
// ---------------------------------------------------------------------------

export function mergeEdges(existing, incoming) {
  if (!existing) return { ...incoming }
  const evidence = []
  for (const part of [...splitEvidence(existing.evidence), ...splitEvidence(incoming.evidence)]) {
    if (!evidence.includes(part)) evidence.push(part)
  }
  const passes = [...new Set([existing.pass, incoming.pass].filter(Boolean))]
  // 来源优先级：高点位的一侧决定 kind / source；同级保留 existing。
  const pe = edgeSourcePriority(existing.source)
  const pi = edgeSourcePriority(incoming.source)
  const primary = pi > pe ? incoming : existing
  return {
    ...existing,
    kind: primary.kind,
    confidence: Math.max(existing.confidence ?? 0, incoming.confidence ?? 0),
    evidence: evidence.join('；'),
    source: primary.source,
    pass: passes.join('+') || null,
    shard: existing.shard ?? incoming.shard ?? null,
    model: existing.model ?? incoming.model ?? null,
    createdAt: existing.createdAt ?? incoming.createdAt ?? null,
  }
}

function sortEdges(edges) {
  return [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
}

// 把一批 agent 结果（仅 edges）合并进图谱（纯函数，不落盘）。
export function applyResults(graph, results, { stage = 'A', minConfidence = 0, shardNodeIds = {}, now } = {}) {
  const allNodes = graph?.nodes ?? []
  const courseNodes = allNodes.filter((n) => (n.kind ?? 'course') === 'course')
  const courseById = new Map(courseNodes.map((n) => [n.id, n]))
  const byKey = new Map()
  for (const edge of graph?.edges ?? []) byKey.set(edgeKey(edge), { ...edge })

  const issues = []
  const stats = { read: 0, kept: 0, rejected: 0, added: 0, merged: 0, suppressed: 0 }
  const passes = []
  const at = now ?? new Date().toISOString()

  for (const result of results ?? []) {
    stats.read += 1
    const shard = result?.shard ?? null

    // v3 起结果文件不再有 logic；若旧结果/手写结果仍带 logic，忽略并警告，不阻塞 apply。
    if (Array.isArray(result?.logic) && result.logic.length) {
      issues.push({
        code: 'W10',
        level: 'warning',
        pass: stage,
        shard,
        message: `结果含已废弃的 logic 字段（${result.logic.length} 组），v3 已移除逻辑节点，已忽略；请改用 prereq / coreq 边表达`,
      })
    }

    // Phase A：只接受两端都在本片节点集合内的边（E5）。分片名未知时无法约束，降级为全局校验并记警告。
    const knownShard = stage === 'A' ? shardNodeIds[shard] : null
    if (stage === 'A' && !knownShard) {
      issues.push({
        code: 'W7',
        level: 'warning',
        pass: stage,
        shard,
        message: `结果的分片名不在本次任务包中（${shard ?? 'null'}），只能做全局校验；请确认 shard 字段或文件名`,
      })
    }

    const { kept, issues: batchIssues } = validateEdges(result?.edges ?? [], {
      nodeIds: new Set(courseById.keys()),
      shardNodeIds: knownShard ?? null,
      minConfidence,
    })
    for (const issue of batchIssues) issues.push({ ...issue, pass: stage, shard })
    stats.rejected += (result?.edges ?? []).length - kept.length
    stats.kept += kept.length

    for (const edge of kept) {
      const enriched = {
        ...edge,
        source: edge.source === 'manual' ? 'manual' : 'agent',
        pass: stage,
        shard: shard ?? edge.shard ?? null,
        model: result?.model ?? edge.model ?? null,
        createdAt: at,
      }
      const key = edgeKey(enriched)
      const prev = byKey.get(key)
      if (prev) {
        byKey.set(key, mergeEdges(prev, enriched))
        stats.merged += 1
      } else {
        byKey.set(key, enriched)
        stats.added += 1
      }
    }
    passes.push({ stage, shard, model: result?.model ?? null, at })
  }

  const suppressed = new Set(graph?.suppressed ?? [])
  const mergedEdges = [...byKey.values()]
  const edges = mergedEdges.filter((e) => !(suppressed.has(edgeKey(e)) && e.source !== 'manual'))
  stats.suppressed = mergedEdges.length - edges.length

  const prevPasses = graph?.meta?.passes ?? []
  const passKey = (p) => `${p.stage}|${p.shard}`
  const passMap = new Map(prevPasses.map((p) => [passKey(p), p]))
  for (const p of passes) passMap.set(passKey(p), p)

  const next = {
    version: GRAPH_VERSION,
    id: graph?.id ?? null,
    meta: {
      ...(graph?.meta ?? {}),
      status: edges.some((e) => e.source !== 'rule') ? 'built' : 'nodes-only',
      builtAt: at,
      passes: [...passMap.values()],
    },
    nodes: sortNodes(courseNodes),
    edges: sortEdges(edges),
    suppressed: graph?.suppressed ?? [],
    issues: dedupeIssues([...(graph?.issues ?? []), ...issues]),
  }
  return { graph: next, issues, stats }
}

function dedupeIssues(issues) {
  const seen = new Set()
  const out = []
  for (const issue of issues ?? []) {
    const key = `${issue.code}|${issue.edge ?? ''}|${issue.nodeId ?? ''}|${issue.message ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(issue)
  }
  return out
}

// ---------------------------------------------------------------------------
// 任务包（pack）
// ---------------------------------------------------------------------------

export const EDGE_TAXONOMY = {
  prereq: '先修：必须先修完 from 才能修 to（有明确的知识依赖或培养方案先修要求）',
  coreq: '同修：需在同一学期或相邻学期同时修读，互为支撑',
}

export const PACKET_INSTRUCTIONS = `你是课程先修关系判定专家。请只依据提供的课程信息（课程名、代码、模块、学分、开课学期）与真实的学科培养逻辑，判断课程之间的有向关系。

请严格按以下顺序操作：

第 1 步 · 先归并「课程系列」（这是最重要的一步，不要跳过）：
  同一课程系列指基底名相同、仅层级标记不同的一组课，例如：
  - 上 / 下、I / II、一 / 二、1 / 2（如「示例课（上）」与「示例课（下）」）；
  - 理论课与其配套的实验/实践课（如「示例理论课」与「示例理论课实验」）；
  - 「X 基础」与「X 进阶」这类同一知识线的递进课。
  先把 nodes 里的课程按系列分组，再在组内判断关系。

第 2 步 · 同一层级的系列成员 → coreq（同修）：
  相互配套、通常同学期或相邻学期修读、彼此提供支撑的课（理论 + 对应实验/实践，或同层级的上下篇）。
  例：示例理论课 + 示例理论课实验 → coreq。

第 3 步 · 层级递进 → prereq（先修）：
  上 → 下、I → II、一 → 二、基础 → 进阶、理论 → 应用、实验一 → 实验二的递进关系。
  from 是较前/较基础的课，to 是较后/较进阶的课。

第 4 步 · 判定依据的优先级（务必遵守）：
  1) 课程内容本身的知识依赖（最强、最优先）；
  2) 开课学期的先后（仅作参考，用于印证，不作为唯一依据）；
  3) 课程编号（仅供参考；编号大小与先后没有必然关系，前置课的编号可能更大，禁止仅凭编号大小定方向）。

第 5 步 · 边界与质量：
  - Phase A 只输出两端都出现在本任务包 nodes 中的边；context.allNodes 用于识别跨模块课程，但本阶段不要输出跨模块边（交给 Phase B）。
  - 不要把同一模块里的课程串成一条链，不要因为「同模块」就造边。
  - 不确定的宁可不输出（宁缺毋滥）。

第 6 步 · 理论课 / 实验课 / 基础课规则（最容易判错，务必逐条执行）：
  - 实验 / 实践 / 上机 / 实习课与其**对应的理论课**一律用 coreq（同修）：理论课 ↔ 配套实验课，**不得写成 prereq**。
  - 一门「整合实验 / 综合实验」同时支撑多门理论课时，对每一门理论课**各建一条 coreq**
    （例：「示例整合实验」↔「示例理论I」、「示例整合实验」↔「示例理论II」）。
  - 只有实验课自身的阶段递进（实验一 → 实验二、基础实验 → 综合实验、实践1 → 实践2）才用 prereq。
  - 实习实践课中带阶段编号的课程（如「实践1」「实践2」）按编号/阶段构成 prereq 链：N → N+1。
  - 毕业论文 / 毕业设计是终结点：它只能作为 to（被别人指向），**不得作为 from 输出任何后置边**。
  - 平台课模块课程与大一专业基础课（数学 / 物理 / 化学 / 生物类基础课…）是后续专业模块课程的
    **起始前置**，必须补出「基础课 → 专业应用课」的 prereq
    （如 基础数学 → 专业计算/建模课、基础物理 → 专业方向课）。

第 7 步 · 字段要求：
  - kind 只能是 prereq（先修）或 coreq（同修）；含义：${EDGE_TAXONOMY.prereq}；${EDGE_TAXONOMY.coreq}。
  - confidence ∈ [0,1]。明确的 0.85~0.95；有较强依据 0.6~0.8；仅为推测 0.4~0.6（允许输出但会被 UI 按阈值隐藏，不得为了「凑数」而编造）。
  - evidence 必须写明依据（引用课程名/代码或具体知识结构），至少 4 个字，不得为空。
  - from 是前置，to 是后继；自环与重复边会被丢弃。

输出要求：只输出一个 JSON 对象，不要包裹代码块或额外文字，schema 如下：
{ "schemaVersion": 3, "stage": "<A|B>", "mapId": "<地图 id>", "shard": "<分片名>",
  "edges": [ { "from": "<id>", "to": "<id>", "kind": "prereq|coreq", "confidence": 0.8, "evidence": "依据说明" } ],
  "notes": "可选：疑难点与不确定处" }`

export const ORPHAN_INSTRUCTIONS = `【本分片为 Stage C · 孤儿课程补边】
上一轮工作流结束后，仍有课程没有任何前后置关系（context.orphanIds）。请专门为这些「孤儿课程」补出关系：

  1. 每门孤儿课**至少产出一条 prereq**（作为 to，被别的课指向），并优先挂到平台课程 / 专业核心课之后：
     from = 平台课或专业核心课，to = 孤儿课。
  2. 孤儿课若明显是某门平台课 / 大一基础课（数学 / 物理 / 化学 / 生物类基础课…）的后继，
     就挂到该基础课之后（from = 基础课）。
  3. 可以基于知识依赖把多门孤儿课串成链（前一门 → 后一门），但不要为了「凑边」而编造。
  4. 确实找不到任何依据的孤儿课，**留空即可**，并在 notes 中逐条说明原因（例如「独立前沿专题，无先修依赖」）。
  5. 同样遵守前面的实践课规则：实习实践课按阶段编号 N → N+1；毕业论文/毕业设计是终结点，不得有后置；
     理论课与其配套实验用 coreq。实习实践课模块的前后置关系已由确定性规则链生成，通常不会成为孤儿。
  6. 依据优先级：课程内容的知识依赖 > 开课学期先后（仅参考）> 课程编号（仅供参考）。

输出 schema 与其余阶段完全一致（schemaVersion 3，stage 填 "C"，shard 填 "__orphans__"）。`

function compactNode(node) {
  return {
    id: node.id,
    name: node.name,
    code: node.code,
    module: node.module,
    semesters: [...(node.semesters ?? [])],
    grade: node.grade,
  }
}

function groupShards(nodes) {
  const map = new Map()
  for (const node of nodes) {
    const shard = node.module || '未分模块'
    if (!map.has(shard)) map.set(shard, [])
    map.get(shard).push(node)
  }
  return map
}

export function packetFileName(stage, shard) {
  const s = String(stage).toUpperCase()
  if (s === 'A') return `packet.A.${shard}.json`
  return `packet.${s}.json`
}

export function resultFileName(stage, shard) {
  const s = String(stage).toUpperCase()
  if (s === 'A') return `result.A.${shard}.json`
  return `result.${s}.json`
}

// 没有任何 prereq / coreq 关联的课程。
export function orphanNodes(graph) {
  const linked = new Set()
  for (const edge of graph?.edges ?? []) {
    if (edge?.from) linked.add(edge.from)
    if (edge?.to) linked.add(edge.to)
  }
  return (graph?.nodes ?? []).filter((node) => node?.id && !linked.has(node.id))
}

export function buildPackets(graph, { stage = 'A', outDir = `out/kg/${graph?.id ?? 'map'}` } = {}) {
  const nodes = graph?.nodes ?? []
  const mapId = graph?.id ?? 'map'
  const s = String(stage).toUpperCase()

  if (s === 'A') {
    return [...groupShards(nodes)].map(([shard, list]) => ({
      schemaVersion: 3,
      stage: 'A',
      mapId,
      shard,
      instructions: PACKET_INSTRUCTIONS,
      taxonomy: { kinds: EDGE_TAXONOMY },
      nodes: list,
      context: {
        allNodes: nodes.map(compactNode),
        stageAEdges: [],
      },
      packetPath: `${outDir}/${packetFileName('A', shard)}`,
      outputPath: `${outDir}/${resultFileName('A', shard)}`,
    }))
  }

  // Stage C：只针对「孤儿课程」（无任何前后置关系）的补边任务包（单包）。
  if (s === 'C') {
    const orphans = orphanNodes(graph)
    if (!orphans.length) return []
    return [
      {
        schemaVersion: 3,
        stage: 'C',
        mapId,
        shard: '__orphans__',
        instructions: `${PACKET_INSTRUCTIONS}\n\n${ORPHAN_INSTRUCTIONS}`,
        taxonomy: { kinds: EDGE_TAXONOMY },
        nodes: orphans,
        context: {
          allNodes: nodes.map(compactNode),
          existingEdges: (graph?.edges ?? []).map((e) => ({
            key: edgeKey(e),
            kind: e.kind,
            confidence: e.confidence,
            evidence: e.evidence,
          })),
          orphanIds: orphans.map((n) => n.id),
        },
        packetPath: `${outDir}/${packetFileName('C')}`,
        outputPath: `${outDir}/${resultFileName('C')}`,
      },
    ]
  }

  const stageAEdges = (graph?.edges ?? [])
    .filter((e) => e.source !== 'manual')
    .map((e) => ({ key: edgeKey(e), kind: e.kind, confidence: e.confidence, evidence: e.evidence }))

  return [
    {
      schemaVersion: 3,
      stage: 'B',
      mapId,
      shard: '__all__',
      instructions: `${PACKET_INSTRUCTIONS}

【本分片为 Phase B 全局汇总】除了补充遗漏的片内关系，重点产出 Phase A 未覆盖的「跨模块」关系：不同子模块之间真实存在的前后置依赖（如 计算机 ↔ 数学、化学 ↔ 生命科学、物理 ↔ 数学）。context.stageAEdges 是 Phase A 已产出的边，请勿重复输出完全相同的 (from,to)；如需修正 Phase A 的判断，可在 notes 中说明。跨模块关系同样遵守上面的第 1~6 步。

尤其不要漏掉两类**跨模块 / 跨学期但必须输出**的高置信关系：
  - 「平台课 / 大一专业基础课（数学 / 物理 / 化学 / 生物类基础课…）→ 后续专业应用课」的 prereq；
  - 「整合实验 / 综合实验 ↔ 多门理论课」的 coreq（一门实验对每门理论课各建一条）。
不要因为「跨模块」或「跨学期」就省略这些关系。`,
      taxonomy: { kinds: EDGE_TAXONOMY },
      nodes,
      context: {
        allNodes: nodes.map(compactNode),
        stageAEdges,
      },
      packetPath: `${outDir}/${packetFileName('B')}`,
      outputPath: `${outDir}/${resultFileName('B')}`,
    },
  ]
}

// 按分片名收集该分片的节点 id 集合（apply --stage a 的 E5 校验用）。
export function shardNodeIds(graph) {
  const out = {}
  for (const [shard, list] of groupShards(graph?.nodes ?? [])) {
    out[shard] = new Set(list.map((n) => n.id))
  }
  return out
}

// ---------------------------------------------------------------------------
// 页面数据准备（图谱缺失 / nodes-only 均不抛错）
// 全局分层布局（列分配 / 列内排序 / 走线）在 src/data/route-layout.js：本模块不反向 import，避免循环。
// ---------------------------------------------------------------------------

export function buildRouteView({ raw, graph, config = {} } = {}) {
  const routeConfig = config.route ?? {}
  let nodes = graph?.nodes ?? null
  let issues = graph?.issues ?? []
  let status = graph?.meta?.status ?? (graph ? 'nodes-only' : 'missing')

  if (!nodes?.length) {
    const extracted = extractNodes(raw ?? [], config)
    nodes = extracted.nodes
    issues = extracted.issues
    if (!graph) status = 'missing'
  }

  const edges = graph?.edges ?? []

  return {
    status,
    nodes,
    edges,
    suppressed: graph?.suppressed ?? [],
    issues,
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    config: routeConfig,
    minConfidence: routeConfig.minConfidence ?? 0.6,
  }
}

// ---------------------------------------------------------------------------
// 边的可见性与点击聚焦
// ---------------------------------------------------------------------------

// 只保留 prereq / coreq 且置信度 ≥ 阈值的边（UI 与聚焦闭包共用同一套阈值）。
export function visibleEdges(edges, { minConfidence = 0, nodeById } = {}) {
  return (edges ?? []).filter((edge) => {
    if (!EDGE_KINDS.includes(edge.kind)) return false
    if (!(Number(edge.confidence) >= minConfidence)) return false
    void nodeById
    return true
  })
}

function closure(start, adj) {
  const out = new Set()
  const queue = [...(adj.get(start) ?? [])]
  while (queue.length) {
    const id = queue.pop()
    if (out.has(id)) continue
    out.add(id)
    for (const next of adj.get(id) ?? []) if (!out.has(next)) queue.push(next)
  }
  return out
}

// 点击 id：返回直接/全部前序与后续，以及子图内可见边。
export function computeFocus(edges, id, { minConfidence = 0, nodeById } = {}) {
  const visible = visibleEdges(edges, { minConfidence, nodeById })
  const prevAdj = new Map()
  const nextAdj = new Map()
  for (const edge of visible) {
    if (!nextAdj.has(edge.from)) nextAdj.set(edge.from, [])
    nextAdj.get(edge.from).push(edge.to)
    if (!prevAdj.has(edge.to)) prevAdj.set(edge.to, [])
    prevAdj.get(edge.to).push(edge.from)
  }
  const allPrev = closure(id, prevAdj)
  const allNext = closure(id, nextAdj)
  const directPrev = new Set(prevAdj.get(id) ?? [])
  const directNext = new Set(nextAdj.get(id) ?? [])
  const related = new Set([id, ...allPrev, ...allNext])
  const subEdges = visible.filter((e) => related.has(e.from) && related.has(e.to))
  return { id, directPrev, directNext, allPrev, allNext, related, edges: subEdges }
}

// 从 index.json 条目推导图谱文件路径。
export function graphPathOf(entry) {
  if (!entry) return null
  if (entry.graph) return entry.graph
  if (!entry.id) return null
  return `/maps/${entry.id}.graph.json`
}

// 合并「入库清单」与「本地清单」：local 覆盖同名 id，其余 local 条目按顺序追加。
export function mergeMapIndex(committed, local) {
  const base = Array.isArray(committed) ? committed : []
  const extra = Array.isArray(local) ? local : []
  const localById = new Map(extra.filter((e) => e?.id).map((e) => [e.id, e]))
  const merged = base.map((entry) => (entry?.id && localById.has(entry.id) ? localById.get(entry.id) : entry))
  const baseIds = new Set(base.map((e) => e?.id).filter(Boolean))
  for (const entry of extra) {
    if (entry?.id && baseIds.has(entry.id)) continue
    merged.push(entry)
  }
  return merged
}

// 空图（nodes-only）：导入时写入，包含节点与确定性实践链（rule 边），其余边留待显式工作流产生。
export function emptyGraph({ id, raw, config = {}, sourceRaw = null, now } = {}) {
  const { nodes, issues } = extractNodes(raw ?? [], config)
  const at = now ?? new Date().toISOString()
  const { edges } = withPracticeChain({ nodes, edges: [], config, now: at })
  return {
    version: GRAPH_VERSION,
    id,
    meta: {
      status: 'nodes-only',
      sourceRaw,
      builtAt: at,
      passes: [],
    },
    nodes,
    edges,
    suppressed: [],
    issues,
  }
}

// ---------------------------------------------------------------------------
// 旧图谱迁移（v1 / v2 → v3）：丢弃逻辑节点与非 prereq/coreq 边，保留可用的前后置关系。
// 供 `kg rebuild --keep-edges` 使用；纯函数，不落盘。
// ---------------------------------------------------------------------------

export function migrateGraphToV3(graph) {
  const nodes = (graph?.nodes ?? [])
    .filter((node) => (node?.kind ?? 'course') === 'course')
    .map((node) => {
      if (!('kind' in node) && !('op' in node)) return node
      const { kind, op, ...rest } = node
      void kind
      void op
      return rest
    })
  const ids = new Set(nodes.map((node) => node.id))
  const byKey = new Map()
  for (const edge of graph?.edges ?? []) {
    if (!EDGE_KINDS.includes(edge?.kind)) continue
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue
    const key = edgeKey(edge)
    const prev = byKey.get(key)
    byKey.set(key, prev ? mergeEdges(prev, edge) : { ...edge })
  }
  return {
    ...(graph ?? {}),
    version: GRAPH_VERSION,
    nodes,
    edges: sortEdges([...byKey.values()]),
    suppressed: graph?.suppressed ?? [],
    issues: graph?.issues ?? [],
  }
}
