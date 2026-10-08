import { readFileSync } from 'node:fs'
import process from 'node:process'

/**
 * 校验 theme.json 是否符合 Monitor Hub 面板的隐性规则
 * （这些规则写错时面板不会报错，只会静默丢字段 / 画不出来）
 */
const meta = JSON.parse(readFileSync('theme.json', 'utf8'))
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

const failures = []
const passes = []
const check = (ok, message) => (ok ? passes : failures).push(message)

for (const key of ['name', 'short', 'description', 'version', 'author']) {
  check(typeof meta[key] === 'string' && meta[key].trim().length > 0, `必填字段 ${key}`)
}
check(typeof meta.url === 'string', 'url 必须是字符串（仓库未建时可留空串）')
check(/^[\w-]+$/.test(meta.short ?? ''), `short 只允许字母数字下划线连字符（当前 ${meta.short}）`)
check(/^\d+\.\d+\.\d+$/.test(meta.version ?? ''), `version 必须是 x.y.z（当前 ${meta.version}）`)
check(meta.version === pkg.version, `version 与 package.json 一致（theme ${meta.version} / pkg ${pkg.version}）`)
if (typeof meta.url === 'string' && meta.url.trim().length > 0) {
  check(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(meta.url), `url 必须是 GitHub 仓库地址（当前 ${meta.url}）`)
  check(meta.url.endsWith(`/${pkg.name}`), `url 的仓库名应与 package.json 的 name 一致（${pkg.name}）`)
}

const TYPES = new Set(['title', 'boolean', 'number', 'select', 'string', 'text'])
const config = Array.isArray(meta.config) ? meta.config : []
check(config.length > 0, 'config 不能为空')

const keys = new Set()
let lastTitle = false
let lastWasTitle = false
config.forEach((field, index) => {
  const at = `config[${index}]`
  check(TYPES.has(field.type), `${at} type 合法（${field.type}）`)
  if (field.type === 'title') {
    check(typeof field.label === 'string' && field.label.trim().length > 0, `${at} title 必须有 label`)
    check(!lastWasTitle, `${at} 不能两个 title 相邻`)
    lastTitle = true
    lastWasTitle = true
    return
  }
  check(typeof field.key === 'string' && field.key.trim().length > 0, `${at} 必须有 key`)
  check(!keys.has(field.key), `${at} key 不能重复（${field.key}）`)
  keys.add(field.key)
  check(lastTitle, `${at} 所在的第一个 title 之前不能直接放字段`)
  lastWasTitle = false
  check(typeof field.label === 'string' && field.label.trim().length > 0, `${at} 必须有 label`)

  if (field.type === 'boolean') {
    check(typeof field.default === 'boolean', `${at} boolean 的 default 必须是布尔值`)
  }
  else if (field.type === 'number') {
    check(typeof field.default === 'number' && Number.isFinite(field.default), `${at} number 的 default 必须是数字`)
    if (typeof field.min === 'number')
      check(field.default >= field.min, `${at} default 不小于 min`)
    if (typeof field.max === 'number')
      check(field.default <= field.max, `${at} default 不大于 max`)
  }
  else if (field.type === 'select') {
    const options = Array.isArray(field.options) ? field.options : []
    check(options.length > 0, `${at} select 必须有 options`)
    const values = options.map(o => o.value)
    check(values.every(v => typeof v === 'string' && v.length > 0), `${at} options 的 value 必须是非空字符串`)
    check(new Set(values).size === values.length, `${at} options 的 value 不能重复`)
    check(options.every(o => typeof o.label === 'string' && o.label.length > 0), `${at} options 的 label 必须是非空字符串`)
    check(values.includes(field.default), `${at} select 的 default 必须在 options 里（${field.default}）`)
  }
  else {
    check(typeof field.default === 'string', `${at} ${field.type} 的 default 必须是字符串`)
  }
})
// 最后一个 title 后面必须有字段
check(!lastWasTitle, '最后一个 title 后面必须有字段')

for (const line of passes)
  console.log(`PASS  ${line}`)
for (const line of failures)
  console.error(`FAIL  ${line}`)
console.log(`\ncheck-manifest: ${passes.length} PASS / ${failures.length} FAIL`)
process.exit(failures.length ? 1 : 0)
