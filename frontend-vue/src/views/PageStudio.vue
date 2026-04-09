<template>
  <div class="page-studio">
    <el-card class="card">
      <template #header>
        <div class="row between">
          <strong>Page Studio</strong>
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
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="Page Studio 已调整为 legacy / internal 调试入口，正式配置已迁移到主页面板。"
        />

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
            <div class="preview-canvas">
              <img v-if="editPreviewUrl" :src="editPreviewUrl" alt="edit preview" class="preview-img" />
              <div v-else class="preview-empty">{{ editPreviewLoading ? "编辑预览渲染中..." : "编辑模板后自动生成预览" }}</div>
              <div v-if="showTimeOverlayPreview" class="time-overlay-preview" :style="timeOverlayPreviewStyle">
                <SegmentTimePreview
                  :width="toPreviewNum(configModel?.time_overlay?.width, 0)"
                  :height="toPreviewNum(configModel?.time_overlay?.height, 0)"
                  :format="String(configModel?.time_overlay?.format || 'HH:mm')"
                  :font-size="toPreviewNum(configModel?.time_overlay?.font_size, 88)"
                  :align="timeOverlayAlign"
                  color="#111111"
                />
              </div>
            </div>
          </div>
          <template v-else>
            <div class="preview-meta">
              <div>etag: {{ renderMeta.etag || '-' }}</div>
              <div>image: {{ renderMeta.image_id || '-' }}</div>
              <div>size: {{ renderMeta.image_width || 0 }} x {{ renderMeta.image_height || 0 }}</div>
            </div>
            <div class="preview-wrap">
              <div class="preview-canvas">
                <img v-if="previewUrl" :src="previewUrl" alt="preview" class="preview-img" />
                <div v-else class="preview-empty">先执行一次渲染</div>
                <div v-if="showTimeOverlayPreview" class="time-overlay-preview" :style="timeOverlayPreviewStyle">
                  <SegmentTimePreview
                    :width="toPreviewNum(configModel?.time_overlay?.width, 0)"
                    :height="toPreviewNum(configModel?.time_overlay?.height, 0)"
                    :format="String(configModel?.time_overlay?.format || 'HH:mm')"
                    :font-size="toPreviewNum(configModel?.time_overlay?.font_size, 88)"
                    :align="timeOverlayAlign"
                    color="#111111"
                  />
                </div>
              </div>
            </div>
          </template>
        </el-card>

        <el-card>
          <template #header>
            <div class="row between">
              <strong>页面配置（Home / Badge / Weather）</strong>
              <div class="row">
                <el-select v-model="pageType" style="width: 170px" @change="loadAll">
                  <el-option label="Homepage" value="homepage" />
                  <el-option label="Badgepage" value="badgepage" />
                  <el-option label="Weatherpage" value="weatherpage" />
                </el-select>
                <el-button size="small" @click="loadAll">刷新</el-button>
              </div>
            </div>
          </template>
          <el-form label-width="125px" size="small">
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
            <el-form-item label="字号/间隔">
              <div class="row wrap">
                <el-input-number v-model="configModel.time_overlay.font_size" :min="12" :max="220" />
                <el-input-number v-model="configModel.time_overlay.refresh_interval_sec" :min="1" :max="3600" />
              </div>
            </el-form-item>
            <el-form-item v-if="pageType === 'weatherpage'" label="QWeather 资源">
              <div class="asset-note">
                <div>root: {{ qweatherAssets.root || '-' }}</div>
                <div>font: {{ qweatherAssets.font_ttf || '-' }}</div>
                <div>map: {{ qweatherAssets.icon_map_json || '-' }}</div>
                <div>svg_count: {{ qweatherAssets.icon_svg_count || 0 }}</div>
              </div>
            </el-form-item>
            <el-form-item label="JSON 高级配置">
              <el-input v-model="configJson" type="textarea" :rows="12" />
            </el-form-item>
          </el-form>
          <div class="row wrap">
            <el-button type="primary" @click="saveConfig">保存配置</el-button>
            <el-button @click="renderPage">仅渲染</el-button>
            <el-button type="success" @click="pushPage">渲染并推送</el-button>
          </div>
        </el-card>

        <el-card>
          <template #header>
            <div class="row between">
              <strong>模板编辑</strong>
              <el-button size="small" @click="newTemplate">新建模板</el-button>
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
              <el-input ref="templateHtmlInputRef" v-model="templateDraft.html" type="textarea" :rows="20" />
            </el-form-item>
          </el-form>
          <div class="row wrap">
            <el-button type="primary" @click="saveTemplate">保存模板</el-button>
            <el-button type="danger" :disabled="!templateDraft.id || templateDraft.builtin" @click="deleteTemplate">删除模板</el-button>
            <el-popover
              v-model:visible="insertVarVisible"
              placement="top-start"
              width="520"
              trigger="click"
              :teleported="false"
            >
              <div class="insert-var-box">
                <el-input v-model="insertVarKeyword" placeholder="搜索变量路径，例如 formatted.hitokoto" size="small" />
                <div class="insert-var-list">
                  <button
                    v-for="item in filteredTemplateVariables"
                    :key="item.path"
                    type="button"
                    class="insert-var-item"
                    @click="insertTemplateVariable(item.path)"
                  >
                    <span class="path">{{ item.placeholder }}</span>
                    <span class="example">{{ item.example || item.type }}</span>
                  </button>
                  <div v-if="!filteredTemplateVariables.length" class="insert-var-empty">当前设备暂无可用变量</div>
                </div>
              </div>
              <template #reference>
                <el-button @click="loadTemplateVariables">插入变量</el-button>
              </template>
            </el-popover>
          </div>
        </el-card>

        <el-card>
          <template #header><strong>远程界面控制（兼容 SSE/WS+ACK）</strong></template>
          <el-form label-width="130px" size="small">
            <el-form-item label="切换页面">
              <div class="row wrap">
                <el-select v-model="remoteView" style="width: 200px">
                  <el-option label="Home" value="home" />
                  <el-option label="Weather" value="weather" />
                  <el-option label="Badge" value="badge" />
                  <el-option label="TODO" value="todo" />
                  <el-option label="Settings" value="settings" />
                  <el-option label="Network" value="network" />
                  <el-option label="About" value="about" />
                </el-select>
                <el-button type="primary" @click="remoteSwitchView">remote.switch_view</el-button>
              </div>
            </el-form-item>
            <el-form-item label="刷新页面图片">
              <div class="row wrap">
                <el-select v-model="remoteRefreshPageType" style="width: 220px">
                  <el-option label="homepage" value="homepage" />
                  <el-option label="badgepage" value="badgepage" />
                  <el-option label="weatherpage" value="weatherpage" />
                </el-select>
                <el-button @click="remoteRefreshPageImage">remote.refresh_page_image</el-button>
              </div>
            </el-form-item>
            <el-form-item label="请求屏幕状态">
              <el-button @click="remoteRequestScreenState">remote.request_screen_state</el-button>
            </el-form-item>
          </el-form>
        </el-card>

      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import SegmentTimePreview from "../components/SegmentTimePreview.vue";
