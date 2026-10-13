# workflow-controller

Pi 메인이 조사·인터뷰·판단·분담을 맡고, 이 확장은 기존 승인·검사·독립 검수·중단·전달 조건을 관리한다. 기본 운영은 **조사와 필요한 인터뷰 → 최종 계획 한 번 승인 → 구현·보완·검증·Draft PR 전달 → 사용자가 PR에서 리뷰**다. 인터뷰 전용 단계·저장 상태·명령은 추가하지 않는다. subagent 관리 API v1이 없으면 시작하지 않는다.

인터뷰 깊이는 구현 난이도가 아니라 **남은 불확실성과 실패 영향**으로 정한다. 코드·문서·조회 도구로 확인할 사실과 기존 패턴의 기술적 선택은 메인이 해결한다. 목표가 명확하면 질문 없이, 일부만 불명확하면 관련 질문을 묶어서, 정책·의존관계가 얽히면 해당 부분만 깊게 확인한다. 이미 합의한 답을 다시 묻거나 고정 질문지를 모두 채우지 않는다.

목표·제외 범위·성공 기준·수정 범위·허용 대안·실패 시 대응·보완/복구 한도와 전달 권한이 정해지면 인터뷰를 끝낸다. 합의는 기존 `objective`·`nonGoals`·`successCriteria`·검사·검수·한도 필드에 담는다. 별도 인터뷰 문서는 필요 없다. 최종 요약을 본문으로 설명한 다음 기존 계획 승인 UI에서 한 번 승인받고, 같은 합의를 별도 폼으로 반복하지 않는다. 사용자가 `verify`·`commit` 종료를 명시하지 않았다면 메인은 `endpoint: "pr"`를 제안한다. 이는 제안 기준이며 스키마 기본값이나 자동 실행 권한이 아니다. 저장소·head·base와 commit·push·Draft PR 권한은 승인 대상이다.

Stacked PR은 각 PR의 결과·제외 범위·부모 관계·검토 순서·검증과 전체 통합 완료 기준까지 처음에 합의한다. 실행 중 조정 권한은 기존 `replanPolicy`·`allowedPaths`의 실제 제한 안에서 정한다. 같은 스택의 PR마다 사용자 리뷰나 재승인을 기다리지 않는다. 합의 범위·한도 안의 실패와 보완은 메인이 처리하되, 새 목표·권한·검증 기준 완화·해결할 수 없는 인증/환경 문제와 사용자 중단은 우회하지 않는다. PR 종료 계획은 실제 전달 확인 뒤 PR 링크·검토 순서·주요 변경·검증 결과·제외/후속 범위로 인계하며, 로컬 구현이나 테스트 통과만으로 끝내지 않는다.

