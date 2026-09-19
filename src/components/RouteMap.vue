<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RouteCard from './RouteCard.vue'
import RouteFocusPanel from './RouteFocusPanel.vue'
import { computeFocus, edgeKey, visibleEdges } from '../lib/course-graph.js'
import { BASIC_TYPES } from '../data/palette.js'
import { buildRouteLayout } from '../data/route-layout.js'

const props = defineProps({
  route: { type: Object, required: true },
})

const canvasEl = ref(null)
const focusId = ref('')
// 聚焦浮层由模板里的 <Teleport to=".app-root"> 挂到 .sheet 之外，导出 PNG 天然不含面板。
// 注意：模板里不要写含「--」的 HTML 注释——dev 下 Vue 会把注释渲染进 DOM，
// html-to-image 克隆后序列化成 SVG 时双连字符会让 XML 非法（导出直接失败）。

// 边的来源标签（工具提示用）。
const SOURCE_LABEL = { manual: '人工', agent: 'agent', rule: '规则' }

const nodeById = computed(() => props.route.nodeById ?? new Map())
const minConfidence = computed(() => props.route.minConfidence ?? 0.6)

// 只绘制 prereq / coreq 且置信度 ≥ route.minConfidence 的边（默认 0.6），
// 并且只把「可见边」交给布局（低于阈值的边不参与分列与 lane 分配）。
const visible = computed(() => visibleEdges(props.route.edges, { minConfidence: minConfidence.value }))

const layout = computed(() =>
  buildRouteLayout({
    nodes: props.route.nodes,
    edges: visible.value,
    config: props.route.config ?? {},
  }),
)

// 边/箭头的「已解析计算值」快照。
// 原因：html-to-image 不会给嵌套 SVG（foreignObject 内的 <svg>）的子元素复制计算样式
// （其 cloneChildren 对 SVG 元素直接返回），导出时会丢掉 class 上的 fill/stroke，
// 退化成 SVG 默认的黑色填充。因此把计算值同时写成 presentation attribute：
// 活页面仍由 CSS 类控制（类规则优先级高于 attribute），导出时 attribute 兼做兜底。
const svgStyles = ref(new Map())

const focus = computed(() =>
  focusId.value
    ? computeFocus(props.route.edges, focusId.value, { minConfidence: minConfidence.value })
    : null,
)

const edgeList = computed(() => {
  if (!focus.value) return visible.value
  const related = focus.value.related
  return visible.value.filter((edge) => related.has(edge.from) && related.has(edge.to))
})

// 布局已算好每条可见边的折线；聚焦时再按相关子集过滤要绘制的部分。
const pathKeys = computed(() => new Set(edgeList.value.map((edge) => edgeKey(edge))))

const paths = computed(() =>
  layout.value.routes
    .filter((route) => pathKeys.value.has(route.key))
    .map((route) => ({
      ...route,
      cls: edgeClass(route),
      title: `${route.kind} · 置信度 ${route.confidence} · ${SOURCE_LABEL[route.source] ?? route.source}\n${route.evidence}`,
    })),
)

// coreq 组内配套连接器（虚线，无箭头）；每条 coreq 边一根。
const companionPaths = computed(() =>
  layout.value.companions.filter(
    (companion) =>
      !focus.value || focus.value.related.has(companion.from) || focus.value.related.has(companion.to),
  ),
)

const coursePlacements = computed(() => layout.value.placements)
const showGradeHints = computed(() => props.route.config?.gradeHints !== false)
const showSemesterBand = computed(() => props.route.config?.semesterBand !== false)

const semesterBadge = (id) => (showGradeHints.value ? layout.value.semester.labelOf(id) : '')
const semesterColor = (id) => (showSemesterBand.value ? layout.value.semester.colorOf(id) : '')

const placementStyle = (p) => ({
  left: `${p.x}px`,
  top: `${p.y}px`,
  width: `${p.w}px`,
  height: `${p.h}px`,
})

const stateOf = (id) => {
  if (!focus.value) return ''
  if (id === focus.value.id) return 'target'
  if (focus.value.directPrev.has(id)) return 'prev'
  if (focus.value.directNext.has(id)) return 'next'
  if (focus.value.related.has(id)) return 'linked'
  return 'dim'
}

