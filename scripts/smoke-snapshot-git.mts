// 阶段 0 冒烟：影子 git 库快照/撤回的机制断言（plan §0.1 的 14 条）。
// 在 os.tmpdir() 造 playground，**绝不碰本仓库**（第 14 条只读跑一次 add -A 做性能基线）。
//
// 用法：node node_modules/jiti/lib/jiti-cli.mjs scripts/smoke-snapshot-git.mts
//       （全过 exit 0；任一失败 exit 1）
// ❗ 必须走 jiti：仓库内 .ts 源用无扩展名相对导入（`from "./json-store"`），
//    node 原生类型剥离跑不动（ERR_MODULE_NOT_FOUND）。`node scripts/smoke-*.mts` 同样不行，
//    既有 smoke-error-events.mts 也是这个前提。
//
// ❗ 阶段 0 实测发现的关键事实（HANDOFF 未覆盖，已回写 channel）：
//   1. 工作区 `.gitattributes` 的 `* text=auto` 会让 `git add` 把 CRLF 归一化成 LF 存进 blob，
//      写回时 checkout filter 又反向转换 → 纯行尾混杂文件被静默改写（第 5 条原设计失败）。
//   2. 补救：影子库 `<GIT_DIR>/info/attributes` 写 `* -text -filter -working-tree-encoding`，
//      该文件优先级最高（压过任意深度的 `.gitattributes`），入站与写回两个方向都不过滤，
//      且 `merge-tree` 的行级合并仍然正常（`-text` 只关 eol 归一化，不把文件当二进制）。
//   3. **绝对不要加 `diff` 属性**（review 实测）：加了之后 `git diff --binary` 对二进制退化成
//      含裸 NUL 的伪文本 diff（PNG：332B/0 NUL → 1785B/40 NUL），无法安全贴进输入框；
//      且 `git diff --numstat` 会把二进制报成 `1\t1` 而不是 `-\t-`，污染二进制判定。
//      字节保真完全不需要 `diff`。
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const exec = promisify(execFile);

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
	results.push({ name, ok, detail });
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const playground = mkdtempSync(join(tmpdir(), "percho-smoke-snap-git-"));
console.log(`[setup] playground: ${playground}`);

const IDENTITY = {
	GIT_AUTHOR_NAME: "percho",
	GIT_AUTHOR_EMAIL: "snapshot@local",
	GIT_COMMITTER_NAME: "percho",
	GIT_COMMITTER_EMAIL: "snapshot@local",
};

interface Shadow {
	gitDir: string;
	workTree: string;
	indexPath: string;
}

const shadowOf = (root: string, name = "s"): Shadow => ({
	gitDir: join(root, "snap", `${name}.git`),
	workTree: join(root, "wt"),
	indexPath: join(root, "snap", `${name}.index`),
});

/** 跑 git：默认导出三环境变量 + 固定 config；stderr 不抛（由调用方看 code）。 */
async function git(
	sh: Shadow | null,
	args: string[],
	opts: { cwd?: string; input?: string; env?: Record<string, string>; noIdentity?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const env: Record<string, string> = {
		...process.env,
		...(opts.noIdentity ? {} : IDENTITY),
		GIT_TERMINAL_PROMPT: "0",
		...(opts.env ?? {}),
	};
	if (sh) {
		env.GIT_DIR = sh.gitDir;
		env.GIT_WORK_TREE = sh.workTree;
		env.GIT_INDEX_FILE = sh.indexPath;
	}
	const fullArgs = [
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
		...args,
	];
	try {
		const { stdout, stderr } = await exec("git", fullArgs, {
			cwd: opts.cwd ?? sh?.workTree ?? playground,
			env,
			maxBuffer: 64 * 1024 * 1024,
			timeout: 60_000,
		});
		return { stdout, stderr, code: 0 };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; code?: number };
		return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
	}
}

/** 用 stdin 传 input 的变体（execFile 的 input 需走 spawn 的 stdin）。 */
async function gitStdin(
	sh: Shadow | null,
	args: string[],
	input: string,
	opts: { cwd?: string } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const env: Record<string, string> = { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: "0" };
	if (sh) {
		env.GIT_DIR = sh.gitDir;
		env.GIT_WORK_TREE = sh.workTree;
		env.GIT_INDEX_FILE = sh.indexPath;
	}
	return await new Promise((resolve) => {
		const child = spawn(
			"git",
			[
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
				...args,
			],
			{ cwd: opts.cwd ?? sh?.workTree ?? playground, env },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
		child.stdin.end(input);
	});
}

const md5 = (buf: Buffer | string): string => createHash("md5").update(buf).digest("hex");
const fileMd5 = (p: string): string => md5(readFileSync(p));

/** info/attributes：压制一切 text/filter/encoding 转换（阶段 0 实测结论）。 */
const INFO_ATTRIBUTES = "* -text -filter -working-tree-encoding\n";

/** info/exclude：与工作区 .gitignore 叠加（不是替代）。 */
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

async function initShadow(sh: Shadow): Promise<void> {
	mkdirSync(join(sh.gitDir, ".."), { recursive: true });
	// ❗ 必须在只设 GIT_DIR 的环境里 init --bare：三变量同时存在时 init 会 fatal。
	const env: Record<string, string> = { ...process.env, ...IDENTITY, GIT_DIR: sh.gitDir };
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
		const child = spawn("git", ["init", "--bare", "-q", sh.gitDir], { env });
		let stderr = "";
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
	});
	if (r.code !== 0) throw new Error(`init --bare failed: ${r.stderr}`);
	writeFileSync(join(sh.gitDir, "info", "attributes"), INFO_ATTRIBUTES);
	writeFileSync(join(sh.gitDir, "info", "exclude"), INFO_EXCLUDE);
	// 固定 config（也可每次 -c，这里落盘一次）
	await git(sh, ["config", "core.autocrlf", "false"]);
	await git(sh, ["config", "gc.auto", "0"]);
}