- 메인이 `workflow_start({ goal: "목표" })`로 읽기 전용 조사와 인터뷰를 시작한다. 사용자가 `/workflow start <목표>`로 직접 시작할 수도 있다. 두 진입점은 같은 진행 안내를 받는다. 도구 응답의 `guidance`는 일회성 안내이며 정본에 저장하거나 별도 모델 턴을 만들지 않는다.
- `workflow_propose`의 실제 UI에서 `승인`을 선택하거나 `/workflow approve`로 승인한다. 모델의 텍스트·도구 인자는 승인이 아니다. `endpoint: "pr"`일 때만 선택 필드 `prBase`를 지정할 수 있으며 생략하면 `stage`다. stacked PR이면 보호 브랜치(`main`, `master`, `stage`, `development`, `production`)가 아닌 기존 원격 브랜치를 지정한다. 승인 화면에 base가 표시된다.
- `/workflow start --auto <목표>`로 시작하면 제안된 계획(재제안 포함)을 사용자 확인 없이 `via: "auto"`로 승인하고 계획의 종료 지점까지 이어간다. 미결정 정책을 임의로 정하는 옵션은 아니며 필요한 인터뷰는 유지한다. 명시적 변경 인수가 없는 전달 계획의 clean 조건·보호 브랜치 제한 등은 그대로 검사한다. 제안 사전 검사가 실패하면 기존 계획과 증거를 보존하고 차단 이유를 알리며, 승인 직전 상태가 달라져도 승인을 거절한다. 플래그는 사용자 명령에서만 켤 수 있다.
- `workflow_dispatch` → `workflow_check` → 독립 review 순서로 진행한다. 구현 완료 주장은 검사 증거가 아니다.
- 모델은 agent 설정을 따르고, effort는 메인이 dispatch마다 `thinking`(`low`·`medium`·`high`·`xhigh`)으로 정할 수 있다. 생략하면 agent 기본값이며 선택한 값은 attempt에 기록된다. subagent 관리 API의 `thinking` 기능이 없으면 시작하지 않는다.
- `/workflow status|pause|resume|cancel`로 제어한다. 검사 중단은 독립 프로세스 그룹 전체에 SIGTERM을 보내고 기본 2초 뒤 SIGKILL로 강제 종료한다. 그룹 소멸과 child의 close 확인 전에는 stopping을 유지해 재개·dispatch를 거절한다. 검사 타임아웃(기본 10분)도 같은 절차로 일시정지한다. 취소는 파일 rollback이 아니며 세션 재시작은 자동 재개하지 않는다.
- 검사 통과마다 새 `verification.id`를 만들고 review attempt에 연결한다. 증거를 무효화하거나 재검사할 때 실행 중인 이전 review도 무효로 표시한다. 이전 review의 늦은 판정은 기록만 남기고, 새 세대와 시작·종료 지문이 모두 일치하는 판정만 반영한다. 세대 없는 기존 정본의 증거는 무효화해 재검사를 요구한다.
- 실패·중단된 구현은 `workflow_recover`로 실제 HEAD·작업 트리 지문·Git 상태를 확인해야 다시 실행할 수 있다.
- endpoint `verify`는 검수 통과로 종료한다. 기본 새 커밋 전달에서 `commit`·`pr`은 검수 통과(`ready-to-deliver`) 뒤 메인이 `workflow_dispatch`에 `role: "deliver"`로 전달 worker(기본 agent `worker`, `--main`)를 실행한다. worker는 commit 스킬을 읽고 검수된 내용만 hook을 유지해 커밋하며, `pr`이면 pr 스킬을 읽고 push와 Draft PR까지 전달한다. 파일 내용 수정·merge·배포·force push·amend·rebase·reset은 하지 않는다.
- 기본 전달 worker가 끝나면 확장은 승인 시점 커밋 위에 새 커밋이 쌓였는지(여러 개 허용), 최종 커밋 트리가 검수 지문과 같은지, 남은 변경이 없는지, 현재 브랜치가 승인 브랜치인지 확인한다. `pr`이면 원격 브랜치 head가 최종 커밋인지, 열린 Draft PR이 하나이고 그 head가 최종 커밋이며 base가 승인된 base인지도 확인한다. 실제 상태가 일치해야 완료로 기록한다.
- 확인 실패 시 완료하지 않고 `blocked`로 멈춘다. 커밋만 완료되고 PR이 실패하면 커밋 완료를 기록한다. 재개 뒤 deliver를 다시 실행하면 worker는 이미 된 단계를 반복하지 않고 PR만 진행한다.

정본은 `${agentDir}/workflows/<repoKey>/<workflowId>.json`이며 세션에는 참조만 저장한다. 손상·접근 오류는 fail-closed로 처리한다. 다른 살아 있는 프로세스가 소유하면 읽기 전용이다. 임시 index를 이용한 지문 계산은 실제 index와 작업 파일을 변경하지 않는다.

기본 export는 Pi의 실제 agent 디렉터리를 사용한다. `createWorkflowController({ agentDir, now?, stopTimeoutMs?, checkKillGraceMs?, checkTimeoutMs? })`로 격리된 환경에서 로드할 수 있다. 기본 PR base는 `stage`이며 승인된 `prBase`로 stacked PR을 전달할 수 있다. 확장은 `git-context.sh`·`pr-reviewer.sh`를 실행하지 않는다. 스크립트 실행과 reviewer `dnp-sungbaek`·assignee·제목·본문 기준은 전달 worker가 읽는 pr 스킬에 맡기며 확장은 이 메타데이터를 확인하지 않는다.

