<script setup>
import { computed } from 'vue'
import { gradeLabel, semesterLabelOf } from '../lib/course-graph.js'

const props = defineProps({
  focus: { type: Object, required: true },
  nodeById: { type: Object, required: true },
})
const emit = defineEmits(['select', 'clear'])

const KIND_LABEL = { prereq: '先修', coreq: '同修' }

const nodeOf = (id) => props.nodeById?.get?.(id) ?? props.nodeById?.[id] ?? { id, name: id, code: '' }

const edgeBetween = (from, to) => props.focus.edges.find((e) => e.from === from && e.to === to)

const direct = computed(() => ({
  prev: [...props.focus.directPrev].map((id) => ({ id, edge: edgeBetween(id, props.focus.id) })),
  next: [...props.focus.directNext].map((id) => ({ id, edge: edgeBetween(props.focus.id, id) })),
}))

const transitive = computed(() => {
  const rest = (set) => [...set].filter((id) => !props.focus.directPrev.has(id) && !props.focus.directNext.has(id) && id !== props.focus.id)
  const group = (ids) => {
    const byGrade = new Map()
    for (const id of ids) {
      const g = nodeOf(id).grade ?? 0
      if (!byGrade.has(g)) byGrade.set(g, [])
      byGrade.get(g).push(id)
    }
    return [...byGrade.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([grade, list]) => ({ grade, label: gradeLabel(grade), list }))
  }
  return { prev: group(rest(props.focus.allPrev)), next: group(rest(props.focus.allNext)) }
})

const target = computed(() => nodeOf(props.focus.id))
const targetSemester = computed(() => semesterLabelOf(target.value))
</script>

