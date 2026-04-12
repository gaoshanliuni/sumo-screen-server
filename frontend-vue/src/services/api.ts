export type ApiResponse<T> = {
  code: number;
  msg: string;
  data: T;
};

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { token?: string; timeoutMs?: number } = {}
): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Number(options.timeoutMs || 30000));
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  if (options.signal) {
    options.signal.addEventListener(
      "abort",
      () => {
        controller.abort();
      },
      { once: true }
    );
  }

  try {
    const response = await fetch(path, {
      ...options,
      headers,
      signal: controller.signal,
    });

    const payload = (await response.json()) as ApiResponse<T>;
    if (!response.ok || payload.code >= 400) {
      throw new Error(payload.msg || "请求失败");
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
  }
}

