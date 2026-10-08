<template>
  <el-card class="e6-device-card" shadow="never">
    <template #header>
      <div class="card-header">
        <strong>{{ displayName }}</strong>
        <el-tag :type="isE6 ? 'success' : 'info'" effect="plain">{{ deviceType }}</el-tag>
      </div>
    </template>

    <el-descriptions :column="2" border size="small">
      <el-descriptions-item label="设备ID">{{ field(device?.id) }}</el-descriptions-item>
      <el-descriptions-item label="在线">{{ device?.online ? "在线" : "离线" }}</el-descriptions-item>
      <el-descriptions-item label="当前集合">{{ currentCollectionLabel }}</el-descriptions-item>
      <el-descriptions-item label="播放模式">{{ field(playMode) }}</el-descriptions-item>
      <el-descriptions-item label="SD状态">{{ field(sdStatus) }}</el-descriptions-item>
      <el-descriptions-item label="SD容量">{{ sdCapacityLabel }}</el-descriptions-item>
      <el-descriptions-item label="温度">{{ temperatureLabel }}</el-descriptions-item>
      <el-descriptions-item label="湿度">{{ humidityLabel }}</el-descriptions-item>
    </el-descriptions>

    <div v-if="!isE6" class="not-e6">-</div>
  </el-card>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { PlayCollectionRow } from "../services/e6Albums";

const props = defineProps<{
  device: Record<string, any> | null;
  collections?: PlayCollectionRow[];
}>();

const deviceType = computed(() => field(props.device?.type));
const isE6 = computed(() => String(props.device?.type || "") === "e6-color-frame");
const displayName = computed(() => props.device?.displayName || props.device?.remark || props.device?.id || "未选择设备");

const currentCollectionId = computed(() =>
  pickFirst(
    props.device?.currentCollectionId,
    props.device?.playCollectionId,
    props.device?.e6CurrentCollectionId,
    props.device?.e6?.currentCollectionId,
    props.device?.status?.currentCollectionId,
    props.device?.telemetry?.currentCollectionId
  )
);

const currentCollectionLabel = computed(() => {
  const direct = pickFirst(
    props.device?.currentCollectionName,
    props.device?.playCollectionName,
    props.device?.e6?.currentCollectionName,
    props.device?.status?.currentCollectionName,
    props.device?.telemetry?.currentCollectionName
  );
  if (direct) return direct;
  const id = currentCollectionId.value;
  if (!id) return "-";
  const row = (props.collections || []).find((item) => item.id === id);
  return row?.name || id;
});

const playMode = computed(() =>
  pickFirst(
    props.device?.playMode,
    props.device?.collectionPlayMode,
    props.device?.e6?.playMode,
    props.device?.status?.playMode,
    props.device?.telemetry?.playMode
  )
);

const sdStatus = computed(() => {
  const value = pickFirst(
    props.device?.sdStatus,
    props.device?.sd?.status,
    props.device?.e6?.sdStatus,
    props.device?.e6?.sd?.status,
    props.device?.telemetry?.sdStatus,
    props.device?.telemetry?.sd?.status
  );
  if (value) return value;
  const mounted = pickFirst(
    props.device?.sdMounted,
    props.device?.sd?.mounted,
    props.device?.e6?.sdMounted,
    props.device?.e6?.sd?.mounted,
    props.device?.telemetry?.sdMounted,
    props.device?.telemetry?.sd?.mounted
  );
  if (mounted === "") return "";
  return truthyString(mounted) ? "已挂载" : "未挂载";
});

const sdCapacityLabel = computed(() => {
  const free = pickFirst(
    props.device?.sdFreeBytes,
    props.device?.sd?.freeBytes,
    props.device?.e6?.sdFreeBytes,
    props.device?.e6?.sd?.freeBytes,
    props.device?.telemetry?.sdFreeBytes,
    props.device?.telemetry?.sd?.freeBytes
  );
  const total = pickFirst(
    props.device?.sdTotalBytes,
    props.device?.sd?.totalBytes,
    props.device?.e6?.sdTotalBytes,
    props.device?.e6?.sd?.totalBytes,
    props.device?.telemetry?.sdTotalBytes,
    props.device?.telemetry?.sd?.totalBytes
  );
  if (free === "" && total === "") return "-";
  return `${formatBytes(free)} / ${formatBytes(total)}`;
});

const temperatureLabel = computed(() => {
  const value = pickFirst(
    props.device?.temperature,
    props.device?.temp,
    props.device?.sensor?.temperature,
    props.device?.e6?.temperature,
    props.device?.telemetry?.temperature,
    props.device?.variables?.temperature,
    props.device?.deviceVariables?.temperature
  );
  return value === "" ? "-" : `${value}${String(value).includes("°") ? "" : "°C"}`;
});

const humidityLabel = computed(() => {
  const value = pickFirst(
    props.device?.humidity,
    props.device?.sensor?.humidity,
    props.device?.e6?.humidity,
    props.device?.telemetry?.humidity,
    props.device?.variables?.humidity,
    props.device?.deviceVariables?.humidity
  );
  return value === "" ? "-" : `${value}${String(value).includes("%") ? "" : "%"}`;
});

function pickFirst(...values: any[]) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function truthyString(value: any) {
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "mounted", "ok"].includes(String(value || "").toLowerCase());
}

function field(value: any) {
  const text = String(value ?? "").trim();
  return text || "-";
}

function formatBytes(value: any) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}
</script>

<style scoped>
.e6-device-card {
  border-radius: 8px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.not-e6 {
  margin-top: 8px;
  color: #94a3b8;
  font-size: 12px;
}
</style>
