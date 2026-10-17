import { readFileSync, watch } from "node:fs";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEventBus,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowController } from "./index.ts";
import { planVersion, type Options } from "./model.ts";

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
		const approvalRemote = join(root, "approval-origin.git");
		git(root, "init", "--bare", approvalRemote);
		git(repo, "remote", "add", "origin", approvalRemote);
	}
	const events = createEventBus();
	const tools = new Map<string, ToolDefinition<any>>();
	const handlers = new Map<string, (...args: any[]) => any>();
	let command: (args: string, ctx: any) => Promise<void> = async () => {};
	let active: string[] = ["bash", "subagent"];
	const refs: any[] = shared?.refs ?? [];
	const messages: string[] = [];
	const userMessages: string[] = [];
	let messageSink: ExtensionAPI["sendUserMessage"] | undefined;
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
	} as unknown as ExtensionToolContext & Pick<ExtensionCommandContext, "waitForIdle">;
	if (managed)
		events.on("subagent:managed:v1:request", (raw: any) => {
			if (raw.type === "capabilities")
				raw.respond({ version: 1, features: ["claim", "cancel", "inspect", "finished", "no-outer-retry", "thinking"] });
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
		sendUserMessage: (message: string, options?: Parameters<ExtensionAPI["sendUserMessage"]>[1]) => {
			messages.push(message);
			userMessages.push(message);
			messageSink?.(message, options);
		},
	} as unknown as ExtensionAPI;
	createWorkflowController({
		agentDir: join(root, "agent"),
		stopTimeoutMs: 15,
		...options,
	})(pi);
	const call = async (name: string, args: any = {}, signal?: AbortSignal) => {
		const tool = tools.get(`workflow_${name}`);
		if (!tool) throw new Error(`등록되지 않은 도구: ${name}`);
		return tool.execute("test-call", args, signal, undefined, ctx);
	};
	const state = async () => (await call("status")).details as any;
	const finish = async (index = started.length - 1, extra: any = {}, wait = true) => {
		events.emit("subagent:managed:v1:event", {
			...started[index],
			type: "finished",
			status: "completed",
			removed: false,
			retryCount: 0,
			finalOutput: "완료",
			...extra,
		});
		const current = await state();
		const attempt = current.attempts.find((a: any) => a.id === started[index].attemptId);
		if (wait && attempt?.role === "deliver" && current.control === "running") {
			await expect
				.poll(
					async () => {
						const latest = await state();
						return latest.phase !== "ready-to-deliver" || latest.control !== "running";
					},
					{ timeout: 3000 },
				)
				.toBe(true);
		}
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
		userMessages,
		forwardUserMessages: (sink: ExtensionAPI["sendUserMessage"]) => {
			messageSink = sink;
		},
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
	it("effort 지정을 지원하지 않는 관리 API로는 시작하지 않는다", async () => {
		/* [Given] */ const h = await harness(false);
		h.events.on("subagent:managed:v1:request", (raw: any) => {
			if (raw.type === "capabilities")
				raw.respond({ version: 1, features: ["claim", "cancel", "inspect", "finished", "no-outer-retry"] });
		});
		/* [When] */ await h.command("start 목표");
		/* [Then] */ expect(h.refs).toHaveLength(0);
	});
	it("메인이 정한 effort로 worker를 실행하고 기록한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		/* [When] */ const result = await h.call("dispatch", { role: "implement", task: "구현", thinking: "low" });
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect(h.claims[0].thinking).toBe("low");
		expect((await h.state()).attempts[0].thinking).toBe("low");
	});
	it("실행 시점의 관리 API가 effort를 지원하지 않으면 effort 실행을 거절한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		h.events.on("subagent:managed:v1:request", (raw: any) => {
			if (raw.type === "capabilities")
				raw.respond({ version: 1, features: ["claim", "cancel", "inspect", "finished", "no-outer-retry"] });
		});
		/* [When] */ const result = await h.call("dispatch", { role: "implement", task: "구현", thinking: "low" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.started).toHaveLength(0);
		expect((await h.state()).attempts).toHaveLength(0);
	});
	it("effort를 정하지 않으면 agent 기본값을 쓴다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		/* [When] */ await h.call("dispatch", { role: "implement", task: "구현" });
		/* [Then] */ expect(h.claims[0].ok).toBe(true);
		expect(h.claims[0].thinking).toBeUndefined();
	});
	it.each(["max", "off", "minimal", "extreme"])("허용 범위 밖 effort는 실행하지 않는다 (%s)", async (thinking) => {
		/* [Given] */ const h = await harness();
		await h.approve();
		/* [When] */ const result = await h.call("dispatch", { role: "implement", task: "구현", thinking });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.started).toHaveLength(0);
		expect((await h.state()).attempts).toHaveLength(0);
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
	it("--auto로 시작하면 계획 제안을 사용자 확인 없이 승인한다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start --auto 파일 변경");
		/* [When] */ await h.call("propose", { ...spec, endpoint: "pr" });
		/* [Then] */ const state = await h.state();
		expect(state.goal).toBe("파일 변경");
		expect(state.autoApprove).toBe(true);
		expect(state.approval.via).toBe("auto");
		expect(state.phase).toBe("executing");
		expect(h.prompts).toHaveLength(0);
	});
	it("--auto로 시작하면 바뀐 계획도 다시 자동 승인한다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start --auto 파일 변경");
		await h.call("propose", spec);
		/* [When] */ await h.call("propose", { ...spec, checks: ["true", "true"] });
		/* [Then] */ const state = await h.state();
		expect(state.approval.planVersion).toBe(state.planVersion);
		expect(state.phase).toBe("executing");
	});
	it("--auto여도 불가능한 제안은 기존 초안을 보존한다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start --auto 파일 변경");
		await writeFile(join(h.repo, "file.txt"), "dirty\n");
		/* [When] */ const result = await h.call("propose", { ...spec, endpoint: "commit" });
		/* [Then] */ expect(result.isError).toBe(true);
		const state = await h.state();
		expect(state.phase).toBe("drafting");
		expect(state.spec).toBeUndefined();
		expect(state.approval).toBeUndefined();
	});
	it("--auto 없이 시작하면 자동 승인하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start 파일 변경");
		/* [When] */ await h.call("propose", spec);
		/* [Then] */ const state = await h.state();
		expect(state.autoApprove).toBeUndefined();
		expect(state.approval).toBeUndefined();
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
			expect((await h.call("dispatch", { role: "deliver", task: "전달" })).isError).toBe(true);
			await h.command("resume");
			expect((await h.state()).error).toMatch(/저장 오류/);
		},
	);
});

