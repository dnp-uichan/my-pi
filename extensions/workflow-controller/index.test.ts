import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowController } from "./index.ts";
import type { Options } from "./model.ts";

const roots: string[] = [];
const harnesses: { hook: (name: string, event: any) => unknown }[] = [];
const spec = {
	title: "테스트 작업",
	objective: "파일 변경",
	nonGoals: ["배포"],
	successCriteria: ["검증 성공"],
	checks: ["true"],
	endpoint: "verify",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function harness(managed = true, shared?: { root: string; refs: any[] }, options: Partial<Options> = {}) {
	const root = shared?.root ?? (await mkdtemp(join(tmpdir(), "workflow-test-")));
	if (!shared) roots.push(root);
	const repo = join(root, "repo");
	if (!shared) {
		await mkdir(repo);
		git(repo, "init", "-b", "feature/workflow");
		git(repo, "config", "user.email", "test@example.invalid");
		git(repo, "config", "user.name", "Workflow Test");
		await writeFile(join(repo, "file.txt"), "initial\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "initial");
	}
	const events = createEventBus();
	const tools = new Map<string, ToolDefinition<any>>();
	const handlers = new Map<string, (...args: any[]) => any>();
	let command: (args: string, ctx: any) => Promise<void> = async () => {};
	let active: string[] = ["bash", "subagent"];
	const refs: any[] = shared?.refs ?? [];
	const messages: string[] = [];
	const prompts: string[] = [];
	const cancellations: any[] = [];
	const claims: any[] = [];
	const started: any[] = [];
	let selection: string | undefined;
	let inputHandler: ((data: string) => unknown) | undefined;
	const ctx = {
		cwd: repo,
		hasUI: false,
		mode: "print",
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => join(root, "session.jsonl"),
			getBranch: () => refs,
		},
		ui: {
			notify: (message: string) => messages.push(message),
			setStatus: () => {},
			select: async (prompt: string) => {
				prompts.push(prompt);
				return selection;
			},
			confirm: async () => true,
			getEditorText: () => "",
			onTerminalInput: (handler: typeof inputHandler) => {
				inputHandler = handler;
				return () => {
					inputHandler = undefined;
				};
			},
		},
		executeTool: async (_name: string, args: any) => {
			if (handlers.get("tool_call")?.({ toolName: "subagent", input: args }, ctx)?.block)
				return { isError: true, content: [], details: {} };
			const attemptId = /--managed (\S+)/.exec(args.command)?.[1];
			const agent = /subagent run (\S+)/.exec(args.command)?.[1];
			const contextMode = args.command.includes("--main") ? "main" : "isolated";
			let claim: any;
			events.emit("subagent:managed:v1:event", {
				type: "claim",
				attemptId,
				agent,
				contextMode,
				respond: (value: any) => {
					claim = value;
				},
			});
			claims.push(claim);
			if (!claim?.ok) return { isError: true, content: [], details: {} };
			/* 실제 subagent 관리 API는 runId를 숫자로 보낸다. */
			const event = { type: "started", attemptId, agent, runId: started.length + 1, owner: claim.owner };
			started.push(event);
			events.emit("subagent:managed:v1:event", event);
			return { isError: false, content: [], details: {} };
		},
	} as unknown as ExtensionToolContext;
	if (managed)
		events.on("subagent:managed:v1:request", (raw: any) => {
			if (raw.type === "capabilities")
				raw.respond({ version: 1, features: ["claim", "cancel", "inspect", "finished", "no-outer-retry"] });
			if (raw.type === "cancel") {
				cancellations.push(raw);
				raw.respond({
					ok: true,
					cancelled: started
						.filter((run) => JSON.stringify(run.owner) === JSON.stringify(raw.owner))
						.map((run) => ({ attemptId: run.attemptId, runId: run.runId })),
					rejected: [],
				});
			}
			if (raw.type === "inspect") raw.respond({ ok: true, runs: [] });
		});
	const pi = {
		events,
		registerTool: (tool: ToolDefinition<any>) => tools.set(tool.name, tool),
		registerCommand: (_name: string, definition: any) => {
			command = definition.handler;
		},
		on: (name: string, handler: any) => {
			handlers.set(name, handler);
			return () => handlers.delete(name);
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		appendEntry: (customType: string, data: any) => refs.push({ type: "custom", customType, data }),
		sendUserMessage: (message: string) => messages.push(message),
	} as unknown as ExtensionAPI;
	createWorkflowController({
		agentDir: join(root, "agent"),
		scriptsDir: join(root, "scripts"),
		stopTimeoutMs: 15,
		...options,
	})(pi);
	const call = async (name: string, args: any = {}, signal?: AbortSignal) => {
		const tool = tools.get(`workflow_${name}`);
		if (!tool) throw new Error(`등록되지 않은 도구: ${name}`);
		return tool.execute("test-call", args, signal, undefined, ctx);
	};
	const state = async () => (await call("status")).details as any;
	const finish = async (index = started.length - 1, extra: any = {}) => {
		events.emit("subagent:managed:v1:event", {
			...started[index],
			type: "finished",
			status: "completed",
			removed: false,
			retryCount: 0,
			finalOutput: "완료",
			...extra,
		});
		await call("status");
	};
	const start = async (proposal: any = spec) => {
		await command("start 파일 변경", ctx);
		await call("propose", proposal);
	};
	const approve = async (proposal: any = spec) => {
		await start(proposal);
		await command("approve", ctx);
	};
	const ready = async (proposal: any = { ...spec, endpoint: "commit" }) => {
		await approve(proposal);
		await writeFile(join(repo, "file.txt"), "changed\n");
		await call("check");
		await call("dispatch", { role: "review", task: "검수" });
		await finish(undefined, { finalOutput: "검수 완료\nWORKFLOW_VERDICT: pass" });
	};
	const h = {
		root,
		repo,
		refs,
		ctx,
		events,
		tools,
		messages,
		prompts,
		claims,
		started,
		cancellations,
		call,
		state,
		finish,
		start,
		approve,
		ready,
		command: (args: string) => command(args, ctx),
		hook: (name: string, event: any) => handlers.get(name)?.(event, ctx),
		active: () => active,
		select: (value: string | undefined) => {
			selection = value;
			ctx.hasUI = true;
		},
		input: (value: string) => inputHandler?.(value),
	};
	harnesses.push(h);
	return h;
}

afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.hook("session_shutdown", { type: "session_shutdown" });
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("관리형 워크플로", () => {
	it("관리 API 없이는 시작하지 않는다", async () => {
		/* [Given] */ const h = await harness(false);
		/* [When] */ await h.command("start 목표");
		/* [Then] */ expect(h.refs).toHaveLength(0);
		expect(h.messages.join(" ")).toMatch(/관리 API|지원/);
	});
	it("승인 전에는 작업을 실행하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.start();
		/* [When] */ const result = await h.call("dispatch", { role: "implement", task: "구현" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.started).toHaveLength(0);
		expect((await h.state()).phase).toBe("awaiting-approval");
	});
	it("모델 인자는 승인이 아니고 사용자 명령만 승인한다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start 목표");
		/* [When] */ await h.call("propose", { ...spec, approved: true });
		const before = await h.state();
		await h.command("approve");
		/* [Then] */ expect(before.approval).toBeUndefined();
		expect((await h.state()).approval.via).toBe("command");
	});
	it("실제 선택 응답만 UI 승인으로 기록한다", async () => {
		/* [Given] */ const h = await harness();
		h.select("승인");
		/* [When] */ await h.start();
		/* [Then] */ expect((await h.state()).approval.via).toBe("ui");
	});
	it("구현 완료 주장은 검사 증거를 대신하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		/* [When] */ await h.finish();
		/* [Then] */ expect((await h.state()).phase).toBe("executing");
		expect(h.claims[0].task).toMatch(/구현/);
		expect(h.claims[0].task).toMatch(/commit/);
		expect(h.refs).toHaveLength(1);
	});
	it("실패한 검사 뒤에는 검수를 실행하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, checks: ["exit 7"] });
		/* [When] */ const check = await h.call("check");
		const review = await h.call("dispatch", { role: "review", task: "검수" });
		/* [Then] */ expect(check.isError).toBe(true);
		expect(review.isError).toBe(true);
		expect(h.started).toHaveLength(0);
	});
	it("검사 뒤 변경된 파일은 검수를 거절한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("check");
		await writeFile(join(h.repo, "file.txt"), "after check");
		/* [When] */ const result = await h.call("dispatch", { role: "review", task: "검수" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.started).toHaveLength(0);
	});
	it("검사 자체가 파일을 바꾸면 검증하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, checks: ["printf mutated > file.txt"] });
		/* [When] */ const result = await h.call("check");
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).verification).toBeUndefined();
	});
	it("검수 중 변경은 통과 판정을 무효화한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "검수" });
		await writeFile(join(h.repo, "file.txt"), "during review");
		/* [When] */ await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		/* [Then] */ expect((await h.state()).phase).toBe("executing");
		expect((await h.state()).verification).toBeUndefined();
	});
	it.each([
		{ status: "completed", finalOutput: "좋습니다" },
		{ status: "failed", finalOutput: "WORKFLOW_VERDICT: pass" },
	])("형식 없는 판정과 실패한 검수는 통과하지 않는다 $status", async (extra) => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "검수" });
		/* [When] */ await h.finish(undefined, extra);
		/* [Then] */ expect((await h.state()).phase).toBe("reviewing");
		expect((await h.state()).recoveries).toBe(0);
	});
	it("다른 owner와 중복 종료 보고를 무시한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		/* [When] */ await h.finish(undefined, { owner: { workflowId: "other", generation: 1 } });
		const before = await h.state();
		await h.finish();
		const once = await h.state();
		await h.finish();
		/* [Then] */ expect(before.attempts[0].status).toBe("running");
		expect((await h.state()).seq).toBe(once.seq);
	});
	it("개선 한도와 카운터를 재시작 후에도 유지한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, maxImprovementCycles: 1 });
		/* [When] */ for (let i = 0; i < 2; i++) {
			await h.call("check");
			await h.call("dispatch", { role: "review", task: "검수" });
			await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: changes-requested" });
		}
		await h.hook("session_shutdown", {});
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [Then] */ expect((await next.state()).control).toBe("blocked");
		expect((await next.state()).improvementCycles).toBe(1);
	});
	it("일시정지는 자기 실행 종료를 기다린다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		/* [When] */ await h.command("pause");
		await new Promise((resolve) => setTimeout(resolve, 25));
		const waiting = await h.state();
		const denied = await h.call("dispatch", { role: "research", task: "조사" });
		await h.finish(undefined, { status: "aborted", removed: true });
		/* [Then] */ expect(waiting.control).toBe("stopping");
		expect(waiting.reason).toMatch(/종료 미확인/);
		expect(denied.isError).toBe(true);
		expect(h.cancellations[0].owner.workflowId).toBe(waiting.workflowId);
		expect((await h.state()).control).toBe("paused");
	});
	it("취소 뒤 늦은 완료 보고는 단계를 바꾸지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "검수" });
		/* [When] */ await h.command("cancel");
		await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		/* [Then] */ expect((await h.state()).control).toBe("cancelled");
		expect((await h.state()).phase).toBe("reviewing");
		expect(h.active()).not.toContain("workflow_dispatch");
	});
	it("재시작한 작업은 실제 복구 기록 후에만 재실행한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		const next = await harness(true, h);
		/* [When] */ await next.hook("session_start", {});
		const restarted = await next.state();
		await next.command("resume");
		const denied = await next.call("dispatch", { role: "implement", task: "재구현" });
		await next.call("recover", { attemptId: restarted.attempts[0].id, assessment: "partial", notes: "파일 확인" });
		const allowed = await next.call("dispatch", { role: "implement", task: "재구현" });
		/* [Then] */ expect(restarted.control).toBe("paused");
		expect(restarted.attempts[0].status).toBe("interrupted");
		expect(denied.isError).toBe(true);
		expect(allowed.isError).not.toBe(true);
		expect((await next.state()).attempts[0].recovered.head).toBe(git(h.repo, "rev-parse", "HEAD"));
	});
	it("손상된 정본은 새 작업으로 덮어쓰지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.start();
		const ref = h.refs[0].data;
		const path = join(h.root, "agent", "workflows", ref.repoKey, `${ref.workflowId}.json`);
		await writeFile(path, "{broken");
		const next = await harness(true, h);
		/* [When] */ await next.hook("session_start", {});
		await next.command("start 다른 작업");
		const result = await next.call("propose", spec);
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await readFile(path, "utf8")).toBe("{broken");
	});
	it("자동 계속은 변경된 상태마다 한 번만 요청한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		const event = { outcome: "completed", continue: false };
		/* [When] */ const first = await h.hook("agent_before_settle", event);
		const second = await h.hook("agent_before_settle", event);
		await h.command("pause");
		const paused = await h.hook("agent_before_settle", event);
		/* [Then] */ expect(first?.continue).toBe(true);
		expect(second).toBeUndefined();
		expect(paused).toBeUndefined();
	});
	it("실행 중인 턴을 사용자가 중단하면 자기 작업을 취소하고 멈춘다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		/* [When] */ await h.hook("agent_settled", { type: "agent_settled", aborted: true });
		/* [Then] */ expect(h.cancellations).toHaveLength(1);
		expect((await h.state()).control).toBe("stopping");
	});
	it("정상으로 끝난 턴은 작업을 멈추지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		/* [When] */ await h.hook("agent_settled", { type: "agent_settled", aborted: false });
		/* [Then] */ expect(h.cancellations).toHaveLength(0);
		expect((await h.state()).control).toBe("running");
	});
	it("관리되지 않은 작업과 직접 전달 명령을 차단한다", async () => {
		/* [Given] */ const h = await harness();
		await h.start();
		/* [When] */ const run = await h.hook("tool_call", {
			toolName: "subagent",
			input: { command: "subagent run worker --main -- task" },
		});
		const push = await h.hook("tool_call", { toolName: "bash", input: { command: "git push origin feature" } });
		const help = await h.hook("tool_call", { toolName: "subagent", input: { command: "subagent runs" } });
		/* [Then] */ expect(run.block).toBe(true);
		expect(push.block).toBe(true);
		expect(help).toBeUndefined();
	});
	it("검수된 내용만 커밋하며 지문과 실제 index를 보존한다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		const before = await h.state();
		const staged = git(h.repo, "diff", "--cached");
		/* [When] */ const result = await h.call("deliver", { action: "commit", message: "구현 변경" });
		/* [Then] */ expect(staged).toBe("");
		expect(result.isError).not.toBe(true);
		expect((await h.state()).phase).toBe("completed");
		expect((await h.state()).review.fingerprint).toBe(before.review.fingerprint);
		expect(git(h.repo, "log", "-1", "--pretty=%s")).toBe("구현 변경");
	});
	it("승인 뒤 외부 커밋이 있으면 전달하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		git(h.repo, "commit", "--allow-empty", "-m", "외부 변경");
		/* [When] */ const result = await h.call("deliver", { action: "commit", message: "전달" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).toBe("blocked");
	});
	it("검수 뒤 변경은 커밋을 거절한다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		await writeFile(join(h.repo, "file.txt"), "unreviewed");
		/* [When] */ const result = await h.call("deliver", { action: "commit", message: "전달" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(git(h.repo, "log", "-1", "--pretty=%s")).toBe("initial");
	});
	it("재승인하면 개선 횟수를 보존한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "검수" });
		await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: changes-requested" });
		/* [When] */ await h.call("propose", { ...spec, title: "수정된 계획" });
		/* [Then] */ expect((await h.state()).phase).toBe("awaiting-approval");
		expect((await h.state()).improvementCycles).toBe(1);
		expect((await h.state()).approval).toBeUndefined();
	});
	it("구현자와 같은 에이전트는 검수하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		await h.finish();
		await h.call("check");
		/* [When] */ const result = await h.call("dispatch", { role: "review", task: "검수", agent: "worker" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.started).toHaveLength(1);
	});
});