function onSelect(id) {
  focusId.value = focusId.value === id ? '' : id
}
function clearFocus() {
  focusId.value = ''
}
function onKeydown(e) {
  if (e.key === 'Escape') clearFocus()
}

// ---- SVG presentation attribute 快照（导出兜底） ----

function sameStyleMap(a, b) {
  if (a.size !== b.size) return false
  for (const [key, va] of a) {
    const vb = b.get(key)
    if (!vb) return false
    if (va.stroke !== vb.stroke || va.fill !== vb.fill || va.strokeWidth !== vb.strokeWidth) return false
    if (va.dasharray !== vb.dasharray || va.opacity !== vb.opacity) return false
  }
  return true
}

function captureSvgStyles(el) {
  const out = new Map()
  for (const node of el.querySelectorAll('.rg-edges [data-edge-key]')) {
    const cs = getComputedStyle(node)
    const key = node.dataset.edgeKey
    const entry = out.get(key) ?? {}
    if (node.classList.contains('arrow')) {
      entry.fill = cs.fill
      entry.opacity = cs.opacity
    } else {
      entry.stroke = cs.stroke
      entry.strokeWidth = cs.strokeWidth
      entry.dasharray = cs.strokeDasharray
      entry.opacity = cs.opacity
    }
    out.set(key, entry)
  }
  return out
}

let rafId = 0
function scheduleMeasure() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    rafId = 0
    const el = canvasEl.value
    if (!el) return
    const styles = captureSvgStyles(el)
    if (!sameStyleMap(styles, svgStyles.value)) svgStyles.value = styles
  })
}

const styleOf = (key) => svgStyles.value.get(key) ?? {}

function edgeClass(edge) {
  return `edge ${edge.kind === 'coreq' ? 'edge-coreq' : 'edge-prereq'}`
}

const legendStyles = computed(() => {
  const used = new Set(props.route.nodes.map((n) => n.styleKey))
  const basics = BASIC_TYPES.filter((t) => used.has(t.key))
  const moduleName = new Map()
  for (const node of props.route.nodes) {
    if (node.styleKey?.startsWith('mod-slot') && !moduleName.has(node.styleKey)) moduleName.set(node.styleKey, node.module)
  }
  const slots = [...moduleName.keys()].sort((a, b) => Number(a.slice(9)) - Number(b.slice(9)))
  return { basics, slots: slots.map((key) => ({ key, name: moduleName.get(key) })), honor: used.has('honor') }
})

const statusHint = computed(() => {
  const { status, edges } = props.route
  if (status === 'built') return ''
  if (!edges.length) {
    return '图谱未建（nodes-only）：当前只显示课程与分层，运行工作流后才有前后置箭头。'
  }
  return ''
})

const layoutIssues = computed(() => layout.value.issues ?? [])
const errorCount = computed(
  () => [...(props.route.issues ?? []), ...layoutIssues.value].filter((i) => i.level === 'error').length,
)
const warnCount = computed(
  () => [...(props.route.issues ?? []), ...layoutIssues.value].filter((i) => i.level !== 'error').length,
)
const thresholdText = computed(() => `仅显示置信度 ≥ ${minConfidence.value}`)

watch(
  () => props.route,
  () => clearFocus(),
)
watch([() => paths.value, () => coursePlacements.value], () => nextTick(scheduleMeasure))

let observer = null
onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => scheduleMeasure())
    if (canvasEl.value) observer.observe(canvasEl.value)
  }
  nextTick(scheduleMeasure)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (observer) observer.disconnect()
  if (rafId) cancelAnimationFrame(rafId)
})
</script>

