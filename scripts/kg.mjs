#!/usr/bin/env node
// 课程知识图谱 CLI（确定性层）。
// 用法：npm run kg -- <init|pack|apply|check|diff|rebuild> [选项]
// 大模型的「判断」不在这里发生：本工具只生成任务包、校验并合并 agent 产出的结果。
// 完整工作流见 docs/kg-workflow.md。

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyResults,
  buildPackets,
  checkGraph,
  edgeKey,
  emptyGraph,
  extractNodes,
  migrateGraphToV3,
  removeCycleEdges,
  resultFileName,
  shardNodeIds,
  transitiveReduce,
  withPracticeChain,
} from '../src/lib/course-graph.js'
import {
  fileExists,
  graphFileName,
  loadMapContext,
  readGraphFile,
  writeGraphFile,
  normalizeGraphFile,
} from '../src/lib/graph-file.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rel = (p) => path.relative(root, p) || '.'

const USAGE = `SYSU 课程地图 · 课程知识图谱 CLI

用法：
  npm run kg -- init    --map <id> [--force]
  npm run kg -- pack    --map <id> --stage <a|b|c> [--outdir <dir>]
  npm run kg -- apply   --map <id> --stage <a|b|c> [--dry-run] <result.json...>
  npm run kg -- check   --map <id> [--min-confidence 0.6] [--fix-cycles] [--reduce] [--report <file>]
  npm run kg -- diff    --map <id> --since <graph.prev.json>
  npm run kg -- rebuild --map <id> [--only A,B] [--neighborhood 1] [--replace] [--keep-edges]
  npm run kg -- practice --map <id> [--dry-run]

说明：
  init     从 raw 抽取节点，写出 nodes-only 图谱（已存在则保留，--force 覆盖）
  pack     生成 agent 任务包到 out/kg/<id>/（A 每模块一包，B 跨模块单包，C 孤儿补边单包；schema v3 只含 edges）
  apply    读入 agent 结果 → 校验（E1-E5）→ 合并去重 → 写回图谱
  check    全图校验（W1 环路 / W2 逆时序 / W3 低置信 / W4 多模块 / W5 漂移 / W11 孤儿 / W12 终结点后置 / W13 实践链）
  diff     对比 --since 指定的旧图谱，列出节点/边增删
  rebuild  重新抽取节点；--only + --neighborhood 仅重跑受影响邻域（删除其 agent 边）；
           --keep-edges 会先迁移旧图谱（v1/v2 → v3）并保留可用的 prereq / coreq
  practice 对已有图谱补齐/更新确定性实践链（source: "rule"，幂等）
`

// 布尔开关：这些 flag 不消费后面的位置参数
const BOOLEAN_FLAGS = new Set(['dry-run', 'force', 'fix-cycles', 'reduce', 'replace', 'keep-edges'])

function parseArgs(argv) {
  const flags = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      flags._.push(token)
      continue
    }
    const name = token.slice(2)
    const next = argv[i + 1]
    if (BOOLEAN_FLAGS.has(name) || next == null || next.startsWith('--')) {
      flags[name] = true
    } else {
      flags[name] = next
      i += 1
    }
  }
  return flags
}

const log = (...args) => console.log(...args)
const warn = (...args) => console.warn(...args)

function requireMap(flags) {
  if (!flags.map) throw new Error('缺少 --map <id>')
  return String(flags.map)
}

const stageOf = (flags) => String(flags.stage ?? 'a').toUpperCase()
const outDirOf = (flags, id) => path.resolve(root, String(flags.outdir ?? `out/kg/${id}`))

async function readRaw(ctx) {
  if (!ctx.dataFile) throw new Error('index.json 条目缺少 data 字段')
  if (!(await fileExists(ctx.dataFile))) throw new Error(`原始数据不存在：${rel(ctx.dataFile)}`)
  return JSON.parse(await fs.readFile(ctx.dataFile, 'utf8'))
}

