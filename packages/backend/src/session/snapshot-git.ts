import { execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../log";

const log = createLogger("snapshot-git");

/**
 * 影子 git 库的纯原语层：只做「对某个影子库执行 git 命令」，不做任何会话编排
 * （编排在 `snapshots.ts`）。**backend 唯一的 `child_process` 使用点**。
 *
 * 影子库永不 merge 回用户分支、不碰用户 `.git`：所有操作都靠
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` 指向 `<userData>/snap/<sessionId>.git`。
 */

export interface ShadowRepo {
	/** <snapshotsDir>/<sessionId>.git */
	gitDir: string;
	/** 项目 cwd（快照与写回都作用在这里） */
	workTree: string;
	/** <snapshotsDir>/<sessionId>.index（独立 index，绝不碰用户的） */
	indexPath: string;
}

export interface GitRunResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** 固定身份：缺了 `commit-tree` 会报误导性的 `fatal: must give exactly one tree` */
const IDENTITY = {
	GIT_AUTHOR_NAME: "percho",
	GIT_AUTHOR_EMAIL: "snapshot@local",
	GIT_COMMITTER_NAME: "percho",
	GIT_COMMITTER_EMAIL: "snapshot@local",
} as const;

/** 每次调用都带的 config：挡 autocrlf 干扰、关嵌入式仓库提示、禁自动 gc */
const BASE_CONFIG = [
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

/**
 * 影子库的 attributes，**只有这三个属性，绝不能加 `diff`**。
 *
 * - 作用：压过任意深度的 `.gitattributes` 与自定义 filter，保证入站 blob 与磁盘字节完全一致、
 *   写回（`read-tree -u --reset`）后 md5 不变。实测覆盖 CRLF、`* text=auto eol=crlf`、
 *   嵌套 `sub/.gitattributes`、`filter.<driver>.clean`。
 * - `-text` 只关 eol 归一化，**不把文件当二进制**，`merge-tree` 的行级合并仍然正常。
 * - 加 `diff` 的后果（实测）：二进制修复包从 `GIT binary patch`（ASCII，0 NUL）退化成含裸 NUL
 *   的伪文本 diff，无法安全贴进输入框走 JSON/IPC/模型上下文；且 `--numstat` 会把二进制
 *   报成 `1\t1` 而非 `-\t-`，污染二进制判定。字节保真完全不需要它。
 */
const INFO_ATTRIBUTES = "* -text -filter -working-tree-encoding\n";

/** 与工作区 `.gitignore` **叠加**（不是替代） */
const INFO_EXCLUDE = [
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

const DEFAULT_TIMEOUT_MS = 20_000;

/** git 二进制启发式的判定窗口：只扫前 8000 字节（实测确认，见 detectBinaryPaths） */
const GIT_BINARY_SNIFF_BYTES = 8000;

/** 扩展名白名单：git 的启发式靠不住（NUL 靠后就被当文本），先按扩展名兜住常见二进制 */
const BINARY_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"ico",
	"bmp",
	"tif",
	"tiff",
	"avif",
	"pdf",
	"zip",
	"gz",
	"tgz",
	"bz2",
	"xz",
	"zst",
	"tar",
	"7z",
	"rar",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	"mp3",
	"mp4",
	"m4a",
	"wav",
	"flac",
	"ogg",
	"mov",
	"webm",
	"avi",
	"mkv",
	"psd",
	"ai",
	"sketch",
	"fig",
	"xcf",
	"xlsx",
	"xls",
	"docx",
	"doc",
	"pptx",
	"ppt",
	"sqlite",
	"sqlite3",
	"db",
	"wasm",
	"so",
	"dll",
	"dylib",
	"exe",
	"class",
	"jar",
	"node",
	"o",
	"a",
	"lib",
	"pdb",
	"icns",
	"heic",
]);

export interface RunGitOptions {
	/** 喂给 stdin 的内容（`--stdin` 类命令用）；Buffer 用于 NUL 分隔的路径列表 */
	input?: string | Buffer;
	timeoutMs?: number;
	/** 覆盖 GIT_INDEX_FILE（私有 index，见 `withIndexFile`） */
	indexFile?: string;
}

/**
 * 派生一个「index 换成私有文件」的 repo 句柄（BUG F）。
 *
 * 同步的 `capture()` 与异步队列若共用同一个 index 文件，会在 `index.lock` 上撞车：
 * 基线首次打点要 3.2s，这期间第一轮 `turn_end` 的同步 `add -A` 直接
 * `fatal: Unable to create '...idx.lock': File exists` → 该轮快照静默丢失。
 * `write-tree` 同样占锁（实测异步 write-tree 与同步 add -A 并发 6 次 ok=1 fail=5）。
 *
 * 所以每次操作都复制 live index 到私有文件、在私有文件上跑、成功后原子前移回 live
 * （前移只为保住「下次仍是增量」，失败不影响正确性）。
 */
export function withIndexFile(repo: ShadowRepo, indexFile: string): ShadowRepo {
	return { ...repo, indexPath: indexFile };
}

/**
 * 统一出口：注入三环境变量 + 固定 config + 固定身份。
 * **stderr 不抛**（由调用方判 code）—— 冲突、缺 ref 等都是预期分支。
 */
/** 三环境变量 + 固定身份；同步与异步出口共用（改一处即可） */
function buildGitEnv(repo: ShadowRepo, indexFile?: string): Record<string, string> {
	const env: Record<string, string> = {
		...IDENTITY,
		GIT_DIR: repo.gitDir,
		GIT_WORK_TREE: repo.workTree,
		GIT_INDEX_FILE: indexFile ?? repo.indexPath,
		GIT_TERMINAL_PROMPT: "0",
	};
	for (const key of Object.keys(process.env)) {
		if (env[key] === undefined && process.env[key] !== undefined) env[key] = process.env[key] as string;
	}
	// 显式清掉可能继承来的 GIT_* 干扰项（GIT_NAMESPACE 等会让命令跑到别处）
	delete env.GIT_NAMESPACE;
	return env;
}

export async function runGit(
	repo: ShadowRepo,
	args: string[],
	opts: RunGitOptions = {},
): Promise<GitRunResult> {
	const env = buildGitEnv(repo, opts.indexFile);

	return new Promise<GitRunResult>((resolve) => {
		const child = execFile(
			"git",
			[...BASE_CONFIG, ...args],
			{
				cwd: repo.workTree,
				env,
				maxBuffer: 64 * 1024 * 1024,
				timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				encoding: "utf8",
			},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as { code?: unknown }).code === "number"
						? (error as { code: number }).code
						: error
							? 1
							: 0;
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
			},
		);
		if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		} else {
			child.stdin?.end();
		}
	});
}

