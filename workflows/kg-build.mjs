#!/usr/bin/env node
// 课程知识图谱 · Phase A 并发编排生成器（可选工具，不参与 npm run dev / build）。
//
// 为什么是「生成器」而不是直接用 workflowScriptPath：
// pi-subagents 的 workflowScript / workflowScriptPath 都是原始脚本，**不能接收 args**
// （args 只对具名 workflow 资源生效），脚本沙箱里也没有文件系统。
// 所以这里先用 Node 读取图谱 / 任务包，把 mapId + shard 列表**烘焙**进一份可直接执行的
// workflowScript 文件，再由父级 agent 调用 subagent 运行它。
//
// 用法：
//   node workflows/kg-build.mjs --map <id>                  # 生成 out/kg/<id>/build.workflow.mjs
//   node workflows/kg-build.mjs --map <id> --stage a
//   node workflows/kg-build.mjs --map <id> --agent worker   # 指定子 agent（默认 delegate）
//
// 生成的脚本：每个 shard 一个 fresh-context subagent，只读自己的 packet、只写自己的 outputPath。
// 父级负责在 barrier 之后执行 apply / pack B / apply B / check（见 docs/kg-workflow.md）。

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    flags[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
  }
  return flags
}

const flags = parseArgs(process.argv.slice(2))
const mapId = flags.map
if (!mapId) {
  console.error('用法：node workflows/kg-build.mjs --map <id> [--stage a] [--agent delegate]')
  process.exit(2)
}
const stage = String(flags.stage ?? 'a').toUpperCase()
if (stage !== 'A') {
  console.error('本脚本只编排 Phase A（Phase B 是单包；Stage C 孤儿补边也是单包，直接派 1 个 subagent 即可）')
  process.exit(2)
}
const agent = String(flags.agent ?? 'delegate')
const outDir = path.join(root, 'out', 'kg', mapId)
const outFile = path.join(outDir, 'build.workflow.mjs')

// 分片列表：优先从已生成的 packet 文件名读取，其次从图谱节点 module 推导
let shards = []
try {
  const files = await fs.readdir(outDir)
  shards = files
    .filter((f) => f.startsWith('packet.A.') && f.endsWith('.json'))
    .map((f) => f.slice('packet.A.'.length, -'.json'.length))
    .sort()
} catch {
  /* out 目录不存在 → 走图谱推导 */
}

if (!shards.length) {
  const graphFile = path.join(root, 'data', 'maps', `${mapId}.graph.json`)
  const graph = JSON.parse(await fs.readFile(graphFile, 'utf8'))
  shards = [...new Set((graph.nodes ?? []).map((n) => n.module || '未分模块'))]
}

if (!shards.length) {
  console.error(`没有可编排的分片：先运行 npm run kg -- pack --map ${mapId} --stage a`)
  process.exit(1)
}

const script = `// 由 workflows/kg-build.mjs 生成，请勿手工维护。
// mapId=${mapId} shards=${shards.length} agent=${agent}

const mapId = ${JSON.stringify(mapId)}
const shards = ${JSON.stringify(shards)}
const agent = ${JSON.stringify(agent)}

const taskFor = (shard) => [
  '你是课程先修关系判定专家，只负责一个分片。',
  '',
  '1. 用读文件工具读取任务包：out/kg/' + mapId + '/packet.A.' + shard + '.json（只读）。',
  '2. 严格按任务包里的 instructions 判定该分片课程之间的前后置关系，注意先归并「课程系列」：',
  '   - 先按基底名把课程分组（「X（上）」与「X（下）」、「X」与「X 实验/实践」、「X 基础」与「X 进阶」）；',
  '   - 同层级的系列成员（如理论课 + 对应实验课、同层上下篇）→ coreq（同修）；',
  '   - 层级递进（上→下、I→II、基础→进阶、理论→应用、实验一→实验二）→ prereq（先修）；',
  '   - 依据优先级：课程内容的知识依赖 > 开课学期先后（仅参考）> 课程编号（仅供参考，前置课号可能更大，禁止仅凭编号大小定方向）。',
  '   - 实验/实践/上机课与其对应理论课一律 coreq（不得写成 prereq）；一门整合/综合实验同时支撑',
  '     多门理论课时，对每一门理论课各建一条 coreq（例：整合实验 ↔ 理论I、整合实验 ↔ 理论II）；',
  '     只有实验课自身的阶段递进（实验一→实验二）才用 prereq。',
  '   - 平台课 / 大一专业基础课（数学 / 物理 / 化学 / 生物类基础课…）是后续专业课程的起始前置；',
  '     片内出现的「基础课 → 应用课」必须输出 prereq，不要因跨学期而省略（跨模块的留给 Phase B）。',
  '   - 实践课规则：实习实践课中带阶段编号的课（实践1/2）按编号构成 prereq 链 N → N+1',
  '     （确定性 rule 链已自动生成，不必重复）；毕业论文 / 毕业设计是终结点，只能作为 to，不得输出任何后置边。',
  '   - from/to 只能取任务包 nodes 中出现过的 id；Phase A 不输出跨模块边（交给 Phase B）。',
  '   - evidence 必须写明依据（引用课程名/代码或知识结构），至少 4 个字，不得为空。',
  '   - confidence 取 0~1；宁缺毋滥，无把握就不要输出。',
  '   - kind 只允许 prereq / coreq（v3 已移除 sequence / equivalent 与 AND/OR 逻辑节点）。',
  '3. 只允许写一个文件：out/kg/' + mapId + '/result.A.' + shard + '.json',
  '   内容为严格 JSON（schemaVersion 3，只有 edges，见 instructions），不要包裹代码块、不要输出额外文字。',
  '4. 允许执行：npm test、npm run kg -- check --map ' + mapId + '（只读诊断）。',
  '   禁止执行 pack / apply / rebuild / init，禁止修改任何其他文件。',
  '',
  '完成后用一句话汇报：写出的边数与不确定处。',
].join('\\n')

// workflow key 只允许 [A-Za-z0-9._-]，因此用 shard-A0/A1… 作 key，分片名放在 label 与 task 里
const results = await runs.all(
  shards.map((shard, index) => ({
    key: 'shard-A' + index,
    label: 'Phase A · ' + shard,
    agent,
    task: taskFor(shard),
  })),
)

return {
  mapId,
  shards,
  outputs: results.map((r, i) => ({
    shard: shards[i],
    resultPath: 'out/kg/' + mapId + '/result.A.' + shards[i] + '.json',
    ok: r && typeof r.ok === 'boolean' ? r.ok : null,
  })),
  next: 'npm run kg -- apply --map ' + mapId + ' --stage a out/kg/' + mapId + '/result.A.*.json',
}
`

await fs.mkdir(outDir, { recursive: true })
await fs.writeFile(outFile, script, 'utf8')

console.log(`已生成 Phase A 编排脚本：${path.relative(root, outFile)}（${shards.length} 个分片）`)
for (const shard of shards) console.log(`  · ${shard}`)
console.log('\n下一步：父级 agent 用 subagent 运行该脚本（fresh context 并发）')
console.log(`  subagent({ workflowScriptPath: 'out/kg/${mapId}/build.workflow.mjs', async: true })`)
console.log('barrier 之后由父级执行：')
console.log(`  npm run kg -- apply --map ${mapId} --stage a out/kg/${mapId}/result.A.*.json`)
console.log(`  npm run kg -- pack  --map ${mapId} --stage b   # → 1 个 subagent → apply --stage b`)
console.log(`  npm run kg -- check --map ${mapId} --report out/kg/${mapId}/report.md`)
