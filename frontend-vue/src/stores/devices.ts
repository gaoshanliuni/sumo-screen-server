import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { apiRequest } from "../services/api";

export type DeviceInfo = {
  id: string;
  mac: string;
  status: string;
  type: string;
  ownerId: string;
  bindState: string;
  displayName?: string;
  defaultView?: string;
  remark?: string;
  clusterIds?: string[];
  clusterNames?: string[];
};

export type DeviceQuery = {
  status?: string;
  bound?: string;
  keyword?: string;
};

export const useDeviceStore = defineStore("devices", () => {
  const loading = ref(false);
  const devices = ref<DeviceInfo[]>([]);
  const selectedIds = ref<string[]>([]);

  const selectedDevices = computed(() => devices.value.filter((item) => selectedIds.value.includes(item.id)));

  async function fetchDevices(token: string, query: DeviceQuery = {}) {
    loading.value = true;
    try {
      const params = new URLSearchParams();
      const status = String(query.status || "").trim();
      const bound = String(query.bound || "").trim();
      const keyword = String(query.keyword || "").trim();
      if (status) params.set("status", status);
      if (bound === "bound") params.set("bound", "true");
      if (bound === "unbound") params.set("bound", "false");
      if (keyword) params.set("mac", keyword);
      const path = `/api/devices${params.toString() ? `?${params.toString()}` : ""}`;
      devices.value = await apiRequest<DeviceInfo[]>(path, { token });
      if (keyword) {
        const kw = keyword.toLowerCase();
        devices.value = devices.value.filter((item) => {
          const merged = `${item.id} ${item.mac} ${item.displayName || ""} ${item.remark || ""}`.toLowerCase();
          return merged.includes(kw);
        });
      }
      selectedIds.value = selectedIds.value.filter((id) => devices.value.some((d) => d.id === id));
    } finally {
      loading.value = false;
    }
  }

  function setSelection(ids: string[]) {
    const valid = new Set(devices.value.map((item) => item.id));
    selectedIds.value = [...new Set(ids.filter((id) => valid.has(id)))];
  }

  function clearSelection() {
    selectedIds.value = [];
  }

  return {
    loading,
    devices,
    selectedIds,
    selectedDevices,
    fetchDevices,
    setSelection,
    clearSelection,
  };
});
