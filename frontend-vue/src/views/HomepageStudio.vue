<template>
  <div class="homepage-studio">
    <el-card class="card">
      <template #header>
        <div class="row between">
          <strong>Homepage Studio</strong>
          <div class="row" v-if="auth.token">
            <span>{{ auth.username }}</span>
            <el-button type="danger" plain size="small" @click="logout">退出登录</el-button>
          </div>
        </div>
      </template>

      <div v-if="!auth.token" class="login-wrap">
        <el-form label-width="90px" @submit.prevent>
          <el-form-item label="角色">
            <el-select v-model="role" style="width: 100%">
              <el-option label="管理员" value="admin" />
              <el-option label="用户" value="user" />
            </el-select>
          </el-form-item>
          <el-form-item label="用户名"><el-input v-model="loginForm.username" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="loginForm.password" show-password /></el-form-item>
          <el-button type="primary" :loading="loginLoading" @click="doLogin">登录</el-button>
        </el-form>
      </div>

      <div v-else class="studio-grid">
        <el-card>
          <template #header>
            <div class="row between">
              <strong>渲染预览</strong>
              <el-radio-group v-model="previewMode" size="small">
                <el-radio-button label="edit">编辑预览</el-radio-button>
                <el-radio-button label="delivery">下发预览</el-radio-button>
              </el-radio-group>
            </div>
          </template>
          <div v-if="previewMode === 'edit'" class="preview-wrap">
            <img v-if="editPreviewUrl" :src="editPreviewUrl" alt="edit preview" class="preview-img" />
            <div v-else class="preview-empty">{{ editPreviewLoading ? "编辑预览渲染中..." : "编辑模板后自动生成预览" }}</div>
          </div>
          <template v-else>
            <div class="preview-meta">
              <div>etag: {{ renderMeta.etag || '-' }}</div>
              <div>image: {{ renderMeta.image_id || '-' }}</div>
              <div>size: {{ renderMeta.image_width || 0 }} x {{ renderMeta.image_height || 0 }}</div>
            </div>
            <div class="preview-wrap">
              <img v-if="previewUrl" :src="previewUrl" alt="preview" class="preview-img" />
              <div v-else class="preview-empty">先执行一次渲染</div>
            </div>
          </template>
        </el-card>

        <el-card>
          <template #header>
            <div class="row between">
              <strong>设备与配置</strong>
              <el-button size="small" @click="loadAll">刷新</el-button>
            </div>
          </template>
          <el-form label-width="120px" size="small">
            <el-form-item label="目标设备">
              <el-select v-model="deviceId" filterable style="width: 100%" @change="loadConfig">
                <el-option v-for="item in devices" :key="item.id" :label="deviceLabel(item)" :value="item.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="模板 ID">
              <el-select v-model="configModel.template.template_id" filterable style="width: 100%">
                <el-option v-for="tpl in templates" :key="tpl.id" :label="tpl.name" :value="tpl.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="渲染引擎">
              <el-select v-model="configModel.template.render_engine" style="width: 100%">
                <el-option label="auto（推荐）" value="auto" />
                <el-option label="browser（支持 HTML+JS）" value="browser" />
                <el-option label="legacy（仅兼容 data-x/data-y）" value="legacy" />
              </el-select>
            </el-form-item>
            <el-form-item label="时间覆盖启用"><el-switch v-model="configModel.time_overlay.enabled" /></el-form-item>
            <el-form-item label="时间格式"><el-input v-model="configModel.time_overlay.format" /></el-form-item>
            <el-form-item label="时间区域 X/Y/W/H">
              <div class="row wrap">
                <el-input-number v-model="configModel.time_overlay.x" :min="0" />
                <el-input-number v-model="configModel.time_overlay.y" :min="0" />
                <el-input-number v-model="configModel.time_overlay.width" :min="40" />
                <el-input-number v-model="configModel.time_overlay.height" :min="40" />
              </div>
            </el-form-item>
            <el-form-item label="时间字号/间隔">
              <div class="row wrap">
                <el-input-number v-model="configModel.time_overlay.font_size" :min="12" :max="220" />
                <el-input-number v-model="configModel.time_overlay.refresh_interval_sec" :min="1" :max="3600" />
              </div>
            </el-form-item>
            <el-form-item label="JSON 高级配置">
              <el-input v-model="configJson" type="textarea" :rows="12" />
            </el-form-item>
          </el-form>
          <div class="row wrap">
            <el-button type="primary" @click="saveConfig">保存配置</el-button>
            <el-button @click="renderHomepage">仅渲染</el-button>
            <el-button type="success" @click="pushHomepage">渲染并推送</el-button>
          </div>
        </el-card>

        <el-card>
          <template #header>
            <div class="row between">
              <strong>HTML 模板</strong>
              <div class="row">
                <el-button size="small" @click="newTemplate">新建模板</el-button>
                <el-button size="small" @click="loadTemplates">刷新模板</el-button>
              </div>
            </div>
          </template>
          <el-form label-width="100px" size="small">
            <el-form-item label="模板">
              <el-select v-model="templateDraft.id" clearable filterable style="width: 100%" @change="onSelectTemplate">
                <el-option v-for="tpl in templates" :key="tpl.id" :label="tpl.name" :value="tpl.id" />
              </el-select>
            </el-form-item>
            <el-form-item label="名称"><el-input v-model="templateDraft.name" /></el-form-item>
            <el-form-item label="HTML">
              <el-input v-model="templateDraft.html" type="textarea" :rows="20" />
            </el-form-item>
          </el-form>
          <div class="row wrap">
            <el-button type="primary" @click="saveTemplate">保存模板</el-button>
            <el-button type="danger" :disabled="!templateDraft.id || templateDraft.builtin" @click="deleteTemplate">删除模板</el-button>
          </div>
        </el-card>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore, type AppRole } from "../stores/auth";
