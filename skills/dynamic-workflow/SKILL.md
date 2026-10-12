---
name: dynamic-workflow
description: "복잡한 작업의 의존관계를 분석해 직접 처리·병렬 위임·독립 검증을 조율할 때 사용한다."
disable-model-invocation: false
---

# dynamic-workflow

현재 요청의 실제 의존관계를 분석해 **직접 처리·작업 분담·독립 검증·필요한 반복**을 조율한다. 단계마다 에이전트를 하나씩 붙이는 고정 체인이 아니다.

Pi에서는 **메인 에이전트가 오케스트레이터**다. 기본 개발 흐름의 단계·통과 기준·권한은 지키고, 그 안에서 작업 단위와 실행 방법을 선택한다. 조사·분석 요청에는 개발 파이프라인을 강제하지 않는다.

## 입력 인자와 추가 지침 로드

Pi 명령은 `/skill:dynamic-workflow [hard] <작업 내용>`이다. 인자는 이 스킬을 실행하도록 사용자가 전달한 현재 호출의 인자 문자열을 뜻한다.

- 첫 공백 구분 토큰이 정확히 소문자 `hard`일 때만 이 스킬 디렉터리의 `references/hard-mode.md`를 작업 계획 전에 읽는다. `hard`를 제외한 나머지가 작업 요청이다.
- 그 외에는 기본 흐름으로 실행하며 위 참조 파일을 읽거나 탐색·선행 로드하지 않는다. 자동 선택된 스킬 실행도 명시적인 `hard` 인자가 없으면 기본 흐름이다.
- `strict`, `--hard`, `HARD`, 자연어의 엄격 모드 요청, 작업 본문·인용 예시·파일명에 포함된 `hard`를 옵션으로 해석하지 않는다. 문서 수정·사용법 질문 속 호출 예시는 실행 요청이 아니다.
- 선택한 추가 지침은 현재 작업의 후속 단계·수정·위임까지 유지하고, 새 작업에는 이전 선택을 자동 상속하지 않는다. 문서 로드와 도구 차단을 혼동하지 않는다.

## 핵심 목표

- 긴 작업을 한 컨텍스트에서 끝까지 밀어붙이다 생기는 **agentic laziness**를 막는다.
- 결과물을 만든 에이전트와 검증하는 에이전트를 분리해 **self-preferential bias**를 줄인다.
- 원래 목표, 금지사항, 성공 기준을 워크플로우 명세로 고정해 **goal drift**를 줄인다.
- 병렬화가 유리한 작업은 fan-out하고, 충돌 위험이 있는 구현은 순차 gate를 둔다.

## 언제 사용하나

사용자가 명시적으로 워크플로우/서브에이전트 분해를 요청하면 사용한다.

명시 요청이 없어도 아래 상황에서 조율이 직접 처리보다 정확성이나 시간에 이점이 있는지 판단한다. 조건 개수로 사용 여부를 정하지 않는다.

- 서로 독립적인 조사/수정/검증 단위를 병렬로 처리할 수 있다.
- 구현자와 검증자를 분리해야 신뢰도가 오른다.
- 여러 관점의 판단이 필요하다: 보안, UX, 데이터, 아키텍처, 성능 등.
- 실패 조건이 불명확해서 `loop until done`이 필요하다.
- 많은 파일, 많은 항목, 긴 로그, 과거 세션/이슈/슬랙/문서 등 대량 컨텍스트가 있다.
- 단일 컨텍스트로 진행하면 중간 결과가 오염되거나 잊힐 가능성이 크다.

사용하지 않는 경우:

- 짧은 질의응답이나 조율 비용이 더 큰 단순 작업은 메인이 직접 처리한다. 개발 작업의 필요한 검증·독립 검수는 유지한다.
- 사용자가 직접 처리를 원하면 분담을 강요하지 않는다.
- 작은 작업에도 이 흐름을 명시적으로 선택할 수 있지만 구현 worker를 억지로 추가하지 않는다.
- 같은 파일을 바꿔야 하거나 공통 계약이 미확정이면 해당 부분을 순차 처리하고, 이후 독립적인 영역만 병렬화한다.

