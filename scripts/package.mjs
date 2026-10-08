import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/**
 * 打包极简探针（Monitor）主题包
 * 产物：release/theme.tar.gz（后台「主题 → 上传主题包」直接使用）
 * 结构：theme.json / LICENSE / THIRD-PARTY.md / dist / preview.png
 */
const meta = JSON.parse(readFileSync('theme.json', 'utf8'))
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (!/^[\w-]+$/.test(meta.short))
  throw new Error('Invalid theme short name')
for (const key of ['name', 'description', 'version', 'author']) {
  if (typeof meta[key] !== 'string' || !meta[key].trim())
    throw new Error(`Missing theme metadata: ${key}`)
}
if (typeof meta.url !== 'string')
  throw new Error('theme.json url must be a string (may be empty)')
if (meta.version !== pkg.version)
  throw new Error(`theme.json version ${meta.version} does not match package.json version ${pkg.version}`)
if (!existsSync('dist/index.html'))
  throw new Error('Missing dist/index.html; run the build first')
if (!existsSync('preview.png'))
  throw new Error('Missing preview.png')
if (!existsSync('THIRD-PARTY.md'))
  throw new Error('Missing THIRD-PARTY.md')

// 构建新鲜度守卫：dist 不能比源码旧（防止把旧产物打出去）
const distMtime = statSync('dist/index.html').mtimeMs
const watchFiles = ['index.html', 'theme.json', 'vite.config.ts', 'package.json']
for (const file of watchFiles) {
  if (statSync(file).mtimeMs > distMtime)
    throw new Error(`dist/ is stale: ${file} is newer than dist/index.html; run the build first`)
}
const newestSource = (dir) => {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
      newest = Math.max(newest, newestSource(full))
    else
      newest = Math.max(newest, statSync(full).mtimeMs)
  }
  return newest
}
if (newestSource('src') > distMtime)
  throw new Error('dist/ is stale: src/ has files newer than dist/index.html; run the build first')

const staging = `release/${meta.short}`
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
for (const file of ['theme.json', 'LICENSE', 'THIRD-PARTY.md', 'dist'])
  cpSync(file, `${staging}/${file}`, { recursive: true })
cpSync('preview.png', `${staging}/preview.png`)

const archive = 'release/theme.tar.gz'
execFileSync('tar', ['--format=ustar', '-czf', archive, '-C', staging, 'theme.json', 'LICENSE', 'THIRD-PARTY.md', 'dist', 'preview.png'], {
  env: { ...process.env, COPYFILE_DISABLE: '1' },
})

// 版本化副本，方便手动下载归档
const versioned = `release/${pkg.name}-${meta.version}.tar.gz`
cpSync(archive, versioned)
writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${archive.split('/').at(-1)}\n`)

const size = (readFileSync(archive).length / 1024 / 1024).toFixed(2)
console.log(`Theme package: ${archive} (${size} MB)`)
console.log(`Versioned copy: ${versioned}`)
