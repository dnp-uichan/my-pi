import { createServer } from "node:http";
import { type Model, normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertMessages, streamOllamaNative } from "./ollama-utils.js";

const tool = { name: "search", description: "Search", parameters: { type: "object", properties: {} } };

const model: Model<"ollama-native-chat"> = {
	id: "test-model",
	name: "Test model",
	api: "ollama-native-chat",
	provider: "ollama-kimi-cloud",
	baseUrl: "http://127.0.0.1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1024,
	maxTokens: 128,
};

describe("Ollama의 Pi 1.0 메시지 호환", () => {
	it("기존 systemPrompt와 사용자 메시지를 그대로 전달한다", () => {
		/* Given */
		const context = {
			systemPrompt: "기본 지침",
			messages: [{ role: "user" as const, content: "안녕", timestamp: 1 }],
		};
		/* When */
		const messages = convertMessages(context);
		/* Then */
		expect(messages).toEqual([
			{ role: "system", content: "기본 지침" },
			{ role: "user", content: "안녕", images: undefined },
		]);
	});

	it("정규화된 시스템 지침과 갱신된 섹션을 도구 결과로 오인하지 않는다", () => {
		/* Given */
		const context = normalizeContext({
			messages: [
				{ role: "system", content: "기본 지침", sections: { rules: "이전 규칙" }, timestamp: 0 },
				{ role: "user", content: "요청", timestamp: 1 },
				{ role: "system", content: "추가 지침", sections: { rules: "새 규칙" }, timestamp: 2 },
			],
		});
		/* When */
		const messages = convertMessages(context);
		/* Then */
		expect(messages).toHaveLength(2);
		expect(messages[0]).toEqual({ role: "system", content: "기본 지침\n\n추가 지침\n\n새 규칙" });
		expect(messages[1]).toEqual({ role: "user", content: "요청", images: undefined });
	});

	it("실제 HTTP 요청에 현재 유효한 도구 선언과 시스템 지침을 보낸다", async () => {
		/* Given: 외부 모델 대신 로컬 HTTP 서버로 전송 경계만 관찰한다. */
		const received: unknown[] = [];
		const server = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			received.push(JSON.parse(Buffer.concat(chunks).toString()));
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ message: { content: "응답" }, done_reason: "stop" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing local server address");
		const context = normalizeContext({
			systemPrompt: "기본 지침",
			tools: [{ ...tool, name: "retired" }],
			messages: [
				{ role: "system", content: "", toolsRemoved: [{ name: "retired" }], toolsAdded: [tool], timestamp: 1 },
				{ role: "user", content: "검색해줘", timestamp: 2 },
			],
		});
		try {
			/* When */
			const result = await streamOllamaNative(`http://127.0.0.1:${address.port}/api/chat`, model, context).result();
			/* Then */
			expect(result.stopReason).toBe("stop");
			expect(received).toEqual([
				expect.objectContaining({
					messages: [
						{ role: "system", content: "기본 지침" },
						{ role: "user", content: "검색해줘" },
					],
					tools: [{ type: "function", function: tool }],
				}),
			]);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
