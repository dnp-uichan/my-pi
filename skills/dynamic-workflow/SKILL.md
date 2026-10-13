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

관련 코드·문서·조회 도구로 사실과 기존 패턴을 먼저 확인하고 목표·범위·성공 기준·종료 지점을 밝힌다. 인터뷰 깊이는 남은 불확실성과 실패 영향에 맞춘다. 아래 항목 중 필요한 내용만 정리하고, 결과를 바꾸는 미결정 정책·범위·성공 기준·허용 대안·실패 대응·전달 권한을 묶어서 확인한다. 이미 합의한 내용과 일상적인 기술 선택을 재질문하지 않으며 고정 질문 수·별도 인터뷰 문서·반복 승인 폼은 요구하지 않는다.

```markdown
## Workflow Scope
- Objective:
- Non-goals / do-not-do:
- Source of truth:
- Success criteria: 반증 가능한 술어로 (무엇을 실행·확인하면 done인지)
- Constraints: 시간/토큰/권한/외부 전송
- Endpoint: 단독 조사·설명·검수 등 요청 범위, 개발 흐름이면 검증까지·커밋까지·PR까지
- Delivery authority: 저장소·head/base·commit·push·Draft PR 권한
- Stop condition:
```

Success criteria를 체크 가능한 술어로 쓸 수 없으면 장기 실행을 시작하지 않는다. "잘 동작하게"는 술어가 아니다.

메인이 관련 코드와 적용되는 프로젝트 규칙을 읽고 요구사항·변경 계획·검증 방법을 정리한다. 이미 합의된 계획은 재사용한다. 범위와 실행이 승인돼 있으면 단계 전환마다 승인을 반복하지 않는다.

개발 변경이면 전역 지침의 기본 개발 흐름과 아래 연결 규칙을 따른다. 해당 시점의 단계 스킬만 읽고, 각 스킬이 전체 흐름을 다시 시작하지 않게 한다. `disable-model-invocation: true`인 스킬도 사용자가 승인한 기본 개발 흐름의 해당 단계로 사용할 수 있다. 조사·설명 또는 단계 단독 요청에는 이 연결을 강제하지 않는다. PRD·gap-check·test-triage·self-healing·simplify·stress-interview·large-feature-loop는 별도 선택 없이 추가하지 않는다. 선택한 hard나 복수 독립 검수의 고유 기준은 기본 흐름으로 줄이지 않는다. 서로 독립적인 요청과 하나의 결과물을 이루는 의존 PR들을 구분하고, 스택이면 PR별 결과·diff 경계·부모 관계·검토 순서·통합 완료 기준을 처음에 합의한다.

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
- 위임 프롬프트에 작업 범위, 적용 지침과 선택된 추가 제약, 테스트 잠금, 종료 지점과 금지 권한을 전달한다. worker가 임의로 단계 생략·테스트 완화·commit·push·PR을 하지 않도록 실행 권한을 구분한다. worker는 하위 worker·reviewer를 재귀 호출하지 않고 결과나 추가 분담 필요를 메인에 반환한다. 분담과 단계 연결은 메인이 맡는다.
- 승인된 개발/테스트 변경 범위의 최소 테스트 변경은 메인이 `test-write`의 '확정 후 테스트 잠금' 기준으로 필요성·독립 근거·영향을 확인해 보수적으로 결정한다. worker·reviewer·lint·simplifier는 제안과 근거를 반환하며, 메인이 승인한 구체적 변경 범위만 수정 역할에 위임한다. 단독 읽기 전용 요청의 범위와 사용자 명시 제한은 유지한다.
- 같은 파일을 고치는 worker를 병렬 실행하지 않는다.
- 긴 프롬프트/컨텍스트는 임시 markdown 파일로 쓰고 subagent에게 경로를 전달한다.
- 장기 인계·감사나 프로젝트 규칙상 결정 트레일이 필요한 경우에만 `show-me-your-work` 기준의 로그와 Attention 보고를 계획에 포함한다. 단순히 단계가 많다는 이유로 파일·별도 검수 체인을 추가하지 않는다.

### 4. Subagent 실행 지침

아래는 메인이 관리 모드 밖에서 사용하는 지침이다. 관리 모드에서는 `workflow_dispatch`를 사용하며 worker에게 오케스트레이션을 다시 맡기지 않는다. 현재 세션에서 `subagent help`를 확인하지 않았거나 인터페이스가 불명확하면 확인한다.

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
- 외부 전송, 삭제, 배포, 대량 변경, 비용 큰 작업은 권한 범위를 확인한다. 이미 승인한 실행은 재승인하지 않으며 승인 밖 권한·파괴적 Git·merge·배포·외부 메시지는 일반 개발이나 PR 목표로 허용된 것으로 보지 않는다.

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

