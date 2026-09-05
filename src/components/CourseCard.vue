<script setup>
defineProps({
  item: { type: Object, required: true },
})
</script>

<template>
  <div class="course-card" :class="[item.styleKey, item.kind]">
    <span v-if="item.kind !== 'empty'">{{ item.code ? `${item.name} ${item.code}` : item.name }}</span>
  </div>
</template>

<style scoped>
.course-card {
  border-radius: var(--card-radius);
  padding: 5px 7px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
}

/* 基础类别 */
.course-card.commonElective {
  background: var(--c-common-elective-bg);
  color: var(--c-common-elective-fg);
}
.course-card.commonRequired {
  background: var(--c-common-required-bg);
  color: var(--c-common-required-fg);
  border: 1px solid var(--c-common-required-bd);
}
.course-card.platform {
  background: var(--c-platform-bg);
  color: var(--c-platform-fg);
}
.course-card.core {
  background: var(--c-core-bg);
  color: var(--c-core-fg);
}
.course-card.practice {
  background: var(--c-practice-bg);
  color: var(--c-practice-fg);
}

/* 选修子模块色槽 */
.course-card.mod-slot-0 {
  background: var(--c-mod-slot-0-bg);
  color: var(--c-mod-slot-0-fg);
  border: 1px solid var(--c-mod-slot-0-bd);
}
.course-card.mod-slot-1 {
  background: var(--c-mod-slot-1-bg);
  color: var(--c-mod-slot-1-fg);
  border: 1px solid var(--c-mod-slot-1-bd);
}
.course-card.mod-slot-2 {
  background: var(--c-mod-slot-2-bg);
  color: var(--c-mod-slot-2-fg);
}
.course-card.mod-slot-3 {
  background: var(--c-mod-slot-3-bg);
  color: var(--c-mod-slot-3-fg);
  border: 1px solid var(--c-mod-slot-3-bd);
}
.course-card.mod-slot-4 {
  background: var(--c-mod-slot-4-bg);
  color: var(--c-mod-slot-4-fg);
  border: 1px solid var(--c-mod-slot-4-bd);
}
.course-card.mod-slot-5 {
  background: var(--c-mod-slot-5-bg);
  color: var(--c-mod-slot-5-fg);
  border: 1px solid var(--c-mod-slot-5-bd);
}
.course-card.mod-slot-6 {
  background: var(--c-mod-slot-6-bg);
  color: var(--c-mod-slot-6-fg);
  border: 1px solid var(--c-mod-slot-6-bd);
}
.course-card.mod-slot-7 {
  background: var(--c-mod-slot-7-bg);
  color: var(--c-mod-slot-7-fg);
  border: 1px solid var(--c-mod-slot-7-bd);
}

/* 荣誉课程覆盖色 */
.course-card.honor {
  background: var(--c-honor-bg);
  color: var(--c-honor-fg);
}

.course-card.placeholder {
  flex: 0 0 auto;
  min-height: 30px;
}
.course-card.empty {
  border-width: 1px;
  border-style: solid;
}
.course-card.empty.commonRequired {
  background: var(--c-common-required-bg);
  border-color: var(--c-common-required-bd);
}
</style>
