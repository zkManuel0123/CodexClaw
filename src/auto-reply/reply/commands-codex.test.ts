import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const mocks = vi.hoisted(() => ({
  handleParsedBashChatCommand: vi.fn(),
  getSession: vi.fn(),
  getFinishedSession: vi.fn(),
  routeReply: vi.fn(async () => ({ ok: true })),
  isRoutableChannel: vi.fn(() => true),
  buildCodexRepairHints: vi.fn(() => "可先这样排查:\n- 先检查本机 Codex 的登录态和网络是否正常。"),
  updateCodexMode: vi.fn(async () => undefined),
  updateCodexWorkspaceDir: vi.fn(async () => undefined),
  updateDelegateMode: vi.fn(async () => undefined),
}));

vi.mock("./bash-command.js", () => ({
  handleParsedBashChatCommand: mocks.handleParsedBashChatCommand,
}));

vi.mock("../../agents/bash-process-registry.js", () => ({
  getSession: mocks.getSession,
  getFinishedSession: mocks.getFinishedSession,
}));

vi.mock("./route-reply.js", () => ({
  routeReply: mocks.routeReply,
  isRoutableChannel: mocks.isRoutableChannel,
}));

vi.mock("./codex-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-session.js")>();
  return {
    ...actual,
    updateCodexMode: mocks.updateCodexMode,
    updateCodexWorkspaceDir: mocks.updateCodexWorkspaceDir,
  };
});

vi.mock("./delegate-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./delegate-session.js")>();
  return {
    ...actual,
    updateDelegateMode: mocks.updateDelegateMode,
  };
});

vi.mock("./delegate-codex-health.js", () => ({
  buildCodexRepairHints: mocks.buildCodexRepairHints,
}));

import {
  handleCodexSupervisorAction,
  handleCodexTaskRequest,
  resetCodexCommandForTests,
} from "./commands-codex.js";

