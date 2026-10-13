# OMO 완료·정지 계약 발췌

이 파일은 my-pi의 MIT 라이선스 대상이 아니다. 아래 발췌문은 Sustainable Use License 1.0 대상이며 전문은 같은 폴더의 `LICENSE-OMO-SUL-1.0.md`에 있다. 개인 사용 목적으로만 보관하며 배포하지 않는다.

- 출처: [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) `v5.1.29` (`6dfb41974556051b432c30ed71b134ed826c883a`)
- 원문 위치: `packages/shared-skills/skills/ulw-execute/SKILL.md`의 Completion contract, `packages/omo-senpi/skills/ulw-loop/references/full-workflow.md`의 Stop Rules와 Final Quality Gate 4번 항목
- 수정 사항: 2026-10-11에 위 절만 발췌했다. 원문 영어 문장은 바꾸지 않았다. 마지막 "이 환경의 적용" 절은 새로 작성했고, 2026-10-13에 현재 controller의 필수 검수·운영·스택 계약에 맞춰 수정했다.

## 원문 발췌

### Completion contract (`ulw-execute`)

A worker done claim is never final: each implementation sub-task returns a `DoneClaim`, a different context runs `AdversarialVerify` probing or reproducing the claim, failures loop back to the executor, and only a confirmed verifier verdict becomes `FullyDone`.

```json
{
  "DoneClaim": {
    "task": "<task id/title>",
    "changed_files": ["path"],
    "tests": ["exact command + result"],
    "manual_qa": ["artifact path"],
    "cleanup": ["receipt"],
    "risks": ["known risk or none"]
  },
  "AdversarialVerify": {
    "verdict": "confirmed | false-positive | needs-fix | needs-human-review",
    "evidence": ["file path, command, log, artifact, or explicit not inspected"],
    "repro": "exact command or manual steps when available",
    "confidence": 0.0
  }
}
```

Rules:
- `confirmed` is the only pass verdict. `false-positive`, `needs-fix`, and `needs-human-review` all block checkbox completion.
- The verifier must be independent from the executor: use the harness's gate reviewer (see the harness compatibility section) or a fresh reviewer worker on a strong model, or root only when root did not implement or materially rewrite that task.
- A worker done claim must be independently verified before it becomes checkbox completion.
- On any non-confirmed verdict, append the feedback to the ledger, reset the checkbox work to in-progress, and re-dispatch the executor with the exact failure.
- The verifier must probe the applicable adversarial keys, including `stale_state`, `dirty_worktree`, and `misleading_success_output`, before allowing `FullyDone`.

### Stop Rules (`ulw-loop`)

- STOP GOAL: all goals complete plus every plan criterion `pass` plus final quality gate clean. The decisive test — outranking every other consideration — is whether the completion conditions are FUNDAMENTALLY fulfilled and the user's problem ACTUALLY SOLVED in observable behavior; a `pass` ledger never substitutes for it. The moment both hold, checkpoint, report, and STOP — no extra review cycles, no evidence regeneration, no polish.
- 3x same criterion failure: checkpoint failed, surface diagnosis.
- 5 cycles on one goal without required criteria passing: checkpoint failed, surface.
- Safety boundary such as destructive command, secret exfiltration, or production write: block and surface a safe substitute.
- omo-senpi `get_goal` reports a different active goal: checkpoint blocker, stop, surface.
- Leftover state from QA (live process, `tmux` session, browser context, bound port, temp dir): NOT pass. Clean up, append the receipt, then continue.
- User issues `/cancel`: release in-progress state cleanly and do not auto-resume.

### Final Quality Gate 4번 (`ulw-loop`)

4. Treat timeout, missing deliverable, ack-only, `BLOCKED:`, or inconclusive review as a blocker. Any fix restarts the freeze at the new HEAD: re-run only the proofs it invalidated and stamp the fresh output; never relabel stale output to HEAD. Re-review the delta at most twice, then record-review-blockers and surface to the user.

## 이 환경의 적용

- `DoneClaim`은 implement worker의 종료 보고다. 종료 보고만으로 단계가 바뀌지 않는다.
- 독립 검증은 `workflow_check`의 승인된 검사 결과와, 구현 agent와 다른 검수 agent들의 `WORKFLOW_VERDICT: pass`다. 계획의 모든 `requiredReviews`(스택 통합은 `integrationReviews`) 결과가 현재 verification 세대와 같은 시작/종료 작업 트리 지문에 묶여야 한다. 첫 PASS·판정 누락·실패·형식 오류는 전체 통과가 아니다.
- 지문이 바뀌면 이전 검사·검수 결과를 다시 쓰지 않는다. 바뀐 상태에서 검사부터 다시 한다.
- 반복 한도는 OMO의 5회·3회 대신 승인 시 정한 개선 한도(기본 3회)와 실행 복구 한도(기본 2회)를 쓴다. 한도에 도달하면 완료가 아니라 차단이며 사용자 판단을 받는다.
- 사용자 cancel·pause·Esc·실행 중단과 사용자 판단 보류는 메인이 해제하지 않는다. 시스템/메인 중단은 실제 상태 확인 뒤 `workflow_resume`으로 재개할 수 있지만 세션 재시작 자체는 자동 재개가 아니다.
- 종료 지점은 검증·commit·Draft PR 중 승인한 지점이다. 명시 선택한 선형 스택은 승인된 모든 Draft PR과 통합 검사·검수·최종 원격/CI 확인까지 진행한다. `--ship`, 자동 merge·배포·무승인 후속 작업은 가져오지 않는다. 전체 성공 기준이 충족되면 불필요한 추가 리뷰·증거 재생성 없이 종료한다.