async function preparePr(h: Awaited<ReturnType<typeof harness>>, policy = true, lost = false) {
	const remote = join(h.root, "remote.git");
	git(h.root, "init", "--bare", remote);
	git(h.repo, "remote", "add", "origin", remote);
	git(h.repo, "push", "origin", "HEAD:stage");
	const scripts = join(h.root, "scripts");
	await mkdir(scripts);
	await writeFile(
		join(scripts, "git-context.sh"),
		`#!/bin/sh\nprintf '=== PR Base ===\\n${policy ? "stage" : "main"}\\n'\n`,
	);
	await writeFile(
		join(scripts, "pr-reviewer.sh"),
		"#!/bin/sh\nprintf 'ASSIGNEE=tester\\nREVIEWERS=dnp-sungbaek,other\\n'\n",
	);
	const bin = join(h.root, "bin");
	await mkdir(bin);
	const data = join(h.root, "pr.json");
	const log = join(h.root, "gh.log");
	const headOverride = join(h.root, "pr-head");
	const pr = {
		number: 1,
		url: "https://example.invalid/pr/1",
		baseRefName: "stage",
		headRefName: "feature/workflow",
		isDraft: true,
		reviewRequests: [{ login: "dnp-sungbaek" }],
		assignees: [{ login: "tester" }],
	};
	await writeFile(
		join(bin, "gh"),
		`#!/usr/bin/env node\nconst fs = require('node:fs'); const a=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, a.join(' ')+'\\n'); const p=${JSON.stringify(data)}; if(a[1]==='list') { process.stdout.write(fs.existsSync(p)?'['+fs.readFileSync(p,'utf8')+']':'[]'); } else if(a[1]==='create') { fs.writeFileSync(p,${JSON.stringify(JSON.stringify(pr))}); ${lost ? "process.exit(1);" : `process.stdout.write(${JSON.stringify(pr.url)});`} } else if(a[1]==='view') { const pr=JSON.parse(fs.readFileSync(p,'utf8')); pr.headRefOid=fs.existsSync(${JSON.stringify(headOverride)})?fs.readFileSync(${JSON.stringify(headOverride)},'utf8').trim():require('node:child_process').execFileSync('git',['--git-dir',${JSON.stringify(remote)},'rev-parse','refs/heads/feature/workflow'],{encoding:'utf8'}).trim(); process.stdout.write(JSON.stringify(pr)); }\n`,
	);
	await chmod(join(bin, "gh"), 0o755);
	return { bin, log, data, pr, remote, headOverride };
}

