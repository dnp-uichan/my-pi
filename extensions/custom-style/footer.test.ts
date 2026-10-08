import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderAlignedLine } from "./footer.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

const left = "chazm-front-service";
const right = "thinking 한국어  ● 🐴 ponytail: ⚡ FULL   MCP 3/3   [■■□□□□□□□□]   16%";

describe("custom footer width", () => {
	it("상태가 가득 찬 73칸 터미널에서도 폭을 넘지 않는다", () => {
		/* Given */
		expect(visibleWidth(right)).toBe(70);

		/* When */
		const line = renderAlignedLine(theme, 73, left, right);

		/* Then */
		expect(visibleWidth(line)).toBeLessThanOrEqual(73);
	});

	it("매우 좁은 터미널에서도 모든 줄이 주어진 폭 안에 머문다", () => {
		/* Given */
		const widths = Array.from({ length: 74 }, (_, index) => index);

		/* When */
		const renderedWidths = widths.map((width) => visibleWidth(renderAlignedLine(theme, width, left, right)));

		/* Then */
		for (const [index, renderedWidth] of renderedWidths.entries()) {
			expect(renderedWidth).toBeLessThanOrEqual(widths[index]);
		}
	});
});
