# 智能墨水屏平台（Node.js + Vue）

## 项目简介
本仓库是智能墨水屏平台的后端与 Web 端工程，包含：
- `backend`：Node.js/Express API、设备实时通道、页面渲染、固件库、课程表同步（喜鹊）等服务。
- `frontend-vue`：Vue3 + Element Plus 源码。
- `frontend`：后端直接托管的静态入口与已构建 Vue 产物（`/vue-app`）。
- `scripts`：新电脑环境复现与维护脚本。

## 当前进度（按代码现状）

### 已实现
- 用户/管理端/设备模拟/API 文档统一为 Vue 入口（`/vue-app/#/...`）。
- 设备主链路：`auto-register -> bind/status -> hardware/login -> SSE/WS`。
- 设备管理：设备种类、分辨率字段、设备种类默认分辨率、预览按设备分辨率等比缩放。
- 页面图片化：`homepage / badgepage / weatherpage` 三套配置、模板、渲染、推送。
- 模板渲染支持变量插值、内联脚本、`legacy/web/hybrid` 渲染模式兼容。
- API 模板自动刷新：前端配置刷新周期，后端调度执行。
- 远程控制：切页、图片刷新、请求屏幕状态、投屏、ACK 上报。
- 后端连接地址切换：管理界面下发 `remote.update_backend_url`，设备保存后重启生效。
- 固件管理：
  - 固件库支持标签（如 `正式版`、`测试版`、`公网版`、`内网版`）；
  - 支持上传固件文件；
  - 支持内嵌 ESP Launchpad/Web Serial 方式直接连接电脑 USB 设备刷入；
  - 支持从固件库、URL 或本地一次性文件选择刷入来源。
- 喜鹊课程表：
  - 手动导入；
  - 自动更新（10/30/60 分钟）；
  - 执行窗口 `06:00-24:00`，`00:00-06:00` 暂停；
  - OCR 自动识别验证码（失败回退手动验证码）。
- 第三方 API 模板含 `xique_schedule`，返回标准化课程表结构与今日视图文本。
- `backend/start.sh` 已支持 Linux/容器首次自举（Python venv + OCR 依赖 + Playwright Chromium + 缺失系统库）。
- Windows 新电脑可用 `scripts/setup_windows_workspace.ps1` 复现 Node/Python/PlatformIO/Playwright/OCR 基础环境。

### 待完善 / 注意事项
- OpenAPI 已覆盖大部分接口，但个别新增细分路径（如部分喜鹊流程扩展字段）可能存在同步滞后，请以 `backend/src/routes` 为最终准。
- 历史 `*.legacy.html` 仅保留兼容，不再作为主维护入口。
- 端口联调约定固定为 `8890`。如果本机端口被占用，请先释放端口，不建议用临时备用端口继续硬件联调。
- ESP Launchpad 依赖浏览器 Web Serial 能力，推荐 Chrome/Edge，并需要使用数据线连接 ESP32-S3。

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
├─ scripts/               # Windows 环境复现脚本
├─ ico/QWeather-Icons-1.8.0/
└─ README.md
```

## 启动与部署

### Windows / 新电脑一键复现环境
在 PowerShell 中执行：

```powershell
cd D:\dachicunhouduan
powershell -ExecutionPolicy Bypass -File .\scripts\setup_windows_workspace.ps1
```

脚本会检查或安装：
- Git
- Node.js LTS
- Python 3.11
- PlatformIO
- Playwright Chromium
- 喜鹊 OCR Python 依赖
- 固件工程所需的 PlatformIO / ESP-IDF 4.4.7 工具链（通过 `espressif32@6.5.0` 自动拉取）

只预览不安装：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup_windows_workspace.ps1 -DryRun
```