<template>
  <div class="route-map">
    <div v-if="statusHint" class="route-hint">
      <strong>{{ statusHint }}</strong>
      <span class="hint-cmd">npm run kg -- pack --map &lt;id&gt; --stage a</span>
    </div>
    <div v-if="errorCount || warnCount" class="route-issues">
      图谱问题：硬错误 {{ errorCount }} · 警告 {{ warnCount }}（详见 npm run kg -- check）
    </div>

    <div
      v-if="showSemesterBand && layout.semester.ruler.length"
      class="route-semester-axis"
      :style="{ maxWidth: `${Math.max(layout.size.w, 360)}px` }"
    >
      <span class="rsa-title">学期色带</span>
      <span
        v-for="cell in layout.semester.ruler"
        :key="cell.key"
        class="rsa-cell"
        :style="{ backgroundColor: cell.color }"
      >{{ cell.label }}</span>
    </div>

    <div class="route-body">
      <div
        ref="canvasEl"
        class="route-canvas"
        :style="{ width: `${layout.size.w}px`, height: `${layout.size.h}px` }"
        @click.self="clearFocus"
      >
        <RouteCard
          v-for="p in coursePlacements"
          :key="p.id"
          :node="nodeById.get(p.id)"
          :state="stateOf(p.id)"
          :badge="semesterBadge(p.id)"
          :semester-color="semesterColor(p.id)"
          :style="placementStyle(p)"
          fill
          @select="onSelect"
        />

        <svg class="rg-edges" :width="layout.size.w" :height="layout.size.h" :viewBox="`0 0 ${layout.size.w} ${layout.size.h}`" aria-hidden="true">
          <path
            v-for="p in paths"
            :key="p.key"
            :data-edge-key="p.key"
            :d="p.d"
            :class="p.cls"
            fill="none"
            :stroke="styleOf(p.key).stroke"
            :stroke-width="styleOf(p.key).strokeWidth"
            :stroke-dasharray="styleOf(p.key).dasharray"
            :opacity="styleOf(p.key).opacity"
          >
            <title>{{ p.title }}</title>
          </path>
          <path
            v-for="p in paths"
            :key="`a-${p.key}`"
            :data-edge-key="p.key"
            :d="p.arrow"
            :class="`arrow ${p.cls}`"
            stroke="none"
            :fill="styleOf(p.key).fill"
          />
          <line
            v-for="c in companionPaths"
            :key="c.key"
            :data-edge-key="c.key"
            :x1="c.x1"
            :y1="c.y1"
            :x2="c.x2"
            :y2="c.y2"
            class="edge edge-companion"
            :stroke="styleOf(c.key).stroke"
            :stroke-width="styleOf(c.key).strokeWidth"
            :stroke-dasharray="styleOf(c.key).dasharray"
            :opacity="styleOf(c.key).opacity"
          />
        </svg>
      </div>
    </div>

    <Teleport to=".app-root">
      <RouteFocusPanel
        v-if="focus"
        :focus="focus"
        :node-by-id="nodeById"
        @select="onSelect"
        @clear="clearFocus"
      />
    </Teleport>

    <div class="route-legend" :style="{ maxWidth: `${Math.max(layout.size.w + 36, 360)}px` }">
      <span class="rl-title">图例</span>
      <span v-for="b in legendStyles.basics" :key="b.key" class="rl-pill" :class="b.key">{{ b.label }}</span>
      <span v-for="s in legendStyles.slots" :key="s.key" class="rl-pill" :class="s.key">{{ s.name }}</span>
      <span v-if="legendStyles.honor" class="rl-pill honor">荣誉课程</span>
      <span class="rl-sep" />
      <span class="rl-edge"><i class="edge-sample edge-prereq" />先修（实线箭头）</span>
      <span class="rl-edge"><i class="edge-sample edge-coreq" />同修（虚线箭头）</span>
      <span class="rl-edge"><i class="edge-sample edge-companion" />同修配套（组内）</span>
      <span class="rl-sep" />
      <span class="rl-edge">{{ thresholdText }}</span>
    </div>
  </div>
</template>

<style scoped>
.route-map {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  width: max-content;
}
.route-hint,
.route-issues {
  width: 100%;
  border-radius: 8px;
  padding: 9px 14px;
  font-size: 12.5px;
  line-height: 1.5;
}
.route-hint {
  background: color-mix(in srgb, var(--c-honor-bg) 45%, #fff);
  border: 1px solid var(--c-honor-bg);
  color: var(--c-honor-fg);
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.hint-cmd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  background: #fff;
  border-radius: 5px;
  padding: 2px 7px;
}
.route-issues {
  background: #fdecec;
  border: 1px solid #f3c1be;
  color: #b3261e;
}

/* 学期色带轴：与画布等宽的纯 DOM（导出 PNG 会包含） */
.route-semester-axis {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  width: 100%;
  align-self: stretch;
  padding: 6px 0;
}
.rsa-title {
  font-size: 11.5px;
  font-weight: 800;
  color: var(--c-title);
  margin-right: 4px;
}
.rsa-cell {
  min-width: 54px;
  text-align: center;
  border-radius: 5px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.18);
}

