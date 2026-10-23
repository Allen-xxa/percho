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
}

export interface RecallCodeSuccess {
	status: "reverted";
	reverted: string[];
	deleted: string[];
	/**
	 * 「已经是目标状态、无需动作」的路径（二进制闸门里当前 blob == theirs 的那些）。
	 * 用户视角和 `reverted` 一样是「没动」，**不是失败项**。
	 */
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

	/**
	 * 打点：`turnIndex` 已有条目则**覆盖**（同轮可能多次 turn_end），否则追加。
	 *
	 * ❗ 不能用「只 append」：followUp 排队时一轮里有多条 user 消息，`agent_settled` 是
	 * 整个 run 结束才发，按 settled 打点会跳过中间那一轮（review BUG C）。改成按 turn_end
	 * 打点后，同一 turnIndex 会被打多次（每次 turn_end 都是一次完整的工作区状态）。
	 * 覆盖时把旧条目的 ref 一并删掉（它指向的 commit 已被新条目接管）。
	 */
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
				// 同 turnIndex 覆盖（同轮多次 turn_end）：**必须先摘掉旧条目和它的 ref**，
				// 再建新 ref —— 否则新 ref 与旧 ref 同名，刚建好就被下面这行删掉。
				const existing = rt.state.snapshots.findIndex((s) => s.turnIndex === turnIndex);
				if (existing >= 0) {
					const [old] = rt.state.snapshots.splice(existing, 1);
					if (old?.ref) await deleteSnapshots(rt.repo, [old.ref]);
				}
				const last = rt.state.snapshots[rt.state.snapshots.length - 1];
				// 内容没变 → 不新建 commit 对象，但**仍然给本条目自己的 ref**（复用同一个 commit OID）。
				// 理由：ref 是条目的 liveness。若让本条 ref 空着、只靠前一条的 ref 撑着这棵树，
				// 一旦前一条被 trim 裁掉，这条还在窗口内的条目就会连带被 prune 掉（BUG B）。
				const commit =
					last?.treeOid === treeOid && last.commitOid
						? await this.pointRef(rt, "turn", turnIndex, last.commitOid)
						: await this.commitOrNull(rt, treeOid, "turn", turnIndex);
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