describe("정책을 지키는 PR 전달", () => {
	it.each([false, true])("Draft PR은 응답 유실 여부와 무관하게 한 번만 만든다 %s", async (lost) => {
		/* [Given] */ const h = await harness();
		const fake = await preparePr(h, true, lost);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("deliver", { action: "commit", message: "변경" });
		const path = process.env.PATH;
		process.env.PATH = `${fake.bin}:${path}`;
		/* [When] */ let result: Awaited<ReturnType<typeof h.call>> | undefined;
		try {
			result = await h.call("deliver", { action: "pr", title: "테스트 PR", body: "검증됨" });
			await h.call("deliver", { action: "pr", title: "중복", body: "금지" });
		} finally {
			process.env.PATH = path;
		}
		/* [Then] */ expect(result?.isError).not.toBe(true);
		expect((await h.state()).phase).toBe("completed");
		const log = await readFile(fake.log, "utf8");
		expect(log.split("\n").filter((line) => line.startsWith("pr create"))).toHaveLength(1);
		expect(log).toMatch(/--draft/);
		expect(log).toMatch(/--base stage/);
		expect(log).toMatch(/--reviewer dnp-sungbaek/);
		expect(git(h.root, "--git-dir", join(h.root, "remote.git"), "rev-parse", "refs/heads/feature/workflow")).toBe(
			git(h.repo, "rev-parse", "HEAD"),
		);
	});
	it("정책이 다른 PR은 원격에 전달하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await preparePr(h, false);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("deliver", { action: "commit", message: "변경" });
		const path = process.env.PATH;
		process.env.PATH = `${fake.bin}:${path}`;
		/* [When] */ let result: Awaited<ReturnType<typeof h.call>> | undefined;
		try {
			result = await h.call("deliver", { action: "pr", title: "PR", body: "검증됨" });
		} finally {
			process.env.PATH = path;
		}
		/* [Then] */ expect(result?.isError).toBe(true);
		expect((await h.state()).control).toBe("blocked");
		expect(git(h.root, "--git-dir", join(h.root, "remote.git"), "branch", "--list", "feature/workflow")).toBe("");
	});
});

