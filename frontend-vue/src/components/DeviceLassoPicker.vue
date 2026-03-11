<template>
  <div class="picker-shell">
    <div class="toolbar">
      <el-input v-model="keyword" placeholder="搜索设备ID / 名称 / MAC / 备注 / 设备池" clearable style="max-width: 360px" />
      <el-select v-model="status" style="width: 170px">
        <el-option label="全部状态" value="all" />
        <el-option label="enabled" value="enabled" />
        <el-option label="blocked" value="blocked" />
      </el-select>
      <el-select v-model="bindFilter" style="width: 170px">
        <el-option label="全部绑定状态" value="all" />
        <el-option label="已绑定" value="bound" />
        <el-option label="未绑定" value="unbound" />
      </el-select>
      <el-button @click="selectAllFiltered">全选筛选结果</el-button>
      <el-button @click="invertFilteredSelection">反选筛选结果</el-button>
      <el-button @click="emitSelection([])">清空选择</el-button>
      <el-tag type="warning">已选 {{ localSelected.length }} 台</el-tag>
      <el-tag>筛选后 {{ filteredDevices.length }} 台</el-tag>
    </div>

    <div
      ref="canvasRef"
      class="cards-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="onPointerUp"
    >
      <div
        v-for="item in filteredDevices"
        :key="item.id"
        :ref="(el) => setCardRef(item.id, el as HTMLDivElement | null)"
        class="card"
        :class="{ selected: localSelected.includes(item.id) }"
        @click.stop="toggleOne(item.id)"
      >
        <div class="title">{{ item.displayName || item.id }}</div>
        <div class="meta">ID: {{ item.id }}</div>
        <div class="meta">MAC: {{ item.mac }}</div>
        <div class="meta">类型: {{ item.type || "-" }} / 状态: {{ item.status || "-" }}</div>
        <div class="meta">绑定: {{ item.bindState === "bound" ? "已绑定" : "未绑定" }}</div>
        <div class="meta">备注: {{ item.remark || "-" }}</div>
        <div class="meta">设备池: {{ (item.clusterNames || []).join("、") || "-" }}</div>
      </div>

      <div v-if="lasso.visible" class="lasso" :style="lassoStyle"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import type { DeviceInfo } from "../stores/devices";

const props = defineProps<{
  devices: DeviceInfo[];
  modelValue: string[];
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: string[]): void;
  (e: "filtered-change", ids: string[]): void;
}>();

const keyword = ref("");
const status = ref<"all" | "enabled" | "blocked">("all");
const bindFilter = ref<"all" | "bound" | "unbound">("all");
const canvasRef = ref<HTMLDivElement | null>(null);
const cardRefMap = new Map<string, HTMLDivElement>();

const localSelected = ref<string[]>([]);
watch(
  () => props.modelValue,
  (next) => {
    localSelected.value = [...next];
  },
  { immediate: true }
);

const filteredDevices = computed(() => {
  const key = keyword.value.trim().toLowerCase();
  return props.devices.filter((item) => {
    if (status.value !== "all" && String(item.status || "") !== status.value) return false;
    if (bindFilter.value === "bound" && item.bindState !== "bound") return false;
    if (bindFilter.value === "unbound" && item.bindState === "bound") return false;
    if (!key) return true;
    const merged = `${item.id} ${item.displayName || ""} ${item.mac} ${item.remark || ""} ${(item.clusterNames || []).join(" ")}`.toLowerCase();
    return merged.includes(key);
  });
});

watch(
  filteredDevices,
  (rows) => {
    emit(
      "filtered-change",
      rows.map((item) => item.id)
    );
  },
  { immediate: true }
);

const lasso = reactive({
  visible: false,
  startX: 0,
  startY: 0,
  endX: 0,
  endY: 0,
  pointerId: -1,
});

const lassoStyle = computed(() => {
  const x = Math.min(lasso.startX, lasso.endX);
  const y = Math.min(lasso.startY, lasso.endY);
  const w = Math.abs(lasso.endX - lasso.startX);
  const h = Math.abs(lasso.endY - lasso.startY);
  return {
    left: `${x}px`,
    top: `${y}px`,
    width: `${w}px`,
    height: `${h}px`,
  };
});

