# 课程知识图谱工作流（前后置关系图）

本文件是「课程路线图」视图所需**有向边**的操作手册。目标：把课程之间的前后置关系交给
**大模型 subagent 判断**，由**确定性工具**负责抽取节点、校验、合并与落盘。

设计原则：

- 关系不用规则表猜。`src/lib/course-graph.js` 只做图代数（抽取 / 校验 / 合并 / 布局），不做语义判断。
- **判断只发生在 subagent 中**。仓库不联网、不存密钥、不引入 LLM SDK；模型调用由使用者的 agent 运行时完成。
- 图谱文件 `data/maps/<id>.graph.json` 是**单一数据源**：页面只读它，不在浏览器里重算关系。
- `source: "manual"` 的边**永远不会**被 agent 流程覆盖或删除。
- schema **v3 只有课程节点**：没有 AND/OR 逻辑节点（菱形），边只有 `prereq`（先修）与 `coreq`（同修）。

---

## 0. 前置

```bash
npm install
npm test                     # 确定性层单测（无模型、无网络）
npm run kg -- help           # 子命令一览
```

图谱文件默认路径 `data/maps/<id>.graph.json`。地图清单分两份：

- `data/maps/index.json`（**入库**，只放 curated 示例）；
- `data/maps/index.local.json`（**gitignore**，导入与本地真实地图写这里）。

页面与 CLI 都会把两份清单合并（local 覆盖同名 id）。`data/maps/*` 已 gitignore，
示例地图 `example` 的配置文件与图谱文件已入库。

---

## 1. 六步流程

### 第 1 步 · 生成节点图（nodes-only）

```bash
npm run kg -- init --map <id>
```

- 从 `/raw/<id>.json` 抽取节点（**只取 `bandOf(row) !== 1` 的行**，即专必 + 专选，排除公必/公选）。
- 同时写入**确定性实践链**（`source: "rule"`）：把「实习实践课」模块整模块串成单条 `prereq` 链。
- 写出 `data/maps/<id>.graph.json`，`meta.status = "nodes-only"`（即便已有 rule 边，状态仍是 nodes-only）。
- **已存在则保留不动**；`--force` 会清空重建（会丢边）。按当前 raw 重建节点请用 `rebuild --replace`。
- 通过页面「导入」JSON 时也会自动执行本步（无网络、无模型调用）。

> 确定性实践链规则：编号主干（名称末尾阿拉伯数字，N → N+1）→ 非编号课（按首学期）→ 终结点（毕业论文/毕业设计）收尾，整模块一条链，不分支。

产物：`data/maps/<id>.graph.json`

### 第 2 步 · 生成 Phase A 任务包

```bash
npm run kg -- pack --map <id> --stage a
```

- 每个子模块（`node.module`）一个任务包，`nodes` 只含本片节点；`context.allNodes` 是
  全量精简表（`id / name / code / module / semesters / grade`），供识别跨模块课程。
- 任务包 `schemaVersion: 3`：只含 `edges`，没有 `logic`。
- 产物：`out/kg/<id>/packet.A.<子模块>.json`。

### 第 3 步 · 并发 N 个 fresh-context subagent

**每个 subagent 只处理一个任务包**，互不通信。可手工逐个派发（任务描述模板见下），
也可用生成器一键编排（第 6 节）。给 subagent 的任务描述模板：

```text
读取任务包 out/kg/<id>/packet.A.<子模块>.json（只读）。
按任务包内的 instructions 判定课程间前后置关系，先归并「课程系列」：
  同层级系列成员（理论 + 对应实验/实践、同层上下篇）→ coreq；
  层级递进（上→下、I→II、基础→进阶）→ prereq。
  依据优先级：课程内容 > 开课学期先后（参考）> 课号（仅供参考，前置课号可能更大，禁止仅凭编号大小定方向）。
只允许写一个文件：任务包中的 outputPath（即 out/kg/<id>/result.A.<子模块>.json）。
输出严格符合任务包 instructions 里的 JSON schema；不要输出额外文字、不要包裹代码块。
允许执行的命令：npm test、npm run kg -- check --map <id>（只读诊断）。不要运行 pack/apply/rebuild。
```

- 每个 subagent 的**唯一可写路径**是它自己的 `outputPath`；沙箱内不能触碰其他文件。
- 结果 schema（`from`/`to` 必须取自任务包 `nodes` 中出现过的 id）：