<template>
  <aside class="focus-panel">
    <header class="fp-head">
      <div class="fp-title">
        <strong>{{ target.name }}</strong>
        <span class="fp-sub">
          <span v-if="target.code" class="fp-code">{{ target.code }}</span>
          <span v-if="targetSemester" class="fp-semester">{{ targetSemester }}</span>
        </span>
      </div>
      <button type="button" class="fp-clear" @click="emit('clear')">取消聚焦 (Esc)</button>
    </header>

    <section class="fp-section">
      <h3>直接先修 · {{ direct.prev.length }}</h3>
      <p v-if="!direct.prev.length" class="fp-empty">无（无前序边）</p>
      <button
        v-for="item in direct.prev"
        :key="`dp-${item.id}`"
        type="button"
        class="fp-item"
        @click="emit('select', item.id)"
      >
        <span class="fp-item-head">
          <span class="fp-name">{{ nodeOf(item.id).name }}</span>
          <em v-if="item.edge" class="fp-kind">{{ KIND_LABEL[item.edge.kind] ?? item.edge.kind }}</em>
          <span class="fp-conf">{{ item.edge?.confidence?.toFixed(2) ?? '—' }}</span>
        </span>
        <span class="fp-evidence">{{ item.edge?.evidence }}</span>
      </button>
    </section>

    <section class="fp-section">
      <h3>直接后续 · {{ direct.next.length }}</h3>
      <p v-if="!direct.next.length" class="fp-empty">无（无后续边）</p>
      <button
        v-for="item in direct.next"
        :key="`dn-${item.id}`"
        type="button"
        class="fp-item"
        @click="emit('select', item.id)"
      >
        <span class="fp-item-head">
          <span class="fp-name">{{ nodeOf(item.id).name }}</span>
          <em v-if="item.edge" class="fp-kind">{{ KIND_LABEL[item.edge.kind] ?? item.edge.kind }}</em>
          <span class="fp-conf">{{ item.edge?.confidence?.toFixed(2) ?? '—' }}</span>
        </span>
        <span class="fp-evidence">{{ item.edge?.evidence }}</span>
      </button>
    </section>

    <section v-if="transitive.prev.length" class="fp-section">
      <h3>全部前序 · {{ focus.allPrev.size }}</h3>
      <div v-for="group in transitive.prev" :key="`tp-${group.grade}`" class="fp-group">
        <div class="fp-group-title">{{ group.label }}</div>
        <button
          v-for="id in group.list"
          :key="`tp-${id}`"
          type="button"
          class="fp-chip"
          @click="emit('select', id)"
        >
          {{ nodeOf(id).name }}
        </button>
      </div>
    </section>

    <section v-if="transitive.next.length" class="fp-section">
      <h3>全部后续 · {{ focus.allNext.size }}</h3>
      <div v-for="group in transitive.next" :key="`tn-${group.grade}`" class="fp-group">
        <div class="fp-group-title">{{ group.label }}</div>
        <button
          v-for="id in group.list"
          :key="`tn-${id}`"
          type="button"
          class="fp-chip"
          @click="emit('select', id)"
        >
          {{ nodeOf(id).name }}
        </button>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.focus-panel {
  position: fixed;
  top: 96px;
  right: 20px;
  width: 300px;
  max-height: calc(100vh - 128px);
  overflow-y: auto;
  z-index: 20;
  background: #fff;
  border: 1px solid var(--c-legend-border);
  border-radius: var(--card-radius);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
  padding: 14px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.fp-head {
  position: sticky;
  top: -14px;
  z-index: 1;
  margin: -14px -14px 0;
  padding: 14px 14px 8px;
  background: #fff;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
@media (max-width: 700px) {
  .focus-panel {
    top: auto;
    left: 12px;
    right: 12px;
    bottom: 12px;
    width: auto;
    max-height: 45vh;
  }
}
.fp-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 14px;
  color: var(--c-title);
  line-height: 1.35;
}
.fp-code {
  font-size: 11px;
  font-weight: 500;
  color: #777;
}
.fp-sub {
  display: flex;
  align-items: center;
  gap: 6px;
}
.fp-semester {
  font-size: 10.5px;
  font-weight: 700;
  color: #777;
  border: 1px solid var(--c-legend-border);
  border-radius: 999px;
  padding: 0 6px;
}
.fp-clear {
  font-family: inherit;
  font-size: 11px;
  white-space: nowrap;
  border: 1px solid var(--c-legend-border);
  background: #fff;
  color: #666;
  border-radius: 6px;
  padding: 3px 7px;
  cursor: pointer;
}
.fp-section h3 {
  font-size: 12.5px;
  font-weight: 800;
  color: var(--c-title);
  margin-bottom: 6px;
}
.fp-empty {
  font-size: 11.5px;
  color: #888;
  margin: 2px 0;
}
.fp-item {
  font-family: inherit;
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--c-legend-border);
  background: color-mix(in srgb, var(--c-panel) 40%, #fff);
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 6px;
  cursor: pointer;
}
.fp-item:hover {
  border-color: var(--route-focus-ring);
}
.fp-item-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  font-weight: 700;
  color: #333;
}
.fp-conf {
  color: var(--c-arrow);
  font-weight: 700;
}
.fp-evidence {
  font-size: 11px;
  color: #666;
  line-height: 1.4;
}
.fp-kind {
  font-style: normal;
  font-weight: 700;
  color: var(--c-title);
  margin-right: 4px;
}
.fp-item-head .fp-kind {
  margin-left: auto;
  margin-right: 6px;
  font-size: 10.5px;
  color: #777;
}
.fp-group {
  margin-bottom: 6px;
}
.fp-group-title {
  font-size: 11px;
  font-weight: 700;
  color: #777;
  margin-bottom: 3px;
}
.fp-chip {
  font-family: inherit;
  font-size: 11.5px;
  border: 1px solid var(--c-legend-border);
  background: #fff;
  color: #444;
  border-radius: 999px;
  padding: 2px 9px;
  margin: 0 4px 4px 0;
  cursor: pointer;
}
.fp-chip:hover {
  border-color: var(--route-focus-ring);
  color: var(--c-title);
}
</style>
