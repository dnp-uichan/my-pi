import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshot } from "./io.ts";
import { hash, normalizeSpec, planVersion, type Workflow } from "./model.ts";
import type { StackPlan, StackUnitResult } from "./stack-model.ts";
import {
	inspectPreparation,
	inspectStackCompletion,
	prepareTask,
	readStackBase,
	validateStackPlan,
	verifyStackDependencies,
	verifyUnitCI,
} from "./stack.ts";

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalData = process.env.STACK_GH_DATA;
const git = (repo: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const plan = (): StackPlan => ({
	title: "설정 스택",
	objective: "설정 기능 구현",
	nonGoals: ["배포"],
	successCriteria: ["통합 검사 통과"],
	rootBase: "stage",
	units: [
		{
			id: "foundation",
			title: "기반",
			objective: "기반 추가",
			branch: "feature/foundation",
			checks: ["true"],
			requiredReviews: ["code"],
			ciChecks: [],
		},
		{
			id: "ui",
			title: "화면",
			objective: "화면 추가",
			branch: "feature/ui",
			checks: ["true"],
			requiredReviews: ["code"],
			ciChecks: [],
		},
	],
	integrationChecks: ["true"],
	integrationReviews: ["integration"],
	maxImprovementCycles: 3,
	maxRecoveries: 2,
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "workflow-stack-"));
	roots.push(root);
	const repo = join(root, "repo");
	const remote = join(root, "origin.git");
	await mkdir(repo);
	git(repo, "init", "-b", "feature/source");
	git(repo, "config", "user.email", "test@example.invalid");
	git(repo, "config", "user.name", "Stack Test");
	await writeFile(join(repo, "initial.txt"), "initial\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "initial");
	git(root, "init", "--bare", remote);
	git(repo, "remote", "add", "origin", remote);
	git(repo, "push", "origin", "HEAD:stage");
	const base = git(repo, "rev-parse", "HEAD");
	const dataPath = join(root, "gh-data.json");
	const bin = join(root, "bin");
	await mkdir(bin);
	await writeFile(
		join(bin, "gh"),
		`#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const data = JSON.parse(fs.readFileSync(process.env.STACK_GH_DATA, 'utf8'));
const args = process.argv.slice(2);
const apiParts = args[1]?.split('/') ?? [];
if (args[0] === 'api' && apiParts.length === 6 && apiParts.slice(0, 4).join('/') === 'repos/{owner}/{repo}/commits' && /^[a-f0-9]{40}$/.test(apiParts[4]) && apiParts[5] === 'check-runs' && args.slice(2).join(' ') === '--paginate --slurp') {
  const head = apiParts[4];
  if (!data.ci || !Object.hasOwn(data.ci, head)) process.exit(2);
  console.log(JSON.stringify(data.ci[head]));
} else if (args.slice(0, 3).join(' ') === 'pr list --head' && args.slice(4).join(' ') === '--state open --json url,isDraft,baseRefName,baseRefOid,headRefName,headRefOid') {
  if (data.dirty) fs.writeFileSync('unexpected.txt', 'changed while querying PR');
  if (data.moveRemote) cp.execFileSync('git', ['--git-dir', data.moveRemote.remote, 'update-ref', 'refs/heads/' + data.moveRemote.branch, data.moveRemote.head]);
  console.log(JSON.stringify(data.prs?.[args[3]] ?? []));
} else { console.error('unsupported gh command: ' + args.join(' ')); process.exit(3); }
`,
	);
	await chmod(join(bin, "gh"), 0o755);
	process.env.PATH = `${bin}:${originalPath}`;
	process.env.STACK_GH_DATA = dataPath;
	const ghData = (data: unknown) => writeFile(dataPath, JSON.stringify(data));
	await ghData({});
	const state: Workflow = {
		workflowId: "00000000-0000-0000-0000-000000000000",
		repoKey: hash(repo).slice(0, 16),
		repoRoot: repo,
		goal: "설정 기능",
		mode: "stack",
		phase: "executing",
		control: "running",
		attempts: [],
		checks: [],
		deliveries: [],
		improvementCycles: 0,
		recoveries: 0,
		owner: { sessionId: "test", pid: process.pid, generation: 1 },
		seq: 0,
		lastContinuationSeq: -1,
		events: [],
		stack: {
			plan: plan(),
			planVersion: "stack-plan",
			approval: {
				at: "now",
				via: "command",
				rootHead: base,
				rootFingerprint: git(repo, "rev-parse", `${base}^{tree}`),
				sourceBranch: "feature/source",
				sourceHead: base,
			},
			index: 0,
			stage: "preparing",
			results: [],
		},
	};
	return { root, repo, remote, base, state, ghData };
}

async function completedFixture() {
	const f = await fixture();
	const stack = f.state.stack;
	if (!stack?.approval) throw new Error("fixture approval missing");
	const prs: Record<string, unknown[]> = {};
	for (const [index, unit] of stack.plan.units.entries()) {
		const previous = stack.results.at(-1);
		const parentHead = previous?.head ?? f.base;
		const base = previous?.branch ?? stack.plan.rootBase;
		git(f.repo, "switch", "-c", unit.branch, parentHead);
		await writeFile(join(f.repo, `${unit.id}.txt`), `${unit.title}\n`);
		git(f.repo, "add", "-A");
		git(f.repo, "commit", "-m", unit.title);
		git(f.repo, "push", "origin", unit.branch);
		const current = await snapshot(f.repo);
		const spec = normalizeSpec({
			title: unit.title,
			objective: unit.objective,
			nonGoals: [],
			successCriteria: ["검사 통과"],
			checks: unit.checks,
			requiredReviews: unit.requiredReviews,
			endpoint: "pr",
			prBase: base,
		});
		const version = planVersion(spec);
		const attemptId = `review-${index}`;
		const result: StackUnitResult = {
			id: unit.id,
			branch: unit.branch,
			base,
			parentHead,
			head: current.head,
			fingerprint: current.fingerprint,
			url: `https://example.invalid/pr/${index + 1}`,
			valid: true,
			execution: {
				spec,
				planVersion: version,
				approval: {
					planVersion: version,
					at: "now",
					via: "command",
					repoRoot: f.repo,
					branch: unit.branch,
					head: parentHead,
					fingerprint: git(f.repo, "rev-parse", `${parentHead}^{tree}`),
				},
				attempts: [],
				checks: [],
				verification: { id: `check-${index}`, fingerprint: current.fingerprint },
				review: { attemptId, fingerprint: current.fingerprint },
				reviewResults: { code: { attemptId, fingerprint: current.fingerprint } },
				deliveries: [],
				improvementCycles: 0,
				recoveries: 0,
			},
		};
		stack.results.push(result);
		prs[unit.branch] = [
			{
				url: result.url,
				isDraft: true,
				baseRefName: base,
				baseRefOid: parentHead,
				headRefName: unit.branch,
				headRefOid: current.head,
			},
		];
	}
	stack.index = stack.plan.units.length;
	stack.stage = "integration";
	const current = await snapshot(f.repo);
	f.state.spec = normalizeSpec({
		title: "전체 검증",
		objective: "전체 검증",
		nonGoals: [],
		successCriteria: ["전체 통과"],
		checks: ["true"],
		requiredReviews: ["integration"],
		endpoint: "verify",
	});
	f.state.verification = { id: "integration-check", fingerprint: current.fingerprint };
	f.state.review = { attemptId: "integration-review", fingerprint: current.fingerprint };
	f.state.reviewResults = { integration: { attemptId: "integration-review", fingerprint: current.fingerprint } };
	await f.ghData({ prs });
	return { ...f, prs };
}

afterEach(async () => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	if (originalData === undefined) delete process.env.STACK_GH_DATA;
	else process.env.STACK_GH_DATA = originalData;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("스택 계획과 브랜치 준비", () => {
	it("새 선형 스택 계획을 원격과 로컬 변경 없이 검증한다", async () => {
		/* [Given] */ const f = await fixture();
		const before = git(f.repo, "show-ref");
		/* [When] */ await validateStackPlan(f.repo, plan());
		/* [Then] */ expect(git(f.repo, "show-ref")).toBe(before);
		expect(git(f.repo, "status", "--short")).toBe("");
	});
	it.each([
		"duplicate-id",
		"duplicate-branch",
		"protected",
		"root-protected",
		"same-base",
		"invalid-branch",
		"empty-reviews",
	])("잘못된 계획 %s을 거절한다", async (kind) => {
		/* [Given] */ const f = await fixture();
		const input = plan();
		if (kind === "duplicate-id") input.units[1].id = input.units[0].id;
		if (kind === "duplicate-branch") input.units[1].branch = input.units[0].branch;
		if (kind === "protected") input.units[0].branch = "main";
		if (kind === "root-protected") input.rootBase = "production";
		if (kind === "same-base") input.rootBase = input.units[0].branch;
		if (kind === "invalid-branch") input.units[0].branch = "feature/bad..name";
		if (kind === "empty-reviews") input.units[0].requiredReviews = [];
		/* [When] */ const result = validateStackPlan(f.repo, input);
		/* [Then] */ await expect(result).rejects.toThrow();
	});
	it.each(["local", "remote"])("이미 있는 %s 대상 브랜치를 거절한다", async (location) => {
		/* [Given] */ const f = await fixture();
		const branch = plan().units[0].branch;
		if (location === "local") git(f.repo, "branch", branch);
		else git(f.repo, "push", "origin", `HEAD:${branch}`);
		/* [When] */ const result = validateStackPlan(f.repo, plan());
		/* [Then] */ await expect(result).rejects.toThrow(/브랜치/);
	});
	it("원격 base의 커밋을 승인 기준으로 읽는다", async () => {
		/* [Given] */ const f = await fixture();
		/* [When] */ const head = await readStackBase(f.repo, plan());
		/* [Then] */ expect(head).toBe(f.base);
	});
	it.each(["missing", "not-fetched"])("base 커밋이 %s이면 자동 fetch 없이 멈춘다", async (kind) => {
		/* [Given] */ const f = await fixture();
		const input = plan();
		if (kind === "missing") input.rootBase = "feature/missing";
		else {
			const writer = join(f.root, "writer");
			git(f.root, "clone", "--branch", "stage", f.remote, writer);
			git(writer, "config", "user.email", "test@example.invalid");
			git(writer, "config", "user.name", "Writer");
			await writeFile(join(writer, "new.txt"), "remote only\n");
			git(writer, "add", "-A");
			git(writer, "commit", "-m", "remote only");
			git(writer, "push", "origin", "stage");
		}
		const before = git(f.repo, "show-ref");
		/* [When] */ const result = readStackBase(f.repo, input);
		/* [Then] */ await expect(result).rejects.toThrow();
		expect(git(f.repo, "show-ref")).toBe(before);
	});
	it("준비 worker의 승인된 새 브랜치와 깨끗한 부모 커밋을 확인한다", async () => {
		/* [Given] */ const f = await fixture();
		git(f.repo, "switch", "-c", plan().units[0].branch, f.base);
		/* [When] */ await inspectPreparation(f.state);
		/* [Then] */ expect(f.state.stack?.stage).toBe("preparing");
		expect(git(f.repo, "status", "--short")).toBe("");
	});
	it.each(["wrong-branch", "dirty", "wrong-head"])("준비 결과 %s은 거절한다", async (kind) => {
		/* [Given] */ const f = await fixture();
		if (kind !== "wrong-branch") git(f.repo, "switch", "-c", plan().units[0].branch, f.base);
		if (kind === "dirty") await writeFile(join(f.repo, "untracked.txt"), "uncommitted");
		if (kind === "wrong-head") git(f.repo, "commit", "--allow-empty", "-m", "unexpected");
		/* [When] */ const result = inspectPreparation(f.state);
		/* [Then] */ await expect(result).rejects.toThrow();
	});
	it("준비 작업은 현재 source와 고정 부모에서 새 브랜치만 만든다", async () => {
		/* [Given] */ const f = await fixture();
		/* [When] */ const task = prepareTask(f.state);
		/* [Then] */ expect(task).toContain("feature/source");
		expect(task).toContain("feature/foundation");
		expect(task).toContain(f.base);
		expect(task).toContain("git switch -c");
	});
});

describe("스택 의존관계", () => {
	it("전달된 선형 부모 관계와 원격 커밋을 확인한다", async () => {
		/* [Given] */ const f = await completedFixture();
		/* [When] */ await verifyStackDependencies(f.state);
		/* [Then] */ expect(f.state.stack?.results.every((result) => result.valid)).toBe(true);
	});
	it.each(["root", "local", "remote", "recorded-parent"])(
		"부모 변경 %s은 후속 결과를 무효화하고 멈춘다",
		async (kind) => {
			/* [Given] */ const f = await completedFixture();
			const stack = f.state.stack;
			if (!stack) throw new Error("fixture stack missing");
			const first = stack.results[0];
			if (kind === "root") git(f.root, "--git-dir", f.remote, "update-ref", "refs/heads/stage", first.head);
			if (kind === "local") git(f.repo, "branch", "-f", first.branch, f.base);
			if (kind === "remote") git(f.root, "--git-dir", f.remote, "update-ref", `refs/heads/${first.branch}`, f.base);
			if (kind === "recorded-parent") stack.results[1].parentHead = f.base;
			const evidence = JSON.stringify(stack.results.map((result) => result.execution));
			/* [When] */ const result = verifyStackDependencies(f.state);
			/* [Then] */ await expect(result).rejects.toThrow();
			const from = kind === "recorded-parent" ? 1 : 0;
			expect(stack.invalidatedFrom).toBe(from);
			expect(stack.results.slice(from).every((unit) => !unit.valid)).toBe(true);
			expect(JSON.stringify(stack.results.map((unit) => unit.execution))).toBe(evidence);
		},
	);
	it("실제 커밋이 고정 부모의 자손이 아니면 완료 증거를 거절한다", async () => {
		/* [Given] */ const f = await completedFixture();
		const stack = f.state.stack;
		if (!stack) throw new Error("fixture stack missing");
		const second = stack.results[1];
		const detached = git(f.repo, "commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "unrelated to first unit");
		git(f.repo, "switch", "feature/source");
		git(f.repo, "branch", "-f", second.branch, detached);
		git(f.repo, "push", "origin", `${detached}:refs/heads/unrelated`);
		git(f.root, "--git-dir", f.remote, "update-ref", `refs/heads/${second.branch}`, detached);
		second.head = detached;
		/* [When] */ const result = verifyStackDependencies(f.state);
		/* [Then] */ await expect(result).rejects.toThrow();
		expect(second.valid).toBe(false);
	});
});

describe("고정 커밋의 필수 CI", () => {
	it("필수 CI가 없으면 GitHub 조회 없이 통과한다", async () => {
		/* [Given] */ const f = await fixture();
		/* [When] */ const result = verifyUnitCI(f.repo, f.base, []);
		/* [Then] */ await expect(result).resolves.toBeUndefined();
	});
	it("페이지에 흩어진 이름별 최신 성공 결과를 확인한다", async () => {
		/* [Given] */ const f = await fixture();
		await f.ghData({
			ci: {
				[f.base]: [
					{ check_runs: [{ id: 1, name: "test", head_sha: f.base, status: "completed", conclusion: "failure" }] },
					{
						check_runs: [
							{ id: 3, name: "test", head_sha: f.base, status: "completed", conclusion: "success" },
							{ id: 2, name: "lint", head_sha: f.base, status: "completed", conclusion: "success" },
						],
					},
				],
			},
		});
		/* [When] */ const result = verifyUnitCI(f.repo, f.base, ["test", "lint"]);
		/* [Then] */ await expect(result).resolves.toBeUndefined();
	});
	it.each(["pending", "failed", "missing", "wrong-head", "invalid"])(
		"필수 CI 결과 %s은 통과로 취급하지 않는다",
		async (kind) => {
			/* [Given] */ const f = await fixture();
			const check = { id: 2, name: "test", head_sha: f.base, status: "completed", conclusion: "success" };
			if (kind === "pending") check.status = "in_progress";
			if (kind === "failed") check.conclusion = "failure";
			if (kind === "wrong-head") check.head_sha = "a".repeat(40);
			await f.ghData({
				ci: { [f.base]: kind === "invalid" ? { broken: true } : [{ check_runs: kind === "missing" ? [] : [check] }] },
			});
			/* [When] */ const result = verifyUnitCI(f.repo, f.base, ["test"]);
			/* [Then] */ await expect(result).rejects.toThrow();
		},
	);
	it("과거 성공이 있어도 최신 재실행이 대기 중이면 멈춘다", async () => {
		/* [Given] */ const f = await fixture();
		await f.ghData({
			ci: {
				[f.base]: [
					{
						check_runs: [
							{ id: 2, name: "test", head_sha: f.base, status: "in_progress", conclusion: null },
							{ id: 1, name: "test", head_sha: f.base, status: "completed", conclusion: "success" },
						],
					},
				],
			},
		});
		/* [When] */ const result = verifyUnitCI(f.repo, f.base, ["test"]);
		/* [Then] */ await expect(result).rejects.toThrow();
	});
});

describe("스택 전체 완료", () => {
	it("모든 Draft PR과 통합 검증이 현재 스택과 맞으면 완료를 허용한다", async () => {
		/* [Given] */ const f = await completedFixture();
		/* [When] */ const result = inspectStackCompletion(f.state);
		/* [Then] */ await expect(result).resolves.toBeUndefined();
	});
	it.each(["missing", "duplicate", "not-draft", "wrong-base", "wrong-parent", "wrong-head", "wrong-url", "null"])(
		"실제 PR 결과 %s이면 전체 완료를 막는다",
		async (kind) => {
			/* [Given] */ const f = await completedFixture();
			const branch = plan().units[1].branch;
			const prs = f.prs[branch] as Record<string, unknown>[];
			if (kind === "missing") f.prs[branch] = [];
			if (kind === "duplicate") prs.push({ ...prs[0] });
			if (kind === "not-draft") prs[0].isDraft = false;
			if (kind === "wrong-base") prs[0].baseRefName = "stage";
			if (kind === "wrong-parent") prs[0].baseRefOid = f.base;
			if (kind === "wrong-head") prs[0].headRefOid = f.base;
			if (kind === "wrong-url") prs[0].url = "https://example.invalid/other";
			if (kind === "null") f.prs[branch] = [null];
			await f.ghData({ prs: f.prs });
			/* [When] */ const result = inspectStackCompletion(f.state);
			/* [Then] */ await expect(result).rejects.toThrow();
		},
	);
	it.each(["missing-unit", "invalid-unit", "missing-integration", "dirty", "wrong-branch"])(
		"완료 조건 %s이면 PR 존재와 무관하게 멈춘다",
		async (kind) => {
			/* [Given] */ const f = await completedFixture();
			if (kind === "missing-unit") f.state.stack?.results.pop();
			if (kind === "invalid-unit" && f.state.stack) f.state.stack.results[0].valid = false;
			if (kind === "missing-integration") f.state.verification = undefined;
			if (kind === "dirty") await writeFile(join(f.repo, "dirty.txt"), "pending");
			if (kind === "wrong-branch") git(f.repo, "switch", "feature/source");
			/* [When] */ const result = inspectStackCompletion(f.state);
			/* [Then] */ await expect(result).rejects.toThrow();
		},
	);
	it.each(["unit", "integration"])("계획의 필수 검수 %s가 빠지면 전체 완료를 막는다", async (scope) => {
		/* [Given] */ const f = await completedFixture();
		if (!f.state.stack) throw new Error("fixture stack missing");
		if (scope === "unit") f.state.stack.plan.units[0].requiredReviews.push("figma");
		else f.state.stack.plan.integrationReviews.push("figma");
		/* [When] */ const result = inspectStackCompletion(f.state);
		/* [Then] */ await expect(result).rejects.toThrow(/검수/);
	});
	it("원격 조회 중 작업 트리가 바뀌면 완료를 허용하지 않는다", async () => {
		/* [Given] */ const f = await completedFixture();
		await f.ghData({ prs: f.prs, dirty: true });
		/* [When] */ const result = inspectStackCompletion(f.state);
		/* [Then] */ await expect(result).rejects.toThrow();
	});
	it("PR 조회 중 하위 원격 브랜치가 바뀌면 후속 결과를 무효화한다", async () => {
		/* [Given] */ const f = await completedFixture();
		await f.ghData({ prs: f.prs, moveRemote: { remote: f.remote, branch: plan().units[0].branch, head: f.base } });
		/* [When] */ const result = inspectStackCompletion(f.state);
		/* [Then] */ await expect(result).rejects.toThrow();
		expect(f.state.stack?.invalidatedFrom).toBe(0);
	});
	it("계획에 명시한 원격 CI가 없으면 전체 완료를 막는다", async () => {
		/* [Given] */ const f = await completedFixture();
		if (!f.state.stack) throw new Error("fixture stack missing");
		f.state.stack.plan.units[0].ciChecks = ["test"];
		await f.ghData({ prs: f.prs, ci: { [f.state.stack.results[0].head]: [{ check_runs: [] }] } });
		/* [When] */ const result = inspectStackCompletion(f.state);
		/* [Then] */ await expect(result).rejects.toThrow();
	});
});