import { useAuthStore, type AppRole } from "../stores/auth";
import { apiRequest } from "../services/api";

type DeviceRow = {
  id: string;
  mac: string;
  displayName?: string;
  ownerId?: string;
};

type PageTemplateRow = {
  id: string;
  name: string;
  type: string;
  html: string;
  builtin?: boolean;
};

type TemplateVariableRow = {
  path: string;
  placeholder: string;
  type: string;
  example: string;
};

type PageType = "homepage" | "badgepage" | "weatherpage";

const auth = useAuthStore();
const role = ref<AppRole>("admin");
const loginLoading = ref(false);
const loginForm = reactive({ username: "admin", password: "admin123" });

const pageType = ref<PageType>("homepage");
const devices = ref<DeviceRow[]>([]);
const deviceId = ref("");
const templates = ref<PageTemplateRow[]>([]);
const templateVariables = ref<TemplateVariableRow[]>([]);
const insertVarVisible = ref(false);
const insertVarKeyword = ref("");
const templateHtmlInputRef = ref<any>(null);
const previewUrl = ref("");
const editPreviewUrl = ref("");
const editPreviewLoading = ref(false);
const renderMeta = reactive<Record<string, any>>({});
const qweatherAssets = reactive<Record<string, any>>({});
const previewMode = ref<"edit" | "delivery">("edit");
let editPreviewTimer: ReturnType<typeof setTimeout> | null = null;

