<script setup>
import { computed } from 'vue'
import CourseCard from './CourseCard.vue'

const props = defineProps({
  band: { type: Object, required: true }, // { strips, lifts, blanks, stacks }
  label: { type: String, required: true },
  sideKey: { type: String, required: true },
  bandIndex: { type: Number, required: true }, // 1..4
  semCount: { type: Number, required: true },
})

// 切换地图时组件会被复用（key 只按带序），行数必须跟随 props 响应式更新
const stripRowCount = computed(() => props.band.strips.length)
</script>

<template>
  <div
    class="band-area"
    :style="{ gridTemplateRows: `repeat(${stripRowCount}, auto) auto` }"
  >
    <div
      class="side-cell"
      :class="`side-${sideKey}`"
      :style="{ gridColumn: '1', gridRow: `1 / ${stripRowCount + 2}` }"
    >
      {{ label }}
    </div>

    <template v-for="s in band.strips" :key="`strip-${s.row}-${s.segments.map((g) => g.item.key).join('_')}`">
      <CourseCard
        v-for="seg in s.segments"
        :key="`strip-${s.row}-${seg.item.key}`"
        :item="seg.item"
        class="strip"
        :style="{
          gridColumn: `${seg.start + 1} / ${seg.end + 2}`,
          gridRow: `${s.row + 1}`,
        }"
      />
    </template>

    <CourseCard
      v-for="l in band.lifts"
      :key="`lift-${l.col}-${l.row}-${l.item.key}`"
      :item="l.item"
      class="strip"
      :style="{ gridColumn: `${l.col + 2}`, gridRow: `${l.row + 1}` }"
    />

    <div
      v-for="b in band.blanks"
      :key="`blank-${b.col}-${b.row}`"
      class="strip blank"
      :style="{ gridColumn: `${b.col + 2}`, gridRow: `${b.row + 1}` }"
    />

    <template v-for="(stack, i) in band.stacks" :key="i">
      <div
        class="stack-cell"
        :class="[`band-${bandIndex}`, { last: i === semCount - 1 }]"
        :style="{ gridColumn: `${2 + i}`, gridRow: `${stripRowCount + 1}` }"
      >
        <CourseCard v-for="item in stack" :key="item.key" :item="item" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.band-area {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: var(--cols);
  column-gap: 16px;
  row-gap: 6px;
  min-width: 0;
}

.side-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--side-bg);
  border-radius: var(--side-radius);
  padding: 12px 8px;
  font-size: 14px;
  font-weight: 700;
  text-align: center;
  line-height: 1.5;
}
.side-public {
  border: var(--side-public-line);
  border-left: var(--side-public-accent);
  color: var(--side-public-fg);
}
.side-platform {
  border: var(--side-platform-line);
  border-left: var(--side-platform-accent);
  color: var(--side-platform-fg);
}
.side-practice {
  border: var(--side-practice-line);
  border-left: var(--side-practice-accent);
  color: var(--side-practice-fg);
}
.side-elective {
  border: var(--side-elective-line);
  border-left: var(--side-elective-accent);
  color: var(--side-elective-fg);
}

.strip {
  min-height: 38px;
}

.strip.blank {
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--c-legend-border) 75%, transparent);
}

.stack-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  position: relative;
  align-items: stretch;
}
.stack-cell > * {
  flex: 0 0 auto;
}
</style>
