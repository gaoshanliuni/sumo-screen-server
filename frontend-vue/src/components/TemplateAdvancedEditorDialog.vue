<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="92vw"
    top="5vh"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="advanced-editor">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="这里编辑 API 模板的多步处理配置，保存后会回写到模板高级配置中。"
      />

      <el-form label-width="110px" size="small" class="advanced-form">
        <el-form-item label="输出模板">
          <el-input v-model="draft.output" type="textarea" :rows="4" placeholder="可选，留空则返回原始结果" />
        </el-form-item>
        <el-form-item label="超时(ms)">
          <el-input-number v-model="draft.timeoutMs" :min="0" :max="120000" />
        </el-form-item>
      </el-form>

      <div class="advanced-toolbar">
        <el-button type="primary" plain @click="addStep">新增步骤</el-button>
        <span class="advanced-tip">支持按顺序执行多步请求、提取和变量拼接。</span>
      </div>

      <div class="steps-wrap">
        <el-card v-for="(step, index) in draft.steps" :key="`step-${index}`" class="step-card" shadow="never">
          <template #header>
            <div class="step-header">
              <strong>步骤 {{ index + 1 }}</strong>
              <el-button link type="danger" @click="removeStep(index)">删除步骤</el-button>
            </div>
          </template>

          <el-form label-width="92px" size="small">
            <el-row :gutter="12">
              <el-col :xs="24" :md="8">
                <el-form-item label="名称">
                  <el-input v-model="step.name" placeholder="step name" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :md="8">
                <el-form-item label="方法">
                  <el-select v-model="step.method" style="width: 100%">
                    <el-option label="GET" value="GET" />
                    <el-option label="POST" value="POST" />
                    <el-option label="PUT" value="PUT" />
                    <el-option label="PATCH" value="PATCH" />
                    <el-option label="DELETE" value="DELETE" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :md="8">
                <el-form-item label="URL">
                  <el-input v-model="step.url" placeholder="https://..." />
                </el-form-item>
              </el-col>
            </el-row>

            <el-row :gutter="12">
              <el-col :xs="24" :md="12">
                <el-form-item label="Headers">
                  <div class="kv-editor">
                    <div v-for="(row, rowIndex) in step.headers" :key="`header-${index}-${rowIndex}`" class="kv-row">
                      <el-input v-model="row.key" placeholder="key" />
                      <el-input v-model="row.value" placeholder="value" />
                      <el-button link type="danger" @click="removePair(step.headers, rowIndex)">删除</el-button>
                    </div>
                    <el-button link type="primary" @click="addPair(step.headers)">新增</el-button>
                  </div>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :md="12">
                <el-form-item label="Query">
                  <div class="kv-editor">
                    <div v-for="(row, rowIndex) in step.params" :key="`param-${index}-${rowIndex}`" class="kv-row">
                      <el-input v-model="row.key" placeholder="key" />
                      <el-input v-model="row.value" placeholder="value" />
                      <el-button link type="danger" @click="removePair(step.params, rowIndex)">删除</el-button>
                    </div>
                    <el-button link type="primary" @click="addPair(step.params)">新增</el-button>
                  </div>
                </el-form-item>
              </el-col>
            </el-row>

            <el-row :gutter="12">
              <el-col :xs="24" :md="12">
                <el-form-item label="Body">
                  <div class="kv-editor">
                    <div v-for="(row, rowIndex) in step.body" :key="`body-${index}-${rowIndex}`" class="kv-row">
                      <el-input v-model="row.key" placeholder="key" />
                      <el-input v-model="row.value" placeholder="value" />
                      <el-button link type="danger" @click="removePair(step.body, rowIndex)">删除</el-button>
                    </div>
                    <el-button link type="primary" @click="addPair(step.body)">新增</el-button>
                  </div>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :md="12">
                <el-form-item label="提取规则">
                  <div class="extract-list">
                    <div v-for="(rule, ruleIndex) in step.extract" :key="`extract-${index}-${ruleIndex}`" class="extract-item">
                      <div class="extract-grid">
                        <el-select v-model="rule.type" size="small" style="width: 100px">
                          <el-option label="regex" value="regex" />
                          <el-option label="jsonpath" value="jsonpath" />
                        </el-select>
                        <el-select v-model="rule.source" size="small" style="width: 100px">
                          <el-option label="body" value="body" />
                          <el-option label="headers" value="headers" />
                          <el-option label="output" value="output" />
                        </el-select>
                        <el-input v-model="rule.pattern" size="small" placeholder="pattern / jsonpath" />
                        <el-input v-model="rule.path" size="small" placeholder="path" />
                        <el-input v-model="rule.saveAs" size="small" placeholder="saveAs" />
                        <el-input v-model="rule.group" size="small" placeholder="group" />
                        <el-input v-model="rule.flags" size="small" placeholder="flags" />
                        <el-button link type="danger" @click="removeExtract(index, ruleIndex)">删除</el-button>
                      </div>
                    </div>
                  </div>
                  <el-button link type="primary" @click="addExtract(index)">新增提取</el-button>
                </el-form-item>
              </el-col>
            </el-row>

            <el-form-item label="处理选项">
              <div class="options-row">
                <el-checkbox v-model="step.legacyCompat">legacyCompat</el-checkbox>
                <el-checkbox v-model="step.passInputParams">passInputParams</el-checkbox>
              </div>
            </el-form-item>
          </el-form>
        </el-card>
      </div>
    </div>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button type="primary" @click="onSave">保存配置</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, watch } from "vue";

