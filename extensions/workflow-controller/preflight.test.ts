import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preflight, readWorkspace } from "./preflight.ts";

const roots: string[] = [];
const git = (repo: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const spec = {
	title: "인수",
	objective: "산출물 전달",
	nonGoals: ["배포"],
	successCriteria: ["검수 통과"],
	checks: ["true"],
	endpoint: "commit",
};
async function repo() {
	const root = await mkdtemp(join(tmpdir(), "workflow-preflight-"));
	roots.push(root);
	git(root, "init", "-b", "feature/adoption");
	git(root, "config", "user.name", "Test");
	git(root, "config", "user.email", "test@example.invalid");
	await writeFile(join(root, "file.txt"), "initial\n");
	git(root, "add", "-A");
	git(root, "commit", "-m", "initial");
	return root;
}
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("읽기 전용 인수 사전 검사", () => {
	it.each(["수정", "삭제", "모드"])("기존 파일의 %s 변경을 인수한다", async (kind) => {
		/* [Given] */ const root = await repo();
		if (kind === "수정") await writeFile(join(root, "file.txt"), "changed\n");
		if (kind === "삭제") await rm(join(root, "file.txt"));
		if (kind === "모드") {
			git(root, "config", "core.filemode", "true");
			await chmod(join(root, "file.txt"), 0o755);
		}
		const index = await readFile(join(root, ".git/index"));
		/* [When] */ const result = await preflight(root, { ...spec, adoptChanges: { paths: ["file.txt"] } });
		/* [Then] */ expect(result.eligible, JSON.stringify(result)).toBe(true);
		expect(result.changes).toEqual([expect.objectContaining({ path: "file.txt" })]);
		expect(result.workspace?.summary).toContain("file.txt");
		expect(await readFile(join(root, ".git/index"))).toEqual(index);
	});
	it("크기와 mtime이 같은 파일 수정도 새 지문으로 승인한다", async () => {
		/* [Given] */ const root = await repo();
		git(root, "config", "core.trustctime", "false");
		const time = new Date("2020-01-01T00:00:00Z");
		await utimes(join(root, "file.txt"), time, time);
		git(root, "add", "file.txt");
		const baseline = git(root, "rev-parse", "HEAD^{tree}");
		const index = await readFile(join(root, ".git/index"));
		await writeFile(join(root, "file.txt"), "changed\n");
		await utimes(join(root, "file.txt"), time, time);
		/* [When] */ const result = await readWorkspace(root);
		/* [Then] */ expect(result.workspace?.fingerprint).not.toBe(baseline);
		expect(result.workspace?.summary).toContain("file.txt");
		expect(await readFile(join(root, ".git/index"))).toEqual(index);
	});
	it("rename은 원본과 새 파일을 모두 승인 대상으로 요구한다", async () => {
		/* [Given] */ const root = await repo();
		git(root, "mv", "file.txt", "renamed.txt");
		const omitted = await preflight(root, { ...spec, adoptChanges: { paths: ["renamed.txt"] } });
		/* [When] */ const result = await preflight(root, {
			...spec,
			adoptChanges: { paths: ["file.txt", "renamed.txt"] },
		});
		/* [Then] */ expect(omitted.eligible).toBe(false);
		expect(result.eligible, JSON.stringify(result)).toBe(true);
		expect(result.changes).toEqual([expect.objectContaining({ path: "renamed.txt", originalPath: "file.txt" })]);
	});
	it("디렉터리 허용 범위는 이름이 비슷한 다른 디렉터리까지 넓히지 않는다", async () => {
		/* [Given] */ const root = await repo();
		await mkdir(join(root, "ui"));
		await mkdir(join(root, "ui-other"));
		await writeFile(join(root, "ui/new.txt"), "허용\n");
		await writeFile(join(root, "ui-other/new.txt"), "별도\n");
		/* [When] */ const result = await preflight(root, {
			...spec,
			adoptChanges: { paths: ["ui/new.txt", "ui-other/new.txt"], allowedPaths: ["ui/"] },
		});
		/* [Then] */ expect(result.eligible).toBe(false);
		expect(result.blockers.join(" ")).toMatch(/범위/);
	});
	it("충돌은 지문 계산 실패 대신 변경 목록과 명확한 blocker를 반환한다", async () => {
		/* [Given] */ const root = await repo();
		const initial = git(root, "rev-parse", "HEAD");
		await writeFile(join(root, "file.txt"), "현재 브랜치\n");
		git(root, "add", "-A");
		git(root, "commit", "-m", "feature");
		git(root, "checkout", "-b", "other", initial);
		await writeFile(join(root, "file.txt"), "다른 브랜치\n");
		git(root, "add", "-A");
		git(root, "commit", "-m", "other");
		git(root, "checkout", "feature/adoption");
		try {
			git(root, "merge", "other");
		} catch {
			/* 의도한 충돌 */
		}
		const index = await readFile(join(root, ".git/index"));
		/* [When] */ const result = await preflight(root, { ...spec, adoptChanges: { paths: ["file.txt"] } });
		/* [Then] */ expect(result.eligible).toBe(false);
		expect(result.blockers.join(" ")).toMatch(/충돌/);
		expect(result.changes).toEqual([expect.objectContaining({ path: "file.txt", status: "UU" })]);
		expect(await readFile(join(root, ".git/index"))).toEqual(index);
	});
	it("인증값은 사전 검사 결과에 남기지 않되 원격 변경을 식별한다", async () => {
		/* [Given] */ const root = await repo();
		git(root, "remote", "add", "origin", "https://user:secret-one@example.invalid/repo.git?private_key=hidden#hidden");
		const before = await readWorkspace(root);
		git(
			root,
			"remote",
			"set-url",
			"origin",
			"https://user:secret-two@example.invalid/repo.git?private_key=hidden#hidden",
		);
		/* [When] */ const result = await readWorkspace(root);
		/* [Then] */ expect(JSON.stringify(before)).not.toMatch(/secret-one|hidden|private_key|user:/);
		expect(JSON.stringify(result)).not.toMatch(/secret-two|hidden|private_key|user:/);
		expect(result.workspace?.remote?.identity).not.toBe(before.workspace?.remote?.identity);
	});
	it("PR 대상 origin이 없으면 제안 가능으로 표시하지 않는다", async () => {
		/* [Given] */ const root = await repo();
		/* [When] */ const result = await preflight(root, { ...spec, endpoint: "pr" });
		/* [Then] */ expect(result.eligible).toBe(false);
		expect(result.blockers.join(" ")).toMatch(/origin/);
	});
	it.each(["verify", "existing-commit"])("%s와 기존 변경 인수를 섞지 않는다", async (mode) => {
		/* [Given] */ const root = await repo();
		await writeFile(join(root, "file.txt"), "작업\n");
		git(root, "remote", "add", "origin", "https://example.invalid/repo.git");
		/* [When] */ const result = await preflight(root, {
			...spec,
			endpoint: mode === "verify" ? "verify" : "pr",
			...(mode === "existing-commit" ? { deliveryMode: mode } : {}),
			adoptChanges: { paths: ["file.txt"] },
		});
		/* [Then] */ expect(result.eligible).toBe(false);
		expect(result.blockers.join(" ")).toMatch(/인수/);
	});
});
