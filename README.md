# Vault Guard

Syncthing으로 실시간 동기화하는 Markdown 폴더에 붙이는 가벼운 버전 보호기입니다.

Syncthing은 파일을 기기 사이에 전달하고, Vault Guard는 각 기기에서 다음 일을 맡습니다.

- 변경을 감시하고 안정된 상태가 될 때까지 기다린 뒤 자동 revision 생성
- SHA-256 내용 주소와 Brotli 압축으로 같은 원문을 한 번만 보관
- 파일 삭제, 빈 파일, 큰 폭의 축소, 대량 변경, Syncthing 충돌 파일 감지
- 선택한 YAML·Markdown 프로필로 사용자 정의 구조 검증
- 손상 후보는 자동 복구하지 않고 `incident`로 비교
- `restore`로 이전 정상본 복구, `accept`로 의도한 삭제·수정 승인
- 오래된 revision과 참조되지 않는 blob 정리
- 복구 직전에 현재 manifest와 revision을 재검증하여 오래된 복구가 이후 작업을 덮어쓰지 못하게 차단

Git의 blob·commit·diff·restore 개념만 가져왔습니다. 브랜치, merge, push는 없고 실시간 전송은 Syncthing에 맡깁니다.

## 요구 사항

- Node.js 22.5 이상
- macOS에서는 Node.js 24 LTS 권장
- YAML 프로필 해석을 위한 `yaml` 패키지 1개

## 1. 시험

```bash
cd vault-guard
npm install
npm test
```

명령 이름으로 바로 쓰고 싶을 때 한 번만 로컬 링크를 등록합니다.

```bash
npm link
vault-guard help
```

## 2. 폴더 등록

```bash
vault-guard init "/보호할/Obsidian Vault" --name my-vault
```

출력되는 `config` 경로를 보관합니다. 상태 DB와 압축 원문은 기본적으로 다음 위치에 생깁니다.

```text
~/Library/Application Support/Vault Guard/my-vault/
```

DB는 Syncthing 폴더 밖에 있어야 합니다. DB 자체를 동기화하면 SQLite WAL 충돌이 생길 수 있습니다.

포맷 프로필을 지정하지 않으면 구조 검증은 완전히 꺼지고 revision·diff·rollback만 사용합니다.

## 선택 기능: 사용자 포맷 검증

YAML 또는 Markdown 안의 YAML 블록을 사용할 수 있습니다. 예제는 [examples/format.example.yml](examples/format.example.yml)과 [examples/format.example.md](examples/format.example.md)에 있습니다.

```bash
vault-guard init "/보호할/Obsidian Vault" \
  --name my-vault \
  --format "/내규칙/format.yml"
```

```yaml
version: 1
name: my-format

variables:
  NUMBER: '\d+(?:[-.]\d+)*'
  STATUS: '🔴|⏸|🔄|✅|⬜'

files:
  - match: '다음할일.md'
    rules:
      - id: title
        pattern: '^# (?<title>.+)$'
        min: 1
        max: 1
      - id: item
        pattern: '^(?<number>{{NUMBER}})\.\s+(?<status>{{STATUS}})?.*$'
        min: 1
    order: [title, item]
```

- `variables`: 여러 규칙에서 재사용할 정규식 조각
- `match`: 검증할 파일 glob
- `pattern`: 사용자가 정하는 줄·문서 구조. `(?<title>...)`처럼 이름 있는 값을 추출할 수 있음
- `min`, `max`: 해당 구조의 허용 개수
- `order`: 구조가 나타나야 하는 순서

프로필은 **검증만 수행합니다**. Markdown을 정렬하거나 자동 수정하지 않습니다. 프로필 경로나 `config.json`의 `format`을 제거하면 즉시 일반 버전 관리 모드가 됩니다.

## 3. 실시간 감시

```bash
vault-guard watch --config "/출력된/config.json"
```

파일 이벤트 후 300ms 기다리고 같은 manifest가 유지되는지 한 번 더 확인합니다. `fs.watch` 이벤트를 놓친 경우를 위해 60초마다 전체 상태도 대조합니다.

## 4. 상태와 이력

```bash
vault-guard check --config "/출력된/config.json"
vault-guard status --config "/출력된/config.json"
vault-guard log --config "/출력된/config.json"
vault-guard log --config "/출력된/config.json" --file "다음할일.md"
vault-guard show 12 --config "/출력된/config.json"
vault-guard diff 8 12 --config "/출력된/config.json"
vault-guard doctor --config "/출력된/config.json"
```

