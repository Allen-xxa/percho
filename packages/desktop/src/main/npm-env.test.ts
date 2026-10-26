import { describe, expect, it } from "vitest";
import { stripNpmAllowScriptsEnv } from "./npm-env";

describe("stripNpmAllowScriptsEnv", () => {
	it("删除 npm_config_allow_scripts（小写，非 Windows）", () => {
		const env = { npm_config_allow_scripts: "better-sqlite3", PATH: "/usr/bin" };
		stripNpmAllowScriptsEnv(env);
		expect(env).toEqual({ PATH: "/usr/bin" });
	});

	it("删除大写 NPM_CONFIG_ALLOW_SCRIPTS（Windows 风格）", () => {
		const env = { NPM_CONFIG_ALLOW_SCRIPTS: "better-sqlite3", Path: "C:\\Windows" };
		stripNpmAllowScriptsEnv(env);
		expect(env).toEqual({ Path: "C:\\Windows" });
	});

	it("混合大小写同样剔除", () => {
		const env = { Npm_Config_Allow_Scripts: "x" };
		stripNpmAllowScriptsEnv(env);
		expect(env).toEqual({});
	});

	it("不动其他 npm_config_* 与其他变量", () => {
		const env = { npm_config_registry: "https://registry.npmmirror.com", npm_config_legacy_peer_deps: "true" };
		stripNpmAllowScriptsEnv(env);
		expect(env).toEqual({ npm_config_registry: "https://registry.npmmirror.com", npm_config_legacy_peer_deps: "true" });
	});

	it("没有该键时保持原样（幂等）", () => {
		const env = { PATH: "/usr/bin" };
		stripNpmAllowScriptsEnv(env);
		stripNpmAllowScriptsEnv(env);
		expect(env).toEqual({ PATH: "/usr/bin" });
	});
});
