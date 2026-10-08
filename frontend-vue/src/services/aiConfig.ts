import { apiRequest } from "./api";

export type AiConfigRow = {
  id: string;
  ownerId?: string;
  scope?: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  thinkingEnabled?: boolean;
  hasApiKey?: boolean;
  apiKeyMask?: string;
  updatedAt?: string;
};

export type MyAiConfigResponse = {
  config: AiConfigRow | null;
  effective: {
    source: string;
    configId?: string;
    provider: string;
    baseUrl: string;
    model: string;
    enabled: boolean;
    thinkingEnabled?: boolean;
    hasApiKey: boolean;
    apiKeyMask?: string;
  };
};

export async function fetchMyAiConfig(token: string) {
  return apiRequest<MyAiConfigResponse>("/api/ai/config/me", { token });
}

export async function saveMyAiConfig(token: string, payload: Record<string, any>) {
  return apiRequest<{ config: AiConfigRow; effective: MyAiConfigResponse["effective"] }>("/api/ai/config/me", {
    method: "PUT",
    token,
    body: JSON.stringify(payload),
  });
}

export async function fetchAdminAiConfigs(token: string) {
  return apiRequest<AiConfigRow[]>("/api/admin/ai/configs", { token });
}

export async function createAdminAiConfig(token: string, payload: Record<string, any>) {
  return apiRequest<AiConfigRow>("/api/admin/ai/configs", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export async function assignAdminAiConfig(token: string, payload: { configId: string; userIds: string[]; enabled?: boolean }) {
  return apiRequest<{ configId: string; assigned: number; userIds: string[] }>("/api/admin/ai/batch-assign", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}
