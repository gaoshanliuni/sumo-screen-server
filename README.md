# 智能墨水屏平台（Node.js + Vue）

## 项目简介
本仓库是智能墨水屏平台的后端与 Web 端工程，包含：
- `backend`：Node.js/Express API、设备实时通道、页面渲染、课程表同步（喜鹊）等服务。
- `frontend-vue`：Vue3 + Element Plus 源码。
- `frontend`：后端直接托管的静态入口与已构建 Vue 产物（`/vue-app`）。

## 当前进度（按代码现状）

### 已实现
- 用户/管理端/设备模拟/API 文档统一为 Vue 入口（`/vue-app/#/...`）。
- 设备主链路：`auto-register -> bind/status -> hardware/login -> SSE/WS`。
- 页面图片化：`homepage / badgepage / weatherpage` 三套配置、模板、渲染、推送。
- 模板渲染支持变量插值、内联脚本、`legacy/web/hybrid` 渲染模式兼容。
- 远程控制：切页、图片刷新、请求屏幕状态、投屏、ACK 上报。
- 喜鹊课程表：
  - 手动导入；
  - 自动更新（10/30/60 分钟）；
  - 执行窗口 `06:00-24:00`，`00:00-06:00` 暂停；
  - OCR 自动识别验证码（失败回退手动验证码）。
- 第三方 API 模板含 `xique_schedule`，返回标准化课程表结构与今日视图文本。
- `backend/start.sh` 已支持 Linux/容器首次自举（Python venv + OCR 依赖 + Playwright Chromium + 缺失系统库）。

### 待完善 / 注意事项
- OpenAPI 已覆盖大部分接口，但个别新增细分路径（如部分喜鹊流程扩展字段）可能存在同步滞后，请以 `backend/src/routes` 为最终准。
- 历史 `*.legacy.html` 仅保留兼容，不再作为主维护入口。

## 目录结构
```text
.
├─ backend/               # 后端服务
│  ├─ openapi/            # OpenAPI 文档
│  ├─ src/
│  │  ├─ routes/          # 路由层
│  │  ├─ services/        # 业务服务（渲染、喜鹊同步、OCR、页面配置）
│  │  └─ db/              # MySQL 状态读写
│  ├─ tools/ocr/          # ddddocr 脚本与依赖清单
│  └─ start.sh            # 生产启动脚本（自举安装）
├─ frontend-vue/          # Vue 源码（Vite）
├─ frontend/              # 后端托管静态目录（含 /vue-app 构建产物）
├─ ico/QWeather-Icons-1.8.0/
└─ README.md
```

## 启动与部署

### 本地开发
1. 后端
```bash
cd backend
npm install
npm run start
```

2. 前端源码调试
```bash
cd frontend-vue
npm install
npm run dev
```

3. 构建前端到后端托管目录
```bash
cd frontend-vue
npm run build
```
说明：Vite `outDir` 已配置为 `../frontend/vue-app`。

### Linux / 1Panel（Node 应用模式）
```bash
bash /app/backend/start.sh
```
`backend/start.sh` 行为：
- 首次启动安装系统依赖（含 Chromium 运行库与中文字体）；
- 自动创建 `.venv` 并安装 `tools/ocr/requirements.txt`；
- 自动下载 Chromium 到 `/app/backend/.local-browser`；
- 导出 OCR 与浏览器渲染环境变量后启动 `npm run start`；
- 后续启动复用本地缓存，不重复全量下载。

根目录 `start.sh` 会自动转发到 `backend/start.sh`。

## 环境变量（核心）

### 基础
- `PORT`：后端端口（默认 `8890`）
- `PUBLIC_ORIGIN`：对外域名（例如 `https://example.com`）
- `TRUST_PROXY`：是否信任反代头（默认 `1`）
- `FORCE_HTTPS`：是否强制 HTTP->HTTPS（默认 `0`）
- `HSTS_MAX_AGE_SEC`：HSTS 秒数（默认 `31536000`）
- `JWT_SECRET`：JWT 密钥

### 数据库与存储
- `MONGO_URI`：MongoDB（GridFS 文件存储）
- `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_STATE_TABLE`：MySQL 配置

