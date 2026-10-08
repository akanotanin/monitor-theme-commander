// 主题验收：对着真实 hub（默认走本机隧道到隔离测试 hub）跑一组硬断言。
//
// 用法：node tools/verify_theme.mjs [baseUrl]
//   baseUrl 默认 http://127.0.0.1:7980（ssh -N -L 7980:127.0.0.1:<hub端口> <目标机>）
//
// 断言（每条都对应一个移植时真出过问题的点）：
//   ① 首访默认视图是「地球」且真的渲染了（cobe canvas 在）
//   ② 卡片视图渲染出节点卡片（数据层通了）
//   ③ 字体是包内自托管：零请求 fonts.googleapis / fonts.gstatic，且 Orbitron 真的加载了
//   ④ 实时通道状态为「已连接」（/api/ws 帧在跑）
//   ⑤ 卡片出现延迟读数（ms）—— ping 预热链路通了
//   ⑥ 表格 / 可用性视图能切换并渲染
//   ⑦ 点开节点详情页能渲染硬件面板与图表
//   ⑧ 390 宽无横向溢出、控制台无错误
import { mkdirSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { openSession } from './cdp.mjs'

const BASE = (process.argv[2] || 'http://127.0.0.1:7980').replace(/\/$/, '')
let passed = 0
const failures = []

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`)
  }
  else {
    failures.push(name)
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 用真鼠标事件点击元素中心（React 19 对合成 click() 不一定响应） */
async function clickSelector(session, selector) {
  const box = await session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return null
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  })()`)
  if (!box)
    return false
  const { x, y } = JSON.parse(box)
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return true
}

