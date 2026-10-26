import {
	chordOwner,
	defaultChordOf,
	formatChord,
	isModifierKey,
	isRecordableChord,
	normalizeChord,
	SHORTCUT_SPECS,
	type ShortcutAction,
	type ShortcutSpec,
	sameChord,
} from "@percho/shared";
import { useEffect, useState } from "react";
import { type MessageKey, useT } from "../../i18n";
import { useUiPreferencesStore } from "../../stores/ui-preferences";

/**
 * 面板文案挂点：动作 id → i18n 前缀。
 * 键位本身由 `formatChord` 拼（`Ctrl+Shift+Enter` 这类键名不进 i18n），
 * 所以加动作只需要在 shared 注册表里加一条、再在这里补两行文案。
 */
const ACTION_TEXT_KEYS: Record<ShortcutAction, { label: MessageKey; hint: MessageKey }> = {
	"composer.send": { label: "settings.shortcuts.send", hint: "settings.shortcuts.sendHint" },
	"composer.newline": { label: "settings.shortcuts.newline", hint: "settings.shortcuts.newlineHint" },
};

/** 只按了修饰键时的预览文案：`Ctrl+Alt+…`（空 → null，回到「按下组合键…」） */
function modifierPreview(event: KeyboardEvent | KeyboardEventInit): string | null {
	const parts: string[] = [];
	if (event.ctrlKey) parts.push("Ctrl");
	if (event.altKey) parts.push("Alt");
	if (event.shiftKey) parts.push("Shift");
	if (event.metaKey) parts.push("Meta");
	return parts.length > 0 ? `${parts.join("+")}+…` : null;
}

/** 录制被拒的原因：不带修饰键 / 和别的动作撞车 */
type Rejection = { kind: "modifier" } | { kind: "conflict"; owner: ShortcutAction };

/**
 * 一个动作的设置行：点一下进入录制态，直接按组合键录入（Esc 取消），改过才出现「恢复默认」。
 *
 * 录制期间在 window 上挂 **capture** 监听并 `preventDefault`/`stopPropagation`：
 * 否则按下的键会先被输入框、其它热键或对话框的 Esc 处理吃掉（尤其 Esc 会顺手关掉设置面板）。
 *
 * 两条拒绝规则：键位必须可录（`isRecordableChord`）、不能和别的动作同键（`chordOwner`）——
 * 后者在提交前就拦下，避免录进去又被归一化悄悄改回默认。
 */
function ShortcutRow({ spec }: { spec: ShortcutSpec }) {
	const t = useT();
	const bindings = useUiPreferencesStore((s) => s.shortcutBindings);
	const current = bindings[spec.id];
	const setShortcutChord = useUiPreferencesStore((s) => s.setShortcutChord);
	const text = ACTION_TEXT_KEYS[spec.id];
	const isDefault = sameChord(current, spec.defaultChord);
	const [recording, setRecording] = useState(false);
	const [pending, setPending] = useState<string | null>(null);
	const [rejection, setRejection] = useState<Rejection | null>(null);

	useEffect(() => {
		if (!recording) return;
		const stop = () => {
			setRecording(false);
			setPending(null);
			setRejection(null);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") {
				// 同一个节点上可能还有别的 Esc 监听（对话框自己关窗），一路拦到家
				event.stopImmediatePropagation();
				stop();
				return;
			}
			if (isModifierKey(event.key)) {
				setPending(modifierPreview(event));
				return;
			}
			const chord = normalizeChord({
				key: event.key,
				ctrl: event.ctrlKey,
				alt: event.altKey,
				shift: event.shiftKey,
				meta: event.metaKey,
			});
			if (!isRecordableChord(chord)) {
				// 裸字母/空格：留在录制态，提示后可以接着按（不必重新点一下）
				setRejection({ kind: "modifier" });
				setPending(null);
				return;
			}
			const owner = chordOwner(bindings, chord, spec.id);
			if (owner) {
				// 和另一个动作撞车：同样留在录制态，说清是谁占着
				setRejection({ kind: "conflict", owner });
				setPending(null);
				return;
			}
			setShortcutChord(spec.id, chord);
			stop();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			// 松开修饰键时同步预览（按下 Ctrl 看到 Ctrl+…、松开就回到「按下组合键…」）
			if (isModifierKey(event.key)) setPending(modifierPreview(event));
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keyup", onKeyUp, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
		};
	}, [recording, spec.id, setShortcutChord, bindings]);

	const stop = () => {
		setRecording(false);
		setPending(null);
		setRejection(null);
	};

	/** 拒绝提示：说清「为什么不收」，比只标红有用 */
	const rejectionText = (() => {
		if (!rejection) return null;
		if (rejection.kind === "modifier") return t("settings.shortcuts.needModifier");
		return t("settings.shortcuts.conflict", {
			key: t(ACTION_TEXT_KEYS[rejection.owner].label),
		});
	})();

	return (
		<div className="flex items-start gap-3">
			<div className="w-28 shrink-0 pt-1.5">
				<span className="text-ui-12 text-ink-dim">{t(text.label)}</span>
			</div>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={() => {
						if (recording) {
							stop();
							return;
						}
						setRejection(null);
						setPending(null);
						setRecording(true);
					}}
					onBlur={() => {
						if (recording) stop();
					}}
					aria-label={t("settings.shortcuts.record", { key: t(text.label) })}
					className={`min-w-[9rem] rounded-lg border px-3 py-1.5 text-left font-mono text-ui-12 transition-colors ${
						rejection
							? "border-err text-err"
							: recording
								? "border-accent bg-accent/10 text-accent"
								: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
					}`}
				>
					{recording ? (pending ?? t("settings.shortcuts.recording")) : formatChord(current)}
				</button>
				{/* 恢复默认只在真的改过时出现 */}
				{!isDefault && (
					<button
						type="button"
						onClick={() => setShortcutChord(spec.id, null)}
						className="rounded-lg px-2 py-1.5 text-ui-12 text-ink-faint transition-colors hover:bg-hover hover:text-ink-2"
					>
						{t("settings.shortcuts.reset", { key: formatChord(defaultChordOf(spec.id)) })}
					</button>
				)}
				{recording && (
					<span className={`text-ui-11 ${rejection ? "text-err" : "text-ink-faint"}`}>
						{rejectionText ?? t("settings.shortcuts.recordHint")}
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * 快捷键设置：按 `SHORTCUT_SPECS` 迭代出行，键位自由录制（点一下 → 按组合键 → Esc 取消）。
 * 硬规则两条（见 shared `shortcuts.ts`）：必须带修饰键或单独 Enter（`isRecordableChord`）、
 * 动作之间键位不能重复（`chordOwner`）；手改 `ui-state.json` 的脏值在主进程按同一规则回落默认。
 */
export function ShortcutsPanel() {
	const t = useT();
	return (
		<div className="flex flex-col gap-6">
			<div>
				<h3 className="text-ui-13 font-medium text-ink">{t("settings.shortcuts.composer")}</h3>
				<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">
					{t("settings.shortcuts.composerHint")}
				</p>
				<div className="mt-3 flex flex-col gap-3">
					{SHORTCUT_SPECS.map((spec) => (
						<div key={spec.id}>
							<ShortcutRow spec={spec} />
							<p className="mt-1 pl-[7.75rem] text-ui-11 text-ink-faint">
								{t(ACTION_TEXT_KEYS[spec.id].hint)}
							</p>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