subagent 실행 가드는 `workflow_dispatch`가 생성한 명령 문자열과 정확히 일치하는 현재 세대의 미claim dispatching attempt만 허용한다. 조회·중단 명령은 첫 두 토큰이 `subagent help|runs|status|detail|abort|remove`이며 따옴표·백슬래시가 없을 때만 허용한다. 메인 세션의 직접 bash 전달(`git commit`·`git push`·`gh pr create`)·merge·workflow 실행은 알려진 패턴을 차단한다. 전달 worker 안에서는 승인된 종료 지점까지 commit·push·PR 생성을 허용하지만 merge·배포는 금지한다. 구현 worker의 commit·push·PR 금지도 유지한다. **OS sandbox가 아니다.** 별칭·간접 실행·다른 도구·승인된 검사나 사용자 스크립트의 모든 부작용까지 막지는 않는다. 검사와 worker/reviewer의 읽기 전용 계약도 사용자와 메인이 확인해야 한다. 외부 프로세스가 동시에 저장소를 바꾸면 지문으로 거절하지만 검사와 실행 사이의 모든 경합을 원자적으로 막지는 못한다.

```bash
cd extensions
bun run test workflow-controller/index.test.ts
bun run test
bun run typecheck
bunx --no-install biome check --error-on-warnings workflow-controller
```

테스트는 실제 임시 Git 저장소·로컬 bare remote·실제 Pi 이벤트 버스와 subagent 관리 계약의 fake 응답자, PATH의 fake gh 실행 파일을 사용한다. 실제 subagent 구현·GitHub·사용자 설정을 변경하지 않는다.

## 사전 검사와 기존 미커밋 변경 인수

메인은 workflow 전환을 권하거나 기존 작업을 취소하기 전에 `workflow_preflight({ spec })`로 후보 계획이 승인 가능한지 확인한다. `spec`을 생략하면 현재 저장소·브랜치·HEAD·변경 파일과 차단 요인을 조회한다. 시작 전이나 진행 중에도 사용할 수 있으며, 계획·승인·검증 증거·파일·실제 Git index를 바꾸지 않는다. 조회 결과는 승인이나 재개 권한이 아니다.

새 작업에서 기존 산출물을 이어받으려면 일반 `commit`·`pr` 계획에 `adoptChanges`를 명시한다. 단순히 dirty 상태를 허용하는 옵션이 아니라, 인수할 변경과 이후 보완 범위를 승인하는 계약이다.

```json
{
  "endpoint": "pr",
  "prBase": "stage",
  "adoptChanges": {
    "paths": ["src/settings/panel.tsx", "src/settings/panel.test.tsx"],
    "allowedPaths": ["src/settings/"]
  }
}
```

예제는 전체 계획 중 인수 설정 부분이다. `paths`에는 현재 변경된 파일을 빠짐없이 적는다. 삭제나 rename도 원본·대상 경로를 포함한다. 무관한 기존 변경이 함께 있으면 부분 인수하지 않고 거절한다. `allowedPaths`는 승인 뒤 보완할 정확한 파일 또는 `/`로 끝나는 디렉터리 범위이며, 생략하면 `paths`만 허용한다. 절대 경로·상위 경로 이동·와일드카드는 허용하지 않는다.

확장은 파일 목록·변경 요약·지문을 직접 계산하고 저장소·브랜치·기준 HEAD·허용 범위·전달 대상을 승인 화면에 표시한다. 표시한 뒤 HEAD·파일·index·전달 대상이 달라지면 승인을 거절한다. 충돌이나 종료되지 않은 관리 실행이 있어도 인수하지 않는다. 실패한 후보가 기존 승인과 검사 증거를 먼저 지우지 않으며, 이전 workflow의 승인이나 blocked 판정을 새 계획의 pass로 복사하지 않는다.

