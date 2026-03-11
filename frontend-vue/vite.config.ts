import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";

export default defineConfig({
  base: "/vue-app/",
  plugins: [vue()],
  build: {
    outDir: path.resolve(__dirname, "../frontend/vue-app"),
    emptyOutDir: true,
  },
});
