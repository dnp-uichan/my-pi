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
	return data;
}
const choices = (values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const count = Type.Integer({ minimum: 0 });
const text = Type.String();
const snapshotSchema = Type.Object({ repoRoot: text, branch: text, head: text, fingerprint: text, statusShort: text });
const attemptSchema = Type.Object({
	id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
	role: choices(["implement", "review", "research"]),
	agent: text,
	contextMode: choices(["main", "isolated"]),
	task: text,
	generation: Type.Integer({ minimum: 1 }),
	status: choices(["dispatching", "running", "completed", "failed", "aborted", "interrupted", "rejected"]),
	claimed: Type.Optional(Type.Boolean()),
	runId: Type.Optional(Type.Integer({ minimum: 1 })),
	fingerprintAtDispatch: text,
	verificationId: Type.Optional(Type.String({ minLength: 1 })),
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
const persistedSchema = Type.Object({
	workflowId: text,
	repoKey: text,
	repoRoot: text,
	goal: text,
	phase: choices(["drafting", "awaiting-approval", "executing", "reviewing", "ready-to-deliver", "completed"]),
	control: choices(["running", "stopping", "paused", "blocked", "cancelled"]),
	stopTarget: Type.Optional(choices(["paused", "cancelled"])),
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
			via: choices(["ui", "command"]),
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
function validWorkflow(value: unknown): value is Workflow {
	if (!Value.Check(persistedSchema, value)) return false;
	const state = value as Workflow;
	const spec = state.spec ? state.planVersion === planVersion(state.spec) : state.phase === "drafting";
	const approval = state.approval
		? state.approval.planVersion === state.planVersion && state.approval.repoRoot === state.repoRoot
		: ["drafting", "awaiting-approval"].includes(state.phase);
	const attempts =
		new Set(state.attempts.map((a) => a.id)).size === state.attempts.length &&
		state.attempts.every((a) => a.generation <= state.owner.generation);
	return (
		spec &&
		approval &&
		attempts &&
		state.lastContinuationSeq <= state.seq &&
		(state.control !== "stopping" || !!state.stopTarget)
	);
}
