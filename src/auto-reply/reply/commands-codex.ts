import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getFinishedSession, getSession, type FinishedSession } from "../../agents/bash-process-registry.js";
import { logVerbose } from "../../globals.js";
import { stripAnsi } from "../../terminal/ansi.js";
import type { OriginatingChannelType } from "../templating.js";
import type { BashRequest } from "./bash-command.js";
import { handleParsedBashChatCommand } from "./bash-command.js";
import { updateCodexMode, updateCodexWorkspaceDir } from "./codex-session.js";
import { buildCodexRepairHints } from "./delegate-codex-health.js";
import { updateDelegateMode } from "./delegate-session.js";
import type { ReplyPayload } from "../types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

// ─── Types ───────────────────────────────────────────────────────────────

// ─── Active job tracking (in-memory, per-process) ───────────────────────

type ActiveCodexJob = {
  requesterSessionKey: string;
  sessionId: string;
  startedAt: number;
  command: string;
};

const watchedCodexSessions = new Set<string>();
const suppressedCodexAutoReplySessions = new Set<string>();
const codexLongRunningTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeCodexJobs = new Map<string, ActiveCodexJob>();
const codexTaskRegistry = new Map<string, CodexTaskRecord>();

const CODEX_LONG_RUNNING_NOTICE_MS = 20_000;
const MAX_RECORDED_CODEX_TASKS = 32;
const CODEX_TASK_SUMMARY_MAX_CHARS = 600;

export type CodexPresentation = "codex" | "delegate";

export type CodexTaskStatus = "running" | "completed" | "stopped" | "error";

export type CodexTaskSummary = {
  requesterSessionKey: string;
  sessionId: string;
  status: CodexTaskStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  command: string;
  channel?: OriginatingChannelType;
  to?: string;
  threadId?: string | number;
  presentation: CodexPresentation;
  summary?: string;
};

export type CodexTaskParams = Omit<Parameters<typeof handleParsedBashChatCommand>[0], "request">;

export type CodexSupervisorAction =
  | { kind: "stop"; sessionId?: string }
  | { kind: "poll"; sessionId?: string }
  | { kind: "switch-workspace"; requestedPath: string }
  | { kind: "run"; prompt: string }
  | { kind: "resume"; prompt?: string }
  | { kind: "review"; prompt?: string };

type CodexReplyRoute = {
  cfg: Parameters<typeof routeReply>[0]["cfg"];
  sessionKey: string;
  channel: OriginatingChannelType;
  to: string;
  accountId?: string;
  threadId?: string | number;
  presentation: CodexPresentation;
};

type CodexTaskRecord = CodexTaskSummary & {
  updatedAt: number;
};

/** Expose active job state for use in codex-session and inline-actions. */
export function getActiveCodexJob(requesterSessionKey?: string): ActiveCodexJob | null {
  if (requesterSessionKey?.trim()) {
    return activeCodexJobs.get(requesterSessionKey.trim()) ?? null;
  }
  return activeCodexJobs.values().next().value ?? null;
}

/** Check if there is a live codex job (still in starting or running state). */
export function hasActiveCodexJob(requesterSessionKey?: string): boolean {
  return getActiveCodexJob(requesterSessionKey) !== null;
}

export function listCodexTasks(): CodexTaskSummary[] {
  return [...codexTaskRegistry.values()]
    .sort((left, right) => {
      if (left.status === "running" && right.status !== "running") {
        return -1;
      }
      if (left.status !== "running" && right.status === "running") {
        return 1;
      }
      return right.startedAt - left.startedAt;
    })
    .map(({ updatedAt: _updatedAt, ...task }) => task);
}

function formatSessionSnippet(sessionId: string) {
  const trimmed = sessionId.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}…`;
}

function trimCodexTaskSummary(text: string) {
  const trimmed = text.trim();
  if (trimmed.length <= CODEX_TASK_SUMMARY_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, CODEX_TASK_SUMMARY_MAX_CHARS - 16).trimEnd()}\n…(truncated)…`;
}

