import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGitAvailable } from "../src/session/snapshot-git";
import { normalizeLedgerPaths, SessionSnapshots } from "../src/session/snapshots";
import { makePlayground, md5, rawGit } from "./helpers/snapshot-fixture";

const SID = "sess-1";
let root = "";
let cwd = "";
let snapDir = "";
let snapshots: SessionSnapshots;
let gitOk = false;

beforeEach(async () => {
	const pg = makePlayground("percho-snapshots-test-");
	root = pg.root;
	cwd = join(root, "proj");
	mkdirSync(cwd, { recursive: true });
	snapDir = join(root, "snap");
	gitOk = await isGitAvailable();
	snapshots = new SessionSnapshots({ dir: snapDir });
	await snapshots.init();
});

afterEach(async () => {
	await snapshots.disposeAll();
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Windows 偶发 EBUSY，留给系统清理
	}
});

const write = (rel: string, content: string): void => {
	const abs = join(cwd, rel);
	mkdirSync(join(abs, ".."), { recursive: true });
	writeFileSync(abs, content);
};

const read = (rel: string): string => readFileSync(join(cwd, rel), "utf8");

/** 模拟一轮 agent 工作：写文件 → 打点 */
async function round(turnIndex: number, files: Record<string, string>, exclusive = true): Promise<void> {
	for (const [rel, content] of Object.entries(files)) write(rel, content);
	await snapshots.record(SID, cwd, turnIndex, exclusive);
	await snapshots.idle(SID);
}

