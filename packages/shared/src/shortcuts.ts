/**
 * 可配置快捷键的底座：动作注册表 + 键位匹配/格式化 + 落盘归一化。
 *
 * 放在 shared 的理由：主进程归一化 `ui-state.json`（`main/ui-state.ts`）与渲染端录入/读键位必须用**同一份**
 * 校验规则，否则手改的脏文件能读出一个设置页录不出来的键位。
 *
 * 键位由用户自由录制（点设置页那一行 → 按组合键，Esc 取消），没有候选白名单；
 * 硬规则有两条：`isRecordableChord`（带修饰键，或单独 Enter）与**动作之间键位不能重复**（`chordOwner`）。
 *
 * 新增一个可配快捷键 = 在 `SHORTCUT_SPECS` 里加一条 + 在渲染端对应按键处理里用 `matchesChord` 接上；
 * 设置页那一行由 spec 自动生成（`components/settings/ShortcutsPanel.tsx` 按注册表迭代），不用改面板。
 */

/**
 * 单个键位：`KeyboardEvent.key` 的小写形式 + 修饰键开关（缺省 = 不按）。
 * 只描述**单键 + 修饰键**的组合，不做多键序列（chord），够用且能严格匹配。
 */
export interface KeyChord {
	/** `KeyboardEvent.key` 小写：`"enter"` / `"space"` / `"escape"` / 单字符 `"k"` */
	key: string;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
	meta?: boolean;
}

/** 可配置动作 id（稳定标识：落盘键名与设置页文案映射都用它；改名 = 老文件里的选择失效） */
export type ShortcutAction = "composer.send" | "composer.newline";

export interface ShortcutSpec {
	id: ShortcutAction;
	/** 出厂默认键位（「恢复默认」用；改默认值只需改这里） */
	defaultChord: KeyChord;
}

/** 当前生效的完整键位表（内存态） */
export type ShortcutBindings = Record<ShortcutAction, KeyChord>;
/** 落盘形态：**只存与出厂默认不同的动作**（改默认值不会让老文件锁死旧行为，文件也不会越用越大） */
export type ShortcutOverrides = Partial<Record<ShortcutAction, KeyChord>>;

/**
 * 动作注册表。取舍：
 * - 顺序即优先级：归一化时靠前的动作先占键位，后来的撞车覆盖项按脏值丢弃。
 * - 键位由用户自己录（不限键名），但必须带修饰键或**单独 Enter**（见 `isRecordableChord`）：
 *   裸字母/空格会把输入抢走，单独 Enter 不在文本里产生字符，可以安全当动作键。
 * - 出厂默认：发送 = Enter、换行 = Shift+Enter —— 跨平台一致，且是各家聊天框的通行习惯；
 *   想反过来（Ctrl+Enter 发送、Enter 换行）在两个动作上各录一次即可。
 */
export const SHORTCUT_SPECS: readonly ShortcutSpec[] = [
	{ id: "composer.send", defaultChord: { key: "enter" } },
	{ id: "composer.newline", defaultChord: { key: "enter", shift: true } },
];

/** 出厂默认绑定表（由注册表推导，别手写第二份） */
export const DEFAULT_SHORTCUT_BINDINGS: ShortcutBindings = Object.fromEntries(
	SHORTCUT_SPECS.map((spec) => [spec.id, spec.defaultChord]),
) as ShortcutBindings;

/** 键盘事件的最小形状：`KeyboardEvent` 与 React 合成事件的 `nativeEvent` 都满足 */
export interface ChordEvent {
	key: string;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	metaKey: boolean;
}

/** 键位相等：修饰键按布尔比较（`undefined` 与 `false` 等价），key 忽略大小写 */
export function sameChord(a: KeyChord, b: KeyChord): boolean {
	return (
		a.key.toLowerCase() === b.key.toLowerCase() &&
		Boolean(a.ctrl) === Boolean(b.ctrl) &&
		Boolean(a.alt) === Boolean(b.alt) &&
		Boolean(a.shift) === Boolean(b.shift) &&
		Boolean(a.meta) === Boolean(b.meta)
	);
}

/**
 * 事件是否命中键位。**严格匹配**：键位里没写的修饰键必须没按
 * （`Ctrl+Enter` 不算 `Shift+Enter`，`Ctrl+Shift+Enter` 也不算 `Ctrl+Enter`）。
 * 输入法合成期的判断不在这里做，调用方各自守在按键入口（`isComposing`）。
 */
export function matchesChord(event: ChordEvent, chord: KeyChord): boolean {
	return sameChord(
		{
			key: event.key,
			ctrl: event.ctrlKey,
			alt: event.altKey,
			shift: event.shiftKey,
			meta: event.metaKey,
		},
		chord,
	);
}

/** 某个动作的出厂默认键位（`setShortcutChord` 的「恢复默认」用） */
export function defaultChordOf(action: ShortcutAction): KeyChord {
	return SHORTCUT_SPECS.find((spec) => spec.id === action)?.defaultChord ?? { key: "enter" };
}

