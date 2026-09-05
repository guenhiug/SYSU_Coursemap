import {
  bandOf,
  typeOfBand1,
  typeOfBand2,
  createModuleStyleResolver,
  BASIC_TYPES,
  HONOR_STYLE_KEY,
} from '../data/palette.js'
import { generatePalette } from '../data/theme.js'

// 输入：接口导出 JSON（{code,data:{rows}} / {rows} / 数组均可）+ 可选 config
// 输出 MapData：
// {
//   title, startYear, theme, paletteVars,
//   semesters: [{ key, label }],
//   bands: [3 × { strips: [{segments:[{item,start,end}]}], lifts: [{item,col,row}], stacks: [每学期一个数组] }],
//     带1 公共课（含公必/公选）/ 带2 专业课（平台+核心+实践合并）/ 带3 专选课
//   legend: { basics, modules, hasHonor, position },
// }
//
// config 结构（全部可省略）：
// {
//   title: '海报标题（支持 {year} 占位 = 数据最早年份）',
//   honor: ['XXXX101', ...],                     // 荣誉课程代码（覆盖底色）
//   relocate: [{ code, semesters?, band? }],     // 覆盖学期归位（按学期序号）与所在带（合并前 1-4）
//   extraCourses: [{ semesters:'all'|[1..N], band, key, name, code?, type, placeholder? }],
//   emptySlots:  [{ semester, band, style? }],   // 空占位盒（band 取合并前编号 1-4）
//   order:       { '学期-带': [key, ...] },       // 显式排序（带取合并前编号 1-4）
//   theme:       'template1' | 'template2',
//   legend:      'side' | 'bottom',
//   moduleOrder: ['模块名', ...],
//   paletteSeed: 12345,
// }

const PLACEHOLDER_KEY = '__PLACEHOLDER_PUBLIC_ELECTIVE__'
const ART_KEY = '__ART_AESTHETIC__'

const THEME_ALIAS = { default: 'template1', integrated: 'template2' }

function extractRows(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.rows)) return raw.rows
  if (Array.isArray(raw?.data?.rows)) return raw.data.rows
  throw new Error('无法识别的数据格式：期望 data.rows / rows / 数组')
}

function parseSemesterKey(key) {
  const m = /^(\d{4})-(\d+)$/.exec(String(key).trim())
  if (!m) return null
  return { year: Number(m[1]), num: Number(m[2]) }
}

// '2026-1~2029-2' → 区间内所有学期 key（含端点）；单值 → [自身]
function expandAnnotation(annotation) {
  const parts = String(annotation ?? '').split('~').map((s) => s.trim())
  const start = parseSemesterKey(parts[0])
  if (!start) return []
  if (parts.length === 1) return [parts[0]]
  const end = parseSemesterKey(parts[1]) ?? start
  const keys = []
  for (let y = start.year; y <= end.year; y += 1) {
    for (let n = 1; n <= 2; n += 1) {
      if (y === start.year && n < start.num) continue
      if (y === end.year && n > end.num) continue
      keys.push(`${y}-${n}`)
    }
  }
  return keys
}

const semesterOrdinals = (keys) => {
  const sorted = [...keys].sort((a, b) => {
    const pa = parseSemesterKey(a)
    const pb = parseSemesterKey(b)
    return pa.year - pb.year || pa.num - pb.num
  })
  return new Map(sorted.map((key, i) => [key, i + 1]))
}

function baseItem(row, band, resolveModuleStyle) {
  const code = row.courseNumber ?? ''
  const name = row.courseName ?? ''
  let styleKey
  if (band === 1) styleKey = typeOfBand1(row)
  else if (band === 2) styleKey = typeOfBand2(row)
  else if (band === 3) styleKey = 'practice'
  else styleKey = resolveModuleStyle(row.courseSubClassModuleName ?? '')
  return { key: code || name, name, code, kind: 'course', styleKey }
}

function applyOrder(pool, orderList) {
  if (!orderList?.length) return pool
  const rank = new Map(orderList.map((key, i) => [key, i]))
  return [...pool].sort((a, b) => {
    const ra = rank.has(a.key) ? rank.get(a.key) : Number.MAX_SAFE_INTEGER
    const rb = rank.has(b.key) ? rank.get(b.key) : Number.MAX_SAFE_INTEGER
    return ra - rb
  })
}