```json
{
  "schemaVersion": 3,
  "stage": "A",
  "mapId": "<id>",
  "shard": "<子模块>",
  "edges": [
    { "from": "SM101", "to": "SM201", "kind": "prereq", "confidence": 0.9,
      "evidence": "叙事设计导论是叙事学原理的先修" },
    { "from": "SM201", "to": "SM202", "kind": "coreq", "confidence": 0.85,
      "evidence": "理论课与配套工作坊同修" }
  ],
  "notes": "可选：疑难点与不确定处"
}
```

### 判定要点（PACKET_INSTRUCTIONS 的摘要）

1. **先归并课程系列**：同基底名的 上/下、I/II、一/二、1/2，以及「X 与 X 实验」「X 与 X 实践」配对。
2. **同层级系列成员 → `coreq`**（如「X（上）」+「X 实验（上）」）。
3. **层级递进 → `prereq`**（上→下、I→II、基础→进阶、理论→应用、实验一→实验二）。
4. **依据优先级**：课程内容的知识依赖 **>** 开课学期先后（仅参考）**>** 课程编号
   （仅供参考；前置课号可能更大，**禁止**仅凭编号大小定方向）。
5. Phase A 只输出两端都在本片 `nodes` 中的边；不要把同模块课程串成链；不确定的宁可不输出。
6. **理论课 / 实验课 / 基础课规则**：实验 / 实践 / 上机 / 实习课与其对应的理论课**一律 `coreq`**（不得写成 `prereq`）；
   一门整合实验同时支撑多门理论课时，对每门理论课各建一条 `coreq`；只有实验课自身的阶段递进（实验一 → 实验二）才用 `prereq`。
   实习实践课中带阶段编号的课（实践1/2）按编号构成 `prereq` 链 N → N+1（该链已由确定性规则自动生成，模型不必重复）；
   毕业论文 / 毕业设计是**终结点**（只能作为 `to`）；平台课 / 大一基础课（数学 / 物理 / 化学 / 生物类基础课…）→ 后续专业应用课的跨模块 `prereq` 必须补出。
7. `confidence ∈ [0,1]`，允许 < 0.6（UI 会按阈值隐藏），但不得编造；`evidence` ≥ 4 字。
8. `kind` 只能是 `prereq` / `coreq`。

### 第 4 步 · 合并 Phase A

```bash
npm run kg -- apply --map <id> --stage a out/kg/<id>/result.A.*.json
```

- 逐份读入 → 校验（E1-E5，硬错误剔除并写入 `issues`）→ 合并去重 → 写回图谱文件 → 追加 `meta.passes`。
- `--dry-run` 只打印将发生的增删；`--min-confidence` 控制 W3 低置信度警告阈值。
- 若结果文件仍带已废弃的 `logic` 字段：忽略并记 W10 警告，不阻塞 apply。

### 第 5 步 · Phase B（跨模块 + 冲突裁决）

```bash
npm run kg -- pack --map <id> --stage b
# 1 个 packet（全量节点 + context.stageAEdges）
#   → 1 个 subagent → out/kg/<id>/result.B.json
npm run kg -- apply --map <id> --stage b out/kg/<id>/result.B.json
```

Phase B 的指令要求专门产出 **Phase A 未覆盖的跨模块边**（如 计算机 ↔ 数学、化学 ↔ 生命科学）。
同 `(from,to)` 会与 A 边合并（`confidence` 取 max、`evidence` 去重拼接、`pass = "A+B"`）。
跨模块同样遵守第 1~4 步的系列归并与依据优先级。

### 第 5.5 步 · Stage C（孤儿课程补边，可省）

```bash
npm run kg -- pack --map <id> --stage c
# 无孤儿时直接提示并退出 0（不产包）
# 1 个 packet（只含孤儿节点 + context.existingEdges / orphanIds）
#   → 1 个 subagent → out/kg/<id>/result.C.json
npm run kg -- apply --map <id> --stage c out/kg/<id>/result.C.json
```

`ORPHAN_INSTRUCTIONS` 要求：每门孤儿课**至少产出一条 `prereq`**，**优先挂到平台课程 / 专业核心课之后**
（`from` = 平台/核心，`to` = 孤儿）；若孤儿明显是平台课 / 大一基础课（高数、线代、大学物理…）的后继，
就挂到该基础课之后；可把多门孤儿串成链；确实无依据的留空并在 `notes` 说明。
实践模块的前后置已由确定性 rule 链覆盖，通常不会成为孤儿。
合并路径与 Phase B 完全一致（写回后 `meta.status = built`）。

### 第 6 步 · 全图检查

```bash
npm run kg -- check --map <id> --report out/kg/<id>/report.md
```

