import fs from "node:fs";
import path from "node:path";
import { readCodexCliCredentialsCached } from "../../agents/cli-credentials.js";
import { resolveUserPath } from "../../utils.js";

const CODEX_BACKEND_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_CREDENTIAL_TTL_MS = 10_000;
const NETWORK_TIMEOUT_MS = 5_000;

export type CodexFailureKind = "auth-401" | "forbidden-403" | "not-found-404" | "network" | "unknown";

function normalizeIntentText(input: string): string {
  return input.trim().toLowerCase();
}

function mentionsCodexControlSurface(input: string): boolean {
  return /(codex|本机 codex|本地 codex|codex cli|chatgpt backend|backend-api\/codex|auth\.json|登录态|认证|代理|vpn|网络|连通性)/i.test(
    input,
  );
}

export function detectDelegateHealthIntent(body: string): boolean {
  const trimmed = normalizeIntentText(body);
  if (!trimmed || !mentionsCodexControlSurface(trimmed)) {
    return false;
  }

  return /(?:检查|查下|查一下|看看|看下|诊断|体检|health|doctor|状态)(?:[\s\S]{0,12})?(?:codex|登录态|认证|auth|代理|网络|backend|连通性)?/i.test(
    trimmed,
  );
}

export function detectDelegateRepairIntent(body: string): boolean {
  const trimmed = normalizeIntentText(body);
  if (!trimmed || !mentionsCodexControlSurface(trimmed)) {
    return false;
  }

  return /(?:修|修复|恢复|排查|处理|repair|fix)(?:[\s\S]{0,12})?(?:codex|登录态|认证|auth|代理|网络|backend|连通性)?/i.test(
    trimmed,
  );
}

