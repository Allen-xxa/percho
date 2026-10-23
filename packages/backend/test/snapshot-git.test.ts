import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildFilteredTree,
	checkoutTree,
	commitTree,
	deleteSnapshots,
	detectBinaryPaths,
	diffPatch,
	diffPaths,
	gcShadowRepo,
	initShadowRepo,
	isGitAvailable,
	listTree,
	mergeTrees,
	readBlob,
	removeShadowRepo,
	resetIndexTo,
	runGit,
	SHADOW_CONSTANTS,
	type ShadowRepo,
	snapshotTree,
} from "../src/session/snapshot-git";
import {
	INFO_ATTRIBUTES as FIXTURE_ATTRIBUTES,
	INFO_EXCLUDE as FIXTURE_EXCLUDE,
	makePlayground,
	md5,
	projectDir,
	rawGit,
	shadowOf,
} from "./helpers/snapshot-fixture";

const SKIP_OVER = 1024 * 1024;

let playground: { root: string; cleanup: () => void };
let repo: ShadowRepo;

function setup(name = "p"): ShadowRepo {
	const wt = projectDir(playground.root, name);
	const sh = shadowOf(wt, playground.root, name);
	return { gitDir: sh.gitDir, workTree: sh.workTree, indexPath: sh.indexPath };
}

async function snap(): Promise<string> {
	return (await snapshotTree(repo, { skipOverBytes: SKIP_OVER })).treeOid;
}

async function gitAvail(): Promise<boolean> {
	return isGitAvailable();
}

beforeEach(async () => {
	playground = makePlayground();
	repo = setup();
	if (!(await gitAvail())) return;
	await initShadowRepo(repo);
});

afterEach(() => {
	playground.cleanup();
});

