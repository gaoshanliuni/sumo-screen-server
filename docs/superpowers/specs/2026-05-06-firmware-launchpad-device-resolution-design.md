# IDF 在线刷机与设备分辨率管理设计

## 背景

当前智能墨水屏平台已有：

- 后端 `backend/src/routes/firmware.routes.js`：固件上传、固件列表、OTA 升级任务与固件下载。
- 后端 `backend/src/routes/device.routes.js`：设备列表、注册、编辑、删除与批量删除。
- 后端 `backend/src/db/store.js`：MySQL 多表状态持久化，设备和固件主要字段保存到结构列，完整对象保存到 `payload_json`。
- 前端 `frontend-vue/src/views/DashboardCore.vue`：管理端核心页面，包含固件管理、设备/PIN、设备框选、主页预览和图片投屏预览。
- 前端 `frontend-vue/src/views/PageStudio.vue`：主页、桌牌、天气页面的编辑预览与下发预览。
- 前端 `frontend-vue/src/components/DeviceLassoPicker.vue` 与 `frontend-vue/src/stores/devices.ts`：设备展示、筛选和选择。

本次新增两类能力：

1. 在“固件管理”中集成 IDF 在线刷入固件功能，使用 Espressif ESP Launchpad/Web Serial 在浏览器侧执行刷机。
2. 新增设备种类与分辨率管理，并让渲染预览、主页预览和图片投屏预览按目标设备分辨率等比缩放。

参考来源：Espressif `esp-launchpad` 是可配置的浏览器固件刷写工具，可通过配置文件指向固件镜像并通过 USB serial 刷写 ESP32 设备。官方仓库：https://github.com/espressif/esp-launchpad

## 目标

- 管理员可以在“固件管理”页面选择目标设备并启动 IDF 在线刷机。
- 固件来源支持固件库、项目构建产物、固件 URL、一次性上传文件。
- 前端展示刷机状态：`待开始`、`刷入中`、`成功`、`失败`。
- 设备列表和设备编辑支持设备种类、分辨率字段。
- 管理员可以新增、修改、删除设备种类，并为每个设备种类配置默认分辨率。
- 删除设备种类前检查关联设备，存在关联设备时拒绝删除并提示迁移。
- 预览区域按设备 `width x height` 动态计算比例，容器自适应且不溢出。
- 渲染预览和桌面/投屏预览共用同一套分辨率计算逻辑。

## 非目标

- 后端不直接操作 USB 串口，不在服务器上执行 `esptool.py`。
- 不替换现有设备端 OTA 升级链路；IDF 在线刷机作为并列的人工维护入口存在。
- 一次性上传刷机默认不进入正式固件版本库，除非用户另行使用现有“上传固件”功能保存。
- 不在本次改动中重构整个 Dashboard 页面结构，只在相关功能区内做局部增强。

## 架构

整体采用“后端提供固件文件与 launch manifest，前端使用 ESP Launchpad/Web Serial 刷机”的架构。

后端职责：

- 管理设备种类与设备分辨率字段。
- 提供固件刷机来源列表。
- 从固件库、URL、项目构建产物或一次性上传文件生成在线刷机 manifest。
- 提供 manifest 和 bin 文件下载地址。
- 记录在线刷机会话与状态回写，用于管理端展示和审计。

前端职责：

- 在“固件管理”新增“IDF 在线刷入”区域。
- 让用户选择目标设备和固件来源。
- 调用后端准备刷机 manifest。
- 打开/嵌入 ESP Launchpad 刷机入口，由浏览器通过 Web Serial 连接 ESP 设备。
- 根据用户操作和 ESP Launchpad 回调更新状态。

## 数据模型

### 设备种类

新增 `deviceTypes` 集合，保存到 store 状态并通过 MySQL payload 表持久化。

```ts
type DeviceType = {
  id: string;
  name: string;
  defaultWidth: number;
  defaultHeight: number;
  description: string;
  createdAt: string;
  updatedAt: string;
};
```

默认种类：

```json
{
  "id": "dtype_ink_screen",
  "name": "ink-screen",
  "defaultWidth": 2560,
  "defaultHeight": 1600,
  "description": "默认水墨屏设备"
}
```

### 设备字段

现有设备对象新增：

```ts
type DeviceResolutionFields = {
  deviceTypeId: string;
  deviceTypeName: string;
  width: number;
  height: number;
};
```

兼容规则：

- `type` 字段继续保留，用于现有固件兼容判断和硬件登录链路。
- `deviceTypeId` 为空时，根据 `type` 或默认种类回填。
- `deviceTypeName` 由关联设备种类名称派生并保存，便于列表展示和旧数据兜底。
- `width`、`height` 缺失或非法时使用关联种类默认分辨率。
- 如果关联种类不存在，使用默认 `2560 x 1600`。

