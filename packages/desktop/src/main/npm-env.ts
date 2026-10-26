/**
 * 剥离 npm 注入的 allowScripts 配置（npm_config_allow_scripts / npm_config_allowscripts）。
 *
 * 背景：`npm run dev` 会把自身配置以 `npm_config_*`（Windows 下为 `NPM_CONFIG_*`）环境变量
 * 注入子进程。npm 11.16 起支持 allowScripts 门禁，若用户 `~/.npmrc` 里写了
 * `allow-scripts=...`，该配置会以 `npm_config_allow_scripts` 传给 Electron 及其所有后代。
 * 而 pi 安装扩展走的是 `npm install <pkg> --prefix <dir>`（project-scoped 安装），npm 对这种
 * 安装明确拒绝 allow-scripts 配置并直接失败：
 *
 *   npm error code EALLOWSCRIPTS
 *   npm error --allow-scripts is not allowed in project-scoped installs.
 *
 * 连锁后果：session:create / session:listSlashCommandsForCwd 等所有依赖扩展安装的调用全挂，
 * dev 界面看起来「功能全部失效」，且每次点击都会弹出一个 cmd 窗口。
 * 打包态不经过 npm run，环境干净，所以只有 dev 受影响 —— 正因如此必须在这里兜住。
 */
const NPM_ALLOW_SCRIPTS_ENV_KEYS = ["npm_config_allow_scripts", "npm_config_allowscripts"];

/** 从给定环境变量表中删除 allowScripts 相关键（大小写不敏感，Windows 环境变量不区分大小写）。 */
export function stripNpmAllowScriptsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	for (const key of Object.keys(env)) {
		if (NPM_ALLOW_SCRIPTS_ENV_KEYS.includes(key.toLowerCase())) delete env[key];
	}
	return env;
}

// 进程级生效：main 与 backend 派生的所有 npm 子进程都继承这份 env。
stripNpmAllowScriptsEnv(process.env);