- 개발 변경: 요구사항 충족, 관련 테스트·프로젝트 필수 검사, 독립 검수와 필요한 개선 확인. 테스트 변경은 위 `test-write` 기준의 재실행과 변경 타당성·누락·동등 이상 검출력 보존을 기존 독립 검수에서 확인한다. 새 전체 리뷰 체인을 자동 추가하지 않는다. 계획에 선택한 모든 필수 검수 관점이 끝나야 전달하며 첫 PASS로 나머지를 대체하지 않는다.
- UI·통합 변경: 영향을 받는 경계의 실제 동작 확인. 정적 분석만으로 대체하지 않는다.
- 데이터·문서 작업: 원문 근거, 주장 확인, 필요한 샘플 검산이나 구조 검사. 적용할 이유가 없는 코드 테스트를 만들지 않는다.
- 기록: 대상 상태/revision, 명령·검사 범위·실제 결과, 독립 검수 근거. 코드·설정·의존성·계약이 바뀌면 영향받은 증거를 갱신한다.

P0/P1, 필수 gate 실패·실행 불가 또는 다른 blocker가 남으면 다음 단계로 넘어가지 않는다. 테스트 실패는 즉시 원인 추정과 다음 조치를 보고한다. 합의한 범위·실패 대응·한도 안에서 보완·재검증하고, 합의 밖 결정·권한·검증 기준 변경이나 해결할 수 없는 인증/환경 문제만 사용자에게 확인한다.

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

코드 변경이 있었다면 파일 경로와 검증 명령을 명시한다. 실행하지 못한 검증은 이유와 사용자가 실행할 명령을 적는다. PR 종료 계획은 실제 전달 확인 후 PR 링크·검토 순서·주요 변경·검증·제외/후속 범위를 반환하며, 로컬 구현이나 테스트 통과만으로 완료하지 않는다.

## 기본 개발 흐름 연결

`plan`·`test-plan` 기준으로 준비한 뒤 `test-write → implement → lint → review → 개선·재검증 → commit → pr` 순서로 진행한다. 단계는 품질 기준이고 작업 분담 단위는 실제 의존관계다. 병렬 구현도 합의된 테스트가 준비된 범위에서 시작하고, 전체 검수는 병렬 결과가 합쳐진 상태를 대상으로 한다.

- 적용할 이유가 없는 단계는 근거와 대체 검증을 기록한다. 필요한 테스트·검수와 프로젝트 필수 검사는 생략하지 않는다. 현재 호출에서 선택한 추가 제약이 있으면 함께 적용한다.
- 테스트 작성의 증거: 의도한 Red, 기존 동작 회귀 테스트의 통과, 구현 미존재로 인한 실행 불가를 구분한다. 구현 미존재 항목은 Green 단계에서 실제 동작 검증을 확인한다. 러너·환경 오류는 Red 통과가 아니다.
- 개선: 확인된 리뷰 지적만 승인 범위에서 수정한다. `implement`의 테스트 보호 규칙을 재사용하고 수정 후 검증과 독립적인 해결 확인을 한다. 지적이 없으면 변경 없이 통과한다.
- 권한: 실행 옵션 자체는 commit·push·PR 권한이 아니다. 개발 요청만 있으면 개선·재검증까지 진행하고, 명시한 종료 지점과 금지사항을 따른다. PR까지 허용됐으면 필요한 commit·push·PR 승인을 반복하지 않는다. commit·push·PR은 관리 모드가 아니거나 관리 모드 전달 경로를 쓸 수 없을 때도 메인이 직접 실행하지 않고 commit·pr 스킬을 읽는 worker에게 위임한다. merge·배포로 확장하지 않는다.

스킬은 각 단계의 기준만 담당한다. `stress-interview`, `self-healing`, `simplify`는 사용자가 별도로 선택한 경우에만 연결하며 기본 흐름에 추가하지 않는다.

## 관리 모드 (`/workflow`)

`workflow-controller` 확장은 승인·검사·독립 검수·중단·전달 조건을 관리하고 메인은 조사·필요한 인터뷰·판단·분담을 맡는다. 현재 계약은 확장의 `README.md`와 실제 도구/schema에서 확인한다. subagent 관리 API v1과 `thinking` 지원이 없으면 시작이 거절되며 지침으로 대신 진행하지 않는다.

테스트 변경 판단 위임은 관리 스키마·안전 gate 변경 권한이 아니다. 검사 목록(`checks` 등)·`requiredReviews`·`allowedPaths`·사용자 hold/stop·locked revision·전달 worker의 파일 내용 수정 금지와 기존 커밋 모드의 수정 금지를 우회하지 않는다.