### 在线刷机会话

新增 `firmwareFlashSessions` 集合。

```ts
type FirmwareFlashSession = {
  id: string;
  deviceId: string;
  sourceType: "library" | "project-build" | "url" | "one-time-upload";
  sourceRef: string;
  manifestUrl: string;
  status: "pending" | "flashing" | "success" | "failed";
  message: string;
  createdBy: { role: string; id: string };
  createdAt: string;
  updatedAt: string;
  finishedAt: string;
  expiresAt: string;
};
```

### 一次性上传文件

一次性上传刷机生成临时文件记录，放入 `firmwareFlashTempFiles` 集合。

```ts
type FirmwareFlashTempFile = {
  id: string;
  sessionId: string;
  originalName: string;
  gridId: string;
  mime: string;
  size: number;
  sha256: string;
  offset: string;
  role: "bootloader" | "partition-table" | "ota-data" | "app" | "custom";
  createdAt: string;
  expiresAt: string;
};
```

临时文件默认 TTL 为 24 小时。后端在读取、列表和准备会话时过滤过期记录，并在后台或下一次准备刷机时清理。

## 后端 API

### 设备种类

新增 `backend/src/routes/device_type.routes.js`，挂载到 `/api/device-types`，仅管理员可写，管理员和用户可读。

- `GET /api/device-types`
  返回设备种类列表。

- `POST /api/device-types`
  新建设备种类。校验 `name` 唯一，`defaultWidth/defaultHeight` 为正整数。

- `POST /api/device-types/:typeId`
  修改设备种类。名称变化后同步设备的 `deviceTypeName`。默认分辨率变化不强制覆盖已手动修改的设备分辨率。

- `POST /api/device-types/:typeId/delete`
  删除设备种类。删除前统计关联设备数量，若数量大于 0 返回 400，消息说明需要先迁移设备。

### 设备管理

扩展 `backend/src/routes/device.routes.js`：

- `POST /api/devices/register`
  接收 `deviceTypeId`、`width`、`height`。选择 `deviceTypeId` 时自动填充 `deviceTypeName` 和默认分辨率，显式传入 `width/height` 时优先使用传入值。

- `POST /api/devices/:deviceId`
  管理员可更新 `deviceTypeId`、`width`、`height`。用户仍只允许更新 `displayName`、`remark`。

- `GET /api/devices`
  返回 `deviceTypeId`、`deviceTypeName`、`width`、`height`，并在关键词搜索中包含设备种类和分辨率。

- 删除设备时保持现有清理逻辑，不删除设备种类；这样不会因为删除设备导致设备种类配置脏数据。

硬件自动注册：

- `POST /api/hardware/auto-register` 接收可选 `deviceTypeId/width/height`。
- 如果真机只传旧字段 `type`，后端按 `type` 匹配设备种类或使用默认种类。

### 在线刷机

扩展 `backend/src/routes/firmware.routes.js` 或新增 `backend/src/routes/firmware_flash.routes.js` 并挂载到 `/api/firmware/flash`。

- `GET /api/firmware/flash/sources`
  返回可选固件来源：
  - 已上传固件库记录。
  - 项目构建产物记录，例如 `idfchonggouepd / 4d_systems_esp32s3_gen4_r8n16`。
  - URL 来源入口元数据。
  - 一次性上传入口元数据。

- `POST /api/firmware/flash/project-build/scan`
  管理员触发扫描 `D:\idfchonggouepd\.pio\build\4d_systems_esp32s3_gen4_r8n16`。
  扫描顺序：
  1. 读取 `flasher_args.json`。
  2. 读取 `flash_project_args` 或 `flash_args` 作为兜底。
  3. 解析 offsets 和 bin 文件路径。
  4. 若配置文件中的路径不存在，按已确认的 PlatformIO 常见产物名映射：
     - app: `idfchonggouepd.bin` -> `firmware.bin`
     - bootloader: `bootloader/bootloader.bin` -> `bootloader.bin`
     - partition-table: `partition_table/partition-table.bin` -> `partitions.bin`
  5. 记录 target 为 `esp32s3`，flash mode 为 `dio`，flash freq 为 `80m`，flash size 为 `16MB` 或 `detect`。

- `POST /api/firmware/flash/one-time-upload`
  支持 multipart 上传。
  输入方式：
  - 多文件：每个文件带 `role` 和 `offset`。
  - 单个 zip：后端解压并查找 `flasher_args.json/flash_args`。
  - 单个 app bin：默认 offset 为 `0x10000`，并在响应中提示这是 app-only 刷入。
  返回临时 sourceRef。

