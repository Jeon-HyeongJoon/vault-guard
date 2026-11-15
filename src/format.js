import { existsSync, readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { parse as parseYaml } from 'yaml'

const VARIABLE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g

function yamlFromMarkdown(text, path) {
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)
  if (frontmatter) return frontmatter[1]
  const fenced = text.match(/```(?:ya?ml|vault-guard)\s*\n([\s\S]*?)\n```/i)
  if (fenced) return fenced[1]
  throw new Error(`Markdown 안에서 YAML frontmatter 또는 fenced block을 찾을 수 없습니다: ${path}`)
}

function profileSource(path) {
  const text = readFileSync(path, 'utf8')
  return extname(path).toLowerCase() === '.md' ? yamlFromMarkdown(text, path) : text
}

function assertProfile(profile, path) {
  if (!profile || typeof profile !== 'object') throw new Error(`포맷 프로필이 객체가 아닙니다: ${path}`)
  if (profile.version !== 1) throw new Error(`지원하지 않는 포맷 프로필 버전입니다: ${profile.version}`)
  if (!Array.isArray(profile.files) || !profile.files.length) throw new Error(`포맷 프로필 files가 비어 있습니다: ${path}`)
  for (const [fileIndex, file] of profile.files.entries()) {
    if (!file?.match || typeof file.match !== 'string') throw new Error(`files[${fileIndex}].match가 필요합니다`)
    if (!Array.isArray(file.rules)) throw new Error(`files[${fileIndex}].rules가 배열이 아닙니다`)
    const ids = new Set()
    for (const [ruleIndex, rule] of file.rules.entries()) {
      if (!rule?.id || !rule.pattern) throw new Error(`files[${fileIndex}].rules[${ruleIndex}]에 id와 pattern이 필요합니다`)
      if (ids.has(rule.id)) throw new Error(`같은 파일 규칙에서 rule id가 겹칩니다: ${rule.id}`)
      ids.add(rule.id)
    }
    for (const id of file.order || []) if (!ids.has(id)) throw new Error(`order가 알 수 없는 rule을 참조합니다: ${id}`)
  }
  return profile
}

export function loadFormatProfile(config) {
  if (!config.format?.profile) return null
  const path = config.format.profile
  if (!existsSync(path)) throw new Error(`포맷 프로필을 찾을 수 없습니다: ${path}`)
  let profile
  try {
    profile = assertProfile(parseYaml(profileSource(path)), path)
  } catch (error) {
    throw new Error(`포맷 프로필 오류: ${error.message}`)
  }
  const loaded = { ...profile, source: path, name: profile.name || 'custom' }
  return loaded
}

function expand(value, variables, stack = []) {
  return String(value).replace(VARIABLE, (_whole, name) => {
    if (!(name in variables)) throw new Error(`정의되지 않은 포맷 변수: ${name}`)
    if (stack.includes(name)) throw new Error(`순환 포맷 변수: ${[...stack, name].join(' -> ')}`)
    return expand(variables[name], variables, [...stack, name])
  })
}

function globRegex(pattern) {
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i++
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp(`${source}$`, 'u')
}

function matchesOf(text, rule, variables) {
  const source = expand(rule.pattern, variables)
  const flags = new Set(String(rule.flags || 'gm').split(''))
  flags.add('g')
  let regex
  try {
    regex = new RegExp(source, [...flags].join(''))
  } catch (error) {
    throw new Error(`rule ${rule.id} 정규식 오류: ${error.message}`)
  }
  const matches = []
  let hit
  while ((hit = regex.exec(text)) !== null) {
    matches.push({ index: hit.index, text: hit[0], variables: hit.groups || {} })
    if (hit[0] === '') regex.lastIndex++
    if (matches.length > 100_000) throw new Error(`rule ${rule.id} 결과가 너무 많습니다`)
  }
  return matches
}

const issueMessage = (template, values) => String(template || '')
  .replace(VARIABLE, (_whole, name) => values[name] ?? `{{${name}}}`)

export function validateFormatting(files, profile) {
  if (!profile) return { enabled: false, profile: null, issues: [], captures: [] }
  const issues = []
  const captures = []
  for (const fileSpec of profile.files) {
    const matcher = globRegex(fileSpec.match.normalize('NFC'))
    const matched = files.filter((file) => matcher.test(file.path))
    const minFiles = Number(fileSpec.minFiles ?? 1)
    const maxFiles = fileSpec.maxFiles == null ? null : Number(fileSpec.maxFiles)
    if (matched.length < minFiles) {
      issues.push({ kind: 'format-file-missing', path: fileSpec.match, rule: null, count: matched.length, min: minFiles, message: fileSpec.message || `필수 파일 패턴이 부족합니다: ${fileSpec.match}` })
    }
    if (maxFiles != null && matched.length > maxFiles) {
      issues.push({ kind: 'format-file-excess', path: fileSpec.match, rule: null, count: matched.length, max: maxFiles, message: fileSpec.message || `파일 패턴이 허용 개수를 넘었습니다: ${fileSpec.match}` })
    }
    for (const file of matched) {
      if (!file.bytes) continue
      const text = file.bytes.toString('utf8')
      const variables = { ...(profile.variables || {}), ...(fileSpec.variables || {}) }
      const first = new Map()
      for (const rule of fileSpec.rules) {
        const matches = matchesOf(text, rule, variables)
        first.set(rule.id, matches[0]?.index ?? null)
        captures.push(...matches.slice(0, 20).map((match) => ({ file: file.path, rule: rule.id, variables: match.variables })))
        const min = Number(rule.min ?? 1)
        const max = rule.max == null ? null : Number(rule.max)
        const values = { file: file.path, rule: rule.id, count: matches.length, min, max: max ?? '' }
        if (matches.length < min) {
          issues.push({ kind: 'format-rule-missing', path: file.path, rule: rule.id, count: matches.length, min, message: issueMessage(rule.message || `{{file}}: {{rule}} 구조가 부족합니다`, values) })
        }
        if (max != null && matches.length > max) {
          issues.push({ kind: 'format-rule-excess', path: file.path, rule: rule.id, count: matches.length, max, message: issueMessage(rule.message || `{{file}}: {{rule}} 구조가 너무 많습니다`, values) })
        }
      }
      const ordered = (fileSpec.order || []).map((id) => ({ id, index: first.get(id) })).filter((item) => item.index != null)
      for (let i = 1; i < ordered.length; i++) {
        if (ordered[i - 1].index <= ordered[i].index) continue
        issues.push({
          kind: 'format-order-invalid',
          path: file.path,
          rule: ordered[i].id,
          message: `${file.path}: ${ordered[i - 1].id} 다음에 ${ordered[i].id} 구조가 와야 합니다`,
        })
      }
    }
  }
  return {
    enabled: true,
    profile: { name: profile.name, source: profile.source, version: profile.version },
    issues,
    captures,
  }
}

export const formatInternals = { expand, globRegex, yamlFromMarkdown }