.route-body {
  display: block;
  /* 画布左右留白：导出 PNG 与页面都不让卡片贴边 */
  padding: 0 18px;
}
/* 画布不创建层叠上下文：边层（z 2）< 卡片（z 3） */
.route-canvas {
  position: relative;
}

.rg-edges {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 2;
  pointer-events: none;
  overflow: visible;
}
.route-canvas :deep(.route-card) {
  position: absolute;
  z-index: 3;
}

.edge {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.arrow {
  stroke: none;
}
.edge-prereq {
  stroke: var(--route-edge-agent);
  stroke-width: 1.7;
}
.edge-coreq {
  stroke: var(--route-edge-agent);
  stroke-width: 1.7;
  stroke-dasharray: 5 4;
}
.arrow.edge-prereq,
.arrow.edge-coreq {
  fill: var(--route-edge-agent);
}
.edge-companion {
  stroke: var(--route-edge-agent);
  stroke-width: 1.5;
  stroke-dasharray: 3 3;
  opacity: 0.75;
}

.route-legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  border: 1px solid var(--c-legend-border);
  background: #fff;
  border-radius: var(--card-radius);
  padding: 10px 16px;
  align-self: stretch;
  font-size: 12px;
  color: #555;
}
.rl-title {
  font-weight: 800;
  color: var(--c-title);
}
.rl-pill {
  border-radius: var(--pill-radius);
  padding: 3px 12px;
  font-weight: 700;
  font-size: 11.5px;
}
.rl-pill.commonElective { background: var(--c-common-elective-bg); color: var(--c-common-elective-fg); }
.rl-pill.commonRequired { background: var(--c-common-required-bg); color: var(--c-common-required-fg); border: 1px solid var(--c-common-required-bd); }
.rl-pill.platform { background: var(--c-platform-bg); color: var(--c-platform-fg); }
.rl-pill.core { background: var(--c-core-bg); color: var(--c-core-fg); }
.rl-pill.practice { background: var(--c-practice-bg); color: var(--c-practice-fg); }
.rl-pill.honor { background: var(--c-honor-bg); color: var(--c-honor-fg); }
.rl-pill.mod-slot-0 { background: var(--c-mod-slot-0-bg); color: var(--c-mod-slot-0-fg); border: 1px solid var(--c-mod-slot-0-bd); }
.rl-pill.mod-slot-1 { background: var(--c-mod-slot-1-bg); color: var(--c-mod-slot-1-fg); border: 1px solid var(--c-mod-slot-1-bd); }
.rl-pill.mod-slot-2 { background: var(--c-mod-slot-2-bg); color: var(--c-mod-slot-2-fg); }
.rl-pill.mod-slot-3 { background: var(--c-mod-slot-3-bg); color: var(--c-mod-slot-3-fg); border: 1px solid var(--c-mod-slot-3-bd); }
.rl-pill.mod-slot-4 { background: var(--c-mod-slot-4-bg); color: var(--c-mod-slot-4-fg); border: 1px solid var(--c-mod-slot-4-bd); }
.rl-pill.mod-slot-5 { background: var(--c-mod-slot-5-bg); color: var(--c-mod-slot-5-fg); border: 1px solid var(--c-mod-slot-5-bd); }
.rl-pill.mod-slot-6 { background: var(--c-mod-slot-6-bg); color: var(--c-mod-slot-6-fg); }
.rl-pill.mod-slot-7 { background: var(--c-mod-slot-7-bg); color: var(--c-mod-slot-7-fg); border: 1px solid var(--c-mod-slot-7-bd); }
.rl-sep {
  width: 1px;
  align-self: stretch;
  background: var(--c-legend-border);
}
.rl-edge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.edge-sample {
  width: 26px;
  height: 0;
  border-top-width: 2px;
  border-top-style: solid;
  border-color: var(--route-edge-agent);
}
.edge-sample.edge-coreq {
  border-top-style: dashed;
}
.edge-sample.edge-companion {
  border-top-style: dashed;
  border-top-width: 2px;
  border-color: color-mix(in srgb, var(--route-edge-agent) 75%, transparent);
}
</style>