type TemplateAdvancedExtract = {
  type: string;
  source: string;
  pattern: string;
  path: string;
  saveAs: string;
  group: string;
  flags: string;
};

type TemplateAdvancedStep = {
  name: string;
  method: string;
  url: string;
  legacyCompat: boolean;
  passInputParams: boolean;
  headers: Array<{ key: string; value: string }>;
  params: Array<{ key: string; value: string }>;
  body: Array<{ key: string; value: string }>;
  extract: TemplateAdvancedExtract[];
};

type TemplateAdvancedConfig = {
  output?: string;
  timeoutMs?: number;
  steps?: TemplateAdvancedStep[];
};

const props = defineProps<{
  modelValue: boolean;
  title?: string;
  config?: TemplateAdvancedConfig;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "save", value: TemplateAdvancedConfig): void;
}>();

function emptyPair() {
  return { key: "", value: "" };
}

function emptyExtract(): TemplateAdvancedExtract {
  return {
    type: "regex",
    source: "body",
    pattern: "",
    path: "",
    saveAs: "",
    group: "1",
    flags: "",
  };
}

function emptyStep(): TemplateAdvancedStep {
  return {
    name: "",
    method: "GET",
    url: "",
    legacyCompat: false,
    passInputParams: false,
    headers: [emptyPair()],
    params: [emptyPair()],
    body: [emptyPair()],
    extract: [emptyExtract()],
  };
}

function cloneConfig(input?: TemplateAdvancedConfig): TemplateAdvancedConfig {
  const source = input && typeof input === "object" ? input : {};
  const steps = Array.isArray(source.steps) && source.steps.length ? source.steps : [emptyStep()];
  return {
    output: String(source.output || ""),
    timeoutMs: Number(source.timeoutMs || 0),
    steps: steps.map((step) => ({
      name: String(step?.name || ""),
      method: String(step?.method || "GET").toUpperCase(),
      url: String(step?.url || ""),
      legacyCompat: Boolean(step?.legacyCompat),
      passInputParams: Boolean(step?.passInputParams),
      headers:
        Array.isArray(step?.headers) && step.headers.length
          ? step.headers.map((item) => ({ key: String(item?.key || ""), value: String(item?.value || "") }))
          : [emptyPair()],
      params:
        Array.isArray(step?.params) && step.params.length
          ? step.params.map((item) => ({ key: String(item?.key || ""), value: String(item?.value || "") }))
          : [emptyPair()],
      body:
        Array.isArray(step?.body) && step.body.length
          ? step.body.map((item) => ({ key: String(item?.key || ""), value: String(item?.value || "") }))
          : [emptyPair()],
      extract:
        Array.isArray(step?.extract) && step.extract.length
          ? step.extract.map((item) => ({
              type: String(item?.type || "regex"),
              source: String(item?.source || "body"),
              pattern: String(item?.pattern || ""),
              path: String(item?.path || ""),
              saveAs: String(item?.saveAs || ""),
              group: String(item?.group || "1"),
              flags: String(item?.flags || ""),
            }))
          : [emptyExtract()],
    })),
  };
}

