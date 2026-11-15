import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { atomicWrite, inside, slug } from './util.js'

export const CONFIG_VERSION = 1

export function defaultDataHome() {
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Vault Guard')
    : join(homedir(), '.local', 'share', 'vault-guard')
}

export function createConfig(root, { name, dataDir, formatProfile = null } = {}) {
  const absoluteRoot = resolve(root)
  const id = slug(name || basename(absoluteRoot))
  const absoluteData = resolve(dataDir || join(defaultDataHome(), id))
  return validateConfig({
    version: CONFIG_VERSION,
    name: name || basename(absoluteRoot),
    root: absoluteRoot,
    dataDir: absoluteData,
    database: join(absoluteData, 'vault-guard.db'),
    extensions: ['.md'],
    excludeDirectories: ['.git', '.obsidian', '.stversions', '이관-백업'],
    excludeHiddenDirectories: true,
    maxFileBytes: 5 * 1024 * 1024,
    debounceMs: 300,
    settleMs: 300,
    verifyEveryMs: 60_000,
    format: formatProfile ? { profile: resolve(formatProfile) } : null,
    policy: {
      protectDeletes: true,
      protectEmptyFiles: true,
      minShrinkBytes: 128,
      minSizeRatio: 0.5,
      massChangeCount: 10,
      massChangeRatio: 0.5,
    },
    retention: {
      days: 30,
      maxRevisions: 100,
      incidentDays: 180,
    },
  })
}

export function validateConfig(input, { baseDir = process.cwd() } = {}) {
  const config = structuredClone(input)
  if (config.version !== CONFIG_VERSION) throw new Error(`지원하지 않는 config 버전: ${config.version}`)
  config.root = resolve(config.root)
  config.dataDir = resolve(config.dataDir)
  config.database = resolve(config.database || join(config.dataDir, 'vault-guard.db'))
  if (inside(config.root, config.dataDir)) {
    throw new Error('상태 DB는 Syncthing 동기화 폴더 밖에 두어야 합니다')
  }
  if (!Array.isArray(config.extensions) || !config.extensions.length) throw new Error('extensions가 비어 있습니다')
  config.extensions = config.extensions.map((x) => String(x).toLowerCase())
  config.excludeDirectories ??= []
  config.excludeHiddenDirectories ??= true
  config.maxFileBytes ??= 5 * 1024 * 1024
  config.debounceMs ??= 300
  config.settleMs ??= 300
  config.verifyEveryMs ??= 60_000
  if (typeof config.format === 'string') config.format = { profile: config.format }
  if (config.format?.profile) config.format.profile = resolve(baseDir, config.format.profile)
  else config.format = null
  config.policy = {
    protectDeletes: true,
    protectEmptyFiles: true,
    minShrinkBytes: 128,
    minSizeRatio: 0.5,
    massChangeCount: 10,
    massChangeRatio: 0.5,
    ...(config.policy || {}),
  }
  config.retention = { days: 30, maxRevisions: 100, incidentDays: 180, ...(config.retention || {}) }
  return config
}

export function saveConfig(config, path = join(config.dataDir, 'config.json'), { overwrite = false } = {}) {
  if (existsSync(path) && !overwrite) throw new Error(`config가 이미 있습니다: ${path}`)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  atomicWrite(path, Buffer.from(`${JSON.stringify(config, null, 2)}\n`))
  return path
}

export function loadConfig(path) {
  const absolute = resolve(path)
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`config를 찾을 수 없습니다: ${absolute}`)
  return validateConfig(JSON.parse(readFileSync(absolute, 'utf8')), { baseDir: dirname(absolute) })
}

export function discoverConfig(start = process.cwd()) {
  const home = defaultDataHome()
  if (!existsSync(home)) throw new Error('등록된 Vault Guard config가 없습니다. --config를 지정하세요')
  const candidates = []
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(home, entry.name, 'config.json')
    if (!existsSync(path)) continue
    try {
      const config = loadConfig(path)
      if (inside(config.root, start)) candidates.push({ path, config })
    } catch {
      // 다른 Vault의 깨진 config는 현재 폴더 자동 탐색을 방해하지 않는다.
    }
  }
  candidates.sort((a, b) => b.config.root.length - a.config.root.length)
  if (!candidates.length) throw new Error('현재 폴더에 연결된 config가 없습니다. --config를 지정하세요')
  return candidates[0]
}
