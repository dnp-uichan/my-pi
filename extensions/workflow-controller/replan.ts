import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { activeAttempts, planVersion, type Workflow } from "./model.ts";
import {
	adoptionEvidence,
	assertRemoteTarget,
	pathAllowed,
	preflight,
	readWorkspace,
	type WorkspaceEvidence,
} from "./preflight.ts";
import type { StackPlan, StackReplanInput, StackUnit } from "./stack-model.ts";
import { activateStackUnit, execution, stackVersion } from "./stack-state.ts";
import { remoteHead, validateStackPlan, verifyStackDependencies } from "./stack.ts";

export function revisionAttempts(state: Workflow, integration = false) {
	return (
		state.stack?.revisions
			?.filter((revision) => integration || revision.index === state.stack?.index)
			.flatMap((revision) => revision.previousExecution.attempts) ?? []
	);
}
export function managedPreparation(state: Workflow): boolean {
	const unit = state.stack?.plan.units[state.stack.index];
	const historical =
		state.stack?.revisions
			?.filter(
				(revision) =>
					revision.index === state.stack?.index && revision.previousPlan.units[revision.index]?.branch === unit?.branch,
			)
			.flatMap((revision) => revision.previousExecution.attempts) ?? [];
	return [...state.attempts, ...historical].some(
		(attempt) =>
			attempt.role === "prepare" &&
			attempt.claimed === true &&
			Number.isInteger(attempt.runId) &&
			attempt.generation <= state.owner.generation &&
			!["dispatching", "rejected"].includes(attempt.status),
	);
}

/* 최초 승인만 위임 근거로 사용한다. payload에 추가한 policy는 권한이 아니다. */
export function delegatedReplan(state: Workflow, plan: StackPlan, input: StackReplanInput): boolean {
	const stack = state.stack;
	const initial = stack?.approval?.initialPlan;
	if (!stack || !initial?.replanPolicy || (stack.revisions?.length ?? 0) >= initial.replanPolicy.maxReplans)
		return false;
	const old = stack.plan;
	const fields = [
		"objective",
		"nonGoals",
		"successCriteria",
		"integrationChecks",
		"integrationReviews",
		"maxImprovementCycles",
		"maxRecoveries",
		"rootBase",
		"replanPolicy",
	] as const;
	if (
		fields.some(
			(field) => !isDeepStrictEqual(plan[field], old[field]) || !isDeepStrictEqual(plan[field], initial[field]),
		) ||
		input.excludedRequirements?.length
	)
		return false;
	if (!isDeepStrictEqual(old.replanPolicy, initial.replanPolicy) || plan.units.length !== old.units.length)
		return false;
	if (
		plan.units.length !== initial.units.length ||
		plan.units
			.slice(stack.index)
			.some(
				(unit, offset) =>
					!unitWithinScope(unit, old.units[stack.index + offset]) ||
					!unitWithinScope(unit, initial.units[stack.index + offset]),
			)
	)
		return false;
	if (input.adoptChanges) {
		const paths = old.units[stack.index].allowedPaths;
		const nextPaths = plan.units[stack.index].allowedPaths;
		const adopted = [...input.adoptChanges.paths, ...(input.adoptChanges.allowedPaths ?? [])];
		if (!paths || adopted.some((path) => !pathAllowed(path, paths) || (nextPaths && !pathAllowed(path, nextPaths))))
			return false;
	}
	return true;
}

function unitWithinScope(unit: StackUnit, previous: StackUnit): boolean {
	return (
		unit.id === previous.id &&
		unit.branch === previous.branch &&
		previous.checks.every((check) => unit.checks.includes(check)) &&
		previous.requiredReviews.every((key) => unit.requiredReviews.includes(key)) &&
		previous.ciChecks.every((key) => unit.ciChecks.includes(key)) &&
		(!previous.allowedPaths ||
			(!!unit.allowedPaths && unit.allowedPaths.every((path) => pathAllowed(path, previous.allowedPaths ?? []))))
	);
}