const draft = reactive<TemplateAdvancedConfig>(cloneConfig(props.config));

watch(
  () => [props.modelValue, props.config],
  () => {
    Object.assign(draft, cloneConfig(props.config));
  },
  { deep: true, immediate: true }
);

function addStep() {
  draft.steps = [...(draft.steps || []), emptyStep()];
}

function removeStep(index: number) {
  const next = [...(draft.steps || [])];
  next.splice(index, 1);
  draft.steps = next.length ? next : [emptyStep()];
}

function addExtract(stepIndex: number) {
  const step = draft.steps?.[stepIndex];
  if (!step) return;
  step.extract = [...(step.extract || []), emptyExtract()];
}

function addPair(list: Array<{ key: string; value: string }>) {
  list.push(emptyPair());
}

function removePair(list: Array<{ key: string; value: string }>, index: number) {
  list.splice(index, 1);
  if (!list.length) {
    list.push(emptyPair());
  }
}

function removeExtract(stepIndex: number, extractIndex: number) {
  const step = draft.steps?.[stepIndex];
  if (!step) return;
  const next = [...(step.extract || [])];
  next.splice(extractIndex, 1);
  step.extract = next.length ? next : [emptyExtract()];
}

function normalizeStepList() {
  draft.steps = (draft.steps || []).map((step) => ({
    name: String(step.name || "").trim(),
    method: String(step.method || "GET").toUpperCase(),
    url: String(step.url || "").trim(),
    legacyCompat: Boolean(step.legacyCompat),
    passInputParams: Boolean(step.passInputParams),
    headers: (step.headers || []).filter((item) => String(item.key || "").trim() || String(item.value || "").trim()),
    params: (step.params || []).filter((item) => String(item.key || "").trim() || String(item.value || "").trim()),
    body: (step.body || []).filter((item) => String(item.key || "").trim() || String(item.value || "").trim()),
    extract: (step.extract || []).filter(
      (item) => String(item.saveAs || "").trim() || String(item.pattern || "").trim() || String(item.path || "").trim()
    ),
  }));
}

function onSave() {
  normalizeStepList();
  emit("save", cloneConfig(draft));
  emit("update:modelValue", false);
}
</script>

<style scoped>
.advanced-editor {
  display: grid;
  gap: 12px;
}

.advanced-form {
  background: #f8fafc;
  padding: 12px 14px 4px;
  border-radius: 12px;
}

.advanced-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.advanced-tip {
  color: #64748b;
  font-size: 12px;
}

.steps-wrap {
  display: grid;
  gap: 12px;
  max-height: 62vh;
  overflow: auto;
  padding-right: 4px;
}

.step-card {
  border-radius: 14px;
}

.step-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.extract-list {
  display: grid;
  gap: 8px;
  width: 100%;
}

.extract-item {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 8px;
  background: #fff;
}

.extract-grid {
  display: grid;
  grid-template-columns: 100px 100px 1fr 1fr 1fr 88px 1fr 64px;
  gap: 8px;
  align-items: center;
}

.options-row {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.kv-editor {
  display: grid;
  gap: 8px;
  width: 100%;
}

.kv-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 8px;
  align-items: center;
}
</style>
