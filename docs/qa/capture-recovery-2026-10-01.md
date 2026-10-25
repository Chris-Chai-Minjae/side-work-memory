# Intermittent capture recovery — 2026-10-01

## 확인한 상태 / Observed state

- 메뉴바 앱은 살아 있었지만 해당 앱이 소유한 데몬은 없었습니다. `side status`는 `Side is not running. Open Side.app.`을 반환했습니다.
- 제공된 메뉴 스크린샷은 “캡처가 실행 중이지 않습니다”를 표시했습니다.
- 기존 설치 앱의 supervisor 상태만 읽은 결과는 `.stopped`였습니다. 프로세스 표본에는 Keychain 승인 대기나 GUI 크래시가 없었습니다.
- 실제 활동 본문·제목·URL, API 키, Keychain 값은 조사 도구로 읽거나 기록하지 않았습니다. 기존 데이터와 인증 정보를 삭제하거나 초기화하지 않았습니다.

The menu bar app remained alive without its owned daemon. Its supervisor was stopped, and the status command reported that Side was not running. Investigation used process/lifecycle metadata and synthetic test inputs only.

## 원인과 수정 / Cause and fix

`DaemonSupervisor.didExit`는 자신이 계속 감독하던 데몬의 종료 코드가 0이면 `.stopped`로 전환하고 복구를 생략했습니다. 프로토콜 또는 파이프 오류로 앱이 SIGTERM을 보내더라도, Bun 데몬은 이를 정상 종료로 처리해 코드 0으로 끝날 수 있습니다. 따라서 예상하지 못한 종료가 영구적인 캡처 중단으로 이어졌습니다.

수정 후에는 계속 감독 중인 프로세스의 모든 종료에 기존 재시작 정책을 적용합니다. 사용자 종료는 기존대로 termination handler와 프로세스 참조를 먼저 해제하므로 재시작하지 않습니다. 1분에 5회 재시도와 재시도 간격 등 정본 정책은 유지했습니다.

종료·시작·재시도·프로토콜/파이프 오류에 OSLog 메타데이터를 추가했습니다. PID, 종료 코드, 고정된 사유, 재시도 간격만 기록하며 프레임·오류 본문·사용자 활동·인증 정보는 기록하지 않습니다.

An unexpected successful daemon exit was mistaken for an intentional stop. The supervisor now applies its existing restart policy to any exit it still owns; explicit stop and quit remain detached from recovery. Lifecycle logs contain metadata only.

처음 데몬을 종료시킨 계기는 기존 로그 부족으로 확인할 수 없습니다. 이번 증거는 **복구 경로의 결함**을 입증하며, 모든 간헐적 중단 원인이 제거됐다는 뜻은 아닙니다.

The original initiating failure is unknown. These findings prove a recovery defect, not that every possible capture interruption has been eliminated.

## 검증 / Verification

| Check | Evidence |
| --- | --- |
| RED | 새 회귀 테스트 2개 모두 수정 전 5초 타임아웃. 예상 `.running`, 실제 `.stopped`; 4 assertions failed. |
| GREEN | `swift test --package-path apps/side-mac --filter SupervisorTests`: 33 tests, 0 failures. |
| Graceful-exit regression | 첫 health 프레임 뒤 코드 0으로 종료하는 합성 데몬이 두 번째 실행에서 `.running`으로 복구됨. |
| Transport regression | 합성 protocol-error 뒤 SIGTERM을 코드 0으로 처리하는 데몬도 `.running`으로 복구됨. |
| Intentional quit | 기존 정상 종료 및 5초 강제 종료 테스트 통과. |
| Full Swift | 186 SideCaptureKit + 28 SideApp tests, 0 failures. |
| Full Bun | 891 pass, 0 fail; 5491 assertions, 75 files. |
| Static checks | `bun run check`: TypeScript and Biome passed (201 files). `git diff --check` passed. |
| Bundle | Release rebuild, bundled CLI smoke and `codesign --verify --deep --strict` passed. |
| Local installation | Rebuilt `/Applications/Side.app`, preserved data/authentication, and launched it. |
| Installed runtime | Pending macOS Keychain approval for the rebuilt app's existing ledger key. A process sample confirmed `SideKeychain.masterKey()` waiting in `SecItemCopyMatching`. |

## 남은 확인 / Remaining verification

- 승인 후 실제 설치 앱에서 상태와 캡처 카운터가 회복되는지 확인합니다.
- GUI를 유지한 채 해당 GUI가 소유한 데몬만 정상 종료시켜, 실제 데몬 재시작과 캡처 재개를 확인합니다.
- 장시간 사용 중 다시 중단되면 새 lifecycle 로그로 최초 실패를 좁힙니다. 장기간 무중단 동작은 아직 검증하지 않았습니다.
- 기존 Downloads ZIP/DMG 및 GitHub 배포본은 이 검증으로 갱신하지 않았습니다.

After approval, verify installed-app capture and recovery from a controlled owned-daemon shutdown. Long-duration acceptance and distribution artifacts remain separate from the source and bundle checks above.