describe("snapshot-git：影子库基本机制", () => {
	it("实现常量与测试夹具一致（防止两处漂移）", () => {
		expect(SHADOW_CONSTANTS.INFO_ATTRIBUTES).toBe(FIXTURE_ATTRIBUTES);
		expect(SHADOW_CONSTANTS.INFO_EXCLUDE).toBe(FIXTURE_EXCLUDE);
		expect(SHADOW_CONSTANTS.INFO_ATTRIBUTES).not.toContain("diff");
	});

	it("initShadowRepo 建出裸库 + info/attributes + info/exclude", async () => {
		if (!(await gitAvail())) return;
		expect(existsSync(join(repo.gitDir, "HEAD"))).toBe(true);
		const attributes = readFileSync(join(repo.gitDir, "info", "attributes"), "utf8");
		expect(attributes).toBe("* -text -filter -working-tree-encoding\n");
		// diff 属性绝不能出现（否则二进制修复包含裸 NUL，见 REVIEW §1）
		expect(attributes).not.toContain("diff");
		const exclude = readFileSync(join(repo.gitDir, "info", "exclude"), "utf8");
		expect(exclude).toContain("node_modules/");
		expect(exclude).toContain(".local/");
	});

	it("不碰用户 .git：工作区 .git 不进快照", async () => {
		if (!(await gitAvail())) return;
		mkdirSync(join(repo.workTree, ".git"), { recursive: true });
		writeFileSync(join(repo.workTree, ".git", "config"), "fake\n");
		writeFileSync(join(repo.workTree, "a.txt"), "a\n");
		const tree = await snap();
		const entries = await listTree(repo, tree);
		expect([...entries.keys()]).toEqual(["a.txt"]);
	});

	it("工作区 .gitignore 与 info/exclude 叠加生效", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, ".gitignore"), "ignored-by-gitignore/\n");
		mkdirSync(join(repo.workTree, "ignored-by-gitignore"), { recursive: true });
		writeFileSync(join(repo.workTree, "ignored-by-gitignore", "x.txt"), "x\n");
		mkdirSync(join(repo.workTree, "node_modules"), { recursive: true });
		writeFileSync(join(repo.workTree, "node_modules", "y.js"), "y\n");
		writeFileSync(join(repo.workTree, "app.log"), "log\n");
		mkdirSync(join(repo.workTree, "sub"), { recursive: true });
		writeFileSync(join(repo.workTree, "sub", "keep.txt"), "k\n");
		const tree = await snap();
		const paths = [...(await listTree(repo, tree)).keys()].sort();
		expect(paths).toEqual([".gitignore", "sub/keep.txt"]);
	});

	it("CRLF/LF/mixed 三文件字节保真（入站 + 写回）", async () => {
		if (!(await gitAvail())) return;
		const files: Record<string, string> = {
			"crlf.txt": "a\r\nb\r\nc\r\n",
			"lf.txt": "a\nb\nc\n",
			"mixed.txt": "a\r\nb\nc\r\n",
		};
		const before: Record<string, string> = {};
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(repo.workTree, name), content);
			before[name] = md5(content);
		}
		const tree = await snap();
		const entries = await listTree(repo, tree);
		for (const [name, want] of Object.entries(before)) {
			const entry = entries.get(name);
			expect(entry).toBeDefined();
			expect(md5(await readBlob(repo, entry?.sha as string))).toBe(want);
		}
		// 破坏后写回
		for (const name of Object.keys(files)) writeFileSync(join(repo.workTree, name), "DESTROYED\n");
		await checkoutTree(repo, tree);
		for (const [name, want] of Object.entries(before)) {
			expect(md5(readFileSync(join(repo.workTree, name)))).toBe(want);
		}
	});

	it(".gitattributes 的 text 属性被 info/attributes 压住（含嵌套目录）", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, ".gitattributes"), "* text=auto\n");
		mkdirSync(join(repo.workTree, "sub"), { recursive: true });
		writeFileSync(join(repo.workTree, "sub", ".gitattributes"), "* text=auto eol=crlf\n");
		const files: Record<string, string> = {
			"root.txt": "a\r\nb\nc\r\n",
			"sub/inner.txt": "x\r\ny\nz\r\n",
		};
		const before: Record<string, string> = {};
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(join(repo.workTree, name), content);
			before[name] = md5(content);
		}
		const tree = await snap();
		const entries = await listTree(repo, tree);
		for (const [name, want] of Object.entries(before)) {
			expect(md5(await readBlob(repo, entries.get(name)?.sha as string))).toBe(want);
		}
		for (const name of Object.keys(files)) writeFileSync(join(repo.workTree, name), "DESTROYED\n");
		await checkoutTree(repo, tree);
		for (const [name, want] of Object.entries(before)) {
			expect(md5(readFileSync(join(repo.workTree, name)))).toBe(want);
		}
	});

	it("嵌套仓库（无 commit）被排除：裸 add -A 会直接 128 失败", async () => {
		if (!(await gitAvail())) return;
		mkdirSync(join(repo.workTree, "vendor"), { recursive: true });
		writeFileSync(join(repo.workTree, "vendor", "v.txt"), "v\n");
		await rawGit(null, ["init", "-q", join(repo.workTree, "vendor")]);
		writeFileSync(join(repo.workTree, "a.txt"), "a\n");
		const result = await snapshotTree(repo, { skipOverBytes: SKIP_OVER });
		expect(result.skipped).toContain("vendor");
		const entries = await listTree(repo, result.treeOid);
		expect([...entries.keys()].sort()).toEqual(["a.txt"]);

		// 反证：裸 add -A 会失败（"does not have a commit checked out"），所以必须先排除
		const raw = await runGit(repo, ["add", "-A"]);
		expect(raw.code).toBe(128);
		expect(raw.stderr).toContain("does not have a commit checked out");
	});

	it("深层嵌套仓库（无 commit）也被排除：父目录里有普通文件", async () => {
		if (!(await gitAvail())) return;
		// review BUG 1：`--directory` 会把整个 `src/` 折叠成一个条目，导致 `src/vendor` 漏检。
		// 去掉 `--directory` 后 git 逐个列未跟踪文件，只把真嵌套仓库折叠成 `src/vendor/`。
		mkdirSync(join(repo.workTree, "src", "vendor"), { recursive: true });
		writeFileSync(join(repo.workTree, "src", "app.ts"), "export {};\n");
		writeFileSync(join(repo.workTree, "src", "vendor", "v.txt"), "v\n");
		await rawGit(null, ["init", "-q", join(repo.workTree, "src", "vendor")]);

		const result = await snapshotTree(repo, { skipOverBytes: SKIP_OVER });
		expect(result.skipped).toContain("src/vendor");
		expect([...(await listTree(repo, result.treeOid)).keys()].sort()).toEqual(["src/app.ts"]);
	});

	it("多层深层嵌套仓库（无 commit）同时被排除", async () => {
		if (!(await gitAvail())) return;
		mkdirSync(join(repo.workTree, "a", "b", "c", "vendor2"), { recursive: true });
		writeFileSync(join(repo.workTree, "a", "b", "c", "keep.txt"), "k\n");
		writeFileSync(join(repo.workTree, "a", "b", "c", "vendor2", "v.txt"), "v\n");
		await rawGit(null, ["init", "-q", join(repo.workTree, "a", "b", "c", "vendor2")]);

		const result = await snapshotTree(repo, { skipOverBytes: SKIP_OVER });
		expect(result.skipped).toContain("a/b/c/vendor2");
		expect([...(await listTree(repo, result.treeOid)).keys()].sort()).toEqual(["a/b/c/keep.txt"]);
	});

	it("嵌套仓库（有 commit）的 gitlink 也会被剔除", async () => {
		if (!(await gitAvail())) return;
		const nested = join(repo.workTree, "vendor");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "v.txt"), "v\n");
		await rawGit(null, ["-C", nested, "init", "-q"]);
		await rawGit(null, ["-C", nested, "add", "-A"]);
		await rawGit(null, ["-C", nested, "commit", "-q", "-m", "init"]);
		writeFileSync(join(repo.workTree, "a.txt"), "a\n");

		const result = await snapshotTree(repo, { skipOverBytes: SKIP_OVER });
		expect(result.skipped).toContain("vendor");
		expect([...(await listTree(repo, result.treeOid)).keys()].sort()).toEqual(["a.txt"]);

		// 反证：有 commit 的嵌套仓库，裸 add -A 会产出 160000 gitlink
		await runGit(repo, ["update-index", "--force-remove", "vendor"]);
		const raw = await runGit(repo, ["add", "-A"]);
		expect(raw.code).toBe(0);
		const staged = await runGit(repo, ["ls-files", "-s"]);
		expect(staged.stdout).toContain("160000");
	});

	it("深层嵌套仓库（有 commit）的 gitlink 也被剔除", async () => {
		if (!(await gitAvail())) return;
		const nested = join(repo.workTree, "src", "vendor");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "v.txt"), "v\n");
		await rawGit(null, ["-C", nested, "init", "-q"]);
		await rawGit(null, ["-C", nested, "add", "-A"]);
		await rawGit(null, ["-C", nested, "commit", "-q", "-m", "init"]);
		writeFileSync(join(repo.workTree, "src", "app.ts"), "export {};\n");

		const result = await snapshotTree(repo, { skipOverBytes: SKIP_OVER });
		expect(result.skipped).toContain("src/vendor");
		expect([...(await listTree(repo, result.treeOid)).keys()].sort()).toEqual(["src/app.ts"]);
	});

	it("超大文件被剔除但磁盘文件不动", async () => {
		if (!(await gitAvail())) return;
		const big = Buffer.alloc(2 * 1024 * 1024, 7);
		writeFileSync(join(repo.workTree, "big.bin"), big);
		writeFileSync(join(repo.workTree, "small.txt"), "s\n");
		const before = md5(readFileSync(join(repo.workTree, "big.bin")));
		const result = await snapshotTree(repo, { skipOverBytes: SKIP_OVER });
		expect(result.skipped).toContain("big.bin");
		const paths = [...(await listTree(repo, result.treeOid)).keys()].sort();
		expect(paths).toEqual(["small.txt"]);
		expect(md5(readFileSync(join(repo.workTree, "big.bin")))).toBe(before);
	});
});