function resolveCodexHomePath(): string {
  const configured = process.env.CODEX_HOME?.trim();
  const home = configured ? resolveUserPath(configured) : resolveUserPath("~/.codex");
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

function resolveCodexAuthPath(): string {
  return path.join(resolveCodexHomePath(), "auth.json");
}

function findCommandOnPath(commandName: string): string | null {
  const pathValue = process.env.PATH ?? "";
  if (!pathValue) {
    return null;
  }

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
      : [""];

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    const base = path.join(dir, commandName);
    if (process.platform === "win32") {
      if (path.extname(base)) {
        if (fs.existsSync(base)) {
          return base;
        }
        continue;
      }
      for (const ext of extensions) {
        const candidate = `${base}${ext}`;
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
      continue;
    }

    if (fs.existsSync(base)) {
      return base;
    }
  }

  return null;
}

function summarizeProxyEnv(): string {
  const proxyVars = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  const configured = proxyVars.filter((name) => Boolean(process.env[name]?.trim()));
  if (configured.length === 0) {
    return "未检测到显式代理环境变量。";
  }
  return `检测到代理环境变量: ${configured.join(", ")}`;
}

function describeCredentialStatus(): { ok: boolean; line: string } {
  const authPath = resolveCodexAuthPath();
  const credential = readCodexCliCredentialsCached({ ttlMs: CODEX_CREDENTIAL_TTL_MS });
  if (!credential) {
    const suffix = fs.existsSync(authPath)
      ? `auth.json 存在于 ${authPath}，但内容看起来无效。`
      : `未找到 ${authPath}。`;
    return {
      ok: false,
      line: `认证: 未检测到可用的 Codex 登录态；${suffix}`,
    };
  }

  const expiresInMs = credential.expires - Date.now();
  if (expiresInMs <= 0) {
    return {
      ok: false,
      line: `认证: 已过期（账号 ${credential.accountId ?? "unknown"}）。建议重新登录 Codex CLI。`,
    };
  }

  const expiresInMinutes = Math.max(1, Math.round(expiresInMs / 60_000));
  return {
    ok: true,
    line: `认证: 已检测到 Codex 登录态（账号 ${credential.accountId ?? "unknown"}，约 ${expiresInMinutes} 分钟后到期）。`,
  };
}

async function probeCodexBackend(): Promise<{ ok: boolean; line: string }> {
  try {
    const response = await fetch(CODEX_BACKEND_URL, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    return {
      ok: true,
      line: `网络: ChatGPT Codex backend 可达（HTTP ${response.status}）。`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      line: `网络: 无法连到 ChatGPT Codex backend（${message}）。`,
    };
  }
}

export async function runDelegateCodexHealthCheck(params: { workspaceDir: string }): Promise<string> {
  const workspaceOk = fs.existsSync(params.workspaceDir) && fs.statSync(params.workspaceDir).isDirectory();
  const codexBinary = findCommandOnPath("codex");
  const credential = describeCredentialStatus();
  const network = await probeCodexBackend();
  const issues: string[] = [];

  if (!workspaceOk) {
    issues.push(`工作目录不存在或不是目录: ${params.workspaceDir}`);
  }
  if (!codexBinary) {
    issues.push("当前 PATH 里没有检测到 codex 可执行文件。");
  }
  if (!credential.ok) {
    issues.push("Codex 登录态缺失或已失效。");
  }
  if (!network.ok) {
    issues.push("ChatGPT Codex backend 不可达。请排查网络或代理。");
  }

  return [
    issues.length === 0 ? "✅ Codex 本地健康检查通过" : "⚠️ Codex 本地健康检查发现问题",
    `工作目录: ${params.workspaceDir}`,
    `Codex 命令: ${codexBinary ?? "未找到"}`,
    credential.line,
    network.line,
    `代理: ${summarizeProxyEnv()}`,
    issues.length > 0 ? "" : null,
    issues.length > 0 ? "建议修复:" : null,
    ...issues.map((issue) => `- ${issue}`),
  ]
    .filter(Boolean)
    .join("\n");
}

export function detectCodexFailureKind(raw: string): CodexFailureKind {
  const lower = raw.toLowerCase();
  if (lower.includes("401 unauthorized")) {
    return "auth-401";
  }
  if (lower.includes("403 forbidden")) {
    return "forbidden-403";
  }
  if (lower.includes("404") && (lower.includes("backend-api/codex") || lower.includes("not found"))) {
    return "not-found-404";
  }
  if (
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("socket") ||
    lower.includes("connect")
  ) {
    return "network";
  }
  return "unknown";
}

export function buildCodexRepairHints(raw: string): string | null {
  const authPath = resolveCodexAuthPath();
  const hasCredential = Boolean(readCodexCliCredentialsCached({ ttlMs: CODEX_CREDENTIAL_TTL_MS }));
  const kind = detectCodexFailureKind(raw);
  const lines: string[] = [];

  if (kind === "unknown") {
    return null;
  }

  lines.push("可先这样排查:");

  if (kind === "auth-401") {
    lines.push(
      hasCredential
        ? "- 重新登录 Codex CLI，当前本地凭证看起来已失效或被服务端拒绝。"
        : `- 先登录 Codex CLI；当前没有读到可用凭证（检查 ${authPath}）。`,
    );
    lines.push("- 登录后再检查一次本机 Codex 的认证和网络状态，确认都正常。");
    return lines.join("\n");
  }

  if (kind === "forbidden-403") {
    lines.push("- 先检查本机 Codex 的网络连通性，确认能连到 ChatGPT Codex backend。");
    lines.push("- 如果最近切过代理/VPN，先切回能访问 chatgpt.com 的出口再重试。");
    lines.push(
      hasCredential
        ? "- 如果网络正常但仍然 403，通常是登录态失效或账号暂时没有 Codex backend 权限，建议重新登录。"
        : `- 当前也没有读到可用凭证，优先检查 ${authPath} 并重新登录。`,
    );
    return lines.join("\n");
  }

  if (kind === "not-found-404") {
    lines.push("- 先确认本机 Codex CLI 是最新可用版本，再重试。");
    lines.push("- 如果是代理导致请求被改写，先关闭异常代理/VPN 后再试。");
    lines.push("- 再检查一次 backend 连通性，确认请求没有被中间代理改写。");
    return lines.join("\n");
  }

  if (kind === "network") {
    lines.push("- 检查当前网络、VPN 和代理是否能访问 chatgpt.com。");
    lines.push("- 再检查 backend 可达性和代理环境变量是否正确。");
    if (!hasCredential) {
      lines.push(`- 网络恢复后再检查 ${authPath}，必要时重新登录 Codex CLI。`);
    }
    return lines.join("\n");
  }

  return null;
}

export async function buildDelegateRepairReport(params: { workspaceDir: string }): Promise<string> {
  const health = await runDelegateCodexHealthCheck({ workspaceDir: params.workspaceDir });
  return [
    "🛠️ Codex 本地修复建议",
    health,
    "",
    "如果刚刚遇到的是 401/403/404，一般按这个顺序处理:",
    "- 先确认本机 Codex 的认证和网络都正常",
    "- 再重新登录 Codex CLI",
    "- 仍失败时检查代理/VPN，确认 chatgpt.com/backend-api/codex 没被拦截或改写",
  ].join("\n");
}
