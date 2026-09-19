<script setup>
defineProps({
  node: { type: Object, required: true },
  // '' | target | prev | next | linked | dim
  state: { type: String, default: '' },
  // 路线图里由 layout placement 给定固定尺寸，卡片填满容器
  fill: { type: Boolean, default: false },
  // 年级角标（如「大二上」）
  badge: { type: String, default: '' },
  // 学期色条（左侧 4px，inline backgroundColor，导出安全）
  semesterColor: { type: String, default: '' },
})
const emit = defineEmits(['select'])
</script>

<template>
  <button
    type="button"
    class="route-card"
    :class="[node.styleKey, state, { fill }]"
    :data-node-id="node.id"
    :title="`${node.name}${node.code ? ' ' + node.code : ''}`"
    @click.stop="emit('select', node.id)"
  >
    <span v-if="semesterColor" class="rc-band" :style="{ backgroundColor: semesterColor }" />
    <span v-if="badge" class="rc-badge">{{ badge }}</span>
    <span class="rc-name">{{ node.name }}</span>
    <span class="rc-meta">
      <span v-if="node.code" class="rc-code">{{ node.code }}</span>
      <span v-if="node.spanning" class="rc-span">贯穿</span>
    </span>
  </button>
</template>

<style scoped>
.route-card {
  font-family: inherit;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  width: 100%;
  min-height: 34px;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: var(--card-radius);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
  text-align: center;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: opacity 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
}
.route-card.fill {
  height: 100%;
  min-height: 0;
}
.rc-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.rc-badge {
  position: absolute;
  top: 1px;
  left: 7px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.3;
  opacity: 0.55;
}
/* 学期色条：常规 DOM 元素，导出时计算样式会被复制 */
.rc-band {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
}
.rc-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 500;
  opacity: 0.75;
}
.rc-span {
  border: 1px solid currentColor;
  border-radius: 999px;
  padding: 0 4px;
  font-size: 9.5px;
  line-height: 1.4;
}

/* 类别色：与海报共用 --c-* 变量 */
.route-card.commonElective {
  background: var(--c-common-elective-bg);
  color: var(--c-common-elective-fg);
}
.route-card.commonRequired {
  background: var(--c-common-required-bg);
  color: var(--c-common-required-fg);
  border-color: var(--c-common-required-bd);
}
.route-card.platform {
  background: var(--c-platform-bg);
  color: var(--c-platform-fg);
}
.route-card.core {
  background: var(--c-core-bg);
  color: var(--c-core-fg);
}
.route-card.practice {
  background: var(--c-practice-bg);
  color: var(--c-practice-fg);
}
.route-card.mod-slot-0 { background: var(--c-mod-slot-0-bg); color: var(--c-mod-slot-0-fg); border-color: var(--c-mod-slot-0-bd); }
.route-card.mod-slot-1 { background: var(--c-mod-slot-1-bg); color: var(--c-mod-slot-1-fg); border-color: var(--c-mod-slot-1-bd); }
.route-card.mod-slot-2 { background: var(--c-mod-slot-2-bg); color: var(--c-mod-slot-2-fg); }
.route-card.mod-slot-3 { background: var(--c-mod-slot-3-bg); color: var(--c-mod-slot-3-fg); border-color: var(--c-mod-slot-3-bd); }
.route-card.mod-slot-4 { background: var(--c-mod-slot-4-bg); color: var(--c-mod-slot-4-fg); border-color: var(--c-mod-slot-4-bd); }
.route-card.mod-slot-5 { background: var(--c-mod-slot-5-bg); color: var(--c-mod-slot-5-fg); border-color: var(--c-mod-slot-5-bd); }
.route-card.mod-slot-6 { background: var(--c-mod-slot-6-bg); color: var(--c-mod-slot-6-fg); }
.route-card.mod-slot-7 { background: var(--c-mod-slot-7-bg); color: var(--c-mod-slot-7-fg); border-color: var(--c-mod-slot-7-bd); }
.route-card.honor {
  background: var(--c-honor-bg);
  color: var(--c-honor-fg);
}

/* 聚焦态 */
.route-card.dim {
  opacity: var(--route-dim);
}
.route-card.target,
.route-card.prev,
.route-card.next,
.route-card.linked {
  box-shadow: 0 0 0 2px var(--route-focus-ring);
}
.route-card.target {
  box-shadow: 0 0 0 3px var(--route-focus-ring);
}
.route-card.prev {
  box-shadow: 0 0 0 2px var(--route-prev-ring);
}
.route-card.next {
  box-shadow: 0 0 0 2px var(--route-next-ring);
}
.route-card.linked {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--route-focus-ring) 55%, transparent);
}
</style>
