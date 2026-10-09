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
//   ⑦ 点开节点详情页能渲染硬件面板与图表（无历史序列显示「无历史数据」）
//   ⑧ 390 宽无横向溢出、控制台无错误
//   ⑨ 图表弹窗：网络页签画出速率曲线；负载/连接页签显示「无历史数据」
//   ⑩ 私有备注（打桩登录态）渲染为带锁小卡片；表格备注行按惯例（到期前置 + 私有芯片 + 芯片浮层）
//   ⑫ 图表弹窗页签顺序（ping 第一位、负载最后）与默认页签
//   ⑬ 卡片右上角打开图表按钮
//   ⑭ 表格标签行（tablechips）与到期前置
//   ⑮ Ping 延迟线路设置（打桩）与丢包红点（打桩）
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

  // ⑩ 地球形态：列表行不显示分组/标签/备注；侧栏详情头部=单行（日期+分组+备注，溢出折 +N）
  const sideRowChips = await session.evaluate(`document.querySelectorAll('.sidebar-node-item .tag-pill-neutral, .sidebar-node-item [class*="bg-primary/15"]').length`)
  check('地球侧栏列表行不显示分组/标签/备注', sideRowChips === 0, `实际 ${sideRowChips}`)
  const clickedSideRow = await clickSelector(session, '.sidebar-node-item')
  const sideDetail = await session.waitFor(`!!document.querySelector('[aria-label="Back to fleet"]')`, 15000)
  check('地球侧栏能打开节点详情', clickedSideRow === true && sideDetail === true)
  const headRowInfo = await session.evaluate(`(() => {
    const row = document.querySelector('[data-accent="headchips"]')
    if (!row) return JSON.stringify({ ok: false })
    const cs = getComputedStyle(row)
    return JSON.stringify({
      ok: true,
      nowrap: cs.flexWrap === 'nowrap',
      clip: cs.overflowX === 'hidden' || cs.overflow === 'hidden',
      text: (row.innerText || '').replace(/\\s+/g, ' '),
    })
  })()`)
  const headRow = JSON.parse(headRowInfo)
  check('侧栏详情头部有单行标签行（不换行 + 溢出裁切）', headRow.ok === true && headRow.nowrap === true && headRow.clip === true, headRowInfo.slice(0, 120))
  check('头部行显示分组芯片', headRow.ok === true && headRow.text.includes('东京'), headRow.text)
  check('头部行显示备注芯片或 +N 悬浮层', headRow.ok === true && (headRow.text.includes('CN2 GIA') || headRow.text.includes('+')), headRow.text)

  // ⑪ 侧栏详情：延迟曲线（磁盘下方、流量上方）
  const pingPath = await session.waitFor(`(() => {
    const p = document.querySelector('.sidebar-detail-telemetry [data-accent="ping"] .sparkline-container svg path')
    return !!p && (p.getAttribute('d') || '').length > 50
  })()`, 45000)
  const pingLayout = await session.evaluate(`(() => {
    const tel = document.querySelector('.sidebar-detail-telemetry')
    if (!tel) return JSON.stringify({ ok: false })
    const secs = [...tel.querySelectorAll('.stat-section')]
    const ping = tel.querySelector('[data-accent="ping"]')
    const traffic = secs.find(e => (e.innerText || '').includes('流量'))
    return JSON.stringify({ ping: secs.indexOf(ping), traffic: secs.indexOf(traffic) })
  })()`)
  const pingPos = JSON.parse(pingLayout)
  check('侧栏详情显示延迟曲线（画出曲线）', pingPath === true)
  check('延迟曲线位于磁盘与流量之间', pingPos.ping === 1 && pingPos.traffic === 2, `ping@${pingPos.ping} traffic@${pingPos.traffic}`)

  // ⑨ 图表弹窗（侧栏详情 → 「图表」按钮）：网络页签画速率曲线；负载/连接显示「无历史数据」
  const chartsBtn = await session.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '图表')
    if (!b) return false
    b.click()
    return true
  })()`)
  const modalUp = await session.waitFor(`!!document.querySelector('.chart-card-commander')`, 20000)
  check('侧栏详情能打开图表弹窗', chartsBtn === true && modalUp === true)
  const tabOrder = JSON.parse(await session.evaluate(`(() => {
    const known = ['Ping', 'CPU', '内存', '磁盘', '网络', '连接', '流量', '负载']
    const tabs = [...document.querySelectorAll('.chart-card-commander button')]
      .map(b => (b.innerText || '').trim())
      .filter(x => known.includes(x))
    return JSON.stringify({ tabs })
  })()`))
  check('弹窗页签 ping 在第一位', tabOrder.tabs[0] === 'Ping', tabOrder.tabs.join(' / '))
  check('弹窗页签 负载 在最后一位', tabOrder.tabs[tabOrder.tabs.length - 1] === '负载', tabOrder.tabs.join(' / '))
  const pingTabDrawn = await session.waitFor(
    `[...document.querySelectorAll('.chart-card-commander .recharts-surface path')].some(p => (p.getAttribute('d') || '').length > 100)`,
    45000,
  )
  check('弹窗默认页签（Ping 延迟）画出曲线', pingTabDrawn === true)
  const clickModalTab = label => session.evaluate(`(() => {
    const b = [...document.querySelectorAll('.chart-card-commander button')].find(x => x.innerText.trim() === ${JSON.stringify(label)})
    if (!b) return false
    b.click()
    return true
  })()`)
  check('弹窗能点「网络」页签', await clickModalTab('网络') === true)
  const netDrawn = await session.waitFor(
    `[...document.querySelectorAll('.chart-card-commander .recharts-surface path')].some(p => (p.getAttribute('d') || '').length > 100)`,
    25000,
  )
  check('弹窗「网络」页签画出速率曲线', netDrawn === true)
  await session.screenshot('shots/modal-network.png')
  check('弹窗能点「负载」页签', await clickModalTab('负载') === true)
  await sleep(600)
  const loadEmpty = await session.evaluate(`document.querySelector('.chart-card-commander')?.innerText.includes('无历史数据') === true`)
  check('弹窗「负载」页签显示「无历史数据」', loadEmpty === true)
  await session.screenshot('shots/modal-load.png')
  check('弹窗能点「连接」页签', await clickModalTab('连接') === true)
  await sleep(600)
  const connEmpty = await session.evaluate(`document.querySelector('.chart-card-commander')?.innerText.includes('无历史数据') === true`)
  check('弹窗「连接」页签显示「无历史数据」', connEmpty === true)
  await session.evaluate(`(() => {
    const b = document.querySelector('.chart-card-commander button[aria-label="关闭"]')
    if (b) { b.click(); return true }
    return false
  })()`)
  await session.waitFor(`!document.querySelector('.chart-card-commander')`, 10000)

  // ② 卡片视图
  check('能点击「卡片」视图', await clickViewTab(session, '卡片') === true)
  const rendered = await session.waitFor(
    `document.querySelectorAll('.node-card-commander').length > 0`,
    30000,
  )
  check('卡片视图渲染出节点卡片', rendered)

  // 卡片右上角：打开图表按钮 → 弹窗
  const cardChartBtn = await session.evaluate(`!!document.querySelector('.node-card-commander [data-accent="cardcharts"]')`)
  check('卡片右上角有打开图表按钮', cardChartBtn === true)
  await clickSelector(session, '.node-card-commander [data-accent="cardcharts"]')
  const modalFromCard = await session.waitFor(`!!document.querySelector('.chart-card-commander')`, 20000)
  check('卡片按钮能打开图表弹窗', modalFromCard === true)
  await session.evaluate(`(() => { const b = document.querySelector('.chart-card-commander button[aria-label="关闭"]'); if (b) { b.click(); return true } return false })()`)
  await session.waitFor(`!document.querySelector('.chart-card-commander')`, 10000)

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
    const chips = [...document.querySelectorAll('.node-card-commander [data-accent="cardchips"] .tag-pill-neutral')].map(c => (c.textContent || '').trim())
    const res = performance.getEntriesByType('resource').filter(r => r.name.includes('/flags/'))
    return JSON.stringify({ flags: flags.length, codes, chips: [...new Set(chips)], flagAssets: res.length })
  })()`))
  check('卡片国旗用包内 SVG 渲染（.fi）', flagInfo.flags >= 1 && flagInfo.flagAssets >= 1, `${flagInfo.flags} 面 ${flagInfo.codes.join(',')}；资源请求 ${flagInfo.flagAssets}`)
  check('备注拆成独立标签胶囊', flagInfo.chips.includes('CN2 GIA'), flagInfo.chips.join(' / ').slice(0, 120))
  check('实时通道显示「已连接」', info.ws.includes('已连接'), `实际 "${info.ws}"`)
  check('标签页标题不是 Komari 字样', !info.title.includes('Komari'), `实际 "${info.title}"`)
  const footerText = await session.evaluate(`document.querySelector('footer')?.innerText ?? ''`)
  check('页脚署名是「由 Monitor 驱动」', footerText.includes('由 Monitor 驱动'), footerText.replace(/\n/g, ' | ').slice(-80))
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
  // 滚到图表网格再拍，让截图里能看到各图表卡片
  await session.evaluate(`(() => { const el = document.querySelector('.chart-card-commander'); if (el) { el.scrollIntoView({ block: 'start' }); return true } return false })()`)
  await sleep(600)
  await session.screenshot('shots/desktop-detail.png')
  console.log('  已截图 shots/desktop-detail.png（实时档）')
  // 切到历史档：Hub 不存的序列（负载/连接/进程）应给「无历史数据」提示而不是空网格
  const switched = await session.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '1天')
    if (!b) return false
    b.click()
    return true
  })()`)
  check('详情页能切到历史档（1天）', switched === true)
  const noHistorySeen = await session.waitFor(`document.body.innerText.includes('无历史数据')`, 20000)
  const noHistoryCount = await session.evaluate(`(document.body.innerText.match(/无历史数据/g) || []).length`)
  check('历史档无序列的图表显示「无历史数据」', noHistorySeen === true && noHistoryCount >= 3, `实际 ${noHistoryCount} 处`)
  await session.evaluate(`(() => { const el = document.querySelector('.chart-card-commander'); if (el) { el.scrollIntoView({ block: 'start' }); return true } return false })()`)
  await sleep(400)
  await session.screenshot('shots/desktop-detail-history.png')
  console.log('  已截图 shots/desktop-detail-history.png（历史档）')
  await session.goto(`${BASE}/`)
  await session.waitFor(`document.querySelectorAll('.node-card-commander').length > 0`, 30000)

  // ⑥ 表格 / 可用性视图
  check('能点击「表格」视图', await clickViewTab(session, '表格') === true)
  const tableUp = await session.waitFor(`!!document.querySelector('table')`, 15000)
  check('表格视图渲染出 table', tableUp === true)
  const tableChips = await session.evaluate(`document.querySelectorAll('.tag-pill-neutral').length`)
  check('表格视图有备注标签', tableChips >= 1, `实际 ${tableChips}`)
  const tableRowInfo = JSON.parse(await session.evaluate(`(() => {
    const rows = [...document.querySelectorAll('table [data-accent="tablechips"]')]
    const row = rows.find(r => (r.innerText || '').includes('CN2 GIA'))
    if (!row) return JSON.stringify({ ok: false, rows: rows.length })
    return JSON.stringify({ ok: true, text: (row.innerText || '').replace(/\\s+/g, ' ') })
  })()`))
  check('表格行渲染标签行（tablechips）', tableRowInfo.ok === true, `rows=${tableRowInfo.rows ?? '-'} "${(tableRowInfo.text || '').slice(0, 80)}"`)
  const tExp = tableRowInfo.ok ? tableRowInfo.text.indexOf('left') : -1
  const tRem = tableRowInfo.ok ? tableRowInfo.text.indexOf('CN2 GIA') : -1
  check('表格到期时间在备注之前', tExp !== -1 && tRem !== -1 && tExp < tRem, `exp@${tExp} rem@${tRem}`)
  const tableRowLine = JSON.parse(await session.evaluate(`(() => {
    const row = document.querySelector('table [data-accent="tablechips"]')
    if (!row) return JSON.stringify({ ok: false })
    const cs = getComputedStyle(row)
    return JSON.stringify({ ok: true, nowrap: cs.flexWrap === 'nowrap', clip: cs.overflowX === 'hidden' })
  })()`))
  check('表格标签行单行（不换行 + 溢出裁切）', tableRowLine.ok === true && tableRowLine.nowrap === true && tableRowLine.clip === true, JSON.stringify(tableRowLine))

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

// ⑩ 私有备注（登录管理员可见）：打桩登录态与节点备注，验证「带锁小卡片」版式
{
  const priv = await openSession({ width: 1440, height: 1000 })
  try {
    await priv.addInitScript(`(() => {
      const origFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const res = await origFetch(input, init)
        if (url.includes('/api/me')) {
          const data = await res.clone().json().catch(() => ({}))
          return new Response(JSON.stringify({ ...data, authed: true }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (url.includes('/api/nodes') && !url.includes('/api/nodes/') && !url.includes('/metrics')) {
          const data = await res.clone().json().catch(() => null)
          if (data && Array.isArray(data.nodes) && data.nodes[0]) {
            data.nodes[0].remark = '仅管理员可见的测试备注'
            data.admin = true
          }
          return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return res
      }
      // 实时帧不含私有备注、会把快照覆盖掉：这里让 ws 静默，主题自带 HTTP 轮询兜底
      class SilentWS { close() {} addEventListener() {} removeEventListener() {} send() {} }
      window.WebSocket = SilentWS
    })()`)
    await priv.goto(`${BASE}/`)
    await priv.evaluate(`localStorage.setItem('komari-language','zh-Hans')`)
    await priv.goto(`${BASE}/`)
    await priv.waitFor(`document.querySelectorAll('.node-card-commander').length > 0 || !!document.querySelector('.globe-top-strip')`, 60000)
    await priv.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '卡片'); if (b) b.click(); return !!b })()`)
    await priv.waitFor(`document.querySelectorAll('.node-card-commander').length > 0`, 30000)
    // 卡片标签行：单行 + 到期在所有备注之前 + 私有备注（可见或折进 +N 浮层）
    const cardRowInfo = JSON.parse(await priv.evaluate(`(() => {
      const row = document.querySelector('.node-card-commander [data-accent="cardchips"]')
      if (!row) return JSON.stringify({ ok: false })
      const cs = getComputedStyle(row)
      const texts = [...row.querySelectorAll('[data-chip-key]')].map(e => (e.innerText || '').trim())
      return JSON.stringify({ ok: true, nowrap: cs.flexWrap === 'nowrap', clip: cs.overflowX === 'hidden', texts })
    })()`))
    check('卡片标签行单行（不换行 + 溢出裁切）', cardRowInfo.ok === true && cardRowInfo.nowrap === true && cardRowInfo.clip === true, JSON.stringify(cardRowInfo).slice(0, 140))
    const expIdx = cardRowInfo.ok ? cardRowInfo.texts.findIndex(x => x.includes('left')) : -1
    const remIdx = cardRowInfo.ok ? cardRowInfo.texts.findIndex(x => x.includes('CN2 GIA')) : -1
    check('卡片到期时间在所有备注之前', expIdx !== -1 && remIdx !== -1 && expIdx < remIdx, `exp@${expIdx} rem@${remIdx} [${cardRowInfo.texts.join(' / ')}]`)
    const privVisible = await priv.evaluate(`document.querySelectorAll('.node-card-commander [data-accent="cardchips"] [data-private-remark]').length`)
    let privInOverflow = false
    const hasPlus = await priv.evaluate(`(() => {
      const row = document.querySelector('.node-card-commander [data-accent="cardchips"]')
      const plus = row ? [...row.children].find(e => (e.innerText || '').startsWith('+')) : null
      if (!plus) return false
      const r = plus.getBoundingClientRect()
      window.__plusBox = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      return true
    })()`)
    if (hasPlus) {
      const box = JSON.parse(await priv.evaluate(`JSON.stringify(window.__plusBox)`))
      await priv.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
      await priv.waitFor(`document.body.innerText.includes('仅管理员可见的测试备注')`, 8000)
      privInOverflow = await priv.evaluate(`document.body.innerText.includes('仅管理员可见的测试备注')`)
      const tipInfo = JSON.parse(await priv.evaluate(`(() => {
        const tip = document.querySelector('[data-slot="tooltip-content"]')
        if (!tip) return JSON.stringify({ ok: false })
        return JSON.stringify({ ok: true, chips: tip.querySelectorAll('.tag-pill-neutral, [data-private-remark]').length, arrow: !!tip.querySelector('svg.rotate-45'), text: (tip.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) })
      })()`))
      check('卡片 +N 悬浮层用芯片形态展示备注', tipInfo.ok === true && tipInfo.chips >= 1, `chips=${tipInfo.chips} "${tipInfo.text}"`)
      check('卡片 +N 悬浮层无菱形箭头', tipInfo.ok === true && tipInfo.arrow === false, `arrow=${tipInfo.arrow}`)
    }
    check('卡片显示私有备注（可见或折进 +N 浮层）', privVisible > 0 || privInOverflow === true, `visible=${privVisible} overflow=${privInOverflow}`)

    // 表格视图：私有备注同样按惯例（芯片 / 悬浮层芯片）
    await priv.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '表格'); if (b) b.click(); return !!b })()`)
    await priv.waitFor(`!!document.querySelector('table [data-accent="tablechips"]')`, 25000)
    const tRow = JSON.parse(await priv.evaluate(`(() => {
      const rows = [...document.querySelectorAll('table [data-accent="tablechips"]')]
      const row = rows.find(r => (r.innerText || '').includes('CN2 GIA')) || rows[0]
      if (!row) return JSON.stringify({ ok: false })
      const visible = row.querySelectorAll('[data-private-remark]').length
      const plus = [...row.children].find(e => (e.innerText || '').startsWith('+'))
      let plusBox = null
      if (plus) { const r = plus.getBoundingClientRect(); plusBox = { x: r.x + r.width / 2, y: r.y + r.height / 2 } }
      return JSON.stringify({ ok: true, visible, plusBox, text: (row.innerText || '').replace(/\\s+/g, ' ').slice(0, 90) })
    })()`))
    check('表格行备注行存在（打桩）', tRow.ok === true, `"${(tRow.text || '').slice(0, 80)}"`)
    if (tRow.plusBox) {
      await priv.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: tRow.plusBox.x, y: tRow.plusBox.y })
      await priv.waitFor(`document.body.innerText.includes('仅管理员可见的测试备注')`, 8000)
      const tipPriv = await priv.evaluate(`document.querySelectorAll('[data-slot="tooltip-content"] [data-private-remark]').length`)
      check('表格 +N 悬浮层以芯片展示私有备注', tipPriv >= 1, `tip=${tipPriv}`)
      const tipArrow = await priv.evaluate(`!!document.querySelector('[data-slot="tooltip-content"] svg.rotate-45')`)
      check('表格 +N 悬浮层无菱形箭头', tipArrow === false, `arrow=${tipArrow}`)
    }
    else {
      check('表格 +N 悬浮层以芯片展示私有备注', tRow.visible > 0, `visible=${tRow.visible}`)
    }
    // 切回卡片视图，继续原流程
    await priv.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '卡片'); if (b) b.click(); return !!b })()`)
    await priv.waitFor(`document.querySelectorAll('.node-card-commander').length > 0`, 20000)
    await clickSelector(priv, '.node-card-commander .node-name')
    await priv.waitFor(`!!document.querySelector('.node-info-panel')`, 20000)
    const privInfo = JSON.parse(await priv.evaluate(`(() => {
      const chips = [...document.querySelectorAll('.node-info-panel [data-private-remark]')]
      return JSON.stringify({
        count: chips.length,
        texts: chips.map(c => (c.textContent || '').trim()),
        locks: chips.filter(c => !!c.querySelector('svg')).length,
        oldNote: document.querySelectorAll('.node-info-panel [role="note"]').length,
      })
    })()`))
    check('私有备注渲染为带锁小卡片', privInfo.count >= 1 && privInfo.locks === privInfo.count && privInfo.texts.some(x => x.includes('仅管理员可见的测试备注')), JSON.stringify(privInfo))
    check('私有备注旧便签框已移除', privInfo.oldNote === 0, `实际 ${privInfo.oldNote}`)
    await priv.screenshot('shots/private-remark.png')
    console.log('  已截图 shots/private-remark.png')
  }
  finally {
    priv.close()
  }
}