const remoteView = ref("home");
const remoteRefreshPageType = ref("homepage");

const filteredTemplateVariables = computed(() => {
  const keyword = String(insertVarKeyword.value || "").trim().toLowerCase();
  if (!keyword) {
    return templateVariables.value.slice(0, 200);
  }
  return templateVariables.value
    .filter((item) => {
      return (
        String(item.path || "").toLowerCase().includes(keyword) ||
        String(item.example || "").toLowerCase().includes(keyword)
      );
    })
    .slice(0, 200);
});

function toPreviewNum(v: unknown, fallback: number) {
  const num = Number(v);
  return Number.isFinite(num) ? num : fallback;
}

const showTimeOverlayPreview = computed(() => {
  const overlay = configModel?.time_overlay || {};
  return Boolean(overlay.enabled) && toPreviewNum(overlay.width, 0) > 0 && toPreviewNum(overlay.height, 0) > 0;
});

const timeOverlayAlign = computed<"left" | "center" | "right">(() => {
  const align = String(configModel?.time_overlay?.align || "right").toLowerCase();
  if (align === "left" || align === "center" || align === "right") {
    return align;
  }
  return "right";
});

const timeOverlayPreviewStyle = computed(() => {
  const overlay = configModel?.time_overlay || {};
  const screen = configModel?.screen || {};
  const image = renderMeta || {};
  const sw = Math.max(1, toPreviewNum(screen.width, toPreviewNum(image.image_width, 2560)));
  const sh = Math.max(1, toPreviewNum(screen.height, toPreviewNum(image.image_height, 1600)));
  const x = Math.max(0, toPreviewNum(overlay.x, Math.max(0, sw - 680)));
  const y = Math.max(0, toPreviewNum(overlay.y, 80));
  const w = Math.max(1, toPreviewNum(overlay.width, 680));
  const h = Math.max(1, toPreviewNum(overlay.height, 180));
  const fontSize = Math.max(12, toPreviewNum(overlay.font_size, 88));
  const align = String(overlay.align || "right").toLowerCase();

  const style: Record<string, string> = {
    left: `${(x / sw) * 100}%`,
    top: `${(y / sh) * 100}%`,
    width: `${(w / sw) * 100}%`,
    height: `${(h / sh) * 100}%`,
    fontSize: `${Math.max(10, (fontSize / sh) * 100)}%`,
  };
  style.justifyContent = align === "left" ? "flex-start" : align === "center" ? "center" : "flex-end";
  return style;
});

