import { createRouter, createWebHashHistory } from "vue-router";
import UserApp from "../views/UserApp.vue";
import AdminApp from "../views/AdminApp.vue";
import SimulatorApp from "../views/SimulatorApp.vue";
import DocsApp from "../views/DocsApp.vue";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", redirect: "/user" },
    { path: "/user", component: UserApp },
    { path: "/admin", component: AdminApp },
    { path: "/simulator", component: SimulatorApp },
    { path: "/docs", component: DocsApp },
  ],
});

export default router;
