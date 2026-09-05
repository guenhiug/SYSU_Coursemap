<script setup>
import { computed } from 'vue'
import BandArea from './BandArea.vue'
import LegendPanel from './LegendPanel.vue'

const props = defineProps({
  map: { type: Object, required: true },
})

// 切换地图时组件会被复用，派生值必须跟随 props 响应式更新
const n = computed(() => props.map.semesters.length)
const isBottomLegend = computed(() => props.map.legend?.position === 'bottom')
const cols = computed(() => `96px repeat(${n.value}, 172px)`)
const legendVariant = computed(() => (isBottomLegend.value ? 'bottom' : 'side'))

const SIDE_CELLS = [
  { key: 'public', label: '公共课' },
  { key: 'platform', label: '专业课' },
  { key: 'elective', label: '专选课' },
]
</script>

<template>
  <div class="course-map" :class="isBottomLegend ? 'legend-bottom' : 'legend-side'">
    <div
      class="map-main"
      :style="{ '--cols': cols, gridTemplateColumns: cols, gridTemplateRows: 'auto repeat(3, auto)' }"
    >
      <div
        v-for="i in n"
        :key="`panel-${i}`"
        class="panel-cell"
        :style="{ gridColumn: `${1 + i}`, gridRow: `2 / ${3 + 2}` }"
      />

      <div
        v-for="(s, i) in map.semesters"
        :key="s.key"
        class="sem-header"
        :class="{ last: i === n - 1 }"
        :style="{ gridColumn: `${2 + i}`, gridRow: '1' }"
      >
        {{ s.label }}
      </div>

      <BandArea
        v-for="(band, bi) in map.bands"
        :key="bi"
        :band="band"
        :band-index="bi + 1"
        :label="SIDE_CELLS[bi].label"
        :side-key="SIDE_CELLS[bi].key"
        :sem-count="n"
        :style="{ gridRow: `${bi + 2}`, gridColumn: '1 / -1' }"
      />
    </div>

    <LegendPanel :legend="map.legend" :variant="legendVariant" />
  </div>
</template>

<style scoped>
.course-map {
  display: flex;
  gap: 16px;
  width: max-content;
  align-items: stretch;
}
.course-map.legend-bottom {
  flex-direction: column;
  gap: 10px;
}

.map-main {
  display: grid;
  column-gap: 16px;
  row-gap: 10px;
  min-width: 0;
}

.panel-cell {
  background: var(--c-panel);
  border-radius: 12px;
  min-height: 100%;
}

.sem-header {
  position: relative;
  z-index: 1;
  background: var(--c-header);
  color: var(--c-header-fg);
  border-radius: var(--header-radius);
  border-bottom: var(--header-accent);
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 700;
}

/* 列间箭头：学期头右侧 */
.sem-header::after {
  content: var(--arrow-char);
  position: absolute;
  right: -22px;
  color: var(--c-arrow);
  font-size: 22px;
  font-weight: 900;
  letter-spacing: var(--arrow-ls);
  z-index: 1;
}
.sem-header.last::after {
  content: none;
}
</style>
