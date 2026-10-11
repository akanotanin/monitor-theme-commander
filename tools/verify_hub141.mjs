// hub 1.4.1 的主题侧适配验收（release note「第三方主题请适配」的四条 + 1.4.0 兜下的图标一件）：
//
//   A. **浏览器禁用站点数据**（`localStorage` 读写都抛 SecurityError）时页面必须照常渲染、
//      开关照常可用（只是记不住）——官方两个主题在 1.4.1 随附版里修的「整页空白」就是这个。
//      夹具在页面任何脚本之前把 `window.localStorage` 换成一枚会抛异常的 getter（并自证生效）。
//   B. **匿名 `/api/ws` 满 1000 条时握手回 503**：主题必须有轮询 `/api/nodes` 的兜底，
//      并且 WS **隔一段时间再试、不放弃**（只做断线重连的主题会一直停在旧数据上）。
//      本组同时证明「快试用尽后还在慢速重试」（观察窗口内握手次数 ≥ 快试批次）。
//   C. **`/api/nodes/{id}/metrics` 每行新增 `swap_used`/`tcp`/`udp`/`procs`**：
//      1.4.1 形状的行 → 图表弹窗「连接」页签真的画出曲线（不再「无历史数据」）；
//      旧 hub 形状的行（没有这几个键）→ 仍然显示「无历史数据」（向后兼容，不画假线）。
//   D. **站点图标四件套**：dist 里有 favicon.svg / favicon.ico（≥3 帧）/ apple-touch-icon.png
//      （180×180 不透明）/ apple-touch-icon-precomposed.png（与前者同字节）；index.html 只引用
//      hub 认的 `/favicon.svg` 与 `/apple-touch-icon.png`；页面运行时不改写 `<link>`
//      （旧版会把图标换成主题字标的 data URI，站长换的图标就永远出不来）。
//
// 反向自测底账：拿改动前的构建跑，A 组必须红（整页空白 + SecurityError），
// D 组的「?v= 原样保留」也必须红（旧代码把 href 改写成 data URI）。
//
// 用法：node tools/verify_hub141.mjs [截图目录=shots/hub141]
//   先 `npm run build` —— 验的是 dist/，不是源码。
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { openSession } from './cdp.mjs'

const OUT = process.argv[2] || 'shots/hub141'
mkdirSync(OUT, { recursive: true })
const PORT = 5241
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.md': 'text/markdown' }

/* ------------------------------------------------------------------ 夹具（3 台，含 1 台离线） */
const GB = 1024 ** 3
const mk = (id, name, country, online = true) => ({
  id, name, sort: id, public: true, online, country, group: '',
  last_seen: Math.floor(Date.now() / 1000), last_seen_ago: online ? 0 : 120,
  metrics: online ? { uptime: 864000, cpu: 20 + id, load: [0.1, 0.2, 0.3], mem_total: 2 * GB, mem_used: 1 * GB, swap_total: 1 * GB, swap_used: 100 * 1024 * 1024, disk_total: 40 * GB, disk_used: 10 * GB, net_rx: 1024, net_tx: 2048, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, tcp: 40 + id, udp: 8, procs: 90 + id } : null,
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon', cpu_cores: 2,
  mem_total: 2 * GB, swap_total: 1 * GB, disk_total: 40 * GB, agent_version: '1.2.1',
  price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null, expires_in: null,
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})
const FLEET = [mk(1, '东京 01', 'JP'), mk(2, '法兰克福 01', 'DE'), mk(3, '马尼拉 01', 'PH', false)]

