import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rawDir = path.join(root, 'data', 'raw')
const mapsDir = path.join(root, 'data', 'maps')
const RESERVED_SLUGS = new Set(['example-template1', 'example-template2'])

const exists = (p) => fs.access(p).then(() => true, () => false)

function slugify(name) {
  const base = String(name ?? '').replace(/\.[^.]+$/, '')
  const s = base
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  const slug = s || 'imported'
  return RESERVED_SLUGS.has(slug) ? `${slug}-imported` : slug
}

function extractRows(json) {
  if (Array.isArray(json)) return json
  if (Array.isArray(json?.rows)) return json.rows
  if (Array.isArray(json?.data?.rows)) return json.data.rows
  return null
}

function readJson(file, fallback) {
  return fs
    .readFile(file, 'utf8')
    .then((t) => JSON.parse(t))
    .catch(() => fallback)
}

async function readBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('文件过大（上限 20MB）')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

export function importMapPlugin() {
  return {
    name: 'coursemap-import-map',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/save-map', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('method not allowed')
          return
        }
        try {
          const search = new URL(req.url ?? '/', 'http://local').searchParams
          const name = search.get('name') ?? ''
          const text = await readBody(req, 20 * 1024 * 1024)
          const json = JSON.parse(text)
          if (!extractRows(json)) {
            throw new Error('无法识别的数据格式：期望 data.rows / rows / 数组')
          }

          const slug = slugify(name)
          const title = String(name ?? '').replace(/\.[^.]+$/, '') || slug
          const dataFile = path.join(rawDir, `${slug}.json`)
          const configFile = path.join(mapsDir, `${slug}.config.json`)
          const dataPath = `/raw/${slug}.json`

          const dataExisted = await exists(dataFile)
          await fs.mkdir(rawDir, { recursive: true })
          await fs.writeFile(dataFile, JSON.stringify(json, null, 2) + '\n', 'utf8')

          let configCreated = false
          if (!(await exists(configFile))) {
            const cfg = { title }
            if (search.get('theme')) cfg.theme = search.get('theme')
            if (search.get('legend')) cfg.legend = search.get('legend')
            await fs.writeFile(configFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
            configCreated = true
          }

          const indexPath = path.join(mapsDir, 'index.json')
          const list = await readJson(indexPath, [])
          const arr = Array.isArray(list) ? list : []
          let entry = arr.find((e) => e?.data === dataPath)
          let indexChanged = false
          if (!entry) {
            entry = { id: slug, title, data: dataPath, config: `/maps/${slug}.config.json` }
            arr.push(entry)
            indexChanged = true
          } else if (!entry.config) {
            entry.config = `/maps/${slug}.config.json`
            indexChanged = true
          }
          if (indexChanged) {
            await fs.writeFile(indexPath, JSON.stringify(arr, null, 2) + '\n', 'utf8')
          }

          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, id: entry.id, dataExisted, configCreated }))
        } catch (err) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
        }
      })
    },
  }
}
