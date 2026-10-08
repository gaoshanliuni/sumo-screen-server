import { defineStore } from "pinia";
import { ref } from "vue";
import { apiRequest } from "../services/api";

export type AppRole = "user" | "admin";

type LoginResult = {
  token: string;
  user: {
    id: string;
    username: string;
    role: string;
    nickname: string;
  };
};

export const useAuthStore = defineStore("auth", () => {
  const token = ref(localStorage.getItem("vue_token") || "");
  const userId = ref("");
  const lastUsername = ref(
    localStorage.getItem("vue_last_username") ||
      localStorage.getItem("vue_username") ||
      ""
  );
  const username = ref(localStorage.getItem("vue_username") || "");
  const role = ref<AppRole>((localStorage.getItem("vue_role") as AppRole) || "user");

  async function login(nextRole: AppRole, loginName: string, password: string) {
    const trimmedLoginName = String(loginName || "").trim();
    const data = await apiRequest<LoginResult>(`/api/auth/${nextRole}/login`, {
      method: "POST",
      body: JSON.stringify({ username: trimmedLoginName, password }),
    });
    token.value = data.token;
    userId.value = data.user.id;
    username.value = data.user.username;
    lastUsername.value = data.user.username || trimmedLoginName;
    role.value = nextRole;
    localStorage.setItem("vue_token", token.value);
    localStorage.setItem("vue_role", role.value);
    localStorage.setItem("vue_username", username.value);
    localStorage.setItem("vue_last_username", lastUsername.value);
    // Legacy pages still read these keys.
    localStorage.setItem(nextRole === "admin" ? "admin_token" : "user_token", token.value);
  }

  function logout() {
    const currentRole = role.value;
    token.value = "";
    userId.value = "";
    username.value = "";
    localStorage.removeItem("vue_token");
    localStorage.removeItem("vue_username");
    localStorage.removeItem("vue_role");
    localStorage.removeItem(currentRole === "admin" ? "admin_token" : "user_token");
  }

  return {
    token,
    userId,
    username,
    lastUsername,
    role,
    login,
    logout,
  };
});