// 历史指标：两套形状 —— 1.4.1（每行多 swap_used/tcp/udp/procs）与旧 hub（没有这几个键）。
const now = Math.floor(Date.now() / 1000)
const baseRow = (i) => ({ ts: now - (30 - i) * 60, cpu: 20 + (i % 5), mem_used: GB, disk_used: 10 * GB, net_rx: 1024, net_tx: 2048 })
const ROWS_NEW = Array.from({ length: 30 }, (_, i) => ({ ...baseRow(i), swap_used: 100 * 1024 * 1024, tcp: 40 + (i % 10), udp: 8, procs: 90 + i }))
const ROWS_OLD = Array.from({ length: 30 }, (_, i) => baseRow(i))
let rowsShape = 'new' // 'new' = 1.4.1 形状；'old' = 旧 hub 形状（C 组两遍跑）

/* ------------------------------------------------------------------ 桩服务器（含 WS accept / refuse） */
const stats = { nodes: 0, metrics: 0, upgrades: 0 }
let wsMode = 'accept' // 'accept' = 101 握手；'refuse' = 回 503（1.4.1 满载形态，B 组）
const stamp = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 8)
const FAVICON = readFileSync('dist/favicon.svg')
const TOUCH = readFileSync('dist/apple-touch-icon.png')
/** hub 送 index.html 时会把这两个地址改写成 `?v=<内容摘要>`（stamp_icons） */
const stampIcons = (html) => html
  .replaceAll('"/favicon.svg"', `"/favicon.svg?v=${stamp(FAVICON)}"`)
  .replaceAll('"/apple-touch-icon.png"', `"/apple-touch-icon.png?v=${stamp(TOUCH)}"`)

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    if (path === '/api/nodes') stats.nodes += 1
    if (/^\/api\/nodes\/\d+\/metrics$/.test(path)) stats.metrics += 1
    const body = path === '/api/me' ? { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '适配验收', history_days: 30 }
      : path === '/api/nodes' ? { nodes: FLEET }
      : /^\/api\/nodes\/\d+\/metrics$/.test(path) ? { metrics: rowsShape === 'new' ? ROWS_NEW : ROWS_OLD, ping: [], probes: {}, loss: {}, step: 60 }
      : path.endsWith('/config') ? {}
      : {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' })
    return res.end(stampIcons(readFileSync('dist/index.html', 'utf8')))
  }
  const isHtml = path === '/' || path === '/index.html'
  const body = isHtml ? stampIcons(readFileSync(file, 'utf8')) : readFileSync(file)
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(body)
})
// WS：'accept' 做最小 101 握手（不推帧，轮询与 REST 照常）；'refuse' 回 503 后断开（B 组）。
// ★ 握手必须挂在 'upgrade' 上：Node 的 http server 没有这个监听器时会直接掐掉带 Upgrade 头的连接。
server.on('upgrade', (req, socket) => {
  stats.upgrades += 1
  if (wsMode === 'refuse') {
    socket.write('HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  const key = req.headers['sec-websocket-key'] || ''
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`)
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${PORT}`
console.log(`dist/ 伺服在 ${BASE}/（wsMode=${wsMode}，行形状=${rowsShape}）`)

/* ------------------------------------------------------------------ 断言工具 */
let pass = 0
const failures = []
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (ok) pass += 1
  else failures.push(name)
}

const session = await openSession({ width: 1280, height: 900 })
const js = async expr => await session.evaluate(expr)
const cleanIssues = () => session.issues.filter(text => !text.includes('[warning]'))

/* ---------------------------------------------------------------- A. 禁用站点数据：不许白屏 */
console.log('\n=== A、浏览器禁用站点数据（localStorage 抛 SecurityError）：页面照常渲染 ===')
wsMode = 'accept'
const blockScript = await session.addInitScript(`(() => {
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('The operation is insecure.', 'SecurityError') },
    })
  } catch (e) { window.__storageBlockFailed = String(e) }
})()`)
const blockId = blockScript?.result?.identifier
await session.goto(`${BASE}/`)
const blocked = JSON.parse(await js(`(() => {
  const mechanism = (() => { try { localStorage; return 'no-throw' } catch { return 'throws' } })()
  return JSON.stringify({ failed: window.__storageBlockFailed ?? null, mechanism })
})()`))
check('机制自检：localStorage 访问真的会抛（桩生效了）', blocked.failed === null && blocked.mechanism === 'throws', JSON.stringify(blocked))
await session.waitFor(`document.querySelector('#root') && document.querySelector('#root').children.length > 0`, 15000)
await sleep(700)
check('★ 页面照常渲染（不是空白页）', await js(`document.querySelector('#root').children.length > 0 && !!document.querySelector('header')`), '')
// 切「卡片」视图 = 走一次存储写入路径（storageSet），随后该视图真的换出来
const switched = await js(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '卡片')
  if (!b) return 'no-button'
  b.click()
  return 'clicked'
})()`)
const cardsUp = await session.waitFor(`document.querySelectorAll('.node-card-commander').length >= 3`, 20000)
check('★ 禁用存储时视图切换仍生效（卡片 ≥3 张）', switched === 'clicked' && cardsUp === true, `${switched} / cards=${await js(`document.querySelectorAll('.node-card-commander').length`)}`)
// 切主题 = 走 useTheme 的 storageSet 写入路径；class 变化在 effect 里，等一拍
const themeBefore = await js(`document.documentElement.getAttribute('data-theme') || '' `)
const themeClicked = await js(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '').startsWith('切换到'))
  if (!b) return 'no-button'
  b.click()
  return 'clicked'
})()`)
await sleep(400)
const themeAfter = await js(`document.documentElement.getAttribute('data-theme') || '' `)
check('★ 禁用存储时主题切换仍生效（本次会话内）', themeClicked === 'clicked' && themeAfter !== themeBefore, `${themeClicked} / "${themeBefore}" → "${themeAfter}"`)
const aIssues = cleanIssues()
check('A 组：无 SecurityError、控制台干净', aIssues.length === 0, aIssues.slice(0, 3).join(' | ') || '干净')
await session.screenshot(`${OUT}/storage-disabled.png`)
// 撤掉「禁用存储」的注入：后面的组要在正常存储下跑
if (blockId)
  await session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: blockId })

