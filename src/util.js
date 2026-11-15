import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
export const nowIso = () => new Date().toISOString()
export const json = (value) => JSON.stringify(value ?? null)
export const parseJson = (value, fallback = null) => {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function slug(value) {
  const cleaned = String(value || 'vault')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'vault'
}

export function inside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}

export function safeTarget(root, relPath) {
  const target = resolve(root, relPath)
  if (!inside(root, target)) throw new Error(`폴더 밖 경로는 사용할 수 없습니다: ${relPath}`)
  return target
}

export function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.vault-guard-${process.pid}-${randomUUID()}.tmp`
  writeFileSync(temporary, bytes, { mode: 0o600 })
  renameSync(temporary, path)
}

export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

export function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}