function printIssues(issues, title) {
  if (!issues.length) return
  warn(`\n${title}（${issues.length}）：`)
  for (const issue of issues.slice(0, 60)) {
    warn(`  [${issue.code}] ${issue.message}`)
  }
  if (issues.length > 60) warn(`  …另有 ${issues.length - 60} 条`)
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function cmdInit(flags) {
  const id = requireMap(flags)
  const ctx = await loadMapContext(root, id)
  if (await fileExists(ctx.graphFile)) {
    if (!flags.force) {
      log(`图谱已存在，保留不动：${rel(ctx.graphFile)}`)
      log('（如需按当前 raw 重建节点，请用 rebuild --replace；如需清空边，请用 init --force）')
      return 0
    }
  }
  const raw = await readRaw(ctx)
  const graph = emptyGraph({
    id: ctx.entry.id,
    raw,
    config: ctx.config,
    sourceRaw: ctx.entry.data ?? null,
  })
  await writeGraphFile(ctx.graphFile, graph)
  log(`已写出 nodes-only 图谱：${rel(ctx.graphFile)}（${graph.nodes.length} 个节点，0 条边）`)
  printIssues(graph.issues, '抽取警告')
  log('\n下一步：npm run kg -- pack --map ' + id + ' --stage a')
  return 0
}

// ---------------------------------------------------------------------------
// pack
// ---------------------------------------------------------------------------

async function cmdPack(flags) {
  const id = requireMap(flags)
  const ctx = await loadMapContext(root, id)
  if (!(await fileExists(ctx.graphFile))) {
    throw new Error(`图谱不存在：${rel(ctx.graphFile)}（先运行 npm run kg -- init --map ${id}）`)
  }
  const graph = await readGraphFile(ctx.graphFile)
  const stage = stageOf(flags)
  const outDir = outDirOf(flags, id)
  const packets = buildPackets(graph, { stage, outDir: rel(outDir) })

  if (!packets.length) {
    log(stage === 'C' ? 'Stage C：没有孤儿课程（所有课程都已有前后置关系），无需补边。' : `Phase ${stage}：没有可生成的任务包。`)
    return 0
  }

  await fs.mkdir(outDir, { recursive: true })
  log(`Phase ${stage}：${packets.length} 个任务包 → ${rel(outDir)}`)
  for (const packet of packets) {
    await fs.writeFile(path.join(root, packet.packetPath), `${JSON.stringify(packet, null, 2)}\n`, 'utf8')
    log(`  · ${packet.packetPath}  (${packet.nodes.length} 节点)  → 结果写 ${packet.outputPath}`)
  }
  log('\n请按 docs/kg-workflow.md 用 subagent 逐个处理任务包，然后：')
  log(`  npm run kg -- apply --map ${id} --stage ${stage.toLowerCase()} ${packets.map((p) => p.outputPath).join(' ')}`)
  return 0
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

async function cmdApply(flags) {
  const id = requireMap(flags)
  const ctx = await loadMapContext(root, id)
  if (!(await fileExists(ctx.graphFile))) {
    throw new Error(`图谱不存在：${rel(ctx.graphFile)}（先运行 init）`)
  }
  const graph = await readGraphFile(ctx.graphFile)
  const stage = stageOf(flags)
  const files = flags._.filter((f) => f !== 'apply')
  if (!files.length) throw new Error('apply 需要至少一个结果文件路径（agent 输出）')

  const results = []
  for (const file of files) {
    const abs = path.resolve(root, file)
    if (!(await fileExists(abs))) throw new Error(`结果文件不存在：${file}`)
    const json = JSON.parse(await fs.readFile(abs, 'utf8'))
    if (!Array.isArray(json?.edges)) {
      throw new Error(`结果文件缺少 edges 数组：${file}`)
    }
    results.push({ ...json, shard: json.shard ?? inferShardFromName(file) })
  }

  const { graph: next, issues, stats } = applyResults(graph, results, {
    stage,
    minConfidence: Number(flags['min-confidence'] ?? 0),
    shardNodeIds: shardNodeIds(graph),
    now: flags.now ? String(flags.now) : undefined,
  })

  log(`Phase ${stage} apply：读入 ${stats.read} 份结果`)
  log(`  接受 ${stats.kept} 条（新增 ${stats.added}，合并 ${stats.merged}），拒绝 ${stats.rejected} 条，suppressed 生效 ${stats.suppressed} 条`)
  printIssues(issues.filter((i) => i.level === 'error'), '被拒绝的边')
  printIssues(issues.filter((i) => i.level === 'warning'), '警告')

  if (flags['dry-run']) {
    log('\n--dry-run：未写盘。')
    return 0
  }
  await writeGraphFile(ctx.graphFile, next)
  log(`\n已写回：${rel(ctx.graphFile)}（共 ${next.nodes.length} 节点 / ${next.edges.length} 边）`)
  return 0
}

function inferShardFromName(file) {
  const base = path.basename(String(file))
  const m = /^result\.[ABC]\.(.+)\.json$/.exec(base)
  return m ? m[1] : null
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function cmdCheck(flags) {
  const id = requireMap(flags)
  const ctx = await loadMapContext(root, id)
  if (!(await fileExists(ctx.graphFile))) {
    throw new Error(`图谱不存在：${rel(ctx.graphFile)}（先运行 init）`)
  }
  let graph = await readGraphFile(ctx.graphFile)
  const raw = ctx.dataFile && (await fileExists(ctx.dataFile)) ? await readRaw(ctx) : null
  const minConfidence = Number(flags['min-confidence'] ?? ctx.config?.route?.minConfidence ?? 0.6)

  const before = checkGraph(graph, { raw, minConfidence, config: ctx.config })

  if (flags['fix-cycles']) {
    const { edges, removed } = removeCycleEdges(graph.edges, graph.nodes.map((n) => n.id))
    if (removed.length) {
      graph = { ...graph, edges }
      log(`--fix-cycles：删除 ${removed.length} 条环内最低置信边`)
      for (const e of removed) log(`  · ${e.from}>${e.to} (confidence ${e.confidence})`)
      await writeGraphFile(ctx.graphFile, graph)
    } else {
      log('--fix-cycles：未发现环路')
    }
  }

  if (flags.reduce) {
    const { edges, removed } = transitiveReduce(graph.edges)
    if (removed.length) {
      graph = { ...graph, edges }
      log(`--reduce：删除 ${removed.length} 条可传递约简的 prereq 边`)
      await writeGraphFile(ctx.graphFile, graph)
    } else {
      log('--reduce：无可约简边')
    }
  }

  const after = flags['fix-cycles'] || flags.reduce ? checkGraph(graph, { raw, minConfidence, config: ctx.config }) : before
  printIssues(after.errors, '硬错误')
  printIssues(after.warnings, '警告')

  if (flags.report) {
    const reportFile = path.resolve(root, String(flags.report))
    await fs.mkdir(path.dirname(reportFile), { recursive: true })
    await fs.writeFile(reportFile, renderReport(id, graph, after, { raw, minConfidence, config: ctx.config }), 'utf8')
    log(`\n报告已写出：${rel(reportFile)}`)
  }

  log(
    `\n结果：${graph.nodes.length} 节点 / ${graph.edges.length} 边，` +
      `硬错误 ${after.errors.length}，警告 ${after.warnings.length}`,
  )
  return after.ok ? 0 : 1
}

function renderReport(id, graph, { errors, warnings }, { raw, minConfidence }) {
  const lines = []
  lines.push(`# 课程知识图谱检查报告 · ${id}`)
  lines.push('')
  lines.push(`- 节点：${graph.nodes.length}`)
  lines.push(`- 边：${graph.edges.length}`)
  lines.push(`- 状态：${graph.meta?.status ?? '-'}`)
  lines.push(`- 低置信度阈值：${minConfidence}`)
  lines.push(`- 原始数据漂移检测：${raw ? '已启用' : '未启用'}`)
  lines.push(`- 硬错误：${errors.length} / 警告：${warnings.length}`)
  lines.push('')

  const byCode = (list) => {
    const m = new Map()
    for (const i of list) m.set(i.code, [...(m.get(i.code) ?? []), i])
    return m
  }

  if (errors.length) {
    lines.push('## 硬错误（被拒绝的边）')
    lines.push('')
    for (const [code, list] of byCode(errors)) {
      lines.push(`### ${code}（${list.length}）`)
      for (const i of list) lines.push(`- ${i.message}`)
      lines.push('')
    }
  }
  if (warnings.length) {
    lines.push('## 警告')
    lines.push('')
    for (const [code, list] of byCode(warnings)) {
      lines.push(`### ${code}（${list.length}）`)
      for (const i of list) lines.push(`- ${i.message}`)
      lines.push('')
    }
  }
  if (!errors.length && !warnings.length) {
    lines.push('无问题。')
    lines.push('')
  }

  lines.push('## 孤儿课程 · 实践课链')
  lines.push('')
  const orphans = warnings.find((w) => w.code === 'W11')
  lines.push('### 孤儿课程（无任何前后置关系）')
  lines.push('')
  if (orphans) {
    for (const nodeId of orphans.nodes ?? []) lines.push(`- ${nodeId}`)
  } else {
    lines.push('- 无')
  }
  lines.push('')
  lines.push('### 实践课链（W13）')
  lines.push('')
  const chain = warnings.filter((w) => w.code === 'W13')
  if (chain.length) for (const w of chain) lines.push(`- ${w.message}`)
  else lines.push('- 无断链')
  lines.push('')
  lines.push('### 终结点后置（W12）')
  lines.push('')
  const terminal = warnings.filter((w) => w.code === 'W12')
  if (terminal.length) for (const w of terminal) lines.push(`- ${w.message}`)
  else lines.push('- 无')
  lines.push('')

  lines.push('## 边清单')
  lines.push('')
  lines.push('| from | to | kind | confidence | source | pass | evidence |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const e of graph.edges) {
    lines.push(
      `| ${e.from} | ${e.to} | ${e.kind} | ${e.confidence} | ${e.source} | ${e.pass ?? '-'} | ${String(e.evidence).replace(/\|/g, '/')} |`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

async function cmdDiff(flags) {
  const id = requireMap(flags)
  const ctx = await loadMapContext(root, id)
  if (!flags.since) throw new Error('diff 需要 --since <旧图谱.json>')
  const before = await readGraphFile(path.resolve(root, String(flags.since)))
  const after = await readGraphFile(ctx.graphFile)

  const key = (e) => `${e.from}>${e.to}`
  const beforeEdges = new Map(before.edges.map((e) => [key(e), e]))
  const afterEdges = new Map(after.edges.map((e) => [key(e), e]))
  const added = [...afterEdges.values()].filter((e) => !beforeEdges.has(key(e)))
  const removed = [...beforeEdges.values()].filter((e) => !afterEdges.has(key(e)))
  const changed = [...afterEdges.values()].filter((e) => {
    const prev = beforeEdges.get(key(e))
    return prev && (prev.confidence !== e.confidence || prev.kind !== e.kind || prev.evidence !== e.evidence)
  })

  const beforeNodes = new Set(before.nodes.map((n) => n.id))
  const afterNodes = new Set(after.nodes.map((n) => n.id))
  const nodesAdded = [...afterNodes].filter((id) => !beforeNodes.has(id))
  const nodesRemoved = [...beforeNodes].filter((id) => !afterNodes.has(id))
  const nodesChanged = after.nodes.filter((n) => before.nodes.find((b) => b.id === n.id)?.sourceHash !== n.sourceHash)

  log(`diff ${id}：${path.relative(root, String(flags.since))} → ${rel(ctx.graphFile)}`)
  log(`  节点 +${nodesAdded.length} -${nodesRemoved.length} ~${nodesChanged.length}`)
  for (const n of nodesAdded) log(`    + ${n}`)
  for (const n of nodesRemoved) log(`    - ${n}`)
  for (const n of nodesChanged) log(`    ~ ${n.id} ${n.name}`)
  log(`  边 +${added.length} -${removed.length} ~${changed.length}`)
  for (const e of added) log(`    + ${key(e)} (${e.kind} ${e.confidence})`)
  for (const e of removed) log(`    - ${key(e)}`)
  for (const e of changed) log(`    ~ ${key(e)} ${beforeEdges.get(key(e)).confidence} → ${e.confidence}`)
  return 0
}

// ---------------------------------------------------------------------------
// rebuild
// ---------------------------------------------------------------------------

async function cmdRebuild(flags) {
  const id = requireMap(flags)
  const ctx = await loadMapContext(root, id)
  const raw = await readRaw(ctx)
  const keepEdgesFlag = Boolean(flags['keep-edges'])
  // 旧图谱容错：读取失败（v1/v2 等不兼容版本）视为无旧图谱 → 按全量重建处理。
  // --keep-edges：不要求版本匹配，直接迁移到 v3 并保留可用的 prereq / coreq。
  let existing = null
  if (await fileExists(ctx.graphFile)) {
    if (keepEdgesFlag) {
      try {
        const rawGraph = JSON.parse(await fs.readFile(ctx.graphFile, 'utf8'))
        const oldEdgeCount = (rawGraph?.edges ?? []).length
        existing = normalizeGraphFile(migrateGraphToV3(rawGraph))
        const droppedLegacy = oldEdgeCount - existing.edges.length
        if (droppedLegacy > 0) {
          warn(`--keep-edges：迁移旧图谱时丢弃 ${droppedLegacy} 条非 prereq/coreq 或悬空旧边`)
        }
      } catch (err) {
        warn(`旧图谱不可用：${String(err?.message ?? err).split('\n')[0]}`)
        log('旧图谱不兼容，按全量重建处理。')
        existing = null
      }
    } else {
      try {
        existing = await readGraphFile(ctx.graphFile)
      } catch (err) {
        warn(`旧图谱不可用：${String(err?.message ?? err).split('\n')[0]}`)
        log('旧图谱不兼容，按全量重建处理（如需保留 prereq/coreq，加 --keep-edges）。')
        existing = null
      }
    }
  }
  const fresh = extractNodes(raw, ctx.config)

  const freshById = new Map(fresh.nodes.map((n) => [n.id, n]))
  const oldById = new Map((existing?.nodes ?? []).map((n) => [n.id, n]))
  const added = fresh.nodes.filter((n) => !oldById.has(n.id))
  const removed = (existing?.nodes ?? []).filter((n) => !freshById.has(n.id))
  const changed = fresh.nodes.filter((n) => oldById.has(n.id) && oldById.get(n.id).sourceHash !== n.sourceHash)

  const only = flags.only ? String(flags.only).split(',').map((s) => s.trim()).filter(Boolean) : null
  const neighborhood = Number(flags.neighborhood ?? 0)

  // 受影响节点：--only 给出种子 + N 跳无向邻域；无 --only 表示全量
  let affected = null
  if (only?.length) {
    const adj = new Map()
    for (const e of existing?.edges ?? []) {
      if (!adj.has(e.from)) adj.set(e.from, [])
      if (!adj.has(e.to)) adj.set(e.to, [])
      adj.get(e.from).push(e.to)
      adj.get(e.to).push(e.from)
    }
    affected = new Set(only)
    for (let d = 0; d < neighborhood; d += 1) {
      for (const node of [...affected]) {
        for (const next of adj.get(node) ?? []) affected.add(next)
      }
    }
  }

  const missing = (only ?? []).filter((nodeId) => !freshById.has(nodeId))
  if (missing.length) warn(`注意：--only 中的节点不在数据里：${missing.join(', ')}`)

  const courseIds = new Set(fresh.nodes.map((n) => n.id))

  // 全量重建默认删除全部 agent 边；邻域重建只删除命中受影响集合的 agent 边。
  // --keep-edges 保留端点仍存在的 prereq / coreq（含 agent 边）。
  // source: manual 的边默认永远保留（--replace 才清）。
  const keepEdges = (existing?.edges ?? []).filter((e) => {
    if (!courseIds.has(e.from) || !courseIds.has(e.to)) return false
    if (e.source === 'manual' && !flags.replace) return true
    if (!affected) return keepEdgesFlag
    return !affected.has(e.from) && !affected.has(e.to)
  })
  const dropped = (existing?.edges ?? []).length - keepEdges.length

  const at = new Date().toISOString()
  const { edges: chained } = withPracticeChain({
    nodes: fresh.nodes,
    edges: keepEdges,
    config: ctx.config,
    now: at,
  })
  const chainAdded = chained.length - keepEdges.length

  const next = normalizeGraphFile({
    ...(existing ?? {}),
    id: ctx.entry.id,
    meta: {
      ...(existing?.meta ?? {}),
      status: keepEdges.length ? 'built' : 'nodes-only',
      sourceRaw: ctx.entry.data ?? null,
      builtAt: at,
      passes: keepEdgesFlag || only?.length ? existing?.meta?.passes ?? [] : [],
    },
    nodes: fresh.nodes,
    edges: chained,
    suppressed: existing?.suppressed ?? [],
    issues: fresh.issues,
  })

  if (flags['dry-run']) log('--dry-run：未写盘。')
  else await writeGraphFile(ctx.graphFile, next)

  log(
    `rebuild ${id}：节点 +${added.length} -${removed.length} ~${changed.length}；` +
      `边删除 ${dropped} 条${keepEdgesFlag ? '（--keep-edges：保留可迁移的 prereq/coreq）' : ''}（保留 manual ${keepEdges.filter((e) => e.source === 'manual').length} 条）` +
      `；实践链 rule 边 +${chainAdded}`,
  )
  for (const n of added) log(`  + ${n.id} ${n.name}`)
  for (const n of removed) log(`  - ${n.id} ${n.name}`)
  for (const n of changed) log(`  ~ ${n.id} ${n.name}`)
  if (only?.length) log(`受影响邻域（${affected.size} 节点）：${[...affected].join(', ')}`)
  printIssues(fresh.issues, '抽取警告')

  if (dropped > 0) {
    log('\n下一步：重新运行工作流补边')
    log(`  npm run kg -- pack --map ${id} --stage a`)
  }
  return 0
}

// ---------------------------------------------------------------------------
// practice
// ---------------------------------------------------------------------------

async function cmdPractice(flags) {
  const id = requireMap(flags)
  const ctx = await loadMapContext(root, id)
  if (!(await fileExists(ctx.graphFile))) {
    throw new Error(`图谱不存在：${rel(ctx.graphFile)}（先运行 npm run kg -- init --map ${id}）`)
  }
  const graph = await readGraphFile(ctx.graphFile)
  const before = new Map(graph.edges.map((e) => [edgeKey(e), e]))
  const at = new Date().toISOString()
  const { edges } = withPracticeChain({ nodes: graph.nodes, edges: graph.edges, config: ctx.config, now: at })

  const added = edges.filter((e) => !before.has(edgeKey(e)))
  const changed = edges.filter((e) => {
    const prev = before.get(edgeKey(e))
    return prev && (prev.confidence !== e.confidence || prev.kind !== e.kind || prev.evidence !== e.evidence)
  })
  const ruleCount = edges.filter((e) => e.source === 'rule').length
  log(`practice ${id}：实践链 rule 边 ${ruleCount} 条（新增 ${added.length}，更新 ${changed.length}）`)
  for (const e of added) log(`  + ${edgeKey(e)} (${e.kind} ${e.confidence}) ${e.evidence}`)
  for (const e of changed) log(`  ~ ${edgeKey(e)} → ${e.kind} ${e.confidence}`)

  if (flags['dry-run']) {
    log('\n--dry-run：未写盘。')
    return 0
  }
  const status = edges.some((e) => e.source !== 'rule') ? 'built' : 'nodes-only'
  await writeGraphFile(ctx.graphFile, { ...graph, edges, meta: { ...(graph.meta ?? {}), status, builtAt: at } })
  log(`\n已写回：${rel(ctx.graphFile)}（共 ${graph.nodes.length} 节点 / ${edges.length} 边）`)
  return 0
}

// ---------------------------------------------------------------------------

const COMMANDS = {
  init: cmdInit,
  pack: cmdPack,
  apply: cmdApply,
  check: cmdCheck,
  diff: cmdDiff,
  rebuild: cmdRebuild,
  practice: cmdPractice,
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE)
    return 0
  }
  if (!COMMANDS[cmd]) {
    warn(`未知子命令：${cmd}\n`)
    console.log(USAGE)
    return 2
  }
  const flags = parseArgs(argv.slice(1))
  return COMMANDS[cmd](flags)
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`错误：${err?.message ?? err}`)
    process.exit(1)
  })
