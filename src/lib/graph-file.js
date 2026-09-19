// 图谱文件读写与 schema 校验（仅 Node 使用；浏览器通过 fetch 读取同一文件）。
// 图谱文件是「单一数据源」：页面只读，重算一律发生在 scripts/kg.mjs。
//
// schema v3：节点只有课程（无 kind / op）；边只有 prereq 与 coreq。
// v1 / v2 文件不再支持：validateGraphShape 会给出可执行的迁移指引。

import fs from 'node:fs/promises'
import path from 'node:path'
import { EDGE_KINDS, GRAPH_VERSION, NODE_KINDS, mergeMapIndex, sortNodes } from './course-graph.js'

export const graphFileName = (id) => `${id}.graph.json`

// 管理端（入库）与本地端（gitignore）的地图清单。
export const MAP_INDEX_FILE = 'index.json'
export const MAP_INDEX_LOCAL_FILE = 'index.local.json'

export { mergeMapIndex }

export const VERSION_ERROR =
  `图谱版本已不再支持：v3 已移除 AND/OR 逻辑节点与 sequence / equivalent 边。` +
  `请运行 npm run kg -- rebuild --map <id> --replace 并重跑 pack/apply 工作流。`

// 把任意图谱对象规整为固定字段顺序（保证同输入逐字节一致）。
export function normalizeGraphFile(graph) {
  const meta = graph?.meta ?? {}
  return {
    version: GRAPH_VERSION,
    id: graph?.id ?? null,
    meta: {
      status: meta.status ?? ((graph?.edges ?? []).length ? 'built' : 'nodes-only'),
      sourceRaw: meta.sourceRaw ?? null,
      builtAt: meta.builtAt ?? null,
      passes: (meta.passes ?? []).map((p) => ({
        stage: p.stage ?? null,
        shard: p.shard ?? null,
        model: p.model ?? null,
        at: p.at ?? null,
      })),
    },
    nodes: sortNodes(graph?.nodes ?? []).map((n) => ({
      id: n.id,
      name: n.name ?? '',
      code: n.code ?? '',
      module: n.module ?? '',
      typeName: n.typeName ?? '',
      category: n.category ?? '',
      credits: n.credits ?? null,
      semesters: [...(n.semesters ?? [])],
      grade: n.grade ?? null,
      spanning: Boolean(n.spanning),
      styleKey: n.styleKey ?? 'core',
      sourceHash: n.sourceHash ?? '',
    })),
    edges: (graph?.edges ?? [])
      .slice()
      .sort((a, b) => String(a.from).localeCompare(String(b.from)) || String(a.to).localeCompare(String(b.to)))
      .map((e) => ({
        from: e.from,
        to: e.to,
        kind: e.kind ?? 'prereq',
        confidence: e.confidence ?? 0,
        evidence: e.evidence ?? '',
        source: e.source ?? 'agent',
        pass: e.pass ?? null,
        shard: e.shard ?? null,
        model: e.model ?? null,
        createdAt: e.createdAt ?? null,
      })),
    suppressed: [...new Set(graph?.suppressed ?? [])].sort(),
    issues: graph?.issues ?? [],
  }
}

export function serializeGraph(graph) {
  return `${JSON.stringify(normalizeGraphFile(graph), null, 2)}\n`
}

// schema 校验：返回硬错误字符串数组（空 = 通过）。用于读取外部/手写文件时兜底。
export function validateGraphShape(graph) {
  const errors = []
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    return ['图谱文件根节点必须是对象']
  }
  if (graph.version !== GRAPH_VERSION) {
    errors.push(`${VERSION_ERROR}（当前文件 version = ${graph.version ?? '缺'}）`)
  }
  if (!Array.isArray(graph.nodes)) errors.push('nodes 必须是数组')
  if (graph.edges != null && !Array.isArray(graph.edges)) errors.push('edges 必须是数组')
  if (graph.suppressed != null && !Array.isArray(graph.suppressed)) errors.push('suppressed 必须是数组')
  for (const [i, node] of (graph.nodes ?? []).entries()) {
    if (!node?.id) errors.push(`nodes[${i}] 缺少 id`)
    if (!Array.isArray(node?.semesters)) errors.push(`nodes[${i}](${node?.id}) 缺少 semesters 数组`)
    const kind = node?.kind ?? 'course'
    if (!NODE_KINDS.includes(kind)) {
      errors.push(
        `nodes[${i}](${node?.id}) kind 非法：${node?.kind}；v3 只允许 course（逻辑节点已移除）——${VERSION_ERROR}`,
      )
    }
  }
  for (const [i, edge] of (graph.edges ?? []).entries()) {
    if (!edge?.from || !edge?.to) errors.push(`edges[${i}] 缺少 from/to`)
    if (edge?.kind && !EDGE_KINDS.includes(edge.kind)) {
      errors.push(
        `edges[${i}] kind 非法：${edge.kind}；v3 只允许 ${EDGE_KINDS.join(' / ')}——${VERSION_ERROR}`,
      )
    }
  }
  return errors
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

export async function readGraphFile(file) {
  const graph = await readJson(file)
  const errors = validateGraphShape(graph)
  if (errors.length) throw new Error(`图谱文件不合法（${file}）：\n- ${errors.join('\n- ')}`)
  return normalizeGraphFile(graph)
}

export async function writeGraphFile(file, graph) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, serializeGraph(graph), 'utf8')
}

export async function fileExists(file) {
  return fs.access(file).then(() => true, () => false)
}

// 读取 data/maps/index.json + data/maps/index.local.json（后者 gitignore，local 覆盖同名 id）。
export async function readMapIndex(mapsDir) {
  const committed = await readJson(path.join(mapsDir, MAP_INDEX_FILE)).catch(() => [])
  const local = await readJson(path.join(mapsDir, MAP_INDEX_LOCAL_FILE)).catch(() => [])
  return mergeMapIndex(committed, local)
}

// 把清单里的相对路径解析到 data/ 之内，拒绝 `../` 越界（清单文件可能是外部提供的）。
function resolveWithin(root, relPath) {
  const base = path.join(root, 'data')
  const abs = path.resolve(base, String(relPath ?? '').replace(/^\/+/, ''))
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`清单中的路径越界（必须在 data/ 内）：${relPath}`)
  }
  return abs
}

// 读取合并后清单中某地图的条目（含 config 与 raw 路径解析）。
export async function loadMapContext(root, mapId) {
  const mapsDir = path.join(root, 'data', 'maps')
  const index = await readMapIndex(mapsDir)
  const entry = (Array.isArray(index) ? index : []).find((e) => e?.id === mapId)
  if (!entry) {
    const ids = (Array.isArray(index) ? index : []).map((e) => e?.id).filter(Boolean)
    throw new Error(`在 data/maps/index.json + index.local.json 中找不到地图 id：${mapId}（现有：${ids.join(', ') || '无'}）`)
  }
  const dataFile = entry.data ? resolveWithin(root, entry.data) : null
  const configFile = entry.config ? resolveWithin(root, entry.config) : null
  const config = configFile && (await fileExists(configFile)) ? await readJson(configFile) : {}
  const graphFile = entry.graph
    ? resolveWithin(root, entry.graph)
    : resolveWithin(root, path.join('maps', graphFileName(String(entry.id))))
  return { entry, dataFile, configFile, config, graphFile, mapsDir }
}
