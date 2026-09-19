<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import CourseMap from './components/CourseMap.vue'
import RouteMap from './components/RouteMap.vue'
import { normalizeMap } from './lib/normalize.js'
import { buildRouteView, graphPathOf, mergeMapIndex } from './lib/course-graph.js'
import { toPng } from 'html-to-image'

const entries = ref([])
const selectedId = ref('')
const mapData = ref(null)
const rawData = ref(null)
const currentConfig = ref({})
const graph = ref(null)
const view = ref('map')
const error = ref('')
const exporting = ref(false)
const fileInput = ref(null)
let importSeq = 0

async function fetchJson(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`加载失败(${r.status}): ${url}`)
  const text = await r.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`路径返回的不是 JSON（文件不存在或路径写错？）: ${url}`)
  }
}

function friendlyError(e) {
  const msg = String(e)
  if (/Failed to fetch/i.test(msg)) {
    return '无法连接服务器：请确认 npm run dev 正在运行，并通过 http://localhost:5173 访问（不要用 file:// 直接打开页面）'
  }
  return msg
}

const OVERRIDE_KEY = 'coursemap-theme-overrides'

function readOverrides() {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDE_KEY)) ?? {}
  } catch {
    return {}
  }
}

function applyOverride(id, config) {
  const ov = readOverrides()[id] ?? {}
  return {
    ...config,
    ...(ov.theme ? { theme: ov.theme } : {}),
    ...(ov.legend ? { legend: ov.legend } : {}),
  }
}

function applyViewOverride(id) {
  const ov = readOverrides()[id] ?? {}
  const fromUrl = new URLSearchParams(location.search).get('view')
  if (fromUrl === 'route' || fromUrl === 'map') return fromUrl
  return ov.view === 'route' ? 'route' : 'map'
}

async function loadGraph(entry) {
  const url = graphPathOf(entry)
  if (!url) return null
  try {
    const r = await fetch(url)
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

async function renderEntry(entry) {
  error.value = ''
  try {
    const raw = entry.raw ?? (await fetchJson(entry.data))
    const fileConfig = entry.raw
      ? {}
      : entry.config
        ? await fetchJson(entry.config).catch(() => ({}))
        : {}
    const config = applyOverride(entry.id, { title: entry.title, ...fileConfig })
    // ?rank=semester 临时切换列模式；config.route.rankMode 优先（URL 仅作缺省补充）。
    const rankParam = new URLSearchParams(location.search).get('rank')
    if (rankParam && !config.route?.rankMode) {
      config.route = { ...(config.route ?? {}), rankMode: rankParam }
    }
    rawData.value = raw
    currentConfig.value = config
    mapData.value = normalizeMap(raw, config)
    graph.value = entry.raw ? null : await loadGraph(entry)
    view.value = applyViewOverride(entry.id)
  } catch (e) {
    error.value = friendlyError(e)
    mapData.value = null
    rawData.value = null
    currentConfig.value = {}
    graph.value = null
  }
}

async function setTheme(theme) {
  if (!mapData.value || mapData.value.theme === theme) return
  const entry = entries.value.find((e) => e.id === selectedId.value)
  if (!entry) return
  const store = readOverrides()
  store[entry.id] = { ...(store[entry.id] ?? {}), theme, legend: theme === 'template2' ? 'bottom' : 'side' }
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(store))
  } catch {
    /* localStorage 不可用时仅本次会话生效 */
  }
  await renderEntry(entry)
}

function setView(next) {
  view.value = next
  const entry = entries.value.find((e) => e.id === selectedId.value)
  if (!entry) return
  const store = readOverrides()
  store[entry.id] = { ...(store[entry.id] ?? {}), view: next === 'route' ? 'route' : 'map' }
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(store))
  } catch {
    /* 仅本次会话生效 */
  }
}

const routeView = computed(() => {
  if (view.value !== 'route' || !mapData.value) return null
  return buildRouteView({ raw: rawData.value, graph: graph.value, config: currentConfig.value })
})

const sheetTitle = computed(() =>
  view.value === 'route' && mapData.value ? `${mapData.value.title} · 课程路线图` : mapData.value?.title ?? '',
)

