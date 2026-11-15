import { mkdirSync, unlinkSync } from 'node:fs'
import { assessRisk, diffFiles } from './policy.js'
import { scanDirectory, scanStable } from './scan.js'
import { openStore } from './store.js'
import { atomicWrite, safeTarget, sha256 } from './util.js'

function publicScan(scan) {
  return {
    available: scan.available,
    manifest: scan.manifest,
    files: scan.files.length,
    bytes: scan.bytes,
    errors: scan.errors,
    format: {
      enabled: Boolean(scan.format?.enabled),
      profile: scan.format?.profile ?? null,
      issues: scan.format?.issues ?? [],
    },
    stable: scan.stable ?? null,
    attempts: scan.attempts ?? 1,
  }
}

function textBlock(beforeBytes, afterBytes, limit = 80) {
  if (!beforeBytes && !afterBytes) return null
  const before = beforeBytes ? beforeBytes.toString('utf8').split('\n') : []
  const after = afterBytes ? afterBytes.toString('utf8').split('\n') : []
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++
  const removed = before.slice(prefix, before.length - suffix)
  const added = after.slice(prefix, after.length - suffix)
  const clipped = removed.length + added.length > limit
  return {
    startLine: prefix + 1,
    removed: removed.slice(0, Math.ceil(limit / 2)),
    added: added.slice(0, Math.ceil(limit / 2)),
    clipped,
  }
}

export class VaultGuard {
  constructor(config, { store = openStore(config.database), assess = assessRisk } = {}) {
    this.config = config
    this.store = store
    this.assess = assess
  }

  close() {
    this.store.close()
  }

  async run({ stable = true } = {}) {
    const scan = stable ? await scanStable(this.config) : scanDirectory(this.config)
    const active = this.store.activeRevision()
    const previous = this.store.filesForRevision(active?.id)
    const assessment = this.assess(previous, scan, this.config.policy)

    if (active?.manifest === scan.manifest) {
      if (assessment.reasons.length) {
        return {
          status: 'invalid',
          scan: publicScan(scan),
          reasons: assessment.reasons,
          activeRevision: active.id,
          recoveryPoint: null,
        }
      }
      const recovered = []
      for (const incident of this.store.openIncidents()) {
        recovered.push(this.store.resolveIncident(incident.id, {
          status: 'self-recovered',
          resolution: 'current-manifest-matches-active',
          actor: 'vault-guard',
        }))
      }
      return { status: 'unchanged', scan: publicScan(scan), activeRevision: active.id, selfRecovered: recovered.length }
    }

    if (!active && !scan.errors.length) {
      const revision = this.store.createRevision(scan, { kind: 'active', parentId: null, changes: assessment.changes })
      return { status: 'baseline', scan: publicScan(scan), revision, changes: assessment.changes }
    }

    if (assessment.reasons.length) {
      const existing = this.store.openIncidents().find((incident) => incident.manifest === scan.manifest)
      if (existing) return { status: 'pending', scan: publicScan(scan), incident: existing, created: false, changes: assessment.changes, recoveryPoint: active }
      const candidate = this.store.createRevision(scan, {
        kind: 'candidate',
        parentId: active?.id ?? null,
        changes: assessment.changes,
        reasons: assessment.reasons,
      })
      const incident = this.store.createIncident({
        activeRevisionId: active?.id ?? null,
        candidateRevisionId: candidate.id,
        manifest: scan.manifest,
        reasons: assessment.reasons,
      })
      return { status: 'pending', scan: publicScan(scan), candidateRevision: candidate.id, ...incident, changes: assessment.changes, recoveryPoint: active }
    }

    const revision = this.store.createRevision(scan, { kind: 'active', changes: assessment.changes })
    const superseded = this.store.supersedeOpenIncidents(0)
    return { status: 'recorded', scan: publicScan(scan), revision, changes: assessment.changes, superseded }
  }

  status() {
    return {
      root: this.config.root,
      database: this.config.database,
      ...this.store.stats(),
      integrity: this.store.integrity(),
      incidents: this.store.openIncidents(),
    }
  }