function pruneCodexTaskRegistry() {
  if (codexTaskRegistry.size <= MAX_RECORDED_CODEX_TASKS) {
    return;
  }
  const removable = [...codexTaskRegistry.values()]
    .filter((record) => record.status !== "running")
    .sort((left, right) => left.updatedAt - right.updatedAt);
  while (codexTaskRegistry.size > MAX_RECORDED_CODEX_TASKS && removable.length > 0) {
    const next = removable.shift();
    if (!next) {
      break;
    }
    codexTaskRegistry.delete(next.sessionId);
  }
}

function clearActiveCodexJobBySessionId(sessionId: string) {
  for (const [requesterSessionKey, job] of activeCodexJobs.entries()) {
    if (job.sessionId === sessionId) {
      activeCodexJobs.delete(requesterSessionKey);
      return;
    }
  }
}

function resolveCodexTaskChannel(params: { taskParams: CodexTaskParams }): OriginatingChannelType | undefined {
  return (
    params.taskParams.ctx.OriginatingChannel ??
    ((params.taskParams.ctx.Surface ?? params.taskParams.ctx.Provider)?.toLowerCase() as
      | OriginatingChannelType
      | undefined)
  );
}

function registerRunningCodexTask(params: {
  requesterSessionKey: string;
  sessionId: string;
  command: string;
  presentation: CodexPresentation;
  taskParams: CodexTaskParams;
}) {
  const startedAt = Date.now();
  activeCodexJobs.set(params.requesterSessionKey, {
    requesterSessionKey: params.requesterSessionKey,
    sessionId: params.sessionId,
    startedAt,
    command: params.command,
  });
  codexTaskRegistry.set(params.sessionId, {
    requesterSessionKey: params.requesterSessionKey,
    sessionId: params.sessionId,
    status: "running",
    startedAt,
    command: params.command,
    channel: resolveCodexTaskChannel({ taskParams: params.taskParams }),
    to: params.taskParams.ctx.OriginatingTo ?? params.taskParams.ctx.To,
    threadId: params.taskParams.ctx.MessageThreadId,
    presentation: params.presentation,
    updatedAt: startedAt,
  });
  pruneCodexTaskRegistry();
}

function markCodexTaskFinished(sessionId: string, finished: FinishedSession) {
  const existing = codexTaskRegistry.get(sessionId);
  const output = finished.aggregated || finished.tail;
  const isSuccess = finished.status === "completed" && (finished.exitCode ?? 0) === 0;
  const summary = trimCodexTaskSummary(
    isSuccess ? extractCodexAnswer(output) || sanitizeCodexOutput(output) : summarizeCodexFailure(output),
  );
  codexTaskRegistry.set(sessionId, {
    requesterSessionKey: existing?.requesterSessionKey ?? "unknown",
    sessionId,
    status: isSuccess ? "completed" : "error",
    startedAt: existing?.startedAt ?? finished.startedAt,
    endedAt: finished.endedAt,
    durationMs: Math.max(0, finished.endedAt - finished.startedAt),
    command: existing?.command ?? finished.command,
    channel: existing?.channel,
    to: existing?.to,
    threadId: existing?.threadId,
    presentation: existing?.presentation ?? "codex",
    summary,
    updatedAt: Date.now(),
  });
  pruneCodexTaskRegistry();
}

function markCodexTaskStopped(sessionId: string, stopReplyText?: string) {
  const existing = codexTaskRegistry.get(sessionId);
  const endedAt = Date.now();
  codexTaskRegistry.set(sessionId, {
    requesterSessionKey: existing?.requesterSessionKey ?? "unknown",
    sessionId,
    status: "stopped",
    startedAt: existing?.startedAt ?? endedAt,
    endedAt,
    durationMs: existing?.startedAt ? Math.max(0, endedAt - existing.startedAt) : undefined,
    command: existing?.command ?? "codex exec",
    channel: existing?.channel,
    to: existing?.to,
    threadId: existing?.threadId,
    presentation: existing?.presentation ?? "codex",
    summary: stopReplyText ? trimCodexTaskSummary(stopReplyText) : "Stopped by user.",
    updatedAt: endedAt,
  });
  pruneCodexTaskRegistry();
}

