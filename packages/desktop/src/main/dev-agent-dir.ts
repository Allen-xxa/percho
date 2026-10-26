import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

// 开发/预览态**默认使用隔离副本**：agent dir = ~/.pi/agent-dev，userData = 正式目录加 `-dev` 后缀。
//
// 为什么默认隔离（而不是跟正式版/CLI 共用一套）：
// 1. 正式 agent dir `~/.pi/agent` 与正式 userData 是**用户真实数据**。dev 会写假会话、整份覆盖
//    ui-state.json、改 settings.json，一旦共用就碰真实数据；验收脚本干脆把「正式目录零写入」当前提。
// 2. 与安装版**并存时不再抢单实例锁、不再 EPERM**：锁按 userData 划分，`@percho/desktop-dev`
//    与 `@percho/desktop` 是两个不同的锁，两个实例可以同时开着（改 UI 时不用先关掉正在用的应用）。
//
// 需要让 dev 看到真实会话/记忆/AGENTS.md 时，显式设 PERCHO_SHARED_DEV_DATA=1 —— 此时 agent dir 与
// userData 都退回正式目录，等同「dev 就是日常应用」，同时也就意味着与安装版互斥（共用 userData）。
// 启动脚本 `scripts/dev.ps1 -Shared` 就是这个开关。
//
// 隔离目录名被验收脚本硬编码（scripts/check-font-size.mjs、check-sidebar-unified-scroll.mjs、
// shoot-rail.mjs、smoke-evaporation-ui.mjs、verify-channel-pill.mjs、verify-layout-freedom.mjs），
// 所以**不能改名**，改名要同步这六个脚本。
//
// 注意：SDK 的 getAgentDir() 最优先读 PI_CODING_AGENT_DIR（每次调用实时读取、无缓存），
// 在 main 入口最早设置即全链路生效（sessions/auth/models/trust/permissions/skills 全部派生自它）。
// 必须早于 backend 的任何路径解析（index.ts 顶部 side-effect import，与 pi-package-dir 同模式）。
// 用户显式设置了 PI_CODING_AGENT_DIR 时尊重之，不做任何处理。
const shareWithProd = process.env.PERCHO_SHARED_DEV_DATA === "1";

if (!app.isPackaged && !shareWithProd) {
	// 已用 --user-data-dir 指定目录时不要再叠 -dev 后缀（否则得到 <指定目录>-dev，验收脚本对不上）
	const userDataOverridden = process.argv.some((arg) => arg.startsWith("--user-data-dir"));
	if (!userDataOverridden) {
		const devUserData = `${app.getPath("userData")}-dev`;
		app.setPath("userData", devUserData);
		mkdirSync(devUserData, { recursive: true });
		console.log(`[dev-agent-dir] userData=${devUserData}（隔离；PERCHO_SHARED_DEV_DATA=1 可改用正式目录）`);
	}

	if (!process.env.PI_CODING_AGENT_DIR) {
		const devDir = join(homedir(), ".pi", "agent-dev");
		const prodDir = join(homedir(), ".pi", "agent");
		process.env.PI_CODING_AGENT_DIR = devDir;
		mkdirSync(devDir, { recursive: true });
		// 一次性种子拷贝（只读正式、只写 dev，目标已存在跳过，之后两边互不影响）：
		// 无凭证/模型 dev 起不来；settings/permissions/trust 拷过去免去重复配置。
		// 目录类资源（skills/extensions/themes/prompts）不拷，dev 独立发展。
		for (const name of ["auth.json", "models.json", "settings.json", "permissions.json", "trust.json"]) {
			const src = join(prodDir, name);
			const dest = join(devDir, name);
			try {
				if (existsSync(src) && !existsSync(dest)) copyFileSync(src, dest);
			} catch {
				// 种子拷贝失败不阻断启动
			}
		}
		console.log(
			`[dev-agent-dir] PI_CODING_AGENT_DIR=${devDir}（隔离；PERCHO_SHARED_DEV_DATA=1 可改用正式目录）`,
		);
	}
}