승인 후 허용 범위 안의 보완은 재승인 없이 진행하지만, 내용이 바뀌면 검사·검수 증거를 새로 받아야 한다. 범위 밖 변경은 검사·검수·전달에서 거절한다. 전달 worker는 최종 검수된 트리만 커밋하고 확장이 실제 커밋·원격·PR을 확인한다. 이 기능을 사용하려고 임시 커밋·stash를 만들거나 기존 파일을 지울 필요는 없다.

`adoptChanges`가 없으면 일반 전달 계획의 clean 조건을 유지한다. 이미 만들어진 커밋을 그대로 보내는 `deliveryMode: "existing-commit"`과는 함께 사용하지 않는다.

## 이미 만들어진 커밋의 전달

이전 작업에서 커밋을 만들었고 push·PR만 남았다면, 일반 `workflow_propose` 계획에 아래 설정을 포함한다. `title`, `objective`, 검사·성공 기준 등 나머지 계획 필드도 필요하다.

```json
{
  "endpoint": "pr",
  "deliveryMode": "existing-commit",
  "prBase": "stage"
}
```

이 모드는 새 커밋을 만들지 않는다. 승인 화면에 기존 커밋 전달과 대상 SHA를 표시하고, 승인된 `approval.head`를 고정한다. 승인 화면 이후 SHA가 바뀌면 다시 확인해야 한다. 해당 workflow의 검사와 필수 독립 검수는 그대로 수행하며 이전 workflow의 승인·검증 증거를 복사하지 않는다.

전달 worker는 pr 스킬을 읽고 고정된 커밋을 push한 뒤 Draft PR을 만들거나 재사용한다. 구현 worker, 파일 수정, 새 커밋·amend·rebase·force push는 허용하지 않는다. 확장은 승인 SHA·브랜치·깨끗한 작업 트리·검수된 커밋 트리와 실제 원격 head·Draft PR의 head/base를 확인한다. 기존 커밋을 확인한 기록은 `reused: true`로 구분하며, 원격이나 PR이 아직 준비되지 않았으면 완료하지 않는다. 조건을 충족한 뒤 재개하면 새 커밋 없이 전달을 확인할 수 있다.

`deliveryMode`를 생략하면 기존 새 커밋 전달 규칙을 유지한다. `existing-commit`은 일반 모드의 `endpoint: "pr"` 전용이고, `verify`·`commit` 또는 stacked PR 생성용 옵션이 아니다. 모드를 바꾸는 것도 계획 변경이므로 재승인이 필요하다.

## Orchestrator 운영과 사용자 승인

사용자는 계획과 실행 권한을 승인하고, 메인은 workflow의 수명 주기를 관리한다. 메인은 시작 명령을 사용자에게 대신 입력해 달라고 요청할 필요가 없다. 시작은 계획 작성 권한이지 구현·Git 전달 승인이 아니다.

| 도구 | 동작 |
| --- | --- |
| `workflow_preflight({ spec? })` | 현재 작업 공간이나 후보 계획의 차단 요인을 상태 변경 없이 확인한다. |
| `workflow_start({ goal, mode? })` | 새 계획을 시작한다. `mode`는 `single`(기본) 또는 `stack`이다. |
| `workflow_status({})` | 시작 전이나 완료 뒤에도 상태를 확인한다. |
| `workflow_pause({ reason })` | 관리 실행의 중단을 요청하고 일시정지한다. |
| `workflow_resume({})` | 메인이 정지했거나 시스템 중단으로 멈춘 작업을 실제 상태 확인 후 재개한다. |
| `workflow_cancel({ reason })` | 관리 실행을 취소한다. 성공 완료로 처리하거나 파일·커밋·PR을 삭제하지 않는다. |

도구로 시작한 계획도 `workflow_propose` 또는 `workflow_stack_propose`의 실제 승인 UI나 `/workflow approve`가 필요하다. 도구는 `auto`·승인자·강제 완료 인자를 받지 않으며, 앞선 workflow의 `--auto` 권한도 새 workflow로 넘기지 않는다. 메인이 완료를 선언하는 도구는 없고, 기존 검사·필수 검수·전달 확인이 끝나야 `completed`가 된다.

