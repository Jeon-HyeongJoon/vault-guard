import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'
import { json, nowIso, parseJson, sha256 } from './util.js'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS guard_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS guard_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,
    manifest TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    file_count INTEGER NOT NULL,
    byte_count INTEGER NOT NULL,
    change_count INTEGER NOT NULL DEFAULT 0,
    reasons TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS guard_blobs (
    hash TEXT PRIMARY KEY,
    codec TEXT NOT NULL,
    raw_size INTEGER NOT NULL,
    compressed_size INTEGER NOT NULL,
    content BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS guard_revision_files (
    revision_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime TEXT,
    blob_hash TEXT,
    PRIMARY KEY (revision_id, path),
    FOREIGN KEY (revision_id) REFERENCES guard_revisions(id) ON DELETE CASCADE,
    FOREIGN KEY (blob_hash) REFERENCES guard_blobs(hash)
  );
  CREATE TABLE IF NOT EXISTS guard_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    resolved_at TEXT,
    active_revision_id INTEGER,
    candidate_revision_id INTEGER NOT NULL,
    manifest TEXT NOT NULL,
    reasons TEXT NOT NULL,
    resolution TEXT,
    actor TEXT,
    FOREIGN KEY (active_revision_id) REFERENCES guard_revisions(id),
    FOREIGN KEY (candidate_revision_id) REFERENCES guard_revisions(id)
  );
  CREATE INDEX IF NOT EXISTS guard_revisions_created ON guard_revisions(created_at DESC);
  CREATE INDEX IF NOT EXISTS guard_revision_files_path ON guard_revision_files(path, revision_id DESC);
  CREATE INDEX IF NOT EXISTS guard_incidents_status ON guard_incidents(status, id DESC);