## Workflow

### 1. Scope lock

목표·범위·성공 기준·종료 지점을 먼저 밝힌다. 아래 항목 중 필요한 내용을 짧게 정리하며 고정 양식이나 파일 저장은 요구하지 않는다. 중요한 결정이 모호하면 `ask_user_question`으로 확인한다.

```markdown
## Workflow Scope
- Objective:
- Non-goals / do-not-do:
- Source of truth:
- Success criteria: 반증 가능한 술어로 (무엇을 실행·확인하면 done인지)
- Constraints: 시간/토큰/권한/외부 전송
- Endpoint: 검증까지·커밋까지·PR까지 등 요청 범위
- Stop condition:
```

Success criteria를 체크 가능한 술어로 쓸 수 없으면 장기 실행을 시작하지 않는다. "잘 동작하게"는 술어가 아니다.

메인이 관련 코드와 적용되는 프로젝트 규칙을 읽고 요구사항·변경 계획·검증 방법을 정리한다. 이미 합의된 계획은 재사용한다. 범위와 실행이 승인돼 있으면 단계 전환마다 승인을 반복하지 않는다.

개발 변경이면 전역 지침의 기본 개발 흐름과 아래 연결 규칙을 따른다. 해당 시점의 단계 스킬만 읽고, 각 스킬이 전체 흐름을 다시 시작하지 않게 한다. `disable-model-invocation: true`인 스킬도 사용자가 승인한 기본 개발 흐름의 해당 단계로 사용할 수 있다. 조사·설명 또는 단계 단독 요청에는 이 연결을 강제하지 않는다. PRD·gap-check·test-triage·self-healing·simplify는 별도 선택 없이 추가하지 않는다.

### 2. Pattern 선택

먼저 작업 단위별로 목표·변경 범위·선행 조건·공유 파일·완료 증거를 정한다. 한 곳의 로직 수정은 직접 처리하고, 독립 영역은 병렬화하며, 공통 타입·API 계약은 먼저 확정한다. 원인이 불명확하면 독립 조사 결과를 합친 뒤 구현한다. 파일 개수나 스킬 이름만으로 분담하지 않는다.

그 뒤 아래 패턴 중 실제로 도움이 되는 방법을 선택한다. 분류 자체를 별도 에이전트에 맡길 필요는 없다.

| Pattern                  | 언제 쓰나                                 | Pi 실행 방식                                                      |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------- |
| classify-and-act         | 작업 종류/위험도/모델 선택이 먼저 필요                | `worker` 또는 `challenger`에게 분류 요청                             |
| fan-out-and-synthesize   | 많은 파일/항목/문서/소스를 독립 처리                 | `subagent batch --isolated` 또는 `--main` 후 메인에서 종합             |
| worker→verifier→reviewer | 구현 태스크 품질 게이트                         | `subagent chain` (worker→verifier→reviewer)                   |
| adversarial verification | 사실/코드/설계 검증 신뢰도 향상 | 필요한 검증 역할을 병렬 실행. `stress-interview` 전체 절차는 명시 요청 시에만 사용 |
| generate-and-filter      | 아이디어/해결책 다수 생성 후 선별                   | 여러 `worker` → `reviewer` 필터                         |
| tournament               | 설계/이름/접근법 비교 판단                       | N개 후보 생성 → pairwise judge/reviewer                            |
| loop until done          | 원인 불명 버그, flaky test, 반복 triage       | stop condition + max cycles를 정하고 반복                           |
| quarantine triage        | Slack/리뷰/공개 입력 등 untrusted content 처리 | 읽기 전용 agent와 실행 agent를 분리                                     |

### 3. Workflow spec 작성

서브에이전트를 띄우기 전에 실행 계획을 `todo_write`에 반영한다. 각 단위의 책임·선행 조건·완료 증거와 충돌 방지 방법이 드러나면 되며 아래 양식을 전부 채울 필요는 없다.

```markdown
## Adaptive Workflow Plan
- Pattern(s):
- Work units:
  1. [unit] owner agent / mode(main|isolated) / expected output / validation
- Parallel groups:
- Sequential gates:
- Conflict risks:
- Verification gates:
- Max cycles / budget:
- Human approval gates:
```

