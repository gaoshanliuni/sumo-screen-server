<template>
  <teleport to="body">
    <transition name="el-fade-in-linear">
      <div v-if="modelValue" class="template-variable-panel" :class="{ mobile: isMobile, dragging: dragging }" :style="panelStyle">
        <div class="panel-header" @pointerdown="onDragStart">
          <div class="panel-title-block">
            <div class="panel-title">{{ title }}</div>
            <div class="panel-subtitle">{{ subtitle }}</div>
          </div>
          <div class="panel-actions">
            <el-button size="small" text @click.stop="emit('refresh')">刷新</el-button>
            <el-button size="small" text @click.stop="closePanel">关闭</el-button>
          </div>
        </div>

        <div class="panel-toolbar">
          <el-input v-model="keyword" clearable placeholder="模糊搜索变量路径、示例、来源" />
        </div>

        <el-tabs v-model="activeTab" class="panel-tabs">
          <el-tab-pane :label="`基础变量 (${filteredBaseVariables.length})`" name="base">
            <div class="panel-scroll">
              <div v-if="loading" class="panel-loading">变量加载中...</div>
              <div v-else-if="!filteredBaseVariables.length" class="panel-empty">暂无匹配的基础变量</div>
              <button
                v-for="item in filteredBaseVariables"
                :key="item.path"
                type="button"
                class="variable-item"
                @click="insertVariable(item.path)"
              >
                <div class="variable-path">{{ displayPlaceholder(item) }}</div>
                <div class="variable-meta">{{ item.example || item.type || item.path }}</div>
              </button>
            </div>
          </el-tab-pane>

          <el-tab-pane :label="`API模板变量 (${filteredApiGroupCount})`" name="api">
            <div class="panel-scroll">
              <div v-if="loading" class="panel-loading">变量加载中...</div>
              <div v-else-if="!filteredApiGroups.length" class="panel-empty">暂无匹配的 API 模板变量</div>
              <el-collapse v-else v-model="openGroups" class="api-groups">
                <el-collapse-item
                  v-for="group in filteredApiGroups"
                  :key="group.slug"
                  :name="group.slug"
                  class="api-group"
                >
                  <template #title>
                    <div class="group-title-row">
                      <span class="group-title">{{ group.label }}</span>
                      <el-tag size="small" type="info">{{ group.items.length }}</el-tag>
                    </div>
                  </template>
                  <div class="group-items">
                    <button
                      v-for="item in group.items"
                      :key="item.path"
                      type="button"
                      class="variable-item"
                      @click="insertVariable(item.path)"
                    >
                      <div class="variable-path">{{ displayPlaceholder(item) }}</div>
                      <div class="variable-meta">{{ item.example || item.type || item.path }}</div>
                    </button>
                  </div>
                </el-collapse-item>
              </el-collapse>
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
    </transition>
  </teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

type TemplateVariableItem = {
  path: string;
  placeholder: string;
  type: string;
  example: string;
  source?: "base" | "api";
  slug?: string;
  sourceLabel?: string;
};

type ApiVariableGroup = {
  slug: string;
  label: string;
  items: TemplateVariableItem[];
};

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    variables: TemplateVariableItem[];
    loading?: boolean;
    isMobile?: boolean;
    title?: string;
    subtitle?: string;
  }>(),
  {
    loading: false,
    isMobile: false,
    title: "插入变量",
    subtitle: "基础变量 / API模板变量",
  }
);

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "insert", path: string): void;
  (event: "refresh"): void;
}>();

const keyword = ref("");
const activeTab = ref<"base" | "api">("base");
const panel = reactive({ left: 20, top: 104, width: 520 });
const dragging = ref(false);
const dragState = reactive({ startX: 0, startY: 0, startLeft: 0, startTop: 0 });
const openGroups = ref<string[]>([]);

function closePanel() {
  emit("update:modelValue", false);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function syncPanelPosition() {
  if (props.isMobile) {
    panel.left = 8;
    panel.top = 92;
    panel.width = Math.max(0, window.innerWidth - 16);
    return;
  }

  panel.width = 520;
  const maxLeft = Math.max(12, window.innerWidth - panel.width - 12);
  const maxTop = Math.max(12, window.innerHeight - 160);
  panel.left = clamp(panel.left, 12, maxLeft);
  panel.top = clamp(panel.top, 88, maxTop);
}

function onDragStart(event: PointerEvent) {
  if (props.isMobile) return;
  if ((event.target as HTMLElement)?.closest(".panel-actions")) return;
  dragging.value = true;
  dragState.startX = event.clientX;
  dragState.startY = event.clientY;
  dragState.startLeft = panel.left;
  dragState.startTop = panel.top;
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", onDragEnd, { once: true });
}

function onDragMove(event: PointerEvent) {
  if (!dragging.value || props.isMobile) return;
  const nextLeft = dragState.startLeft + (event.clientX - dragState.startX);
  const nextTop = dragState.startTop + (event.clientY - dragState.startY);
  const maxLeft = Math.max(12, window.innerWidth - panel.width - 12);
  const maxTop = Math.max(12, window.innerHeight - 120);
  panel.left = clamp(nextLeft, 12, maxLeft);
  panel.top = clamp(nextTop, 64, maxTop);
}

function onDragEnd() {
  dragging.value = false;
  window.removeEventListener("pointermove", onDragMove);
}

watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      keyword.value = "";
      activeTab.value = "base";
      syncPanelPosition();
      if (!openGroups.value.length) {
        openGroups.value = [];
      }
    }
  },
  { immediate: true }
);