describe("인터뷰 합의 전달", () => {
	it.each(["single", "stack"])("%s 도구 시작도 명령 시작과 같은 안내를 일회성 응답으로 받는다", async (mode) => {
		/* [Given] */ const command = await harness();
		const tool = await harness();
		await command.command(`start ${mode === "stack" ? "--stack " : ""}설정 개선`);
		/* [When] */ const result = await tool.call("start", { goal: "설정 개선", mode });
		/* [Then] */ expect(result.isError).not.toBe(true);
		const details = result.details;
		const content = result.content[0];
		if (typeof details !== "object" || details === null || !("guidance" in details) || content?.type !== "text")
			throw new Error("시작 응답에 안내와 텍스트 본문이 필요합니다.");
		expect(details.guidance).toBe(command.messages[0]);
		expect(details.guidance).toEqual(expect.any(String));
		expect(JSON.parse(content.text).guidance).toBe(details.guidance);
		expect((await tool.state()).guidance).toBeUndefined();
		expect(tool.messages).toHaveLength(0);
	});
	it("PR 승인 전에 제외 범위·완료 기준·필수 검수와 실행 한도를 보여준다", async () => {
		/* [Given] */ const h = await harness();
		h.select("보류");
		const proposal = {
			...spec,
			endpoint: "pr",
			nonGoals: ["결제 정책 변경 제외"],
			successCriteria: ["설정 저장 후 재접속해도 선택 유지"],
			requiredReviews: ["설정 접근성 검수"],
			maxImprovementCycles: 3,
			maxRecoveries: 2,
		};
		/* [When] */ await h.start(proposal);
		/* [Then] */ expect(h.prompts[0]).toContain(proposal.nonGoals[0]);
		expect(h.prompts[0]).toContain(proposal.successCriteria[0]);
		expect(h.prompts[0]).toContain(proposal.requiredReviews[0]);
		expect(h.prompts[0]).toMatch(/보완.*3/);
		expect(h.prompts[0]).toMatch(/복구.*2/);
		expect(h.prompts[0]).toMatch(/commit.*push.*Draft PR/);
		expect((await h.state()).approval).toBeUndefined();
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
				: await h.call("dispatch", { role: "deliver", task: "전달" });
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
		const denied = await next.call("dispatch", { role: "deliver", task: "오래된 검수" });
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

async function fakeRemote(h: Awaited<ReturnType<typeof harness>>, bases = ["stage"]) {
	const remote = git(h.repo, "remote", "get-url", "origin");
	git(h.root, "init", "--bare", remote);
	for (const base of bases) git(h.repo, "push", "origin", `HEAD:${base}`);
	const bin = join(h.root, "bin");
	await mkdir(bin);
	const data = join(h.root, "prs.json");
	await writeFile(
		join(bin, "gh"),
		`#!/usr/bin/env node\nconst fs = require('node:fs'); const a = process.argv.slice(2); if (a[0] === 'pr' && a[1] === 'list') process.stdout.write(fs.existsSync(${JSON.stringify(data)}) ? fs.readFileSync(${JSON.stringify(data)}, 'utf8') : '[]'); else process.exit(2);\n`,
	);
	await chmod(join(bin, "gh"), 0o755);
	const withGh = async <T>(action: () => Promise<T>) => {
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path}`;
		try {
			return await action();
		} finally {
			process.env.PATH = path;
		}
	};
	const openPr = async (fields: Record<string, unknown> = {}) =>
		writeFile(
			data,
			JSON.stringify([
				{
					url: "https://example.invalid/pr/1",
					isDraft: true,
					baseRefName: "stage",
					headRefName: "feature/workflow",
					headRefOid: git(h.repo, "rev-parse", "HEAD"),
					...fields,
				},
			]),
		);
	const gate = async () => {
		const marker = join(h.root, "gh-started");
		const release = join(h.root, "gh-release");
		await writeFile(
			join(bin, "gh"),
			`#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, 'started');
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  process.stdout.write(fs.readFileSync(${JSON.stringify(data)}, 'utf8'));
}, 10);
`,
		);
		return { entered: () => waitForFile(marker), release: () => writeFile(release, "released") };
	};
	return { remote, withGh, openPr, gate };
}

describe("전달 worker", () => {
	it("직접 전달 도구는 없다", async () => {
		/* [Given] */ const h = await harness();
		/* [When] */ const names = [...h.tools.keys()];
		/* [Then] */ expect(names).not.toContain("workflow_deliver");
	});
	it("검수 통과 전에는 전달 worker를 실행하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, endpoint: "commit" });
		/* [When] */ const result = await h.call("dispatch", { role: "deliver", task: "전달" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.started).toHaveLength(0);
	});
	it("전달 worker에게 commit 스킬과 종료 지점을 전달한다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		/* [When] */ const result = await h.call("dispatch", { role: "deliver", task: "전달", thinking: "low" });
		/* [Then] */ expect(result.isError).not.toBe(true);
		const claim = h.claims.at(-1);
		expect(claim.task).toMatch(/commit\/SKILL\.md/);
		expect(claim.task).not.toMatch(/pr\/SKILL\.md/);
		expect(claim.thinking).toBe("low");
		expect(h.started.at(-1).agent).toBe("worker");
	});
	it("worker가 나눠 만든 커밋도 검수 내용과 같으면 완료한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, endpoint: "commit" });
		await writeFile(join(h.repo, "file.txt"), "changed\n");
		await writeFile(join(h.repo, "extra.txt"), "extra\n");
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "검수" });
		await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		await h.call("dispatch", { role: "deliver", task: "전달" });
		git(h.repo, "add", "file.txt");
		git(h.repo, "commit", "-m", "첫 번째");
		git(h.repo, "add", "extra.txt");
		git(h.repo, "commit", "-m", "두 번째");
		/* [When] */ await h.finish();
		/* [Then] */ const state = await h.state();
		expect(state.phase).toBe("completed");
		expect(state.deliveries.find((d: any) => d.action === "commit").details.head).toBe(
			git(h.repo, "rev-parse", "HEAD"),
		);
	});
	it("커밋 내용이 검수 내용과 다르면 완료하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		await h.call("dispatch", { role: "deliver", task: "전달" });
		await writeFile(join(h.repo, "file.txt"), "worker changed\n");
		git(h.repo, "commit", "-am", "다른 내용");
		/* [When] */ await h.finish();
		/* [Then] */ const state = await h.state();
		expect(state.phase).not.toBe("completed");
		expect(state.control).toBe("blocked");
	});
	it("커밋하지 않고 끝난 전달 worker는 완료로 보지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		await h.call("dispatch", { role: "deliver", task: "전달" });
		/* [When] */ await h.finish();
		/* [Then] */ const state = await h.state();
		expect(state.phase).toBe("ready-to-deliver");
		expect(state.control).toBe("blocked");
	});
	it("승인 뒤 외부 커밋이 있으면 전달 worker를 실행하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		git(h.repo, "stash");
		git(h.repo, "commit", "--allow-empty", "-m", "외부 변경");
		git(h.repo, "stash", "pop");
		/* [When] */ const result = await h.call("dispatch", { role: "deliver", task: "전달" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.started.filter((run: any) => run.agent === "worker")).toHaveLength(0);
	});
	it("PR 종료 지점은 원격 head와 열린 Draft PR을 확인해 완료한다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("dispatch", { role: "deliver", task: "전달" });
		expect(h.claims.at(-1).task).toMatch(/pr\/SKILL\.md/);
		git(h.repo, "commit", "-am", "전달");
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		/* [When] */ await fake.withGh(() => h.finish());
		/* [Then] */ const state = await h.state();
		expect(state.phase).toBe("completed");
		expect(state.deliveries.find((d: any) => d.action === "pr").details.url).toBe("https://example.invalid/pr/1");
	});
	it.each([
		["base", { baseRefName: "main" }],
		["Draft", { isDraft: false }],
		["head", { headRefOid: "0".repeat(40) }],
	])("PR의 %s가 승인과 다르면 완료하지 않는다", async (_label, fields) => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("dispatch", { role: "deliver", task: "전달" });
		git(h.repo, "commit", "-am", "전달");
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr(fields);
		/* [When] */ await fake.withGh(() => h.finish());
		/* [Then] */ const state = await h.state();
		expect(state.phase).not.toBe("completed");
		expect(state.control).toBe("blocked");
	});
	it("커밋만 되고 PR이 없으면 커밋을 기록하고 재개 뒤 다시 전달할 수 있다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("dispatch", { role: "deliver", task: "전달" });
		git(h.repo, "commit", "-am", "전달");
		await fake.withGh(() => h.finish());
		const blocked = await h.state();
		/* [When] */ await fake.withGh(() => h.command("resume"));
		const retry = await h.call("dispatch", { role: "deliver", task: "PR만 진행" });
		/* [Then] */ expect(blocked.control).toBe("blocked");
		expect(blocked.deliveries.find((d: any) => d.action === "commit").state).toBe("done");
		expect((await h.state()).control).toBe("running");
		expect(retry.isError).not.toBe(true);
	});
	it("재개 중 취소하면 늦게 도착한 PR 조회가 완료 상태를 덮어쓰지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.command("pause");
		git(h.repo, "commit", "-am", "전달");
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		const gate = await fake.gate();
		await fake.withGh(async () => {
			const resuming = h.command("resume");
			try {
				await gate.entered();
				/* [When] */ await h.command("cancel");
			} finally {
				await gate.release();
				await resuming;
			}
		});
		/* [Then] */ const state = await h.state();
		expect(state.control).toBe("cancelled");
		expect(state.phase).not.toBe("completed");
		expect(state.deliveries).toHaveLength(0);
	});
	it("전달 조회 중에도 상태 조회와 일시정지가 응답하고 늦은 결과는 완료로 반영하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("dispatch", { role: "deliver", task: "전달" });
		git(h.repo, "commit", "-am", "전달");
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		const gate = await fake.gate();
		await fake.withGh(async () => {
			const finishing = h.finish(undefined, {}, false);
			let pausing: Promise<void> | undefined;
			try {
				await gate.entered();
				/* [When] */ pausing = h.command("pause");
				/* [Then] */ await expect
					.poll(
						async () =>
							Promise.race([
								h.state().then((state) => state.control),
								new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
							]),
						{ timeout: 700 },
					)
					.toBe("stopping");
			} finally {
				await gate.release();
				await finishing;
				await pausing;
				await expect.poll(async () => (await h.state()).control).toBe("paused");
			}
		});
		expect((await h.state()).phase).not.toBe("completed");
		expect((await h.state()).deliveries).toHaveLength(0);
	});
	it("검사 세대가 없는 기존 커밋 intent도 재개 때 조정해 재검수 뒤 바로 전달한다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		const stored = await h.state();
		stored.deliveries.push({
			action: "commit",
			state: "intent",
			at: new Date().toISOString(),
			details: {
				beforeHead: stored.approval.head,
				fingerprint: stored.review.fingerprint,
			},
		});
		stored.verification.id = undefined;
		for (const attempt of stored.attempts) attempt.verificationId = undefined;
		git(h.repo, "commit", "-am", "기존 전달");
		await writeFile(storedPath(h), JSON.stringify(stored));
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [When] */ await next.command("resume");
		const resumed = await next.state();
		await next.call("check");
		await next.call("dispatch", { role: "review", task: "새 세대로 재검수" });
		await next.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		const delivery = await next.call("dispatch", { role: "deliver", task: "기존 커밋 확인" });
		/* [Then] */ expect(resumed.phase).toBe("executing");
		expect(resumed.deliveries[0].state).toBe("reconciled");
		expect(resumed.deliveries[0].details.head).toBe(git(h.repo, "rev-parse", "HEAD"));
		expect(delivery.isError).not.toBe(true);
		await next.finish();
		expect((await next.state()).phase).toBe("completed");
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("2");
	});
	it("재개 시 이미 끝난 PR 전달을 확인해 완료한다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("dispatch", { role: "deliver", task: "전달" });
		await h.command("pause");
		await h.finish(undefined, { status: "aborted" });
		git(h.repo, "commit", "-am", "전달");
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		/* [When] */ await fake.withGh(() => h.command("resume"));
		/* [Then] */ expect((await h.state()).phase).toBe("completed");
	});
});

describe("stacked PR base", () => {
	it("PR 계획의 base 기본값은 stage다", async () => {
		/* [Given] */ const h = await harness();
		h.select("보류");
		/* [When] */ await h.start({ ...spec, endpoint: "pr" });
		/* [Then] */ expect((await h.state()).spec.prBase).toBe("stage");
		expect(h.prompts[0]).toMatch(/stage/);
	});
	it("보호 브랜치가 아닌 base를 지정한 stacked PR을 확인해 완료한다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h, ["stage", "feature/base"]);
		await h.ready({ ...spec, endpoint: "pr", prBase: "feature/base" });
		await h.call("dispatch", { role: "deliver", task: "전달" });
		expect(h.claims.at(-1).task).toMatch(/feature\/base/);
		git(h.repo, "commit", "-am", "전달");
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr({ baseRefName: "feature/base" });
		/* [When] */ await fake.withGh(() => h.finish());
		/* [Then] */ expect((await h.state()).phase).toBe("completed");
	});
	it.each([
		["보호 브랜치", { endpoint: "pr", prBase: "main" }],
		["PR이 아닌 종료 지점", { endpoint: "commit", prBase: "feature/base" }],
		["잘못된 이름", { endpoint: "pr", prBase: "bad..name" }],
	])("%s의 base 지정은 거절한다", async (_label, fields) => {
		/* [Given] */ const h = await harness();
		await h.command("start 목표");
		/* [When] */ const result = await h.call("propose", { ...spec, ...fields });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).spec).toBeUndefined();
	});
});

const stackPlan = (count = 2) => ({
	title: "설정 기능",
	objective: "검토 단위 PR로 설정 기능 완성",
	nonGoals: ["배포"],
	successCriteria: ["전체 설정 동작"],
	rootBase: "stage",
	units: Array.from({ length: count }, (_, index) => ({
		id: `part-${index + 1}`,
		title: `변경 ${index + 1}`,
		objective: `파일 ${index + 1} 추가`,
		branch: `feature/stack-${index + 1}`,
		checks: ["true"],
		requiredReviews: ["code", "design"],
		ciChecks: [],
	})),
	integrationChecks: ["true"],
	integrationReviews: ["integration"],
});
async function stackHarness(count = 2, auto = true, overrides: Record<string, unknown> = {}) {
	const h = await harness();
	const fake = await fakeRemote(h);
	const prs: Record<string, unknown> = {};
	const data = join(h.root, "stack-prs.json");
	await writeFile(data, "{}");
	await writeFile(
		join(h.root, "bin", "gh"),
		`#!/usr/bin/env node
const fs=require('node:fs'); const a=process.argv.slice(2);
if(a[0]!=='pr'||a[1]!=='list') process.exit(2);
const all=JSON.parse(fs.readFileSync(${JSON.stringify(data)},'utf8'));
process.stdout.write(JSON.stringify(all[a[a.indexOf('--head')+1]]||[]));
`,
	);
	const plan = { ...stackPlan(count), ...overrides };
	await h.command(`start --stack ${auto ? "--auto " : ""}설정 기능`);
	const propose = await fake.withGh(() => h.call("stack_propose", plan));
	expect(propose.isError).not.toBe(true);
	const prepare = async () => {
		const state = await h.state();
		const unit = state.stack.plan.units[state.stack.index];
		const parent = state.stack.results.at(-1)?.head ?? state.stack.approval.rootHead;
		const dispatched = await h.call("dispatch", { role: "prepare", task: "승인 브랜치 준비" });
		expect(dispatched.isError).not.toBe(true);
		git(h.repo, "switch", "-c", unit.branch, parent);
		await fake.withGh(async () => {
			await h.finish();
			await expect.poll(async () => (await h.state()).stack.stage).toBe("unit");
		});
	};
	const review = async (key: string, verdict = "pass") => {
		const dispatched = await h.call("dispatch", { role: "review", reviewKey: key, task: `${key} 검수` });
		expect(dispatched.isError).not.toBe(true);
		await h.finish(undefined, { finalOutput: `WORKFLOW_VERDICT: ${verdict}` });
	};
	const deliver = async () => {
		const state = await h.state();
		const dispatched = await h.call("dispatch", { role: "deliver", task: "검수한 PR 전달" });
		expect(dispatched.isError).not.toBe(true);
		git(h.repo, "add", "-A");
		git(h.repo, "commit", "-m", `전달 ${state.stack.index}`);
		git(h.repo, "push", "origin", state.approval.branch);
		prs[state.approval.branch] = [
			{
				url: `https://example.invalid/pr/${state.stack.index + 1}`,
				isDraft: true,
				baseRefName: state.spec.prBase,
				baseRefOid: state.approval.head,
				headRefName: state.approval.branch,
				headRefOid: git(h.repo, "rev-parse", "HEAD"),
			},
		];
		await writeFile(data, JSON.stringify(prs));
		await fake.withGh(() => h.finish());
	};
	const completeUnit = async () => {
		await prepare();
		const index = (await h.state()).stack.index;
		await writeFile(join(h.repo, `unit-${index}.txt`), `구현 ${index}\n`);
		expect((await h.call("check")).isError).not.toBe(true);
		await review("code");
		await review("design");
		await deliver();
	};
	return { ...h, fake, plan, prepare, review, deliver, completeUnit };
}

