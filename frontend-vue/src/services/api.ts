export type ApiResponse<T> = {
  code: number;
  msg: string;
  data: T;
};

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { token?: string; timeoutMs?: number } = {}
): Promise<T> {
  const { token, timeoutMs: configuredTimeoutMs, signal: upstreamSignal, ...requestOptions } = options;
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(configuredTimeoutMs || 30000));
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  const abortFromUpstream = () => controller.abort();

  if (upstreamSignal?.aborted) {
    controller.abort();
  } else if (upstreamSignal) {
    upstreamSignal.addEventListener("abort", abortFromUpstream, { once: true });
  }

  try {
    const response = await fetch(path, {
      ...requestOptions,
      headers,
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload: ApiResponse<T>;
    try {
      payload = raw ? (JSON.parse(raw) as ApiResponse<T>) : ({ code: response.status, msg: "", data: undefined } as ApiResponse<T>);
    } catch (_) {
      const excerpt = raw.trim().slice(0, 160);
      throw new Error(
        response.ok
          ? "服务端响应格式错误"
          : `请求失败（HTTP ${response.status}）${excerpt ? `：${excerpt}` : ""}`
      );
    }
    if (!response.ok || payload.code >= 400) {
      throw new Error(payload.msg || `请求失败（HTTP ${response.status}）`);
    }
    return payload.data;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw new Error("请求超时，请重试");
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  }
}