export function assertReplanReady(state: Workflow): void {
	const stack = state.stack;
	if (
		state.mode !== "stack" ||
		!stack?.approval ||
		!state.approval ||
		state.userHold ||
		!["preparing", "unit"].includes(stack.stage) ||
		stack.invalidatedFrom !== undefined
	)
		throw new Error("사용자 보류·무효화가 없는 승인된 미전달 스택 단위에서만 재계획합니다.");
	if (activeAttempts(state).length || state.deliveries.length)
		throw new Error("종료하지 않은 작업·전달 결과가 있습니다. 먼저 기존 실행을 복구하세요.");
	if (
		[...state.attempts, ...revisionAttempts(state)].some(
			(attempt) =>
				attempt.role === "implement" &&
				["failed", "aborted", "interrupted"].includes(attempt.status) &&
				!attempt.recovered,
		)
	)
		throw new Error("실패·중단 구현은 workflow_recover로 실제 작업 공간을 기록한 뒤 재계획하세요.");
	if (
		state.improvementCycles >= (state.spec?.maxImprovementCycles ?? 3) ||
		state.recoveries > (state.spec?.maxRecoveries ?? 2)
	)
		throw new Error("개선·복구 한도 소진은 재계획으로 초기화하지 않습니다.");
	const budget = stack.approval.initialPlan?.replanPolicy?.maxReplans;
	if (budget !== undefined && (stack.revisions?.length ?? 0) >= budget) throw new Error("최초 승인된 재계획 한도 초과");
}

export async function inspectReplan(
	state: Workflow,
	plan: StackPlan,
	input: StackReplanInput,
): Promise<{ workspace: WorkspaceEvidence; prepared: boolean; candidate: Workflow }> {
	assertReplanReady(state);
	const stack = state.stack;
	if (!stack?.approval || !state.approval) throw new Error("승인된 스택이 없습니다.");
	if (
		plan.rootBase !== stack.plan.rootBase ||
		!isDeepStrictEqual(plan.units.slice(0, stack.index), stack.plan.units.slice(0, stack.index))
	)
		throw new Error("전달된 prefix와 루트 부모는 재계획으로 바꾸지 않습니다.");
	const removed = stack.plan.successCriteria.filter((requirement) => !plan.successCriteria.includes(requirement));
	if (removed.some((requirement) => !input.excludedRequirements?.includes(requirement)))
		throw new Error(
			"제외하는 기존 성공 조건은 excludedRequirements에 명시하여 사용자 승인과 제외 이력으로 남겨야 합니다.",
		);
	if (!plan.units[stack.index]) throw new Error("현재 미전달 단위가 없는 계획은 적용하지 않습니다.");
	const allowed = plan.units[stack.index].allowedPaths;
	const adoption = input.adoptChanges;
	if (
		allowed &&
		adoption &&
		[...adoption.paths, ...(adoption.allowedPaths ?? [])].some((path) => !pathAllowed(path, allowed))
	)
		throw new Error("인수 파일과 보완 허용 경로는 새 스택 단위의 허용 범위 안에 있어야 합니다.");
	await assertRemoteTarget(state.repoRoot, stack.approval.target ?? state.approval.target);
	await verifyStackDependencies(structuredClone(state));
	const current = await readWorkspace(state.repoRoot);
	if (!current.workspace || current.blockers.length) throw new Error(current.blockers.join("\n"));
	const workspace = current.workspace;
	if (workspace.repoRoot !== state.repoRoot) throw new Error("승인된 저장소와 다릅니다.");
	const prepared = await inspectCurrentBranch(state, plan, workspace);
	const unit = stack.plan.units[stack.index];
	if (!prepared && input.adoptChanges)
		throw new Error("변경 인수는 관리 prepare가 만든 현재 단위 브랜치에서만 가능합니다.");
	await validateStackPlan(state.repoRoot, plan, [
		...stack.results.map((result) => result.branch),
		...(prepared ? [unit.branch] : []),
	]);
	const candidate = replanCandidate(state, plan, input);
	if (!candidate.spec || !candidate.approval || !candidate.stack)
		throw new Error("재계획 실행 계약을 만들 수 없습니다.");
	if (prepared) {
		const flight = await preflight(state.repoRoot, candidate.spec);
		if (!flight.eligible || !flight.workspace || flight.workspace.signature !== workspace.signature)
			throw new Error(flight.blockers.join("\n") || "재계획 검사 중 작업 공간이 변경되었습니다.");
		candidate.stack.stage = "unit";
		candidate.approval.fingerprint = workspace.fingerprint;
		if (input.adoptChanges) candidate.approval.adoption = adoptionEvidence(candidate.spec, workspace);
	}
	candidate.approval.target = workspace.remote;
	candidate.improvementCycles = state.improvementCycles;
	candidate.recoveries = state.recoveries;
	return { workspace, prepared, candidate };
}