- `POST /api/firmware/flash/prepare`
  输入：
  ```json
  {
    "deviceId": "dev_xxx",
    "sourceType": "library",
    "sourceRef": "fw_xxx",
    "url": "",
    "oneTimeUploadRef": ""
  }
  ```
  输出：
  ```json
  {
    "sessionId": "fflash_xxx",
    "manifestUrl": "/api/firmware/flash/sessions/fflash_xxx/manifest.toml",
    "launchUrl": "https://espressif.github.io/esp-launchpad/?flashConfigURL=..."
  }
  ```

- `GET /api/firmware/flash/sessions/:sessionId/manifest.toml`
  返回 ESP Launchpad 可消费的 TOML 配置。所有固件文件 URL 使用同源 API 地址，避免跨域。

- `GET /api/firmware/flash/sessions/:sessionId/files/:fileId`
  下载本次刷机使用的 bin 文件。会校验登录用户权限、会话有效期和关联设备访问权限。

- `POST /api/firmware/flash/sessions/:sessionId/status`
  前端回写状态：`pending/flashing/success/failed` 和 message。

## 固件来源处理

### 固件库

现有固件库记录只有单个固件下载 URL 时，按 app-only 刷入处理，offset 默认为 `0x10000`。如果后续上传的是 zip 或 manifest 包，则解析出多段刷机配置。

### 固件 URL

用户填写 URL 时：

- 若 URL 指向 `.bin`，默认 app-only，offset `0x10000`。
- 若 URL 指向 `.toml`，后端可以直接作为 launch config 代理或校验后转发。
- 若 URL 指向 `.zip`，后端下载后解析；下载大小限制沿用固件上传限制，默认不超过 120MB。

### 项目构建产物

默认配置：

```json
{
  "projectName": "idfchonggouepd",
  "envName": "4d_systems_esp32s3_gen4_r8n16",
  "buildDir": "D:\\idfchonggouepd\\.pio\\build\\4d_systems_esp32s3_gen4_r8n16",
  "chip": "esp32s3",
  "defaultResolution": { "width": 2560, "height": 1600 }
}
```

### 一次性上传

一次性上传只创建临时 sourceRef 和刷机会话，不写入 `firmwares` 集合。成功或失败状态只保存在 `firmwareFlashSessions`。

## 前端 UI

### 固件管理

在 `DashboardCore.vue` 的 `activePanel === 'firmware'` 下新增卡片“IDF 在线刷入”。

表单字段：

- 目标设备：`el-select`，从 `deviceStore.devices` 选择。
- 固件来源：`el-radio-group`
  - 固件库
  - 项目构建产物
  - 固件 URL
  - 一次性上传
- 固件库选择：显示版本、设备类型、文件名。
- 项目构建产物：显示 `idfchonggouepd / 4d_systems_esp32s3_gen4_r8n16`，提供“重新扫描”按钮。
- URL：输入 URL 和可选 offset。
- 一次性上传：支持 zip/manifest 或多个 bin 文件，多个 bin 文件时允许填写 offset 与 role。

状态展示：

- `待开始`：尚未 prepare 或已 prepare 等待用户连接设备。
- `刷入中`：用户已点击启动，前端回写 `flashing`。
- `成功`：ESP Launchpad 完成后回写 `success`。
- `失败`：prepare 失败、浏览器不支持 Web Serial、用户取消、ESP Launchpad 报错或超时。

刷机启动：

- 默认打开新窗口：
  `https://espressif.github.io/esp-launchpad/?flashConfigURL=<encoded manifest url>`
- 若浏览器阻止弹窗，则显示可点击链接。
- 前端提供“我已完成刷机 / 标记失败”按钮作为可靠兜底，因为跨站 launchpad 页面不一定能稳定向本系统发送完整回调。

浏览器能力提示：

- 如果 `navigator.serial` 不存在，提示需要使用支持 Web Serial 的 Chromium 系浏览器，并保持 HTTPS 或 localhost 环境。

### 设备/PIN

在现有“设备与PIN”表单新增：

- 设备种类 `el-select`
- 分辨率宽度 `el-input-number`
- 分辨率高度 `el-input-number`

选择设备种类时：

- 自动填充该种类默认宽高。
- 用户之后手动修改宽高时保留手动值。

### 设备框选与筛选

在 `DeviceLassoPicker.vue` 卡片上新增：

- 设备种类：`deviceTypeName || type`
- 分辨率：`width x height`

在快速编辑表格新增列：

- 设备种类
- 分辨率

快速编辑可以只保存显示名和备注；完整种类/分辨率修改在“设备与PIN”中进行，避免批量误改。

### 设备种类管理

在 Dashboard 新增侧边栏项“设备种类”，仅管理员显示。

功能：