사용자의 `/workflow pause`, Esc, 실행 중단, `/workflow cancel`은 메인이 해제할 수 없는 중단이다. 메인이 다시 pause하거나 cancel한 뒤 start하는 방식으로도 우회할 수 없다. `workflow_block`으로 요청한 사용자 판단도 메인이 스스로 해제하지 못한다. 사용자는 일시정지를 `/workflow resume`으로 해제하고, 취소한 작업 뒤 새 작업은 `/workflow start`로 명시한다.

세션 재시작 자체는 자동 재개하지 않는다. 시스템 중단이 확인된 작업에는 메인이 `workflow_resume`을 호출할 수 있지만 사용자 중단은 재시작 뒤에도 유지한다. 출처가 없는 과거 정지·차단·취소 기록은 사용자 확인을 요구한다. 실행 중인 worker나 검사·원격 확인이 끝나지 않으면 다음 workflow를 시작하지 않는다. 재개 확인 도중 들어온 사용자 중단도 늦은 확인 결과보다 우선한다.

## Stacked 모드

`workflow_start({ goal: "목표", mode: "stack" })` 또는 `/workflow start --stack <목표>`로 스택을 명시하면 전체 계획을 한 번 승인하고 선형 스택의 Draft PR들을 순서대로 전달한다. `--stack`이 없으면 기존 단일 모드와 `verify`·`commit`·`pr` 종료 지점을 그대로 사용한다. 단일 모드의 `prBase` 지정은 PR 하나의 base 선택이며 스택 전체를 관리하지 않는다. 분기·합류가 있는 PR 그래프와 독립 요청의 후속 FIFO 대기열은 지원하지 않는다.

- `/workflow start --stack <목표>`는 읽기 전용 조사 후 `workflow_stack_propose`로 전체 계획을 제안하고 승인받는다.
- `/workflow start --stack --auto <목표>`는 같은 계획을 사용자 확인 없이 승인한다. `--auto --stack` 순서도 허용한다. `--stack` 또는 도구의 `mode: "stack"`은 PR 구성 방식이고, `--auto`는 사용자 명령에서만 켤 수 있는 계획 승인 방식이다.
- 승인 범위는 계획한 브랜치 생성·전환과 PR별 commit·push·Draft PR 전달을 포함한다. 같은 계획의 다음 PR마다 승인을 다시 요구하지 않는다. 실행 시작 후에는 `workflow_stack_replan`으로 미전달 구간의 변경을 제안한다. `--auto`가 범위 확장이나 이력 재작성 권한을 주지는 않는다.
- `rootBase`는 `stage` 또는 승인된 비보호 원격 feature 브랜치다. 승인 시 원격 SHA를 고정하며 해당 커밋 객체가 로컬에 없으면 멈춘다. 자동 fetch는 하지 않는다. 대상 브랜치는 보호 브랜치가 아니어야 하며 계획 시 로컬이나 원격에 이미 존재하면 거절한다.

`workflow_stack_propose` 계획 예제는 다음과 같다. 검사 명령과 필수 검수·CI 이름은 대상 프로젝트에 맞춰 지정한다. unit의 `id`와 `branch`는 각각 고유해야 하며, PR별 `checks`·`requiredReviews`와 전체 `integrationChecks`·`integrationReviews`는 비워둘 수 없다.

```json
{
  "title": "설정 기능 스택",
  "objective": "설정 기반과 UI를 두 PR로 나누어 전달한다",
  "nonGoals": ["merge와 배포"],
  "successCriteria": ["설정 기반과 UI의 통합 검사 및 필수 검수가 통과한다"],
  "rootBase": "stage",
  "replanPolicy": { "maxReplans": 2 },
  "units": [
    {
      "id": "foundation",
      "title": "설정 기반",
      "objective": "UI가 사용할 설정 기반을 추가한다",
      "branch": "feature/settings-foundation",
      "allowedPaths": ["src/settings/"],
      "checks": ["bun run test", "bun run typecheck"],
      "requiredReviews": ["code"],
      "ciChecks": []
    },
    {
      "id": "ui",
      "title": "설정 UI",
      "objective": "설정 기반을 사용하는 UI를 추가한다",
      "branch": "feature/settings-ui",
      "allowedPaths": ["src/settings/"],
      "checks": ["bun run test", "bun run typecheck"],
      "requiredReviews": ["code", "figma"],
      "ciChecks": []
    }
  ],
  "integrationChecks": ["bun run test", "bun run typecheck"],
  "integrationReviews": ["integration"],
  "maxImprovementCycles": 2,
  "maxRecoveries": 1
}
```

