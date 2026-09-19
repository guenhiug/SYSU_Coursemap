import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyGraph } from '../src/lib/course-graph.js'
import { graphFileName, writeGraphFile } from '../src/lib/graph-file.js'

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

// 仅接受来自本机 / 局域网（loopback、RFC1918 私有网段、*.local）的请求：
// 防止用户浏览任意网页时，该页面向 dev 服务器发起跨域 POST 写入仓库文件（CSRF / DNS rebinding）。
function isLocalHost(value) {
  const host = String(value ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return host.endsWith('.local')
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

function isLocalRequest(req) {
  if (!isLocalHost(String(req.headers.host ?? '').replace(/:[\d]+$/, ''))) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return isLocalHost(new URL(origin).hostname)
  } catch {
    return false
  }
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
        if (!isLocalRequest(req)) {
          res.statusCode = 403
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, error: '仅允许来自本机（localhost）的导入请求' }))
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

          // 隐私：导入条目只写 gitignore 的 index.local.json；入库的 index.json 不增删。
          // 去重同时查 local 与 committed（按 data 路径与 id），同一 raw 重复导入只更新 local 条目。
          const indexPath = path.join(mapsDir, 'index.json')
          const localIndexPath = path.join(mapsDir, 'index.local.json')
          const committed = await readJson(indexPath, [])
          const localList = await readJson(localIndexPath, [])
          const committedArr = Array.isArray(committed) ? committed : []
          const localArr = Array.isArray(localList) ? localList : []
          const findEntry = (arr) => arr.find((e) => e?.data === dataPath || e?.id === slug)
          let entry = findEntry(localArr)
          let localChanged = false
          if (!entry) {
            const committedEntry = findEntry(committedArr)
            if (committedEntry) {
              entry = committedEntry
            } else {
              entry = { id: slug, title, data: dataPath, config: `/maps/${slug}.config.json` }
              localArr.push(entry)
              localChanged = true
            }
          }
          if (!entry.config) {
            entry.config = `/maps/${slug}.config.json`
            if (localArr.includes(entry)) localChanged = true
          }

          // 图谱：导入时只做确定性节点抽取 + 确定性实践链（rule 边），无网络/无模型调用；
          // 其余边留待使用者显式运行 docs/kg-workflow.md 中的工作流产生。已存在则保留。
          const graphFile = path.join(mapsDir, graphFileName(entry.id))
          let graphCreated = false
          try {
            await fs.access(graphFile)
          } catch {
            const cfg = await readJson(configFile, {})
            const graph = emptyGraph({ id: entry.id, raw: json, config: cfg, sourceRaw: dataPath })
            await writeGraphFile(graphFile, graph)
            graphCreated = true
          }

          if (localChanged) {
            await fs.writeFile(localIndexPath, JSON.stringify(localArr, null, 2) + '\n', 'utf8')
          }

          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, id: entry.id, dataExisted, configCreated, graphCreated }))
        } catch (err) {
          res.statusCode = 400
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
        }
      })
    },
  }
}
