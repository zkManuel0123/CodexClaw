import { Type } from "@sinclair/typebox";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  getActiveCodexJob,
  handleCodexSupervisorAction,
  listCodexTasks,
  resolveCodexWorkspaceDir,
} from "../../auto-reply/reply/commands-codex.js";
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam, ToolInputError } from "./common.js";

const CODEX_ACTIONS = [
  "run",
  "review",
  "resume",
  "poll",
  "stop",
  "workspace.get",
  "workspace.set",
  "status",
] as const;

const CodexToolSchema = Type.Object({
  action: stringEnum(CODEX_ACTIONS),
  prompt: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  workspaceDir: Type.Optional(Type.String()),
});

function parseSessionId(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const match = text.match(/session\s+([a-z0-9-]+)/i);
  return match?.[1]?.trim() || undefined;
}

function inferCodexStatus(params: {
  action: (typeof CODEX_ACTIONS)[number];
  replyText?: string;
  activeSessionId?: string;
}): "idle" | "running" | "completed" | "stopped" | "error" {
  if (params.action === "workspace.get" || params.action === "status") {
    return params.activeSessionId ? "running" : "idle";
  }
  const text = params.replyText ?? "";
  if (params.activeSessionId) {
    return "running";
  }
  if (/bash stopped|已退出 Codex 模式/i.test(text)) {
    return "stopped";
  }
  if (/已完成|Codex 完成|bash finished/i.test(text)) {
    return "completed";
  }
  if (/No active bash job|No bash session found|当前不在 Codex 模式/i.test(text)) {
    return "idle";
  }
  if (text.includes("⚠️")) {
    return "error";
  }
  return "idle";
}

export function createCodexTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  workspaceDir?: string;
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Codex",
    name: "codex",
    description:
      "Run or control Codex as an internal coding tool. Use for repo inspection, code edits, reviews, background task polling, cross-chat/topic Codex task status, and workspace selection. Prefer this over asking the user to switch into /codex or /delegate modes.",
    parameters: CodexToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true }) as (typeof CODEX_ACTIONS)[number];
      const cfg = opts?.config ?? loadConfig();
      const sessionKey = opts?.agentSessionKey?.trim();
      if (!sessionKey) {
        throw new ToolInputError("agentSessionKey required");
      }

      const agentId = resolveSessionAgentId({ sessionKey, config: cfg });
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      const store = loadSessionStore(storePath);
      const sessionEntry = store[sessionKey];
      const baseWorkspaceDir = resolveCodexWorkspaceDir(
        opts?.workspaceDir ?? process.cwd(),
        sessionEntry?.codexWorkspaceDir,
      );

      if (action === "workspace.get" || action === "status") {
        const currentJob = getActiveCodexJob(sessionKey);
        const activeSessionId = currentJob?.sessionId;
        const allTasks = listCodexTasks();
        const activeTasks = allTasks.filter((task) => task.status === "running");
        const recentTasks = allTasks.filter((task) => task.status !== "running").slice(0, 10);

        return jsonResult({
          ok: true,
          action,
          status: activeSessionId ? "running" : "idle",
          workspaceDir: baseWorkspaceDir,
          activeSessionId,
          currentTask:
            activeSessionId != null
              ? allTasks.find((task) => task.sessionId === activeSessionId) ?? null
              : null,
          activeTasks,
          recentTasks,
          taskCount: {
            active: activeTasks.length,
            recent: recentTasks.length,
            total: allTasks.length,
          },
        });
      }

      const prompt = readStringParam(params, "prompt");
      const requestedWorkspaceDir = readStringParam(params, "workspaceDir");
      const sessionId = readStringParam(params, "sessionId");

      const toolCtx: MsgContext = {
        SessionKey: sessionKey,
        To: opts?.agentTo?.trim() || sessionKey,
        AccountId: opts?.agentAccountId,
        MessageThreadId: opts?.agentThreadId,
        OriginatingChannel: opts?.agentChannel,
        OriginatingTo: opts?.agentTo?.trim() || undefined,
      };
      const taskParams = {
        ctx: toolCtx,
        cfg,
        agentId,
        sessionKey,
        isGroup: false,
        elevated: {
          enabled: true,
          allowed: true,
          failures: [],
        },
      };

      const supervisorAction =
        action === "run"
          ? { kind: "run", prompt: prompt || "" }
          : action === "review"
            ? { kind: "review", prompt }
            : action === "resume"
              ? { kind: "resume", prompt }
              : action === "poll"
                ? { kind: "poll", sessionId }
                : action === "stop"
                  ? { kind: "stop", sessionId }
                  : { kind: "switch-workspace", requestedPath: requestedWorkspaceDir || "" };

      if ((action === "run" || action === "review") && !prompt?.trim()) {
        throw new ToolInputError("prompt required");
      }
      if (action === "workspace.set" && !requestedWorkspaceDir?.trim()) {
        throw new ToolInputError("workspaceDir required");
      }

      const reply = await handleCodexSupervisorAction({
        action: supervisorAction,
        workspaceDir: baseWorkspaceDir,
        storePath,
        sessionKey,
        taskParams,
      });

      const refreshedStore = loadSessionStore(storePath);
      const refreshedEntry = refreshedStore[sessionKey];
      const activeJob = getActiveCodexJob(sessionKey);
      const activeSessionId = activeJob?.sessionId;
      const resolvedSessionId = activeSessionId ?? parseSessionId(reply.text) ?? sessionId;
      const effectiveWorkspaceDir = resolveCodexWorkspaceDir(
        opts?.workspaceDir ?? process.cwd(),
        refreshedEntry?.codexWorkspaceDir,
      );

      return jsonResult({
        ok: true,
        action,
        status: inferCodexStatus({
          action,
          replyText: reply.text,
          activeSessionId,
        }),
        sessionId: resolvedSessionId ?? null,
        activeSessionId: activeSessionId ?? null,
        workspaceDir: effectiveWorkspaceDir,
        replyText: reply.text ?? "",
      });
    },
  };
}