/** 枚举候选路径：已跟踪（ls-files -s）+ 未跟踪未忽略（ls-files -o --exclude-standard）。 */
async function listCandidatePaths(sh: Shadow): Promise<string[]> {
	const tracked = await git(sh, ["ls-files", "-z"]);
	const untracked = await git(sh, ["ls-files", "-o", "--exclude-standard", "-z"]);
	const split = (s: string): string[] => s.split("\0").filter((p) => p.length > 0);
	return [...new Set([...split(tracked.stdout), ...split(untracked.stdout)])].sort();
}

/** 快照：add -A → 剔除超限路径 → write-tree。 */
async function snapshotTree(sh: Shadow, skipOverBytes: number): Promise<{ treeOid: string; skipped: string[] }> {
	await git(sh, ["add", "-A"]);
	// 用 index 里的路径 + 磁盘 size 判定（首次快照没有 HEAD，不能用 ls-tree HEAD）
	const candidates = await listCandidatePaths(sh);
	const skipped: string[] = [];
	for (const rel of candidates) {
		const abs = join(sh.workTree, rel);
		try {
			const st = lstatSync(abs);
			if (st.isFile() && st.size > skipOverBytes) skipped.push(rel);
		} catch {
			// 已消失
		}
	}
	if (skipped.length > 0) {
		const r = await gitStdin(sh, ["update-index", "--force-remove", "-z", "--stdin"], skipped.join("\0") + "\0");
		if (r.code !== 0) throw new Error(`force-remove failed: ${r.stderr}`);
	}
	// 嵌套 git 仓库会被 `add -A` 记成 gitlink（mode 160000）——必须剔除，否则快照里只有个指针。
	const lsFiles = await git(sh, ["ls-files", "-s", "-z"]);
	const gitlinks = lsFiles.stdout
		.split("\0")
		.filter((line) => line.startsWith("160000 "))
		.map((line) => line.slice(line.indexOf("\t") + 1));
	if (gitlinks.length > 0) {
		const r = await gitStdin(sh, ["update-index", "--force-remove", "-z", "--stdin"], gitlinks.join("\0") + "\0");
		if (r.code !== 0) throw new Error(`force-remove gitlinks failed: ${r.stderr}`);
	}
	const w = await git(sh, ["write-tree"]);
	if (w.code !== 0) throw new Error(`write-tree failed: ${w.stderr}`);
	return { treeOid: w.stdout.trim(), skipped };
}