describe("snapshot-git：commit / diff / merge", () => {
	it("commitTree 注入身份后成功", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, "a.txt"), "a\n");
		const tree = await snap();
		const commit = await commitTree(repo, tree, "test");
		expect(commit).toMatch(/^[0-9a-f]{40}$/);
	});

	it("diffPaths 列出变化路径", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, "a.txt"), "1\n");
		writeFileSync(join(repo.workTree, "b.txt"), "1\n");
		const t0 = await snap();
		writeFileSync(join(repo.workTree, "a.txt"), "2\n");
		const t1 = await snap();
		expect(await diffPaths(repo, t0, t1)).toEqual(["a.txt"]);
	});

	it("mergeTrees 无冲突时返回合并树", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, "f.txt"), "l1\nl2\nl3\nl4\nl5\n");
		const base = await snap();
		// theirs：改第 1 行
		writeFileSync(join(repo.workTree, "f.txt"), "T1\nl2\nl3\nl4\nl5\n");
		const theirs = await snap();
		// ours：改第 5 行
		writeFileSync(join(repo.workTree, "f.txt"), "l1\nl2\nl3\nl4\nO5\n");
		const ours = await snap();
		const merged = await mergeTrees(repo, { base, ours, theirs });
		expect(merged.conflicts).toEqual([]);
		expect(merged.treeOid).toMatch(/^[0-9a-f]{40}$/);
		await checkoutTree(repo, merged.treeOid);
		expect(readFileSync(join(repo.workTree, "f.txt"), "utf8")).toBe("T1\nl2\nl3\nl4\nO5\n");
	});

	it("mergeTrees 冲突时返回去重后的路径", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, "f.txt"), "l1\nl2\nl3\n");
		const base = await snap();
		writeFileSync(join(repo.workTree, "f.txt"), "T1\nl2\nl3\n");
		const theirs = await snap();
		writeFileSync(join(repo.workTree, "f.txt"), "O1\nl2\nl3\n");
		const ours = await snap();
		const merged = await mergeTrees(repo, { base, ours, theirs });
		expect(merged.conflicts).toEqual(["f.txt"]);
	});

	it("buildFilteredTree 只把 scope 内路径换成 theirs 的样子", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, "in.txt"), "base\n");
		writeFileSync(join(repo.workTree, "out.txt"), "base\n");
		const base = await snap();
		writeFileSync(join(repo.workTree, "in.txt"), "theirs\n");
		writeFileSync(join(repo.workTree, "out.txt"), "theirs\n");
		const theirs = await snap();
		const filtered = await buildFilteredTree(repo, base, theirs, ["in.txt"]);
		const entries = await listTree(repo, filtered);
		expect(md5(await readBlob(repo, entries.get("in.txt")?.sha as string))).toBe(md5("theirs\n"));
		expect(md5(await readBlob(repo, entries.get("out.txt")?.sha as string))).toBe(md5("base\n"));
	});

	it("buildFilteredTree 对 scope 内「theirs 已删」的路径写入删除项", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, "gone.txt"), "x\n");
		writeFileSync(join(repo.workTree, "keep.txt"), "k\n");
		const base = await snap();
		rmFile(join(repo.workTree, "gone.txt"));
		const theirs = await snap();
		const filtered = await buildFilteredTree(repo, base, theirs, ["gone.txt"]);
		const entries = await listTree(repo, filtered);
		expect(entries.has("gone.txt")).toBe(false);
		expect(entries.has("keep.txt")).toBe(true);
	});

	it("resetIndexTo + checkoutTree 能把工作区退回旧树，并删掉之后新建的文件", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, "a.txt"), "v1\n");
		const t0 = await snap();
		writeFileSync(join(repo.workTree, "a.txt"), "v2\n");
		writeFileSync(join(repo.workTree, "new.txt"), "n\n");
		const t1 = await snap();
		// index 停在 t1 时直接 checkout t0：new.txt 会被删掉
		expect(t1).not.toBe(t0);
		await resetIndexTo(repo, t1);
		await checkoutTree(repo, t0);
		expect(readFileSync(join(repo.workTree, "a.txt"), "utf8")).toBe("v1\n");
		expect(existsSync(join(repo.workTree, "new.txt"))).toBe(false);
	});
});