import { apiRequest } from "../services/api";

type DeviceRow = {
  id: string;
  mac: string;
  displayName?: string;
  ownerId?: string;
};

type HomepageTemplateRow = {
  id: string;
  name: string;
  type: string;
  html: string;
  builtin?: boolean;
};

const auth = useAuthStore();
const role = ref<AppRole>("admin");
const loginLoading = ref(false);
const loginForm = reactive({ username: "admin", password: "admin123" });

const devices = ref<DeviceRow[]>([]);
const deviceId = ref("");
const templates = ref<HomepageTemplateRow[]>([]);
const previewUrl = ref("");
const editPreviewUrl = ref("");
const editPreviewLoading = ref(false);
const renderMeta = reactive<Record<string, any>>({});
const previewMode = ref<"edit" | "delivery">("edit");
let editPreviewTimer: ReturnType<typeof setTimeout> | null = null;

const configModel = reactive<any>({
  template: {
    template_id: "tpl_home_default",
    render_engine: "auto",
  },
  time_overlay: {
    enabled: true,
    x: 1820,
    y: 80,
    width: 680,
    height: 180,
    format: "HH:mm",
    font_size: 88,
    refresh_interval_sec: 60,
  },
});
const configJson = ref("{}");

const templateDraft = reactive<HomepageTemplateRow>({
  id: "",
  name: "",
  type: "custom_html",
  html: "",
  builtin: false,
});

function defaultTemplateHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body{margin:0;background:#fff;color:#111;font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;}
    .wrap{padding:80px 100px;}
    h1{margin:0;font-size:72px;}
    .line{margin-top:24px;font-size:42px;}
    .clock{position:absolute;top:72px;right:96px;font-size:64px;font-weight:700;}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>{{profile.name}}</h1>
    <div class="line">{{profile.title}}</div>
    <div class="line">{{profile.department}} · {{profile.workstation}}</div>
    <div class="line">TODO: {{todo_summary.text}}</div>
  </div>
  <div id="clock" class="clock"></div>
  <script>
    const now = new Date();
    const p = (n) => String(n).padStart(2, "0");
    document.getElementById("clock").textContent = p(now.getHours()) + ":" + p(now.getMinutes());
  <\/script>
</body>
</html>`;
}

function clearPreviewRef(target: typeof previewUrl | typeof editPreviewUrl) {
  if (target.value && target.value.startsWith("blob:")) {
    URL.revokeObjectURL(target.value);
  }
  target.value = "";
}

function deviceLabel(row: DeviceRow) {
  const name = String(row.displayName || "").trim();
  return name ? `${name} (${row.id})` : `${row.mac} (${row.id})`;
}

async function doLogin() {
  loginLoading.value = true;
  try {
    await auth.login(role.value, loginForm.username, loginForm.password);
    await loadAll();
    ElMessage.success("登录成功");
  } catch (error) {
    ElMessage.error((error as Error).message || "登录失败");
  } finally {
    loginLoading.value = false;
  }
}

function logout() {
  auth.logout();
}

function syncConfigJsonFromModel() {
  configJson.value = JSON.stringify(configModel, null, 2);
}

function applyConfigModel(data: Record<string, any>) {
  Object.keys(configModel).forEach((k) => delete configModel[k]);
  Object.assign(configModel, data || {});
  if (!configModel.template) configModel.template = { template_id: "tpl_home_default", render_engine: "auto" };
  if (!configModel.template.render_engine) configModel.template.render_engine = "auto";
  if (!configModel.time_overlay) {
    configModel.time_overlay = {
      enabled: true,
      x: 1820,
      y: 80,
      width: 680,
      height: 180,
      format: "HH:mm",
      font_size: 88,
      refresh_interval_sec: 60,
    };
  }
  syncConfigJsonFromModel();
}

async function loadDevices() {
  devices.value = await apiRequest<DeviceRow[]>("/api/devices", { token: auth.token });
  if (!deviceId.value && devices.value.length) {
    deviceId.value = devices.value[0].id;
  }
}

async function loadTemplates() {
  templates.value = await apiRequest<HomepageTemplateRow[]>("/api/homepages/templates", { token: auth.token });
  if (templateDraft.id) {
    const current = templates.value.find((item) => item.id === templateDraft.id);
    if (!current) {
      templateDraft.id = "";
      templateDraft.builtin = false;
    }
  }
}

async function loadConfig() {
  if (!deviceId.value) return;
  const data = await apiRequest<any>(`/api/homepages/config?deviceId=${encodeURIComponent(deviceId.value)}`, { token: auth.token });
  applyConfigModel(data);
  Object.keys(renderMeta).forEach((k) => delete renderMeta[k]);
  Object.assign(renderMeta, data.image || {});
  await fetchPreview(data.image || {}, previewUrl);
  scheduleEditPreview();
}

async function loadAll() {
  if (!auth.token) return;
  await loadDevices();
  await Promise.all([loadTemplates(), loadConfig()]);
}

function parseConfigJson() {
  try {
    return JSON.parse(configJson.value || "{}");
  } catch (_) {
    throw new Error("JSON 高级配置格式错误");
  }
}

function buildConfigPatch() {
  const patch = parseConfigJson();
  patch.template = patch.template || {};
  patch.template.template_id = String(configModel?.template?.template_id || patch.template.template_id || "tpl_home_default");
  patch.template.render_engine = String(configModel?.template?.render_engine || patch.template.render_engine || "auto");

  patch.time_overlay = patch.time_overlay || {};
  const srcOverlay = configModel?.time_overlay || {};
  Object.keys(srcOverlay).forEach((k) => {
    patch.time_overlay[k] = srcOverlay[k];
  });
  return patch;
}

async function saveConfig() {
  if (!deviceId.value) return ElMessage.error("请先选择设备");
  const patch = buildConfigPatch();
  await apiRequest("/api/homepages/config", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deviceId: deviceId.value,
      config: patch,
    }),
  });
  ElMessage.success("主页配置已保存");
  await loadConfig();
}

async function renderHomepage() {
  if (!deviceId.value) return ElMessage.error("请先选择设备");
  const patch = buildConfigPatch();
  const data = await apiRequest<any>("/api/homepages/render", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deviceId: deviceId.value,
      config: patch,
      template: {
        id: templateDraft.id || configModel?.template?.template_id || "tpl_home_default",
        name: templateDraft.name || "Homepage Template",
        type: templateDraft.builtin ? "default_html" : "custom_html",
        html: templateDraft.html || "",
      },
    }),
  });
  Object.keys(renderMeta).forEach((k) => delete renderMeta[k]);
  Object.assign(renderMeta, data.image || {});
  await fetchPreview(data.image || {}, previewUrl);
  await fetchPreview(data.image || {}, editPreviewUrl);
  ElMessage.success("渲染完成");
}

async function pushHomepage() {
  if (!deviceId.value) return ElMessage.error("请先选择设备");
  const patch = buildConfigPatch();
  const result = await apiRequest<any>("/api/homepages/push", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deviceId: deviceId.value,
      config: patch,
      template: buildTemplatePatchForRender(),
    }),
  });
  ElMessage.success(`推送结果：成功 ${result.successCount || 0}，失败 ${result.failedCount || 0}`);
  await loadConfig();
}

function onSelectTemplate(id: string) {
  if (!id) {
    newTemplate();
    return;
  }
  const row = templates.value.find((item) => item.id === id);
  if (!row) return;
  templateDraft.id = row.id;
  templateDraft.name = row.name;
  templateDraft.type = row.type;
  templateDraft.html = row.html;
  templateDraft.builtin = Boolean(row.builtin);
}

function newTemplate() {
  templateDraft.id = "";
  templateDraft.name = "";
  templateDraft.type = "custom_html";
  templateDraft.builtin = false;
  templateDraft.html = defaultTemplateHtml();
  scheduleEditPreview();
}

async function saveTemplate() {
  if (!templateDraft.name.trim() || !templateDraft.html.trim()) {
    return ElMessage.error("模板名称和 HTML 不能为空");
  }
  const row = await apiRequest<any>("/api/homepages/templates", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      id: templateDraft.id && !templateDraft.builtin ? templateDraft.id : undefined,
      name: templateDraft.name.trim(),
      type: templateDraft.builtin ? "default_html" : "custom_html",
      html: templateDraft.html,
    }),
  });
  templateDraft.id = row.id;
  ElMessage.success("模板已保存");
  await loadTemplates();
  scheduleEditPreview();
}

async function deleteTemplate() {
  if (!templateDraft.id) return;
  await apiRequest(`/api/homepages/templates/${templateDraft.id}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({}),
  });
  ElMessage.success("模板已删除");
  templateDraft.id = "";
  templateDraft.name = "";
  templateDraft.type = "custom_html";
  templateDraft.html = "";
  await loadTemplates();
  scheduleEditPreview();
}

