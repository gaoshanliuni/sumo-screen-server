<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from "vue";

onMounted(() => {
  const saved = localStorage.getItem("ink-screen-theme") || "light";
  document.documentElement.dataset.theme = saved === "dark" ? "dark" : "light";
});
</script>

<style>
:root {
  font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif;
  color: #1d232f;
  background: #f5f7fa;
}

body {
  margin: 0;
  background: #f5f7fa;
}

html[data-theme="dark"] {
  color-scheme: dark;
  --el-bg-color: #0f172a;
  --el-bg-color-page: #020617;
  --el-bg-color-overlay: #111827;
  --el-fill-color: #172033;
  --el-fill-color-light: #1b2539;
  --el-fill-color-lighter: #243047;
  --el-fill-color-blank: #0f172a;
  --el-text-color-primary: #e5edf7;
  --el-text-color-regular: #cbd5e1;
  --el-text-color-secondary: #94a3b8;
  --el-border-color: #2b3548;
  --el-border-color-light: #334155;
  --el-border-color-lighter: #3a475c;
  --el-mask-color: rgba(2, 6, 23, 0.8);
  --el-overlay-color: rgba(2, 6, 23, 0.82);
  --el-box-shadow: 0 20px 48px rgba(2, 6, 23, 0.45);
}

html[data-theme="dark"] body {
  background:
    radial-gradient(circle at top left, rgba(56, 189, 248, 0.12), transparent 28%),
    radial-gradient(circle at top right, rgba(59, 130, 246, 0.12), transparent 24%),
    linear-gradient(180deg, #020617 0%, #0f172a 100%);
  color: #e5edf7;
}
</style>