/* ---------------------------------------------------------------- B. WS 503：轮询兜底 + 隔段时间再试 */
console.log('\n=== B、/api/ws 握手回 503：轮询继续、WS 快试后仍慢速重试（不放弃） ===')
wsMode = 'refuse'
const before = { ...stats }
await session.goto(`${BASE}/`)
await session.waitFor(`document.querySelector('#root') && document.querySelector('#root').children.length > 0`, 15000)
await sleep(12000) // 覆盖快试批次（3s ×5）的前几轮
const dB = { nodes: stats.nodes - before.nodes, upgrades: stats.upgrades - before.upgrades }
check('★ WS 被拒后轮询继续在拉 /api/nodes（≥2 次）', dB.nodes >= 2, `窗口内 ${dB.nodes} 次`)
check('★ WS 快试在跑（≥2 次握手）', dB.upgrades >= 2, `窗口内 ${dB.upgrades} 次`)
// 「不放弃」的判据：旧实现最多 6 次握手（首连 + 5 次快试）就彻底收手；新实现快试用尽后
// 每 15 秒继续试 —— 第 7 次出现在 ~42s，窗口放到 55s 恰好把两者分开（反向自测：旧构建此条红）。
const got = await (async () => {
  for (let i = 0; i < 220; i++) {
    if (stats.upgrades - before.upgrades >= 7) return true
    await sleep(250)
  }
  return false
})()
check('★ 快试用尽后仍在慢速重试（累计 ≥7 次握手；旧实现 6 次就放弃）', got === true, `累计 ${stats.upgrades - before.upgrades} 次`)
// 数据照常显示：切到卡片视图（默认视图是地球，卡片只在网格里）
await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '卡片'); if (b) b.click(); return !!b })()`)
const bCards = await session.waitFor(`document.querySelectorAll('.node-card-commander').length >= 3`, 20000)
check('★ 数据照常显示（WS 被拒、轮询兜底下卡片 ≥3 张）', bCards === true, `cards=${await js(`document.querySelectorAll('.node-card-commander').length`)}`)
wsMode = 'accept' // C/D 组回到正常 WS（B 的 503 噪声不再累积）

/* ---------------------------------------------------------------- C. metrics 新字段（1.4.1 / 旧 hub 两遍） */
console.log('\n=== C、/api/nodes/{id}/metrics 行新增 swap_used/tcp/udp/procs ===')
const issueBase = session.issues.length // B 组的 503 握手日志不计入后面的断言
async function openModalTab(label) {
  let opened = await js(`!!document.querySelector('.chart-card-commander')`)
  if (!opened) {
    await js(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '卡片'); if (b) b.click(); return !!b })()`)
    await session.waitFor(`document.querySelectorAll('.node-card-commander').length >= 1`, 20000)
    await js(`(() => { const b = document.querySelector('.node-card-commander [data-accent="cardcharts"]'); if (b) { b.click(); return true } return false })()`)
    opened = await session.waitFor(`!!document.querySelector('.chart-card-commander')`, 20000)
  }
  if (!opened) return null
  await js(`(() => {
    const b = [...document.querySelectorAll('.chart-card-commander button')].find(x => x.innerText.trim() === ${JSON.stringify(label)})
    if (b) { b.click(); return true }
    return false
  })()`)
  await sleep(1200)
  return JSON.parse(await js(`(() => {
    const modal = document.querySelector('.chart-card-commander')
    if (!modal) return JSON.stringify({ ok: false })
    const paths = [...modal.querySelectorAll('.recharts-surface path')].filter(p => (p.getAttribute('d') || '').length > 100).length
    const dashed = [...modal.querySelectorAll('.recharts-surface path')].filter(p => !!p.getAttribute('stroke-dasharray') && (p.getAttribute('d') || '').length > 50).length
    return JSON.stringify({ ok: true, noHistory: modal.innerText.includes('无历史数据'), paths, dashed })
  })()`))
}
const closeModal = () => js(`(() => { const b = document.querySelector('.chart-card-commander button[aria-label="关闭"]'); if (b) { b.click(); return true } return false })()`)

