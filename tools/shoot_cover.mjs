// 生成封面式 preview.png（参照上游 komari-theme-commander 的封面构图）。
//
// 流程：
//   1. 从测试 Hub 拍三张真实截图（en 界面）：
//      - deepspace + 地球视图（前景深色）
//      - clean + 网格视图（右上浅色）
//      - clean + 网格视图（下滚一屏，左下浅色）
//   2. 用这三张图 + 包内字体拼一张 1600×900 的封面页（图片/字体全部内嵌为 data URI），
//      headless 截成 preview.png（@2x = 3200×1800）。
//
// 用法：node tools/shoot_cover.mjs [baseUrl]
//   baseUrl 默认 http://127.0.0.1:7980（本机隧道到隔离测试 hub）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { openSession } from './cdp.mjs'

const BASE = (process.argv[2] || 'http://127.0.0.1:7980').replace(/\/$/, '')
const OUT_DIR = 'tools/cover-assets'
mkdirSync(OUT_DIR, { recursive: true })

// ─────────── 1. 拍三张界面截图 ───────────
let session = await openSession({ width: 1440, height: 900, dpr: 2 })
try {
  await session.goto(`${BASE}/`)
  await session.evaluate(`localStorage.setItem('komari-language','zh-Hans'); localStorage.setItem('appearance','deepspace')`)
  await session.goto(`${BASE}/`)
  await session.waitFor(
    `!!document.querySelector('.globe-top-strip') && document.querySelectorAll('.sidebar-node-item').length > 0 && document.fonts.status === 'loaded'`,
    60000,
  )
  await session.addStyle('html{scrollbar-width:none}::-webkit-scrollbar{display:none}')
  // 雷达扫掠扇区（16s 一圈）扫到球体上时会像一块暗色楔形盖在右下；
  // 封面取它扫走的干净相位 —— 只隐藏扇区，保留雷达圆环与扫描线装饰。
  await session.addStyle('.globe-radar-layer .radar-scan{display:none !important}')
  await sleep(4500)
  // 信息流若正在滚一条「信号丢失」，会显得像故障；等它滚过去再拍。
  await session.waitFor(
    `(() => { const t = document.querySelector('.globe-feed')?.innerText ?? ''; return t.length > 0 && !t.includes('信号丢失') })()`,
    30000,
  )
  await session.screenshot(`${OUT_DIR}/dark-globe.png`)
  console.log('✓ dark-globe.png')

  await session.evaluate(`localStorage.setItem('appearance','clean')`)
  await session.goto(`${BASE}/`)
  await session.waitFor(`!!document.querySelector('.globe-top-strip') || document.querySelectorAll('.node-card-commander').length > 0`, 60000)
  await session.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '卡片'); if (b) b.click(); return !!b })()`)
  await session.waitFor(
    `document.querySelectorAll('.node-card-commander').length > 0 && document.fonts.status === 'loaded' && document.body.innerText.includes('ms')`,
    60000,
  )
  await session.addStyle('html{scrollbar-width:none}::-webkit-scrollbar{display:none}')
  await sleep(900)
  await session.screenshot(`${OUT_DIR}/light-grid.png`)
  console.log('✓ light-grid.png')
  await session.evaluate(`window.scrollTo(0, 430)`)
  await sleep(1000)
  await session.screenshot(`${OUT_DIR}/light-grid2.png`)
  console.log('✓ light-grid2.png')
}
finally {
  session.close()
}

// ─────────── 2. 拼封面页（全部内嵌，file:// 直接可渲染） ───────────
const b64 = (path, mime) => `data:${mime};base64,${readFileSync(path).toString('base64')}`
const dark = b64(join(OUT_DIR, 'dark-globe.png'), 'image/png')
const lightTop = b64(join(OUT_DIR, 'light-grid.png'), 'image/png')
const lightBottom = b64(join(OUT_DIR, 'light-grid2.png'), 'image/png')
const orbitron = b64('public/fonts/orbitron-latin-600-normal.woff2', 'font/woff2')
const plex400 = b64('public/fonts/ibm-plex-sans-latin-400-normal.woff2', 'font/woff2')
const plex700 = b64('public/fonts/ibm-plex-sans-latin-700-normal.woff2', 'font/woff2')

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  @font-face { font-family:'Orbitron'; src:url(${orbitron}) format('woff2'); font-weight:600; }
  @font-face { font-family:'IBM Plex Sans'; src:url(${plex400}) format('woff2'); font-weight:400; }
  @font-face { font-family:'IBM Plex Sans'; src:url(${plex700}) format('woff2'); font-weight:700; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:1600px; height:900px; overflow:hidden; }
  body {
    position:relative; font-family:'IBM Plex Sans','Microsoft YaHei',sans-serif; color:#fff;
    background:linear-gradient(132deg, #08141f 0%, #0a1a2a 55%, #0d2233 100%);
  }
  .grid { position:absolute; inset:0;
    background-image:
      linear-gradient(rgba(63,224,242,0.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(63,224,242,0.035) 1px, transparent 1px);
    background-size:40px 40px; }
  .glow-cyan { position:absolute; width:1350px; height:1050px; left:470px; top:-90px;
    background:radial-gradient(closest-side, rgba(63,224,242,0.13), rgba(63,224,242,0) 72%); }
  .glow-purple { position:absolute; width:1050px; height:620px; left:300px; top:520px;
    background:radial-gradient(closest-side, rgba(138,92,246,0.11), rgba(138,92,246,0) 72%); }
  .kicker { position:absolute; left:88px; top:158px; font-family:'Orbitron','Microsoft YaHei'; font-weight:600;
    font-size:16px; letter-spacing:0.4em; color:#3fe0f2; }
  h1 { position:absolute; left:86px; top:194px; font-weight:700; font-size:94px; line-height:0.98;
    letter-spacing:-0.015em; color:#ffffff; }
  h1 .cyan { display:block; color:#3fe0f2; }
  .divider { position:absolute; left:88px; top:434px; width:92px; height:4px; border-radius:2px;
    background:linear-gradient(90deg, #3fe0f2, #8a5cf6); }
  .tagline { position:absolute; left:88px; top:468px; width:600px;
    font-size:25px; line-height:1.5; color:#d0dce4; }
  .pills { position:absolute; left:88px; top:628px; width:600px; display:flex; flex-wrap:wrap; gap:14px; }
  .pill { border:1px solid rgba(63,224,242,0.45); background:rgba(4,22,32,0.72); border-radius:999px;
    padding:11px 22px; font-size:16px; color:#eaf6fa; white-space:nowrap; }
  .foot { position:absolute; left:88px; top:812px; display:flex; align-items:center; gap:12px;
    font-family:'Orbitron','Microsoft YaHei'; font-weight:600; font-size:14px; letter-spacing:0.3em; color:#b0c4d0; }
  .foot .dot { width:8px; height:8px; border-radius:50%; background:#3fe0f2;
    box-shadow:0 0 10px rgba(63,224,242,0.9); }
  .shot { position:absolute; border-radius:12px; overflow:hidden;
    border:1px solid rgba(255,255,255,0.10); background:#0b1620; }
  .shot img { display:block; width:100%; height:auto; }
  .shot-light-top { left:980px; top:82px; width:560px; z-index:1; box-shadow:0 30px 80px rgba(0,0,0,0.55); }
  .shot-light-bottom { left:620px; top:552px; width:470px; z-index:1; box-shadow:0 24px 70px rgba(0,0,0,0.5); }
  .shot-dark { left:728px; top:244px; width:812px; z-index:2; box-shadow:0 44px 110px rgba(0,0,0,0.66); }
  .badge { position:absolute; left:1302px; top:160px; z-index:3; display:inline-flex; align-items:center;
    gap:9px; background:#ffffff; border-radius:999px; padding:9px 20px 9px 14px;
    box-shadow:0 14px 34px rgba(0,0,0,0.45); }
  .badge .dot { width:12px; height:12px; border-radius:50%; background:#00e676; }
  .badge .label { font-weight:700; font-size:19px; color:#0b1a22; letter-spacing:0.02em; }
</style>
</head>
<body>
  <div class="grid"></div>
  <div class="glow-cyan"></div>
  <div class="glow-purple"></div>
  <div class="kicker">极简探针主题</div>
  <h1>Monitor<span class="cyan">Commander</span></h1>
  <div class="divider"></div>
  <div class="tagline">面向全球节点的指挥台监控：<br>实时图表、隐私安全的公开面板。</div>
  <div class="pills">
    <div class="pill">三套配色</div>
    <div class="pill">3D 地球</div>
    <div class="pill">隐私模式</div>
    <div class="pill">实时遥测</div>
  </div>
  <div class="foot"><span class="dot"></span>地球&nbsp;&nbsp;卡片&nbsp;&nbsp;表格&nbsp;&nbsp;可用性</div>
  <div class="shot shot-light-top"><img src="${lightTop}"></div>
  <div class="shot shot-light-bottom"><img src="${lightBottom}"></div>
  <div class="shot shot-dark"><img src="${dark}"></div>
  <div class="badge"><span class="dot"></span><span class="label">8 在线</span></div>
</body>
</html>`

const coverPath = join(OUT_DIR, 'cover.html')
writeFileSync(coverPath, html)

// ─────────── 3. 截封面 ───────────
session = await openSession({ width: 1600, height: 900, dpr: 2 })
try {
  await session.goto(pathToFileURL(coverPath).href)
  await session.waitFor(
    `document.fonts.status === 'loaded' && [...document.images].every(i => i.complete && i.naturalWidth > 0)`,
    30000,
  )
  await sleep(400)
  await session.screenshot('preview.png')
}
finally {
  session.close()
}

const head = readFileSync('preview.png').subarray(0, 33)
const w = head.readUInt32BE(16)
const h = head.readUInt32BE(20)
console.log(`✓ preview.png ${w}×${h}`)