/** 拿二进制输出的版本（读 blob 全文查 NUL 时必须用它，utf8 解码会破坏字节） */
async function runGitBuffer(
	repo: ShadowRepo,
	args: string[],
	opts: RunGitOptions = {},
): Promise<{ buffer: Buffer; code: number; stderr: string }> {
	const env = buildGitEnv(repo, opts.indexFile);
	return new Promise((resolve) => {
		const child = execFile(
			"git",
			[...BASE_CONFIG, ...args],
			{
				cwd: repo.workTree,
				env,
				maxBuffer: 256 * 1024 * 1024,
				timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				encoding: "buffer",
			},
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as { code?: unknown }).code === "number"
						? (error as { code: number }).code
						: error
							? 1
							: 0;
				resolve({
					buffer: (stdout as unknown as Buffer) ?? Buffer.alloc(0),
					code,
					stderr: ((stderr as unknown as Buffer) ?? Buffer.alloc(0)).toString("utf8"),
				});
			},
		);
		child.stdin?.end();
	});
}

/** `git --version` 探活；缺 git 时整个快照系统降级为 unavailable，绝不抛 */
export async function isGitAvailable(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("git", ["--version"], { timeout: 5_000 }, (error, stdout) => {
			resolve(!error && /git version/i.test(stdout ?? ""));
		});
	});
}

/**
 * 建影子库。**顺序不能反**：必须先在只设 `GIT_DIR` 的环境里 `init --bare`，
 * 三变量同时存在时 init 报 `fatal: GIT_WORK_TREE (or --work-tree=<directory>) not allowed
 * without specifying GIT_DIR`。
 */
