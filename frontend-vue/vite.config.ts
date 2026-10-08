import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

export default defineConfig({
  base: "/vue-app/",
  plugins: [vue()],
  build: {
    outDir: path.resolve(__dirname, "../frontend/vue-app"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("/node_modules/element-plus/es/components/table/") ||
            id.includes("/node_modules/element-plus/es/components/table-column/")
          ) {
            return "element-plus-table";
          }
          if (id.includes("/node_modules/element-plus/")) return "element-plus";
          if (
            id.includes("/node_modules/vue/") ||
            id.includes("/node_modules/vue-router/") ||
            id.includes("/node_modules/pinia/")
          ) {
            return "vue-vendor";
          }
          return undefined;
        },
      },
    },
  },
});
