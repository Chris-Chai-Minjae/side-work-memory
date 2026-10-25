# Side Work Memory 상세 설명서

[한국어](manual.md) · [English](manual.en.md) · [README로 돌아가기](../README.md) · [처음 쓰는 분을 위한 쉬운 안내서](side-for-beginners.html)

이 문서는 [README](../README.md)에서 덜어낸 세부 사항을 모아 둔 기술 설명서입니다. 저장 경로와 명령, 빌드 옵션, 재빌드 후 권한 복구, 요약 모델 설정과 비용, 완전 제거 절차를 다룹니다. Side를 처음 쓴다면 [쉬운 안내서](side-for-beginners.html)를 먼저 보세요.

![Mac의 활성 창을 기기에 기록하고, 출처를 검색해 연결한 에이전트에서 다시 찾는 네 단계 흐름](assets/side-flow.png)

- [1. 요구 사항](#1-요구-사항)
- [2. 빌드와 설치](#2-빌드와-설치)
- [3. 첫 실행과 설정](#3-첫-실행과-설정)
- [4. macOS 권한](#4-macos-권한)
- [5. 진단과 문제 해결](#5-진단과-문제-해결)
- [6. 요약 모델과 비용](#6-요약-모델과-비용)
- [7. 데이터 저장 구조](#7-데이터-저장-구조)
- [8. 일시정지·삭제·완전 제거](#8-일시정지삭제완전-제거)
- [9. 에이전트 연결](#9-에이전트-연결)
- [10. 개발 현황과 남은 검증 항목](#10-개발-현황과-남은-검증-항목)

## 1. 요구 사항

| 항목 | 내용 |
|---|---|
| OS | macOS 14 이상 |
| 빌드 도구 | Bun, Xcode Command Line Tools. 개발 중 `swift test` 실행에는 전체 Xcode가 필요합니다. |
| SQLite | 빌드 Mac에서 `brew install sqlite`를 실행하거나 FTS5와 확장 로딩을 지원하는 dylib의 절대 경로를 `SIDE_SQLITE_LIBRARY`에 지정합니다. |
| 네트워크 | 첫 빌드에서 MiniLM 모델을 내려받습니다. 실행하는 Mac에는 Homebrew가 필요하지 않습니다. |

## 2. 빌드와 설치

```sh
git clone https://github.com/Chris-Chai-Minjae/side-work-memory.git
cd side-work-memory
bun install --frozen-lockfile
bun run build

ditto apps/side-mac/.build/release/Side.app /Applications/Side.app
open /Applications/Side.app
```

- 빌드 결과물은 `apps/side-mac/.build/release/Side.app`입니다. 같은 이름의 앱이 이미 실행 중이면 복사하기 전에 먼저 종료하세요.
- 빌드 스크립트는 Homebrew SQLite 경로를 먼저 찾습니다. `brew install sqlite`를 실행하거나 다른 위치의 dylib를 쓰려면 `SIDE_SQLITE_LIBRARY`에 절대 경로를 지정합니다.
- 이미 채운 MiniLM 캐시가 있으면 `SIDE_MODEL_CACHE_SOURCE`로 지정해 다시 내려받지 않게 할 수 있습니다.
- 개발 중 데이터 경로를 바꾸려면 `SIDE_DATA_DIR`를 사용합니다.
- 소스 배포 정책상 사전 빌드 앱은 제공하지 않습니다. 로컬 빌드는 **임시 서명(ad hoc signing)** 이며, 재빌드하면 권한을 다시 허용해야 할 수 있습니다.

## 3. 첫 실행과 설정

1. Side는 Dock이 아니라 **메뉴바**에 나타납니다.
2. 첫 실행 온보딩에서 캡처 권한을 허용하고 컨텍스트 인지를 켭니다.
3. 요약 모델 설정은 건너뛸 수 있습니다. 이 경우 캡처와 검색은 동작하고 요약만 대기합니다.
4. 메뉴바 **설정**에서 관리하는 항목: 보관 기간, 제외 앱·웹사이트(Denylist), 브라우저 방문 기록 검색(기본 꺼짐), 요약 모델과 제공자, 에이전트 연결, 화면 언어(한국어 / English).

## 4. macOS 권한

| 권한 | Side에서 쓰는 용도 |
|---|---|
| Accessibility | 활성 창의 제목, 접근성 텍스트와 선택 영역 읽기 |
| Input Monitoring | 입력된 문장을 구성하기 위한 입력 이벤트 관찰. 비밀번호 필드와 개별 키 입력은 저장하지 않음 |
| Screen Recording | 읽을 수 있는 접근성 텍스트가 없을 때 화면 글자를 온디바이스 OCR로 읽기. 이미지는 저장하지 않음 |
| Automation | 지원 브라우저의 현재 탭 URL 읽기 |

- **Screen Recording은 선택 사항입니다.** macOS 권한 창에서 Side를 승인해야 해당 관찰 기능이 동작합니다.
- 메뉴바 **설정 → 권한**에서 각 권한의 현재 상태를 따로 확인하고, 권한을 요청하거나 해당 macOS 설정 화면을 바로 열 수 있습니다.
- 같은 화면에서 요약 제공자의 Keychain 키 참조를 확인하고, 접근 확인이 필요하면 **Keychain 권한 허용**을 누릅니다. 접근 상태는 명시적으로 승인하기 전까지 **미확인**으로 표시됩니다.

**브라우저 자동화**는 Side가 지원 브라우저에 현재 탭 URL을 물을 때 쓰는 macOS 권한입니다. 브라우저마다 따로 허용되며, 이미 허용된 브라우저에는 다시 요청해도 승인 창이 뜨지 않습니다. Side에서 **허용됨**이라고 표시되면 추가 조치가 필요 없습니다. 상태를 바꾸려면 **시스템 설정 → 개인정보 보호 및 보안 → 자동화**를 여세요([Apple 안내](https://support.apple.com/ko-kr/guide/mac-help/mchl108e1718/mac)).

Safari는 시크릿 창 상태를 확실히 구분할 수 없어 현재 활성 창 캡처를 실패 시 차단(fail-closed)합니다. 브라우저 자체 방문 기록 조회는 별도 옵트인 설정을 켠 경우에만 수행합니다.

**Keychain 권한 허용**은 Side 설정에 저장한 API 제공자의 키를 읽을 수 있는지 확인합니다. **키 참조 설정됨**은 항목이 등록됐다는 뜻이고, **Keychain 접근 확인 전**은 값을 읽는 검사를 아직 하지 않았다는 뜻입니다. Keychain 창이 뜨면 Side의 접근을 선택할 수 있습니다. 이미 허용된 경우 새 창 없이 확인이 끝날 수 있습니다. Side 원본 기록을 여는 데 필요한 암호화 키(`local-context-awareness-ledger`)는 제공자 API 키와 별개입니다. Codex·Claude Code CLI 로그인에도 이 버튼을 사용하지 않습니다([Apple 안내](https://support.apple.com/ko-kr/guide/mac-help/kychn002/mac)).

## 5. 진단과 문제 해결

### 진단 명령

```sh
"/Applications/Side.app/Contents/Resources/side" doctor    # Keychain, 권한, SQLite, 벡터 검색 모듈, 모델 캐시, 제공자 연결 상태
"/Applications/Side.app/Contents/Resources/side" status    # 데몬 상태
```

`doctor`의 제공자 연결 검사는 실제 활동 대신 합성 문장을 사용합니다. `status --json`과 `doctor`의 daemon diagnostics에는 마지막 오류의 이름·코드·단계·시각·연속 횟수와 마지막 성공 캡처 시각이 표시됩니다. 오류 message, 캡처 내용, URL, 키, stderr 원문은 진단 로그에 기록하지 않습니다.

제공자 줄에서 `PASS`는 선택한 요약 제공자의 합성 연결 검사 성공, `SKIP`은 요약 제공자가 없거나 선택하지 않은 제공자에 모델 ID·API 키가 없어 검사를 생략한 상태, `WARN`은 선택하지 않은 제공자의 합성 연결 검사 실패를 뜻합니다. 선택한 제공자의 검사 실패는 `FAIL`입니다.

### 다시 빌드한 뒤 권한이 잡히지 않을 때

로컬 빌드는 임시 서명을 쓰기 때문에, 새 빌드로 앱을 교체하면 macOS가 기존 Accessibility·Input Monitoring·Screen Recording 권한을 새 빌드에 적용하지 않을 수 있습니다. 저장된 암호화 키의 Keychain 접근도 다시 물을 수 있습니다.

1. Keychain 창이 뜨면 새 Side를 허용합니다.
2. 메뉴바 **설정 → 권한**에서 손쉬운 사용·입력 모니터링·화면 기록의 상태를 하나씩 확인합니다. 각 행의 **시스템 설정 열기**로 해당 macOS 항목으로 이동할 수 있습니다.
3. 시스템 설정 → 개인정보 보호 및 보안의 해당 권한 목록에서 이전 `Side` 항목을 제거한 뒤 `/Applications/Side.app`을 다시 추가합니다.
4. 같은 권한 스위치를 반복해서 누르기 전에 앱 경로가 맞는지 확인하세요.

### Keychain 허용 창이 보이지 않고 데몬이 시작되지 않을 때

**Keychain Access → login → Passwords**에서 `local-context-awareness-ledger` 항목의 **Access Control**을 열어 `/Applications/Side.app`을 개별 앱으로 추가한 뒤 저장하고, Side를 다시 시작합니다. 암호 표시나 모든 앱 허용은 필요하지 않습니다. 자세한 내용은 [Apple의 앱별 Keychain 접근 안내](https://support.apple.com/ko-kr/guide/mac-help/kychn002/mac)를 보세요.

### 요약이 비어 있거나 실패할 때

1. 먼저 10분 창이 끝났는지 확인합니다.
2. 기록 화면에 실패한 요약 작업이 표시되면 모델 연결과 Keychain 접근을 확인한 뒤 **실패한 요약 다시 시도**를 누릅니다. 재시도 버튼을 누르기 전에는 실패 작업을 다시 모델에 보내지 않습니다.
3. 완료를 기다린 뒤 **요약 새로고침**을 누르면 새 결과가 표시됩니다.
4. 모델 연결이 정상이어도 개별 요약은 모델 응답 오류나 형식 위반으로 실패할 수 있습니다.

## 6. 요약 모델과 비용

- 요약은 활동이 있는 10분 구간과 6시간 롤업에 모델을 사용합니다.
- 제공자는 직접 고릅니다. MiMo·MiniMax 및 기타 OpenAI 호환 API의 키를 Side 설정에 입력하면 macOS Keychain에 보관됩니다. OpenAI는 Codex CLI를 설치해 터미널에서 `codex login`으로 ChatGPT 계정에 로그인한 뒤, Side에서 **OpenAI (Codex login)**을 선택할 수 있습니다. Claude Code는 `claude auth login` 후 **Claude Code login**을 선택합니다. Side는 두 CLI의 로그인 토큰 내용을 읽거나 복사하지 않습니다. Codex 연동은 현재 CLI가 파일에 저장한 로그인만 지원하며, Keychain에만 저장한 로그인은 연결 실패로 처리합니다. Side는 개인 Codex 지침이 요약 요청에 섞이지 않도록 임시 격리 폴더에서 CLI를 실행합니다.
- CLI 로그인을 Side의 요약 호출에 사용하는 경우 각 서비스의 약관과 사용량 제한을 직접 확인하고 본인 책임으로 사용하세요. CLI 로그인은 Side MCP 도구를 Codex·Claude Code에 등록하는 과정과 별개입니다.
- 제공자를 등록한 뒤에도 설정에서 **이 제공자에게 증거 전송**을 켜야 실제 활동으로 요약을 만듭니다. 이 항목은 기본적으로 꺼져 있고, 끄면 새 요약이 만들어지지 않습니다.
- 사용량은 활동량·입력 길이·재시도에 따라 크게 달라지며, 하루 종일 사용하면 수백만 입력 토큰에 이를 수 있습니다. 현재 일일 토큰 한도 기능은 없습니다. 제공자 사용량을 확인하고, 비용을 제한하려면 캡처를 일시정지하거나 위 항목을 끄세요.
- Codex CLI 연결을 허구의 짧은 활동 문장으로 한 번 시험했을 때 CLI가 입력 21,412토큰·출력 123토큰을 보고했습니다. 단일 호출의 관측치이며 실제 하루 사용량을 예측하는 값은 아닙니다.
- Grok Build 로그인으로 Side 요약을 만드는 경로는 아직 검증되지 않았으며 요약 제공자로 연결되어 있지 않습니다.

## 7. 데이터 저장 구조

데이터 루트는 `~/Library/Application Support/Side/`이며, 개발용 경로는 `SIDE_DATA_DIR`로 바꿀 수 있습니다.

| 경로 | 내용 |
|---|---|
| `context-awareness/ledger.db` | 원본 이벤트 (제목·URL·본문 등) |
| `memory/episodic/` | 날짜별 요약 페이지 |
| `index.db` | 검색 색인 |
| `run/mcp-usage.jsonl*` | MCP 클라이언트·도구·결과 수·지연 시간만 기록하는 사용량 로그 |
| `run/diagnostics.jsonl*` | 민감 내용을 제외한 daemon 진단 메타데이터 |
| `daemon.lock` | 실행 중인 daemon의 단일 소유자 확인. 종료 후 남은 stale lock은 다음 시작 때 회수 |

- 원본의 제목·URL·본문 등 민감한 컬럼은 저장 전에 알려진 패턴으로 마스킹하고 AES-256-GCM으로 암호화합니다. 규칙 기반 마스킹은 모든 민감 정보를 찾는다는 보장이 없습니다.
- 마스터 키와 provider API 키는 macOS Keychain에 보관합니다(`local-context-awareness-ledger`, `side-provider-api-key`).
- 원본 캡처의 기본 보관 기간은 14일이며 설정에서 1·3·7·14·30일 중 고를 수 있습니다. 요약은 별도로 남습니다.
- MCP 사용량 로그는 파일당 1MiB·최대 5개, 진단 로그는 파일당 256KiB·최대 3개로 회전하며 둘 다 30일 후 삭제되고 0600 권한을 유지합니다. 이 운영 로그의 30일 보존은 원본 캡처 보관 기간 설정과 독립적입니다.
- 날짜별 페이지(인용된 제목·주소 포함)와 검색 색인(`index.db`)은 암호화되지 않은 로컬 파생 파일입니다. 원본 보관 기간이 지나도 요약·색인에 내용이 남을 수 있으며, 전체 삭제로 제거합니다.
- Side는 원본 캡처를 클라우드로 동기화하지 않습니다.

## 8. 일시정지·삭제·완전 제거

### 멈추기

- 메뉴바에서 15분·30분·1시간·재개할 때까지 캡처를 멈출 수 있습니다.
- 설정의 **Denylist**에 관찰하지 않을 앱이나 웹사이트를 추가합니다.
- **Disable Context Awareness**는 새 캡처를 중단하지만 기존 이력은 보관 기간이 끝나거나 직접 삭제할 때까지 남습니다.

### 지우기

설정의 **Clear history**에서 최근 10분, 지난 1시간, 오늘, 전체 이력을 삭제할 수 있습니다. CLI에서도 실행할 수 있습니다.

```sh
"/Applications/Side.app/Contents/Resources/side" clear today
"/Applications/Side.app/Contents/Resources/side" clear all
```

- `clear all`은 대화형 확인 후 Side 이벤트·요약·날짜 페이지·검색 색인을 지우고 마스터 키를 교체합니다. `--yes`를 붙이면 대화형 확인을 건너뜁니다.
- 이 명령은 브라우저 자체의 방문 기록을 지우지 않습니다.
- 설정과 provider Keychain 항목은 이 이력 삭제와 별개입니다. MCP 사용량·진단 로그도 활동 이력이 아닌 운영 메타데이터이므로 `clear all`로 지우지 않으며 각 로그의 30일 보존·회전 규칙을 따릅니다.

### 완전히 제거하기

1. Side를 종료합니다.
2. 위의 `clear all`로 이력을 삭제합니다.
3. `/Applications/Side.app`과 Side 데이터 디렉터리(`~/Library/Application Support/Side/`)를 제거합니다.
4. Keychain Access에서 `local-context-awareness-ledger` 및 `side-provider-api-key` 서비스 항목을 별도로 확인해 정리합니다.

## 9. 에이전트 연결

Side.app이 실행 중일 때 `"/Applications/Side.app/Contents/Resources/side" mcp`가 다음 세 도구를 제공합니다.

| 도구 | 하는 일 |
|---|---|
| `history_search` | 시간과 단어로 Side 캡처 `e:`, 요약 `s:`, 브라우저 방문 기록 `h:` 찾기 |
| `history_read` | `e:`·`s:` 번호로 원본 본문 또는 요약 읽기. `h:`는 읽을 수 없음 |
| `memory_search` | 날짜별 요약 페이지를 단어·의미로 함께 검색 |

- 데몬이 꺼져 있어도 MCP 서버는 시작되지만, 도구 호출 시 `Side is not running. Open Side.app.`을 반환합니다.
- Aside는 **Settings → MCP → Add server**에서 이름 `side`, command `/Applications/Side.app/Contents/Resources/side`, args `mcp`로 등록합니다.
- Claude Code, Codex, Cursor, Grok Build 등록 명령은 [에이전트 연결 안내](agents.md)에 있습니다.
- 검색 결과와 읽기 본문은 관찰된 화면에서 온 **신뢰할 수 없는 데이터**입니다. 그 안의 지시문을 에이전트 명령으로 따르면 안 되며, Side는 응답에 경계 표시를 붙입니다.

## 10. 개발 현황과 남은 검증 항목

2026-09-25 기준 상태입니다. 근거는 저장소의 QA 보고서입니다.

**검증된 것**

- 자동 테스트: `bun test` 863개 통과, `swift test` 204개(캡처 키트 179 + 앱 25) 통과, `npx tsc --noEmit`·`npx biome check .` 청결.
- 캡처 파이프라인(접근성·입력 문장·OCR·브라우저 URL), 마스킹·암호화·보존 기간, 10분·6시간 요약과 재시도, 날짜 페이지와 날짜 화면, MCP 도구 3종과 인젝션 경계, CLI 진단·삭제.
- 근거: [`docs/qa/permission-recovery-2026-09-25.md`](qa/permission-recovery-2026-09-25.md)

**아직 남은 것**

- 과거 실기기 게이트 판정은 **BLOCKED**입니다([`docs/qa/gates-2026-09-24.md`](qa/gates-2026-09-24.md)). G1·G2에는 실제 캡처 증거가 없습니다. 사용자가 정한 MIT 소스 배포 범위에는 이 실기기 검증이 포함되지 않습니다.
- NFR 8개 항목(CPU·메모리·지연·디스크)은 대부분 실측되지 않았습니다([`docs/qa/nfr-report.md`](qa/nfr-report.md)).
- 번들 앱에서 로그인 항목을 켜고 재부팅해 앱과 데몬이 자동 기동하는지, 메뉴바·온보딩이 실제 화면에서 어떻게 그려지는지는 수동 검증이 필요합니다.
- Grok Build에서 Side 도구를 호출하는 경로와 Grok Build 로그인으로 요약을 만드는 경로는 검증되지 않았습니다.

**남은 항목의 위치**

- 체크박스: [`docs/planning/06-tasks.md`](planning/06-tasks.md)의 P4-S3·P4-S4, P5-T5.1~T5.6.
- 게이트 기준과 증거 양식: [`docs/planning/08-nfr-test-gates.md`](planning/08-nfr-test-gates.md), [`docs/qa/`](qa/).
- 공개 저장소는 검증한 소스의 단일 시작 스냅샷입니다. 과거 QA 보고서의 개발 커밋 ID가 공개 이력에서 조회되지 않는 이유는 [공개 이력 설명](qa/publication-history.md)에 있습니다.
