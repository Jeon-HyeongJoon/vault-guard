import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createConfig, saveConfig, scanDirectory, startWatcher, VaultGuard } from '../src/index.js'

function fixture(files = { 'a.md': '# A\n\n첫 내용\n', 'folder/b.md': '# B\n\n둘째 내용\n' }, { formatText = null, formatExtension = 'yml' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'vault-guard-test-'))
  const root = join(base, 'vault')
  const dataDir = join(base, 'state')
  mkdirSync(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  const formatProfile = formatText ? join(base, `format.${formatExtension}`) : null
  if (formatProfile) writeFileSync(formatProfile, formatText)
  const config = createConfig(root, { name: 'test', dataDir, formatProfile })
  config.settleMs = 5
  config.debounceMs = 5
  config.verifyEveryMs = 50
  const guard = new VaultGuard(config)
  return {
    base,
    root,
    config,
    guard,
    close() {
      guard.close()
      rmSync(base, { recursive: true, force: true })
    },
  }
}

test('정상 변경은 revision으로 기록하고 blob을 중복 저장하지 않는다', async () => {
  const env = fixture()
  try {
    const baseline = await env.guard.run({ stable: false })
    assert.equal(baseline.status, 'baseline')
    writeFileSync(join(env.root, 'a.md'), '# A\n\n첫 내용\n\n정상 추가\n')
    const recorded = await env.guard.run({ stable: false })
    assert.equal(recorded.status, 'recorded')
    assert.equal(env.guard.status().revisions, 2)
    assert.equal(env.guard.status().openIncidents, 0)
    assert.equal(env.guard.status().integrity.ok, true)
    assert.ok(env.guard.status().blobs < 4, '변하지 않은 b.md blob은 재사용해야 한다')
  } finally {
    env.close()
  }
})

test('파일 삭제는 후보 사건으로 남기고 사람이 정상본으로 복구한다', async () => {
  const env = fixture()
  try {
    const baseline = await env.guard.run({ stable: false })
    const original = readFileSync(join(env.root, 'folder/b.md'), 'utf8')
    unlinkSync(join(env.root, 'folder/b.md'))
    const pending = await env.guard.run({ stable: false })
    assert.equal(pending.status, 'pending')
    assert.equal(env.guard.status().active.id, baseline.revision.id)
    assert.equal(env.guard.preview(pending.incident.id).canRestore, true)
    assert.equal(env.guard.diff(pending.incident.id).changes[0].op, 'delete')

    const restored = env.guard.restore(pending.incident.id)
    assert.equal(restored.status, 'restored')
    assert.equal(readFileSync(join(env.root, 'folder/b.md'), 'utf8'), original)
    assert.equal(env.guard.status().openIncidents, 0)
  } finally {
    env.close()
  }
})

test('의도한 삭제 승인 후 과거 revision 롤백도 새 이력으로 기록한다', async () => {
  const env = fixture()
  try {
    const baseline = await env.guard.run({ stable: false })
    unlinkSync(join(env.root, 'folder/b.md'))
    const pending = await env.guard.run({ stable: false })
    const accepted = env.guard.accept(pending.incident.id)
    assert.equal(accepted.status, 'accepted')
    assert.equal(existsSync(join(env.root, 'folder/b.md')), false)

    const rolledBack = env.guard.rollback(baseline.revision.id)
    assert.equal(rolledBack.status, 'rolled-back')
    assert.equal(existsSync(join(env.root, 'folder/b.md')), true)
    assert.equal(rolledBack.revision.parent_id, accepted.revision.id)
    assert.equal(rolledBack.revision.reasons[0].kind, 'manual-rollback')
    assert.equal(env.guard.showRevision(rolledBack.revision.id).changes.some((change) => change.path === 'folder/b.md'), true)
    assert.equal(env.guard.diffRevisions(accepted.revision.id, rolledBack.revision.id).changes[0].op, 'add')
  } finally {
    env.close()
  }
})

test('사건 이후 파일이 달라지면 오래된 restore와 accept를 거부한다', async () => {
  const env = fixture()
  try {
    await env.guard.run({ stable: false })
    unlinkSync(join(env.root, 'folder/b.md'))
    const pending = await env.guard.run({ stable: false })
    writeFileSync(join(env.root, 'a.md'), '# A\n\n사건 이후 새 작업\n')
    assert.equal(env.guard.preview(pending.incident.id).currentMatchesCandidate, false)
    assert.throws(() => env.guard.restore(pending.incident.id), /복구 거부/)
    assert.throws(() => env.guard.accept(pending.incident.id), /승인 거부/)
  } finally {
    env.close()
  }
})

test('원래 manifest로 직접 되돌아오면 대기 사건을 자동 종료한다', async () => {
  const env = fixture()
  try {
    await env.guard.run({ stable: false })
    const path = join(env.root, 'folder/b.md')
    const original = readFileSync(path)
    unlinkSync(path)
    const pending = await env.guard.run({ stable: false })
    assert.equal(pending.status, 'pending')
    writeFileSync(path, original)
    const result = await env.guard.run({ stable: false })
    assert.equal(result.status, 'unchanged')
    assert.equal(result.selfRecovered, 1)
    assert.equal(env.guard.status().openIncidents, 0)
  } finally {
    env.close()
  }
})

test('Syncthing 충돌 파일은 자동 revision이 아니라 사건으로 분리한다', async () => {
  const env = fixture({ 'a.md': '# A\n' })
  try {
    await env.guard.run({ stable: false })
    writeFileSync(join(env.root, 'a.sync-conflict-20261030-123456.md'), '# 충돌\n')
    const result = await env.guard.run({ stable: false })
    assert.equal(result.status, 'pending')
    assert.equal(result.incident.reasons.some((reason) => reason.kind === 'syncthing-conflict'), true)
  } finally {
    env.close()
  }
})

