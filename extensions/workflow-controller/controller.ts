import { stackPlanSchema } from "./stack-model.ts";
import { activateStackUnit, advanceStack, normalizeStackPlan, stackInstruction, stackVersion } from "./stack-state.ts";
import {
	validateStackPlan,
	readStackBase,
	prepareTask,
	inspectPreparation,
	verifyStackDependencies,
	verifyUnitCI,
	inspectStackCompletion,
} from "./stack.ts";
import { randomUUID } from "node:crypto";
import type {
	AgentBeforeSettleEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { deliveredHead, inspectDelivery, prBase, reconcileCommitIntents, type DeliveryResult } from "./delivery.ts";
import { alive, fingerprint, load, mustRun, run, runCheck, save, snapshot } from "./io.ts";
import {
	activeAttempts,
	boundOutput,
	DISPATCH_THINKING_LEVELS,
	type DispatchThinking,
	dispatchCommand,
	evidenceValid,
	guard,
	hash,
	normalizeSpec,
	ownerOf,
	planVersion,
	protectedBranch,
	roleTask,
	sameOwner,
	specSchema,
	terminal,
	verdict,
	type Attempt,
	type ControlSource,
	type Options,
	type Owner,
	type Role,
	type Workflow,
} from "./model.ts";

export const toolNames = [
	"status",
	"start",
	"pause",
	"resume",
	"cancel",
	"propose",
	"stack_propose",
	"dispatch",
	"check",
	"recover",
	"block",
].map((name) => `workflow_${name}`);
type ManagedEvent =
	| {
			type: "claim";
			attemptId: string;
			agent: string;
			contextMode: "main" | "isolated";
			respond: (reply: unknown) => void;
	  }
	| { type: "started"; attemptId: string; owner: Owner; runId: number; agent: string; sessionFile?: string }
	| {
			type: "finished";
			attemptId: string;
			owner: Owner;
			runId: number;
			status: "completed" | "failed" | "aborted";
			removed: boolean;
			finalOutput: string;
			exitCode?: number;
			stopReason?: string;
			retryCount: number;
	  };
export type DispatchInput = {
	role: Role;
	task: string;
	agent?: string;
	contextMode?: "main" | "isolated";
	thinking?: string;
	reviewKey?: string;
};
type RecoverInput = { attemptId: string; assessment: "complete" | "partial" | "unknown"; notes: string };
type DeliveryInspection = { state: Workflow; observed: Workflow; kind?: "prepare" | "deliver" | "stack" };

function dispatchOptions(input: DispatchInput): {
	agent: string;
	mode: "main" | "isolated";
	thinking?: DispatchThinking;
} {
	const agent =
		input.agent ??
		{ implement: "worker", review: "reviewer", research: "searcher", deliver: "worker", prepare: "worker" }[input.role];
	const mode = input.contextMode ?? (["implement", "deliver", "prepare"].includes(input.role) ? "main" : "isolated");
	if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(agent) || !["main", "isolated"].includes(mode))
		throw new Error("잘못된 agent·contextMode");
	if (input.thinking !== undefined && !(DISPATCH_THINKING_LEVELS as readonly string[]).includes(input.thinking))
		throw new Error(`effort는 ${DISPATCH_THINKING_LEVELS.join("·")} 중 하나여야 합니다.`);
	return { agent, mode, thinking: input.thinking as DispatchThinking | undefined };
}