function markCodexTaskError(sessionId: string, summary: string) {
  const existing = codexTaskRegistry.get(sessionId);
  const endedAt = Date.now();
  codexTaskRegistry.set(sessionId, {
    requesterSessionKey: existing?.requesterSessionKey ?? "unknown",
    sessionId,
    status: "error",
    startedAt: existing?.startedAt ?? endedAt,
    endedAt,
    durationMs: existing?.startedAt ? Math.max(0, endedAt - existing.startedAt) : undefined,
    command: existing?.command ?? "codex exec",
    channel: existing?.channel,
    to: existing?.to,
    threadId: existing?.threadId,
    presentation: existing?.presentation ?? "codex",
    summary: trimCodexTaskSummary(summary),
    updatedAt: endedAt,
  });
  pruneCodexTaskRegistry();
}

function sanitizeCodexOutput(text: string) {
  const cleaned = stripAnsi(text).replace(/\r\n?/g, "\n");
  // "tokens used" starts a line but may have content glued after it (no trailing newline)
  const footerIndex = cleaned.search(/^tokens used/im);
  const withoutFooter = footerIndex >= 0 ? cleaned.slice(0, footerIndex) : cleaned;
  return withoutFooter.trim().replace(/\n{3,}/g, "\n\n");
}

function unwrapCodeFence(text: string) {
  const match = text.trim().match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  return match?.[1]?.trim() ?? text.trim();
}

function parseImmediateBashReply(text: string): { exitLabel: string; output: string } | null {
  const match = text.match(/^⚙️ bash:[^\n]*\nExit: ([^\n]+)\n([\s\S]*)$/);
  if (!match) {
    return null;
  }
  return {
    exitLabel: match[1]!.trim(),
    output: unwrapCodeFence(match[2] ?? ""),
  };
}