describe("snapshots：打点与时间线", () => {
	it("基线 + 3 轮打点，条目顺序与 turnIndex 正确", async () => {
		if (!gitOk) return;
		write("a.txt", "base\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		await round(0, { "a.txt": "r0\n" });
		await round(1, { "a.txt": "r1\n" });
		await round(2, { "a.txt": "r2\n" });

		const entries = snapshots.entriesOf(SID);
		expect(entries.map((e) => e.turnIndex)).toEqual([-1, 0, 1, 2]);
		expect(entries.map((e) => e.kind)).toEqual(["baseline", "turn", "turn", "turn"]);
		expect(entries[0]?.exclusive).toBe(true);
	});

	it("内容没变的轮次不新建 commit 对象，但本条仍持有自己的 ref（复用同一 commit）", async () => {
		if (!gitOk) return;
		write("a.txt", "same\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		await round(0, {});
		const entries = snapshots.entriesOf(SID);
		expect(entries).toHaveLength(2);
		// 不重复写 commit 对象：复用基线那条的 commit OID
		expect(entries[1]?.commitOid).toBe(entries[0]?.commitOid);
		expect(entries[1]?.treeOid).toBe(entries[0]?.treeOid);
		// ❗ 但 ref 必须各自存在：否则基线那条被裁掉时，本条共享的树会连带被 prune（BUG B）
		expect(entries[1]?.ref).toBe("refs/snap/turn-0");
		const refs = await rawGit(null, [
			"--git-dir",
			join(snapDir, `${SID}.git`),
			"for-each-ref",
			"--format=%(refname)",
		]);
		expect(refs.stdout.split("\n").filter(Boolean).sort()).toEqual([
			"refs/snap/baseline--1",
			"refs/snap/turn-0",
		]);
	});

	it("同一 turnIndex 打点两次：覆盖而不是追加（同轮多次 turn_end，BUG C）", async () => {
		if (!gitOk) return;
		write("a.txt", "base\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		// 同一轮里 turn_end 会来多次：先半成品、再成品
		await round(0, { "a.txt": "half\n" });
		await round(0, { "a.txt": "done\n" });

		const entries = snapshots.entriesOf(SID);
		expect(entries.map((e) => e.turnIndex)).toEqual([-1, 0]);
		// 覆盖后保留的是**最后一次**的内容
		await round(1, { "a.txt": "next\n" });
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("done\n");
	});

	it("覆盖同一 turnIndex 时旧条目的 ref 被删掉（否则 commit 泄漏）", async () => {
		if (!gitOk) return;
		write("a.txt", "base\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		await round(0, { "a.txt": "half\n" });
		const before = snapshots.entriesOf(SID);
		expect(before.map((e) => e.ref)).toEqual(["refs/snap/baseline--1", "refs/snap/turn-0"]);
		await round(0, { "a.txt": "done\n" });
		const refs = await rawGit(null, [
			"--git-dir",
			join(snapDir, `${SID}.git`),
			"for-each-ref",
			"--format=%(refname)",
		]);
		// 仍然只有两条 ref：覆盖没有留下孤儿
		expect(refs.stdout.split("\n").filter(Boolean).sort()).toEqual([
			"refs/snap/baseline--1",
			"refs/snap/turn-0",
		]);
	});

	it("capture() 之后工作区再变，record 仍拍到冻结时刻的内容（BUG E 的核心语义）", async () => {
		if (!gitOk) return;
		write("a.txt", "base\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);

		// 第 0 轮：turn_end 里同步冻结（真实场景里这之后 1–2ms 下一轮就开始写盘）
		write("a.txt", "turn0-done\n");
		const frozen = snapshots.capture(SID, cwd);
		if (!frozen) throw new Error("capture 返回 undefined");

		// 冻结后**立刻**改工作区，然后才轮到异步的 record 真正落库
		write("a.txt", "turn1-in-progress\n");
		write("b.txt", "turn1-only\n");
		await snapshots.record(SID, cwd, 0, true, frozen);
		await snapshots.idle(SID);
		// 第 1 轮正常打点
		await snapshots.record(SID, cwd, 1, true);
		await snapshots.idle(SID);

		// 撤回第 1 轮 → 必须回到第 0 轮冻结时刻（turn0-done、无 b.txt）。
		// 若打点没冻结（BUG E），第 0 轮的树会拍到 turn1 的内容，这里就一个字节都回不去。
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt", "b.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("turn0-done\n");
		expect(existsSync(join(cwd, "b.txt"))).toBe(false);
	});

	it("不给 captured 时 record 在入口同步冻结（兜底打点也安全）", async () => {
		if (!gitOk) return;
		write("a.txt", "base\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);

		write("a.txt", "frozen-at-call\n");
		// 不 await：record 的第一个 await 之前就必须把 index 冻结住
		const pending = snapshots.record(SID, cwd, 0, true);
		write("a.txt", "written-after-call\n");
		await pending;
		await snapshots.idle(SID);

		await snapshots.record(SID, cwd, 1, true);
		await snapshots.idle(SID);

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("frozen-at-call\n");
	});

	it("元数据落盘后可被新实例读回", async () => {
		if (!gitOk) return;
		write("a.txt", "x\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		await round(0, { "a.txt": "y\n" });
		await snapshots.disposeAll();

		const second = new SessionSnapshots({ dir: snapDir });
		await second.init();
		// 重新 ensureBaseline 是幂等的：已有快照就什么都不做
		await second.ensureBaseline(SID, cwd, -1, true);
		await second.idle(SID);
		expect(second.entriesOf(SID).map((e) => e.turnIndex)).toEqual([-1, 0]);
		await second.disposeAll();
	});
});

describe("snapshots：撤回", () => {
	beforeEach(async () => {
		if (!gitOk) return;
		write("a.txt", "base\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
	});

	it("撤回最后一轮：文件回到上一轮内容", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "r0\n" });
		await round(1, { "a.txt": "r1\n" });
		expect(read("a.txt")).toBe("r1\n");

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		if (res.status !== "reverted") return;
		expect(read("a.txt")).toBe("r0\n");
		expect(res.reverted).toContain("a.txt");
	});

	it("撤回中间轮：跨轮一次跳，等于逐轮回退", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "r0\n" });
		await round(1, { "a.txt": "r1\n" });
		await round(2, { "a.txt": "r2\n" });

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("r0\n");
	});

	it("撤回第 0 轮：回到基线", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "r0\n" });
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("base\n");
	});

	it("agent 新建的文件被删除，用户新建的文件保留", async () => {
		if (!gitOk) return;
		await round(0, { "agent.txt": "agent\n" });
		write("user.txt", "user\n");

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["agent.txt"],
		});
		expect(res.status).toBe("reverted");
		if (res.status !== "reverted") return;
		expect(existsSync(join(cwd, "agent.txt"))).toBe(false);
		expect(res.deleted).toContain("agent.txt");
		expect(read("user.txt")).toBe("user\n");
	});

	it("用户手改窗口外的路径 → 保留", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "r0\n" });
		write("untouched.txt", "user made this\n");

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("untouched.txt")).toBe("user made this\n");
	});

	it("用户手改窗口内但不相干的行 → 行级合并保留用户改动", async () => {
		if (!gitOk) return;
		// 基线就是一整段文本，agent 那一轮只改第 1 行 —— 这样「回退」才是行级的
		const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
		write("a.txt", `${lines.join("\n")}\n`);
		await snapshots.disposeSession(SID);
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);

		const agentLines = [...lines];
		agentLines[0] = "AGENT1";
		await round(0, { "a.txt": `${agentLines.join("\n")}\n` });

		// 用户改第 8 行（窗口内文件，但那一行 agent 没动）
		const userLines = [...agentLines];
		userLines[7] = "USER8";
		write("a.txt", `${userLines.join("\n")}\n`);

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		// 第 1 行回到 base（agent 改过），第 8 行保留用户改动
		const got = read("a.txt").split("\n");
		expect(got[0]).toBe("line1");
		expect(got[7]).toBe("USER8");
	});

	it("用户手改同一处 → 冲突，工作区一个字节都不动", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "agent changed\n" });
		write("a.txt", "user changed\n");
		const before = md5(readFileSync(join(cwd, "a.txt")));

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("conflict");
		if (res.status !== "conflict") return;
		expect(res.reason).toBe("merge");
		expect(res.conflicts).toContain("a.txt");
		expect(res.repairPatch).toContain("---");
		expect(md5(readFileSync(join(cwd, "a.txt")))).toBe(before);
	});

	it("二进制被用户改过 → 冲突（不被静默行级合并）", async () => {
		if (!gitOk) return;
		const png = (fill: number): Buffer => {
			const b = Buffer.alloc(200, fill);
			b[0] = 0x89;
			b[1] = 0x50;
			b[2] = 0x4e;
			b[3] = 0x47;
			b[10] = 0;
			return b;
		};
		await round(0, { "img.png": png(65).toString("latin1") });
		writeFileSync(join(cwd, "img.png"), png(66));
		const before = md5(readFileSync(join(cwd, "img.png")));

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["img.png"],
		});
		expect(res.status).toBe("conflict");
		if (res.status !== "conflict") return;
		expect(res.conflicts).toContain("img.png");
		expect(md5(readFileSync(join(cwd, "img.png")))).toBe(before);
	});

	it("二进制当前内容 == base（agent 改过、之后没人动）→ 正常回退，不判冲突", async () => {
		if (!gitOk) return;
		const png = (fill: number): Buffer => {
			const b = Buffer.alloc(200, fill);
			b[0] = 0x89;
			b[1] = 0x50;
			b[2] = 0x4e;
			b[3] = 0x47;
			b[10] = 0;
			return b;
		};
		// 基线：img.png 是 png(65)；第 0 轮 agent 把它改成 png(66) 并存进 base
		writeFileSync(join(cwd, "img.png"), png(65));
		await snapshots.disposeSession(SID);
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		writeFileSync(join(cwd, "img.png"), png(66));
		await snapshots.record(SID, cwd, 0, true);
		await snapshots.idle(SID);

		// 撤回第 0 轮：当前（= base）既不是 theirs 也不是... 等等，它**是** base。
		// review 的三方判定：ours == base → 留在 scope 交给 merge-tree，不判冲突。
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["img.png"],
		});
		expect(res.status).toBe("reverted");
		if (res.status !== "reverted") return;
		// 回到基线那份 png(65)
		expect(md5(readFileSync(join(cwd, "img.png")))).toBe(md5(png(65)));
	});

	it("撤回失败（冲突）后 index 被拨回 ours：下一次打点仍能算对增量", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "agent changed\n" });
		write("a.txt", "user changed\n");
		const oursTree = (
			await rawGit(null, ["--git-dir", join(snapDir, `${SID}.git`), "rev-parse", "refs/snap/turn-0"])
		).stdout.trim();
		const indexPath = join(snapDir, `${SID}.index`);

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("conflict");

		// ❗ 直接钉住 index：冲突路径上 index 必须与工作区（= 刚拍的 ours）对齐。
		// 这行断言是「没有 finally 就红」的那一条 —— 去掉 finally 后 index 会停在
		// buildFilteredTree 留下的 base 树上，下面的 `ls-files -s` 会给出基线的 blob。
		const sh = { gitDir: join(snapDir, `${SID}.git`), workTree: cwd, indexPath };
		const lsFiles = await rawGit(sh, ["ls-files", "-s", "a.txt"]);
		const indexBlob = lsFiles.stdout.trim().split(/\s+/)[1] ?? "";
		// ours 树是撤回时现拍的（含用户手改），没有被 ref 引用，所以直接算磁盘字节的 blob。
		// ❗ 必须带 sh（影子库环境）：不带时 cwd 落在本仓库，`* text=auto` 会把 CRLF 归一化，
		// 算出来的 blob 与影子库里的对不上（实测 40ed9b0b… vs dab4bd46…）。
		const expectedBlob = (
			await rawGit(sh, ["hash-object", "--stdin"], {
				input: "user changed\n",
			})
		).stdout.trim();
		expect(indexBlob).toBe(expectedBlob);
		expect(oursTree).toMatch(/^[0-9a-f]{40,64}$/);

		// 冲突后工作区没变（还是 user changed），index 也应与之对齐。
		// 接着写一个新文件再打点：如果 index 停在半路，这里会算出错误的 tree。
		write("b.txt", "new file\n");
		await snapshots.record(SID, cwd, 1, true);
		await snapshots.idle(SID);

		const entries = snapshots.entriesOf(SID);
		expect(entries.map((e) => e.turnIndex)).toEqual([-1, 0, 1]);
		// 撤回一轮之后的新打点，必须能撤回回它自己的前一点
		const again = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["b.txt"],
		});
		expect(again.status).toBe("reverted");
		expect(existsSync(join(cwd, "b.txt"))).toBe(false);
		// 撤回到「第 1 轮开始前」= 第 0 轮结束时的树（agent changed）。
		// 用户在两轮之间手改的 "user changed" 已被并进第 1 轮快照，所以随第 1 轮一起被撤掉。
		expect(read("a.txt")).toBe("agent changed\n");
	});

	it("非独占窗口 + 不在账本里的路径 → 静默跳过", async () => {
		if (!gitOk) return;
		// 第 0 轮不独占：另一会话可能同时改过工作区
		await round(0, { "a.txt": "r0\n", "other.txt": "other\n" }, false);

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"], // 只有 a.txt 在账本里
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("base\n");
		// other.txt 不在账本里 → 不回退
		expect(read("other.txt")).toBe("other\n");
	});

	it("rollback 把工作区还原到撤回前", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "r0\n" });
		const before = md5(readFileSync(join(cwd, "a.txt")));

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		if (res.status !== "reverted") return;
		expect(md5(readFileSync(join(cwd, "a.txt")))).not.toBe(before);

		await res.rollback();
		expect(md5(readFileSync(join(cwd, "a.txt")))).toBe(before);
	});

	it("commitRecall 重置时间线：丢弃的轮次被删，recall 条目接上", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "r0\n" });
		await round(1, { "a.txt": "r1\n" });
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		if (res.status !== "reverted") throw new Error(`expected reverted, got ${res.status}`);

		await snapshots.commitRecall(SID, cwd, 1, res.postTreeOid, true);
		await snapshots.idle(SID);

		const entries = snapshots.entriesOf(SID);
		expect(entries.map((e) => e.turnIndex)).toEqual([-1, 0, 0]);
		expect(entries.map((e) => e.kind)).toEqual(["baseline", "turn", "recall"]);

		// 撤回后继续打点：新一轮的 turnIndex 用 1
		await round(1, { "a.txt": "r1-again\n" });
		expect(snapshots.entriesOf(SID).map((e) => e.turnIndex)).toEqual([-1, 0, 0, 1]);
	});

	it("code 侧 unavailable（postTreeOid 未定义）也要重置时间线：条目保持单调（BUG D）", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "r0\n" });
		await round(1, { "a.txt": "r1\n" });
		await round(2, { "a.txt": "r2\n" });
		// 模拟 code 侧没跑成（git 不可用 / internal）：只撤了对话，工作区留在 r2
		await snapshots.commitRecall(SID, cwd, 2, undefined, true);
		await snapshots.idle(SID);

		// recall 条目落在 targetTurn-1（「第 2 轮之前」的状态），与已有的 turn-1 条目同槽位 —— 这是设计如此
		const entries = snapshots.entriesOf(SID);
		expect(entries.map((e) => e.turnIndex)).toEqual([-1, 0, 1, 1]);
		expect(entries.map((e) => e.kind)).toEqual(["baseline", "turn", "turn", "recall"]);
		// 单调性（BUG D 的核心）：下一条打点追加的 turnIndex 必须比尾部大，不能回退
		await round(2, { "a.txt": "r2b\n" });
		const after = snapshots.entriesOf(SID).map((e) => e.turnIndex);
		expect(after).toEqual([-1, 0, 1, 1, 2]);
		expect([...after].sort((a, b) => a - b)).toEqual(after);
	});

	it("unavailable 重置后的撤回不空转：真的倒回到目标轮之前（BUG D 回归）", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "r0\n" });
		await round(1, { "a.txt": "r1\n" });
		await snapshots.commitRecall(SID, cwd, 1, undefined, true);
		await snapshots.idle(SID);
		// 撤回后又跑了一轮，用户继续改
		await round(1, { "a.txt": "r1-after\n" });
		await round(2, { "a.txt": "r2\n" });

		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 2,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		// 倒回到第 1 轮打点时的状态（r1-after），而不是一个字节没动还报成功
		expect(read("a.txt")).toBe("r1-after\n");
	});

	it("撤回后再撤回同一轮：拿到的是 recall 那条（回到撤回后的状态）", async () => {
		if (!gitOk) return;
		await round(0, { "a.txt": "r0\n" });
		await round(1, { "a.txt": "r1\n" });
		const first = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		if (first.status !== "reverted") throw new Error("first recall failed");
		await snapshots.commitRecall(SID, cwd, 1, first.postTreeOid, true);
		await snapshots.idle(SID);
		expect(read("a.txt")).toBe("r0\n");

		// 又写了一轮，再撤回：应回到 r0（recall 那点），不是 r1
		await round(1, { "a.txt": "r1b\n" });
		const second = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		expect(second.status).toBe("reverted");
		expect(read("a.txt")).toBe("r0\n");
	});

	it("中途打开的会话（基线 turnIndex = 3）：撤回第 4 轮回到基线", async () => {
		if (!gitOk) return;
		write("a.txt", "base\n");
		await snapshots.disposeSession(SID);
		await snapshots.ensureBaseline(SID, cwd, 3, true);
		await snapshots.idle(SID);
		await round(4, { "a.txt": "r4\n" });

		// 撤回第 4 轮 → 要的是 turnIndex 3 那个点，恰好就是基线
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 4,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("base\n");
	});

	it("保留窗口裁剪时对应调试 ref 被删掉（否则对象永远不可达不了）", async () => {
		if (!gitOk) return;
		await snapshots.disposeAll();
		const small = new SessionSnapshots({ dir: snapDir, maxSnapshots: 3 });
		await small.init();
		write("a.txt", "base\n");
		await small.ensureBaseline(SID, cwd, -1, true);
		await small.idle(SID);
		for (const [i, content] of ["r0\n", "r1\n", "r2\n"].entries()) {
			write("a.txt", content);
			await small.record(SID, cwd, i, true);
			await small.idle(SID);
		}
		// 3 条上限：基线（-1）被裁掉，只剩 0、1、2
		expect(small.entriesOf(SID).map((e) => e.turnIndex)).toEqual([0, 1, 2]);

		const refs = await rawGit(null, [
			"--git-dir",
			join(snapDir, `${SID}.git`),
			"for-each-ref",
			"--format=%(refname)",
		]);
		const names = refs.stdout.split("\n").filter(Boolean).sort();
		expect(names).toEqual(["refs/snap/turn-0", "refs/snap/turn-1", "refs/snap/turn-2"]);
		await small.disposeAll();
	});

	it("目标轮之前的快照被裁掉 → out-of-window", async () => {
		if (!gitOk) return;
		await snapshots.disposeAll();
		// maxSnapshots=2：基线 + 1 轮，再打两轮就裁掉旧条目
		const small = new SessionSnapshots({ dir: snapDir, maxSnapshots: 2 });
		await small.init();
		write("a.txt", "base\n");
		await small.ensureBaseline(SID, cwd, -1, true);
		await small.idle(SID);
		for (const [i, content] of ["r0\n", "r1\n"].entries()) {
			write("a.txt", content);
			await small.record(SID, cwd, i, true);
			await small.idle(SID);
		}
		expect(small.entriesOf(SID).map((e) => e.turnIndex)).toEqual([0, 1]);

		// 基线（-1）已被裁掉 → 撤回第 0 轮需要它，拿不到
		const res = await small.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("conflict");
		if (res.status === "conflict") expect(res.reason).toBe("out-of-window");
		// ❗ 关键：不能因为「找不到 -1」就退回基线（那会把窗口外的状态静默倒回来）
		expect(read("a.txt")).toBe("r1\n");

		// 更远的轮次同理
		const res2 = await small.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 5,
			ledgerPaths: ["a.txt"],
		});
		expect(res2.status).toBe("conflict");
		if (res2.status === "conflict") expect(res2.reason).toBe("out-of-window");

		// 窗口内最后一轮仍可撤回（beforeTurn(1) = turnIndex 0 那条）
		const ok = await small.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		expect(ok.status).toBe("reverted");
		expect(read("a.txt")).toBe("r0\n");
		await small.disposeAll();
	});

	it("基线还在、但目标轮早于基线 → out-of-window（不能拿基线顶替）", async () => {
		if (!gitOk) return;
		await snapshots.disposeAll();
		// 会话在第 3 轮之后才打开：基线 turnIndex = 3
		// 用新 sessionId：describe 级 beforeEach 已给 SID 建了 turnIndex=-1 的基线
		const mid = "sess-mid";
		const small = new SessionSnapshots({ dir: snapDir });
		await small.init();
		write("a.txt", "state-after-turn3\n");
		await small.ensureBaseline(mid, cwd, 3, true);
		await small.idle(mid);
		// 第 4 轮：改 a.txt + 新建 c.txt
		write("a.txt", "state-after-turn4\n");
		write("c.txt", "created-in-turn4\n");
		await small.record(mid, cwd, 4, true);
		await small.idle(mid);
		expect(small.entriesOf(mid).map((e) => [e.kind, e.turnIndex])).toEqual([
			["baseline", 3],
			["turn", 4],
		]);

		// 撤回第 2 轮：beforeTurn(2) 要 turnIndex 1，快照里没有 → out-of-window
		const res = await small.recallCode({
			sessionId: mid,
			cwd,
			targetTurn: 2,
			ledgerPaths: ["a.txt", "c.txt"],
		});
		expect(res.status).toBe("conflict");
		if (res.status === "conflict") expect(res.reason).toBe("out-of-window");
		// ❗ 工作区一个字节都不能动：既不能倒回第 3 轮，也不能删掉第 4 轮新建的 c.txt
		expect(read("a.txt")).toBe("state-after-turn4\n");
		expect(read("c.txt")).toBe("created-in-turn4\n");
		await small.disposeAll();
	});

	it("空轮次（内容没变）的条目在后续裁剪 + GC 后树仍在（BUG B）", async () => {
		if (!gitOk) return;
		await snapshots.disposeAll();
		// maxSnapshots=2 加速：两轮就触发裁剪 + repack + prune
		const empty = "sess-empty";
		const small = new SessionSnapshots({ dir: snapDir, maxSnapshots: 2 });
		await small.init();
		write("a.txt", "base\n");
		await small.ensureBaseline(empty, cwd, -1, true);
		await small.idle(empty);
		// 第 0 轮：什么都没改（内容与基线相同）→ 复用 commit，但要有自己的 ref
		await small.record(empty, cwd, 0, true);
		await small.idle(empty);
		const turn0Tree = small.entriesOf(empty)[1]?.treeOid ?? "";
		expect(turn0Tree).not.toBe("");
		// 第 1 轮：改文件 → 条目溢出，基线那条被裁掉 + GC
		write("a.txt", "r1\n");
		await small.record(empty, cwd, 1, true);
		await small.idle(empty);
		expect(small.entriesOf(empty).map((e) => e.turnIndex)).toEqual([0, 1]);

		// turn 0 的树必须仍然可达（GC 不能因为基线被裁就把它清掉）
		const cat = await rawGit(null, ["--git-dir", join(snapDir, `${empty}.git`), "cat-file", "-t", turn0Tree]);
		expect(cat.code).toBe(0);
		expect(cat.stdout.trim()).toBe("tree");

		// 撤回第 1 轮需要 turn 0 的树：不能 unavailable
		const res = await small.recallCode({
			sessionId: empty,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("base\n");
		await small.disposeAll();
	});
});