- 有硬错误时**退出码非零**。
- 默认低置信度阈值取 `config.route.minConfidence`（缺省 `0.6`），可用 `--min-confidence` 覆盖。
- `--fix-cycles` 才删除环内最低置信边（默认只报告）；`--reduce` 才做传递约简（默认关闭，
  因为模型边的语义未必等价于可达性）。
- `--report` 报告额外包含「孤儿课程」「实践课链」「终结点后置」三个章节（对应 W11/W13/W12）。

---

## 2. 失败回路

1. `apply` / `check` 报出硬错误（E1-E5）或 W1 环路 → 把 `issues` 原文回灌给**同一分片**的
   subagent，限定它只修正自己的 `outputPath`，然后重跑第 4（或第 5）步。
2. 同一分片最多重跑 **2 轮**。
3. 仍失败：保留已通过的部分，把未决项写进 `report.md`，**不阻塞出图**——路线图对缺失边是容错的。

---

## 3. 图谱文件 schema（v3）

```json
{
  "version": 3,
  "id": "example",
  "meta": {
    "status": "nodes-only | built",
    "sourceRaw": "/raw/example.json",
    "builtAt": "2026-09-12T00:00:00.000Z",
    "passes": [{ "stage": "A", "shard": "叙事媒体模块", "model": null, "at": "…" }]
  },
  "nodes": [
    { "id": "SM101", "name": "叙事设计导论", "code": "SM101",
      "module": "平台课模块", "typeName": "平台课程", "category": "专必", "credits": 3,
      "semesters": ["2026-1"], "grade": 1, "spanning": false,
      "styleKey": "platform", "sourceHash": "b1f2c3d4" }
  ],
  "edges": [
    { "from": "EX201", "to": "EX202", "kind": "prereq", "confidence": 0.8,
      "evidence": "先修关系依据", "source": "agent", "pass": "A",
      "shard": "叙事媒体模块", "model": null, "createdAt": "…" }
  ],
  "suppressed": ["SM202>SM203"],
  "issues": []
}
```

- **v1 / v2 文件不再可读**：`readGraphFile` 会直接报错，并提示运行
  `npm run kg -- rebuild --map <id> --replace` 后重跑 pack/apply。`rebuild` 自身对旧版本容错
  （读取失败 → 视为无旧图谱，按全量重建处理）。
- 节点**不再有 `kind` / `op`**，只有课程。写出时统一为 v3。
- 节点 id：`courseNumber` 优先，无码时用 `courseName`；同码多行合并为一个节点。
- `grade`：`学期年 - 数据最早年 + 1`（第 1 学年 = 大一）；跨学年注记 `A~B` 标 `spanning: true`，
  按首学期归位。
- 边类型：

| kind | 含义 | 路线图 |
|---|---|---|
| `prereq` | 先修 | 平滑曲线 + 实线箭头 |
| `coreq` | 同修 | 平滑曲线 + 虚线箭头 |

- `source`：`manual`（人工，最高）| `agent`（模型判定）| `rule`（确定性规则，最低）。
  合并同一条 `(from,to)` 时，来源优先级高的一侧决定 `kind` / `source`，`confidence` 取 max；
  **manual 永不被 agent / rule 流程覆盖或删除**。
- `suppressed`：`"FROM>TO"` 数组，每次 apply 生效（manual 边除外）。

---

## 4. 校验语义

### 硬错误（拒绝该边并计入 `issues`；`check` 非零退出）

| 码 | 含义 |
|---|---|
| E1 | `from` / `to` 不存在于 `nodes`（悬空引用） |
| E2 | `evidence` 为空或少于 4 字 |
| E3 | `confidence` 不是 [0,1] 的数字，或 `kind` 不在 `{prereq, coreq}` 内 |
| E4 | 自环，或同批重复 `(from,to)` |
| E5 | Phase A 分片只接受**两端都在本片**的边（跨模块边交给 Phase B） |
| E7 | 节点 `kind` 不是 `course`（v3 已移除逻辑节点；schema 校验也会拒绝 `logic`） |

### 警告（保留并报告）

| 码 | 含义 |
|---|---|
| W1 | 环路（SCC > 1），默认只报告，`--fix-cycles` 才删环内最低置信边 |
| W2 | 逆时序（目标学期早于源；`source: "rule"` 的确定性实践链不报，其排序按课程系列阶段而非学期） |
| W3 | 置信度低于阈值（默认取 `config.route.minConfidence`，缺省 0.6） |
| W4 | 同码课程归属多个子模块（保留首次出现的模块） |
| W5 | `sourceHash` 与 raw 不一致（节点过期，需 `rebuild`） |
| W6 | 缺少可解析的学期注记（该行被丢弃） |
| W7 | 结果的分片名不在本次任务包中（无法执行 E5 片内约束，降级为全局校验） |
| W10 | 结果文件含已废弃的 `logic` 字段（忽略） |
| W11 | 仍存在无任何 `prereq`/`coreq` 关联的孤儿课程（用 Stage C 补边） |
| W12 | 终结点（毕业论文 / 毕业设计）存在后置 `prereq` |
| W13 | 实践课阶段链断裂（`practiceModule` 内 N 与 N+1 之间缺 `prereq`）或终结点不可达（无前置） |