/** 按文案点击顶栏视图按钮 */
async function clickViewTab(session, label) {
  return await session.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

mkdirSync('shots', { recursive: true })

const session = await openSession({ width: 1440, height: 1000 })
try {
  await session.goto(`${BASE}/`)
  // 用与站长/访客一致的中文口径跑断言
  await session.evaluate(`localStorage.setItem('komari-language','zh-Hans')`)
  await session.goto(`${BASE}/`)

  // ① 首访默认视图 = 地球
  const globe = await session.waitFor(
    `!!document.querySelector('.globe-top-strip') && document.fonts.status === 'loaded'`,
    60000,
  )
  check('首访默认视图是「地球」', globe)
  const canvas = await session.waitFor(`!!document.querySelector('canvas')`, 15000)
  check('地球视图渲染出 canvas（WebGL）', canvas)
  await sleep(600)
  await session.screenshot('shots/desktop-globe.png')
  console.log('  已截图 shots/desktop-globe.png')

  // ⑩ 地球形态：列表行与侧栏详情都不显示备注 —— 备注只在详情页出现
  const sideRowChips = await session.evaluate(`document.querySelectorAll('.sidebar-node-item .tag-pill-neutral').length`)
  check('地球侧栏列表行不显示备注', sideRowChips === 0, `实际 ${sideRowChips}`)
  const clickedSideRow = await clickSelector(session, '.sidebar-node-item')
  const sideDetail = await session.waitFor(`!!document.querySelector('[aria-label="Back to fleet"]')`, 15000)
  check('地球侧栏能打开节点详情', clickedSideRow === true && sideDetail === true)
  const sideDetailChips = await session.evaluate(`document.querySelectorAll('.tag-pill-neutral').length`)
  check('侧栏详情不显示备注（备注只在详情页）', sideDetailChips === 0, `实际 ${sideDetailChips}`)

  // ② 卡片视图
  check('能点击「卡片」视图', await clickViewTab(session, '卡片') === true)
  const rendered = await session.waitFor(
    `document.querySelectorAll('.node-card-commander').length > 0`,
    30000,
  )
  check('卡片视图渲染出节点卡片', rendered)

  // ⑤ 延迟数据是后台预热的，等它上卡（最多 20 秒）
  const latency = await session.waitFor(`document.body.innerText.includes('ms')`, 20000)
  check('卡片出现延迟读数（ms）', latency)

  const info = JSON.parse(await session.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.node-card-commander')]
    const res = performance.getEntriesByType('resource')
    return JSON.stringify({
      cards: cards.length,
      firstCard: (cards[0]?.innerText ?? '').slice(0, 260),
      googleFonts: res.filter(r => r.name.includes('fonts.googleapis') || r.name.includes('fonts.gstatic')).length,
      localFonts: res.filter(r => r.name.includes('/fonts/')).length,
      title: document.title,
      header: (document.querySelector('header')?.innerText ?? '').replace(/\\n/g, ' | ').slice(0, 160),
      ws: document.querySelector('[role="status"]')?.innerText ?? '',
      orbitron: document.fonts.check('16px Orbitron'),
      plex: document.fonts.check('16px "IBM Plex Sans"'),
    })
  })()`))

  check('节点卡片数量 > 0', info.cards > 0, `${info.cards} 张`)
  check('零 Google Fonts 请求', info.googleFonts === 0, `实际 ${info.googleFonts}`)
  check('字体从包内加载（/fonts/ 资源 ≥ 1）', info.localFonts >= 1, `实际 ${info.localFonts}`)
  check('Orbitron 已加载', info.orbitron === true)
  check('IBM Plex Sans 已加载', info.plex === true)

  // ⑨ 国旗走包内 SVG（Windows 上 emoji 旗帜会退化成「JP」字母对）；备注拆成标签胶囊
  const flagInfo = JSON.parse(await session.evaluate(`(() => {
    const flags = [...document.querySelectorAll('.node-card-commander .fi')]
    const codes = [...new Set(flags.map(f => [...f.classList].find(c => /^fi-[a-z]{2}$/.test(c)) || '?'))]
    const chips = [...document.querySelectorAll('.node-card-commander .tag-pill-neutral')].map(c => (c.textContent || '').trim())
    const res = performance.getEntriesByType('resource').filter(r => r.name.includes('/flags/'))
    return JSON.stringify({ flags: flags.length, codes, chips: [...new Set(chips)], flagAssets: res.length })
  })()`))
  check('卡片国旗用包内 SVG 渲染（.fi）', flagInfo.flags >= 1 && flagInfo.flagAssets >= 1, `${flagInfo.flags} 面 ${flagInfo.codes.join(',')}；资源请求 ${flagInfo.flagAssets}`)
  check('备注拆成独立标签胶囊', flagInfo.chips.includes('CN2 GIA'), flagInfo.chips.join(' / ').slice(0, 120))
  check('实时通道显示「已连接」', info.ws.includes('已连接'), `实际 "${info.ws}"`)
  check('标签页标题不是 Komari 字样', !info.title.includes('Komari'), `实际 "${info.title}"`)
  console.log(`    标题：${info.title}`)
  console.log(`    页头：${info.header}`)
  console.log(`    首卡：${info.firstCard.replace(/\n/g, ' | ').slice(0, 220)}`)

  await session.addStyle('html{scrollbar-width:none}::-webkit-scrollbar{display:none}')
  await session.screenshot('shots/desktop-grid.png')
  console.log('  已截图 shots/desktop-grid.png')

  // ⑦ 点开第一个节点 → 详情页（跳转热区是节点名那一行，上游设计如此）
  const clickedCard = await clickSelector(session, '.node-card-commander .node-name')
  check('能点击节点卡片', clickedCard === true)
  const detail = await session.waitFor(`!!document.querySelector('.node-info-panel')`, 20000)
  check('详情页渲染出硬件信息面板', detail === true)
  // 详情页的备注与卡片同口径：拆成标签胶囊并入标签条
  const detailStrip = JSON.parse(await session.evaluate(`(() => {
    const panel = document.querySelector('.node-info-panel')
    const chips = [...(panel?.querySelectorAll('.tag-pill-neutral') ?? [])].map(c => (c.textContent || '').trim())
    return JSON.stringify({ chips, head: (panel?.innerText ?? '').split('\\n').slice(0, 4).join(' | ').slice(0, 160) })
  })()`))
  check('详情页备注拆成标签胶囊', detailStrip.chips.includes('CN2 GIA'), detailStrip.chips.join(' / ').slice(0, 120))
  console.log(`    详情面板首段：${detailStrip.head}`)
  const charts = await session.waitFor(`!!document.querySelector('[data-chart], .recharts-surface')`, 25000)
  check('详情页渲染出图表', charts === true)
  // 等图表真的画出数据线（约 60 个点的折线 d 会很长），再截图
  const chartData = await session.waitFor(
    `[...document.querySelectorAll('.recharts-surface path')].some(p => (p.getAttribute('d') || '').length > 300)`,
    25000,
  )
  check('图表画出了数据曲线', chartData === true)
  await sleep(600)
  await session.screenshot('shots/desktop-detail.png')
  console.log('  已截图 shots/desktop-detail.png')
  await session.goto(`${BASE}/`)
  await session.waitFor(`document.querySelectorAll('.node-card-commander').length > 0`, 30000)

  // ⑥ 表格 / 可用性视图
  check('能点击「表格」视图', await clickViewTab(session, '表格') === true)
  const tableUp = await session.waitFor(`!!document.querySelector('table')`, 15000)
  check('表格视图渲染出 table', tableUp === true)
  const tableChips = await session.evaluate(`document.querySelectorAll('.tag-pill-neutral').length`)
  check('表格视图有备注标签', tableChips >= 1, `实际 ${tableChips}`)

  check('能点击「可用性」视图', await clickViewTab(session, '可用性') === true)
  const uptimeUp = await session.waitFor(`!!document.querySelector('.uptime-status-strip')`, 20000)
  check('可用性视图渲染出状态条', uptimeUp === true)

  check('能回到「卡片」视图', await clickViewTab(session, '卡片') === true)
  await session.waitFor(`document.querySelectorAll('.node-card-commander').length > 0`, 15000)

  // 手机视口
  await session.setViewport(390, 844, 2, true)
  await sleep(900)
  const overflow = await session.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)
  check('390 宽无横向溢出', overflow === true)
  await session.screenshot('shots/mobile-grid.png')
  console.log('  已截图 shots/mobile-grid.png')

  const errors = session.issues.filter(text => !text.includes('[warning]'))
  check('控制台无错误', errors.length === 0, errors.slice(0, 3).join(' ; ') || '干净')
  if (session.issues.length)
    console.log(`    控制台共 ${session.issues.length} 条（含警告）：\n      ${session.issues.slice(0, 8).join('\n      ')}`)
}
finally {
  session.close()
}

console.log(`\n${passed} PASS / ${failures.length} FAIL`)
if (failures.length)
  console.log(`失败：${failures.join('、')}`)
process.exit(failures.length ? 1 : 0)
