import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { PiBackend } from "../src/pi-backend";
import type { RegisteredSession, SessionRegistry } from "../src/session/registry";

/**
 * 阶段 3 端到端：`PiBackend` 接线（基线 + `agent_settled` 打点 + `recallMessage` 撤回代码）。
 *
 * 这里刻意走**真实** AgentSession + 真实 git（临时目录），因为本阶段的风险全在接线上：
 * 基线建得对不对、打点时机对不对、撤回时账本路径算得对不对。快照算法本身由
 * `snapshots.test.ts` / `snapshot-git.test.ts` 覆盖。
 *
 * 模型用假流（`streamFunction` 直接 push done），不碰网络。
 */

const roots: string[] = [];
const sessions: AgentSession[] = [];

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose();
	for (const root of roots.splice(0)) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// Windows 上 git 对象文件是只读的，偶发 EPERM/EBUSY：留给系统清理
		}
	}
});

const model: Model<"openai-completions"> = {
	id: "recall-code-test",
	name: "recall-code-test",
	provider: "test",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function doneMessage(): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason: "stop",
		content: [{ type: "text", text: "done" }],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "percho-recall-code-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		settingsManager,
		resourceLoader,
		noTools: "all",
		sessionManager: SessionManager.create(cwd, join(root, "sessions")),
		modelRuntime: {
			getModel: () => model,
			hasConfiguredAuth: () => true,
			checkAuth: async () => ({ type: "api_key", key: "test-key" }),
			getAuth: async () => undefined,
		} as unknown as ModelRuntime,
	});
	sessions.push(session);
	/** 每次模型请求前跑一次：模拟 agent 在这一轮里改文件；可以返回一个 Promise 卡住这一轮 */
	let onRequest: (() => void | Promise<void>) | undefined;
	session.agent.streamFunction = async () => {
		await onRequest?.();
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: doneMessage() });
		return stream;
	};
	/**
	 * `backend.prompt` 在 preflight 就 resolve（不等整轮跑完），所以测试必须自己等 `agent_settled`，
	 * 否则断言会跑在 agent 还没改文件/还没落库的时刻。
	 */
	const run = async (backend: PiBackend, text: string) => {
		const settled = new Promise<void>((resolve) => {
			const off = session.subscribe((e) => {
				if (e.type === "agent_settled") {
					off();
					resolve();
				}
			});
		});
		await backend.prompt(session.sessionId, text);
		await settled;
	};
	const backend = new PiBackend({
		projectTrust: false,
		permissionGates: false,
		snapshotsDir: join(root, "snap"),
	});
	const registry = (backend as unknown as { registry: SessionRegistry }).registry;
	registry.add({
		session,
		cwd,
		unsubscribe: () => {},
		gate: { dispose: () => {} },
		dialogs: { dispose: () => {} },
	} as unknown as RegisteredSession);
	// 走真实的接线方法（wireSession 里对非只读会话调的就是它）
	(backend as unknown as { attachSnapshots: (s: AgentSession, cwd: string) => void }).attachSnapshots(
		session,
		cwd,
	);
	return {
		backend,
		session,
		cwd,
		root,
		run: (b: PiBackend, text: string) => run(b, text),
		setOnRequest: (fn: () => void | Promise<void>) => {
			onRequest = fn;
		},
	};
}

const attach = (backend: PiBackend) =>
	backend as unknown as {
		snapshots: { idle: (id: string) => Promise<void>; entriesOf: (id: string) => unknown[] };
	};

/** `ensureBaseline`/`record` 都是 fire-and-forget，`idle` 只能等到已建 runtime 的队列——所以轮询 */
async function waitEntries(backend: PiBackend, sessionId: string, min: number): Promise<void> {
	for (let i = 0; i < 200; i += 1) {
		await attach(backend).snapshots.idle(sessionId);
		if (attach(backend).snapshots.entriesOf(sessionId).length >= min) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`等不到 ${min} 条快照条目`);
}

