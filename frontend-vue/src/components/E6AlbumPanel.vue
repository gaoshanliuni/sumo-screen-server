<template>
  <div class="album-dashboard">
    <div class="album-topbar">
      <div>
        <div class="eyebrow">E6 Photo Frame</div>
        <h3>相册与集合播放台</h3>
        <p>{{ e6Devices.length }} 台 E6 设备 · {{ collections.length }} 个集合 · {{ sources.length }} 个来源</p>
      </div>
      <div class="topbar-actions">
        <el-button :loading="loading" @click="loadAll">刷新</el-button>
        <el-button type="primary" @click="modeTab = 'collections'; openSourceDialog()">添加来源</el-button>
      </div>
    </div>

    <div class="album-mode-tabs">
      <button :class="{ active: modeTab === 'play' }" type="button" @click="modeTab = 'play'">播放相片</button>
      <button :class="{ active: modeTab === 'collections' }" type="button" @click="modeTab = 'collections'">编辑集合</button>
      <button :class="{ active: modeTab === 'memory' }" type="button" @click="modeTab = 'memory'">记忆流年</button>
    </div>

    <div class="album-mode-pages">
      <section v-if="modeTab === 'play'" class="mode-page play-photo-page">
        <aside class="album-panel play-device-panel">
          <div class="panel-title">
            <div>
              <strong>播放设备</strong>
              <small>可多选，同时推送</small>
            </div>
            <el-tag size="small" type="success">{{ selectedDeviceIds.length }}</el-tag>
          </div>

          <el-input v-model="deviceKeyword" size="small" placeholder="搜索设备 / MAC / 名称" clearable />
          <div class="quick-row">
            <el-button size="small" @click="selectAllDevices">全选</el-button>
            <el-button size="small" @click="selectedDeviceIds = []">取消</el-button>
            <el-button size="small" @click="invertDevices">反选</el-button>
          </div>

          <div class="device-list">
            <label
              v-for="device in filteredE6Devices"
              :key="device.id"
              class="device-row"
              :class="{ checked: selectedDeviceSet.has(String(device.id)) }"
            >
              <input v-model="selectedDeviceIds" type="checkbox" :value="String(device.id)" />
              <span class="device-dot" :class="{ online: deviceOnline(device) }" />
              <span class="device-main">
                <strong>{{ deviceDisplayName(device) }}</strong>
                <small>{{ device.mac || device.id }}</small>
              </span>
              <el-tag size="small" :type="deviceOnline(device) ? 'success' : 'info'">
                {{ deviceOnline(device) ? "在线" : "离线" }}
              </el-tag>
            </label>
            <el-empty v-if="!filteredE6Devices.length" description="没有 E6 设备" />
          </div>
        </aside>

        <section class="album-panel play-collection-panel">
          <div class="section-title">
            <div>
              <strong>内容选择</strong>
              <small>选择一个或多个集合，缩略图来自集合内图片</small>
            </div>
            <el-tag size="small">{{ validSelectedCollectionIds.length }} 个集合</el-tag>
          </div>
          <div class="play-collection-gallery">
            <label
              v-for="collection in collections"
              :key="collection.id"
              class="collection-gallery-card"
              :class="{ checked: selectedCollectionSet.has(collection.id) }"
              @mouseenter="loadCollectionPreview(collection.id)"
            >
              <input v-model="selectedCollectionIds" type="checkbox" :value="collection.id" />
              <span class="collection-gallery-main">
                <strong>{{ collection.name }}</strong>
                <small>{{ collection.itemCount || 0 }} 张 · {{ intervalMinutes(collection.slideIntervalSec) }} 分钟切换</small>
              </span>
              <span class="collection-preview-grid">
                <span
                  v-for="item in collectionPreviewItems(collection.id)"
                  :key="item.id || item.imageId"
                  class="preview-thumb"
                    @click.prevent="previewImageEnhanced(item)"
                >
                  <img v-if="item.isImage && item.thumbnailUrl" :src="assetUrl(item.thumbnailUrl)" loading="lazy" />
                  <em v-else>{{ fileBadge(item.name || item.originalName) }}</em>
                </span>
                <span v-if="!collectionPreviewItems(collection.id).length" class="preview-thumb empty">
                  {{ collection.itemCount ? "加载" : "空" }}
                </span>
              </span>
            </label>
            <el-empty v-if="!collections.length" description="还没有集合，请到编辑集合中新建或上传图片" />
          </div>
        </section>

        <aside class="album-panel play-action-panel">
          <div class="section-title">
            <div>
              <strong>播放设置</strong>
              <small>多集合会合并为临时播放清单</small>
            </div>
          </div>
          <el-form :model="playForm" label-width="82px" size="small">
            <el-form-item label="切换分钟">
              <el-input-number v-model="playForm.slideIntervalMinutes" :min="1" :max="1440" />
            </el-form-item>
            <el-form-item label="循环">
              <el-switch v-model="playForm.loopEnabled" />
            </el-form-item>
            <el-form-item label="离线缓存">
              <el-switch v-model="playForm.offlineSyncEnabled" />
            </el-form-item>
          </el-form>
          <div class="confirm-box">
            <div>
              <strong>确认推送</strong>
              <p v-if="validSelectedCollectionIds.length > 1">
                系统会自动合并 {{ validSelectedCollectionIds.length }} 个集合为临时播放清单，并推送到 {{ selectedDeviceIds.length }} 台设备。
              </p>
              <p v-else>{{ validSelectedCollectionIds.length }} 个集合，将推送到 {{ selectedDeviceIds.length }} 台设备。</p>
            </div>
            <el-button
              type="success"
              :loading="pushing"
              :disabled="!validSelectedCollectionIds.length || !selectedDeviceIds.length"
              @click="pushSelectedCollections"
            >
              推送集合
            </el-button>
          </div>
        </aside>
      </section>

      <section v-else-if="modeTab === 'collections'" class="mode-page collection-editor-layout">
        <aside class="album-panel collection-manager-panel">
          <div class="section-title">
            <strong>集合管理</strong>
            <div class="mini-actions">
              <el-button size="small" @click="newCollection">新建集合</el-button>
              <el-button size="small" :disabled="!collectionForm.id" @click="loadCollectionDetail(collectionForm.id)">刷新详情</el-button>
            </div>
          </div>

          <div class="collection-list">
            <button
              v-for="collection in collections"
              :key="collection.id"
              type="button"
              class="collection-row"
              :class="{ active: collection.id === collectionForm.id }"
              @click="editCollection(collection)"
            >
              <span>
                <strong>{{ collection.name }}</strong>
                <small>{{ collection.itemCount || 0 }} 张 · {{ collection.updatedAt || "未更新" }}</small>
              </span>
              <el-tag size="small">{{ intervalMinutes(collection.slideIntervalSec) }} 分钟</el-tag>
            </button>
          </div>

          <el-form class="collection-form" :model="collectionForm" label-width="82px" size="small">
            <el-form-item label="名称"><el-input v-model="collectionForm.name" /></el-form-item>
            <el-form-item label="描述"><el-input v-model="collectionForm.description" type="textarea" :rows="2" /></el-form-item>
            <el-form-item label="切换分钟">
              <el-input-number v-model="collectionForm.slideIntervalMinutes" :min="1" :max="1440" />
            </el-form-item>
            <el-form-item label="离线缓存"><el-switch v-model="collectionForm.offlineSyncEnabled" /></el-form-item>
          </el-form>
          <div class="form-actions">
            <el-button type="primary" :loading="savingCollection" @click="saveCollection">
              {{ collectionForm.id ? "保存集合" : "创建集合" }}
            </el-button>
            <el-button type="danger" plain :disabled="!collectionForm.id" :loading="savingCollection" @click="deleteCollection">
              删除集合
            </el-button>
          </div>
        </aside>

        <section class="album-panel collection-detail-panel">
          <div class="content-head">
            <div>
              <strong>集合图片</strong>
              <small>{{ collectionForm.id ? collectionForm.name || "当前集合" : "先选择或创建集合" }}</small>
            </div>
            <div class="mini-actions">
              <el-tag size="small">{{ collectionItems.length }} 张</el-tag>
              <el-button size="small" :disabled="!collectionItems.length" @click="selectAllCollectionItems">全选</el-button>
              <el-button size="small" :disabled="!selectedCollectionItemIds.length" @click="selectedCollectionItemIds = []">取消</el-button>
              <el-button size="small" :disabled="!collectionItems.length" @click="invertCollectionItems">反选</el-button>
            </div>
          </div>
          <div
            ref="collectionGridRef"
            class="collection-strip"
            @mousedown="startCollectionLasso"
            @mousemove="moveCollectionLasso"
            @mouseup="endCollectionLasso"
            @mouseleave="endCollectionLasso"
          >
            <div
              v-for="item in collectionItems"
              :key="item.id || item.imageId"
              :data-image-id="String(item.imageId || item.id || '')"
              class="selected-thumb collection-item-thumb"
              :class="{ checked: selectedCollectionItemSet.has(String(item.imageId || item.id || '')) }"
            >
              <label class="thumb-check">
                <input v-model="selectedCollectionItemIds" type="checkbox" :value="String(item.imageId || item.id || '')" />
              </label>
              <button class="thumb-preview" type="button" @click="previewImageEnhanced(item)">
                <img v-if="item.isImage && item.thumbnailUrl" :src="assetUrl(item.thumbnailUrl)" loading="lazy" />
                <span v-else>{{ fileBadge(item.name || item.originalName) }}</span>
              </button>
              <small :title="item.name || item.originalName">{{ item.name || item.originalName }}</small>
              <button type="button" @click="removeCollectionItem(item)">移除</button>
            </div>
            <span
              v-if="collectionLasso.active && collectionLasso.dragging"
              class="lasso-box"
              :style="collectionLassoStyle"
            />
            <el-empty v-if="collectionForm.id && !collectionItems.length" description="集合里还没有图片" />
            <el-empty v-if="!collectionForm.id" description="请选择集合后管理图片" />
          </div>
        </section>

        <section class="album-panel source-browser-panel">
          <div class="content-head">
            <div>
              <strong>本地上传</strong>
              <small>{{ currentUploadCollectionLabel }}</small>
            </div>
            <div class="mini-actions">
              <el-button size="small" @click="sourcePickerOpen = true">来源</el-button>
              <el-button size="small" @click="openSourceDialog(currentSource || undefined)">管理来源</el-button>
            </div>
          </div>

          <div
            class="upload-zone"
            tabindex="0"
            @click="uploadInputRef?.click()"
            @paste="handlePasteUpload"
            @dragover.prevent
            @drop.prevent="handleDropUpload"
          >
            <input ref="uploadInputRef" class="upload-input" type="file" accept="image/*" multiple @change="handleUploadInput" />
            <strong>上传图片到集合</strong>
            <span>{{ uploadFiles.length ? `${uploadFiles.length} 个文件待上传` : "点击选择、拖入或粘贴单张/多张图片" }}</span>
          </div>

          <div class="target-row">
            <span class="current-target">{{ currentUploadCollectionLabel }}</span>
            <el-input-number v-model="importForm.slideIntervalMinutes" size="small" :min="1" :max="1440" />
            <el-button size="small" type="primary" :loading="uploading" :disabled="!uploadFiles.length || !activeCollectionId" @click.stop="uploadSelectedFiles">
              上传
            </el-button>
          </div>
          <div class="dither-row">
            <span class="dither-label">E6 抖动</span>
            <el-switch v-model="importForm.ditherEnabled" size="small" active-text="开启" inactive-text="关闭" />
            <el-select v-model="importForm.ditherMode" size="small" :disabled="!importForm.ditherEnabled" placeholder="抖动方式">
              <el-option
                v-for="option in ditherModeOptions"
                :key="option.value"
                :label="option.label"
                :value="option.value"
              />
            </el-select>
            <small>{{ selectedDitherDescription }}</small>
          </div>

        </section>
      </section>

      <section v-else class="album-panel mode-page memory-body">
        <strong>记忆流年</strong>
        <p>用现有集合按时间、来源或文件夹组织年度播放清单。当前版本先复用集合与来源数据，避免再造一套假数据。</p>
        <el-button @click="modeTab = 'collections'">去整理集合</el-button>
      </section>
    </div>

    <el-dialog v-model="sourcePickerOpen" title="来源选择" width="min(960px, 94vw)" class="source-picker-dialog">
      <div class="source-chips">
        <button
          v-for="source in sources"
          :key="source.id"
          type="button"
          class="source-chip"
          :class="{ active: source.id === selectedSourceId }"
          @click="selectSource(source)"
        >
          <span>{{ source.name }}</span>
          <el-tag size="small" :type="statusTagType(source.lastTestStatus)">{{ source.lastTestStatus || "ready" }}</el-tag>
        </button>
        <el-empty v-if="!sources.length" description="暂无来源" />
      </div>

      <div class="browser-toolbar">
        <div class="path-row">
          <el-button text @click="goPath('/')">/</el-button>
          <template v-for="crumb in breadcrumbs" :key="crumb.path">
            <span>/</span>
            <el-button text @click="goPath(crumb.path)">{{ crumb.name }}</el-button>
          </template>
        </div>
        <div class="mini-actions">
          <el-button size="small" :disabled="!selectedSourceId" :loading="browseLoading" @click="browse()">刷新目录</el-button>
          <el-button size="small" :disabled="!fileItems.length" @click="selectAllFiles">全选</el-button>
          <el-button size="small" :disabled="!selectedPaths.length" @click="clearSelectedFiles">全部取消</el-button>
          <el-button size="small" :disabled="!fileItems.length" @click="invertSelectedFiles">反选</el-button>
        </div>
      </div>

      <div
        ref="browseGridRef"
        class="album-grid source-dialog-grid"
        @mousedown="startBrowseLasso"
        @mousemove="moveBrowseLasso"
        @mouseup="endBrowseLasso"
        @mouseleave="endBrowseLasso"
      >
            <button
              v-for="(item, index) in browseItems"
              :key="item.path"
              :data-path="item.path"
              :data-type="item.type"
              class="album-tile"
              :class="{ selected: isSelected(item), dir: item.type === 'dir' }"
              type="button"
              @click.stop="toggleItem(item, index, $event)"
              @dblclick.stop="openItem(item)"
            >
              <div class="tile-media">
                <img v-if="item.type !== 'dir' && item.thumbnailUrl" :src="assetUrl(item.thumbnailUrl)" loading="lazy" />
                <span v-else>{{ item.type === "dir" ? "DIR" : fileBadge(item.name) }}</span>
              </div>
              <div class="tile-name" :title="item.name">{{ item.name }}</div>
              <el-tag v-if="item.imported" size="small" type="success">已导入</el-tag>
            </button>
            <span
              v-if="browseLasso.active && browseLasso.dragging"
              class="lasso-box"
              :style="browseLassoStyle"
            />
            <el-empty v-if="!browseLoading && !browseItems.length" description="这个文件夹暂时没有可显示内容" />
          </div>

          <div class="selected-footer">
            <div class="selected-footer-head">
              <strong>已选图片</strong>
              <span>{{ selectedItems.length }} 张</span>
            </div>
            <div class="selected-strip">
              <div v-for="item in selectedItems" :key="item.path" class="selected-thumb">
                <button class="thumb-preview" type="button" @click="previewImageEnhanced(item)">
                  <img v-if="item.thumbnailUrl" :src="assetUrl(item.thumbnailUrl)" loading="lazy" />
                  <span v-else>{{ fileBadge(item.name) }}</span>
                </button>
                <button type="button" @click="removeSelected(item.path)">移除</button>
              </div>
            </div>
            <div class="form-actions">
              <el-button type="primary" :disabled="!selectedItems.length" :loading="importing" @click="importSelected">导入到集合</el-button>
              <el-progress v-if="activeJob?.id" :percentage="jobProgress" :status="jobStatus" />
            </div>
          </div>
    </el-dialog>

    <el-dialog v-model="sourceDialogOpen" :title="sourceForm.id ? '编辑来源' : '添加来源'" width="520px">
      <el-form :model="sourceForm" label-width="86px" size="small">
        <el-form-item label="名称"><el-input v-model="sourceForm.name" /></el-form-item>
        <el-form-item label="类型">
          <el-segmented v-model="sourceForm.providerType" :options="providerOptions" />
        </el-form-item>
        <el-form-item v-if="sourceForm.providerType === 'openlist'" label="站点">
          <el-input v-model="sourceForm.baseUrl" placeholder="https://openlist.example.com" />
        </el-form-item>
        <el-form-item label="根路径"><el-input v-model="sourceForm.rootPath" /></el-form-item>
        <el-form-item v-if="sourceForm.providerType === 'openlist'" label="账号"><el-input v-model="sourceForm.username" /></el-form-item>
        <el-form-item v-if="sourceForm.providerType === 'openlist'" label="密码">
          <el-input v-model="sourceForm.password" show-password autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="公开"><el-switch v-model="sourceForm.isPublic" /></el-form-item>
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button :disabled="!sourceForm.id" :loading="testingSource" @click="testSource(sourceForm.id)">测试连接</el-button>
          <el-button :disabled="!sourceForm.id" type="danger" plain :loading="savingSource" @click="deleteSource">删除来源</el-button>
          <el-button @click="sourceDialogOpen = false">取消</el-button>
          <el-button type="primary" :loading="savingSource" @click="saveSource">保存</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="imagePreviewDialog.open" class="preview-dialog" width="min(920px, 92vw)" append-to-body>
      <template #header>
        <div class="preview-dialog-title">
          <strong>{{ imagePreviewDialog.title || "图片预览" }}</strong>
          <small v-if="imagePreviewDialog.subtitle">{{ imagePreviewDialog.subtitle }}</small>
        </div>
      </template>
      <div class="preview-tools">
        <el-segmented v-model="imagePreviewDialog.mode" :options="previewModeOptions" @change="handlePreviewModeChange" />
        <el-select v-model="imagePreviewDialog.ditherMode" size="small" :disabled="imagePreviewDialog.mode !== 'e6'" @change="loadE6Preview">
          <el-option v-for="option in ditherModeOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-button-group>
          <el-button size="small" :disabled="imagePreviewDialog.mode !== 'e6'" @click="rotatePreviewImage(-90)">左转</el-button>
          <el-button size="small" :disabled="imagePreviewDialog.mode !== 'e6'" @click="rotatePreviewImage(90)">右转</el-button>
        </el-button-group>
        <el-button
          size="small"
          type="primary"
          plain
          :loading="savingPreviewDither"
          :disabled="imagePreviewDialog.mode !== 'e6' || !previewImageIds.length"
          @click="applyPreviewDitherToImages"
        >
          应用到{{ previewImageIds.length > 1 ? `${previewImageIds.length}张` : "当前图" }}
        </el-button>
      </div>
      <div v-if="imagePreviewDialog.mode === 'e6'" class="preview-crop-tools">
        <span>旋转 {{ imagePreviewDialog.rotateDeg }}°</span>
        <label>
          裁剪X
          <el-input-number v-model="imagePreviewDialog.cropX" size="small" :min="0" :max="99" :step="1" controls-position="right" @change="loadE6Preview" />
        </label>
        <label>
          裁剪Y
          <el-input-number v-model="imagePreviewDialog.cropY" size="small" :min="0" :max="99" :step="1" controls-position="right" @change="loadE6Preview" />
        </label>
        <label>
          宽度
          <el-input-number v-model="imagePreviewDialog.cropWidth" size="small" :min="1" :max="100" :step="1" controls-position="right" @change="loadE6Preview" />
        </label>
        <label>
          高度
          <el-input-number v-model="imagePreviewDialog.cropHeight" size="small" :min="1" :max="100" :step="1" controls-position="right" @change="loadE6Preview" />
        </label>
        <el-button size="small" @click="resetPreviewCrop">重置裁剪</el-button>
      </div>
      <div class="preview-dialog-body">
        <el-empty v-if="imagePreviewDialog.mode === 'e6' && imagePreviewDialog.loading" description="正在生成 E6 预览" />
        <template v-else-if="imagePreviewDialog.mode === 'e6'">
          <div class="preview-multi-grid">
            <img v-for="item in imagePreviewDialog.e6Previews" :key="item.imageId" :src="item.previewDataUrl" alt="e6-preview" />
          </div>
        </template>
        <img v-else-if="imagePreviewDialog.url" :src="imagePreviewDialog.url" alt="preview" />
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus/es/components/message/index.mjs";
import { ElMessageBox } from "element-plus/es/components/message-box/index.mjs";
import {
  browseAlbumSource,
  createAlbumSource,
  createPlayCollection,
  deleteAlbumSource,
  deletePlayCollection,
  fetchAlbumImportJob,
  fetchAlbumSources,
  fetchPlayCollection,
  fetchPlayCollections,
  importAlbumImages,
  patchAlbumSource,
  patchPlayCollection,
  previewE6Images,
  pushMergedPlayCollections,
  pushPlayCollection,
  setE6ImageDitherMode,
  setPlayCollectionItems,
  testAlbumSource,
  uploadAlbumImages,
  type AlbumBrowseItem,
  type AlbumImportJobRow,
  type AlbumProviderType,
  type AlbumSourceRow,
  type PlayCollectionItemRow,
  type PlayCollectionRow,
} from "../services/e6Albums";