如果固件仓库不在默认路径 `D:\idfchonggouepd`，可指定：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup_windows_workspace.ps1 -FirmwareRoot "D:\your\idfchonggouepd"
```

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
- 默认启用 `ASR_AUTO_SETUP=1`，未配置云 ASR 时会在后台安装 `tools/asr/requirements.txt`，后端不会等待 faster-whisper 下载完成才对外提供服务；
- 自动下载 Chromium 到 `/app/backend/.local-browser`；
- 导出 OCR 与浏览器渲染环境变量后启动 `npm run start`；
- 后续启动复用本地缓存，不重复全量下载。

根目录 `start.sh` 会自动转发到 `backend/start.sh`。

## 环境变量（核心）

### 基础
- `PORT`：后端端口（当前硬件联调固定使用 `8890`）
- `PORT_FALLBACK_ENABLED`：端口占用时是否尝试备用端口，默认 `0`（严格监听 `PORT`）；仅在无需固定设备地址的场景设为 `1`
- `LISTEN_HOST`：后端监听地址；Windows 默认 `127.0.0.1`，Linux/容器默认 `0.0.0.0`
- 如果 `8890` 被占用，请优先停止占用进程后再启动，避免设备端仍连向旧地址
- `PUBLIC_ORIGIN`：对外域名（例如 `https://example.com`）
- `TRUST_PROXY`：是否信任反代头（默认 `1`）
- `FORCE_HTTPS`：是否强制 HTTP->HTTPS（默认 `0`）
- `HSTS_MAX_AGE_SEC`：HSTS 秒数（默认 `31536000`）
- `JWT_SECRET`：JWT 密钥
- `SHUTDOWN_GRACE_MS`：优雅关闭等待活动连接的最长时间，默认 `10000`

### 数据库与存储
- `MONGO_URI`：MongoDB（GridFS 文件存储）
- `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_STATE_TABLE`：MySQL 配置
- `DB_POOL_SIZE`：MySQL pool 最大连接数，默认 `32`
- `DB_CONNECT_TIMEOUT_MS` / `DB_OP_TIMEOUT_MS`：MySQL 连接与操作超时

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
- `PAGE_RENDER_BROWSER_MAX_CONCURRENT`：全局 Browser render 并发上限，默认 `2`
- `PAGE_RENDER_BROWSER_IDLE_CLOSE_MS`：空闲 Browser 自动关闭时间
- `PAGE_RENDER_BROWSER_LAUNCH_TIMEOUT_MS`
- `PAGE_RENDER_BROWSER_TOTAL_TIMEOUT_MS`

### Realtime / WebSocket
- `REALTIME_HISTORY_LIMIT`：每台设备保留的实时事件数量，默认 `200`
- `REALTIME_HISTORY_TTL_MS`：实时事件保留时间，默认 `6` 小时
- `REALTIME_PRESENCE_RETENTION_MS`：离线 presence 保留时间，默认 `1` 小时
- `REALTIME_MAX_TRACKED_DEVICES`：最多跟踪的设备数，默认 `10000`
- `REALTIME_SWEEP_INTERVAL_MS`：过期状态清理周期，默认 `5` 分钟
- `WS_MAX_PAYLOAD_BYTES`：单条 WebSocket 消息上限，默认 `1 MiB`
- `WS_MAX_BUFFERED_BYTES`：单连接发送缓冲上限，默认 `2 MiB`
- `WS_HEARTBEAT_INTERVAL_MS`：心跳周期，默认 `30000`

### 小程序语音指令 / ASR
- `ASR_AUTO_SETUP`：Linux/1Panel 启动脚本默认 `1`。未配置 Azure 或自定义命令时，会自动安装本地 faster-whisper 依赖。
- `ASR_SETUP_MODE`：默认 `background`，后台安装 ASR 依赖并立即启动后端；如需启动时等待安装完成可设为 `foreground`；如需完全跳过可设为 `skip` 或设置 `ASR_AUTO_SETUP=0`。
- `ASR_PROVIDER`：可选 `faster_whisper`、`azure_speech`、`command`。默认优先按已配置项自动设置。
- 本地 faster-whisper：
  - `FASTER_WHISPER_MODEL`：默认 `small`。服务器性能较弱可改为 `base` 或 `tiny`。
  - `FASTER_WHISPER_LANGUAGE`：默认 `zh`。
  - `FASTER_WHISPER_COMMAND`：默认由 `start.sh` 设置为 `/app/backend/.venv/bin/python`。
  - `FASTER_WHISPER_ARGS`：默认调用 `tools/asr/faster_whisper_cli.py`。
  - `HF_HOME`：默认 `/app/backend/runtime/huggingface`，首次识别会下载并缓存模型。