const configModel = reactive<any>({
  template: { template_id: "tpl_home_default", render_engine: "auto" },
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

const templateDraft = reactive<PageTemplateRow>({
  id: "",
  name: "",
  type: "custom_html",
  html: "",
  builtin: false,
});

function defaultTemplateHtml(type: PageType) {
  const title = type === "homepage" ? "Homepage" : type === "badgepage" ? "Badgepage" : "Weatherpage";
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin:0; width:100%; height:100%; background:#fff; color:#111; font-family:"Noto Sans SC","Microsoft YaHei",sans-serif; }
    .wrap { padding:80px 100px; }
    h1 { margin:0; font-size:72px; line-height:1.2; }
    .line { margin-top:24px; font-size:42px; }
    .clock { position:absolute; top:72px; right:96px; font-size:64px; font-weight:700; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${title} / {{profile.name}}</h1>
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

function endpointBase() {
  if (pageType.value === "homepage") return "/api/homepages";
  if (pageType.value === "badgepage") return "/api/badgepages";
  return "/api/weatherpages";
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
  templates.value = await apiRequest<PageTemplateRow[]>(`${endpointBase()}/templates`, { token: auth.token });
  if (templateDraft.id) {
    const current = templates.value.find((item) => item.id === templateDraft.id);
    if (!current) {
      templateDraft.id = "";
      templateDraft.builtin = false;
    }
  }
}

async function loadQweatherAssetsIfNeeded() {
  Object.keys(qweatherAssets).forEach((k) => delete qweatherAssets[k]);
  if (pageType.value !== "weatherpage") return;
  const data = await apiRequest<Record<string, any>>(`${endpointBase()}/qweather-assets`, { token: auth.token });
  Object.assign(qweatherAssets, data || {});
}

async function loadTemplateVariables() {
  if (!deviceId.value) return;
  const data = await apiRequest<{ variables?: TemplateVariableRow[] }>(
    `${endpointBase()}/template-variables?deviceId=${encodeURIComponent(deviceId.value)}`,
    { token: auth.token }
  );
  templateVariables.value = Array.isArray(data?.variables) ? data.variables : [];
}

async function loadConfig() {
  if (!deviceId.value) return;
  const data = await apiRequest<any>(`${endpointBase()}/config?deviceId=${encodeURIComponent(deviceId.value)}`, { token: auth.token });
  applyConfigModel(data);
  Object.keys(renderMeta).forEach((k) => delete renderMeta[k]);
  Object.assign(renderMeta, data.image || {});
  await fetchPreview(data.image || {}, previewUrl);
  await loadTemplateVariables();
  scheduleEditPreview();
}

async function loadAll() {
  if (!auth.token) return;
  await loadDevices();
  await Promise.all([loadTemplates(), loadConfig(), loadQweatherAssetsIfNeeded()]);
  await loadTemplateVariables();
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
  await apiRequest(`${endpointBase()}/config`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deviceId: deviceId.value,
      config: patch,
    }),
  });
  ElMessage.success("页面配置已保存");
  await loadConfig();
}

async function renderPage() {
  if (!deviceId.value) return ElMessage.error("请先选择设备");
  const patch = buildConfigPatch();
  const data = await apiRequest<any>(`${endpointBase()}/render`, {
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
  await fetchPreview(data.image || {}, previewUrl);
  await fetchPreview(data.image || {}, editPreviewUrl);
  ElMessage.success("渲染完成");
}

async function pushPage() {
  if (!deviceId.value) return ElMessage.error("请先选择设备");
  const patch = buildConfigPatch();
  const result = await apiRequest<any>(`${endpointBase()}/push`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deviceId: deviceId.value,
      config: patch,
      template: buildTemplatePatchForRender(),
    }),
  });
  ElMessage.success(`推送结果：成功 ${result.successCount || 0}，失败 ${result.failedCount || 0}`);
  if (pageType.value === "badgepage" && (result.successCount || 0) > 0) {
    try {
      await ElMessageBox.confirm(
        "桌牌数据已下发，是否同步切换设备到桌牌模式（badge）？",
        "同步切换确认",
        {
          confirmButtonText: "切换到桌牌",
          cancelButtonText: "仅下发数据",
          type: "info",
        }
      );
      const sw = await apiRequest<any>("/api/remote/switch-view", {
        method: "POST",
        token: auth.token,
        body: JSON.stringify({ deviceId: deviceId.value, view: "badge", setAsDefault: false }),
      });
      ElMessage.success(`已切换桌牌模式，ACK成功 ${sw.ackedSuccessCount || 0}`);
    } catch {
      // user cancelled
    }
  }
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
  templateDraft.html = defaultTemplateHtml(pageType.value);
  scheduleEditPreview();
}

function insertTemplateVariable(path: string) {
  const variable = `{{${String(path || "").trim()}}}`;
  if (!path) return;

  const current = String(templateDraft.html || "");
  const textarea = templateHtmlInputRef.value?.textarea as HTMLTextAreaElement | undefined;
  if (textarea && typeof textarea.selectionStart === "number" && typeof textarea.selectionEnd === "number") {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    templateDraft.html = `${current.slice(0, start)}${variable}${current.slice(end)}`;
    nextTick(() => {
      const pos = start + variable.length;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
    });
  } else {
    const sep = current.endsWith("\n") || current.length === 0 ? "" : "\n";
    templateDraft.html = `${current}${sep}${variable}`;
  }
  insertVarVisible.value = false;
  scheduleEditPreview();
}