// ⑮ Ping 延迟线路设置 + 丢包红点（打桩：主题配置指定线路 + ping 历史改写）
{
  const ps = await openSession({ width: 1440, height: 1000 })
  try {
    await ps.addInitScript(`(() => {
      const origFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (url.includes('/themes/commander/config')) {
          return new Response(JSON.stringify({ ping_lines: '美西 · 一毫秒' }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        const res = await origFetch(input, init)
        if (url.includes('series=ping')) {
          const data = await res.clone().json().catch(() => null)
          if (data && Array.isArray(data.ping)) {
            let k = 0
            data.ping = data.ping.map((p) => {
              if (p.task_id === 6) return { ...p, latency: 130 }
              if (p.task_id === 5) { k += 1; if (k % 9 === 0) return { ...p, latency: -1 } }
              return p
            })
          }
          return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return res
      }
      class SilentWS { close() {} addEventListener() {} removeEventListener() {} send() {} }
      window.WebSocket = SilentWS
    })()`)
    await ps.goto(`${BASE}/`)
    await ps.evaluate(`localStorage.setItem('komari-language','zh-Hans')`)
    await ps.goto(`${BASE}/`)
    await ps.waitFor(`document.querySelectorAll('.sidebar-node-item').length > 0`, 60000)
    await clickSelector(ps, '.sidebar-node-item')
    await ps.waitFor(`!!document.querySelector('.sidebar-detail-telemetry')`, 30000)
    const pinOk = await ps.waitFor(`(() => {
      const sec = document.querySelector('.sidebar-detail-telemetry [data-accent="ping"]')
      return !!sec && (sec.innerText || '').includes('130')
    })()`, 45000)
    const pinText = await ps.evaluate(`(() => { const sec = document.querySelector('.sidebar-detail-telemetry [data-accent="ping"]'); return sec ? (sec.innerText || '').replace(/\\s+/g, ' ').slice(0, 50) : '' })()`)
    check('「Ping 延迟线路」设置生效（数值跟随指定线路）', pinOk === true, pinText)

    // 丢包红点：打开图表弹窗（默认页签 = Ping 延迟）
    await ps.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '图表'); if (b) b.click(); return !!b })()`)
    await ps.waitFor(`!!document.querySelector('.chart-card-commander')`, 20000)
    const lossDots = await ps.waitFor(`document.querySelectorAll('.chart-card-commander circle[fill="#ef4444"]').length >= 1`, 45000)
    check('Ping 图表画出丢包红点（打桩数据）', lossDots === true)
    await ps.screenshot('shots/modal-ping-loss.png')
    console.log('  已截图 shots/modal-ping-loss.png')
  }
  finally {
    ps.close()
  }
}

console.log(`\n${passed} PASS / ${failures.length} FAIL`)
if (failures.length)
  console.log(`失败：${failures.join('、')}`)
process.exit(failures.length ? 1 : 0)