`log`는 revision과 부모 revision을 보여 주고, `show`는 해당 revision에서 바뀐 파일과 줄 단위 내용을 보여 줍니다. `diff 8 12`는 두 revision을 직접 비교하며, 뒤 revision을 생략하면 현재 활성 revision과 비교합니다.

기본 데이터 경로로 등록했다면 보호 폴더 안에서는 `--config`를 생략할 수 있습니다.

```bash
cd "/보호할/Obsidian Vault"
vault-guard status
```

CLI 접근과 `watch` 중 손상이 감지되면 터미널에 다음 형식의 빨간 경고를 표시합니다. `check`는 자동화에서 사용할 수 있도록 손상 시 종료 코드 `2`를 반환합니다.

```text
현재 손상이 감지됨 — 다음할일.md: title 구조가 부족합니다 — 복구 포인트 r12 (시각)
```

## 에이전트 작업 검증

에이전트에는 사람용 색상 문구 대신 JSON과 종료 코드를 사용합니다.

```bash
vault-guard check --json
```

`validate`는 `check`의 같은 이름 별칭입니다.

```bash
vault-guard validate --json
```

- 종료 코드 `0`: 현재 Markdown 구조와 손실 검사가 통과함
- 종료 코드 `2`: 검증 실패. `format.issues`와 `reasons`를 에이전트에 그대로 반환
- 종료 코드 `1`: config, 프로필 또는 프로그램 실행 오류

`--json`에서는 빨간 사람용 경고를 섞지 않고 stdout에 구조화된 결과만 출력합니다. 이 명령은 읽기 전용이며 파일·revision·사건 상태를 변경하지 않습니다.

에이전트 지침에는 다음 정도만 추가하면 됩니다.

```markdown
Markdown 작업을 마친 뒤 `vault-guard check --json`을 실행한다.
종료 코드가 2이면 `format.issues`와 `reasons`를 수정하고 다시 검사한다.
삭제·대량 축소처럼 사람 승인이 필요한 실패는 임의로 승인하거나 복구하지 않는다.
```

원하는 과거 revision으로 폴더 전체를 되돌릴 수도 있습니다.

```bash
vault-guard rollback 12 --config "/출력된/config.json" --yes
```

롤백 결과는 새 revision으로 다시 기록됩니다. 따라서 롤백 전 상태도 `log`에 남고 다시 되돌릴 수 있습니다.

## 5. 손상 후보 처리

`status`의 `incidents`에서 사건 ID를 확인합니다.

```bash
vault-guard incident 3 --config "/출력된/config.json"
```

잘못된 삭제·손상이면 이전 정상본으로 복구합니다.

```bash
vault-guard restore 3 --config "/출력된/config.json" --yes
```

의도한 삭제나 정리라면 현재본을 정상 revision으로 승인합니다.

```bash
vault-guard accept 3 --config "/출력된/config.json" --yes
```

사건 이후 폴더가 다시 바뀌었다면 두 명령 모두 거부됩니다. 최신 사건과 diff를 다시 확인해야 합니다.

## 6. 이력 정리

```bash
vault-guard prune --config "/출력된/config.json"
```

기본값은 최근 30일 또는 최신 100 revision을 유지합니다. 미해결 사건과 180일 이내 사건이 참조하는 revision은 별도로 보호합니다. 설정은 `config.json`에서 조정할 수 있습니다.

## Syncthing 권장 구성

- 각 기기에서 같은 Vault 폴더를 Syncthing `Send & Receive`로 연결
- Syncthing의 `Staggered File Versioning`도 켜서 2차 복구 계층으로 사용
- Vault Guard는 사용할 기기마다 설치하되, 상태 DB는 각 기기의 동기화 폴더 밖에 저장
- 한 기기에서 복구하면 복구된 Markdown이 Syncthing을 통해 다른 기기로 전달됨
- `.sync-conflict-*.md`가 생기면 자동 승인하지 않고 사건으로 남김

Vault Guard는 동기화 충돌을 merge하지 않습니다. 정확한 해시와 diff를 제공하고, 어느 상태를 정상본으로 삼을지는 사람이 결정합니다.

## 모듈로 사용

```js
import { loadConfig, VaultGuard, startWatcher } from 'vault-guard'

const config = loadConfig('/path/to/config.json')
const guard = new VaultGuard(config)
const watcher = startWatcher(guard, {
  onResult: console.log,
  onError: console.error,
})

// 종료할 때
watcher.stop()
guard.close()
```

프로젝트 고유 구조 검증이 필요하면 `VaultGuard` 생성자의 `assess` 함수를 교체할 수 있습니다. 저장·revision·복구 기능과 Markdown 해석 규칙을 분리하기 위한 확장 지점입니다.