describe("snapshots：降级与清理", () => {
	it("没有快照的会话 → unavailable（不抛）", async () => {
		if (!gitOk) return;
		const res = await snapshots.recallCode({
			sessionId: "nobody",
			cwd,
			targetTurn: 0,
			ledgerPaths: [],
		});
		expect(res.status).toBe("unavailable");
	});

	it("disposeSession 删掉影子库与元数据", async () => {
		if (!gitOk) return;
		write("a.txt", "x\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		expect(existsSync(join(snapDir, `${SID}.git`))).toBe(true);
		expect(existsSync(join(snapDir, `${SID}.json`))).toBe(true);

		await snapshots.disposeSession(SID);
		expect(existsSync(join(snapDir, `${SID}.git`))).toBe(false);
		expect(existsSync(join(snapDir, `${SID}.json`))).toBe(false);
	});

	it("disposeAll 只清内存，不删磁盘（下次启动接着用）", async () => {
		if (!gitOk) return;
		write("a.txt", "x\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		await snapshots.disposeAll();
		expect(existsSync(join(snapDir, `${SID}.git`))).toBe(true);
	});

	it("cwd 变了 → 打点跳过，不污染旧树", async () => {
		if (!gitOk) return;
		write("a.txt", "x\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		const other = join(root, "other");
		mkdirSync(other, { recursive: true });
		await snapshots.record(SID, other, 0, true);
		await snapshots.idle(SID);
		expect(snapshots.entriesOf(SID)).toHaveLength(1);
	});
});

describe("snapshots：路径归一", () => {
	it("绝对路径、相对路径、Windows 分隔符都归一成 posix 相对", () => {
		const set = normalizeLedgerPaths(cwd, ["src/a.ts", join(cwd, "src", "b.ts"), "src\\c.ts"]);
		expect([...set].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
	});

	it("项目外的路径被丢弃", () => {
		const set = normalizeLedgerPaths(cwd, ["../outside.txt"]);
		expect(set.size).toBe(0);
	});
});