### 시작·합의·승인

- 메인은 `workflow_start({ goal, mode? })`로 시작한다. `mode`는 `single`(기본) 또는 `stack`이다. 사용자의 `/workflow start [--stack] [--auto] <목표>`도 지원한다. 도구 시작은 구현·전달 승인이나 auto 권한이 아니며 이전 작업의 권한을 상속하지 않는다.
- 읽기 전용 조사 뒤 필요한 미결정 사항만 인터뷰한다. 목표·제외 범위·성공 기준·수정 범위·허용 대안·실패 대응·보완/복구 한도·전달 권한을 기존 계획 필드에 담고 요약을 본문으로 먼저 설명한다. 개발 흐름에서 사용자가 더 이른 종료를 명시하지 않았으면 `endpoint: "pr"`를 제안한다. 단독 조사·설명·검수 요청은 해당 범위에서 끝내며, PR 제안은 schema 기본값이나 자동 권한이 아니다.
- 단일 계획은 `workflow_propose`, 스택 계획은 `workflow_stack_propose`의 실제 승인 UI 또는 `/workflow approve`로 한 번 승인받는다. 사용자가 명시적으로 `/workflow start --auto`로 시작한 경우에만 안전 조건을 통과한 제안이 자동 승인된다. `--auto`는 미결정 정책·범위 확장·사용자 중단을 우회하지 않으며 도구 인자로 켤 수 없다.
- 단일 `endpoint: "pr"`의 `prBase`는 기본 `stage`, 승인된 stacked base는 보호 브랜치가 아닌 기존 원격 feature 브랜치다. `requiredReviews`에 선택한 모든 검수 키를 명시한다. 생략 시 `code` 하나이므로 성공 기준에 적은 복수 검수가 자동 등록된다고 가정하지 않는다.

### 사전 확인·기존 산출물

- 전환을 권하거나 기존 작업을 취소하기 전에 `workflow_preflight({ spec? })`로 현재 상태와 후보 **단일** 계획의 승인 가능성을 확인한다. 상태·파일·실제 index를 바꾸지 않으며 결과는 승인·재개 권한이 아니다. 이 조회가 스택 계획 전체의 적합성까지 보장하지 않는다.
- 기존 미커밋 변경은 일반 `commit`·`pr` 계획의 `adoptChanges`로 명시 인수한다. `paths`는 rename 원본·대상을 포함한 현재 변경 전체, `allowedPaths`는 정확한 파일 또는 `/`로 끝나는 디렉터리 범위다. 무관한 변경과 부분 인수는 거절하며 승인 뒤 범위 안의 보완은 재승인하지 않되 검사·검수 증거를 갱신한다. 인수가 없으면 전달 계획의 clean 조건을 유지한다.
- 이미 만들어진 커밋은 일반 `endpoint: "pr"`의 `deliveryMode: "existing-commit"`으로 승인 SHA를 그대로 전달한다. 새 커밋·파일 수정·구현 worker는 금지하며 현재 workflow의 검사·필수 검수는 유지한다. `adoptChanges`와 함께 쓰거나 `verify`·`commit`·최초 스택 옵션으로 확대하지 않는다. 기존 커밋을 전달하려고 빈 커밋·stash·이력 재작성을 만들지 않는다.

### 실행·검수·전달

- 구현·조사·검수는 메인이 `workflow_dispatch`로 실행한다. 모델은 사용자 지정값과 agent 설정을 유지한다. `thinking`은 난이도에 맞춰 `low`·`medium`·`high`·`xhigh` 중 선택하고 생략하면 agent 기본값이다. 메인의 관리되지 않는 `subagent` 실행과 직접 Git 전달은 확장이 막지만 OS 수준 격리는 아니다. worker는 하위 worker를 호출하지 않는다.
- 구현 완료 보고는 완료가 아니다. `workflow_check`의 검사 통과 뒤 `role: "review"`로 구현 agent와 다른 검수 agent를 실행한다. 복수 필수 검수는 각 `reviewKey`를 지정한다. 현재 verification 세대·시작/종료 작업 트리 지문에 연결된 `WORKFLOW_VERDICT: pass`가 모든 필수 키에 있어야 통과한다. 판정 누락·실패·형식 오류와 오래된 결과는 통과가 아니다.
- 실패·중단된 구현은 `workflow_recover`로 실제 HEAD·작업 공간 상태를 기록한 뒤 다시 실행한다. 승인 범위·한도 안의 실패·보완·재검증은 재승인하지 않는다. 사용자 판단이 필요한 합의 밖 변경·권한·검증 기준이나 해결할 수 없는 인증/환경 문제는 `workflow_block`으로 멈추고 묻는다.
- `verify`는 필수 검수 통과로 종료한다. `commit`·`pr`은 `ready-to-deliver` 뒤 `role: "deliver"`의 전달 worker(기본 `worker`, `main` 컨텍스트)가 commit·pr 스킬을 직접 읽고 승인된 단계만 수행한다. 기존 커밋 모드는 pr만 수행한다. 이미 완료한 단계는 반복하지 않으며 worker 재귀 호출·파일 내용 수정·merge·배포·force push·amend·rebase·reset은 금지한다.
- 확장은 승인 브랜치·검수된 최종 트리·커밋·깨끗한 작업 트리를 확인하고, `pr`이면 실제 원격 HEAD·열린 Draft PR의 head/base까지 확인해야 완료한다. 실패하면 `blocked`로 멈추며 부분 전달 기록을 보존한다. pr 스킬의 assignee·reviewer·본문 기준을 확장이 대신 검사한다고 주장하지 않는다.