describe("선택형 stacked workflow", () => {
	it("통합 검수는 보관된 하위 PR 구현 agent도 거절한다", async () => {
		/* [Given] */ const h = await stackHarness(2);
		await h.prepare();
		await h.call("dispatch", { role: "implement", agent: "first-builder", task: "첫 PR 구현" });
		await writeFile(join(h.repo, "first.txt"), "첫 구현\n");
		await h.finish();
		await h.call("check");
		await h.review("code");
		await h.review("design");
		await h.deliver();
		await h.completeUnit();
		await h.call("check");
		/* [When] */ const result = await h.call("dispatch", {
			role: "review",
			agent: "first-builder",
			reviewKey: "integration",
			task: "자기 구현 최종 검수",
		});
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).phase).toBe("reviewing");
		expect((await h.state()).attempts).toHaveLength(0);
		const independent = await h.call("dispatch", {
			role: "review",
			agent: "reviewer",
			reviewKey: "integration",
			task: "독립 검수",
		});
		expect(independent.isError).not.toBe(true);
	});
	it("prepare 실행 기록 없는 외부 동명 브랜치는 재개로 수용하지 않는다", async () => {
		/* [Given] */ const h = await stackHarness(1);
		const state = await h.state();
		await h.command("pause");
		git(h.repo, "switch", "-c", h.plan.units[0].branch, state.stack.approval.rootHead);
		/* [When] */ await h.fake.withGh(() => h.command("resume"));
		/* [Then] */ expect((await h.state()).control).toBe("blocked");
		expect((await h.state()).stack.stage).toBe("preparing");
		expect((await h.state()).attempts).toHaveLength(0);
	});
	it("prepare 실행 기록 없는 외부 브랜치에서 새 prepare로 재사용을 승인하지 않는다", async () => {
		/* [Given] */ const h = await stackHarness(1);
		const state = await h.state();
		git(h.repo, "switch", "-c", h.plan.units[0].branch, state.stack.approval.rootHead);
		/* [When] */ const result = await h.call("dispatch", { role: "prepare", task: "기존 브랜치 재사용" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.started).toHaveLength(0);
	});
	it.each(["pause", "restart"])("실제 관리 prepare가 만든 브랜치는 %s 후에도 복구한다", async (stop) => {
		/* [Given] */ const h = await stackHarness(1);
		const before = await h.state();
		await h.call("dispatch", { role: "prepare", task: "브랜치 준비" });
		git(h.repo, "switch", "-c", h.plan.units[0].branch, before.stack.approval.rootHead);
		let target = h;
		if (stop === "pause") {
			await h.command("pause");
			await h.finish(undefined, { status: "aborted" });
		} else {
			const restored = await harness(true, h);
			await restored.hook("session_start", {});
			target = { ...h, ...restored };
		}
		/* [When] */ await h.fake.withGh(() => target.command("resume"));
		/* [Then] */ const state = await target.state();
		expect(state.error).toBeUndefined();
		expect(state.control).toBe("running");
		expect(state.stack.stage).toBe("unit");
		expect(state.approval.branch).toBe(h.plan.units[0].branch);
	});

	it("전달 후 기록 전에 중단돼도 재개가 같은 PR을 다시 만들지 않는다", async () => {
		/* [Given] */ const h = await stackHarness(1);
		await h.prepare();
		await writeFile(join(h.repo, "delivered.txt"), "전달 내용\n");
		await h.call("check");
		await h.review("code");
		await h.review("design");
		await h.call("dispatch", { role: "deliver", task: "전달" });
		const before = await h.state();
		git(h.repo, "add", "-A");
		git(h.repo, "commit", "-m", "전달 완료");
		git(h.repo, "push", "origin", before.approval.branch);
		await writeFile(
			join(h.root, "stack-prs.json"),
			JSON.stringify({
				[before.approval.branch]: [
					{
						url: "https://example.invalid/pr/1",
						isDraft: true,
						baseRefName: "stage",
						baseRefOid: before.approval.head,
						headRefName: before.approval.branch,
						headRefOid: git(h.repo, "rev-parse", "HEAD"),
					},
				],
			}),
		);
		await h.command("pause");
		await h.finish(undefined, { status: "aborted" });
		const runs = h.started.length;
		/* [When] */ await h.fake.withGh(() => h.command("resume"));
		/* [Then] */ const state = await h.state();
		expect(state.control).toBe("running");
		expect(state.stack.stage).toBe("integration");
		expect(state.stack.results).toHaveLength(1);
		expect(h.started).toHaveLength(runs);
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("2");
		await h.command("pause");
		await h.fake.withGh(() => h.command("resume"));
		expect((await h.state()).stack.results).toHaveLength(1);
	});

	it("승인 화면을 띄운 뒤 바뀐 계획은 이전 화면의 승인으로 실행하지 않는다", async () => {
		/* [Given] */ const h = await stackHarness(1, false);
		let selected: (value: string) => void = () => {};
		let shown: () => void = () => {};
		const visible = new Promise<void>((resolve) => {
			shown = resolve;
		});
		h.ctx.hasUI = true;
		h.ctx.ui.select = async () => {
			shown();
			return new Promise<string>((resolve) => {
				selected = resolve;
			});
		};
		const first = h.call("stack_propose", h.plan);
		await visible;
		h.ctx.hasUI = false;
		await h.call("stack_propose", { ...h.plan, objective: "다른 계획" });
		/* [When] */ selected("승인");
		await first;
		/* [Then] */ const state = await h.state();
		expect(state.stack.plan.objective).toBe("다른 계획");
		expect(state.stack.approval).toBeUndefined();
		expect(state.phase).toBe("awaiting-approval");
	});
	it("브랜치를 만들지 않은 prepare 완료 보고는 구현 단계로 넘어가지 못한다", async () => {
		/* [Given] */ const h = await stackHarness(1);
		await h.call("dispatch", { role: "prepare", task: "준비" });
		/* [When] */ await h.finish();
		/* [Then] */ await expect.poll(async () => (await h.state()).control).toBe("blocked");
		expect((await h.state()).stack.stage).toBe("preparing");
	});
	it("PR 전달이 끝나도 통합 검사가 실패하면 전체 완료로 기록하지 않는다", async () => {
		/* [Given] */ const h = await stackHarness(1, false);
		await h.call("stack_propose", { ...h.plan, integrationChecks: ["false"] });
		await h.command("approve");
		await h.completeUnit();
		/* [When] */ const check = await h.call("check");
		/* [Then] */ expect(check.isError).toBe(true);
		const state = await h.state();
		expect(state.stack.results).toHaveLength(1);
		expect(state.stack.stage).toBe("integration");
		expect(state.phase).not.toBe("completed");
		expect(state.control).toBe("blocked");
	});

	it.each(["--stack --auto", "--auto --stack"])("%s로만 stacked 자동 승인 모드를 시작한다", async (flags) => {
		/* [Given] */ const h = await harness();
		/* [When] */ await h.command(`start ${flags} 작업`);
		/* [Then] */ expect(await h.state()).toMatchObject({
			mode: "stack",
			autoApprove: true,
			goal: "작업",
			phase: "drafting",
		});
		expect(h.active()).toContain("workflow_stack_propose");
	});
	it("일반 시작은 스택을 만들거나 스택 계획을 허용하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start --auto 작업");
		/* [When] */ const result = await h.call("stack_propose", stackPlan());
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).stack).toBeUndefined();
		expect(h.active()).not.toContain("workflow_stack_propose");
	});
	it("명시 승인이 없으면 브랜치 준비도 시작하지 않는다", async () => {
		/* [Given] */ const h = await stackHarness(1, false);
		/* [When] */ const result = await h.call("dispatch", { role: "prepare", task: "준비" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).phase).toBe("awaiting-approval");
		expect(h.started).toHaveLength(0);
		expect(git(h.repo, "branch", "--show-current")).toBe("feature/workflow");
	});
	it("필수 검수 하나만 통과하면 전달하지 않고 나머지 검수를 받는다", async () => {
		/* [Given] */ const h = await stackHarness();
		await h.prepare();
		await writeFile(join(h.repo, "first.txt"), "첫 변경\n");
		await h.call("check");
		/* [When] */ await h.review("code");
		const denied = await h.call("dispatch", { role: "deliver", task: "성급한 전달" });
		/* [Then] */ expect((await h.state()).phase).toBe("reviewing");
		expect(denied.isError).toBe(true);
		await h.review("design");
		expect((await h.state()).phase).toBe("ready-to-deliver");
	});
	it("앞 PR을 보존하고 다음 PR의 부모로 삼되 전체 통합 검수 전에는 완료하지 않는다", async () => {
		/* [Given] */ const h = await stackHarness();
		await h.completeUnit();
		const first = await h.state();
		/* [When] */ await h.completeUnit();
		/* [Then] */ const state = await h.state();
		expect(first.stack.index).toBe(1);
		expect(first.stack.results).toHaveLength(1);
		expect(first.spec.prBase).toBe(h.plan.units[0].branch);
		expect(first.approval.head).toBe(first.stack.results[0].head);
		expect(state.stack.results).toHaveLength(2);
		expect(state.stack.results[0].execution.reviewResults).toHaveProperty("design");
		expect(state.stack.stage).toBe("integration");
		expect(state.phase).toBe("executing");
		expect(state.verification).toBeUndefined();
		expect(state.review).toBeUndefined();
		await h.call("check");
		await h.fake.withGh(async () => {
			await h.review("integration");
			await expect.poll(async () => (await h.state()).phase).toBe("completed");
		});
		expect((await h.state()).stack.results.map((r: any) => r.base)).toEqual(["stage", h.plan.units[0].branch]);
	});
	it.each(["pause", "cancel"])("%s 후 도착한 전달 결과는 다음 PR을 시작하지 않는다", async (command) => {
		/* [Given] */ const h = await stackHarness();
		await h.prepare();
		await writeFile(join(h.repo, "first.txt"), "변경\n");
		await h.call("check");
		await h.review("code");
		await h.review("design");
		await h.call("dispatch", { role: "deliver", task: "전달" });
		await h.command(command);
		/* [When] */ await h.finish(undefined, { status: "aborted" });
		/* [Then] */ const state = await h.state();
		expect(state.control).toBe(command === "pause" ? "paused" : "cancelled");
		expect(state.stack.index).toBe(0);
		expect(state.stack.results).toHaveLength(0);
	});
	it("재시작은 보존된 다음 PR을 자동 실행하지 않는다", async () => {
		/* [Given] */ const h = await stackHarness();
		await h.completeUnit();
		const next = await harness(true, h);
		/* [When] */ await next.hook("session_start", {});
		/* [Then] */ const state = await next.state();
		expect(state.error).toBeUndefined();
		expect(state.control).toBe("paused");
		expect(state.stack.index).toBe(1);
		expect(state.stack.results).toHaveLength(1);
		expect(next.started).toHaveLength(0);
		await h.fake.withGh(() => next.command("resume"));
		expect((await next.state()).control).toBe("running");
	});
	it("하위 원격 브랜치가 바뀌면 후속 검증을 무효화하고 멈춘다", async () => {
		/* [Given] */ const h = await stackHarness();
		await h.completeUnit();
		git(h.repo, "commit", "--allow-empty", "-m", "외부 변경");
		git(h.repo, "push", "origin", h.plan.units[0].branch);
		await h.command("pause");
		/* [When] */ await h.fake.withGh(() => h.command("resume"));
		/* [Then] */ const state = await h.state();
		expect(state.control).toBe("blocked");
		expect(state.stack.invalidatedFrom).toBe(0);
		expect(state.stack.results[0].valid).toBe(false);
		expect(state.stack.index).toBe(1);
	});
	it("진행 중인 스택은 새 계획으로 덮어쓸 수 없다", async () => {
		/* [Given] */ const h = await stackHarness();
		const original = await h.state();
		/* [When] */ const result = await h.call("stack_propose", { ...h.plan, objective: "범위 확대" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).stack.planVersion).toBe(original.stack.planVersion);
	});
});

describe("Orchestrator lifecycle", () => {
	it("idle에서도 상태 조회와 시작 도구를 활성화한다", async () => {
		/* [Given] */ const h = await harness();
		/* [When] */ await h.hook("session_start", {});
		/* [Then] */ expect(h.active()).toEqual(expect.arrayContaining(["workflow_status", "workflow_start"]));
		expect(h.active()).not.toContain("workflow_dispatch");
		expect(h.tools.get("workflow_start")?.defaultActive).toBe(true);
	});
	it.each(["single", "stack"])(
		"도구로 %s 초안을 시작하되 자기 승인하거나 추가 모델 턴을 만들지 않는다",
		async (mode) => {
			/* [Given] */ const h = await harness();
			/* [When] */ const result = await h.call("start", { goal: "목표 --auto completed", mode });
			/* [Then] */ expect(result.isError).not.toBe(true);
			const state = await h.state();
			expect(state.phase).toBe("drafting");
			expect(state.mode).toBe(mode === "stack" ? "stack" : undefined);
			expect(state.autoApprove).toBeUndefined();
			expect(state.approval).toBeUndefined();
			expect(h.messages).toHaveLength(0);
			expect((await h.call("dispatch", { role: "implement", task: "구현" })).isError).toBe(true);
		},
	);
	it("도구 시작의 기본 모드는 single이고 사용자 승인 전에는 구현하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.call("start", { goal: "파일 변경" });
		/* [When] */ await h.call("propose", spec);
		/* [Then] */ expect((await h.state()).phase).toBe("awaiting-approval");
		expect((await h.state()).mode).toBeUndefined();
		expect((await h.call("dispatch", { role: "implement", task: "구현" })).isError).toBe(true);
		await h.command("approve");
		expect((await h.call("dispatch", { role: "implement", task: "구현" })).isError).not.toBe(true);
	});
	it.each([
		{ goal: " " },
		{ goal: "목표", mode: "auto" },
		{ goal: "목표", auto: true },
		{ goal: "목표", autoApprove: true },
		{ goal: "목표", approval: true },
		{ goal: "목표", actor: "user" },
	])("시작 입력으로 권한을 위조하거나 빈 목표를 보낼 수 없다 %j", async (input) => {
		/* [Given] */ const h = await harness();
		/* [When] */ const result = await h.call("start", input);
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.refs).toHaveLength(0);
	});
	it("자동 승인으로 완료한 다음 도구 시작은 새 사용자 승인을 요구한다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start --auto 이전 작업");
		await h.call("propose", spec);
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "검수" });
		await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		const previous = await h.state();
		/* [When] */ await h.call("start", { goal: "다음 작업" });
		await h.call("propose", spec);
		/* [Then] */ expect(previous.phase).toBe("completed");
		const current = await h.state();
		expect(current.workflowId).not.toBe(previous.workflowId);
		expect(current.autoApprove).toBeUndefined();
		expect(current.approval).toBeUndefined();
		expect(current.phase).toBe("awaiting-approval");
		expect(JSON.parse(await readFile(storedPath(h), "utf8")).phase).toBe("completed");
	});
	it("Orchestrator 일시정지는 명시적 도구 재개로만 풀리고 추가 턴을 만들지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("pause", { reason: "조사 대기" });
		const paused = await h.state();
		const messages = h.messages.length;
		/* [When] */ const result = await h.call("resume");
		/* [Then] */ expect(paused.control).toBe("paused");
		expect(paused.reason).toBe("조사 대기");
		expect(result.isError).not.toBe(true);
		expect((await h.state()).control).toBe("running");
		expect(h.messages).toHaveLength(messages);
	});
	it("Orchestrator 취소는 worker 종료 확인 전까지 새 시작을 거절한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		/* [When] */ await h.call("cancel", { reason: "작업 폐기" });
		const waiting = await h.state();
		const denied = await h.call("start", { goal: "다음 목표" });
		await h.finish(undefined, { status: "aborted" });
		const cancelled = await h.state();
		const next = await h.call("start", { goal: "다음 목표" });
		/* [Then] */ expect(waiting.control).toBe("stopping");
		expect(denied.isError).toBe(true);
		expect(cancelled.control).toBe("cancelled");
		expect(cancelled.phase).not.toBe("completed");
		expect(next.isError).not.toBe(true);
		expect((await h.state()).approval).toBeUndefined();
	});
	it.each(["pause", "cancel"])("사용자 %s는 도구 운영과 세션 재시작으로 해제할 수 없다", async (action) => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.command(action);
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [When] */ const results = await Promise.all([
			next.call("resume"),
			next.call("pause", { reason: "우회" }),
			next.call("cancel", { reason: "우회" }),
			next.call("start", { goal: "우회" }),
		]);
		/* [Then] */ expect(results.every((result) => result.isError)).toBe(true);
		expect((await next.state()).control).toBe(action === "pause" ? "paused" : "cancelled");
		await next.command(action === "pause" ? "resume" : "start 새 목표");
		expect((await next.state()).control).toBe("running");
	});
	it.each(["block", "reviewer"])("%s의 사용자 판단 요청은 도구 재개로 풀 수 없다", async (source) => {
		/* [Given] */ const h = await harness();
		await h.approve();
		if (source === "block") await h.call("block", { reason: "사용자 판단 필요" });
		else {
			await h.call("check");
			await h.call("dispatch", { role: "review", task: "검수" });
			await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: blocked" });
		}
		/* [When] */ const result = await h.call("resume");
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).toBe("blocked");
		await h.command("resume");
		expect((await h.state()).control).toBe("running");
	});
	it("실제 사용자 aborted 이벤트는 Orchestrator 일시정지에도 사용자 보류를 남긴다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("pause", { reason: "운영 대기" });
		/* [When] */ await h.hook("agent_settled", { aborted: true });
		/* [Then] */ expect((await h.call("resume")).isError).toBe(true);
		expect((await h.state()).control).toBe("paused");
	});
	it("실제 Esc로 중단한 worker의 늦은 종료와 재시작은 사용자 보류를 지우지 않는다", async () => {
		/* [Given] */ const h = await harness();
		h.ctx.hasUI = true;
		await h.hook("session_start", {});
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		/* [When] */ h.input("\x1b");
		await expect.poll(async () => (await h.state()).control).toBe("stopping");
		await h.finish(undefined, { status: "aborted" });
		await h.hook("session_shutdown", {});
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [Then] */ expect((await next.call("resume")).isError).toBe(true);
		expect((await next.state()).control).toBe("paused");
	});
	it("세션 재시작으로 중단한 running 정본은 도구로 명시 복구할 수 있다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		const next = await harness(true, h);
		await next.hook("session_start", {});
		const paused = await next.state();
		/* [When] */ const result = await next.call("resume");
		/* [Then] */ expect(paused.control).toBe("paused");
		expect(result.isError).not.toBe(true);
		expect((await next.state()).control).toBe("running");
		expect((await next.call("dispatch", { role: "implement", task: "재구현" })).isError).toBe(true);
		await next.call("recover", { attemptId: paused.attempts[0].id, assessment: "partial", notes: "실제 파일 확인" });
		expect((await next.call("dispatch", { role: "implement", task: "재구현" })).isError).not.toBe(true);
	});
	it.each(["paused", "blocked", "cancelled", "running"])(
		"출처 없는 레거시 %s 정본은 관찰된 시스템 중단만 도구 복구한다",
		async (control) => {
			/* [Given] */ const h = await harness();
			await h.approve();
			const stored = await h.state();
			stored.control = control;
			stored.controlSource = undefined;
			stored.userHold = undefined;
			stored.controlRevision = undefined;
			await writeFile(storedPath(h), JSON.stringify(stored));
			const next = await harness(true, h);
			await next.hook("session_start", {});
			/* [When] */ const result = await next.call("resume");
			/* [Then] */ expect(result.isError === true).toBe(control !== "running");
			expect((await next.state()).control).toBe(control === "running" ? "running" : control);
		},
	);
	it.each([
		["pause", { reason: " " }],
		["cancel", { reason: "" }],
		["resume", { actor: "user" }],
		["pause", { reason: "운영", actor: "user" }],
	])("운영 도구 %s도 빈 이유와 사용자 사칭을 거절한다", async (tool, input) => {
		/* [Given] */ const h = await harness();
		await h.approve();
		/* [When] */ const result = await h.call(tool as string, input);
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).toBe("running");
	});
	it("재개 네트워크 대기 중 사용자 중단은 같은 owner의 늦은 완료보다 우선한다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("pause", { reason: "PR 확인 대기" });
		git(h.repo, "commit", "-am", "전달");
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		const gate = await fake.gate();
		let result: any;
		await fake.withGh(async () => {
			const resuming = h.call("resume");
			const observed = Promise.allSettled([resuming]);
			try {
				await gate.entered();
				/* [When] */ await h.command("pause");
				await h.hook("session_shutdown", {});
			} finally {
				await gate.release();
				await observed;
				result = await resuming;
			}
		});
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).toBe("paused");
		expect((await h.state()).phase).not.toBe("completed");
		expect((await h.state()).deliveries).toHaveLength(0);
		expect((await h.call("resume")).isError).toBe(true);
	});
	it("재개 도구의 사용자 abort는 늦은 PR 확인과 새 시작을 막는다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("pause", { reason: "PR 확인 대기" });
		git(h.repo, "commit", "-am", "전달");
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		const gate = await fake.gate();
		const abort = new AbortController();
		let result: any;
		await fake.withGh(async () => {
			const resuming = h.call("resume", {}, abort.signal);
			const observed = Promise.allSettled([resuming]);
			try {
				await gate.entered();
				/* [When] */ abort.abort();
			} finally {
				await gate.release();
				await observed;
				result = await resuming;
			}
		});
		await h.hook("agent_settled", { aborted: true });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).toBe("paused");
		expect((await h.state()).phase).not.toBe("completed");
		expect((await h.state()).userHold).toBe(true);
		expect((await h.call("resume")).isError).toBe(true);
		expect((await h.call("start", { goal: "중단 우회" })).isError).toBe(true);
	});
	it("이미 중단된 재개 도구 호출도 사용자 보류를 남긴다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("pause", { reason: "운영 대기" });
		const abort = new AbortController();
		abort.abort();
		/* [When] */ const result = await h.call("resume", {}, abort.signal);
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).toBe("paused");
		expect((await h.state()).userHold).toBe(true);
	});
	it("기계적 PR 전달 실패는 도구 재개 때 기존 원격 검증을 통과해야 한다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		await h.ready({ ...spec, endpoint: "pr" });
		await h.call("dispatch", { role: "deliver", task: "전달" });
		git(h.repo, "commit", "-am", "전달");
		await fake.withGh(() => h.finish());
		/* [When] */ const result = await fake.withGh(() => h.call("resume"));
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect((await h.state()).control).toBe("running");
		expect((await h.state()).phase).toBe("ready-to-deliver");
		expect((await h.state()).deliveries.find((d: any) => d.action === "commit").state).toBe("done");
	});
});

