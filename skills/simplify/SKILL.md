---
name: simplify
description: 명시 요청 전용 코드 단순화. 기본은 code-cleaner 1개와 reviewer 3개 검토 후 simplifier 수정이며, light를 명시하면 code-cleaner 1개 검토 후 메인이 수정·검증한다.
argument-hint: "[light] <대상 변경사항>"
disable-model-invocation: true
---

# simplify

Review all changed files for reuse, quality, efficiency, and ponytail-style over-engineering. Fix any behavior-preserving issues found.

## 호출과 모드

사용자가 simplify 실행을 명시적으로 요청했거나, 명시적으로 선택한 상위 워크플로의 하위 단계일 때만 사용한다. lint, gap-check, dynamic-workflow 완료 후 자동으로 붙이지 않는다.

- 기본: code-cleaner 1개 + reviewer 3개를 병렬 실행한 뒤 simplifier가 수정한다.
- 인자의 첫 토큰이 `light`일 때만: code-cleaner 1개가 아래 네 관점을 함께 검토하고 메인이 판단·수정·검증한다.
- 작업이 작다는 이유로 light를 자동 선택하지 않는다.
- 사용자 지정 에이전트 모델을 우선하고, 지정하지 않은 모델은 런타임 기본값을 따른다. 메인 모델로 강제 덮어쓰지 않는다.
- 분담과 단계 연결은 메인 또는 선택된 상위 흐름이 맡는다. worker는 하위 에이전트를 재귀 호출하지 않고 맡은 결과를 반환한다. 관리 모드에서는 네 검토를 계획의 서로 다른 `requiredReviews` 키에 담고 `workflow_dispatch`의 `role: "review"`·`reviewKey`로 실행한다. 수정은 `role: "implement"`, 검증은 `workflow_check`를 사용한다. light에서도 하나의 검토와 수정·검증 기준을 유지하며 관리 흐름의 수정은 구현 역할로 분담한다.

## Phase 1: Identify Changes