const props = defineProps<{
  token: string;
  devices?: Array<Record<string, any>>;
}>();

const emit = defineEmits<{
  (event: "refresh-devices"): void;
}>();

const providerOptions = [
  { label: "OpenList", value: "openlist" },
  { label: "NAS", value: "nas_local" },
];
type E6DitherMode = "waveshare_floyd" | "poster_clean" | "photo_detail" | "photo_soft" | "art_blue_noise";
const ditherModeOptions: Array<{ label: string; value: E6DitherMode; description: string }> = [
  { label: "微雪 Floyd 六色抖动", value: "waveshare_floyd", description: "默认模式，层次更明显，适合 E6 彩色水墨屏实机显示" },
  { label: "海报文字", value: "poster_clean", description: "关闭扩散抖动，适合文字、图标、二维码和海报" },
  { label: "细节照片", value: "photo_detail", description: "细节更锐利，适合纹理丰富的照片" },
  { label: "柔和照片", value: "photo_soft", description: "柔和颗粒，适合人像、风景和日常照片" },
  { label: "蓝噪声", value: "art_blue_noise", description: "颗粒更均匀，适合插画和艺术图" },
];
const previewModeOptions = [
  { label: "原图", value: "original" },
  { label: "转换后", value: "e6" },
];
const UPLOAD_CHUNK_SIZE = 8;
const UPLOAD_CONCURRENCY = 2;