describe("snapshot-git：二进制判定", () => {
	it("扩展名白名单命中", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, "img.png"), "not really a png\n");
		writeFileSync(join(repo.workTree, "doc.md"), "# text\n");
		const tree = await snap();
		const bins = await detectBinaryPaths(repo, {
			fromTree: tree,
			oursTree: tree,
			paths: ["img.png", "doc.md"],
		});
		expect(bins.has("img.png")).toBe(true);
		expect(bins.has("doc.md")).toBe(false);
	});

	it("无扩展名但含 NUL 的文件被兜底识别", async () => {
		if (!(await gitAvail())) return;
		const buf = Buffer.alloc(64, 65);
		buf[10] = 0;
		writeFileSync(join(repo.workTree, "blobfile"), buf);
		writeFileSync(join(repo.workTree, "plain"), "plain text\n");
		const tree = await snap();
		const bins = await detectBinaryPaths(repo, {
			fromTree: tree,
			oursTree: tree,
			paths: ["blobfile", "plain"],
		});
		expect(bins.has("blobfile")).toBe(true);
		expect(bins.has("plain")).toBe(false);
	});

	it("NUL 在 8000 字节之后仍被识别（git 的启发式会漏）", async () => {
		if (!(await gitAvail())) return;
		const buf = Buffer.alloc(40000, 65);
		buf[39026] = 0;
		writeFileSync(join(repo.workTree, "late.dat"), buf);
		const tree = await snap();
		const bins = await detectBinaryPaths(repo, { fromTree: tree, oursTree: tree, paths: ["late.dat"] });
		expect(bins.has("late.dat")).toBe(true);
	});

	it("numstat 分支真的在工作：两棵树之间变化的二进制会被抓到", async () => {
		if (!(await gitAvail())) return;
		// review BUG 2：原来传单个树（= tree 对工作区）恒为空，这一支是死代码。
		// 现在传两棵树。为了证明是 numstat 在起作用（而不是全文查 NUL 兜底），
		// 故意把 bin.dat 排除在 paths 之外 —— 全文扫描只遍历 paths。
		const mk = (fill: number): Buffer => {
			const b = Buffer.alloc(64, fill);
			b[10] = 0;
			return b;
		};
		writeFileSync(join(repo.workTree, "bin.dat"), mk(65));
		writeFileSync(join(repo.workTree, "note.txt"), "note\n");
		const t0 = await snap();
		writeFileSync(join(repo.workTree, "bin.dat"), mk(66));
		const t1 = await snap();
		const bins = await detectBinaryPaths(repo, { fromTree: t0, oursTree: t1, paths: ["note.txt"] });
		expect(bins.has("bin.dat")).toBe(true);
		expect(bins.has("note.txt")).toBe(false);
	});

	it("二进制修复包是 GIT binary patch 且 0 个 NUL", async () => {
		if (!(await gitAvail())) return;
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from(Array.from({ length: 400 }, (_, i) => (i * 37 + 11) % 256)),
		]);
		writeFileSync(join(repo.workTree, "img.png"), png);
		const t0 = await snap();
		const png2 = Buffer.from(png);
		png2[100] = ((png2[100] ?? 0) + 1) % 256;
		writeFileSync(join(repo.workTree, "img.png"), png2);
		const t1 = await snap();
		const patch = await diffPatch(repo, t0, t1);
		expect(patch).toContain("GIT binary patch");
		expect(Buffer.from(patch, "utf8").filter((b) => b === 0).length).toBe(0);
	});
});

