import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlayground, rawGit } from "./helpers/snapshot-fixture";

/**
 * `recallCode` 的 index 兜底（review 2026-10-23 23:12 提的「阶段 2 的坑」）。
 *
 * 撤回链会反复改写 index：`snapshotTree` 的 `add -A` → `buildFilteredTree` 的 `read-tree base`
 * → `resetIndexTo(ours)` → `checkoutTree` 的 `read-tree -u`。中间任何一步抛错，index 都会停在
 * 半路（既不是 base 也不是 ours），下一次打点的 `add -A` 就会算错增量。
 *
 * 这条路径**没法从外部触发**（`buildFilteredTree` 只有 git 自己出错才会抛），所以这里用
 * `vi.mock` 把它换成一个可开关的炸弹，专门验证 `finally` 里的兜底。
 */

const state = vi.hoisted(() => ({ boom: false }));

vi.mock("../src/session/snapshot-git", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/session/snapshot-git")>();
	return {
		...actual,
		buildFilteredTree: async (...args: Parameters<typeof actual.buildFilteredTree>) => {
			// ❗ 先跑真实现再抛：真实现里第一句是 `read-tree base`，会把 index 挪到 base 树上。
			// 这正是要兜底的场景（index 停在半路）。只抛不跑的话 index 还停在 ours，测不出问题。
			const tree = await actual.buildFilteredTree(...args);
			if (state.boom) throw new Error("boom: buildFilteredTree 故意失败");
			return tree;
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
	state.boom = false;
	const pg = makePlayground("percho-snap-idx-");
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

const shadow = () => ({
	gitDir: join(snapDir, `${SID}.git`),
	workTree: cwd,
	indexPath: join(snapDir, `${SID}.index`),
});

/** index 里 a.txt 记的 blob sha */
async function indexBlobOf(path: string): Promise<string> {
	const out = await rawGit(shadow(), ["ls-files", "-s", path]);
	return out.stdout.trim().split(/\s+/)[1] ?? "";
}

describe("snapshots：撤回中途抛错后的 index 兜底", () => {
	it("buildFilteredTree 抛错 → 工作区不动、index 被拨回 ours、下一次打点仍算对增量", async () => {
		if (!gitOk) return;

		write("a.txt", "base\n");
		await snapshots.ensureBaseline(SID, cwd, -1, true);
		await snapshots.idle(SID);
		write("a.txt", "agent changed\n");
		await snapshots.record(SID, cwd, 0, true);
		await snapshots.idle(SID);

		// 用户在两次打点之间手改：这就是撤回时要现拍的 `ours`
		write("a.txt", "user changed\n");
		const oursBlob = (
			await rawGit(shadow(), ["hash-object", "--stdin"], { input: "user changed\n" })
		).stdout.trim();

		state.boom = true;
		// recallCode 外层会把异常包成 unavailable（不向上抛），但 index 兜底必须在 finally 里跑完
		const failed = await snapshots.recallCode({
			sessionId: SID,
			cwd,
			targetTurn: 0,
			ledgerPaths: ["a.txt"],
		});
		state.boom = false;
		expect(failed.status).toBe("unavailable");

		// ① 工作区一个字节都没动
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("user changed\n");
		// ② index 与工作区一致（没有兜底时它会停在 buildFilteredTree 留下的 base 树上）
		expect(await indexBlobOf("a.txt")).toBe(oursBlob);

		// ③ 恢复后继续打点，增量必须正确：这一轮的树里要含用户手改后的内容
		await snapshots.record(SID, cwd, 1, true);
		await snapshots.idle(SID);
		const entries = snapshots.entriesOf(SID);
		const last = entries[entries.length - 1];
		expect(last?.turnIndex).toBe(1);
		const blobInTree = (await rawGit(shadow(), ["rev-parse", `${last?.treeOid}:a.txt`])).stdout.trim();
		expect(blobInTree).toBe(oursBlob);
	});
});
