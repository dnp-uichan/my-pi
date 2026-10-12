import { stackPlanSchema } from "./stack-model.ts";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionToolContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { WorkflowController } from "./controller.ts";
import { specSchema, type Options } from "./model.ts";

export function createWorkflowController(options: Options) {
	return (pi: ExtensionAPI): void => {
		const controller = new WorkflowController(pi, {
			...options,
		});
		function tool<T extends TSchema>(
			name: string,
			description: string,
			parameters: T,
			action: (
				params: Parameters<ToolDefinition<T>["execute"]>[1],
				ctx: ExtensionToolContext,
				signal?: AbortSignal,
			) => Promise<unknown>,
			serial = true,
		): void {
			pi.registerTool({
				name: `workflow_${name}`,
				label: `Workflow ${name}`,
				description,
				parameters,
				defaultActive: ["status", "start"].includes(name),
				executionMode: "sequential",
				execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
					try {
						if (!Value.Check(parameters, params)) throw new Error("잘못된 workflow 도구 입력입니다.");
						const details = await (serial
							? controller.serial(() => action(params, ctx, signal))
							: action(params, ctx, signal));
						return {
							content: [{ type: "text", text: JSON.stringify(details ?? controller.status(), null, 2) }],
							details: details ?? controller.status(),
						};
					} catch (error) {
						return {
							isError: true,
							content: [{ type: "text", text: String(error) }],
							details: { error: String(error) },
						};
					}
				},
			});
		}
		tool(
			"start",
			"목표의 workflow 초안을 시작한다. 구현·전달은 이후 사용자 계획 승인이 필요하며 자동 승인 권한을 만들거나 상속하지 않는다.",
			Type.Object(
				{
					goal: Type.String({ minLength: 1, pattern: "\\S" }),
					mode: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("stack")])),
				},
				{ additionalProperties: false },
			),
			async (params, ctx) => controller.startFromTool(params, ctx),
			false,
		);
		for (const name of ["pause", "cancel"] as const)
			tool(
				name,
				`Orchestrator 소유 작업을 ${name === "pause" ? "일시정지" : "취소"}한다. 사용자 보류를 변경하거나 성공 완료로 처리하지 않는다.`,
				Type.Object({ reason: Type.String({ minLength: 1, pattern: "\\S" }) }, { additionalProperties: false }),
				async (params, ctx) => controller.stopFromTool(name === "pause" ? "paused" : "cancelled", params.reason, ctx),
				false,
			);
		tool(
			"resume",
			"Orchestrator 또는 시스템 중단을 명시적으로 복구한다. 사용자 중단·판단 요청은 사용자만 해제할 수 있다.",
			Type.Object({}, { additionalProperties: false }),
			async (_params, ctx, signal) => controller.resumeFromTool(ctx, signal),
			false,
		);
		tool("status", "워크플로 정본 상태·증거를 조회한다.", Type.Object({}), async () => controller.status());
		tool(
			"propose",
			"계획과 검사·종료 지점을 제안한다. 승인은 사용자 명령·실제 UI 선택, 또는 사용자가 /workflow start --auto로 시작한 경우의 자동 승인만 허용한다.",
			specSchema,
			async (params) => controller.propose(params),
		);
		tool(
			"stack_propose",
			"명시적 --stack 모드의 전체 PR 계획·검수·CI를 제안한다. 승인 전 쓰기 금지.",
			stackPlanSchema,
			async (params) => controller.proposeStack(params),
			false,
		);
		tool(
			"dispatch",
			"승인된 범위의 구현·독립 검수·읽기 전용 조사, 검수 통과 뒤 commit·pr 스킬 기반 전달을 관리형 subagent로 실행한다.",
			Type.Object({
				role: Type.Union([
					Type.Literal("implement"),
					Type.Literal("review"),
					Type.Literal("research"),
					Type.Literal("deliver"),
					Type.Literal("prepare"),
				]),
				task: Type.String({ minLength: 1 }),
				reviewKey: Type.Optional(
					Type.String({ minLength: 1, description: "계획의 필수 검수 이름. 복수 검수이면 반드시 지정한다." }),
				),
				agent: Type.Optional(Type.String()),
				contextMode: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("isolated")])),
				thinking: Type.Optional(
					Type.String({
						description:
							"worker effort(low·medium·high·xhigh). 작업 난이도로 판단한다. 단순 수정 low, 일반 구현 medium·high, 설계가 얽힌 변경 xhigh. 생략하면 agent 기본값.",
					}),
				),
			}),
			async (params, ctx) => controller.dispatch(params, ctx),
			false,
		);
		tool(
			"check",
			"승인된 검사 명령을 순서대로 실행하고 작업 트리 지문을 검증한다.",
			Type.Object({}),
			async (_params, _ctx, signal) => controller.check(signal),
			false,
		);
		tool(
			"recover",
			"실패·중단 구현의 실제 HEAD·지문·작업 상태를 확인해 복구 기록을 남긴다.",
			Type.Object({
				attemptId: Type.String(),
				assessment: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("unknown")]),
				notes: Type.String({ minLength: 1 }),
			}),
			async (params) => controller.recover(params),
		);
		tool(
			"block",
			"사용자 판단이 필요한 이유를 기록하고 차단한다.",
			Type.Object({ reason: Type.String({ minLength: 1 }) }),
			async (params) => controller.block(params.reason),
		);
		pi.registerCommand("workflow", {
			description: "관리형 워크플로 start [--stack] [--auto]/status/approve/pause/resume/cancel",
			handler: (args, ctx) => controller.command(args, ctx),
		});
		pi.on("session_start", (_event, ctx) => controller.sessionStart(ctx));
		pi.on("session_shutdown", () => controller.shutdown());
		pi.on("agent_before_settle", (event) => controller.beforeSettle(event));
		pi.on("agent_settled", (event) => controller.settled(event as { aborted?: boolean }));
		pi.on("tool_call", (event) => controller.toolGuard(event.toolName, event.input));
	};
}

export default createWorkflowController({ agentDir: getAgentDir() });