예제의 첫 PR은 `stage`, 두 번째 PR은 `feature/settings-foundation`을 base로 한다. `ciChecks: []`는 해당 PR의 원격 CI를 검사하지 않는다는 뜻이다. 프로젝트 필수 CI가 있으면 실제 check-run 이름을 계획에 명시해야 하며 빈 배열로 생략하지 않는다.

`replanPolicy`는 처음 승인할 때 범위 안의 재계획을 메인에 위임하는 선택 항목이다. `maxReplans`는 1~5이며, 자동 재계획의 횟수 한도도 승인 대상이다. unit의 `allowedPaths`에는 보완할 파일·디렉터리 범위를 적는다. 메인이 나중에 정책 필드를 추가한다고 위임 권한이 생기지는 않는다.

### 진행 중인 스택 재계획

메인은 실행 중인 worker·검사가 실제로 종료된 뒤 `workflow_stack_replan({ plan, reason, adoptChanges?, excludedRequirements? })`으로 현재 미전달 PR부터 뒤쪽 계획을 바꿀 수 있다. 이미 전달한 PR의 계획·커밋·부모·증거는 그대로 유지한다. 기존 스택을 취소하거나 새 workflow를 만들 필요가 없다.

처음 위임한 횟수 안에서 다음 조건을 모두 만족하면 승인창 없이 적용한다.

- 전체 목표·제외 범위·성공 기준·통합 검사·검수·한도·루트 부모를 유지한다.
- 미전달 PR의 id·브랜치·순서를 유지하고 검사·필수 검수·CI를 줄이지 않는다.
- 파일 허용 범위를 넓히거나 요구사항을 제외하지 않는다.

이 범위에서는 단위별 작업 설명을 보완하거나 검사를 추가할 수 있다. 위임이 없거나 목표·권한·검증 기준이 달라지면 변경 전후와 영향을 보여주고 사용자 승인을 받는다. `--auto`도 이 구분을 우회하지 않는다. 보류나 사전 검사 실패, 승인 중 작업 공간 변경이 발생하면 기존 계획·승인·증거를 남긴다.

작성 중인 파일은 `adoptChanges`로 명시적으로 인수한다. 자동 인수는 기존 unit의 `allowedPaths` 안에서만 가능하다. 새 unit의 허용 범위를 좁혔다면 인수 파일과 보완 범위도 그 안에 있어야 하며, 실행·전달에서는 인수 범위와 단위 범위를 모두 검사한다. 허용 범위를 정하지 않았거나 넓혀야 한다면 사용자 확인이 필요하다. 충돌·미종료 worker·변경된 원격 부모·사용자 중단을 인수나 재계획으로 우회하지 않는다. 이미 준비한 현재 브랜치는 관리 실행 기록과 부모 SHA를 확인해 이어 쓰며, 임시 커밋·stash·reset·rebase로 맞추지 않는다.

이전 계획과 현재 단위의 실행은 `stack.revisions`에 남긴다. 영향받은 검사·검수는 다시 수행하지만 과거 구현자의 검수 금지, 복구 의무, 개선 한도는 초기화하지 않는다. 사용자 승인으로 제외한 요구사항은 `excludedRequirements`에 남기고 완료와 구분한다. 최종 보고에는 전체 성공 기준의 충족 여부, PR 검토 순서, 검사·검수 결과, 제외·미완료 사항을 함께 제시한다.

### 실행과 완료 확인

