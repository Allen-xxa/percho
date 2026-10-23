// 阶段 0 冒烟：`agent_settled` 事件时机断言（plan §0.2 的 4 条）。
//
// 用真实 PiBackend + 真实 SDK 跑一轮「问一句 → 让它写一个文件」，只伪造模型传输层
// （本地 HTTP 服务器回 OpenAI-completions 流）。dev 默认 provider 端点实测不可用
// （192.168.1.52:12345 超时），所以这里必须自建 mock，不能连真实模型。
//
//   1  session.subscribe 能收到 agent_settled（类型已在联合里，这里是运行时确认）
//   2  一次 run **只发一次** agent_settled（turn_end 会发多次 —— 这就是不用它的原因）
//   3  收到 agent_settled 时 isStreaming === false 且 isCompacting === false
//   4  被 abort() 中断的 run 也发 agent_settled（aborted: true）—— 此时不应打点
//
// 用法：node node_modules/jiti/lib/jiti-cli.mjs scripts/smoke-snapshot-events.mts
//       （全过 exit 0；任一失败 exit 1；需 jiti，原因见 smoke-snapshot-git.mts 头注释）
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
	results.push({ name, ok, detail });
	console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (cond()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`timeout waiting for ${label}`));
			}
		}, 25);
	});
}

type Mode = "tool-then-text" | "hang";

let mode: Mode = "tool-then-text";
let requestCount = 0;

