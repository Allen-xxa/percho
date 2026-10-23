import { mkdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { JsonStore } from "../json-store";
import { createLogger } from "../log";
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
	removeShadowRepo,
	resetIndexTo,
	runGit,
	type ShadowRepo,
	snapshotTree,
} from "./snapshot-git";

const log = createLogger("snapshots");

/** 保留窗口：基线 + 50 轮 */
const DEFAULT_MAX_SNAPSHOTS = 51;
/** 单个文件超过该大小不进快照（大二进制既拖慢快照也无法按行回退） */
const DEFAULT_SKIP_OVER_BYTES = 1024 * 1024;

export interface SnapshotEntry {
	/** 这条快照代表"第几轮的工作做完之后"；基线 = baselineTurnIndex（通常 -1） */
	turnIndex: number;
	treeOid: string;
	/** 仅调试可读用，代码逻辑不依赖 */
	commitOid?: string;
	/** 对应的调试 ref 全名（`refs/snap/<kind>-<turnIndex>`）；裁剪时要删掉它，否则对象永远不可达不了 */
	ref?: string;
	/** 打点时刻同 cwd 没有其他活跃可写会话 */
	exclusive: boolean;
	/** 被剔除的路径（大文件/嵌套仓库），仅调试 */
	skipped: string[];
	kind: "baseline" | "turn" | "recall";
}

export interface SnapshotState {
	version: 1;
	cwd: string;
	snapshots: SnapshotEntry[];
}

export interface RecallCodeRequest {
	sessionId: string;
	cwd: string;
	/** 要撤回的那一轮（0 基） */
	targetTurn: number;
	/** 窗口内 deriveTurnChanges 的 path 并集（原始，未归一） */
	ledgerPaths: string[];
	/** 当前是否独占（仅在记录 recall 快照时用；回退范围按历史记录判定） */
	isExclusiveNow: boolean;
}

export interface RecallCodeSuccess {
	status: "reverted";
	reverted: string[];
	deleted: string[];
	skipped: string[];
	/** 对话侧失败时调用，把工作区拨回撤回前的样子 */
	rollback: () => Promise<void>;
	/** 撤回后的工作区快照树（`commitRecall` 直接用它，不必重拍） */
	postTreeOid: string;
	/** 撤回前的现场（`postTreeOid` 与之比较即为本次改动） */
	oursTreeOid: string;
}

export type RecallCodeResult =
	| RecallCodeSuccess
	| { status: "conflict"; conflicts: string[]; repairPatch: string; reason: "merge" | "out-of-window" }
	| { status: "unavailable"; reason: string };

interface SessionRuntime {
	sessionId: string;
	repo: ShadowRepo;
	metaPath: string;
	state: SnapshotState;
	/** 串行队列尾（打点按序执行） */
	tail: Promise<void>;
	/** 排队中的打点数；`idle` 等它归零 */
	pending: number;
}

const noop = async (): Promise<void> => {};

/**
 * 会话级「工作区照片」编排：每次 agent 跑完一轮就打一个点（影子 git 库里的 tree），
 * 撤回时把工作区三路合并回目标轮的现场。
 *
 * 设计要点（详见 `.local/agent-work/spec/checkpoint-recall.md`）：
 * - **绝不碰用户的 `.git`**：只在自己的裸库里用 `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`。
 * - **git 不可用 = 静默降级**：`init()` 之后所有方法返回 `unavailable`，绝不把异常抛给调用方
 *   （快照是增强能力，不能因为环境缺 git 就让会话开不起来）。
 * - **每会话串行**：打点与撤回都排进 `tail`，避免同一工作区并发 `add -A`。
 * - **原子性**：撤回先算完合并树再写盘；写盘后若对话侧失败，调用方用 `rollback()` 还原。
 */
export class SessionSnapshots {
	private readonly dir: string;
	private readonly maxSnapshots: number;
	private readonly skipOverBytes: number;
	private readonly sessions = new Map<string, SessionRuntime>();
	private gitAvailable = false;
	private initialized = false;
	private initPromise: Promise<void> | null = null;
	private readonly stores = new Map<string, JsonStore<SnapshotState>>();

	constructor(opts: { dir: string; maxSnapshots?: number; skipOverBytes?: number }) {
		this.dir = opts.dir;
		this.maxSnapshots = opts.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS;
		this.skipOverBytes = opts.skipOverBytes ?? DEFAULT_SKIP_OVER_BYTES;
	}

