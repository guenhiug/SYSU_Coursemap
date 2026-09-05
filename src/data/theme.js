// 随机系列配色生成器：每个模板固定一个基调色系（v1 血统），
// 每次加载只在基调 ±12° 色相内微随机；深浅差由「实底/淡底/淡底两档」结构保证，
// 背景一律低彩度。以 CSS 自定义属性返回，供 App 注入根元素覆盖静态回退色。

export function hashString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  }
  return h >>> 0
}

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hue = (h) => ((h % 360) + 360) % 360
const hsl = (h, s, l) => `hsl(${Math.round(hue(h))} ${s}% ${l}%)`

const SLOT_COUNT = 8

// 基调色相：模板2 = 蓝金系（v1 模板2 原配色），模板1 = 玫红系（v1 模板1 结构换色系，与蓝金拉开）
const ANCHORS = { template2: 230, template1: 345 }

export function generatePaletteVars(theme, rng) {
  const v = {}
  const anchor = ANCHORS[theme] ?? ANCHORS.template1
  const h0 = anchor + (rng() * 2 - 1) * 12

  if (theme === 'template2') {
    // 蓝金系：蓝紫主体 + 固定金色强调
    const hA = 44
    const hE = h0 + 18
    v['--c-common-elective-bg'] = hsl(hE, 33, 52)
    v['--c-common-elective-fg'] = '#ffffff'
    v['--c-common-required-bg'] = hsl(hE, 38, 94)
    v['--c-common-required-fg'] = hsl(hE, 40, 30)
    v['--c-common-required-bd'] = hsl(hE, 30, 82)
    v['--c-platform-bg'] = hsl(h0 - 15, 35, 52)
    v['--c-platform-fg'] = '#ffffff'
    v['--c-core-bg'] = hsl(h0, 40, 28)
    v['--c-core-fg'] = '#ffffff'
    v['--c-practice-bg'] = hsl(36, 50, 42)
    v['--c-practice-fg'] = '#ffffff'
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const hi = h0 + 60 + (i * 360) / SLOT_COUNT
      const l = i % 2 === 0 ? 93 : 89
      v[`--c-mod-slot-${i}-bg`] = hsl(hi, 40, l)
      v[`--c-mod-slot-${i}-fg`] = hsl(hi, 45, 30)
      v[`--c-mod-slot-${i}-bd`] = hsl(hi, 35, 78)
    }
    v['--c-honor-bg'] = hsl(hA, 70, 67)
    v['--c-honor-fg'] = hsl(hA, 65, 25)
    v['--c-panel'] = hsl(h0, 10, 95)
    v['--c-header'] = '#ffffff'
    v['--c-header-fg'] = hsl(h0, 40, 28)
    v['--c-header-accent'] = `3px solid ${hsl(hA, 62, 45)}`
    v['--c-arrow'] = hsl(hA, 62, 45)
    v['--c-title'] = hsl(h0, 40, 28)
    v['--c-page'] = hsl(hA, 25, 98)
    v['--c-legend-border'] = hsl(h0, 12, 88)
    // 侧栏：淡底 + 左粗条
    v['--side-bg'] = 'transparent'
    v['--side-public-accent'] = `5px solid ${hsl(hE, 33, 52)}`
    v['--side-public-fg'] = hsl(hE, 40, 30)
    v['--side-platform-accent'] = `5px solid ${hsl(h0 - 15, 35, 52)}`
    v['--side-platform-fg'] = hsl(h0 - 15, 40, 30)
    v['--side-practice-accent'] = `5px solid ${hsl(36, 50, 42)}`
    v['--side-practice-fg'] = hsl(36, 50, 26)
    v['--side-elective-accent'] = `5px solid ${hsl(140, 30, 42)}`
    v['--side-elective-fg'] = hsl(140, 35, 30)
  } else {
    // 玫红系：v1 模板1 结构（实底选修 + 淡底必修 + 平台/核心暖橙 + 补色实践 + 淡底色槽）
    const hB = h0 + 35
    const hP = h0 + 165
    v['--c-common-elective-bg'] = hsl(h0, 42, 46)
    v['--c-common-elective-fg'] = '#ffffff'
    v['--c-common-required-bg'] = hsl(h0, 38, 92)
    v['--c-common-required-fg'] = hsl(h0, 45, 30)
    v['--c-common-required-bd'] = hsl(h0, 30, 78)
    v['--c-platform-bg'] = hsl(hB, 48, 46)
    v['--c-platform-fg'] = '#ffffff'
    v['--c-core-bg'] = hsl(hB, 52, 28)
    v['--c-core-fg'] = '#ffffff'
    v['--c-practice-bg'] = hsl(hP, 60, 30)
    v['--c-practice-fg'] = '#ffffff'
    for (let i = 0; i < SLOT_COUNT; i += 1) {
      const hi = h0 + 18 + (i * 360) / SLOT_COUNT
      if (i % 4 === 2) {
        // 少量实底色槽（补色方向），制造深浅差
        const bg = hsl(hP + i * 12, 55, 38)
        v[`--c-mod-slot-${i}-bg`] = bg
        v[`--c-mod-slot-${i}-fg`] = '#ffffff'
        v[`--c-mod-slot-${i}-bd`] = bg
      } else {
        const l = i % 2 === 0 ? 92 : 87
        v[`--c-mod-slot-${i}-bg`] = hsl(hi, 45, l)
        v[`--c-mod-slot-${i}-fg`] = hsl(hi, 45, 30)
        v[`--c-mod-slot-${i}-bd`] = hsl(hi, 35, l === 92 ? 76 : 70)
      }
    }
    v['--c-honor-bg'] = hsl(200, 45, 84)
    v['--c-honor-fg'] = hsl(200, 50, 26)
    v['--c-panel'] = hsl(h0 + 180, 7, 94)
    v['--c-header'] = hsl(hB, 52, 28)
    v['--c-header-fg'] = '#ffffff'
    v['--c-header-accent'] = 'none'
    v['--c-arrow'] = hsl(h0, 45, 50)
    v['--c-title'] = hsl(hB, 50, 24)
    v['--c-page'] = hsl(h0 + 180, 10, 98)
    v['--c-legend-border'] = hsl(h0, 12, 88)
    // 侧栏：白底描边盒
    v['--side-bg'] = '#ffffff'
    v['--side-public-accent'] = 'none'
    v['--side-public-fg'] = hsl(h0, 45, 30)
    v['--side-platform-accent'] = 'none'
    v['--side-platform-fg'] = hsl(hB, 45, 34)
    v['--side-practice-accent'] = 'none'
    v['--side-practice-fg'] = hsl(hP, 60, 30)
    v['--side-elective-accent'] = 'none'
    v['--side-elective-fg'] = hsl(h0 + 220, 40, 42)
  }

  // 侧栏描边线（线色随机，线型由主题 CSS 决定的部分保持静态变量名兼容）
  const lineFor = (accent, fallbackColor) =>
    theme === 'template2' ? 'none' : `1.5px solid ${fallbackColor}`
  v['--side-public-line'] = lineFor(
    v['--side-public-accent'],
    theme === 'template2' ? '' : v['--c-common-elective-bg'],
  )
  v['--side-platform-line'] = lineFor(
    v['--side-platform-accent'],
    theme === 'template2' ? '' : v['--c-platform-bg'],
  )
  v['--side-practice-line'] = lineFor(
    v['--side-practice-accent'],
    theme === 'template2' ? '' : v['--c-practice-bg'],
  )
  v['--side-elective-line'] = lineFor(
    v['--side-elective-accent'],
    theme === 'template2' ? '' : hsl(h0 + 220, 40, 50),
  )

  return v
}

export function generatePalette(theme, seed) {
  return generatePaletteVars(theme, mulberry32(seed))
}