async function inspectCurrentBranch(state: Workflow, plan: StackPlan, workspace: WorkspaceEvidence): Promise<boolean> {
	const stack = state.stack;
	if (!stack?.approval) throw new Error("승인된 스택이 없습니다.");
	const previous = stack.results.at(-1);
	const parent = previous?.head ?? stack.approval.rootHead;
	const unit = stack.plan.units[stack.index];
	const prepared = workspace.branch === unit.branch;
	if (prepared) {
		if (workspace.head !== parent || !managedPreparation(state))
			throw new Error("현재 브랜치의 관리 prepare 출처·고정 부모 HEAD를 증명할 수 없습니다.");
		if (plan.units[stack.index].branch !== unit.branch)
			throw new Error("이미 준비된 현재 브랜치는 재계획으로 바꾸지 않습니다.");
		if (await remoteHead(state.repoRoot, unit.branch))
			throw new Error("현재 미전달 브랜치가 원격에 있습니다. 기존 전달 결과부터 복구하세요.");
	} else if (
		stack.stage !== "preparing" ||
		workspace.statusShort ||
		workspace.branch !== (previous?.branch ?? stack.approval.sourceBranch) ||
		workspace.head !== (previous?.head ?? stack.approval.sourceHead)
	)
		throw new Error("재계획 시작 브랜치·HEAD가 고정된 부모 관계와 다릅니다.");
	return prepared;
}
function replanCandidate(state: Workflow, plan: StackPlan, input: StackReplanInput): Workflow {
	const candidate = structuredClone(state);
	if (!candidate.stack) throw new Error("스택 계획이 없습니다.");
	candidate.stack.plan = structuredClone(plan);
	candidate.stack.planVersion = stackVersion(plan);
	activateStackUnit(candidate, state.approval?.at ?? "");
	if (!candidate.spec || !candidate.approval) throw new Error("재계획 실행 계약을 만들 수 없습니다.");
	candidate.spec.revisionId = randomUUID();
	if (input.adoptChanges) candidate.spec.adoptChanges = structuredClone(input.adoptChanges);
	candidate.planVersion = planVersion(candidate.spec);
	candidate.approval.planVersion = candidate.planVersion;
	return candidate;
}

export function applyReplan(
	state: Workflow,
	candidate: Workflow,
	plan: StackPlan,
	input: StackReplanInput,
	via: "scope" | "ui",
	at: string,
): void {
	const stack = state.stack;
	if (!stack || !candidate.stack || !candidate.approval) throw new Error("적용할 스택 재계획이 없습니다.");
	candidate.stack.revisions = [
		...(stack.revisions ?? []),
		{
			at,
			reason: input.reason.trim(),
			via,
			fromPlanVersion: stack.planVersion,
			toPlanVersion: stackVersion(plan),
			previousPlan: structuredClone(stack.plan),
			previousExecution: execution(state),
			index: stack.index,
			excludedRequirements: [...(input.excludedRequirements ?? [])],
		},
	];
	const excluded = [...new Set([...(stack.excludedRequirements ?? []), ...(input.excludedRequirements ?? [])])];
	if (excluded.length) candidate.stack.excludedRequirements = excluded;
	candidate.approval.at = at;
	if (via === "ui") {
		candidate.approval.via = "ui";
		if (candidate.stack.approval && !candidate.stack.approval.target)
			candidate.stack.approval.target = candidate.approval.target;
	}
	/* prepare 출처만 현재 실행에도 남긴다. 이전 구현/검수는 revision을 통해 독립성에 반영한다. */
	candidate.attempts =
		stack.plan.units[stack.index].branch === plan.units[stack.index].branch
			? state.attempts.filter((attempt) => attempt.role === "prepare")
			: [];
	Object.assign(state, candidate);
}