async function saveTemplate() {
  if (!templateDraft.name.trim() || !templateDraft.html.trim()) {
    return ElMessage.error("模板名称和 HTML 不能为空");
  }
  const row = await apiRequest<any>(`${endpointBase()}/templates`, {
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
  await apiRequest(`${endpointBase()}/templates/${templateDraft.id}/delete`, {
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

async function remoteSwitchView() {
  if (!deviceId.value) return ElMessage.error("请先选择设备");
  const data = await apiRequest<any>("/api/remote/switch-view", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ deviceId: deviceId.value, view: remoteView.value, setAsDefault: false }),
  });
  ElMessage.success(`switch_view 已下发，ACK成功 ${data.ackedSuccessCount || 0}`);
}

async function remoteRefreshPageImage() {
  if (!deviceId.value) return ElMessage.error("请先选择设备");
  const data = await apiRequest<any>("/api/remote/refresh-page-image", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ deviceId: deviceId.value, pageType: remoteRefreshPageType.value }),
  });
  ElMessage.success(`refresh_page_image 已下发，ACK成功 ${data.ackedSuccessCount || 0}`);
}

async function remoteRequestScreenState() {
  if (!deviceId.value) return ElMessage.error("请先选择设备");
  const data = await apiRequest<any>("/api/remote/request-screen-state", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ deviceId: deviceId.value, include: ["page", "overlay", "network", "version"] }),
  });
  ElMessage.success(`request_screen_state 已下发，ACK成功 ${data.ackedSuccessCount || 0}`);
}

function buildTemplatePatchForRender() {
  const html = String(templateDraft.html || "").trim();
  if (!html) return undefined;
  return {
    id: templateDraft.id || configModel?.template?.template_id || `tpl_${pageType.value}_default`,
    name: String(templateDraft.name || "").trim() || `${pageType.value} template`,
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
    const data = await apiRequest<any>(`${endpointBase()}/render`, {
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
  } catch (_) {
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
  () => [
    auth.token,
    pageType.value,
    deviceId.value,
    previewMode.value,
    configJson.value,
    templateDraft.id,
    templateDraft.name,
    templateDraft.html,
  ],
  () => {
    if (!templateDraft.id && !String(templateDraft.html || "").trim()) {
      templateDraft.html = defaultTemplateHtml(pageType.value);
    }
    scheduleEditPreview();
  }
);
</script>

<style scoped>
.page-studio {
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
.preview-canvas {
  position: relative;
  width: fit-content;
  max-width: 100%;
}
.preview-img {
  max-width: 100%;
  display: block;
}
.preview-empty {
  color: #94a3b8;
}
.time-overlay-preview {
  position: absolute;
  border: 2px dashed #ef4444;
  background: rgba(254, 242, 242, 0.7);
  color: #111827;
  display: flex;
  align-items: center;
  padding: 4px 8px;
  box-sizing: border-box;
  pointer-events: none;
  overflow: hidden;
}
.asset-note {
  font-size: 12px;
  line-height: 1.5;
  color: #334155;
}
.insert-var-box {
  display: grid;
  gap: 8px;
}
.insert-var-list {
  max-height: 280px;
  overflow: auto;
  display: grid;
  gap: 6px;
}
.insert-var-item {
  border: 1px solid #dbe4ef;
  background: #ffffff;
  border-radius: 8px;
  padding: 8px 10px;
  text-align: left;
  display: grid;
  gap: 4px;
  cursor: pointer;
}
.insert-var-item:hover {
  border-color: #409eff;
  background: #f0f7ff;
}
.insert-var-item .path {
  font-family: "Consolas", "Courier New", monospace;
  font-size: 12px;
  color: #0f172a;
}
.insert-var-item .example {
  font-size: 12px;
  color: #64748b;
}
.insert-var-empty {
  color: #94a3b8;
  font-size: 12px;
  padding: 6px 2px;
}
</style>