describe("commands-codex", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetCodexCommandForTests();
    mocks.handleParsedBashChatCommand.mockReset();
    mocks.getSession.mockReset();
    mocks.getFinishedSession.mockReset();
    mocks.routeReply.mockClear();
    mocks.isRoutableChannel.mockReset();
    mocks.isRoutableChannel.mockReturnValue(true);
    mocks.buildCodexRepairHints.mockReset();
    mocks.buildCodexRepairHints.mockReturnValue(
      "可先这样排查:\n- 先检查本机 Codex 的登录态和网络是否正常。",
    );
    mocks.updateCodexMode.mockReset();
    mocks.updateCodexMode.mockResolvedValue(undefined);
    mocks.updateCodexWorkspaceDir.mockReset();
    mocks.updateCodexWorkspaceDir.mockResolvedValue(undefined);
    mocks.updateDelegateMode.mockReset();
    mocks.updateDelegateMode.mockResolvedValue(undefined);
  });

  it("auto-routes full codex output when a background task finishes", async () => {
    vi.useFakeTimers();
    const finishedSession = {
      id: "nova-gulf",
      command: "codex exec",
      scopeKey: "chat:bash",
      startedAt: 1000,
      endedAt: 16000,
      cwd: "D:/Paperclaw",
      status: "completed",
      exitCode: 0,
      exitSignal: null,
      aggregated: [
        "OpenAI Codex v0.111.0",
        "--------",
        "user",
        "some question",
        "codex",
        "let me check the files",
        "exec",
        "ls -la",
        "codex",
        "这是最终结论，full result from codex",
      ].join("\n"),
      tail: "full result from codex",
      truncated: false,
      totalOutputChars: 22,
    };

    mocks.handleParsedBashChatCommand.mockResolvedValue({
      text: "⚙️ bash started (session nova-gulf). Still running; use !poll / !stop (or /bash poll / /bash stop).",
    });
    // Initially running, no child (production behavior)
    mocks.getSession.mockReturnValue({ id: "nova-gulf" });
    mocks.getFinishedSession.mockReturnValue(undefined);

    await handleCodexTaskRequest({
      request: { action: "run", prompt: "这个仓库是干什么的" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
          To: "telegram:123",
          SessionKey: "agent:main:main",
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    // Simulate Codex finishing: session moves from running to finished
    mocks.getSession.mockReturnValue(undefined);
    mocks.getFinishedSession.mockReturnValue(finishedSession);

    // Advance past the 2s poll interval
    await vi.advanceTimersByTimeAsync(2_500);

    const lastRouteCall = mocks.routeReply.mock.calls.at(-1);
    expect(lastRouteCall).toBeTruthy();
    const [routedPayload] = lastRouteCall!;
    const routedText = String(routedPayload?.payload?.text ?? "");
    // Extracts ONLY the final codex answer, not intermediate steps
    expect(routedText).toContain("full result from codex");
    expect(routedText).not.toContain("let me check the files");
    expect(routedText).not.toContain("ls -la");
    expect(routedText).not.toContain("OpenAI Codex v0.111.0");
    // Shows duration
    expect(routedText).toContain("15s");
    expect(routedText).toContain("查看 session");
    expect(routedText).not.toContain("/codex");
    expect(routedText).not.toContain("/delegate");
    expect(routedPayload?.channel).toBe("telegram");
  });

  it("strips ansi escapes and codex footer noise from completion output", async () => {
    vi.useFakeTimers();
    const finishedSession = {
      id: "nova-gulf",
      command: "codex exec",
      scopeKey: "chat:bash",
      startedAt: 1000,
      endedAt: 5000,
      cwd: "D:/Paperclaw",
      status: "completed",
      exitCode: 0,
      exitSignal: null,
      aggregated: [
        "user",
        "some question",
        "codex",
        "\u001b[32;1mMode\u001b[0m ok",
        "codex",
        "实际结论",
        "tokens used这段不该继续发回去",
        "25,428",
      ].join("\n"),
      tail: "tail",
      truncated: false,
      totalOutputChars: 22,
    };

    mocks.handleParsedBashChatCommand.mockResolvedValue({
      text: "⚙️ bash started (session nova-gulf). Still running; use !poll / !stop (or /bash poll / /bash stop).",
    });
    mocks.getSession.mockReturnValue({ id: "nova-gulf" });
    mocks.getFinishedSession.mockReturnValue(undefined);

    await handleCodexTaskRequest({
      request: { action: "run", prompt: "这个仓库是干什么的" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
          To: "telegram:123",
          SessionKey: "agent:main:main",
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    mocks.getSession.mockReturnValue(undefined);
    mocks.getFinishedSession.mockReturnValue(finishedSession);
    await vi.advanceTimersByTimeAsync(2_500);

    const lastRouteCall = mocks.routeReply.mock.calls.at(-1);
    expect(lastRouteCall).toBeTruthy();
    const [routedPayload] = lastRouteCall!;
    const routedText = String(routedPayload?.payload?.text ?? "");
    expect(routedText).toContain("实际结论");
    expect(routedText).not.toContain("\u001b[");
    expect(routedText).not.toContain("tokens used");
    expect(routedText).not.toContain("这段不该继续发回去");
  });

  it("returns a shorter Codex-specific start message for background tasks", async () => {
    vi.useFakeTimers();
    mocks.handleParsedBashChatCommand.mockResolvedValue({
      text: "⚙️ bash started (session nova-gulf). Still running; use !poll / !stop (or /bash poll / /bash stop).",
    });
    mocks.getSession.mockReturnValue({ id: "nova-gulf" });
    mocks.getFinishedSession.mockReturnValue(undefined);

    const reply = await handleCodexTaskRequest({
      request: { action: "run", prompt: "这个仓库是干什么的" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
          To: "telegram:123",
          SessionKey: "agent:main:main",
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    expect(reply.text).toContain("Codex 已开始处理");
    expect(reply.text).toContain("完成后会自动把结果发回来");
    expect(reply.text).not.toContain("bash started");
  });

  it("returns OpenClaw supervisor wording for delegate-mode tasks", async () => {
    vi.useFakeTimers();
    mocks.handleParsedBashChatCommand.mockResolvedValue({
      text: "⚙️ bash started (session nova-gulf). Still running; use !poll / !stop (or /bash poll / /bash stop).",
    });
    mocks.getSession.mockReturnValue({ id: "nova-gulf" });
    mocks.getFinishedSession.mockReturnValue(undefined);

    const reply = await handleCodexTaskRequest({
      request: { action: "run", prompt: "这个仓库是干什么的" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
          To: "telegram:123",
          SessionKey: "agent:main:main",
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
      presentation: "delegate",
    });

    expect(reply.text).toContain("我先接手这个任务");
    expect(reply.text).toContain("本机 Codex");
    expect(reply.text).toContain("交给本机 Codex 执行");
    expect(reply.text).not.toContain("需要时会调用");
    expect(reply.text).not.toContain("Codex 已开始处理");
  });

  it("summarizes immediate 403 failures instead of returning raw html and reconnect spam", async () => {
    mocks.handleParsedBashChatCommand.mockResolvedValue({
      text: [
        "⚙️ bash: & 'D:/openclaw/codex-runner.ps1' -Action 'exec' -Workspace 'D:/Paperclaw' -Prompt '这个仓库是关于什么的'",
        "Exit: 1",
        "```txt",
        "2026-03-11 ERROR failed to refresh available models: unexpected status 403 Forbidden: <html>",
        "Reconnecting... 1/5 (unexpected status 403 Forbidden: <html>)",
        "Reconnecting... 2/5 (unexpected status 403 Forbidden: <html>)",
        "ERROR: unexpected status 403 Forbidden: <html>",
        "url: https://chatgpt.com/backend-api/codex/responses",
        "```",
      ].join("\n"),
    });

    const reply = await handleCodexTaskRequest({
      request: { action: "run", prompt: "这个仓库是关于什么的" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
          To: "telegram:123",
          SessionKey: "agent:main:main",
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    expect(reply.text).toContain("Codex 启动失败");
    expect(reply.text).toContain("被拒绝（403）");
    expect(reply.text).toContain("自动重试 2 次");
    expect(reply.text).toContain("可先这样排查");
    expect(reply.text).toContain("检查本机 Codex 的登录态和网络");
    expect(reply.text).not.toContain("/delegate");
    expect(reply.text).not.toContain("<html>");
    expect(reply.text).not.toContain("Reconnecting...");
  });

  it("sends a delayed long-running reminder once when Codex is still running", async () => {
    vi.useFakeTimers();
    mocks.handleParsedBashChatCommand.mockResolvedValue({
      text: "⚙️ bash started (session nova-gulf). Still running; use !poll / !stop (or /bash poll / /bash stop).",
    });
    mocks.getSession.mockReturnValue({ id: "nova-gulf" });
    mocks.getFinishedSession.mockReturnValue(undefined);

    await handleCodexTaskRequest({
      request: { action: "run", prompt: "这个仓库是干什么的" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
          To: "telegram:123",
          SessionKey: "agent:main:main",
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    await vi.advanceTimersByTimeAsync(20_000);

    expect(mocks.routeReply).toHaveBeenCalledTimes(1);
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: expect.stringContaining("Codex 还在处理"),
        }),
      }),
    );
  });

  it("allows different Telegram topic sessions to run Codex tasks concurrently", async () => {
    vi.useFakeTimers();
    let runCount = 0;
    const runningSessions = new Set<string>();
    const finishedSessions = new Map<string, Record<string, unknown>>();

    mocks.handleParsedBashChatCommand.mockImplementation(async ({ request }) => {
      if (request.action === "run") {
        runCount += 1;
        const sessionId = runCount === 1 ? "topic-42-run" : "topic-43-run";
        runningSessions.add(sessionId);
        return {
          text: `⚙️ bash started (session ${sessionId}). Still running; use !poll / !stop (or /bash poll / /bash stop).`,
        };
      }
      return { text: "" };
    });
    mocks.getSession.mockImplementation((sessionId?: string) =>
      sessionId && runningSessions.has(sessionId) ? { id: sessionId } : undefined,
    );
    mocks.getFinishedSession.mockImplementation((sessionId?: string) =>
      sessionId ? finishedSessions.get(sessionId) : undefined,
    );

    const replyTopic42 = await handleCodexTaskRequest({
      request: { action: "run", prompt: "分析 paperclaw topic 42" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:-100:topic:42",
          To: "telegram:-100:topic:42",
          SessionKey: "agent:main:telegram:group:-100:topic:42",
          MessageThreadId: 42,
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:telegram:group:-100:topic:42",
        isGroup: true,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    const replyTopic43 = await handleCodexTaskRequest({
      request: { action: "run", prompt: "分析 paperclaw topic 43" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:-100:topic:43",
          To: "telegram:-100:topic:43",
          SessionKey: "agent:main:telegram:group:-100:topic:43",
          MessageThreadId: 43,
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:telegram:group:-100:topic:43",
        isGroup: true,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    expect(replyTopic42.text).toContain("topic-42");
    expect(replyTopic43.text).toContain("topic-43");
    expect(replyTopic43.text).not.toContain("上一个任务");

    runningSessions.delete("topic-43-run");
    finishedSessions.set("topic-43-run", {
      id: "topic-43-run",
      command: "codex exec",
      scopeKey: "chat:bash",
      startedAt: 1000,
      endedAt: 9000,
      cwd: "D:/Paperclaw",
      status: "completed",
      exitCode: 0,
      exitSignal: null,
      aggregated: ["user", "topic 43", "codex", "topic 43 done"].join("\n"),
      tail: "topic 43 done",
      truncated: false,
      totalOutputChars: 12,
    });

    await vi.advanceTimersByTimeAsync(2_500);

    runningSessions.delete("topic-42-run");
    finishedSessions.set("topic-42-run", {
      id: "topic-42-run",
      command: "codex exec",
      scopeKey: "chat:bash",
      startedAt: 1000,
      endedAt: 11000,
      cwd: "D:/Paperclaw",
      status: "completed",
      exitCode: 0,
      exitSignal: null,
      aggregated: ["user", "topic 42", "codex", "topic 42 done"].join("\n"),
      tail: "topic 42 done",
      truncated: false,
      totalOutputChars: 12,
    });

    await vi.advanceTimersByTimeAsync(2_500);

    expect(mocks.routeReply).toHaveBeenCalledTimes(2);
    expect(mocks.routeReply.mock.calls.map((call) => call[0]?.to)).toEqual([
      "telegram:-100:topic:43",
      "telegram:-100:topic:42",
    ]);
  });

  it("stops the current session's Codex task without affecting another active topic", async () => {
    let runCount = 0;
    mocks.handleParsedBashChatCommand.mockImplementation(async ({ request }) => {
      if (request.action === "run") {
        runCount += 1;
        const sessionId = runCount === 1 ? "topic-42-run" : "topic-43-run";
        return {
          text: `⚙️ bash started (session ${sessionId}). Still running; use !poll / !stop (or /bash poll / /bash stop).`,
        };
      }
      if (request.action === "stop") {
        return { text: `stopped ${request.sessionId}` };
      }
      return { text: "" };
    });

    await handleCodexTaskRequest({
      request: { action: "run", prompt: "分析 topic 42" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:-100:topic:42",
          To: "telegram:-100:topic:42",
          SessionKey: "agent:main:telegram:group:-100:topic:42",
          MessageThreadId: 42,
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:telegram:group:-100:topic:42",
        isGroup: true,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    await handleCodexTaskRequest({
      request: { action: "run", prompt: "分析 topic 43" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:-100:topic:43",
          To: "telegram:-100:topic:43",
          SessionKey: "agent:main:telegram:group:-100:topic:43",
          MessageThreadId: 43,
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:telegram:group:-100:topic:43",
        isGroup: true,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    const reply = await handleCodexSupervisorAction({
      action: { kind: "stop" },
      workspaceDir: "D:/Paperclaw",
      storePath: "D:/openclaw/.test-session-store.json",
      sessionKey: "agent:main:telegram:group:-100:topic:42",
      taskParams: {
        ctx: {} as never,
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:telegram:group:-100:topic:42",
        isGroup: true,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    expect(reply.text).toContain("stopped topic-42-run");
    expect(mocks.handleParsedBashChatCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: { action: "stop", sessionId: "topic-42-run" },
      }),
    );
  });

  it("stops the active Codex job through the shared supervisor action", async () => {
    mocks.handleParsedBashChatCommand.mockResolvedValueOnce({
      text: "⚙️ bash started (session nova-gulf). Still running; use !poll / !stop (or /bash poll / /bash stop).",
    });

    await handleCodexTaskRequest({
      request: { action: "run", prompt: "这个仓库是干什么的" },
      workspaceDir: "D:/Paperclaw",
      taskParams: {
        ctx: {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
          To: "telegram:123",
          SessionKey: "agent:main:main",
        },
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    mocks.handleParsedBashChatCommand.mockResolvedValueOnce({ text: "stopped nova-gulf" });

    const reply = await handleCodexSupervisorAction({
      action: { kind: "stop" },
      workspaceDir: "D:/Paperclaw",
      storePath: "D:/openclaw/.test-session-store.json",
      sessionKey: "agent:main:main",
      taskParams: {
        ctx: {} as never,
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    expect(reply.text).toContain("stopped nova-gulf");
    expect(reply.text).toContain("已停止当前本地编码执行");
    expect(reply.text).not.toContain("/codex");
    expect(mocks.handleParsedBashChatCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        request: { action: "stop", sessionId: "nova-gulf" },
      }),
    );
    expect(mocks.updateCodexMode).toHaveBeenCalledWith({
      storePath: "D:/openclaw/.test-session-store.json",
      sessionKey: "agent:main:main",
      mode: undefined,
    });
    expect(mocks.updateDelegateMode).toHaveBeenCalledWith({
      storePath: "D:/openclaw/.test-session-store.json",
      sessionKey: "agent:main:main",
      mode: undefined,
    });
  });

  it("switches workspace through the shared supervisor action", async () => {
    const reply = await handleCodexSupervisorAction({
      action: { kind: "switch-workspace", requestedPath: "D:/next-workspace" },
      workspaceDir: "D:/Paperclaw",
      storePath: "D:/openclaw/.test-session-store.json",
      sessionKey: "agent:main:main",
      taskParams: {
        ctx: {} as never,
        cfg: {} as OpenClawConfig,
        agentId: "main",
        sessionKey: "agent:main:main",
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      },
    });

    expect(reply.text).toContain("D:/next-workspace");
    expect(mocks.updateCodexWorkspaceDir).toHaveBeenCalledWith({
      storePath: "D:/openclaw/.test-session-store.json",
      sessionKey: "agent:main:main",
      dir: "D:/next-workspace",
    });
  });
});