	/** 惰性探测 git；不可用则整体降级，**不抛** */
	async init(): Promise<void> {
		if (this.initialized) return;
		if (!this.initPromise) {
			this.initPromise = (async () => {
				this.gitAvailable = await isGitAvailable();
				if (!this.gitAvailable) log.warn("git 不可用，撤回将只回退对话（不拍工作区快照）");
				this.initialized = true;
			})();
		}
		await this.initPromise;
	}

	/** 会话打开时建影子库 + 基线点（幂等；已存在则只补基线） */
	async ensureBaseline(
		sessionId: string,
		cwd: string,
		baselineTurnIndex: number,
		exclusive: boolean,
	): Promise<void> {
		await this.init();
		if (!this.gitAvailable) return;
		try {
			const rt = await this.runtime(sessionId, cwd);
			if (rt.state.snapshots.length > 0) return;
			await this.enqueue(rt, async () => {
				if (rt.state.snapshots.length > 0) return;
				const { treeOid, skipped } = await snapshotTree(rt.repo, { skipOverBytes: this.skipOverBytes });
				const commit = await this.commitOrNull(rt, treeOid, "baseline", baselineTurnIndex);
				rt.state.snapshots.push({
					turnIndex: baselineTurnIndex,
					treeOid,
					commitOid: commit?.commitOid,
					ref: commit?.ref,
					exclusive,
					skipped,
					kind: "baseline",
				});
				await this.persist(rt);
			});
		} catch (err) {
			log.warn("建立基线快照失败", sessionId, String(err));
		}
	}

	/** agent 跑完一轮后调用；内部按 sessionId 串行排队 */
	async record(sessionId: string, cwd: string, turnIndex: number, exclusive: boolean): Promise<void> {
		if (!this.gitAvailable) return;
		const rt = this.sessions.get(sessionId);
		if (!rt) {
			// 会话还没 ensureBaseline（只读会话或时序意外）：静默跳过，不凭空造库
			return;
		}
		if (resolve(cwd) !== resolve(rt.repo.workTree)) {
			// cwd 变过：旧树的路径与新目录不可比，硬拍只会产出无法回退的快照
			log.warn("cwd 与会话快照库不一致，跳过打点", sessionId, rt.repo.workTree, cwd);
			return;
		}
		try {
			await this.enqueue(rt, async () => {
				const { treeOid, skipped } = await snapshotTree(rt.repo, { skipOverBytes: this.skipOverBytes });
				const last = rt.state.snapshots[rt.state.snapshots.length - 1];
				// 内容没变 → 不建 commit，只记一条元数据（省对象、省时间）
				const commit =
					last?.treeOid === treeOid ? undefined : await this.commitOrNull(rt, treeOid, "turn", turnIndex);
				rt.state.snapshots.push({
					turnIndex,
					treeOid,
					commitOid: commit?.commitOid,
					ref: commit?.ref,
					exclusive,
					skipped,
					kind: "turn",
				});
				await this.trim(rt);
				await this.persist(rt);
			});
		} catch (err) {
			log.warn("打点失败", sessionId, String(err));
		}
	}

	/** 撤回前先等排队清空 */
	async idle(sessionId: string): Promise<void> {
		const rt = this.sessions.get(sessionId);
		if (!rt) return;
		// 打点过程中可能又入队（理论上不会，但循环一次更稳）
		while (rt.pending > 0) await rt.tail;
	}

	/**
	 * 算撤回方案并落地。**严格按 spec 6.3**：
	 * 1. 等排队清空 → 2. 定位目标树 → 3. 现拍 ours → 4. 算 scope → 5. 二进制闸门
	 * → 6. 缩窄 theirs → 7. 三路合并 → 8. 冲突则不动盘 → 9. 写盘
	 */
	async recallCode(req: RecallCodeRequest): Promise<RecallCodeResult> {
		await this.init();
		if (!this.gitAvailable) return { status: "unavailable", reason: "git-unavailable" };
		const rt = this.sessions.get(req.sessionId);
		if (!rt) return { status: "unavailable", reason: "no-snapshots" };

		await this.idle(req.sessionId);
		try {
			return await this.recallCodeInner(rt, req);
		} catch (err) {
			log.warn("撤回代码失败", req.sessionId, String(err));
			return { status: "unavailable", reason: "internal-error" };
		}
	}