describe("Orchestrator lifecycle 경계", () => {
	it.each(["개선", "복구"])("%s 한도 차단은 도구 pause 후 resume으로 우회하지 못한다", async (limit) => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, maxImprovementCycles: 1, maxRecoveries: 0 });
		if (limit === "복구") {
			await h.call("dispatch", { role: "implement", task: "구현" });
			await h.finish(undefined, { status: "failed" });
			await h.call("recover", {
				attemptId: (await h.state()).attempts[0].id,
				assessment: "partial",
				notes: "파일 확인",
			});
		} else {
			for (let i = 0; i < 2; i++) {
				await h.call("check");
				await h.call("dispatch", { role: "review", task: "검수" });
				await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: changes-requested" });
			}
		}
		/* [When] */ await h.call("pause", { reason: "한도 이유 덮어쓰기" });
		const result = await h.call("resume");
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).not.toBe("running");
	});
	it("사용자 재개로 전달을 확인해 완료하면 다음 도구 시작을 막지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.ready();
		await h.command("pause");
		git(h.repo, "commit", "-am", "전달");
		await h.command("resume");
		const completed = await h.state();
		/* [When] */ const result = await h.call("start", { goal: "새 목표" });
		/* [Then] */ expect(completed.phase).toBe("completed");
		expect(completed.userHold).toBe(false);
		expect(result.isError).not.toBe(true);
		expect((await h.state()).phase).toBe("drafting");
	});
	it("같은 프로세스라도 다른 세션의 정본은 도구가 시작하거나 재개하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		const stored = await h.state();
		stored.owner.sessionId = "another-live-session";
		await writeFile(storedPath(h), JSON.stringify(stored));
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [When] */ const result = await next.call("resume");
		const start = await next.call("start", { goal: "소유권 우회" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(start.isError).toBe(true);
		expect((await next.state()).owner.sessionId).toBe("another-live-session");
		expect((await next.state()).control).toBe("running");
	});
	it("세션 종료의 시스템 중단은 다음 세션에서 도구로 명시 재개할 수 있다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.hook("session_shutdown", {});
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [When] */ const result = await next.call("resume");
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect((await next.state()).control).toBe("running");
	});
	it("취소 대기 중 늦은 사용자 aborted 신호가 취소를 일시정지로 바꾸지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("dispatch", { role: "implement", task: "구현" });
		await h.call("cancel", { reason: "폐기" });
		/* [When] */ await h.hook("agent_settled", { aborted: true });
		await h.finish(undefined, { status: "aborted" });
		/* [Then] */ expect((await h.state()).control).toBe("cancelled");
		expect((await h.call("start", { goal: "사용자 보류 우회" })).isError).toBe(true);
	});
	it("도구 재개도 승인 브랜치가 바뀌면 실행을 허용하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("pause", { reason: "대기" });
		git(h.repo, "switch", "-c", "feature/another");
		/* [When] */ const result = await h.call("resume");
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).control).toBe("paused");
	});
	it("부분적인 lifecycle 권한 정본은 추측하지 않고 손상으로 거절한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		const stored = await h.state();
		stored.userHold = undefined;
		await writeFile(storedPath(h), JSON.stringify(stored));
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [When] */ const result = await next.call("start", { goal: "새 작업" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await next.state()).error).toMatch(/손상/);
	});
	it("자기 승인이나 강제 완료 도구를 등록하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		/* [When] */ const names = [...h.tools.keys()];
		/* [Then] */ expect(names).not.toContain("workflow_approve");
		expect(names).not.toContain("workflow_force_complete");
		expect(names).not.toContain("workflow_end");
	});
});

it("세션 종료 뒤에도 이전 worker의 abortPending이 남으면 도구 재개를 거절한다", async () => {
	/* [Given] */ const h = await harness();
	await h.approve();
	await h.call("dispatch", { role: "implement", task: "구현" });
	await h.hook("session_shutdown", {});
	const next = await harness(true, h);
	let stopped = false;
	next.events.on("subagent:managed:v1:request", (raw: any) => {
		if (raw.type === "inspect" && raw.owner.generation === 1)
			raw.respond({ ok: true, runs: stopped ? [] : [{ status: "running", removed: true, abortPending: true }] });
	});
	await next.hook("session_start", {});
	/* [When] */ const pending = await next.call("resume");
	const waiting = await next.state();
	stopped = true;
	const settled = await next.call("resume");
	/* [Then] */ expect(pending.isError).toBe(true);
	expect(waiting.control).toBe("paused");
	expect(settled.isError).not.toBe(true);
});

async function existingCommitReady(overrides: Record<string, unknown> = {}) {
	const h = await harness();
	await writeFile(join(h.repo, "file.txt"), "already implemented\n");
	git(h.repo, "commit", "-am", "기존 구현");
	await h.approve({ ...spec, endpoint: "pr", deliveryMode: "existing-commit", ...overrides });
	await h.call("check");
	for (const reviewKey of (overrides.requiredReviews as string[] | undefined) ?? ["code"]) {
		await h.call("dispatch", { role: "review", reviewKey, task: "현재 커밋 독립 검수" });
		await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
	}
	return h;
}