- Azure Speech：
  - `AZURE_SPEECH_KEY`
  - `AZURE_SPEECH_REGION` 或 `AZURE_SPEECH_ENDPOINT`
  - `AZURE_SPEECH_LANGUAGE`（默认 `zh-CN`）
- 自定义命令：
  - `ASR_PROVIDER=command`
  - `ASR_COMMAND=/path/to/your/asr-wrapper`
- 运行状态诊断：登录后请求 `/api/ai/asr/status`，可查看当前 ASR 是否配置完成。

## 访问入口
- 平台首页：`/`
- 用户端：`/user.html`（跳转 `/vue-app/#/user`）
- 管理端：`/admin.html`（跳转 `/vue-app/#/admin`）
- 设备模拟：`/simulator.html`（跳转 `/vue-app/#/simulator`）
- API 文档：`/docs.html`（跳转 `/vue-app/#/docs`）
- OpenAPI：`/openapi.yaml`
- Liveness：`/api/health/live`（进程存活即返回 `200`）
- Readiness：`/api/health/ready`（Store 未初始化或 optimistic persistence 持续失败时返回 `503`）

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

### Dashboard 与运行状态
- `/api/dashboard/overview`：一次返回当前账号可见的设备、在线状态、TODO、课表及固件统计
- `/api/health/live`：供进程级存活探针使用
- `/api/health/ready`：供流量接入探针使用，并报告 Store persistence、Scheduler 与 Realtime runtime

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
- 管理界面可通过远程命令下发 `remote.update_backend_url`，设备保存后重启并连接新地址。

### 固件 / 设备类型 / 在线刷入
- `/api/firmware/*`
- `/api/firmware-flash/*`
- `/api/device-types/*`
- 前端固件管理页内嵌 ESP Launchpad，不跳转官方页面；刷入状态显示待开始、刷入中、成功、失败。

### API 模板自动刷新
- `/api/templates/*`
- 每个 API 模板的刷新时间由前端配置，后端调度执行。

### 其它
- `/api/todos/*`
- `/api/third/{slug}`
- `/api/tf/*`
- `/api/logs/*`
- `/api/system-upgrade/*`

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
- 后端不是 `8890`：硬件默认连接地址按 `8890` 联调。请停止占用端口的旧进程，重新启动后端，不要让后端自动落到 `8891`。
- 公网图片或固件提示 `image not available`：先确认正式地址使用 `https://epd.gaoshanliuni.top:19999`，并检查反向代理是否允许对应静态/下载路径。
- ESP Launchpad 显示“无兼容设备”：确认浏览器为 Chrome/Edge、页面在 HTTPS 或 localhost 下打开、USB 线支持数据传输，并在系统设备管理器中确认 ESP32-S3 串口枚举正常。
- 固件区分正式/测试：固件库使用标签区分，常用标签为 `正式版`、`测试版`、`公网版`、`内网版`。
- 新电脑缺环境：先运行 `scripts/setup_windows_workspace.ps1 -DryRun` 看将执行的动作，再不带 `-DryRun` 安装。
- 小程序语音上传成功但没有识别文字：请求 `/api/ai/asr/status` 检查 ASR 状态。Linux 正式环境默认会走本地 faster-whisper；首次识别需要下载模型，耗时较长，建议确认服务器能访问 Hugging Face 或提前缓存模型到 `HF_HOME`。
