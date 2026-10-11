// 后台标签页策略的验收（hub 1.4.0 适配清单里的「切回前台」一项）：
//   藏起来 → WebSocket 关掉、兜底轮询停掉、不重连（不再每 2 秒一帧、每帧一次 React 重渲染，
//   也不再占着反代按 IP 限的并发 WS 名额）；回到前台 → 立刻补一次 /api/nodes，再把连接接回去。
//   后台标签页打开（中键开一堆链接）时连第一条 WS 都不建。
//
// 三个场景，分开跑：
//   A. WS 可用（主路径）：隐藏后 socket 必须进入 CLOSING/CLOSED、服务端看到关闭；隐藏 4 秒里
//      /api/nodes 与重连计数一个都不涨；回前台 2.5 秒内 +1 次 /api/nodes、+1 条新 WS（且连上），
//      推送帧继续在发、页脚状态回到「已连接」。
//   B. WS 不可用（兜底路径）：轮询在跑；隐藏后轮询停（计数冻结）、连重试都不发；
//      回前台先 +1（补一次）再继续涨（轮询接回来）。
//   C. 后台标签页打开：初始的 WS 一条都不建；隐藏期间 /api/nodes 不涨；切回前台才补一次 + 建连。
//
// 用法：cd <repo> && node tools/verify_visibility.mjs
//   先 `npm run build` —— 验的是 dist/。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { extname, join, normalize } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { openSession } from './cdp.mjs'

const PORT = 5399
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' }

const mkNode = (name) => ({
  id: 1, name, sort: 1, public: true, online: true, country: 'JP', group: '',
  last_seen: Math.floor(Date.now() / 1000) - 3, last_seen_ago: 3,
  metrics: {
    uptime: 400000, cpu: 12.5, load: [0.1, 0.2, 0.3], mem_total: 2 * 1024 ** 3, mem_used: 1024 ** 3,
    swap_total: 0, swap_used: 0, disk_total: 40 * 1024 ** 3, disk_used: 10 * 1024 ** 3,
    net_rx: 512 * 1024, net_tx: 128 * 1024, total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0,
    tcp: 10, udp: 2, procs: 100,
  },
  os: 'Debian 12', kernel: '6.1.0', arch: 'x86_64', virt: 'kvm', cpu_name: 'Xeon', cpu_cores: 2,
  mem_total: 2 * 1024 ** 3, swap_total: 0, disk_total: 40 * 1024 ** 3, agent_version: '1.2.1',
  price: 0, currency: 'CNY', billing_cycle: 'monthly', expires_at: null, expires_in: null,
  traffic_limit: 0, traffic_mode: 'sum', traffic_reset_day: 1,
  total_rx: 0, total_tx: 0, month_rx: 0, month_tx: 0, month_start: '', day_rx: 0, day_tx: 0,
})

/* ------------------------------------------------------------------ 桩服务器（含真 WS） */

let wsEnabled = true
const stats = { nodes: 0, upgrades: 0, wsOpens: 0, wsClosed: 0, framesSent: 0, openSockets: 0 }

// 服务端帧不做掩码；长度按 125/65535/以上三档。
const sendFrame = (socket, text) => {
  const payload = Buffer.from(text)
  let header
  if (payload.length < 126) header = Buffer.from([0x81, payload.length])
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2) }
  try { socket.write(Buffer.concat([header, payload])); stats.framesSent += 1 } catch { /* 对端已走 */ }
}

const server = createServer((req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname
  if (path.startsWith('/api/')) {
    let body = {}
    if (path === '/api/me') body = { authed: false, github: false, public_page: true, site: `http://127.0.0.1:${PORT}`, site_name: '可见性校验', history_days: 30 }
    else if (path === '/api/nodes') { stats.nodes += 1; body = { nodes: [mkNode('快照')] } }
    else if (path.endsWith('/config')) body = {}
    else if (path.includes('/metrics')) body = { metrics: [], ping: [], probes: {}, loss: {} }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    return res.end(JSON.stringify(body))
  }
  const file = join('dist', normalize(path === '/' ? '/index.html' : path).replace(/^(\.[/\\])+/, ''))
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    return res.end(readFileSync('dist/index.html'))
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(readFileSync(file))
})
// ★ 握手要挂在 'upgrade' 上：Node 的 http server 没有这个监听器时，会直接掐掉带 Upgrade 头的连接
// （客户端收 1006、一个字节都收不到），「WS 连着」这件事就永远测不到。
server.on('upgrade', (req, socket) => {
  stats.upgrades += 1
  if (!wsEnabled) { socket.destroy(); return }
  const key = req.headers['sec-websocket-key'] || ''
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  stats.wsOpens += 1
  stats.openSockets += 1
  let seq = 0
  const timer = setInterval(() => sendFrame(socket, JSON.stringify({ nodes: [mkNode(`帧${++seq}`)] })), 300)
  socket.on('data', (buf) => {
    // 客户端发关闭帧（0x88）：回一条空的再断开，别让 TCP 半开着（否则 close 要等超时）。
    if ((buf[0] & 0x0f) === 0x8) { try { socket.write(Buffer.from([0x88, 0x00])) } catch { /* 已断 */ } socket.destroy() }
  })
  socket.on('close', () => { clearInterval(timer); stats.openSockets -= 1; stats.wsClosed += 1 })
  socket.on('error', () => {})
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))
const BASE = `http://127.0.0.1:${PORT}`
console.log(`dist/ 伺服在 ${BASE}/`)