	private async recallCodeInner(rt: SessionRuntime, req: RecallCodeRequest): Promise<RecallCodeResult> {
		const last = rt.state.snapshots[rt.state.snapshots.length - 1];
		if (!last) return { status: "unavailable", reason: "no-snapshots" };

		const theirsEntry = beforeTurn(rt.state.snapshots, req.targetTurn);
		if (!theirsEntry) {
			// 目标轮之前的快照已被保留窗口裁掉
			return { status: "conflict", conflicts: [], repairPatch: "", reason: "out-of-window" };
		}

		const base = last.treeOid;
		const theirs = theirsEntry.treeOid;

		// 用户可能手改过工作区，必须现拍（不能复用上一次打点的树）
		const ours = (await snapshotTree(rt.repo, { skipOverBytes: this.skipOverBytes })).treeOid;

		// 回退范围按**历史记录**判定：窗口内每一轮打点都独占，才敢整片回退
		const exclusive = windowIsExclusive(rt.state.snapshots, req.targetTurn);
		const changed = await diffPaths(rt.repo, base, theirs);
		const ledger = normalizeLedgerPaths(req.cwd, req.ledgerPaths);
		let scope = exclusive ? changed : changed.filter((p) => ledger.has(p));
		if (scope.length === 0) {
			return {
				status: "reverted",
				reverted: [],
				deleted: [],
				skipped: [],
				rollback: noop,
				postTreeOid: ours,
				oursTreeOid: ours,
			};
		}

		// 二进制闸门：git 只看前 8000 字节判二进制，靠后的 NUL 会被静默行级合并成半坏文件
		const binGuard = await this.binaryGuard(rt.repo, base, theirs, ours, scope);
		if (binGuard.conflicts.length > 0) {
			return {
				status: "conflict",
				conflicts: binGuard.conflicts,
				repairPatch: await diffPatch(rt.repo, base, theirs),
				reason: "merge",
			};
		}
		scope = scope.filter((p) => !binGuard.skip.has(p));

		// 缩窄 theirs：只保留 scope 内的路径，窗口外的路径保持工作区原样
		const filteredTheirs = await buildFilteredTree(rt.repo, base, theirs, scope);
		// merge-tree 前 index 必须停在 ours 树上
		await resetIndexTo(rt.repo, ours);
		const merged = await mergeTrees(rt.repo, { base, ours, theirs: filteredTheirs });
		if (merged.failed) return { status: "unavailable", reason: "merge-failed" };
		if (merged.conflicts.length > 0) {
			// 此时还没写盘，工作区一个字节都没动
			return {
				status: "conflict",
				conflicts: merged.conflicts,
				repairPatch: await diffPatch(rt.repo, base, theirs),
				reason: "merge",
			};
		}

		await checkoutTree(rt.repo, merged.treeOid);

		const changedNow = await diffPaths(rt.repo, ours, merged.treeOid);
		const inMerged = await listTree(rt.repo, merged.treeOid);
		const reverted = changedNow.filter((p) => inMerged.has(p));
		const deleted = changedNow.filter((p) => !inMerged.has(p));

		return {
			status: "reverted",
			reverted,
			deleted,
			skipped: [...binGuard.skip],
			rollback: async () => {
				await checkoutTree(rt.repo, ours);
			},
			postTreeOid: merged.treeOid,
			oursTreeOid: ours,
		};
	}

	/**
	 * 二进制闸门（plan §2 步骤 7b）。
	 *
	 * - 当前 blob 与 theirs 的 blob 相同 → 无冲突风险，交给正常合并写回（放进 `skip` 没必要，
	 *   这里不动 scope，合并结果就是 theirs）
	 * - 当前 blob ≠ theirs 且 ≠ base → 二进制无"部分回退"，**直接判类别 A 冲突**
	 */
	private async binaryGuard(
		repo: ShadowRepo,
		base: string,
		theirs: string,
		ours: string,
		scope: string[],
	): Promise<{ conflicts: string[]; skip: Set<string> }> {
		const bins = await detectBinaryPaths(repo, { fromTree: base, oursTree: ours, paths: scope });
		const skip = new Set<string>();
		if (bins.size === 0) return { conflicts: [], skip };

		const [baseTree, theirsTree, oursTree] = await Promise.all([
			listTree(repo, base),
			listTree(repo, theirs),
			listTree(repo, ours),
		]);
		const conflicts: string[] = [];
		for (const path of bins) {
			const oursSha = oursTree.get(path)?.sha ?? "";
			const theirsSha = theirsTree.get(path)?.sha ?? "";
			if (oursSha === theirsSha) continue; // 已经和目标一致，无需处理
			const baseSha = baseTree.get(path)?.sha ?? "";
			if (oursSha === baseSha) {
				// 用户没动过这个二进制 → 安全回退（合并会取 theirs）
				continue;
			}
			// 用户（或窗口外的会话）改过它 → 二进制没法按行合并，判冲突
			conflicts.push(path);
		}
		if (conflicts.length > 0) skip.clear();
		return { conflicts, skip };
	}

