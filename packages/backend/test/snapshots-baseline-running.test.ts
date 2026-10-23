import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayground } from "./helpers/snapshot-fixture";

/**
 * 基线进行中调用 `capture()` 的行为（review 2026-10-24 01:12 定的最终策略）。
 *
 * 曾经有过一版「live index 未建立 → 本轮直接放弃打点」，被 review 否掉（BUG H）：
 * `liveIndexReady` 只在 `withPrivateIndex*` 成功前移时置 true，而早退根本不进那条路径 →
 * live 文件一旦丢过（进程在 rename 前被杀 / 用户删了 `*.index` / `add -A` 抛错），
 * 这个会话就**永久**丢点。
 *
 * 现在的策略：live 缺失时 `withPrivateIndexSync` 退化成「空 index + 全量 `add -A`」，
 * 成功后自动置位。代价实测只有 ~520ms（基线正在并发写 blob，全量 add 直接复用）。
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
let snapDir = "";
let snapshots: InstanceType<typeof SessionSnapshots>;
let gitOk = false;

beforeEach(async () => {
	state.gate = null;
	state.entered = null;
	const pg = makePlayground("percho-snap-baseline-running-");
	root = pg.root;
	cwd = join(root, "proj");
	mkdirSync(cwd, { recursive: true });
	snapDir = join(root, "snap");
	gitOk = await isGitAvailable();
	snapshots = new SessionSnapshots({ dir: snapDir });
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

describe("snapshots：基线进行中的 capture", () => {
	it("基线进行中也能拍：不抛错、不撞 index.lock，第 0 轮照样有条目", async () => {
		if (!gitOk) return;
		write("a.txt", "v0\n");

		const { entered, release } = await blockBaseline();
		const baseline = snapshots.ensureBaseline(SID, cwd, -1, true);
		await entered;

		// live index 还没建立 → 走全量 add -A（~520ms 量级），但**不放弃本轮**
		write("a.txt", "turn0\n");
		const frozen = snapshots.capture(SID, cwd, 0);
		expect(frozen).toBeDefined();

		// 先放行基线再入队：record 会排在基线后面，此刻 await 会等一个被闸门卡住的队列（死等）
		release();
		await baseline;
		await snapshots.record(SID, cwd, 0, true, frozen);
		await snapshots.idle(SID);
		expect(snapshots.hasEntry(SID, 0)).toBe(true);
		// 基线拍到的仍是「会话打开那一刻」的内容（没被上面那次写盘带歪）
		const entries = snapshots.entriesOf(SID);
		expect(entries.map((e) => `${e.kind}@${e.turnIndex}`)).toEqual(["baseline@-1", "turn@0"]);

		// 第 1 轮正常打点 → 撤回第 1 轮必须真的倒回 turn0（不再 out-of-window）
		write("a.txt", "turn1\n");
		await snapshots.record(SID, cwd, 1, true);
		await snapshots.idle(SID);
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("turn0\n");
	});

	it("live index 被删掉后重启：capture 仍返回树，不会永久丢点（BUG H）", async () => {
		if (!gitOk) return;
		write("a.txt", "v0\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		expect(snapshots.capture(SID, cwd, 0)).toBeDefined();
		await snapshots.disposeAll();

		// 模拟「进程在 renameSync 之前被杀」/「用户清掉了看着像临时文件的 *.index」
		for (const name of readdirSync(snapDir)) {
			if (name.endsWith(".index")) rmSync(join(snapDir, name), { force: true });
		}
		expect(readdirSync(snapDir).some((n) => n.endsWith(".index"))).toBe(false);

		// 重启：新实例、元数据还在（条目存在），但 live index 不在
		snapshots = new SessionSnapshots({ dir: snapDir });
		await snapshots.init();
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		expect(snapshots.entriesOf(SID).length).toBe(1);

		write("a.txt", "turn0\n");
		// 早退实现会在这里返回 undefined，之后**永远**返回 undefined（死锁）
		const frozen = snapshots.capture(SID, cwd, 0);
		expect(frozen).toBeDefined();
		await snapshots.record(SID, cwd, 0, true, frozen);
		await snapshots.idle(SID);
		expect(snapshots.hasEntry(SID, 0)).toBe(true);

		// 而且下一次仍是增量（live 已被重建），撤回也正常
		write("a.txt", "turn1\n");
		await snapshots.record(SID, cwd, 1, true);
		await snapshots.idle(SID);
		const res = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 1,
			ledgerPaths: ["a.txt"],
		});
		expect(res.status).toBe("reverted");
		expect(read("a.txt")).toBe("turn0\n");
	});
});