describe("기존 커밋 전달", () => {
	it("승인된 기존 커밋을 새 커밋 없이 Draft PR로 전달한다", async () => {
		/* [Given] */ const h = await existingCommitReady();
		const head = git(h.repo, "rev-parse", "HEAD");
		const count = git(h.repo, "rev-list", "--count", "HEAD");
		const fake = await fakeRemote(h);
		const dispatched = await h.call("dispatch", { role: "deliver", task: "기존 커밋 전달" });
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		/* [When] */ await fake.withGh(() => h.finish());
		/* [Then] */ expect(dispatched.isError).not.toBe(true);
		const state = await h.state();
		expect(state.phase).toBe("completed");
		expect(state.spec.deliveryMode).toBe("existing-commit");
		expect(state.approval.head).toBe(head);
		expect(git(h.repo, "rev-parse", "HEAD")).toBe(head);
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe(count);
		expect(state.deliveries.find((d: any) => d.action === "commit").details).toMatchObject({ head, reused: true });
		expect(state.deliveries.find((d: any) => d.action === "pr").details.url).toBe("https://example.invalid/pr/1");
		expect(h.claims.at(-1).task).toMatch(/pr\/SKILL\.md/);
		expect(h.claims.at(-1).task).not.toMatch(/commit\/SKILL\.md/);
		expect(h.claims.at(-1).task).toContain(head);
		expect(h.claims.at(-1).task).toMatch(/새.*commit.*금지/);
	});
	it.each(["verify", "commit"])("%s 종료 지점에는 기존 커밋 전달 모드를 허용하지 않는다", async (endpoint) => {
		/* [Given] */ const h = await harness();
		await h.command("start 기존 커밋 전달");
		/* [When] */ const result = await h.call("propose", { ...spec, endpoint, deliveryMode: "existing-commit" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).spec).toBeUndefined();
	});
	it("알 수 없는 전달 모드는 승인하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start 기존 커밋 전달");
		/* [When] */ const result = await h.call("propose", { ...spec, endpoint: "pr", deliveryMode: "unknown" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).spec).toBeUndefined();
	});
	it.each(["implement", "prepare"])("기존 커밋 전달 모드에서는 %s worker를 허용하지 않는다", async (role) => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, endpoint: "pr", deliveryMode: "existing-commit" });
		/* [When] */ const result = await h.call("dispatch", { role, task: "작업" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.started).toHaveLength(0);
	});
	it.each(["check", "review", "deliver"])("기존 커밋 승인 뒤 빈 커밋도 %s에서 거절한다", async (action) => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, endpoint: "pr", deliveryMode: "existing-commit" });
		if (action !== "check") await h.call("check");
		if (action === "deliver") {
			await h.call("dispatch", { role: "review", task: "검수" });
			await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		}
		git(h.repo, "commit", "--allow-empty", "-m", "승인 뒤 빈 커밋");
		/* [When] */ const result =
			action === "check" ? await h.call("check") : await h.call("dispatch", { role: action, task: "작업" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).phase).not.toBe("completed");
	});
	it.each(["check", "review", "deliver"])("기존 커밋 승인 뒤 dirty 작업 트리도 %s에서 거절한다", async (action) => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, endpoint: "pr", deliveryMode: "existing-commit" });
		if (action !== "check") await h.call("check");
		if (action === "deliver") {
			await h.call("dispatch", { role: "review", task: "검수" });
			await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		}
		await writeFile(join(h.repo, "file.txt"), "unapproved\n");
		/* [When] */ const result =
			action === "check" ? await h.call("check") : await h.call("dispatch", { role: action, task: "작업" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).phase).not.toBe("completed");
	});
	it("기존 커밋 전달로 계획을 바꾸면 승인과 검사 증거를 다시 요구한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, endpoint: "pr" });
		await h.call("check");
		const version = (await h.state()).planVersion;
		/* [When] */ await h.call("propose", { ...spec, endpoint: "pr", deliveryMode: "existing-commit" });
		/* [Then] */ const state = await h.state();
		expect(state.planVersion).not.toBe(version);
		expect(state.phase).toBe("awaiting-approval");
		expect(state.approval).toBeUndefined();
		expect(state.verification).toBeUndefined();
	});
	it("승인 화면의 기존 커밋 SHA가 선택 전에 바뀌면 승인하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const head = git(h.repo, "rev-parse", "HEAD");
		h.ctx.hasUI = true;
		h.ctx.ui.select = async (prompt) => {
			h.prompts.push(prompt);
			git(h.repo, "commit", "--allow-empty", "-m", "화면 이후 변경");
			return "승인";
		};
		await h.command("start 기존 커밋 전달");
		/* [When] */ const result = await h.call("propose", { ...spec, endpoint: "pr", deliveryMode: "existing-commit" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(h.prompts[0]).toContain(head);
		expect(h.prompts[0]).toMatch(/기존 커밋/);
		expect(h.prompts[0]).toMatch(/새 커밋.*금지/);
		expect((await h.state()).approval).toBeUndefined();
	});
	it("기존 커밋 검사 중 HEAD가 바뀌면 검사 증거를 남기지 않는다", async () => {
		/* [Given] */ const h = await harness();
		const marker = join(h.root, "check-entered");
		const release = join(h.root, "check-release");
		await h.approve({
			...spec,
			endpoint: "pr",
			deliveryMode: "existing-commit",
			checks: [`touch '${marker}'; while [ ! -e '${release}' ]; do sleep 0.01; done`],
		});
		const checking = h.call("check");
		let result: Awaited<ReturnType<typeof h.call>>;
		try {
			await waitForFile(marker);
			/* [When] */ git(h.repo, "commit", "--allow-empty", "-m", "검사 중 변경");
		} finally {
			await writeFile(release, "release");
			result = await checking;
		}
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).verification).toBeUndefined();
	});
	it("기존 커밋 검수 중 HEAD가 바뀌면 전달 가능한 증거를 남기지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({ ...spec, endpoint: "pr", deliveryMode: "existing-commit" });
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "검수" });
		git(h.repo, "commit", "--allow-empty", "-m", "검수 중 변경");
		/* [When] */ await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		/* [Then] */ const state = await h.state();
		expect(state.phase).not.toBe("ready-to-deliver");
		expect(state.review).toBeUndefined();
	});
	it("기존 커밋도 필수 검수가 남으면 전달하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve({
			...spec,
			endpoint: "pr",
			deliveryMode: "existing-commit",
			requiredReviews: ["code", "security"],
		});
		await h.call("check");
		await h.call("dispatch", { role: "review", reviewKey: "code", task: "코드 검수" });
		await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		/* [When] */ const result = await h.call("dispatch", { role: "deliver", task: "전달" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).phase).toBe("reviewing");
	});
	it.each(["remote", "PR", "base"])("기존 커밋의 %s가 맞지 않으면 전달을 완료하지 않는다", async (boundary) => {
		/* [Given] */ const h = await existingCommitReady();
		const fake = await fakeRemote(h);
		await h.call("dispatch", { role: "deliver", task: "전달" });
		git(h.repo, "push", "origin", `${boundary === "remote" ? "HEAD~1" : "HEAD"}:refs/heads/feature/workflow`);
		if (boundary !== "PR") await fake.openPr(boundary === "base" ? { baseRefName: "main" } : {});
		/* [When] */ await fake.withGh(() => h.finish());
		/* [Then] */ expect((await h.state()).control).toBe("blocked");
		expect((await h.state()).phase).not.toBe("completed");
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("2");
	});
	it.each(["head", "dirty"])("기존 커밋 전달 조회 중 %s가 바뀌면 완료하지 않는다", async (change) => {
		/* [Given] */ const h = await existingCommitReady();
		const fake = await fakeRemote(h);
		await h.call("dispatch", { role: "deliver", task: "전달" });
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		const gate = await fake.gate();
		await fake.withGh(async () => {
			await h.finish(undefined, {}, false);
			try {
				await gate.entered();
				/* [When] */ if (change === "head") git(h.repo, "commit", "--allow-empty", "-m", "조회 중 변경");
				else await writeFile(join(h.repo, "file.txt"), "changed during query\n");
			} finally {
				await gate.release();
			}
			/* [Then] */ await expect.poll(async () => (await h.state()).control).toBe("blocked");
		});
		expect((await h.state()).phase).not.toBe("completed");
	});
	it("기존 커밋 전달 worker 실패는 자동 완료하지 않고 재개로 실제 결과를 확인한다", async () => {
		/* [Given] */ const h = await existingCommitReady();
		const fake = await fakeRemote(h);
		await h.call("dispatch", { role: "deliver", task: "전달" });
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		await fake.withGh(() => h.finish(undefined, { status: "failed", exitCode: 1 }));
		const blocked = await h.state();
		/* [When] */ await fake.withGh(() => h.command("resume"));
		/* [Then] */ expect(blocked.control).toBe("blocked");
		expect(blocked.phase).not.toBe("completed");
		expect((await h.state()).phase).toBe("completed");
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("2");
	});
	it("재시작 후 기존 커밋 전달을 조정해 중복 worker 없이 완료한다", async () => {
		/* [Given] */ const h = await existingCommitReady();
		const fake = await fakeRemote(h);
		await h.call("dispatch", { role: "deliver", task: "전달" });
		await fake.withGh(() => h.finish());
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		const next = await harness(true, h);
		await next.hook("session_start", {});
		/* [When] */ await fake.withGh(() => next.command("resume"));
		/* [Then] */ const state = await next.state();
		expect(state.phase).toBe("completed");
		expect(state.spec.deliveryMode).toBe("existing-commit");
		expect(state.deliveries.filter((d: any) => d.action === "commit")).toHaveLength(1);
		expect(state.deliveries.filter((d: any) => d.action === "pr")).toHaveLength(1);
		expect(next.started).toHaveLength(0);
		expect(git(h.repo, "rev-list", "--count", "HEAD")).toBe("2");
		expect((await next.call("dispatch", { role: "deliver", task: "중복 전달" })).isError).toBe(true);
	});
});

describe("기존 커밋 전달 승인과 복원 경계", () => {
	it("기존 커밋 SHA를 보여준 화면에서 같은 커밋을 승인한다", async () => {
		/* [Given] */ const h = await harness();
		h.select("승인");
		const head = git(h.repo, "rev-parse", "HEAD");
		/* [When] */ await h.start({ ...spec, endpoint: "pr", deliveryMode: "existing-commit" });
		/* [Then] */ const state = await h.state();
		expect(h.prompts[0]).toContain(head);
		expect(state.approval).toMatchObject({ via: "ui", head });
		expect(state.phase).toBe("executing");
	});
	it("자동 승인도 현재 기존 커밋 SHA를 고정한다", async () => {
		/* [Given] */ const h = await harness();
		await h.command("start --auto 기존 커밋 전달");
		const head = git(h.repo, "rev-parse", "HEAD");
		/* [When] */ await h.call("propose", { ...spec, endpoint: "pr", deliveryMode: "existing-commit" });
		/* [Then] */ expect((await h.state()).approval).toMatchObject({ via: "auto", head });
	});
	it.each(["verify", "commit"])("저장된 기존 커밋 모드의 %s 종료 지점도 복원하지 않는다", async (endpoint) => {
		/* [Given] */ const h = await existingCommitReady();
		const stored = await h.state();
		stored.spec.endpoint = endpoint;
		stored.planVersion = planVersion(stored.spec);
		stored.approval.planVersion = stored.planVersion;
		await writeFile(storedPath(h), JSON.stringify(stored));
		const next = await harness(true, h);
		/* [When] */ await next.hook("session_start", {});
		/* [Then] */ expect((await next.state()).error).toMatch(/정본.*손상/);
		expect(next.started).toHaveLength(0);
	});
	it.each(["pause", "cancel"])("기존 커밋 PR 조회 중 사용자 %s는 늦은 완료 결과보다 우선한다", async (command) => {
		/* [Given] */ const h = await existingCommitReady();
		const fake = await fakeRemote(h);
		await h.call("dispatch", { role: "deliver", task: "전달" });
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		const gate = await fake.gate();
		await fake.withGh(async () => {
			await h.finish(undefined, {}, false);
			try {
				await gate.entered();
				/* [When] */ await h.command(command);
			} finally {
				await gate.release();
			}
			/* [Then] */ await expect
				.poll(async () => (await h.state()).control)
				.toBe(command === "pause" ? "paused" : "cancelled");
		});
		const state = await h.state();
		expect(state.phase).not.toBe("completed");
		expect(state.userHold).toBe(true);
		expect(state.deliveries).toHaveLength(0);
	});
});