describe("중단과 정본 경계", () => {
	it("검사 종료를 기다리지 않고 일시정지한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, checks: ["touch checking; while [ ! -f release ]; do sleep 0.02; done"] });
		const checking = h.call("check");
		const observed = checking.catch(() => undefined);
		for (let i = 0; i < 100; i++) {
			try {
				await readFile(join(h.repo, "checking"));
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		/* [When] */ const pause = h.command("pause");
		const immediate = await Promise.race([
			pause.then(() => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 200)),
		]);
		await writeFile(join(h.repo, "release"), "");
		await observed;
		await pause;
		/* [Then] */ expect(immediate).toBe(true);
		expect((await h.state()).control).toBe("paused");
		expect((await h.state()).verification).toBeUndefined();
	});
	it("잘못된 복구 기록도 손상된 정본으로 거절한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		await h.finish(undefined, { status: "failed" });
		const ref = h.refs[0].data;
		const path = join(h.root, "agent", "workflows", ref.repoKey, `${ref.workflowId}.json`);
		const stored = JSON.parse(await readFile(path, "utf8"));
		stored.attempts[0].recovered = { assessment: "complete" };
		await writeFile(path, JSON.stringify(stored));
		const next = await harness(true, h);
		/* [When] */ await next.hook("session_start", {});
		await next.command("resume");
		/* [Then] */ expect((await next.state()).error).toEqual(expect.stringMatching(/손상/));
		expect(await readFile(path, "utf8")).toBe(JSON.stringify(stored));
	});
	it("복구 한도 초과는 사용자 재개로 우회하지 못한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, maxRecoveries: 0 });
		await h.call("dispatch", { role: "implement", task: "구현" });
		await h.finish(undefined, { status: "aborted" });
		/* [When] */ await h.call("recover", {
			attemptId: (await h.state()).attempts[0].id,
			assessment: "unknown",
			notes: "상태 확인",
		});
		await h.command("resume");
		/* [Then] */ expect((await h.state()).control).toBe("blocked");
		expect((await h.state()).recoveries).toBe(1);
	});
	it("정본 저장 실패에도 관리 실행 중단을 요청한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		const ref = h.refs[0].data;
		const path = join(h.root, "agent", "workflows", ref.repoKey, `${ref.workflowId}.json`);
		await rm(path);
		await mkdir(path);
		/* [When] */ await h.command("cancel");
		const result = await h.call("dispatch", { role: "research", task: "조사" });
		/* [Then] */ expect(h.cancellations).toHaveLength(1);
		expect(result.isError).toBe(true);
		expect((await h.state()).error).toMatch(/저장 오류/);
	});
	it("단독 Esc만 확인 후 중단하고 입력은 소비하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		h.ctx.hasUI = true;
		await h.hook("session_start", {});
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		/* [When] */ const sequence = h.input("\x1b[A");
		const before = await h.state();
		const escapeResult = h.input("\x1b");
		await new Promise((resolve) => setTimeout(resolve, 30));
		await h.state();
		/* [Then] */ expect(sequence).toBeUndefined();
		expect(before.control).toBe("running");
		expect(escapeResult).toBeUndefined();
		expect((await h.state()).control).toBe("stopping");
	});
});

describe("전달 우회와 재개 경계", () => {
	it("Git 전역 옵션이 붙어도 직접 전달을 차단한다", async () => {
		/* [Given] */ const h = await harness();
		await h.start();
		/* [When] */ const result = await h.hook("tool_call", {
			toolName: "bash",
			input: { command: "git -C /tmp/repo push origin feature" },
		});
		/* [Then] */ expect(result?.block).toBe(true);
	});
	it("검사 명령으로 커밋 전달을 우회하지 못한다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start 목표");
		/* [When] */ const result = await h.call("propose", { ...spec, checks: ["git commit --allow-empty -m bypass"] });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).approval).toBeUndefined();
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("1");
	});
	it("실행 전 끊긴 최초 커밋 intent도 재개에서 조정한다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		const ref = h.refs[0].data;
		const path = join(h.root, "agent", "workflows", ref.repoKey, `${ref.workflowId}.json`);
		const stored = JSON.parse(await readFile(path, "utf8"));
		stored.control = "paused";
		stored.deliveries.push({
			action: "commit",
			state: "intent",
			at: new Date().toISOString(),
			details: { beforeHead: stored.approval.head, fingerprint: stored.review.fingerprint, message: "전달" },
		});
		await writeFile(path, JSON.stringify(stored));
		const next = await harness(true, h);
		/* [When] */ await next.hook("session_start", {});
		await next.command("resume");
		/* [Then] */ expect((await next.state()).control).toBe("running");
		expect((await next.state()).deliveries[0].state).toBe("failed");
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("1");
	});
});

it("PR 명령이 실행 중이어도 일시정지를 즉시 기록한다", async () => {
	/* [Given] */ const h = await harness();
	const fake = await preparePr(h);
	await h.ready({ ...spec, endpoint: "pr" });
	await h.call("deliver", { action: "commit", message: "변경" });
	const executable = join(fake.bin, "gh");
	const marker = join(h.root, "creating");
	const release = join(h.root, "release-pr");
	await writeFile(
		executable,
		(await readFile(executable, "utf8")).replace(
			"else if(a[1]==='create') {",
			`else if(a[1]==='create') { fs.writeFileSync(${JSON.stringify(marker)},''); while(!fs.existsSync(${JSON.stringify(release)})) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
		),
	);
	const path = process.env.PATH;
	process.env.PATH = `${fake.bin}:${path}`;
	/* [When] */ let immediate: unknown;
	const delivering = h.call("deliver", { action: "pr", title: "PR", body: "검증" });
	const observed = delivering.catch(() => undefined);
	try {
		for (let i = 0; i < 150; i++) {
			try {
				await readFile(marker);
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		const pause = h.command("pause");
		immediate = await Promise.race([
			pause.then(() => true),
			new Promise((resolve) => setTimeout(() => resolve(false), 200)),
		]);
		await writeFile(release, "");
		await observed;
		await pause;
	} finally {
		await writeFile(release, "");
		await observed;
		process.env.PATH = path;
	}
	/* [Then] */ expect(immediate).toBe(true);
	expect((await h.state()).control).toBe("paused");
	expect((await h.state()).phase).toBe("ready-to-deliver");
});

const storedPath = (h: Awaited<ReturnType<typeof harness>>) => {
	const ref = h.refs[0].data;
	return join(h.root, "agent", "workflows", ref.repoKey, `${ref.workflowId}.json`);
};
async function waitForFile(path: string): Promise<void> {
	for (let i = 0; i < 150; i++) {
		try {
			await readFile(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`경계 프로세스 시작 미확인: ${path}`);
}

describe("옵션 위치 가드", () => {
	it.each([
		"subagent run worker --main -- task --managed fake",
		"subagent run worker --managed unknown -- task",
		"subagent continue 1 --managed unknown",
		"subagent batch --managed unknown -- task",
		"subagent chain --managed unknown -- task",
	])("관리 실행 우회를 차단한다 %s", async (command) => {
		/* [Given] */ const h = await harness();
		await h.approve();
		/* [When] */ const result = await h.hook("tool_call", { toolName: "subagent", input: { command } });
		/* [Then] */ expect(result?.block).toBe(true);
	});
	it("관리 작업의 task 안에 있는 실행 동사는 가드에 영향을 주지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		/* [When] */ const result = await h.call("dispatch", { role: "research", task: "run continue batch chain 조사" });
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect(h.started[0].runId).toBeTypeOf("number");
	});
	it.each(["help", "runs", "status 1", "detail 1", "abort 1", "remove 1"])(
		"조회와 중단 명령은 허용한다 %s",
		async (verb) => {
			/* [Given] */ const h = await harness();
			await h.start();
			/* [When] */ const result = await h.hook("tool_call", {
				toolName: "subagent",
				input: { command: `subagent ${verb}` },
			});
			/* [Then] */ expect(result).toBeUndefined();
		},
	);
});

describe("정본 로드 실패 가드", () => {
	it.each(["손상", "누락", "접근 오류"])("정본 %s 세션에서도 직접 실행을 차단한다", async (failure) => {
		/* [Given] */ const h = await harness();
		await h.start();
		const path = storedPath(h);
		if (failure === "손상") await writeFile(path, "{broken");
		else {
			await rm(path);
			if (failure === "접근 오류") await mkdir(path);
		}
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [When] */ const results = await Promise.all([
			next.hook("tool_call", { toolName: "bash", input: { command: "git push origin feature" } }),
			next.hook("tool_call", { toolName: "subagent", input: { command: "subagent run worker --main -- task" } }),
			next.hook("tool_call", {
				toolName: "subagent",
				input: { command: "subagent run worker --managed unknown -- task" },
			}),
		]);
		/* [Then] */ expect(results.every((result) => result?.block === true)).toBe(true);
		expect(next.active()).not.toContain("workflow_dispatch");
		expect((await next.state()).error).toMatch(/정본/);
	});
});

describe("Pi signal 중단", () => {
	it("검사 signal 중단은 명령을 멈추고 다음 검사를 실행하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const marker = join(h.root, "checking-signal");
		const release = join(h.root, "release-signal");
		const next = join(h.root, "next-check");
		await h.approve({
			...spec,
			checks: [`touch '${marker}'; while [ ! -f '${release}' ]; do sleep 0.02; done`, `touch '${next}'`],
		});
		const signal = new AbortController();
		const checking = h.call("check", {}, signal.signal);
		const observed = Promise.allSettled([checking]);
		await waitForFile(marker);
		/* [When] */ signal.abort();
		let immediate: unknown;
		try {
			immediate = await Promise.race([checking, new Promise((resolve) => setTimeout(() => resolve("waiting"), 500))]);
		} finally {
			await writeFile(release, "");
			await observed;
		}
		/* [Then] */ expect(immediate).not.toBe("waiting");
		expect((await checking).isError).toBe(true);
		expect((await h.state()).control).toBe("paused");
		expect((await h.state()).verification).toBeUndefined();
		await expect(readFile(next)).rejects.toThrow();
	});
	it("전달 signal 중단은 아직 시작하지 않은 push와 PR 생성을 막는다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await preparePr(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("deliver", { action: "commit", message: "변경" });
		const marker = join(h.root, "policy-running");
		const release = join(h.root, "release-policy");
		const script = join(h.root, "scripts", "git-context.sh");
		await writeFile(
			script,
			`#!/bin/sh\ntouch '${marker}'\nwhile [ ! -f '${release}' ]; do sleep 0.02; done\nprintf '=== PR Base ===\\nstage\\n'\n`,
		);
		const path = process.env.PATH;
		process.env.PATH = `${fake.bin}:${path}`;
		const signal = new AbortController();
		const delivering = h.call("deliver", { action: "pr", title: "PR", body: "검증" }, signal.signal);
		const observed = Promise.allSettled([delivering]);
		/* [When] */ let paused: any;
		try {
			await waitForFile(marker);
			signal.abort();
			await h.call("status");
			paused = await h.state();
		} finally {
			await writeFile(release, "");
			await observed;
			process.env.PATH = path;
		}
		/* [Then] */ expect(paused.control).toBe("stopping");
		expect((await delivering).isError).toBe(true);
		expect((await h.state()).control).toBe("paused");
		expect(git(h.root, "--git-dir", fake.remote, "branch", "--list", "feature/workflow")).toBe("");
		expect(await readFile(fake.log, "utf8").catch(() => "")).not.toMatch(/pr create/);
	});
});

