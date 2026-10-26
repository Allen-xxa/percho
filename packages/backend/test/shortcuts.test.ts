import {
	DEFAULT_SHORTCUT_BINDINGS,
	defaultChordOf,
	formatChord,
	isModifierKey,
	isRecordableChord,
	type KeyChord,
	matchesChord,
	normalizeChord,
	normalizeShortcutOverrides,
	resolveShortcutBindings,
	SHORTCUT_SPECS,
	toShortcutOverrides,
} from "@percho/shared";
import { describe, expect, it } from "vitest";

/** 事件最小形状（与 `KeyboardEvent` 字段同名） */
function ev(key: string, mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {}) {
	return {
		key,
		ctrlKey: mods.ctrl ?? false,
		altKey: mods.alt ?? false,
		shiftKey: mods.shift ?? false,
		metaKey: mods.meta ?? false,
	};
}

/** 键位 → 等价的「事件」（用来比默认键位是否撞车，省得自己拼修饰键） */
function toEvent(chord: KeyChord) {
	return ev(chord.key, { ctrl: chord.ctrl, alt: chord.alt, shift: chord.shift, meta: chord.meta });
}

const SHIFT_ENTER: KeyChord = { key: "Enter", shift: true };
const CTRL_ENTER: KeyChord = { key: "enter", ctrl: true };

describe("registry 自洽", () => {
	it("出厂默认键位本身可录制（否则「恢复默认」会落一个非法值）", () => {
		for (const spec of SHORTCUT_SPECS) {
			expect(isRecordableChord(spec.defaultChord), formatChord(spec.defaultChord)).toBe(true);
		}
	});

	it("动作之间的出厂默认键位互不相同（同一键位会抢同一个按键）", () => {
		for (const a of SHORTCUT_SPECS) {
			for (const b of SHORTCUT_SPECS) {
				if (a.id === b.id) continue;
				expect(matchesChord(toEvent(a.defaultChord), b.defaultChord), `${a.id} vs ${b.id}`).toBe(false);
			}
		}
	});

	it("发送默认是裸 Enter、换行默认带修饰键（各家聊天框的通行习惯）", () => {
		expect(defaultChordOf("composer.send")).toEqual({ key: "enter" });
		expect(defaultChordOf("composer.newline")).toEqual({ key: "enter", shift: true });
	});
});

describe("isRecordableChord / isModifierKey（自由录制的唯一硬规则）", () => {
	it.each([
		[{ key: "enter", shift: true }, true],
		[{ key: "Enter", ctrl: true, shift: true }, true],
		[{ key: "enter", meta: true }, true],
		[{ key: "k", alt: true }, true],
		[{ key: "enter" }, true], // 单独 Enter：不产生文本，可当动作键（默认发送）
		[{ key: "k" }, false], // 单键会把输入抢走
		[{ key: "space" }, false], // 空格同理
		[{ key: "control", ctrl: true }, false], // 只有修饰键不成键位
		[{ key: "", ctrl: true }, false],
	] as const)("%o → %s", (chord, expected) => {
		expect(isRecordableChord(chord)).toBe(expected);
	});

	it("修饰键本身被识别出来（录制时等主键、不提交）", () => {
		for (const key of ["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock"]) {
			expect(isModifierKey(key), key).toBe(true);
		}
		expect(isModifierKey("Enter")).toBe(false);
		expect(isModifierKey("k")).toBe(false);
	});
});

describe("normalizeChord", () => {
	it("键名小写 + 丢掉值为 false 的修饰键", () => {
		expect(normalizeChord({ key: "Enter", ctrl: true, shift: false })).toEqual({ key: "enter", ctrl: true });
		expect(normalizeChord({ key: "K", alt: false, meta: false })).toEqual({ key: "k" });
	});
});

describe("matchesChord 严格匹配", () => {
	it("命中：键名大小写不敏感、修饰键按布尔比", () => {
		expect(matchesChord(ev("Enter", { shift: true }), SHIFT_ENTER)).toBe(true);
		expect(matchesChord(ev("enter", { shift: true }), SHIFT_ENTER)).toBe(true);
	});

	it("多按修饰键不算命中（Ctrl+Shift+Enter ≠ Shift+Enter）", () => {
		expect(matchesChord(ev("Enter", { shift: true, ctrl: true }), SHIFT_ENTER)).toBe(false);
	});

	it("少按修饰键不算命中（裸 Enter ≠ Shift+Enter）", () => {
		expect(matchesChord(ev("Enter"), SHIFT_ENTER)).toBe(false);
		expect(matchesChord(ev("Enter", { ctrl: true }), SHIFT_ENTER)).toBe(false);
	});

	it("Meta 独立比较（Windows 上是 Win 键，不能当 Ctrl 用）", () => {
		expect(matchesChord(ev("Enter", { meta: true }), CTRL_ENTER)).toBe(false);
		expect(matchesChord(ev("Enter", { meta: true }), { key: "Enter", meta: true })).toBe(true);
	});
});

