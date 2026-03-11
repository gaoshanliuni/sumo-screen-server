# 智能墨水屏平台（Node.js 全栈）

## 项目简介
面向智能墨水屏的全生命周期管理平台，支持用户端与管理端权限隔离、设备注册鉴权、固件升级、TODO/课程表、第三方 API 模板、TF 卡文件管理、设备模拟与实时通道（SSE/WS）。

## 功能概览
- 用户端：PIN 绑定设备、TODO/课程表表格化管理、固件升级、第三方 API 测试、TF 卡管理、投屏与远程控制。
- 管理端：账号与设备全量管理、模板与批量 Key 下发、固件上传与批量升级、日志查询。
- 模拟端：自动注册 + PIN 绑定、SSE/WS 实时事件、模拟 TF 本地文件上报、投屏预览。

## 启动
```bash
cd backend
npm install
npm run start
```

如果看到 `MONGO_URI 未配置`，说明未加载 MongoDB 连接串。项目已使用 `dotenv`，默认读取 `backend/.env`。

## 环境变量
- `PORT`：服务端口（默认 8890）
- `MONGO_URI`：MongoDB 连接串（必填，用于 GridFS 存储文件）
- `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_STATE_TABLE`：MySQL 连接参数

当前默认 MongoDB：
```
MONGO_URI=mongodb://mongo_tkKafE:mongo_5tNAQx@gaoshanliuni.top:27017/smp?authSource=admin
```

## 访问入口
- 首页：`http://localhost:8890/`
- 用户端：`http://localhost:8890/user.html`
- 管理端：`http://localhost:8890/admin.html`
- 设备模拟：`http://localhost:8890/simulator.html`
- 接口文档页：`http://localhost:8890/docs.html`
- OpenAPI 文件：`http://localhost:8890/openapi.yaml`
- 健康检查：`http://localhost:8890/api/health`

## PIN 绑定流程
1. 设备自动注册：`POST /api/hardware/auto-register`，返回 PIN 与 `bootstrapToken`。
2. 用户/管理员输入 PIN 绑定：`POST /api/devices/bind-pin`。
3. 设备轮询绑定状态：`GET /api/hardware/bind/status?bootstrapToken=...`，绑定后获取设备 token。

## 实时通道
- SSE：`/api/hardware/stream/sse?deviceId=...&token=...`
- WS：`/ws/hardware?deviceId=...&token=...`

## 默认账号
- 管理员：`admin / admin123`
- 普通用户：`demo / user123`

## 数据库与存储
- MySQL：业务数据持久化，默认连接配置见 `backend/src/config.js`。
- MongoDB GridFS：TF 卡文件、固件文件、远程控制文件均存储在 GridFS 中。

## 鉴权说明
除 `auto-register / bind/status / hardware/login` 外，其余接口均需 `Authorization: Bearer <JWT>`。