describe("fatal 이후 소유 실행 중단", () => {
	it.each(["pause", "cancel", "Esc", "settled", "before settle", "shutdown"])(
		"저장 오류 후에도 %s는 자기 owner를 중단한다",
		async (action) => {
			/* [Given] */ const h = await harness();
			h.ctx.hasUI = true;
			await h.hook("session_start", {});
			await h.approve();
			await h.call("dispatch", { role: "implement", task: "구현" });
			const owner = h.started[0].owner;
			const path = storedPath(h);
			await rm(path);
			await mkdir(path);
			await h.call("block", { reason: "저장 실패 유도" });
			expect((await h.state()).error).toMatch(/저장 오류/);
			/* [When] */ if (action === "Esc") {
				h.input("\x1b");
				await new Promise((resolve) => setTimeout(resolve, 30));
				await h.call("status");
			} else if (action === "settled") await h.hook("agent_settled", { aborted: true });
			else if (action === "before settle") await h.hook("agent_before_settle", { outcome: "aborted" });
			else if (action === "shutdown") await h.hook("session_shutdown", {});
			else await h.command(action);
			/* [Then] */ expect(h.cancellations).toHaveLength(1);
			expect(h.cancellations[0].owner).toEqual(owner);
			expect((await h.call("dispatch", { role: "research", task: "조사" })).isError).toBe(true);
			expect((await h.call("check")).isError).toBe(true);
			expect((await h.call("deliver", { action: "commit", message: "금지" })).isError).toBe(true);
			await h.command("resume");
			expect((await h.state()).error).toMatch(/저장 오류/);
		},
	);
});

describe("PR 실제 head 검증", () => {
	it("기존 PR도 전달 커밋까지 일반 push 후 완료한다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await preparePr(h);
		git(h.repo, "push", "origin", "HEAD:feature/workflow");
		await writeFile(fake.data, JSON.stringify(fake.pr));
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("deliver", { action: "commit", message: "전달 변경" });
		const head = git(h.repo, "rev-parse", "HEAD");
		const path = process.env.PATH;
		process.env.PATH = `${fake.bin}:${path}`;
		/* [When] */ let result: any;
		try {
			result = await h.call("deliver", { action: "pr", title: "기존 PR", body: "검증" });
		} finally {
			process.env.PATH = path;
		}
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect(git(h.root, "--git-dir", fake.remote, "rev-parse", "refs/heads/feature/workflow")).toBe(head);
		expect((await h.state()).phase).toBe("completed");
		expect((await h.state()).deliveries.find((d: any) => d.action === "pr").details.pr.headRefOid).toBe(head);
		expect(await readFile(fake.log, "utf8")).not.toMatch(/pr create/);
	});
	it.each(["PR head", "remote head"])("전달 커밋과 다른 %s는 완료하지 않는다", async (mismatch) => {
		/* [Given] */ const h = await harness();
		const fake = await preparePr(h);
		const initial = git(h.repo, "rev-parse", "HEAD");
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("deliver", { action: "commit", message: "전달 변경" });
		await writeFile(fake.headOverride, mismatch === "PR head" ? initial : git(h.repo, "rev-parse", "HEAD"));
		if (mismatch === "remote head") {
			const executable = join(fake.bin, "gh");
			await writeFile(
				executable,
				(await readFile(executable, "utf8")).replace(
					"else if(a[1]==='view') {",
					`else if(a[1]==='view') { require('node:child_process').execFileSync('git',['--git-dir',${JSON.stringify(fake.remote)},'update-ref','refs/heads/feature/workflow',${JSON.stringify(initial)}]);`,
				),
			);
		}
		const path = process.env.PATH;
		process.env.PATH = `${fake.bin}:${path}`;
		/* [When] */ let result: any;
		try {
			result = await h.call("deliver", { action: "pr", title: "PR", body: "검증" });
		} finally {
			process.env.PATH = path;
		}
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).phase).not.toBe("completed");
		expect((await h.state()).control).toBe("blocked");
	});
	it("재개도 오래된 원격과 PR intent를 완료로 조정하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await preparePr(h);
		git(h.repo, "push", "origin", "HEAD:feature/workflow");
		await writeFile(fake.data, JSON.stringify(fake.pr));
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("deliver", { action: "commit", message: "전달 변경" });
		const stored = await h.state();
		stored.control = "paused";
		stored.deliveries.push({
			action: "pr",
			state: "intent",
			at: new Date().toISOString(),
			details: { branch: stored.approval.branch, head: git(h.repo, "rev-parse", "HEAD") },
		});
		await writeFile(storedPath(h), JSON.stringify(stored));
		const next = await harness(true, h);
		await next.hook("session_start", {});
		const path = process.env.PATH;
		process.env.PATH = `${fake.bin}:${path}`;
		/* [When] */ try {
			await next.command("resume");
		} finally {
			process.env.PATH = path;
		}
		/* [Then] */ expect((await next.state()).phase).not.toBe("completed");
		expect((await next.state()).control).toBe("blocked");
	});
});