// C1：1.4.1 形状的行 → 「连接」页签画出曲线；「负载」仍「无历史数据」（hub 不存 load）
rowsShape = 'new'
await session.goto(`${BASE}/`)
await session.waitFor(`document.querySelectorAll('.sidebar-node-item').length >= 1 || document.querySelectorAll('.node-card-commander').length >= 1`, 25000)
const c1conn = await openModalTab('连接')
check('C1「连接」页签画出历史曲线（1.4.1 行带 tcp/udp）', c1conn?.ok === true && c1conn.noHistory === false && c1conn.paths >= 1, JSON.stringify(c1conn))
const c1mem = await openModalTab('内存')
check('C1「内存」页签画出 Swap 虚线（1.4.1 行带 swap_used）', c1mem?.ok === true && c1mem.dashed >= 1, JSON.stringify(c1mem))
const c1load = await openModalTab('负载')
check('C1「负载」页签仍是「无历史数据」（hub 不存 load 历史）', c1load?.ok === true && c1load.noHistory === true, JSON.stringify(c1load))
await session.screenshot(`${OUT}/c1-connections.png`)
const c1Issue = session.issues.slice(issueBase).filter(x => !x.includes('[warning]')).filter(x => /swap_used|procs|tcp|udp/i.test(x))
check('C1 无与新字段相关的报错', c1Issue.length === 0, c1Issue.join(' | ') || '干净')