export class WorkflowController {
	private state?: Workflow;
	private context?: ExtensionContext;
	private fatal?: string;
	private readOnly = false;
	private unresolvedRef = false;
	private queue: Promise<unknown> = Promise.resolve();
	private stopTimer?: ReturnType<typeof setTimeout>;
	private checking = false;
	private delivering = false;
	private checkAbort?: AbortController;
	private unsubscribeInput?: () => void;
	private now: () => Date;
	constructor(
		private pi: ExtensionAPI,
		private options: Options,
	) {
		this.now = options.now ?? (() => new Date());
		pi.events.on("subagent:managed:v1:event", (raw) => this.managedEvent(raw));
	}
	serial<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => {});
		return result;
	}
	private at(): string {
		return this.now().toISOString();
	}
	private notify(message: string): void {
		this.context?.ui.notify(message, "error");
	}
	private owned(): boolean {
		return (
			!!this.state &&
			!this.readOnly &&
			this.state.owner.pid === process.pid &&
			this.state.owner.sessionId === this.context?.sessionManager.getSessionId()
		);
	}
	private requireState(): Workflow {
		if (this.fatal) throw new Error(this.fatal);
		if (!this.state) throw new Error("워크플로가 없습니다. workflow_start 또는 /workflow start를 사용하세요.");
		if (!this.owned()) throw new Error("다른 세션 소유 워크플로입니다. 읽기 전용입니다.");
		if (terminal(this.state)) throw new Error("종료된 워크플로입니다.");
		return this.state;
	}
	private running(): Workflow {
		const state = this.requireState();
		if (state.control !== "running") throw new Error(`실행 불가: ${state.control} ${state.reason ?? ""}`);
		return state;
	}
	private async approved(state: Workflow): Promise<Awaited<ReturnType<typeof snapshot>>> {
		if (!state.approval || state.approval.planVersion !== state.planVersion)
			throw new Error("사용자 승인이 필요합니다.");
		const current = await snapshot(this.context?.cwd ?? state.repoRoot);
		if (current.repoRoot !== state.approval.repoRoot || current.branch !== state.approval.branch)
			throw new Error("승인된 저장소·브랜치와 다릅니다.");
		return current;
	}
	private display(): void {
		const state = this.state;
		const enabled = state && this.owned() && !this.fatal && !terminal(state);
		const active = this.pi.getActiveTools().filter((name) => !toolNames.includes(name));
		const lifecycle = ["workflow_status", "workflow_start"];
		this.pi.setActiveTools(
			enabled
				? [
						...active,
						...toolNames.filter(
							(name) => name !== (state.mode === "stack" ? "workflow_propose" : "workflow_stack_propose"),
						),
					]
				: [...active, ...lifecycle],
		);
		this.context?.ui.setStatus(
			"workflow",
			state
				? `${state.mode === "stack" ? `stack ${state.stack ? `${Math.min(state.stack.index + 1, state.stack.plan.units.length)}/${state.stack.plan.units.length} ${state.stack.stage}` : "계획"} · ` : ""}${state.phase} · ${state.control} · 개선 ${state.improvementCycles}/${state.spec?.maxImprovementCycles ?? 3} · 복구 ${state.recoveries}/${state.spec?.maxRecoveries ?? 2}${this.readOnly ? " · 읽기 전용" : ""}${this.fatal ? ` · ${this.fatal}` : state.reason ? ` · ${state.reason}` : ""}`
				: this.fatal,
		);
	}
	private async persist(message: string, increment = true): Promise<void> {
		if (!this.state) throw new Error("저장할 워크플로가 없습니다.");
		if (increment) {
			this.state.seq++;
			this.state.events.push({ seq: this.state.seq, at: this.at(), message });
			this.state.events = this.state.events.slice(-100);
		}
		try {
			await save(this.options.agentDir, this.state);
		} catch (error) {
			this.fatal = `워크플로 저장 오류: ${String(error)}`;
			this.display();
			throw new Error(this.fatal);
		}
		this.display();
	}
	private request(type: string, args: Record<string, unknown> = {}): unknown {
		let response: unknown;
		this.pi.events.emit("subagent:managed:v1:request", {
			type,
			...args,
			respond: (value: unknown) => {
				response = value;
			},
		});
		return response;
	}
	private assertRunsStopped(state: Workflow): void {
		const generations = new Set([state.owner.generation, ...state.attempts.map((attempt) => attempt.generation)]);
		for (const generation of generations) {
			const response = this.request("inspect", { owner: { workflowId: state.workflowId, generation } }) as
				| { ok?: boolean; runs?: { status: string; abortPending?: boolean }[] }
				| undefined;
			if (response?.ok !== true || !Array.isArray(response.runs))
				throw new Error("관리 실행 종료 확인 불가: inspect 응답이 없습니다.");
			/* remove는 취소 요청일 뿐이다. 실제 종료 전에는 다음 소유 세대로 넘어가지 않는다. */
			if (response.runs.some((run) => run.status === "running" || run.abortPending))
				throw new Error("아직 종료하지 않은 관리 작업이 있습니다.");
		}
	}
	async command(args: string, ctx: ExtensionContext): Promise<void> {
		this.context = ctx;
		try {
			if (args.trim() === "approve" && this.state?.mode === "stack") {
				await this.approveStack("command");
				return;
			}
			if (args.trim() === "resume") {
				await this.resume();
				return;
			}
			await this.serial(async () => {
				const [sub, ...rest] = args.trim().split(/\s+/);
				switch (sub) {
					case "start": {
						let auto = false;
						let stack = false;
						while (rest[0]?.startsWith("--")) {
							const flag = rest.shift();
							if (flag === "--auto") auto = true;
							else if (flag === "--stack") stack = true;
							else throw new Error(`알 수 없는 workflow 옵션: ${flag}`);
						}
						await this.start(rest.join(" "), auto, stack);
						break;
					}
					case "status":
						this.display();
						ctx.ui.notify(JSON.stringify(this.status(), null, 2), "info");
						break;
					case "approve":
						await this.approve("command");
						break;
					case "pause":
						await this.stop("paused");
						break;
					case "cancel":
						await this.stop("cancelled");
						break;
					default:
						throw new Error("사용법: /workflow start [--stack] [--auto] <목표>|status|approve|pause|resume|cancel");
				}
			});
		} catch (error) {
			this.notify(String(error));
		}
	}
	async startFromTool(input: { goal: string; mode?: "single" | "stack" }, ctx: ExtensionToolContext): Promise<void> {
		await this.serial(async () => {
			this.context = ctx;
			if (this.state?.userHold) throw new Error("사용자 보류는 /workflow resume 또는 /workflow start로만 해제합니다.");
			await this.start(input.goal.trim(), false, input.mode === "stack", "orchestrator");
		});
	}
	async stopFromTool(target: "paused" | "cancelled", reason: string, ctx: ExtensionToolContext): Promise<void> {
		await this.serial(async () => {
			this.context = ctx;
			await this.stop(target, "orchestrator", reason.trim());
		});
	}
	async resumeFromTool(ctx: ExtensionToolContext, signal?: AbortSignal): Promise<void> {
		const state = await this.serial(async () => {
			this.context = ctx;
			return this.state;
		});
		let stopping: Promise<void> | undefined;
		const pause = () => {
			stopping ??= this.serial(async () => {
				if (state && this.state === state && this.owned() && !terminal(state)) await this.stop("paused", "user");
			}).catch((error) => this.notify(String(error)));
		};
		signal?.addEventListener("abort", pause, { once: true });
		try {
			if (signal?.aborted) pause();
			await this.resume("orchestrator", signal);
		} finally {
			signal?.removeEventListener("abort", pause);
			await stopping;
		}
	}
	private async start(goal: string, auto: boolean, stack = false, source: ControlSource = "user"): Promise<void> {
		if (this.fatal || this.readOnly) throw new Error(this.fatal ?? "다른 프로세스 소유 워크플로입니다.");
		if (this.state && !this.owned()) throw new Error("다른 세션 소유 워크플로입니다.");
		if (this.state && !terminal(this.state)) throw new Error("세션당 비종료 워크플로는 하나입니다.");
		if (this.checking || this.delivering || (this.state && activeAttempts(this.state).length))
			throw new Error("아직 종료하지 않은 작업이 있습니다.");
		if (!goal.trim()) throw new Error("목표가 필요합니다.");
		const capabilities = this.request("capabilities") as { version?: number; features?: string[] } | undefined;
		if (
			capabilities?.version !== 1 ||
			!["claim", "cancel", "inspect", "finished", "no-outer-retry", "thinking"].every((feature) =>
				capabilities.features?.includes(feature),
			)
		)
			throw new Error("subagent 관리 API v1 지원이 필요합니다.");
		if (this.state) this.assertRunsStopped(this.state);
		const current = await snapshot(this.context?.cwd ?? "");
		this.state = {
			workflowId: randomUUID(),
			repoKey: hash(current.repoRoot).slice(0, 16),
			repoRoot: current.repoRoot,
			goal,
			...(stack ? { mode: "stack" as const } : {}),
			...(auto ? { autoApprove: true as const } : {}),
			phase: "drafting",
			control: "running",
			controlSource: source,
			userHold: false,
			controlRevision: 0,
			attempts: [],
			checks: [],
			deliveries: [],
			improvementCycles: 0,
			recoveries: 0,
			owner: {
				sessionId: this.context?.sessionManager.getSessionId() ?? "",
				sessionFile: this.context?.sessionManager.getSessionFile(),
				pid: process.pid,
				generation: 1,
			},
			seq: 0,
			lastContinuationSeq: -1,
			events: [],
		};
		await this.persist("start");
		this.pi.appendEntry("workflow-ref", {
			workflowId: this.state.workflowId,
			repoKey: this.state.repoKey,
			repoRoot: this.state.repoRoot,
		});
		if (source === "user")
			this.pi.sendUserMessage(
				`목표: ${goal}\n읽기 전용으로 조사하고 ${stack ? "workflow_stack_propose로 선형 PR 분할·rootBase·각 branch·checks·requiredReviews·ciChecks·integrationChecks·integrationReviews" : "workflow_propose로 계획·검사 명령·종료 지점"}을 제안하세요. ${auto ? "사용자가 --auto로 시작해 계획은 안전 조건을 통과하면 자동 승인됩니다. 승인되면 사용자에게 묻지 말고 이어서 진행하세요." : "사용자 승인 전에는 구현하지 마세요."} 승인 후에는 workflow_dispatch로 작업·독립 검수를 분담하고 workflow_check로 검증하세요. commit·push·PR은 직접 실행하지 말고 검수 통과 뒤 workflow_dispatch role deliver로 전달 worker에게 맡기세요. merge·배포 금지.`,
			);
	}
	status(): Workflow | { error: string } {
		if (this.fatal) return { error: this.fatal };
		return this.state ? structuredClone(this.state) : { error: "워크플로가 없습니다." };
	}
	async propose(input: unknown): Promise<void> {
		const state = this.running();
		if (state.mode === "stack") throw new Error("stack 모드에서는 workflow_stack_propose를 사용하세요.");
		if (!Value.Check(specSchema, input)) throw new Error("유효한 계획·검사 명령·종료 지점이 필요합니다.");
		if (activeAttempts(state).length || this.checking || this.delivering)
			throw new Error("실행 중 작업이 있어 계획을 바꿀 수 없습니다.");
		const spec = normalizeSpec(input);
		if (input.prBase !== undefined) {
			if (spec.endpoint !== "pr") throw new Error("prBase는 pr 종료 지점에서만 지정합니다.");
			if (input.prBase !== "stage" && protectedBranch(input.prBase))
				throw new Error("보호 브랜치는 stacked PR base로 지정할 수 없습니다.");
			if ((await run(state.repoRoot, "git", ["check-ref-format", "--branch", input.prBase])).code !== 0)
				throw new Error("prBase가 올바른 브랜치 이름이 아닙니다.");
		}
		if (spec.checks.some((command) => guard("bash", { command })))
			throw new Error("검사 명령에서 전달·merge·workflow 실행은 금지입니다.");
		if (!Value.Check(specSchema, spec)) throw new Error("빈 계획·검사 명령은 허용하지 않습니다.");
		const version = planVersion(spec);
		if (version === state.planVersion && state.approval) return;
		state.spec = spec;
		state.planVersion = version;
		state.phase = "awaiting-approval";
		state.approval = undefined;
		state.verification = undefined;
		state.review = undefined;
		state.reviewResults = undefined;
		await this.persist("propose");
		if (state.autoApprove) {
			await this.approve("auto").catch((error) => {
				throw new Error(
					`자동 승인 실패: ${error instanceof Error ? error.message : error} 해결 뒤 /workflow approve로 승인하세요.`,
				);
			});
			return;
		}
		if (this.context?.hasUI) {
			const choice = await this.context.ui.select(
				`${spec.title}\n${spec.objective}\n검사: ${spec.checks.join("; ")}\n종료: ${spec.endpoint === "pr" ? `Draft PR (base ${spec.prBase})` : spec.endpoint}`,
				["승인", "보류"],
				{ timeout: 60_000 },
			);
			if (choice === "승인") await this.approve("ui");
		}
	}
	async proposeStack(input: unknown): Promise<void> {
		const { state, plan } = await this.serial(async () => {
			const state = this.running();
			if (
				state.mode !== "stack" ||
				!["drafting", "awaiting-approval"].includes(state.phase) ||
				state.stack?.approval ||
				this.delivering
			)
				throw new Error("명시적으로 시작한 stack의 승인 대기 단계에서만 계획할 수 있습니다.");
			if (!Value.Check(stackPlanSchema, input)) throw new Error("스택 계획 형식 오류");
			const plan = normalizeStackPlan(input);
			if (!Value.Check(stackPlanSchema, plan)) throw new Error("스택 계획에 빈 항목이나 중복이 있습니다.");
			return { state, plan };
		});
		await validateStackPlan(state.repoRoot, plan);
		await this.serial(async () => {
			if (this.running() !== state || state.stack?.approval) throw new Error("계획 도중 상태가 변경되었습니다.");
			state.stack = { plan, planVersion: stackVersion(plan), index: 0, stage: "planned", results: [] };
			state.phase = "awaiting-approval";
			await this.persist("stack proposed");
		});
		if (state.autoApprove) {
			await this.approveStack("auto", stackVersion(plan));
			return;
		}
		if (this.context?.hasUI) {
			const choice = await this.context.ui.select(
				`스택 계획 승인\n${JSON.stringify(plan, null, 2)}\n전달: commit·push·Draft PR. merge·배포·restack 금지.`,
				["승인", "보류"],
			);
			if (choice === "승인") await this.approveStack("ui", stackVersion(plan));
		}
	}
	private async approveStack(via: "ui" | "command" | "auto", expectedVersion?: string): Promise<void> {
		const { state, observed } = await this.serial(async () => {
			const state = this.running();
			if (state.phase !== "awaiting-approval" || !state.stack || state.stack.approval || this.delivering)
				throw new Error("승인할 스택 계획이 없습니다.");
			if (expectedVersion && state.stack.planVersion !== expectedVersion)
				throw new Error("승인 화면 이후 계획이 변경됐습니다. 새 계획을 확인하세요.");
			const current = await snapshot(state.repoRoot);
			if (current.statusShort) throw new Error("스택 승인에는 clean 작업 트리가 필요합니다.");
			this.delivering = true;
			return { state, observed: structuredClone(state) };
		});
		try {
			const plan = observed.stack?.plan;
			if (!plan) throw new Error("스택 계획이 없습니다.");
			await validateStackPlan(state.repoRoot, plan);
			const rootHead = await readStackBase(state.repoRoot, plan);
			const rootFingerprint = await mustRun(state.repoRoot, "git", ["rev-parse", `${rootHead}^{tree}`]);
			await this.serial(async () => {
				if (!this.ownsInspection({ state, observed }) || state.control !== "running")
					throw new Error("승인 중 워크플로가 중단됐습니다.");
				const current = await snapshot(state.repoRoot);
				if (current.statusShort) throw new Error("승인 도중 작업 트리가 변경됐습니다.");
				if (!state.stack) throw new Error("스택 계획이 없습니다.");
				state.stack.approval = {
					at: this.at(),
					via,
					rootHead,
					rootFingerprint,
					sourceBranch: current.branch,
					sourceHead: current.head,
				};
				activateStackUnit(state, this.at());
				await this.persist("stack approved");
			});
		} finally {
			await this.serial(async () => {
				this.delivering = false;
				if (this.state === state && state.control === "stopping" && !this.fatal) {
					await this.settleStop();
					await this.persist("stack approval stopped");
				}
			});
		}
	}
	private async approve(via: "ui" | "command" | "auto"): Promise<void> {
		const state = this.running();
		if (state.phase !== "awaiting-approval" || !state.spec || !state.planVersion)
			throw new Error("승인 대기 중인 계획이 없습니다.");
		const current = await snapshot(this.context?.cwd ?? state.repoRoot);
		if (current.repoRoot !== state.repoRoot) throw new Error("계획 저장소와 다릅니다.");
		if (state.spec.endpoint !== "verify" && current.statusShort)
			throw new Error("commit/pr 승인에는 clean 작업 트리가 필요합니다.");
		if (state.spec.endpoint === "pr" && protectedBranch(current.branch))
			throw new Error("보호 브랜치에서 PR 승인은 금지입니다.");
		state.approval = {
			planVersion: state.planVersion,
			at: this.at(),
			via,
			repoRoot: current.repoRoot,
			branch: current.branch,
			head: current.head,
			fingerprint: current.fingerprint,
		};
		state.phase = "executing";
		await this.persist("approve");
	}
	async dispatch(input: DispatchInput, ctx: ExtensionToolContext): Promise<void> {
		this.context = ctx;
		const attempt = await this.serial(() => this.prepareDispatch(input));
		try {
			const result = await ctx.executeTool("subagent", {
				command: dispatchCommand(attempt),
			});
			await this.serial(async () => {
				if (result.isError && ["dispatching", "running"].includes(attempt.status)) {
					attempt.status = attempt.claimed ? "failed" : "rejected";
					await this.settleStop();
					await this.persist("dispatch rejected");
				} else if (!attempt.claimed && attempt.status === "dispatching") {
					attempt.status = "rejected";
					await this.settleStop();
					await this.persist("claim missing");
					throw new Error("관리 claim 응답이 없습니다.");
				}
			});
			if (result.isError)
				throw new Error(
					attempt.claimed
						? `worker 실행이 ${attempt.status} 상태로 끝났습니다. 다시 실행하기 전에 workflow_recover로 실제 작업 공간을 기록하세요.`
						: "subagent 실행이 거절되었습니다.",
				);
		} catch (error) {
			await this.serial(async () => {
				if (attempt.status === "dispatching") {
					attempt.status = "rejected";
					await this.settleStop();
					await this.persist("dispatch error");
				}
			});
			throw error;
		}
	}
	private async assertDeliverable(state: Workflow, current: { head: string; fingerprint: string }): Promise<void> {
		if (state.phase === "ready-to-deliver" && state.review && state.review.fingerprint !== current.fingerprint) {
			await this.invalidateEvidence(state);
			throw new Error("검수 이후 파일 변경: workflow_check로 재검사하세요.");
		}
		if (state.phase !== "ready-to-deliver" || activeAttempts(state).length || !evidenceValid(state))
			throw new Error("검수된 내용과 같고 실행 중 작업이 없는 전달 단계에서만 허용합니다.");
		if (current.head !== (deliveredHead(state) ?? state.approval?.head))
			throw new Error("승인·전달 기록 뒤 다른 커밋이 있습니다.");
	}
	private async assertRoleReady(
		role: Role,
		agent: string,
		state: Workflow,
		current: { head: string; fingerprint: string },
		reviewKey?: string,
	): Promise<void> {
		if (role === "prepare") return;
		if (role === "implement") {
			if (state.phase !== "executing" || activeAttempts(state).some((a) => a.role === "implement"))
				throw new Error("구현은 executing에서 한 번에 하나만 실행합니다.");
			if (
				state.attempts.some(
					(a) => a.role === "implement" && ["failed", "aborted", "interrupted"].includes(a.status) && !a.recovered,
				)
			)
				throw new Error("중단·실패한 구현은 workflow_recover로 실제 작업 공간을 기록하세요.");
		}
		if (role === "review") {
			if (state.phase === "reviewing" && state.verification && state.verification.fingerprint !== current.fingerprint) {
				await this.invalidateEvidence(state);
				throw new Error("검사 이후 파일 변경: workflow_check로 재검사하세요.");
			}
			if (
				state.phase !== "reviewing" ||
				!state.verification?.id ||
				state.verification.fingerprint !== current.fingerprint ||
				activeAttempts(state).some((a) => a.role === "review" && (a.reviewKey ?? "code") === reviewKey)
			)
				throw new Error("현재 검사 증거가 없거나 검수 중입니다.");
			const implementations =
				state.stack?.stage === "integration"
					? [...state.attempts, ...state.stack.results.flatMap((result) => result.execution.attempts)]
					: state.attempts;
			if (implementations.some((attempt) => attempt.role === "implement" && attempt.agent === agent))
				throw new Error("검수 agent는 구현 agent와 달라야 합니다.");
		}
		if (role === "deliver") await this.assertDeliverable(state, current);
	}
	private hasManagedPreparation(state: Workflow): boolean {
		/* attempts는 PR 전환 때 비워진다. 재시작은 같은 PR의 시작 기록을 남기고 소유 세대만 올린다. */
		return (
			state.stack?.stage === "preparing" &&
			state.attempts.some(
				(attempt) =>
					attempt.role === "prepare" &&
					attempt.claimed === true &&
					Number.isInteger(attempt.runId) &&
					attempt.generation <= state.owner.generation &&
					!["dispatching", "rejected"].includes(attempt.status),
			)
		);
	}
	private assertStackRole(
		state: Workflow,
		role: Role,
		current: { branch: string; head: string; statusShort: string },
	): void {
		const stack = state.stack;
		if (role === "prepare" && (!stack?.approval || stack.stage !== "preparing"))
			throw new Error("prepare는 스택 브랜치 준비 단계 전용입니다.");
		if (!stack) return;
		if (stack.invalidatedFrom !== undefined) throw new Error("부모 변경으로 무효화된 스택입니다. 자동 restack 금지.");
		if (stack.stage === "preparing") {
			if (role !== "prepare" || activeAttempts(state).length || current.statusShort)
				throw new Error("clean 상태에서 prepare worker 하나만 실행하세요.");
			const previous = stack.results.at(-1);
			const branch = previous?.branch ?? stack.approval?.sourceBranch;
			const head = previous?.head ?? stack.approval?.sourceHead;
			const prepared = current.branch === state.approval?.branch && current.head === state.approval.head;
			if (prepared && !this.hasManagedPreparation(state))
				throw new Error("관리 prepare 실행 기록 없는 동명 브랜치는 재사용하지 않습니다.");
			if (!prepared && (current.branch !== branch || current.head !== head))
				throw new Error("준비 시작 브랜치·HEAD가 승인과 다릅니다.");
		}
		if (stack.stage === "integration" && !["review", "research"].includes(role))
			throw new Error("통합 단계에서는 검사와 검수만 허용합니다.");
	}
	private async prepareDispatch(input: DispatchInput): Promise<Attempt> {
		const state = this.running();
		const current = state.stack?.stage === "preparing" ? await snapshot(state.repoRoot) : await this.approved(state);
		if (this.checking || this.delivering) throw new Error("검사·전달 중에는 새 작업을 실행하지 않습니다.");
		if (!["implement", "review", "research", "deliver", "prepare"].includes(input.role) || !input.task?.trim())
			throw new Error("역할·작업이 필요합니다.");
		if (!["executing", "reviewing", "ready-to-deliver"].includes(state.phase)) throw new Error("실행 단계가 아닙니다.");
		const { agent, mode, thinking } = dispatchOptions(input);
		/* 재개한 워크플로도 실행 시점의 subagent가 effort를 실제로 적용하는지 확인한다. */
		if (thinking) {
			const capabilities = this.request("capabilities") as { version?: number; features?: string[] } | undefined;
			if (capabilities?.version !== 1 || !capabilities.features?.includes("thinking"))
				throw new Error("현재 subagent 관리 API가 effort 지정을 지원하지 않습니다.");
		}
		this.assertStackRole(state, input.role, current);
		const keys = state.spec?.requiredReviews ?? ["code"];
		const reviewKey =
			input.role === "review" ? (input.reviewKey ?? (keys.length === 1 ? keys[0] : undefined)) : undefined;
		if (input.role === "review" && (!reviewKey || !keys.includes(reviewKey)))
			throw new Error("계획의 필수 검수 이름을 reviewKey로 지정하세요.");
		await this.assertRoleReady(input.role, agent, state, current, reviewKey);
		const attempt: Attempt = {
			id: randomUUID(),
			role: input.role,
			...(reviewKey ? { reviewKey } : {}),
			agent,
			contextMode: mode,
			...(thinking ? { thinking } : {}),
			task: roleTask(
				input.role,
				input.role === "prepare"
					? `${input.task}\n${prepareTask(state)}`
					: `${input.task}${reviewKey ? `\n검수 관점: ${reviewKey}` : ""}`,
				input.role === "deliver" && state.spec?.endpoint !== "verify" && state.spec
					? { endpoint: state.spec.endpoint, base: prBase(state), branch: current.branch, head: current.head }
					: undefined,
			),
			generation: state.owner.generation,
			status: "dispatching",
			fingerprintAtDispatch: current.fingerprint,
			verificationId: state.verification?.id,
		};
		state.attempts.push(attempt);
		await this.persist("dispatching");
		return attempt;
	}
	private managedEvent(raw: unknown): void {
		if (typeof raw !== "object" || raw === null || !("type" in raw)) return;
		const event = raw as ManagedEvent;
		if (event.type === "claim") {
			this.claim(event);
			return;
		}
		if (event.type === "started" || event.type === "finished")
			void this.serial(() => this.lifecycle(event))
				.then((inspection) => inspection && this.deliveryFinished(inspection))
				.catch((error) => this.notify(String(error)));
	}
	private claim(event: Extract<ManagedEvent, { type: "claim" }>): void {
		if (typeof event.respond !== "function") return;
		const state = this.state;
		const attempt = state?.attempts.find((a) => a.id === event.attemptId);
		if (
			!state ||
			!this.owned() ||
			this.fatal ||
			state.control !== "running" ||
			terminal(state) ||
			!attempt ||
			attempt.status !== "dispatching" ||
			attempt.generation !== state.owner.generation ||
			attempt.claimed ||
			attempt.agent !== event.agent ||
			attempt.contextMode !== event.contextMode
		) {
			event.respond({ ok: false, reason: "사용 가능한 관리 attempt가 아닙니다." });
			return;
		}
		attempt.claimed = true;
		event.respond({
			ok: true,
			owner: ownerOf(state),
			task: attempt.task,
			...(attempt.thinking ? { thinking: attempt.thinking } : {}),
		});
	}
	private async lifecycle(event: Exclude<ManagedEvent, { type: "claim" }>): Promise<DeliveryInspection | undefined> {
		const state = this.state;
		if (!state || !this.owned() || this.fatal || !event.owner || !sameOwner(event.owner, ownerOf(state))) return;
		const attempt = state.attempts.find((a) => a.id === event.attemptId);
		if (
			!attempt ||
			attempt.generation !== state.owner.generation ||
			!attempt.claimed ||
			!["dispatching", "running"].includes(attempt.status)
		)
			return;
		if (event.type === "started") {
			if (attempt.status !== "dispatching" || attempt.agent !== event.agent || !Number.isInteger(event.runId)) return;
			attempt.runId = event.runId;
			attempt.status = "running";
			await this.persist("started");
			return;
		}
		if (attempt.runId !== event.runId || !["completed", "failed", "aborted"].includes(event.status)) return;
		attempt.status = event.status;
		attempt.finalOutput = boundOutput(event.finalOutput);
		attempt.exitCode = event.exitCode;
		attempt.stopReason = event.stopReason;
		attempt.fingerprintAtFinish = await fingerprint(state.repoRoot);
		if (attempt.role === "review") {
			/* 현재 증거의 파일 변경은 판정과 별개로 무효화한다. 오래된 리뷰는 새 증거를 건드리지 않는다. */
			if (
				state.control === "running" &&
				!attempt.reviewInvalidated &&
				state.verification?.id &&
				attempt.verificationId === state.verification.id &&
				attempt.fingerprintAtDispatch === state.verification.fingerprint &&
				attempt.fingerprintAtFinish !== state.verification.fingerprint
			)
				await this.invalidateEvidence(state);
			attempt.verdict = verdict(event.finalOutput);
			if (state.control === "running") this.reviewFinished(state, attempt);
		}
		await this.settleStop();
		await this.persist("finished");
		const kind =
			attempt.role === "prepare"
				? "prepare"
				: attempt.role === "deliver"
					? "deliver"
					: state.stack?.stage === "integration" && state.phase === "ready-to-deliver" && !activeAttempts(state).length
						? "stack"
						: undefined;
		if (kind && state.control === "running") {
			this.delivering = true;
			return { state, observed: structuredClone(state), kind };
		}
	}
	private ownsInspection({ state, observed }: DeliveryInspection): boolean {
		return (
			this.state === state &&
			this.owned() &&
			!this.fatal &&
			sameOwner(ownerOf(state), ownerOf(observed)) &&
			state.controlRevision === observed.controlRevision &&
			state.stack?.planVersion === observed.stack?.planVersion &&
			state.stack?.index === observed.stack?.index &&
			state.phase === observed.phase &&
			state.verification?.id === observed.verification?.id &&
			state.review?.fingerprint === observed.review?.fingerprint
		);
	}
	private async deliveryFinished(inspection: DeliveryInspection): Promise<void> {
		const { state, observed } = inspection;
		let result: DeliveryResult | undefined;
		let reason: string | undefined;
		try {
			/* 네트워크 조회는 직렬 큐 밖에서 복사본만 갱신한다. */
			result = await this.inspectResult(observed, inspection.kind);
			reason = result.complete
				? "검수 증거가 유효하지 않습니다."
				: `전달 미완료: ${result.reason} /workflow resume 뒤 다시 전달하세요.`;
		} catch (error) {
			reason = `전달 확인 실패: ${error instanceof Error ? error.message : String(error)}`;
		}
		await this.serial(async () => {
			this.delivering = false;
			if (this.ownsInspection(inspection) && state.control === "running") {
				state.deliveries = observed.deliveries;
				state.stack = observed.stack;
				if (result?.complete && (inspection.kind === "prepare" || evidenceValid(state)))
					this.applyInspection(state, inspection.kind);
				else {
					state.control = "blocked";
					state.controlSource = "system";
					state.reason = reason;
				}
				if (state.stack?.invalidatedFrom !== undefined) {
					state.verification = undefined;
					state.review = undefined;
					state.reviewResults = undefined;
				}
				await this.persist("delivery inspected");
				this.wakeStack(state);
			}
			if (this.state === state && !this.fatal && state.control === "stopping") {
				await this.settleStop();
				await this.persist("delivery inspection stopped");
			}
		});
	}
	private async inspectResult(state: Workflow, kind: DeliveryInspection["kind"] = "deliver"): Promise<DeliveryResult> {
		if (kind === "prepare") {
			if (!this.hasManagedPreparation(state))
				throw new Error("관리 prepare 실행 기록이 없어 브랜치 출처를 확인할 수 없습니다.");
			await inspectPreparation(state);
			return { complete: true };
		}
		if (kind === "stack") {
			await inspectStackCompletion(state);
			return { complete: true };
		}
		if (state.stack) await verifyStackDependencies(state);
		const result = await inspectDelivery(state, this.at());
		if (result.complete && state.stack) {
			const head = deliveredHead(state);
			if (!head) throw new Error("전달 커밋 기록이 없습니다.");
			await verifyUnitCI(state.repoRoot, head, state.stack.plan.units[state.stack.index].ciChecks);
			await verifyStackDependencies(state);
			const current = await snapshot(state.repoRoot);
			if (
				current.head !== deliveredHead(state) ||
				current.fingerprint !== state.review?.fingerprint ||
				current.statusShort
			)
				throw new Error("전달 확인 도중 작업 트리·HEAD가 변경됐습니다.");
		}
		return result;
	}
	private applyInspection(state: Workflow, kind: DeliveryInspection["kind"] = "deliver"): void {
		if (kind === "prepare" && state.stack) state.stack.stage = "unit";
		else if (kind === "deliver" && state.stack) advanceStack(state, this.at());
		else state.phase = "completed";
	}
	private wakeStack(state: Workflow): void {
		if (state.mode === "stack" && state.control === "running" && !terminal(state) && this.context?.isIdle())
			this.pi.sendUserMessage(stackInstruction(state) ?? "스택 다음 단계는 workflow_status로 확인하고 진행하세요.", {
				deliverAs: "followUp",
			});
	}
	private reviewFinished(state: Workflow, attempt: Attempt): void {
		if (
			attempt.reviewInvalidated ||
			!state.verification?.id ||
			attempt.verificationId !== state.verification.id ||
			attempt.fingerprintAtDispatch !== state.verification.fingerprint ||
			attempt.fingerprintAtFinish !== state.verification.fingerprint
		)
			return;
		if (attempt.status !== "completed" || attempt.verdict === "missing") return;
		if (attempt.verdict === "pass") {
			const key = attempt.reviewKey ?? "code";
			state.reviewResults = {
				...state.reviewResults,
				[key]: { attemptId: attempt.id, fingerprint: attempt.fingerprintAtFinish ?? "" },
			};
			if (
				!(state.spec?.requiredReviews ?? ["code"]).every(
					(name) => state.reviewResults?.[name]?.fingerprint === state.verification?.fingerprint,
				)
			)
				return;
			state.review = { attemptId: attempt.id, fingerprint: attempt.fingerprintAtFinish ?? "" };
			state.phase = state.spec?.endpoint === "verify" && !state.stack ? "completed" : "ready-to-deliver";
		}
		if (attempt.verdict === "blocked") {
			state.controlSource = "user";
			state.userHold = true;
			state.controlRevision = (state.controlRevision ?? 0) + 1;
			state.control = "blocked";
			state.reason = "검수에서 사용자 판단을 요청했습니다.";
		}
		if (attempt.verdict === "changes-requested") {
			if (state.improvementCycles >= (state.spec?.maxImprovementCycles ?? 3)) {
				state.control = "blocked";
				state.controlSource = "system";
				state.reason = "개선 한도 초과";
			} else {
				state.improvementCycles++;
				state.phase = "executing";
				state.verification = undefined;
				state.review = undefined;
				state.reviewResults = undefined;
			}
		}
	}
	private async invalidateEvidence(state: Workflow): Promise<void> {
		for (const attempt of activeAttempts(state)) {
			if (attempt.role === "review") attempt.reviewInvalidated = true;
		}
		state.verification = undefined;
		state.review = undefined;
		state.reviewResults = undefined;
		state.phase = "executing";
		if (state.improvementCycles >= (state.spec?.maxImprovementCycles ?? 3)) {
			state.control = "blocked";
			state.controlSource = "system";
			state.reason = "개선 한도 초과";
		} else {
			state.improvementCycles++;
			state.reason = "증거 지문 변경, workflow_check로 재검사하세요.";
		}
		await this.persist("evidence invalidated");
	}
	private async withSignal(signal: AbortSignal | undefined, operation: () => Promise<void>): Promise<void> {
		let stopping: Promise<void> | undefined;
		const pause = () => {
			this.checkAbort?.abort();
			stopping ??= this.serial(() => this.stop("paused", "user")).catch((error) => this.notify(String(error)));
		};
		signal?.addEventListener("abort", pause, { once: true });
		try {
			if (signal?.aborted) {
				pause();
				throw new Error("실행 signal이 중단되었습니다.");
			}
			await operation();
		} finally {
			signal?.removeEventListener("abort", pause);
			await stopping;
		}
	}
	async check(signal?: AbortSignal): Promise<void> {
		await this.withSignal(signal, () => this.performCheck());
	}
	private async performCheck(): Promise<void> {
		const { state, before, commands, abort } = await this.serial(async () => {
			const state = this.running();
			await this.approved(state);
			if (
				state.phase !== "executing" ||
				this.checking ||
				this.delivering ||
				state.stack?.stage === "preparing" ||
				state.stack?.invalidatedFrom !== undefined ||
				activeAttempts(state).some((a) => a.role === "implement")
			)
				throw new Error("구현 실행이 종료된 executing 단계에서만 검사합니다.");
			state.verification = undefined;
			state.review = undefined;
			state.reviewResults = undefined;
			state.checks = [];
			/* 재검사는 실행 중인 이전 리뷰의 결과를 무효로 만들되 종료 기록은 받는다. */
			for (const attempt of activeAttempts(state)) {
				if (attempt.role === "review") attempt.reviewInvalidated = true;
			}
			const before = await fingerprint(state.repoRoot);
			const abort = new AbortController();
			this.checkAbort = abort;
			this.checking = true;
			await this.persist("checks started");
			return { state, before, commands: [...(state.spec?.checks ?? [])], abort };
		});
		try {
			if (state.stack) {
				const observed = structuredClone(state);
				try {
					await verifyStackDependencies(observed);
				} catch (error) {
					await this.serial(async () => {
						if (this.state === state && !this.fatal) {
							state.stack = observed.stack;
							await this.persist("stack dependency invalidated");
						}
					});
					throw error;
				}
			}
			for (const command of commands) {
				if (abort.signal.aborted) throw new Error("검사가 중단되었습니다.");
				const result = await runCheck(state.repoRoot, command, abort.signal, {
					killGraceMs: this.options.checkKillGraceMs,
					timeoutMs: this.options.checkTimeoutMs,
					onTimeout: () => {
						void this.serial(() => this.stop("paused", "system", "검사 시간 초과")).catch((error) =>
							this.notify(String(error)),
						);
					},
				});
				await this.serial(async () => {
					if (this.state !== state || this.fatal) throw new Error("검사 소유 상태가 변경되었습니다.");
					const after = await fingerprint(state.repoRoot);
					state.checks.push({
						command,
						exitCode: result.code,
						stdout: boundOutput(result.stdout),
						stderr: boundOutput(result.stderr),
						at: this.at(),
						fingerprintBefore: before,
						fingerprintAfter: after,
					});
					await this.persist("check result");
					if (state.control !== "running" || abort.signal.aborted || result.code !== 0 || after !== before)
						throw new Error("검사 실패·중단 또는 검사 중 파일 변경");
				});
			}
			await this.serial(async () => {
				if (this.state !== state || state.control !== "running" || abort.signal.aborted || this.fatal)
					throw new Error("검사 도중 워크플로가 중단되었습니다.");
				await this.approved(state);
				if ((await fingerprint(state.repoRoot)) !== before) throw new Error("검사 이후 파일 변경");
				state.verification = { id: randomUUID(), fingerprint: before };
				state.phase = "reviewing";
				await this.persist("verified");
			});
		} catch (error) {
			await this.serial(async () => {
				if (this.state === state && state.stack && state.control === "running" && !this.fatal) {
					state.control = "blocked";
					state.controlSource = "system";
					state.reason = `스택 검사 실패: ${String(error)}`;
					await this.persist("stack check blocked");
				}
			});
			throw error;
		} finally {
			await this.serial(async () => {
				this.checking = false;
				if (this.checkAbort === abort) this.checkAbort = undefined;
				if (this.state === state && !this.fatal && state.control === "stopping") {
					await this.settleStop();
					await this.persist("checks stopped");
				}
			});
		}
	}

	async recover(input: RecoverInput): Promise<void> {
		const state = this.running();
		await this.approved(state);
		const attempt = state.attempts.find((a) => a.id === input.attemptId);
		if (
			attempt?.role !== "implement" ||
			!["failed", "aborted", "interrupted"].includes(attempt.status) ||
			attempt.recovered
		)
			throw new Error("복구할 실패·중단 구현이 없습니다.");
		if (!["complete", "partial", "unknown"].includes(input.assessment) || !input.notes.trim())
			throw new Error("복구 평가·메모가 필요합니다.");
		const current = await this.approved(state);
		attempt.recovered = {
			at: this.at(),
			assessment: input.assessment,
			notes: input.notes,
			head: current.head,
			fingerprint: current.fingerprint,
			statusShort: current.statusShort,
		};
		state.recoveries++;
		if (state.recoveries > (state.spec?.maxRecoveries ?? 2)) {
			state.control = "blocked";
			state.controlSource = "system";
			state.reason = "복구 한도 초과";
		}
		await this.persist("recovered");
	}
	async block(reason: string): Promise<void> {
		const state = this.running();
		if (!reason.trim()) throw new Error("차단 사유가 필요합니다.");
		state.control = "blocked";
		state.controlSource = "user";
		state.userHold = true;
		state.controlRevision = (state.controlRevision ?? 0) + 1;
		state.reason = reason;
		await this.persist("blocked");
	}
	private async stop(target: "paused" | "cancelled", source: ControlSource = "user", reason?: string): Promise<void> {
		const state = this.state;
		if (!state || !this.owned() || terminal(state)) throw new Error("중단할 소유 워크플로가 없습니다.");
		if (source === "orchestrator" && state.userHold)
			throw new Error("사용자 보류를 Orchestrator가 변경할 수 없습니다.");
		state.userHold ||= source === "user";
		state.controlSource = state.userHold ? "user" : source;
		state.controlRevision = (state.controlRevision ?? 0) + 1;
		this.checkAbort?.abort();
		if (this.fatal) {
			this.request("cancel", { owner: ownerOf(state), reason: `workflow ${target}` });
			throw new Error(this.fatal);
		}
		state.control = "stopping";
		/* 이미 요청된 취소를 늦은 pause signal이나 timeout으로 되돌리지 않는다. */
		state.stopTarget = state.stopTarget === "cancelled" ? "cancelled" : target;
		if (!/(?:개선|복구) 한도 초과/.test(state.reason ?? "")) state.reason = reason;
		this.checkAbort?.abort();
		let error: unknown;
		try {
			await this.persist(`stopping ${target}${source === "orchestrator" ? `: ${reason}` : ""}`);
		} catch (caught) {
			error = caught;
		}
		/* 저장 실패하더라도 소유 run에 대한 중단 요청은 보낸다. */
		const response = this.request("cancel", { owner: ownerOf(state), reason: `workflow ${target}` });
		if (!response) state.reason = "관리 중단 응답 없음, 종료 미확인";
		if (error) throw error;
		await this.settleStop();
		await this.persist(`stop requested ${target}`);
		if (state.control === "stopping") {
			clearTimeout(this.stopTimer);
			this.stopTimer = setTimeout(() => {
				void this.serial(async () => {
					if (this.state === state && state.control === "stopping" && !this.fatal) {
						if (!/(?:개선|복구) 한도 초과/.test(state.reason ?? "")) state.reason = "종료 미확인";
						await this.persist("stop timeout");
					}
				}).catch((error) => this.notify(String(error)));
			}, this.options.stopTimeoutMs ?? 20_000);
			this.stopTimer.unref();
		}
	}
	private async settleStop(): Promise<void> {
		if (
			this.state?.control === "stopping" &&
			!activeAttempts(this.state).length &&
			!this.delivering &&
			!this.checking
		) {
			this.state.control = this.state.stopTarget ?? "paused";
			if (/^(?:종료 미확인|관리 중단 응답 없음)/.test(this.state.reason ?? "")) this.state.reason = undefined;
			clearTimeout(this.stopTimer);
		}
	}
	private async resume(source: "user" | "orchestrator" = "user", signal?: AbortSignal): Promise<void> {
		const inspection = await this.serial(async () => {
			const state = this.requireState();
			if (signal?.aborted) throw new Error("사용자가 재개를 중단했습니다.");
			if (source === "orchestrator" && state.userHold)
				throw new Error("사용자 중단·판단 보류는 /workflow resume으로만 해제합니다.");
			if (
				!["paused", "blocked"].includes(state.control) ||
				/(?:개선|복구) 한도 초과/.test(state.reason ?? "") ||
				state.recoveries > (state.spec?.maxRecoveries ?? 2)
			)
				throw new Error("재개할 수 없는 상태입니다.");
			if (activeAttempts(state).length || this.delivering || this.checking)
				throw new Error("아직 종료하지 않은 작업이 있습니다.");
			this.assertRunsStopped(state);
			state.resumeSnapshot =
				state.approval && state.stack?.stage !== "preparing"
					? await this.approved(state)
					: await snapshot(state.repoRoot);
			await this.persist("resume inspected");
			this.delivering = true;
			return { state, observed: structuredClone(state) };
		});
		const { state, observed } = inspection;
		try {
			if (observed.stack?.approval) await verifyStackDependencies(observed);
			await reconcileCommitIntents(observed);
			const preparing =
				observed.stack?.stage === "preparing" &&
				(await snapshot(observed.repoRoot)).branch === observed.approval?.branch;
			const kind: DeliveryInspection["kind"] = preparing
				? "prepare"
				: observed.stack?.stage === "integration"
					? "stack"
					: "deliver";
			const result =
				preparing || (observed.phase === "ready-to-deliver" && evidenceValid(observed))
					? await this.inspectResult(observed, kind)
					: undefined;
			await this.serial(async () => {
				if (signal?.aborted || !this.ownsInspection(inspection) || !["paused", "blocked"].includes(state.control))
					throw new Error("재개 도중 상태가 변경되었습니다.");
				state.deliveries = observed.deliveries;
				state.stack = observed.stack;
				if (result?.complete) {
					this.applyInspection(state, kind);
					if (terminal(state)) {
						state.control = "running";
						state.controlSource = source;
						state.userHold = false;
						state.controlRevision = (state.controlRevision ?? 0) + 1;
						state.stopTarget = undefined;
						state.reason = undefined;
						await this.persist("resume reconciled completed");
						return;
					}
				}
				state.control = "running";
				state.controlSource = source;
				state.userHold = false;
				state.controlRevision = (state.controlRevision ?? 0) + 1;
				state.stopTarget = undefined;
				state.reason = undefined;
				await this.persist("resume");
				if (source === "user")
					this.pi.sendUserMessage(
						`워크플로 재개: ${state.phase}. 중단·실패한 implement는 workflow_recover로 HEAD·지문·status를 확인한 뒤 다시 실행하세요. 현재 상태는 workflow_status로 확인하세요.`,
					);
			});
		} catch (error) {
			await this.serial(async () => {
				if (this.ownsInspection(inspection) && ["paused", "blocked"].includes(state.control)) {
					state.deliveries = observed.deliveries;
					state.stack = observed.stack;
					if (state.stack?.invalidatedFrom !== undefined) {
						state.verification = undefined;
						state.review = undefined;
						state.reviewResults = undefined;
					}
					state.control = "blocked";
					state.controlSource = state.userHold ? "user" : "system";
					state.reason = String(error);
					await this.persist("resume reconciliation blocked");
				}
			});
			throw error;
		} finally {
			await this.serial(async () => {
				this.delivering = false;
				if (this.state === state && !this.fatal && state.control === "stopping") {
					await this.settleStop();
					await this.persist("resume stopped");
				}
			});
		}
	}

	private pauseInterrupted(state: Workflow, reason: string): void {
		if (terminal(state) || !["running", "stopping"].includes(state.control)) return;
		state.control = "paused";
		state.controlSource = state.userHold ? "user" : "system";
		state.controlRevision = (state.controlRevision ?? 0) + 1;
		if (!/(?:개선|복구) 한도 초과/.test(state.reason ?? "")) state.reason = reason;
	}

	async sessionStart(ctx: ExtensionContext): Promise<void> {
		await this.serial(async () => {
			clearTimeout(this.stopTimer);
			this.checkAbort?.abort();
			this.unsubscribeInput?.();
			this.context = ctx;
			this.state = undefined;
			this.readOnly = false;
			this.unresolvedRef = false;
			this.fatal = undefined;
			const ref = ctx.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "workflow-ref")
				.at(-1);
			if (ref?.type === "custom") {
				this.unresolvedRef = true;
				try {
					const data = ref.data as { workflowId: string; repoKey: string; repoRoot: string };
					this.state = await load(this.options.agentDir, data.repoKey, data.workflowId, data.repoRoot);
					this.unresolvedRef = false;
					if (
						alive(this.state.owner.pid) &&
						(this.state.owner.pid !== process.pid || this.state.owner.sessionId !== ctx.sessionManager.getSessionId())
					)
						this.readOnly = true;
					else {
						for (const attempt of activeAttempts(this.state)) attempt.status = "interrupted";
						this.state.owner = {
							sessionId: ctx.sessionManager.getSessionId(),
							sessionFile: ctx.sessionManager.getSessionFile(),
							pid: process.pid,
							generation: this.state.owner.generation + 1,
						};
						this.pauseInterrupted(this.state, "세션 재시작으로 중단, /workflow resume 필요");
						await this.persist("session restart");
					}
				} catch (error) {
					this.fatal = `워크플로 정본 접근·손상 오류: ${String(error)}`;
					this.notify(this.fatal);
				}
			}
			this.display();
			if (ctx.hasUI)
				this.unsubscribeInput = ctx.ui.onTerminalInput((data) => {
					if (
						data === "\x1b" &&
						ctx.isIdle() &&
						!ctx.ui.getEditorText() &&
						this.owned() &&
						this.state &&
						(this.state.control === "running" || !!this.fatal) &&
						activeAttempts(this.state).length
					) {
						/* 같은 Esc가 포커스된 확인창으로 전달돼 곧바로 취소되지 않도록 다음 tick에 띄운다. */
						setTimeout(() => {
							void ctx.ui
								.confirm("워크플로 일시정지", "관리 작업을 중단하고 일시정지할까요?")
								.then((ok) => {
									if (ok)
										return this.serial(async () => {
											if (this.state?.control === "running" || this.fatal) await this.stop("paused");
										});
								})
								.catch((error) => this.notify(String(error)));
						}, 0);
					}
					return undefined;
				});
		});
	}
	async shutdown(): Promise<void> {
		await this.serial(async () => {
			clearTimeout(this.stopTimer);
			this.checkAbort?.abort();
			this.unsubscribeInput?.();
			if (!this.state || !this.owned() || terminal(this.state)) return;
			this.request("cancel", { owner: ownerOf(this.state), reason: "workflow shutdown" });
			if (this.fatal) {
				this.notify(this.fatal);
				return;
			}
			for (const attempt of activeAttempts(this.state)) attempt.status = "interrupted";
			this.pauseInterrupted(this.state, "세션 종료로 중단");
			await this.persist("session shutdown");
		}).catch((error) => this.notify(String(error)));
	}
	async beforeSettle(
		event: AgentBeforeSettleEvent,
	): Promise<
		| { continue: true; entries: { type: "custom_message"; customType: string; display: true; content: string }[] }
		| undefined
	> {
		return this.serial(async () => {
			const state = this.state;
			if (!state || !this.owned() || terminal(state)) return;
			if (event.outcome === "aborted") {
				await this.stop("paused").catch((error) => this.notify(String(error)));
				return;
			}
			if (this.fatal || state.control !== "running") return;
			if (
				event.outcome !== "completed" ||
				event.continue ||
				!["executing", "reviewing", "ready-to-deliver", ...(state.mode === "stack" ? ["drafting"] : [])].includes(
					state.phase,
				) ||
				activeAttempts(state).length ||
				this.checking ||
				this.delivering ||
				state.seq === state.lastContinuationSeq
			)
				return;
			state.lastContinuationSeq = state.seq;
			await this.persist("continuation", false);
			const next = {
				executing: "workflow_recover 필요 여부를 확인하고 workflow_dispatch로 구현하거나 workflow_check로 검사하세요.",
				reviewing: "workflow_dispatch로 독립 검수하세요. 판정이 없거나 실패했다면 재검수하세요.",
				"ready-to-deliver":
					"workflow_dispatch role deliver로 전달 worker를 실행해 승인된 종료 지점까지만 전달하세요. 직접 commit·push·PR 금지.",
			};
			return {
				continue: true,
				entries: [
					{
						type: "custom_message",
						customType: "workflow-continue",
						display: true,
						content: stackInstruction(state) ?? next[state.phase as keyof typeof next],
					},
				],
			};
		});
	}
	/* Pi는 사용자가 중단한 실행에서 before_settle을 건너뛰고 settled만 보낸다. 구버전 이벤트에는 aborted 필드가 없다. */
	async settled(event: { aborted?: boolean }): Promise<void> {
		if (event.aborted !== true) return;
		await this.serial(async () => {
			const state = this.state;
			if (!state || !this.owned() || terminal(state)) return;
			await this.stop("paused").catch((error) => this.notify(String(error)));
		});
	}
	toolGuard(tool: string, input: Record<string, unknown>): { block: true; reason: string } | undefined {
		if (!this.unresolvedRef && (!this.state || !this.owned() || terminal(this.state))) return;
		const reason = guard(tool, input, (command) => {
			const state = this.state;
			return (
				!!state &&
				!this.fatal &&
				this.owned() &&
				state.control === "running" &&
				state.attempts.some(
					(attempt) =>
						dispatchCommand(attempt) === command &&
						attempt.status === "dispatching" &&
						attempt.generation === state.owner.generation &&
						!attempt.claimed,
				)
			);
		});
		return reason ? { block: true, reason } : undefined;
	}
}
