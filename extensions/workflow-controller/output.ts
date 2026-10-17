import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { statePath } from "./io.ts";
import type { Attempt, Options, Workflow } from "./model.ts";
import type { PreflightResult } from "./preflight.ts";

const sections = ["spec", "approval", "attempts", "checks", "deliveries", "events", "stack"] as const;
export const statusQuerySchema = Type.Object(
	{
		section: Type.Optional(Type.Union(sections.map((section) => Type.Literal(section)))),
		index: Type.Optional(Type.Integer({ minimum: 0, description: "배열 섹션의 항목 인덱스(0부터)." })),
		offset: Type.Optional(Type.Integer({ minimum: 0, description: "섹션 JSON의 문자 오프셋(0부터)." })),
		limit: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 4000, description: "페이지 문자 수. 기본 2000, 최대 4000." }),
		),
	},
	{ additionalProperties: false },
);
type StatusQuery = Static<typeof statusQuerySchema>;

/* 잘린 값은 같은 응답의 evidence와 섹션/항목 인덱스로 원문을 찾는다. */
function excerpt(value: string | undefined, limit = 400): string | undefined {
	if (value === undefined || value.length <= limit) return value;
	return `${value.slice(0, limit)}… [원문 ${value.length}자, evidence 참조]`;
}
function recent<T>(items: T[], limit = 3) {
	return { total: items.length, omitted: Math.max(0, items.length - limit), items: items.slice(-limit) };
}
function attemptSummary(attempt: Attempt, index: number) {
	return {
		index,
		id: attempt.id,
		role: attempt.role,
		agent: excerpt(attempt.agent, 100),
		runId: attempt.runId,
		status: attempt.status,
		reviewKey: excerpt(attempt.reviewKey, 100),
		verdict: attempt.verdict,
		reviewInvalidated: attempt.reviewInvalidated,
		exitCode: attempt.exitCode,
		stopReason: excerpt(attempt.stopReason),
		recovered: attempt.recovered?.assessment,
		output: excerpt(attempt.finalOutput, 600),
	};
}
function nextAction(state: Workflow): string {
	if (state.userHold) return "사용자 보류 중. 사용자의 /workflow resume 또는 /workflow start만 기다리세요.";
	if (state.control === "cancelled" || state.phase === "completed")
		return "종료 상태와 증거를 인계하세요. 작업을 재실행하지 마세요.";
	if (state.control === "stopping") return "실행 중인 작업의 중단 확인을 기다리세요.";
	if (state.control === "blocked")
		return "차단 이유를 확인하고 필요한 사용자 판단을 받으세요. 게이트를 우회하지 마세요.";
	if (state.control === "paused") return "중단 이유와 복구 증거를 확인한 뒤 권한에 맞게 workflow_resume을 사용하세요.";
	if (state.phase === "awaiting-approval") return "사용자의 계획 승인을 기다리세요. 승인 전 구현·전달 금지.";
	if (state.phase === "drafting")
		return "읽기 전용 조사 후 workflow_propose 또는 workflow_stack_propose로 계획을 제안하세요.";
	if (state.attempts.some((attempt) => ["dispatching", "running"].includes(attempt.status)))
		return "실행 중인 worker의 완료를 기다리고 실행 ID로 진행을 확인하세요.";
	if (
		state.attempts.some(
			(attempt) =>
				attempt.role === "implement" &&
				["failed", "aborted", "interrupted"].includes(attempt.status) &&
				!attempt.recovered,
		)
	)
		return "실패·중단된 구현을 workflow_recover로 확인한 뒤 승인 범위 안에서 복구하세요.";
	if (state.stack?.invalidatedFrom !== undefined)
		return "스택 의존관계 무효화 증거를 확인하고 필요한 사용자 판단을 받으세요.";
	if (state.stack?.stage === "preparing")
		return "승인된 스택의 브랜치 준비 상태를 확인하고 workflow_dispatch role prepare를 사용하세요.";
	if (state.phase === "reviewing")
		return "검사 증거와 필수 검수 이름을 확인하고 workflow_dispatch role review로 독립 검수하세요.";
	if (state.phase === "ready-to-deliver")
		return "승인된 종료 지점까지만 workflow_dispatch role deliver로 전달하세요. 직접 Git 전달·merge·배포 금지.";
	return "실패·검수 지적을 확인하고 승인 범위 안에서 workflow_dispatch로 구현하거나 workflow_check로 검사하세요.";
}
function workflowSummary(state: Workflow & { guidance?: string }, options: Options) {
	const attempts = state.attempts.map(attemptSummary);
	const checks = state.checks.map((check, index) => ({
		index,
		command: excerpt(check.command),
		exitCode: check.exitCode,
		at: check.at,
		fingerprintChanged: check.fingerprintBefore !== check.fingerprintAfter,
		...(check.exitCode !== 0 ? { stdout: excerpt(check.stdout), stderr: excerpt(check.stderr) } : {}),
	}));
	return {
		ok: true,
		workflowId: state.workflowId,
		repoRoot: excerpt(state.repoRoot),
		generation: state.owner.generation,
		phase: state.phase,
		control: state.control,
		controlSource: state.controlSource,
		userHold: state.userHold ?? false,
		reason: excerpt(state.reason, 600),
		seq: state.seq,
		goal: excerpt(state.goal),
		planVersion: state.planVersion,
		plan: state.spec
			? {
					title: excerpt(state.spec.title),
					endpoint: state.spec.endpoint,
					deliveryMode: state.spec.deliveryMode,
					prBase: excerpt(state.spec.prBase, 100),
					requiredReviews: recent((state.spec.requiredReviews ?? ["code"]).map((key) => excerpt(key, 100))),
				}
			: null,
		approval: state.approval
			? {
					planVersion: state.approval.planVersion,
					via: state.approval.via,
					at: state.approval.at,
					branch: excerpt(state.approval.branch, 100),
					head: state.approval.head,
					fingerprint: state.approval.fingerprint,
				}
			: null,
		attempts: {
			total: attempts.length,
			active: recent(attempts.filter((attempt) => ["dispatching", "running"].includes(attempt.status))),
			attention: recent(
				attempts.filter(
					(attempt) =>
						["failed", "aborted", "interrupted", "rejected"].includes(attempt.status) ||
						(attempt.verdict && attempt.verdict !== "pass"),
				),
			),
			recent: recent(attempts, 1),
		},
		checks: {
			total: checks.length,
			failed: recent(checks.filter((check) => check.exitCode !== 0 || check.fingerprintChanged)),
			recent: recent(checks, 1),
		},
		verification: state.verification ?? null,
		review: state.review ?? null,
		deliveries: recent(
			state.deliveries.map((delivery, index) => ({
				index,
				action: delivery.action,
				state: delivery.state,
				at: delivery.at,
				head: typeof delivery.details.head === "string" ? excerpt(delivery.details.head, 100) : undefined,
				base: typeof delivery.details.base === "string" ? excerpt(delivery.details.base, 100) : undefined,
				url: typeof delivery.details.url === "string" ? excerpt(delivery.details.url, 500) : undefined,
			})),
			1,
		),
		improvementCycles: { used: state.improvementCycles, limit: state.spec?.maxImprovementCycles },
		recoveries: { used: state.recoveries, limit: state.spec?.maxRecoveries },
		stack: state.stack
			? {
					stage: state.stack.stage,
					index: state.stack.index,
					total: state.stack.plan.units.length,
					unitId: excerpt(state.stack.plan.units[state.stack.index]?.id, 100),
					planVersion: state.stack.planVersion,
					approval: state.stack.approval ? { via: state.stack.approval.via, at: state.stack.approval.at } : null,
					delivered: state.stack.results.length,
					results: recent(
						state.stack.results.map((result, index) => ({
							index,
							id: excerpt(result.id, 100),
							head: result.head,
							url: excerpt(result.url, 500),
							valid: result.valid,
						})),
						state.stack.results.length,
					),
					excludedRequirements: recent((state.stack.excludedRequirements ?? []).map((item) => excerpt(item))),
					invalidatedFrom: state.stack.invalidatedFrom,
					revisions: state.stack.revisions?.length ?? 0,
					lastRevision: state.stack.revisions?.length
						? {
								via: state.stack.revisions.at(-1)?.via,
								fromPlanVersion: state.stack.revisions.at(-1)?.fromPlanVersion,
								toPlanVersion: state.stack.revisions.at(-1)?.toPlanVersion,
								reason: excerpt(state.stack.revisions.at(-1)?.reason),
							}
						: undefined,
				}
			: undefined,
		nextAction: nextAction(state),
		evidence: {
			path: statePath(options.agentDir, state.repoKey, state.workflowId),
			sections,
			query:
				"workflow_status {section, index?, offset?, limit?}. JSON 문자 페이지, 기본 2000·최대 4000자. index는 배열 항목(0부터). 페이지 사이 seq가 바뀌면 처음부터 재조회하세요.",
		},
		...(state.guidance ? { guidance: excerpt(state.guidance, 4000) } : {}),
	};
}
function statusPage(state: Workflow, query: StatusQuery, options: Options) {
	if (!query.section) {
		if (Object.keys(query).length) throw new Error("상세 조회에는 section이 필요합니다.");
		return workflowSummary(state, options);
	}
	let selected: unknown = state[query.section] ?? null;
	if (query.index !== undefined) {
		if (!Array.isArray(selected) || query.index >= selected.length)
			throw new Error("존재하는 배열 섹션 항목 인덱스가 필요합니다.");
		selected = selected[query.index];
	}
	const source = JSON.stringify(selected, null, 2);
	const offset = query.offset ?? 0;
	if (offset > source.length) throw new Error("상세 조회 오프셋이 원문 길이를 초과합니다.");
	const end = Math.min(source.length, offset + (query.limit ?? 2000));
	return {
		workflowId: state.workflowId,
		seq: state.seq,
		section: query.section,
		index: query.index,
		offset,
		totalChars: source.length,
		nextOffset: end < source.length ? end : null,
		data: source.slice(offset, end),
	};
}
async function responseEvidence(value: unknown, options: Options): Promise<string> {
	const directory = join(options.agentDir, "workflows", "responses");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${randomUUID()}.json`);
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	return path;
}
function isWorkflow(value: unknown): value is Workflow {
	return typeof value === "object" && value !== null && "workflowId" in value;
}
function isPreflight(value: unknown): value is PreflightResult {
	return typeof value === "object" && value !== null && "eligible" in value;
}
export async function toolContent(name: string, details: unknown, options: Options, params?: unknown): Promise<string> {
	if (isWorkflow(details)) {
		if (name === "status") {
			if (!Value.Check(statusQuerySchema, params)) throw new Error("잘못된 상태 조회 입력입니다.");
			return JSON.stringify(statusPage(details, params, options));
		}
		const summary = workflowSummary(details, options);
		const guidance = "guidance" in details && typeof details.guidance === "string" ? details.guidance : undefined;
		return JSON.stringify({
			...summary,
			...(guidance && guidance.length > 4000
				? { guidanceEvidence: { path: await responseEvidence({ guidance }, options) } }
				: {}),
		});
	}
	if (isPreflight(details)) {
		return JSON.stringify({
			eligible: details.eligible,
			nextAction:
				details.eligible === false
					? "차단 지적과 원문을 확인해 계획·작업 공간을 보완하세요. 승인 게이트를 우회하지 마세요."
					: "작업 공간과 후보 계획을 확인하세요. preflight 결과는 실행 승인이 아닙니다.",
			blockers: recent(
				details.blockers.map((blocker) => excerpt(blocker, 600)),
				5,
			),
			workspace: details.workspace
				? {
						repoRoot: excerpt(details.workspace.repoRoot),
						branch: excerpt(details.workspace.branch, 100),
						head: details.workspace.head,
						fingerprint: details.workspace.fingerprint,
						signature: details.workspace.signature,
					}
				: null,
			changes: {
				total: details.changes.length,
				items: details.changes.slice(0, 5).map((change) => ({
					path: excerpt(change.path),
					status: change.status,
					originalPath: excerpt(change.originalPath),
				})),
			},
			evidence: {
				path: await responseEvidence(details, options),
				read: "read로 필요한 행만 명시적으로 조회하세요. 전체 원문을 기본 본문에 다시 출력하지 마세요.",
			},
		});
	}
	/* 상태 부재·저장 장애의 details는 유지하되 오류 본문도 무제한 출력하지 않는다. */
	const source = JSON.stringify(details) ?? "null";
	if (source.length <= 2000) return source;
	return JSON.stringify({
		result: excerpt(source, 1600),
		evidence: { path: await responseEvidence(details, options) },
	});
}
export async function errorContent(
	error: string,
	status: Workflow | { error: string },
	options: Options,
): Promise<string> {
	let errorEvidence: { path: string } | { error: string | undefined } | undefined;
	if (error.length > 1600) {
		try {
			errorEvidence = { path: await responseEvidence({ error }, options) };
		} catch (storageError) {
			errorEvidence = { error: excerpt(String(storageError)) };
		}
	}
	return JSON.stringify({
		...(isWorkflow(status) ? workflowSummary(status, options) : {}),
		ok: false,
		error: excerpt(error, 1600),
		...(errorEvidence ? { errorEvidence } : {}),
	});
}
