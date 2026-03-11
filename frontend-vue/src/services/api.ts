export type ApiResponse<T> = {
  code: number;
  msg: string;
  data: T;
};

export async function apiRequest<T>(path: string, options: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  const payload = (await response.json()) as ApiResponse<T>;
  if (!response.ok || payload.code >= 400) {
    throw new Error(payload.msg || "请求失败");
  }
  return payload.data;
}