function isChord(value: unknown): value is KeyChord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const raw = value as Record<string, unknown>;
	if (typeof raw.key !== "string" || raw.key === "") return false;
	return (["ctrl", "alt", "shift", "meta"] as const).every(
		(modifier) => raw[modifier] === undefined || typeof raw[modifier] === "boolean",
	);
}

/** 只有修饰键本身的键名（录制时按 Ctrl 不算一个键位，得等主键） */
const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "os", "altgraph", "capslock"]);

/**
 * 不带修饰键也可以录的「动作键」：不产生文本的 Enter（发送/换行的通行默认键）。
 * 其余裸键（字母、空格、Backspace…）会把日常输入抢走，必须搭配修饰键。
 */
const BARE_KEYS = new Set(["enter"]);

/** 事件里的键名是不是「只有修饰键」（录制/预览用，`KeyboardEvent.key` 大小写不统一） */
export function isModifierKey(key: string): boolean {
	return MODIFIER_KEYS.has(key.toLowerCase());
}

/**
 * 键位能否被录制/保存：键名非空、不是修饰键本身，并且**带至少一个修饰键或就是单独的 Enter**。
 * 这拦住了「裸字母把输入抢走」；单独 Enter 放行是发送的出厂默认，也允许把它换给换行。
 */
export function isRecordableChord(chord: KeyChord): boolean {
	if (chord.key === "" || isModifierKey(chord.key)) return false;
	if (chord.ctrl || chord.alt || chord.shift || chord.meta) return true;
	return BARE_KEYS.has(chord.key.toLowerCase());
}

/** 规范形态：键名小写、值为 false 的修饰键直接丢掉（落盘/比较都用它，避免同一键位多种写法） */
export function normalizeChord(chord: KeyChord): KeyChord {
	return {
		key: chord.key.toLowerCase(),
		...(chord.ctrl ? { ctrl: true } : {}),
		...(chord.alt ? { alt: true } : {}),
		...(chord.shift ? { shift: true } : {}),
		...(chord.meta ? { meta: true } : {}),
	};
}

/**
 * 该键位是否已被**其它**动作占用（录制时拒绝提示 + 归一化时丢弃撞车覆盖项）。
 * `exclude` 是「我自己」，比较时跳过。
 */
export function chordOwner(
	bindings: ShortcutBindings,
	chord: KeyChord,
	exclude?: ShortcutAction,
): ShortcutAction | null {
	for (const spec of SHORTCUT_SPECS) {
		if (spec.id === exclude) continue;
		if (sameChord(bindings[spec.id], chord)) return spec.id;
	}
	return null;
}

/**
 * 归一化落盘/内存里的覆盖值 → 完整绑定表：未知动作、录不出来的键位（裸字母/纯修饰键）、
 * 非对象一律回落默认；收下的键位统一成 `normalizeChord` 的规范形态（脏文件里的多余字段自然消失）。
 *
 * 动作之间**互斥**：注册表顺序即优先级，先到先得；后来的撞车覆盖项当脏值丢弃（回落默认），
 * 所以这张表永远不存在「两个动作同一个键位」的状态（否则发送/换行的优先级就没法解释了）。
 */
export function resolveShortcutBindings(overrides: unknown): ShortcutBindings {
	const resolved: ShortcutBindings = { ...DEFAULT_SHORTCUT_BINDINGS };
	if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return resolved;
	for (const spec of SHORTCUT_SPECS) {
		const value = (overrides as Record<string, unknown>)[spec.id];
		if (!isChord(value) || !isRecordableChord(value)) continue;
		const chord = normalizeChord(value);
		if (chordOwner(resolved, chord, spec.id)) continue;
		resolved[spec.id] = chord;
	}
	return resolved;
}

/** 反向：完整绑定表 → 最小覆盖集（只留与出厂默认不同的项；顺手转成规范形态） */
export function toShortcutOverrides(bindings: ShortcutBindings): ShortcutOverrides {
	const overrides: ShortcutOverrides = {};
	for (const spec of SHORTCUT_SPECS) {
		const chord = bindings[spec.id];
		if (!sameChord(chord, spec.defaultChord)) overrides[spec.id] = normalizeChord(chord);
	}
	return overrides;
}

/** 落盘前的归一化（主进程 `ui-state.json` 的 normalize 用）：脏值清洗 + 只留覆盖项 */
export function normalizeShortcutOverrides(value: unknown): ShortcutOverrides {
	return toShortcutOverrides(resolveShortcutBindings(value));
}

/**
 * 键位文案：`Ctrl+Shift+Enter`（修饰键顺序固定 Ctrl → Alt → Shift → Meta）。
 * 键名是通用词（Enter / Space / 单字符），不进 i18n。
 */
export function formatChord(chord: KeyChord): string {
	const parts: string[] = [];
	if (chord.ctrl) parts.push("Ctrl");
	if (chord.alt) parts.push("Alt");
	if (chord.shift) parts.push("Shift");
	if (chord.meta) parts.push("Meta");
	parts.push(
		chord.key.length === 1
			? chord.key.toUpperCase()
			: chord.key.slice(0, 1).toUpperCase() + chord.key.slice(1),
	);
	return parts.join("+");
}