### 喜鹊同步 / OCR
- `XIQUE_OCR_ENABLED`（默认 `1`）
- `XIQUE_OCR_PYTHON_BIN`
- `XIQUE_OCR_AUTO_SETUP`
- `XIQUE_OCR_TIMEOUT_MS`
- `XIQUE_OCR_MAX_FAILURES_BEFORE_MANUAL`（默认 `2`）
- `XIQUE_SCHEDULER_INTERVAL_MS`
- `XIQUE_SESSION_TTL_MS`
- `XIQUE_CAPTCHA_TTL_MS`

### 页面渲染
- `PLAYWRIGHT_CHROMIUM_PATH` / `CHROME_PATH` / `CHROME_BIN`
- `PAGE_RENDER_BROWSER_STRICT`
- `PAGE_RENDER_BROWSER_LAUNCH_TIMEOUT_MS`
- `PAGE_RENDER_BROWSER_TOTAL_TIMEOUT_MS`

## 访问入口
- 平台首页：`/`
- 用户端：`/user.html`（跳转 `/vue-app/#/user`）
- 管理端：`/admin.html`（跳转 `/vue-app/#/admin`）
- 设备模拟：`/simulator.html`（跳转 `/vue-app/#/simulator`）
- API 文档：`/docs.html`（跳转 `/vue-app/#/docs`）
- OpenAPI：`/openapi.yaml`

## 默认账号（仅开发）
- 管理员：`admin / admin@0607`
- 用户：`demo / uesr@123`

上线前请立即修改默认口令。

## 主要接口分组（当前版本）

### 认证与设备
- `/api/auth/*`
- `/api/devices/*`
- `/api/hardware/*`
- `/ws/hardware`

### 页面图片化（主页/桌牌/天气）
- `/api/homepages/*`
- `/api/badgepages/*`
- `/api/weatherpages/*`
- 模板变量辅助：`/api/{page}/template-variables`

### 课程表（含喜鹊）
- 常规课表：`/api/schedules/*`
- 喜鹊状态与配置：`/api/schedules/xique/status`、`/api/schedules/xique/config`
- 喜鹊登录与导入：
  - `/api/schedules/xique/init-login`
  - `/api/schedules/xique/import`
  - `/api/schedules/xique/import/start`
  - `/api/schedules/xique/import/verify-captcha`
  - `/api/schedules/xique/reverify`

### 远程控制
- `/api/remote/switch-view`
- `/api/remote/refresh-page-image`
- `/api/remote/request-screen-state`
- `/api/remote/show-text`
- `/api/remote/show-image`
- `/api/remote/cast-frame`
- `/api/remote/cast-stop`

### 其它
- `/api/todos/*`
- `/api/templates/*`
- `/api/third/{slug}`
- `/api/tf/*`
- `/api/firmware/*`
- `/api/logs/*`

## 课程表（喜鹊）当前行为
- 导入与自动更新共用同一套后端流程；
- 自动更新按设备独立配置频率（10/30/60）；
- 调度仅在 `06:00-24:00` 执行；
- 验证码优先 OCR，连续失败后回退手动输入；
- 导入策略为“当前 term 的 `source=xique` 记录覆盖更新，保留手工课程”；
- `xique_schedule` 模板返回：
  - `formatted.schedule.byDay[].courses[]`
  - `formatted.view.todayCourseText` 等可直接渲染字段。

## 页面渲染机制（当前）
- 优先浏览器渲染（Playwright Chromium）；
- 浏览器不可用时回退 legacy 渲染路径；
- `template.render_mode` 支持 `legacy/web/hybrid`；
- 支持旧模板 `data-x/data-y/data-size/...` 与标准 HTML/CSS 混用。

## QWeather 资源
- 资源目录：`ico/QWeather-Icons-1.8.0`
- 天气页面渲染会读取字体/CSS/SVG 映射；
- 设备端只消费后端生成图片，不做天气图标排版。

## 常见问题
- `MONGO_URI 未配置`：文件上传与 GridFS 相关功能不可用。
- `browser render failed`：优先检查 `backend/start.sh` 是否执行、容器是否有 Chromium 运行库。
- `xique-ocr ready=false`：检查 Python venv、`tools/ocr/requirements.txt` 安装状态。
- `401/403`：确认 Token 与角色权限。
