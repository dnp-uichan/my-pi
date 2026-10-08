import { expect, it } from "vitest";
import { PtyTerminalSession } from "./pty-session.js";

it("독립 설치의 실제 PTY에서 출력과 정상 종료를 수신한다", async () => {
	/* Given: 외부 모델 호출 없이 로컬 PTY와 터미널 의존성을 확인한다. */
	const command = "printf 'PI_PTY_READY\\n'; exit 0";

	/* When */
	await new Promise<void>((resolve, reject) => {
		const session = new PtyTerminalSession(
			{ command, shell: "/bin/sh", cols: 40, rows: 8 },
			{
				onExit: (code) => {
					clearTimeout(timeout);
					try {
						/* Then */
						expect(code).toBe(0);
						expect(session.getRawStream()).toContain("PI_PTY_READY");
						expect(session.getViewportLines().join("\n")).toContain("PI_PTY_READY");
						resolve();
					} catch (error) {
						reject(error);
					} finally {
						session.dispose();
					}
				},
			},
		);
		const timeout = setTimeout(() => {
			session.kill("SIGKILL");
			reject(new Error("PTY did not exit within 3 seconds"));
		}, 3000);
	});
});
