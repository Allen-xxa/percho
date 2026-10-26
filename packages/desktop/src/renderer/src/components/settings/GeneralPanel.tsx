import type { ContextManagerMode, PermissionMode } from "@percho/shared";
import type { Language } from "../../i18n";
import { useI18nStore, useT } from "../../i18n";
import { useSessionsStore } from "../../stores/sessions";
import { useSettingsStore } from "../../stores/settings";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { Switch } from "../ui/Switch";

const CONTEXT_MANAGER_MODES: ContextManagerMode[] = ["evaporation", "off"];
/** 新会话默认档位候选（与 composer 的 PermissionPicker 同序） */
const PERMISSION_MODES: PermissionMode[] = ["default", "fullAccess"];

/** 通用设置面板：语言选择 + 上下文管理二态 + 新会话默认权限档位 + channel-watch 开关 */
export function GeneralPanel() {
	const t = useT();
	const language = useI18nStore((s) => s.language);
	const setLanguage = useI18nStore((s) => s.setLanguage);
	const contextManagerMode = useSettingsStore((s) => s.contextManagerMode);
	const setContextManagerMode = useSettingsStore((s) => s.setContextManagerMode);
	const channelWatchEnabled = useSettingsStore((s) => s.channelWatchEnabled);
	const setChannelWatchEnabled = useSettingsStore((s) => s.setChannelWatchEnabled);
	const defaultPermissionMode = useUiPreferencesStore((s) => s.defaultPermissionMode);
	const setDefaultPermissionMode = useUiPreferencesStore((s) => s.setDefaultPermissionMode);

	const changeDefaultPermissionMode = (mode: PermissionMode) => {
		const previous = defaultPermissionMode;
		setDefaultPermissionMode(mode);
		// 当前那份草稿若还等于旧默认（= 用户没在新会话页单独选过），跟着改成新默认；
		// 手动选过的不动（promotion 时以草稿为准）
		const sessions = useSessionsStore.getState();
		if (sessions.newSessionDraft?.permissionMode === previous) sessions.setDraftPermissionMode(mode);
	};

	return (
		<div className="flex flex-col gap-6">
			<div>
				<h3 className="text-ui-13 font-medium text-ink">{t("settings.language")}</h3>
				<p className="mt-0.5 text-ui-11 text-ink-faint">{t("settings.languageHint")}</p>
				<div className="mt-2 flex gap-2">
					{(["zh", "en"] as Language[]).map((lang) => (
						<button
							key={lang}
							type="button"
							className={`rounded-lg border px-3 py-1.5 text-ui-13 transition-colors ${
								language === lang
									? "border-ink bg-ink text-on-ink"
									: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
							}`}
							onClick={() => setLanguage(lang)}
						>
							{t(`lang.${lang}`)}
						</button>
					))}
				</div>
			</div>
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-ui-13 font-medium text-ink">{t("settings.contextManager")}</h3>
					<div className="flex gap-2">
						{CONTEXT_MANAGER_MODES.map((mode) => (
							<button
								key={mode}
								type="button"
								disabled={contextManagerMode === null}
								className={`rounded-lg border px-3 py-1.5 text-ui-13 transition-colors disabled:opacity-50 ${
									contextManagerMode === mode
										? "border-ink bg-ink text-on-ink"
										: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
								}`}
								onClick={() => void setContextManagerMode(mode)}
							>
								{t(`settings.contextManagerMode.${mode}`)}
							</button>
						))}
					</div>
				</div>
				<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">
					{contextManagerMode ? t(`settings.contextManagerHint.${contextManagerMode}`) : ""}
				</p>
			</div>
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-ui-13 font-medium text-ink">{t("settings.defaultPermission")}</h3>
					<div className="flex gap-2">
						{PERMISSION_MODES.map((mode) => (
							<button
								key={mode}
								type="button"
								className={`rounded-lg border px-3 py-1.5 text-ui-13 transition-colors ${
									defaultPermissionMode === mode
										? "border-ink bg-ink text-on-ink"
										: "border-border text-ink-2 hover:border-border-strong hover:bg-hover"
								}`}
								onClick={() => changeDefaultPermissionMode(mode)}
							>
								{mode === "fullAccess"
									? t("composer.permissionFullAccess")
									: t("composer.permissionDefault")}
							</button>
						))}
					</div>
				</div>
				<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">
					{t("settings.defaultPermissionHint")}
				</p>
				{defaultPermissionMode === "fullAccess" && (
					<p className="mt-1 text-ui-11 leading-relaxed text-warn">
						{t("settings.defaultPermissionWarn")}
					</p>
				)}
			</div>
			<div>
				<div className="flex items-center justify-between gap-4">
					<h3 className="text-ui-13 font-medium text-ink">{t("settings.channelWatch")}</h3>
					<Switch
						checked={channelWatchEnabled === true}
						disabled={channelWatchEnabled === null}
						onCheckedChange={(enabled) => void setChannelWatchEnabled(enabled)}
					/>
				</div>
				<p className="mt-0.5 text-ui-11 leading-relaxed text-ink-faint">{t("settings.channelWatchHint")}</p>
			</div>
		</div>
	);
}
