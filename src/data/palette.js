// 课程类别 / 选修子模块的样式键与显示名。
// styleKey 对应 global.css 中的调色变量（--c-<styleKey>-bg/fg/bd）。

export const BASIC_TYPES = [
  { key: 'commonElective', label: '公选课' },
  { key: 'commonRequired', label: '公必课' },
  { key: 'platform', label: '平台课' },
  { key: 'core', label: '专业课' },
  { key: 'practice', label: '实践课' },
]

export const ELECTIVE_LABEL = '专选课'
export const HONOR_LABEL = '荣誉课程'
export const HONOR_STYLE_KEY = 'honor'

// 选修子模块按「首次出现的顺序」分配色槽（mod-slot-0..7），
// 可用 preferredNames 预置顺序（config.moduleOrder），超过 8 个时循环复用。
const SLOT_COUNT = 8
const slotKey = (i) => `mod-slot-${i}`

export function createModuleStyleResolver(preferredNames = []) {
  const assigned = new Map()
  preferredNames.forEach((name, i) => {
    if (name) assigned.set(name, slotKey(i % SLOT_COUNT))
  })
  let next = preferredNames.length
  return (moduleName) => {
    if (!assigned.has(moduleName)) {
      assigned.set(moduleName, slotKey(next % SLOT_COUNT))
      next += 1
    }
    return assigned.get(moduleName)
  }
}

// 分带兜底链：courseSubClassModuleName → courseTypeName → courseCategoryName
const SUBCLASS_BAND = {
  公共课: 1,
  公必课模块: 1,
  平台课模块: 2,
  专必课: 2,
  实习实践课: 3,
}

const TYPE_BAND = {
  公共课: 1,
  平台课程: 2,
  专业课: 2,
  实践课: 3,
  专业选修课: 4,
}

const CATEGORY_BAND = { 公必: 1, 公选: 1, 专必: 2, 专选: 4 }

export function bandOf(row) {
  const bySubclass = SUBCLASS_BAND[row.courseSubClassModuleName]
  if (bySubclass) return bySubclass
  const byType = TYPE_BAND[row.courseTypeName]
  if (byType) return byType
  return CATEGORY_BAND[row.courseCategoryName] ?? 4
}

const CATEGORY_TYPE = { 公必: 'commonRequired', 公选: 'commonElective' }

// 带1 内区分公必/公选
export function typeOfBand1(row) {
  const sub = row.courseSubClassModuleName
  if (sub === '公选课模块') return 'commonElective'
  return CATEGORY_TYPE[row.courseCategoryName] ?? 'commonRequired'
}

// 带2 内区分平台/核心：subclass 优先，其次 courseTypeName
export function typeOfBand2(row) {
  const sub = row.courseSubClassModuleName
  if (sub === '平台课模块') return 'platform'
  if (sub === '专必课') return 'core'
  const t = row.courseTypeName
  if (t === '平台课程') return 'platform'
  if (t === '专业课') return 'core'
  return 'core'
}
