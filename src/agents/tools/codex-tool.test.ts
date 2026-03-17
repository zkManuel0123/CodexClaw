import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleCodexSupervisorAction: vi.fn(),
  getActiveCodexJob: vi.fn(),
  listCodexTasks: vi.fn(() => []),
  resolveCodexWorkspaceDir: vi.fn((workspaceDir: string, override?: string) =>
    override?.trim() ? override : workspaceDir,
  ),
  loadConfig: vi.fn(() => ({ commands: { bash: true } })),
  resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
  loadSessionStore: vi.fn(() => ({
    "agent:main:main": {
      codexWorkspaceDir: "D:/repo",
    },
  })),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolvePluginTools: vi.fn(() => []),
}));

vi.mock("../../auto-reply/reply/commands-codex.js", () => ({
  handleCodexSupervisorAction: mocks.handleCodexSupervisorAction,
  getActiveCodexJob: mocks.getActiveCodexJob,
  listCodexTasks: mocks.listCodexTasks,
  resolveCodexWorkspaceDir: mocks.resolveCodexWorkspaceDir,
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("../../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: mocks.resolveStorePath,
    loadSessionStore: mocks.loadSessionStore,
  };
});

vi.mock("../agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-scope.js")>();
  return {
    ...actual,
    resolveSessionAgentId: mocks.resolveSessionAgentId,
  };
});

vi.mock("../../plugins/tools.js", () => ({
  resolvePluginTools: mocks.resolvePluginTools,
}));

import { createOpenClawTools } from "../openclaw-tools.js";
import { createCodexTool } from "./codex-tool.js";

function readDetails(result: Awaited<ReturnType<NonNullable<ReturnType<typeof createCodexTool>["execute"]>>>) {
  return result?.details as Record<string, unknown>;
}