let pass = 0
const failures = []
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (ok) pass += 1
  else failures.push(name)
}
const waitStats = async (fn, ms = 6000) => {
  for (let i = 0; i < Math.ceil(ms / 200); i++) {
    if (fn(stats)) return true
    await sleep(200)
  }
  return false
}

/* ------------------------------------------------------------------ 浏览器 */
const session = await openSession({ width: 1440, height: 1000 })
const js = async expr => await session.evaluate(expr)
// 每个新文档开头都装两样：① hook window.WebSocket 收实例（看 readyState）；
// ② 可切换的 document.visibilityState / document.hidden + 派发 visibilitychange 的开关；
//    `?hidden=1` 时以隐藏态启动（模拟「后台标签页打开」）。
await session.addInitScript(`(() => {
  const O = window.WebSocket, list = []
  window.__sockets = list
  window.WebSocket = class extends O { constructor(...a) { super(...a); list.push(this) } }
  window.__visState = /(?:^|[?&])hidden=1(?:&|$)/.test(location.search) ? 'hidden' : 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__visState })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__visState === 'hidden' })
  window.__setVis = (v) => { window.__visState = v; document.dispatchEvent(new Event('visibilitychange')); return document.visibilityState }
})()`)
const readyStates = async () => JSON.parse(await js(`JSON.stringify((window.__sockets || []).map(s => s.readyState))`))

/* ------------------------------------------------------------- 场景 A：WS 可用 */

console.log('\n=== A. WS 可用（主路径） ===')
await session.goto(`${BASE}/`)
const a1 = await waitStats(s => s.wsOpens >= 1 && s.nodes >= 1, 15000)
check('加载后 WS 连上、/api/nodes 拉过初始快照', a1, JSON.stringify({ wsOpens: stats.wsOpens, nodes: stats.nodes }))
const rendered = await session.waitFor(`document.querySelectorAll('.sidebar-node-item').length >= 1 || document.querySelectorAll('.node-card-commander').length >= 1`, 25000)
check('节点数据画出来了', rendered === true)
check('隐藏前 socket 处于 OPEN（探针本身没问题）', (await readyStates()).some(s => s === 1), JSON.stringify(await readyStates()))
const framesBefore = stats.framesSent
check('WS 推送帧在发（服务端计数在涨）', await waitStats(s => s.framesSent > framesBefore, 3000), `framesSent=${stats.framesSent}`)

console.log(`    → 切隐藏（__setVis('hidden')）`)
await js(`window.__setVis('hidden')`)
const rs = await readyStates()
check('★ 隐藏后 socket 立刻进入 CLOSING/CLOSED（不再收推送）', rs.length > 0 && rs.every(s => s >= 2), JSON.stringify(rs))
check('★ 服务端看到了这条连接的关闭', await waitStats(s => s.wsClosed >= 1, 3000), `wsClosed=${stats.wsClosed}`)

await sleep(600) // 让在途的收尾干净
const snapA = { ...stats }
await sleep(4000)
check('★ 隐藏 4 秒里没有再拉 /api/nodes（兜底轮询没在后台空转）', stats.nodes === snapA.nodes, `${snapA.nodes} → ${stats.nodes}`)
check('★ 隐藏期间没有偷偷重连 WS', stats.wsOpens === snapA.wsOpens && stats.upgrades === snapA.upgrades, `opens ${snapA.wsOpens}→${stats.wsOpens}, attempts ${snapA.upgrades}→${stats.upgrades}`)

