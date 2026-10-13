import { assertAdoptionScope, assertRemoteTarget } from "./preflight.ts";
import { mustRun, run, snapshot } from "./io.ts";
import type { Delivery, Snapshot, Workflow } from "./model.ts";

type PR = { url: string; isDraft: boolean; baseRefName: string; headRefName: string; headRefOid: string };
export type DeliveryResult = { complete: true } | { complete: false; reason: string };

export const prBase = (state: Workflow) => state.spec?.prBase ?? "stage";

export function deliveredHead(state: Workflow): string | undefined {
	const done = [...state.deliveries]
		.reverse()
		.find((d) => d.action === "commit" && ["done", "reconciled"].includes(d.state));
	return typeof done?.details.head === "string" ? done.details.head : undefined;
}

/* 구버전에서 커밋 후 저장되지 못한 intent는 검사 세대와 별개로 실제 Git 상태에서 복구한다. */
export async function reconcileCommitIntents(state: Workflow): Promise<void> {
	for (const delivery of state.deliveries.filter((d) => d.action === "commit" && d.state === "intent")) {
		const current = await snapshot(state.repoRoot);
		if (current.branch !== state.approval?.branch || delivery.details.beforeHead !== state.approval?.head)
			throw new Error("기존 커밋 intent가 승인된 브랜치·HEAD와 다릅니다.");
		if (current.head === delivery.details.beforeHead) {
			delivery.state = "failed";
			continue;
		}
		const parents = (await mustRun(state.repoRoot, "git", ["rev-list", "--parents", "-n", "1", "HEAD"])).split(/\s+/);
		const tree = await mustRun(state.repoRoot, "git", ["rev-parse", "HEAD^{tree}"]);
		if (
			parents.length !== 2 ||
			parents[1] !== delivery.details.beforeHead ||
			tree !== delivery.details.fingerprint ||
			(state.review && tree !== state.review.fingerprint) ||
			current.fingerprint !== tree ||
			current.statusShort
		)
			throw new Error("미완료 커밋의 실제 결과를 확인할 수 없습니다.");
		delivery.state = "reconciled";
		delivery.details.head = current.head;
	}
}

function record(state: Workflow, action: Delivery["action"], details: Record<string, unknown>, at: string): void {
	const existing = state.deliveries.find(
		(d) => d.action === action && ["done", "reconciled"].includes(d.state) && d.details.head === details.head,
	);
	if (existing) Object.assign(existing.details, details);
	else state.deliveries.push({ action, state: "done", at, details });
}

function assertExistingCommit(state: Workflow, current: Snapshot, tree: string): void {
	if (state.mode === "stack" || state.spec?.endpoint !== "pr")
		throw new Error("기존 커밋 전달은 일반 pr 종료 지점 전용입니다.");
	if (
		current.head !== state.approval?.head ||
		tree !== state.approval.fingerprint ||
		!state.verification?.id ||
		state.verification.fingerprint !== tree ||
		!(state.spec.requiredReviews ?? ["code"]).every((key) => state.reviewResults?.[key]?.fingerprint === tree)
	)
		throw new Error("기존 커밋이 승인된 HEAD·검사·필수 검수 증거와 다릅니다.");
}

function assertUnchangedDelivery(current: Snapshot, latest: Snapshot, tree: string): void {
	if (
		latest.branch !== current.branch ||
		latest.head !== current.head ||
		latest.fingerprint !== tree ||
		latest.statusShort
	)
		throw new Error("전달 확인 도중 검수된 커밋·작업 트리가 변경됐습니다.");
}

/* 전달 worker의 보고 대신 실제 커밋·원격·PR 상태로 전달 여부를 판정한다. 승인과 어긋나면 예외를 던진다. */
export async function inspectDelivery(state: Workflow, at: string): Promise<DeliveryResult> {
	const approval = state.approval;
	if (!state.spec || !approval || state.spec.endpoint === "verify")
		throw new Error("승인된 전달 종료 지점이 아닙니다.");
	const current = await snapshot(state.repoRoot);
	await assertRemoteTarget(state.repoRoot, approval.target);
	await assertAdoptionScope(state, current);
	if (current.branch !== approval.branch) throw new Error("승인된 브랜치가 아닙니다.");
	const reused = state.spec.deliveryMode === "existing-commit";

	if (!reused && current.head === approval.head) return { complete: false, reason: "전달 커밋이 없습니다." };
	const tree = await mustRun(state.repoRoot, "git", ["rev-parse", "HEAD^{tree}"]);
	if (reused) {
		assertExistingCommit(state, current, tree);
	} else {
		const ancestor = await run(state.repoRoot, "git", ["merge-base", "--is-ancestor", approval.head, current.head]);
		const merges =
			ancestor.code === 0
				? await mustRun(state.repoRoot, "git", ["rev-list", "--merges", `${approval.head}..HEAD`])
				: "";
		if (ancestor.code !== 0 || merges)
			throw new Error("전달 커밋이 승인 커밋 위의 검수 내용과 다르거나 커밋되지 않은 변경이 남았습니다.");
	}
	if (tree !== state.review?.fingerprint || current.fingerprint !== tree || current.statusShort)
		throw new Error("전달 커밋이 승인 커밋 위의 검수 내용과 다르거나 커밋되지 않은 변경이 남았습니다.");
	record(state, "commit", { head: current.head, base: approval.head, ...(reused ? { reused: true } : {}) }, at);
	if (state.spec.endpoint === "commit") {
		const latest = await snapshot(state.repoRoot);
		await assertAdoptionScope(state, latest);
		assertUnchangedDelivery(current, latest, tree);
		return { complete: true };
	}
	const remote = await mustRun(state.repoRoot, "git", ["ls-remote", "origin", `refs/heads/${current.branch}`]);
	if (remote.split(/\s/)[0] !== current.head)
		return { complete: false, reason: "원격 브랜치가 전달 커밋을 가리키지 않습니다." };
	const prs: unknown = JSON.parse(
		await mustRun(state.repoRoot, "gh", [
			"pr",
			"list",
			"--head",
			current.branch,
			"--state",
			"open",
			"--json",
			"url,isDraft,baseRefName,headRefName,headRefOid",
		]),
	);
	if (!Array.isArray(prs)) throw new Error("PR 조회 응답 오류");
	if (!prs.length) return { complete: false, reason: "열린 PR이 없습니다." };
	const pr = prs[0] as PR;
	if (
		prs.length > 1 ||
		pr.isDraft !== true ||
		pr.baseRefName !== prBase(state) ||
		pr.headRefName !== current.branch ||
		pr.headRefOid !== current.head
	)
		throw new Error("PR의 base·Draft·head가 승인·전달 커밋과 다릅니다.");
	assertUnchangedDelivery(current, await snapshot(state.repoRoot), tree);
	await assertRemoteTarget(state.repoRoot, approval.target);
	await assertAdoptionScope(state, await snapshot(state.repoRoot));
	record(state, "pr", { head: current.head, url: pr.url, base: pr.baseRefName }, at);
	return { complete: true };
}
