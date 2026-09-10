# SYSU 课程地图 · Python 版

原 Vue/Vite 版的 Python 重写：**读课程 JSON + 可选 config，直接输出课程地图海报 PNG**。
去掉了浏览器 UI 与交互（地图切换、导入、localStorage 主题记忆），保留全部布局算法、两套模板与配色生成。

原 JS 版完整保留在仓库根目录，可随时对照。

## 安装

```bash
py -3.13 -m venv .venv
.venv/Scripts/pip install -r py/requirements.txt
.venv/Scripts/python -m playwright install chromium   # 首次需要下载浏览器内核
```

需要 Python 3.10+。仅三个依赖：`jinja2`、`playwright`、`pytest`。

## 用法

```bash
cd py

# 单张：JSON + config
py -3.13 -m coursemap render ../data/raw/example.json --config ../data/maps/example.config.json

# 指定输出与模板
py -3.13 -m coursemap render ../data/raw/example.json \
  --config ../data/maps/example.config.json --theme template1 --out ../out/example-t1.png

# 只给 JSON（config 可省，标题默认取文件名）
py -3.13 -m coursemap render ../data/raw/example.json --seed 7

# 批量：渲染 data/maps/index.json 里的全部地图
py -3.13 -m coursemap render --all --outdir ../out

# 列出可用地图
py -3.13 -m coursemap list
```

参数：`--theme {template1,template2}`、`--legend {side,bottom}`、`--title`、`--seed`、`--out`、`--outdir`、`--scale`（默认 2）。
命令行参数覆盖 config 文件里的同名字段。

## 目录

```
py/
├── coursemap/
│   ├── palette.py     # 分带映射、选修子模块色槽（移植自 src/data/palette.js）
│   ├── theme.py       # mulberry32 + 配色变量生成（移植自 src/data/theme.js）
│   ├── normalize.py   # JSON + config -> MapData，全部布局算法（移植自 src/lib/normalize.js）
│   ├── render.py      # MapData -> HTML -> Playwright 截图
│   └── cli.py         # 命令行入口
├── templates/poster.html.j2
├── tests/             # 与 JS 原版对拍
└── tools/dump_expected.mjs
```

## 与 JS 版的一致性

**算法**：`normalize.py` / `palette.py` / `theme.py` 是逐行移植，包括 32 位位运算语义
（`Math.imul`、`>>>0`）与 `Math.round` 的 .5 向上取整——这两处不精确复刻会让同一种子产生不同配色。
`py/tests/test_normalize.py` 通过 `tools/dump_expected.mjs` 让 Node 跑出原版结果，再逐字段比对。

**样式**：渲染时不复制 CSS，而是运行时读取 `src/styles/global.css` 与各 `.vue` 的
`<style scoped>` 块内联进 HTML，DOM 类名与结构也与组件一一对应。因此不存在第二份会漂移的样式源。
代价是 Python 版依赖 `src/` 目录存在。

排版仍可能有 1-4px 级差异，来源是字体度量（原版示例用 PingFang SC，Windows 上回落到微软雅黑）。

## 测试

```bash
cd py && py -3.13 -m pytest -q
```

`test_parity_*` 需要 `node` 可执行；缺失时自动跳过。

## config 字段

与 JS 版一致，见根目录 [README.md](../README.md#config-全字段)：
`title`（支持 `{year}`）、`theme`、`legend`、`honor`、`moduleOrder`、`relocate`、
`extraCourses`、`emptySlots`、`order`、`paletteSeed`。
