import { apiRequest } from "./api";

export type DeviceTypeRow = {
  id: string;
  name: string;
  defaultWidth: number;
  defaultHeight: number;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
};

export async function fetchDeviceTypes(token: string) {
  return apiRequest<DeviceTypeRow[]>("/api/device-types", { token });
}

export async function createDeviceType(token: string, payload: Partial<DeviceTypeRow>) {
  return apiRequest<DeviceTypeRow>("/api/device-types", {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export async function updateDeviceType(token: string, id: string, payload: Partial<DeviceTypeRow>) {
  return apiRequest<DeviceTypeRow>(`/api/device-types/${encodeURIComponent(id)}`, {
    method: "POST",
    token,
    body: JSON.stringify(payload),
  });
}

export async function deleteDeviceType(token: string, id: string) {
  return apiRequest<{ id: string }>(`/api/device-types/${encodeURIComponent(id)}/delete`, {
    method: "POST",
    token,
    body: JSON.stringify({}),
  });
}