// 地图清单 = 入库的 index.json + 本地 index.local.json（后者 gitignore，local 覆盖同名 id）。
async function loadEntries() {
  const [committed, local] = await Promise.all([
    fetchJson('/maps/index.json'),
    fetchJson('/maps/index.local.json').catch(() => []),
  ])
  return mergeMapIndex(committed, local)
}

onMounted(async () => {
  try {
    entries.value = await loadEntries()
  } catch (e) {
    error.value = /Failed to fetch/i.test(String(e))
      ? '地图清单加载失败：无法连接服务器。请确认 npm run dev 正在运行，并通过 http://localhost:5173 访问（不要用 file:// 直接打开页面）'
      : `地图清单加载失败: ${e}`
    return
  }
  const want = new URLSearchParams(location.search).get('map')
  const initial = entries.value.find((e) => e.id === want) ?? entries.value[0]
  if (initial) {
    selectedId.value = initial.id
  }
})

watch(selectedId, (id) => {
  const entry = entries.value.find((e) => e.id === id)
  if (entry) renderEntry(entry)
})

async function saveImportedMap(file, text) {
  const params = new URLSearchParams({ name: file.name })
  if (mapData.value?.theme) params.set('theme', mapData.value.theme)
  if (mapData.value?.legend?.position) params.set('legend', mapData.value.legend.position)
  const r = await fetch(`/api/save-map?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: text,
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || !body.ok) throw new Error(body.error || `保存失败(${r.status})`)
  return body
}

function onFileChange(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  if (/\.xlsx$/i.test(file.name)) {
    error.value = 'Excel 导入暂未开放，请先使用 JSON 文件'
    return
  }
  const reader = new FileReader()
  reader.onload = async () => {
    let raw
    try {
      raw = JSON.parse(String(reader.result))
    } catch (err) {
      error.value = `导入失败: ${err.message}`
      return
    }
    try {
      const saved = await saveImportedMap(file, String(reader.result))
      entries.value = await loadEntries()
      if (selectedId.value === saved.id) {
        const entry = entries.value.find((en) => en.id === saved.id)
        if (entry) await renderEntry(entry)
      } else {
        selectedId.value = saved.id
      }
      error.value = ''
    } catch (saveErr) {
      // dev 保存接口不可用（vite preview / file:// 直开）→ 退化为会话内导入
      const title = file.name.replace(/\.[^.]+$/, '')
      const id = `imported-${++importSeq}`
      entries.value = [...entries.value, { id, title, raw }]
      selectedId.value = id
      error.value = ''
    }
  }
  reader.onerror = () => {
    error.value = '文件读取失败'
  }
  reader.readAsText(file)
}

async function exportPng() {
  if (!mapData.value || exporting.value) return
  const el = document.querySelector('.sheet')
  if (!el) return
  exporting.value = true
  error.value = ''
  try {
    const root = document.querySelector('.app-root')
    const bg = getComputedStyle(root).backgroundColor
    const dataUrl = await toPng(el, { pixelRatio: 2, backgroundColor: bg })
    const a = document.createElement('a')
    a.download = view.value === 'route' ? `${mapData.value.title}-路线图.png` : `${mapData.value.title}.png`
    a.href = dataUrl
    a.click()
  } catch (e) {
    const detail = e?.message ?? e?.name ?? String(e) ?? '未知错误'
    error.value = `导出失败: ${detail}`
    console.error('[exportPng]', e)
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div
    class="app-root"
    :data-theme="mapData?.theme ?? 'template1'"
    :style="mapData?.paletteVars"
  >
    <header class="topbar">
      <div class="controls">
        <select v-model="selectedId" class="map-picker" aria-label="选择课程地图">
          <option v-for="e in entries" :key="e.id" :value="e.id">{{ e.title }}</option>
        </select>
        <div class="theme-switch" role="group" aria-label="切换视图">
          <button
            class="btn theme-btn"
            :class="{ active: view === 'map' }"
            type="button"
            :disabled="!mapData"
            @click="setView('map')"
          >
            课程地图
          </button>
          <button
            class="btn theme-btn"
            :class="{ active: view === 'route' }"
            type="button"
            :disabled="!mapData"
            @click="setView('route')"
          >
            课程路线图
          </button>
        </div>
        <div class="theme-switch" role="group" aria-label="切换模板">
          <button
            class="btn theme-btn"
            :class="{ active: mapData?.theme === 'template1' }"
            type="button"
            :disabled="!mapData"
            @click="setTheme('template1')"
          >
            模板一
          </button>
          <button
            class="btn theme-btn"
            :class="{ active: mapData?.theme === 'template2' }"
            type="button"
            :disabled="!mapData"
            @click="setTheme('template2')"
          >
            模板二
          </button>
        </div>
        <button class="btn" type="button" @click="fileInput?.click()">导入</button>
        <input
          ref="fileInput"
          type="file"
          accept=".json,.xlsx"
          style="display: none"
          @change="onFileChange"
        />
        <button class="btn" type="button" :disabled="exporting" @click="exportPng">
          {{ exporting ? '导出中…' : '导出图片' }}
        </button>
      </div>
    </header>

    <main class="viewport">
      <div v-if="error" class="error">{{ error }}</div>
      <div v-else-if="mapData" class="sheet">
        <div class="title-row">
          <span class="deco deco-left" aria-hidden="true"><i /><i /><i /></span>
          <h1>{{ sheetTitle }}</h1>
          <span class="deco deco-right" aria-hidden="true"><i /><i /><i /></span>
        </div>
        <RouteMap
          v-if="view === 'route' && routeView"
          :route="routeView"
        />
        <CourseMap v-else :map="mapData" />
      </div>
    </main>
  </div>
</template>

<style scoped>
.app-root {
  min-height: 100vh;
  background: var(--c-page);
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px 20px;
  padding: 26px 32px 10px;
}
.sheet {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  width: max-content;
  margin: 0 auto;
}
.title-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
}
h1 {
  font-family: var(--font-title);
  font-size: 30px;
  font-weight: 800;
  color: var(--c-title);
  letter-spacing: 1px;
}
.deco {
  display: inline-flex;
  gap: 5px;
}
.deco i {
  width: 0;
  height: 0;
  border-top: 8px solid transparent;
  border-bottom: 8px solid transparent;
}
.deco-right i {
  border-left: 12px solid var(--c-arrow);
}
.deco-left i {
  border-right: 12px solid var(--c-arrow);
}
.deco i:nth-child(1) {
  opacity: 0.25;
}
.deco i:nth-child(2) {
  opacity: 0.55;
}
.deco i:nth-child(3) {
  opacity: 1;
}
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.map-picker {
  font-family: inherit;
  font-size: 13px;
  padding: 6px 10px;
  border: 1px solid var(--c-legend-border);
  border-radius: 8px;
  background: #fff;
  color: #444;
  max-width: 280px;
}
.btn {
  font-family: inherit;
  font-size: 13px;
  padding: 6px 14px;
  border: 1px solid var(--c-legend-border);
  border-radius: 8px;
  background: #fff;
  color: #444;
  cursor: pointer;
}
.btn:hover {
  border-color: var(--c-arrow);
  color: var(--c-title);
}
.btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.theme-switch {
  display: flex;
}
.theme-btn + .theme-btn {
  margin-left: -1px;
}
.theme-btn:first-child {
  border-radius: 8px 0 0 8px;
}
.theme-btn:last-child {
  border-radius: 0 8px 8px 0;
}
.theme-btn.active {
  border-color: var(--c-arrow);
  color: var(--c-title);
  font-weight: 700;
  box-shadow: inset 0 0 0 1px var(--c-arrow);
}

.viewport {
  overflow-x: auto;
  padding: 18px 32px 40px;
}
.error {
  color: #b3261e;
  background: #fdecec;
  border: 1px solid #f3c1be;
  border-radius: 8px;
  padding: 14px 18px;
  max-width: 720px;
  margin: 40px auto;
  font-size: 14px;
}
</style>
