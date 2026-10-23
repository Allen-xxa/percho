import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayground } from "./helpers/snapshot-fixture";

/**
 * review BUG G：基线被第一轮改动污染 → 撤回第一轮「报成功但什么都没撤」。
 *
 * 基线的**语义**是「会话打开那一刻的工作区」，实现上却是「基线异步任务真正跑完那一刻的
 * 工作区」。首次基线要 3.2s，足够用户发完第一句话、agent 跑完一轮 —— 那一轮的改动就被
 * 并进了基线树，撤回它时 `diff(baseline, baseline)` 为空，`status: "reverted"` +
 * `reverted: []`：报成功、一个字节没动。
 *
 * 这里用一个可控闸门把基线卡在 `snapshotTree` 里，稳定复现「基线进行中一轮结束」。
 */

const state = vi.hoisted(() => ({
	gate: null as Promise<void> | null,
	entered: null as (() => void) | null,
}));

vi.mock("../src/session/snapshot-git", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/session/snapshot-git")>();
	return {
		...actual,
		snapshotTree: async (...args: Parameters<typeof actual.snapshotTree>) => {
			state.entered?.();
			state.entered = null;
			if (state.gate) await state.gate;
			return actual.snapshotTree(...args);
		},
	};
});

const { isGitAvailable } = await import("../src/session/snapshot-git");
const { SessionSnapshots } = await import("../src/session/snapshots");

const SID = "sess-1";
let root = "";
let cwd = "";
let snapshots: InstanceType<typeof SessionSnapshots>;
let gitOk = false;

beforeEach(async () => {
	state.gate = null;
	state.entered = null;
	const pg = makePlayground("percho-snap-polluted-");
	root = pg.root;
	cwd = join(root, "proj");
	mkdirSync(cwd, { recursive: true });
	gitOk = await isGitAvailable();
	snapshots = new SessionSnapshots({ dir: join(root, "snap") });
	await snapshots.init();
});

afterEach(async () => {
	state.gate = null;
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

describe("snapshots：基线被污染（BUG G）", () => {
	it("基线进行中结束的轮次 → 基线标记 polluted，撤回该轮诚实地报 out-of-window 且工作区一字未动", async () => {
		if (!gitOk) return;
		write("a.txt", "v0\n");

		let release = (): void => {};
		state.gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			state.entered = resolve;
		});
		const baseline = snapshots.ensureBaseline(SID, cwd, -1, true);
		await entered; // 基线此刻卡在 snapshotTree 里，条目还没 push

		// 用户立刻发第一句话，agent 跑完一轮
		write("a.txt", "turn0\n");
		await snapshots.record(SID, cwd, 0, true);
		// live index 还没建立 → 本轮不打点（否则同步全量 add -A 要 3.7s，见 review 补充策略 1）
		expect(snapshots.hasEntry(SID, 0)).toBe(false);

		release();
		await baseline;
		await snapshots.idle(SID);

		const entries = snapshots.entriesOf(SID);
		expect(entries.map((e) => `${e.kind}@${e.turnIndex}${e.polluted ? "!" : ""}`)).toEqual(["baseline@-1!"]);

		// 第 2 轮正常打点（live index 已就位，增量 30ms 量级）
		write("a.txt", "turn1\n");
		await snapshots.record(SID, cwd, 1, true);
		await snapshots.idle(SID);
		expect(snapshots.hasEntry(SID, 1)).toBe(true);

		// 撤回第 0 轮：它的目标状态是 `baselineTurnIndex = -1`，正好落在污染基线上。
		// 不判 polluted 时会把污染基线当 theirs → diff 非空 → 真的把工作区倒回「turn 0 结束」，
		// 而用户要的是「turn 0 开始之前」（`v0`）—— 静默倒到错误状态。
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("conflict");
		if (res.status === "conflict") expect(res.reason).toBe("out-of-window");
		// 关键：不能是「reverted + reverted: []」的假成功
		expect(read("a.txt")).toBe("turn1\n");
	});

	it("基线全程没有轮次结束 → 不标记 polluted，撤回照常工作", async () => {
		if (!gitOk) return;
		write("a.txt", "v0\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		expect(snapshots.entriesOf(SID).every((e) => e.polluted !== true)).toBe(true);

		write("a.txt", "turn0\n");
		await snapshots.record(SID, cwd, 0, true);
		await snapshots.idle(SID);
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("v0\n");
	});
});
