import { stackPlanSchema } from "./stack-model.ts";
import { stackVersion } from "./stack-state.ts";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { hash, planVersion, specSchema, type Snapshot, type Workflow } from "./model.ts";

export type CommandResult = { code: number; stdout: string; stderr: string };
export function run(
	cwd: string,
	file: string,
	args: string[],
	env = process.env,
	timeout = 600_000,
	signal?: AbortSignal,
): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		execFile(
			file,
			args,
			{ cwd, env, timeout, signal, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				resolveResult({
					code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
					stdout,
					stderr: stderr || error?.message || "",
				});
			},
		);
	});
}
export function runCheck(
	cwd: string,
	command: string,
	signal: AbortSignal,
	options: { killGraceMs?: number; timeoutMs?: number; onTimeout: () => void },
): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		const child = spawn("bash", ["-lc", command], {
			cwd,
			env: process.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let closed = false;
		let code = -1;
		let stopping = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let poll: ReturnType<typeof setInterval> | undefined;
		const groupAlive = () => child.pid !== undefined && alive(-child.pid);
		const send = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch (error) {
				if (!isMissingProcess(error)) stderr += String(error);
			}
		};
		const finish = () => {
			if (!closed || (stopping && groupAlive())) return;
			clearTimeout(timeoutTimer);
			clearTimeout(killTimer);
			clearInterval(poll);
			signal.removeEventListener("abort", terminate);
			resolveResult({ code: stopping ? -1 : code, stdout, stderr });
		};
		const terminate = () => {
			if (stopping) return;
			stopping = true;
			send("SIGTERM");
			killTimer = setTimeout(() => {
				send("SIGKILL");
				finish();
			}, options.killGraceMs ?? 2_000);
			poll = setInterval(finish, 10);
		};
		const timeoutTimer = setTimeout(() => {
			stderr += "검사 시간 초과";
			terminate();
			options.onTimeout();
		}, options.timeoutMs ?? 600_000);
		const append = (output: string, target: "stdout" | "stderr") => {
			if (target === "stdout") stdout += output;
			else stderr += output;
			if (stdout.length + stderr.length > 16 * 1024 * 1024) {
				stderr += "검사 출력 한도 초과";
				terminate();
			}
		};
		child.stdout.setEncoding("utf8").on("data", (output: string) => append(output, "stdout"));
		child.stderr.setEncoding("utf8").on("data", (output: string) => append(output, "stderr"));
		child.on("error", (error) => {
			stderr += error.message;
		});
		child.on("close", (exitCode) => {
			closed = true;
			code = exitCode ?? -1;
			finish();
		});
		signal.addEventListener("abort", terminate, { once: true });
		if (signal.aborted) terminate();
	});
}
function isMissingProcess(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ESRCH";
}
export async function mustRun(cwd: string, file: string, args: string[], env = process.env): Promise<string> {
	const result = await run(cwd, file, args, env);
	if (result.code !== 0) throw new Error(`${file} 실패: ${result.stderr || result.stdout}`);
	return result.stdout.trim();
}
export async function fingerprint(repo: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "workflow-index-"));
	const index = join(dir, "index");
	try {
		const actual = resolve(repo, await mustRun(repo, "git", ["rev-parse", "--git-path", "index"]));
		try {
			await copyFile(actual, index);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const env = { ...process.env, GIT_INDEX_FILE: index };
		await mustRun(repo, "git", ["add", "-A"], env);
		return await mustRun(repo, "git", ["write-tree"], env);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
export async function snapshot(cwd: string): Promise<Snapshot> {
	const repoRoot = await realpath(await mustRun(cwd, "git", ["rev-parse", "--show-toplevel"]));
	return {
		repoRoot,
		branch: await mustRun(repoRoot, "git", ["rev-parse", "--abbrev-ref", "HEAD"]),
		head: await mustRun(repoRoot, "git", ["rev-parse", "HEAD"]),
		fingerprint: await fingerprint(repoRoot),
		statusShort: await mustRun(repoRoot, "git", ["status", "--short"]),
	};
}
export function statePath(agentDir: string, repoKey: string, workflowId: string): string {
	if (!/^[a-f0-9]{16}$/.test(repoKey) || !/^[a-f0-9-]{36}$/.test(workflowId)) throw new Error("잘못된 워크플로 참조");
	return join(agentDir, "workflows", repoKey, `${workflowId}.json`);
}
export async function save(agentDir: string, state: Workflow): Promise<void> {
	const path = statePath(agentDir, state.repoKey, state.workflowId);
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		await rename(tmp, path);
	} finally {
		await rm(tmp, { force: true });
	}
}
function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}
export async function load(agentDir: string, repoKey: string, workflowId: string, repoRoot: string): Promise<Workflow> {
	const data: unknown = JSON.parse(await readFile(statePath(agentDir, repoKey, workflowId), "utf8"));
	if (
		!validWorkflow(data) ||
		data.workflowId !== workflowId ||
		data.repoKey !== repoKey ||
		data.repoRoot !== repoRoot ||
		hash(await realpath(repoRoot)).slice(0, 16) !== repoKey
	)
		throw new Error("워크플로 정본 손상 또는 참조 불일치");
	if (data.verification && !data.verification.id) {
		data.verification = undefined;
		data.review = undefined;
		for (const attempt of data.attempts) {
			if (attempt.role === "review") attempt.reviewInvalidated = true;
		}
		if (["reviewing", "ready-to-deliver"].includes(data.phase)) data.phase = "executing";
	}
	/* 출처 없는 과거 중단 기록은 사용자 보류로 다룬다. running은 세션 복원에서 시스템 중단을 관찰한다. */
	if (data.controlSource === undefined) {
		data.controlSource = data.control === "running" ? "system" : "user";
		data.userHold = data.control !== "running";
	}
	data.controlRevision ??= 0;
	return data;
}
const choices = (values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const count = Type.Integer({ minimum: 0 });
const text = Type.String();
const snapshotSchema = Type.Object({ repoRoot: text, branch: text, head: text, fingerprint: text, statusShort: text });
const attemptSchema = Type.Object({
	id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
	role: choices(["implement", "review", "research", "deliver", "prepare"]),
	agent: text,
	contextMode: choices(["main", "isolated"]),
	thinking: Type.Optional(choices(["low", "medium", "high", "xhigh"])),
	task: text,
	generation: Type.Integer({ minimum: 1 }),
	status: choices(["dispatching", "running", "completed", "failed", "aborted", "interrupted", "rejected"]),
	claimed: Type.Optional(Type.Boolean()),
	runId: Type.Optional(Type.Integer({ minimum: 1 })),
	fingerprintAtDispatch: text,
	verificationId: Type.Optional(Type.String({ minLength: 1 })),
	reviewKey: Type.Optional(Type.String({ minLength: 1 })),
	reviewInvalidated: Type.Optional(Type.Boolean()),
	fingerprintAtFinish: Type.Optional(text),
	finalOutput: Type.Optional(text),
	exitCode: Type.Optional(Type.Integer()),
	stopReason: Type.Optional(text),
	verdict: Type.Optional(choices(["pass", "changes-requested", "blocked", "missing"])),
	recovered: Type.Optional(
		Type.Object({
			at: text,
			assessment: choices(["complete", "partial", "unknown"]),
			notes: text,
			head: text,
			fingerprint: text,
			statusShort: text,
		}),
	),
});
const singleSchema = Type.Object({
	workflowId: text,
	repoKey: text,
	repoRoot: text,
	goal: text,
	autoApprove: Type.Optional(Type.Literal(true)),
	phase: choices(["drafting", "awaiting-approval", "executing", "reviewing", "ready-to-deliver", "completed"]),
	control: choices(["running", "stopping", "paused", "blocked", "cancelled"]),
	stopTarget: Type.Optional(choices(["paused", "cancelled"])),
	controlSource: Type.Optional(choices(["user", "orchestrator", "system"])),
	userHold: Type.Optional(Type.Boolean()),
	controlRevision: Type.Optional(count),
	reason: Type.Optional(text),
	spec: Type.Optional(
		Type.Object({
			...specSchema.properties,
			prDraft: Type.Literal(true),
			maxImprovementCycles: Type.Integer({ minimum: 1, maximum: 5 }),
			maxRecoveries: Type.Integer({ minimum: 0, maximum: 3 }),
		}),
	),
	planVersion: Type.Optional(text),
	approval: Type.Optional(
		Type.Object({
			planVersion: text,
			at: text,
			via: choices(["ui", "command", "auto"]),
			repoRoot: text,
			branch: text,
			head: text,
			fingerprint: text,
		}),
	),
	attempts: Type.Array(attemptSchema),
	checks: Type.Array(
		Type.Object({
			command: text,
			exitCode: Type.Integer(),
			stdout: text,
			stderr: text,
			at: text,
			fingerprintBefore: text,
			fingerprintAfter: text,
		}),
	),
	verification: Type.Optional(Type.Object({ id: Type.Optional(Type.String({ minLength: 1 })), fingerprint: text })),
	review: Type.Optional(Type.Object({ attemptId: text, fingerprint: text })),
	reviewResults: Type.Optional(Type.Record(Type.String(), Type.Object({ attemptId: text, fingerprint: text }))),
	deliveries: Type.Array(
		Type.Object({
			action: choices(["commit", "push", "pr"]),
			state: choices(["intent", "done", "failed", "reconciled"]),
			at: text,
			details: Type.Record(Type.String(), Type.Unknown()),
		}),
	),
	improvementCycles: count,
	recoveries: count,
	owner: Type.Object({
		sessionId: text,
		sessionFile: Type.Optional(text),
		pid: Type.Integer({ minimum: 1 }),
		generation: Type.Integer({ minimum: 1 }),
	}),
	seq: count,
	lastContinuationSeq: Type.Integer({ minimum: -1 }),
	events: Type.Array(Type.Object({ seq: count, at: text, message: text }), { maxItems: 100 }),
	resumeSnapshot: Type.Optional(snapshotSchema),
});
const unitExecutionSchema = Type.Pick(singleSchema, [
	"spec",
	"planVersion",
	"approval",
	"attempts",
	"checks",
	"verification",
	"review",
	"reviewResults",
	"deliveries",
	"improvementCycles",
	"recoveries",
]);
const persistedSchema = Type.Object({
	...singleSchema.properties,
	mode: Type.Optional(Type.Literal("stack")),
	stack: Type.Optional(
		Type.Object({
			plan: Type.Object({
				...stackPlanSchema.properties,
				maxImprovementCycles: Type.Integer({ minimum: 1, maximum: 5 }),
				maxRecoveries: Type.Integer({ minimum: 0, maximum: 3 }),
			}),
			planVersion: text,
			index: count,
			stage: choices(["planned", "preparing", "unit", "integration"]),
			approval: Type.Optional(
				Type.Object({
					at: text,
					via: choices(["ui", "command", "auto"]),
					rootHead: text,
					rootFingerprint: text,
					sourceBranch: text,
					sourceHead: text,
				}),
			),
			results: Type.Array(
				Type.Object({
					id: text,
					branch: text,
					base: text,
					parentHead: text,
					head: text,
					fingerprint: text,
					url: text,
					valid: Type.Boolean(),
					execution: unitExecutionSchema,
				}),
			),
			invalidatedFrom: Type.Optional(count),
		}),
	),
});
function validStack(state: Workflow): boolean {
	const stack = state.stack;
	if (state.mode !== "stack") return !stack;
	if (!stack) return state.phase === "drafting" && !state.spec && !state.approval;
	if (
		stack.planVersion !== stackVersion(stack.plan) ||
		stack.index > stack.plan.units.length ||
		stack.results.length !== stack.index
	)
		return false;
	if (
		new Set(stack.plan.units.map((unit) => unit.id)).size !== stack.plan.units.length ||
		new Set(stack.plan.units.map((unit) => unit.branch)).size !== stack.plan.units.length
	)
		return false;
	if (!stack.approval)
		return stack.stage === "planned" && stack.index === 0 && state.phase === "awaiting-approval" && !state.approval;
	if (stack.stage === "planned" || (stack.stage === "integration") !== (stack.index === stack.plan.units.length))
		return false;
	if (stack.invalidatedFrom !== undefined && stack.invalidatedFrom > stack.index) return false;
	if (
		!stack.results.every((result, index) => {
			const unit = stack.plan.units[index];
			const previous = stack.results[index - 1];
			const execution = result.execution;
			return (
				result.id === unit.id &&
				result.branch === unit.branch &&
				result.base === (previous?.branch ?? stack.plan.rootBase) &&
				result.parentHead === (previous?.head ?? stack.approval?.rootHead) &&
				execution.spec &&
				execution.planVersion === planVersion(execution.spec) &&
				execution.approval?.planVersion === execution.planVersion &&
				execution.approval.branch === result.branch &&
				execution.approval.head === result.parentHead &&
				!!execution.verification?.id &&
				execution.verification.fingerprint === result.fingerprint &&
				execution.review?.fingerprint === result.fingerprint &&
				unit.requiredReviews.every((key) => execution.reviewResults?.[key]?.fingerprint === result.fingerprint)
			);
		})
	)
		return false;
	const unit = stack.plan.units[stack.index];
	const previous = stack.results.at(-1);
	return (
		!!state.spec &&
		!!state.approval &&
		state.approval.branch === (unit?.branch ?? previous?.branch) &&
		state.approval.head === (previous?.head ?? stack.approval.rootHead) &&
		state.spec.endpoint === (unit ? "pr" : "verify") &&
		JSON.stringify(state.spec.checks) === JSON.stringify(unit?.checks ?? stack.plan.integrationChecks) &&
		JSON.stringify(state.spec.requiredReviews) ===
			JSON.stringify(unit?.requiredReviews ?? stack.plan.integrationReviews) &&
		(!unit || state.spec.prBase === (previous?.branch ?? stack.plan.rootBase))
	);
}
function validWorkflow(value: unknown): value is Workflow {
	if (!Value.Check(persistedSchema, value)) return false;
	const state = value as Workflow;
	const spec = state.spec
		? state.planVersion === planVersion(state.spec)
		: state.phase === "drafting" || (state.mode === "stack" && state.phase === "awaiting-approval");
	const approval = state.approval
		? state.approval.planVersion === state.planVersion && state.approval.repoRoot === state.repoRoot
		: ["drafting", "awaiting-approval"].includes(state.phase);
	const attempts =
		new Set(state.attempts.map((a) => a.id)).size === state.attempts.length &&
		state.attempts.every((a) => a.generation <= state.owner.generation);
	return (
		/* 부분적으로 쓰인 권한 필드도 모호한 정본이므로 거절한다. */
		(state.controlSource === undefined
			? state.userHold === undefined && state.controlRevision === undefined
			: typeof state.userHold === "boolean" && state.controlRevision !== undefined) &&
		validStack(state) &&
		(!state.spec?.deliveryMode || (state.mode !== "stack" && state.spec.endpoint === "pr")) &&
		(state.stack?.results.every((result) => !result.execution.spec?.deliveryMode) ?? true) &&
		spec &&
		approval &&
		attempts &&
		state.lastContinuationSeq <= state.seq &&
		(state.control !== "stopping" || !!state.stopTarget)
	);
}
