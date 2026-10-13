import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Value } from "typebox/value";
import { fingerprint, mustRun, run } from "./io.ts";
import {
	guard,
	hash,
	normalizeSpec,
	protectedBranch,
	specSchema,
	type Snapshot,
	type Spec,
	type Workflow,
} from "./model.ts";

export type Change = { path: string; status: string; originalPath?: string };
export type RemoteTarget = { identity: string; display: string; pushDisplay: string };
export type WorkspaceEvidence = Snapshot & {
	indexFingerprint: string;
	changes: Change[];
	summary: string;
	remote?: RemoteTarget;
	signature: string;
};
export type AdoptionEvidence = {
	paths: string[];
	allowedPaths: string[];
	changes: Change[];
	workspace: WorkspaceEvidence;
};
export type PreflightResult = {
	eligible: boolean | null;
	blockers: string[];
	workspace?: WorkspaceEvidence;
	changes: Change[];
};
const readEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0" });

export function validatePaths(paths: string[], directories = true): void {
	if (!paths.length || new Set(paths).size !== paths.length) throw new Error("경로는 비어 있거나 중복될 수 없습니다.");
	for (const path of paths) {
		const parts = (directories && path.endsWith("/") ? path.slice(0, -1) : path).split("/");
		if (
			!path ||
			path.startsWith("/") ||
			/[\\*?[\]]/.test(path) ||
			[...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
			parts.some((part) => !part || part === "." || part === "..")
		)
			throw new Error("repo 상대 파일 경로 또는 끝이 /인 디렉터리 경로가 필요합니다.");
	}
}
export function pathAllowed(path: string, allowed: string[]): boolean {
	return allowed.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
}
export function changedPaths(changes: Change[]): string[] {
	return [
		...new Set(changes.flatMap((change) => (change.originalPath ? [change.path, change.originalPath] : [change.path]))),
	].sort();
}

function redactRemote(value: string): string {
	/* 원격 인증값은 해시에만 사용한다. 표시와 정본에는 userinfo를 남기지 않는다. */
	return value
		.split("\n")
		.map((url) =>
			url
				.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1")
				.replace(/^[^@/\s]+@(?=[^/\s]+:)/, "")
				.replace(/[?#].*$/, "[redacted]"),
		)
		.join("\n");
}
export async function readRemoteTarget(repo: string): Promise<RemoteTarget | undefined> {
	const fetch = await run(repo, "git", ["remote", "get-url", "--all", "origin"], readEnv());
	const push = await run(repo, "git", ["remote", "get-url", "--push", "--all", "origin"], readEnv());
	if (fetch.code !== 0 || push.code !== 0 || !fetch.stdout.trim() || !push.stdout.trim()) return undefined;
	return {
		identity: hash(JSON.stringify([fetch.stdout.trim(), push.stdout.trim()])),
		display: redactRemote(fetch.stdout.trim()),
		pushDisplay: redactRemote(push.stdout.trim()),
	};
}
export async function assertRemoteTarget(repo: string, target?: RemoteTarget): Promise<void> {
	if (target && (await readRemoteTarget(repo))?.identity !== target.identity)
		throw new Error("승인된 origin 전달 대상이 변경되었습니다. 새 사용자 승인이 필요합니다.");
}
async function readChanges(repo: string): Promise<Change[]> {
	const status = await run(repo, "git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], readEnv());
	if (status.code !== 0) throw new Error("변경 목록 조회 실패");
	const output = status.stdout;
	const entries = output.split("\0");
	const changes: Change[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const status = entry.slice(0, 2);
		const path = entry.slice(3);
		const originalPath = /[RC]/.test(status) ? entries[++i] : undefined;
		changes.push({ path, status, ...(originalPath ? { originalPath } : {}) });
	}
	return changes;
}

async function readIndexFingerprint(index: string): Promise<string> {
	try {
		return hash((await readFile(index)).toString("base64"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		return hash("missing-index");
	}
}

/* 읽기 전용 조회는 실제 index를 갱신하지 않는다. tree 계산만 격리된 임시 index를 사용한다. */
export async function readWorkspace(cwd: string): Promise<PreflightResult> {
	const result: PreflightResult = { eligible: null, blockers: [], changes: [] };
	try {
		const repoRoot = await realpath(await mustRun(cwd, "git", ["rev-parse", "--show-toplevel"], readEnv()));
		result.changes = await readChanges(repoRoot);
		const conflicts = await mustRun(repoRoot, "git", ["ls-files", "-u", "-z"], readEnv());
		if (conflicts) {
			result.blockers.push("충돌 상태에서는 승인·인수가 불가능합니다.");
			return result;
		}
		const index = resolve(repoRoot, await mustRun(repoRoot, "git", ["rev-parse", "--git-path", "index"], readEnv()));
		const indexFingerprint = await readIndexFingerprint(index);
		const branch = await mustRun(repoRoot, "git", ["rev-parse", "--abbrev-ref", "HEAD"], readEnv());
		const head = await mustRun(repoRoot, "git", ["rev-parse", "HEAD"], readEnv());
		const remote = await readRemoteTarget(repoRoot);
		const tree = await fingerprint(repoRoot);
		const workspace = {
			repoRoot,
			branch,
			head,
			fingerprint: tree,
			statusShort: await mustRun(repoRoot, "git", ["status", "--short", "--untracked-files=all"], readEnv()),
			indexFingerprint,
			changes: result.changes,
			summary: await mustRun(repoRoot, "git", ["diff", "--stat", head, tree], readEnv()),
			remote,
		};
		if (
			head !== (await mustRun(repoRoot, "git", ["rev-parse", "HEAD"], readEnv())) ||
			branch !== (await mustRun(repoRoot, "git", ["rev-parse", "--abbrev-ref", "HEAD"], readEnv())) ||
			indexFingerprint !== (await readIndexFingerprint(index)) ||
			JSON.stringify(result.changes) !== JSON.stringify(await readChanges(repoRoot)) ||
			remote?.identity !== (await readRemoteTarget(repoRoot))?.identity ||
			tree !== (await fingerprint(repoRoot))
		) {
			result.blockers.push("사전 검사 중 HEAD·브랜치·파일·index·원격이 변경되었습니다. 다시 조회하세요.");
			return result;
		}
		result.workspace = { ...workspace, signature: hash(JSON.stringify(workspace)) };
	} catch {
		/* Git stderr에는 인증값이 포함될 수 있으므로 반환하지 않는다. */
		result.blockers.push("Git 상태를 읽을 수 없습니다. repo·HEAD·index를 확인하세요.");
	}
	return result;
}

export async function preflight(cwd: string, input?: unknown): Promise<PreflightResult> {
	const result = await readWorkspace(cwd);
	if (input === undefined) return result;
	result.eligible = false;
	if (!Value.Check(specSchema, input)) {
		result.blockers.push("유효한 계획·검사 명령·종료 지점이 필요합니다.");
		return result;
	}
	const spec = normalizeSpec(input);
	result.blockers.push(...specBlockers(spec, input.prBase));
	if (result.workspace && spec.endpoint === "pr") result.blockers.push(...(await prBlockers(result.workspace, spec)));
	if (spec.adoptChanges) {
		try {
			validateAdoption(spec, result.changes);
		} catch (error) {
			result.blockers.push(error instanceof Error ? error.message : "인수 경로 오류");
		}
	} else if (result.workspace && spec.endpoint !== "verify" && result.workspace.statusShort) {
		result.blockers.push(
			"commit/pr 승인에는 clean 작업 트리가 필요합니다. 기존 변경 인수 adoptChanges 승인이 필요합니다.",
		);
	}
	result.eligible = !!result.workspace && !result.blockers.length;
	return result;
}

function specBlockers(spec: Spec, explicitBase?: string): string[] {
	const blockers: string[] = [];
	if (!Value.Check(specSchema, spec)) blockers.push("빈 계획·검사 명령은 허용하지 않습니다.");
	if (spec.deliveryMode && spec.endpoint !== "pr") blockers.push("기존 커밋 전달은 pr 종료 지점 전용입니다.");
	if (explicitBase !== undefined && spec.endpoint !== "pr") blockers.push("prBase는 pr 종료 지점에서만 지정합니다.");
	if (spec.checks.some((command) => guard("bash", { command })))
		blockers.push("검사 명령에서 전달·merge·workflow 실행은 금지입니다.");
	if (explicitBase !== undefined && explicitBase !== "stage" && protectedBranch(explicitBase))
		blockers.push("보호 브랜치는 stacked PR base로 지정할 수 없습니다.");
	return blockers;
}
async function prBlockers(workspace: WorkspaceEvidence, spec: Spec): Promise<string[]> {
	const blockers: string[] = [];
	if (protectedBranch(workspace.branch)) blockers.push("보호 브랜치에서 PR 승인은 금지입니다.");
	if (!workspace.remote) blockers.push("PR 승인에는 origin 전달 대상이 필요합니다.");
	if (
		(await run(workspace.repoRoot, "git", ["check-ref-format", "--branch", spec.prBase ?? "stage"], readEnv())).code !==
		0
	)
		blockers.push("prBase가 올바른 브랜치 이름이 아닙니다.");
	if ((await run(workspace.repoRoot, "git", ["check-ref-format", "--branch", workspace.branch], readEnv())).code !== 0)
		blockers.push("PR head가 올바른 브랜치 이름이 아닙니다.");
	return blockers;
}
function validateAdoption(spec: Spec, changes: Change[]): void {
	const adoption = spec.adoptChanges;
	if (!adoption) return;
	validatePaths(adoption.paths, false);
	const allowed = adoption.allowedPaths ?? adoption.paths;
	validatePaths(allowed);
	if (spec.endpoint === "verify" || spec.deliveryMode)
		throw new Error("인수는 새 커밋 commit/pr 종료 지점 전용입니다.");
	const paths = changedPaths(changes);
	if (JSON.stringify([...adoption.paths].sort()) !== JSON.stringify(paths))
		throw new Error("인수 paths는 현재 변경 파일 전체와 정확히 같아야 합니다. 누락·미승인 추가 경로를 확인하세요.");
	if (paths.some((path) => !pathAllowed(path, allowed))) throw new Error("인수 경로가 승인할 보완 범위 밖에 있습니다.");
}

export function adoptionEvidence(spec: Spec, workspace: WorkspaceEvidence): AdoptionEvidence | undefined {
	return spec.adoptChanges
		? {
				paths: [...spec.adoptChanges.paths],
				allowedPaths: [...(spec.adoptChanges.allowedPaths ?? spec.adoptChanges.paths)],
				changes: workspace.changes,
				workspace,
			}
		: undefined;
}
export async function assertAdoptionScope(state: Workflow, current: Snapshot): Promise<void> {
	const adoption = state.approval?.adoption;
	const scopes = [adoption?.allowedPaths, state.stack?.plan.units[state.stack.index]?.allowedPaths].filter(
		(paths): paths is string[] => paths !== undefined,
	);
	if (!scopes.length || !state.approval) return;
	let changes: Change[];
	if (adoption) {
		const result = await readWorkspace(state.repoRoot);
		if (!result.workspace || result.blockers.length) throw new Error(result.blockers.join("\n"));
		if (
			current.head !== result.workspace.head ||
			current.branch !== result.workspace.branch ||
			current.fingerprint !== result.workspace.fingerprint
		)
			throw new Error("인수 범위 검사 중 HEAD·브랜치·파일이 변경되었습니다. 다시 검사하세요.");
		changes = result.changes;
	} else {
		/* 일반 단위는 이미 계산한 tree를 재사용하고 실제 index·작업 경로도 함께 제한한다. */
		changes = await readChanges(state.repoRoot);
	}
	const diff = await run(
		state.repoRoot,
		"git",
		["diff", "--no-renames", "--name-only", "-z", state.approval.head, current.fingerprint],
		readEnv(),
	);
	if (diff.code !== 0) throw new Error("승인 기준 HEAD의 범위 검사 실패");
	const paths = [...new Set([...diff.stdout.split("\0").filter(Boolean), ...changedPaths(changes)])];
	const outside = paths.filter((path) => scopes.some((scope) => !pathAllowed(path, scope)));
	if (outside.length)
		throw new Error(`승인된 ${adoption ? "인수 보완" : "스택 단위"} 범위 밖 경로: ${outside.join(", ")}`);
}