> 实践课模块名与终结点匹配串可用 `config.route.practiceModule`（默认 `实习实践课`）与
> `config.route.terminalPatterns`（默认 `['毕业论文','毕业设计']`）覆盖。

---

## 5. 其余子命令

```bash
npm run kg -- diff    --map <id> --since out/kg/<id>/graph.prev.json   # 节点/边增删
npm run kg -- rebuild --map <id>                                       # 全量重抽节点（删除全部 agent 边）
npm run kg -- rebuild --map <id> --only SM101,SM102 --neighborhood 1  # 只重跑受影响邻域
npm run kg -- rebuild --map <id> --replace                             # 连 manual 边一起清空
npm run kg -- rebuild --map <id> --replace --keep-edges                # v1/v2 → v3 迁移并保留 prereq/coreq
npm run kg -- practice --map <id>                                      # 补齐/更新确定性实践链（rule 边，幂等）
npm run kg -- practice --map <id> --dry-run                            # 只看将发生的增删
```

`rebuild` 会重算 `sourceHash`，删除受影响节点的 agent 边（manual 边默认保留），
自动叠加确定性实践链，并清空 `meta.passes`（全量时），之后需要重新跑第 2-6 步。

`--keep-edges` 与普通 rebuild 不同：它先用 `migrateGraphToV3` 把旧图谱（v1/v2/v3 均可）
迁移到 v3（丢弃逻辑节点与 `sequence` / `equivalent` 边，保留端点在数据里仍存在的
`prereq` / `coreq`），因此不需要重跑 A/B/C。

`practice` 只做一件事：对已有图谱重新计算确定性实践链（`source: "rule"`）并按来源优先级合并。
已有 agent / manual 边不会被降级（`kind`/`source` 保留高优先级一侧），重复运行边集合稳定（幂等）。
`meta.status` 在只剩 rule 边时为 `nodes-only`，否则为 `built`。

---

## 6. 一键编排（可选）

`workflows/kg-build.mjs` 是给 pi-subagents 用的编排**生成器**（纯工具脚本，不参与
`npm run dev` / `npm run build`）。

为什么是生成器：pi-subagents 的 `workflowScript` / `workflowScriptPath` 都是原始脚本，
**不能接收 `args`**（`args` 只对具名 workflow 资源生效），脚本沙箱里也没有文件系统。
因此先用 Node 读取任务包，把 `mapId` 与 shard 列表**烘焙**进一份可直接执行的脚本，
再由父级 agent 调用 subagent 运行：

```bash
npm run kg -- pack --map example --stage a                 # 1) 先生成任务包
node workflows/kg-build.mjs --map example --agent delegate # 2) 生成 out/kg/example/build.workflow.mjs
```

```text
# 3) 父级：并发 Phase A（fresh context，每个分片一个 subagent）
subagent({ workflowScriptPath: 'out/kg/example/build.workflow.mjs', async: true })
```

```bash
# 4) barrier 之后由父级收尾
npm run kg -- apply --map example --stage a out/kg/example/result.A.*.json
npm run kg -- pack  --map example --stage b                 # 单包 → 1 个 subagent → apply --stage b
npm run kg -- pack  --map example --stage c                 # 孤儿补边单包 → 1 个 subagent → apply --stage c
npm run kg -- check --map example --report out/kg/example/report.md
```

> 生成器只编排 Phase A（多分片并发）；Phase B 与 Stage C 都是单包，父级直接派 1 个 subagent
> 处理 `packet.B.json` / `packet.C.json` 即可（无需生成器）。

每个子 agent 的约束（由生成器写进任务描述）：只读自己的 `packet.A.<shard>.json`、
只写自己的 `result.A.<shard>.json`、允许执行 `npm test` 与只读 `check`、禁止
`pack` / `apply` / `rebuild` / `init`。任务描述里已包含实践课规则与依据优先级。

---

## 7. 页面侧（课程路线图 v6：dagre 分层 + 学期色带 + coreq 同列）

- 顶栏「课程地图 | 课程路线图」分段切换；按地图记忆在 `localStorage.coursemap-theme-overrides`
  的 `view` 字段，也支持 `?view=route`。