규칙:

- 한 번에 정확히 하나의 `todo_write` 항목만 `in_progress`로 둔다.
- 독립 fan-out 결과는 반드시 synthesis barrier에서 합친다.
- 개발 변경의 검수는 구현자와 다른 컨텍스트의 `reviewer` 1개를 기본으로 한다. 같은 최신 상태에 대한 독립 검수 결과는 재사용하고, 위험에 따라 필요한 관점을 추가한다. `verifier` 실행 자체가 요구사항·AGENTS 준수 검수를 대신하지는 않는다.
- 위임 프롬프트에 작업 범위, 적용 지침과 선택된 추가 제약, 테스트 잠금, 종료 지점과 금지 권한을 전달한다. worker가 임의로 단계 생략·테스트 완화·commit·push·PR을 하지 않도록 실행 권한을 구분한다.
- 같은 파일을 고치는 worker를 병렬 실행하지 않는다.
- 긴 프롬프트/컨텍스트는 임시 markdown 파일로 쓰고 subagent에게 경로를 전달한다.
- 장기 실행·다수 사이클·사용자가 자리를 비우는 워크플로우는 `show-me-your-work` 스킬의 `decisions.tsv` 결정 로그를 유지하고, 최종 보고를 Attention 섹션으로 마무리한다.

### 4. Subagent 실행 지침

먼저 현재 세션에서 `subagent help`를 확인하지 않았거나 인터페이스가 불명확하면 확인한다.

- 독립 작업: `subagent batch [--main|--isolated] --agent <agent> --task "..." ...`
- 의존 작업: `subagent chain [--main|--isolated] --agent <agent> --task "..." --agent <agent> --task "..."`
- 단일 위임: `subagent run <agent> [--main|--isolated] -- <task>`

모드 선택:

- `--main`: 같은 repo의 최신 변경/컨텍스트를 공유해야 하는 구현·검증.
- `--isolated`: 독립 조사, 아이디어 생성, 반론, 오염 방지 검증.

주의:

- `--` 뒤로 넘기는 task 본문에 apostrophe(`'s`, `won't` 등)가 들어가면 CLI가 "Unclosed quote"로 거절한다. apostrophe를 제거하거나, task를 `.tmp/*.md`에 적고 `subagent run <agent> -- read PATH and follow the instructions there` 패턴으로 우회한다.
- 실행 직후 바로 `status/detail`로 폴링하지 않는다. 자동 완료/실패 follow-up을 기다린다.
- 읽기 전용 역할(challenger, reviewer, verifier)에는 파일 산출물을 요구하지 않는다. write/셸 도구가 없어 조용히 불이행될 수 있다. 결과는 응답 본문으로 받고, 보존이 필요하면 메인 에이전트가 파일로 저장한다.
- `continue`는 최신 메인 컨텍스트를 자동 동기화하지 않으므로, 이어서 필요한 변경사항/결론을 프롬프트에 명시한다.
- 외부 전송, 삭제, 배포, 대량 변경, 비용 큰 작업은 사용자 승인 gate를 둔다.

#### Failed write-capable run recovery

실패하거나 중단된 write-capable subagent를 retry, continue, 재할당하기 전에 실패 로그와 그 실행이 실제로 사용한 workspace를 확인한다. `--main`이면 공유 worktree를, `--isolated`이면 해당 isolated worktree를 직접 확인하며 호출자의 깨끗한 worktree를 대리 증거로 사용하지 않는다.

Git workspace라면 `HEAD`, worker commit 유무, `git status --short`, staged/unstaged diff, 관련 untracked output을 기록한다. 관찰된 결과를 `complete | partial | unknown`으로 분류하고, 다음 프롬프트에 그 상태와 이어서 사용할 worktree 또는 revision을 명시한다. 실패가 write를 원자적으로 rollback했다고 가정하지 않는다.