### 선형 Stacked PR

- `mode: "stack"` 또는 사용자의 `--stack`으로 명시 선택한다. 단일 `prBase` 지정은 PR 하나의 base 선택이며 스택 전체 관리가 아니다. 분기·합류 PR 그래프와 독립 요청 FIFO는 지원하지 않는다.
- `rootBase`·PR별 결과·브랜치·부모 관계·검토 순서·`checks`·`requiredReviews`·`ciChecks`, 전체 `integrationChecks`·`integrationReviews`를 처음에 합의한다. 필수 CI는 실제 이름으로 지정한다. 최초 스택은 clean 작업 트리와 아직 존재하지 않는 대상 브랜치가 필요하며 일반 인수 사전 검사 결과로 이 조건을 대체하지 않는다.
- PR별 `prepare → implement → check → requiredReviews별 review → deliver`, 전체 전달 후 `integration check → integrationReviews별 review → 최종 PR·CI 확인` 순서다. 승인 root SHA 또는 직전 확인 HEAD에서 `role: "prepare"` worker만 브랜치를 생성·전환한다. 같은 작업 트리의 PR 작업은 순차 실행하고 같은 계획의 PR마다 사용자 리뷰·재승인을 기다리지 않는다.
- 통합 검수 agent는 모든 하위 PR 구현 agent와 달라야 한다. 통합 단계는 검사·검수만 허용하며 모든 PR·원격 부모·Draft PR head/base·필수 CI·최상단 HEAD·clean 상태 확인까지 끝나야 전체 완료다. 실패한 PR을 건너뛰거나 통합 PASS만으로 완료하지 않는다.
- 실행 중 미전달 구간의 조정은 `workflow_stack_replan`을 사용한다. 최초 `replanPolicy.maxReplans` 위임과 `allowedPaths` 안에서 목표·제외 범위·성공 기준·통합 검사·검수·한도·root·미전달 id/브랜치/순서를 유지하고 검증을 줄이지 않을 때만 승인 없이 적용한다. 그 밖은 실제 사용자 승인 대상이며 `--auto`로 우회하지 않는다. 재계획의 `adoptChanges`는 최초 스택 인수 옵션이 아니다. 이미 전달한 PR·부모·증거와 과거 구현자의 검수 금지·복구 의무·개선 한도를 보존한다. 부모 변경은 차단하며 자동 restack·rebase·force push하지 않는다.

### 중단·재개

- 메인은 `workflow_status`·`workflow_pause({ reason })`·`workflow_resume({})`·`workflow_cancel({ reason })`로 운영할 수 있다. 시스템/메인 중단만 실제 상태 확인 뒤 도구로 재개한다. 사용자의 pause·Esc·cancel·실행 중단과 `workflow_block` 판단 보류는 사용자만 해제하며 다른 시작·취소로 우회하지 않는다.
- 세션 재시작은 자동 재개하지 않는다. 미종료 worker·검사·전달 확인이 있으면 다음 작업을 시작하지 않는다. 한도 초과·출처 불명 과거 중단은 사용자 판단 대상이며 취소는 파일 rollback이나 PR 삭제가 아니다.
- 완료·정지 기준은 `references/omo-managed-contract.md`를 따른다. 이 발췌문은 SUL-1.0 대상이다.

## Safety

- untrusted public content를 읽은 agent에게 고권한 액션을 맡기지 않는다. 읽기/분류 agent와 실행 agent를 분리한다.
- secret, token, 개인정보를 subagent 프롬프트에 불필요하게 넣지 않는다.
- destructive action, push, deploy, 외부 메시지 전송은 사용자 명시 승인 없이는 수행하지 않는다.
- token/time budget을 명시할 수 있으면 명시한다. 작은 slice로 먼저 검증하는 것을 선호한다.
