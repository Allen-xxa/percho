import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 影子库测试的共用夹具：`scripts/smoke-snapshot-git.mts`（原始机制验证）与
 * `test/snapshot-git.test.ts`（模块行为验证）都从这里拿，避免抄两遍。
 *
 * 这里只放**与实现无关**的东西：临时 playground 的建删、md5、路径拼装。
 * 断言逻辑各自写在自己的文件里。
 */

export interface Shadow {
	gitDir: string;
	workTree: string;
	indexPath: string;
}

/** 造一个独立的临时 playground（调用方负责 `cleanup()`） */
export function makePlayground(prefix = "percho-snap-test-"): { root: string; cleanup: () => void } {
	const root = mkdtempSync(join(tmpdir(), prefix));
	return {
		root,
		cleanup: () => {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// Windows 上偶发 EBUSY：临时目录留给系统清理，不阻塞测试
			}
		},
	};
}

/** playground 里的子项目目录（自动 mkdir） */
export function projectDir(root: string, name: string): string {
	const dir = join(root, name, "wt");
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** 子项目对应的影子库路径（**不创建**，由 initShadow 或模块负责） */
export function shadowOf(workTree: string, root: string, name: string): Shadow {
	const base = join(root, name);
	return {
		gitDir: join(base, "snap", "s.git"),
		workTree,
		indexPath: join(base, "snap", "s.index"),
	};
}

export function md5(input: Buffer | string): string {
	return createHash("md5").update(input).digest("hex");
}

export function fileMd5(path: string): string {
	return md5(readFileSync(path));
}

/**
 * 影子库 attributes。**唯一真源**：`snapshot-git.ts` 的 `SHADOW_CONSTANTS` 必须与它一致
 * （`test/snapshot-git.test.ts` 里有断言钉住）。改这里就要同步改那边。
 */
export const INFO_ATTRIBUTES = "* -text -filter -working-tree-encoding\n";

/** 与工作区 `.gitignore` **叠加**（不是替代） */
export const INFO_EXCLUDE = [
	"node_modules/",
	"dist/",
	"dist-electron/",
	"out/",
	"build/",
	".next/",
	".turbo/",
	".cache/",
	".local/",
	"coverage/",
	"*.log",
	".DS_Store",
	"Thumbs.db",
	"",
].join("\n");

export const IDENTITY = {
	GIT_AUTHOR_NAME: "percho",
	GIT_AUTHOR_EMAIL: "snapshot@local",
	GIT_COMMITTER_NAME: "percho",
	GIT_COMMITTER_EMAIL: "snapshot@local",
} as const;

export const BASE_CONFIG = [
	"-c",
	"core.autocrlf=false",
	"-c",
	"core.safecrlf=false",
	"-c",
	"core.quotepath=false",
	"-c",
	"advice.addEmbeddedRepo=false",
	"-c",
	"gc.auto=0",
];

export interface RawGitOptions {
	env?: Record<string, string>;
	input?: string | Buffer;
	/** 不注入固定身份（用于「缺身份时 commit-tree 报错」这类反证） */
	noIdentity?: boolean;
}

/**
 * 直接对影子库跑 git —— **不经过被测模块**，供「原始机制」类断言使用
 * （阶段 0 脚本用它证明机制本身成立；模块测试请用模块的 `runGit`）。
 */
export async function rawGit(
	sh: Shadow | null,
	args: string[],
	opts: RawGitOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	if (!opts.noIdentity) Object.assign(env, IDENTITY);
	if (sh) {
		env.GIT_DIR = sh.gitDir;
		env.GIT_WORK_TREE = sh.workTree;
		env.GIT_INDEX_FILE = sh.indexPath;
	}
	env.GIT_TERMINAL_PROMPT = "0";
	if (opts.env) Object.assign(env, opts.env);
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			[...BASE_CONFIG, ...args],
			{
				cwd: sh?.workTree ?? process.cwd(),
				env,
				maxBuffer: 64 * 1024 * 1024,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				if (error && (error as { code?: unknown }).code === undefined) {
					reject(error);
					return;
				}
				const code =
					error && typeof (error as { code?: unknown }).code === "number"
						? (error as { code: number }).code
						: error
							? 1
							: 0;
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
			},
		);
		if (opts.input !== undefined) child.stdin?.end(opts.input);
		else child.stdin?.end();
	});
}
