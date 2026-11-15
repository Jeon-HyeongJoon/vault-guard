#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createConfig, discoverConfig, loadConfig, saveConfig, VaultGuard, startWatcher } from '../src/index.js'
import { humanBytes, inside } from '../src/util.js'

const HELP = `Vault Guard — Syncthing Markdown 버전 보호기

사용법
  vault-guard init <folder> [--name NAME] [--data DIR] [--format PROFILE] [--force]
  vault-guard scan     --config CONFIG
  vault-guard watch    --config CONFIG
  vault-guard check    [--config CONFIG] [--json]
  vault-guard validate [--config CONFIG] [--json]
  vault-guard status   --config CONFIG
  vault-guard log      --config CONFIG [--file PATH] [--limit 50]
  vault-guard show <revision-id>     --config CONFIG
  vault-guard diff <from-revision> [to-revision] --config CONFIG
  vault-guard incident <incident-id> --config CONFIG
  vault-guard rollback <revision-id> --config CONFIG --yes
  vault-guard restore <incident-id> --config CONFIG --yes
  vault-guard accept <incident-id>  --config CONFIG --yes
  vault-guard prune    --config CONFIG
  vault-guard doctor   --config CONFIG

restore와 accept는 현재 폴더가 사건 발생 직후 상태와 같을 때만 실행됩니다.
`

function parse(argv) {
  const positionals = []
  const options = {}
  const booleans = new Set(['yes', 'force', 'json'])
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (!value.startsWith('--')) {
      positionals.push(value)
      continue
    }
    const key = value.slice(2)
    if (booleans.has(key)) options[key] = true
    else {
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`값이 필요한 옵션입니다: --${key}`)
      options[key] = argv[++i]
    }
  }
  return { positionals, options }
}

function output(value, { json = false } = {}) {
  if (json || typeof value !== 'string') console.log(JSON.stringify(value, null, 2))
  else console.log(value)
}

function damageAlert(value, options = {}) {
  const damaged = value?.damaged || value?.status === 'pending' || value?.status === 'invalid'
  if (!damaged) return false
  const reasons = value.reasons || value.incident?.reasons || []
  const summary = reasons.slice(0, 3).map((reason) => {
    const detail = reason.message || reason.kind
    return reason.path && !detail.includes(reason.path) ? `${reason.path}: ${detail}` : detail
  }).join(' · ')
  const point = value.recoveryPoint
    ? `복구 포인트 r${value.recoveryPoint.id} (${value.recoveryPoint.createdAt || value.recoveryPoint.created_at})`
    : '현재 포맷과 호환되는 복구 포인트를 확인할 수 없음'
  const message = `현재 손상이 감지됨 — ${summary || '구조 검증 실패'} — ${point}`
  if (options.json) return true
  console.error(process.env.NO_COLOR ? message : `\x1b[1;31m${message}\x1b[0m`)
  return true
}

function requireConfig(options) {
  if (options.config) return loadConfig(options.config)
  return discoverConfig().config
}

function requireDecision(options, command) {
  if (!options.yes) throw new Error(`${command}은 파일 상태를 바꿉니다. diff 확인 후 --yes를 붙이세요`)
}

function doctor(config, guard, current) {
  const marker = join(config.root, '.stfolder')
  return {
    ok: existsSync(config.root)
      && statSync(config.root).isDirectory()
      && !inside(config.root, config.dataDir)
      && guard.store.integrity().ok
      && !current.damaged,
    root: { path: config.root, available: existsSync(config.root) },
    stateOutsideSyncFolder: !inside(config.root, config.dataDir),
    syncthingMarker: existsSync(marker),
    database: { path: config.database, integrity: guard.store.integrity() },
    current,
    note: existsSync(marker)
      ? 'Syncthing 폴더 표식을 확인했습니다.'
      : '.stfolder 표식이 없습니다. Syncthing 폴더가 아니어도 Vault Guard는 동작합니다.',
  }
}

