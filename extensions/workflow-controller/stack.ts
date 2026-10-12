import { Value } from "typebox/value";
import { mustRun, run, snapshot } from "./io.ts";
import { evidenceValid, protectedBranch, type Workflow } from "./model.ts";
import { stackPlanSchema, type StackPlan, type StackState, type UnitExecution } from "./stack-model.ts";

export async function validateStackPlan(repo: string, plan: StackPlan): Promise<void> {
	if (!Value.Check(stackPlanSchema, plan)) throw new Error("스택 계획의 필수 항목이 잘못되었습니다.");
	if (
		new Set(plan.units.map((unit) => unit.id)).size !== plan.units.length ||
		new Set(plan.units.map((unit) => unit.branch)).size !== plan.units.length
	)
		throw new Error("스택 PR의 id와 브랜치는 각각 유일해야 합니다.");
	if (plan.rootBase !== "stage" && protectedBranch(plan.rootBase))
		throw new Error("스택의 기준 브랜치는 stage 또는 비보호 브랜치여야 합니다.");
	await checkBranch(repo, plan.rootBase);
	for (const unit of plan.units) {
		if (protectedBranch(unit.branch) || unit.branch === plan.rootBase)
			throw new Error("스택 대상 브랜치는 보호 브랜치나 기준 브랜치일 수 없습니다.");
		await checkBranch(repo, unit.branch);
		const local = await run(repo, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${unit.branch}`]);
		if (local.code === 0) throw new Error(`이미 존재하는 로컬 브랜치: ${unit.branch}`);
		if (local.code !== 1) throw new Error(`로컬 브랜치 확인 실패: ${local.stderr}`);
		if (await remoteHead(repo, unit.branch)) throw new Error(`이미 존재하는 원격 브랜치: ${unit.branch}`);
	}
}

export async function readStackBase(repo: string, plan: StackPlan): Promise<string> {
	await checkBranch(repo, plan.rootBase);
	const head = await remoteHead(repo, plan.rootBase);
	if (!head) throw new Error(`원격 기준 브랜치가 없습니다: ${plan.rootBase}`);
	const object = await run(repo, "git", ["cat-file", "-e", `${head}^{commit}`]);
	if (object.code !== 0) throw new Error("원격 기준 커밋이 로컬에 없습니다. 먼저 해당 커밋을 fetch해야 합니다.");
	return head;
}

export function prepareTask(state: Workflow): string {
	const { stack, approval } = approvedStack(state);
	const unit = stack.plan.units[stack.index];
	if (!unit || stack.stage !== "preparing") throw new Error("준비할 스택 PR이 없습니다.");
	const previous = stack.results[stack.index - 1];
	if (stack.index > 0 && !previous?.valid) throw new Error("이전 PR의 전달 결과가 유효하지 않습니다.");
	const source = previous?.branch ?? approval.sourceBranch;
	const parent = previous?.head ?? approval.rootHead;
	return [
		`스택 PR ${unit.id}의 브랜치만 준비한다. 현재 브랜치는 ${source}, 새 브랜치는 ${unit.branch}, 고정 부모 커밋은 ${parent}이다.`,
		"작업 트리가 깨끗하고 현재 브랜치가 위 source와 일치하는지 먼저 확인한다. 대상 로컬·원격 브랜치가 이미 있으면 덮어쓰거나 재사용하지 말고 중단한다.",
		`확인 후 git switch -c ${shellQuote(unit.branch)} ${shellQuote(parent)} 로 브랜치를 만든다.`,
		"파일·설정 수정, commit·push·PR·merge·배포·fetch·rebase·reset·amend·force push 금지. 마지막에 실제 브랜치와 HEAD를 보고한다.",
	].join("\n");
}

export async function inspectPreparation(state: Workflow): Promise<void> {
	const { stack, approval } = approvedStack(state);
	const unit = stack.plan.units[stack.index];
	if (!unit || stack.stage !== "preparing") throw new Error("준비 확인 단계가 아닙니다.");
	if (stack.results.length !== stack.index) throw new Error("이전 스택 PR의 전달 기록이 누락됐습니다.");
	await verifyStackDependencies(state);
	const parent = stack.results[stack.index - 1]?.head ?? approval.rootHead;
	const current = await snapshot(state.repoRoot);
	const tree = await mustRun(state.repoRoot, "git", ["rev-parse", `${parent}^{tree}`]);
	if (current.branch !== unit.branch || current.head !== parent || current.fingerprint !== tree || current.statusShort)
		throw new Error("준비된 브랜치·HEAD·작업 트리가 승인된 고정 부모와 다릅니다.");
}

export async function verifyStackDependencies(state: Workflow): Promise<void> {
	const { stack, approval } = approvedStack(state);
	const root = await remoteHead(state.repoRoot, stack.plan.rootBase);
	if (root !== approval.rootHead) invalidate(stack, 0, "원격 기준 커밋이 승인 이후 바뀌었습니다.");
	for (const [index, result] of stack.results.entries()) {
		const unit = stack.plan.units[index];
		const previous = stack.results[index - 1];
		const parent = previous?.head ?? approval.rootHead;
		const base = previous?.branch ?? stack.plan.rootBase;
		if (
			!unit ||
			!result.valid ||
			result.id !== unit.id ||
			result.branch !== unit.branch ||
			result.base !== base ||
			result.parentHead !== parent
		)
			invalidate(stack, index, "스택 PR의 기록된 부모 관계가 승인된 계획과 다릅니다.");
		const local = await run(state.repoRoot, "git", ["rev-parse", "--verify", `refs/heads/${result.branch}`]);
		if (local.code !== 0 || local.stdout.trim() !== result.head)
			invalidate(stack, index, `로컬 부모 브랜치가 바뀌었습니다: ${result.branch}`);
		const remote = await remoteHead(state.repoRoot, result.branch);
		if (remote !== result.head) invalidate(stack, index, `원격 부모 브랜치가 바뀌었습니다: ${result.branch}`);
		const ancestor = await run(state.repoRoot, "git", ["merge-base", "--is-ancestor", parent, result.head]);
		const tree = await run(state.repoRoot, "git", ["rev-parse", `${result.head}^{tree}`]);
		if (ancestor.code !== 0 || result.head === parent || tree.code !== 0 || tree.stdout.trim() !== result.fingerprint)
			invalidate(stack, index, "스택 커밋이 고정 부모 위의 검수 내용과 다릅니다.");
	}
}

export async function verifyUnitCI(repo: string, head: string, names: string[]): Promise<void> {
	if (!names.length) return;
	if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("CI 확인 대상 커밋이 잘못되었습니다.");
	const pages: unknown = JSON.parse(
		await mustRun(repo, "gh", ["api", `repos/{owner}/{repo}/commits/${head}/check-runs`, "--paginate", "--slurp"]),
	);
	if (!Array.isArray(pages) || !pages.length) throw new Error("CI 조회 응답 오류");
	const checks: CheckRun[] = [];
	for (const page of pages) {
		if (!isObject(page) || !Array.isArray(page.check_runs)) throw new Error("CI 조회 응답 오류");
		for (const check of page.check_runs) {
			if (!isCheckRun(check)) throw new Error("CI 실행 정보가 잘못되었습니다.");
			checks.push(check);
		}
	}
	for (const name of names) {
		const latest = checks
			.filter((check) => check.name === name && check.head_sha === head)
			.sort((a, b) => b.id - a.id)[0];
		if (latest?.status !== "completed" || latest.conclusion !== "success")
			throw new Error(
				`필수 CI가 성공하지 않았습니다: ${name} (${latest?.status ?? "missing"}/${latest?.conclusion ?? "none"})`,
			);
	}
}

export async function inspectStackCompletion(state: Workflow): Promise<void> {
	const { stack } = approvedStack(state);
	if (
		stack.stage !== "integration" ||
		stack.index !== stack.plan.units.length ||
		stack.results.length !== stack.plan.units.length ||
		stack.results.some((result) => !result.valid) ||
		stack.invalidatedFrom !== undefined ||
		state.spec?.endpoint !== "verify" ||
		!evidenceValid(state) ||
		!requiredReviewsValid(state, stack.plan.integrationReviews, state.verification?.fingerprint)
	)
		throw new Error("전체 스택 전달과 통합 검사·필수 검수가 완료되지 않았습니다.");
	await verifyStackDependencies(state);
	await inspectTip(state, stack);
	for (const [index, result] of stack.results.entries()) {
		if (!requiredReviewsValid(result.execution, stack.plan.units[index].requiredReviews, result.fingerprint))
			throw new Error(`스택 PR의 필수 검수 증거가 누락됐거나 현재 커밋과 다릅니다: ${result.branch}`);
		const prs: unknown = JSON.parse(
			await mustRun(state.repoRoot, "gh", [
				"pr",
				"list",
				"--head",
				result.branch,
				"--state",
				"open",
				"--json",
				"url,isDraft,baseRefName,baseRefOid,headRefName,headRefOid",
			]),
		);
		if (!Array.isArray(prs) || prs.length !== 1 || !isObject(prs[0]))
			throw new Error("스택 PR이 없거나 단일 열린 PR이 아닙니다.");
		const pr = prs[0];
		if (
			pr.isDraft !== true ||
			pr.url !== result.url ||
			!result.url ||
			pr.baseRefName !== result.base ||
			pr.baseRefOid !== result.parentHead ||
			pr.headRefName !== result.branch ||
			pr.headRefOid !== result.head
		)
			throw new Error(`스택 PR의 Draft·URL·부모·HEAD가 전달 결과와 다릅니다: ${result.branch}`);
		await verifyUnitCI(state.repoRoot, result.head, stack.plan.units[index].ciChecks);
	}
	/* 원격 조회 사이의 로컬 수정과 부모 변경도 완료 판정에 반영한다. */
	await verifyStackDependencies(state);
	await inspectTip(state, stack);
}

function requiredReviewsValid(execution: UnitExecution, names: string[], fingerprint: string | undefined): boolean {
	return (
		!!fingerprint &&
		!!execution.verification?.id &&
		execution.verification.fingerprint === fingerprint &&
		execution.review?.fingerprint === fingerprint &&
		names.every(
			(name) =>
				!!execution.reviewResults?.[name]?.attemptId && execution.reviewResults[name].fingerprint === fingerprint,
		)
	);
}

async function inspectTip(state: Workflow, stack: StackState): Promise<void> {
	const tip = stack.results.at(-1);
	const current = await snapshot(state.repoRoot);
	if (
		!tip ||
		current.branch !== tip.branch ||
		current.head !== tip.head ||
		current.fingerprint !== tip.fingerprint ||
		current.fingerprint !== state.verification?.fingerprint ||
		current.statusShort
	)
		throw new Error("최상단 스택 브랜치·HEAD·작업 트리가 통합 검증 결과와 다릅니다.");
}

async function checkBranch(repo: string, branch: string): Promise<void> {
	const result = await run(repo, "git", ["check-ref-format", "--branch", branch]);
	if (result.code !== 0 || result.stdout.trim() !== branch) throw new Error(`잘못된 브랜치 이름: ${branch}`);
}

async function remoteHead(repo: string, branch: string): Promise<string | undefined> {
	const ref = `refs/heads/${branch}`;
	const output = await mustRun(repo, "git", ["ls-remote", "origin", ref]);
	if (!output) return undefined;
	const lines = output.split("\n");
	const [head, actualRef, extra] = lines[0].split(/\s+/);
	if (lines.length !== 1 || actualRef !== ref || extra || !/^[a-f0-9]{40,64}$/.test(head))
		throw new Error(`원격 브랜치 조회 응답 오류: ${branch}`);
	return head;
}

function approvedStack(state: Workflow): { stack: StackState; approval: NonNullable<StackState["approval"]> } {
	const stack = state.stack;
	if (!stack?.approval || state.mode !== "stack") throw new Error("승인된 스택 계획이 없습니다.");
	return { stack, approval: stack.approval };
}

function invalidate(stack: StackState, from: number, reason: string): never {
	stack.invalidatedFrom = Math.min(stack.invalidatedFrom ?? from, from);
	for (const result of stack.results.slice(stack.invalidatedFrom)) result.valid = false;
	throw new Error(`${reason} 후속 결과를 무효화했습니다. 자동 restack은 하지 않습니다.`);
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
type CheckRun = { id: number; name: string; head_sha: string; status: string; conclusion: string | null };
function isCheckRun(value: unknown): value is CheckRun {
	return (
		isObject(value) &&
		Number.isSafeInteger(value.id) &&
		typeof value.id === "number" &&
		value.id > 0 &&
		typeof value.name === "string" &&
		typeof value.head_sha === "string" &&
		typeof value.status === "string" &&
		(typeof value.conclusion === "string" || value.conclusion === null)
	);
}