describe("기존 변경 인수와 사전 검사", () => {
	it("시작 전 사전 검사는 변경 목록을 반환하고 index와 파일을 보존한다", async () => {
		/* [Given] */ const h = await harness();
		await h.hook("session_start", { type: "session_start" });
		await writeFile(join(h.repo, "new.txt"), "새 작업\n");
		git(h.repo, "add", "new.txt");
		await writeFile(join(h.repo, "new.txt"), "보완 작업\n");
		const index = await readFile(join(h.repo, ".git/index"));
		const refs = structuredClone(h.refs);
		/* [When] */ const result = await h.call("preflight");
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect((result.details as { eligible: boolean | null }).eligible).toBeNull();
		expect((result.details as { changes: unknown[] }).changes).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "new.txt" })]),
		);
		expect(await readFile(join(h.repo, ".git/index"))).toEqual(index);
		expect(await readFile(join(h.repo, "new.txt"), "utf8")).toBe("보완 작업\n");
		expect(h.refs).toEqual(refs);
		expect(h.active()).toContain("workflow_preflight");
	});
	it("승인 불가능한 새 계획은 기존 승인과 검사 증거를 보존한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("check");
		await writeFile(join(h.repo, "file.txt"), "인수할 변경\n");
		const before = await h.state();
		/* [When] */ const result = await h.call("propose", { ...spec, endpoint: "commit" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
	});
	it("UI에서 후보를 보류하면 기존 승인과 검사 증거를 보존한다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("check");
		const before = await h.state();
		h.select("보류");
		/* [When] */ await h.call("propose", { ...spec, title: "새 계획" });
		/* [Then] */ expect(await h.state()).toEqual(before);
	});
	it("후보 승인 중 파일이 바뀌어도 기존 승인과 증거를 잃지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.call("check");
		const before = await h.state();
		h.ctx.hasUI = true;
		h.ctx.ui.select = async () => {
			await writeFile(join(h.repo, "file.txt"), "승인 중 변경\n");
			return "승인";
		};
		/* [When] */ const result = await h.call("propose", { ...spec, title: "새 계획" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
	});
	it("여섯 신규 파일을 인수한 뒤 검사와 독립 검수를 거쳐 PR까지 전달한다", async () => {
		/* [Given] */ const h = await harness();
		const fake = await fakeRemote(h);
		const paths = Array.from({ length: 6 }, (_, i) => `ui-${i}.txt`);
		for (const path of paths) await writeFile(join(h.repo, path), "독립 UI\n");
		await h.approve({ ...spec, endpoint: "pr", adoptChanges: { paths } });
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "인수 산출물 검수" });
		await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		const dispatched = await h.call("dispatch", { role: "deliver", task: "인수 산출물 전달" });
		git(h.repo, "add", "-A");
		git(h.repo, "commit", "-m", "독립 UI");
		git(h.repo, "push", "origin", "feature/workflow");
		await fake.openPr();
		/* [When] */ await fake.withGh(() => h.finish());
		/* [Then] */ expect(dispatched.isError).not.toBe(true);
		const state = await h.state();
		expect(state.phase).toBe("completed");
		expect(state.approval.adoption.paths).toEqual(paths);
		expect(state.approval.adoption.changes).toHaveLength(6);
		expect(state.deliveries.find((d: any) => d.action === "pr").details.url).toBe("https://example.invalid/pr/1");
	});
	it.each(["누락", "무관한 추가"])("인수 대상 %s은 제안 단계에서 차단한다", async (kind) => {
		/* [Given] */ const h = await harness();
		await writeFile(join(h.repo, "first.txt"), "작업\n");
		await writeFile(join(h.repo, "second.txt"), "별도 작업\n");
		await h.command("start 인수");
		/* [When] */ const result = await h.call("propose", {
			...spec,
			endpoint: "commit",
			adoptChanges: { paths: kind === "누락" ? ["first.txt"] : ["first.txt", "second.txt", "missing.txt"] },
		});
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).spec).toBeUndefined();
	});
	it.each(["../file.txt", "/tmp/file.txt", "./file.txt", "", "*.txt", "dir//file.txt"])(
		"잘못된 허용 경로 %s를 거절한다",
		async (path) => {
			/* [Given] */ const h = await harness();
			await writeFile(join(h.repo, "file.txt"), "작업\n");
			/* [When] */ const result = await h.call("preflight", {
				spec: { ...spec, endpoint: "commit", adoptChanges: { paths: ["file.txt"], allowedPaths: [path] } },
			});
			/* [Then] */ expect((result.details as { eligible: boolean }).eligible).toBe(false);
		},
	);
	it.each(["head", "file", "index", "remote"])("인수 승인 화면 이후 %s 변경을 거절한다", async (kind) => {
		/* [Given] */ const h = await harness();
		await fakeRemote(h);
		await writeFile(join(h.repo, "new.txt"), "작업\n");
		h.ctx.hasUI = true;
		h.ctx.ui.select = async () => {
			if (kind === "head") git(h.repo, "commit", "--allow-empty", "-m", "경합");
			if (kind === "file") await writeFile(join(h.repo, "new.txt"), "바뀐 작업\n");
			if (kind === "index") git(h.repo, "add", "new.txt");
			if (kind === "remote") git(h.repo, "remote", "set-url", "origin", join(h.root, "other.git"));
			return "승인";
		};
		await h.command("start 인수");
		/* [When] */ const result = await h.call("propose", {
			...spec,
			endpoint: "pr",
			adoptChanges: { paths: ["new.txt"] },
		});
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).approval).toBeUndefined();
	});
	it("허용 범위 안의 보완은 재승인 없이 증거를 갱신한다", async () => {
		/* [Given] */ const h = await harness();
		await writeFile(join(h.repo, "file.txt"), "인수 작업\n");
		await h.approve({ ...spec, endpoint: "commit", adoptChanges: { paths: ["file.txt"] } });
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "검수" });
		await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		const approval = (await h.state()).approval;
		await writeFile(join(h.repo, "file.txt"), "보완 작업\n");
		const stale = await h.call("dispatch", { role: "deliver", task: "전달" });
		/* [When] */ const checked = await h.call("check");
		/* [Then] */ expect(stale.isError).toBe(true);
		expect(checked.isError).not.toBe(true);
		expect((await h.state()).approval).toEqual(approval);
		expect((await h.state()).review).toBeUndefined();
	});
	it.each(["check", "review", "deliver", "implement"])("범위 밖 변경은 %s에서 차단한다", async (action) => {
		/* [Given] */ const h = await harness();
		await writeFile(join(h.repo, "file.txt"), "인수 작업\n");
		await h.approve({ ...spec, endpoint: "commit", adoptChanges: { paths: ["file.txt"] } });
		if (["review", "deliver"].includes(action)) await h.call("check");
		if (action === "deliver") {
			await h.call("dispatch", { role: "review", task: "검수" });
			await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		}
		await writeFile(join(h.repo, "outside.txt"), "승인 외 작업\n");
		/* [When] */ const result =
			action === "check" ? await h.call("check") : await h.call("dispatch", { role: action, task: "작업" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(/범위|경로/);
	});
	it("기준 HEAD 이후 커밋된 범위 밖 파일도 검사하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await writeFile(join(h.repo, "file.txt"), "인수 작업\n");
		await h.approve({ ...spec, endpoint: "commit", adoptChanges: { paths: ["file.txt"] } });
		await writeFile(join(h.repo, "outside.txt"), "승인 외 작업\n");
		git(h.repo, "add", "outside.txt");
		git(h.repo, "commit", "-m", "범위 우회");
		/* [When] */ const result = await h.call("check");
		/* [Then] */ expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(/범위|경로/);
	});
	it("실제 관리 worker가 남아 있으면 후보를 적용하지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		const before = await h.state();
		h.events.on("subagent:managed:v1:request", (raw: any) => {
			if (raw.type === "inspect") raw.respond({ ok: true, runs: [{ status: "running" }] });
		});
		/* [When] */ const result = await h.call("propose", { ...spec, title: "전환" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
	});
	it("재시작은 인수 증거와 사용자 보류를 보존한다", async () => {
		/* [Given] */ const h = await harness();
		await writeFile(join(h.repo, "file.txt"), "인수 작업\n");
		await h.approve({ ...spec, endpoint: "commit", adoptChanges: { paths: ["file.txt"] } });
		await h.command("pause");
		const before = await h.state();
		const next = await harness(true, { root: h.root, refs: h.refs });
		/* [When] */ await next.hook("session_start", { type: "session_start" });
		/* [Then] */ const current = await next.state();
		expect(current.approval.adoption).toEqual(before.approval.adoption);
		expect(current.userHold).toBe(true);
		expect(next.active()).toContain("workflow_preflight");
	});

	it.each(["head", "file", "index", "remote"])("명령 승인 전 %s 변경도 재제안을 요구한다", async (kind) => {
		/* [Given] */ const h = await harness();
		await writeFile(join(h.repo, "file.txt"), "인수 작업\n");
		await h.start({ ...spec, endpoint: "pr", adoptChanges: { paths: ["file.txt"] } });
		if (kind === "head") git(h.repo, "commit", "--allow-empty", "-m", "경합");
		if (kind === "file") await writeFile(join(h.repo, "file.txt"), "바뀐 작업\n");
		if (kind === "index") git(h.repo, "add", "file.txt");
		if (kind === "remote") git(h.repo, "remote", "set-url", "origin", join(h.root, "other.git"));
		/* [When] */ await h.command("approve");
		/* [Then] */ expect((await h.state()).approval).toBeUndefined();
		expect(h.messages.join(" ")).toMatch(/승인 화면 이후/);
	});
	it.each(["check", "review", "deliver"])("승인 이후 origin 변경을 %s에서 거절한다", async (action) => {
		/* [Given] */ const h = await harness();
		await writeFile(join(h.repo, "file.txt"), "인수 작업\n");
		await h.approve({ ...spec, endpoint: "pr", adoptChanges: { paths: ["file.txt"] } });
		if (action !== "check") await h.call("check");
		if (action === "deliver") {
			await h.call("dispatch", { role: "review", task: "검수" });
			await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		}
		git(h.repo, "remote", "set-url", "origin", join(h.root, "other.git"));
		/* [When] */ const result =
			action === "check" ? await h.call("check") : await h.call("dispatch", { role: action, task: "작업" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(/origin/);
		expect((await h.state()).review).toBeUndefined();
	});
	it("보류 상태의 사전 검사는 정본과 index를 쓰지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await h.approve();
		await h.command("pause");
		const state = await h.state();
		const stored = await readFile(storedPath(h));
		const index = await readFile(join(h.repo, ".git/index"));
		/* [When] */ const result = await h.call("preflight", { spec: { ...spec, endpoint: "commit" } });
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect(await h.state()).toEqual(state);
		expect(await readFile(storedPath(h))).toEqual(stored);
		expect(await readFile(join(h.repo, ".git/index"))).toEqual(index);
	});
	it("검수 중 원격 대상이 바뀌면 pass를 완료 증거로 받지 않는다", async () => {
		/* [Given] */ const h = await harness();
		await writeFile(join(h.repo, "file.txt"), "인수 작업\n");
		await h.approve({ ...spec, endpoint: "pr", adoptChanges: { paths: ["file.txt"] } });
		await h.call("check");
		await h.call("dispatch", { role: "review", task: "검수" });
		git(h.repo, "remote", "set-url", "origin", join(h.root, "other.git"));
		/* [When] */ await h.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		/* [Then] */ const state = await h.state();
		expect(state.control).toBe("blocked");
		expect(state.review).toBeUndefined();
		expect(state.attempts.at(-1).reviewInvalidated).toBe(true);
	});
});

async function replanHarness(delegated = true, ci = false) {
	const plan = stackPlan(2);
	const h = await stackHarness(2, true, {
		...(delegated ? { replanPolicy: { maxReplans: 2 } } : {}),
		units: plan.units.map((unit) => ({
			...unit,
			...(ci && unit.id === "part-2" ? { ciChecks: ["required-ci"] } : {}),
			allowedPaths: ["file.txt", "unit-0.txt", "unit-1.txt"],
		})),
	});
	await h.completeUnit();
	await h.prepare();
	return h;
}
function revisedPlan(state: any) {
	const plan = structuredClone(state.stack.plan);
	plan.units[state.stack.index].title = "미전달 단위 보완";
	plan.units[state.stack.index].checks.push(`printf checked-${plan.units[state.stack.index].checks.length}`);
	return plan;
}

describe("스택 suffix 재계획", () => {
	it("최초 위임 범위의 dirty 인수는 UI 없이 prefix를 보존하고 새 검수로 전체 완료한다", async () => {
		/* [Given] */ const h = await replanHarness();
		await h.call("dispatch", { role: "implement", agent: "old-builder", task: "작성 중 구현" });
		await writeFile(join(h.repo, "unit-1.txt"), "작성 중\n");
		await h.finish();
		await h.call("check");
		await h.review("code");
		const before = await h.state();
		const index = await readFile(join(h.repo, ".git/index"));
		/* [When] */ const result = await h.call("stack_replan", {
			plan: revisedPlan(before),
			reason: "현재 구현과 추가 검사 반영",
			adoptChanges: { paths: ["unit-1.txt"], allowedPaths: before.stack.plan.units[1].allowedPaths },
		});
		/* [Then] */ expect(result.isError).not.toBe(true);
		const after = await h.state();
		expect(h.prompts).toHaveLength(0);
		expect(after.stack.results).toEqual(before.stack.results);
		expect(after.stack.approval).toEqual(before.stack.approval);
		expect(after.stack.stage).toBe("unit");
		expect(after.owner.generation).toBe(before.owner.generation + 1);
		expect(after.planVersion).not.toBe(before.planVersion);
		expect(after.verification).toBeUndefined();
		expect(after.reviewResults).toBeUndefined();
		expect(after.stack.revisions[0]).toMatchObject({ via: "scope", index: 1, previousPlan: before.stack.plan });
		expect(after.stack.revisions[0].previousExecution.attempts).toEqual(before.attempts);
		expect(after.stack.revisions[0].previousExecution.verification).toEqual(before.verification);
		expect(await readFile(join(h.repo, ".git/index"))).toEqual(index);
		expect(git(h.repo, "rev-parse", "HEAD")).toBe(before.approval.head);
		expect((await h.call("dispatch", { role: "deliver", task: "이전 증거 전달" })).isError).toBe(true);
		await writeFile(join(h.repo, "unit-1.txt"), "보완 완료\n");
		expect((await h.call("check")).isError).not.toBe(true);
		expect(
			(await h.call("dispatch", { role: "review", agent: "old-builder", reviewKey: "code", task: "자기 검수" }))
				.isError,
		).toBe(true);
		await h.review("code");
		await h.review("design");
		await h.deliver();
		await h.call("check");
		expect(
			(
				await h.call("dispatch", {
					role: "review",
					agent: "old-builder",
					reviewKey: "integration",
					task: "통합 자기 검수",
				})
			).isError,
		).toBe(true);
		await h.fake.withGh(async () => {
			await h.review("integration");
			await expect.poll(async () => (await h.state()).phase).toBe("completed");
		});
		expect((await h.state()).stack.results[0]).toEqual(before.stack.results[0]);
	}, 60_000);
	it.each([
		"위임 없음",
		"목표 삭제",
		"검사 삭제",
		"검수 삭제",
		"CI 삭제",
		"범위 확대",
		"한도 확대",
		"요구 제외",
		"정책 추가",
	])("%s는 --auto여도 UI 없이 기존 증거를 바꾸지 않는다", async (change) => {
		/* [Given] */ const h = await replanHarness(!["위임 없음", "정책 추가"].includes(change), change === "CI 삭제");
		const before = await h.state();
		const plan = revisedPlan(before);
		const input: any = { plan, reason: change };
		if (change === "목표 삭제") plan.successCriteria = ["다른 목표"];
		if (change === "검사 삭제") plan.units[1].checks = ["printf checked"];
		if (change === "검수 삭제") plan.units[1].requiredReviews = ["code"];
		if (change === "CI 삭제") plan.units[1].ciChecks = [];
		if (change === "범위 확대") plan.units[1].allowedPaths.push("outside/");
		if (change === "한도 확대") plan.maxImprovementCycles++;
		if (change === "요구 제외") input.excludedRequirements = ["전체 설정 동작"];
		if (change === "정책 추가") plan.replanPolicy = { maxReplans: 5 };
		/* [When] */ const result = await h.call("stack_replan", input);
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).stack.revisions).toBeUndefined();
		expect((await h.state()).approval).toEqual(before.approval);
		expect((await h.state()).stack.planVersion).toBe(before.stack.planVersion);
	});
	it("재승인 보류는 계획과 검사 증거를 그대로 보존한다", async () => {
		/* [Given] */ const h = await replanHarness(false);
		await h.call("check");
		const before = await h.state();
		h.select("보류");
		/* [When] */ await h.call("stack_replan", { plan: revisedPlan(before), reason: "보완" });
		/* [Then] */ expect(await h.state()).toEqual(before);
		expect(h.prompts).toHaveLength(1);
	});
	it("사용자 승인된 요구 제외는 완료가 아닌 제외 이력으로 재시작 뒤에도 남는다", async () => {
		/* [Given] */ const h = await replanHarness(false);
		const before = await h.state();
		const plan = revisedPlan(before);
		plan.successCriteria = ["축소된 설정 동작"];
		h.select("승인");
		/* [When] */ const result = await h.call("stack_replan", {
			plan,
			reason: "일부 요구 제외",
			excludedRequirements: ["전체 설정 동작"],
		});
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect((await h.state()).stack.revisions[0]).toMatchObject({ via: "ui", excludedRequirements: ["전체 설정 동작"] });
		const next = await harness(true, h);
		await next.hook("session_start", {});
		expect((await next.state()).error).toBeUndefined();
		expect((await next.state()).stack.excludedRequirements).toEqual(["전체 설정 동작"]);
	});
	it.each(["누락", "범위 밖"])("dirty %s 인수는 자동으로 받아들이지 않는다", async (change) => {
		/* [Given] */ const h = await replanHarness();
		await writeFile(join(h.repo, "outside.txt"), "외부 변경\n");
		const before = await h.state();
		/* [When] */ const result = await h.call("stack_replan", {
			plan: revisedPlan(before),
			reason: "dirty",
			...(change === "범위 밖" ? { adoptChanges: { paths: ["outside.txt"] } } : {}),
		});
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
	});
	it("복구하지 않은 실패 구현은 재계획으로 지우지 않는다", async () => {
		/* [Given] */ const h = await replanHarness();
		await h.call("dispatch", { role: "implement", task: "실패 구현" });
		await h.finish(undefined, { status: "failed" });
		const before = await h.state();
		/* [When] */ const result = await h.call("stack_replan", { plan: revisedPlan(before), reason: "실패 지우기" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
	});
	it("재계획 예산을 소진해도 새 payload로 위임을 늘리지 못한다", async () => {
		/* [Given] */ const h = await replanHarness();
		for (let i = 0; i < 2; i++)
			expect((await h.call("stack_replan", { plan: revisedPlan(await h.state()), reason: "보완" })).isError).not.toBe(
				true,
			);
		const before = await h.state();
		/* [When] */ const result = await h.call("stack_replan", { plan: revisedPlan(before), reason: "예산 우회" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
	});
	it("전달된 prefix 변경은 UI 승인으로도 허용하지 않는다", async () => {
		/* [Given] */ const h = await replanHarness();
		const before = await h.state();
		const plan = revisedPlan(before);
		plan.units[0].title = "이미 전달된 변경 수정";
		h.select("승인");
		/* [When] */ const result = await h.call("stack_replan", { plan, reason: "prefix 변경" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
		expect(h.prompts).toHaveLength(0);
	});
	it.each(["파일", "index", "HEAD", "원격", "중단", "abort"])(
		"재승인 화면 중 %s 변경은 늦은 승인을 적용하지 않는다",
		async (change) => {
			/* [Given] */ const h = await replanHarness(false);
			const before = await h.state();
			let release: (value: string) => void = () => {};
			let shown: () => void = () => {};
			const visible = new Promise<void>((resolve) => {
				shown = resolve;
			});
			h.ctx.hasUI = true;
			h.ctx.ui.select = async () => {
				shown();
				return new Promise<string>((resolve) => {
					release = resolve;
				});
			};
			const abort = new AbortController();
			const pending = h.call("stack_replan", { plan: revisedPlan(before), reason: "UI 대기" }, abort.signal);
			const settled = Promise.allSettled([pending]);
			try {
				await visible;
				/* [When] */ if (change === "파일") await writeFile(join(h.repo, "file.txt"), "승인 중 변경\n");
				if (change === "index") {
					await writeFile(join(h.repo, "file.txt"), "index 변경\n");
					git(h.repo, "add", "file.txt");
				}
				if (change === "HEAD") git(h.repo, "commit", "--allow-empty", "-m", "승인 중 커밋");
				if (change === "원격") git(h.repo, "remote", "set-url", "origin", join(h.root, "missing.git"));
				if (change === "중단") await h.command("pause");
				if (change === "abort") abort.abort();
			} finally {
				release("승인");
				await settled;
			}
			/* [Then] */ expect((await pending).isError).toBe(true);
			expect((await h.state()).stack).toEqual(before.stack);
			expect((await h.state()).approval).toEqual(before.approval);
			if (["중단", "abort"].includes(change)) {
				expect((await h.state()).userHold).toBe(true);
				expect((await h.state()).control).toBe("paused");
			}
		},
	);
});

describe("스택 재계획 복구·범위 경계", () => {
	it.each(["인수 파일", "보완 범위"])("새 단위 범위 밖 %s는 기존 증거를 보존하고 거절한다", async (kind) => {
		/* [Given] */ const h = await replanHarness();
		await writeFile(join(h.repo, "unit-1.txt"), "인수할 내용\n");
		await h.call("check");
		const before = await h.state();
		const index = await readFile(join(h.repo, ".git/index"));
		const plan = revisedPlan(before);
		plan.units[1].allowedPaths = kind === "인수 파일" ? ["file.txt"] : ["unit-1.txt"];
		h.select("승인");
		/* [When] */ const result = await h.call("stack_replan", {
			plan,
			reason: "단위 범위를 좁혀 인수",
			adoptChanges: { paths: ["unit-1.txt"], allowedPaths: before.stack.plan.units[1].allowedPaths },
		});
		/* [Then] */ expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toMatch(/범위/);
		expect(await h.state()).toEqual(before);
		expect(await readFile(join(h.repo, ".git/index"))).toEqual(index);
		expect(await readFile(join(h.repo, "unit-1.txt"), "utf8")).toBe("인수할 내용\n");
		expect(h.prompts).toHaveLength(0);
	});
	it("이미 승인받은 변경 인수는 현재 실행과 전달된 prefix 모두 재시작으로 복원한다", async () => {
		/* [Given] */ const h = await replanHarness();
		await writeFile(join(h.repo, "unit-1.txt"), "인수할 내용\n");
		const before = await h.state();
		await h.call("stack_replan", {
			plan: revisedPlan(before),
			reason: "변경 인수",
			adoptChanges: { paths: ["unit-1.txt"], allowedPaths: before.stack.plan.units[1].allowedPaths },
		});
		const next = await harness(true, h);
		await next.hook("session_start", {});
		await h.fake.withGh(() => next.command("resume"));
		/* [When] */ const result = await next.call("check");
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect((await next.state()).approval.adoption.paths).toEqual(["unit-1.txt"]);
		for (const key of ["code", "design"]) {
			expect((await next.call("dispatch", { role: "review", reviewKey: key, task: "독립 검수" })).isError).not.toBe(
				true,
			);
			await next.finish(undefined, { finalOutput: "WORKFLOW_VERDICT: pass" });
		}
		/* 전달 worker 경계는 같은 실제 임시 Git에서 수행한다. */
		await next.call("dispatch", { role: "deliver", task: "전달" });
		const reviewed = await next.state();
		git(h.repo, "add", "-A");
		git(h.repo, "commit", "-m", "인수 결과 전달");
		git(h.repo, "push", "origin", reviewed.approval.branch);
		const data = join(h.root, "stack-prs.json");
		const prs = JSON.parse(await readFile(data, "utf8"));
		prs[reviewed.approval.branch] = [
			{
				url: "https://example.invalid/pr/2",
				isDraft: true,
				baseRefName: reviewed.spec.prBase,
				baseRefOid: reviewed.approval.head,
				headRefName: reviewed.approval.branch,
				headRefOid: git(h.repo, "rev-parse", "HEAD"),
			},
		];
		await writeFile(data, JSON.stringify(prs));
		await h.fake.withGh(() => next.finish());
		const restored = await harness(true, h);
		await restored.hook("session_start", {});
		expect((await restored.state()).error).toBeUndefined();
		expect((await restored.state()).stack.results[1].execution.approval.adoption.paths).toEqual(["unit-1.txt"]);
	}, 60_000);
	it("재계획 후 허용 범위 밖 파일은 검사와 전달에 포함하지 않는다", async () => {
		/* [Given] */ const h = await replanHarness();
		await writeFile(join(h.repo, "unit-1.txt"), "인수\n");
		const before = await h.state();
		await h.call("stack_replan", {
			plan: revisedPlan(before),
			reason: "인수",
			adoptChanges: { paths: ["unit-1.txt"] },
		});
		await writeFile(join(h.repo, "outside.txt"), "승인 외\n");
		/* [When] */ const result = await h.call("check");
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).verification).toBeUndefined();
		expect((await h.call("dispatch", { role: "deliver", task: "범위 외 전달" })).isError).toBe(true);
	});
	it("기존 단위 허용 범위가 없으면 dirty 인수에 실제 UI 승인이 필요하다", async () => {
		/* [Given] */ const h = await stackHarness(1, true, { replanPolicy: { maxReplans: 2 } });
		await h.prepare();
		await writeFile(join(h.repo, "file.txt"), "작성 중\n");
		const before = await h.state();
		/* [When] */ const result = await h.call("stack_replan", {
			plan: revisedPlan(before),
			reason: "범위 없는 변경",
			adoptChanges: { paths: ["file.txt"] },
		});
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
	});
	it("prepare 전 재계획도 고정 부모를 유지하고 실제 관리 prepare를 요구한다", async () => {
		/* [Given] */ const h = await stackHarness(2, true, { replanPolicy: { maxReplans: 2 } });
		await h.completeUnit();
		const before = await h.state();
		/* [When] */ const result = await h.call("stack_replan", {
			plan: revisedPlan(before),
			reason: "다음 단위 준비 전 보완",
		});
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect((await h.state()).stack.stage).toBe("preparing");
		expect(git(h.repo, "branch", "--show-current")).toBe(before.stack.results[0].branch);
		expect((await h.state()).approval.head).toBe(before.stack.results[0].head);
		expect((await h.call("dispatch", { role: "implement", task: "prepare 생략" })).isError).toBe(true);
		await h.prepare();
		expect((await h.state()).stack.stage).toBe("unit");
	});
	it("관리 prepare 기록 없는 외부 동명 브랜치는 재계획으로 수용하지 않는다", async () => {
		/* [Given] */ const h = await stackHarness(1, true, { replanPolicy: { maxReplans: 2 } });
		const before = await h.state();
		git(h.repo, "switch", "-c", before.stack.plan.units[0].branch, before.stack.approval.rootHead);
		/* [When] */ const result = await h.call("stack_replan", { plan: revisedPlan(before), reason: "브랜치 재사용" });
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
	});
	it("복구한 실패와 개선 횟수는 새 실행 세대로 넘어가도 유지한다", async () => {
		/* [Given] */ const h = await replanHarness();
		await h.call("dispatch", { role: "implement", agent: "failed-builder", task: "실패 구현" });
		await h.finish(undefined, { status: "failed" });
		await h.call("recover", {
			attemptId: (await h.state()).attempts.at(-1).id,
			assessment: "partial",
			notes: "실제 파일 확인",
		});
		await h.call("check");
		await h.review("code", "changes-requested");
		const before = await h.state();
		/* [When] */ const result = await h.call("stack_replan", { plan: revisedPlan(before), reason: "복구 후 보완" });
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect((await h.state()).improvementCycles).toBe(1);
		expect((await h.state()).recoveries).toBe(1);
		expect((await h.state()).stack.revisions[0].previousExecution.attempts).toEqual(before.attempts);
		await h.call("check");
		expect(
			(
				await h.call("dispatch", {
					role: "review",
					reviewKey: "code",
					agent: "failed-builder",
					task: "과거 실패 자기 검수",
				})
			).isError,
		).toBe(true);
	});
	it.each(["worker", "inspect", "hold", "integration", "budget"])(
		"%s 경계는 재계획으로 초기화하지 않는다",
		async (boundary) => {
			/* [Given] */ const h = await replanHarness();
			if (boundary === "worker") await h.call("dispatch", { role: "implement", task: "실행 중" });
			if (boundary === "inspect")
				h.events.on("subagent:managed:v1:request", (raw: any) => {
					if (raw.type === "inspect") raw.respond({ ok: true, runs: [{ status: "running", abortPending: true }] });
				});
			if (boundary === "hold") await h.command("pause");
			if (boundary === "integration") {
				await writeFile(join(h.repo, "unit-1.txt"), "최종 구현\n");
				await h.call("check");
				await h.review("code");
				await h.review("design");
				await h.deliver();
			}
			if (boundary === "budget") {
				for (let i = 0; i < 3; i++) {
					await h.call("check");
					await h.review("code", "changes-requested");
				}
			}
			const before = await h.state();
			const plan = boundary === "integration" ? before.stack.plan : revisedPlan(before);
			/* [When] */ const result = await h.call("stack_replan", { plan, reason: "실행 제약 우회" });
			/* [Then] */ expect(result.isError).toBe(true);
			expect(await h.state()).toEqual(before);
		},
	);
	it("원격 부모가 변경돼도 실패한 후보는 기존 계획과 결과를 수정하지 않는다", async () => {
		/* [Given] */ const h = await replanHarness();
		const before = await h.state();
		const root = before.stack.results[0];
		const replacement = git(h.repo, "commit-tree", `${root.head}^{tree}`, "-p", root.head, "-m", "외부 부모 변경");
		git(h.repo, "push", "origin", `${replacement}:refs/heads/${root.branch}`);
		/* [When] */ const result = await h.call("stack_replan", {
			plan: revisedPlan(before),
			reason: "부모 변경 후 계속",
		});
		/* [Then] */ expect(result.isError).toBe(true);
		expect(await h.state()).toEqual(before);
	});
	it("재승인으로 suffix PR을 추가할 수 있지만 최초 위임의 범위를 사후 확장하지 않는다", async () => {
		/* [Given] */ const h = await replanHarness();
		const before = await h.state();
		const plan = revisedPlan(before);
		plan.units.push({ ...plan.units[1], id: "part-3", branch: "feature/stack-3" });
		h.select("승인");
		/* [When] */ const result = await h.call("stack_replan", { plan, reason: "추가 PR 권한" });
		/* [Then] */ expect(result.isError).not.toBe(true);
		expect((await h.state()).stack.revisions[0].via).toBe("ui");
		expect((await h.state()).stack.approval.initialPlan).toEqual(before.stack.plan);
		h.ctx.hasUI = false;
		expect(
			(await h.call("stack_replan", { plan: revisedPlan(await h.state()), reason: "사후 위임 우회" })).isError,
		).toBe(true);
	});
	it.each([0, 6, 1.5])("재계획 한도 %s는 최초 승인하지 않는다", async (maxReplans) => {
		/* [Given] */ const h = await harness();
		await h.command("start --stack --auto 계획");
		/* [When] */ const result = await h.call("stack_propose", { ...stackPlan(), replanPolicy: { maxReplans } });
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).stack).toBeUndefined();
	});
	it.each(["src/../", "/absolute", "src/*", "src//"])("허용 경로 %s는 최초 스택 승인하지 않는다", async (path) => {
		/* [Given] */ const h = await harness();
		await h.command("start --stack --auto 계획");
		const plan = stackPlan(1);
		/* [When] */ const result = await h.call("stack_propose", {
			...plan,
			units: [{ ...plan.units[0], allowedPaths: [path] }],
		});
		/* [Then] */ expect(result.isError).toBe(true);
		expect((await h.state()).stack).toBeUndefined();
	});
});

it("명시하지 않은 성공 조건 삭제는 UI 승인이 있어도 제외 이력 없이 적용하지 않는다", async () => {
	/* [Given] */ const h = await replanHarness();
	const before = await h.state();
	const plan = revisedPlan(before);
	plan.successCriteria = ["일부 성공만 검증"];
	h.select("승인");
	/* [When] */ const result = await h.call("stack_replan", { plan, reason: "제외 목록 없이 축소" });
	/* [Then] */ expect(result.isError).toBe(true);
	expect(await h.state()).toEqual(before);
	expect(h.prompts).toHaveLength(0);
});

it("clean 재계획 이후에도 단위 허용 경로 밖 파일을 검사에 포함하지 않는다", async () => {
	/* [Given] */ const h = await replanHarness();
	const before = await h.state();
	await h.call("stack_replan", { plan: revisedPlan(before), reason: "clean 보완 계획" });
	await writeFile(join(h.repo, "outside.txt"), "범위 외 구현\n");
	/* [When] */ const result = await h.call("check");
	/* [Then] */ expect(result.isError).toBe(true);
	expect((await h.state()).spec.adoptChanges).toBeUndefined();
	expect((await h.state()).verification).toBeUndefined();
});

describe("승인 명령의 자동 실행", () => {
	it.each([
		["single", false],
		["single", true],
		["stack", false],
		["stack", true],
	] as const)("%s 명령 승인 뒤 SDK가 후속 턴을 실행한다 (busy=%s)", async (mode, busy) => {
		/* [Given] */
		const h = mode === "stack" ? await stackHarness(1, false) : await harness();
		if (mode === "single") await h.start();
		const agentDir = join(h.root, "sdk-agent");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: h.repo,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const faux = fauxProvider();
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only");
		const { session } = await createAgentSession({
			cwd: h.repo,
			agentDir,
			settingsManager,
			resourceLoader,
			modelRuntime,
			model: faux.getModel(),
			sessionManager: SessionManager.inMemory(h.repo),
			tools: [],
		});
		h.ctx.isIdle = () => session.isIdle;
		h.ctx.waitForIdle = () => session.waitForIdle();
		Object.defineProperty(h.ctx, "signal", { get: () => session.agent.signal });
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		if (busy)
			faux.appendResponses([
				async () => {
					enter();
					await released;
					return fauxAssistantMessage("진행 중인 응답 완료");
				},
			]);
		faux.appendResponses([fauxAssistantMessage("승인된 작업 실행 시작")]);
		const pending: Promise<void>[] = [];
		const approvals: any[] = [];
		h.forwardUserMessages((message, options) => {
			approvals.push(JSON.parse(readFileSync(storedPath(h), "utf8")));
			const sending = session.sendUserMessage(message, options);
			pending.push(sending);
			void sending.catch(() => {});
		});
		const active = busy ? session.prompt("진행 중인 별도 요청") : Promise.resolve();
		void active.catch(() => {});
		try {
			if (busy) await entered;
			/* [When] */ await h.command("approve");
			/* [Then] */
			await expect.poll(() => (busy ? session.getFollowUpMessages().length : faux.state.callCount)).toBe(1);
			expect(approvals).toHaveLength(1);
			expect(approvals[0].phase).toBe("executing");
			expect(approvals[0].approval.via).toBe("command");
			if (mode === "stack") expect(approvals[0].stack.stage).toBe("preparing");
			release();
			await Promise.all([active, ...pending]);
			await session.waitForIdle();
			expect(faux.state.callCount).toBe(busy ? 2 : 1);
			expect(session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "승인된 작업 실행 시작" }],
			});
			expect(session.getFollowUpMessages()).toHaveLength(0);
		} finally {
			release();
			await Promise.allSettled([active, ...pending]);
			await session.abort();
			session.dispose();
		}
	});
	it.each(["single", "stack"] as const)("%s의 중복 승인 명령은 턴을 추가하지 않는다", async (mode) => {
		/* [Given] */ const h = mode === "stack" ? await stackHarness(1, false) : await harness();
		if (mode === "single") await h.start();
		const before = h.userMessages.length;
		/* [When] */ await Promise.all([h.command("approve"), h.command("approve")]);
		/* [Then] */ expect(h.userMessages).toHaveLength(before + 1);
	});
	it.each(["single", "stack"] as const)("%s의 중단·보류·실패 승인은 턴을 시작하지 않는다", async (mode) => {
		/* [Given] */ const h = mode === "stack" ? await stackHarness(1, false) : await harness();
		if (mode === "single") await h.start({ ...spec, endpoint: "commit" });
		const before = h.userMessages.length;
		await writeFile(join(h.repo, "file.txt"), "승인 불가능한 변경\n");
		/* [When] */
		await h.command("approve");
		await h.command("pause");
		await h.command("approve");
		await h.command("resume");
		const resumed = h.userMessages.length;
		await h.call("block", { reason: "사용자 판단 대기" });
		await h.command("approve");
		await h.command("cancel");
		await h.command("approve");
		/* [Then] */
		expect(resumed).toBe(before + 1);
		expect(h.userMessages).toHaveLength(resumed);
		expect((await h.state()).approval).toBeUndefined();
	});
	it.each(["single", "stack"] as const)("%s의 승인 저장 실패는 턴을 시작하지 않는다", async (mode) => {
		/* [Given] */ const h = mode === "stack" ? await stackHarness(1, false) : await harness();
		if (mode === "single") await h.start();
		const before = h.userMessages.length;
		const path = storedPath(h);
		await rm(path);
		await mkdir(path);
		/* [When] */ await h.command("approve");
		/* [Then] */ expect(h.userMessages).toHaveLength(before);
		expect((await h.state()).error).toMatch(/저장 오류/);
	});
	it.each(["single", "stack"] as const)("%s의 자동 승인은 현재 턴에 중복 요청을 넣지 않는다", async (mode) => {
		/* [Given] */ const h = await harness();
		if (mode === "stack") await fakeRemote(h);
		await h.command(`start ${mode === "stack" ? "--stack " : ""}--auto 목표`);
		const before = h.userMessages.length;
		/* [When] */ await h.call(mode === "stack" ? "stack_propose" : "propose", mode === "stack" ? stackPlan(1) : spec);
		/* [Then] */ expect((await h.state()).approval.via).toBe("auto");
		expect(h.userMessages).toHaveLength(before);
	});
});