console.log(`    → 切回前台（__setVis('visible')）`)
await js(`window.__setVis('visible')`)
const backA = await waitStats(s => s.nodes >= snapA.nodes + 1, 2500)
check('★ 回前台立刻补一次 /api/nodes', backA, `${snapA.nodes} → ${stats.nodes}`)
const reopenA = await waitStats(s => s.wsOpens >= snapA.wsOpens + 1, 2500)
check('★ 回前台把 WS 接回来了（+1 条新连接）', reopenA, `wsOpens ${snapA.wsOpens} → ${stats.wsOpens}`)
const openAgain = await (async () => {
  for (let i = 0; i < 20; i++) { if ((await readyStates()).some(s => s === 1)) return true; await sleep(200) }
  return false
})()
check('新连接已到 OPEN', openAgain === true, JSON.stringify(await readyStates()))
check('推送帧重新在发（服务端 framesSent 继续涨）', await waitStats(s => s.framesSent > snapA.framesSent + 3, 4000), `framesSent ${snapA.framesSent} → ${stats.framesSent}`)
check('页脚状态回到「已连接」', await session.waitFor(`(document.querySelector('[role="status"]')?.innerText || '').includes('已连接')`, 5000), '')

/* ------------------------------------------------------------- 场景 B：WS 不可用 */

console.log('\n=== B. WS 不可用（兜底轮询路径） ===')
wsEnabled = false
const beforeB = stats.nodes
await session.goto(`${BASE}/`)
const poll = await waitStats(s => s.nodes >= beforeB + 2, 9000)
check('WS 不可用时兜底轮询在跑（重新加载后至少 +2 次 /api/nodes）', poll, `${beforeB} → ${stats.nodes}`)

await js(`window.__setVis('hidden')`)
await sleep(1300) // 让在途的收尾干净
const snapB = { ...stats }
await sleep(5800)
check('★ 隐藏期间轮询真的停了（跨过一个 2 秒周期计数不涨）', stats.nodes === snapB.nodes, `${snapB.nodes} → ${stats.nodes}`)
check('★ 隐藏期间连 WS 重试都不发', stats.upgrades === snapB.upgrades, `attempts ${snapB.upgrades} → ${stats.upgrades}`)

await js(`window.__setVis('visible')`)
const backB = await waitStats(s => s.nodes >= snapB.nodes + 1, 2500)
check('★ 回前台补一次（轮询不可用时的「立刻拉一下」）', backB, `${snapB.nodes} → ${stats.nodes}`)
const againB = await waitStats(s => s.nodes >= snapB.nodes + 2, 7500)
check('轮询也接回来了（回前台后 2 秒周期恢复）', againB, `${snapB.nodes} → ${stats.nodes}`)

/* ------------------------------------------------------------- 场景 C：后台标签页打开 */

console.log('\n=== C. 后台标签页打开（连第一条 WS 都不建） ===')
wsEnabled = true
await session.goto(`${BASE}/?hidden=1`)
const vis = await js(`document.visibilityState`)
check('夹具自检：以隐藏态启动', vis === 'hidden', `visibilityState=${vis}`)
await sleep(2500) // 让初始的一次性拉取收尾
const snapC = { ...stats }
const cSockets = await js(`window.__sockets.length`)
check('★ 隐藏启动时一条 WS 都不建（页面里没有任何 WebSocket 实例）', cSockets === 0, `sockets=${cSockets}`)
await sleep(3000)
check('★ 隐藏期间 /api/nodes 不涨（轮询没在后台空转）', stats.nodes === snapC.nodes, `${snapC.nodes} → ${stats.nodes}`)
const cSockets2 = await js(`window.__sockets.length`)
check('★ 隐藏期间仍没有 WS 尝试', cSockets2 === 0, `sockets=${cSockets2}`)
await js(`window.__setVis('visible')`)
const backC = await waitStats(s => s.nodes >= snapC.nodes + 1, 2500)
check('★ 切回前台补一次 /api/nodes', backC, `${snapC.nodes} → ${stats.nodes}`)
const cSockets3 = await (async () => {
  for (let i = 0; i < 20; i++) { if (await js(`window.__sockets.length`) >= 1) return true; await sleep(200) }
  return false
})()
check('★ 切回前台才建 WS（页面里出现 WebSocket 实例）', cSockets3 === true, `sockets=${await js(`window.__sockets.length`)}`)

const exceptions = session.issues.filter(text => text.includes('[exception]'))
check('全程没有未捕获异常', exceptions.length === 0, exceptions.slice(0, 3).join(' | ') || '0 条')

session.close()
server.close()

console.log(`\n${pass} PASS / ${failures.length} FAIL`)
if (failures.length)
  console.log(`失败项：${failures.join('、')}`)
process.exit(failures.length ? 1 : 0)
