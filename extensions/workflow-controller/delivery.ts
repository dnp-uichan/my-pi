import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mustRun, run, snapshot } from "./io.ts";
import { protectedBranch, type Delivery, type Options, type Workflow } from "./model.ts";

export type DeliveryInput = { action: "commit"; message: string } | { action: "pr"; title: string; body: string };
type PR = {
	number?: number;
	url: string;
	baseRefName: string;
	headRefName?: string;
	headRefOid: string;
	isDraft: boolean;
	reviewRequests?: { login?: string; name?: string; slug?: string }[];
	assignees?: { login: string }[];
};
export class DeliveryService {
	constructor(
		private options: Required<Pick<Options, "scriptsDir" | "prPolicy" | "now">>,
		private persist: (state: Workflow, message: string) => Promise<void>,
	) {}
	private mayComplete(state: Workflow): boolean {
		return state.control !== "stopping" && state.control !== "cancelled" && this.evidenceValid(state);
	}
	/* 외부 작업 조정과 완료 판정을 분리한다. 검사·검수 증거가 무효면 조정 결과만 남기고 완료하지 않는다. */
	private evidenceValid(state: Workflow): boolean {
		return (
			!!state.review?.fingerprint &&
			!!state.verification?.id &&
			state.review.fingerprint === state.verification.fingerprint
		);
	}
	private requireRunning(state: Workflow): void {
		if (state.control !== "running") throw new Error("전달이 중단되었습니다.");
	}
	private async entry(
		state: Workflow,
		action: Delivery["action"],
		details: Record<string, unknown>,
	): Promise<Delivery> {
		this.requireRunning(state);
		const entry: Delivery = { action, state: "intent", at: this.options.now().toISOString(), details };
		state.deliveries.push(entry);
		await this.persist(state, `${action} intent`);
		return entry;
	}
	async commit(state: Workflow, message: string): Promise<void> {
		if (!state.spec || !state.approval || state.spec.endpoint === "verify")
			throw new Error("승인된 commit endpoint가 아닙니다.");
		const committed = [...state.deliveries]
			.reverse()
			.find((d) => d.action === "commit" && ["done", "reconciled"].includes(d.state));
		if (committed && !state.deliveries.some((d) => d.action === "commit" && d.state === "intent")) {
			/* 재검수된 내용이 이미 커밋돼 있으면 새 커밋 없이 같은 커밋으로 완료한다. */
			const current = await snapshot(state.repoRoot);
			const tree = await mustRun(state.repoRoot, "git", ["rev-parse", "HEAD^{tree}"]);
			const parent = await mustRun(state.repoRoot, "git", ["rev-parse", "HEAD^"]);
			if (
				current.head !== committed.details.head ||
				parent !== state.approval.head ||
				tree !== state.review?.fingerprint ||
				current.fingerprint !== tree
			)
				throw new Error("이미 커밋했거나 커밋 결과를 조정해야 합니다.");
			if (state.spec.endpoint === "commit" && state.control === "running" && this.evidenceValid(state)) {
				state.phase = "completed";
				await this.persist(state, "commit already delivered");
			}
			return;
		}
		if (state.deliveries.some((d) => d.action === "commit" && ["done", "reconciled", "intent"].includes(d.state)))
			throw new Error("이미 커밋했거나 커밋 결과를 조정해야 합니다.");
		const current = await snapshot(state.repoRoot);
		if (current.head !== state.approval.head) throw new Error("승인 뒤 다른 커밋이 있습니다.");
		if (current.fingerprint !== state.review?.fingerprint) throw new Error("커밋할 내용이 검수 지문과 다릅니다.");
		const delivery = await this.entry(state, "commit", {
			message,
			beforeHead: current.head,
			fingerprint: current.fingerprint,
		});
		try {
			this.requireRunning(state);
			await mustRun(state.repoRoot, "git", ["add", "-A"]);
			this.requireRunning(state);
			await mustRun(state.repoRoot, "git", ["commit", "-m", message]);
			const after = await snapshot(state.repoRoot);
			const tree = await mustRun(state.repoRoot, "git", ["rev-parse", "HEAD^{tree}"]);
			const parent = await mustRun(state.repoRoot, "git", ["rev-parse", "HEAD^"]);
			if (tree !== state.review?.fingerprint || parent !== state.approval.head || after.fingerprint !== tree)
				throw new Error("커밋 hook 이후 실제 HEAD 트리·부모가 검수·승인과 다릅니다.");
			delivery.state = "done";
			delivery.details.head = after.head;
			if (state.spec.endpoint === "commit" && state.control === "running") state.phase = "completed";
			await this.persist(state, "commit done");
		} catch (error) {
			delivery.state = "failed";
			delivery.details.error = String(error);
			await this.persist(state, "commit failed");
			throw error;
		}
	}
	private async policy(state: Workflow): Promise<{ base: string; assignee: string; reviewers: string[] }> {
		const context = await mustRun(state.repoRoot, "bash", [join(this.options.scriptsDir, "git-context.sh")]);
		const reviewer = await mustRun(state.repoRoot, "bash", [join(this.options.scriptsDir, "pr-reviewer.sh")]);
		const base = /(?:^|\n)=== PR Base ===\r?\n([^\r\n]+)/.exec(context)?.[1].trim() ?? "";
		const assignee = /^ASSIGNEE=(.*)$/m.exec(reviewer)?.[1].trim() ?? "";
		const reviewers = (/^REVIEWERS=(.*)$/m.exec(reviewer)?.[1] ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		if (
			base !== this.options.prPolicy.requiredBase ||
			!reviewers.includes(this.options.prPolicy.requiredReviewer) ||
			!assignee
		)
			throw new Error("PR base·reviewer·assignee 정책 불일치");
		await mustRun(state.repoRoot, "git", ["ls-remote", "--exit-code", "--heads", "origin", base]);
		return { base, assignee, reviewers };
	}
	private async list(state: Workflow): Promise<PR | undefined> {
		const text = await mustRun(state.repoRoot, "gh", [
			"pr",
			"list",
			"--head",
			state.approval?.branch ?? "",
			"--state",
			"open",
			"--json",
			"number,url,baseRefName,isDraft",
		]);
		const list: unknown = JSON.parse(text);
		if (!Array.isArray(list)) throw new Error("PR 조회 응답 오류");
		const existing = list[0] as PR | undefined;
		return existing ? this.verifyPolicy(state, existing.url) : undefined;
	}
	private async remoteHead(state: Workflow, branch: string): Promise<string> {
		const remote = await mustRun(state.repoRoot, "git", ["ls-remote", "origin", `refs/heads/${branch}`]);
		return remote.split(/\s/)[0];
	}
	private async verifyPolicy(state: Workflow, url: string): Promise<PR> {
		const pr: PR = JSON.parse(
			await mustRun(state.repoRoot, "gh", [
				"pr",
				"view",
				url,
				"--json",
				"url,isDraft,baseRefName,headRefName,headRefOid,reviewRequests,assignees",
			]),
		);
		const valid =
			pr.baseRefName === this.options.prPolicy.requiredBase &&
			pr.headRefName === state.approval?.branch &&
			pr.isDraft === true &&
			pr.reviewRequests?.some((r) => (r.login ?? r.name ?? r.slug) === this.options.prPolicy.requiredReviewer);
		if (!valid) throw new Error("PR의 base·draft·reviewer·head 불일치");
		return pr;
	}
	private async verify(state: Workflow, url: string, head: unknown): Promise<PR> {
		const pr = await this.verifyPolicy(state, url);
		const remote = await this.remoteHead(state, state.approval?.branch ?? "");
		if (typeof head !== "string" || !head || pr.headRefOid !== head || remote !== head)
			throw new Error("PR head·원격 head가 전달 커밋과 다릅니다.");
		return pr;
	}
	async pr(state: Workflow, title: string, body: string): Promise<void> {
		if (state.spec?.endpoint !== "pr" || !state.approval) throw new Error("승인된 pr endpoint가 아닙니다.");
		const current = await snapshot(state.repoRoot);
		const commit = [...state.deliveries]
			.reverse()
			.find((d) => d.action === "commit" && ["done", "reconciled"].includes(d.state));
		if (!commit || current.statusShort || protectedBranch(current.branch) || current.head !== commit.details.head)
			throw new Error("PR은 완료된 커밋·clean 트리·승인된 비보호 브랜치가 필요합니다.");
		const policy = await this.policy(state);
		const existing = await this.list(state);
		const delivery = await this.entry(state, "pr", {
			branch: current.branch,
			head: current.head,
			base: policy.base,
			title,
		});
		const dir = await mkdtemp(join(tmpdir(), "workflow-pr-"));
		try {
			const file = join(dir, "body.md");
			await writeFile(file, body, { mode: 0o600 });
			if ((await this.remoteHead(state, current.branch)) !== current.head) {
				const push = await this.entry(state, "push", { branch: current.branch, head: current.head });
				this.requireRunning(state);
				const pushed = await run(state.repoRoot, "git", ["push", "-u", "origin", current.branch]);
				push.state = pushed.code === 0 ? "done" : "failed";
				push.details.output = pushed.stderr;
				await this.persist(state, `push ${push.state}`);
				if (pushed.code !== 0) throw new Error(`push 실패: ${pushed.stderr}`);
			}
			if (existing) {
				await this.completePR(state, delivery, existing.url, "reconciled");
				return;
			}
			const args = [
				"pr",
				"create",
				"--draft",
				"--base",
				policy.base,
				"--head",
				current.branch,
				"--title",
				title,
				"--body-file",
				file,
				"--assignee",
				policy.assignee,
			];
			for (const reviewer of policy.reviewers) args.push("--reviewer", reviewer);
			this.requireRunning(state);
			const created = await run(state.repoRoot, "gh", args);
			let url = created.code === 0 ? created.stdout.trim() : "";
			let status: "done" | "reconciled" = "done";
			if (!url) {
				const recovered = await this.list(state);
				url = recovered?.url ?? "";
				status = "reconciled";
			}
			if (!url) throw new Error(`PR 생성 실패: ${created.stderr}`);
			await this.completePR(state, delivery, url, status);
		} catch (error) {
			/* 조회 성공 여부가 불명확하면 intent를 유지해 resume에서 다시 조정한다. */
			if (delivery.state === "intent") {
				try {
					const existing = await this.list(state);
					if (existing) {
						await this.completePR(state, delivery, existing.url, "reconciled");
						return;
					}
					delivery.state = "failed";
				} catch {
					delivery.details.uncertain = true;
				}
			}
			delivery.details.error = String(error);
			await this.persist(state, "pr failed or uncertain");
			throw error;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
	private async completePR(
		state: Workflow,
		delivery: Delivery,
		url: string,
		status: "done" | "reconciled",
	): Promise<void> {
		delivery.details.url = url;
		const pr = await this.verify(state, url, delivery.details.head);
		delivery.state = status;
		delivery.details.pr = pr;
		if (state.control === "running" && this.evidenceValid(state)) state.phase = "completed";
		await this.persist(state, `pr ${status}`);
	}
	private async reconcileCommit(state: Workflow, delivery: Delivery): Promise<void> {
		const current = await snapshot(state.repoRoot);
		if (current.head === delivery.details.beforeHead) {
			delivery.state = "failed";
			return;
		}
		const parent = await mustRun(state.repoRoot, "git", ["rev-parse", "HEAD^"]);
		const tree = await mustRun(state.repoRoot, "git", ["rev-parse", "HEAD^{tree}"]);
		if (
			parent !== delivery.details.beforeHead ||
			parent !== state.approval?.head ||
			tree !== delivery.details.fingerprint ||
			(state.review && tree !== state.review.fingerprint) ||
			current.fingerprint !== tree
		)
			throw new Error("미완료 커밋의 실제 결과를 확인할 수 없습니다.");
		delivery.state = "reconciled";
		delivery.details.head = current.head;
		if (state.spec?.endpoint === "commit" && this.mayComplete(state)) state.phase = "completed";
	}
	private async finalizeDelivered(state: Workflow): Promise<void> {
		const done = [...state.deliveries]
			.reverse()
			.find(
				(d) =>
					["done", "reconciled"].includes(d.state) &&
					(d.action === "pr" || (d.action === "commit" && state.spec?.endpoint === "commit")),
			);
		if (!done || !this.mayComplete(state) || state.phase === "completed") return;
		const current = await snapshot(state.repoRoot);
		if (current.fingerprint !== state.review?.fingerprint) throw new Error("전달 이후 검수된 내용이 변경되었습니다.");
		if (done.action === "commit" && current.head !== done.details.head)
			throw new Error("전달 이후 HEAD가 변경되었습니다.");
		/* 재검수한 내용이 실제 전달된 커밋에 들어 있어야 완료한다. */
		const deliveredHead = typeof done.details.head === "string" ? done.details.head : "";
		const deliveredTree = deliveredHead
			? await mustRun(state.repoRoot, "git", ["rev-parse", `${deliveredHead}^{tree}`])
			: "";
		if (!deliveredTree || deliveredTree !== state.review?.fingerprint)
			throw new Error("전달된 커밋 내용이 현재 검수 내용과 다릅니다.");
		if (done.action === "pr") await this.verify(state, String(done.details.url), done.details.head);
		if (this.mayComplete(state)) {
			state.phase = "completed";
			await this.persist(state, "resume delivery completed");
		}
	}
	async reconcile(state: Workflow): Promise<void> {
		for (const delivery of state.deliveries.filter((d) => d.state === "intent")) {
			if (delivery.action === "commit") await this.reconcileCommit(state, delivery);
			else if (delivery.action === "push") {
				const remote = await mustRun(state.repoRoot, "git", [
					"ls-remote",
					"origin",
					`refs/heads/${String(delivery.details.branch)}`,
				]);
				delivery.state = remote.split(/\s/)[0] === delivery.details.head ? "reconciled" : "failed";
			} else {
				await this.policy(state);
				const existing = await this.list(state);
				if (existing) {
					await this.completePR(state, delivery, existing.url, "reconciled");
					if (this.mayComplete(state)) state.phase = "completed";
				} else delivery.state = "failed";
			}
			await this.persist(state, `${delivery.action} reconciled`);
		}
		await this.finalizeDelivered(state);
	}
}
