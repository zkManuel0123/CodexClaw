import { ProxyAgent, fetch as undiciFetch } from "undici";

export function resolveTelegramProxyUrl(
  configuredProxyUrl?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = configuredProxyUrl?.trim();
  if (configured) {
    return configured;
  }

  for (const key of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    const value = env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function makeProxyFetch(proxyUrl: string): typeof fetch {
  const agent = new ProxyAgent(proxyUrl);
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    }) as unknown as Promise<Response>) as typeof fetch;
  // Return raw proxy fetch; call sites that need AbortSignal normalization
  // should opt into resolveFetch/wrapFetchWithAbortSignal once at the edge.
  return fetcher;
}