  inspectCurrent() {
    const scan = scanDirectory(this.config)
    const active = this.store.activeRevision()
    const assessment = this.assess(this.store.filesForRevision(active?.id), scan, this.config.policy)
    const changed = active?.manifest !== scan.manifest
    return {
      damaged: assessment.reasons.length > 0,
      changed,
      currentManifest: scan.manifest,
      activeManifest: active?.manifest ?? null,
      reasons: assessment.reasons,
      recoveryPoint: active && changed ? { id: active.id, createdAt: active.created_at, manifest: active.manifest } : null,
      format: {
        enabled: Boolean(scan.format?.enabled),
        profile: scan.format?.profile ?? null,
        issues: scan.format?.issues ?? [],
      },
    }
  }

  preview(id) {
    const incident = this.store.incident(Number(id))
    if (!incident) throw new Error(`사건을 찾을 수 없습니다: ${id}`)
    const active = this.store.activeRevision()
    const candidate = this.store.revision(incident.candidate_revision_id)
    const current = scanDirectory(this.config, { keepBytes: false, validate: false })
    const activeFiles = this.store.filesForRevision(incident.active_revision_id)
    const candidateFiles = this.store.filesForRevision(incident.candidate_revision_id)
    const activeRecoverable = activeFiles.every((file) => Boolean(file.blob_hash))
    const candidateRecoverable = candidateFiles.every((file) => Boolean(file.blob_hash))
    return {
      incident,
      active,
      candidate,
      currentManifest: current.manifest,
      currentMatchesCandidate: current.manifest === candidate?.manifest,
      headMatchesIncident: active?.id === incident.active_revision_id,
      activeRecoverable,
      candidateRecoverable,
      canRestore: incident.status === 'open' && current.manifest === candidate?.manifest && active?.id === incident.active_revision_id && activeRecoverable,
      canAccept: incident.status === 'open' && current.manifest === candidate?.manifest && active?.id === incident.active_revision_id && candidateRecoverable,
      changes: diffFiles(activeFiles, candidateFiles),
    }
  }

  diff(id, { lineLimit = 80 } = {}) {
    const preview = this.preview(id)
    const detailed = preview.changes.map((change) => {
      const before = change.before?.blob_hash ? this.store.blobBytes(change.before.blob_hash) : null
      const after = change.after?.blob_hash ? this.store.blobBytes(change.after.blob_hash) : null
      return {
        op: change.op,
        path: change.path,
        before: change.before ? { hash: change.before.hash, size: change.before.size } : null,
        after: change.after ? { hash: change.after.hash, size: change.after.size } : null,
        text: textBlock(before, after, lineLimit),
      }
    })
    return { ...preview, changes: detailed }
  }

  showRevision(id, { lineLimit = 80 } = {}) {
    const revision = this.store.revision(Number(id))
    if (!revision) throw new Error(`revision을 찾을 수 없습니다: ${id}`)
    const parent = this.store.revision(revision.parent_id)
    const beforeFiles = this.store.filesForRevision(parent?.id)
    const afterFiles = this.store.filesForRevision(revision.id)
    const changes = diffFiles(beforeFiles, afterFiles).map((change) => {
      const before = change.before?.blob_hash ? this.store.blobBytes(change.before.blob_hash) : null
      const after = change.after?.blob_hash ? this.store.blobBytes(change.after.blob_hash) : null
      return {
        op: change.op,
        path: change.path,
        before: change.before ? { hash: change.before.hash, size: change.before.size } : null,
        after: change.after ? { hash: change.after.hash, size: change.after.size } : null,
        text: textBlock(before, after, lineLimit),
      }
    })
    return { revision, parent, changes }
  }

  diffRevisions(fromId, toId = null, { lineLimit = 80 } = {}) {
    const from = this.store.revision(Number(fromId))
    const to = toId == null ? this.store.activeRevision() : this.store.revision(Number(toId))
    if (!from) throw new Error(`시작 revision을 찾을 수 없습니다: ${fromId}`)
    if (!to) throw new Error(`대상 revision을 찾을 수 없습니다: ${toId ?? 'active'}`)
    const changes = diffFiles(this.store.filesForRevision(from.id), this.store.filesForRevision(to.id)).map((change) => {
      const before = change.before?.blob_hash ? this.store.blobBytes(change.before.blob_hash) : null
      const after = change.after?.blob_hash ? this.store.blobBytes(change.after.blob_hash) : null
      return {
        op: change.op,
        path: change.path,
        before: change.before ? { hash: change.before.hash, size: change.before.size } : null,
        after: change.after ? { hash: change.after.hash, size: change.after.size } : null,
        text: textBlock(before, after, lineLimit),
      }
    })
    return { from, to, changes }
  }

