import { apiRequest } from "./api";

export type XiqueSyncInterval = 10 | 30 | 60;

export type XiqueScheduleConfig = {
  id: string;
  deviceId: string;
  source?: string;
  enabled: boolean;
  intervalMinutes: XiqueSyncInterval;
  currentTermKey: string;
  adapterMode?: string;
  baseUrl?: string;
  sampleUrl?: string;
  sampleHtml?: string;
  sampleJson?: Record<string, any>;
  requireCaptcha?: boolean;
  needCaptchaReverify?: boolean;
  paused?: boolean;
  pauseReason?: string;
  pauseUntil?: string;
  failureCount?: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  nextRunAt?: string;
  loginUsername?: string;
  loginDisplayName?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type XiqueSessionVault = {
  id: string;
  configId: string;
  deviceId: string;
  state: string;
  sessionId: string;
  sessionExpiresAt: string;
  captchaSession: string;
  captchaImage: string;
  captchaExpiresAt: string;
  needCaptchaReverify: boolean;
  lastVerifiedAt: string;
  lastLoginAt: string;
  lastError: string;
  hasCredential?: boolean;
  hasSession?: boolean;
};

export type XiqueStatusResponse = {
  deviceId: string;
  config: XiqueScheduleConfig;
  session: XiqueSessionVault;
  logs: Array<Record<string, any>>;
};

export type XiqueInitLoginResponse = {
  deviceId: string;
  configId: string;
  loginRequired: boolean;
  captchaRequired: boolean;
  captchaSession: string;
  captchaImage: string;
  captchaExpiresAt: string;
  session: XiqueSessionVault;
};

export type XiqueImportResponse = {
  status: string;
  loginStatus?: string;
  deviceId: string;
  configId: string;
  taskId?: string;
  needManualCaptcha?: boolean;
  reason?: string;
  ocrFailCount?: number;
  ocrAttempts?: number;
  ocrFailures?: number;
  termKey?: string;
  result?: Record<string, any>;
  nextRunAt?: string;
  captchaSession?: string;
  captchaImage?: string;
  captchaExpiresAt?: string;
  needCaptchaReverify?: boolean;
};

export type XiqueConfigPayload = {
  deviceId: string;
  enabled: boolean;
  intervalMinutes: XiqueSyncInterval;
  currentTermKey: string;
  loginUsername?: string;
  loginDisplayName?: string;
};

function normalizeIntervalMinutes(value: unknown): XiqueSyncInterval {
  const numeric = Math.floor(Number(value || 60));
  if (numeric === 10 || numeric === 30 || numeric === 60) return numeric;
  return 60;
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeXiqueConfig(input?: Partial<XiqueScheduleConfig> | null): XiqueConfigPayload {
  return {
    deviceId: cleanString(input?.deviceId),
    enabled: Boolean(input?.enabled),
    intervalMinutes: normalizeIntervalMinutes(input?.intervalMinutes),
    currentTermKey: cleanString(input?.currentTermKey),
    loginUsername: cleanString(input?.loginUsername),
    loginDisplayName: cleanString(input?.loginDisplayName),
  };
}

export async function fetchXiqueStatus(token: string, deviceId: string) {
  return apiRequest<XiqueStatusResponse>(`/api/schedules/xique/status?deviceId=${encodeURIComponent(cleanString(deviceId))}`, {
    token,
    timeoutMs: 30000,
  });
}

export async function saveXiqueConfig(token: string, payload: XiqueConfigPayload) {
  return apiRequest<{ config: XiqueScheduleConfig; session: XiqueSessionVault }>(`/api/schedules/xique/config`, {
    method: "POST",
    token,
    body: JSON.stringify(payload),
    timeoutMs: 45000,
  });
}

export async function initXiqueLogin(
  token: string,
  payload: Partial<XiqueConfigPayload> & {
    deviceId: string;
    requireCaptcha?: boolean;
    forceCaptcha?: boolean;
    captchaSession?: string;
    captchaAnswer?: string;
    captchaCode?: string;
  }
) {
  return apiRequest<XiqueInitLoginResponse>(`/api/schedules/xique/init-login`, {
    method: "POST",
    token,
    body: JSON.stringify(payload),
    timeoutMs: 90000,
  });
}

export async function importXiqueSchedule(
  token: string,
  payload: Partial<XiqueConfigPayload> & {
    deviceId: string;
    captchaSession?: string;
    captchaAnswer?: string;
    forceCaptcha?: boolean;
  }
) {
  return apiRequest<XiqueImportResponse>(`/api/schedules/xique/import`, {
    method: "POST",
    token,
    body: JSON.stringify(payload),
    timeoutMs: 180000,
  });
}

export async function startXiqueImport(
  token: string,
  payload: Partial<XiqueConfigPayload> & {
    deviceId: string;
    forceCaptcha?: boolean;
    autoOcrEnabled?: boolean;
  }
) {
  return apiRequest<XiqueImportResponse>(`/api/schedules/xique/import/start`, {
    method: "POST",
    token,
    body: JSON.stringify(payload),
    timeoutMs: 180000,
  });
}

export async function verifyXiqueCaptcha(
  token: string,
  payload: {
    deviceId: string;
    taskId?: string;
    configId?: string;
    sessionId?: string;
    captchaSession?: string;
    captchaCode: string;
    loginUsername?: string;
    password?: string;
    currentTermKey?: string;
    enabled?: boolean;
    intervalMinutes?: XiqueSyncInterval;
  }
) {
  return apiRequest<XiqueImportResponse>(`/api/schedules/xique/import/verify-captcha`, {
    method: "POST",
    token,
    body: JSON.stringify(payload),
    timeoutMs: 180000,
  });
}

export async function reverifyXiqueLogin(
  token: string,
  payload: Partial<XiqueConfigPayload> & {
    deviceId: string;
    captchaSession?: string;
    captchaAnswer?: string;
    forceCaptcha?: boolean;
  }
) {
  return apiRequest<XiqueInitLoginResponse>(`/api/schedules/xique/reverify`, {
    method: "POST",
    token,
    body: JSON.stringify(payload),
    timeoutMs: 90000,
  });
}