test('실시간 watcher가 파일 변경을 자동 revision으로 기록한다', async () => {
  const env = fixture({ 'a.md': '# A\n' })
  let watcher
  try {
    await env.guard.run({ stable: false })
    const recorded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('watcher 결과 대기 시간 초과')), 1500)
      watcher = startWatcher(env.guard, {
        onResult: (result) => {
          if (result.status !== 'recorded') return
          clearTimeout(timeout)
          resolve(result)
        },
        onError: reject,
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    writeFileSync(join(env.root, 'a.md'), '# A\n\n실시간 변경\n')
    const result = await recorded
    assert.equal(result.status, 'recorded')
    assert.equal(env.guard.status().revisions, 2)
  } finally {
    watcher?.stop()
    env.close()
  }
})

test('prune은 최신 revision과 활성 blob을 남기고 오래된 중복 이력을 정리한다', async () => {
  const env = fixture({ 'a.md': '# A\n' })
  try {
    await env.guard.run({ stable: false })
    for (let i = 1; i <= 4; i++) {
      writeFileSync(join(env.root, 'a.md'), `# A\n\n변경 ${i}\n`)
      await env.guard.run({ stable: false })
    }
    assert.equal(env.guard.status().revisions, 5)
    env.config.retention = { days: 0, maxRevisions: 2, incidentDays: 0 }
    const pruned = env.guard.prune()
    assert.equal(pruned.removedRevisions, 3)
    assert.equal(pruned.revisions, 2)
    assert.equal(env.guard.status().integrity.ok, true)
    assert.equal(readFileSync(join(env.root, 'a.md'), 'utf8'), '# A\n\n변경 4\n')
  } finally {
    env.close()
  }
})

test('포맷 프로필이 없으면 자유 형식 Markdown도 버전 관리만 한다', async () => {
  const env = fixture({ 'free.md': '제목도 규칙도 없는 자유 문서\n' })
  try {
    const baseline = await env.guard.run({ stable: false })
    assert.equal(baseline.status, 'baseline')
    assert.equal(baseline.scan.format.enabled, false)
  } finally {
    env.close()
  }
})

test('선택한 YAML 포맷 규칙 위반은 손상 사건과 정상 복구점을 만든다', async () => {
  const profile = `version: 1
name: title-required
files:
  - match: 'note.md'
    rules:
      - id: title
        pattern: '^# (?<title>.+)$'
        min: 1
        max: 1
        message: '{{file}} 제목 구조가 손상되었습니다'
`
  const env = fixture({ 'note.md': '# 정상 제목\n\n본문\n' }, { formatText: profile })
  try {
    const baseline = await env.guard.run({ stable: false })
    assert.equal(baseline.status, 'baseline')
    writeFileSync(join(env.root, 'note.md'), '제목 표식이 사라짐\n\n본문\n')
    const pending = await env.guard.run({ stable: false })
    assert.equal(pending.status, 'pending')
    assert.equal(pending.incident.reasons.some((reason) => reason.kind === 'format-rule-missing'), true)
    const current = env.guard.inspectCurrent()
    assert.equal(current.damaged, true)
    assert.equal(current.recoveryPoint.id, baseline.revision.id)
    env.guard.restore(pending.incident.id)
    assert.equal(env.guard.inspectCurrent().damaged, false)
  } finally {
    env.close()
  }
})

test('Markdown 프로필의 YAML 블록과 사용자 변수를 구조 규칙에 사용할 수 있다', async () => {
  const profile = `# 내 문서 규칙

\`\`\`yaml
version: 1
name: variable-profile
variables:
  DATE: '\\d{4}-\\d{2}-\\d{2}'
files:
  - match: '*.md'
    rules:
      - id: title
        pattern: '^# (?<title>.+)$'
        min: 1
        max: 1
      - id: updated
        pattern: '^updated: (?<date>{{DATE}})$'
        min: 1
        max: 1
    order: [title, updated]
\`\`\`
`
  const env = fixture({ 'note.md': '# Note\nupdated: 2026-10-30\n' }, { formatText: profile, formatExtension: 'md' })
  try {
    const scan = scanDirectory(env.config)
    assert.equal(scan.format.enabled, true)
    assert.equal(scan.format.issues.length, 0)
    assert.equal(scan.format.captures.find((capture) => capture.rule === 'updated').variables.date, '2026-10-30')
    assert.equal((await env.guard.run({ stable: false })).status, 'baseline')
  } finally {
    env.close()
  }
})

test('에이전트용 check --json은 색상 문구 없이 검증 실패와 종료 코드 2를 반환한다', async () => {
  const profile = `version: 1
files:
  - match: 'note.md'
    rules:
      - id: title
        pattern: '^# .+$'
        min: 1
`
  const env = fixture({ 'note.md': '# 정상\n' }, { formatText: profile })
  try {
    await env.guard.run({ stable: false })
    const configPath = saveConfig(env.config, join(env.config.dataDir, 'config.json'))
    writeFileSync(join(env.root, 'note.md'), '제목 손상\n')
    const cli = join(import.meta.dirname, '..', 'bin', 'vault-guard.js')
    const result = spawnSync(process.execPath, [cli, 'check', '--config', configPath, '--json'], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stderr, '')
    const output = JSON.parse(result.stdout)
    assert.equal(output.damaged, true)
    assert.equal(output.format.issues[0].rule, 'title')
    assert.equal(output.recoveryPoint.id, 1)
  } finally {
    env.close()
  }
})
