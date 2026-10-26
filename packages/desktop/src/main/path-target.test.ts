// @vitest-environment node
import { homedir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { cleanPathText, resolveExistingPath, resolvePathTarget } from "./path-target";

/** 路径解析（issue #55 ④）：模型给的路径形态千奇百怪，这里把每类都钉住 */

const CWD = "/Users/me/proj";
/** 期望值统一走 node:path 的平台规则：同一段断言在 POSIX 与 Windows 上都得成立
 *  （Windows 下 `/Users/x` 是「当前盘符下的根路径」，`normalize` 会给出 `\\Users\\x`） */
const asPath = (posix: string) => normalize(posix);

describe("cleanPathText", () => {
	it("剥成对包裹符（反引号/引号/尖括号/括号/方括号）", () => {
		expect(cleanPathText("`src/a.ts`")).toBe("src/a.ts");
		expect(cleanPathText('"src/a.ts"')).toBe("src/a.ts");
		expect(cleanPathText("(src/a.ts)")).toBe("src/a.ts");
		expect(cleanPathText("[src/a.ts]")).toBe("src/a.ts");
		expect(cleanPathText("<src/a.ts>")).toBe("src/a.ts");
		expect(cleanPathText("  `src/a.ts`  ")).toBe("src/a.ts");
	});

	it("只剥两端同款包裹符：路径自带的括号保留", () => {
		expect(cleanPathText("/Users/me/My (notes)/a.md")).toBe("/Users/me/My (notes)/a.md");
		expect(cleanPathText("(a.md")).toBe("(a.md");
	});

	it("剥行号/列号/锚点后缀", () => {
		expect(cleanPathText("src/a.ts:12")).toBe("src/a.ts");
		expect(cleanPathText("src/a.ts:12:5")).toBe("src/a.ts");
		expect(cleanPathText("src/a.ts#L12")).toBe("src/a.ts");
		expect(cleanPathText("src/a.ts#L12-L20")).toBe("src/a.ts");
		expect(cleanPathText("(src/a.ts:12)")).toBe("src/a.ts");
		// Windows 盘符不是行号：C: 在最前，且尾部没有 :数字
		expect(cleanPathText("C:\\proj\\a.ts")).toBe("C:\\proj\\a.ts");
		expect(cleanPathText("C:\\proj\\a.ts:12")).toBe("C:\\proj\\a.ts");
	});
});

describe("resolvePathTarget", () => {
	it("绝对路径原样（normalize 掉 ./ 与 ..）", () => {
		expect(resolvePathTarget("/Users/me/proj/src/a.ts", CWD)).toBe(asPath("/Users/me/proj/src/a.ts"));
		expect(resolvePathTarget("/Users/me/proj/./src/../src/a.ts", CWD)).toBe(asPath("/Users/me/proj/src/a.ts"));
	});

	it("相对路径以会话 cwd 为基准（cwd 非法/缺省时退回进程 cwd）", () => {
		expect(resolvePathTarget("src/a.ts", CWD)).toBe(resolve(CWD, "src/a.ts"));
		expect(resolvePathTarget("./src/../b.ts", CWD)).toBe(resolve(CWD, "b.ts"));
		expect(resolvePathTarget("src/a.ts", null)).toBe(resolve(process.cwd(), "src/a.ts"));
		expect(resolvePathTarget("src/a.ts", "relative-cwd")).toBe(resolve(process.cwd(), "src/a.ts"));
	});

	it("~ 展开到 home（裸 ~ / ~/子路径）", () => {
		expect(resolvePathTarget("~", CWD)).toBe(homedir());
		expect(resolvePathTarget("~/notes/a.md", CWD)).toBe(join(homedir(), "notes/a.md"));
		expect(resolvePathTarget("`~/.pi/agent/settings.json`", CWD)).toBe(
			join(homedir(), ".pi/agent/settings.json"),
		);
	});

	it("file:// URL（含中文与空格的 percent-encoding）", () => {
		// URL 用 pathToFileURL 生成：手写 `file:///Users/...` 在 Windows 上不是合法 file URL
		// （fileURLToPath 抛 ERR_INVALID_FILE_URL_PATH），测的就不是「本平台 URL 能不能吃」了
		const spaced = resolve("/Users/me/proj/a b.ts");
		const chinese = resolve("/Users/me/中文.md");
		expect(resolvePathTarget(pathToFileURL(spaced).href, CWD)).toBe(spaced);
		expect(resolvePathTarget(pathToFileURL(chinese).href, CWD)).toBe(chinese);
		expect(resolvePathTarget(`${pathToFileURL(resolve("/Users/me/proj/a.ts")).href}:12`, CWD)).toBe(
			resolve("/Users/me/proj/a.ts"),
		);
	});

	it("纯路径里的 percent-encoding 也解码；非法转义保持原样", () => {
		expect(resolvePathTarget("/Users/me/a%20b.ts", CWD)).toBe(asPath("/Users/me/a b.ts"));
		expect(resolvePathTarget("/Users/me/100%25.ts", CWD)).toBe(asPath("/Users/me/100%.ts"));
		expect(resolvePathTarget("/Users/me/100% 完成.md", CWD)).toBe(asPath("/Users/me/100% 完成.md"));
	});

	it("空路径/纯包裹符抛错（不静默当成 cwd）", () => {
		expect(() => resolvePathTarget("", CWD)).toThrow(/Empty path/);
		expect(() => resolvePathTarget("  ", CWD)).toThrow(/Empty path/);
		expect(() => resolvePathTarget("``", CWD)).toThrow(/Empty path/);
	});

	it("中文/空格路径（未编码）原样保留", () => {
		expect(resolvePathTarget("docs/中文 文档/说明.md", CWD)).toBe(resolve(CWD, "docs/中文 文档/说明.md"));
	});
});

describe("resolveExistingPath", () => {
	it("存在的路径返回绝对路径；不存在的抛 Path not found（带解析结果便于定位）", () => {
		const here = resolvePathTarget("./package.json", process.cwd());
		expect(resolveExistingPath("./package.json", process.cwd())).toBe(here);
		expect(() => resolveExistingPath("./definitely-not-here.ts", process.cwd())).toThrow(
			/Path not found: .*definitely-not-here\.ts/,
		);
	});
});
