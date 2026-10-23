import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayground } from "./helpers/snapshot-fixture";

/**
 * 基线进行中调用 `capture()` 的行为（review 2026-10-24 00:51 要求补的用例）。
 *
 * 定下的策略：**live index 未建立时本轮直接放弃打点**。
 * 理由：私有 index 拿不到 live 的增量起点，`add -A` 会退化成全量（真实仓库实测：基线进行中
 * 约 520ms，完全无基线在跑时约 3.7s），而 `capture()` 是同步的、卡在 `turn_end` 里。
 * 基线本身正在做同样的活，那一轮丢点会诚实降级成 `out-of-window`。
 *
 * 用可控闸门把基线卡在 `snapshotTree` 里，稳定复现「基线进行中」。
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
	const pg = makePlayground("percho-snap-baseline-running-");
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

/** 把下一次 `ensureBaseline` 卡在 `snapshotTree` 里，返回「放行」函数 */
async function blockBaseline(): Promise<{ entered: Promise<void>; release: () => void }> {
	let release = (): void => {};
	state.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		state.entered = resolve;
	});
	return { entered, release };
}

describe("snapshots：基线进行中的 capture（策略 1）", () => {
	it("基线进行中 capture 返回 undefined：不抛错、不撞 index.lock，本轮诚实丢点", async () => {
		if (!gitOk) return;
		write("a.txt", "v0\n");

		const { entered, release } = await blockBaseline();
		const baseline = snapshots.ensureBaseline(SID, cwd, -1, true);
		await entered;

		// live index 还没建立 → 放弃本轮（否则同步全量 add -A 卡在 turn_end 里）
		write("a.txt", "turn0\n");
		expect(snapshots.capture(SID, cwd, 0)).toBeUndefined();
		await snapshots.record(SID, cwd, 0, true);
		expect(snapshots.hasEntry(SID, 0)).toBe(false);

		release();
		await baseline;
		await snapshots.idle(SID);
		// 基线本身拍到了「会话打开那一刻」的内容，没被上面那次写盘带歪
		expect(snapshots.entriesOf(SID).map((e) => `${e.kind}@${e.turnIndex}`)).toEqual(["baseline@-1"]);
	});

	it("基线完成后 capture 立刻恢复正常，撤回照常工作", async () => {
		if (!gitOk) return;
		write("a.txt", "v0\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);

		write("a.txt", "turn0\n");
		expect(snapshots.capture(SID, cwd, 0)).toBeDefined();
		await snapshots.record(SID, cwd, 0, true);
		await snapshots.idle(SID);
		expect(snapshots.hasEntry(SID, 0)).toBe(true);

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
