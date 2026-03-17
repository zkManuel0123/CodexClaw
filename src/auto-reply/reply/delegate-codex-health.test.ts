import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexRepairHints,
  detectCodexFailureKind,
  detectDelegateHealthIntent,
  detectDelegateRepairIntent,
  runDelegateCodexHealthCheck,
} from "./delegate-codex-health.js";

describe("delegate-codex-health", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("detects common Codex failure kinds", () => {
    expect(detectCodexFailureKind("401 Unauthorized")).toBe("auth-401");
    expect(detectCodexFailureKind("403 Forbidden url: https://chatgpt.com/backend-api/codex/responses")).toBe(
      "forbidden-403",
    );
    expect(detectCodexFailureKind("404 not found backend-api/codex")).toBe("not-found-404");
    expect(detectCodexFailureKind("fetch failed: socket hang up")).toBe("network");
  });

  it("builds repair hints for forbidden errors", () => {
    const hint = buildCodexRepairHints(
      "unexpected status 403 Forbidden url: https://chatgpt.com/backend-api/codex/responses",
    );

    expect(hint).toContain("检查本机 Codex 的网络连通性");
    expect(hint).not.toContain("/delegate");
    expect(hint).toContain("代理/VPN");
  });

  it("detects natural-language local health and repair intents", () => {
    expect(detectDelegateHealthIntent("帮我检查一下 codex 登录态和网络状态")).toBe(true);
    expect(detectDelegateRepairIntent("帮我修一下 codex 登录态")).toBe(true);
    expect(detectDelegateHealthIntent("帮我检查这个仓库的登录页面实现")).toBe(false);
    expect(detectDelegateRepairIntent("修一下这个仓库的登录页面")).toBe(false);
  });

  it("reports backend reachability in health check", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })) as typeof fetch);

    const report = await runDelegateCodexHealthCheck({ workspaceDir: process.cwd() });

    expect(report).toContain("ChatGPT Codex backend 可达");
    expect(report).toContain("工作目录:");
  });
});