/** OpenAI-completions 流式响应的一帧。 */
function sse(res: import("node:http").ServerResponse, payload: unknown): void {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const CHUNK_BASE = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock-model" };

async function main(): Promise<void> {
	const agentDir = mkdtempSync(join(tmpdir(), "percho-smoke-snap-events-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_LOG_LEVEL = "warn";
	const workDir = join(agentDir, "work");
	mkdirSync(workDir, { recursive: true });
	console.log(`[setup] temp agent dir: ${agentDir}`);

	// ---- 本地 mock provider（OpenAI completions 流） ----
	const server: Server = createServer((req, res) => {
		req.resume();
		requestCount++;
		if (mode === "hang") {
			// 永不响应：留给 abort() 打断
			return;
		}
		// 第一轮：发一个 write 工具调用；第二轮：收尾文本
		const round = requestCount;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (round % 2 === 1) {
			sse(res, { ...CHUNK_BASE, choices: [{ index: 0, delta: { role: "assistant", content: "我来写。" } }] });
			sse(res, {
				...CHUNK_BASE,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call-1",
									type: "function",
									function: { name: "write", arguments: "" },
								},
							],
						},
					},
				],
			});
			sse(res, {
				...CHUNK_BASE,
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									function: { arguments: JSON.stringify({ path: "note.txt", content: "hello from mock\n" }) },
								},
							],
						},
					},
				],
			});
			sse(res, {
				...CHUNK_BASE,
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			});
		} else {
			sse(res, { ...CHUNK_BASE, choices: [{ index: 0, delta: { role: "assistant", content: "写好了。" } }] });
			sse(res, { ...CHUNK_BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
		}
		sse(res, {
			...CHUNK_BASE,
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
		});
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	console.log(`[setup] mock provider: http://127.0.0.1:${port}/v1`);

	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					snapmock: {
						name: "snapmock",
						baseUrl: `http://127.0.0.1:${port}/v1`,
						api: "openai-completions",
						models: [{ id: "mock-model", contextWindow: 128_000, maxTokens: 4096 }],
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ snapmock: { type: "api_key", key: "sk-fake" } }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, cacheWarming: "off" }));

	const { PiBackend } = await import("../packages/backend/src/index.ts");
	const backend = new PiBackend({
		defaultCwd: workDir,
		projectTrust: false,
		permissionGates: false,
		permissionExtension: false,
	});
	await backend.init();

	type Recorded = { seq: number; type: string; event: { type: string; aborted?: boolean } };
	let events: Recorded[] = [];
	backend.onEvent((_sessionId, event) => {
		events.push({ seq: events.length, type: event.type, event: event as { type: string; aborted?: boolean } });
	});

	// 取运行态（断言 3 要在收到事件的那一刻读）
	const runtimeOf = (sessionId: string): { streaming: boolean; compacting: boolean } | undefined => {
		const registry = (backend as unknown as { registry: { get(id: string): unknown } }).registry;
		const entry = registry.get(sessionId) as { session?: { isStreaming: boolean; isCompacting: boolean } } | undefined;
		if (!entry?.session) return undefined;
		return { streaming: entry.session.isStreaming, compacting: entry.session.isCompacting };
	};

	// ================= 断言 1–3：正常一轮 =================
	console.log("\n=== 1–3. 正常一轮（工具调用 → 收尾） ===");
	{
		mode = "tool-then-text";
		requestCount = 0;
		events = [];
		const meta = await backend.createSession({ cwd: workDir, provider: "snapmock", modelId: "mock-model" });
		console.log(`[session] ${meta.sessionId}`);
		// 记录收到 agent_settled 那一刻的运行态
		let runtimeAtSettled: { streaming: boolean; compacting: boolean } | undefined;
		const originalPush = events.push.bind(events);
		events.push = ((item: Recorded): number => {
			if (item.type === "agent_settled") runtimeAtSettled = runtimeOf(meta.sessionId);
			return originalPush(item);
		}) as typeof events.push;

		await backend.prompt(meta.sessionId, "写一个文件");
		await waitFor(() => events.some((e) => e.type === "agent_settled"), 60_000, "agent_settled");

		const settled = events.filter((e) => e.type === "agent_settled");
		const turnEnds = events.filter((e) => e.type === "turn_end");
		check(
			"1 session.subscribe 收到 agent_settled（运行时确认）",
			settled.length > 0,
			`seq=${settled.map((e) => e.seq).join(",")} 事件序列=${[...new Set(events.map((e) => e.type))].join(" → ")}`,
		);
		check("2 一次 run 只发一次 agent_settled", settled.length === 1, `count=${settled.length} seq=${settled.map((e) => e.seq)}`);
		check(
			"2 turn_end 发了多次（证明不能用 turn_end 打点）",
			turnEnds.length >= 2,
			`turn_end count=${turnEnds.length} seq=${turnEnds.map((e) => e.seq)}`,
		);
		check(
			"3 收到 agent_settled 时 isStreaming=false",
			runtimeAtSettled?.streaming === false,
			JSON.stringify(runtimeAtSettled),
		);
		check(
			"3 收到 agent_settled 时 isCompacting=false",
			runtimeAtSettled?.compacting === false,
			JSON.stringify(runtimeAtSettled),
		);
		check(
			"3 正常结束时 aborted 不为 true",
			settled[0]?.event.aborted !== true,
			`aborted=${settled[0]?.event.aborted}`,
		);
		const notePath = join(workDir, "note.txt");
		let noteOk = false;
		try {
			noteOk = readFileSync(notePath, "utf8") === "hello from mock\n";
		} catch {
			noteOk = false;
		}
		check("背景：mock 的 write 工具真的写了文件", noteOk, notePath);
		await backend.closeSession(meta.sessionId);
	}

	// ================= 断言 4：abort 也会发 agent_settled =================
	console.log("\n=== 4. abort 中断的 run 也发 agent_settled ===");
	{
		mode = "hang";
		requestCount = 0;
		events = [];
		const meta = await backend.createSession({ cwd: workDir, provider: "snapmock", modelId: "mock-model" });
		console.log(`[session] ${meta.sessionId}`);
		await backend.prompt(meta.sessionId, "这一轮会被打断");
		await waitFor(() => runtimeOf(meta.sessionId)?.streaming === true, 20_000, "run 进入 streaming");
		await backend.abort(meta.sessionId);
		await waitFor(() => events.some((e) => e.type === "agent_settled"), 30_000, "aborted agent_settled");
		const settled = events.filter((e) => e.type === "agent_settled");
		check("4 abort 后仍发 agent_settled", settled.length === 1, `count=${settled.length}`);
		check("4 aborted === true（此时不应打点）", settled[0]?.event.aborted === true, `aborted=${settled[0]?.event.aborted}`);
		await backend.closeSession(meta.sessionId);
	}

	backend.dispose();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (process.env.KEEP_AGENT_DIR !== "1") rmSync(agentDir, { recursive: true, force: true });

	const failed = results.filter((r) => !r.ok);
	console.log(`\n${"=".repeat(60)}`);
	console.log(`总计 ${results.length} 条，通过 ${results.length - failed.length}，失败 ${failed.length}`);
	if (failed.length > 0) {
		console.log("失败项：");
		for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
	}
	process.exit(failed.length > 0 ? 1 : 0);
}

void main().catch((err) => {
	console.error("[smoke-snapshot-events] fatal:", err);
	process.exit(1);
});