  rollbackPreview(id) {
    const target = this.store.revision(Number(id))
    if (!target) throw new Error(`revision을 찾을 수 없습니다: ${id}`)
    const active = this.store.activeRevision()
    if (!active) throw new Error('활성 revision이 없습니다')
    const current = scanDirectory(this.config, { keepBytes: false, validate: false })
    const targetFiles = this.store.filesForRevision(target.id)
    const recoverable = targetFiles.every((file) => Boolean(file.blob_hash))
    return {
      target,
      active,
      currentManifest: current.manifest,
      currentMatchesHead: current.manifest === active.manifest,
      recoverable,
      canRollback: current.manifest === active.manifest && recoverable,
      changes: diffFiles(this.store.filesForRevision(active.id), targetFiles),
    }
  }

  writeRevisionToFolder(revisionId) {
    const target = this.store.revision(revisionId)
    if (!target) throw new Error(`revision을 찾을 수 없습니다: ${revisionId}`)
    const desired = new Map()
    for (const file of this.store.filesForRevision(revisionId)) {
      const bytes = this.store.blobBytes(file.blob_hash)
      if (!bytes || sha256(bytes) !== file.hash) throw new Error(`복구 원문 무결성 오류: ${file.path}`)
      desired.set(file.path, bytes)
    }
    const current = scanDirectory(this.config)
    mkdirSync(this.config.root, { recursive: true })
    for (const [path, bytes] of desired) atomicWrite(safeTarget(this.config.root, path), bytes)
    for (const file of current.files) if (!desired.has(file.path)) unlinkSync(safeTarget(this.config.root, file.path))
    const verified = scanDirectory(this.config)
    if (verified.manifest !== target.manifest) throw new Error('파일 반영 후 manifest 검증에 실패했습니다')
    return verified
  }

  restore(id, { actor = 'local-user' } = {}) {
    const preview = this.preview(id)
    if (!preview.canRestore) {
      throw new Error('복구 거부: 현재 폴더 또는 활성 revision이 사건 시점과 다릅니다. 최신 사건을 다시 확인하세요')
    }
    const verified = this.writeRevisionToFolder(preview.incident.active_revision_id)
    const incident = this.store.resolveIncident(preview.incident.id, { status: 'restored', resolution: 'restore-active', actor })
    const superseded = this.store.supersedeOpenIncidents(preview.incident.id, actor)
    return { status: 'restored', incident, revision: preview.active.id, manifest: verified.manifest, superseded }
  }

  rollback(id, { actor = 'local-user' } = {}) {
    const preview = this.rollbackPreview(id)
    if (!preview.canRollback) {
      throw new Error('롤백 거부: 현재 폴더가 최신 활성 revision과 다르거나 대상 원문이 없습니다')
    }
    if (preview.target.id === preview.active.id) return { status: 'unchanged', revision: preview.active }
    const scan = this.writeRevisionToFolder(preview.target.id)
    const revision = this.store.createRevision(scan, {
      kind: 'active',
      parentId: preview.active.id,
      changes: preview.changes,
      reasons: [{ kind: 'manual-rollback', targetRevision: preview.target.id, actor }],
    })
    const superseded = this.store.supersedeOpenIncidents(0, actor)
    return {
      status: 'rolled-back',
      fromRevision: preview.active.id,
      targetRevision: preview.target.id,
      revision,
      superseded,
    }
  }

  accept(id, { actor = 'local-user' } = {}) {
    const preview = this.preview(id)
    if (!preview.canAccept) {
      throw new Error('승인 거부: 현재 폴더 또는 활성 revision이 사건 시점과 다르거나 후보 원문을 보관하지 못했습니다')
    }
    const revision = this.store.setActive(preview.candidate.id)
    const incident = this.store.resolveIncident(preview.incident.id, { status: 'accepted', resolution: 'accept-candidate', actor })
    const superseded = this.store.supersedeOpenIncidents(preview.incident.id, actor)
    return { status: 'accepted', incident, revision, superseded }
  }

  history(options) {
    return this.store.history(options)
  }

  prune() {
    return this.store.prune(this.config.retention)
  }
}

export const engineInternals = { textBlock }