	/**
	 * 撤回成功后重置时间线：删掉 `turnIndex >= targetTurn` 的条目，再 push 一条 recall。
	 * `postTreeOid` 用 `recallCode` 返回的合并树，不必重拍。
	 */
	async commitRecall(
		sessionId: string,
		cwd: string,
		targetTurn: number,
		postTreeOid: string,
		exclusive: boolean,
	): Promise<void> {
		if (!this.gitAvailable) return;
		const rt = this.sessions.get(sessionId);
		if (!rt) return;
		if (resolve(cwd) !== resolve(rt.repo.workTree)) {
			log.warn("cwd 与会话快照库不一致，跳过重置时间线", sessionId, rt.repo.workTree, cwd);
			return;
		}
		try {
			await this.enqueue(rt, async () => {
				const dropped = rt.state.snapshots.filter((s) => s.turnIndex >= targetTurn);
				rt.state.snapshots = rt.state.snapshots.filter((s) => s.turnIndex < targetTurn);
				await deleteSnapshots(rt.repo, refsOf(dropped));
				const commit = await this.commitOrNull(rt, postTreeOid, "recall", targetTurn - 1);
				rt.state.snapshots.push({
					turnIndex: targetTurn - 1,
					treeOid: postTreeOid,
					commitOid: commit?.commitOid,
					ref: commit?.ref,
					exclusive,
					skipped: [],
					kind: "recall",
				});
				await this.trim(rt, dropped.length > 0);
				await this.persist(rt);
			});
		} catch (err) {
			log.warn("重置撤回时间线失败", sessionId, String(err));
		}
	}

	/** 会话删除：清影子库 + index + 元数据 */
	async disposeSession(sessionId: string): Promise<void> {
		const rt = this.sessions.get(sessionId);
		if (!rt) return;
		await this.idle(sessionId).catch(() => {});
		this.sessions.delete(sessionId);
		this.stores.delete(sessionId);
		await removeShadowRepo(rt.repo, rt.metaPath).catch((err: unknown) => {
			log.warn("清理会话快照失败", sessionId, String(err));
		});
	}

	async disposeAll(): Promise<void> {
		// 进程退出：只清内存状态，**不删影子库**（下次启动要接着用）
		this.sessions.clear();
		this.stores.clear();
	}

	/** 诊断用：某会话的快照条目（测试与日志） */
	entriesOf(sessionId: string): SnapshotEntry[] {
		return this.sessions.get(sessionId)?.state.snapshots ?? [];
	}

	// ── 内部 ──────────────────────────────────────────────────────────────

	private async runtime(sessionId: string, cwd: string): Promise<SessionRuntime> {
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;

		await mkdir(this.dir, { recursive: true });
		const repo: ShadowRepo = {
			gitDir: join(this.dir, `${sessionId}.git`),
			workTree: cwd,
			indexPath: join(this.dir, `${sessionId}.index`),
		};
		await initShadowRepo(repo);

		const metaPath = join(this.dir, `${sessionId}.json`);
		const store = this.storeFor(sessionId, metaPath);
		const loaded = await store.read();
		const state: SnapshotState =
			loaded && loaded.version === 1 && Array.isArray(loaded.snapshots)
				? { ...loaded, cwd }
				: { version: 1, cwd, snapshots: [] };

		const rt: SessionRuntime = { sessionId, repo, metaPath, state, tail: Promise.resolve(), pending: 0 };
		this.sessions.set(sessionId, rt);
		return rt;
	}

	private storeFor(sessionId: string, metaPath: string): JsonStore<SnapshotState> {
		const existing = this.stores.get(sessionId);
		if (existing) return existing;
		const store = new JsonStore<SnapshotState>({
			path: metaPath,
			defaultValue: () => ({ version: 1, cwd: "", snapshots: [] }),
		});
		this.stores.set(sessionId, store);
		return store;
	}

