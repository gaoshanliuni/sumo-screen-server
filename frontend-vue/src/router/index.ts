import { createRouter, createWebHashHistory } from "vue-router";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/user" },
    { path: "/user", component: () => import("../views/UserApp.vue") },
    { path: "/admin", component: () => import("../views/AdminApp.vue") },
    { path: "/simulator", component: () => import("../views/SimulatorApp.vue") },
    { path: "/docs", component: () => import("../views/DocsApp.vue") },
    { path: "/homepage", redirect: "/pagestudio" }, // legacy/internal alias, kept for compatibility
    { path: "/pagestudio", component: () => import("../views/PageStudio.vue") }, // legacy/internal debug entry
  ],
});

export default router;
