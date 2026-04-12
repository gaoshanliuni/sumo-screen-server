<template>
  <div class="page">
    <el-card class="panel">
      <template #header>
        <div class="header-row">
          <div>
            <strong>API 文档（Vue）</strong>
            <div class="sub">统一设备链路：login -> auto-register -> bind/status -> login -> stream</div>
          </div>
          <div class="actions">
            <el-button @click="goSimulator">设备模拟</el-button>
            <el-button @click="goAdmin">返回管理端</el-button>
          </div>
        </div>
      </template>

      <el-alert type="info" :closable="false" show-icon>
        <template #default>
          <div class="tips">
            <div><code>POST /api/hardware/simulate/register</code> 仅兼容保留，已弃用（deprecated）。</div>
            <div><code>POST /api/hardware/login</code> 返回 <code>404</code> 表示设备未注册，返回 <code>403</code> 表示设备未绑定或已封禁。</div>
            <div>模拟设备请走与真机一致流程，不再依赖快捷 auto-login / auto-bind。</div>
          </div>
        </template>
      </el-alert>

      <el-row :gutter="12" class="meta-grid">
        <el-col :md="12" :xs="24">
          <el-card shadow="never" class="meta-card">
            <template #header>最新设备能力</template>
            <ul class="meta-list">
              <li>主页/桌牌/天气：后端生成图片，设备显示并支持时间覆盖。</li>
              <li>远程事件：<code>remote.switch_view</code> / <code>remote.refresh_page_image</code> / <code>remote.request_screen_state</code>。</li>
              <li>投屏控制：<code>remote.show_text</code> / <code>remote.show_image</code> / <code>remote.cast_stop</code>。</li>
              <li>ACK 回传：<code>POST /api/hardware/remote/ack</code>。</li>
            </ul>
          </el-card>
        </el-col>
        <el-col :md="12" :xs="24">
          <el-card shadow="never" class="meta-card">
            <template #header>推荐联调顺序</template>
            <ol class="meta-list ordered">
              <li>登录 Swagger 并授权 Bearer token。</li>
              <li>执行设备注册/绑定相关接口，确认设备在线。</li>
              <li>触发 remote 事件并观察模拟器/真机 ACK。</li>
              <li>检查 homepage / badgepage / weatherpage 图像 payload。</li>
            </ol>
          </el-card>
        </el-col>
      </el-row>

      <div class="auth-line">
        <el-select v-model="loginForm.role" style="width: 150px">
          <el-option label="用户" value="user" />
          <el-option label="管理员" value="admin" />
        </el-select>
        <el-input v-model="loginForm.username" placeholder="用户名" autocomplete="username" style="width: 220px" />
        <el-input v-model="loginForm.password" placeholder="密码" show-password autocomplete="current-password" style="width: 220px" />
        <el-button type="primary" :loading="loginLoading" @click="loginAndAuthorize">登录并授权</el-button>
        <el-button @click="clearAuth">退出授权</el-button>
      </div>
      <div class="msg">{{ authMsg }}</div>

      <div id="swagger-ui" class="swagger-wrap" />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage } from "element-plus";

type AppRole = "user" | "admin";

const router = useRouter();
const loginLoading = ref(false);
const authMsg = ref("");
const loginForm = reactive<{ role: AppRole; username: string; password: string }>({
  role: "user",
  username: String(localStorage.getItem("vue_last_username") || localStorage.getItem("vue_username") || ""),
  password: "",
});

let swaggerUi: any = null;

function goAdmin() {
  router.push("/admin");
}

function goSimulator() {
  router.push("/simulator");
}

function appendSwaggerCss() {
  if (document.getElementById("swagger-ui-css")) return;
  const link = document.createElement("link");
  link.id = "swagger-ui-css";
  link.rel = "stylesheet";
  link.href = "https://unpkg.com/swagger-ui-dist@5/swagger-ui.css";
  document.head.appendChild(link);
}

function loadSwaggerScript() {
  return new Promise<void>((resolve, reject) => {
    const win = window as any;
    if (win.SwaggerUIBundle) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Swagger 脚本加载失败"));
    document.body.appendChild(script);
  });
}

async function initSwagger() {
  appendSwaggerCss();
  await loadSwaggerScript();
  const win = window as any;
  swaggerUi = win.SwaggerUIBundle({
    url: "/openapi.yaml",
    dom_id: "#swagger-ui",
    deepLinking: true,
    displayRequestDuration: true,
    persistAuthorization: true,
  });
}

async function loginAndAuthorize() {
  if (!loginForm.username.trim() || !loginForm.password) {
    ElMessage.error("请输入账号和密码");
    return;
  }
  loginLoading.value = true;
  try {
    const path = loginForm.role === "admin" ? "/api/auth/admin/login" : "/api/auth/user/login";
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: loginForm.username.trim(),
        password: loginForm.password,
      }),
    });
    const json = await res.json();
    if (!res.ok || !json?.data?.token) {
      throw new Error(json?.msg || "授权失败");
    }
    swaggerUi?.preauthorizeApiKey?.("BearerAuth", json.data.token);
    authMsg.value = "授权成功，可直接调试接口";
    ElMessage.success("授权成功");
  } catch (error) {
    authMsg.value = (error as Error).message || "授权失败";
    ElMessage.error(authMsg.value);
  } finally {
    loginLoading.value = false;
  }
}

function clearAuth() {
  swaggerUi?.authActions?.logout?.(["BearerAuth"]);
  authMsg.value = "已退出授权";
  ElMessage.info("已退出授权");
}

onMounted(async () => {
  try {
    await initSwagger();
  } catch (error) {
    authMsg.value = (error as Error).message || "文档初始化失败";
  }
});

onBeforeUnmount(() => {
  // Keep Swagger instance persistent in page cache, no explicit dispose needed.
});
</script>

<style scoped>
.page {
  padding: 16px;
}
.panel {
  max-width: 1280px;
  margin: 0 auto;
}
.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.sub {
  margin-top: 6px;
  color: #64748b;
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 8px;
}
.tips {
  display: grid;
  gap: 6px;
}
.meta-grid {
  margin-top: 12px;
}
.meta-card {
  border-radius: 12px;
}
.meta-list {
  margin: 0;
  padding-left: 18px;
  color: #334155;
  display: grid;
  gap: 6px;
  font-size: 13px;
}
.meta-list.ordered {
  padding-left: 22px;
}
.auth-line {
  margin-top: 12px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.msg {
  margin: 8px 0 10px;
  color: #475569;
  font-size: 13px;
  min-height: 20px;
}
.swagger-wrap {
  border: 1px solid #d9dee8;
  border-radius: 12px;
  overflow: hidden;
  background: #fff;
}
</style>