## API 目录（GET/POST）
### 认证
- `POST /api/auth/user/login`
- `POST /api/auth/admin/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `POST /api/auth/change-password`

### 管理端
- `GET /api/admin/dashboard`
- `GET /api/admin/users`
- `POST /api/admin/users`
- `POST /api/admin/users/{userId}`
- `POST /api/admin/users/{userId}/resources`
- `POST /api/admin/users/{userId}/delete`

### 设备
- `GET /api/devices`（支持 `status/mac/ownerId/simulated/bound`）
- `POST /api/devices/register`
- `POST /api/devices/bind-pin`
- `GET /api/devices/{deviceId}`
- `POST /api/devices/{deviceId}`
- `POST /api/devices/{deviceId}/delete`
- `GET /api/devices/{deviceId}/keys`
- `POST /api/devices/{deviceId}/keys`
- `POST /api/devices/batch/config`

### 硬件
- `POST /api/hardware/auto-register`
- `GET /api/hardware/bind/status`
- `POST /api/hardware/login`
- `GET /api/hardware/config`
- `GET /api/hardware/stream/sse`
- `POST /api/hardware/simulate/register`
- `POST /api/hardware/tf/report`

### 集群
- `GET /api/clusters`
- `POST /api/clusters`
- `POST /api/clusters/{clusterId}`
- `POST /api/clusters/{clusterId}/devices`
- `POST /api/clusters/{clusterId}/delete`

### 模板
- `GET /api/templates`
- `POST /api/templates`
- `POST /api/templates/{templateId}`
- `POST /api/templates/{templateId}/delete`
- `GET /api/templates/device/{deviceId}/keys`
- `POST /api/templates/device/{deviceId}/keys`

### 第三方 API
- `POST /api/third/{slug}`

### TODO
- `GET /api/todos`
- `POST /api/todos`
- `POST /api/todos/{todoId}`
- `POST /api/todos/{todoId}/delete`
- `POST /api/todos/batch-upsert`
- `POST /api/todos/batch-delete`

### 课程表
- `GET /api/schedules`
- `POST /api/schedules`
- `POST /api/schedules/{scheduleId}`
- `POST /api/schedules/{scheduleId}/delete`
- `POST /api/schedules/batch-upsert`
- `POST /api/schedules/batch-delete`

### 固件
- `GET /api/firmware`
- `POST /api/firmware`
- `POST /api/firmware/upload`
- `GET /api/firmware/{firmwareId}/download`
- `POST /api/firmware/upgrade`
- `GET /api/firmware/upgrades`
- `POST /api/firmware/batch-upgrade`
- `POST /api/firmware/upgrades/{jobId}/run`
- `POST /api/firmware/{firmwareId}/delete`

### TF 卡
- `GET /api/tf`
- `GET /api/tf/device/{deviceId}`
- `GET /api/tf/device?deviceId=...`（兼容）
- `POST /api/tf/upload`
- `GET /api/tf/{fileId}/download`
- `POST /api/tf/{fileId}/delete`
- `GET /api/tf/device/{deviceId}/download`
- `POST /api/tf/device/{deviceId}/delete`

### 远程控制
- `POST /api/remote/switch-view`
- `POST /api/remote/show-text`
- `POST /api/remote/show-image`
- `POST /api/remote/cast-frame`

### 日志
- `GET /api/logs/operations`
- `GET /api/logs/apis`

## 用户手册
### 用户端（/user.html）
1. 登录：输入账号密码后进入功能区，左侧导航切换模块。
2. 绑定设备：在“设备绑定”输入设备 PIN 码并绑定，成功后“当前设备”会显示设备信息。
3. 选择设备：点击侧栏“选择设备”弹窗切换当前设备。
4. TODO/课程表：进入模块后点击“加载数据”，表格内编辑后点击“批量保存”。
5. 固件升级：选择固件版本，可选定时升级时间，点击“触发升级”。
6. 第三方 API：选择模板、填写参数 JSON，点击“调用 API”查看返回。
7. TF 卡：上传文件、刷新云端/本地文件，支持下载与删除。
8. 投屏与远程控制：上传图片投屏、屏幕投射、切换设备界面、临时文字显示。

### 管理端（/admin.html）
1. 登录后进入“主页概览”查看设备、账号、固件、API 统计。
2. 账号管理：创建/更新/封禁/删除账号，支持资源处理（解绑/迁移/清理）。
3. 设备与 PIN：选择设备后可更新设备字段、删除设备、管理员 PIN 绑定。
4. 模板管理：新增/编辑/删除模板；单设备 Key 编辑与批量下发。
5. 固件管理：上传固件文件，创建版本；批量升级支持定时。
6. TODO/课程表：管理员可按设备查看与批量保存。
7. TF 卡：查看云端与设备本地文件，支持下载与删除。
8. 投屏与远程控制：同用户端，支持管理员控制任意设备。

### 设备模拟（/simulator.html）
1. 登录后点击“启动模拟设备”自动注册并获取 PIN。
2. 在用户端或管理端输入 PIN 绑定设备。
3. 模拟端轮询成功后会自动建立 WS/SSE 连接并显示实时事件。
4. “模拟内存卡”可添加本地文件并上报清单，用于对比“待下发/已下发”。
5. “当前设备快照”展示设备信息、密钥、TODO、课程、升级任务与硬件配置。

### 文档页（/docs.html）
1. 选择角色，输入账号密码后点击“登录并授权”。
2. Swagger UI 中可直接调试已授权接口。

### 操作输出面板
1. 所有界面右下角“操作输出”为浮窗，可拖动、可收起、可调整大小。
2. 每个操作会同时在输出面板与右上角提示框显示结果。

### 常见问题
1. `MONGO_URI 未配置`：检查 `backend/.env` 是否存在并包含正确的连接串。
2. `401` 或 `403`：确认已登录并携带 `Authorization: Bearer <JWT>`。
3. 设备不可见：用户端只能看到自己绑定的设备，管理员可看到全量设备。
