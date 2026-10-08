import { readFileSync } from 'node:fs'
import process from 'node:process'

/**
 * 双向比对：theme.json 的默认值 ⟷ 源码内置默认值（src/hooks/useAppConfig.ts 的 defaultThemeConfig）
 * 只改一边的症状是「后台显示开着、页面还是旧样子」，两边都不报错 —— 所以这里必须挡。
 */
const meta = JSON.parse(readFileSync('theme.json', 'utf8'))
const source = readFileSync('src/hooks/useAppConfig.ts', 'utf8')

const match = source.match(/const defaultThemeConfig: ThemeConfig = \{([\s\S]*?)\n\};/)
if (!match)
  throw new Error('未能在 src/hooks/useAppConfig.ts 里找到 defaultThemeConfig')

const codeDefaults = {}
for (const rawLine of match[1].split('\n')) {
  const line = rawLine.replace(/\/\/.*$/, '').trim()
  if (!line)
    continue
  const entry = line.match(/^([\w$]+):\s*(.+?),?$/)
  if (!entry)
    throw new Error(`无法解析默认值行: ${rawLine}`)
  codeDefaults[entry[1]] = JSON.parse(entry[2].replace(/'/g, '"'))
}

const failures = []
const passes = []
const themeFields = (meta.config ?? []).filter(field => field.type !== 'title')

for (const field of themeFields) {
  if (!(field.key in codeDefaults)) {
    failures.push(`theme.json 有 ${field.key}，源码 defaultThemeConfig 缺这个键`)
    continue
  }
  if (JSON.stringify(codeDefaults[field.key]) !== JSON.stringify(field.default)) {
    failures.push(`默认值不一致 ${field.key}: theme.json=${JSON.stringify(field.default)} 源码=${JSON.stringify(codeDefaults[field.key])}`)
    continue
  }
  passes.push(`默认值一致 ${field.key} = ${JSON.stringify(field.default)}`)
}

const themeKeys = new Set(themeFields.map(field => field.key))
for (const key of Object.keys(codeDefaults)) {
  if (!themeKeys.has(key))
    failures.push(`源码 defaultThemeConfig 有 ${key}，theme.json 里没有（站长在面板里改不了）`)
}

for (const line of passes)
  console.log(`PASS  ${line}`)
for (const line of failures)
  console.error(`FAIL  ${line}`)
console.log(`\ncheck-defaults: ${passes.length} PASS / ${failures.length} FAIL`)
process.exit(failures.length ? 1 : 0)
