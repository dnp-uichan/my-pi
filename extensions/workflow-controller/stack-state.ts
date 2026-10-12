import { hash, normalizeSpec, planVersion, type Workflow } from "./model.ts";
import type { StackPlan, StackPlanInput, UnitExecution } from "./stack-model.ts";

export function normalizeStackPlan(input: StackPlanInput): StackPlan {
	const strings = (values: string[]) => values.map((value) => value.trim());
	return {
		...input,
		title: input.title.trim(),
		objective: input.objective.trim(),
		rootBase: input.rootBase.trim(),
		nonGoals: strings(input.nonGoals),
		successCriteria: strings(input.successCriteria),
		integrationChecks: strings(input.integrationChecks),
		integrationReviews: strings(input.integrationReviews),
		units: input.units.map((unit) => ({
			...unit,
			id: unit.id.trim(),
			title: unit.title.trim(),
			objective: unit.objective.trim(),
			branch: unit.branch.trim(),
			checks: strings(unit.checks),
			requiredReviews: strings(unit.requiredReviews),
			ciChecks: strings(unit.ciChecks),
		})),
		maxImprovementCycles: input.maxImprovementCycles ?? 3,
		maxRecoveries: input.maxRecoveries ?? 2,
	};
}
export const stackVersion = (plan: StackPlan) => hash(JSON.stringify(plan));

function execution(state: Workflow): UnitExecution {
	return structuredClone({
		spec: state.spec,
		planVersion: state.planVersion,
		approval: state.approval,
		attempts: state.attempts,
		checks: state.checks,
		verification: state.verification,
		review: state.review,
		reviewResults: state.reviewResults,
		deliveries: state.deliveries,
		improvementCycles: state.improvementCycles,
		recoveries: state.recoveries,
	});
}

/* 전체 승인에서 허용한 다음 실행 단위를 새 증거 세대로 연다. */
export function activateStackUnit(state: Workflow, at: string): void {
	const stack = state.stack;
	if (!stack?.approval) throw new Error("승인된 스택 계획이 없습니다.");
	const unit = stack.plan.units[stack.index];
	const previous = stack.results.at(-1);
	const parentHead = previous?.head ?? stack.approval.rootHead;
	const fingerprint = previous?.fingerprint ?? stack.approval.rootFingerprint;
	const base = previous?.branch ?? stack.plan.rootBase;
	state.spec = normalizeSpec({
		title: unit?.title ?? stack.plan.title,
		objective: unit?.objective ?? stack.plan.objective,
		nonGoals: stack.plan.nonGoals,
		successCriteria: unit ? [unit.objective] : stack.plan.successCriteria,
		checks: unit?.checks ?? stack.plan.integrationChecks,
		requiredReviews: unit?.requiredReviews ?? stack.plan.integrationReviews,
		endpoint: unit ? "pr" : "verify",
		...(unit ? { prBase: base } : {}),
		maxImprovementCycles: stack.plan.maxImprovementCycles,
		maxRecoveries: stack.plan.maxRecoveries,
	});
	state.planVersion = planVersion(state.spec);
	state.approval = {
		planVersion: state.planVersion,
		at,
		via: stack.approval.via,
		repoRoot: state.repoRoot,
		branch: unit?.branch ?? base,
		head: parentHead,
		fingerprint,
	};
	state.attempts = [];
	state.checks = [];
	state.deliveries = [];
	state.verification = undefined;
	state.review = undefined;
	state.reviewResults = undefined;
	state.improvementCycles = 0;
	state.recoveries = 0;
	state.reason = undefined;
	state.phase = "executing";
	stack.stage = unit ? "preparing" : "integration";
	state.owner.generation++;
	state.lastContinuationSeq = -1;
}

export function advanceStack(state: Workflow, at: string): void {
	const stack = state.stack;
	if (!stack?.approval || stack.stage !== "unit" || !state.approval || !state.review)
		throw new Error("완료할 스택 실행 단위가 없습니다.");
	const unit = stack.plan.units[stack.index];
	const pr = [...state.deliveries].reverse().find((d) => d.action === "pr" && ["done", "reconciled"].includes(d.state));
	if (!unit || typeof pr?.details.head !== "string" || typeof pr.details.url !== "string")
		throw new Error("확인된 스택 PR이 없습니다.");
	stack.results.push({
		id: unit.id,
		branch: unit.branch,
		base: state.spec?.prBase ?? stack.plan.rootBase,
		parentHead: state.approval.head,
		head: pr.details.head,
		fingerprint: state.review.fingerprint,
		url: pr.details.url,
		valid: true,
		execution: execution(state),
	});
	stack.index++;
	activateStackUnit(state, at);
}

export function stackInstruction(state: Workflow): string | undefined {
	const stack = state.stack;
	if (state.mode !== "stack") return;
	if (!stack?.approval)
		return "workflow_stack_propose로 선형 PR 계획·필수 검수·CI·전체 검사를 제안하세요. 임의 브랜치 변경 금지.";
	if (stack.invalidatedFrom !== undefined)
		return "스택의 부모 커밋이 변경됐습니다. 자동 restack하지 말고 사용자에게 영향 범위를 보고하세요.";
	if (stack.stage === "preparing")
		return `스택 ${stack.index + 1}/${stack.plan.units.length}: workflow_dispatch role prepare로 승인 브랜치를 준비하세요.`;
	if (stack.stage === "integration")
		return "전체 스택 통합 단계입니다. workflow_check 및 계획의 integrationReviews별 reviewKey 검수를 수행하세요. 파일 수정·추가 전달 금지.";
	if (state.phase === "reviewing")
		return `필수 검수 ${state.spec?.requiredReviews?.join(", ")}를 각각 reviewKey로 지정해 완료하세요.`;
	return undefined;
}