describe("resolveShortcutBindings 归一化", () => {
	it("空/脏入参一律回落出厂默认", () => {
		for (const raw of [undefined, null, "x", 42, [], { "composer.newline": "enter" }]) {
			expect(resolveShortcutBindings(raw)).toEqual(DEFAULT_SHORTCUT_BINDINGS);
		}
	});

	it("任意带修饰键的组合都照收（没有候选白名单），键名归一成小写", () => {
		expect(
			resolveShortcutBindings({ "composer.newline": { key: "enter", ctrl: true } })["composer.newline"],
		).toEqual({
			key: "enter",
			ctrl: true,
		});
		// 用户自己录出来的「冷门」组合也算数
		expect(
			resolveShortcutBindings({ "composer.newline": { key: "J", alt: true } })["composer.newline"],
		).toEqual({
			key: "j",
			alt: true,
		});
	});

	it("无修饰键的裸字母、只有修饰键、未知动作都被丢弃（回落默认）", () => {
		for (const dirty of [
			{ key: "k" },
			{ key: "enter", shift: false, ctrl: false },
			{ key: "control", ctrl: true },
			{ key: "" },
		]) {
			expect(
				resolveShortcutBindings({ "composer.newline": dirty })["composer.newline"],
				JSON.stringify(dirty),
			).toEqual(defaultChordOf("composer.newline"));
		}
		const resolved = resolveShortcutBindings({ "composer.unknown": { key: "enter", ctrl: true } });
		expect(Object.keys(resolved)).toEqual(["composer.send", "composer.newline"]);
	});

	it("两个动作键位互斥：裸 Enter 只能属于一个动作（先到先得，后来者当脏值丢弃）", () => {
		// 只把换行改成裸 Enter：发送已经占着裸 Enter，这条覆盖项无效
		expect(resolveShortcutBindings({ "composer.newline": { key: "enter" } })["composer.newline"]).toEqual(
			defaultChordOf("composer.newline"),
		);
		// 反过来把发送挪到 Ctrl+Enter，再把换行改回裸 Enter —— 「Ctrl+Enter 发送、Enter 换行」
		const swapped = resolveShortcutBindings({
			"composer.send": { key: "enter", ctrl: true },
			"composer.newline": { key: "enter" },
		});
		expect(swapped).toEqual({
			"composer.send": { key: "enter", ctrl: true },
			"composer.newline": { key: "enter" },
		});
	});
});

describe("toShortcutOverrides / normalizeShortcutOverrides", () => {
	it("只留与出厂默认不同的动作", () => {
		expect(toShortcutOverrides(DEFAULT_SHORTCUT_BINDINGS)).toEqual({});
		expect(toShortcutOverrides({ ...DEFAULT_SHORTCUT_BINDINGS, "composer.newline": CTRL_ENTER })).toEqual({
			"composer.newline": CTRL_ENTER,
		});
		// 反过来的习惯（Ctrl+Enter 发送、Enter 换行）落盘两条
		expect(
			toShortcutOverrides({ "composer.send": CTRL_ENTER, "composer.newline": { key: "enter" } }),
		).toEqual({ "composer.send": { key: "enter", ctrl: true }, "composer.newline": { key: "enter" } });
	});

	it("归一化落盘值 = 清洗 + 只留差异项（脏文件读一遍就瘦身）", () => {
		expect(normalizeShortcutOverrides({ "composer.newline": { key: "enter", shift: true } })).toEqual({});
		// 键名按注册表的规范形态收下（大写 Enter 归一成小写），多余字段自然消失
		expect(normalizeShortcutOverrides({ "composer.newline": { key: "Enter", ctrl: true, junk: 1 } })).toEqual(
			{
				"composer.newline": { key: "enter", ctrl: true },
			},
		);
	});
});

describe("formatChord", () => {
	it.each([
		[{ key: "enter", shift: true }, "Shift+Enter"],
		[{ key: "Enter", ctrl: true, shift: true }, "Ctrl+Shift+Enter"],
		[{ key: "j", ctrl: true }, "Ctrl+J"],
		[{ key: "space", alt: true, meta: true }, "Alt+Meta+Space"],
	] as const)("%o → %s", (chord, expected) => {
		expect(formatChord(chord)).toBe(expected);
	});
});