	/** 链式排队：同一会话的打点按入队顺序执行 */
	private enqueue(rt: SessionRuntime, op: () => Promise<void>): Promise<void> {
		rt.pending += 1;
		const next = rt.tail.then(op, op).finally(() => {
			rt.pending -= 1;
		});
		rt.tail = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	private async commitOrNull(
		rt: SessionRuntime,
		treeOid: string,
		kind: SnapshotEntry["kind"],
		turnIndex: number,
	): Promise<{ commitOid: string; ref: string } | undefined> {
		const label = `${kind}-${turnIndex}`;
		const ref = `refs/snap/${label}`;
		try {
			const commitOid = await commitTree(rt.repo, treeOid, `snapshot ${label}`);
			// ref 只为调试可读（`git --git-dir=<...> log refs/snap/turn-3`），代码逻辑不依赖它
			await runGit(rt.repo, ["update-ref", ref, commitOid]);
			return { commitOid, ref };
		} catch (err) {
			log.warn("写快照 commit 失败（只影响调试可读性）", label, String(err));
			return undefined;
		}
	}

	/**
	 * 保留窗口裁剪：从头部删，删掉的条目对应 ref 一起清，然后异步回收。
	 * `forceGc` 用于「刚删了一批 ref」的场合（撤回丢弃整段历史），否则只在真裁剪时才回收
	 * —— 每次打点都 repack 会把快照成本从 130ms 抬到秒级。
	 */
	private async trim(rt: SessionRuntime, forceGc = false): Promise<void> {
		const overflow = rt.state.snapshots.length - this.maxSnapshots;
		const dropped = overflow > 0 ? rt.state.snapshots.splice(0, overflow) : [];
		if (dropped.length > 0) await deleteSnapshots(rt.repo, refsOf(dropped));
		if (dropped.length > 0 || forceGc) void gcShadowRepo(rt.repo);
	}

	private async persist(rt: SessionRuntime): Promise<void> {
		await this.storeFor(rt.sessionId, rt.metaPath).write(rt.state);
	}
}

/** 一批条目对应的调试 ref（裁剪/丢弃时删掉它们，对象才会变成不可达） */
function refsOf(entries: SnapshotEntry[]): string[] {
	return entries.map((e) => e.ref).filter((ref): ref is string => typeof ref === "string");
}

/** 最后一个 `turnIndex === targetTurn - 1` 的条目（撤回第 T 轮时要还原到「第 T-1 轮做完」） */
function beforeTurn(snapshots: SnapshotEntry[], targetTurn: number): SnapshotEntry | undefined {
	const want = targetTurn - 1;
	for (let i = snapshots.length - 1; i >= 0; i -= 1) {
		const entry = snapshots[i];
		if (entry && entry.turnIndex === want) return entry;
	}
	// 会话是中途打开的（基线 turnIndex 可能 > -1）：只要想要的那一轮不早于基线，就用基线兜底。
	// ❗ 不能无条件回退到基线 —— 那会把「目标轮已超出保留窗口」误当成可撤回，
	// 静默把工作区倒回很久以前。
	const baseline = snapshots.find((s) => s.kind === "baseline");
	if (baseline && want <= baseline.turnIndex) return baseline;
	return undefined;
}

/** 窗口 `[targetTurn, last.turnIndex]` 内每条打点都独占，才敢整片回退 */
function windowIsExclusive(snapshots: SnapshotEntry[], targetTurn: number): boolean {
	const last = snapshots[snapshots.length - 1];
	if (!last) return false;
	const window = snapshots.filter((s) => s.turnIndex >= targetTurn && s.turnIndex <= last.turnIndex);
	return window.length > 0 && window.every((s) => s.exclusive);
}

/** 把 `deriveTurnChanges` 给的原始路径（可能绝对、可能 Windows 分隔符）归一成快照里的 posix 相对路径 */
export function normalizeLedgerPaths(cwd: string, paths: string[]): Set<string> {
	const out = new Set<string>();
	const root = resolve(cwd);
	for (const raw of paths) {
		if (!raw) continue;
		const abs = resolve(root, raw);
		const rel = relative(root, abs);
		if (!rel || rel.startsWith("..")) continue; // 项目外，快照里不可能有
		out.add(rel.split(sep).join("/"));
	}
	return out;
}