describe("codex-tool", () => {
  beforeEach(() => {
    mocks.handleCodexSupervisorAction.mockReset();
    mocks.getActiveCodexJob.mockReset();
    mocks.listCodexTasks.mockReset();
    mocks.listCodexTasks.mockReturnValue([]);
    mocks.resolveCodexWorkspaceDir.mockClear();
    mocks.loadConfig.mockClear();
    mocks.resolveStorePath.mockClear();
    mocks.loadSessionStore.mockReset();
    mocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        codexWorkspaceDir: "D:/repo",
      },
    });
    mocks.resolveSessionAgentId.mockClear();
    mocks.resolvePluginTools.mockClear();
  });

  it("registers codex in the default OpenClaw tool list", () => {
    const tool = createOpenClawTools({
      agentSessionKey: "agent:main:main",
      workspaceDir: "D:/workspace",
    }).find((candidate) => candidate.name === "codex");

    expect(tool).toBeTruthy();
  });

  it("returns current workspace status without invoking Codex", async () => {
    const tool = createCodexTool({
      agentSessionKey: "agent:main:main",
      workspaceDir: "D:/workspace",
    });
    mocks.getActiveCodexJob.mockReturnValue(null);

    const result = await tool.execute?.("call-1", { action: "workspace.get" });
    const details = readDetails(result);

    expect(mocks.handleCodexSupervisorAction).not.toHaveBeenCalled();
    expect(details).toMatchObject({
      ok: true,
      action: "workspace.get",
      status: "idle",
      workspaceDir: "D:/repo",
      currentTask: null,
      activeTasks: [],
      recentTasks: [],
    });
  });

  it("returns global Codex task status alongside the current session task", async () => {
    const tool = createCodexTool({
      agentSessionKey: "agent:main:telegram:group:-100:topic:42",
      workspaceDir: "D:/workspace",
    });
    mocks.getActiveCodexJob.mockReturnValue({
      requesterSessionKey: "agent:main:telegram:group:-100:topic:42",
      sessionId: "topic-42-run",
      startedAt: 100,
      command: "codex exec",
    });
    mocks.listCodexTasks.mockReturnValue([
      {
        requesterSessionKey: "agent:main:telegram:group:-100:topic:42",
        sessionId: "topic-42-run",
        status: "running",
        startedAt: 100,
        command: "codex exec",
        channel: "telegram",
        to: "telegram:-100:topic:42",
        threadId: 42,
        presentation: "codex",
      },
      {
        requesterSessionKey: "agent:main:telegram:group:-100:topic:43",
        sessionId: "topic-43-done",
        status: "completed",
        startedAt: 50,
        endedAt: 90,
        durationMs: 40,
        command: "codex exec",
        channel: "telegram",
        to: "telegram:-100:topic:43",
        threadId: 43,
        presentation: "codex",
        summary: "paperclaw repo summary",
      },
    ]);

    const result = await tool.execute?.("call-status", { action: "status" });
    const details = readDetails(result);

    expect(details).toMatchObject({
      ok: true,
      action: "status",
      status: "running",
      activeSessionId: "topic-42-run",
      currentTask: expect.objectContaining({
        sessionId: "topic-42-run",
        status: "running",
      }),
      taskCount: {
        active: 1,
        recent: 1,
        total: 2,
      },
    });
    expect(details.activeTasks).toEqual([
      expect.objectContaining({
        sessionId: "topic-42-run",
      }),
    ]);
    expect(details.recentTasks).toEqual([
      expect.objectContaining({
        sessionId: "topic-43-done",
        summary: "paperclaw repo summary",
      }),
    ]);
  });

  it("routes run through the codex supervisor and returns the active session id", async () => {
    const tool = createCodexTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "acct-1",
      agentTo: "telegram:123",
      agentThreadId: 456,
      workspaceDir: "D:/workspace",
    });
    mocks.handleCodexSupervisorAction.mockResolvedValue({
      text: "🔨 Codex 已开始处理 (session abcdef12-3456)",
    });
    mocks.getActiveCodexJob.mockReturnValue({
      state: "running",
      sessionId: "abcdef12-3456",
      startedAt: 1,
      command: "codex exec",
    });

    const result = await tool.execute?.("call-2", {
      action: "run",
      prompt: "Inspect the repo and fix the failing test",
    });
    const details = readDetails(result);

    expect(mocks.handleCodexSupervisorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { kind: "run", prompt: "Inspect the repo and fix the failing test" },
        sessionKey: "agent:main:main",
        workspaceDir: "D:/repo",
        taskParams: expect.objectContaining({
          ctx: expect.objectContaining({
            SessionKey: "agent:main:main",
            To: "telegram:123",
            AccountId: "acct-1",
            MessageThreadId: 456,
            OriginatingChannel: "telegram",
            OriginatingTo: "telegram:123",
          }),
        }),
      }),
    );
    expect(details).toMatchObject({
      ok: true,
      action: "run",
      status: "running",
      sessionId: "abcdef12-3456",
      activeSessionId: "abcdef12-3456",
    });
  });

  it("updates the persisted workspace through workspace.set", async () => {
    const tool = createCodexTool({
      agentSessionKey: "agent:main:main",
      workspaceDir: "D:/workspace",
    });
    mocks.handleCodexSupervisorAction.mockResolvedValue({
      text: "📁 Codex 工作目录已设置为: D:/new-repo",
    });
    mocks.getActiveCodexJob.mockReturnValue(null);
    mocks.loadSessionStore
      .mockReturnValueOnce({
        "agent:main:main": {
          codexWorkspaceDir: "D:/repo",
        },
      })
      .mockReturnValueOnce({
        "agent:main:main": {
          codexWorkspaceDir: "D:/new-repo",
        },
      });

    const result = await tool.execute?.("call-3", {
      action: "workspace.set",
      workspaceDir: "D:/new-repo",
    });
    const details = readDetails(result);

    expect(mocks.handleCodexSupervisorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { kind: "switch-workspace", requestedPath: "D:/new-repo" },
      }),
    );
    expect(details).toMatchObject({
      action: "workspace.set",
      workspaceDir: "D:/new-repo",
    });
  });
});
