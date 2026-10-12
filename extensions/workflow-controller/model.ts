import type { StackState } from "./stack-model.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";

export const specSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	objective: Type.String({ minLength: 1 }),
	nonGoals: Type.Array(Type.String()),
	successCriteria: Type.Array(Type.String(), { minItems: 1 }),
	checks: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	endpoint: Type.Union([Type.Literal("verify"), Type.Literal("commit"), Type.Literal("pr")]),
	prDraft: Type.Optional(Type.Literal(true)),
	requiredReviews: Type.Optional(
		Type.Array(Type.String({ minLength: 1, pattern: "\\S" }), { minItems: 1, uniqueItems: true }),
	),
	prBase: Type.Optional(
		Type.String({ minLength: 1, description: "stacked PR의 base 브랜치. pr 종료 지점에서만 지정하며 생략하면 stage." }),
	),
	maxImprovementCycles: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	maxRecoveries: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
});
export type Spec = Omit<Required<Static<typeof specSchema>>, "prBase" | "requiredReviews"> & {
	prBase?: string;
	requiredReviews?: string[];
};
export type Role = "implement" | "review" | "research" | "deliver" | "prepare";
/* 메인이 고를 수 있는 worker effort. off·minimal·max는 품질·비용 극단이라 제외한다. */
export const DISPATCH_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type DispatchThinking = (typeof DISPATCH_THINKING_LEVELS)[number];
export type Owner = { workflowId: string; generation: number };
export type Attempt = {
	id: string;
	role: Role;
	agent: string;
	contextMode: "main" | "isolated";
	thinking?: DispatchThinking;
	task: string;
	generation: number;
	status: "dispatching" | "running" | "completed" | "failed" | "aborted" | "interrupted" | "rejected";
	claimed?: boolean;
	runId?: number;
	fingerprintAtDispatch: string;
	verificationId?: string;
	reviewKey?: string;
	reviewInvalidated?: boolean;
	fingerprintAtFinish?: string;
	finalOutput?: string;
	exitCode?: number;
	stopReason?: string;
	verdict?: "pass" | "changes-requested" | "blocked" | "missing";
	recovered?: {
		at: string;
		assessment: "complete" | "partial" | "unknown";
		notes: string;
		head: string;
		fingerprint: string;
		statusShort: string;
	};
};
export type Snapshot = { repoRoot: string; branch: string; head: string; fingerprint: string; statusShort: string };
export type Delivery = {
	action: "commit" | "push" | "pr";
	state: "intent" | "done" | "failed" | "reconciled";
	at: string;
	details: Record<string, unknown>;
};
export type ControlSource = "user" | "orchestrator" | "system";
export type Workflow = {
	workflowId: string;
	repoKey: string;
	repoRoot: string;
	goal: string;
	mode?: "stack";
	stack?: StackState;
	autoApprove?: boolean;
	phase: "drafting" | "awaiting-approval" | "executing" | "reviewing" | "ready-to-deliver" | "completed";
	control: "running" | "stopping" | "paused" | "blocked" | "cancelled";
	stopTarget?: "paused" | "cancelled";
	controlSource?: ControlSource;
	userHold?: boolean;
	controlRevision?: number;
	reason?: string;
	spec?: Spec;
	planVersion?: string;
	approval?: {
		planVersion: string;
		at: string;
		via: "ui" | "command" | "auto";
		repoRoot: string;
		branch: string;
		head: string;
		fingerprint: string;
	};
	attempts: Attempt[];
	checks: {
		command: string;
		exitCode: number;
		stdout: string;
		stderr: string;
		at: string;
		fingerprintBefore: string;
		fingerprintAfter: string;
	}[];
	verification?: { id?: string; fingerprint: string };
	review?: { attemptId: string; fingerprint: string };
	reviewResults?: Record<string, { attemptId: string; fingerprint: string }>;
	deliveries: Delivery[];
	improvementCycles: number;
	recoveries: number;
	owner: { sessionId: string; sessionFile?: string; pid: number; generation: number };
	seq: number;
	lastContinuationSeq: number;
	events: { seq: number; at: string; message: string }[];
	resumeSnapshot?: Snapshot;
};
export type Options = {
	agentDir: string;
	now?: () => Date;
	stopTimeoutMs?: number;
	checkKillGraceMs?: number;
	checkTimeoutMs?: number;
};

export function normalizeSpec(input: Static<typeof specSchema>): Spec {
	return {
		title: input.title.trim(),
		objective: input.objective.trim(),
		nonGoals: input.nonGoals.map((s) => s.trim()),
		successCriteria: input.successCriteria.map((s) => s.trim()),
		checks: input.checks.map((s) => s.trim()),
		endpoint: input.endpoint,
		prDraft: input.prDraft ?? true,
		...(input.requiredReviews ? { requiredReviews: input.requiredReviews.map((key) => key.trim()) } : {}),
		...(input.endpoint === "pr" ? { prBase: input.prBase ?? "stage" } : {}),
		maxImprovementCycles: input.maxImprovementCycles ?? 3,
		maxRecoveries: input.maxRecoveries ?? 2,
	};
}
export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const planVersion = (spec: Spec) => hash(JSON.stringify(spec));
export const activeAttempts = (state: Workflow) =>
	state.attempts.filter((a) => a.status === "dispatching" || a.status === "running");