실행 순서는 PR별 `prepare → implement → check → requiredReviews별 review → deliver`, 모든 PR 전달 후 `integration check → integrationReviews별 review → 최종 PR·CI 확인`이다.

- `workflow_dispatch`의 `role: "prepare"` worker가 첫 PR은 승인된 root SHA, 이후 PR은 직전 PR의 확인된 HEAD에서 브랜치를 생성·전환한다. 확장은 실제 브랜치·HEAD·깨끗한 작업 트리를 확인한다. 브랜치 생성·전환은 준비 worker만, commit·push·PR 생성은 전달 worker만 수행하며 메인과 확장은 직접 실행하지 않는다. 같은 작업 트리의 PR 작업은 순차 실행한다.
- 구현 뒤 `workflow_check`로 부모 변경을 포함한 누적 결과를 검사하고, 검수는 부모 대비 해당 PR 변경을 대상으로 한다. `workflow_dispatch`에 `role: "review"`, `reviewKey: "code"`처럼 계획의 키를 지정한다. `requiredReviews`가 하나일 때만 `reviewKey`를 생략할 수 있으며 복수 검수는 현재 증거에 연결된 결과가 모두 통과해야 전달한다.
- 전달 worker는 기존 commit·pr 스킬을 사용한다. 확장이 검수된 내용과 실제 커밋·원격 HEAD·Draft PR의 head/base를 확인해야 결과를 보관하고 다음 PR로 넘어간다. 실패한 PR을 건너뛰지 않는다.
- 통합 단계는 최상단 브랜치에서 전체 검사와 `integrationReviews` 검수만 수행한다. 통합 검수 agent는 모든 하위 PR의 구현 agent와 달라야 한다. 구현과 전달은 허용하지 않는다. 통합 검수 통과만으로 완료하지 않고 모든 PR의 유효한 결과, 원격 부모 관계, 열린 Draft PR의 URL·head·base, 최상단 HEAD와 깨끗한 작업 트리를 다시 확인한다.
- CI 확인은 고정된 PR 커밋 SHA에 대해 읽기 전용 `gh api repos/{owner}/{repo}/commits/<head>/check-runs --paginate --slurp`를 사용한다. 지정한 이름별 최신 실행(가장 큰 check-run ID)의 `head_sha`가 일치하고 `completed`·`success`여야 통과한다. 누락·대기·실패·조회 오류는 `blocked`로 멈추며 `resume`에서 다시 확인한다. 최종 원격 조회 뒤 로컬 상태와 의존관계도 재확인해야 전체 완료를 기록한다.

전체 계획·승인 버전·현재 PR·PR별 검사/검수/전달 결과는 같은 JSON 정본에 원자적으로 저장한다. 다음 PR으로 전환할 때 실행 세대를 바꾸므로 이전 worker의 늦은 결과는 현재 PR 완료에 쓰지 않는다. pause·Esc·cancel 뒤에는 다음 PR을 시작하지 않으며 cancel도 기존 커밋·PR을 삭제하지 않는다. 세션 재시작은 상태만 복원하고 자동 진행하지 않는다. `resume`은 실제 브랜치·커밋·원격·PR을 확인해 상태를 복구하며 전달 후 기록 전에 중단됐더라도 기존 결과를 확인해 중복 전달을 막는다. prepare 복구는 현재 PR의 실제 관리 prepare 시작 기록과 브랜치·부모 SHA·깨끗한 작업 트리를 함께 확인해 실행 기록 없는 외부 동명 브랜치를 거절하며, 세션 재시작으로 소유 세대가 바뀌어도 동일 PR의 기존 prepare 기록을 복구에 사용한다.

부모 커밋 변경을 감지하면 `invalidatedFrom`에 영향을 받는 시작 위치를 기록하고 해당 결과와 후속 결과를 `valid: false`로 표시한 뒤 멈춘다. 기존 검사·검수 기록은 남지만 완료 증거로 사용하지 않는다. 자동 restack·rebase·force push는 하지 않으며 `--auto`도 이 제한을 풀지 않는다.