Run `git diff` (or `git diff HEAD` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Review

light 모드에서는 `code-cleaner` 하나에 아래 재사용·품질·효율·과설계 네 관점과 보호 규칙을 모두 전달한다. 검토가 끝나면 Phase 3의 메인 수정으로 진행한다.

기본 모드에서는 다음 네 에이전트를 사용한다.

관리 모드 밖에서는 `subagent` 도구의 `subagent batch`로 네 에이전트를 **한 번의 호출에서 병렬로** 실행한다. 관리 모드에서는 앞서 정한 필수 검수 키별 dispatch로 네 관점을 유지한다. 각 에이전트에는 전체 diff를 넘겨 동일한 컨텍스트를 공유한다. 인터페이스가 불분명하면 먼저 `subagent help`로 확인한다.

### Agent 1: Code Reuse Review (`code-cleaner`)

For each change:

1. **Search for existing utilities and helpers** that could replace newly written code. Look for similar patterns elsewhere in the codebase — common locations are utility directories, shared modules, and files adjacent to the changed ones.
2. **Flag any new function that duplicates existing functionality.** Suggest the existing function to use instead.
3. **Flag any inline logic that could use an existing utility** — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns are common candidates.

### Agent 2: Code Quality Review (`reviewer`)

Review the same changes for hacky patterns:

1. **Redundant state**: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls
2. **Parameter sprawl**: adding new parameters to a function instead of generalizing or restructuring existing ones
3. **Copy-paste with slight variation**: near-duplicate code blocks that should be unified with a shared abstraction
4. **Leaky abstractions**: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries
5. **Stringly-typed code**: using raw strings where constants, enums (string unions), or branded types already exist in the codebase
6. **Unnecessary JSX nesting**: wrapper Boxes/elements that add no layout value — check if inner component props (flexShrink, alignItems, etc.) already provide the needed behavior
7. **Unnecessary comments**: comments explaining WHAT the code does (well-named identifiers already do that), narrating the change, or referencing the task/caller — delete; keep only non-obvious WHY (hidden constraints, subtle invariants, workarounds)

### Agent 3: Efficiency Review (`reviewer`)

Review the same changes for efficiency:

1. **Unnecessary work**: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns
2. **Missed concurrency**: independent operations run sequentially when they could run in parallel
3. **Hot-path bloat**: new blocking work added to startup or per-request/per-render hot paths
4. **Recurring no-op updates**: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers aren't notified when nothing changed. Also: if a wrapper function takes an updater/reducer callback, verify it honors same-reference returns (or whatever the "no change" signal is) — otherwise callers' early-return no-ops are silently defeated
5. **Unnecessary existence checks**: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error
6. **Memory**: unbounded data structures, missing cleanup, event listener leaks
7. **Overly broad operations**: reading entire files when only a portion is needed, loading all items when filtering for one

### Agent 4: Ponytail Over-engineering Review (`reviewer`)

Review the same changes with the `ponytail-review` lens: **over-engineering only**. The best finding is a safe deletion or shrink. Do not review correctness, security, or performance except where unnecessary complexity creates extra work.

Use these tags:

1. **delete:** dead code, unused flexibility, speculative features, comments that only narrate obvious changes
2. **stdlib:** hand-rolled logic that the language/runtime standard library already covers
3. **native:** dependency or custom code doing what the platform/browser/framework already provides
4. **yagni:** abstraction with one implementation, factory with one product, config nobody sets, wrapper that only delegates, layer with one caller
5. **shrink:** same behavior in fewer lines/files, preferably by deleting glue code rather than adding a new abstraction

Guardrails:

- Do not suggest removing trust-boundary validation, data-loss-preventing error handling, security, accessibility, or explicitly requested behavior.
- Do not flag the one smallest runnable test/self-check for non-trivial logic as bloat.
- Prefer `delete`, `stdlib`, and `native` replacements over introducing new abstractions. Suggest a shared abstraction only when repeated concrete duplication already exists and the abstraction is smaller than the duplicated code.

Finding format:

`<file>:L<line>: <tag>: <what to cut>. <replacement>. net: -<N> lines possible.`

## Phase 3: Fix Issues

**테스트 코드 잠금**: 호출 경로와 모드에 관계없이 승인·확정된 테스트(`*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`)는 보호하며 기본 단순화 대상은 구현 코드다. 승인된 개발/테스트 변경 범위에서 메인은 `test-write`의 '확정 후 테스트 잠금' 기준으로 최소 변경을 보수적으로 결정할 수 있다. 동등 이상 검출력 보존 근거 없는 삭제·대체나 통과 목적 기대값 완화는 금지한다. simplifier·worker·reviewer는 제안과 근거를 메인에 반환하고, 수정 역할은 메인이 승인한 구체적 테스트 변경 범위만 수행한다. 사용자 명시 수정 금지·확인 필수와 더 엄격한 적용 규칙은 유지한다.

light 모드에서는 메인이 code-cleaner 결과를 검증하고 오탐을 제외한 뒤 동작 보존 수정만 직접 수행한다. 아래 기본 모드와 동일한 과설계 제거·범위·테스트 보호 규칙을 적용하고 Phase 4로 진행한다.

기본 모드: Wait for all four agents to complete. Aggregate their findings, filter out false positives, and delegate the actual edits to the `simplifier` subagent — pass it the consolidated finding list plus the target files.

- Use `simplifier` for behavior-preserving refactors (the default case — reuse swaps, quality cleanups, efficiency tweaks, ponytail delete/shrink findings that don't change outputs).
- Treat Ponytail findings as deletion-first candidates, not mandates. Apply them only when requirements, behavior, and locked tests remain intact.
- If Ponytail says "delete the abstraction" while reuse/quality says "extract abstraction", prefer the smaller behavior-preserving option. Add abstraction only when it removes real repeated code and is simpler than the current diff.
- If a finding requires genuine behavior change or larger architectural work, report it and obtain explicit scope approval before delegating that item to `worker`.
- If a finding is a false positive or not worth addressing, note it and move on — do not argue with the finding, just skip it.

## Phase 4: Verify

수정한 동작을 직접 확인하는 최소 검증과 프로젝트 필수 검사를 실행한다. 테스트·린트·타입 검사 중 해당 변경에 필요한 명령과 실제 결과를 보고한다. 실행하지 못한 검증은 이유를 남긴다. 검증 실패를 숨기거나 테스트 잠금을 풀어 통과시키지 않는다. 별도 전체 리뷰를 자동으로 추가하지 않는다. 확정 테스트를 변경했다면 위 `test-write` 기준의 재실행과 기존 독립 검수에서 변경 타당성·누락·검출력 보존 확인 없이 완료로 처리하지 않는다. 관리 모드에서 수정으로 무효화된 `workflow_check`와 계획의 필수 검수 gate도 다시 충족해야 하며 이 문장으로 생략하지 않는다.

When done, briefly summarize what was fixed (or confirm the code was already clean), with the validation evidence.