export const terminal = (state: Workflow) => state.phase === "completed" || state.control === "cancelled";
export const ownerOf = (state: Workflow): Owner => ({
	workflowId: state.workflowId,
	generation: state.owner.generation,
});
export function sameOwner(a: Owner, b: Owner): boolean {
	return a.workflowId === b.workflowId && a.generation === b.generation;
}
export const protectedBranch = (branch: string) =>
	["main", "master", "stage", "development", "production", "HEAD", "detached"].includes(branch);
export function boundOutput(output: string): string {
	return output.length <= 8000 ? output : `${output.slice(0, 4000)}\n…\n${output.slice(-4000)}`;
}
export type DeliverContext = { endpoint: "commit" | "pr"; base: string; branch: string; head: string };
export function evidenceValid(state: Workflow): boolean {
	return (
		!!state.review?.fingerprint &&
		!!state.verification?.id &&
		state.review.fingerprint === state.verification.fingerprint
	);
}
function deliverContract(context: DeliverContext): string {
	const skills = join(homedir(), ".claude", "skills");
	const pr =
		context.endpoint === "pr"
			? ` 이어서 ${join(skills, "pr", "SKILL.md")}를 읽고 브랜치 ${context.branch}를 origin에 push한 뒤 base ${context.base}로 Draft PR을 만든다. 같은 head의 열린 PR이 있으면 새로 만들지 않는다.`
			: " push·PR은 하지 않는다.";
	return `검수 통과한 현재 작업 트리를 전달한다. ${join(skills, "commit", "SKILL.md")}를 읽고 그 기준으로 커밋한다.${pr} 커밋은 현재 HEAD ${context.head} 위에 쌓고 이미 끝난 단계는 반복하지 않는다. 파일 내용 수정·merge·배포·force push·amend·rebase·reset 금지. 마지막에 커밋 해시${context.endpoint === "pr" ? "와 PR URL" : ""}을 보고한다.`;
}
export function roleTask(role: Role, task: string, context?: DeliverContext): string {
	if (role === "deliver") {
		if (!context) throw new Error("전달 정보가 필요합니다.");
		return `${task}\n\n역할 계약\n${deliverContract(context)}`;
	}
	const contracts = {
		prepare: "승인된 스택 브랜치만 준비한다. 파일 수정·commit·push·merge·rebase·reset·배포 금지.",
		implement:
			"승인된 범위만 구현하고 테스트를 보호한다. commit/push/PR/merge/배포 금지. 변경 파일과 실제 검증 명령·결과를 보고한다.",
		review:
			"읽기 전용 검수. 요구사항·적용 AGENTS.md·회귀·테스트 품질을 확인한다. 마지막 줄은 정확히 WORKFLOW_VERDICT: pass 또는 WORKFLOW_VERDICT: changes-requested 또는 WORKFLOW_VERDICT: blocked.",
		research: "읽기 전용 조사. 파일·설정·Git·원격을 변경하지 않는다.",
	};
	return `${task}\n\n역할 계약\n${contracts[role]}`;
}
export function verdict(output: string): NonNullable<Attempt["verdict"]> {
	const line = output.trimEnd().split("\n").at(-1);
	const match = /^WORKFLOW_VERDICT: (pass|changes-requested|blocked)$/.exec(line ?? "");
	return match ? (match[1] as "pass" | "changes-requested" | "blocked") : "missing";
}
function forbiddenBash(command: string): boolean {
	/* 일반적인 Git 전역 옵션은 값까지 포함해 명령 이름 앞에서 제거한다. */
	const normalized = command.replace(
		/\bgit((?:\s+(?:-(?:C|c)\s+(?:"[^"]*"|'[^']*'|[^\s;]+)|--(?:git-dir|work-tree|namespace)(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s;]+)|--[a-z-]+))*)/g,
		"git",
	);
	return /\b(?:git\s+(?:commit|push|merge)|gh\s+pr\s+(?:create|merge|ready)|gh\s+workflow\s+run)\b/.test(normalized);
}
export const dispatchCommand = (attempt: Attempt) =>
	`subagent run ${attempt.agent} --${attempt.contextMode} --managed ${attempt.id} -- managed task`;
export function guard(
	tool: string,
	input: Record<string, unknown>,
	canDispatch: (command: string) => boolean = () => false,
): string | undefined {
	const command = typeof input.command === "string" ? input.command : "";
	if (tool === "subagent") {
		const [name, verb] = command.trim().split(/\s+/);
		const safeCommand =
			!/["'\\]/.test(command) &&
			name === "subagent" &&
			["help", "runs", "status", "detail", "abort", "remove"].includes(verb ?? "");
		if (!safeCommand && !canDispatch(command)) return "workflow_dispatch를 사용하세요.";
	}
	if (tool === "bash" && forbiddenBash(command))
		return "commit·push·PR은 workflow_dispatch role deliver로 전달 worker에게 맡기세요. merge·배포는 금지입니다.";
	return undefined;
}