`

export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  chmodSync(path, 0o600)
  db.exec('PRAGMA auto_vacuum = INCREMENTAL')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)

  const q = {
    metaGet: db.prepare('SELECT value FROM guard_meta WHERE key = ?'),
    metaSet: db.prepare('INSERT INTO guard_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    revision: db.prepare('SELECT * FROM guard_revisions WHERE id = ?'),
    revisionByManifest: db.prepare('SELECT * FROM guard_revisions WHERE manifest = ? ORDER BY id DESC LIMIT 1'),
    insertRevision: db.prepare(`INSERT INTO guard_revisions
      (parent_id, manifest, kind, created_at, file_count, byte_count, change_count, reasons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    updateKind: db.prepare('UPDATE guard_revisions SET kind = ? WHERE id = ?'),
    files: db.prepare('SELECT path, hash, size, mtime, blob_hash FROM guard_revision_files WHERE revision_id = ? ORDER BY path'),
    insertFile: db.prepare(`INSERT INTO guard_revision_files(revision_id, path, hash, size, mtime, blob_hash)
      VALUES (?, ?, ?, ?, ?, ?)`),
    blobExists: db.prepare('SELECT 1 AS found FROM guard_blobs WHERE hash = ?'),
    insertBlob: db.prepare(`INSERT OR IGNORE INTO guard_blobs(hash, codec, raw_size, compressed_size, content, created_at)
      VALUES (?, 'br', ?, ?, ?, ?)`),
    blob: db.prepare('SELECT * FROM guard_blobs WHERE hash = ?'),
    openByManifest: db.prepare("SELECT * FROM guard_incidents WHERE status = 'open' AND manifest = ? ORDER BY id DESC LIMIT 1"),
    incident: db.prepare('SELECT * FROM guard_incidents WHERE id = ?'),
    insertIncident: db.prepare(`INSERT INTO guard_incidents
      (status, detected_at, active_revision_id, candidate_revision_id, manifest, reasons)
      VALUES ('open', ?, ?, ?, ?, ?)`),
    resolveIncident: db.prepare(`UPDATE guard_incidents SET status = ?, resolved_at = ?, resolution = ?, actor = ?
      WHERE id = ? AND status = 'open'`),
  }

  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  const activeRevisionId = () => Number(q.metaGet.get('active_revision')?.value || 0) || null
  const revision = (id) => {
    const row = id ? q.revision.get(id) : null
    return row ? { ...row, reasons: parseJson(row.reasons, []) } : null
  }
  const activeRevision = () => revision(activeRevisionId())
  const filesForRevision = (id) => id ? q.files.all(id) : []

  function blobBytes(hash) {
    if (!hash) return null
    const row = q.blob.get(hash)
    if (!row) return null
    const bytes = row.codec === 'br' ? brotliDecompressSync(row.content) : null
    if (!bytes || sha256(bytes) !== hash) throw new Error(`blob 무결성 오류: ${hash}`)
    return bytes
  }

  function createRevision(scan, { kind, parentId = activeRevisionId(), changes = [], reasons = [] } = {}) {
    if (!scan.manifest) throw new Error('manifest가 없습니다')
    const at = nowIso()
    return transaction(() => {
      const revisionId = Number(q.insertRevision.run(
        parentId,
        scan.manifest,
        kind,
        at,
        scan.files.length,
        scan.files.reduce((sum, file) => sum + file.size, 0),
        changes.length,
        json(reasons),
      ).lastInsertRowid)
      for (const file of scan.files) {
        let blobHash = null
        if (file.bytes) {
          blobHash = file.hash
          if (!q.blobExists.get(file.hash)) {
            const compressed = brotliCompressSync(file.bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
            q.insertBlob.run(file.hash, file.bytes.length, compressed.length, compressed, at)
          }
        }
        q.insertFile.run(revisionId, file.path, file.hash, file.size, file.mtime, blobHash)
      }
      if (kind === 'active') {
        if (parentId) q.updateKind.run('history', parentId)
        q.metaSet.run('active_revision', String(revisionId))
      }
      return revision(revisionId)
    })
  }

  function setActive(id) {
    const row = revision(id)
    if (!row) throw new Error(`revision을 찾을 수 없습니다: ${id}`)
    transaction(() => {
      q.updateKind.run('history', activeRevisionId())
      q.updateKind.run('active', id)
      q.metaSet.run('active_revision', String(id))
    })
    return revision(id)
  }

  const incidentFromRow = (row) => row ? { ...row, reasons: parseJson(row.reasons, []) } : null
  const incident = (id) => incidentFromRow(q.incident.get(id))
  const openIncidentByManifest = (manifest) => incidentFromRow(q.openByManifest.get(manifest))

  function createIncident({ activeRevisionId: activeId, candidateRevisionId, manifest, reasons }) {
    const existing = openIncidentByManifest(manifest)
    if (existing) return { incident: existing, created: false }
    const id = Number(q.insertIncident.run(nowIso(), activeId, candidateRevisionId, manifest, json(reasons)).lastInsertRowid)
    return { incident: incident(id), created: true }
  }

  function resolveIncident(id, { status, resolution = status, actor = 'local-user' } = {}) {
    q.resolveIncident.run(status, nowIso(), resolution, actor, id)
    return incident(id)
  }

  function supersedeOpenIncidents(exceptId, actor = 'vault-guard') {
    const rows = db.prepare("SELECT id FROM guard_incidents WHERE status = 'open' AND id != ?").all(exceptId)
    for (const row of rows) resolveIncident(row.id, { status: 'superseded', resolution: 'newer-decision', actor })
    return rows.length
  }

  const openIncidents = () => db.prepare("SELECT * FROM guard_incidents WHERE status = 'open' ORDER BY id DESC")
    .all().map(incidentFromRow)
  const incidents = (limit = 50) => db.prepare('SELECT * FROM guard_incidents ORDER BY id DESC LIMIT ?')
    .all(limit).map(incidentFromRow)

  function history({ limit = 50, path = null } = {}) {
    if (!path) return db.prepare('SELECT * FROM guard_revisions ORDER BY id DESC LIMIT ?').all(limit).map((row) => ({ ...row, reasons: parseJson(row.reasons, []) }))
    return db.prepare(`SELECT r.* FROM guard_revisions r JOIN guard_revision_files f ON f.revision_id = r.id
      WHERE f.path = ? ORDER BY r.id DESC LIMIT ?`).all(path.normalize('NFC'), limit).map((row) => ({ ...row, reasons: parseJson(row.reasons, []) }))
  }

  function stats() {
    const one = (sql) => Number(db.prepare(sql).get().n)
    const active = activeRevision()
    const rawBytes = one('SELECT coalesce(sum(raw_size), 0) AS n FROM guard_blobs')
    const compressedBytes = one('SELECT coalesce(sum(compressed_size), 0) AS n FROM guard_blobs')
    return {
      active,
      revisions: one('SELECT count(*) AS n FROM guard_revisions'),
      blobs: one('SELECT count(*) AS n FROM guard_blobs'),
      rawBytes,
      compressedBytes,
      openIncidents: one("SELECT count(*) AS n FROM guard_incidents WHERE status = 'open'"),
      databaseBytes: existsSync(path) ? statSync(path).size : 0,
    }
  }

  function integrity() {
    const active = activeRevision()
    const missing = []
    const corrupt = []
    for (const file of filesForRevision(active?.id)) {
      if (!file.blob_hash) {
        missing.push(file.path)
        continue
      }
      try {
        const bytes = blobBytes(file.blob_hash)
        if (!bytes || bytes.length !== file.size) corrupt.push(file.path)
      } catch {
        corrupt.push(file.path)
      }
    }
    return { ok: missing.length === 0 && corrupt.length === 0, missing, corrupt }
  }

  function prune({ days = 30, maxRevisions = 100, incidentDays = 180 } = {}) {
    const now = Date.now()
    const revisionCutoff = now - days * 86_400_000
    const incidentCutoff = new Date(now - incidentDays * 86_400_000).toISOString()
    db.prepare("DELETE FROM guard_incidents WHERE status != 'open' AND resolved_at < ?").run(incidentCutoff)
    const protectedIds = new Set([activeRevisionId()].filter(Boolean))
    for (const row of db.prepare("SELECT active_revision_id, candidate_revision_id FROM guard_incidents WHERE status = 'open' OR resolved_at >= ?").all(incidentCutoff)) {
      if (row.active_revision_id) protectedIds.add(row.active_revision_id)
      if (row.candidate_revision_id) protectedIds.add(row.candidate_revision_id)
    }
    const rows = db.prepare('SELECT id, created_at FROM guard_revisions ORDER BY id DESC').all()
    rows.slice(0, maxRevisions).forEach((row) => protectedIds.add(row.id))
    rows.filter((row) => Date.parse(row.created_at) >= revisionCutoff).forEach((row) => protectedIds.add(row.id))
    const removed = rows.filter((row) => !protectedIds.has(row.id))
    transaction(() => {
      const remove = db.prepare('DELETE FROM guard_revisions WHERE id = ?')
      removed.forEach((row) => remove.run(row.id))
      db.prepare('DELETE FROM guard_blobs WHERE NOT EXISTS (SELECT 1 FROM guard_revision_files f WHERE f.blob_hash = guard_blobs.hash)').run()
    })
    if (Number(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum) === 2) db.exec('PRAGMA incremental_vacuum(256)')
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { removedRevisions: removed.length, ...stats() }
  }

  return {
    db,
    close: () => db.close(),
    activeRevision,
    activeRevisionId,
    revision,
    revisionByManifest: (manifest) => revision(q.revisionByManifest.get(manifest)?.id),
    filesForRevision,
    blobBytes,
    createRevision,
    setActive,
    incident,
    createIncident,
    resolveIncident,
    supersedeOpenIncidents,
    openIncidents,
    incidents,
    history,
    stats,
    integrity,
    prune,
  }
}