describe("승인 중 사용자 중단", () => {
	it.each(["pause", "cancel", "block"] as const)("스택 승인 검사 중 %s는 후속 실행보다 우선한다", async (action) => {
		/* [Given] */ const h = await stackHarness(1, false);
		const bin = join(h.root, "bin");
		const entered = join(h.root, "approval-entered");
		const release = join(h.root, "approval-release");
		const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
		await writeFile(
			join(bin, "git"),
			`#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
(async () => {
  if (process.argv[2] === 'ls-remote') {
    fs.writeFileSync(${JSON.stringify(entered)}, 'entered');
    while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 5));
  }
  const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });
  process.exit(result.status ?? 1);
})();
`,
		);
		await chmod(join(bin, "git"), 0o755);
		const before = h.userMessages.length;
		const path = process.env.PATH;
		process.env.PATH = `${bin}:${path}`;
		let enteredApproval!: () => void;
		const waiting = new Promise<void>((resolve) => {
			enteredApproval = resolve;
		});
		const watcher = watch(h.root, (_event, file) => {
			if (file === "approval-entered") enteredApproval();
		});
		const approval = h.command("approve");
		try {
			await waiting;
			/* [When] */
			if (action === "block") await h.call("block", { reason: "사용자 판단 대기" });
			else await h.command(action);
		} finally {
			watcher.close();
			await writeFile(release, "release");
			await approval;
			process.env.PATH = path;
		}
		/* [Then] */ expect(h.userMessages).toHaveLength(before);
		expect((await h.state()).control).toBe(
			action === "pause" ? "paused" : action === "cancel" ? "cancelled" : "blocked",
		);
		expect((await h.state()).stack.approval).toBeUndefined();
	});
	it.each([
		["single", "승인"],
		["single", "보류"],
		["stack", "승인"],
		["stack", "보류"],
	] as const)("%s의 UI %s는 현재 턴에 후속 실행을 중복 예약하지 않는다", async (mode, choice) => {
		/* [Given] */ const h = mode === "stack" ? await stackHarness(1, false) : await harness();
		if (mode === "single") await h.command("start 목표");
		h.select(choice);
		const before = h.userMessages.length;
		/* [When] */ await h.call(mode === "stack" ? "stack_propose" : "propose", mode === "stack" ? stackPlan(1) : spec);
		/* [Then] */ expect(h.userMessages).toHaveLength(before);
		expect((await h.state()).approval?.via).toBe(choice === "승인" ? "ui" : undefined);
	});
});