export async function initShadowRepo(repo: ShadowRepo): Promise<void> {
	await mkdir(join(repo.gitDir, "info"), { recursive: true });
	await new Promise<void>((resolve, reject) => {
		const env: Record<string, string> = { GIT_DIR: repo.gitDir, GIT_TERMINAL_PROMPT: "0" };
		for (const key of Object.keys(process.env)) {
			if (key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE") continue;
			if (env[key] === undefined && process.env[key] !== undefined) env[key] = process.env[key] as string;
		}
		execFile(
			"git",
			["init", "--bare", "-q", repo.gitDir],
			{ env, timeout: DEFAULT_TIMEOUT_MS },
			(error, _stdout, stderr) => {
				if (error) reject(new Error(`git init --bare failed: ${stderr || error.message}`));
				else resolve();
			},
		);
	});
	await writeFile(join(repo.gitDir, "info", "attributes"), INFO_ATTRIBUTES, "utf8");
	await writeFile(join(repo.gitDir, "info", "exclude"), INFO_EXCLUDE, "utf8");
	await mkdir(join(repo.gitDir, "refs", "snap"), { recursive: true });
	log.debug("shadow repo initialized", repo.gitDir);
}

export interface SnapshotTreeResult {
	treeOid: string;
	/** 被剔除的路径（超大文件、嵌套仓库），仅调试用 */
	skipped: string[];
}

/**
 * 找出工作区里的嵌套 git 仓库（含未 commit 的）。
 *
 * ❗ 必须在 `git add -A` **之前**剔除：嵌套仓库若还没有任何 commit，`git add -A` 会以
 * **exit 128 直接失败**（`error: 'vendor/' does not have a commit checked out` /
 * `fatal: adding files failed`），不是「加进去再剔」。有 commit 的才会变成 `160000` gitlink。
 *
 * 用 `git ls-files -o --exclude-standard -z`（**不加 `--directory`**）：
 * - 加 `--directory` 会把**整个未跟踪目录**折叠成一个条目（不管它是不是仓库），
 *   于是 `src/vendor` 这种深层嵌套仓库会以 `src/` 的形式出现，`stat("src/.git")` 不存在
 *   → 被误判为普通目录 → `git add -A` 直接 128 失败。
 * - 不加时 git 逐个列出未跟踪文件，只把**真正的嵌套仓库**折叠成 `dir/`（带尾斜杠），
 *   所以 `endsWith("/")` 过滤依然成立。实测代价：本仓 25ms/174B → 30ms/36.9KB（index 全空的最坏情况）。
 * - 仍然 `stat(<dir>/.git)` 兜底，防 git 折叠了别的东西。
 */

/**
 * 现拍一棵树。
 *
 * 顺序：枚举嵌套仓库 → `add -A -- ':(exclude)...'` → 剔除超大文件 → 剔除 gitlink → `write-tree`。
 *
 * - 嵌套 git 仓库必须在 add **之前**用 pathspec 排除（未 commit 的嵌套仓库会让 add 直接 128 失败）。
 * - 超大文件按**磁盘 size** 判定（`update-index --force-remove`，磁盘文件不动）。
 * - 有 commit 的嵌套仓库仍会以 `160000` gitlink 进 index（`advice.addEmbeddedRepo=false` 只关提示
 *   不阻止入库），所以 add 之后还要再扫一遍兜底。
 */
export async function snapshotTree(
	repo: ShadowRepo,
	opts: { skipOverBytes: number; indexFile?: string },
): Promise<SnapshotTreeResult> {
	const skipped = captureIndex(repo, opts);
	const treeOid = await writeCapturedTree(repo, { indexFile: opts.indexFile });
	return { treeOid, skipped };
}

/**
 * 同步冻结 index —— **这是 BUG E 的解法**。
 *
 * `turn_end` 到下一轮真正写盘只隔 1–2ms（review 实测 +12ms / +14ms）。若打点只是
 * `void record(...)`（仅入队），排队轮到 `add -A` 时下一轮已经改完文件 → 两轮拍成同一棵树，
 * 撤回静默空转。所以 `turn_end` 回调里必须**同步**跑完 `add -A`：一旦 index 冻结，
 * 工作区之后怎么变都不影响这棵树（实测确认）。
 *
 * ⚠️ **会阻塞主线程**：`execFileSync` 跑几次 git（增量 30ms 量级；首轮全量 3.2s 一次性）。
 * 这是刻意的取舍 —— 一轮结束时的这点抖动，换的是「快照真的对应那一轮」。
 * 后续 `write-tree`/`commit-tree`/trim/persist 仍然异步（见 `writeCapturedTree`）。
 */
export function captureIndex(
	repo: ShadowRepo,
	opts: { skipOverBytes: number; indexFile?: string },
): string[] {
	const idx = opts.indexFile;
	const skipped: string[] = [];

	// 1) 嵌套仓库：add 之前排除（否则 add -A 直接失败）
	const nested = findNestedReposSync(repo, idx);
	const addArgs = ["add", "-A"];
	if (nested.length > 0) {
		addArgs.push("--");
		for (const dir of nested) addArgs.push(`:(exclude)${dir}`);
	}
	const added = runGitSync(repo, addArgs, undefined, idx);
	if (added.code !== 0) throw new Error(`git add -A failed: ${added.stderr.trim()}`);
	skipped.push(...nested);

	// 2) 超大文件：按磁盘真实大小判定
	const listed = runGitSync(repo, ["ls-files", "-z"], undefined, idx);
	if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
	const tooBig: string[] = [];
	for (const path of listed.stdout.split("\0")) {
		if (!path) continue;
		try {
			const st = statSync(join(repo.workTree, path));
			if (st.isFile() && st.size > opts.skipOverBytes) tooBig.push(path);
		} catch {
			// 快照期间被删掉的文件：留给 git 自己处理
		}
	}
	if (tooBig.length > 0) {
		forceRemoveFromIndexSync(repo, idx, tooBig);
		skipped.push(...tooBig);
	}

	// 3) gitlink 兜底（有 commit 的嵌套仓库会绕过第 1 步的 pathspec 排除）
	const staged = runGitSync(repo, ["ls-files", "-s", "-z"], undefined, idx);
	if (staged.code !== 0) throw new Error(`git ls-files -s failed: ${staged.stderr.trim()}`);
	const gitlinks: string[] = [];
	for (const entry of staged.stdout.split("\0")) {
		if (!entry.startsWith("160000 ")) continue;
		const tab = entry.indexOf("	");
		if (tab >= 0) gitlinks.push(entry.slice(tab + 1));
	}
	if (gitlinks.length > 0) {
		forceRemoveFromIndexSync(repo, idx, gitlinks);
		for (const link of gitlinks) if (!skipped.includes(link)) skipped.push(link);
	}

	return skipped;
}

/** 把 `captureIndex` 冻结的 index 落成 tree（异步，可安全排队） */
export async function writeCapturedTree(
	repo: ShadowRepo,
	opts: { indexFile?: string } = {},
): Promise<string> {
	const tree = await runGit(repo, ["write-tree"], { indexFile: opts.indexFile });
	if (tree.code !== 0) throw new Error(`git write-tree failed: ${tree.stderr.trim()}`);
	return tree.stdout.trim();
}

/** 同步版 `write-tree`：与 `captureIndex` 一起在 turn_end 回调里跑完，index 与树同时冻结 */
export function writeCapturedTreeSync(repo: ShadowRepo, opts: { indexFile?: string } = {}): string {
	const tree = runGitSync(repo, ["write-tree"], undefined, opts.indexFile);
	if (tree.code !== 0) throw new Error(`git write-tree failed: ${tree.stderr.trim()}`);
	return tree.stdout.trim();
}

/** `runGit` 的同步版：只给 `captureIndex` 用（必须在 turn_end 回调里跑完） */
function runGitSync(repo: ShadowRepo, args: string[], input?: string, indexFile?: string): GitRunResult {
	try {
		const stdout = execFileSync("git", [...BASE_CONFIG, ...args], {
			cwd: repo.workTree,
			env: buildGitEnv(repo, indexFile),
			...(input === undefined ? {} : { input }),
			maxBuffer: 64 * 1024 * 1024,
			timeout: DEFAULT_TIMEOUT_MS,
			encoding: "utf8",
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		return { stdout, stderr: "", code: 0 };
	} catch (error) {
		const e = error as { status?: number | null; stdout?: string; stderr?: string; code?: number };
		const code = typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : 1;
		return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code };
	}
}

function forceRemoveFromIndexSync(repo: ShadowRepo, indexFile: string | undefined, paths: string[]): void {
	if (paths.length === 0) return;
	// NUL 分隔避免路径里的空格/引号被转义
	const input = `${paths.join("\0")}\0`;
	const r = runGitSync(repo, ["update-index", "--force-remove", "-z", "--stdin"], input, indexFile);
	if (r.code !== 0) throw new Error(`update-index --force-remove failed: ${r.stderr.trim()}`);
}

function findNestedReposSync(repo: ShadowRepo, indexFile?: string): string[] {
	const listed = runGitSync(repo, ["ls-files", "-o", "--exclude-standard", "-z"], undefined, indexFile);
	if (listed.code !== 0) return [];
	const found: string[] = [];
	for (const entry of listed.stdout.split("\0")) {
		if (!entry.endsWith("/")) continue;
		const dir = entry.slice(0, -1);
		try {
			statSync(join(repo.workTree, dir, ".git"));
			found.push(dir);
		} catch {
			// 普通目录（非嵌套仓库），正常入库
		}
	}
	return found;
}

/** 把 tree 提交成 commit（影子库内部对象，仅调试可读；代码逻辑不依赖） */
export async function commitTree(repo: ShadowRepo, treeOid: string, message: string): Promise<string> {
	const r = await runGit(repo, ["commit-tree", treeOid, "-m", message]);
	if (r.code !== 0) throw new Error(`git commit-tree failed: ${r.stderr.trim()}`);
	return r.stdout.trim();
}

/** 两棵树之间有变化的路径（`git diff --name-only`，路径是相对 cwd 的 posix 形式） */
export async function diffPaths(repo: ShadowRepo, fromTree: string, toTree: string): Promise<string[]> {
	const r = await runGit(repo, ["diff", "--name-only", "-z", fromTree, toTree]);
	if (r.code !== 0) throw new Error(`git diff --name-only failed: ${r.stderr.trim()}`);
	return r.stdout.split("\0").filter(Boolean);
}

/**
 * 修复包全文（类别 A 冲突时塞进用户输入框让 agent 照着改回去）。
 * **不截断**：截断的 patch 无法 `git apply`。
 */
export async function diffPatch(repo: ShadowRepo, fromTree: string, toTree: string): Promise<string> {
	const r = await runGit(repo, ["diff", "--binary", fromTree, toTree]);
	if (r.code !== 0) throw new Error(`git diff --binary failed: ${r.stderr.trim()}`);
	return r.stdout;
}

export interface TreeEntry {
	mode: string;
	sha: string;
}

/** tree 的 path → {mode, sha} 映射 */
export async function listTree(repo: ShadowRepo, treeOid: string): Promise<Map<string, TreeEntry>> {
	const r = await runGit(repo, ["ls-tree", "-r", "-z", treeOid]);
	if (r.code !== 0) throw new Error(`git ls-tree failed: ${r.stderr.trim()}`);
	const map = new Map<string, TreeEntry>();
	for (const entry of r.stdout.split("\0")) {
		if (!entry) continue;
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const [mode, , sha] = entry.slice(0, tab).split(" ");
		if (!mode || !sha) continue;
		map.set(entry.slice(tab + 1), { mode, sha });
	}
	return map;
}

/** 读 blob 原始字节（二进制判定用，不能用 runGit 的 utf8 解码） */
export async function readBlob(repo: ShadowRepo, sha: string): Promise<Buffer> {
	const r = await runGitBuffer(repo, ["cat-file", "blob", sha]);
	if (r.code !== 0) throw new Error(`git cat-file blob failed: ${r.stderr.trim()}`);
	return r.buffer;
}

/**
 * 显式二进制判定 —— **不要依赖 git 的启发式**。
 *
 * git 只扫文件前 8000 字节找 NUL；NUL 在 8000 字节之后（或压根没有 NUL 的压缩流）就会被当文本，
 * `merge-tree` 静默做行级合并，产出一份半坏的文件（实测：2000 行文件、NUL 在字节 39026 时
 * `merge-tree` exit 0 且无冲突），违反 spec 3.1「二进制没法按行合并 → 类别 A 冲突」。
 *
 * 判定来源取三者并集：
 * 1. 扩展名白名单（最常见的图像/压缩/字体/音视频/设计稿/文档/数据库/可执行）
 * 2. `git diff --numstat` 输出 `-` 的路径（覆盖白名单之外、无扩展名的二进制）
 * 3. 兜底：对剩余候选读 blob **全文**查 NUL（不是只看前 8000 字节）
 *
 * @param opts.fromTree 比较基线（窗口起点，通常是 `base`）
 * @param opts.oursTree 当前工作区快照树
 * @param opts.paths 候选路径（相对 cwd 的 posix 形式）
 */
export async function detectBinaryPaths(
	repo: ShadowRepo,
	opts: { fromTree: string; oursTree: string; paths: string[] },
): Promise<Set<string>> {
	const { fromTree, oursTree, paths } = opts;
	const result = new Set<string>();
	if (paths.length === 0) return result;

	// 1) 扩展名白名单
	for (const path of paths) {
		const dot = path.lastIndexOf(".");
		const slash = path.lastIndexOf("/");
		if (dot > slash && dot >= 0) {
			const ext = path.slice(dot + 1).toLowerCase();
			if (BINARY_EXTENSIONS.has(ext)) result.add(path);
		}
	}

	// 2) numstat 的 `-`
	// ❗ 必须传**两棵树**：`git diff <tree>` 是「tree 对工作区」，而本函数调用时工作区刚被
	// `snapshotTree` 拍过（内容与 oursTree 完全一致）→ 只传一个树时输出恒为空，这一支就是死代码。
	const numstat = await runGit(repo, ["diff", "--numstat", "-z", fromTree, oursTree]);
	if (numstat.code === 0) {
		// -z 格式：`<add>\t<del>\t<path>\0`（rename 时多一段 path\0，此处不关心）
		for (const chunk of numstat.stdout.split("\0")) {
			if (!chunk) continue;
			const first = chunk.indexOf("\t");
			const second = chunk.indexOf("\t", first + 1);
			if (first < 0 || second < 0) continue;
			if (chunk.slice(0, first) === "-" && chunk.slice(first + 1, second) === "-") {
				result.add(chunk.slice(second + 1));
			}
		}
	}

	// 3) 兜底：读 blob 全文查 NUL
	const tree = await listTree(repo, oursTree);
	for (const path of paths) {
		if (result.has(path)) continue;
		const entry = tree.get(path);
		if (!entry) continue; // ours 里没有 = 已被删，没有二进制风险
		let buffer: Buffer;
		try {
			buffer = await readBlob(repo, entry.sha);
		} catch {
			continue;
		}
		if (buffer.includes(0)) result.add(path);
	}
	return result;
}

/**
 * 「缩窄范围」：以 `baseTree` 为底，只把 `scope` 里的路径替换成 `theirsTree` 的样子。
 * 返回的树交给 `mergeTrees` 当 theirs，从而保证窗口外（非独占会话改的路径）不受影响。
 */
export async function buildFilteredTree(
	repo: ShadowRepo,
	baseTree: string,
	theirsTree: string,
	scope: string[],
): Promise<string> {
	const reset = await runGit(repo, ["read-tree", baseTree]);
	if (reset.code !== 0) throw new Error(`git read-tree failed: ${reset.stderr.trim()}`);
	if (scope.length === 0) {
		const tree = await runGit(repo, ["write-tree"]);
		if (tree.code !== 0) throw new Error(`git write-tree failed: ${tree.stderr.trim()}`);
		return tree.stdout.trim();
	}

	const theirs = await listTree(repo, theirsTree);
	const ZERO = "0000000000000000000000000000000000000000";
	const lines: string[] = [];
	for (const path of scope) {
		const entry = theirs.get(path);
		lines.push(entry ? `${entry.mode} ${entry.sha}\t${path}` : `0 ${ZERO}\t${path}`);
	}
	// -z + --index-info：一次进程写入，NUL 分隔避免路径转义
	const applied = await runGit(repo, ["update-index", "-z", "--index-info"], {
		input: `${lines.join("\0")}\0`,
	});
	if (applied.code !== 0) throw new Error(`git update-index --index-info failed: ${applied.stderr.trim()}`);
	const tree = await runGit(repo, ["write-tree"]);
	if (tree.code !== 0) throw new Error(`git write-tree failed: ${tree.stderr.trim()}`);
	return tree.stdout.trim();
}

export interface MergeResult {
	/** 合并树 OID；`failed` 为 true 时为空串 */
	treeOid: string;
	/** 冲突路径（已去重） */
	conflicts: string[];
	/**
	 * `merge-tree` 非预期失败（缺对象 / 超时 / git 报错），**不是冲突**。
	 * 冲突是预期分支（`failed === false` 且 `conflicts` 非空）。
	 * 调用方必须检查这个标志 —— 否则会把「失败」当「无冲突」继续，
	 * 最后在 `checkoutTree("")` 抛一个与真实原因无关的错。
	 */
	failed: boolean;
}

/**
 * 三路合并。**不因 exit code 抛错**：冲突是预期分支，冲突行在 stdout。
 *
 * stdout 形如：
 * ```
 * <treeOid>
 * 100644 <sha> 1\t<path>
 * 100644 <sha> 2\t<path>
 * 100644 <sha> 3\t<path>
 * ```
 * 同一路径会出现 3 次（stage 1/2/3），必须去重。
 */
export async function mergeTrees(
	repo: ShadowRepo,
	opts: { base: string; ours: string; theirs: string },
): Promise<MergeResult> {
	const r = await runGit(repo, [
		"merge-tree",
		"--write-tree",
		`--merge-base=${opts.base}`,
		opts.ours,
		opts.theirs,
	]);
	const lines = r.stdout.split("\n");
	const treeOid = (lines[0] ?? "").trim();
	const conflicts: string[] = [];
	const seen = new Set<string>();
	const re = /^\d{6} [0-9a-f]+ [123]\t(.+)$/;
	for (const line of lines.slice(1)) {
		const m = re.exec(line);
		if (!m) continue;
		const path = m[1] as string;
		if (seen.has(path)) continue;
		seen.add(path);
		conflicts.push(path);
	}
	// 二进制冲突时 merge-tree 会把原因写到 stderr（"Cannot merge binary files"），此时 stdout 可能没有 tree
	if (!/^[0-9a-f]{40,64}$/.test(treeOid)) {
		return { treeOid: "", conflicts, failed: conflicts.length === 0 };
	}
	return { treeOid, conflicts, failed: false };
}

/** 落地：`read-tree -u --reset`。**调用前 index 必须停在目标树的父状态**（调用方负责） */
export async function checkoutTree(repo: ShadowRepo, treeOid: string): Promise<void> {
	const r = await runGit(repo, ["read-tree", "-u", "--reset", treeOid]);
	if (r.code !== 0) throw new Error(`git read-tree -u --reset failed: ${r.stderr.trim()}`);
}

/** 只重置 index（不碰工作区）。`mergeTrees` 前必须把 index 拨回 ours 树 */
export async function resetIndexTo(repo: ShadowRepo, treeOid: string): Promise<void> {
	const r = await runGit(repo, ["read-tree", treeOid]);
	if (r.code !== 0) throw new Error(`git read-tree failed: ${r.stderr.trim()}`);
}

/** 删快照 ref（保留窗口裁剪 / 会话删除时用） */
export async function deleteSnapshots(repo: ShadowRepo, refs: string[]): Promise<void> {
	for (const ref of refs) {
		// 不存在的 ref 返回 128，属正常（同一 turnIndex 可能只 push 了元数据没建 commit）
		await runGit(repo, ["update-ref", "-d", ref]);
	}
}

/** 回收不可达对象。失败只记日志，绝不阻断调用方 */
export async function gcShadowRepo(repo: ShadowRepo): Promise<void> {
	const repack = await runGit(repo, ["repack", "-a", "-d", "-q"], { timeoutMs: 120_000 });
	if (repack.code !== 0) {
		log.warn("shadow repo repack failed", repo.gitDir, repack.stderr.trim().slice(0, 200));
		return;
	}
	const prune = await runGit(repo, ["prune", "--expire=now"], { timeoutMs: 120_000 });
	if (prune.code !== 0) log.warn("shadow repo prune failed", repo.gitDir, prune.stderr.trim().slice(0, 200));
}

/** 会话删除：清掉影子库 + index + 元数据 */
export async function removeShadowRepo(repo: ShadowRepo, metaPath?: string): Promise<void> {
	const targets = [repo.gitDir, repo.indexPath];
	if (metaPath) targets.push(metaPath);
	for (const target of targets) {
		await rm(target, { recursive: true, force: true }).catch((err: unknown) => {
			log.warn("shadow repo remove failed", target, String(err));
		});
	}
}

/** 影子库当前占用字节数（诊断/日志用） */
export async function shadowRepoSize(repo: ShadowRepo): Promise<number> {
	let total = 0;
	const walk = async (dir: string): Promise<void> => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) await walk(p);
			else {
				try {
					total += (await stat(p)).size;
				} catch {
					// ignore
				}
			}
		}
	};
	await walk(repo.gitDir);
	return total;
}

/** 读文件内容（元数据 JSON 用；测试与调试） */
export async function readTextFile(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

/** 供测试使用的常量（避免测试重复硬编码） */
export const SHADOW_CONSTANTS = {
	INFO_ATTRIBUTES,
	INFO_EXCLUDE,
	BINARY_EXTENSIONS,
	GIT_BINARY_SNIFF_BYTES,
	DEFAULT_TIMEOUT_MS,
} as const;
