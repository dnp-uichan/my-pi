# workflow-controller

Pi 메인이 판단과 분담을 맡고, 이 확장은 승인·상태·검사 증거·독립 검수·중단·전달 조건을 관리한다. subagent 관리 API v1이 없으면 시작하지 않는다.

- `/workflow start <목표>`로 읽기 전용 조사와 계획 제안을 시작한다.
- `workflow_propose`의 실제 UI에서 `승인`을 선택하거나 `/workflow approve`로 승인한다. 모델의 텍스트·도구 인자는 승인이 아니다.
- `workflow_dispatch` → `workflow_check` → 독립 review 순서로 진행한다. 구현 완료 주장은 검사 증거가 아니다.
- 모델은 agent 설정을 따르고, effort는 메인이 dispatch마다 `thinking`(`low`·`medium`·`high`·`xhigh`)으로 정할 수 있다. 생략하면 agent 기본값이며 선택한 값은 attempt에 기록된다. subagent 관리 API의 `thinking` 기능이 없으면 시작하지 않는다.
- `/workflow status|pause|resume|cancel`로 제어한다. 검사 중단은 독립 프로세스 그룹 전체에 SIGTERM을 보내고 기본 2초 뒤 SIGKILL로 강제 종료한다. 그룹 소멸과 child의 close 확인 전에는 stopping을 유지해 재개·dispatch를 거절한다. 검사 타임아웃(기본 10분)도 같은 절차로 일시정지한다. 취소는 파일 rollback이 아니며 세션 재시작은 자동 재개하지 않는다.
- 검사 통과마다 새 `verification.id`를 만들고 review attempt에 연결한다. 증거를 무효화하거나 재검사할 때 실행 중인 이전 review도 무효로 표시한다. 이전 review의 늦은 판정은 기록만 남기고, 새 세대와 시작·종료 지문이 모두 일치하는 판정만 반영한다. 세대 없는 기존 정본의 증거는 무효화해 재검사를 요구한다.
- 실패·중단된 구현은 `workflow_recover`로 실제 HEAD·작업 트리 지문·Git 상태를 확인해야 다시 실행할 수 있다.
- endpoint `verify`는 검수 통과로 종료한다. `commit`은 검수된 내용만 hook을 유지해 커밋한다. `pr`은 커밋 후 정책을 확인하고 push와 Draft PR까지 전달한다. merge·배포는 하지 않는다.

정본은 `${agentDir}/workflows/<repoKey>/<workflowId>.json`이며 세션에는 참조만 저장한다. 손상·접근 오류는 fail-closed로 처리한다. 다른 살아 있는 프로세스가 소유하면 읽기 전용이다. 임시 index를 이용한 지문 계산은 실제 index와 작업 파일을 변경하지 않는다.

기본 export는 Pi의 실제 agent 디렉터리와 `$HOME/.claude/scripts`를 사용한다. `createWorkflowController({ agentDir, scriptsDir?, prPolicy?, now?, stopTimeoutMs?, checkKillGraceMs?, checkTimeoutMs? })`로 격리된 환경에서 로드할 수 있다. 기본 PR 정책은 base `stage`, reviewer `dnp-sungbaek`, Draft다. `git-context.sh`와 `pr-reviewer.sh`의 출력·원격 base·생성된 PR 정책을 확인한다. 기존 PR의 base·Draft·reviewer·head branch 정책은 push 전에 검증하고, PR과 원격 head SHA는 push 뒤 전달 커밋과 비교한다. resume 조정에서도 같은 정책 검증을 적용한다. 응답 유실 시 실제 PR을 재조회하고 미완료 intent는 resume에서 조정한다.

subagent 실행 가드는 `workflow_dispatch`가 생성한 명령 문자열과 정확히 일치하는 현재 세대의 미claim dispatching attempt만 허용한다. 조회·중단 명령은 첫 두 토큰이 `subagent help|runs|status|detail|abort|remove`이며 따옴표·백슬래시가 없을 때만 허용한다. 직접 bash 전달·merge·workflow 실행은 알려진 패턴을 차단한다. **OS sandbox가 아니다.** 별칭·간접 실행·다른 도구·승인된 검사나 사용자 스크립트의 모든 부작용까지 막지는 않는다. 검사와 worker/reviewer의 읽기 전용 계약도 사용자와 메인이 확인해야 한다. 외부 프로세스가 동시에 저장소를 바꾸면 지문으로 거절하지만 검사와 실행 사이의 모든 경합을 원자적으로 막지는 못한다.

```bash
cd extensions
bun run test workflow-controller/index.test.ts
bun run test
bun run typecheck
bunx --no-install biome check --error-on-warnings workflow-controller
```

테스트는 실제 임시 Git 저장소·로컬 bare remote·실제 Pi 이벤트 버스와 subagent 관리 계약의 fake 응답자, PATH의 fake gh 실행 파일을 사용한다. 실제 subagent 구현·GitHub·사용자 설정을 변경하지 않는다.