async function main() {
  const { positionals, options } = parse(process.argv.slice(2))
  const command = positionals[0]
  if (!command || command === 'help' || options.help) {
    console.log(HELP)
    return
  }

  if (command === 'init') {
    const folder = positionals[1]
    if (!folder) throw new Error('보호할 폴더를 지정하세요')
    const root = resolve(folder)
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`폴더가 없습니다: ${root}`)
    const config = createConfig(root, { name: options.name, dataDir: options.data, formatProfile: options.format })
    const configPath = saveConfig(config, join(config.dataDir, 'config.json'), { overwrite: Boolean(options.force) })
    const guard = new VaultGuard(config)
    try {
      const baseline = await guard.run({ stable: false })
      damageAlert(baseline, options)
      output({ config: configPath, baseline, next: `node ${resolve(process.argv[1])} watch --config ${JSON.stringify(configPath)}` }, options)
      if (baseline.status === 'pending') process.exitCode = 2
    } finally {
      guard.close()
    }
    return
  }

  const config = requireConfig(options)
  const guard = new VaultGuard(config)
  const accessCheck = command === 'scan' ? null : guard.inspectCurrent()
  if (accessCheck) damageAlert(accessCheck, options)
  if (command === 'watch') {
    const watcher = startWatcher(guard, {
      onResult: (result) => {
        damageAlert(result)
        console.log(JSON.stringify({ at: new Date().toISOString(), ...result }))
      },
      onError: (error) => console.error(JSON.stringify({ at: new Date().toISOString(), status: 'error', error: error.message })),
    })
    const shutdown = () => {
      watcher.stop()
      guard.close()
      process.exit(0)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    await new Promise(() => {})
    return
  }

  try {
    switch (command) {
      case 'scan':
      {
        const result = await guard.run({ stable: true })
        damageAlert(result, options)
        output(result, options)
        if (result.status === 'pending' || result.status === 'invalid') process.exitCode = 2
        break
      }
      case 'check':
      case 'validate':
        output(accessCheck, options)
        if (accessCheck.damaged) process.exitCode = 2
        break
      case 'status': {
        const status = guard.status()
        output({
          ...status,
          current: accessCheck,
          storage: {
            database: humanBytes(status.databaseBytes),
            rawBlobs: humanBytes(status.rawBytes),
            compressedBlobs: humanBytes(status.compressedBytes),
          },
        }, options)
        if (accessCheck.damaged) process.exitCode = 2
        break
      }
      case 'log':
      case 'logs':
      case 'history':
        output(guard.history({ limit: Number(options.limit || 50), path: options.file || null }), options)
        break
      case 'show':
        if (!positionals[1]) throw new Error('revision ID가 필요합니다')
        output(guard.showRevision(Number(positionals[1])), options)
        break
      case 'diff':
        if (!positionals[1]) throw new Error('시작 revision ID가 필요합니다')
        output(guard.diffRevisions(Number(positionals[1]), positionals[2] ? Number(positionals[2]) : null), options)
        break
      case 'incident':
        if (!positionals[1]) throw new Error('사건 ID가 필요합니다')
        output(guard.diff(Number(positionals[1])), options)
        break
      case 'restore':
        if (!positionals[1]) throw new Error('사건 ID가 필요합니다')
        requireDecision(options, 'restore')
        output(guard.restore(Number(positionals[1])), options)
        break
      case 'rollback':
        if (!positionals[1]) throw new Error('revision ID가 필요합니다')
        requireDecision(options, 'rollback')
        output(guard.rollback(Number(positionals[1])), options)
        break
      case 'accept':
        if (!positionals[1]) throw new Error('사건 ID가 필요합니다')
        requireDecision(options, 'accept')
        output(guard.accept(Number(positionals[1])), options)
        break
      case 'prune':
        output(guard.prune(), options)
        break
      case 'doctor':
        output(doctor(config, guard, accessCheck), options)
        break
      default:
        throw new Error(`알 수 없는 명령입니다: ${command}`)
    }
  } finally {
    guard.close()
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
