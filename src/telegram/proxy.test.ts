import { describe, expect, it, vi } from "vitest";

const { ProxyAgent, undiciFetch, proxyAgentSpy, getLastAgent } = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  const proxyAgentSpy = vi.fn();
  class ProxyAgent {
    static lastCreated: ProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      this.proxyUrl = proxyUrl;
      ProxyAgent.lastCreated = this;
      proxyAgentSpy(proxyUrl);
    }
  }

  return {
    ProxyAgent,
    undiciFetch,
    proxyAgentSpy,
    getLastAgent: () => ProxyAgent.lastCreated,
  };
});

vi.mock("undici", () => ({
  ProxyAgent,
  fetch: undiciFetch,
}));

import { makeProxyFetch, resolveTelegramProxyUrl } from "./proxy.js";

describe("makeProxyFetch", () => {
  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    await proxyFetch("https://api.telegram.org/bot123/getMe");

    expect(proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123/getMe",
      expect.objectContaining({ dispatcher: getLastAgent() }),
    );
  });
});

describe("resolveTelegramProxyUrl", () => {
  it("prefers explicit config proxy over env", () => {
    expect(
      resolveTelegramProxyUrl("http://config-proxy:8080", {
        HTTPS_PROXY: "http://env-proxy:8080",
      }),
    ).toBe("http://config-proxy:8080");
  });

  it("falls back to HTTPS_PROXY then HTTP_PROXY then ALL_PROXY", () => {
    expect(resolveTelegramProxyUrl(undefined, { HTTPS_PROXY: "http://https-proxy:8080" })).toBe(
      "http://https-proxy:8080",
    );
    expect(resolveTelegramProxyUrl(undefined, { HTTP_PROXY: "http://http-proxy:8080" })).toBe(
      "http://http-proxy:8080",
    );
    expect(resolveTelegramProxyUrl(undefined, { ALL_PROXY: "http://all-proxy:8080" })).toBe(
      "http://all-proxy:8080",
    );
  });

  it("returns undefined when no proxy is configured", () => {
    expect(resolveTelegramProxyUrl(undefined, {})).toBeUndefined();
  });
});