const loading = ref(false);
const modeTab = ref<"play" | "collections" | "memory">("play");
const sources = ref<AlbumSourceRow[]>([]);
const collections = ref<PlayCollectionRow[]>([]);
const selectedCollectionIds = ref<string[]>([]);
const selectedSourceId = ref("");
const currentPath = ref("/");
const browseItems = ref<AlbumBrowseItem[]>([]);
const browseLoading = ref(false);
const selectedPaths = ref<string[]>([]);
const lastAnchorIndex = ref(-1);
const deviceKeyword = ref("");
const selectedDeviceIds = ref<string[]>([]);
const savingSource = ref(false);
const testingSource = ref(false);
const importing = ref(false);
const uploading = ref(false);
const pushing = ref(false);
const savingCollection = ref(false);
const savingPreviewDither = ref(false);
const activeJob = ref<AlbumImportJobRow | null>(null);
const collectionDetail = ref<PlayCollectionRow | null>(null);
const collectionPreviewMap = ref<Record<string, PlayCollectionItemRow[]>>({});
const sourceDialogOpen = ref(false);
const sourcePickerOpen = ref(false);
const uploadInputRef = ref<HTMLInputElement | null>(null);
const browseGridRef = ref<HTMLElement | null>(null);
const collectionGridRef = ref<HTMLElement | null>(null);
const uploadFiles = ref<File[]>([]);
const selectedCollectionItemIds = ref<string[]>([]);
const imagePreviewDialog = reactive({
  open: false,
  url: "",
  title: "",
  subtitle: "",
  mode: "original" as "original" | "e6",
  ditherMode: "waveshare_floyd" as E6DitherMode,
  loading: false,
  imageId: "",
  targetImageIds: [] as string[],
  rotateDeg: 0,
  cropX: 0,
  cropY: 0,
  cropWidth: 100,
  cropHeight: 100,
  e6Previews: [] as Array<{
    imageId: string;
    ditherMode: string;
    binaryTfFileId?: string;
    converterVersion?: string;
    generated?: boolean;
    previewDataUrl: string;
  }>,
});
const browseLasso = reactive({
  active: false,
  dragging: false,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  baseSelected: [] as string[],
});
const collectionLasso = reactive({
  active: false,
  dragging: false,
  startX: 0,
  startY: 0,
  currentX: 0,
  currentY: 0,
  baseSelected: [] as string[],
});
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let loadAllSeq = 0;
let browseSeq = 0;
let detailSeq = 0;
let e6PreviewSeq = 0;
const previewLoadingIds = new Set<string>();
const DEFAULT_SLIDE_INTERVAL_MINUTES = 10;

const sourceForm = reactive({
  id: "",
  providerType: "openlist" as AlbumProviderType,
  name: "",
  baseUrl: "",
  rootPath: "/",
  username: "",
  password: "",
  isPublic: false,
});

const importForm = reactive({
  targetCollectionId: "",
  newCollectionName: "",
  slideIntervalMinutes: DEFAULT_SLIDE_INTERVAL_MINUTES,
  ditherEnabled: true,
  ditherMode: "waveshare_floyd" as E6DitherMode,
});

const effectiveDitherMode = computed<E6DitherMode>(() => (importForm.ditherEnabled ? importForm.ditherMode : "poster_clean"));
const selectedDitherDescription = computed(() => {
  const selected = ditherModeOptions.find((item) => item.value === effectiveDitherMode.value);
  return selected?.description || "";
});

watch(
  () => importForm.ditherEnabled,
  (enabled) => {
    if (!enabled) {
      importForm.ditherMode = "poster_clean";
    } else if (importForm.ditherMode === "poster_clean") {
      importForm.ditherMode = "waveshare_floyd";
    }
  }
);

const playForm = reactive({
  slideIntervalMinutes: DEFAULT_SLIDE_INTERVAL_MINUTES,
  loopEnabled: true,
  offlineSyncEnabled: true,
});

const collectionForm = reactive({
  id: "",
  name: "",
  description: "",
  slideIntervalMinutes: DEFAULT_SLIDE_INTERVAL_MINUTES,
  offlineSyncEnabled: true,
});

watch(
  () => collectionForm.id,
  () => {
    selectedCollectionItemIds.value = [];
    importForm.targetCollectionId = collectionForm.id || "";
  }
);

const activeCollectionId = computed(() => String(collectionForm.id || selectedCollectionIds.value[0] || importForm.targetCollectionId || ""));
const selectedCollectionItemSet = computed(() => new Set(selectedCollectionItemIds.value));
const previewImageIds = computed(() => {
  const ids = imagePreviewDialog.targetImageIds.length
    ? imagePreviewDialog.targetImageIds
    : [imagePreviewDialog.imageId].filter(Boolean);
  return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
});
const previewImageTransform = computed(() => ({
  rotateDeg: imagePreviewDialog.rotateDeg,
  crop: {
    x: imagePreviewDialog.cropX / 100,
    y: imagePreviewDialog.cropY / 100,
    width: imagePreviewDialog.cropWidth / 100,
    height: imagePreviewDialog.cropHeight / 100,
  },
}));
const currentUploadCollectionLabel = computed(() => {
  const activeId = activeCollectionId.value;
  if (!activeId) return "请先在左侧选择或创建集合";
  const collection = collections.value.find((item) => item.id === activeId);
  return `当前集合：${collection?.name || collectionForm.name || activeId}`;
});
const browseLassoStyle = computed(() => {
  const left = Math.min(browseLasso.startX, browseLasso.currentX);
  const top = Math.min(browseLasso.startY, browseLasso.currentY);
  const width = Math.abs(browseLasso.currentX - browseLasso.startX);
  const height = Math.abs(browseLasso.currentY - browseLasso.startY);
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  };
});
const collectionLassoStyle = computed(() => {
  const left = Math.min(collectionLasso.startX, collectionLasso.currentX);
  const top = Math.min(collectionLasso.startY, collectionLasso.currentY);
  const width = Math.abs(collectionLasso.currentX - collectionLasso.startX);
  const height = Math.abs(collectionLasso.currentY - collectionLasso.startY);
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  };
});