describe("snapshot-git：回收与删除", () => {
	it("deleteSnapshots + gcShadowRepo 让旧 tree 消失", async () => {
		if (!(await gitAvail())) return;
		writeFileSync(join(repo.workTree, "a.txt"), "v1\n");
		const t1 = await snap();
		const c1 = await commitTree(repo, t1, "c1");
		await runGit(repo, ["update-ref", "refs/snap/1", c1]);
		writeFileSync(join(repo.workTree, "a.txt"), "v2\n");
		const t2 = await snap();
		const c2 = await commitTree(repo, t2, "c2");
		await runGit(repo, ["update-ref", "refs/snap/2", c2]);
		expect((await runGit(repo, ["cat-file", "-t", t1])).code).toBe(0);
		await deleteSnapshots(repo, ["refs/snap/1"]);
		await gcShadowRepo(repo);
		// 旧 tree 不可达后 cat-file 返回 128
		expect((await runGit(repo, ["cat-file", "-t", t1])).code).toBe(128);
	});

	it("removeShadowRepo 清掉 gitDir 与 index", async () => {
		if (!(await gitAvail())) return;
		expect(existsSync(repo.gitDir)).toBe(true);
		await removeShadowRepo(repo);
		expect(existsSync(repo.gitDir)).toBe(false);
	});
});

function rmFile(path: string): void {
	rmSync(path, { force: true });
}
