import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { centerOverlayText, fitOverlayRowContent } from "./render-utils.js";

it("새 TUI SDK에서도 한글·이모지 오버레이 행이 지정된 폭을 지킨다", () => {
	/* Given */
	const content = "한글 🙂 terminal";
	for (let width = 0; width <= 30; width++) {
		/* When */
		const rows = [fitOverlayRowContent(content, width), centerOverlayText(content, width)];
		/* Then */
		for (const row of rows) expect(visibleWidth(row)).toBe(width);
	}
});
