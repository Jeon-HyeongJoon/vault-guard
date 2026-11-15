export function diffFiles(previous, current) {
  const before = new Map(previous.map((file) => [file.path, file]))
  const after = new Map(current.map((file) => [file.path, file]))
  const changes = []
  for (const [path, file] of before) {
    const next = after.get(path)
    if (!next) changes.push({ op: 'delete', path, before: file, after: null })
    else if (next.hash !== file.hash) changes.push({ op: 'update', path, before: file, after: next })
  }
  for (const [path, file] of after) if (!before.has(path)) changes.push({ op: 'add', path, before: null, after: file })
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

export function assessRisk(previous, scan, policy) {
  const changes = diffFiles(previous, scan.files)
  const reasons = scan.errors.map((error) => ({ ...error, source: 'scan' }))
  const deleted = changes.filter((change) => change.op === 'delete')
  if (policy.protectDeletes) {
    reasons.push(...deleted.map((change) => ({ kind: 'file-deleted', path: change.path, beforeSize: change.before.size })))
  }
  for (const change of changes.filter((item) => item.op === 'update')) {
    const beforeSize = change.before.size
    const afterSize = change.after.size
    if (policy.protectEmptyFiles && beforeSize > 0 && afterSize === 0) {
      reasons.push({ kind: 'file-emptied', path: change.path, beforeSize, afterSize })
      continue
    }
    if (beforeSize >= policy.minShrinkBytes && afterSize / beforeSize < policy.minSizeRatio) {
      reasons.push({ kind: 'file-shrunk', path: change.path, beforeSize, afterSize, ratio: afterSize / beforeSize })
    }
  }
  const base = Math.max(previous.length, 1)
  if (changes.length >= policy.massChangeCount && changes.length / base >= policy.massChangeRatio) {
    reasons.push({ kind: 'mass-change', path: '', changed: changes.length, total: previous.length, ratio: changes.length / base })
  }
  return { changes, reasons }
}