- 列表展示 `name/defaultWidth/defaultHeight/description/updatedAt/关联设备数`。
- 新增种类。
- 点击行编辑种类。
- 删除前调用后端；有关联设备时展示后端错误。

## 分辨率与预览

新增 `frontend-vue/src/composables/useDeviceResolution.ts`：

```ts
export const DEFAULT_DEVICE_RESOLUTION = { width: 2560, height: 1600 };

export function normalizeDeviceResolution(input: unknown): { width: number; height: number };

export function getAspectRatio(resolution: { width: number; height: number }): number;

export function getPreviewScale(options: {
  sourceWidth: number;
  sourceHeight: number;
  maxWidth: number;
  maxHeight?: number;
  allowUpscale?: boolean;
}): number;

export function useDeviceResolution(devicesRef, selectedDeviceIdRef);
```

使用点：

- `PageStudio.vue`
  - `DeviceRow` 增加 `width/height/deviceTypeName`。
  - `preview-canvas` 不再依赖图片自然尺寸撑开，而是设置为按设备分辨率缩放后的 stage。
  - 图片使用 `width:100%; height:100%; object-fit:contain`。
  - 时间覆盖层坐标基于真实设备分辨率，再乘以 stage scale。

- `DashboardCore.vue` 主页预览
  - `homepagePreviewSourceSize` 优先使用当前目标设备分辨率，其次使用 render meta，其次 `2560 x 1600`。
  - 主页编辑预览和下发预览共用同一 stage scale。

- `DashboardCore.vue` 图片投屏预览
  - `remotePreviewResolution` 从当前选中设备读取，不再固定 `RES_MAP["ink-screen"]`。
  - 未选中设备时使用默认分辨率。

切换设备后：

- 设备 id 变化触发 computed 更新，预览 stage 尺寸立即变化。
- 不需要重新渲染图片才能更新 stage 比例；如果需要重新生成真实分辨率图片，用户仍使用现有渲染按钮。

## 错误处理

- 设备种类名称重复：返回 409。
- 设备种类宽高非法：返回 400。
- 删除有关联设备的设备种类：返回 400，并返回关联设备数量。
- 设备更新传入不存在的 `deviceTypeId`：返回 400。
- 一次性上传缺少文件：返回 400。
- 一次性上传多段 bin 缺少 offset：返回 400。
- 项目构建产物路径不存在：返回 404，并提示检查 `D:\idfchonggouepd` 构建输出。
- manifest 文件引用的 bin 不存在：prepare 阶段返回 400。
- 浏览器不支持 Web Serial：前端进入失败状态并给出浏览器提示。
- 用户取消串口授权：前端进入失败状态，message 记录取消原因。

## 测试策略

后端测试优先覆盖纯函数和路由行为：

- 设备种类 CRUD、名称重复、删除关联检查。
- 设备更新时选择种类自动回填 `deviceTypeName` 和默认分辨率。
- 旧设备缺少分辨率时 `normalizeStoreShape` 回填默认值。
- 项目构建产物扫描能解析 `flasher_args.json`，并能把 `idfchonggouepd.bin` 兜底映射到 `firmware.bin`。
- 一次性上传生成临时 sourceRef 和 manifest。
- `prepare` 对设备权限、来源类型和文件存在性做校验。

前端测试和验证：

- TypeScript build 通过。
- 设备列表展示设备种类和 `width x height`。
- 选择设备种类后宽高自动填充且可手动覆盖。
- 固件管理中四种来源能进入 `prepare`。
- 不支持 Web Serial 时显示失败提示。
- 预览 stage 在不同设备分辨率之间切换后立即改变比例，且不溢出容器。

## 迁移与兼容

- `normalizeStoreShape` 负责为旧数据补齐 `deviceTypes`、`deviceTypeId/deviceTypeName/width/height`。
- MySQL `devices` 表不需要新增结构列即可保存新字段，因为完整设备对象保存在 `payload_json`；可选地把设备种类和分辨率加入 `metadata_json`，提升直接查询可读性。
- 现有 `type` 字段继续保留，不破坏固件兼容判断。
- 现有 OTA 固件升级 API 保持不变。

## 实施顺序

1. 后端新增设备种类数据模型、路由和 store 归一化。
2. 后端扩展设备注册/编辑/列表字段。
3. 后端新增在线刷机 manifest、项目扫描、一次性上传和会话状态 API。
4. 前端扩展设备 store 类型、设备列表、设备编辑和设备种类管理页。
5. 前端新增 `useDeviceResolution` 并改造 PageStudio、主页预览、图片投屏预览。
6. 前端新增固件管理“IDF 在线刷入”区域。
7. 运行后端路由测试、前端构建和手动冒烟验证。