		// ❗ 这条链会反复改写 index（snapshotTree 的 add -A → buildFilteredTree 的 read-tree base
		// → resetIndexTo(ours) → checkoutTree 的 read-tree -u merged）。任何一步抛错，index 都会停在
		// 半路（既不是 base 也不是 ours），下一次打点的 `add -A` 就会算错增量。
		// 所以：只要没成功写盘，finally 无条件把 index 拨回 ours。
		let ours: string | null = null;
		let wrote = false;
		try {
			// 用户可能手改过工作区，必须现拍（不能复用上一次打点的树）
			ours = (await snapshotTree(rt.repo, { skipOverBytes: this.skipOverBytes })).treeOid;

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
			// 已经和目标状态一致的二进制不需要参与合并（写回也是同样的字节）
			scope = scope.filter((p) => !binGuard.resolved.has(p));

			// 缩窄 theirs：只保留 scope 内的路径，窗口外的路径保持工作区原样
			const filteredTheirs = await buildFilteredTree(rt.repo, base, theirs, scope);
			// merge-tree 前 index 必须停在 ours 树上
			await resetIndexTo(rt.repo, ours);
			const merged = await mergeTrees(rt.repo, { base, ours, theirs: filteredTheirs });
			// ❗ failed 必须在 conflicts 之前判：否则「基础设施失败」会被当成「无冲突」继续往下走
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
			wrote = true;

			const changedNow = await diffPaths(rt.repo, ours, merged.treeOid);
			const inMerged = await listTree(rt.repo, merged.treeOid);
			const reverted = changedNow.filter((p) => inMerged.has(p));
			const deleted = changedNow.filter((p) => !inMerged.has(p));
			const restoredOurs = ours;

			return {
				status: "reverted",
				reverted,
				deleted,
				skipped: [...binGuard.resolved],
				rollback: async () => {
					await checkoutTree(rt.repo, restoredOurs);
				},
				postTreeOid: merged.treeOid,
				oursTreeOid: restoredOurs,
			};
		} finally {
			if (!wrote) {
				// 没写盘 = 工作区还是 ours 的样子，index 必须与之一致（拍不出 ours 时退化成 last.treeOid）
				const target = ours ?? last.treeOid;
				await resetIndexTo(rt.repo, target).catch((err: unknown) => {
					log.warn(
						"恢复 index 失败（下次打点可能算错增量，下次撤回可能漏删文件）",
						rt.sessionId,
						String(err),
					);
				});
			}
		}
	}

	/**
	 * 二进制闸门（plan §2 步骤 7b，review 2026-10-23 23:12 改成三方判定）。
	 *
	 * - 当前 blob == theirs  → `resolved`：已经是目标状态，从 scope 移除
	 * - 当前 blob == base    → 留在 scope 交给 merge-tree（ours === base 时直接取 theirs，干净不冲突）。
	 *   ❗ 这是**最正常**的情况：窗口内被 agent 改过、之后没人动过，当前内容本就该是 base。
	 * - 都不是               → 真的被人动过，二进制没法按行合并，判类别 A 冲突
	 */
	private async binaryGuard(
		repo: ShadowRepo,
		base: string,
		theirs: string,
		ours: string,
		scope: string[],
	): Promise<{ conflicts: string[]; resolved: Set<string> }> {
		const bins = await detectBinaryPaths(repo, { fromTree: base, oursTree: ours, paths: scope });
		const resolved = new Set<string>();
		if (bins.size === 0) return { conflicts: [], resolved };

		const [baseTree, theirsTree, oursTree] = await Promise.all([
			listTree(repo, base),
			listTree(repo, theirs),
			listTree(repo, ours),
		]);
		const conflicts: string[] = [];
		for (const path of bins) {
			const oursSha = oursTree.get(path)?.sha ?? "";
			const theirsSha = theirsTree.get(path)?.sha ?? "";
			if (oursSha === theirsSha) {
				resolved.add(path);
				continue;
			}
			const baseSha = baseTree.get(path)?.sha ?? "";
			if (oursSha === baseSha) continue;
			conflicts.push(path);
		}
		return { conflicts, resolved };
	}

	/**
	 * 撤回成功后重置时间线：删掉 `turnIndex >= targetTurn` 的条目，再 push 一条 recall。
	 *
	 * `postTreeOid` 用 `recallCode` 返回的合并树（`reverted` 时）不必重拍；
	 * **code 侧 `unavailable` 时也要传 `undefined` 进来调一次** —— 对话已经撤了，
	 * 时间线不重置就会让数组不再单调，之后撤回静默空转（review BUG D）。
	 * 传 `undefined` 时这里现拍一次（30–130ms，撤回是低频操作）。
	 */
	async commitRecall(
		sessionId: string,
		cwd: string,
		targetTurn: number,
		postTreeOid: string | undefined,
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
				const treeOid =
					postTreeOid ?? (await snapshotTree(rt.repo, { skipOverBytes: this.skipOverBytes })).treeOid;
				const dropped = rt.state.snapshots.filter((s) => s.turnIndex >= targetTurn);
				rt.state.snapshots = rt.state.snapshots.filter((s) => s.turnIndex < targetTurn);
				await deleteSnapshots(rt.repo, refsOf(dropped));
				const commit = await this.commitOrNull(rt, treeOid, "recall", targetTurn - 1);
				rt.state.snapshots.push({
					turnIndex: targetTurn - 1,
					treeOid,
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

	/** 把 `refs/snap/<kind>-<turnIndex>` 指向已有 commit（内容没变的轮次复用同一 commit） */
	private async pointRef(
		rt: SessionRuntime,
		kind: SnapshotEntry["kind"],
		turnIndex: number,
		commitOid: string,
	): Promise<{ commitOid: string; ref: string } | undefined> {
		const ref = `refs/snap/${kind}-${turnIndex}`;
		try {
			await runGit(rt.repo, ["update-ref", ref, commitOid]);
			return { commitOid, ref };
		} catch (err) {
			log.warn("写快照 ref 失败（只影响调试可读性与可达性）", ref, String(err));
			return undefined;
		}
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
	 * 保留窗口裁剪：从头部删，删掉的条目对应 ref 一起清，然后回收。
	 * `forceGc` 用于「刚删了一批 ref」的场合（撤回丢弃整段历史），否则只在真裁剪时才回收
	 * —— 每次打点都 repack 会把快照成本从 130ms 抬到秒级。
	 *
	 * ❗ GC **必须排进队列**（不能 `void` 甩出去）：`prune --expire=now` 会删掉所有不可达对象，
	 * 而下一次 `record` 的 `add -A` 刚写进去的 blob 此刻正是不可达的（还没 commit/ref 指向），
	 * 被 prune 后紧接着的 `write-tree` 就会报缺对象。
	 */
	private async trim(rt: SessionRuntime, forceGc = false): Promise<void> {
		const overflow = rt.state.snapshots.length - this.maxSnapshots;
		const dropped = overflow > 0 ? rt.state.snapshots.splice(0, overflow) : [];
		if (dropped.length > 0) await deleteSnapshots(rt.repo, refsOf(dropped));
		if (dropped.length > 0 || forceGc) {
			// ❗ 直接 await，不再 enqueue：trim 的调用方都已经在 enqueue 内，嵌套 enqueue 会等自己
			// 的 tail → 死锁（实测整轮超时 5s）。直接 await 就已经在串行队列里了，
			// 这也保证 GC 不会跟下一次 `add -A` 撞车（prune 会删掉刚写入但尚未被引用的 blob）。
			await gcShadowRepo(rt.repo).catch((err: unknown) => {
				log.warn("回收快照对象失败（只是占空间）", rt.sessionId, String(err));
			});
		}
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
	// 找不到就是超出保留窗口，**不能用基线顶替**：基线条目本身就在数组里（`ensureBaseline` push 了它），
	// 循环已经覆盖了它。能走到这里的唯一情况是 `want < baseline.turnIndex` —— 目标轮早于会话开始，
	// 快照里根本没有那个状态，拿基线顶替会静默把工作区倒回很久以前（review BUG A）。
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
