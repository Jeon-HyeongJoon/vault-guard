# Vault Guard 포맷 프로필

아래 YAML 블록만 기계가 읽습니다. 변수와 규칙은 사용자가 자유롭게 바꿀 수 있습니다.

```yaml
version: 1
name: simple-notes

variables:
  DATE: '\d{4}-\d{2}-\d{2}'

files:
  - match: '*.md'
    minFiles: 1
    rules:
      - id: title
        pattern: '^# (?<title>.+)$'
        min: 1
        max: 1
      - id: updated-date
        pattern: '^updated: (?<date>{{DATE}})$'
        min: 0
        max: 1
    order: [title, updated-date]
```
