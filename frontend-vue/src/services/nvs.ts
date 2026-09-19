import { apiRequest } from "./api";

export type NvsItem = {
  namespace: string;
  key: string;
  type: string;
  value: string;
  values?: string[];
  description?: string;
  required?: boolean;
  secret?: boolean;
  rebootRequired?: boolean;
  readonly?: boolean;
  hasValue?: boolean;
  updatedAt?: string;
  pendingCommandId?: string;
};

export type NvsShadow = {
  deviceId: string;
  deviceType: string;
  items: NvsItem[];
  values: Record<string, string>;
};

export type NvsBackup = {
  id: string;
  deviceId: string;
  deviceType: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  keys: string[];
  rowCount: number;
  rows: NvsItem[];
};

export async function fetchNvsSchema(token: string, deviceId: string) {
  return apiRequest<{ deviceId: string; deviceType: string; adapter: string; items: NvsItem[] }>(
    `/api/nvs/devices/${encodeURIComponent(deviceId)}/schema`,
    { token }
  );
}

export async function fetchNvsShadow(token: string, deviceId: string) {
  return apiRequest<NvsShadow>(`/api/nvs/devices/${encodeURIComponent(deviceId)}/shadow`, { token });
}

export async function writeNvsValue(token: string, deviceId: string, key: string, value: string, reboot = false) {
  return apiRequest<NvsItem & { commandId?: string }>(
    `/api/nvs/devices/${encodeURIComponent(deviceId)}/values/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      token,
      body: JSON.stringify({ value, reboot }),
    }
  );
}

export async function importNvsConfig(token: string, deviceId: string, items: Array<{ key: string; value: string }>, reboot = false) {
  return apiRequest<{ deviceId: string; commandId: string; updated: number; items: NvsItem[] }>(
    `/api/nvs/devices/${encodeURIComponent(deviceId)}/import`,
    {
      method: "POST",
      token,
      body: JSON.stringify({ items, reboot }),
    }
  );
}

export async function fetchNvsBackups(token: string, deviceId: string) {
  return apiRequest<NvsBackup[]>(`/api/nvs/devices/${encodeURIComponent(deviceId)}/backups`, { token });
}

export async function restoreNvsBackup(token: string, deviceId: string, backupId: string, reboot = false) {
  return apiRequest<{ deviceId: string; backupId: string; commandId: string; restored: boolean; restoredKeys: string[]; items: NvsItem[] }>(
    `/api/nvs/devices/${encodeURIComponent(deviceId)}/backups/${encodeURIComponent(backupId)}/restore`,
    {
      method: "POST",
      token,
      body: JSON.stringify({ reboot }),
    }
  );
}