로그가 없으면 확인하지 못한 범위를 기록한다. 실제 workspace를 확인할 수 없으면 gate 미충족으로 보고 retry나 재할당 전에 사용자에게 에스컬레이션한다. 이 gate는 commit을 강제하지 않는다. 다음 worker나 verifier가 같은 worktree, 또는 workflow의 commit 제약이 허용한 명시적 commit/patch를 통해 동일 상태를 검사할 수 있으면 된다.

### 5. Role routing

현재 사용 가능한 에이전트를 확인해야 하면 `list-agents`를 호출한다.

- `searcher`: 파일 탐색, 코드베이스/문서/웹 리서치.
- `worker`: 맡은 범위의 목표 분해, 설계, 구현, 다중 파일 수정. 전체 계획과 오케스트레이션은 메인이 소유한다.
- 모델: 에이전트별 사용자 지정값을 우선하고, 미지정 시 런타임 기본값을 따른다. 편의상 메인 모델을 강제하지 않는다.
- `verifier`: 테스트/타입체크/빌드/재현 증거.
- `reviewer`: correctness, regression, maintainability 리뷰.
- `challenger`: 숨은 가정, 실패 시나리오, 반론.
- `security-auditor`: auth, secret, injection, data boundary 등 보안 이슈.
- `browser`: UI/브라우저 검증.
- `code-cleaner`: 재사용성, 품질, 단순화.

### 6. Verification gate

각 작업 단위는 시작할 때 정한 성공 기준을 모두 충족해야 완료다. 증거 하나로 다른 필수 gate를 대체하지 않는다.

- 개발 변경: 요구사항 충족, 관련 테스트·프로젝트 필수 검사, 독립 검수와 필요한 개선 확인.
- UI·통합 변경: 영향을 받는 경계의 실제 동작 확인. 정적 분석만으로 대체하지 않는다.
- 데이터·문서 작업: 원문 근거, 주장 확인, 필요한 샘플 검산이나 구조 검사. 적용할 이유가 없는 코드 테스트를 만들지 않는다.
- 기록: 대상 상태/revision, 명령·검사 범위·실제 결과, 독립 검수 근거. 코드·설정·의존성·계약이 바뀌면 영향받은 증거를 갱신한다.

P0/P1, 필수 gate 실패·실행 불가 또는 다른 blocker가 남으면 다음 단계로 넘어가지 않는다. 테스트 실패는 즉시 원인 추정과 다음 조치를 보고한다. 판단이 필요한 이슈는 사용자에게 확인한다.

### 7. Loop policy

반복형 워크플로우는 시작 전에 종료 조건을 둔다.

- 완료 종료: 합의한 성공 기준과 필수 gate를 모두 충족했고 미해결 blocker가 없다.
- 미완료 중단: 반복 한도·예산에 도달했거나 진행에 필요한 결정·권한·환경이 없다.

무한 루프는 금지한다. 기본 최대 2~3 cycles 안에서 작업에 맞는 한도를 정한다. 더 필요하면 현재 결과와 남은 문제를 보고하고 확인받는다. 새로운 지적이 없다는 사실, 테스트만 통과했다는 사실, 시간 한도에 도달했다는 사실을 전체 완료로 오인하지 않는다.

수정 후에는 영향받은 테스트·정적 분석과 지적 해결을 독립적으로 확인한다. 영향이 넓어지지 않았다면 전체 조사·리뷰를 처음부터 반복하지 않는다.

### 8. Synthesis and final report

최종 응답은 짧게 다음을 포함한다.

```markdown
## Workflow Result
- Pattern used:
- Agents used:
- Completed work units:
- Validation evidence:
- Remaining risks:
- Next step:
```

코드 변경이 있었다면 파일 경로와 검증 명령을 명시한다. 실행하지 못한 검증은 이유와 사용자가 실행할 명령을 적는다.

## 기본 개발 흐름 연결

`plan`·`test-plan` 기준으로 준비한 뒤 `test-write → implement → lint → review → 개선·재검증 → commit → pr` 순서로 진행한다. 단계는 품질 기준이고 작업 분담 단위는 실제 의존관계다. 병렬 구현도 합의된 테스트가 준비된 범위에서 시작하고, 전체 검수는 병렬 결과가 합쳐진 상태를 대상으로 한다.