function setCardRef(id: string, el: HTMLDivElement | null) {
  if (!el) {
    cardRefMap.delete(id);
    return;
  }
  cardRefMap.set(id, el);
}

function emitSelection(ids: string[]) {
  localSelected.value = [...ids];
  emit("update:modelValue", [...ids]);
}

function getFilteredIds() {
  return filteredDevices.value.map((item) => item.id);
}

function selectAllFiltered() {
  emitSelection(getFilteredIds());
}

function invertFilteredSelection() {
  const filtered = new Set(getFilteredIds());
  const selected = new Set(localSelected.value);
  filtered.forEach((id) => {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  });
  emitSelection([...selected]);
}

function getFilters() {
  return {
    keyword: keyword.value.trim(),
    status: status.value,
    bound: bindFilter.value,
  };
}

function toggleOne(id: string) {
  const set = new Set(localSelected.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  emitSelection([...set]);
}

function getCanvasPoint(event: PointerEvent) {
  const rect = canvasRef.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function onPointerDown(event: PointerEvent) {
  if (!canvasRef.value) return;
  if (event.button !== 0) return;
  const p = getCanvasPoint(event);
  lasso.visible = true;
  lasso.startX = p.x;
  lasso.startY = p.y;
  lasso.endX = p.x;
  lasso.endY = p.y;
  lasso.pointerId = event.pointerId;
  canvasRef.value.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (!lasso.visible || lasso.pointerId !== event.pointerId) return;
  const p = getCanvasPoint(event);
  lasso.endX = p.x;
  lasso.endY = p.y;
}

function onPointerUp(event: PointerEvent) {
  if (!lasso.visible || lasso.pointerId !== event.pointerId) return;
  const rectCanvas = canvasRef.value?.getBoundingClientRect();
  if (!rectCanvas) return;

  const x1 = Math.min(lasso.startX, lasso.endX);
  const y1 = Math.min(lasso.startY, lasso.endY);
  const x2 = Math.max(lasso.startX, lasso.endX);
  const y2 = Math.max(lasso.startY, lasso.endY);

  const selected = new Set(localSelected.value);
  if (!event.shiftKey && !event.ctrlKey) selected.clear();

  filteredDevices.value.forEach((item) => {
    const el = cardRefMap.get(item.id);
    if (!el) return;
    const card = el.getBoundingClientRect();
    const cx1 = card.left - rectCanvas.left;
    const cy1 = card.top - rectCanvas.top;
    const cx2 = cx1 + card.width;
    const cy2 = cy1 + card.height;
    const intersects = !(cx2 < x1 || cx1 > x2 || cy2 < y1 || cy1 > y2);
    if (intersects) selected.add(item.id);
  });

  emitSelection([...selected]);

  if (canvasRef.value.hasPointerCapture(event.pointerId)) {
    canvasRef.value.releasePointerCapture(event.pointerId);
  }
  lasso.visible = false;
  lasso.pointerId = -1;
}

defineExpose({
  getFilteredIds,
  getFilters,
  selectAllFiltered,
  invertFilteredSelection,
  clearSelection: () => emitSelection([]),
});
</script>

<style scoped>
.picker-shell {
  display: grid;
  gap: 12px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.cards-canvas {
  position: relative;
  min-height: 220px;
  border: 1px solid #d6d8dc;
  border-radius: 12px;
  padding: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  user-select: none;
}

.card {
  border: 1px solid #cfd4dc;
  border-radius: 10px;
  padding: 10px;
  background: #fff;
  cursor: pointer;
}

.card.selected {
  border-color: #1f6feb;
  background: #eef4ff;
}

.title {
  font-weight: 700;
  margin-bottom: 6px;
}

.meta {
  font-size: 12px;
  color: #4d5868;
}

.lasso {
  position: absolute;
  border: 1px solid #1f6feb;
  background: rgba(31, 111, 235, 0.15);
  pointer-events: none;
}
</style>
