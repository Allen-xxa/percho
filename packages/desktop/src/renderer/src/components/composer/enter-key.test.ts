import { DEFAULT_SHORTCUT_BINDINGS, type KeyChord } from "@percho/shared";
import { describe, expect, it } from "vitest";
import { resolveComposerKey } from "./enter-key";

const event = (key: string, mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", true>> = {}) => ({
	key,
	ctrlKey: mods.ctrl === true,
	altKey: mods.alt === true,
	shiftKey: mods.shift === true,
	metaKey: mods.meta === true,
});

const SEND = DEFAULT_SHORTCUT_BINDINGS["composer.send"];
const SHIFT_ENTER = DEFAULT_SHORTCUT_BINDINGS["composer.newline"];
const ENTER: KeyChord = { key: "enter" };
const CTRL_ENTER: KeyChord = { key: "enter", ctrl: true };
const CTRL_ALT_K: KeyChord = { key: "k", ctrl: true, alt: true };

describe("resolveComposerKey（三岔：换行 / 发送 / 不管）", () => {
	it("出厂默认：裸 Enter 发送，Shift+Enter 换行", () => {
		expect(resolveComposerKey(event("Enter"), SEND, SHIFT_ENTER)).toBe("send");
		expect(resolveComposerKey(event("Enter", { shift: true }), SEND, SHIFT_ENTER)).toBe("newline");
	});

	it("没被占用的 Enter 一律换行、绝不发送（曾经 Alt/Ctrl+Enter 也在发消息）", () => {
		for (const mods of [
			{ ctrl: true },
			{ alt: true },
			{ meta: true },
			{ ctrl: true, shift: true },
			{ ctrl: true, alt: true, meta: true },
		] as const) {
			expect(resolveComposerKey(event("Enter", mods), SEND, SHIFT_ENTER)).toBe("newline");
		}
	});

	it("改成 Ctrl+Enter 发送 / Enter 换行（有人就喜欢这个习惯）", () => {
		expect(resolveComposerKey(event("Enter", { ctrl: true }), CTRL_ENTER, ENTER)).toBe("send");
		expect(resolveComposerKey(event("Enter"), CTRL_ENTER, ENTER)).toBe("newline");
		// 换行键位仍是 Enter 时，别的修饰键 Enter 也还是换行
		expect(resolveComposerKey(event("Enter", { shift: true }), CTRL_ENTER, ENTER)).toBe("newline");
	});

	it("发送改到非 Enter 组合后，裸 Enter 不会误发消息（兜底换行）", () => {
		expect(resolveComposerKey(event("Enter"), CTRL_ALT_K, SHIFT_ENTER)).toBe("newline");
		expect(resolveComposerKey(event("k", { ctrl: true, alt: true }), CTRL_ALT_K, SHIFT_ENTER)).toBe("send");
		// 大小写不敏感（KeyboardEvent.key 可能是大写）
		expect(resolveComposerKey(event("K", { ctrl: true, alt: true }), CTRL_ALT_K, SHIFT_ENTER)).toBe("send");
	});

	it("换行也能录成非 Enter 组合", () => {
		expect(resolveComposerKey(event("k", { ctrl: true, alt: true }), SEND, CTRL_ALT_K)).toBe("newline");
	});

	it("严格匹配：多按/少按一个修饰键都不算命中（不是「包含即触发」）", () => {
		expect(resolveComposerKey(event("k", { ctrl: true }), SEND, CTRL_ALT_K)).toBe("ignore");
		expect(resolveComposerKey(event("k", { ctrl: true, alt: true, shift: true }), SEND, CTRL_ALT_K)).toBe(
			"ignore",
		);
	});

	it("非 Enter 的普通键一律不管（字母、空格不归这里处理）", () => {
		expect(resolveComposerKey(event("k"), SEND, SHIFT_ENTER)).toBe("ignore");
		expect(resolveComposerKey(event(" "), SEND, SHIFT_ENTER)).toBe("ignore");
		expect(resolveComposerKey(event("Backspace"), SEND, SHIFT_ENTER)).toBe("ignore");
	});
});