const selectedCollectionSet = computed(() => new Set(selectedCollectionIds.value));
const collectionIdSet = computed(() => new Set(collections.value.map((item) => String(item.id))));
const validSelectedCollectionIds = computed(() =>
  selectedCollectionIds.value.filter((id) => collectionIdSet.value.has(String(id)))
);
const selectedDeviceSet = computed(() => new Set(selectedDeviceIds.value));
const selectedPathSet = computed(() => new Set(selectedPaths.value));
const currentSource = computed(() => sources.value.find((item) => item.id === selectedSourceId.value) || null);
const fileItems = computed(() => browseItems.value.filter((item) => item.type !== "dir"));
const selectedItems = computed(() => fileItems.value.filter((item) => selectedPathSet.value.has(item.path)));
const singlePlayableItem = computed(() => {
  const item = selectedItems.value.length === 1 ? selectedItems.value[0] : null;
  return item?.imported && item.imageId ? item : null;
});
const e6Devices = computed(() =>
  (props.devices || []).filter((item) => String(item.type || "") === "e6-color-frame" || String(item.deviceType || "") === "e6-color-frame")
);
const filteredE6Devices = computed(() => {
  const keyword = deviceKeyword.value.trim().toLowerCase();
  if (!keyword) return e6Devices.value;
  return e6Devices.value.filter((device) =>
    [device.id, device.mac, device.displayName, device.remark, device.ownerId]
      .map((item) => String(item || "").toLowerCase())
      .some((text) => text.includes(keyword))
  );
});
const breadcrumbs = computed(() => {
  const parts = String(currentPath.value || "/").split("/").filter(Boolean);
  return parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join("/")}` }));
});
const collectionItems = computed<PlayCollectionItemRow[]>(() => collectionDetail.value?.items || []);
const jobProgress = computed(() => {
  const job = activeJob.value;
  const total = Number(job?.total || 0);
  if (!job || total <= 0) return 0;
  return Math.min(100, Math.round((Number(job.processed || job.done || 0) / total) * 100));
});
const jobStatus = computed(() => {
  const status = String(activeJob.value?.status || "");
  if (status === "success") return "success";
  if (status === "failed" || status === "partial_failed") return "exception";
  return undefined;
});

onMounted(loadAll);
onBeforeUnmount(() => {
  if (pollTimer) clearTimeout(pollTimer);
});

watch(
  () => selectedCollectionIds.value[0] || "",
  async (id) => {
    if (id && modeTab.value === "collections") {
      await loadCollectionDetail(id);
      const collection = collections.value.find((item) => item.id === id);
      if (collection) fillCollectionForm(collection);
    } else if (!id && modeTab.value === "collections") {
      collectionDetail.value = null;
    }
  }
);

watch(
  () => [imagePreviewDialog.open, imagePreviewDialog.mode, imagePreviewDialog.ditherMode] as const,
  () => {
    if (imagePreviewDialog.open && imagePreviewDialog.mode === "e6") {
      void loadE6Preview();
    }
  }
);

async function loadAll() {
  if (!props.token) return;
  if (loading.value) return;
  const seq = ++loadAllSeq;
  loading.value = true;
  try {
    const [sourceRows, collectionRows] = await Promise.all([
      fetchAlbumSources(props.token),
      fetchPlayCollections(props.token),
    ]);
    if (seq !== loadAllSeq) return;
    sources.value = sourceRows;
    collections.value = collectionRows;
    if (!selectedSourceId.value && sourceRows.length) {
      selectedSourceId.value = sourceRows[0].id;
      currentPath.value = sourceRows[0].rootPath || "/";
      void browse();
    }
    selectedCollectionIds.value = selectedCollectionIds.value.filter((id) => collectionRows.some((item) => item.id === id));
    if (!selectedCollectionIds.value.length && collectionRows.length) {
      selectedCollectionIds.value = [collectionRows[0].id];
    }
    if (!importForm.targetCollectionId && collectionRows.length) {
      importForm.targetCollectionId = collectionRows[0].id;
    }
    emit("refresh-devices");
  } catch (error) {
    ElMessage.error((error as Error).message || "加载失败");
  } finally {
    if (seq === loadAllSeq) loading.value = false;
  }
}

function openSourceDialog(source?: AlbumSourceRow) {
  if (source) {
    fillSourceForm(source);
  } else {
    Object.assign(sourceForm, {
      id: "",
      providerType: "openlist",
      name: "",
      baseUrl: "",
      rootPath: "/",
      username: "",
      password: "",
      isPublic: false,
    });
  }
  sourceDialogOpen.value = true;
}

function fillSourceForm(source: AlbumSourceRow) {
  Object.assign(sourceForm, {
    id: source.id,
    providerType: source.providerType || "openlist",
    name: source.name || "",
    baseUrl: source.baseUrl || "",
    rootPath: source.rootPath || "/",
    username: source.username || "",
    password: "",
    isPublic: Boolean(source.isPublic),
  });
}

async function saveSource() {
  if (!sourceForm.name.trim()) {
    ElMessage.warning("请填写来源名称");
    return;
  }
  try {
    if (sourceForm.isPublic) {
      await ElMessageBox.confirm("公开来源会让有权限的用户看到这个来源。确认公开吗？", "公开来源确认", {
        type: "warning",
        confirmButtonText: "确认公开",
        cancelButtonText: "取消",
      });
    }
  } catch (_) {
    return;
  }
  savingSource.value = true;
  try {
    const payload = {
      providerType: sourceForm.providerType,
      name: sourceForm.name,
      baseUrl: sourceForm.baseUrl,
      rootPath: sourceForm.rootPath || "/",
      username: sourceForm.username,
      password: sourceForm.password || undefined,
      isPublic: sourceForm.isPublic,
    };
    const saved = sourceForm.id
      ? await patchAlbumSource(props.token, sourceForm.id, payload)
      : await createAlbumSource(props.token, payload);
    ElMessage.success(sourceForm.id ? "来源已更新" : "来源已添加");
    sourceForm.password = "";
    sourceDialogOpen.value = false;
    await loadAll();
    selectSource(saved);
  } catch (error) {
    ElMessage.error((error as Error).message || "保存失败");
  } finally {
    savingSource.value = false;
  }
}

async function deleteSource() {
  if (!sourceForm.id) return;
  const removedId = sourceForm.id;
  try {
    await ElMessageBox.confirm("删除来源不会删除已导入图片，但会移除这个入口。确认删除？", "删除来源", {
      type: "warning",
    });
  } catch (_) {
    return;
  }
  savingSource.value = true;
  try {
    await deleteAlbumSource(props.token, removedId);
    ElMessage.success("来源已删除");
    sourceDialogOpen.value = false;
    sources.value = sources.value.filter((item) => item.id !== removedId);
    if (selectedSourceId.value === removedId) {
      const nextSource = sources.value[0] || null;
      selectedSourceId.value = nextSource?.id || "";
      currentPath.value = nextSource?.rootPath || "/";
      browseItems.value = [];
      selectedPaths.value = [];
      if (nextSource) void browse();
    }
  } catch (error) {
    ElMessage.error((error as Error).message || "删除失败");
  } finally {
    savingSource.value = false;
  }
}

async function testSource(id: string) {
  if (!id) return;
  testingSource.value = true;
  try {
    await testAlbumSource(props.token, id);
    ElMessage.success("连接成功");
    await loadAll();
  } catch (error) {
    ElMessage.error((error as Error).message || "连接失败");
  } finally {
    testingSource.value = false;
  }
}

function selectSource(source: AlbumSourceRow) {
  selectedSourceId.value = source.id;
  currentPath.value = source.rootPath || "/";
  selectedPaths.value = [];
  void browse();
}

async function browse(path = currentPath.value) {
  if (!selectedSourceId.value) return;
  const seq = ++browseSeq;
  browseLoading.value = true;
  try {
    const result = await browseAlbumSource(props.token, selectedSourceId.value, { path, page: 1, pageSize: 180 });
    if (seq !== browseSeq) return;
    currentPath.value = result.path || path || "/";
    browseItems.value = result.items || [];
    selectedPaths.value = selectedPaths.value.filter((item) => browseItems.value.some((row) => row.path === item));
  } catch (error) {
    ElMessage.error((error as Error).message || "目录读取失败");
  } finally {
    if (seq === browseSeq) browseLoading.value = false;
  }
}

function openItem(item: AlbumBrowseItem) {
  if (item.type === "dir") {
    browse(item.path);
    return;
  }
  togglePath(item.path, true);
}

function toggleItem(item: AlbumBrowseItem, index: number, event: MouseEvent) {
  if (item.type === "dir") {
    lastAnchorIndex.value = index;
    return;
  }
  if (event.shiftKey && lastAnchorIndex.value >= 0) {
    const start = Math.min(lastAnchorIndex.value, index);
    const end = Math.max(lastAnchorIndex.value, index);
    const paths = browseItems.value.slice(start, end + 1).filter((row) => row.type !== "dir").map((row) => row.path);
    selectedPaths.value = [...new Set([...selectedPaths.value, ...paths])];
  } else if (event.ctrlKey || event.metaKey) {
    togglePath(item.path);
  } else {
    selectedPaths.value = [item.path];
  }
  lastAnchorIndex.value = index;
}

function togglePath(path: string, force = false) {
  if (force) {
    selectedPaths.value = [...new Set([...selectedPaths.value, path])];
    return;
  }
  selectedPaths.value = selectedPathSet.value.has(path)
    ? selectedPaths.value.filter((item) => item !== path)
    : [...selectedPaths.value, path];
}

function selectAllFiles() {
  selectedPaths.value = fileItems.value.map((item) => item.path);
}

function clearSelectedFiles() {
  selectedPaths.value = [];
}

function invertSelectedFiles() {
  selectedPaths.value = fileItems.value.filter((item) => !selectedPathSet.value.has(item.path)).map((item) => item.path);
}

function removeSelected(path: string) {
  selectedPaths.value = selectedPaths.value.filter((item) => item !== path);
}

function isSelected(item: AlbumBrowseItem) {
  return selectedPathSet.value.has(item.path);
}

function selectAllCollectionItems() {
  selectedCollectionItemIds.value = collectionItems.value
    .map((item) => String(item.imageId || item.id || ""))
    .filter(Boolean);
}

function invertCollectionItems() {
  const selected = selectedCollectionItemSet.value;
  selectedCollectionItemIds.value = collectionItems.value
    .map((item) => String(item.imageId || item.id || ""))
    .filter((id) => id && !selected.has(id));
}

function handlePasteUpload(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  event.preventDefault();
  uploadFiles.value = [...uploadFiles.value, ...files];
  void uploadSelectedFiles();
}

function handleDropUpload(event: DragEvent) {
  const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith("image/"));
  if (!files.length) return;
  uploadFiles.value = [...uploadFiles.value, ...files];
  void uploadSelectedFiles();
}

function previewImageEnhanced(item: any) {
  const url = item?.originalPreviewUrl || item?.downloadUrl || item?.url || item?.previewUrl || item?.thumbnailUrl || "";
  if (!url) return;
  const imageId = String(item?.imageId || item?.id || "");
  imagePreviewDialog.open = true;
  imagePreviewDialog.url = assetUrl(url);
  imagePreviewDialog.title = item?.name || item?.originalName || item?.imageId || "图片预览";
  imagePreviewDialog.subtitle = item?.path || item?.sourcePath || "";
  imagePreviewDialog.imageId = imageId;
  imagePreviewDialog.targetImageIds = imageId ? [imageId] : [];
  imagePreviewDialog.mode = "original";
  imagePreviewDialog.ditherMode = effectiveDitherMode.value;
  imagePreviewDialog.rotateDeg = 0;
  imagePreviewDialog.cropX = 0;
  imagePreviewDialog.cropY = 0;
  imagePreviewDialog.cropWidth = 100;
  imagePreviewDialog.cropHeight = 100;
  imagePreviewDialog.e6Previews = [];
}

function handlePreviewModeChange() {
  if (imagePreviewDialog.mode === "e6") {
    void loadE6Preview();
  }
}

function rotatePreviewImage(delta: number) {
  imagePreviewDialog.rotateDeg = ((imagePreviewDialog.rotateDeg + delta) % 360 + 360) % 360;
  void loadE6Preview();
}

function resetPreviewCrop() {
  imagePreviewDialog.cropX = 0;
  imagePreviewDialog.cropY = 0;
  imagePreviewDialog.cropWidth = 100;
  imagePreviewDialog.cropHeight = 100;
  void loadE6Preview();
}

async function loadE6Preview() {
  if (imagePreviewDialog.mode !== "e6") return;
  const selectedIds = previewImageIds.value;
  if (!selectedIds.length) return;
  const seq = ++e6PreviewSeq;
  imagePreviewDialog.loading = true;
  try {
    const result = await previewE6Images(props.token, {
      imageIds: selectedIds,
      ditherMode: imagePreviewDialog.ditherMode,
      imageTransform: previewImageTransform.value,
    });
    if (seq !== e6PreviewSeq) return;
    imagePreviewDialog.e6Previews = result.previews || [];
  } catch (error) {
    ElMessage.error((error as Error).message || "E6预览生成失败");
  } finally {
    if (seq === e6PreviewSeq) imagePreviewDialog.loading = false;
  }
}

async function applyPreviewDitherToImages() {
  const imageIds = previewImageIds.value;
  if (!imageIds.length) {
    ElMessage.info("请选择要设置的图片");
    return;
  }
  savingPreviewDither.value = true;
  try {
    const result = await setE6ImageDitherMode(props.token, {
      imageIds,
      ditherMode: imagePreviewDialog.ditherMode,
      imageTransform: previewImageTransform.value,
    });
    ElMessage.success(result.count > 1 ? `已设置 ${result.count} 张图片` : "已设置当前图片");
    if (collectionForm.id) await loadCollectionDetail(collectionForm.id);
  } catch (error) {
    ElMessage.error((error as Error).message || "抖动方式保存失败");
  } finally {
    savingPreviewDither.value = false;
  }
}

function lassoPoint(event: MouseEvent) {
  const rect = browseGridRef.value?.getBoundingClientRect();
  return {
    x: event.clientX - (rect?.left || 0),
    y: event.clientY - (rect?.top || 0),
  };
}

function startBrowseLasso(event: MouseEvent) {
  if (event.button !== 0 || !browseGridRef.value) return;
  const point = lassoPoint(event);
  browseLasso.active = true;
  browseLasso.dragging = false;
  browseLasso.startX = point.x;
  browseLasso.startY = point.y;
  browseLasso.currentX = point.x;
  browseLasso.currentY = point.y;
  browseLasso.baseSelected = [...selectedPaths.value];
}

function moveBrowseLasso(event: MouseEvent) {
  if (!browseLasso.active || !browseGridRef.value) return;
  const point = lassoPoint(event);
  browseLasso.currentX = point.x;
  browseLasso.currentY = point.y;
  if (!browseLasso.dragging && Math.hypot(point.x - browseLasso.startX, point.y - browseLasso.startY) < 6) return;
  browseLasso.dragging = true;
  const gridRect = browseGridRef.value.getBoundingClientRect();
  const left = gridRect.left + Math.min(browseLasso.startX, browseLasso.currentX);
  const top = gridRect.top + Math.min(browseLasso.startY, browseLasso.currentY);
  const right = gridRect.left + Math.max(browseLasso.startX, browseLasso.currentX);
  const bottom = gridRect.top + Math.max(browseLasso.startY, browseLasso.currentY);
  const selected = new Set(browseLasso.baseSelected);
  browseGridRef.value.querySelectorAll<HTMLElement>(".album-tile[data-path]").forEach((node) => {
    if (node.dataset.type === "dir") return;
    const rect = node.getBoundingClientRect();
    const hit = rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top;
    if (hit && node.dataset.path) selected.add(node.dataset.path);
  });
  selectedPaths.value = Array.from(selected);
}

function endBrowseLasso() {
  browseLasso.active = false;
  browseLasso.dragging = false;
}

function collectionLassoPoint(event: MouseEvent) {
  const rect = collectionGridRef.value?.getBoundingClientRect();
  return {
    x: event.clientX - (rect?.left || 0),
    y: event.clientY - (rect?.top || 0),
  };
}

function startCollectionLasso(event: MouseEvent) {
  if (event.button !== 0 || !collectionGridRef.value) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest("button,input,label")) return;
  const point = collectionLassoPoint(event);
  collectionLasso.active = true;
  collectionLasso.dragging = false;
  collectionLasso.startX = point.x;
  collectionLasso.startY = point.y;
  collectionLasso.currentX = point.x;
  collectionLasso.currentY = point.y;
  collectionLasso.baseSelected = [...selectedCollectionItemIds.value];
}

function moveCollectionLasso(event: MouseEvent) {
  if (!collectionLasso.active || !collectionGridRef.value) return;
  const point = collectionLassoPoint(event);
  collectionLasso.currentX = point.x;
  collectionLasso.currentY = point.y;
  if (!collectionLasso.dragging && Math.hypot(point.x - collectionLasso.startX, point.y - collectionLasso.startY) < 6) return;
  collectionLasso.dragging = true;
  const gridRect = collectionGridRef.value.getBoundingClientRect();
  const left = gridRect.left + Math.min(collectionLasso.startX, collectionLasso.currentX);
  const top = gridRect.top + Math.min(collectionLasso.startY, collectionLasso.currentY);
  const right = gridRect.left + Math.max(collectionLasso.startX, collectionLasso.currentX);
  const bottom = gridRect.top + Math.max(collectionLasso.startY, collectionLasso.currentY);
  const selected = new Set(collectionLasso.baseSelected);
  collectionGridRef.value.querySelectorAll<HTMLElement>(".collection-item-thumb[data-image-id]").forEach((node) => {
    const imageId = String(node.dataset.imageId || "");
    if (!imageId) return;
    const rect = node.getBoundingClientRect();
    const hit = rect.left <= right && rect.right >= left && rect.top <= bottom && rect.bottom >= top;
    if (hit) selected.add(imageId);
  });
  selectedCollectionItemIds.value = Array.from(selected);
}

function endCollectionLasso() {
  collectionLasso.active = false;
  collectionLasso.dragging = false;
}

function goPath(path: string) {
  browse(path || "/");
}

async function importSelected() {
  if (!selectedSourceId.value || !selectedItems.value.length) return;
  importing.value = true;
  try {
    const payload: Record<string, any> = {
      sourceId: selectedSourceId.value,
      items: selectedItems.value.map((item) => ({ path: item.path, name: item.name })),
      targetCollectionId: activeCollectionId.value || undefined,
      dedupe: true,
      autoConvert: true,
      ditherMode: effectiveDitherMode.value,
    };
    if (importForm.newCollectionName.trim()) {
      payload.createCollection = {
        name: importForm.newCollectionName.trim(),
        playMode: "slideshow",
        slideIntervalSec: minutesToSeconds(importForm.slideIntervalMinutes),
        offlineSyncEnabled: true,
        targetDeviceType: "e6-color-frame",
      };
    }
    activeJob.value = await importAlbumImages(props.token, payload as any);
    ElMessage.success("导入任务已创建");
    pollJob();
  } catch (error) {
    ElMessage.error((error as Error).message || "导入失败");
  } finally {
    importing.value = false;
  }
}

function pollJob() {
  if (pollTimer) clearTimeout(pollTimer);
  const jobId = String(activeJob.value?.id || activeJob.value?.jobId || "");
  if (!jobId) return;
  pollTimer = setTimeout(async () => {
    try {
      activeJob.value = await fetchAlbumImportJob(props.token, jobId);
      const status = String(activeJob.value.status || "");
      if (["success", "failed", "partial_failed", "cancelled"].includes(status)) {
        await loadAll();
        await browse();
        if (collectionForm.id) await loadCollectionDetail(collectionForm.id);
        return;
      }
      pollJob();
    } catch (error) {
      ElMessage.error((error as Error).message || "任务状态读取失败");
    }
  }, 1600);
}

function handleUploadInput(event: Event) {
  const input = event.target as HTMLInputElement;
  uploadFiles.value = Array.from(input.files || []);
  if (uploadFiles.value.length) {
    void uploadSelectedFiles();
  }
}

function chunkUploadFiles(files: File[], size = UPLOAD_CHUNK_SIZE) {
  const chunks: File[][] = [];
  for (let index = 0; index < files.length; index += size) {
    chunks.push(files.slice(index, index + size));
  }
  return chunks;
}

async function uploadFileChunksWithLimit(
  chunks: File[][],
  getTargetCollectionId: () => string,
  onTargetCollectionId: (collectionId: string) => void,
  onSettledChunk: (files: File[]) => void
) {
  const uploaded: Array<{ imageId: string; originalName: string; size: number; mime: string; e6Ready?: boolean; e6Status?: string }> = [];
  const failed: Array<{ originalName: string; error: string }> = [];
  let cursor = 0;

  async function runNext() {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor];
      cursor += 1;
      try {
        const result = await uploadAlbumImages(props.token, {
          files: chunk,
          targetCollectionId: getTargetCollectionId() || activeCollectionId.value || undefined,
          slideIntervalSec: minutesToSeconds(importForm.slideIntervalMinutes),
          autoConvert: true,
          dedupe: true,
          ditherMode: effectiveDitherMode.value,
        });
        uploaded.push(...(result.files || []));
        failed.push(...(result.failed || []));
        if (result.collectionId) onTargetCollectionId(result.collectionId);
      } catch (error) {
        chunk.forEach((file) => {
          failed.push({
            originalName: file.name,
            error: (error as Error).message || "上传失败",
          });
        });
      } finally {
        onSettledChunk(chunk);
      }
    }
  }

  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, chunks.length) }, () => runNext());
  await Promise.all(workers);
  return { uploaded, failed };
}

async function uploadSelectedFiles() {
  if (!uploadFiles.value.length || uploading.value) return;
  const filesToUpload = [...uploadFiles.value];
  uploading.value = true;
    let targetCollectionId = activeCollectionId.value || "";
  const createCollectionName = targetCollectionId ? "" : importForm.newCollectionName.trim();
  try {
    const chunks = chunkUploadFiles(filesToUpload);
    const uploaded: Array<{ imageId: string; originalName: string; size: number; mime: string; e6Ready?: boolean; e6Status?: string }> = [];
    const failed: Array<{ originalName: string; error: string }> = [];
    const markSettled = (files: File[]) => {
      const doneSet = new Set(files);
      uploadFiles.value = uploadFiles.value.filter((item) => !doneSet.has(item));
    };
    const setTargetCollection = (collectionId: string) => {
      if (!collectionId) return;
      targetCollectionId = collectionId;
      importForm.targetCollectionId = collectionId;
    };

    if (createCollectionName && chunks.length) {
      const firstChunk = chunks.shift() || [];
      try {
        const result = await uploadAlbumImages(props.token, {
          files: firstChunk,
          createCollectionName,
          slideIntervalSec: minutesToSeconds(importForm.slideIntervalMinutes),
          autoConvert: true,
          dedupe: true,
          ditherMode: effectiveDitherMode.value,
        });
        uploaded.push(...(result.files || []));
        failed.push(...(result.failed || []));
        setTargetCollection(result.collectionId || "");
      } catch (error) {
        firstChunk.forEach((file) => {
          failed.push({ originalName: file.name, error: (error as Error).message || "上传失败" });
        });
      } finally {
        markSettled(firstChunk);
      }
    }

    const rest = await uploadFileChunksWithLimit(
      chunks,
      () => targetCollectionId,
      setTargetCollection,
      markSettled
    );
    uploaded.push(...rest.uploaded);
    failed.push(...rest.failed);

    if (!uploaded.length && failed.length) {
      throw new Error(failed[0]?.error || "上传失败");
    }
    ElMessage.success(failed.length ? `上传完成，${failed.length} 个失败` : "上传完成，E6文件后台生成中");
    uploadFiles.value = [];
    if (uploadInputRef.value) uploadInputRef.value.value = "";
    if (targetCollectionId) {
      selectedCollectionIds.value = [targetCollectionId];
      collectionForm.id = targetCollectionId;
    }
    await loadAll();
    if (targetCollectionId) await loadCollectionDetail(targetCollectionId);
  } catch (error) {
    ElMessage.error((error as Error).message || "上传失败");
  } finally {
    uploading.value = false;
  }
}

function newCollection() {
  Object.assign(collectionForm, {
    id: "",
    name: "",
    description: "",
    slideIntervalMinutes: playForm.slideIntervalMinutes,
    offlineSyncEnabled: playForm.offlineSyncEnabled,
  });
  collectionDetail.value = null;
}

function fillCollectionForm(collection: PlayCollectionRow) {
  Object.assign(collectionForm, {
    id: collection.id,
    name: collection.name || "",
    description: collection.description || "",
    slideIntervalMinutes: intervalMinutes(collection.slideIntervalSec),
    offlineSyncEnabled: collection.offlineSyncEnabled !== false,
  });
}

async function editCollection(collection: PlayCollectionRow) {
  fillCollectionForm(collection);
  if (!selectedCollectionSet.value.has(collection.id)) {
    selectedCollectionIds.value = [collection.id, ...selectedCollectionIds.value];
  }
  await loadCollectionDetail(collection.id);
}

async function loadCollectionDetail(id: string) {
  if (!id) return;
  const seq = ++detailSeq;
  try {
    const detail = await fetchPlayCollection(props.token, id);
    if (seq !== detailSeq && collectionForm.id !== id) return;
    collectionDetail.value = detail;
    collectionPreviewMap.value = {
      ...collectionPreviewMap.value,
      [id]: detail.items || [],
    };
  } catch (error) {
    ElMessage.error((error as Error).message || "集合详情读取失败");
  }
}

async function loadCollectionPreview(id: string) {
  if (!id || collectionPreviewMap.value[id] || previewLoadingIds.has(id)) return;
  previewLoadingIds.add(id);
  try {
    const detail = await fetchPlayCollection(props.token, id);
    collectionPreviewMap.value = {
      ...collectionPreviewMap.value,
      [id]: detail.items || [],
    };
  } catch (_) {
    collectionPreviewMap.value = {
      ...collectionPreviewMap.value,
      [id]: [],
    };
  } finally {
    previewLoadingIds.delete(id);
  }
}

function collectionPreviewItems(collectionId: string) {
  const fromDetail = collectionDetail.value?.id === collectionId ? collectionItems.value : [];
  return (fromDetail.length ? fromDetail : collectionPreviewMap.value[collectionId] || []).slice(0, 6);
}

function imagePreviewUrl(item: Partial<AlbumBrowseItem & PlayCollectionItemRow>) {
  return String(item.previewUrl || item.rawUrl || item.thumbnailUrl || item.providerThumbnailUrl || "");
}

function previewImage(item: Partial<AlbumBrowseItem & PlayCollectionItemRow>) {
  previewImageEnhanced(item);
}

async function removeCollectionItem(item: PlayCollectionItemRow) {
  if (!collectionForm.id || !item.imageId) return;
  try {
    await ElMessageBox.confirm("从集合中移除这张图片？原始图片不会被删除。", "移除图片", {
      type: "warning",
    });
  } catch (_) {
    return;
  }
  savingCollection.value = true;
  try {
    const nextItems = collectionItems.value
      .filter((row) => row.imageId !== item.imageId)
      .map((row, index) => ({ imageId: row.imageId, sortOrder: index + 1 }));
    const updatedItems = await setPlayCollectionItems(props.token, collectionForm.id, nextItems);
    collectionDetail.value = collectionDetail.value
      ? { ...collectionDetail.value, items: updatedItems }
      : collectionDetail.value;
    collectionPreviewMap.value = {
      ...collectionPreviewMap.value,
      [collectionForm.id]: updatedItems,
    };
    ElMessage.success("已从集合移除");
    await loadAll();
  } catch (error) {
    ElMessage.error((error as Error).message || "移除失败");
  } finally {
    savingCollection.value = false;
  }
}

async function saveCollection() {
  if (!collectionForm.name.trim()) {
    ElMessage.warning("请填写集合名称");
    return;
  }
  savingCollection.value = true;
  try {
    const payload = {
      name: collectionForm.name,
      description: collectionForm.description,
      slideIntervalSec: minutesToSeconds(collectionForm.slideIntervalMinutes),
      offlineSyncEnabled: collectionForm.offlineSyncEnabled,
      targetDeviceType: "e6-color-frame",
    };
    const saved = collectionForm.id
      ? await patchPlayCollection(props.token, collectionForm.id, payload)
      : await createPlayCollection(props.token, payload);
    ElMessage.success(collectionForm.id ? "集合已保存" : "集合已创建");
    collectionForm.id = saved.id;
    selectedCollectionIds.value = [saved.id, ...selectedCollectionIds.value.filter((id) => id !== saved.id)];
    await loadAll();
    await loadCollectionDetail(saved.id);
  } catch (error) {
    ElMessage.error((error as Error).message || "保存集合失败");
  } finally {
    savingCollection.value = false;
  }
}

async function deleteCollection() {
  if (!collectionForm.id) return;
  try {
    await ElMessageBox.confirm("删除集合会移除其中的播放关系，但不会删除原图。确认删除？", "删除集合", {
      type: "warning",
    });
  } catch (_) {
    return;
  }
  savingCollection.value = true;
  try {
    await deletePlayCollection(props.token, collectionForm.id);
    ElMessage.success("集合已删除");
    selectedCollectionIds.value = selectedCollectionIds.value.filter((id) => id !== collectionForm.id);
    newCollection();
    await loadAll();
  } catch (error) {
    ElMessage.error((error as Error).message || "删除集合失败");
  } finally {
    savingCollection.value = false;
  }
}

async function pushSelectedCollections() {
  const validCollectionIds = validSelectedCollectionIds.value;
  if (!validCollectionIds.length) {
    selectedCollectionIds.value = validCollectionIds;
    ElMessage.warning("请选择有效集合");
    return;
  }
  if (!selectedDeviceIds.value.length) return;
  if (validCollectionIds.length !== selectedCollectionIds.value.length) {
    selectedCollectionIds.value = validCollectionIds;
    ElMessage.warning("已移除不存在的集合，请重新确认后推送");
    return;
  }
  pushing.value = true;
  try {
    const result =
      validCollectionIds.length === 1
        ? await pushPlayCollection(props.token, validCollectionIds[0], selectedDeviceIds.value)
        : await pushMergedPlayCollections(props.token, validCollectionIds, selectedDeviceIds.value, {
            slideIntervalSec: minutesToSeconds(playForm.slideIntervalMinutes),
            loopEnabled: playForm.loopEnabled,
            offlineSyncEnabled: playForm.offlineSyncEnabled,
            dedupe: true,
          });
    const summary = summarizeCollectionPushResult(result);
    if (validCollectionIds.length > 1 && summary.sentCount > 0) {
      const prefix = summary.failedCount > 0 || summary.pendingCount > 0 ? "合并播放清单已下发" : "合并播放成功";
      const message = `${prefix}：已向 ${summary.sentCount} 台设备推送，共包含 ${validCollectionIds.length} 个集合、${Number(result.itemCount || 0)} 张图片。`;
      if (summary.failedCount > 0 || summary.pendingCount > 0) ElMessage.warning(message);
      else ElMessage.success(message);
    } else if (summary.successCount > 0 && summary.pendingCount === 0 && summary.failedCount === 0) {
      ElMessage.success(`已确认 ${summary.successCount} 台设备播放集合`);
    } else if (summary.sentCount > 0) {
      ElMessage.warning(`集合已下发，${summary.pendingCount} 台设备未确认，${summary.failedCount} 台失败`);
    } else {
      ElMessage.warning("集合未下发到设备");
    }
  } catch (error) {
    ElMessage.error((error as Error).message || "推送失败");
  } finally {
    pushing.value = false;
  }
}

function summarizeCollectionPushResult(result: Record<string, any>) {
  const rawRows = Array.isArray(result?.devices)
    ? result.devices
    : Array.isArray(result?.results)
      ? result.results
      : [];
  const rowsByDevice = new Map<string, Record<string, any>>();
  rawRows.forEach((row: Record<string, any>) => {
    const deviceId = String(row?.deviceId || "").trim();
    if (deviceId) rowsByDevice.set(deviceId, row);
  });
  let successCount = 0;
  let pendingCount = 0;
  let failedCount = 0;
  rowsByDevice.forEach((row) => {
    const state = String(row.ackState || row.state || "").toLowerCase();
    if (state === "success" || row.acked === true) successCount += 1;
    else if (state === "failed" || row.ok === false) failedCount += 1;
    else pendingCount += 1;
  });
  const sentCount = rowsByDevice.size || Number(result?.sentCount ?? result?.count ?? 0);
  return {
    sentCount,
    successCount: rowsByDevice.size ? successCount : Number(result?.ackedSuccessCount || 0),
    pendingCount: rowsByDevice.size ? pendingCount : Number(result?.ackedPendingCount || 0),
    failedCount: rowsByDevice.size ? failedCount : Number(result?.ackedFailedCount || 0),
  };
}

async function pushSinglePhoto() {
  const item = singlePlayableItem.value;
  if (!item?.imageId || !selectedDeviceIds.value.length) return;
  pushing.value = true;
  try {
    const collection = await createPlayCollection(props.token, {
      name: `单张-${item.name || item.imageId}`,
      playMode: "slideshow",
      slideIntervalSec: minutesToSeconds(playForm.slideIntervalMinutes),
      offlineSyncEnabled: playForm.offlineSyncEnabled,
      targetDeviceType: "e6-color-frame",
    });
    await setPlayCollectionItems(props.token, collection.id, [{ imageId: item.imageId, sortOrder: 1 }]);
    const result = await pushPlayCollection(props.token, collection.id, selectedDeviceIds.value);
    if (Number(result.ackedSuccessCount || 0) > 0) {
      ElMessage.success("单张播放已确认");
    } else {
      ElMessage.warning("单张播放已下发，设备未确认");
    }
    await loadAll();
  } catch (error) {
    ElMessage.error((error as Error).message || "单张播放失败");
  } finally {
    pushing.value = false;
  }
}

function selectAllDevices() {
  selectedDeviceIds.value = filteredE6Devices.value.map((item) => String(item.id));
}

function invertDevices() {
  const visibleIds = new Set(filteredE6Devices.value.map((item) => String(item.id)));
  const keepHidden = selectedDeviceIds.value.filter((id) => !visibleIds.has(id));
  const invertedVisible = filteredE6Devices.value.map((item) => String(item.id)).filter((id) => !selectedDeviceSet.value.has(id));
  selectedDeviceIds.value = [...keepHidden, ...invertedVisible];
}

function assetUrl(url = "") {
  if (!url) return "";
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin && props.token) parsed.searchParams.set("token", props.token);
    return parsed.origin === window.location.origin ? `${parsed.pathname}${parsed.search}` : parsed.toString();
  } catch (_) {
    return url;
  }
}

function statusTagType(status?: string) {
  if (status === "success") return "success";
  if (status === "failed") return "danger";
  return "info";
}

function collectionLabel(collection: PlayCollectionRow) {
  return `${collection.name}${collection.itemCount !== undefined ? ` · ${collection.itemCount}` : ""}`;
}

function intervalMinutes(seconds?: number) {
  return Math.max(1, Math.round(Number(seconds || DEFAULT_SLIDE_INTERVAL_MINUTES * 60) / 60));
}

function minutesToSeconds(minutes?: number) {
  return Math.max(60, Math.round(Number(minutes || 1) * 60));
}

function fileBadge(name = "") {
  const ext = String(name || "").split(".").pop()?.slice(0, 4).toUpperCase();
  return ext || "FILE";
}

function deviceDisplayName(device: Record<string, any>) {
  return String(device.displayName || device.remark || device.name || device.id || "E6设备");
}

function deviceOnline(device: Record<string, any>) {
  if (device.online !== undefined) return Boolean(device.online);
  if (device.isOnline !== undefined) return Boolean(device.isOnline);
  return String(device.status || "").toLowerCase() === "online";
}
</script>

<style scoped>
.album-dashboard {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.album-topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border: 1px solid #d8dee7;
  border-radius: 8px;
  background: #ffffff;
}

.album-topbar h3 {
  margin: 2px 0 4px;
  font-size: 22px;
}

.album-topbar p,
.album-topbar small,
.section-title small,
.panel-title small,
.content-head small,
.collection-pick small,
.collection-row small,
.device-main small {
  display: block;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

.eyebrow {
  color: #1d4ed8;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.topbar-actions,
.quick-row,
.mini-actions,
.browser-toolbar,
.path-row,
.target-row,
.form-actions,
.confirm-actions,
.dialog-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.album-workspace,
.mode-page {
  display: grid;
  grid-template-columns: minmax(230px, 0.8fr) minmax(310px, 1fr) minmax(460px, 1.55fr);
  gap: 12px;
  align-items: start;
}

.album-mode-pages {
  min-width: 0;
}

.play-photo-page {
  grid-template-columns: minmax(250px, 0.78fr) minmax(520px, 1.65fr) minmax(260px, 0.8fr);
}

.collection-editor-layout {
  grid-template-columns: minmax(290px, 0.9fr) minmax(360px, 1.05fr) minmax(520px, 1.55fr);
}

.album-panel {
  min-height: 720px;
  border: 1px solid #d8dee7;
  border-radius: 8px;
  background: #ffffff;
  padding: 14px;
  overflow: hidden;
}

.panel-title,
.section-title,
.content-head,
.selected-footer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.device-list,
.collection-pick-list,
.collection-list,
.source-chips {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  max-height: 560px;
  overflow: auto;
}

.play-collection-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(236px, 1fr));
  gap: 12px;
  max-height: 650px;
  overflow: auto;
  padding: 2px;
}

.device-row,
.collection-pick,
.collection-row,
.source-chip,
.collection-gallery-card {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  padding: 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  cursor: pointer;
}

.device-row.checked,
.collection-pick.checked,
.collection-row.active,
.source-chip.active,
.collection-gallery-card.checked {
  border-color: #2563eb;
  background: #eef6ff;
}

.device-row input,
.collection-pick input,
.collection-gallery-card input {
  width: 16px;
  height: 16px;
}

.device-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #94a3b8;
  flex: 0 0 auto;
}

.device-dot.online {
  background: #16a34a;
}

.device-main,
.collection-pick span,
.collection-row span,
.collection-gallery-main {
  min-width: 0;
  flex: 1;
}

.collection-gallery-card {
  align-items: flex-start;
  flex-direction: column;
}

.collection-gallery-card input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.collection-gallery-main {
  display: block;
  width: 100%;
}

.collection-preview-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  width: 100%;
}

.preview-thumb {
  aspect-ratio: 1.24;
  border-radius: 6px;
  background: #eef2f7;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: #64748b;
  font-size: 11px;
  font-style: normal;
  font-weight: 800;
}

.preview-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview-thumb.empty {
  grid-column: 1 / -1;
  height: 70px;
}

.album-mode-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 4px;
  background: #f1f5f9;
  border-radius: 8px;
  margin-bottom: 14px;
}

.album-mode-tabs button {
  height: 36px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #475569;
  cursor: pointer;
  font-weight: 700;
}

.album-mode-tabs button.active {
  background: #ffffff;
  color: #1d4ed8;
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
}

.mode-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.play-card,
.confirm-box {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 12px;
  background: #f8fafc;
}

.confirm-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.confirm-box p,
.memory-body p {
  color: #64748b;
  margin: 4px 0 0;
}

.collection-form {
  border-top: 1px solid #e2e8f0;
  padding-top: 12px;
}

.source-chips {
  max-height: 136px;
  margin-bottom: 12px;
}

.source-chip {
  justify-content: space-between;
}

.browser-toolbar {
  justify-content: space-between;
  border-top: 1px solid #e2e8f0;
  padding-top: 12px;
}

.path-row {
  min-width: 0;
}

.upload-zone {
  margin-top: 12px;
  border: 1px dashed #94a3b8;
  border-radius: 8px;
  background: #f8fafc;
  padding: 14px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.upload-zone span {
  color: #64748b;
  font-size: 12px;
}

.upload-input {
  display: none;
}

.target-row {
  margin-top: 10px;
  align-items: stretch;
}

.target-row .el-select {
  width: 190px;
}

.target-row .el-input {
  width: 230px;
}

.current-target {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 10px;
  border-radius: 6px;
  background: #f1f5f9;
  color: #334155;
  font-size: 12px;
  font-weight: 700;
}

.dither-row {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: #475569;
  font-size: 12px;
}

.dither-row .el-select {
  width: 150px;
}

.dither-label {
  font-weight: 700;
  color: #0f172a;
}

.album-grid {
  margin-top: 12px;
  min-height: 390px;
  max-height: 520px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  align-content: start;
  gap: 10px;
  overflow: auto;
  padding: 2px;
}

.album-tile {
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  min-height: 142px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  cursor: pointer;
}

.album-tile.selected {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.14);
}

.album-tile.dir {
  background: #f8fafc;
}

.tile-media,
.selected-thumb {
  border-radius: 6px;
  background: #eef2f7;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: #475569;
  font-size: 12px;
  font-weight: 800;
}

.tile-media {
  height: 84px;
}

.tile-media img,
.selected-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.tile-name {
  font-size: 12px;
  line-height: 1.35;
  min-height: 32px;
  word-break: break-word;
}

.selected-footer {
  border-top: 1px solid #e2e8f0;
  margin-top: 12px;
  padding-top: 12px;
}

.selected-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  min-height: 74px;
  padding-bottom: 4px;
}

.selected-thumb {
  position: relative;
  width: 72px;
  height: 58px;
  flex: 0 0 auto;
}

.selected-thumb.checked {
  border-color: #16a34a;
  background: #ecfdf5;
}

.thumb-check {
  position: absolute;
  z-index: 2;
  left: 4px;
  top: 4px;
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.88);
}

.thumb-check input {
  margin: 0;
}

.source-dialog-grid {
  position: relative;
  min-height: 300px;
  max-height: 48vh;
}

.lasso-box {
  position: absolute;
  z-index: 4;
  pointer-events: none;
  border: 1px solid #2563eb;
  background: rgba(37, 99, 235, 0.12);
}

.selected-thumb small {
  width: 100%;
  padding: 2px 4px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: #475569;
  font-size: 11px;
}

.collection-strip {
  position: relative;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  max-height: 620px;
  overflow: auto;
  min-height: 160px;
  padding: 2px;
  user-select: none;
}

.collection-item-thumb {
  width: 118px;
  height: 132px;
  flex-direction: column;
  justify-content: flex-start;
  padding: 6px;
  gap: 6px;
  box-sizing: border-box;
}

.thumb-preview {
  position: static;
  width: 100%;
  height: 76px;
  border: none;
  border-radius: 6px;
  padding: 0;
  background: #eef2f7;
  overflow: hidden;
  cursor: pointer;
}

.thumb-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.selected-thumb > button:not(.thumb-preview) {
  position: absolute;
  right: 2px;
  bottom: 2px;
  border: none;
  border-radius: 4px;
  background: rgba(15, 23, 42, 0.72);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
}

.preview-dialog-title {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.preview-dialog-title small {
  color: #64748b;
  font-size: 12px;
  word-break: break-all;
}

.preview-tools,
.preview-crop-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.preview-crop-tools {
  padding: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
}

.preview-crop-tools > span {
  color: #334155;
  font-size: 12px;
  font-weight: 700;
}

.preview-crop-tools label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #475569;
  font-size: 12px;
  white-space: nowrap;
}

.preview-crop-tools .el-input-number {
  width: 92px;
}

.preview-dialog-body {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 260px;
  max-height: 72vh;
  overflow: auto;
  background: #0f172a;
  border-radius: 8px;
}

.preview-dialog-body img {
  display: block;
  max-width: 100%;
  max-height: 72vh;
  object-fit: contain;
}

:global(.dark-mode) .album-dashboard {
  color: #e5e7eb;
}

:global(.dark-mode) .album-topbar,
:global(.dark-mode) .album-panel {
  border-color: #334155;
  background: #111827;
  color: #e5e7eb;
}

:global(.dark-mode) .album-topbar h3,
:global(.dark-mode) .panel-title strong,
:global(.dark-mode) .section-title strong,
:global(.dark-mode) .content-head strong,
:global(.dark-mode) .selected-footer-head strong,
:global(.dark-mode) .collection-row strong,
:global(.dark-mode) .collection-gallery-main strong,
:global(.dark-mode) .device-main strong,
:global(.dark-mode) .confirm-box strong,
:global(.dark-mode) .memory-body strong,
:global(.dark-mode) .upload-zone strong,
:global(.dark-mode) .dither-label {
  color: #f8fafc;
}

:global(.dark-mode) .album-topbar p,
:global(.dark-mode) .album-topbar small,
:global(.dark-mode) .section-title small,
:global(.dark-mode) .panel-title small,
:global(.dark-mode) .content-head small,
:global(.dark-mode) .collection-pick small,
:global(.dark-mode) .collection-row small,
:global(.dark-mode) .device-main small,
:global(.dark-mode) .collection-gallery-main small,
:global(.dark-mode) .confirm-box p,
:global(.dark-mode) .memory-body p,
:global(.dark-mode) .upload-zone span,
:global(.dark-mode) .dither-row,
:global(.dark-mode) .preview-dialog-title small {
  color: #94a3b8;
}

:global(.dark-mode) .preview-crop-tools {
  border-color: rgba(148, 163, 184, 0.22);
  background: rgba(15, 23, 42, 0.72);
}

:global(.dark-mode) .preview-crop-tools > span,
:global(.dark-mode) .preview-crop-tools label {
  color: #cbd5e1;
}

:global(.dark-mode) .current-target {
  background: #1e293b;
  color: #cbd5e1;
}

:global(.dark-mode) .selected-thumb.checked {
  border-color: #22c55e;
  background: rgba(34, 197, 94, 0.12);
}

:global(.dark-mode) .eyebrow {
  color: #60a5fa;
}

:global(.dark-mode) .album-mode-tabs {
  background: #0f172a;
  border: 1px solid #334155;
}

:global(.dark-mode) .album-mode-tabs button {
  color: #cbd5e1;
}

:global(.dark-mode) .album-mode-tabs button.active {
  background: #1e293b;
  color: #93c5fd;
  box-shadow: none;
}

:global(.dark-mode) .device-row,
:global(.dark-mode) .collection-pick,
:global(.dark-mode) .collection-row,
:global(.dark-mode) .source-chip,
:global(.dark-mode) .collection-gallery-card,
:global(.dark-mode) .album-tile {
  border-color: #334155;
  background: #172033;
  color: #e5e7eb;
}

:global(.dark-mode) .device-row.checked,
:global(.dark-mode) .collection-pick.checked,
:global(.dark-mode) .collection-row.active,
:global(.dark-mode) .source-chip.active,
:global(.dark-mode) .collection-gallery-card.checked,
:global(.dark-mode) .album-tile.selected {
  border-color: #60a5fa;
  background: #172b4d;
  box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.16);
}

:global(.dark-mode) .album-tile.dir,
:global(.dark-mode) .play-card,
:global(.dark-mode) .confirm-box,
:global(.dark-mode) .upload-zone {
  border-color: #334155;
  background: #0f172a;
}

:global(.dark-mode) .preview-thumb,
:global(.dark-mode) .tile-media,
:global(.dark-mode) .selected-thumb,
:global(.dark-mode) .thumb-preview {
  background: #1e293b;
  color: #cbd5e1;
}

:global(.dark-mode) .collection-form,
:global(.dark-mode) .browser-toolbar,
:global(.dark-mode) .selected-footer {
  border-color: #334155;
}

:global(.dark-mode) .tile-name,
:global(.dark-mode) .selected-thumb small {
  color: #dbeafe;
}

:global(.dark-mode) .path-row span {
  color: #64748b;
}

:global(html[data-theme="dark"]) .preview-dialog .el-dialog {
  background: #111827;
  color: #e5e7eb;
}

:global(html[data-theme="dark"]) .preview-dialog .el-dialog__header,
:global(html[data-theme="dark"]) .preview-dialog .el-dialog__body {
  color: #e5e7eb;
}

@media (max-width: 1180px) {
  .album-workspace,
  .mode-page,
  .play-photo-page,
  .collection-editor-layout {
    grid-template-columns: 1fr;
  }

  .album-panel {
    min-height: 0;
  }
}
</style>
