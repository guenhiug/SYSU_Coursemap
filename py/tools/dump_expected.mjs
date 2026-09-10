// 对拍基准：用 JS 原版跑出期望值，供 Python 测试逐字段比对。
// 用法（仓库根目录）：node py/tools/dump_expected.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { normalizeMap } from '../../src/lib/normalize.js'
import { generatePalette } from '../../src/data/theme.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const readJson = (p) => JSON.parse(readFileSync(path.join(root, p), 'utf8'))

const raw = readJson('data/raw/example.json')
const config = readJson('data/maps/example.config.json')

const palettes = []
for (const theme of ['template1', 'template2']) {
  for (const seed of [0, 1, 7, 12345, 4294967295]) {
    palettes.push({ theme, seed, vars: generatePalette(theme, seed) })
  }
}

process.stdout.write(JSON.stringify({ normalize: normalizeMap(raw, config), palettes }))