describe("커밋 실제 트리 검증", () => {
	it("index만 바꾸는 hook의 커밋을 검수 완료로 기록하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		const reviewed = (await h.state()).review.fingerprint;
		const hook = join(h.repo, ".git", "hooks", "pre-commit");
		await writeFile(
			hook,
			"#!/bin/sh\nblob=$(printf 'hook-only\\n' | git hash-object -w --stdin)\ngit update-index --cacheinfo 100644,$blob,file.txt\n",
		);
		await chmod(hook, 0o755);
		/* [When] */ const result = await h.call("deliver", { action: "commit", message: "전달" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(git(h.repo, "rev-parse", "HEAD^{tree}")).not.toBe(reviewed);
		expect(await readFile(join(h.repo, "file.txt"), "utf8")).toBe("changed\n");
		expect((await h.state()).phase).not.toBe("completed");
		expect((await h.state()).deliveries[0].state).toBe("failed");
	});
	it("부모 HEAD를 바꾸는 hook의 커밋을 승인된 전달로 기록하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		const approved = (await h.state()).approval.head;
		const hook = join(h.repo, ".git", "hooks", "post-commit");
		await writeFile(
			hook,
			"#!/bin/sh\nparent=$(git rev-parse HEAD^)\nother=$(printf 'external\\n' | git commit-tree HEAD^{tree} -p $parent)\nreplacement=$(printf 'replacement\\n' | git commit-tree HEAD^{tree} -p $other)\ngit update-ref HEAD $replacement\n",
		);
		await chmod(hook, 0o755);
		/* [When] */ const result = await h.call("deliver", { action: "commit", message: "전달" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(git(h.repo, "rev-parse", "HEAD^")).not.toBe(approved);
		expect((await h.state()).phase).not.toBe("completed");
	});
});

describe("Draft 강제", () => {
	it("일반 PR 제안은 승인 대기로 저장하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start 목표");
		/* [When] */ const result = await h.call("propose", { ...spec, endpoint: "pr", prDraft: false });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).phase).toBe("drafting");
		expect((await h.state()).spec).toBeUndefined();
	});
	it("PR 승인 화면에 Draft 종료 지점을 표시한다", async () => {
		/* [Given] */ const h = await harness();
		h.select("보류");
		/* [When] */ await h.start({ ...spec, endpoint: "pr" });
		/* [Then] */ expect(h.prompts[0]).toMatch(/Draft PR/);
	});
});

describe("증거 불일치 재검사", () => {
	it.each(["review", "deliver"])("%s의 지문 불일치는 증거를 지우고 재검사 가능하게 저장한다", async (action) => {
		/* [Given] */ const h = await harness();
		if (action === "review") {
			await h.approve();
			await h.call("check");
		} else await h.ready();
		await writeFile(join(h.repo, "file.txt"), "unreviewed\n");
		/* [When] */ const result =
			action === "review"
				? await h.call("dispatch", { role: "review", task: "검수" })
				: await h.call("deliver", { action: "commit", message: "전달" });
		/* [Then] */ expect(result.isError).toBe(true);
		const state = await h.state();
		expect(state.phase).toBe("executing");
		expect(state.control).toBe("running");
		expect(state.verification).toBeUndefined();
		expect(state.review).toBeUndefined();
		expect(state.improvementCycles).toBe(1);
		const persisted = JSON.parse(await readFile(storedPath(h), "utf8"));
		expect(persisted.phase).toBe("executing");
		expect(persisted.verification).toBeUndefined();
		expect((await h.call("check")).isError).not.toBe(true);
	});
	it("불일치로 소비한 개선 한도를 초과하면 차단한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, maxImprovementCycles: 1 });
		await h.call("check");
		await writeFile(join(h.repo, "file.txt"), "first drift\n");
		await h.call("dispatch", { role: "review", task: "검수" });
		await h.call("check");
		await writeFile(join(h.repo, "file.txt"), "second drift\n");
		/* [When] */ const result = await h.call("dispatch", { role: "review", task: "검수" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).toBe("blocked");
		expect((await h.state()).reason).toMatch(/개선 한도 초과/);
		expect((await h.state()).improvementCycles).toBe(1);
		expect((await h.state()).verification).toBeUndefined();
	});
});

