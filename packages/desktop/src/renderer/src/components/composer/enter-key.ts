import { type ChordEvent, type KeyChord, matchesChord } from "@percho/shared";

/** 按键三岔：换行 / 发送 / 不管 */
export type ComposerKeyAction = "newline" | "send" | "ignore";

/**
 * 只做决策、不做副作用：Composer 的按键处理据此分别「preventDefault + 换行」或「发送」。
 *
 * 优先级（两个键位都能在设置里自由录制，见 shared `shortcuts.ts`）：
 * 1. **命中换行键位 → 换行**（先判换行：它不会产生不可逆副作用）；
 * 2. **命中发送键位 → 发送**；
 * 3. **没被占用的 Enter 一律换行**（软换行，不发送、也不落到 Lexical 手里变成新段落）。
 *    这条兜底把「发送改到 Ctrl+K 之后裸 Enter 反而误发消息」这条路彻底关掉：发送只认录下来的那个键位。
 *
 * 录的键位可以**不是 Enter**（如 Ctrl+Alt+K），所以匹配要按键位走，不能只看键名；
 * 两个动作的键位由 `resolveShortcutBindings` 保证互不相同，所以 1/2 的顺序不影响结果。
 */
export function resolveComposerKey(
	event: ChordEvent,
	sendChord: KeyChord,
	newlineChord: KeyChord,
): ComposerKeyAction {
	if (matchesChord(event, newlineChord)) return "newline";
	if (matchesChord(event, sendChord)) return "send";
	if (event.key.toLowerCase() !== "enter") return "ignore";
	return "newline";
}