function summarizeCodexFailure(raw: string) {
  const cleaned = sanitizeCodexOutput(raw);
  if (!cleaned) {
    return "Codex 已退出，但没有返回可用错误信息。";
  }

  const lower = cleaned.toLowerCase();
  const reconnectMatches = cleaned.match(/^Reconnecting\.\.\./gm) ?? [];

  if (lower.includes("403 forbidden") && lower.includes("chatgpt.com/backend-api/codex")) {
    return [
      "Codex 访问 ChatGPT backend 时被拒绝（403）。",
      reconnectMatches.length > 0 ? `CLI 已自动重试 ${reconnectMatches.length} 次，但仍失败。` : null,
      "常见原因：ChatGPT 登录态失效、代理/网络出口被拦截，或当前账号暂时没有 Codex backend 权限。",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (lower.includes("401 unauthorized")) {
    return "Codex 认证失败（401 Unauthorized）。请检查当前登录态和凭证来源。";
  }

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^OpenAI Codex v/i.test(line))
    .filter((line) => !/^-{4,}$/.test(line))
    .filter((line) => !/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(line))
    .filter((line) => !/^(user|codex|exec)$/i.test(line))
    .filter((line) => !/^mcp startup:/i.test(line))
    .filter((line) => !/^Reconnecting\.\.\./.test(line))
    .filter((line) => !/^<\/?(html|head|body|meta|style)\b/i.test(line))
    .filter((line) => !/^@media\s/i.test(line))
    .filter((line) => !/^\(?Command exited with code /i.test(line));

  return lines.slice(0, 3).join("\n") || "Codex 已退出，但错误输出主要是噪声日志。";
}

/**
 * Extract the final answer from Codex CLI output.
 *
 * Codex output format:
 *   <session header>
 *   user\n<prompt>
 *   codex\n<thinking>
 *   exec\n<command output>
 *   codex\n<FINAL ANSWER>
 *
 * We want just the last `codex` block — that's the actual conclusion.
 * Falls back to full sanitized output if parsing fails.
 */
function extractCodexAnswer(raw: string): string {
  const cleaned = sanitizeCodexOutput(raw);
  if (!cleaned) return "";

  // Split on lines that are exactly "codex" (Codex's turn marker)
  const blocks = cleaned.split(/^codex$/m);
  if (blocks.length < 2) return cleaned;

  // The last block is the final answer; trim exec/tool noise from it
  const lastBlock = blocks[blocks.length - 1]!.trim();
  if (!lastBlock) {
    // If last block is empty, try the second-to-last
    const prev = blocks[blocks.length - 2]?.trim() ?? "";
    return prev || cleaned;
  }
  return lastBlock;
}

function formatDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return remainSecs > 0 ? `${mins}m${remainSecs}s` : `${mins}m`;
}

function resolveCodexReplyRoute(params: {
  taskParams: Omit<Parameters<typeof handleParsedBashChatCommand>[0], "request">;
  presentation: CodexPresentation;
}): CodexReplyRoute | null {
  const channel =
    params.taskParams.ctx.OriginatingChannel ??
    ((params.taskParams.ctx.Surface ?? params.taskParams.ctx.Provider)?.toLowerCase() as
      | OriginatingChannelType
      | undefined);
  const to = params.taskParams.ctx.OriginatingTo ?? params.taskParams.ctx.To;
  if (!channel || !to || !isRoutableChannel(channel)) {
    return null;
  }
  return {
    cfg: params.taskParams.cfg,
    sessionKey: params.taskParams.sessionKey,
    channel,
    to,
    accountId: params.taskParams.ctx.AccountId ?? undefined,
    threadId: params.taskParams.ctx.MessageThreadId,
    presentation: params.presentation,
  };
}

function buildCodexCompletionPayload(
  sessionId: string,
  finished: FinishedSession,
  presentation: CodexPresentation,
): ReplyPayload {
  const isSuccess = finished.status === "completed" && (finished.exitCode ?? 0) === 0;
  const durationMs = finished.endedAt - finished.startedAt;
  const durationLabel = durationMs > 0 ? ` · ${formatDuration(durationMs)}` : "";
  const snippet = formatSessionSnippet(sessionId);

  const answer = extractCodexAnswer(finished.aggregated || finished.tail);

  if (isSuccess && answer) {
    if (presentation === "delegate") {
      return {
        text: [
          `✅ 这轮任务已完成${durationLabel}`,
          "",
          answer,
          "",
          `💡 如需展开这次执行的完整日志，直接告诉我查看 session ${snippet}。`,
        ].join("\n"),
      };
    }
    return {
      text: [
        `✅ Codex 完成${durationLabel}`,
        "",
        answer,
        "",
        `💡 如需展开这次执行的完整日志，直接告诉我查看 session ${snippet}。`,
      ].join("\n"),
    };
  }

  // Non-zero exit or no extractable answer — show more detail
  const exitLabel = finished.exitSignal
    ? `signal ${String(finished.exitSignal)}`
    : `code ${String(finished.exitCode ?? 0)}`;
  const output = sanitizeCodexOutput(finished.aggregated || finished.tail);
  const repairHints = buildCodexRepairHints(output);
  const heading =
    presentation === "delegate"
      ? isSuccess
        ? `✅ 这轮任务已完成${durationLabel}`
        : `⚠️ 这轮任务没有完成 (${exitLabel})${durationLabel}`
      : isSuccess
        ? `✅ Codex 完成${durationLabel}`
        : `⚠️ Codex 异常退出 (${exitLabel})${durationLabel}`;
  return {
    text: [heading, "", output || "(no output)", repairHints ? "" : null, repairHints]
      .filter(Boolean)
      .join("\n"),
  };
}

function buildImmediateCodexReply(reply: ReplyPayload, presentation: CodexPresentation): ReplyPayload {
  const parsed = parseImmediateBashReply(reply.text ?? "");
  if (!parsed) {
    return reply;
  }

  const repairHints = buildCodexRepairHints(parsed.output);

  if (parsed.exitLabel === "0") {
    const answer = extractCodexAnswer(parsed.output);
    if (answer) {
      if (presentation === "delegate") {
        return {
          text: ["✅ 这轮任务已完成", "", answer].join("\n"),
        };
      }
      return {
        text: ["✅ Codex 已完成", "", answer].join("\n"),
      };
    }
  }

  if (presentation === "delegate") {
    return {
      text: [
        `⚠️ 这轮任务没有完成 (exit ${parsed.exitLabel})`,
        "",
        summarizeCodexFailure(parsed.output),
        "",
        "我这边调用本机 Codex 时失败了。请先检查登录态、代理网络，或稍后重试。",
        repairHints ? "" : null,
        repairHints,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return {
    text: [
      `⚠️ Codex 启动失败 (exit ${parsed.exitLabel})`,
      "",
      summarizeCodexFailure(parsed.output),
      "",
      "请先检查 ChatGPT / Codex 登录态、代理网络，或稍后重试。",
      repairHints ? "" : null,
      repairHints,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

function buildCodexStartedPayload(sessionId: string): ReplyPayload {
  return {
    text: [
      `🔨 Codex 已开始处理 (session ${formatSessionSnippet(sessionId)})`,
      "完成后会自动把结果发回来。",
      "如果要停止这轮执行，直接告诉我。",
    ].join("\n"),
  };
}

function buildDelegateStartedPayload(sessionId: string): ReplyPayload {
  return {
    text: [
      `🧩 我先接手这个任务 (session ${formatSessionSnippet(sessionId)})`,
      "这轮任务已经交给本机 Codex 执行代码和仓库操作。",
      "完成后我会把结果整理后发回来；如果要停止这轮执行，直接告诉我。",
    ].join("\n"),
  };
}

function buildCodexLongRunningPayload(sessionId: string): ReplyPayload {
  return {
    text: [
      `⏳ Codex 还在处理 (session ${formatSessionSnippet(sessionId)})`,
      "暂时还没出最终结果。",
      "完成后会自动发回；如果你想现在就看进展或停止任务，直接告诉我。",
    ].join("\n"),
  };
}

function buildDelegateLongRunningPayload(sessionId: string): ReplyPayload {
  return {
    text: [
      `⏳ 这轮任务还在进行中 (session ${formatSessionSnippet(sessionId)})`,
      "我正在等待本机 Codex 完成这轮执行。",
      "完成后会把整理后的结果发回，不用手动轮询。",
    ].join("\n"),
  };
}

function clearCodexLongRunningTimer(sessionId: string) {
  const timer = codexLongRunningTimers.get(sessionId);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  codexLongRunningTimers.delete(sessionId);
}

export function suppressCodexAutoReply(sessionId: string) {
  suppressedCodexAutoReplySessions.add(sessionId);
  clearCodexLongRunningTimer(sessionId);
}

function scheduleCodexLongRunningNotice(sessionId: string, route: CodexReplyRoute) {
  clearCodexLongRunningTimer(sessionId);
  const timer = setTimeout(() => {
    codexLongRunningTimers.delete(sessionId);
    if (suppressedCodexAutoReplySessions.has(sessionId) || getFinishedSession(sessionId)) {
      return;
    }
    if (!getSession(sessionId)) {
      return;
    }
    void routeReply({
      payload:
        route.presentation === "delegate"
          ? buildDelegateLongRunningPayload(sessionId)
          : buildCodexLongRunningPayload(sessionId),
      channel: route.channel,
      to: route.to,
      sessionKey: route.sessionKey,
      accountId: route.accountId,
      threadId: route.threadId,
      cfg: route.cfg,
    }).then((result) => {
      if (!result.ok) {
        logVerbose(
          `codex long-running notice failed (${formatSessionSnippet(sessionId)}): ${result.error ?? "unknown error"}`,
        );
      }
    });
  }, CODEX_LONG_RUNNING_NOTICE_MS);
  codexLongRunningTimers.set(sessionId, timer);
}

const CODEX_COMPLETION_POLL_MS = 2_000;
const CODEX_COMPLETION_MAX_POLL_MS = 30 * 60 * 1_000; // 30 minutes

function cleanupCodexWatcher(sessionId: string) {
  clearCodexLongRunningTimer(sessionId);
  watchedCodexSessions.delete(sessionId);
  suppressedCodexAutoReplySessions.delete(sessionId);
  clearActiveCodexJobBySessionId(sessionId);
}

async function sendCodexCompletionReply(sessionId: string, finished: FinishedSession, route: CodexReplyRoute) {
  const result = await routeReply({
    payload: buildCodexCompletionPayload(sessionId, finished, route.presentation),
    channel: route.channel,
    to: route.to,
    sessionKey: route.sessionKey,
    accountId: route.accountId,
    threadId: route.threadId,
    cfg: route.cfg,
  });
  if (!result.ok) {
    logVerbose(
      `codex auto-reply failed (${formatSessionSnippet(sessionId)}): ${result.error ?? "unknown error"}`,
    );
  }
}

function attachCodexCompletionWatcher(sessionId: string, route: CodexReplyRoute) {
  if (watchedCodexSessions.has(sessionId)) {
    return;
  }
  watchedCodexSessions.add(sessionId);
  scheduleCodexLongRunningNotice(sessionId, route);

  // Poll for session completion — session.child is not available in production
  // (only set in test helpers), so we poll getFinishedSession instead.
  const startedAt = Date.now();
  const poll = () => {
    if (suppressedCodexAutoReplySessions.has(sessionId)) {
      cleanupCodexWatcher(sessionId);
      return;
    }
    const finished = getFinishedSession(sessionId);
    if (finished) {
      markCodexTaskFinished(sessionId, finished);
      cleanupCodexWatcher(sessionId);
      void sendCodexCompletionReply(sessionId, finished, route);
      return;
    }
    // Session gone from both running and finished — give up
    if (!getSession(sessionId)) {
      logVerbose(`codex watcher: session ${formatSessionSnippet(sessionId)} disappeared`);
      markCodexTaskError(sessionId, "Codex session disappeared before a final result was collected.");
      cleanupCodexWatcher(sessionId);
      return;
    }
    if (Date.now() - startedAt > CODEX_COMPLETION_MAX_POLL_MS) {
      logVerbose(`codex watcher: timed out waiting for ${formatSessionSnippet(sessionId)}`);
      markCodexTaskError(sessionId, "Timed out waiting for Codex to finish.");
      cleanupCodexWatcher(sessionId);
      return;
    }
    setTimeout(poll, CODEX_COMPLETION_POLL_MS);
  };
  setTimeout(poll, CODEX_COMPLETION_POLL_MS);
}

// ─── Shell command building ──────────────────────────────────────────────

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve the effective Codex working directory.
 * Priority:
 *   1. Per-session override (set via `/codex dir` or natural language in chat)
 *   2. OPENCLAW_CODEX_WORKSPACE env var (code-level configurable default)
 *   3. process.cwd() when codex-runner.ps1 exists there (Windows dev setup)
 *   4. Agent workspace fallback
 */
export function resolveCodexWorkspaceDir(
  agentWorkspaceDir: string,
  sessionWorkspaceDir?: string,
): string {
  if (sessionWorkspaceDir?.trim()) {
    return sessionWorkspaceDir.trim();
  }
  const envDir = process.env.OPENCLAW_CODEX_WORKSPACE?.trim();
  if (envDir) {
    return envDir;
  }
  const processDir = process.cwd();
  const runnerInProcessDir = path.join(processDir, "codex-runner.ps1");
  if (fs.existsSync(runnerInProcessDir)) {
    return processDir;
  }
  return agentWorkspaceDir;
}

/** Resolve the directory where codex-runner.ps1 lives (OpenClaw repo root). */
function resolveRunnerDir(): string {
  // 1. process.cwd() — gateway is normally started from the repo root
  if (fs.existsSync(path.join(process.cwd(), "codex-runner.ps1"))) {
    return process.cwd();
  }
  // 2. Walk up from the module location (handles both src/ dev and dist/ bundle)
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      if (fs.existsSync(path.join(dir, "codex-runner.ps1"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.url may not be a file URL in exotic runtimes
  }
  return process.cwd();
}

function buildCodexShellCommand(params: {
  workspaceDir: string;
  request:
    | { action: "run"; prompt: string }
    | { action: "resume"; prompt?: string }
    | { action: "review"; prompt?: string };
}): string {
  if (process.platform === "win32") {
    const runnerPath = path.join(resolveRunnerDir(), "codex-runner.ps1");
    const parts = [
      `& ${quotePowerShell(runnerPath)}`,
      `-Action ${quotePowerShell(
        params.request.action === "run" ? "exec" : params.request.action,
      )}`,
      `-Workspace ${quotePowerShell(params.workspaceDir)}`,
    ];
    const prompt = params.request.prompt?.trim();
    if (prompt) {
      parts.push(`-Prompt ${quotePowerShell(prompt)}`);
    }
    return parts.join(" ");
  }

  // Strip OpenAI env vars that would override Codex's ChatGPT OAuth provider.
  const unsetPrefix = "unset OPENAI_BASE_URL OPENAI_API_KEY OPENAI_MODEL 2>/dev/null; ";
  const workspace = quotePosix(params.workspaceDir);
  if (params.request.action === "run") {
    return `${unsetPrefix}codex exec --full-auto -C ${workspace} ${quotePosix(params.request.prompt)}`;
  }
  if (params.request.action === "resume") {
    const prompt = params.request.prompt?.trim();
    return prompt
      ? `${unsetPrefix}codex exec resume --last -C ${workspace} ${quotePosix(prompt)}`
      : `${unsetPrefix}codex exec resume --last -C ${workspace}`;
  }
  const prompt = params.request.prompt?.trim();
  return prompt
    ? `${unsetPrefix}codex review -C ${workspace} ${quotePosix(prompt)}`
    : `${unsetPrefix}codex review -C ${workspace}`;
}

function toBashRequest(params: {
  workspaceDir: string;
  request:
    | { action: "run"; prompt: string }
    | { action: "resume"; prompt?: string }
    | { action: "review"; prompt?: string }
    | { action: "poll"; sessionId?: string }
    | { action: "stop"; sessionId?: string };
}): BashRequest | null {
  const { request, workspaceDir } = params;
  if (request.action === "poll") {
    return { action: "poll", sessionId: request.sessionId };
  }
  if (request.action === "stop") {
    return { action: "stop", sessionId: request.sessionId };
  }
  return {
    action: "run",
    command: buildCodexShellCommand({ workspaceDir, request }),
  };
}

function buildCodexPollRequest(sessionId?: string): BashRequest {
  return { action: "poll", sessionId };
}

async function clearLegacySessionModes(storePath: string | undefined, sessionKey: string): Promise<void> {
  if (!storePath) {
    return;
  }
  await updateDelegateMode({ storePath, sessionKey, mode: undefined });
  await updateCodexMode({ storePath, sessionKey, mode: undefined });
}

function shouldClearActiveCodexJobFromReply(replyText: string): boolean {
  return replyText.includes("bash finished") || replyText.includes("No active bash job");
}

function buildCodexTaskRequestFromAction(
  action: Extract<CodexSupervisorAction, { kind: "run" | "resume" | "review" }>,
):
  | { action: "run"; prompt: string }
  | { action: "resume"; prompt?: string }
  | { action: "review"; prompt?: string } {
  if (action.kind === "run") {
    return { action: "run", prompt: action.prompt };
  }
  if (action.kind === "resume") {
    return { action: "resume", prompt: action.prompt };
  }
  return { action: "review", prompt: action.prompt };
}

async function stopActiveCodexJob(params: {
  taskParams: CodexTaskParams;
  requesterSessionKey: string;
  sessionId?: string;
}): Promise<{ stopped: boolean; stopReplyText?: string }> {
  const targetSessionId =
    params.sessionId ?? getActiveCodexJob(params.requesterSessionKey)?.sessionId;
  if (!targetSessionId) {
    return { stopped: false };
  }

  suppressedCodexAutoReplySessions.add(targetSessionId);
  clearCodexLongRunningTimer(targetSessionId);
  const stopReply = await handleParsedBashChatCommand({
    ...params.taskParams,
    request: { action: "stop", sessionId: targetSessionId },
  });
  const stopReplyText = stopReply.text ?? undefined;
  if (
    stopReplyText?.includes("No running bash job found") ||
    stopReplyText?.includes("No bash session found")
  ) {
    suppressedCodexAutoReplySessions.delete(targetSessionId);
  }
  markCodexTaskStopped(targetSessionId, stopReplyText);
  clearActiveCodexJobBySessionId(targetSessionId);
  return {
    stopped: true,
    stopReplyText,
  };
}

// ─── Execute a codex task via bash exec ──────────────────────────────────

async function executeCodexTask(params: {
  taskParams: Omit<Parameters<typeof handleParsedBashChatCommand>[0], "request">;
  bashRequest: BashRequest;
  presentation?: CodexPresentation;
}): Promise<ReplyPayload> {
  const presentation = params.presentation ?? "codex";
  const reply = await handleParsedBashChatCommand({
    ...params.taskParams,
    request: params.bashRequest,
  });

  // Track active job based on reply content
  if (params.bashRequest.action === "run") {
    const text = reply.text ?? "";
    const sessionMatch = text.match(/session\s+([a-z0-9-]+)/i);
    if (sessionMatch?.[1] && text.includes("Still running")) {
      const sessionId = sessionMatch[1];
      registerRunningCodexTask({
        requesterSessionKey: params.taskParams.sessionKey,
        sessionId,
        command: params.bashRequest.command,
        presentation,
        taskParams: params.taskParams,
      });
      const route = resolveCodexReplyRoute({ taskParams: params.taskParams, presentation });
      if (route) {
        attachCodexCompletionWatcher(sessionId, route);
      }
      return presentation === "delegate"
        ? buildDelegateStartedPayload(sessionId)
        : buildCodexStartedPayload(sessionId);
    } else {
      return buildImmediateCodexReply(reply, presentation);
    }
  }

  return reply;
}

export async function handleCodexTaskRequest(params: {
  request:
    | { action: "run"; prompt: string }
    | { action: "resume"; prompt?: string }
    | { action: "review"; prompt?: string };
  taskParams: Omit<Parameters<typeof handleParsedBashChatCommand>[0], "request">;
  workspaceDir: string;
  presentation?: CodexPresentation;
}): Promise<ReplyPayload> {
  const presentation = params.presentation ?? "codex";

  const activeJob = getActiveCodexJob(params.taskParams.sessionKey);
  if (activeJob) {
    const label = `session ${activeJob.sessionId.slice(0, 8)}…`;
    return {
      text:
        presentation === "delegate"
          ? [`⚠️ 我这边还有一轮任务在执行 (${label})`, "如果你想看当前进展或停止这轮任务，直接告诉我。"].join("\n")
          : [`⚠️ Codex 正在执行上一个任务 (${label})`, "如果你想看当前进展或停止这轮任务，直接告诉我。"].join("\n"),
    };
  }

  const bashRequest = toBashRequest({ workspaceDir: params.workspaceDir, request: params.request });
  if (!bashRequest) {
    return {
      text:
        presentation === "delegate"
          ? "⚠️ 无法构造要交给本机 Codex 的任务请求。"
          : "⚠️ 无法构造 Codex 任务请求。",
    };
  }

  return executeCodexTask({
    taskParams: params.taskParams,
    bashRequest,
    presentation,
  });
}

export async function handleCodexSupervisorAction(params: {
  action: CodexSupervisorAction;
  workspaceDir: string;
  storePath?: string;
  sessionKey: string;
  taskParams: CodexTaskParams;
}): Promise<ReplyPayload> {
  const { action, workspaceDir, storePath, sessionKey, taskParams } = params;

  if (action.kind === "stop") {
    const replies: string[] = [];
    const stopResult = await stopActiveCodexJob({
      taskParams,
      requesterSessionKey: sessionKey,
      sessionId: action.sessionId,
    });
    if (stopResult.stopReplyText) {
      replies.push(stopResult.stopReplyText);
    }

    await clearLegacySessionModes(storePath, sessionKey);

    if (stopResult.stopped) {
      replies.push("✅ 已停止当前本地编码执行。");
    } else if (replies.length === 0) {
      replies.push("⚙️ 当前没有正在接管的本地编码执行");
    }
    return { text: replies.join("\n") };
  }

  if (action.kind === "poll") {
    const pollReply = await handleParsedBashChatCommand({
      ...taskParams,
      request: buildCodexPollRequest(
        action.sessionId ?? getActiveCodexJob(sessionKey)?.sessionId,
      ),
    });
    const replyText = pollReply.text ?? "";
    if (shouldClearActiveCodexJobFromReply(replyText)) {
      const targetSessionId = action.sessionId ?? getActiveCodexJob(sessionKey)?.sessionId;
      if (targetSessionId) {
        clearActiveCodexJobBySessionId(targetSessionId);
      }
    }
    return pollReply;
  }

  if (action.kind === "switch-workspace") {
    if (storePath) {
      await updateCodexWorkspaceDir({ storePath, sessionKey, dir: action.requestedPath });
    }
    return {
      text: `📁 Codex 工作目录已设置为: ${action.requestedPath}\n（本次会话有效；可用环境变量 OPENCLAW_CODEX_WORKSPACE 设置永久默认值）`,
    };
  }

  return handleCodexTaskRequest({
    request: buildCodexTaskRequestFromAction(action),
    taskParams,
    workspaceDir,
  });
}

export function resetCodexCommandForTests() {
  activeCodexJobs.clear();
  codexTaskRegistry.clear();
  for (const timer of codexLongRunningTimers.values()) {
    clearTimeout(timer);
  }
  codexLongRunningTimers.clear();
  watchedCodexSessions.clear();
  suppressedCodexAutoReplySessions.clear();
}