watch(
  () => props.variables,
  () => {
    if (!openGroups.value.length) return;
    const groups = filteredApiGroups.value.map((group) => group.slug);
    openGroups.value = openGroups.value.filter((slug) => groups.includes(slug));
  },
  { deep: true }
);

function matchesKeyword(item: TemplateVariableItem) {
  const text = String(keyword.value || "").trim().toLowerCase();
  if (!text) return true;
  const slug = String(item.slug || "").toLowerCase();
  return [item.path, item.placeholder, item.example, item.type, item.sourceLabel, slug]
    .filter(Boolean)
    .some((part) => String(part).toLowerCase().includes(text));
}

const filteredBaseVariables = computed(() => {
  return (props.variables || []).filter((item) => (item.source || "base") !== "api" && matchesKeyword(item));
});

const filteredApiGroups = computed<ApiVariableGroup[]>(() => {
  const map = new Map<string, TemplateVariableItem[]>();
  (props.variables || []).forEach((item) => {
    if ((item.source || "base") !== "api") return;
    const slug = String(item.slug || "latest").trim() || "latest";
    if (!matchesKeyword(item)) return;
    const list = map.get(slug) || [];
    list.push(item);
    map.set(slug, list);
  });

  return [...map.entries()]
    .map(([slug, items]) => ({
      slug,
      label: slug,
      items: items.sort((a, b) => String(a.path || "").localeCompare(String(b.path || ""))),
    }))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
});

const filteredApiGroupCount = computed(() => filteredApiGroups.value.length);

function insertVariable(path: string) {
  emit("insert", path);
}

function displayPlaceholder(item: TemplateVariableItem) {
  return String(item.placeholder || "").trim() || `{{${String(item.path || "").trim()}}}`;
}

const panelStyle = computed(() => ({
  left: props.isMobile ? "8px" : `${panel.left}px`,
  top: props.isMobile ? "92px" : `${panel.top}px`,
  width: props.isMobile ? `calc(100vw - 16px)` : `${panel.width}px`,
}));

onMounted(() => {
  window.addEventListener("resize", syncPanelPosition);
});

onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onDragMove);
  window.removeEventListener("resize", syncPanelPosition);
});
</script>

<style scoped>
.template-variable-panel {
  position: fixed;
  z-index: 2600;
  max-height: min(78vh, 760px);
  display: grid;
  grid-template-rows: auto auto 1fr;
  gap: 10px;
  padding: 12px;
  border: 1px solid #d7e0ea;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.97);
  box-shadow: 0 18px 42px rgba(15, 23, 42, 0.16);
  backdrop-filter: blur(16px);
  color: #0f172a;
}

.template-variable-panel.dragging {
  cursor: grabbing;
  user-select: none;
}

.template-variable-panel.mobile {
  max-height: calc(100vh - 100px);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  cursor: grab;
}

.panel-title-block {
  min-width: 0;
}

.panel-title {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
}

.panel-subtitle {
  margin-top: 3px;
  font-size: 12px;
  color: #64748b;
}

.panel-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.panel-toolbar {
  display: grid;
}

.panel-tabs {
  min-height: 0;
}

.panel-tabs :deep(.el-tabs__content) {
  min-height: 0;
}

.panel-tabs :deep(.el-tabs__nav-wrap::after) {
  background-color: rgba(148, 163, 184, 0.35);
}

.panel-scroll {
  max-height: min(58vh, 560px);
  overflow: auto;
  display: grid;
  gap: 8px;
  padding-right: 2px;
}

.panel-loading,
.panel-empty {
  padding: 12px 8px;
  font-size: 13px;
  color: #64748b;
}

.variable-item {
  display: grid;
  gap: 4px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #dce5ef;
  border-radius: 12px;
  background: #fff;
  text-align: left;
  cursor: pointer;
  transition: all 0.18s ease;
}

.variable-item:hover {
  border-color: #409eff;
  background: #f5faff;
  transform: translateY(-1px);
}

.variable-path {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
  word-break: break-all;
}

.variable-meta {
  font-size: 12px;
  line-height: 1.4;
  color: #64748b;
  word-break: break-all;
}

.api-groups {
  display: grid;
  gap: 8px;
}

.group-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.group-title {
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.group-items {
  display: grid;
  gap: 8px;
  padding: 4px 2px 4px 0;
}

.template-variable-panel :deep(.el-collapse) {
  border: none;
}

.template-variable-panel :deep(.el-collapse-item__header) {
  background: transparent;
  border-bottom: 1px solid rgba(226, 232, 240, 0.9);
}

.template-variable-panel :deep(.el-collapse-item__wrap) {
  background: transparent;
  border-bottom: none;
}

.template-variable-panel :deep(.el-collapse-item__content) {
  padding-bottom: 4px;
}

@media (max-width: 900px) {
  .template-variable-panel {
    border-radius: 14px;
    padding: 10px;
  }

  .panel-header {
    cursor: default;
  }

  .panel-scroll {
    max-height: calc(100vh - 250px);
  }
}
</style>