- 적용할 이유가 없는 단계는 근거와 대체 검증을 기록한다. 필요한 테스트·검수와 프로젝트 필수 검사는 생략하지 않는다. 현재 호출에서 선택한 추가 제약이 있으면 함께 적용한다.
- 테스트 작성의 증거: 의도한 Red, 기존 동작 회귀 테스트의 통과, 구현 미존재로 인한 실행 불가를 구분한다. 구현 미존재 항목은 Green 단계에서 실제 동작 검증을 확인한다. 러너·환경 오류는 Red 통과가 아니다.
- 개선: 확인된 리뷰 지적만 승인 범위에서 수정한다. `implement`의 테스트 보호 규칙을 재사용하고 수정 후 검증과 독립적인 해결 확인을 한다. 지적이 없으면 변경 없이 통과한다.
- 권한: 실행 옵션 자체는 commit·push·PR 권한이 아니다. 개발 요청만 있으면 개선·재검증까지 진행하고, 명시한 종료 지점과 금지사항을 따른다. PR까지 허용됐으면 필요한 commit·push·PR 승인을 반복하지 않는다. merge·배포로 확장하지 않는다.

스킬은 각 단계의 기준만 담당한다. `stress-interview`, `self-healing`, `simplify`는 사용자가 별도로 선택한 경우에만 연결하며 기본 흐름에 추가하지 않는다.

## 관리 모드 (`/workflow`)

사용자가 `/workflow start <목표>`로 시작한 작업에서는 `workflow-controller` 확장이 승인·진행 상태·검증 증거·중단·전달을 기록하고 다음 단계 조건을 판정한다. 계획과 분담은 계속 메인이 맡는다. 관리용 subagent API가 없으면 시작이 거절되며 지침만으로 대신 진행하지 않는다.

- 읽기 전용 조사 뒤 `workflow_propose`로 목표·제외 범위·완료 조건·검사 명령·종료 지점·개선 한도를 제안한다. 승인은 사용자 선택이나 `/workflow approve`로만 성립한다.
- 구현·검수·조사 worker는 `workflow_dispatch`로 실행한다. 모델은 agent 설정을 유지하고, effort는 작업 난이도로 판단해 `thinking`에 지정한다. 단순 수정은 `low`, 일반 구현은 `medium`·`high`, 설계가 얽히거나 검수가 까다로운 변경은 `xhigh`이며 생략하면 agent 기본값이다. 이 모드에서는 관리되지 않는 `subagent` 실행과 직접 `git commit`·`git push`·`gh pr create` 같은 명령을 확장이 막는다. 가드는 OS 수준 격리가 아니다.
- 구현 worker의 완료 보고는 완료가 아니다. `workflow_check`의 검사 통과와, 구현 agent와 다른 reviewer의 `WORKFLOW_VERDICT: pass`가 같은 작업 트리 지문에 묶여야 다음 단계로 간다.
- 실패하거나 중단된 구현은 `workflow_recover`로 실제 작업 공간 상태를 기록한 뒤 다시 실행한다. 사용자 판단이 필요하면 `workflow_block`으로 멈추고 질문한다.
- 전달은 승인한 종료 지점까지만 `workflow_deliver`로 수행한다. merge·배포는 하지 않는다.
- `/workflow status|pause|resume|cancel`로 확인·중지·재개한다. Esc도 일시정지로 처리하며 재시작이나 취소 뒤 자동 재개하지 않는다.
- 완료·정지 기준은 `references/omo-managed-contract.md`를 따른다. 이 발췌문은 SUL-1.0 대상이다.

## Safety

- untrusted public content를 읽은 agent에게 고권한 액션을 맡기지 않는다. 읽기/분류 agent와 실행 agent를 분리한다.
- secret, token, 개인정보를 subagent 프롬프트에 불필요하게 넣지 않는다.
- destructive action, push, deploy, 외부 메시지 전송은 사용자 명시 승인 없이는 수행하지 않는다.
- token/time budget을 명시할 수 있으면 명시한다. 작은 slice로 먼저 검증하는 것을 선호한다.