async function compactingSDK(h: Awaited<ReturnType<typeof harness>>, outcome: "success" | "failure" | "abort") {
	const agentDir = join(h.root, "compacting-sdk");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false, keepRecentTokens: 1 },
		retry: { enabled: false },
	});
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: h.repo,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.registerCommand("workflow-approve-fixture", {
					description: "실제 압축 중 workflow 승인",
					handler: async () => h.command("approve"),
				});
				pi.on("session_before_compact", async (event) => {
					enter();
					await released;
					if (outcome === "failure") return;
					return {
						compaction: {
							summary: "이전 대화 압축",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	await resourceLoader.reload();
	const faux = fauxProvider();
	if (outcome === "failure")
		faux.appendResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "압축 실패 fixture" })]);
	faux.appendResponses([fauxAssistantMessage("압축 종료 후 승인된 작업 실행")]);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.setRuntimeApiKey(faux.provider.id, "test-only");
	const sessionManager = SessionManager.inMemory(h.repo);
	sessionManager.appendMessage({ role: "user", content: "압축할 이전 요청", timestamp: Date.now() });
	sessionManager.appendMessage(fauxAssistantMessage("압축할 이전 응답"));
	sessionManager.appendMessage({ role: "user", content: "보존할 최근 요청", timestamp: Date.now() });
	sessionManager.appendMessage(fauxAssistantMessage("보존할 최근 응답"));
	const { session } = await createAgentSession({
		cwd: h.repo,
		agentDir,
		settingsManager,
		resourceLoader,
		modelRuntime,
		model: faux.getModel(),
		sessionManager,
		tools: [],
	});
	h.ctx.isIdle = () => session.isIdle;
	h.ctx.waitForIdle = () => session.waitForIdle();
	Object.defineProperty(h.ctx, "signal", { get: () => session.agent.signal });
	const sending: Promise<void>[] = [];
	h.forwardUserMessages((message, options) => {
		const job = session.sendUserMessage(message, options);
		sending.push(job);
		void job.catch(() => {});
	});
	const compacting = session.compact();
	const settledCompaction = Promise.allSettled([compacting]);
	await entered;
	const finish = async () => {
		if (outcome === "abort") session.abortCompaction();
		release();
		return (await settledCompaction)[0];
	};
	const cleanup = async () => {
		release();
		await settledCompaction;
		await Promise.allSettled(sending);
		await session.abort();
		session.dispose();
	};
	return { session, faux, sending, finish, cleanup };
}

describe("압축 중 승인 실행 요청 보존", () => {
	it.each([
		["single", "success"],
		["single", "failure"],
		["single", "abort"],
		["stack", "success"],
		["stack", "failure"],
		["stack", "abort"],
	] as const)("%s 승인은 압축 %s 종료 후 한 번 실행한다", async (mode, outcome) => {
		/* [Given] */ const h = mode === "stack" ? await stackHarness(1, false) : await harness();
		if (mode === "single") await h.start();
		const sdk = await compactingSDK(h, outcome);
		const before = h.userMessages.length;
		try {
			/* [When] */ await sdk.session.prompt("/workflow-approve-fixture");
			/* [Then] */
			expect((await h.state()).approval.via).toBe("command");
			expect(h.userMessages).toHaveLength(before);
			expect(sdk.sending).toHaveLength(0);
			const compacted = await sdk.finish();
			expect(compacted.status).toBe(outcome === "success" ? "fulfilled" : "rejected");
			await expect.poll(() => sdk.faux.state.callCount).toBe(outcome === "failure" ? 2 : 1);
			await Promise.all(sdk.sending);
			await sdk.session.waitForIdle();
			expect(h.userMessages).toHaveLength(before + 1);
			expect(sdk.session.messages.at(-1)).toMatchObject({
				role: "assistant",
				content: [{ type: "text", text: "압축 종료 후 승인된 작업 실행" }],
			});
		} finally {
			await sdk.cleanup();
		}
	});
	it.each([
		["single", "pause"],
		["single", "cancel"],
		["single", "hold"],
		["single", "shutdown"],
		["single", "switch"],
		["stack", "pause"],
		["stack", "cancel"],
		["stack", "hold"],
		["stack", "shutdown"],
		["stack", "switch"],
	] as const)("%s 승인 대기 중 %s는 압축 후 실행을 막는다", async (mode, action) => {
		/* [Given] */ const h = mode === "stack" ? await stackHarness(1, false) : await harness();
		if (mode === "single") await h.start();
		const sdk = await compactingSDK(h, "success");
		const before = h.userMessages.length;
		await sdk.session.prompt("/workflow-approve-fixture");
		try {
			/* [When] */
			if (action === "pause" || action === "cancel") await h.command(action);
			else if (action === "hold") await h.call("block", { reason: "사용자 판단 대기" });
			else if (action === "shutdown") await h.hook("session_shutdown", { type: "session_shutdown" });
			else await h.hook("session_start", { type: "session_start", reason: "switch" });
			/* [Then] */
			await sdk.finish();
			await h.state();
			expect(h.userMessages).toHaveLength(before);
			expect(sdk.sending).toHaveLength(0);
			expect(sdk.faux.state.callCount).toBe(0);
		} finally {
			await sdk.cleanup();
		}
	});
});