describe("전달 중단과 재개 회귀", () => {
	it("이미 전송된 PR의 signal 중단은 실제 응답을 기록하되 자동 완료하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await preparePr(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("deliver", { action: "commit", message: "변경" });
		const executable = join(fake.bin, "gh");
		const marker = join(h.root, "signal-creating");
		const release = join(h.root, "signal-pr-release");
		await writeFile(
			executable,
			(await readFile(executable, "utf8")).replace(
				"else if(a[1]==='create') {",
				`else if(a[1]==='create') { fs.writeFileSync(${JSON.stringify(marker)},''); while(!fs.existsSync(${JSON.stringify(release)})) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
			),
		);
		const path = process.env.PATH;
		process.env.PATH = `${fake.bin}:${path}`;
		const signal = new AbortController();
		const delivering = h.call("deliver", { action: "pr", title: "PR", body: "검증" }, signal.signal);
		const observed = Promise.allSettled([delivering]);
		/* [When] */ let stopped: any;
		try {
			await waitForFile(marker);
			signal.abort();
			await h.call("status");
			stopped = await h.state();
		} finally {
			await writeFile(release, "");
			await observed;
			process.env.PATH = path;
		}
		/* [Then] */ expect(stopped.control).toBe("stopping");
		const state = await h.state();
		expect(state.control).toBe("paused");
		expect(state.phase).toBe("ready-to-deliver");
		expect(state.deliveries.find((d: any) => d.action === "pr").state).toBe("done");
	});
	it("재개는 작업 파일이 같아도 실제 HEAD 트리가 다른 커밋 intent를 거절한다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		const stored = await h.state();
		const hook = join(h.repo, ".git", "hooks", "pre-commit");
		await writeFile(
			hook,
			"#!/bin/sh\nblob=$(printf 'hook-only\\n' | git hash-object -w --stdin)\ngit update-index --cacheinfo 100644,$blob,file.txt\n",
		);
		await chmod(hook, 0o755);
		git(h.repo, "add", "-A");
		git(h.repo, "commit", "-m", "중단된 전달");
		stored.control = "paused";
		stored.deliveries.push({
			action: "commit",
			state: "intent",
			at: new Date().toISOString(),
			details: { beforeHead: stored.approval.head, fingerprint: stored.review.fingerprint, message: "전달" },
		});
		await writeFile(storedPath(h), JSON.stringify(stored));
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [When] */ await next.command("resume");
		/* [Then] */ expect((await next.state()).control).toBe("blocked");
		expect((await next.state()).phase).not.toBe("completed");
		expect((await next.state()).deliveries[0].state).toBe("intent");
		expect(await readFile(join(h.repo, "file.txt"), "utf8")).toBe("changed\n");
	});
	it("이미 중단된 signal의 검사는 시작하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const marker = join(h.root, "never-started");
		await h.approve({ ...spec, checks: [`touch '${marker}'`] });
		const signal = new AbortController();
		signal.abort();
		/* [When] */ const result = await h.call("check", {}, signal.signal);
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).toBe("paused");
		await expect(readFile(marker)).rejects.toThrow();
	});
});

describe("관리 명령 정확 일치", () => {
	it.each([
		["백슬래시 구분자", (command: string) => command.replace(" -- managed", " -\\- managed")],
		["결합된 따옴표 구분자", (command: string) => command.replace(" -- managed", ' "-""-" managed')],
		["추가 공백", (command: string) => `${command} `],
		["추가 문자", (command: string) => `${command} extra`],
		["다른 attempt", (command: string) => command.replace(/--managed \S+/, "--managed unknown")],
		["다른 agent", (command: string) => command.replace("run worker", "run other")],
		["다른 context", (command: string) => command.replace("--main", "--isolated")],
	])("변형된 관리 명령은 차단하고 실제 dispatch만 허용한다 %s", async (_label, mutate) => {
		/* [Given] */ const h = await harness();
		await h.approve();
		const execute = h.ctx.executeTool;
		let altered: any;
		let replay: any;
		h.ctx.executeTool = async (name, args, ...rest) => {
			const input = args as { command: string };
			altered = await h.hook("tool_call", { toolName: name, input: { command: mutate(input.command) } });
			const result = await execute(name, args, ...rest);
			replay = await h.hook("tool_call", { toolName: name, input });
			return result;
		};
		/* [When] */ const result = await h.call("dispatch", { role: "implement", task: "구현" });
		/* [Then] */ expect(altered?.block).toBe(true);
		expect(result.isError).not.toBe(true);
		expect(h.started).toHaveLength(1);
		expect(replay?.block).toBe(true);
	});
	it.each(['"subagent" help', 'subagent "help"', "subagent h\\elp", "subagent help 'run'"])(
		"따옴표나 백슬래시가 있는 조회 명령은 차단한다 %s",
		async (command) => {
			/* [Given] */ const h = await harness();
			await h.start();
			/* [When] */ const result = await h.hook("tool_call", { toolName: "subagent", input: { command } });
			/* [Then] */ expect(result?.block).toBe(true);
		},
	);
});

describe("검사 프로세스 그룹 종료", () => {
	it.each(["pause", "signal"])("%s 중단은 SIGTERM을 무시하는 검사와 자식의 종료까지 기다린다", async (action) => {
		/* [Given] */ const h = await harness(true, undefined, { checkKillGraceMs: 250 });
		const script = join(h.root, "stubborn.cjs");
		const marker = join(h.root, "check-group.json");
		await writeFile(
			script,
			`const {spawn}=require('node:child_process'); const fs=require('node:fs');
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
child.stdout.once('data',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid})));
setInterval(()=>{},1000);`,
		);
		await h.approve({ ...spec, checks: [`exec node '${script}'`] });
		const signal = new AbortController();
		const checking = h.call("check", {}, signal.signal);
		const observed = Promise.allSettled([checking]);
		await waitForFile(marker);
		const pids = JSON.parse(await readFile(marker, "utf8"));
		/* [When] */ let waiting: any;
		let returned: any;
		let denied: any;
		let settled = false;
		try {
			if (action === "signal") signal.abort();
			else await h.command("pause");
			checking.then(() => {
				settled = true;
			});
			await h.call("status");
			waiting = await h.state();
			await h.command("resume");
			denied = await h.call("dispatch", { role: "research", task: "조사" });
			returned = await checking;
			/* [Then] */ expect(waiting.control).toBe("stopping");
			expect(denied.isError).toBe(true);
			expect(h.messages.join(" ")).toMatch(/재개할 수 없는|종료하지 않은/);
			expect(returned.isError).toBe(true);
			expect(() => process.kill(-pids.parent, 0)).toThrow();
			expect(() => process.kill(pids.child, 0)).toThrow();
			expect((await h.state()).control).toBe("paused");
		} finally {
			for (const pid of [pids.parent, pids.child]) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					/* 이미 종료된 프로세스 */
				}
			}
			if (!settled) signal.abort();
			await observed;
		}
	});
});

describe("기존 PR push 전 정책", () => {
	it.each([
		["base", { baseRefName: "main" }],
		["Draft", { isDraft: false }],
		["reviewer", { reviewRequests: [{ login: "other" }] }],
		["head branch", { headRefName: "feature/other" }],
	])("기존 PR의 %s 불일치는 전달과 재개 모두 원격을 갱신하지 않는다", async (_field, invalid) => {
		/* [Given] */ const h = await harness();
		const fake = await preparePr(h);
		git(h.repo, "push", "origin", "HEAD:feature/workflow");
		const before = git(h.root, "--git-dir", fake.remote, "rev-parse", "refs/heads/feature/workflow");
		await writeFile(fake.data, JSON.stringify({ ...fake.pr, ...invalid }));
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("deliver", { action: "commit", message: "전달 변경" });
		const path = process.env.PATH;
		process.env.PATH = `${fake.bin}:${path}`;
		/* [When] */ let result: any;
		let afterDelivery: string | undefined;
		let resumed: any;
		try {
			result = await h.call("deliver", { action: "pr", title: "기존 PR", body: "검증" });
			afterDelivery = git(h.root, "--git-dir", fake.remote, "rev-parse", "refs/heads/feature/workflow");
			const stored = await h.state();
			stored.control = "paused";
			stored.deliveries.push({
				action: "pr",
				state: "intent",
				at: new Date().toISOString(),
				details: { branch: stored.approval.branch, head: git(h.repo, "rev-parse", "HEAD") },
			});
			await writeFile(storedPath(h), JSON.stringify(stored));
			const next = await harness(true, h);
			await next.hook("session_start", {});
			await next.command("resume");
			resumed = await next.state();
		} finally {
			process.env.PATH = path;
		}
		/* [Then] */ expect(result.isError).toBe(true);
		expect(afterDelivery).toBe(before);
		expect(git(h.root, "--git-dir", fake.remote, "rev-parse", "refs/heads/feature/workflow")).toBe(before);
		expect(resumed.control).toBe("blocked");
		expect(resumed.phase).not.toBe("completed");
		expect(await readFile(fake.log, "utf8")).not.toMatch(/pr create/);
	});
});

describe("검수 증거 세대", () => {
	it.each([
		["pass", false],
		["blocked", false],
		["changes-requested", false],
		["pass", true],
	])("새 검사 이후 이전 리뷰의 늦은 %s는 새 증거의 단계를 바꾸지 않는다 (원복 %s)", async (verdict, revert) => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("check");
		const original = (await h.state()).verification;
		await h.call("dispatch", { role: "review", task: "T0 검수" });
		await writeFile(join(h.repo, "file.txt"), "T1\n");
		/* [When] */ const invalidation = await h.call("dispatch", { role: "review", task: "변경된 파일 재검수" });
		if (revert) await writeFile(join(h.repo, "file.txt"), "initial\n");
		const recheck = await h.call("check");
		const fresh = await h.state();
		await h.finish(0, { finalOutput: `WORKFLOW_VERDICT: ${verdict}` });
		const late = await h.state();
		const review = await h.call("dispatch", { role: "review", task: "새 증거 검수" });
		await h.finish(1, { finalOutput: "WORKFLOW_VERDICT: pass" });
		/* [Then] */ expect(invalidation.isError).toBe(true);
		expect(recheck.isError).not.toBe(true);
		expect(original.id).toBeTypeOf("string");
		expect(fresh.verification.id).not.toBe(original.id);
		expect(late.phase).toBe("reviewing");
		expect(late.control).toBe("running");
		expect(late.review).toBeUndefined();
		expect(late.verification).toEqual(fresh.verification);
		expect(late.attempts[0].verdict).toBe(verdict);
		expect(review.isError).not.toBe(true);
		expect((await h.state()).phase).toBe("completed");
	});
	it("세대 없는 정본의 PR 전달 조정은 재검수 전까지 완료하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await preparePr(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("deliver", { action: "commit", message: "변경" });
		git(h.repo, "push", "origin", "feature/workflow");
		await writeFile(fake.data, JSON.stringify(fake.pr));
		const stored = await h.state();
		stored.control = "paused";
		stored.verification.id = undefined;
		for (const attempt of stored.attempts) attempt.verificationId = undefined;
		stored.deliveries.push({
			action: "pr",
			state: "intent",
			at: new Date().toISOString(),
			details: { branch: "feature/workflow", head: git(h.repo, "rev-parse", "HEAD"), base: "stage", title: "PR" },
		});
		await writeFile(storedPath(h), JSON.stringify(stored));
		const path = process.env.PATH;
		process.env.PATH = `${fake.bin}:${path}`;
		const next = await harness(true, h);
		let resumed: any;
		let finished: any;
		try {
			await next.hook("session_start", {});
			/* [When] */ await next.command("resume");
			resumed = await next.state();
			await next.call("check");
			await next.call("dispatch", { role: "review", task: "재검수" });
			await next.finish(undefined, { finalOutput: "재검수 완료\nWORKFLOW_VERDICT: pass" });
			await next.call("deliver", { action: "pr", title: "PR", body: "검증" });
			finished = await next.state();
		} finally {
			process.env.PATH = path;
		}
		/* [Then] */ expect(resumed.control).toBe("running");
		expect(resumed.phase).toBe("executing");
		expect(resumed.deliveries.find((d: any) => d.action === "pr").state).toBe("reconciled");
		expect(finished.phase).toBe("completed");
		expect((await readFile(fake.log, "utf8")).match(/pr create/g) ?? []).toHaveLength(0);
	});
	it("세대 없는 정본의 실제로 끝난 커밋 intent는 재검수 뒤 새 커밋 없이 완료한다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		const stored = await h.state();
		git(h.repo, "add", "-A");
		git(h.repo, "commit", "-m", "중단된 전달");
		stored.control = "paused";
		stored.verification.id = undefined;
		for (const attempt of stored.attempts) attempt.verificationId = undefined;
		stored.deliveries.push({
			action: "commit",
			state: "intent",
			at: new Date().toISOString(),
			details: { beforeHead: stored.approval.head, fingerprint: stored.review.fingerprint, message: "전달" },
		});
		await writeFile(storedPath(h), JSON.stringify(stored));
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [When] */ await next.command("resume");
		const resumed = await next.state();
		await next.call("check");
		await next.call("dispatch", { role: "review", task: "재검수" });
		await next.finish(undefined, { finalOutput: "재검수 완료\nWORKFLOW_VERDICT: pass" });
		const delivered = await next.call("deliver", { action: "commit", message: "다시 전달" });
		/* [Then] */ expect(resumed.control).toBe("running");
		expect(resumed.phase).toBe("executing");
		expect(resumed.deliveries[0].state).toBe("reconciled");
		expect(delivered.isError).not.toBe(true);
		expect((await next.state()).phase).toBe("completed");
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("2");
	});
	it("전달된 커밋과 다른 내용을 재검수한 뒤 재개해도 완료하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		const stored = await h.state();
		git(h.repo, "add", "-A");
		git(h.repo, "commit", "-m", "중단된 전달");
		stored.control = "paused";
		stored.verification.id = undefined;
		for (const attempt of stored.attempts) attempt.verificationId = undefined;
		stored.deliveries.push({
			action: "commit",
			state: "intent",
			at: new Date().toISOString(),
			details: { beforeHead: stored.approval.head, fingerprint: stored.review.fingerprint, message: "전달" },
		});
		await writeFile(storedPath(h), JSON.stringify(stored));
		const next = await harness(true, h);
		await next.hook("session_start", {});
		await next.command("resume");
		await writeFile(join(h.repo, "file.txt"), "changed again\n");
		await next.call("check");
		await next.call("dispatch", { role: "review", task: "재검수" });
		await next.finish(undefined, { finalOutput: "재검수 완료\nWORKFLOW_VERDICT: pass" });
		const denied = await next.call("deliver", { action: "commit", message: "다시 전달" });
		/* [When] */ await next.command("resume");
		/* [Then] */ expect(denied.isError).toBe(true);
		expect((await next.state()).phase).not.toBe("completed");
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("2");
	});
	it.each(["reviewing", "ready-to-deliver"])("세대 없는 기존 %s 정본은 로드하되 재검사를 요구한다", async (phase) => {
		/* [Given] */ const h = await harness();
		await h.ready();
		const stored = await h.state();
		stored.phase = phase;
		stored.verification.id = undefined;
		for (const attempt of stored.attempts) attempt.verificationId = undefined;
		await writeFile(storedPath(h), JSON.stringify(stored));
		const next = await harness(true, h);
		/* [When] */ await next.hook("session_start", {});
		await next.command("resume");
		const state = await next.state();
		const denied = await next.call("deliver", { action: "commit", message: "오래된 검수" });
		const recheck = await next.call("check");
		/* [Then] */ expect(state.error).toBeUndefined();
		expect(state.phase).toBe("executing");
		expect(state.verification).toBeUndefined();
		expect(state.review).toBeUndefined();
		expect(denied.isError).toBe(true);
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("1");
		expect(recheck.isError).not.toBe(true);
		expect((await next.state()).verification.id).toBeTypeOf("string");
	});
});

it("검사 타임아웃도 그룹 종료 확인까지 stopping을 유지한다", async () => {
	/* [Given] */ const h = await harness(true, undefined, { checkTimeoutMs: 400, checkKillGraceMs: 250 });
	const script = join(h.root, "timeout.cjs");
	const marker = join(h.root, "timeout-group.json");
	await writeFile(
		script,
		`const {spawn}=require('node:child_process'); const fs=require('node:fs');
process.on('SIGTERM',()=>{});
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
child.stdout.once('data',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid})));
setInterval(()=>{},1000);`,
	);
	await h.approve({ ...spec, checks: [`exec node '${script}'`] });
	const checking = h.call("check");
	const observed = Promise.allSettled([checking]);
	await waitForFile(marker);
	const pids = JSON.parse(await readFile(marker, "utf8"));
	/* [When] */ let stopping: any;
	try {
		for (let i = 0; i < 100; i++) {
			stopping = await h.state();
			if (stopping.control === "stopping") break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const result = await checking;
		/* [Then] */ expect(stopping.control).toBe("stopping");
		expect(result.isError).toBe(true);
		expect(() => process.kill(-pids.parent, 0)).toThrow();
		expect(() => process.kill(pids.child, 0)).toThrow();
		expect((await h.state()).control).toBe("paused");
	} finally {
		for (const pid of [pids.parent, pids.child]) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* 이미 종료된 프로세스 */
			}
		}
		await observed;
	}
});
