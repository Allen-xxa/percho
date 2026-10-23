import { composerDocumentText, type SessionMeta } from "@percho/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 撤回：代码冲突 → 对话不动、修复包进草稿；代码成功 → 原文回填 + 重建消息流 */
const piMock = vi.hoisted(() => ({
	recallMessage: vi.fn(),
	openSession: vi.fn(),
	getSessionMessages: vi.fn(() => Promise.resolve([])),
	markSessionHistoryReady: vi.fn(() => Promise.resolve()),
	getFollowUpMessages: vi.fn(() => Promise.resolve([])),
	getTodos: vi.fn(() => Promise.resolve([])),
	getPermissionMode: vi.fn(() => Promise.resolve("default" as const)),
}));
vi.mock("../api", () => ({ getPi: () => piMock }));

import { COMPOSER_FOCUS_EVENT, useDraftStore } from "./drafts";
import { clearSessionHistory } from "./session-history";
import { useSessionsStore } from "./sessions";
import { useToastsStore } from "./toasts";
import { useTranscriptStore } from "./transcript";

const SID = "s1";

function meta(): SessionMeta {
	return {
		sessionId: SID,
		cwd: "/p",
		sessionFile: `/tmp/${SID}.jsonl`,
		active: true,
		messageCount: 1,
		createdAt: 1,
	};
}

const draftText = (): string => {
	const entry = useDraftStore.getState().bySession[SID];
	return entry ? composerDocumentText(entry.document) : "";
};

/** store 会往 window 派发聚焦事件；node 环境没有 window，用最小替身接住 */
const dispatched: Event[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	piMock.recallMessage.mockReset();
	dispatched.length = 0;
	vi.stubGlobal("window", {
		dispatchEvent: (event: Event) => {
			dispatched.push(event);
			return true;
		},
	});
	clearSessionHistory(SID);
	useTranscriptStore.setState({ bySession: {} });
	useDraftStore.setState({ bySession: {} });
	useToastsStore.setState({ toasts: [], overflowCount: 0 });
	useSessionsStore.setState({ sessions: [meta()], activeSessionId: SID, cwd: "/p" });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const toastTitles = (): string[] =>
	useToastsStore.getState().toasts.map((t) => `${t.severity}:${t.titleKey}`);

describe("recallMessage：代码与对话一起回退", () => {
	it("代码撤回成功：原文回填草稿、重建消息流、聚焦输入框", async () => {
		piMock.recallMessage.mockResolvedValue({
			recalled: true,
			text: "改一下 a.txt",
			images: [],
			code: { status: "reverted", reverted: ["a.txt"], deleted: [], alreadyTarget: [] },
		});

		await useSessionsStore.getState().recallMessage({ entryId: "e1" });

		expect(draftText()).toBe("改一下 a.txt");
		expect(toastTitles()).toEqual([]);
		// 没删文件 → 不额外 toast（类别 B 清单不向用户展示）
		expect(toastTitles()).toEqual([]);
		// 成功路径会重建消息流（loadSessionBundle 拉历史是它做的第一件事）
		expect(piMock.getSessionMessages).toHaveBeenCalled();
		expect(dispatched.map((e) => e.type)).toEqual([COMPOSER_FOCUS_EVENT]);
	});

	it("代码撤回成功且删了文件：用 info toast 说删了哪些（spec 6.5）", async () => {
		piMock.recallMessage.mockResolvedValue({
			recalled: true,
			text: "删掉临时脚本",
			images: [],
			code: { status: "reverted", reverted: [], deleted: ["tmp/a.mjs", "tmp/b.mjs"], alreadyTarget: [] },
		});

		await useSessionsStore.getState().recallMessage({ entryId: "e1" });

		expect(toastTitles()).toEqual(["info:toast.recallDeleted"]);
		expect(useToastsStore.getState().toasts[0]?.detail).toBe("tmp/a.mjs, tmp/b.mjs");
		expect(draftText()).toBe("删掉临时脚本");
	});

	it("代码冲突：不回填原文、不重建消息流，修复包进草稿 + 冲突 toast", async () => {
		const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-v1\n+v2\n";
		piMock.recallMessage.mockResolvedValue({
			recalled: false,
			text: "",
			images: [],
			code: {
				status: "conflict",
				reverted: [],
				deleted: [],
				alreadyTarget: [],
				conflicts: ["a.txt", "b.txt"],
				repairPatch: patch,
			},
		});

		await useSessionsStore.getState().recallMessage({ entryId: "e1" });

		// 对话没动：不重建消息流（一次 IPC 都不发）
		expect(piMock.getSessionMessages).not.toHaveBeenCalled();
		// 修复包进草稿，包含完整 patch
		const text = draftText();
		expect(text).toContain("```diff");
		expect(text).toContain("diff --git a/a.txt b/a.txt");
		expect(text).toContain("-v1");
		expect(text).toContain("+v2");
		// 只有一个 toast（冲突），detail 是冲突文件清单
		expect(toastTitles()).toEqual(["warning:toast.recallConflict"]);
		expect(useToastsStore.getState().toasts[0]?.detail).toBe("a.txt, b.txt");
		// 冲突路径也聚焦输入框（用户下一步就是发修复包）
		expect(dispatched.map((e) => e.type)).toEqual([COMPOSER_FOCUS_EVENT]);
	});

	it("代码不可用（unavailable）：静默只撤对话，不 toast 也不塞修复包", async () => {
		piMock.recallMessage.mockResolvedValue({
			recalled: false,
			text: "",
			images: [],
			code: { status: "unavailable", reverted: [], deleted: [], alreadyTarget: [] },
		});

		await useSessionsStore.getState().recallMessage({ entryId: "e1" });

		expect(toastTitles()).toEqual([]);
		expect(draftText()).toBe("");
		expect(piMock.getSessionMessages).not.toHaveBeenCalled();
	});

	it("修复包为空时不产生空 diff 代码块", async () => {
		piMock.recallMessage.mockResolvedValue({
			recalled: false,
			text: "",
			images: [],
			code: { status: "conflict", reverted: [], deleted: [], alreadyTarget: [], conflicts: ["a.txt"] },
		});

		await useSessionsStore.getState().recallMessage({ entryId: "e1" });

		const text = draftText();
		expect(text).not.toContain("```diff");
		expect(text).toContain("撤不回来了");
	});
});
