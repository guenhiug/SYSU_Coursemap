# SYSU 课程地图

把教务系统导出的课程 JSON 渲染成 **课程地图海报** 与 **课程路线图** 网页，一键导出 PNG。
仓库不含真实课程数据（仓库内示例数据为虚构课程）。
![示例课程地图](images/example.png)

## 快速开始

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 产物在 dist/
npm test         # 确定性层单测（无模型、无网络）
```

顶栏：**地图切换 · 课程地图/课程路线图 · 模板一/模板二 · 导入 · 导出图片**。
URL 直达：`?map=<id>`、`?view=route`、`?rank=semester`。

- **课程地图**：每学期一列、按模块分带；横贯条带（同一门课跨多学期自动抽出长条）、空位补齐、图例自动推导。
- **课程路线图**：`@dagrejs/dagre` 分层（左 = 前置，右 = 后置），`coreq` 同修组同列堆叠，学期用色带表达；
  正交折线走线不压卡片；点击课程在右侧浮层聚焦其前序/后续（不触发页面滚动）。
- **导入**：dev 下真正保存（JSON → `data/raw/`、条目 → gitignore 的 `data/maps/index.local.json`、生成 `nodes-only` 图谱）。
- **导出图片**：PNG（标题 + 地图本体 + 图例，不含顶栏控件与聚焦浮层）。

## 数据格式

`{ code, data: { rows } }`（`{rows}` 或纯数组亦可）。用到的字段：

| 字段 | 说明 |
|---|---|
| `courseName` / `courseNumber` | 课程名（渲染名以它为准）/ 课程代码 |
| `courseCategoryName` | 公必 / 公选 / 专必 / 专选 |
| `courseSubClassModuleName` | 子模块名，可缺失（回退 `courseTypeName`，再回退 `courseCategoryName`） |
| `courseTypeName` | 公共课 / 平台课程 / 专业课 / 实践课 / 专业选修课 |
| `initiationSemesterAnnotation` | 学期注记 `2026-1`…`2029-2`；`A~B` 表示 A 到 B 每学期都出现 |

config（`theme` / `legend` / `honor` / `moduleOrder` / `relocate` / `extraCourses` / `emptySlots` / `order` /
`paletteSeed` / `route` 等）全部字段说明见 [`docs/kg-workflow.md`](docs/kg-workflow.md)。

## 添加自己的地图

1. 把导出 JSON 放进 `data/raw/`；
2. 在 **gitignore 的** `data/maps/index.local.json` 加一条：
   `{ "id": "xxx", "title": "XXX课程地图", "data": "/raw/xxx.json", "config": "/maps/xxx.config.json" }`；
3. （可选）写 `data/maps/xxx.config.json`——没有 config 也能出图。

## 课程知识图谱（路线图的箭头从哪来）

前后置关系**不用规则表猜**：确定性层（`src/lib/course-graph.js`）只做节点抽取 / 校验 / 合并 / 排布，
关系的「判断」由大模型 subagent 在工作流中完成。完整手册：[`docs/kg-workflow.md`](docs/kg-workflow.md)。

```bash
npm run kg -- help                                     # 子命令一览
npm run kg -- init    --map <id>                       # raw → nodes-only 图谱（自动带确定性实践链）
npm run kg -- pack    --map <id> --stage a             # 每子模块一个任务包 → subagent
npm run kg -- apply   --map <id> --stage a out/kg/<id>/result.A.*.json
npm run kg -- pack    --map <id> --stage b && npm run kg -- apply --map <id> --stage b out/kg/<id>/result.B.json
npm run kg -- pack    --map <id> --stage c && npm run kg -- apply --map <id> --stage c out/kg/<id>/result.C.json
npm run kg -- check   --map <id> --report out/kg/<id>/report.md
npm run kg -- practice --map <id>                      # 补齐/更新确定性实践链（幂等）
npm run kg -- rebuild --map <id> --keep-edges          # 旧图谱迁移到 v3 并保留 prereq/coreq
```

- 图谱文件 `data/maps/<id>.graph.json` 是单一数据源，页面只读。边 `kind` 只有 `prereq`（实线箭头）/ `coreq`（虚线箭头）；
  `source` 优先级 `manual` > `agent` > `rule`；UI 只画置信度 ≥ `route.minConfidence`（默认 0.6）的边。
- schema **v3** 只有课程节点（无逻辑节点）；v1/v2 文件需 `rebuild --replace` 后重跑工作流。
- `init` / 导入 / `rebuild` 会自动生成**确定性实践链**（`source: "rule"`）：把「实习实践课」模块串成单条 `prereq` 链。
- 硬错误 E1-E5 / E7 剔除并记录；警告 W1-W13（环路 / 逆时序 / 低置信 / 孤儿 / 终结点后置 / 实践链断裂 等）只报告。

## 隐私

- 真实数据只放 `data/raw/`、`data/maps/`（除列出的示例文件外**全部 gitignore**）。页面与 CLI 合并入库的
  `data/maps/index.json`（只放 curated 示例）与本地 `data/maps/index.local.json`（local 覆盖同名 id）。
- `dist/` 会把 `data/` 下全部原始数据打进产物，**不要提交或外发**；`out/`（工作流中间产物）已 gitignore。
