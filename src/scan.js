import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { loadFormatProfile, validateFormatting } from './format.js'
import { sha256, sleep } from './util.js'

const utf8 = new TextDecoder('utf-8', { fatal: true })
const slash = (value) => value.split(sep).join('/').normalize('NFC')

function listFiles(config) {
  const files = []
  const errors = []
  let rootStat
  try {
    rootStat = statSync(config.root)
  } catch {
    return { available: false, files, errors: [{ kind: 'folder-unavailable', path: '', detail: config.root }] }
  }
  if (!rootStat.isDirectory()) return { available: false, files, errors: [{ kind: 'folder-unavailable', path: '', detail: config.root }] }

  const excluded = new Set(config.excludeDirectories)
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      const rel = slash(relative(config.root, absolute))
      if (entry.isSymbolicLink()) {
        if (config.extensions.includes(extname(entry.name).toLowerCase())) errors.push({ kind: 'symlink-file', path: rel })
        continue
      }
      if (entry.isDirectory()) {
        if (excluded.has(entry.name) || (config.excludeHiddenDirectories && entry.name.startsWith('.'))) continue
        walk(absolute)
        continue
      }
      if (entry.isFile() && config.extensions.includes(extname(entry.name).toLowerCase())) files.push({ path: rel, absolute })
    }
  }
  walk(config.root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { available: true, files, errors }
}

export function scanDirectory(config, { keepBytes = true, validate = true } = {}) {
  const listed = listFiles(config)
  const result = { available: listed.available, root: config.root, files: [], errors: [...listed.errors], manifest: null, bytes: 0, format: { enabled: false, profile: null, issues: [], captures: [] } }
  if (!listed.available) {
    result.manifest = sha256(JSON.stringify(['unavailable', config.root]))
    return result
  }

  const normalized = new Set()
  const portable = new Map()
  for (const entry of listed.files) {
    if (normalized.has(entry.path)) {
      result.errors.push({ kind: 'duplicate-normalized-path', path: entry.path })
      continue
    }
    normalized.add(entry.path)
    const portablePath = entry.path.toLocaleLowerCase('en-US')
    if (portable.has(portablePath)) {
      result.errors.push({ kind: 'duplicate-portable-path', path: entry.path, detail: portable.get(portablePath) })
      continue
    }
    portable.set(portablePath, entry.path)

    try {
      if (lstatSync(entry.absolute).isSymbolicLink()) {
        result.errors.push({ kind: 'symlink-file', path: entry.path })
        continue
      }
      const stat = statSync(entry.absolute)
      if (stat.size > config.maxFileBytes) {
        result.errors.push({ kind: 'file-too-large', path: entry.path, size: stat.size, limit: config.maxFileBytes })
        result.files.push({ path: entry.path, hash: sha256(`oversize\0${stat.size}\0${stat.mtimeMs}`), size: stat.size, mtime: stat.mtime.toISOString(), bytes: null })
        continue
      }
      const bytes = readFileSync(entry.absolute)
      const hash = sha256(bytes)
      if (validate) {
        try {
          const text = utf8.decode(bytes)
          if (text.includes('\0')) result.errors.push({ kind: 'binary-content', path: entry.path })
        } catch {
          result.errors.push({ kind: 'invalid-utf8', path: entry.path })
        }
        if (/\.sync-conflict-[^/]*\.md$/i.test(entry.path)) result.errors.push({ kind: 'syncthing-conflict', path: entry.path })
      }
      result.files.push({ path: entry.path, hash, size: bytes.length, mtime: stat.mtime.toISOString(), bytes: keepBytes ? bytes : null })
      result.bytes += bytes.length
    } catch (error) {
      result.errors.push({ kind: 'read-failed', path: entry.path, detail: error.message })
    }
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path))
  if (validate && config.format?.profile) {
    result.format = validateFormatting(result.files, loadFormatProfile(config))
    result.errors.push(...result.format.issues.map((issue) => ({ ...issue, source: 'format' })))
  }
  result.manifest = sha256(JSON.stringify(result.files.map((file) => [file.path, file.hash, file.size])))
  return result
}

export async function scanStable(config, { retries = 3 } = {}) {
  let full = scanDirectory(config)
  for (let attempt = 1; attempt <= retries; attempt++) {
    await sleep(config.settleMs)
    const fingerprint = scanDirectory(config, { keepBytes: false, validate: false })
    if (full.manifest === fingerprint.manifest && full.available === fingerprint.available) {
      return { ...full, stable: true, attempts: attempt + 1 }
    }
    full = scanDirectory(config)
  }
  full.errors.push({ kind: 'folder-changing', path: '', detail: '안정화 시간 동안 내용이 계속 바뀌었습니다' })
  return { ...full, stable: false, attempts: retries + 1 }
}
