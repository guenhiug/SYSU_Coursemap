<script setup>
import { ELECTIVE_LABEL, HONOR_LABEL } from '../data/palette.js'

defineProps({
  legend: { type: Object, required: true },
  variant: { type: String, default: 'side' }, // side: 右侧竖排面板 | bottom: 底部横排
})
</script>

<template>
  <aside class="legend" :class="`legend--${variant}`">
    <h2>图例与课程类别</h2>
    <div
      v-for="b in legend.basics"
      :key="b.key"
      class="pill"
      :class="b.key"
    >
      {{ b.label }}
    </div>

    <div v-if="legend.modules.length" class="elective-group">
      <div class="group-title">{{ ELECTIVE_LABEL }}</div>
      <div
        v-for="m in legend.modules"
        :key="m.styleKey"
        class="pill"
        :class="m.styleKey"
      >
        {{ m.name }}
      </div>
    </div>

    <div v-if="legend.hasHonor" class="pill honor">{{ HONOR_LABEL }}</div>
  </aside>
</template>

<style scoped>
.legend {
  background: #ffffff;
  border: 1px solid var(--c-legend-border);
  border-radius: var(--card-radius);
  padding: 18px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.legend--side {
  width: 256px;
  align-self: stretch;
}
h2 {
  font-size: 17px;
  font-weight: 800;
  color: var(--c-title);
  text-align: center;
  margin-bottom: 4px;
}

.pill {
  min-height: 40px;
  border-radius: var(--pill-radius);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  text-align: center;
  padding: 4px 10px;
  line-height: 1.35;
  white-space: nowrap;
}

.pill.commonElective {
  background: var(--c-common-elective-bg);
  color: var(--c-common-elective-fg);
}
.pill.commonRequired {
  background: var(--c-common-required-bg);
  color: var(--c-common-required-fg);
  border: 1px solid var(--c-common-required-bd);
}
.pill.platform {
  background: var(--c-platform-bg);
  color: var(--c-platform-fg);
}
.pill.core {
  background: var(--c-core-bg);
  color: var(--c-core-fg);
}
.pill.practice {
  background: var(--c-practice-bg);
  color: var(--c-practice-fg);
}
.pill.mod-slot-0 {
  background: var(--c-mod-slot-0-bg);
  color: var(--c-mod-slot-0-fg);
  border: 1px solid var(--c-mod-slot-0-bd);
}
.pill.mod-slot-1 {
  background: var(--c-mod-slot-1-bg);
  color: var(--c-mod-slot-1-fg);
  border: 1px solid var(--c-mod-slot-1-bd);
}
.pill.mod-slot-2 {
  background: var(--c-mod-slot-2-bg);
  color: var(--c-mod-slot-2-fg);
}
.pill.mod-slot-3 {
  background: var(--c-mod-slot-3-bg);
  color: var(--c-mod-slot-3-fg);
  border: 1px solid var(--c-mod-slot-3-bd);
}
.pill.mod-slot-4 {
  background: var(--c-mod-slot-4-bg);
  color: var(--c-mod-slot-4-fg);
  border: 1px solid var(--c-mod-slot-4-bd);
}
.pill.mod-slot-5 {
  background: var(--c-mod-slot-5-bg);
  color: var(--c-mod-slot-5-fg);
  border: 1px solid var(--c-mod-slot-5-bd);
}
.pill.mod-slot-6 {
  background: var(--c-mod-slot-6-bg);
  color: var(--c-mod-slot-6-fg);
  border: 1px solid var(--c-mod-slot-6-bd);
}
.pill.mod-slot-7 {
  background: var(--c-mod-slot-7-bg);
  color: var(--c-mod-slot-7-fg);
  border: 1px solid var(--c-mod-slot-7-bd);
}
.pill.honor {
  background: var(--c-honor-bg);
  color: var(--c-honor-fg);
}

.elective-group {
  background: var(--c-panel);
  border-radius: var(--pill-radius);
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.group-title {
  font-size: 15px;
  font-weight: 800;
  color: #333;
  text-align: center;
}

/* 底部横排变体 */
.legend--bottom {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 12px;
  padding: 12px 18px;
  align-self: stretch;
}
.legend--bottom h2 {
  margin: 0 8px 0 0;
  white-space: nowrap;
}
.legend--bottom .pill {
  min-height: 34px;
  padding: 4px 14px;
}
.legend--bottom .elective-group {
  flex-direction: row;
  align-items: center;
  gap: 12px;
  background: transparent;
  border-radius: 0;
  border-left: 1px solid var(--c-legend-border);
  padding: 0 0 0 16px;
}
.legend--bottom .group-title {
  margin: 0 4px 0 0;
}
</style>