async function main(): Promise<void> {
	// ============ 1. init --bare 后再导出三环境变量可用 ============
	console.log("\n=== 1. init --bare 后三环境变量可用 ===");
	{
		const root = join(playground, "p1");
		mkdirSync(join(root, "wt"), { recursive: true });
		writeFileSync(join(root, "wt", "a.txt"), "hello\n");
		const sh = shadowOf(root);
		await initShadow(sh);
		const r = await git(sh, ["status", "--porcelain"]);
		check("1 init 后 git 命令可用", r.code === 0, `code=${r.code} stderr=${r.stderr.trim().slice(0, 120)}`);
		// 反证：三变量同时导出时 init 会 fatal
		const bad = await git(sh, ["init", "--bare", "-q", join(root, "snap", "x.git")]);
		check(
			"1 反证：三变量同时导出时 init 报错",
			bad.code !== 0,
			`code=${bad.code} stderr=${bad.stderr.trim().split("\n")[0]?.slice(0, 120)}`,
		);
	}

	// ============ 2. 工作区 .git/ 不进快照 ============
	console.log("\n=== 2. 工作区 .git/ 不进快照 ===");
	{
		const root = join(playground, "p2");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, "a.txt"), "hello\n");
		// 工作区自己有一个真实 git 仓库
		await exec("git", ["init", "-q"], { cwd: wt });
		await exec("git", ["add", "-A"], { cwd: wt });
		await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: wt });
		const sh = shadowOf(root);
		await initShadow(sh);
		const { treeOid } = await snapshotTree(sh, 1024 * 1024);
		const ls = await git(sh, ["ls-tree", "-r", "--name-only", treeOid]);
		const paths = ls.stdout.split("\n").filter(Boolean);
		check(
			"2 .git/ 未进快照",
			!paths.some((p) => p === ".git" || p.startsWith(".git/")),
			`paths=${JSON.stringify(paths)}`,
		);
		check("2 a.txt 进了快照", paths.includes("a.txt"), `paths=${JSON.stringify(paths)}`);
	}

	// ============ 3. .gitignore 与 info/exclude 叠加生效 ============
	console.log("\n=== 3. .gitignore 与 info/exclude 叠加 ===");
	{
		const root = join(playground, "p3");
		const wt = join(root, "wt");
		mkdirSync(join(wt, "node_modules"), { recursive: true });
		mkdirSync(join(wt, "sub"), { recursive: true });
		writeFileSync(join(wt, ".gitignore"), "ignored-by-gitignore/\n");
		mkdirSync(join(wt, "ignored-by-gitignore"), { recursive: true });
		writeFileSync(join(wt, "ignored-by-gitignore", "x.txt"), "x\n");
		writeFileSync(join(wt, "node_modules", "m.js"), "m\n");
		writeFileSync(join(wt, "sub", "keep.txt"), "k\n");
		writeFileSync(join(wt, "app.log"), "log\n");
		const sh = shadowOf(root);
		await initShadow(sh);
		const { treeOid } = await snapshotTree(sh, 1024 * 1024);
		const ls = await git(sh, ["ls-tree", "-r", "--name-only", treeOid]);
		const paths = ls.stdout.split("\n").filter(Boolean);
		check("3 .gitignore 生效", !paths.some((p) => p.startsWith("ignored-by-gitignore/")), JSON.stringify(paths));
		check("3 info/exclude 生效（node_modules）", !paths.some((p) => p.startsWith("node_modules/")), JSON.stringify(paths));
		check("3 info/exclude 生效（*.log）", !paths.includes("app.log"), JSON.stringify(paths));
		check("3 正常文件保留", paths.includes("sub/keep.txt"), JSON.stringify(paths));
	}

	// ============ 4. CRLF 文件字节一致 ============
	console.log("\n=== 4. CRLF 字节一致（无 .gitattributes） ===");
	{
		const root = join(playground, "p4");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const files = { "crlf.txt": "a\r\nb\r\nc\r\n", "lf.txt": "a\nb\nc\n", "mixed.txt": "a\r\nb\nc\r\n" };
		for (const [n, c] of Object.entries(files)) writeFileSync(join(wt, n), c);
		const sh = shadowOf(root);
		await initShadow(sh);
		const before = Object.fromEntries(Object.keys(files).map((n) => [n, fileMd5(join(wt, n))]));
		const { treeOid } = await snapshotTree(sh, 1024 * 1024);
		// 破坏全部文件
		for (const n of Object.keys(files)) writeFileSync(join(wt, n), "DESTROYED\n");
		const r = await git(sh, ["read-tree", "-u", "--reset", treeOid]);
		check("4 read-tree 成功", r.code === 0, r.stderr.trim().slice(0, 200));
		for (const n of Object.keys(files)) {
			check(`4 ${n} 字节一致`, fileMd5(join(wt, n)) === before[n], `md5 ${before[n]?.slice(0, 8)}`);
		}
	}

	// ============ 5. .gitattributes（* text=auto）下仍字节一致 ============
	console.log("\n=== 5. .gitattributes * text=auto 下字节一致 ===");
	{
		const root = join(playground, "p5");
		const wt = join(root, "wt");
		mkdirSync(join(wt, "sub"), { recursive: true });
		writeFileSync(join(wt, ".gitattributes"), "* text=auto\n");
		writeFileSync(join(wt, "sub", ".gitattributes"), "* text=auto eol=crlf\n");
		const files: Record<string, string> = {
			"crlf.txt": "a\r\nb\r\nc\r\n",
			"mixed.txt": "a\r\nb\nc\r\n",
			"sub/inner.txt": "m\r\nn\r\n",
		};
		for (const [n, c] of Object.entries(files)) writeFileSync(join(wt, n), c);
		const sh = shadowOf(root);
		await initShadow(sh);
		const before = Object.fromEntries(Object.keys(files).map((n) => [n, fileMd5(join(wt, n))]));
		const { treeOid } = await snapshotTree(sh, 1024 * 1024);
		// blob 必须与磁盘字节完全一致（证明入站没被 filter 改写）
		const lsFiles = await git(sh, ["ls-files", "-s", "-z"]);
		const entries = lsFiles.stdout
			.split("\0")
			.filter(Boolean)
			.map((line) => {
				const tab = line.indexOf("\t");
				const [mode, sha] = line.slice(0, tab).split(" ");
				return { mode: mode ?? "", sha: sha ?? "", path: line.slice(tab + 1) };
			});
		for (const n of Object.keys(files)) {
			const e = entries.find((x) => x.path === n);
			if (!e) {
				check(`5 ${n} 在 index 里`, false);
				continue;
			}
			const blob = await git(sh, ["cat-file", "-p", e.sha]);
			check(
				`5 ${n} blob 字节与磁盘一致`,
				md5(blob.stdout) === before[n],
				`blob=${md5(blob.stdout).slice(0, 8)} disk=${before[n]?.slice(0, 8)}`,
			);
		}
		// 写回方向：破坏后撤回，字节必须一致
		for (const n of Object.keys(files)) writeFileSync(join(wt, n), "DESTROYED\n");
		rmSync(join(wt, "sub", ".gitattributes"));
		const r = await git(sh, ["read-tree", "-u", "--reset", treeOid]);
		check("5 read-tree 成功", r.code === 0, r.stderr.trim().slice(0, 200));
		for (const n of Object.keys(files)) {
			check(`5 ${n} 撤回后字节一致`, fileMd5(join(wt, n)) === before[n], `md5 ${before[n]?.slice(0, 8)}`);
		}
		check(
			"5 被删的 sub/.gitattributes 被还原",
			existsSync(join(wt, "sub", ".gitattributes")),
			`exists=${existsSync(join(wt, "sub", ".gitattributes"))}`,
		);
	}

	// ============ 6. 嵌套 git 仓库不进快照（gitlink） ============
	console.log("\n=== 6. 嵌套 git 仓库不成为 gitlink ===");
	{
		const root = join(playground, "p6");
		const wt = join(root, "wt");
		const vendor = join(wt, "vendor");
		mkdirSync(vendor, { recursive: true });
		writeFileSync(join(wt, "a.txt"), "a\n");
		writeFileSync(join(vendor, "lib.txt"), "lib\n");
		await exec("git", ["init", "-q"], { cwd: vendor });
		await exec("git", ["add", "-A"], { cwd: vendor });
		await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "v"], { cwd: vendor });
		const sh = shadowOf(root);
		await initShadow(sh);
		const { treeOid } = await snapshotTree(sh, 1024 * 1024);
		const lsTree = await git(sh, ["ls-tree", "-r", treeOid]);
		const lines = lsTree.stdout.split("\n").filter(Boolean);
		const hasGitlink = lines.some((l) => l.startsWith("160000"));
		check("6 快照树里无 gitlink 条目", !hasGitlink, `ls-tree:\n${lsTree.stdout.trim().slice(0, 400)}`);
		// 反证：裸 `add -A` 确实会产生 gitlink（证明剔除是必要的，不是碰巧）
		const root2 = join(playground, "p6b");
		const wt2 = join(root2, "wt");
		const vendor2 = join(wt2, "vendor");
		mkdirSync(vendor2, { recursive: true });
		writeFileSync(join(wt2, "a.txt"), "a\n");
		writeFileSync(join(vendor2, "lib.txt"), "lib\n");
		await exec("git", ["init", "-q"], { cwd: vendor2 });
		await exec("git", ["add", "-A"], { cwd: vendor2 });
		await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "v"], { cwd: vendor2 });
		const sh2 = shadowOf(root2);
		await initShadow(sh2);
		await git(sh2, ["add", "-A"]);
		const raw = await git(sh2, ["ls-files", "-s"]);
		check(
			"6 反证：裸 add -A 会产生 gitlink",
			raw.stdout.split("\n").some((l) => l.startsWith("160000")),
			`ls-files -s:\n${raw.stdout.trim().slice(0, 300)}`,
		);
		const fr = await git(sh2, ["update-index", "--force-remove", "vendor"]);
		check(
			"6 update-index --force-remove 剔除 gitlink",
			fr.code === 0 && !(await git(sh2, ["ls-files", "-s"])).stdout.split("\n").some((l) => l.startsWith("160000")),
			`code=${fr.code} stderr=${fr.stderr.trim().slice(0, 120)}`,
		);
	}

	// ============ 7. 超 1MB 路径剔除，磁盘文件不动 ============
	console.log("\n=== 7. 超 1MB 剔除但磁盘不动 ===");
	{
		const root = join(playground, "p7");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const big = Buffer.alloc(1024 * 1024 + 100, 0x41);
		writeFileSync(join(wt, "big.bin"), big);
		writeFileSync(join(wt, "small.txt"), "small\n");
		const sh = shadowOf(root);
		await initShadow(sh);
		const { treeOid, skipped } = await snapshotTree(sh, 1024 * 1024);
		const ls = await git(sh, ["ls-tree", "-r", "--name-only", treeOid]);
		const paths = ls.stdout.split("\n").filter(Boolean);
		check("7 big.bin 被剔除", !paths.includes("big.bin"), `skipped=${JSON.stringify(skipped)}`);
		check("7 skipped 报告 big.bin", skipped.includes("big.bin"), JSON.stringify(skipped));
		check("7 small.txt 保留", paths.includes("small.txt"), JSON.stringify(paths));
		check("7 磁盘 big.bin 仍在且字节未变", existsSync(join(wt, "big.bin")) && fileMd5(join(wt, "big.bin")) === md5(big));
	}

	// ============ 8. merge-tree 冲突解析 ============
	console.log("\n=== 8. merge-tree 输出解析 ===");
	{
		const root = join(playground, "p8");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const sh = shadowOf(root);
		await initShadow(sh);
		const mk = async (content: string): Promise<string> => {
			writeFileSync(join(wt, "f.txt"), content);
			await git(sh, ["add", "-A"]);
			const t = await git(sh, ["write-tree"]);
			return t.stdout.trim();
		};
		const base = await mk("l1\nl2\nl3\n");
		const theirs = await mk("T1\nl2\nl3\n");
		const ours = await mk("O1\nl2\nl3\n"); // 与 theirs 同处冲突
		const r = await git(sh, ["merge-tree", "--write-tree", `--merge-base=${base}`, ours, theirs]);
		check("8 冲突时 exit 1", r.code === 1, `code=${r.code}`);
		check("8 冲突信息在 stdout（stderr 空）", r.stderr.trim() === "", `stderr=${JSON.stringify(r.stderr.slice(0, 120))}`);
		const re = /^(\d{6}) ([0-9a-f]+) ([123])\t(.+)$/gm;
		const conflicts: string[] = [];
		let m: RegExpExecArray | null = re.exec(r.stdout);
		while (m !== null) {
			if (m[4]) conflicts.push(m[4]);
			m = re.exec(r.stdout);
		}
		check(
			"8 冲突路径可从 stdout 解析",
			[...new Set(conflicts)].length === 1 && conflicts[0] === "f.txt",
			`conflicts=${JSON.stringify([...new Set(conflicts)])}`,
		);
		const firstLine = r.stdout.split("\n")[0]?.trim() ?? "";
		check("8 首行是 tree OID", /^[0-9a-f]{40}$/.test(firstLine), `first=${firstLine}`);

		// 无冲突场景
		const ours2 = await mk("O1\nl2\nl3\n");
		const theirs2 = await mk("l1\nl2\nT3\n");
		const ok = await git(sh, ["merge-tree", "--write-tree", `--merge-base=${base}`, ours2, theirs2]);
		check("8 无冲突 exit 0", ok.code === 0, `code=${ok.code} stderr=${ok.stderr.slice(0, 120)}`);
		check("8 无冲突首行 tree OID", /^[0-9a-f]{40}$/.test(ok.stdout.split("\n")[0]?.trim() ?? ""));
	}

	// ============ 9. 行级合并正确 ============
	console.log("\n=== 9. 行级合并：base 改第1行 + ours 改第8行 → 两者都保留 ===");
	{
		const root = join(playground, "p9");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const sh = shadowOf(root);
		await initShadow(sh);
		const mk = async (content: string): Promise<string> => {
			writeFileSync(join(wt, "f.txt"), content);
			await git(sh, ["add", "-A"]);
			const t = await git(sh, ["write-tree"]);
			return t.stdout.trim();
		};
		const original = "orig1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n";
		const theirs = await mk(original); // theirs = 快照前的原始内容
		const base = await mk("AGENT1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n"); // base = agent 改完第1行
		const ours = await mk("orig1\nl2\nl3\nl4\nl5\nl6\nl7\nUSER8\nl9\n"); // ours = 用户改第8行
		const r = await git(sh, ["merge-tree", "--write-tree", `--merge-base=${base}`, ours, theirs]);
		check("9 merge 无冲突", r.code === 0, r.stderr.slice(0, 200));
		const mergedTree = r.stdout.split("\n")[0]?.trim() ?? "";
		const ls = await git(sh, ["ls-tree", "-r", mergedTree]);
		const sha = ls.stdout.split("\n").find((l) => l.endsWith("\tf.txt"))?.split(/\s+/)[2] ?? "";
		const blob = await git(sh, ["cat-file", "-p", sha]);
		const expected = "orig1\nl2\nl3\nl4\nl5\nl6\nl7\nUSER8\nl9\n";
		check("9 第1行回到原始", blob.stdout.split("\n")[0] === "orig1", JSON.stringify(blob.stdout.split("\n")[0]));
		check("9 第8行保留用户改动", blob.stdout.split("\n")[7] === "USER8", JSON.stringify(blob.stdout.split("\n")[7]));
		check("9 全文匹配", blob.stdout === expected, JSON.stringify(blob.stdout.slice(0, 120)));
	}

	// ============ 10. 用户新建文件撤回后保留 ============
	console.log("\n=== 10. 用户新建的文件撤回后保留 ===");
	{
		const root = join(playground, "p10");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const sh = shadowOf(root);
		await initShadow(sh);
		const mk = async (files: Record<string, string>): Promise<string> => {
			for (const [n, c] of Object.entries(files)) writeFileSync(join(wt, n), c);
			await git(sh, ["add", "-A"]);
			const t = await git(sh, ["write-tree"]);
			return t.stdout.trim();
		};
		// theirs = agent 改动前的快照；base = agent 改动后；ours = 用户额外新建 user.txt
		const theirs = await mk({ "a.txt": "a\n" });
		const base = await mk({ "a.txt": "a\n", "agent.txt": "from agent\n" });
		const ours = await mk({ "a.txt": "a\n", "agent.txt": "from agent\n", "user.txt": "mine\n" });
		const r = await git(sh, ["merge-tree", "--write-tree", `--merge-base=${base}`, ours, theirs]);
		const mergedTree = r.stdout.split("\n")[0]?.trim() ?? "";
		const ls = await git(sh, ["ls-tree", "-r", "--name-only", mergedTree]);
		const paths = ls.stdout.split("\n").filter(Boolean);
		check("10 user.txt 保留", paths.includes("user.txt"), JSON.stringify(paths));
		check("10 agent.txt 被移除", !paths.includes("agent.txt"), JSON.stringify(paths));
		check("10 a.txt 保留", paths.includes("a.txt"), JSON.stringify(paths));
	}

	// ============ 11. read-tree -u --reset 落地 + 不碰 exclude 路径 ============
	console.log("\n=== 11. read-tree -u --reset 落地 ===");
	{
		const root = join(playground, "p11");
		const wt = join(root, "wt");
		mkdirSync(join(wt, "node_modules"), { recursive: true });
		writeFileSync(join(wt, "node_modules", "keep.js"), "keep\n");
		writeFileSync(join(wt, "a.txt"), "a\n");
		const sh = shadowOf(root);
		await initShadow(sh);
		const mk = async (files: Record<string, string>, rm: string[] = []): Promise<string> => {
			for (const [n, c] of Object.entries(files)) writeFileSync(join(wt, n), c);
			for (const n of rm) rmSync(join(wt, n));
			await git(sh, ["add", "-A"]);
			const t = await git(sh, ["write-tree"]);
			return t.stdout.trim();
		};
		const theirs = await mk({ "a.txt": "a\n" });
		const base = await mk({ "a.txt": "a\n", "agent-new.txt": "agent\n" });
		const ours = await mk({ "a.txt": "a\n", "agent-new.txt": "agent\n" });
		// 用户后来改过 a.txt（ours 树里体现）
		const oursReal = await mk({ "a.txt": "a-user\n", "agent-new.txt": "agent\n" });
		const merged = await git(sh, ["merge-tree", "--write-tree", `--merge-base=${base}`, oursReal, theirs]);
		const mergedTree = merged.stdout.split("\n")[0]?.trim() ?? "";
		// ❗ 落地前 index 必须停在 ours 树上
		await git(sh, ["read-tree", oursReal]);
		const r = await git(sh, ["read-tree", "-u", "--reset", mergedTree]);
		check("11 read-tree 成功", r.code === 0, r.stderr.slice(0, 200));
		check("11 agent-new.txt 被删除", !existsSync(join(wt, "agent-new.txt")), `exists=${existsSync(join(wt, "agent-new.txt"))}`);
		// theirs 的 a.txt 与 base 相同（agent 没动）→ 合并结果取 ours，即用户的改动被保留
		check("11 a.txt 保留用户改动", readFileSync(join(wt, "a.txt"), "utf8") === "a-user\n", JSON.stringify(readFileSync(join(wt, "a.txt"), "utf8")));
		check("11 node_modules 未被动（exclude 路径）", existsSync(join(wt, "node_modules", "keep.js")));
		void ours;

		// 反证：先 reset 到 theirs 再 read-tree，agent-new.txt 删不掉
		const root2 = join(playground, "p11b");
		const wt2 = join(root2, "wt");
		mkdirSync(wt2, { recursive: true });
		const sh2 = shadowOf(root2);
		await initShadow(sh2);
		const mk2 = async (files: Record<string, string>, rm: string[] = []): Promise<string> => {
			for (const [n, c] of Object.entries(files)) writeFileSync(join(wt2, n), c);
			for (const n of rm) rmSync(join(wt2, n));
			await git(sh2, ["add", "-A"]);
			const t = await git(sh2, ["write-tree"]);
			return t.stdout.trim();
		};
		const theirs2 = await mk2({ "a.txt": "a\n" });
		const base2 = await mk2({ "a.txt": "a\n", "agent-new.txt": "agent\n" });
		await git(sh2, ["read-tree", theirs2]); // ❌ 错误的做法：index 停在 theirs
		await git(sh2, ["read-tree", "-u", "--reset", theirs2]);
		check(
			"11 反证：index 停在 theirs 时 agent-new.txt 删不掉",
			existsSync(join(wt2, "agent-new.txt")),
			`exists=${existsSync(join(wt2, "agent-new.txt"))} (index=${theirs2.slice(0, 8)} base=${base2.slice(0, 8)})`,
		);
	}

	// ============ 12. 删 ref + repack/prune 让旧 tree 消失 ============
	console.log("\n=== 12. repack + prune 回收 ===");
	{
		const root = join(playground, "p12");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const sh = shadowOf(root);
		await initShadow(sh);
		writeFileSync(join(wt, "a.txt"), "v1\n");
		await git(sh, ["add", "-A"]);
		const t1 = (await git(sh, ["write-tree"])).stdout.trim();
		const c1 = (
			await git(sh, ["commit-tree", t1, "-m", "c1"], {})
		).stdout.trim();
		await git(sh, ["update-ref", "refs/snap/c1", c1]);
		writeFileSync(join(wt, "a.txt"), "v2\n");
		await git(sh, ["add", "-A"]);
		const t2 = (await git(sh, ["write-tree"])).stdout.trim();
		const c2 = (await git(sh, ["commit-tree", t2, "-m", "c2"], {})).stdout.trim();
		await git(sh, ["update-ref", "refs/snap/c2", c2]);
		const beforeType = await git(sh, ["cat-file", "-t", t1]);
		check("12 prune 前旧 tree 存在", beforeType.code === 0 && beforeType.stdout.trim() === "tree", `type=${beforeType.stdout.trim()}`);
		await git(sh, ["update-ref", "-d", "refs/snap/c1"]);
		const rp = await git(sh, ["repack", "-a", "-d", "-q"]);
		const pr = await git(sh, ["prune", "--expire=now"]);
		const afterType = await git(sh, ["cat-file", "-t", t1]);
		check(
			"12 prune 后旧 tree 消失（cat-file 128）",
			afterType.code === 128,
			`code=${afterType.code} repack=${rp.code} prune=${pr.code} stderr=${afterType.stderr.trim().slice(0, 120)}`,
		);
	}

	// ============ 13. commit-tree 需要身份 ============
	console.log("\n=== 13. commit-tree 需要 GIT_AUTHOR_*/GIT_COMMITTER_* ===");
	{
		const root = join(playground, "p13");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, "a.txt"), "a\n");
		const sh = shadowOf(root);
		await initShadow(sh);
		await git(sh, ["add", "-A"]);
		const t = (await git(sh, ["write-tree"])).stdout.trim();
		// 清空身份 + 无 HOME/config → 应报错
		const env: Record<string, string> = { ...process.env, GIT_DIR: sh.gitDir, GIT_WORK_TREE: sh.workTree, GIT_INDEX_FILE: sh.indexPath };
		delete env.GIT_AUTHOR_NAME;
		delete env.GIT_AUTHOR_EMAIL;
		delete env.GIT_COMMITTER_NAME;
		delete env.GIT_COMMITTER_EMAIL;
		env.HOME = join(playground, "emptyhome");
		env.XDG_CONFIG_HOME = join(playground, "emptyhome");
		env.GIT_CONFIG_GLOBAL = join(playground, "emptyhome", "gitconfig");
		env.GIT_CONFIG_NOSYSTEM = "1";
		const r = await git(null, ["commit-tree", t, "-m", "x"], { env, noIdentity: true });
		check(
			"13 缺身份时 commit-tree 失败",
			r.code !== 0,
			`code=${r.code} stderr=${r.stderr.trim().split("\n").slice(0, 2).join(" | ").slice(0, 200)}`,
		);
		// 带上身份后成功
		const ok = await git(sh, ["commit-tree", t, "-m", "x"]);
		check("13 带身份时成功", ok.code === 0 && /^[0-9a-f]{40}$/.test(ok.stdout.trim()), `code=${ok.code}`);
	}

	// ============ 14. 本仓库性能基线（只读） ============
	console.log("\n=== 14. 本仓库 add -A 性能基线（只读，不提交） ===");
	{
		const repoRoot = process.cwd();
		const isRepo = existsSync(join(repoRoot, ".git"));
		if (!isRepo) {
			console.log("  (跳过：当前目录不是 git 仓库)");
		} else {
			const root = join(playground, "p14");
			const wt = join(root, "wt");
			mkdirSync(wt, { recursive: true });
			// 用 git archive 式复制太慢；改用本仓库 worktree 只读枚举 + 影子库快照
			// ❗ 绝不写本仓库：影子库 GIT_WORK_TREE 指向本仓库，但只做 add/write-tree（不 checkout）
			const sh: Shadow = {
				gitDir: join(root, "snap", "s.git"),
				workTree: repoRoot,
				indexPath: join(root, "snap", "s.index"),
			};
			await initShadow(sh);
			const t0 = Date.now();
			const first = await snapshotTree(sh, 1024 * 1024);
			const firstMs = Date.now() - t0;
			const t1 = Date.now();
			const second = await snapshotTree(sh, 1024 * 1024);
			const secondMs = Date.now() - t1;
			let repoBytes = 0;
			const walk = (dir: string): void => {
				let entries: string[] = [];
				try {
					entries = readdirSync(dir);
				} catch {
					return;
				}
				for (const name of entries) {
					const p = join(dir, name);
					try {
						const st = lstatSync(p);
						if (st.isDirectory()) walk(p);
						else repoBytes += st.size;
					} catch {
						// ignore
					}
				}
			};
			walk(sh.gitDir);
			const files = (await git(sh, ["ls-tree", "-r", "--name-only", first.treeOid])).stdout.split("\n").filter(Boolean).length;
			console.log(
				`  文件数=${files} 首次=${firstMs}ms 二次=${secondMs}ms 影子库=${(repoBytes / 1024 / 1024).toFixed(1)}M skipped=${first.skipped.length}`,
			);
			check("14 首次快照 < 30s", firstMs < 30_000, `${firstMs}ms files=${files}`);
			check("14 二次快照 < 5s", secondMs < 5_000, `${secondMs}ms`);
			check("14 二次与首次 tree 相同", first.treeOid === second.treeOid, `${first.treeOid.slice(0, 8)} vs ${second.treeOid.slice(0, 8)}`);
		}
	}

	// ============ 15. 二进制不被 diff 属性污染（review 阶段新增） ============
	// `info/attributes` 里绝不能有 `diff`：加了之后 `git diff --binary` 对二进制退化成含裸 NUL
	// 的伪文本 diff（无法安全贴进输入框），且 `--numstat` 会把二进制报成 `1\t1` 而不是 `-\t-`。
	console.log("\n=== 15. 二进制：numstat 报 -/- 、修复包无 NUL ===");
	{
		const root = join(playground, "p15");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		const sh = shadowOf(root);
		await initShadow(sh);
		// PNG 魔数 + 随机字节，确保 git 一眼认成二进制
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 37 + 11) % 256)),
		]);
		writeFileSync(join(wt, "img.png"), png);
		await git(sh, ["add", "-A"]);
		const t0 = (await git(sh, ["write-tree"])).stdout.trim();
		// 改一个字节再快照
		const png2 = Buffer.from(png);
		png2[100] = (png2[100]! + 1) % 256;
		writeFileSync(join(wt, "img.png"), png2);
		await git(sh, ["add", "-A"]);
		const t1 = (await git(sh, ["write-tree"])).stdout.trim();

		const numstat = (await git(sh, ["diff", "--numstat", t0, t1])).stdout.trim();
		check("15 numstat 把 PNG 报成 -/-", numstat.startsWith("-\t-\t"), JSON.stringify(numstat));

		const patch = (await git(sh, ["diff", "--binary", t0, t1])).stdout;
		const nulCount = Buffer.from(patch, "utf8").filter((b) => b === 0).length;
		check("15 修复包含 GIT binary patch", patch.includes("GIT binary patch"), `len=${patch.length}`);
		check("15 修复包 0 个 NUL（可安全过 JSON/IPC/模型）", nulCount === 0, `NUL=${nulCount}`);
		check("15 修复包纯 ASCII", /^[\x09\x0a\x20-\x7e]*$/.test(patch), `len=${patch.length}`);

		// 字节保真不靠 diff：写回后 md5 必须等于快照时刻磁盘上的 md5
		// （不能用 `cat-file -p` 拿 stdout 算 md5 —— git() 走 utf8 解码，二进制会被破坏）
		const wantMd5 = md5(png);
		await git(sh, ["read-tree", "-u", "--reset", t0]);
		const backMd5 = md5(readFileSync(join(wt, "img.png")));
		check("15 去掉 diff 后二进制字节仍保真", wantMd5 === backMd5, `want=${wantMd5.slice(0, 8)} disk=${backMd5.slice(0, 8)}`);
	}

	// ============ 16. git 二进制启发式只看前 8000 字节（阶段 1 detectBinaryPaths 的依据） ============
	// NUL 在 8000 字节之后 → git 当文本 → merge-tree 静默行级合并 → 产出半坏文件，
	// 违反 spec 3.1「二进制没法按行合并 → 类别 A 冲突」。所以不能依赖 git 的启发式。
	console.log("\n=== 16. 二进制启发式只看前 8000 字节 ===");
	{
		const build = async (nulOffset: number, name: string): Promise<{ late: boolean; lateMergeCode: number }> => {
			const root = join(playground, name);
			const wt = join(root, "wt");
			mkdirSync(wt, { recursive: true });
			const sh = shadowOf(root);
			await initShadow(sh);
			const mk = (line3: string, line1995: string): Buffer => {
				const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}\n`);
				lines[2] = `${line3}\n`;
				lines[1994] = `${line1995}\n`;
				const buf = Buffer.from(lines.join(""));
				if (nulOffset >= 0) buf[nulOffset] = 0;
				return buf;
			};
			writeFileSync(join(wt, "f.dat"), mk("base3", "base1995"));
			await git(sh, ["add", "-A"]);
			const base = (await git(sh, ["write-tree"])).stdout.trim();
			writeFileSync(join(wt, "f.dat"), mk("theirs3", "base1995"));
			await git(sh, ["add", "-A"]);
			const theirs = (await git(sh, ["write-tree"])).stdout.trim();
			writeFileSync(join(wt, "f.dat"), mk("base3", "ours1995"));
			await git(sh, ["add", "-A"]);
			const ours = (await git(sh, ["write-tree"])).stdout.trim();
			const m = await git(sh, ["merge-tree", "--write-tree", `--merge-base=${base}`, ours, theirs]);
			return { late: m.code === 0 && !/Cannot merge binary/.test(m.stdout + m.stderr), lateMergeCode: m.code };
		};
		const early = await build(156, "p16a");
		const late = await build(39026, "p16b");
		check("16 NUL 在前 8000 字节内 → 冲突（git 认得出二进制）", early.lateMergeCode === 1, `code=${early.lateMergeCode}`);
		check(
			"16 NUL 在 8000 字节之后 → git 静默行级合并（所以必须自己判二进制）",
			late.late === true,
			`code=${late.lateMergeCode}`,
		);
	}

	// ================= 汇总 =================
	const failed = results.filter((r) => !r.ok);
	console.log(`\n${"=".repeat(60)}`);
	console.log(`总计 ${results.length} 条，通过 ${results.length - failed.length}，失败 ${failed.length}`);
	if (failed.length > 0) {
		console.log("失败项：");
		for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
	}
	console.log(`playground: ${playground}`);
	if (process.env.KEEP_PLAYGROUND !== "1") {
		try {
			rmSync(playground, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
	process.exit(failed.length > 0 ? 1 : 0);
}

await main();
