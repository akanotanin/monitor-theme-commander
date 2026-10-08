// 拍主题预览图（preview.png，1600×900 @2x —— 与上游主题同比例，参照同仓库其它移植用 2x）
//
// 用法：node tools/shot_preview.mjs [baseUrl] [outfile]
//   baseUrl 默认 http://127.0.0.1:7980（本机隧道到隔离测试 hub）
// 拍摄前等：卡片渲染 + 字体 loaded + 延迟读数出现
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { openSession } from './cdp.mjs'

const BASE = (process.argv[2] || 'http://127.0.0.1:7980').replace(/\/$/, '')
const OUT = process.argv[3] || 'preview.png'

const session = await openSession({ width: 1600, height: 900, dpr: 2 })
try {
  await session.goto(`${BASE}/`)
  await session.evaluate(`localStorage.setItem('komari-language','zh-Hans')`)
  await session.goto(`${BASE}/`)
  await session.addStyle('html{scrollbar-width:none}::-webkit-scrollbar{display:none}')

  // 首访默认是地球视图；预览图取「卡片」视图（数据密度更像面板缩略图）
  await session.waitFor(`!!document.querySelector('.globe-top-strip') || document.querySelectorAll('.node-card-commander').length > 0`, 60000)
  await session.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '卡片'); if (b) b.click(); })()`)

  const ready = await session.waitFor(
    `document.querySelectorAll('.node-card-commander').length > 0
      && document.fonts.status === 'loaded'
      && document.body.innerText.includes('ms')`,
    60000,
  )
  if (!ready)
    throw new Error('页面未在 60 秒内就绪')

  // 数值动画落定：等两次采样文本一致（统计数字带滚动动画）
  let last = ''
  for (let i = 0; i < 30; i++) {
    const text = await session.evaluate(`document.body.innerText`)
    if (text && text === last)
      break
    last = text
    await sleep(500)
  }

  await session.screenshot(OUT)
  const size = await session.evaluate(`JSON.stringify({w: innerWidth, h: innerHeight})`)
  console.log(`已拍摄 ${OUT} @ ${size}`)
}
finally {
  session.close()
}