// C2：旧 hub 形状的行 → 两页签都回落「无历史数据」（向后兼容、不画贴 0 的假线）
rowsShape = 'old'
await session.goto(`${BASE}/`)
await session.waitFor(`document.querySelectorAll('.sidebar-node-item').length >= 1 || document.querySelectorAll('.node-card-commander').length >= 1`, 25000)
const c2conn = await openModalTab('连接')
check('C2（旧 hub 行）「连接」回落「无历史数据」', c2conn?.ok === true && c2conn.noHistory === true, JSON.stringify(c2conn))
const c2load = await openModalTab('负载')
check('C2（旧 hub 行）「负载」仍是「无历史数据」', c2load?.ok === true && c2load.noHistory === true, JSON.stringify(c2load))
await closeModal()
await session.screenshot(`${OUT}/c2-old-rows.png`)

/* ---------------------------------------------------------------- D. 站点图标四件套 */
console.log('\n=== D、站点图标：四件套齐 + 运行时不改写 <link> ===')
const svg = readFileSync('dist/favicon.svg', 'utf8')
check('D1 dist/favicon.svg 是一张 SVG', svg.trimStart().startsWith('<svg'), svg.slice(0, 24))
const ico = readFileSync('dist/favicon.ico')
const icoFrames = ico.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) ? ico.readUInt16LE(4) : 0
check('D2 dist/favicon.ico 是真的 ICO 且 ≥3 帧（16/32/48）', icoFrames >= 3, `${icoFrames} 帧 / ${ico.length} 字节`)
const touch = readFileSync('dist/apple-touch-icon.png')
const touchW = touch.readUInt32BE(16)
const touchH = touch.readUInt32BE(20)
const touchDepth = touch[24]
const touchColorType = touch[25]
check('D3 dist/apple-touch-icon.png 是 180×180 不透明（colorType 2/3）', touchW === 180 && touchH === 180 && (touchColorType === 2 || touchColorType === 3), `${touchW}×${touchH} colorType=${touchColorType} depth=${touchDepth}`)
const precomposed = readFileSync('dist/apple-touch-icon-precomposed.png')
check('D4 dist/apple-touch-icon-precomposed.png 存在且与 apple-touch-icon.png 同字节', precomposed.equals(touch), `${precomposed.length} 字节`)
const html = readFileSync('dist/index.html', 'utf8')
check('D5 index.html 静态引用 hub 认的那两条路径', html.includes('href="/favicon.svg"') && html.includes('href="/apple-touch-icon.png"'), '')
// 页面里：<link> 保持 hub 给的 ?v= 版本号（主题运行时不改写图标地址）
await session.goto(`${BASE}/`)
await session.waitFor(`document.querySelector('#root') && document.querySelector('#root').children.length > 0`, 15000)
await sleep(900)
const links = JSON.parse(await js(`(() => {
  const icon = document.querySelector('link[rel~="icon"]')
  const touch = document.querySelector('link[rel="apple-touch-icon"]')
  return JSON.stringify({
    iconCount: document.querySelectorAll('link[rel~="icon"]').length,
    iconHref: icon ? icon.getAttribute('href') : null,
    touchHref: touch ? touch.getAttribute('href') : null,
  })
})()`))
check('D6 页面里只有一条 <link rel="icon">，且保持 hub 的 ?v= 版本号（未被改写成 data URI）', links.iconCount === 1 && /^\/favicon\.svg\?v=[0-9a-f]{8}$/.test(links.iconHref ?? ''), JSON.stringify(links))
check('D7 apple-touch-icon 同样保持 ?v= 版本号', /^\/apple-touch-icon\.png\?v=[0-9a-f]{8}$/.test(links.touchHref ?? ''), links.touchHref ?? '')
await session.screenshot(`${OUT}/icons.png`)

const finalIssues = session.issues.slice(issueBase).filter(text => !text.includes('[warning]'))
check('C/D 组控制台无错误（B 组 503 握手不计）', finalIssues.length === 0, finalIssues.slice(0, 4).join(' | ') || '干净')

session.close()
server.close()

console.log(`\n${pass} PASS / ${failures.length} FAIL`)
if (failures.length)
  console.log(`失败项：${failures.join('、')}`)
process.exit(failures.length ? 1 : 0)