- **节点 = unit（`coreq` 收缩组）**：并查集把每条 `coreq` 的两端并进同一 unit，unit 内成员
  按 (学期, 课码, id) 纵向堆叠，组内画虚线**配套连接器**（无箭头）。
- **列 = dagre rank**（`@dagrejs/dagre`，`rankdir:'LR'` + `network-simplex` + 交叉最小化）：
  列号沿每条非反向边**严格递增** —— 最左 = 前置，最右 = 后置。**学期不再约束列**（默认 `rankMode = "dependency"`）。
  默认模式下 `rank = min(dagre rank, 源出发最长路径深度)`，因此**所有源节点（含平台课链起始）固定在第 0 列**。
  `route.rankMode = "semester"`（或 config 未指定时 URL `?rank=semester`）改为**学期分列**：列 = 首学期序号（大一上…大四下），
  无学期节点进末尾「未标注学期」列，列内顺序仍取 dagre `order`；依赖不再决定列，边走线照旧（同列走右侧、逆时序走左侧）。
- **学期色带**：卡片左侧 4px 学期色条 + 左上角「大一上 / 大一上–大四下」角标，画布上方
  一条学期色带轴（`.route-semester-axis`）。`route.semesterBand` 控制色带轴/色条，
  `route.gradeHints` 控制角标。
- **模块不再是容器**：只决定配色与图例顺序。
- 走线是**正交折线**（`M/L/Q` 圆角）：竖直段只走列间空隙（按 y 区间 lane 分配），
  水平段只保留「卡片边 → 通道」的短 stub；跨多列的长边在**中间列全部空出来的横向走廊**高度横穿；
  反向边（环 / dagre 反向）从源卡左侧出发、目标卡右侧进入，箭头指向左；
  同一卡片同一侧的多条边在卡片高度内扇出。因此折线（端点除外）**不会进入任何卡片矩形**。
- **只画 `prereq` / `coreq` 两型边**（实线箭头 / 虚线箭头），且只画置信度 ≥
  `route.minConfidence`（默认 `0.6`）的边；没有边筛选按钮，也没有折叠总览。
- 点击课程 → 逆边闭包（全部前序）+ 顺边闭包（全部后续），无关节点淡出，**视口右侧悬浮卡片**
  分区列出证据与置信度；点击不触发页面滚动，再点同卡 / `Esc` / 点空白取消。
  浮层 `Teleport` 到 `.app-root`（在 `.sheet` 外），导出 PNG 不含它。
- `config.route` 只放版面与显示开关（**关系一律写在图谱文件里**）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `route.columns` | 内置顺序（`DEFAULT_MODULE_ORDER`） | 语义 = 图例顺序（键名保留）；不再影响分列 |
| `route.rankMode` | `dependency` | `dependency`（依赖分列，源节点在第 0 列）/ `semester`（学期分列）；URL `?rank=semester` 在 config 未指定时临时覆盖 |
| `route.excludeModules` | `[]` | 不参与路线图的模块（其课程被忽略） |
| `route.gradeHints` | `true` | 是否显示卡片学期角标 |
| `route.semesterBand` | `true` | 是否显示学期色带轴与卡片色条 |
| `route.minConfidence` | `0.6` | 边可见阈值（UI 固定按此过滤，无开关） |
| `route.practiceModule` | `实习实践课` | W13 实践课链检查的模块名 |
| `route.terminalPatterns` | `['毕业论文','毕业设计']` | W12/W13 终结点匹配串 |
| `route.semesterAxis` / `andGroups` / `collapsed` / `hideOutOfOrderEdges` | — | **已废弃，静默忽略** |
| `route.blockRows` / `blockColumns` / `nodeBlock` / `affinity` / `practiceModules` | — | **更早已废弃，静默忽略** |

> 导出实现注意：`html-to-image` 不会给 `foreignObject` 内嵌套 `<svg>` 的子元素复制计算样式，
> 所以边的 `fill`/`stroke`/`stroke-dasharray` 必须同时写成 presentation attribute
> （`RouteMap.vue` 的 `captureSvgStyles()` 会连同修配套 `<line>` 一起快照），
> 不要用 SVG `<marker>` / `<polygon>`，否则导出会退化成黑色填充或巨大黑三角。
> 布局是纯函数（固定卡片尺寸 + dagre 确定性输入顺序），不依赖 `getBoundingClientRect()` 测量；
> 卡片与边的坐标都是画布绝对坐标，`.route-canvas` 不得创建层叠上下文，否则卡片盖不住边层 SVG；
> `.route-body` 的左右 padding 负责导出贴边留白。