// 贪心装箱：占位条最前，然后 start 升序 / end 降序，行内互不重叠
function packStrips(strips) {
  const sorted = [...strips].sort((a, b) => {
    const pa = a.segments.some((g) => g.item.key === PLACEHOLDER_KEY) ? 0 : 1
    const pb = b.segments.some((g) => g.item.key === PLACEHOLDER_KEY) ? 0 : 1
    if (pa !== pb) return pa - pb
    const as = Math.min(...a.segments.map((g) => g.start))
    const bs = Math.min(...b.segments.map((g) => g.start))
    const ae = Math.max(...a.segments.map((g) => g.end))
    const be = Math.max(...b.segments.map((g) => g.end))
    return as - bs || be - ae
  })
  const rowEnds = []
  for (const s of sorted) {
    const start = Math.min(...s.segments.map((g) => g.start))
    const end = Math.max(...s.segments.map((g) => g.end))
    let r = rowEnds.findIndex((e) => e < start)
    if (r === -1) {
      rowEnds.push(end)
      r = rowEnds.length - 1
    } else {
      rowEnds[r] = end
    }
    s.row = r
  }
  return sorted
}

export function normalizeMap(raw, config = {}) {
  const rows = extractRows(raw)
  const resolveModuleStyle = createModuleStyleResolver(config.moduleOrder ?? [])
  const honorCodes = new Set(config.honor ?? [])
  const relocByCode = new Map((config.relocate ?? []).map((r) => [r.code, r]))

  // 1. 展开全部学期列
  const allKeys = new Set()
  const expanded = rows.map((row) => ({ row, keys: expandAnnotation(row.initiationSemesterAnnotation) }))
  expanded.forEach(({ keys }) => keys.forEach((k) => allKeys.add(k)))
  const ordinal = semesterOrdinals(allKeys)
  const semCount = ordinal.size

  const semesters = [...ordinal.keys()]
    .sort((a, b) => ordinal.get(a) - ordinal.get(b))
    .map((key) => ({ key, label: `第${ordinal.get(key)}学期` }))

  const bands = [1, 2, 3, 4].map(() => ({
    strips: [],
    stacks: Array.from({ length: semCount }, () => []),
  }))
  const pool = (ord, band) => bands[band - 1].stacks[ord - 1]

  // 2. 课程按行展开入池（relocate 覆盖学期注记与所在带；底色始终按课程自身类别）
  for (const { row, keys } of expanded) {
    const reloc = relocByCode.get(row.courseNumber)
    const naturalBand = bandOf(row)
    const ords = reloc?.semesters ?? keys.map((k) => ordinal.get(k)).filter(Boolean)
    if (!ords.length) continue
    const placeBand = reloc?.band ?? naturalBand
    for (const ord of ords) {
      const item = baseItem(row, naturalBand, resolveModuleStyle)
      if (honorCodes.has(item.code)) item.styleKey = HONOR_STYLE_KEY
      pool(ord, placeBand).push(item)
    }
  }

  // 3. 默认注入：艺术与审美课（第 1-4 学期，公共课带）
  for (let i = 0; i < Math.min(4, semCount); i += 1) {
    pool(i + 1, 1).push({
      key: ART_KEY,
      name: '艺术与审美课',
      code: '',
      kind: 'course',
      styleKey: 'commonRequired',
    })
  }

  // 4. config 补充项
  for (const extra of config.extraCourses ?? []) {
    const targets = extra.semesters === 'all'
      ? semesters.map((_, i) => i + 1)
      : extra.semesters
    for (const ord of targets) {
      pool(ord, extra.band).push({
        key: extra.key ?? extra.code ?? extra.name,
        name: extra.name,
        code: extra.code ?? '',
        kind: extra.placeholder ? 'placeholder' : 'course',
        styleKey: extra.type ?? 'commonRequired',
      })
    }
  }
  for (const slot of config.emptySlots ?? []) {
    pool(slot.semester, slot.band).push({
      key: `__empty_${slot.semester}_${slot.band}`,
      name: '', code: '', kind: 'empty',
      styleKey: slot.style ?? 'commonRequired',
    })
  }

  // 5. 公选课占位条：每学期带1顶部
  for (let i = 0; i < semCount; i += 1) {
    bands[0].stacks[i].unshift({
      key: PLACEHOLDER_KEY,
      name: '公选课',
      code: '',
      kind: 'placeholder',
      styleKey: 'commonElective',
    })
  }

  // 6. order 排序：order['学期-带'] 显式序（带取合并前编号），其余按 JSON 行序
  bands.forEach((band, bi) => {
    band.stacks = band.stacks.map((st, si) => applyOrder(st, config.order?.[`${si + 1}-${bi + 1}`]))
  })

  // 7. 横贯条带抽取：同一带同一 key 出现于 ≥2 学期 → 跨列长条，其余留在堆叠
  for (const band of bands) {
    const occ = new Map()
    for (let i = 0; i < semCount; i += 1) {
      for (const item of band.stacks[i]) {
        if (item.kind === 'empty') continue
        if (!occ.has(item.key)) occ.set(item.key, { item, sems: new Set() })
        occ.get(item.key).sems.add(i + 1)
      }
    }
    const spanning = []
    for (const { item, sems } of occ.values()) {
      if (sems.size < 2) continue
      const list = [...sems]
      const start = Math.min(...list)
      const end = Math.max(...list)
      spanning.push({ segments: [{ item, start, end }] })
      for (let i = 0; i < semCount; i += 1) {
        band.stacks[i] = band.stacks[i].filter((it) => it.key !== item.key)
      }
    }
    band.strips = packStrips(spanning)
  }

  // 8. 三大模块：专业课（带2）与实践课（带3）合并，条带重新装箱
  const merged = {
    strips: packStrips([...bands[1].strips, ...bands[2].strips]),
    stacks: bands[1].stacks.map((st, i) => [...st, ...bands[2].stacks[i]]),
  }
  const outBands = [bands[0], merged, bands[3]]

  // 8.5 条带行空位回填：条带行未被覆盖的学期格子，从该列堆叠顶部按序上提普通课程；
  // 仍无课程可填的格子补一个虚线空位盒（blank），保证条带区网格完整
  for (const band of outBands) {
    const stripRows = band.strips.length
    band.lifts = []
    band.blanks = []
    if (!stripRows) continue
    const covered = Array.from({ length: semCount }, () => new Array(stripRows).fill(false))
    for (const s of band.strips) {
      for (const seg of s.segments) {
        for (let c = seg.start; c <= seg.end; c += 1) covered[c - 1][s.row] = true
      }
    }
    const lifted = new Set()
    const lifts = []
    band.stacks = band.stacks.map((stack, c) => {
      const emptyRows = []
      for (let r = 0; r < stripRows; r += 1) if (!covered[c][r]) emptyRows.push(r)
      if (!emptyRows.length) return stack
      let need = emptyRows.length
      const rest = []
      for (const it of stack) {
        if (need > 0 && it.kind === 'course') {
          const row = emptyRows[emptyRows.length - need]
          lifts.push({ item: it, col: c, row })
          lifted.add(`${c}:${row}`)
          need -= 1
        } else {
          rest.push(it)
        }
      }
      return rest
    })
    for (let c = 0; c < semCount; c += 1) {
      for (let r = 0; r < stripRows; r += 1) {
        if (!covered[c][r] && !lifted.has(`${c}:${r}`)) band.blanks.push({ col: c, row: r })
      }
    }
    band.lifts = lifts
  }

  // 9. 图例：按实际用到的类别推导
  const usedStyles = new Set()
  let hasHonor = false
  for (const band of outBands) {
    for (const strip of band.strips) {
      for (const seg of strip.segments) {
        usedStyles.add(seg.item.styleKey)
        if (seg.item.styleKey === HONOR_STYLE_KEY) hasHonor = true
      }
    }
    for (const stack of band.stacks) {
      for (const item of stack) {
        if (item.kind === 'empty') continue
        usedStyles.add(item.styleKey)
        if (item.styleKey === HONOR_STYLE_KEY) hasHonor = true
      }
    }
    for (const lift of band.lifts) {
      usedStyles.add(lift.item.styleKey)
      if (lift.item.styleKey === HONOR_STYLE_KEY) hasHonor = true
    }
  }
  const moduleNameByStyle = new Map()
  for (const { row } of expanded) {
    if (bandOf(row) === 4 && row.courseSubClassModuleName) {
      const style = resolveModuleStyle(row.courseSubClassModuleName)
      if (!moduleNameByStyle.has(style)) moduleNameByStyle.set(style, row.courseSubClassModuleName)
    }
  }
  const moduleOrder = []
  for (const style of usedStyles) {
    if (style.startsWith('mod-slot') && !moduleOrder.some((m) => m.styleKey === style)) {
      moduleOrder.push({ name: moduleNameByStyle.get(style) ?? style, styleKey: style })
    }
  }
  moduleOrder.sort((a, b) => Number(a.styleKey.slice(9)) - Number(b.styleKey.slice(9)))

  // 10. 主题与随机配色（seed 缺省每次加载随机）；标题 {year} = 数据最早年份
  const theme = THEME_ALIAS[config.theme] ?? config.theme ?? 'template1'
  const seed = config.paletteSeed != null
    ? Number(config.paletteSeed) >>> 0
    : (Math.random() * 4294967296) >>> 0

  let startYear = null
  for (const key of allKeys) {
    const y = parseSemesterKey(key)?.year
    if (y != null && (startYear == null || y < startYear)) startYear = y
  }
  const title = (config.title ?? '课程地图').replaceAll('{year}', String(startYear ?? ''))

  return {
    title,
    startYear,
    theme,
    paletteVars: generatePalette(theme, seed),
    semesters,
    bands: outBands,
    legend: {
      basics: BASIC_TYPES.filter((t) => usedStyles.has(t.key)),
      modules: moduleOrder,
      hasHonor,
      position: config.legend ?? (theme === 'template2' ? 'bottom' : 'side'),
    },
  }
}