function buildTemplatePatchForRender() {
  const html = String(templateDraft.html || "").trim();
  if (!html) return undefined;
  return {
    id: templateDraft.id || configModel?.template?.template_id || "tpl_home_default",
    name: String(templateDraft.name || "").trim() || "Homepage Template",
    type: templateDraft.builtin ? "default_html" : "custom_html",
    html,
  };
}

async function fetchPreview(image: Record<string, any>, target: typeof previewUrl | typeof editPreviewUrl) {
  clearPreviewRef(target);
  if (!image || typeof image !== "object") return;

  const inlineDataUrl = String(image.preview_data_url || "").trim();
  if (inlineDataUrl.startsWith("data:image/")) {
    target.value = inlineDataUrl;
    return;
  }

  const url = String(image.admin_preview_url || image.preview_url || "").trim();
  if (!url) return;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
    },
  });
  if (!response.ok) return;
  const blob = await response.blob();
  target.value = URL.createObjectURL(blob);
}

async function renderEditPreview() {
  if (!auth.token || !deviceId.value || previewMode.value !== "edit") return;
  editPreviewLoading.value = true;
  try {
    const patch = buildConfigPatch();
    const data = await apiRequest<any>("/api/homepages/render", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({
        deviceId: deviceId.value,
        config: patch,
        template: buildTemplatePatchForRender(),
      }),
    });
    Object.keys(renderMeta).forEach((k) => delete renderMeta[k]);
    Object.assign(renderMeta, data.image || {});
    await fetchPreview(data.image || {}, editPreviewUrl);
    await fetchPreview(data.image || {}, previewUrl);
  } catch (error) {
    clearPreviewRef(editPreviewUrl);
  } finally {
    editPreviewLoading.value = false;
  }
}

function scheduleEditPreview() {
  if (editPreviewTimer) {
    clearTimeout(editPreviewTimer);
    editPreviewTimer = null;
  }
  if (previewMode.value !== "edit") return;
  editPreviewTimer = setTimeout(() => {
    void renderEditPreview();
  }, 450);
}

onMounted(async () => {
  if (auth.token) {
    await loadAll();
    if (!templateDraft.id && !String(templateDraft.html || "").trim()) {
      newTemplate();
    }
    scheduleEditPreview();
  }
});

onBeforeUnmount(() => {
  if (editPreviewTimer) {
    clearTimeout(editPreviewTimer);
    editPreviewTimer = null;
  }
  clearPreviewRef(previewUrl);
  clearPreviewRef(editPreviewUrl);
});

watch(
  () => [deviceId.value, previewMode.value, configJson.value, templateDraft.id, templateDraft.name, templateDraft.html],
  () => {
    if (!templateDraft.id && !String(templateDraft.html || "").trim()) {
      templateDraft.html = defaultTemplateHtml();
    }
    scheduleEditPreview();
  }
);
</script>

<style scoped>
.homepage-studio {
  padding: 12px;
}
.card {
  max-width: 1680px;
  margin: 0 auto;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row.between {
  justify-content: space-between;
}
.row.wrap {
  flex-wrap: wrap;
}
.login-wrap {
  max-width: 420px;
}
.studio-grid {
  display: grid;
  gap: 12px;
}
.preview-meta {
  font-size: 12px;
  color: #64748b;
  display: grid;
  gap: 4px;
}
.preview-wrap {
  margin-top: 10px;
  border: 1px solid #dbe4ef;
  border-radius: 12px;
  min-height: 220px;
  display: flex;
  justify-content: center;
  align-items: center;
  overflow: auto;
  background: #fff;
}
.preview-img {
  max-width: 100%;
  display: block;
}
.preview-empty {
  color: #94a3b8;
}
</style>
