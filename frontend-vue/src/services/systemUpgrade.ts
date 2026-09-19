import { apiRequest } from "./api";

export type SystemUpgradeRuntime = {
  release: {
    appId: string;
    version: string;
    channel: string;
    buildTime: string;
    buildId: string;
    developerBuild: boolean;
  };
  runtime: {
    platform: string;
    nodeVersion: string;
    container: boolean;
    subsystemEnabled: boolean;
    subsystemStatus: string;
    busy: boolean;
    lastError: string;
    lastErrorAt: string;
    lastUpgradeResult: any;
    pendingPackageId: string;
    hasPublicKey: boolean;
    hasPrivateKey: boolean;
    allowDevPackageInstall: boolean;
    allowDevDowngrade: boolean;
    allowUnsignedDevPackage: boolean;
    allowSameVersionDevReplace: boolean;
    channel: string;
    upgradeServerSummary: {
      enabled: boolean;
      baseUrl: string;
      latestPath: string;
      hasToken: boolean;
    };
    updatedAt: string;
  };
  config: any;
  latestPackage?: any;
  tasks?: any[];
  recentBuilds?: any[];
  recentInstalls?: any[];
};

export async function getSystemUpgradeRuntime(token: string) {
  return await apiRequest<SystemUpgradeRuntime>("/api/system-upgrade/runtime", { token });
}

export async function getSystemUpgradeConfig(token: string) {
  return await apiRequest<any>("/api/system-upgrade/config", { token });
}

export async function saveSystemUpgradeConfig(token: string, payload: any) {
  return await apiRequest<any>("/api/system-upgrade/config", {
    method: "POST",
    token,
    body: JSON.stringify(payload || {}),
  });
}

export async function verifySystemUpgradeAdmin(token: string, password: string) {
  return await apiRequest<{ packageBuildToken: string; expireAt: string; ttlMs: number }>(
    "/api/system-upgrade/admin-verify",
    {
      method: "POST",
      token,
      body: JSON.stringify({ password }),
    }
  );
}

export async function uploadSystemUpgradeSourceZip(token: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  return await apiRequest<any>("/api/system-upgrade/source-upload", {
    method: "POST",
    token,
    body: form,
  });
}

export async function startBuildSystemUpgradePackage(token: string, payload: any) {
  return await apiRequest<any>("/api/system-upgrade/build-package", {
    method: "POST",
    token,
    body: JSON.stringify(payload || {}),
  });
}

export async function getSystemUpgradeBuildTask(token: string, taskId: string) {
  return await apiRequest<any>(`/api/system-upgrade/build-task/${encodeURIComponent(taskId)}`, {
    token,
  });
}

export async function getSystemUpgradeTask(token: string, taskId: string) {
  return await apiRequest<any>(`/api/system-upgrade/task/${encodeURIComponent(taskId)}`, {
    token,
  });
}

export async function getSystemUpgradeBuiltPackages(token: string) {
  return await apiRequest<any>("/api/system-upgrade/built-packages", { token });
}

export async function uploadSystemUpgradePackageZip(token: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  return await apiRequest<any>("/api/system-upgrade/upload", {
    method: "POST",
    token,
    body: form,
  });
}

export async function startSystemUpgradeVerify(token: string, packageId: string) {
  return await apiRequest<any>(`/api/system-upgrade/verify/${encodeURIComponent(packageId)}`, {
    method: "POST",
    token,
    body: JSON.stringify({}),
  });
}

export async function startSystemUpgradeInstall(token: string, packageId: string) {
  return await apiRequest<any>(`/api/system-upgrade/install/${encodeURIComponent(packageId)}`, {
    method: "POST",
    token,
    body: JSON.stringify({}),
  });
}

export async function startSystemUpgradeFetchRemote(token: string, payload: { url?: string; packageName?: string }) {
  return await apiRequest<any>("/api/system-upgrade/fetch-remote", {
    method: "POST",
    token,
    body: JSON.stringify(payload || {}),
  });
}

export async function getSystemUpgradeHistory(token: string) {
  return await apiRequest<any[]>("/api/system-upgrade/history", { token });
}