describe("PiBackend 撤回代码（阶段 3 接线）", () => {
	it("一轮跑完后撤回：磁盘文件回到该轮之前，对话也回到该轮之前", async () => {
		const f = await fixture();
		writeFileSync(join(f.cwd, "a.txt"), "v1\n");
		// 基线 = 会话打开时的工作区（此时还没有 a.txt 的改动）
		await waitEntries(f.backend, f.session.sessionId, 1);

		f.setOnRequest(() => writeFileSync(join(f.cwd, "a.txt"), "v2-agent\n"));
		await f.run(f.backend, "改一下 a.txt");
		await waitEntries(f.backend, f.session.sessionId, 2);

		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("v2-agent\n");
		const entries = attach(f.backend).snapshots.entriesOf(f.session.sessionId);
		expect(entries.length).toBeGreaterThanOrEqual(2);

		const branch = f.session.sessionManager.getBranch();
		const user = branch.findLast((e) => e.type === "message" && e.message.role === "user");
		if (user?.type !== "message") throw new Error("missing user message");

		const recalled = await f.backend.recallMessage(f.session.sessionId, { entryId: user.id });
		expect(recalled.recalled).toBe(true);
		expect(recalled.code?.status).toBe("reverted");
		// 代码真的回到 v1，且账本路径被正确识别
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("v1\n");
		expect(recalled.code?.reverted ?? []).toContain("a.txt");
		// 对话也回到该轮之前：分支里不再有这条 user 消息
		expect(
			f.session.sessionManager.getBranch().filter((e) => e.type === "message" && e.message.role === "user"),
		).toHaveLength(0);
		await f.backend.dispose();
	});

	it("followUp 排队的第二轮也有自己的快照：撤回第二轮回到第一轮之后的状态（BUG C）", async () => {
		const f = await fixture();
		writeFileSync(join(f.cwd, "a.txt"), "base\n");
		await waitEntries(f.backend, f.session.sessionId, 1);

		// 第 1 轮：卡住流，让第 2 条 user 消息在 run 期间排队成 followUp
		let release = (): void => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let request = 0;
		f.setOnRequest(async () => {
			request += 1;
			if (request === 1) {
				writeFileSync(join(f.cwd, "a.txt"), "after-first\n");
				await gate;
			} else {
				// ❗ 不加任何延迟：BUG E 修好后 turn_end 已同步冻结 index，第二轮立即写盘也不影响
				writeFileSync(join(f.cwd, "a.txt"), "after-second\n");
			}
		});

		const settled = new Promise<void>((resolve) => {
			const off = f.session.subscribe((e) => {
				if (e.type === "agent_settled") {
					off();
					resolve();
				}
			});
		});
		await f.backend.prompt(f.session.sessionId, "第一条");
		// 等第 1 轮真的开跑，再把第二条挤进 followUp 队列
		for (let i = 0; i < 100 && !f.session.isStreaming; i += 1) await new Promise((r) => setTimeout(r, 10));
		await f.backend.prompt(f.session.sessionId, "第二条");
		release();
		await settled;
		await waitEntries(f.backend, f.session.sessionId, 3); // baseline + turn 0 + turn 1

		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("after-second\n");
		const entries = attach(f.backend).snapshots.entriesOf(f.session.sessionId) as {
			turnIndex: number;
			kind: string;
		}[];
		// 关键：turn 0 与 turn 1 都要有（旧实现只有 settled 打点 → 只剩 turn 1）
		expect(entries.map((e) => e.turnIndex)).toEqual([-1, 0, 1]);

		const branch = f.session.sessionManager.getBranch();
		const userMessages = branch.filter((e) => e.type === "message" && e.message.role === "user");
		expect(userMessages).toHaveLength(2);
		const second = userMessages[1];
		if (second?.type !== "message") throw new Error("missing second user message");

		const recalled = await f.backend.recallMessage(f.session.sessionId, { entryId: second.id });
		expect(recalled.recalled).toBe(true);
		expect(recalled.code?.status).toBe("reverted");
		// 回到「第 1 轮之后」的状态，而不是 out-of-window / 一字节没动
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("after-first\n");
		await f.backend.dispose();
	});

	it("code 侧 unavailable 时仍然重置时间线（BUG D：传 undefined 让 commitRecall 现拍）", async () => {
		const f = await fixture();
		writeFileSync(join(f.cwd, "a.txt"), "base\n");
		await waitEntries(f.backend, f.session.sessionId, 1);
		f.setOnRequest(() => writeFileSync(join(f.cwd, "a.txt"), "v2\n"));
		await f.run(f.backend, "改一下");
		await waitEntries(f.backend, f.session.sessionId, 2);

		// 强制 code 那一半失败（模拟 git 不可用 / internal），只撤对话
		const snaps = attach(f.backend).snapshots as unknown as {
			recallCode: (req: unknown) => Promise<unknown>;
			commitRecall: (a: string, b: string, c: number, d: string | undefined, e: boolean) => Promise<void>;
		};
		const calls: (string | undefined)[] = [];
		const realRecall = snaps.recallCode.bind(snaps);
		const realCommit = snaps.commitRecall.bind(snaps);
		snaps.recallCode = async () => ({ status: "unavailable", reason: "test" });
		snaps.commitRecall = async (a, b, c, d, e) => {
			calls.push(d);
			return realCommit(a, b, c, d, e);
		};

		const branch = f.session.sessionManager.getBranch();
		const user = branch.findLast((e) => e.type === "message" && e.message.role === "user");
		if (user?.type !== "message") throw new Error("missing user message");
		const recalled = await f.backend.recallMessage(f.session.sessionId, { entryId: user.id });

		snaps.recallCode = realRecall;
		snaps.commitRecall = realCommit;
		expect(recalled.recalled).toBe(true);
		expect(recalled.code?.status).toBe("unavailable");
		// 关键：时间线照样重置，且 postTreeOid 传 undefined（由 commitRecall 现拍）
		expect(calls).toEqual([undefined]);
		// 时间线只剩基线 + recall 条目（第 1 轮被丢弃）
		const kinds = (attach(f.backend).snapshots.entriesOf(f.session.sessionId) as { kind: string }[]).map(
			(e) => e.kind,
		);
		expect(kinds).toEqual(["baseline", "recall"]);
		await f.backend.dispose();
	});

	it("会话没有快照能力时降级为只撤对话（code = unavailable，不抛错）", async () => {
		const f = await fixture();
		// 手动塞一个没有 attachSnapshots 过的会话：模拟 git 不可用/无基线
		const backend = new PiBackend({
			projectTrust: false,
			permissionGates: false,
			snapshotsDir: join(f.root, "snap-none"),
		});
		const registry = (backend as unknown as { registry: SessionRegistry }).registry;
		registry.add({
			session: f.session,
			cwd: f.cwd,
			unsubscribe: () => {},
			gate: { dispose: () => {} },
			dialogs: { dispose: () => {} },
		} as unknown as RegisteredSession);
		writeFileSync(join(f.cwd, "a.txt"), "keep\n");
		await f.run(backend, "hello");
		const branch = f.session.sessionManager.getBranch();
		const user = branch.findLast((e) => e.type === "message" && e.message.role === "user");
		if (user?.type !== "message") throw new Error("missing user message");

		const recalled = await backend.recallMessage(f.session.sessionId, { entryId: user.id });
		expect(recalled.recalled).toBe(true);
		expect(recalled.code?.status).toBe("unavailable");
		// 工作区一个字节都没动
		expect(readFileSync(join(f.cwd, "a.txt"), "utf8")).toBe("keep\n");
		await backend.dispose();
		await f.backend.dispose();
	});
});
