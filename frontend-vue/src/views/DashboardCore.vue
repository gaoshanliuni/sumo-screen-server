<template>
  <div class="page" :class="{ 'dark-mode': darkMode }">
    <el-card class="panel">
      <template #header>
        <div class="header-row">
          <div class="header-left">
            <el-button v-if="isMobile" class="menu-toggle" plain @click="toggleSidebar">
              {{ mobileNavOpen ? "关闭菜单" : "菜单" }}
            </el-button>
            <el-button v-else-if="!sidebarCollapsed" class="menu-toggle menu-toggle-icon" circle plain @click="toggleSidebar" title="收起侧栏">
              ☰
            </el-button>
            <strong>{{ title }}</strong>
          </div>
          <div v-if="auth.token" class="header-user">
            <div class="theme-toggle">
              <span class="theme-label">{{ darkMode ? "夜间" : "日间" }}</span>
              <el-switch v-model="darkMode" inline-prompt active-text="夜" inactive-text="昼" @change="toggleDarkMode" />
            </div>
            <span class="header-username">当前用户：{{ auth.username }}</span>
            <el-button type="danger" plain @click="logout">退出登录</el-button>
          </div>
        </div>
      </template>

      <div v-if="!auth.token" class="login-wrap">
        <el-form :model="loginForm" label-width="90px" @submit.prevent>
          <el-form-item label="用户名"><el-input v-model="loginForm.username" autocomplete="username" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="loginForm.password" show-password autocomplete="current-password" /></el-form-item>
          <el-button type="primary" :loading="loginLoading" @click="doLogin">登录</el-button>
        </el-form>
      </div>

      <el-container v-else class="workbench-shell">
        <el-drawer
          v-model="mobileNavOpen"
          class="mobile-nav-drawer"
          direction="ltr"
          :show-close="true"
          :with-header="false"
          append-to-body
          size="86%"
        >
          <div class="drawer-shell">
            <div class="drawer-title">
              <strong>功能菜单</strong>
              <span class="drawer-hint">点击切换页面</span>
            </div>
            <el-menu :default-active="activePanel" class="drawer-menu" @select="onSelectPanel">
              <el-menu-item v-for="item in sidebarMenuItems" :key="item.index" :index="item.index">
                <span class="menu-item-content">
                  <svg class="menu-svg" viewBox="0 0 24 24" aria-hidden="true">
                    <path :d="iconPaths[item.icon] || iconPaths.default" />
                  </svg>
                  <span>{{ item.label }}</span>
                </span>
              </el-menu-item>
            </el-menu>
          </div>
        </el-drawer>

        <el-aside v-if="!isMobile && !sidebarCollapsed" width="220px" class="aside-nav">
          <el-menu
            :default-active="activePanel"
            class="side-menu"
            @select="onSelectPanel"
          >
            <el-menu-item v-for="item in sidebarMenuItems" :key="item.index" :index="item.index">
              <span class="menu-item-content">
                <svg class="menu-svg" viewBox="0 0 24 24" aria-hidden="true">
                  <path :d="iconPaths[item.icon] || iconPaths.default" />
                </svg>
                <span>{{ item.label }}</span>
              </span>
            </el-menu-item>
          </el-menu>
        </el-aside>

        <div v-if="!isMobile && sidebarCollapsed" class="sidebar-rail">
          <el-button class="sidebar-rail-button" plain @click="toggleSidebar">☰</el-button>
        </div>

        <el-main class="content-main">
          <section v-if="activePanel === 'overview'" class="section-wrap">
            <div class="overview-hero">
              <div>
                <div class="overview-eyebrow">平台总览</div>
                <h3>主页概览</h3>
                <div class="overview-summary">
                  当前共有 {{ overview.deviceTotal }} 台设备，其中 {{ overview.deviceOnline }} 台在线，绑定率 {{ overviewBoundRate }}。
                </div>
              </div>
              <el-button @click="refreshOverview">刷新概览</el-button>
            </div>
            <div class="overview-grid">
              <el-card v-for="card in overviewCards" :key="card.key" class="overview-card" shadow="hover">
                <div class="overview-card-label">{{ card.label }}</div>
                <div class="overview-card-value">{{ card.value }}</div>
                <div class="overview-card-note">{{ card.note }}</div>
              </el-card>
            </div>
          </section>

          <section v-if="activePanel === 'account'" class="section-wrap">
            <h3>账号管理</h3>
            <el-card>
              <el-form :model="passwordForm" label-width="110px" size="small">
                <el-form-item label="旧密码"><el-input v-model="passwordForm.oldPassword" show-password /></el-form-item>
                <el-form-item label="新密码"><el-input v-model="passwordForm.newPassword" show-password /></el-form-item>
              </el-form>
              <div class="row-actions">
                <el-button type="primary" @click="changePassword">修改密码</el-button>
              </div>
            </el-card>

            <el-card v-if="isAdmin">
              <template #header>
                <div class="row-actions">
                  <strong>管理员用户管理</strong>
                  <el-button @click="loadAdminUsers">刷新账号列表</el-button>
                </div>
              </template>
              <el-form :model="adminUserCreateForm" label-width="100px" size="small">
                <el-form-item label="用户名"><el-input v-model="adminUserCreateForm.username" /></el-form-item>
                <el-form-item label="密码"><el-input v-model="adminUserCreateForm.password" show-password /></el-form-item>
                <el-form-item label="角色">
                  <el-select v-model="adminUserCreateForm.role">
                    <el-option label="user" value="user" />
                    <el-option label="admin" value="admin" />
                  </el-select>
                </el-form-item>
                <el-form-item label="昵称"><el-input v-model="adminUserCreateForm.nickname" /></el-form-item>
              </el-form>
              <div class="row-actions">
                <el-button type="primary" @click="createAdminUser">创建账号</el-button>
              </div>
              <el-divider />
              <el-table :data="adminUsers" height="300" size="small">
                <el-table-column prop="username" label="用户名" min-width="120" />
                <el-table-column label="角色" width="110">
                  <template #default="scope">
                    <el-select v-model="scope.row.role" style="width:100%">
                      <el-option label="user" value="user" />
                      <el-option label="admin" value="admin" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="状态" width="120">
                  <template #default="scope">
                    <el-select v-model="scope.row.status" style="width:100%">
                      <el-option label="enabled" value="enabled" />
                      <el-option label="blocked" value="blocked" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="昵称" min-width="120">
                  <template #default="scope"><el-input v-model="scope.row.nickname" /></template>
                </el-table-column>
                <el-table-column label="新密码" min-width="120">
                  <template #default="scope"><el-input v-model="scope.row._newPassword" show-password placeholder="可空" /></template>
                </el-table-column>
                <el-table-column label="设备数" width="80">
                  <template #default="scope">{{ scope.row.deviceCount || 0 }}</template>
                </el-table-column>
                <el-table-column label="删除模式" width="120">
                  <template #default="scope">
                    <el-select v-model="scope.row._deleteMode" style="width:100%">
                      <el-option label="detach" value="detach" />
                      <el-option label="purge" value="purge" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="160">
                  <template #default="scope">
                    <el-button link type="primary" @click="updateAdminUser(scope.row)">更新</el-button>
                    <el-button link type="danger" @click="deleteAdminUser(scope.row)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>

              <el-divider />
              <strong>账号资源处理</strong>
              <el-form :model="adminResourceForm" label-width="110px" size="small" style="margin-top:8px">
                <el-form-item label="账号">
                  <el-select v-model="adminResourceForm.userId" filterable style="width:100%">
                    <el-option v-for="u in adminUsers" :key="u.id" :label="`${u.username} (${u.id})`" :value="u.id" />
                  </el-select>
                </el-form-item>
                <el-form-item label="动作">
                  <el-select v-model="adminResourceForm.action" style="width:100%">
                    <el-option label="detach 解绑设备" value="detach" />
                    <el-option label="transfer 迁移设备" value="transfer" />
                    <el-option label="purge 清理资源" value="purge" />
                  </el-select>
                </el-form-item>
                <el-form-item label="目标账号">
                  <el-select v-model="adminResourceForm.targetUserId" filterable style="width:100%">
                    <el-option v-for="u in adminUsers" :key="u.id" :label="`${u.username} (${u.id})`" :value="u.id" />
                  </el-select>
                </el-form-item>
              </el-form>
              <div class="row-actions">
                <el-button type="warning" @click="applyAdminUserResources">执行资源处理</el-button>
              </div>
            </el-card>
          </section>

          <section v-if="activePanel === 'ai'" class="section-wrap ai-page-wrap">
            <AiChatPanel
              :token="auth.token"
              :effective-text="aiEffectiveText"
              :initial-thinking-enabled="aiConfigForm.thinkingEnabled"
              @open-settings="openAiSettingsDrawer"
            />
          </section>

          <el-drawer v-model="aiSettingsDrawerOpen" title="AI设置" direction="rtl" size="min(720px, 92%)" append-to-body>
            <div class="ai-settings-drawer">
              <el-card>
                <template #header>我的 AI 配置</template>
                <el-form :model="aiConfigForm" label-width="98px" size="small">
                  <el-form-item label="名称"><el-input v-model="aiConfigForm.name" placeholder="我的 DeepSeek" /></el-form-item>
                  <el-form-item label="提供商">
                    <el-select v-model="aiConfigForm.provider" style="width:100%">
                      <el-option label="DeepSeek" value="deepseek" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="接入 URL"><el-input v-model="aiConfigForm.baseUrl" placeholder="https://api.deepseek.com" /></el-form-item>
                  <el-form-item label="模型"><el-input v-model="aiConfigForm.model" placeholder="deepseek-chat" /></el-form-item>
                  <el-form-item label="API Key"><el-input v-model="aiConfigForm.apiKey" show-password placeholder="留空则保留原密钥" /></el-form-item>
                  <el-form-item label="启用"><el-switch v-model="aiConfigForm.enabled" /></el-form-item>
                  <el-form-item label="思考模式"><el-switch v-model="aiConfigForm.thinkingEnabled" /></el-form-item>
                </el-form>
                <div class="row-actions">
                  <el-button @click="loadAiConfig">刷新</el-button>
                  <el-button type="primary" :loading="aiConfigLoading" @click="saveAiConfig">保存我的 AI 配置</el-button>
                  <el-tag>{{ aiEffectiveText }}</el-tag>
                </div>
              </el-card>

              <el-card v-if="isAdmin">
                <template #header>管理员批量分配</template>
                <el-form label-width="98px" size="small">
                  <el-form-item label="配置名"><el-input v-model="adminAiConfigForm.name" /></el-form-item>
                  <el-form-item label="接入 URL"><el-input v-model="adminAiConfigForm.baseUrl" placeholder="https://api.deepseek.com" /></el-form-item>
                  <el-form-item label="模型"><el-input v-model="adminAiConfigForm.model" placeholder="deepseek-chat" /></el-form-item>
                  <el-form-item label="API Key"><el-input v-model="adminAiConfigForm.apiKey" show-password /></el-form-item>
                  <el-form-item label="配置">
                    <el-select v-model="adminAiAssignForm.configId" filterable style="width:100%">
                      <el-option v-for="cfg in adminAiConfigs" :key="cfg.id" :label="`${cfg.name} · ${cfg.model} · ${cfg.apiKeyMask || '未设Key'}`" :value="cfg.id" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="用户">
                    <el-select v-model="adminAiAssignForm.userIds" multiple filterable style="width:100%">
                      <el-option v-for="u in adminUsers" :key="u.id" :label="ownerOptionLabel(u)" :value="u.id" />
                    </el-select>
                  </el-form-item>
                </el-form>
                <div class="row-actions">
                  <el-button @click="loadAdminAiConfigs">刷新配置</el-button>
                  <el-button type="primary" @click="createAdminAiProvider">新建配置</el-button>
                  <el-button type="warning" @click="assignAdminAiProvider">批量分配</el-button>
                </div>
              </el-card>
            </div>
          </el-drawer>

          <section v-if="activePanel === 'devicePin'" class="section-wrap">
            <h3>设备与PIN</h3>
            <el-row :gutter="12">
              <el-col :md="12" :xs="24">
                <el-card>
                  <el-form label-width="110px" size="small">
                    <el-form-item label="当前设备">
                      <el-select v-model="singleDeviceId" filterable style="width:100%" @change="onSingleDeviceChanged">
                        <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="显示名字"><el-input v-model="deviceEditForm.displayName" placeholder="设备显示名称（可空）" /></el-form-item>
                    <el-form-item label="备注"><el-input v-model="deviceEditForm.remark" /></el-form-item>
                    <el-form-item v-if="isAdmin" label="状态">
                      <el-select v-model="deviceEditForm.status">
                        <el-option label="enabled" value="enabled" />
                        <el-option label="blocked" value="blocked" />
                      </el-select>
                    </el-form-item>
                    <el-form-item v-if="isAdmin" label="归属用户">
                      <el-select v-model="deviceEditForm.ownerId" clearable filterable style="width:100%" placeholder="选择归属用户">
                        <el-option v-for="u in ownerSelectOptions" :key="u.id" :label="ownerOptionLabel(u)" :value="u.id" />
                      </el-select>
                    </el-form-item>
                  </el-form>
                  <div class="row-actions">
                    <el-button type="primary" @click="updateCurrentDevice">保存设备信息</el-button>
                    <el-button type="danger" @click="deleteCurrentDevice">删除当前设备</el-button>
                  </div>
                </el-card>
              </el-col>
              <el-col :md="12" :xs="24">
                <el-card>
                  <el-form :model="bindForm" label-width="110px" size="small">
                    <el-form-item label="PIN"><el-input v-model="bindForm.pin" placeholder="6位数字PIN" /></el-form-item>
                    <el-form-item v-if="isAdmin" label="归属用户">
                      <el-select v-model="bindForm.ownerId" clearable filterable style="width:100%" placeholder="管理员可指定用户">
                        <el-option v-for="u in ownerSelectOptions" :key="u.id" :label="ownerOptionLabel(u)" :value="u.id" />
                      </el-select>
                    </el-form-item>
                  </el-form>
                  <div class="row-actions">
                    <el-button type="primary" @click="bindByPin">PIN绑定设备</el-button>
                  </div>
                </el-card>
              </el-col>
            </el-row>
          </section>

          <section v-if="activePanel === 'todo'" class="section-wrap">
            <div class="row-actions">
              <h3>TODO</h3>
              <el-select v-model="todoDeviceId" filterable style="width:380px" @change="loadTodoRows">
                <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
              </el-select>
              <el-button @click="addTodoRow">新增行</el-button>
              <el-button @click="loadTodoRows">刷新</el-button>
              <el-button type="primary" @click="saveTodoRows">保存</el-button>
            </div>
            <el-card>
              <template #header>批量下发 TODO（相同内容/正则）</template>
              <el-form :model="todoBatchForm" inline label-width="98px" size="small">
                <el-form-item label="模式">
                  <el-select v-model="todoBatchForm.mode" style="width:140px">
                    <el-option label="相同内容" value="same" />
                    <el-option label="正则替换" value="regex" />
                    <el-option label="模板变量" value="template" />
                  </el-select>
                </el-form-item>
                <el-form-item label="内容模板"><el-input v-model="todoBatchForm.content" style="width:420px" placeholder="支持 {{displayName}} / {{remark}} / {{deviceId}}" /></el-form-item>
                <el-form-item v-if="todoBatchForm.mode === 'regex'" label="源文本"><el-input v-model="todoBatchForm.regexSource" style="width:300px" placeholder="可带模板变量" /></el-form-item>
                <el-form-item v-if="todoBatchForm.mode === 'regex'" label="正则"><el-input v-model="todoBatchForm.regexPattern" style="width:180px" placeholder="例如 \\{\\{name\\}\\}" /></el-form-item>
                <el-form-item v-if="todoBatchForm.mode === 'regex'" label="替换"><el-input v-model="todoBatchForm.regexReplace" style="width:180px" placeholder="例如 {{displayName}}" /></el-form-item>
                <el-form-item label="优先级"><el-input-number v-model="todoBatchForm.priority" :min="0" :max="99" /></el-form-item>
                <el-form-item label="完成"><el-switch v-model="todoBatchForm.done" /></el-form-item>
                <el-form-item label="覆盖清空"><el-switch v-model="todoBatchForm.replace" /></el-form-item>
                <el-form-item label="设备池">
                  <el-select v-model="todoBatchClusterIds" multiple clearable filterable style="width:320px" placeholder="选择设备池">
                    <el-option v-for="c in clusters" :key="c.id" :label="c.name" :value="c.id" />
                  </el-select>
                </el-form-item>
              </el-form>
              <div class="row-actions">
                <el-button @click="openDispatchPicker('todo')">弹窗选择设备</el-button>
                <el-tag type="warning">已选设备 {{ batchTargetDeviceIds.todo.length }} 台</el-tag>
                <el-tag>已选设备池 {{ todoBatchClusterIds.length }} 个</el-tag>
                <el-button type="primary" @click="dispatchTodoBatch">批量下发</el-button>
              </div>
            </el-card>
            <el-table :data="todoRows" height="420" size="small">
              <el-table-column label="#" width="60"><template #default="scope">{{ scope.$index + 1 }}</template></el-table-column>
              <el-table-column label="内容" min-width="220"><template #default="scope"><el-input v-model="scope.row.content" /></template></el-table-column>
              <el-table-column label="完成" width="90"><template #default="scope"><el-switch v-model="scope.row.done" /></template></el-table-column>
              <el-table-column label="优先级" width="120"><template #default="scope"><el-input-number v-model="scope.row.priority" :min="0" :max="99" /></template></el-table-column>
              <el-table-column label="操作" width="90"><template #default="scope"><el-button link type="danger" @click="removeTodoRow(scope.$index)">删除</el-button></template></el-table-column>
            </el-table>
          </section>

          <section v-if="activePanel === 'schedule'" class="section-wrap">
            <div class="row-actions">
              <h3>日程安排</h3>
              <el-select v-model="scheduleDeviceId" filterable style="width:380px" @change="loadScheduleRows">
                <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
              </el-select>
              <el-button @click="addScheduleRow">新增行</el-button>
              <el-button @click="loadScheduleRows">刷新</el-button>
              <el-button type="primary" @click="saveScheduleRows">保存</el-button>
            </div>
            <ScheduleXiquePanel :device-id="scheduleDeviceId" :token="auth.token" :device-label="deviceOptionLabel(deviceStore.devices.find((item) => item.id === scheduleDeviceId) || { id: '', mac: '' })" @updated="loadScheduleRows" />
            <el-card>
              <template #header>批量下发日程（课程/会议）</template>
              <el-form :model="scheduleBatchForm" inline label-width="100px" size="small">
                <el-form-item label="文本模式">
                  <el-select v-model="scheduleBatchForm.mode" style="width:140px">
                    <el-option label="相同标题" value="same" />
                    <el-option label="正则替换" value="regex" />
                    <el-option label="模板变量" value="template" />
                  </el-select>
                </el-form-item>
                <el-form-item label="日程模式">
                  <el-select v-model="scheduleBatchForm.scheduleMode" style="width:130px">
                    <el-option label="课程模式" value="course" />
                    <el-option label="会议模式" value="meeting" />
                  </el-select>
                </el-form-item>
                <el-form-item label="标题模板"><el-input v-model="scheduleBatchForm.title" style="width:360px" placeholder="支持 {{displayName}} / {{remark}}" /></el-form-item>
                <el-form-item label="内容"><el-input v-model="scheduleBatchForm.content" style="width:220px" /></el-form-item>
                <el-form-item label="周几"><el-input-number v-model="scheduleBatchForm.weekday" :min="1" :max="7" /></el-form-item>
                <el-form-item label="节次"><el-input-number v-model="scheduleBatchForm.orderIndex" :min="1" :max="20" /></el-form-item>
                <el-form-item label="开始"><el-input v-model="scheduleBatchForm.startTime" style="width:120px" placeholder="09:00" /></el-form-item>
                <el-form-item label="结束"><el-input v-model="scheduleBatchForm.endTime" style="width:120px" placeholder="10:30" /></el-form-item>
                <el-form-item v-if="scheduleBatchForm.mode === 'regex'" label="源文本"><el-input v-model="scheduleBatchForm.regexSource" style="width:240px" /></el-form-item>
                <el-form-item v-if="scheduleBatchForm.mode === 'regex'" label="正则"><el-input v-model="scheduleBatchForm.regexPattern" style="width:180px" /></el-form-item>
                <el-form-item v-if="scheduleBatchForm.mode === 'regex'" label="替换"><el-input v-model="scheduleBatchForm.regexReplace" style="width:180px" /></el-form-item>
                <el-form-item label="覆盖清空"><el-switch v-model="scheduleBatchForm.replace" /></el-form-item>
                <el-form-item label="设备池">
                  <el-select v-model="scheduleBatchClusterIds" multiple clearable filterable style="width:320px" placeholder="选择设备池">
                    <el-option v-for="c in clusters" :key="c.id" :label="c.name" :value="c.id" />
                  </el-select>
                </el-form-item>
              </el-form>
              <div class="row-actions">
                <el-button @click="openDispatchPicker('schedule')">弹窗选择设备</el-button>
                <el-tag type="warning">已选设备 {{ batchTargetDeviceIds.schedule.length }} 台</el-tag>
                <el-tag>已选设备池 {{ scheduleBatchClusterIds.length }} 个</el-tag>
                <el-button type="primary" @click="dispatchScheduleBatch">批量下发</el-button>
              </div>
            </el-card>
            <el-table :data="scheduleRows" height="420" size="small">
              <el-table-column label="模式" width="110">
                <template #default="scope">
                  <el-select v-model="scope.row.mode" style="width:100%">
                    <el-option label="课程" value="course" />
                    <el-option label="会议" value="meeting" />
                  </el-select>
                </template>
              </el-table-column>
              <el-table-column label="周" width="90"><template #default="scope"><el-input-number v-model="scope.row.weekday" :min="1" :max="7" /></template></el-table-column>
              <el-table-column label="节次" width="90"><template #default="scope"><el-input-number v-model="scope.row.orderIndex" :min="1" :max="20" /></template></el-table-column>
              <el-table-column label="标题" min-width="170"><template #default="scope"><el-input v-model="scope.row.title" /></template></el-table-column>
              <el-table-column label="内容" min-width="160"><template #default="scope"><el-input v-model="scope.row.content" /></template></el-table-column>
              <el-table-column label="开始" width="110"><template #default="scope"><el-input v-model="scope.row.startTime" placeholder="09:00" /></template></el-table-column>
              <el-table-column label="结束" width="110"><template #default="scope"><el-input v-model="scope.row.endTime" placeholder="10:30" /></template></el-table-column>
              <el-table-column label="操作" width="90"><template #default="scope"><el-button link type="danger" @click="removeScheduleRow(scope.$index)">删除</el-button></template></el-table-column>
            </el-table>
          </section>

          <section v-if="activePanel === 'templates'" class="section-wrap">
            <h3>API模板</h3>
            <el-row :gutter="12">
              <el-col :md="14" :xs="24">
                <el-card>
                  <div class="row-actions">
                    <el-button @click="loadTemplateRows">刷新模板</el-button>
                    <el-button v-if="isAdmin" @click="resetTemplateDraft">新建模板</el-button>
                    <el-button v-if="isAdmin" type="primary" @click="saveTemplateDraft">保存模板</el-button>
                    <el-button v-if="isAdmin && templateDraft.id" type="danger" @click="deleteTemplateDraft">删除模板</el-button>
                    <el-button v-if="isAdmin" @click="openTemplateAdvancedEditor">配置多步处理</el-button>
                  </div>
                  <el-table :data="templateRows" height="260" size="small" @row-click="pickTemplateRow">
                    <el-table-column prop="name" label="名称" min-width="120" />
                    <el-table-column prop="slug" label="slug" min-width="120" />
                    <el-table-column label="刷新模式" width="140">
                      <template #default="scope">
                        {{ scope.row.refreshConfig?.mode || "interval" }}
                      </template>
                    </el-table-column>
                    <el-table-column label="启用" width="80"><template #default="scope">{{ scope.row.enabled ? "是" : "否" }}</template></el-table-column>
                    <el-table-column label="需设备Key" width="110"><template #default="scope">{{ scope.row.deviceKeyRequired ? "是" : "否" }}</template></el-table-column>
                  </el-table>
                  <el-divider />
                  <el-form :model="templateDraft" label-width="120px" size="small">
                    <el-form-item label="名称"><el-input v-model="templateDraft.name" /></el-form-item>
                    <el-form-item label="slug"><el-input v-model="templateDraft.slug" :disabled="!isAdmin && !!templateDraft.id" /></el-form-item>
                    <el-form-item label="请求方法">
                      <el-select v-model="templateDraft.method"><el-option label="GET" value="GET" /><el-option label="POST" value="POST" /></el-select>
                    </el-form-item>
                    <el-form-item label="URL"><el-input v-model="templateDraft.url" /></el-form-item>
                    <el-form-item label="key字段"><el-input v-model="templateDraft.keyField" /></el-form-item>
                    <el-form-item label="key携带方式">
                      <el-select v-model="templateDraft.keyIn" multiple>
                        <el-option label="query" value="query" />
                        <el-option label="header" value="header" />
                        <el-option label="body" value="body" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="用户补全字段">
                      <div style="display:grid; gap:6px; width:100%">
                        <div v-for="(row, idx) in templateDraft.userInputFields" :key="idx" class="row-actions">
                          <el-input v-model="row.name" placeholder="参数名" />
                          <el-input v-model="row.placeholder" placeholder="提示内容" />
                          <el-button link type="danger" @click="removeTemplateInputField(idx)">删除</el-button>
                        </div>
                        <el-button v-if="isAdmin" link type="primary" @click="addTemplateInputField">新增字段</el-button>
                      </div>
                    </el-form-item>
                    <el-form-item label="多步处理">
                      <div class="advanced-summary">
                        <div v-for="line in templateAdvancedSummaryLines" :key="line" class="advanced-summary-line">{{ line }}</div>
                        <div v-if="!templateAdvancedSummaryLines.length" class="advanced-summary-empty">未配置多步处理</div>
                      </div>
                    </el-form-item>
                    <el-form-item label="刷新模式">
                      <div class="row-actions">
                        <el-select v-model="templateDraft.refreshConfig.mode" style="width:240px">
                          <el-option label="manual（仅手动刷新）" value="manual" />
                          <el-option label="interval（定时刷新）" value="interval" />
                          <el-option label="on_request（按请求刷新）" value="on_request" />
                          <el-option label="stale_while_revalidate（过期先返回旧缓存）" value="stale_while_revalidate" />
                        </el-select>
                        <el-switch v-model="templateDraft.refreshConfig.enabled" />
                        <span style="font-size:12px;color:#64748b">启用刷新策略</span>
                      </div>
                    </el-form-item>
                    <el-form-item label="定时间隔(分钟)" v-if="templateDraft.refreshConfig.mode === 'interval'">
                      <el-select v-model="templateDraft.refreshConfig.intervalMinutes" style="width:200px">
                        <el-option label="10 分钟" :value="10" />
                        <el-option label="30 分钟" :value="30" />
                        <el-option label="1 小时" :value="60" />
                        <el-option label="2 小时" :value="120" />
                        <el-option label="6 小时" :value="360" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="缓存 TTL(秒)">
                      <el-input-number v-model="templateDraft.refreshConfig.ttlSeconds" :min="30" :max="86400" />
                    </el-form-item>
                    <el-form-item
                      label="最小请求间隔(秒)"
                      v-if="templateDraft.refreshConfig.mode === 'on_request' || templateDraft.refreshConfig.mode === 'stale_while_revalidate'"
                    >
                      <el-input-number v-model="templateDraft.refreshConfig.minRequestGapSeconds" :min="0" :max="86400" />
                    </el-form-item>
                    <el-form-item label="刷新超时(ms)">
                      <el-input-number v-model="templateDraft.refreshConfig.timeoutMs" :min="500" :max="120000" />
                    </el-form-item>
                    <el-form-item label="错峰抖动(秒)" v-if="templateDraft.refreshConfig.mode === 'interval'">
                      <el-input-number v-model="templateDraft.refreshConfig.jitterSeconds" :min="0" :max="3600" />
                    </el-form-item>
                    <el-form-item label="失败回退旧缓存">
                      <el-switch v-model="templateDraft.refreshConfig.fallbackToStale" />
                    </el-form-item>
                    <el-form-item label="需要设备Key"><el-switch v-model="templateDraft.deviceKeyRequired" /></el-form-item>
                    <el-form-item label="启用"><el-switch v-model="templateDraft.enabled" /></el-form-item>
                  </el-form>
                </el-card>
              </el-col>
              <el-col :md="10" :xs="24">
                <el-card>
                  <el-form label-width="100px" size="small">
                    <el-form-item label="单设备(调试)">
                      <el-select v-model="templateDeviceId" filterable style="width:100%" @change="loadTemplateDeviceState">
                        <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="设备Key"><el-input v-model="templateDeviceKey" placeholder="当前模板的设备Key" /></el-form-item>
                    <el-form-item label="批量设备池">
                      <el-select v-model="templateBatchClusterIds" multiple clearable filterable style="width:100%" placeholder="可选设备池">
                        <el-option v-for="c in clusters" :key="c.id" :label="c.name" :value="c.id" />
                      </el-select>
                    </el-form-item>
                  </el-form>
                  <div class="row-actions">
                    <el-button type="primary" @click="saveTemplateDeviceKey">保存设备Key</el-button>
                    <el-button @click="loadTemplateDeviceState">刷新设备参数</el-button>
                    <el-button @click="openDispatchPicker('templates')">弹窗选择参数下发设备</el-button>
                    <el-tag type="warning">已选设备 {{ batchTargetDeviceIds.templates.length }} 台</el-tag>
                  </div>
                  <el-divider />
                  <el-form v-if="isWeatherTemplate || isXiqueTemplate" label-width="100px" size="small">
                    <el-form-item v-if="isWeatherTemplate" label="城市ID">
                      <el-input v-model="templateParamValues.cityId" placeholder="例如 101010100" />
                    </el-form-item>
                    <template v-if="isXiqueTemplate">
                      <el-form-item label="喜鹊账号">
                        <el-select v-model="xiqueAccountMode" style="width:100%">
                          <el-option label="使用已登录账号" value="existing" />
                          <el-option label="登录新账号" value="new" />
                        </el-select>
                      </el-form-item>
                      <el-form-item v-if="xiqueAccountMode === 'existing'" label="已登录账号">
                        <el-select v-model="xiqueSelectedAccount" style="width:100%" placeholder="请选择账号" @change="applyXiqueAccountSelection">
                          <el-option v-for="row in xiqueKnownAccounts" :key="row.value" :label="row.label" :value="row.value" />
                        </el-select>
                      </el-form-item>
                      <el-form-item v-else label="新账号">
                        <el-input v-model="templateParamValues.loginUsername" placeholder="教务系统账号" />
                      </el-form-item>
                      <el-form-item v-if="xiqueAccountMode === 'new'" label="新密码">
                        <el-input v-model="templateParamValues.password" show-password placeholder="教务系统密码（仅本次调用使用）" />
                      </el-form-item>
                      <el-form-item v-if="!xiqueTemplateAutoOcrEnabled" label="验证码">
                        <el-input
                          v-model="templateParamValues.captchaAnswer"
                          placeholder="需要验证码时填写"
                          @focus="handleXiqueTemplateCaptchaInputFocus"
                        />
                      </el-form-item>
                      <el-form-item label="自动识别验证码">
                        <el-switch
                          v-model="templateParamValues.autoOcrEnabled"
                          active-value="1"
                          inactive-value="0"
                        />
                      </el-form-item>
                      <el-form-item v-if="!xiqueTemplateAutoOcrEnabled" label="验证码图片">
                        <div style="display:grid; gap:8px; width:100%">
                          <img
                            v-if="xiqueCaptchaImage"
                            :src="xiqueCaptchaImage"
                            alt="xique-captcha"
                            style="max-width:240px; border:1px solid #e5e7eb; border-radius:8px; background:#fff; cursor:pointer"
                            @click="refreshXiqueTemplateCaptcha"
                          />
                          <div v-else style="font-size:12px; color:#64748b">当前未返回验证码，调用后如需手动验证会自动显示。</div>
                          <div style="font-size:12px; color:#64748b">
                            会话: {{ xiqueCaptchaSession || "-" }} ｜过期: {{ xiqueCaptchaExpiresAt || "-" }}
                          </div>
                          <div class="row-actions">
                            <el-button size="small" :loading="xiqueStatusLoading" @click="refreshXiqueTemplateCaptcha">刷新验证码</el-button>
                          </div>
                        </div>
                      </el-form-item>
                      <el-form-item v-else label="验证码">
                        <div style="font-size:12px; color:#64748b">
                          已开启自动识别验证码，界面不展示验证码图片与输入框。仅当自动识别失败时再切换为手动输入。
                        </div>
                      </el-form-item>
                      <el-form-item label="学年/学期">
                        <el-input v-model="templateParamValues.currentTermKey" placeholder="例如 2026-S1" />
                      </el-form-item>
                      <div class="row-actions">
                        <el-button type="primary" plain :loading="xiqueStatusLoading" @click="loginXiqueTemplate">登录验证</el-button>
                        <el-button :loading="xiqueStatusLoading" @click="refreshXiqueTemplateStatus">刷新喜鹊状态</el-button>
                        <el-tag>{{ xiqueStatusSummary || "未获取状态" }}</el-tag>
                      </div>
                    </template>
                  </el-form>
                  <div style="display:grid; gap:8px">
                    <div v-for="(field, idx) in templateVisibleInputFields" :key="`param-${idx}`">
                      <el-input v-model="templateParamValues[field.name]" :placeholder="field.placeholder || field.name" />
                    </div>
                  </div>
                  <div class="row-actions" style="margin-top:8px">
                    <el-button type="primary" @click="saveTemplateParams">下发参数到设备</el-button>
                    <el-button @click="testTemplateApi">调用第三方API</el-button>
                  </div>
                  <el-input
                    v-model="templateResultText"
                    type="textarea"
                    :rows="12"
                    readonly
                    style="margin-top:8px"
                    placeholder="这里显示调用结果"
                  />
                </el-card>
              </el-col>
            </el-row>
          </section>

          <section v-if="activePanel === 'firmware'" class="section-wrap">
            <h3>固件管理</h3>
            <div class="row-actions">
              <el-button @click="loadFirmwareRows">刷新固件</el-button>
              <el-button @click="loadFullFirmwareBundles">刷新完整包</el-button>
              <el-button @click="loadUpgradeJobs">刷新升级任务</el-button>
              <el-button @click="openDispatchPicker('firmware')">弹窗选择升级设备</el-button>
              <el-tag type="warning">目标设备 {{ batchTargetDeviceIds.firmware.length || deviceStore.selectedIds.length }} 台</el-tag>
              <el-button type="primary" @click="batchUpgradeLatest">批量升级已选设备（最新）</el-button>
            </div>
            <el-row :gutter="12">
              <el-col :md="14" :xs="24">
                <el-card>
                  <el-table :data="firmwareRows" height="300" size="small">
                    <el-table-column prop="version" label="版本" width="140" />
                    <el-table-column prop="deviceType" label="设备类型" width="150" />
                    <el-table-column prop="fileName" label="文件名" min-width="180" />
                    <el-table-column prop="createdAt" label="时间" min-width="180" />
                    <el-table-column v-if="isAdmin" label="操作" width="90">
                      <template #default="scope"><el-button link type="danger" @click="deleteFirmwareRow(scope.row.id)">删除</el-button></template>
                    </el-table-column>
                  </el-table>
                </el-card>
              </el-col>
              <el-col v-if="isAdmin" :md="10" :xs="24">
                <el-card>
                  <el-form :model="firmwareForm" label-width="100px" size="small">
                    <el-form-item label="版本"><el-input v-model="firmwareForm.version" /></el-form-item>
                    <el-form-item label="设备类型"><el-input v-model="firmwareForm.deviceType" /></el-form-item>
                    <el-form-item label="发布说明"><el-input v-model="firmwareForm.releaseNote" type="textarea" :rows="3" /></el-form-item>
                    <el-form-item label="固件文件"><input type="file" accept=".bin,application/octet-stream" @change="onFirmwareFileChange" /></el-form-item>
                  </el-form>
                  <div class="row-actions"><el-button type="primary" @click="uploadFirmware">上传固件</el-button></div>
                </el-card>
              </el-col>
            </el-row>
            <el-card>
              <template #header>完整固件 ZIP / Web Serial 刷入准备</template>
              <div v-if="isAdmin" class="row-actions" style="margin-bottom:8px">
                <input type="file" accept=".zip,application/zip" @change="onFullFirmwareFileChange" />
                <el-button type="primary" :disabled="!fullFirmwareFile" @click="uploadFullFirmwareBundle">上传并校验完整包</el-button>
                <el-tag type="info">E6 校验：esp32 / 4MB / bootloader + partition-table + app</el-tag>
              </div>
              <el-table :data="fullFirmwareBundles" height="240" size="small">
                <el-table-column prop="version" label="版本" width="120" />
                <el-table-column prop="deviceType" label="设备类型" width="150" />
                <el-table-column prop="chip" label="芯片" width="90" />
                <el-table-column prop="flashSize" label="Flash" width="90" />
                <el-table-column prop="fileName" label="文件名" min-width="180" />
                <el-table-column label="分区" min-width="220">
                  <template #default="scope">
                    {{ (scope.row.files || []).map((f: any) => `${f.type}@${f.offsetHex}`).join(" / ") }}
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="150">
                  <template #default="scope">
                    <el-button link type="primary" @click="openFullFirmwareManifest(scope.row)">manifest</el-button>
                    <el-button link type="info" @click="downloadFullFirmwareBundle(scope.row)">下载</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
            <el-card>
              <template #header>升级任务</template>
              <el-table :data="upgradeRows" height="240" size="small">
                <el-table-column prop="id" label="任务ID" min-width="180" />
                <el-table-column prop="deviceId" label="设备" min-width="160" />
                <el-table-column prop="status" label="状态" width="120" />
                <el-table-column prop="progress" label="进度" width="90" />
                <el-table-column prop="result" label="结果" min-width="180" />
              </el-table>
            </el-card>
          </section>

          <section v-if="activePanel === 'tf'" class="section-wrap">
            <h3>文件管理</h3>
            <div class="row-actions">
              <el-select v-model="tfQuery.category" clearable placeholder="分类" style="width:140px">
                <el-option label="fonts" value="fonts" />
                <el-option label="read" value="read" />
                <el-option label="photo" value="photo" />
                <el-option label="update" value="update" />
                <el-option label="background" value="background" />
                <el-option label="config" value="config" />
              </el-select>
              <el-select v-model="tfQuery.deviceId" clearable filterable placeholder="设备(看下发状态/本地文件)" style="width:360px">
                <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
              </el-select>
              <el-select v-model="tfBatchClusterIds" multiple clearable filterable placeholder="批量下发设备池" style="width:260px">
                <el-option v-for="c in clusters" :key="c.id" :label="c.name" :value="c.id" />
              </el-select>
              <el-button @click="openDispatchPicker('tf')">弹窗选择下发设备</el-button>
              <el-tag type="warning">设备 {{ batchTargetDeviceIds.tf.length }} 台</el-tag>
              <el-tag>选中文件 {{ selectedTfFile?.originalName || "-" }}</el-tag>
              <el-button type="primary" :disabled="!selectedTfFile" @click="dispatchTfSelectedFile">下发选中文件</el-button>
              <el-button @click="loadTfRows">刷新云端文件</el-button>
              <el-button @click="loadTfLocalRows">刷新设备本地文件</el-button>
            </div>
            <el-row :gutter="12">
              <el-col :md="14" :xs="24">
                <el-card>
                  <div class="row-actions" style="margin-bottom:8px">
                    <el-select v-model="tfUpload.category" style="width:150px">
                      <el-option label="fonts" value="fonts" />
                      <el-option label="read" value="read" />
                      <el-option label="photo" value="photo" />
                      <el-option label="update" value="update" />
                      <el-option label="background" value="background" />
                      <el-option label="config" value="config" />
                    </el-select>
                    <input type="file" @change="onTfFileChange" />
                    <el-button type="primary" @click="uploadTfFile">上传到云端</el-button>
                  </div>
                  <el-table :data="tfRows" height="300" size="small" @row-click="pickTfRow">
                    <el-table-column prop="originalName" label="文件名" min-width="180" />
                    <el-table-column prop="category" label="分类" width="110" />
                    <el-table-column prop="deliverStatus" label="下发状态" width="110" />
                    <el-table-column prop="size" label="大小" width="90" />
                    <el-table-column label="操作" width="160">
                      <template #default="scope">
                        <el-button link type="primary" @click="downloadTfFile(scope.row.id)">下载</el-button>
                        <el-button link type="danger" @click="deleteTfFile(scope.row.id)">删除</el-button>
                      </template>
                    </el-table-column>
                  </el-table>
                </el-card>
              </el-col>
              <el-col :md="10" :xs="24">
                <el-card>
                  <template #header>设备本地文件</template>
                  <el-table :data="tfLocalRows" height="300" size="small">
                    <el-table-column prop="name" label="文件名" min-width="160" />
                    <el-table-column prop="category" label="分类" width="100" />
                    <el-table-column prop="size" label="大小" width="80" />
                    <el-table-column label="操作" width="100">
                      <template #default="scope">
                        <el-button link type="danger" @click="deleteTfLocalFile(scope.row)">删除</el-button>
                      </template>
                    </el-table-column>
                  </el-table>
                </el-card>
              </el-col>
            </el-row>
          </section>

          <section v-if="activePanel === 'logs' && isAdmin" class="section-wrap">
            <h3>日志中心</h3>
            <div class="row-actions">
              <el-button @click="loadOperationLogs">查询操作日志</el-button>
              <el-button @click="loadApiLogs">查询API日志</el-button>
              <el-checkbox v-model="logCleanupForm.includeOperationLogs">操作日志</el-checkbox>
              <el-checkbox v-model="logCleanupForm.includeApiLogs">API日志</el-checkbox>
              <el-checkbox v-model="logCleanupForm.includeFiles">文件/日志文件</el-checkbox>
              <el-checkbox v-model="logCleanupForm.dryRun">仅预览</el-checkbox>
            </div>
            <div class="row-actions">
              <el-date-picker
                v-model="logCleanupForm.range"
                type="datetimerange"
                range-separator="至"
                start-placeholder="开始时间"
                end-placeholder="结束时间"
                format="YYYY-MM-DD HH:mm:ss"
                style="min-width: 360px"
              />
              <el-button type="danger" :loading="logCleanupLoading" @click="runLogCleanup('range')">按时间段清理</el-button>
              <el-button type="danger" plain :loading="logCleanupLoading" @click="runLogCleanup('all')">清理全部</el-button>
            </div>
            <el-alert v-if="logCleanupSummary" type="info" :closable="false" show-icon>
              <template #default>{{ logCleanupSummary }}</template>
            </el-alert>
            <el-row :gutter="12">
              <el-col :md="12" :xs="24">
                <el-card>
                  <template #header>操作日志</template>
                  <el-table :data="operationLogs" height="320" size="small">
                    <el-table-column prop="createdAt" label="时间" width="160" />
                    <el-table-column prop="action" label="动作" min-width="140" />
                    <el-table-column prop="targetId" label="目标" min-width="140" />
                  </el-table>
                </el-card>
              </el-col>
              <el-col :md="12" :xs="24">
                <el-card>
                  <template #header>API日志</template>
                  <el-table :data="apiLogs" height="320" size="small">
                    <el-table-column prop="createdAt" label="时间" width="160" />
                    <el-table-column prop="templateSlug" label="模板" min-width="120" />
                    <el-table-column prop="deviceId" label="设备" min-width="120" />
                    <el-table-column label="成功" width="70"><template #default="scope">{{ scope.row.success ? "是" : "否" }}</template></el-table-column>
                  </el-table>
                </el-card>
              </el-col>
            </el-row>
          </section>

          <section v-if="activePanel === 'systemUpgrade' && isAdmin" class="section-wrap">
            <h3>系统升级</h3>
            <SystemUpgradePanel :token="auth.token" />
          </section>

          <section v-if="activePanel === 'albumCollections'" class="section-wrap">
            <h3>相册与集合</h3>
            <E6AlbumPanel :token="auth.token" :devices="deviceStore.devices" @refresh-devices="refreshDevices" />
          </section>

          <section v-if="activePanel === 'devices'" class="section-wrap">
            <h3>设备框选与筛选</h3>
            <div class="row-actions">
              <el-select v-model="deviceFilters.bound" clearable placeholder="绑定状态" style="width:140px">
                <el-option label="已绑定" value="bound" />
                <el-option label="未绑定" value="unbound" />
              </el-select>
              <el-select v-model="deviceFilters.online" clearable placeholder="在线状态" style="width:140px">
                <el-option label="在线" value="online" />
                <el-option label="离线" value="offline" />
              </el-select>
              <el-select v-model="deviceFilters.status" clearable placeholder="设备状态" style="width:140px">
                <el-option label="enabled" value="enabled" />
                <el-option label="blocked" value="blocked" />
              </el-select>
              <el-input v-model="deviceFilters.keyword" placeholder="按ID/名称/MAC/绑定用户/备注筛选" style="width:320px" />
              <el-button :loading="deviceStore.loading" @click="refreshDevices">刷新设备</el-button>
              <el-button type="danger" plain @click="batchDeleteSelectedDevices">删除已选设备</el-button>
              <el-button v-if="isAdmin" type="danger" @click="batchDeleteAllFiltered">删除筛选结果全部设备</el-button>
            </div>
            <el-card style="margin-bottom:12px">
              <template #header>硬件连接地址</template>
              <div class="row-actions">
                <el-input v-model="backendUrlForm.backendBaseUrl" clearable placeholder="http://192.168.9.106:8890 或 https://epd.gaoshanliuni.top:19999" style="width:420px">
                  <template #prepend>后端地址</template>
                </el-input>
                <el-button @click="fillCurrentBackendBaseUrl">填入当前地址</el-button>
                <el-select v-model="backendUrlClusterIds" multiple clearable filterable placeholder="选择设备池" style="width:260px">
                  <el-option v-for="c in clusters" :key="c.id" :label="c.name" :value="c.id" />
                </el-select>
                <el-button @click="openDispatchPicker('backendUrl')">弹窗选择设备</el-button>
                <el-tag type="warning">设备 {{ batchTargetDeviceIds.backendUrl.length || deviceStore.selectedIds.length }} 台</el-tag>
                <el-tag>设备池 {{ backendUrlClusterIds.length }} 个</el-tag>
                <el-button type="primary" :loading="backendUrlDispatchLoading" @click="dispatchBackendUrl">下发连接地址</el-button>
              </div>
            </el-card>
            <el-card style="margin-bottom:12px">
              <template #header>浏览器 USB / NVS</template>
              <el-radio-group v-model="usbNvsState.mode" class="usb-nvs-mode-tabs" size="small">
                <el-radio-button value="usb">USB 本地读取</el-radio-button>
                <el-radio-button value="online">在线下发 NVS</el-radio-button>
              </el-radio-group>

              <section v-if="usbNvsState.mode === 'usb'" class="usb-nvs-page">
                <div class="row-actions">
                  <el-button type="primary" :loading="usbNvsState.connecting" @click="connectUsbNvsDevice">连接电脑当前 USB 设备</el-button>
                  <el-button :disabled="!usbNvsState.connected" @click="disconnectUsbNvsDevice">断开</el-button>
                  <el-tag :type="usbNvsSupportTagType">{{ usbNvsState.status }}</el-tag>
                </div>
                <el-alert type="info" :closable="false" show-icon style="margin:8px 0">
                  <template #default>
                    USB 本地模式只读取当前浏览器连接的硬件，不会自动套用后台已选设备；读取结果来自硬件串口返回的 NVS 值。
                  </template>
                </el-alert>
                <el-row :gutter="12">
                  <el-col :md="8" :xs="24">
                    <el-form label-width="86px" size="small">
                      <el-form-item label="NVS offset"><el-input v-model="usbNvsState.offset" /></el-form-item>
                      <el-form-item label="NVS size"><el-input v-model="usbNvsState.size" /></el-form-item>
                      <el-form-item label="namespace"><el-input v-model="usbNvsState.namespace" /></el-form-item>
                      <el-form-item label="key"><el-input v-model="usbNvsState.key" placeholder="留空读取全部已支持项" /></el-form-item>
                    </el-form>
                  </el-col>
                  <el-col :md="16" :xs="24">
                    <div class="row-actions">
                      <el-button type="primary" :disabled="!usbNvsState.connected" :loading="usbNvsState.loading" @click="readUsbHardwareNvs">USB 读取硬件 NVS</el-button>
                    </div>
                    <el-table :data="usbNvsEntries" height="260" size="small" style="margin-top:8px">
                      <el-table-column prop="namespace" label="namespace" width="130" />
                      <el-table-column prop="key" label="key" width="150" />
                      <el-table-column prop="type" label="type" width="90" />
                      <el-table-column prop="value" label="硬件当前值" min-width="220" show-overflow-tooltip />
                    </el-table>
                  </el-col>
                </el-row>
              </section>

              <section v-if="usbNvsState.mode === 'online'" class="usb-nvs-page">
                <div class="row-actions">
                  <el-select v-model="usbNvsState.selectedDeviceId" filterable clearable placeholder="选择要在线下发的后端设备" style="width:300px">
                    <el-option v-for="d in deviceStore.devices" :key="d.id" :label="d.displayName || d.remark || d.id" :value="d.id" />
                  </el-select>
                  <el-tag type="success">后端 NVS 适配器已启用</el-tag>
                </div>
                <el-alert type="warning" :closable="false" show-icon style="margin:8px 0">
                  <template #default>
                    在线模式读取后端 shadow，并通过 nvs.write 指令下发到选中的在线设备；必须显式选择设备，不会使用 USB 连接或全局选中设备。
                  </template>
                </el-alert>
                <el-row :gutter="12">
                  <el-col :md="8" :xs="24">
                    <el-form label-width="86px" size="small">
                      <el-form-item label="namespace"><el-input v-model="usbNvsState.namespace" /></el-form-item>
                      <el-form-item label="key">
                        <el-select v-model="usbNvsState.key" filterable allow-create default-first-option>
                          <el-option v-for="entry in usbNvsEntries" :key="entry.key" :label="`${entry.key} (${entry.namespace})`" :value="entry.key" />
                        </el-select>
                      </el-form-item>
                      <el-form-item label="value"><el-input v-model="usbNvsState.value" /></el-form-item>
                      <el-form-item label="重启"><el-switch v-model="usbNvsState.reboot" /></el-form-item>
                    </el-form>
                  </el-col>
                  <el-col :md="16" :xs="24">
                    <div class="row-actions">
                      <el-button :loading="usbNvsState.loading" @click="readUsbNvsPartition">读取后端 Shadow</el-button>
                      <el-button type="primary" :loading="usbNvsState.loading" @click="writeUsbNvsPartition">在线下发 NVS</el-button>
                      <el-button :loading="usbNvsState.loading" @click="loadUsbNvsBackups">刷新备份</el-button>
                      <el-button type="warning" :disabled="!selectedNvsBackupId" :loading="usbNvsState.loading" @click="restoreSelectedUsbNvsBackup">恢复选中备份</el-button>
                    </div>
                    <el-table :data="usbNvsEntries" height="180" size="small" style="margin-top:8px">
                      <el-table-column prop="namespace" label="namespace" width="130" />
                      <el-table-column prop="key" label="key" width="150" />
                      <el-table-column prop="type" label="type" width="90" />
                      <el-table-column prop="value" label="shadow value" min-width="180" show-overflow-tooltip />
                    </el-table>
                    <el-table :data="usbNvsBackups" height="150" size="small" style="margin-top:8px" @row-click="pickUsbNvsBackup">
                      <el-table-column width="48">
                        <template #default="scope">
                          <el-radio v-model="selectedNvsBackupId" :label="scope.row.id">&nbsp;</el-radio>
                        </template>
                      </el-table-column>
                      <el-table-column prop="createdAt" label="备份时间" min-width="160" />
                      <el-table-column prop="reason" label="原因" width="90" />
                      <el-table-column label="keys" min-width="180" show-overflow-tooltip>
                        <template #default="scope">{{ (scope.row.keys || []).join(", ") || "-" }}</template>
                      </el-table-column>
                    </el-table>
                  </el-col>
                </el-row>
              </section>
            </el-card>
            <device-lasso-picker
              ref="pickerRef"
              :devices="deviceStore.devices"
              :model-value="deviceStore.selectedIds"
              @update:model-value="deviceStore.setSelection"
              @filtered-change="onFilteredChange"
            />
            <div class="row-actions">
              <el-button :loading="deviceStore.loading" @click="refreshDevices">刷新设备</el-button>
              <el-button @click="selectAllFiltered">全选筛选结果</el-button>
              <el-button @click="clearSelection">清空选择</el-button>
              <el-tag>筛选后 {{ filteredDeviceIds.length }} 台</el-tag>
              <el-tag type="warning">已选 {{ deviceStore.selectedIds.length }} 台</el-tag>
            </div>
            <E6DeviceDetailCard v-if="selectedE6DetailDevice" :device="selectedE6DetailDevice" />
            <el-card>
              <template #header>已选设备快速编辑</template>
              <el-table :data="quickEditRows" height="280" size="small">
                <el-table-column prop="id" label="设备ID" min-width="150" />
                <el-table-column label="在线状态" width="100">
                  <template #default="scope">{{ scope.row.online ? "在线" : "离线" }}</template>
                </el-table-column>
                <el-table-column label="绑定用户" min-width="190">
                  <template #default="scope">
                    <el-select v-if="isAdmin" v-model="scope.row.ownerId" clearable filterable placeholder="未绑定" style="width:100%">
                      <el-option v-for="u in ownerSelectOptions" :key="u.id" :label="ownerOptionLabel(u)" :value="u.id" />
                    </el-select>
                    <span v-else>{{ scope.row.ownerNickname || scope.row.ownerUsername || scope.row.ownerId || "-" }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="显示名字" min-width="150"><template #default="scope"><el-input v-model="scope.row.displayName" /></template></el-table-column>
                <el-table-column label="备注" min-width="180"><template #default="scope"><el-input v-model="scope.row.remark" /></template></el-table-column>
                <el-table-column label="设备池" min-width="180"><template #default="scope">{{ (scope.row.clusterNames || []).join("、") || "-" }}</template></el-table-column>
                <el-table-column label="操作" width="90">
                  <template #default="scope"><el-button link type="primary" @click="saveDeviceQuickEdit(scope.row)">保存</el-button></template>
                </el-table-column>
              </el-table>
            </el-card>
          </section>

          <section v-if="activePanel === 'deviceVariables'" class="section-wrap">
            <h3>设备变量</h3>
            <div class="row-actions">
              <el-select v-model="deviceVariableDeviceId" filterable placeholder="选择设备" style="width:360px" @change="loadDeviceVariables">
                <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
              </el-select>
              <el-button :loading="deviceVariableLoading" @click="loadDeviceVariables">刷新变量</el-button>
              <el-button type="primary" plain @click="openDeviceVariableBatchDialog">批量设置变量</el-button>
            </div>
            <el-row :gutter="12">
              <el-col :md="9" :xs="24">
                <el-card>
                  <template #header>{{ deviceVariableEditingName ? '修改基础变量' : '新增基础变量' }}</template>
                  <el-form :model="deviceVariableDraft" label-width="74px" size="small">
                    <el-form-item label="变量名">
                      <el-select
                        v-model="deviceVariableDraft.name"
                        filterable
                        allow-create
                        default-first-option
                        clearable
                        style="width:100%"
                        placeholder="选择已有变量名或直接输入"
                      >
                        <el-option v-for="name in deviceVariableBaseNameOptions" :key="name" :label="name" :value="name" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="变量">
                      <el-select
                        v-model="deviceVariableDraft.value"
                        filterable
                        allow-create
                        default-first-option
                        clearable
                        style="width:100%"
                        placeholder="选择已有变量或直接输入"
                      >
                        <el-option v-for="value in deviceVariableBaseValueOptions" :key="value" :label="value" :value="value" />
                      </el-select>
                    </el-form-item>
                  </el-form>
                  <div class="row-actions">
                    <el-button type="primary" @click="saveDeviceVariable">保存变量</el-button>
                    <el-button @click="resetDeviceVariableDraft">清空</el-button>
                  </div>
                </el-card>
              </el-col>
              <el-col :md="15" :xs="24">
                <el-card>
                  <template #header>基础变量</template>
                  <el-table :data="deviceVariableBaseRows" height="300" size="small" v-loading="deviceVariableLoading">
                    <el-table-column prop="name" label="变量名" min-width="140" />
                    <el-table-column prop="value" label="变量" min-width="180" show-overflow-tooltip />
                    <el-table-column label="模板路径" min-width="220">
                      <template #default="scope">{{ deviceVariablePlaceholder(scope.row.name) }}</template>
                    </el-table-column>
                    <el-table-column prop="updatedAt" label="更新时间" min-width="170" />
                    <el-table-column label="操作" width="130">
                      <template #default="scope">
                        <el-button link type="primary" @click="editDeviceVariable(scope.row)">修改</el-button>
                        <el-button link type="danger" @click="deleteDeviceVariable(scope.row)">删除</el-button>
                      </template>
                    </el-table-column>
                  </el-table>
                </el-card>
              </el-col>
            </el-row>
            <el-card style="margin-top:12px">
              <template #header>当前获取的 API 变量</template>
              <div class="row-actions" style="margin-bottom:8px">
                <el-input
                  v-model="deviceVariableApiKeyword"
                  clearable
                  placeholder="模糊搜索 API 变量名、路径、当前值、模板"
                  style="max-width:420px"
                />
                <el-tag>匹配 {{ filteredDeviceVariableApiRows.length }} / {{ deviceVariableApiRows.length }}</el-tag>
              </div>
              <el-table :data="filteredDeviceVariableApiRows" height="360" size="small" v-loading="deviceVariableLoading">
                <el-table-column prop="templateName" label="模板" min-width="130" />
                <el-table-column prop="name" label="变量名" min-width="180" show-overflow-tooltip />
                <el-table-column prop="value" label="当前变量" min-width="220" show-overflow-tooltip />
                <el-table-column prop="path" label="模板路径" min-width="280" show-overflow-tooltip />
                <el-table-column prop="updatedAt" label="更新时间" min-width="170" />
                <el-table-column label="操作" width="110">
                  <template #default="scope">
                    <el-button link type="primary" @click="copyApiVariableToBase(scope.row)">转为基础变量</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </section>

          <section v-if="activePanel === 'pools' && isAdmin" class="section-wrap">
            <h3>设备池管理</h3>
            <el-alert type="info" :closable="false" show-icon>
              <template #default>
                上方只负责新建设备池；修改已有设备池时，请在列表中点击“编辑”打开弹窗。
              </template>
            </el-alert>
            <el-row :gutter="12" class="pool-vertical">
              <el-col :md="24" :xs="24">
                <el-card>
                  <template #header>新建设备池</template>
                  <el-form :model="clusterCreateForm" label-width="88px" size="small">
                    <el-form-item label="设备池ID">
                      <el-input model-value="自动生成" disabled />
                    </el-form-item>
                    <el-form-item label="名称"><el-input v-model="clusterCreateForm.name" placeholder="例如：一号会议室" /></el-form-item>
                    <el-form-item label="描述"><el-input v-model="clusterCreateForm.description" placeholder="可选" /></el-form-item>
                  </el-form>
                  <div class="row-actions">
                    <el-button type="primary" @click="createCluster">创建设备池</el-button>
                    <el-button @click="resetClusterCreateForm">重置</el-button>
                    <el-button @click="loadClusters">刷新设备池</el-button>
                  </div>
                </el-card>
              </el-col>
              <el-col :md="24" :xs="24">
                <el-card>
                  <template #header>设备池列表</template>
                  <el-table :data="clusters" height="460" size="small" @row-click="openClusterEditor">
                    <el-table-column prop="name" label="名称" min-width="140" />
                    <el-table-column label="设备数" width="90">
                      <template #default="scope">{{ scope.row.deviceIds?.length || 0 }}</template>
                    </el-table-column>
                    <el-table-column prop="description" label="描述" min-width="180" />
                    <el-table-column label="设备预览" min-width="240">
                      <template #default="scope">{{ clusterDevicePreview(scope.row.deviceIds || []) }}</template>
                    </el-table-column>
                    <el-table-column prop="updatedAt" label="更新时间" min-width="180" />
                    <el-table-column label="操作" width="110">
                      <template #default="scope">
                        <el-button link type="primary" @click.stop="openClusterEditor(scope.row)">编辑</el-button>
                      </template>
                    </el-table-column>
                  </el-table>
                </el-card>
              </el-col>
            </el-row>
          </section>

          <section v-if="activePanel === 'remote'" class="section-wrap">
            <h3>远程控制（批量）</h3>
            <div class="row-actions">
              <el-select v-model="remoteClusterIds" multiple clearable filterable placeholder="选择设备池" style="width:300px">
                <el-option v-for="c in clusters" :key="c.id" :label="c.name" :value="c.id" />
              </el-select>
              <el-button @click="openDispatchPicker('remote')">弹窗选择设备</el-button>
              <el-tag type="warning">设备 {{ batchTargetDeviceIds.remote.length }} 台</el-tag>
              <el-tag>设备池 {{ remoteClusterIds.length }} 个</el-tag>
            </div>
            <el-row :gutter="12">
              <el-col :md="8" :xs="24">
                <el-card>
                  <template #header>切换界面</template>
                  <el-select v-model="remoteForm.view" style="width: 100%">
                    <el-option label="主页" value="home" />
                    <el-option label="天气" value="weather" />
                    <el-option label="桌牌" value="badge" />
                    <el-option label="待办" value="todo" />
                    <el-option label="设置页" value="settings" />
                    <el-option label="网络页" value="network" />
                    <el-option label="关于页" value="about" />
                  </el-select>
                  <div class="row-actions" style="margin-top:8px">
                    <el-switch v-model="remoteForm.setAsDefault" />
                    <span>设为设备默认开机界面</span>
                  </div>
                  <el-button type="primary" style="margin-top: 10px" @click="switchView">下发切换</el-button>
                </el-card>
              </el-col>
              <el-col :md="8" :xs="24">
                <el-card>
                  <template #header>发布公告</template>
                  <el-input v-model="remoteForm.text" placeholder="输入公告内容" />
                  <div class="row-actions" style="margin-top:8px">
                    <el-select v-model="remoteForm.announcementMode" style="width:130px">
                      <el-option label="状态栏公告" value="status" />
                      <el-option label="全屏公告" value="fullscreen" />
                    </el-select>
                    <el-input-number v-model="remoteForm.durationValue" :min="1" :max="7" />
                    <el-select v-model="remoteForm.durationUnit" style="width:110px">
                      <el-option label="分钟" value="minute" />
                      <el-option label="小时" value="hour" />
                      <el-option label="天" value="day" />
                    </el-select>
                  </div>
                  <el-button type="primary" style="margin-top: 10px" @click="showText">发布公告</el-button>
                </el-card>
              </el-col>
              <el-col :md="8" :xs="24">
                <el-card>
                  <template #header>图片投屏</template>
                  <input type="file" accept="image/*" @change="onImageChange" />
                  <div class="row-actions" style="margin-top:8px">
                    <el-button @click="openImagePreviewDialog">预览效果</el-button>
                    <el-tag>{{ remotePreviewResolution.w }}×{{ remotePreviewResolution.h }}</el-tag>
                  </div>
                  <div class="row-actions" style="margin-top: 8px">
                    <el-button type="primary" @click="showImage">发送图片</el-button>
                    <el-button @click="castStop">结束投屏</el-button>
                  </div>
                </el-card>
              </el-col>
            </el-row>
          </section>

          <section v-if="activePanel === 'taskPlans'" class="section-wrap">
            <h3>计划任务</h3>
            <div class="row-actions">
              <el-button :loading="taskPlanLoading" @click="loadTaskPlans">刷新任务</el-button>
              <el-button type="primary" plain @click="resetTaskPlanDraft">新建任务</el-button>
              <el-tag>低优先级会避让高优先级；手动执行优先级最高</el-tag>
            </div>
            <el-row :gutter="12">
              <el-col :md="10" :xs="24">
                <el-card>
                  <template #header>任务列表</template>
                  <el-table :data="taskPlans" height="420" size="small" @row-click="pickTaskPlan">
                    <el-table-column prop="name" label="名称" min-width="150" />
                    <el-table-column prop="priority" label="优先级" width="80" />
                    <el-table-column label="启用" width="70">
                      <template #default="scope">{{ scope.row.enabled ? "是" : "否" }}</template>
                    </el-table-column>
                    <el-table-column prop="nextRunAt" label="下次执行" min-width="170" />
                    <el-table-column label="操作" width="150">
                      <template #default="scope">
                        <el-button link type="primary" @click.stop="runTaskPlanNow(scope.row)">执行</el-button>
                        <el-button link type="danger" @click.stop="deleteTaskPlan(scope.row)">删除</el-button>
                      </template>
                    </el-table-column>
                  </el-table>
                </el-card>
              </el-col>
              <el-col :md="14" :xs="24">
                <el-card>
                  <template #header>{{ taskPlanDraft.id ? '编辑计划任务' : '新建计划任务' }}</template>
                  <el-form :model="taskPlanDraft" label-width="92px" size="small">
                    <el-form-item label="任务名称"><el-input v-model="taskPlanDraft.name" /></el-form-item>
                    <el-form-item label="描述"><el-input v-model="taskPlanDraft.description" /></el-form-item>
                    <el-form-item label="启用"><el-switch v-model="taskPlanDraft.enabled" /></el-form-item>
                    <el-form-item label="优先级"><el-input-number v-model="taskPlanDraft.priority" :min="0" :max="9999" /></el-form-item>
                    <el-form-item label="目标设备">
                      <el-select v-model="taskPlanDraft.targetDeviceIds" multiple collapse-tags collapse-tags-tooltip filterable style="width:100%">
                        <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="目标设备池">
                      <el-select v-model="taskPlanDraft.targetClusterIds" multiple collapse-tags collapse-tags-tooltip filterable style="width:100%">
                        <el-option v-for="c in clusters" :key="c.id" :label="c.name" :value="c.id" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="调度模式">
                      <el-select v-model="taskPlanDraft.scheduleMode" style="width:220px">
                        <el-option label="一次性" value="once" />
                        <el-option label="每周几" value="weekly" />
                        <el-option label="日历月日" value="calendar" />
                      </el-select>
                    </el-form-item>
                    <el-form-item label="一次时间" v-if="taskPlanDraft.scheduleMode === 'once'">
                      <el-date-picker v-model="taskPlanOnceAt" type="datetime" placeholder="选择执行时间" style="width:260px" />
                    </el-form-item>
                    <el-form-item label="星期" v-if="taskPlanDraft.scheduleMode === 'weekly'">
                      <el-checkbox-group v-model="taskPlanWeekdays">
                        <el-checkbox :label="1">周一</el-checkbox>
                        <el-checkbox :label="2">周二</el-checkbox>
                        <el-checkbox :label="3">周三</el-checkbox>
                        <el-checkbox :label="4">周四</el-checkbox>
                        <el-checkbox :label="5">周五</el-checkbox>
                        <el-checkbox :label="6">周六</el-checkbox>
                        <el-checkbox :label="7">周日</el-checkbox>
                      </el-checkbox-group>
                    </el-form-item>
                    <el-form-item label="月日" v-if="taskPlanDraft.scheduleMode === 'calendar'">
                      <el-input v-model="taskPlanCalendarDatesText" placeholder="例如：05-12,06-01" />
                    </el-form-item>
                    <el-form-item label="执行时间" v-if="taskPlanDraft.scheduleMode !== 'once'">
                      <el-input v-model="taskPlanTimesText" placeholder="例如：09:00,18:30" />
                    </el-form-item>
                  </el-form>

                  <div class="row-between" style="margin:8px 0">
                    <strong>动作步骤</strong>
                    <el-button size="small" @click="addTaskPlanStep">新增步骤</el-button>
                  </div>
                  <el-table :data="taskPlanSteps" height="280" size="small">
                    <el-table-column label="#" width="46"><template #default="scope">{{ scope.$index + 1 }}</template></el-table-column>
                    <el-table-column label="动作" min-width="170">
                      <template #default="scope">
                        <el-select v-model="scope.row.actionType" style="width:100%">
                          <el-option label="修改基础变量" value="device.variable.upsert" />
                          <el-option label="刷新API模板" value="api_template.refresh" />
                          <el-option label="下发后端地址" value="remote.update_backend_url" />
                          <el-option label="切换设备界面" value="remote.switch_view" />
                        </el-select>
                      </template>
                    </el-table-column>
                    <el-table-column label="参数" min-width="300">
                      <template #default="scope">
                        <div class="stack-vertical compact">
                          <template v-if="scope.row.actionType === 'device.variable.upsert'">
                            <el-input v-model="scope.row.name" placeholder="变量名" />
                            <el-input v-model="scope.row.value" placeholder="变量值" />
                          </template>
                          <template v-else-if="scope.row.actionType === 'api_template.refresh'">
                            <el-select v-model="scope.row.slug" filterable placeholder="API模板slug" style="width:100%">
                              <el-option v-for="tpl in templateRows" :key="tpl.slug" :label="`${tpl.name} (${tpl.slug})`" :value="tpl.slug" />
                            </el-select>
                          </template>
                          <template v-else-if="scope.row.actionType === 'remote.update_backend_url'">
                            <el-input v-model="scope.row.backendBaseUrl" placeholder="https://example.com:19999" />
                          </template>
                          <template v-else>
                            <el-select v-model="scope.row.view" style="width:100%">
                              <el-option label="主页" value="home" />
                              <el-option label="天气" value="weather" />
                              <el-option label="桌牌" value="badge" />
                              <el-option label="待办" value="todo" />
                              <el-option label="设置页" value="settings" />
                              <el-option label="网络页" value="network" />
                              <el-option label="关于页" value="about" />
                            </el-select>
                          </template>
                        </div>
                      </template>
                    </el-table-column>
                    <el-table-column label="失败继续" width="100">
                      <template #default="scope"><el-switch v-model="scope.row.continueOnError" /></template>
                    </el-table-column>
                    <el-table-column label="操作" width="70">
                      <template #default="scope"><el-button link type="danger" @click="removeTaskPlanStep(scope.$index)">删除</el-button></template>
                    </el-table-column>
                  </el-table>
                  <div class="row-actions" style="margin-top:10px">
                    <el-button type="primary" :loading="taskPlanSaving" @click="saveTaskPlan">保存任务</el-button>
                    <el-button v-if="taskPlanDraft.id" :loading="taskPlanRunning" @click="runTaskPlanNow(taskPlanDraft)">手动执行</el-button>
                  </div>
                </el-card>
              </el-col>
            </el-row>
            <el-card style="margin-top:12px">
              <template #header>运行历史</template>
              <el-table :data="taskPlanRuns" height="260" size="small">
                <el-table-column prop="triggerType" label="触发" width="90" />
                <el-table-column prop="status" label="状态" width="130" />
                <el-table-column prop="reason" label="原因" min-width="160" />
                <el-table-column prop="startedAt" label="开始" min-width="170" />
                <el-table-column prop="finishedAt" label="结束" min-width="170" />
              </el-table>
            </el-card>
          </section>

          <section v-if="activePanel === 'homepage'" class="section-wrap">
            <h3>主页</h3>
            <div class="row-actions">
              <el-select v-model="homepageClusterIds" multiple clearable filterable placeholder="选择设备池" style="width:300px">
                <el-option v-for="c in clusters" :key="c.id" :label="c.name" :value="c.id" />
              </el-select>
              <el-button @click="openDispatchPicker('homepage')">弹窗选择设备</el-button>
              <el-tag type="warning">设备 {{ batchTargetDeviceIds.homepage.length }} 台</el-tag>
              <el-tag>设备池 {{ homepageClusterIds.length }} 个</el-tag>
              <el-button @click="loadHomepageAll">刷新主页数据</el-button>
            </div>
            <div class="stack-vertical">
              <el-card>
                <template #header>
                  <div class="row-between">
                    <strong>渲染预览</strong>
                    <el-radio-group v-model="homepagePreviewMode" size="small">
                      <el-radio-button value="edit">编辑预览</el-radio-button>
                      <el-radio-button value="delivery">下发预览</el-radio-button>
                    </el-radio-group>
                  </div>
                </template>
                <div v-if="homepagePreviewMode === 'edit'" class="image-preview-shell">
                  <div class="image-preview-stage" :style="homepagePreviewStageStyle">
                    <img v-if="homepageEditPreviewUrl" :src="homepageEditPreviewUrl" class="homepage-preview-img" alt="homepage edit preview" />
                    <div v-else class="image-preview-empty">
                      {{ homepageEditPreviewLoading ? "编辑预览渲染中..." : (homepageEditPreviewError || "编辑模板后自动生成预览") }}
                    </div>
                    <div v-if="showHomepageTimeOverlayPreview" class="time-overlay-preview" :style="homepageTimeOverlayPreviewStyle">
                      <SegmentTimePreview
                        :width="homepageTimeOverlayBox.width"
                        :height="homepageTimeOverlayBox.height"
                        :format="homepageTimeOverlayFormat"
                        :font-size="homepageTimeOverlayFontSize"
                        :align="homepageTimeOverlayAlign"
                        color="#000000"
                      />
                    </div>
                  </div>
                </div>
                <template v-else>
                  <div style="font-size:12px;color:#64748b;display:grid;gap:4px">
                    <div>etag: {{ homepageRenderMeta.etag || "-" }}</div>
                    <div>image: {{ homepageRenderMeta.image_id || "-" }}</div>
                    <div>size: {{ homepageRenderMeta.image_width || 0 }} x {{ homepageRenderMeta.image_height || 0 }}</div>
                  </div>
                  <div class="image-preview-shell" style="margin-top:10px">
                    <div class="image-preview-stage" :style="homepagePreviewStageStyle">
                      <img v-if="homepagePreviewUrl" :src="homepagePreviewUrl" class="homepage-preview-img" alt="homepage preview" />
                      <div v-else class="image-preview-empty">先执行一次渲染</div>
                      <div v-if="showHomepageTimeOverlayPreview" class="time-overlay-preview" :style="homepageTimeOverlayPreviewStyle">
                        <SegmentTimePreview
                          :width="homepageTimeOverlayBox.width"
                          :height="homepageTimeOverlayBox.height"
                          :format="homepageTimeOverlayFormat"
                          :font-size="homepageTimeOverlayFontSize"
                          :align="homepageTimeOverlayAlign"
                          color="#000000"
                        />
                      </div>
                    </div>
                  </div>
                </template>
              </el-card>

              <el-card>
                <template #header><strong>主页配置</strong></template>
                <el-form label-width="118px" size="small">
                  <el-form-item label="目标设备">
                    <el-select v-model="homepageDeviceId" filterable style="width:100%" @change="loadHomepageConfig">
                      <el-option-group v-for="group in homepageDeviceGroups" :key="group.type" :label="group.label">
                        <el-option v-for="d in group.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
                      </el-option-group>
                    </el-select>
                  </el-form-item>
                  <el-form-item label="模板 ID">
                    <el-select v-model="homepageConfigModel.template.template_id" filterable style="width:100%">
                      <el-option v-for="tpl in homepageTemplatesForDevice" :key="tpl.id" :label="homepageTemplateOptionLabel(tpl)" :value="tpl.id" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="时间覆盖启用"><el-switch v-model="homepageConfigModel.time_overlay.enabled" /></el-form-item>
                  <el-form-item label="时间格式"><el-input v-model="homepageConfigModel.time_overlay.format" /></el-form-item>
                  <el-form-item label="时间区域 X/Y/W/H">
                    <div class="row-actions">
                      <el-input-number v-model="homepageConfigModel.time_overlay.x" :min="0" />
                      <el-input-number v-model="homepageConfigModel.time_overlay.y" :min="0" />
                      <el-input-number v-model="homepageConfigModel.time_overlay.width" :min="40" />
                      <el-input-number v-model="homepageConfigModel.time_overlay.height" :min="40" />
                    </div>
                  </el-form-item>
                  <el-form-item label="字号/间隔">
                    <div class="row-actions">
                      <el-input-number v-model="homepageConfigModel.time_overlay.font_size" :min="12" :max="220" />
                      <el-input-number v-model="homepageConfigModel.time_overlay.refresh_interval_sec" :min="1" :max="3600" />
                    </div>
                  </el-form-item>
                  <el-form-item label="时间对齐">
                    <el-select v-model="homepageConfigModel.time_overlay.align" style="width:160px">
                      <el-option label="左对齐" value="left" />
                      <el-option label="居中" value="center" />
                      <el-option label="右对齐" value="right" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="JSON 高级配置">
                    <el-input v-model="homepageConfigJson" type="textarea" :rows="11" />
                  </el-form-item>
                </el-form>
                <div class="row-actions">
                  <el-button type="primary" :loading="homepageConfigSaving" @click="saveHomepageConfig">保存配置</el-button>
                  <el-button @click="renderHomepage">仅渲染</el-button>
                  <el-button type="success" :loading="homepagePushLoading" @click="pushHomepage">渲染并推送</el-button>
                </div>
                <el-divider />
                <el-form label-width="118px" size="small">
                  <el-form-item label="自动渲染下发">
                    <el-switch v-model="homepageConfigModel.auto_render_push.enabled" />
                  </el-form-item>
                  <el-form-item label="固定时刻" v-if="homepageConfigModel.auto_render_push.enabled">
                    <div style="display:grid;gap:6px;width:100%">
                      <el-select
                        v-model="homepageConfigModel.auto_render_push.fixed_times"
                        multiple
                        filterable
                        allow-create
                        default-first-option
                        clearable
                        :reserve-keyword="false"
                        style="width:100%"
                        placeholder="例如 07:30、12:00、18:30"
                      >
                        <el-option v-for="item in homepageAutoFixedTimeOptions" :key="item" :label="item" :value="item" />
                      </el-select>
                      <span style="font-size:12px;color:#64748b">支持多个时间点触发，格式为 HH:mm。</span>
                    </div>
                  </el-form-item>
                  <el-form-item label="区间循环触发" v-if="homepageConfigModel.auto_render_push.enabled">
                    <el-switch v-model="homepageConfigModel.auto_render_push.interval_enabled" />
                  </el-form-item>
                  <el-form-item
                    label="区间开始/结束"
                    v-if="homepageConfigModel.auto_render_push.enabled && homepageConfigModel.auto_render_push.interval_enabled"
                  >
                    <div class="row-actions">
                      <el-time-picker
                        v-model="homepageConfigModel.auto_render_push.window_start_time"
                        value-format="HH:mm"
                        format="HH:mm"
                        :clearable="false"
                        placeholder="07:30"
                      />
                      <el-time-picker
                        v-model="homepageConfigModel.auto_render_push.window_end_time"
                        value-format="HH:mm"
                        format="HH:mm"
                        :clearable="false"
                        placeholder="23:59"
                      />
                    </div>
                  </el-form-item>
                  <el-form-item
                    label="循环间隔"
                    v-if="homepageConfigModel.auto_render_push.enabled && homepageConfigModel.auto_render_push.interval_enabled"
                  >
                    <el-select v-model="homepageConfigModel.auto_render_push.interval_minutes" style="width:180px">
                      <el-option label="10 分钟" :value="10" />
                      <el-option label="30 分钟" :value="30" />
                      <el-option label="1 小时" :value="60" />
                      <el-option label="2 小时" :value="120" />
                      <el-option label="6 小时" :value="360" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="自动任务状态">
                    <div style="display:grid;gap:6px;font-size:12px;color:#475569">
                      <div>状态：{{ homepageConfigModel.auto_render_push.enabled ? "已开启" : "已关闭" }}</div>
                      <div>固定时刻：{{ (homepageConfigModel.auto_render_push.fixed_times || []).length ? (homepageConfigModel.auto_render_push.fixed_times || []).join(" / ") : "-" }}</div>
                      <div>
                        区间循环：
                        {{
                          homepageConfigModel.auto_render_push.interval_enabled
                            ? `${homepageConfigModel.auto_render_push.window_start_time || "07:30"} ~ ${homepageConfigModel.auto_render_push.window_end_time || "23:59"}，每 ${Number(homepageConfigModel.auto_render_push.interval_minutes || 60)} 分钟`
                            : "关闭"
                        }}
                      </div>
                      <div>下次执行时间：{{ formatDateTimeText(homepageConfigModel.auto_render_push.next_run_at) }}</div>
                      <div>上次执行时间：{{ formatDateTimeText(homepageConfigModel.auto_render_push.last_run_at) }}</div>
                      <div>调度判定：{{ homepageConfigModel.auto_render_push.scheduler_decision || "-" }}</div>
                      <div>调度心跳：{{ formatDateTimeText(homepageConfigModel.auto_render_push.scheduler?.last_tick_at || "") }}</div>
                      <div>
                        上次执行结果：
                        <el-tag size="small" :type="homepageAutoLastResultTagType">{{ homepageAutoLastResultText }}</el-tag>
                      </div>
                      <div>失败原因：{{ homepageConfigModel.auto_render_push.last_error || "-" }}</div>
                    </div>
                  </el-form-item>
                </el-form>
                <div class="row-actions">
                  <el-button :loading="homepageAutoRunLoading" @click="runHomepageAutoRenderNow">立即执行一次自动任务</el-button>
                </div>
              </el-card>

              <el-card>
                <template #header><strong>主页模板</strong></template>
                <el-form label-width="92px" size="small">
                  <el-form-item label="模板">
                    <el-select v-model="homepageTemplateDraft.id" clearable filterable style="width:100%" @change="onSelectHomepageTemplate">
                      <el-option v-for="tpl in homepageTemplates" :key="tpl.id" :label="tpl.name" :value="tpl.id" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="名称"><el-input v-model="homepageTemplateDraft.name" /></el-form-item>
                  <el-form-item label="设备类型">
                    <el-select
                      v-model="homepageTemplateDraft.targetDeviceTypes"
                      multiple
                      clearable
                      collapse-tags
                      collapse-tags-tooltip
                      style="width:100%"
                      placeholder="通用型，或选择一个/多个设备类型"
                    >
                      <el-option v-for="item in homepageDeviceTypeOptions" :key="item.value" :label="item.label" :value="item.value" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="HTML">
                    <el-input ref="homepageTemplateHtmlInputRef" v-model="homepageTemplateDraft.html" type="textarea" :rows="13" />
                  </el-form-item>
                </el-form>
                <div class="row-actions">
                  <el-button @click="newHomepageTemplate">新建模板</el-button>
                  <el-button type="primary" @click="saveHomepageTemplate">保存模板</el-button>
                  <el-button type="danger" :disabled="!homepageTemplateDraft.id || homepageTemplateDraft.builtin" @click="deleteHomepageTemplate">删除模板</el-button>
                  <el-button @click="openHomepageVariablePanel">插入变量</el-button>
                </div>
              </el-card>
            </div>
          </section>

          <section v-if="activePanel === 'layout'" class="section-wrap">
            <h3>桌牌设置</h3>
            <div class="stack-vertical">
              <el-card>
                <el-form :model="layoutForm" label-width="108px" size="small">
                  <el-form-item label="布局名称"><el-input v-model="layoutForm.layoutName" /></el-form-item>
                  <el-form-item label="设备类型"><el-input v-model="layoutForm.deviceType" /></el-form-item>
                  <el-form-item label="字体">
                    <el-select v-model="layoutForm.fontFamily" filterable allow-create default-first-option style="width:100%">
                      <el-option v-for="font in fontOptions" :key="font" :label="font" :value="font" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="姓名字号"><el-input-number v-model="layoutForm.nameFontSize" :min="28" :max="320" /></el-form-item>
                  <el-form-item label="职位字号"><el-input-number v-model="layoutForm.titleFontSize" :min="12" :max="200" /></el-form-item>
                  <el-form-item label="对齐方式">
                    <el-select v-model="layoutForm.align">
                      <el-option label="左对齐" value="left" />
                      <el-option label="居中" value="center" />
                      <el-option label="右对齐" value="right" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="边距"><el-input-number v-model="layoutForm.margin" :min="0" :max="240" /></el-form-item>
                  <el-form-item label="姓名X偏移"><el-input-number v-model="layoutForm.nameOffsetX" :min="-1200" :max="1200" /></el-form-item>
                  <el-form-item label="姓名Y偏移"><el-input-number v-model="layoutForm.nameOffsetY" :min="-900" :max="900" /></el-form-item>
                  <el-form-item label="职位X偏移"><el-input-number v-model="layoutForm.titleOffsetX" :min="-1200" :max="1200" /></el-form-item>
                  <el-form-item label="职位Y偏移"><el-input-number v-model="layoutForm.titleOffsetY" :min="-900" :max="900" /></el-form-item>
                </el-form>
                <div class="row-actions">
                  <el-button type="primary" @click="saveLayout">保存布局</el-button>
                  <el-button @click="resetLayoutForm">重置</el-button>
                  <el-button @click="loadLayouts">刷新布局</el-button>
                </div>
              </el-card>

              <el-card>
                <template #header>
                  <div class="row-between">
                    <span>实时预览（拖动姓名/职位可改位置）</span>
                    <el-button link type="primary" @click="previewDialogOpen = true">弹窗等比预览</el-button>
                  </div>
                </template>

                <div
                  ref="previewRef"
                  class="nameplate-stage"
                  :style="stageStyle"
                  @pointermove="onPreviewMove"
                  @pointerup="onPreviewUp"
                  @pointerleave="onPreviewUp"
                >
                  <div class="preview-name" :style="nameStyle" @pointerdown.stop="onPreviewDown('name', $event)">{{ singleForm.name || '张三' }}</div>
                  <div class="preview-title" :style="titleStyle" @pointerdown.stop="onPreviewDown('title', $event)">{{ singleForm.title || '产品经理' }}</div>
                </div>

                <el-divider />
                <h4>下发功能 1：下发到指定设备</h4>
                <el-form :model="singleForm" label-width="88px" size="small">
                  <el-form-item label="布局ID">
                    <el-input :model-value="singleForm.layoutId || layoutForm.id || '将自动生成'" disabled />
                  </el-form-item>
                  <el-form-item label="目标设备">
                    <el-select v-model="singleForm.deviceId" filterable style="width:100%" placeholder="选择一台设备">
                      <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="姓名"><el-input v-model="singleForm.name" /></el-form-item>
                  <el-form-item label="职位"><el-input v-model="singleForm.title" /></el-form-item>
                </el-form>
                <div class="row-actions">
                  <el-button type="primary" @click="pushSingle">下发到指定设备</el-button>
                  <el-button @click="openBatchDialog">打开批量下发弹窗</el-button>
                </div>
              </el-card>
            </div>

            <el-card style="margin-top: 12px">
              <template #header>布局列表</template>
              <el-table :data="layouts" height="240" size="small" @row-click="pickLayout">
                <el-table-column prop="layoutName" label="布局" min-width="140" />
                <el-table-column prop="deviceType" label="设备类型" width="160" />
                <el-table-column prop="fontFamily" label="字体" width="170" />
                <el-table-column prop="updatedAt" label="更新时间" min-width="180" />
                <el-table-column label="操作" width="160">
                  <template #default="scope">
                    <el-button link type="primary" @click.stop="pickLayout(scope.row)">编辑</el-button>
                    <el-button link type="danger" @click.stop="deleteLayout(scope.row.id)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>
            </el-card>
          </section>

          <section v-if="activePanel === 'history'" class="section-wrap">
            <h3>桌牌历史</h3>
            <div class="row-actions"><el-button @click="loadHistory">刷新历史</el-button></div>
            <el-table :data="history" height="340" size="small" style="margin-top:8px">
              <el-table-column prop="name" label="姓名" width="120" />
              <el-table-column prop="title" label="职位" min-width="120" />
              <el-table-column prop="deviceType" label="设备类型" width="130" />
              <el-table-column prop="createdAt" label="下发时间" min-width="180" />
              <el-table-column label="操作" width="120">
                <template #default="scope">
                  <el-button link type="danger" @click="deleteHistory(scope.row.id)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>

        </el-main>
      </el-container>
    </el-card>

    <TemplateVariablePanel
      v-model="homepageInsertVarVisible"
      :variables="homepageTemplateVariables"
      :loading="homepageInsertVarLoading"
      :is-mobile="isMobile"
      title="主页变量"
      subtitle="基础变量 / 设备变量 / API模板变量"
      @refresh="loadHomepageTemplateVariables"
      @insert="insertHomepageTemplateVariable"
    />

    <el-dialog v-model="previewDialogOpen" title="桌牌等比例预览" width="80%" append-to-body>
      <div class="dialog-preview-wrap">
        <div class="nameplate-stage dialog" :style="stageDialogStyle">
          <div class="preview-name" :style="nameDialogStyle">{{ singleForm.name || '张三' }}</div>
          <div class="preview-title" :style="titleDialogStyle">{{ singleForm.title || '产品经理' }}</div>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="batchDialogOpen" title="批量桌牌下发（表格）" width="88%" append-to-body>
      <div class="row-actions" style="margin-bottom:8px">
        <el-select v-model="batchPlanId" clearable filterable placeholder="选择历史方案" style="width: 300px" @change="loadBatchPlanToRows">
          <el-option v-for="plan in batchPlans" :key="plan.id" :label="plan.planName" :value="plan.id" />
        </el-select>
        <el-input v-model="batchPlanName" placeholder="方案名称" style="width:220px" />
        <el-button @click="saveBatchPlan">保存方案</el-button>
        <el-button v-if="batchPlanId" type="danger" plain @click="deleteBatchPlan">删除方案</el-button>
        <el-button @click="addBatchRow">新增一行</el-button>
        <el-button @click="executeBatchPush" type="primary">批量下发</el-button>
      </div>

      <el-alert type="warning" :closable="false" show-icon>
        <template #default>
          每行对应一个姓名/职位，可选择“指定设备”或“随机设备（从设备池抽取N台）”。
        </template>
      </el-alert>

      <el-table :data="batchRows" height="420" size="small" style="margin-top:8px">
        <el-table-column label="#" width="52">
          <template #default="scope">{{ scope.$index + 1 }}</template>
        </el-table-column>
        <el-table-column label="姓名" min-width="140">
          <template #default="scope"><el-input v-model="scope.row.name" /></template>
        </el-table-column>
        <el-table-column label="职位" min-width="140">
          <template #default="scope"><el-input v-model="scope.row.title" /></template>
        </el-table-column>
        <el-table-column label="模式" width="120">
          <template #default="scope">
            <el-select v-model="scope.row.mode">
              <el-option label="指定设备" value="specified" />
              <el-option label="随机设备" value="random" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="指定设备" min-width="260">
          <template #default="scope">
            <el-select
              v-model="scope.row.deviceIds"
              multiple
              collapse-tags
              collapse-tags-tooltip
              filterable
              style="width:100%"
              placeholder="选择设备"
              :disabled="scope.row.mode !== 'specified'"
            >
              <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="随机设备池" min-width="260">
          <template #default="scope">
            <el-select
              v-model="scope.row.poolDeviceIds"
              multiple
              collapse-tags
              collapse-tags-tooltip
              filterable
              style="width:100%"
              placeholder="选择设备池"
              :disabled="scope.row.mode !== 'random'"
            >
              <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="随机N" width="100">
          <template #default="scope"><el-input-number v-model="scope.row.randomCount" :min="1" :max="999" :disabled="scope.row.mode !== 'random'" /></template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="scope"><el-button link type="danger" @click="removeBatchRow(scope.$index)">删除</el-button></template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="deviceVariableBatchDialogOpen" title="批量设备变量设置（表格）" width="88%" append-to-body>
      <div class="row-actions" style="margin-bottom:8px">
        <el-button @click="addDeviceVariableBatchRow">新增一行</el-button>
        <el-button type="primary" @click="executeDeviceVariableBatch">批量保存</el-button>
      </div>
      <el-alert type="info" :closable="false" show-icon>
        <template #default>
          每行对应一个变量名/变量；变量名和变量都可以从现有值中选择，也可以直接输入。
        </template>
      </el-alert>
      <el-table :data="deviceVariableBatchRows" height="420" size="small" style="margin-top:8px">
        <el-table-column label="#" width="52">
          <template #default="scope">{{ scope.$index + 1 }}</template>
        </el-table-column>
        <el-table-column label="变量名" min-width="160">
          <template #default="scope">
            <el-select
              v-model="scope.row.name"
              filterable
              allow-create
              default-first-option
              clearable
              style="width:100%"
              placeholder="选择或输入变量名"
            >
              <el-option v-for="name in deviceVariableBaseNameOptions" :key="name" :label="name" :value="name" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="变量" min-width="180">
          <template #default="scope">
            <el-select
              v-model="scope.row.value"
              filterable
              allow-create
              default-first-option
              clearable
              style="width:100%"
              placeholder="选择或输入变量"
            >
              <el-option v-for="value in deviceVariableBaseValueOptions" :key="value" :label="value" :value="value" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="模式" width="120">
          <template #default="scope">
            <el-select v-model="scope.row.mode">
              <el-option label="指定设备" value="specified" />
              <el-option label="随机设备池" value="random" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="指定设备" min-width="260">
          <template #default="scope">
            <el-select
              v-model="scope.row.deviceIds"
              multiple
              collapse-tags
              collapse-tags-tooltip
              filterable
              style="width:100%"
              placeholder="选择设备"
              :disabled="scope.row.mode !== 'specified'"
            >
              <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="随机设备池" min-width="240">
          <template #default="scope">
            <el-select
              v-model="scope.row.clusterIds"
              multiple
              collapse-tags
              collapse-tags-tooltip
              filterable
              style="width:100%"
              placeholder="选择设备池"
              :disabled="scope.row.mode !== 'random'"
            >
              <el-option v-for="cluster in clusters" :key="cluster.id" :label="cluster.name" :value="cluster.id" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="随机N" width="110">
          <template #default="scope"><el-input-number v-model="scope.row.randomCount" :min="1" :max="999" :disabled="scope.row.mode !== 'random'" /></template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="scope"><el-button link type="danger" @click="removeDeviceVariableBatchRow(scope.$index)">删除</el-button></template>
        </el-table-column>
      </el-table>
    </el-dialog>

    <el-dialog v-model="clusterEditDialogOpen" :title="clusterForm.name ? `编辑设备池：${clusterForm.name}` : '编辑设备池'" width="92%" append-to-body>
      <div class="cluster-edit-shell">
        <el-card class="cluster-edit-meta" shadow="never">
          <template #header>设备池修改</template>
          <el-form :model="clusterForm" label-width="88px" size="small">
            <el-form-item label="设备池ID"><el-input v-model="clusterForm.id" disabled /></el-form-item>
            <el-form-item label="名称"><el-input v-model="clusterForm.name" placeholder="例如：一号会议室" /></el-form-item>
            <el-form-item label="描述"><el-input v-model="clusterForm.description" placeholder="可选" /></el-form-item>
          </el-form>
        </el-card>
        <el-card shadow="never">
          <template #header>设备池设备选择（框选/筛选）</template>
          <div class="row-actions" style="margin-bottom:8px">
            <el-tag type="warning">已选 {{ poolPickerSelection.length }} 台</el-tag>
            <el-tag>筛选后 {{ poolFilteredIds.length }} 台</el-tag>
          </div>
          <device-lasso-picker
            ref="poolPickerRef"
            :devices="deviceStore.devices"
            :model-value="poolPickerSelection"
            @update:model-value="setPoolPickerSelection"
            @filtered-change="onPoolFilteredChange"
          />
        </el-card>
      </div>
      <template #footer>
        <div class="row-actions">
          <el-button @click="poolPickerRef?.selectAllFiltered?.()">全选筛选结果</el-button>
          <el-button @click="poolPickerRef?.invertFilteredSelection?.()">反选筛选结果</el-button>
          <el-button @click="clearPoolPickerSelection">清空选择</el-button>
          <el-button type="danger" plain @click="deleteCluster">删除设备池</el-button>
          <el-button type="primary" @click="saveCluster">保存修改</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="dispatchPickerDialogOpen" :title="`选择目标设备（${dispatchTargetKeyLabel}）`" width="92%" append-to-body>
      <device-lasso-picker
        ref="dispatchPickerRef"
        :devices="deviceStore.devices"
        :model-value="dispatchPickerSelection"
        @update:model-value="setDispatchPickerSelection"
        @filtered-change="onDispatchFilteredChange"
      />
      <template #footer>
        <div class="row-actions">
          <el-button @click="dispatchPickerRef?.selectAllFiltered?.()">全选筛选结果</el-button>
          <el-button @click="dispatchPickerRef?.invertFilteredSelection?.()">反选筛选结果</el-button>
          <el-button @click="clearDispatchPickerSelection">清空选择</el-button>
          <el-tag>筛选后 {{ dispatchFilteredIds.length }} 台</el-tag>
          <el-button type="primary" @click="confirmDispatchPicker">应用到当前模块</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog v-model="imagePreviewDialogOpen" title="投屏预览（设备分辨率）" width="86%" append-to-body>
      <div class="image-preview-shell">
        <div class="image-preview-stage" :style="imagePreviewStageStyle">
          <img v-if="imagePreviewUrl" :src="imagePreviewUrl" class="image-preview-img" alt="preview" />
          <div v-else class="image-preview-empty">请先选择图片</div>
        </div>
      </div>
    </el-dialog>

    <TemplateAdvancedEditorDialog
      v-model="templateAdvancedDialogVisible"
      :title="templateAdvancedEditorTitle"
      :config="templateDraft.advancedConfig"
      @save="saveTemplateAdvancedConfig"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus/es/components/message/index.mjs";
import { ElMessageBox } from "element-plus/es/components/message-box/index.mjs";
import { useAuthStore, type AppRole } from "../stores/auth";
import { useDeviceStore } from "../stores/devices";
import { apiRequest } from "../services/api";
import {
  fetchDeviceTypes,
  createDeviceType,
  updateDeviceType,
  deleteDeviceType,
  type DeviceTypeRow,
} from "../services/deviceTypes";
import {
  fetchNvsBackups,
  fetchNvsShadow,
  fetchNvsSchema,
  restoreNvsBackup,
  writeNvsValue,
  type NvsBackup,
  type NvsItem,
} from "../services/nvs";
import {
  assignAdminAiConfig,
  createAdminAiConfig,
  fetchAdminAiConfigs,
  fetchMyAiConfig,
  saveMyAiConfig,
  type AiConfigRow,
} from "../services/aiConfig";
import DeviceLassoPicker from "../components/DeviceLassoPicker.vue";
import TemplateVariablePanel from "../components/TemplateVariablePanel.vue";
import TemplateAdvancedEditorDialog from "../components/TemplateAdvancedEditorDialog.vue";

const ScheduleXiquePanel = defineAsyncComponent(() => import("../components/ScheduleXiquePanel.vue"));
const SegmentTimePreview = defineAsyncComponent(() => import("../components/SegmentTimePreview.vue"));
const SystemUpgradePanel = defineAsyncComponent(() => import("../components/SystemUpgradePanel.vue"));
const E6AlbumPanel = defineAsyncComponent(() => import("../components/E6AlbumPanel.vue"));
const E6DeviceDetailCard = defineAsyncComponent(() => import("../components/E6DeviceDetailCard.vue"));
const AiChatPanel = defineAsyncComponent(() => import("../components/AiChatPanel.vue"));

type DispatchTargetKey = "todo" | "schedule" | "templates" | "tf" | "remote" | "homepage" | "backendUrl" | "firmware";
type TaskPlanStepRow = {
  id?: string;
  actionType: "device.variable.upsert" | "api_template.refresh" | "remote.update_backend_url" | "remote.switch_view";
  title?: string;
  enabled?: boolean;
  orderIndex?: number;
  continueOnError: boolean;
  name?: string;
  value?: string;
  slug?: string;
  backendBaseUrl?: string;
  view?: string;
};
type TaskPlanRow = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  targetDeviceIds: string[];
  targetClusterIds: string[];
  scheduleMode: "once" | "weekly" | "calendar";
  scheduleSpec: Record<string, any>;
  repeatSpec?: Record<string, any>;
  retrySpec?: Record<string, any>;
  steps: Array<Record<string, any>>;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt?: string;
  updatedAt?: string;
};
type TaskRunRow = {
  id: string;
  planId: string;
  triggerType: string;
  status: string;
  reason: string;
  startedAt: string;
  finishedAt: string;
};

const props = defineProps<{ role: AppRole }>();
const title = props.role === "admin" ? "管理端" : "用户端";
const isAdmin = computed(() => props.role === "admin");

const auth = useAuthStore();
const deviceStore = useDeviceStore();
const darkMode = ref(false);
const activePanel = ref("overview");
const sidebarCollapsed = ref(false);
const mobileNavOpen = ref(false);
const pickerRef = ref<any>(null);
const filteredDeviceIds = ref<string[]>([]);
const poolPickerRef = ref<any>(null);
const clusterEditDialogOpen = ref(false);
const poolPickerSelection = ref<string[]>([]);
const poolFilteredIds = ref<string[]>([]);
const dispatchPickerRef = ref<any>(null);
const dispatchPickerDialogOpen = ref(false);
const dispatchPickerSelection = ref<string[]>([]);
const dispatchFilteredIds = ref<string[]>([]);
const dispatchTargetKey = ref<DispatchTargetKey>("remote");

const loginForm = reactive({ username: auth.lastUsername || auth.username || "", password: "" });
const loginLoading = ref(false);
const windowWidth = ref(typeof window !== "undefined" ? window.innerWidth : 1440);
const handleResize = () => {
  windowWidth.value = window.innerWidth;
};
const isMobile = computed(() => windowWidth.value < 900);

const overview = reactive({
  deviceTotal: 0,
  deviceBound: 0,
  deviceUnbound: 0,
  deviceOnline: 0,
  deviceOffline: 0,
  todoCount: 0,
  scheduleCount: 0,
  firmwareCount: 0,
});
const passwordForm = reactive({ oldPassword: "", newPassword: "" });

type AdminUserRow = {
  id: string;
  username: string;
  role: "admin" | "user";
  status: "enabled" | "blocked";
  nickname: string;
  deviceCount?: number;
  _newPassword: string;
  _deleteMode: "detach" | "purge";
};
const adminUsers = ref<AdminUserRow[]>([]);
const adminUserCreateForm = reactive({
  username: "",
  password: "",
  role: "user" as "admin" | "user",
  nickname: "",
});
const adminResourceForm = reactive({
  userId: "",
  action: "detach" as "detach" | "transfer" | "purge",
  targetUserId: "",
});
const aiConfigLoading = ref(false);
const aiSettingsDrawerOpen = ref(false);
const aiEffective = ref<Record<string, any> | null>(null);
const aiConfigForm = reactive({
  name: "我的 DeepSeek",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKey: "",
  enabled: true,
  thinkingEnabled: false,
});
const adminAiConfigs = ref<AiConfigRow[]>([]);
const adminAiConfigForm = reactive({
  name: "团队 DeepSeek",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKey: "",
  enabled: true,
});
const adminAiAssignForm = reactive({
  configId: "",
  userIds: [] as string[],
});
const aiEffectiveText = computed(() => {
  const value = aiEffective.value || {};
  if (!value.provider) return "未加载";
  const source = value.source === "user" ? "个人配置" : value.source === "assignment" ? "管理员分配" : "环境变量";
  return `${source} · ${value.provider} · ${value.model || "-"} · ${value.apiKeyMask || "未设Key"}`;
});

function currentBackendBaseUrl() {
  if (typeof window === "undefined" || !window.location?.origin) return "";
  return window.location.origin.replace(/\/+$/g, "");
}

const deviceFilters = reactive({ bound: "", online: "", status: "", keyword: "" });
const singleDeviceId = ref("");
const deviceEditForm = reactive({ displayName: "", remark: "", status: "enabled", ownerId: "" });
const quickEditRows = computed(() => deviceStore.devices.filter((item) => deviceStore.selectedIds.includes(item.id)));
const selectedE6DetailDevice = computed(
  () =>
    quickEditRows.value.find((item) => String(item.type || "") === "e6-color-frame") ||
    deviceStore.devices.find((item) => String(item.type || "") === "e6-color-frame") ||
    null
);
const backendUrlForm = reactive({ backendBaseUrl: currentBackendBaseUrl() });
const backendUrlClusterIds = ref<string[]>([]);
const backendUrlDispatchLoading = ref(false);
const usbNvsEntries = ref<NvsItem[]>([]);
const usbNvsBackups = ref<NvsBackup[]>([]);
const selectedNvsBackupId = ref("");
const usbNvsState = reactive({
  mode: "usb" as "usb" | "online",
  supported: typeof navigator !== "undefined" && Boolean((navigator as any).serial),
  connecting: false,
  connected: false,
  adapterReady: true,
  status: typeof navigator !== "undefined" && Boolean((navigator as any).serial) ? "待连接" : "当前浏览器不支持 Web Serial",
  offset: "0x9000",
  size: "0x6000",
  namespace: "net",
  key: "server_url",
  value: currentBackendBaseUrl(),
  port: null as any,
  selectedDeviceId: "",
  loading: false,
  reboot: false,
});
const usbNvsSupportTagType = computed(() => {
  if (!usbNvsState.supported) return "danger";
  if (usbNvsState.connected) return "success";
  return "warning";
});
const taskPlanLoading = ref(false);
const taskPlanSaving = ref(false);
const taskPlanRunning = ref(false);
const taskPlans = ref<TaskPlanRow[]>([]);
const taskPlanRuns = ref<TaskRunRow[]>([]);
const taskPlanDraft = reactive<Omit<TaskPlanRow, "steps">>({
  id: "",
  name: "",
  description: "",
  enabled: true,
  priority: 10,
  targetDeviceIds: [],
  targetClusterIds: [],
  scheduleMode: "once",
  scheduleSpec: {},
  repeatSpec: {},
  retrySpec: {},
  lastRunAt: "",
  nextRunAt: "",
  createdAt: "",
  updatedAt: "",
});
const taskPlanSteps = ref<TaskPlanStepRow[]>([]);
const taskPlanOnceAt = ref<Date | string>("");
const taskPlanWeekdays = ref<number[]>([1, 2, 3, 4, 5]);
const taskPlanCalendarDatesText = ref("");
const taskPlanTimesText = ref("09:00");
type DeviceBaseVariableRow = {
  name: string;
  value: string;
  createdAt?: string;
  updatedAt?: string;
};
type DeviceApiVariableRow = {
  source: "api";
  name: string;
  path: string;
  value: string;
  type: string;
  slug: string;
  templateName: string;
  updatedAt?: string;
};
type DeviceVariableBatchRow = {
  name: string;
  value: string;
  mode: "specified" | "random";
  deviceIds: string[];
  clusterIds: string[];
  randomCount: number;
};
const deviceVariableDeviceId = ref("");
const deviceVariableLoading = ref(false);
const deviceVariableBaseRows = ref<DeviceBaseVariableRow[]>([]);
const deviceVariableApiRows = ref<DeviceApiVariableRow[]>([]);
const deviceVariableSuggestions = reactive<{ names: string[]; values: string[] }>({ names: [], values: [] });
const deviceVariableApiSuggestions = reactive<{ names: string[]; values: string[] }>({ names: [], values: [] });
const deviceVariableApiKeyword = ref("");
const deviceVariableDraft = reactive({ name: "", value: "" });
const deviceVariableEditingName = ref("");
const deviceVariableBatchDialogOpen = ref(false);
const deviceVariableBatchRows = ref<DeviceVariableBatchRow[]>([]);
function compactUniqueOptions(values: Array<string | undefined | null>) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 500);
}
const deviceVariableBaseNameOptions = computed(() =>
  compactUniqueOptions([
    ...deviceVariableSuggestions.names,
    ...deviceVariableBaseRows.value.map((item) => item.name),
  ])
);
const deviceVariableBaseValueOptions = computed(() =>
  compactUniqueOptions([
    ...deviceVariableSuggestions.values,
    ...deviceVariableBaseRows.value.map((item) => item.value),
  ])
);
const filteredDeviceVariableApiRows = computed(() => {
  const keyword = String(deviceVariableApiKeyword.value || "").trim().toLowerCase();
  if (!keyword) return deviceVariableApiRows.value;
  return deviceVariableApiRows.value.filter((row) => {
    return [row.templateName, row.slug, row.name, row.path, row.value, row.type, row.updatedAt]
      .filter(Boolean)
      .some((part) => String(part).toLowerCase().includes(keyword));
  });
});
const bindForm = reactive({ pin: "", ownerId: "" });
const ownerSelectOptions = computed(() => adminUsers.value.filter((user) => user.status !== "blocked"));
const todoDeviceId = ref("");
const todoRows = ref<Array<{ id?: string; content: string; done: boolean; priority: number | null }>>([]);
const todoDeletedIds = ref<string[]>([]);
const todoBatchForm = reactive({
  mode: "same",
  content: "",
  regexSource: "",
  regexPattern: "",
  regexReplace: "",
  done: false,
  priority: 0,
  replace: false,
});
const todoBatchClusterIds = ref<string[]>([]);
const scheduleDeviceId = ref("");
const scheduleRows = ref<Array<{ id?: string; mode: "course" | "meeting"; weekday: number; orderIndex: number; title: string; content: string; startTime: string; endTime: string }>>([]);
const scheduleDeletedIds = ref<string[]>([]);
const scheduleBatchForm = reactive({
  mode: "same",
  scheduleMode: "course",
  title: "",
  content: "",
  weekday: 1,
  orderIndex: 1,
  startTime: "",
  endTime: "",
  regexSource: "",
  regexPattern: "",
  regexReplace: "",
  replace: false,
});
const scheduleBatchClusterIds = ref<string[]>([]);

type TemplateRow = {
  id: string;
  name: string;
  slug: string;
  method: string;
  url: string;
  keyField: string;
  keyIn: string[];
  userInputFields: Array<{ name: string; placeholder?: string }>;
  deviceKeyRequired: boolean;
  enabled: boolean;
  advancedConfig?: TemplateAdvancedConfig;
  refreshConfig?: TemplateRefreshConfig;
};

type TemplateRefreshMode = "manual" | "interval" | "on_request" | "stale_while_revalidate";
type TemplateRefreshConfig = {
  mode: TemplateRefreshMode;
  enabled: boolean;
  intervalMinutes: number;
  ttlSeconds: number;
  minRequestGapSeconds: number;
  timeoutMs: number;
  fallbackToStale: boolean;
  jitterSeconds: number;
};

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
  output: string;
  timeoutMs: number;
  steps: TemplateAdvancedStep[];
};
const templateRows = ref<TemplateRow[]>([]);
const templateDraft = reactive<TemplateRow>({
  id: "",
  name: "",
  slug: "",
  method: "GET",
  url: "",
  keyField: "key",
  keyIn: ["query"],
  userInputFields: [],
  deviceKeyRequired: true,
  enabled: true,
  advancedConfig: { output: "", timeoutMs: 8000, steps: [] },
  refreshConfig: {
    mode: "interval",
    enabled: true,
    intervalMinutes: 10,
    ttlSeconds: 300,
    minRequestGapSeconds: 30,
    timeoutMs: 8000,
    fallbackToStale: true,
    jitterSeconds: 15,
  },
});
const templateAdvancedDialogVisible = ref(false);
const templateAdvancedEditorTitle = computed(() => {
  const name = String(templateDraft.name || templateDraft.slug || "模板").trim();
  return `配置多步处理 · ${name}`;
});
const templateAdvancedSummaryLines = computed(() => {
  const cfg = templateDraft.advancedConfig;
  if (!cfg || !Array.isArray(cfg.steps) || !cfg.steps.length) {
    return [];
  }
  return cfg.steps.map((step, index) => {
    const method = String(step.method || "GET").toUpperCase();
    const url = String(step.url || "").trim() || "-";
    const headerCount = Array.isArray(step.headers) ? step.headers.filter((item) => String(item?.key || "").trim() || String(item?.value || "").trim()).length : 0;
    const paramCount = Array.isArray(step.params) ? step.params.filter((item) => String(item?.key || "").trim() || String(item?.value || "").trim()).length : 0;
    const bodyCount = Array.isArray(step.body) ? step.body.filter((item) => String(item?.key || "").trim() || String(item?.value || "").trim()).length : 0;
    const extractCount = Array.isArray(step.extract) ? step.extract.length : 0;
    return `${index + 1}. ${String(step.name || `step${index + 1}`)} · ${method} ${url} · H${headerCount}/Q${paramCount}/B${bodyCount}/X${extractCount}`;
  });
});
const templateDeviceId = ref("");
const templateDeviceKey = ref("");
const templateParamValues = reactive<Record<string, string>>({});
const templateResultText = ref("");
const templateBatchClusterIds = ref<string[]>([]);
const xiqueStatusLoading = ref(false);
const xiqueKnownAccounts = ref<Array<{ value: string; label: string }>>([]);
const xiqueAccountMode = ref<"existing" | "new">("existing");
const xiqueSelectedAccount = ref("");
const xiqueStatusSummary = ref("");
const xiqueCaptchaImage = ref("");
const xiqueCaptchaSession = ref("");
const xiqueCaptchaExpiresAt = ref("");
const xiqueTemplateCaptchaFocusAt = ref(0);
const isWeatherTemplate = computed(() => String(templateDraft.slug || "").trim() === "weather");
const isXiqueTemplate = computed(() => String(templateDraft.slug || "").trim() === "xique_schedule");
const xiqueTemplateAutoOcrEnabled = computed(() => {
  const raw = String(templateParamValues.autoOcrEnabled || "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
});
const templateVisibleInputFields = computed(() => {
  const rows = Array.isArray(templateDraft.userInputFields) ? templateDraft.userInputFields : [];
  const hiddenForWeather = new Set(["cityId", "location", "cityID"]);
  const hiddenForXique = new Set([
    "cityId",
    "loginUsername",
    "username",
    "password",
    "autoOcrEnabled",
    "captchaAnswer",
    "captchaSession",
    "currentTermKey",
    "termKey",
  ]);
  return rows.filter((row) => {
    const name = String(row?.name || "").trim();
    if (!name) return false;
    if (isWeatherTemplate.value && hiddenForWeather.has(name)) return false;
    if (isXiqueTemplate.value && hiddenForXique.has(name)) return false;
    return true;
  });
});

type FirmwareRow = {
  id: string;
  version: string;
  deviceType: string;
  fileName: string;
  createdAt: string;
};
const firmwareRows = ref<FirmwareRow[]>([]);
const firmwareForm = reactive({ version: "", deviceType: "ink-screen", releaseNote: "" });
const firmwareFile = ref<File | null>(null);
const fullFirmwareBundles = ref<Array<Record<string, any>>>([]);
const fullFirmwareFile = ref<File | null>(null);
const upgradeRows = ref<Array<Record<string, any>>>([]);

const tfQuery = reactive({ category: "", deviceId: "" });
const tfRows = ref<Array<Record<string, any>>>([]);
const tfUpload = reactive({ category: "photo" });
const tfUploadFile = ref<File | null>(null);
const tfLocalRows = ref<Array<Record<string, any>>>([]);
const selectedTfFile = ref<Record<string, any> | null>(null);
const tfBatchClusterIds = ref<string[]>([]);

const operationLogs = ref<Array<Record<string, any>>>([]);
const apiLogs = ref<Array<Record<string, any>>>([]);
const logCleanupLoading = ref(false);
const logCleanupSummary = ref("");
const logCleanupForm = reactive<{
  range: [Date, Date] | [];
  includeOperationLogs: boolean;
  includeApiLogs: boolean;
  includeFiles: boolean;
  dryRun: boolean;
}>({
  range: [],
  includeOperationLogs: true,
  includeApiLogs: true,
  includeFiles: true,
  dryRun: false,
});

const remoteForm = reactive({
  view: "home",
  setAsDefault: false,
  text: "",
  announcementMode: "status",
  durationValue: 20,
  durationUnit: "minute",
});
const imageFile = ref<File | null>(null);
const imagePreviewDialogOpen = ref(false);
const imagePreviewUrl = ref("");
const remoteClusterIds = ref<string[]>([]);
type HomepageTemplateRow = {
  id: string;
  name: string;
  type: string;
  html: string;
  builtin?: boolean;
  targetDeviceTypes?: string[];
};
type HomepageTemplateVariableRow = {
  path: string;
  placeholder: string;
  type: string;
  example: string;
  source?: "base" | "api" | "device";
  slug?: string;
  sourceLabel?: string;
  categoryKey?: string;
  categoryLabel?: string;
};
const homepageDeviceId = ref("");
const homepageTemplates = ref<HomepageTemplateRow[]>([]);
const homepageTemplateDraft = reactive<HomepageTemplateRow>({
  id: "",
  name: "",
  type: "custom_html",
  html: "",
  builtin: false,
  targetDeviceTypes: [],
});
const deviceTypeRows = ref<DeviceTypeRow[]>([]);
const homepageTemplateVariables = ref<HomepageTemplateVariableRow[]>([]);
const homepageInsertVarVisible = ref(false);
const homepageInsertVarLoading = ref(false);
const homepageTemplateHtmlInputRef = ref<any>(null);
const homepageConfigModel = reactive<any>({
  template: { template_id: "tpl_home_default" },
  auto_render_push: {
    enabled: false,
    interval_enabled: true,
    window_start_time: "07:30",
    window_end_time: "23:59",
    fixed_times: [] as string[],
    // legacy aliases
    daily_start_time: "07:30",
    interval_minutes: 60,
    next_run_at: "",
    last_run_at: "",
    last_result: "idle",
    last_error: "",
    last_reason: "",
  },
  time_overlay: {
    enabled: true,
    x: 1820,
    y: 80,
    width: 680,
    height: 180,
    format: "HH:mm",
    font_size: 88,
    align: "right",
    refresh_interval_sec: 60,
  },
});
const homepageConfigJson = ref("{}");
const homepageClusterIds = ref<string[]>([]);
const homepagePreviewUrl = ref("");
const homepageEditPreviewUrl = ref("");
const homepageEditPreviewLoading = ref(false);
const homepageEditPreviewError = ref("");
const homepageRenderMeta = reactive<Record<string, any>>({});
const homepagePreviewMode = ref<"edit" | "delivery">("edit");
const homepageConfigSaving = ref(false);
const homepagePushLoading = ref(false);
const homepageAutoRunLoading = ref(false);
let homepageEditPreviewTimer: ReturnType<typeof setTimeout> | null = null;
let homepageEditPreviewRevision = 0;
let homepageEditPreviewInFlight = false;
let homepageEditPreviewQueuedRevision: number | null = null;

function toPreviewNum(value: unknown, fallback: number) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

const homepagePreviewSourceSize = computed(() => {
  const image = homepageRenderMeta || {};
  const screen = homepageConfigModel?.screen || {};
  const sw = Math.max(1, toPreviewNum(image.image_width, toPreviewNum(screen.width, 2560)));
  const sh = Math.max(1, toPreviewNum(image.image_height, toPreviewNum(screen.height, 1600)));
  return { sw, sh };
});

const homepagePreviewLayout = computed(() => {
  const { sw, sh } = homepagePreviewSourceSize.value;
  const maxWidth = Math.min(Math.round(windowWidth.value * 0.78), 1200);
  const scale = Math.min(1, maxWidth / sw);
  const stageW = Math.max(1, Math.round(sw * scale));
  const stageH = Math.max(1, Math.round(sh * scale));
  return { sw, sh, stageW, stageH, scale: stageW / sw };
});

const homepagePreviewStageStyle = computed(() => {
  const layout = homepagePreviewLayout.value;
  return {
    width: `${layout.stageW}px`,
    height: `${layout.stageH}px`,
  };
});

const homepageTimeOverlayBox = computed(() => {
  const overlay = homepageConfigModel?.time_overlay || {};
  const layout = homepagePreviewLayout.value;
  const width = Math.max(1, toPreviewNum(overlay.width, 680));
  const height = Math.max(1, toPreviewNum(overlay.height, 180));
  const x = Math.max(0, toPreviewNum(overlay.x, Math.max(0, layout.sw - width - 32)));
  const y = Math.max(0, toPreviewNum(overlay.y, 80));
  return { sw: layout.sw, sh: layout.sh, x, y, width, height, scale: layout.scale };
});

const homepageTimeOverlayAlign = computed<"left" | "center" | "right">(() => {
  const align = String(homepageConfigModel?.time_overlay?.align || "right").toLowerCase();
  if (align === "left" || align === "center" || align === "right") {
    return align;
  }
  return "right";
});

const homepageTimeOverlayFormat = computed(() => String(homepageConfigModel?.time_overlay?.format || "HH:mm"));
const homepageTimeOverlayFontSize = computed(() => Math.max(12, toPreviewNum(homepageConfigModel?.time_overlay?.font_size, 88)));

const showHomepageTimeOverlayPreview = computed(() => {
  const overlay = homepageConfigModel?.time_overlay || {};
  const previewUrl = homepagePreviewMode.value === "edit" ? homepageEditPreviewUrl.value : homepagePreviewUrl.value;
  return Boolean(overlay.enabled) && Boolean(previewUrl) && homepageTimeOverlayBox.value.width > 0 && homepageTimeOverlayBox.value.height > 0;
});

const homepageTimeOverlayPreviewStyle = computed(() => {
  const box = homepageTimeOverlayBox.value;
  return {
    left: `${Math.round(box.x * box.scale)}px`,
    top: `${Math.round(box.y * box.scale)}px`,
    width: `${Math.round(box.width * box.scale)}px`,
    height: `${Math.round(box.height * box.scale)}px`,
  };
});

const homepageAutoRenderPushModel = computed(() => homepageConfigModel?.auto_render_push || {});
const homepageDeviceTypeOptions = computed(() => {
  const map = new Map<string, string>();
  deviceTypeRows.value.forEach((item: any) => {
    const value = String(item.type || item.id || "").trim();
    if (!value) return;
    map.set(value, String(item.label || item.name || value));
  });
  deviceStore.devices.forEach((item: any) => {
    const value = homepageDeviceTypeOf(item);
    if (value && !map.has(value)) map.set(value, value);
  });
  return [...map.entries()].map(([value, label]) => ({ value, label }));
});
const homepageDeviceTypeLabelMap = computed(() => new Map(homepageDeviceTypeOptions.value.map((item) => [item.value, item.label])));
const homepageDeviceGroups = computed(() => {
  const groups = new Map<string, any[]>();
  deviceStore.devices.forEach((item: any) => {
    const type = homepageDeviceTypeOf(item) || "unknown";
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type)?.push(item);
  });
  return [...groups.entries()]
    .sort((a, b) => homepageDeviceTypeLabel(a[0]).localeCompare(homepageDeviceTypeLabel(b[0])))
    .map(([type, devices]) => ({
      type,
      label: `${homepageDeviceTypeLabel(type)} · ${devices.length} 台`,
      devices,
    }));
});
const selectedHomepageDeviceType = computed(() => {
  const row = deviceStore.devices.find((item: any) => item.id === homepageDeviceId.value);
  return homepageDeviceTypeOf(row || {});
});
const homepageTemplatesForDevice = computed(() => {
  const type = selectedHomepageDeviceType.value;
  const rows = homepageTemplates.value.filter((item) => {
    const targets = normalizeHomepageTargetDeviceTypes(item.targetDeviceTypes);
    return !targets.length || !type || targets.includes(type);
  });
  if (rows.some((item) => item.id === homepageConfigModel?.template?.template_id)) return rows;
  const selected = homepageTemplates.value.find((item) => item.id === homepageConfigModel?.template?.template_id);
  return selected ? [selected, ...rows] : rows;
});
const homepageAutoFixedTimeOptions = computed(() => {
  const base = ["07:30", "08:00", "09:00", "12:00", "14:00", "18:00", "20:00", "22:00"];
  const dynamic = Array.isArray(homepageAutoRenderPushModel.value?.fixed_times)
    ? homepageAutoRenderPushModel.value.fixed_times.map((item: unknown) => String(item || "").trim()).filter(Boolean)
    : [];
  return [...new Set([...base, ...dynamic])].sort();
});
const homepageAutoLastResultText = computed(() => {
  const raw = String(homepageAutoRenderPushModel.value?.last_result || "idle");
  if (raw === "success") return "成功";
  if (raw === "failed") return "失败";
  if (raw === "running") return "执行中";
  if (raw === "skipped") return "已跳过";
  return "未执行";
});
const homepageAutoLastResultTagType = computed(() => {
  const raw = String(homepageAutoRenderPushModel.value?.last_result || "idle");
  if (raw === "success") return "success";
  if (raw === "failed") return "danger";
  if (raw === "running") return "warning";
  return "info";
});

function ensureHomepageAutoRenderPushShape(target: any) {
  const safe = target && typeof target === "object" ? target : {};
  const toLooseBoolean = (value: unknown, fallback: boolean) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    const raw = String(value).trim().toLowerCase();
    if (!raw) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    return fallback;
  };
  const fixedTimesRaw = Array.isArray(safe.fixed_times)
    ? safe.fixed_times
    : typeof safe.fixed_times === "string"
      ? safe.fixed_times.split(/[,\n;\s]+/g)
      : [];
  const fixedTimes = [...new Set(fixedTimesRaw.map((item: unknown) => String(item || "").trim()).filter(Boolean))].sort();
  const intervalEnabled = toLooseBoolean(safe.interval_enabled ?? safe.intervalEnabled, true);
  const enabled = toLooseBoolean(safe.enabled, false);
  const windowStart = String(safe.window_start_time || safe.daily_start_time || "07:30");
  const windowEnd = String(safe.window_end_time || "23:59");
  const intervalMinutesRaw = Number(safe.interval_minutes || 60);
  const intervalMinutesAllowed = [10, 30, 60, 120, 360];
  const intervalMinutes = intervalMinutesAllowed.includes(Math.floor(intervalMinutesRaw)) ? Math.floor(intervalMinutesRaw) : 60;

  safe.enabled = enabled;
  safe.interval_enabled = intervalEnabled;
  safe.window_start_time = windowStart;
  safe.window_end_time = windowEnd;
  safe.fixed_times = fixedTimes;
  // legacy aliases kept in model for compatibility
  safe.daily_start_time = windowStart;
  safe.interval_minutes = Number.isFinite(intervalMinutes) ? intervalMinutes : 60;
  safe.next_run_at = String(safe.next_run_at || "");
  safe.last_run_at = String(safe.last_run_at || "");
  safe.last_result = String(safe.last_result || "idle");
  safe.last_error = String(safe.last_error || "");
  safe.last_reason = String(safe.last_reason || "");
  return safe;
}
const batchTargetDeviceIds = reactive<Record<DispatchTargetKey, string[]>>({
  todo: [],
  schedule: [],
  templates: [],
  tf: [],
  remote: [],
  homepage: [],
  backendUrl: [],
  firmware: [],
});

type LayoutRow = {
  id: string;
  layoutName: string;
  deviceType: string;
  fontFamily?: string;
  nameFontSize: number;
  nameOffsetX?: number;
  nameOffsetY?: number;
  titleFontSize: number;
  titleOffsetX?: number;
  titleOffsetY?: number;
  align: "left" | "center" | "right";
  margin: number;
  updatedAt?: string;
};

const layouts = ref<LayoutRow[]>([]);
type NameplateHistoryRow = {
  id: string;
  name: string;
  title: string;
  deviceType: string;
  createdAt: string;
};
const history = ref<NameplateHistoryRow[]>([]);

type ClusterRow = {
  id: string;
  name: string;
  description?: string;
  rule?: string;
  deviceIds: string[];
  updatedAt?: string;
};
const clusters = ref<ClusterRow[]>([]);
const clusterCreateForm = reactive<{ name: string; description: string }>({
  name: "",
  description: "",
});
const clusterForm = reactive<{ id: string; name: string; description: string }>({
  id: "",
  name: "",
  description: "",
});
const overviewBoundRate = computed(() => {
  if (!overview.deviceTotal) return "0%";
  return `${Math.round((overview.deviceBound / overview.deviceTotal) * 100)}%`;
});
const overviewCards = computed(() => [
  { key: "deviceTotal", label: "设备总数", value: overview.deviceTotal, note: "当前平台已登记设备" },
  { key: "deviceOnline", label: "在线设备", value: overview.deviceOnline, note: "SSE / WS 有活跃连接" },
  { key: "deviceBound", label: "已绑定设备", value: overview.deviceBound, note: "已归属到用户账号" },
  { key: "deviceUnbound", label: "未绑定设备", value: overview.deviceUnbound, note: "待 PIN 或管理员绑定" },
  { key: "todoCount", label: "TODO 总数", value: overview.todoCount, note: "待办数据条目" },
  { key: "scheduleCount", label: "日程条目", value: overview.scheduleCount, note: "课程/会议统一统计" },
  { key: "firmwareCount", label: "固件版本", value: overview.firmwareCount, note: "当前已上传固件" },
  { key: "deviceOffline", label: "离线设备", value: overview.deviceOffline, note: "当前无在线会话" },
]);

const fontOptions = ["Microsoft YaHei", "SimSun", "SimHei", "PingFang SC", "Noto Sans SC", "Arial", "Times New Roman"];

const layoutForm = reactive({
  id: "",
  layoutName: "默认桌牌",
  deviceType: "ink-screen",
  fontFamily: "Microsoft YaHei",
  nameFontSize: 180,
  nameOffsetX: 0,
  nameOffsetY: 0,
  titleFontSize: 76,
  titleOffsetX: 0,
  titleOffsetY: 88,
  align: "center" as "left" | "center" | "right",
  margin: 40,
});

const singleForm = reactive({ layoutId: "", deviceId: "", name: "张三", title: "产品经理" });

const previewDialogOpen = ref(false);
const previewRef = ref<HTMLDivElement | null>(null);
const drag = reactive({ active: false, target: "" as "" | "name" | "title", pointerId: -1, startX: 0, startY: 0, startOffsetX: 0, startOffsetY: 0 });

const batchDialogOpen = ref(false);
const batchPlans = ref<Array<Record<string, any>>>([]);
const batchPlanId = ref("");
const batchPlanName = ref("");
const batchRows = ref<Array<{ name: string; title: string; mode: "specified" | "random"; deviceIds: string[]; poolDeviceIds: string[]; randomCount: number }>>([]);
const iconPaths: Record<string, string> = {
  overview: "M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6v-9h-6v9Zm0-16v5h6V4h-6Z",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0H5Z",
  ai: "M12 3a6 6 0 0 0-6 6v2.2A3 3 0 0 0 7 17h1v3h8v-3h1a3 3 0 0 0 1-5.8V9a6 6 0 0 0-6-6Zm-2 7h1.8v1.8H10V10Zm4.2 0H16v1.8h-1.8V10ZM9.5 15h5v1.4h-5V15Z",
  pin: "M7 10V8a5 5 0 0 1 10 0v2h1.2A1.8 1.8 0 0 1 20 11.8v7.4a1.8 1.8 0 0 1-1.8 1.8H5.8A1.8 1.8 0 0 1 4 19.2v-7.4A1.8 1.8 0 0 1 5.8 10H7Zm2 0h6V8a3 3 0 0 0-6 0v2Z",
  device: "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-5v2h3v2H7v-2h3v-2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v9h14V6H5Z",
  variable: "M5 5h14v4H5V5Zm0 6h8v4H5v-4Zm10 0h4v8h-4v-8ZM5 17h8v2H5v-2Z",
  task: "M6 4h12v2H6V4Zm0 5h12v2H6V9Zm0 5h8v2H6v-2Zm10.5 1.2 1.4 1.4 3.6-3.6 1.4 1.4-5 5-2.8-2.8 1.4-1.4Z",
  todo: "M5 4h14v16H5V4Zm3 4v2h8V8H8Zm0 4v2h8v-2H8Zm0 4v2h5v-2H8Z",
  schedule: "M7 2h2v3h6V2h2v3h3v17H4V5h3V2Zm11 8H6v10h12V10Z",
  file: "M6 2h8l4 4v16H6V2Zm7 1.5V7h3.5L13 3.5ZM8 11h8v2H8v-2Zm0 4h8v2H8v-2Z",
  album: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v9l3.5-3.5 2.5 2.5 4-5L19 14V6H5Zm3 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  remote: "M8 3h8a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm1 4h6V5H9v2Zm3 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  home: "M3 11 12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3Z",
  layout: "M4 4h16v16H4V4Zm2 2v5h12V6H6Zm0 7v5h5v-5H6Zm7 0v5h5v-5h-5Z",
  history: "M12 4a8 8 0 1 1-7.5 5.3H2l3.3-4L8.7 9H6.6A6 6 0 1 0 12 6V4Zm-1 4h2v5l4 2-1 1.7-5-2.7V8Z",
  template: "M5 3h14v18H5V3Zm3 4h8V5H8v2Zm0 4h8V9H8v2Zm0 4h5v-2H8v2Z",
  firmware: "M8 3h8v4h3v8h-3v6H8v-6H5V7h3V3Zm2 2v2h4V5h-4Zm0 12v2h4v-2h-4Z",
  pool: "M7 7a4 4 0 1 1 8 0 4 4 0 0 1-8 0Zm-3 13a7 7 0 0 1 14 0H4Zm13-8a3 3 0 0 0 0-6v6Zm1 8h3a5 5 0 0 0-4-4.9V20Z",
  log: "M5 3h14v18H5V3Zm3 5h8V6H8v2Zm0 4h8v-2H8v2Zm0 4h5v-2H8v2Z",
  upgrade: "M12 3 7 8h3v6h4V8h3l-5-5ZM5 18h14v3H5v-3Z",
  default: "M5 5h14v14H5V5Z",
};
const sidebarMenuItems = computed(() => {
  const items = [
    { index: "overview", label: "主页概览", icon: "overview" },
    { index: "account", label: "账号管理", icon: "account" },
    { index: "ai", label: "AI", icon: "ai" },
    { index: "devicePin", label: "设备与PIN", icon: "pin" },
    { index: "devices", label: "设备管理", icon: "device" },
    { index: "deviceVariables", label: "设备变量", icon: "variable" },
    { index: "taskPlans", label: "计划任务", icon: "task" },
    { index: "todo", label: "TODO", icon: "todo" },
    { index: "schedule", label: "日程安排", icon: "schedule" },
    { index: "tf", label: "文件管理", icon: "file" },
    { index: "albumCollections", label: "相册与集合", icon: "album" },
    { index: "remote", label: "远程控制", icon: "remote" },
    { index: "homepage", label: "主页", icon: "home" },
    { index: "layout", label: "桌牌设置", icon: "layout" },
    { index: "history", label: "桌牌历史", icon: "history" },
    { index: "templates", label: "API模板", icon: "template" },
    { index: "firmware", label: "固件管理", icon: "firmware" },
  ];
  if (isAdmin.value) {
    items.splice(4, 0, { index: "pools", label: "设备池管理", icon: "pool" });
    items.push({ index: "logs", label: "日志中心", icon: "log" });
    items.push({ index: "systemUpgrade", label: "系统升级", icon: "upgrade" });
  }
  return items;
});

function toggleSidebar() {
  if (isMobile.value) {
    mobileNavOpen.value = !mobileNavOpen.value;
    return;
  }
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

watch(
  isMobile,
  (mobile) => {
    mobileNavOpen.value = false;
    if (mobile) {
      sidebarCollapsed.value = true;
    }
  },
  { immediate: true }
);

const RES_MAP: Record<string, { w: number; h: number }> = {
  "ink-screen": { w: 2560, h: 1600 },
  "4d_systems_esp32s3_gen4_r8n16": { w: 2560, h: 1600 },
  "epd-13.3": { w: 1600, h: 1200 },
};

const resolution = computed(() => RES_MAP[layoutForm.deviceType] || RES_MAP["ink-screen"]);
const stageW = computed(() => {
  const byRatio = Math.round(420 * (resolution.value.w / resolution.value.h));
  const byWindow = Math.round(windowWidth.value * 0.52);
  return Math.min(980, Math.max(520, Math.min(byRatio, byWindow)));
});
const stageScale = computed(() => stageW.value / resolution.value.w);
const stageStyle = computed(() => ({ width: `${stageW.value}px`, height: `${Math.round(resolution.value.h * stageScale.value)}px` }));
const stageDialogW = computed(() => {
  const byRatio = Math.round(620 * (resolution.value.w / resolution.value.h));
  const byWindow = Math.round(windowWidth.value * 0.82);
  return Math.min(1320, Math.max(680, Math.min(byRatio, byWindow)));
});
const stageDialogScale = computed(() => stageDialogW.value / resolution.value.w);
const stageDialogStyle = computed(() => ({ width: `${stageDialogW.value}px`, height: `${Math.round(resolution.value.h * stageDialogScale.value)}px` }));
const remotePreviewResolution = computed(() => RES_MAP["ink-screen"]);
const imagePreviewStageStyle = computed(() => {
  const w = remotePreviewResolution.value.w;
  const h = remotePreviewResolution.value.h;
  const maxW = Math.min(Math.round(windowWidth.value * 0.78), 1200);
  const scale = maxW / w;
  return {
    width: `${Math.round(w * scale)}px`,
    height: `${Math.round(h * scale)}px`,
  };
});
const dispatchTargetKeyLabel = computed(() => {
  const map = {
    todo: "TODO",
    schedule: "日程",
    templates: "API模板",
    tf: "文件管理",
    remote: "远程控制",
    homepage: "主页",
    backendUrl: "连接地址",
    firmware: "固件升级",
  } as const;
  return map[dispatchTargetKey.value];
});

function buildTextStyle(scale: number, target: "name" | "title") {
  const isName = target === "name";
  const w = resolution.value.w;
  const h = resolution.value.h;
  const margin = Math.max(0, layoutForm.margin);
  const nameTop = Math.max(20, Math.floor(h * 0.16));
  const nameAreaH = Math.max(120, Math.floor(h * 0.48));
  const x = Math.max(0, Math.min(w - 100, margin + (isName ? layoutForm.nameOffsetX : layoutForm.titleOffsetX)));
  const yRaw = isName ? nameTop + layoutForm.nameOffsetY : nameTop + nameAreaH + layoutForm.titleOffsetY;
  const y = Math.max(0, Math.min(h - 80, yRaw));
  const contentW = Math.max(100, w - x - margin);
  const size = isName ? layoutForm.nameFontSize : layoutForm.titleFontSize;
  return {
    left: `${Math.round(x * scale)}px`,
    top: `${Math.round(y * scale)}px`,
    width: `${Math.round(contentW * scale)}px`,
    fontSize: `${Math.max(12, Math.round(size * scale))}px`,
    textAlign: layoutForm.align,
    fontFamily: layoutForm.fontFamily || "Microsoft YaHei",
  };
}

const nameStyle = computed(() => buildTextStyle(stageScale.value, "name"));
const titleStyle = computed(() => buildTextStyle(stageScale.value, "title"));
const nameDialogStyle = computed(() => buildTextStyle(stageDialogScale.value, "name"));
const titleDialogStyle = computed(() => buildTextStyle(stageDialogScale.value, "title"));

function applyTheme(mode: boolean) {
  darkMode.value = mode;
  const theme = mode ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("ink-screen-theme", theme);
}

function toggleDarkMode(value: string | number | boolean) {
  applyTheme(Boolean(value));
}

function onSelectPanel(index: string) {
  activePanel.value = index;
  mobileNavOpen.value = false;
  const loaders = new Set<() => Promise<unknown>>();
  if (["todo", "schedule", "templates", "tf", "remote", "homepage", "deviceVariables", "taskPlans"].includes(index)) {
    loaders.add(loadClusters);
  }
  if (index === "overview") {
    loaders.add(refreshOverview);
  } else if (index === "account" && isAdmin.value) {
    loaders.add(loadAdminUsers);
  } else if (index === "ai") {
    loaders.add(loadAiConfig);
    if (isAdmin.value) {
      loaders.add(loadAdminUsers);
      loaders.add(loadAdminAiConfigs);
    }
  } else if (index === "devicePin" && isAdmin.value) {
    loaders.add(loadAdminUsers);
  } else if (index === "todo") {
    loaders.add(loadTodoRows);
  } else if (index === "schedule") {
    loaders.add(loadScheduleRows);
  } else if (index === "templates") {
    loaders.add(loadTemplateRows);
  } else if (index === "homepage") {
    loaders.add(loadHomepageAll);
  } else if (index === "firmware") {
    loaders.add(loadFirmwareRows);
    loaders.add(loadFullFirmwareBundles);
    loaders.add(loadUpgradeJobs);
  } else if (index === "tf") {
    loaders.add(loadTfRows);
    loaders.add(loadTfLocalRows);
  } else if (index === "albumCollections") {
    loaders.add(refreshDevices);
  } else if (index === "logs" && isAdmin.value) {
    loaders.add(loadOperationLogs);
    loaders.add(loadApiLogs);
  } else if (index === "systemUpgrade" && isAdmin.value) {
    // system-upgrade panel handles its own data loading
  } else if (index === "layout") {
    loaders.add(loadLayouts);
  } else if (index === "pools" && isAdmin.value) {
    loaders.add(loadClusters);
  } else if (index === "devices") {
    loaders.add(loadClusters);
  } else if (index === "deviceVariables") {
    loaders.add(loadDeviceVariables);
  } else if (index === "taskPlans") {
    loaders.add(loadTaskPlans);
    loaders.add(loadTemplateRows);
  } else if (index === "history") {
    loaders.add(loadHistory);
  }

  void Promise.allSettled([...loaders].map((load) => load()));
}

function onFilteredChange(ids: string[]) { filteredDeviceIds.value = ids; }
function onPoolFilteredChange(ids: string[]) { poolFilteredIds.value = ids; }
function setPoolPickerSelection(ids: string[]) { poolPickerSelection.value = [...ids]; }
function onDispatchFilteredChange(ids: string[]) { dispatchFilteredIds.value = ids; }
function setDispatchPickerSelection(ids: string[]) { dispatchPickerSelection.value = [...ids]; }
function selectAllFiltered() { pickerRef.value?.selectAllFiltered(); }
function clearSelection() { deviceStore.clearSelection(); }
function clearPoolPickerSelection() { poolPickerSelection.value = []; }
function clearDispatchPickerSelection() { dispatchPickerSelection.value = []; }
function openDispatchPicker(key: DispatchTargetKey) {
  dispatchTargetKey.value = key;
  const current = batchTargetDeviceIds[key] || [];
  dispatchPickerSelection.value = current.length ? [...current] : [...deviceStore.selectedIds];
  dispatchPickerDialogOpen.value = true;
}
function confirmDispatchPicker() {
  batchTargetDeviceIds[dispatchTargetKey.value] = [...dispatchPickerSelection.value];
  dispatchPickerDialogOpen.value = false;
}

async function doLogin() {
  loginLoading.value = true;
  try {
    await auth.login(props.role, loginForm.username, loginForm.password);
    loginForm.username = auth.lastUsername || auth.username || loginForm.username;
    loginForm.password = "";
    await loadInitialDashboardData();
    ElMessage.success("登录成功");
  } catch (error) {
    ElMessage.error((error as Error).message || "登录失败");
  } finally {
    loginLoading.value = false;
  }
}

function logout() {
  auth.logout();
  deviceStore.clearSelection();
  loginForm.username = auth.lastUsername || loginForm.username;
  loginForm.password = "";
}

async function refreshDevices() {
  if (!auth.token) return;
  await deviceStore.fetchDevices(auth.token, deviceFilters);
  if (!singleDeviceId.value && deviceStore.devices.length) {
    singleDeviceId.value = deviceStore.devices[0].id;
  }
  if (!todoDeviceId.value && deviceStore.devices.length) {
    todoDeviceId.value = deviceStore.devices[0].id;
  }
  if (!scheduleDeviceId.value && deviceStore.devices.length) {
    scheduleDeviceId.value = deviceStore.devices[0].id;
  }
  if (!templateDeviceId.value && deviceStore.devices.length) {
    templateDeviceId.value = deviceStore.devices[0].id;
  }
  if (!homepageDeviceId.value && deviceStore.devices.length) {
    homepageDeviceId.value = deviceStore.devices[0].id;
  }
  if (!deviceVariableDeviceId.value && deviceStore.devices.length) {
    deviceVariableDeviceId.value = deviceStore.devices[0].id;
  }
  if (!singleForm.deviceId && deviceStore.devices.length) singleForm.deviceId = deviceStore.devices[0].id;
  const valid = new Set(deviceStore.devices.map((item) => item.id));
  (Object.keys(batchTargetDeviceIds) as Array<keyof typeof batchTargetDeviceIds>).forEach((key) => {
    batchTargetDeviceIds[key] = (batchTargetDeviceIds[key] || []).filter((id) => valid.has(id));
  });
  onSingleDeviceChanged();
}

async function loadDeviceTypeRows() {
  if (!auth.token) return;
  try {
    deviceTypeRows.value = await fetchDeviceTypes(auth.token);
  } catch (_) {
    deviceTypeRows.value = [];
  }
}

type DashboardOverviewPayload = Partial<{
  deviceTotal: number;
  deviceBound: number;
  deviceUnbound: number;
  deviceOnline: number;
  deviceOffline: number;
  todoCount: number;
  scheduleCount: number;
  firmwareCount: number;
}>;

function applyOverview(payload: DashboardOverviewPayload) {
  const numberOr = (value: unknown, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const deviceTotal = numberOr(payload.deviceTotal, deviceStore.devices.length);
  const deviceBoundFallback = deviceStore.devices.filter((device) => device.bindState === "bound").length;
  const deviceOnlineFallback = deviceStore.devices.filter((device) => device.online).length;
  overview.deviceTotal = deviceTotal;
  overview.deviceBound = numberOr(payload.deviceBound, deviceBoundFallback);
  overview.deviceUnbound = numberOr(payload.deviceUnbound, deviceTotal - overview.deviceBound);
  overview.deviceOnline = numberOr(payload.deviceOnline, deviceOnlineFallback);
  overview.deviceOffline = numberOr(payload.deviceOffline, deviceTotal - overview.deviceOnline);
  overview.todoCount = numberOr(payload.todoCount, 0);
  overview.scheduleCount = numberOr(payload.scheduleCount, 0);
  overview.firmwareCount = numberOr(payload.firmwareCount, 0);
}

async function refreshOverview() {
  if (!auth.token) return;
  try {
    const payload = await apiRequest<DashboardOverviewPayload>("/api/dashboard/overview", { token: auth.token });
    applyOverview(payload);
  } catch (_) {
    // Compatibility fallback for servers that do not expose the aggregate endpoint yet.
    // Device counts come from the already-loaded store to avoid fetching /api/devices twice.
    const [todos, schedules, firmwares] = await Promise.all([
      apiRequest<any[]>("/api/todos", { token: auth.token }),
      apiRequest<any[]>("/api/schedules", { token: auth.token }),
      apiRequest<any[]>("/api/firmware", { token: auth.token }),
    ]);
    applyOverview({
      todoCount: todos.length,
      scheduleCount: schedules.length,
      firmwareCount: firmwares.length,
    });
  }
}

async function loadInitialDashboardData() {
  await refreshDevices();
  const [, overviewResult] = await Promise.allSettled([loadDeviceTypeRows(), refreshOverview()]);
  if (overviewResult.status === "rejected") {
    applyOverview({});
    console.warn("[dashboard] overview load failed", overviewResult.reason);
  }
}

function selectedDevice() {
  return deviceStore.devices.find((item) => item.id === singleDeviceId.value) || null;
}

function onSingleDeviceChanged() {
  const row = selectedDevice();
  if (!row) return;
  deviceEditForm.displayName = row.displayName || "";
  deviceEditForm.remark = row.remark || "";
  deviceEditForm.status = row.status || "enabled";
  deviceEditForm.ownerId = row.ownerId || "";
}

async function updateCurrentDevice() {
  const row = selectedDevice();
  if (!row) return ElMessage.error("请先选择设备");
  const body: Record<string, any> = { displayName: deviceEditForm.displayName, remark: deviceEditForm.remark };
  if (isAdmin.value) {
    body.status = deviceEditForm.status;
    body.ownerId = deviceEditForm.ownerId;
  }
  await apiRequest(`/api/devices/${row.id}`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify(body),
  });
  ElMessage.success("设备信息已更新");
  await refreshDevices();
}

async function saveDeviceQuickEdit(row: any) {
  if (!row?.id) return;
  const body: Record<string, any> = {
    displayName: String(row.displayName || "").trim(),
    remark: String(row.remark || "").trim(),
  };
  if (isAdmin.value) {
    body.ownerId = String(row.ownerId || "").trim();
  }
  await apiRequest(`/api/devices/${row.id}`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify(body),
  });
  ElMessage.success(`设备 ${row.id} 已更新`);
  await refreshDevices();
}

function ownerOptionLabel(user: AdminUserRow) {
  const nickname = String(user.nickname || "").trim();
  return nickname ? `${user.username}（${nickname}）` : `${user.username}（${user.id}）`;
}

async function deleteCurrentDevice() {
  const row = selectedDevice();
  if (!row) return ElMessage.error("请先选择设备");
  await apiRequest(`/api/devices/${row.id}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({}),
  });
  ElMessage.success("设备已删除");
  singleDeviceId.value = "";
  await refreshDevices();
  await refreshOverview();
}

async function batchDeleteSelectedDevices() {
  if (!deviceStore.selectedIds.length) return ElMessage.error("请先框选设备");
  const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/devices/batch/delete", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ deviceIds: deviceStore.selectedIds }),
  });
  ElMessage.success(`批量删除完成：成功 ${data.successCount}，失败 ${data.failedCount}`);
  await refreshDevices();
  await refreshOverview();
}

async function batchDeleteAllFiltered() {
  const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/devices/batch/delete", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deleteAll: true,
      filters: {
        status: deviceFilters.status,
        bound: deviceFilters.bound,
        online: deviceFilters.online,
        keyword: deviceFilters.keyword,
      },
    }),
  });
  ElMessage.success(`筛选全删完成：成功 ${data.successCount}，失败 ${data.failedCount}`);
  await refreshDevices();
  await refreshOverview();
}

function fillCurrentBackendBaseUrl() {
  const current = currentBackendBaseUrl();
  if (!current) return ElMessage.error("无法读取当前访问地址");
  backendUrlForm.backendBaseUrl = current;
}

async function dispatchBackendUrl() {
  const backendBaseUrl = String(backendUrlForm.backendBaseUrl || "").trim().replace(/\/+$/g, "");
  const deviceIds = resolveBatchTargetDevices("backendUrl");
  const clusterIds = [...backendUrlClusterIds.value];
  if (!backendBaseUrl) return ElMessage.error("请填写后端地址");
  if (!deviceIds.length && !clusterIds.length) return ElMessage.error("请先选择设备或设备池");

  backendUrlDispatchLoading.value = true;
  try {
    const data = await apiRequest<{ successCount: number; failedCount: number; ackedSuccessCount?: number; ackedPendingCount?: number }>("/api/remote/update-backend-url", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({
        backendBaseUrl,
        deviceIds,
        clusterIds,
        ackTimeoutMs: 8000,
      }),
    });
    backendUrlForm.backendBaseUrl = backendBaseUrl;
    ElMessage.success(`连接地址下发：成功 ${data.successCount}，失败 ${data.failedCount}`);
  } catch (error) {
    ElMessage.error((error as Error).message || "连接地址下发失败");
  } finally {
    backendUrlDispatchLoading.value = false;
  }
}

async function connectUsbNvsDevice() {
  const serial = typeof navigator !== "undefined" ? (navigator as any).serial : null;
  if (!serial) {
    usbNvsState.status = "当前浏览器不支持 Web Serial";
    return ElMessage.error("当前浏览器不支持 Web Serial，请使用 Chromium/Edge 并通过 HTTPS/localhost 访问");
  }
  usbNvsState.connecting = true;
  try {
    const port = await serial.requestPort({});
    await port.open({ baudRate: 115200 });
    usbNvsState.port = port;
    usbNvsState.connected = true;
    usbNvsState.status = "USB设备已连接，等待读取硬件 NVS";
    usbNvsEntries.value = [];
    ElMessage.success("USB设备已连接");
  } catch (error) {
    usbNvsState.connected = false;
    usbNvsState.port = null;
    usbNvsState.status = (error as Error).message || "连接失败";
    ElMessage.error((error as Error).message || "连接USB设备失败");
  } finally {
    usbNvsState.connecting = false;
  }
}

async function disconnectUsbNvsDevice() {
  try {
    if (usbNvsState.port?.readable || usbNvsState.port?.writable) {
      await usbNvsState.port.close();
    }
  } catch (_) {
    // ignore close errors
  }
  usbNvsState.port = null;
  usbNvsState.connected = false;
  usbNvsState.status = usbNvsState.supported ? "待连接" : "当前浏览器不支持 Web Serial";
}

function selectedNvsDeviceId() {
  return usbNvsState.selectedDeviceId || "";
}

async function writeUsbSerialLine(line: string) {
  if (!usbNvsState.port?.writable) throw new Error("USB 串口不可写，请重新连接硬件");
  const writer = usbNvsState.port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(`${line}\n`));
  } finally {
    writer.releaseLock();
  }
}

async function readUsbSerialLine(timeoutMs = 45000) {
  if (!usbNvsState.port?.readable) throw new Error("USB 串口不可读，请重新连接硬件");
  const reader = usbNvsState.port.readable.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        void reader.cancel();
      } catch (_) {
        // ignore cancel errors
      }
      reject(new Error("当前固件未返回 USB NVS 数据，请确认已刷入支持 nvs.read 的 E6 固件"));
    }, timeoutMs);
  });
  const readLoop = (async () => {
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const resultLine = [...lines].reverse().find((line) => line.includes("nvs.read") || line.startsWith("{") || line.startsWith("["));
      if (resultLine) return resultLine;
      if (buffer.length > 8192) return buffer.trim();
    }
    return buffer.trim();
  })();
  try {
    const line = await Promise.race([readLoop, timeout]);
    if (!line) throw new Error("当前固件未返回 USB NVS 数据");
    return line;
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
}

function tryParseUsbNvsJson(raw: string) {
  const candidates = [
    raw.trim(),
    ...raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse(),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      const jsonLike = candidate.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (!jsonLike) continue;
      try {
        return JSON.parse(jsonLike[1]);
      } catch (_) {
        // keep scanning
      }
    }
  }
  return null;
}

function normalizeUsbNvsEntries(payload: unknown, raw: string): NvsItem[] {
  const fallbackNamespace = usbNvsState.namespace.trim() || "nvs";
  const fallbackKey = usbNvsState.key.trim() || "raw";
  const normalizeEntry = (entry: any, index: number): NvsItem => ({
    namespace: String(entry?.namespace || fallbackNamespace),
    key: String(entry?.key || entry?.name || (index === 0 ? fallbackKey : `item_${index + 1}`)),
    type: String(entry?.type || typeof entry?.value || "string"),
    value: typeof entry?.value === "string" ? entry.value : JSON.stringify(entry?.value ?? entry ?? ""),
    description: entry?.description ? String(entry.description) : undefined,
    secret: Boolean(entry?.secret),
    readonly: entry?.readonly === undefined ? true : Boolean(entry.readonly),
  });

  if (Array.isArray(payload)) {
    return payload.map(normalizeEntry);
  }
  if (payload && typeof payload === "object") {
    const data = payload as Record<string, any>;
    if (data.ok === false || data.success === false) {
      throw new Error(String(data.error || data.message || "USB NVS 读取失败"));
    }
    const rows = data.items || data.rows || data.nvs;
    if (Array.isArray(rows)) {
      return rows.map(normalizeEntry);
    }
    const values = data.values && typeof data.values === "object" ? data.values : null;
    if (values) {
      return Object.entries(values).map(([key, value]) =>
        normalizeEntry({ namespace: data.namespace || fallbackNamespace, key, value }, 0)
      );
    }
    if (data.key || data.value !== undefined) {
      return [normalizeEntry(data, 0)];
    }
  }
  return [
    {
      namespace: fallbackNamespace,
      key: fallbackKey,
      type: "raw",
      value: raw,
      readonly: true,
    },
  ];
}

async function readUsbHardwareNvs() {
  if (!usbNvsState.connected || !usbNvsState.port) {
    return ElMessage.error("请先连接电脑当前 USB 设备");
  }
  usbNvsState.loading = true;
  try {
    const request = {
      type: "nvs.read",
      namespace: usbNvsState.namespace.trim() || "net",
      key: usbNvsState.key.trim(),
      offset: usbNvsState.offset.trim(),
      size: usbNvsState.size.trim(),
    };
    await writeUsbSerialLine(JSON.stringify(request));
    const raw = await readUsbSerialLine();
    const payload = tryParseUsbNvsJson(raw);
    usbNvsEntries.value = normalizeUsbNvsEntries(payload, raw);
    const current = usbNvsEntries.value.find((item) => item.key === usbNvsState.key) || usbNvsEntries.value[0];
    if (current) {
      usbNvsState.namespace = current.namespace;
      usbNvsState.key = current.key;
      usbNvsState.value = String(current.value || "");
    }
    usbNvsState.status = `USB NVS 已读取：${usbNvsEntries.value.length} 项`;
    ElMessage.success("USB 硬件 NVS 已读取");
  } catch (error) {
    usbNvsState.status = (error as Error).message || "USB NVS 读取失败";
    ElMessage.error((error as Error).message || "USB NVS 读取失败");
  } finally {
    usbNvsState.loading = false;
  }
}

async function readUsbNvsPartition() {
  const deviceId = selectedNvsDeviceId();
  if (!deviceId) return ElMessage.error("请先选择一个设备");
  usbNvsState.loading = true;
  try {
    usbNvsState.selectedDeviceId = deviceId;
    const [schema, shadow] = await Promise.all([
      fetchNvsSchema(auth.token, deviceId),
      fetchNvsShadow(auth.token, deviceId),
    ]);
    const shadowMap = new Map((shadow.items || []).map((item) => [item.key, item]));
    usbNvsEntries.value = (schema.items || []).map((item) => ({
      ...item,
      value: String(shadowMap.get(item.key)?.value ?? item.value ?? ""),
      hasValue: Boolean(shadowMap.get(item.key)?.hasValue),
      updatedAt: shadowMap.get(item.key)?.updatedAt || "",
      pendingCommandId: shadowMap.get(item.key)?.pendingCommandId || "",
    }));
    const current = usbNvsEntries.value.find((item) => item.key === usbNvsState.key) || usbNvsEntries.value[0];
    if (current) {
      usbNvsState.namespace = current.namespace;
      usbNvsState.key = current.key;
      usbNvsState.value = String(current.value || "");
    }
    usbNvsState.status = `NVS已读取：${schema.deviceType}`;
    await loadUsbNvsBackups(false);
    ElMessage.success("NVS配置已读取");
  } catch (error) {
    ElMessage.error((error as Error).message || "NVS读取失败");
  } finally {
    usbNvsState.loading = false;
  }
}

async function writeUsbNvsPartition() {
  const deviceId = selectedNvsDeviceId();
  if (!deviceId) return ElMessage.error("请先选择一个设备");
  if (!usbNvsState.key.trim()) return ElMessage.error("请填写 NVS key");
  usbNvsState.loading = true;
  try {
    const result = await writeNvsValue(auth.token, deviceId, usbNvsState.key.trim(), usbNvsState.value, usbNvsState.reboot);
    usbNvsState.selectedDeviceId = deviceId;
    usbNvsState.namespace = result.namespace || usbNvsState.namespace;
    usbNvsState.status = result.commandId ? `NVS写入已排队：${result.commandId}` : "NVS写入已排队";
    ElMessage.success("NVS写入指令已下发");
    await readUsbNvsPartition();
    await loadUsbNvsBackups(false);
  } catch (error) {
    ElMessage.error((error as Error).message || "NVS写回失败");
  } finally {
    usbNvsState.loading = false;
  }
}

function pickUsbNvsBackup(row: NvsBackup) {
  selectedNvsBackupId.value = row.id;
}

async function loadUsbNvsBackups(showToast = true) {
  const deviceId = selectedNvsDeviceId();
  if (!deviceId) {
    if (showToast) ElMessage.error("请先选择一个设备");
    return;
  }
  usbNvsState.loading = true;
  try {
    usbNvsState.selectedDeviceId = deviceId;
    const rows = await fetchNvsBackups(auth.token, deviceId);
    usbNvsBackups.value = rows || [];
    if (selectedNvsBackupId.value && !usbNvsBackups.value.some((item) => item.id === selectedNvsBackupId.value)) {
      selectedNvsBackupId.value = "";
    }
    if (showToast) ElMessage.success("NVS备份已刷新");
  } catch (error) {
    if (showToast) ElMessage.error((error as Error).message || "NVS备份读取失败");
  } finally {
    usbNvsState.loading = false;
  }
}

async function restoreSelectedUsbNvsBackup() {
  const deviceId = selectedNvsDeviceId();
  if (!deviceId) return ElMessage.error("请先选择一个设备");
  if (!selectedNvsBackupId.value) return ElMessage.error("请先选择一个备份");
  try {
    await ElMessageBox.confirm("恢复备份会覆盖当前后端 NVS shadow，并向设备下发 nvs.write 指令。继续吗？", "恢复 NVS 备份", {
      type: "warning",
      confirmButtonText: "恢复",
      cancelButtonText: "取消",
    });
  } catch (_) {
    return;
  }
  usbNvsState.loading = true;
  try {
    const result = await restoreNvsBackup(auth.token, deviceId, selectedNvsBackupId.value, usbNvsState.reboot);
    usbNvsState.status = result.commandId ? `NVS恢复已排队：${result.commandId}` : "NVS恢复已排队";
    ElMessage.success("NVS备份恢复指令已下发");
    await readUsbNvsPartition();
    await loadUsbNvsBackups(false);
  } catch (error) {
    ElMessage.error((error as Error).message || "NVS恢复失败");
  } finally {
    usbNvsState.loading = false;
  }
}

function resetTaskPlanDraft() {
  taskPlanDraft.id = "";
  taskPlanDraft.name = "";
  taskPlanDraft.description = "";
  taskPlanDraft.enabled = true;
  taskPlanDraft.priority = 10;
  taskPlanDraft.targetDeviceIds = [];
  taskPlanDraft.targetClusterIds = [];
  taskPlanDraft.scheduleMode = "once";
  taskPlanDraft.scheduleSpec = {};
  taskPlanDraft.repeatSpec = {};
  taskPlanDraft.retrySpec = {};
  taskPlanDraft.lastRunAt = "";
  taskPlanDraft.nextRunAt = "";
  taskPlanDraft.createdAt = "";
  taskPlanDraft.updatedAt = "";
  taskPlanOnceAt.value = "";
  taskPlanWeekdays.value = [1, 2, 3, 4, 5];
  taskPlanCalendarDatesText.value = "";
  taskPlanTimesText.value = "09:00";
  taskPlanSteps.value = [];
  taskPlanRuns.value = [];
}

function taskPlanStepToRow(step: Record<string, any>, index: number): TaskPlanStepRow {
  const params = step?.params && typeof step.params === "object" ? step.params : {};
  return {
    id: String(step?.id || ""),
    actionType: String(step?.actionType || "device.variable.upsert") as TaskPlanStepRow["actionType"],
    title: String(step?.title || ""),
    enabled: step?.enabled !== false,
    orderIndex: Number(step?.orderIndex || index + 1),
    continueOnError: Boolean(step?.continueOnError),
    name: String(params.name || ""),
    value: String(params.value || ""),
    slug: String(params.slug || ""),
    backendBaseUrl: String(params.backendBaseUrl || ""),
    view: String(params.view || "home"),
  };
}

function taskPlanStepPayload(row: TaskPlanStepRow, index: number) {
  const params: Record<string, any> = {};
  if (row.actionType === "device.variable.upsert") {
    params.name = String(row.name || "").trim();
    params.value = String(row.value || "");
  } else if (row.actionType === "api_template.refresh") {
    params.slug = String(row.slug || "").trim();
  } else if (row.actionType === "remote.update_backend_url") {
    params.backendBaseUrl = String(row.backendBaseUrl || "").trim();
  } else {
    params.view = String(row.view || "home");
  }
  return {
    id: row.id || undefined,
    actionType: row.actionType,
    title: row.title || "",
    enabled: row.enabled !== false,
    orderIndex: index + 1,
    params,
    continueOnError: Boolean(row.continueOnError),
  };
}

function taskPlanScheduleSpecPayload() {
  if (taskPlanDraft.scheduleMode === "once") {
    const value = taskPlanOnceAt.value instanceof Date ? taskPlanOnceAt.value.toISOString() : String(taskPlanOnceAt.value || "");
    return { runAt: value };
  }
  if (taskPlanDraft.scheduleMode === "calendar") {
    return {
      dates: taskPlanCalendarDatesText.value.split(/[,\n;\s]+/g).map((item) => item.trim()).filter(Boolean),
      times: taskPlanTimesText.value.split(/[,\n;\s]+/g).map((item) => item.trim()).filter(Boolean),
    };
  }
  return {
    weekdays: [...taskPlanWeekdays.value],
    times: taskPlanTimesText.value.split(/[,\n;\s]+/g).map((item) => item.trim()).filter(Boolean),
  };
}

function addTaskPlanStep() {
  taskPlanSteps.value.push({
    actionType: "device.variable.upsert",
    continueOnError: false,
    view: "home",
  });
}

function removeTaskPlanStep(index: number) {
  taskPlanSteps.value.splice(index, 1);
}

async function loadTaskPlans() {
  if (!auth.token) return;
  taskPlanLoading.value = true;
  try {
    taskPlans.value = await apiRequest<TaskPlanRow[]>("/api/task-plans", { token: auth.token });
  } catch (error) {
    ElMessage.error((error as Error).message || "加载计划任务失败");
  } finally {
    taskPlanLoading.value = false;
  }
}

async function loadTaskPlanRuns(planId: string) {
  if (!auth.token || !planId) {
    taskPlanRuns.value = [];
    return;
  }
  try {
    taskPlanRuns.value = await apiRequest<TaskRunRow[]>(`/api/task-plans/${encodeURIComponent(planId)}/runs`, { token: auth.token });
  } catch (error) {
    taskPlanRuns.value = [];
    ElMessage.error((error as Error).message || "加载运行历史失败");
  }
}

function pickTaskPlan(row: TaskPlanRow) {
  taskPlanDraft.id = row.id || "";
  taskPlanDraft.name = row.name || "";
  taskPlanDraft.description = row.description || "";
  taskPlanDraft.enabled = row.enabled !== false;
  taskPlanDraft.priority = Number(row.priority || 10);
  taskPlanDraft.targetDeviceIds = Array.isArray(row.targetDeviceIds) ? [...row.targetDeviceIds] : [];
  taskPlanDraft.targetClusterIds = Array.isArray(row.targetClusterIds) ? [...row.targetClusterIds] : [];
  taskPlanDraft.scheduleMode = row.scheduleMode || "once";
  taskPlanDraft.scheduleSpec = row.scheduleSpec || {};
  taskPlanDraft.repeatSpec = row.repeatSpec || {};
  taskPlanDraft.retrySpec = row.retrySpec || {};
  taskPlanDraft.lastRunAt = row.lastRunAt || "";
  taskPlanDraft.nextRunAt = row.nextRunAt || "";
  taskPlanDraft.createdAt = row.createdAt || "";
  taskPlanDraft.updatedAt = row.updatedAt || "";
  taskPlanOnceAt.value = row.scheduleMode === "once" ? String(row.scheduleSpec?.runAt || "") : "";
  taskPlanWeekdays.value = Array.isArray(row.scheduleSpec?.weekdays) ? [...row.scheduleSpec.weekdays] : [1, 2, 3, 4, 5];
  taskPlanCalendarDatesText.value = Array.isArray(row.scheduleSpec?.dates) ? row.scheduleSpec.dates.join(",") : "";
  taskPlanTimesText.value = Array.isArray(row.scheduleSpec?.times) ? row.scheduleSpec.times.join(",") : "09:00";
  taskPlanSteps.value = Array.isArray(row.steps) ? row.steps.map(taskPlanStepToRow) : [];
  loadTaskPlanRuns(row.id);
}

async function saveTaskPlan() {
  if (!taskPlanDraft.name.trim()) return ElMessage.error("请填写任务名称");
  if (!taskPlanDraft.targetDeviceIds.length && !taskPlanDraft.targetClusterIds.length) return ElMessage.error("请选择目标设备或设备池");
  const steps = taskPlanSteps.value.map(taskPlanStepPayload);
  if (!steps.length) return ElMessage.error("请至少新增一个动作步骤");
  const payload = {
    name: taskPlanDraft.name.trim(),
    description: taskPlanDraft.description,
    enabled: taskPlanDraft.enabled,
    priority: taskPlanDraft.priority,
    targetDeviceIds: taskPlanDraft.targetDeviceIds,
    targetClusterIds: taskPlanDraft.targetClusterIds,
    scheduleMode: taskPlanDraft.scheduleMode,
    scheduleSpec: taskPlanScheduleSpecPayload(),
    repeatSpec: taskPlanDraft.repeatSpec || {},
    retrySpec: taskPlanDraft.retrySpec || {},
    steps,
  };
  taskPlanSaving.value = true;
  try {
    const endpoint = taskPlanDraft.id ? `/api/task-plans/${encodeURIComponent(taskPlanDraft.id)}` : "/api/task-plans";
    const saved = await apiRequest<TaskPlanRow>(endpoint, {
      method: "POST",
      token: auth.token,
      body: JSON.stringify(payload),
    });
    ElMessage.success("计划任务已保存");
    await loadTaskPlans();
    pickTaskPlan(saved);
  } catch (error) {
    ElMessage.error((error as Error).message || "保存计划任务失败");
  } finally {
    taskPlanSaving.value = false;
  }
}

async function runTaskPlanNow(row: Pick<TaskPlanRow, "id">) {
  if (!row?.id) return ElMessage.error("请先保存计划任务");
  taskPlanRunning.value = true;
  try {
    const run = await apiRequest<TaskRunRow>(`/api/task-plans/${encodeURIComponent(row.id)}/run`, {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({}),
      timeoutMs: 120000,
    });
    ElMessage.success(`计划任务执行完成：${run.status}`);
    await loadTaskPlans();
    await loadTaskPlanRuns(row.id);
  } catch (error) {
    ElMessage.error((error as Error).message || "执行计划任务失败");
  } finally {
    taskPlanRunning.value = false;
  }
}

async function deleteTaskPlan(row: TaskPlanRow) {
  if (!row?.id) return;
  if (!window.confirm(`确认删除计划任务「${row.name}」？`)) return;
  await apiRequest(`/api/task-plans/${encodeURIComponent(row.id)}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({}),
  });
  ElMessage.success("计划任务已删除");
  if (taskPlanDraft.id === row.id) resetTaskPlanDraft();
  await loadTaskPlans();
}

async function loadDeviceVariables() {
  if (!auth.token) return;
  if (!deviceVariableDeviceId.value && deviceStore.devices.length) {
    deviceVariableDeviceId.value = deviceStore.devices[0].id;
  }
  if (!deviceVariableDeviceId.value) {
    deviceVariableBaseRows.value = [];
    deviceVariableApiRows.value = [];
    deviceVariableSuggestions.names = [];
    deviceVariableSuggestions.values = [];
    deviceVariableApiSuggestions.names = [];
    deviceVariableApiSuggestions.values = [];
    deviceVariableApiKeyword.value = "";
    return;
  }
  deviceVariableLoading.value = true;
  try {
    const data = await apiRequest<{
      baseVariables?: DeviceBaseVariableRow[];
      apiVariables?: DeviceApiVariableRow[];
      suggestions?: { names?: string[]; values?: string[] };
      baseSuggestions?: { names?: string[]; values?: string[] };
      apiSuggestions?: { names?: string[]; values?: string[] };
    }>(`/api/device-variables/${encodeURIComponent(deviceVariableDeviceId.value)}`, { token: auth.token });
    deviceVariableBaseRows.value = Array.isArray(data.baseVariables) ? data.baseVariables : [];
    deviceVariableApiRows.value = Array.isArray(data.apiVariables) ? data.apiVariables : [];
    const baseSuggestions = data.baseSuggestions || data.suggestions || {};
    deviceVariableSuggestions.names = Array.isArray(baseSuggestions.names) ? baseSuggestions.names : [];
    deviceVariableSuggestions.values = Array.isArray(baseSuggestions.values) ? baseSuggestions.values : [];
    deviceVariableApiSuggestions.names = Array.isArray(data.apiSuggestions?.names) ? data.apiSuggestions.names : [];
    deviceVariableApiSuggestions.values = Array.isArray(data.apiSuggestions?.values) ? data.apiSuggestions.values : [];
  } catch (error) {
    deviceVariableBaseRows.value = [];
    deviceVariableApiRows.value = [];
    deviceVariableSuggestions.names = [];
    deviceVariableSuggestions.values = [];
    deviceVariableApiSuggestions.names = [];
    deviceVariableApiSuggestions.values = [];
    ElMessage.error((error as Error).message || "加载设备变量失败");
  } finally {
    deviceVariableLoading.value = false;
  }
}

function resetDeviceVariableDraft() {
  deviceVariableDraft.name = "";
  deviceVariableDraft.value = "";
  deviceVariableEditingName.value = "";
}

function deviceVariablePlaceholder(name: string) {
  return `{{deviceVariables.${String(name || "").trim()}}}`;
}

function editDeviceVariable(row: DeviceBaseVariableRow) {
  deviceVariableDraft.name = row.name || "";
  deviceVariableDraft.value = row.value || "";
  deviceVariableEditingName.value = row.name || "";
}

async function saveDeviceVariable() {
  if (!deviceVariableDeviceId.value) return ElMessage.error("请先选择设备");
  if (!deviceVariableDraft.name.trim()) return ElMessage.error("请填写变量名");
  await apiRequest(`/api/device-variables/${encodeURIComponent(deviceVariableDeviceId.value)}/base`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      name: deviceVariableDraft.name.trim(),
      value: deviceVariableDraft.value,
    }),
  });
  ElMessage.success("设备变量已保存");
  resetDeviceVariableDraft();
  await loadDeviceVariables();
  await loadHomepageTemplateVariables();
}

async function deleteDeviceVariable(row: DeviceBaseVariableRow) {
  const name = String(row?.name || "").trim();
  if (!name || !deviceVariableDeviceId.value) return;
  if (!window.confirm(`确认删除设备变量「${name}」？`)) return;
  await apiRequest(`/api/device-variables/${encodeURIComponent(deviceVariableDeviceId.value)}/base/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ name }),
  });
  ElMessage.success("设备变量已删除");
  if (deviceVariableEditingName.value === name) resetDeviceVariableDraft();
  await loadDeviceVariables();
  await loadHomepageTemplateVariables();
}

function copyApiVariableToBase(row: DeviceApiVariableRow) {
  const fallbackName = String(row.path || "").split(".").slice(3).join(".");
  deviceVariableDraft.name = String(fallbackName || row.name || "").trim();
  deviceVariableDraft.value = String(row.value || "");
  deviceVariableEditingName.value = "";
}

function addDeviceVariableBatchRow() {
  deviceVariableBatchRows.value.push({
    name: "",
    value: "",
    mode: "specified",
    deviceIds: [],
    clusterIds: [],
    randomCount: 1,
  });
}

function removeDeviceVariableBatchRow(index: number) {
  deviceVariableBatchRows.value.splice(index, 1);
}

function openDeviceVariableBatchDialog() {
  deviceVariableBatchDialogOpen.value = true;
  if (!deviceVariableBatchRows.value.length) addDeviceVariableBatchRow();
  loadClusters();
}

async function executeDeviceVariableBatch() {
  const entries = deviceVariableBatchRows.value
    .map((row) => ({
      name: row.name.trim(),
      value: row.value,
      deviceIds: row.mode === "specified" ? [...row.deviceIds] : [],
      clusterIds: row.mode === "random" ? [...row.clusterIds] : [],
      randomCount: row.mode === "random" ? Math.max(1, Number(row.randomCount || 1)) : 0,
    }))
    .filter((row) => row.name);
  if (!entries.length) return ElMessage.error("请至少填写一条变量记录");
  const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/device-variables/batch/base-upsert", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      entries,
      defaultDeviceIds: deviceStore.selectedIds,
    }),
  });
  ElMessage.success(`批量变量保存完成：成功 ${data.successCount}，失败 ${data.failedCount}`);
  await loadDeviceVariables();
  await loadHomepageTemplateVariables();
}

async function bindByPin() {
  if (!bindForm.pin.trim()) return ElMessage.error("请输入PIN");
  const body: Record<string, any> = { pin: bindForm.pin.trim() };
  if (isAdmin.value && bindForm.ownerId.trim()) {
    body.ownerId = bindForm.ownerId.trim();
  }
  await apiRequest("/api/devices/bind-pin", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify(body),
  });
  ElMessage.success("PIN绑定成功");
  bindForm.pin = "";
  await refreshDevices();
  await refreshOverview();
}

async function changePassword() {
  if (!passwordForm.oldPassword || !passwordForm.newPassword) {
    return ElMessage.error("请填写旧密码和新密码");
  }
  await apiRequest("/api/auth/change-password", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify(passwordForm),
  });
  passwordForm.oldPassword = "";
  passwordForm.newPassword = "";
  ElMessage.success("密码已更新");
}

async function loadAdminUsers() {
  if (!isAdmin.value || !auth.token) return;
  const rows = await apiRequest<any[]>("/api/admin/users", { token: auth.token });
  adminUsers.value = rows.map((row) => ({
    id: row.id,
    username: row.username,
    role: row.role === "admin" ? "admin" : "user",
    status: row.status === "blocked" ? "blocked" : "enabled",
    nickname: String(row.nickname || ""),
    deviceCount: Number(row.deviceCount || 0),
    _newPassword: "",
    _deleteMode: "detach",
  }));
  if (!adminResourceForm.userId && adminUsers.value.length) {
    adminResourceForm.userId = adminUsers.value[0].id;
  }
}

async function loadAiConfig() {
  if (!auth.token) return;
  aiConfigLoading.value = true;
  try {
    const result = await fetchMyAiConfig(auth.token);
    aiEffective.value = result.effective || null;
    if (result.config) {
      aiConfigForm.name = result.config.name || "我的 DeepSeek";
      aiConfigForm.provider = result.config.provider || "deepseek";
      aiConfigForm.baseUrl = result.config.baseUrl || "https://api.deepseek.com";
      aiConfigForm.model = result.config.model || "deepseek-chat";
      aiConfigForm.enabled = result.config.enabled !== false;
      aiConfigForm.thinkingEnabled = result.config.thinkingEnabled === true;
    } else if (result.effective) {
      aiConfigForm.provider = result.effective.provider || "deepseek";
      aiConfigForm.baseUrl = result.effective.baseUrl || "https://api.deepseek.com";
      aiConfigForm.model = result.effective.model || "deepseek-chat";
      aiConfigForm.enabled = result.effective.enabled !== false;
      aiConfigForm.thinkingEnabled = result.effective.thinkingEnabled === true;
    }
    aiConfigForm.apiKey = "";
  } catch (error) {
    ElMessage.error((error as Error).message || "加载AI配置失败");
  } finally {
    aiConfigLoading.value = false;
  }
}

async function openAiSettingsDrawer() {
  aiSettingsDrawerOpen.value = true;
  await loadAiConfig();
  if (isAdmin.value) {
    await Promise.all([loadAdminUsers(), loadAdminAiConfigs()]);
  }
}

async function saveAiConfig() {
  if (!auth.token) return;
  aiConfigLoading.value = true;
  try {
    const payload: Record<string, any> = {
      name: aiConfigForm.name,
      provider: aiConfigForm.provider,
      baseUrl: aiConfigForm.baseUrl,
      model: aiConfigForm.model,
      enabled: aiConfigForm.enabled,
      thinkingEnabled: aiConfigForm.thinkingEnabled,
    };
    if (aiConfigForm.apiKey.trim()) payload.apiKey = aiConfigForm.apiKey.trim();
    const result = await saveMyAiConfig(auth.token, payload);
    aiEffective.value = result.effective || null;
    aiConfigForm.apiKey = "";
    ElMessage.success("AI配置已保存");
  } catch (error) {
    ElMessage.error((error as Error).message || "保存AI配置失败");
  } finally {
    aiConfigLoading.value = false;
  }
}

async function loadAdminAiConfigs() {
  if (!isAdmin.value || !auth.token) return;
  try {
    adminAiConfigs.value = await fetchAdminAiConfigs(auth.token);
    if (!adminAiAssignForm.configId && adminAiConfigs.value[0]) {
      adminAiAssignForm.configId = adminAiConfigs.value[0].id;
    }
  } catch (error) {
    ElMessage.error((error as Error).message || "加载管理员AI配置失败");
  }
}

async function createAdminAiProvider() {
  if (!isAdmin.value) return;
  if (!adminAiConfigForm.name.trim()) return ElMessage.error("请填写配置名");
  if (!adminAiConfigForm.apiKey.trim()) return ElMessage.error("请填写 API Key");
  try {
    const row = await createAdminAiConfig(auth.token, {
      name: adminAiConfigForm.name,
      provider: adminAiConfigForm.provider,
      baseUrl: adminAiConfigForm.baseUrl,
      model: adminAiConfigForm.model,
      apiKey: adminAiConfigForm.apiKey,
      enabled: adminAiConfigForm.enabled,
    });
    adminAiConfigForm.apiKey = "";
    await loadAdminAiConfigs();
    adminAiAssignForm.configId = row.id;
    ElMessage.success("管理员AI配置已创建");
  } catch (error) {
    ElMessage.error((error as Error).message || "创建AI配置失败");
  }
}

async function assignAdminAiProvider() {
  if (!isAdmin.value) return;
  if (!adminAiAssignForm.configId) return ElMessage.error("请选择AI配置");
  if (!adminAiAssignForm.userIds.length) return ElMessage.error("请选择要分配的用户");
  try {
    const result = await assignAdminAiConfig(auth.token, {
      configId: adminAiAssignForm.configId,
      userIds: adminAiAssignForm.userIds,
      enabled: true,
    });
    ElMessage.success(`已分配 ${result.assigned} 个用户`);
  } catch (error) {
    ElMessage.error((error as Error).message || "批量分配失败");
  }
}

async function createAdminUser() {
  if (!isAdmin.value) return;
  if (!adminUserCreateForm.username.trim() || !adminUserCreateForm.password.trim()) {
    return ElMessage.error("请填写用户名和密码");
  }
  await apiRequest("/api/admin/users", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      username: adminUserCreateForm.username.trim(),
      password: adminUserCreateForm.password,
      role: adminUserCreateForm.role,
      nickname: adminUserCreateForm.nickname.trim(),
    }),
  });
  ElMessage.success("账号已创建");
  adminUserCreateForm.username = "";
  adminUserCreateForm.password = "";
  adminUserCreateForm.nickname = "";
  adminUserCreateForm.role = "user";
  await loadAdminUsers();
  await refreshOverview();
}

async function updateAdminUser(row: AdminUserRow) {
  if (!isAdmin.value) return;
  const body: Record<string, any> = {
    nickname: row.nickname,
    role: row.role,
    status: row.status,
  };
  if (row._newPassword && row._newPassword.length >= 6) {
    body.password = row._newPassword;
  }
  await apiRequest(`/api/admin/users/${row.id}`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify(body),
  });
  row._newPassword = "";
  ElMessage.success("账号已更新");
  await loadAdminUsers();
}

async function deleteAdminUser(row: AdminUserRow) {
  if (!isAdmin.value) return;
  await apiRequest(`/api/admin/users/${row.id}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ mode: row._deleteMode || "detach" }),
  });
  ElMessage.success("账号已删除");
  await loadAdminUsers();
  await refreshOverview();
}

async function applyAdminUserResources() {
  if (!isAdmin.value) return;
  if (!adminResourceForm.userId) return ElMessage.error("请选择账号");
  await apiRequest(`/api/admin/users/${adminResourceForm.userId}/resources`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      action: adminResourceForm.action,
      targetUserId: adminResourceForm.targetUserId || "",
    }),
  });
  ElMessage.success("资源处理已完成");
  await loadAdminUsers();
  await refreshDevices();
}

async function loadTodoRows() {
  if (!auth.token || !todoDeviceId.value) return;
  const rows = await apiRequest<any[]>(`/api/todos?deviceId=${encodeURIComponent(todoDeviceId.value)}`, { token: auth.token });
  todoRows.value = rows.map((row) => ({
    id: row.id,
    content: row.content || "",
    done: Boolean(row.done),
    priority: row.priority === null || row.priority === undefined ? null : Number(row.priority),
  }));
  todoDeletedIds.value = [];
}

function addTodoRow() {
  todoRows.value.push({ content: "", done: false, priority: null });
}

function removeTodoRow(index: number) {
  const row = todoRows.value[index];
  if (row?.id) todoDeletedIds.value.push(String(row.id));
  todoRows.value.splice(index, 1);
}

async function saveTodoRows() {
  if (!todoDeviceId.value) return ElMessage.error("请选择设备");
  await apiRequest("/api/todos/batch-upsert", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deviceId: todoDeviceId.value,
      rows: todoRows.value,
      deletedIds: todoDeletedIds.value,
    }),
  });
  ElMessage.success("TODO保存成功");
  await loadTodoRows();
}

function resolveBatchTargetDevices(key: DispatchTargetKey) {
  const ids = [...(batchTargetDeviceIds[key] || [])];
  if (ids.length) return ids;
  return [...deviceStore.selectedIds];
}

function formatDateTimeText(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "-";
  const dt = new Date(raw);
  if (!Number.isFinite(dt.getTime())) return raw;
  return dt.toLocaleString("zh-CN", { hour12: false });
}

function syncHomepageConfigJsonFromModel() {
  ensureHomepageAutoRenderPushShape(homepageConfigModel?.auto_render_push || {});
  homepageConfigJson.value = JSON.stringify(homepageConfigModel, null, 2);
}

function applyHomepageConfigModel(data: Record<string, any>) {
  Object.keys(homepageConfigModel).forEach((k) => delete homepageConfigModel[k]);
  Object.assign(homepageConfigModel, data || {});
  if (!homepageConfigModel.template) homepageConfigModel.template = { template_id: "tpl_home_default" };
  if (!homepageConfigModel.auto_render_push) {
    homepageConfigModel.auto_render_push = {
      enabled: false,
      interval_enabled: true,
      window_start_time: "07:30",
      window_end_time: "23:59",
      fixed_times: [],
      // legacy aliases
      daily_start_time: "07:30",
      interval_minutes: 60,
      next_run_at: "",
      last_run_at: "",
      last_result: "idle",
      last_error: "",
      last_reason: "",
    };
  }
  ensureHomepageAutoRenderPushShape(homepageConfigModel.auto_render_push);
  if (!homepageConfigModel.time_overlay) {
    homepageConfigModel.time_overlay = {
      enabled: true,
      x: 1820,
      y: 80,
      width: 680,
      height: 180,
      format: "HH:mm",
      font_size: 88,
      align: "right",
      refresh_interval_sec: 60,
    };
  }
  syncHomepageConfigJsonFromModel();
}

function parseHomepageConfigJson() {
  try {
    return JSON.parse(homepageConfigJson.value || "{}");
  } catch (_) {
    throw new Error("主页配置 JSON 格式错误");
  }
}

function buildHomepageConfigPatch() {
  const patch = parseHomepageConfigJson();
  patch.template = patch.template || {};
  patch.template.template_id = String(
    homepageConfigModel?.template?.template_id || patch.template.template_id || "tpl_home_default"
  );

  patch.time_overlay = patch.time_overlay || {};
  const srcOverlay = homepageConfigModel?.time_overlay || {};
  Object.keys(srcOverlay).forEach((k) => {
    patch.time_overlay[k] = srcOverlay[k];
  });

  patch.auto_render_push = patch.auto_render_push || {};
  const srcAuto = homepageConfigModel?.auto_render_push || {};
  ensureHomepageAutoRenderPushShape(srcAuto);
  if (srcAuto.enabled && !srcAuto.interval_enabled && (!Array.isArray(srcAuto.fixed_times) || srcAuto.fixed_times.length === 0)) {
    srcAuto.interval_enabled = true;
    srcAuto.window_start_time = String(srcAuto.window_start_time || srcAuto.daily_start_time || "07:30");
    srcAuto.window_end_time = String(srcAuto.window_end_time || "23:59");
  }
  Object.keys(srcAuto).forEach((k) => {
    patch.auto_render_push[k] = srcAuto[k];
  });
  return patch;
}

function getHomepageTemplateId() {
  return String(homepageConfigModel?.template?.template_id || "").trim();
}

function findHomepageTemplateRow(templateId: string) {
  const id = String(templateId || "").trim();
  if (!id) return null;
  return homepageTemplates.value.find((item) => item.id === id) || null;
}

function syncHomepageTemplateDraftFromConfig() {
  const templateId = getHomepageTemplateId();
  if (!templateId) return;
  const row = findHomepageTemplateRow(templateId);
  if (!row) return;
  if (!homepageTemplateDraft.id || homepageTemplateDraft.id === templateId || !homepageTemplates.value.some((item) => item.id === homepageTemplateDraft.id)) {
    homepageTemplateDraft.id = row.id;
    homepageTemplateDraft.name = row.name;
    homepageTemplateDraft.type = row.type;
    homepageTemplateDraft.html = row.html;
    homepageTemplateDraft.builtin = Boolean(row.builtin);
    homepageTemplateDraft.targetDeviceTypes = normalizeHomepageTargetDeviceTypes(row.targetDeviceTypes);
  }
}

function buildHomepageRenderTemplatePatch() {
  const selectedId = getHomepageTemplateId();
  if (!selectedId) return undefined;

  const configTemplate = findHomepageTemplateRow(selectedId);
  const draftId = String(homepageTemplateDraft.id || "").trim();
  if (draftId && draftId === selectedId) {
    const html = String(homepageTemplateDraft.html || "").trim();
    if (!html) return undefined;
    return {
      id: selectedId,
      name: String(homepageTemplateDraft.name || configTemplate?.name || "Homepage Template").trim() || "Homepage Template",
      type: String(homepageTemplateDraft.type || configTemplate?.type || "custom_html"),
      html,
      targetDeviceTypes: normalizeHomepageTargetDeviceTypes(homepageTemplateDraft.targetDeviceTypes),
    };
  }

  if (configTemplate) {
    return {
      id: String(configTemplate.id || selectedId),
      name: String(configTemplate.name || "Homepage Template"),
      type: String(configTemplate.type || "custom_html"),
      html: String(configTemplate.html || ""),
      targetDeviceTypes: normalizeHomepageTargetDeviceTypes(configTemplate.targetDeviceTypes),
    };
  }

  return {
    id: selectedId,
    name: "Homepage Template",
    type: "custom_html",
    html: "",
    targetDeviceTypes: [],
  };
}

const homepageBaseVariableRoots = new Set(["profile", "todo_summary", "schedule_summary", "weather", "custom_fields", "meta"]);

function classifyHomepageApiVariable(path: string) {
  const raw = String(path || "").trim();
  const stepMatch = raw.match(/(?:^|\.)(?:raw\.)?steps\.(\d+)(?:\.|$)/i);
  if (stepMatch?.[1]) {
    const stepNo = Number(stepMatch[1]) + 1;
    return {
      categoryKey: `step-${stepNo}`,
      categoryLabel: `第${stepNo}步`,
    };
  }

  const lower = raw.toLowerCase();
  if (
    lower.includes(".formatted") ||
    lower.includes(".raw.output") ||
    lower.startsWith("formatted_by_slug.") ||
    lower.startsWith("api.formatted_by_slug.")
  ) {
    return {
      categoryKey: "final",
      categoryLabel: "最终结果",
    };
  }

  if (
    lower.includes(".template.") ||
    lower.endsWith(".updated_at") ||
    lower.includes(".raw.vars") ||
    lower.includes(".raw.steps")
  ) {
    return {
      categoryKey: "base",
      categoryLabel: "基础属性",
    };
  }

  return {
    categoryKey: "base",
    categoryLabel: "基础属性",
  };
}

function collectHomepageApiSlugs(rows: HomepageTemplateVariableRow[]) {
  const slugs = new Set<string>();
  (rows || []).forEach((row) => {
    const path = String(row?.path || "").trim();
    const patterns = [
      /^api\.third\.([^.]+)/,
      /^api\.formatted_by_slug\.([^.]+)/,
      /^api\.raw_by_slug\.([^.]+)/,
      /^third\.([^.]+)/,
      /^third_formatted\.([^.]+)/,
      /^third_raw\.([^.]+)/,
      /^formatted_by_slug\.([^.]+)/,
      /^raw_by_slug\.([^.]+)/,
    ];
    patterns.some((pattern) => {
      const match = path.match(pattern);
      if (!match?.[1]) return false;
      slugs.add(String(match[1]).trim());
      return true;
    });
  });
  return slugs;
}

function normalizeHomepageTemplateVariables(rows: Array<Record<string, any>>) {
  const rawRows = Array.isArray(rows) ? rows : [];
  const knownApiSlugs = new Set<string>([
    ...collectHomepageApiSlugs(
      rawRows.map((item) => ({
        path: String(item?.path || ""),
        placeholder: String(item?.placeholder || ""),
        type: String(item?.type || ""),
        example: String(item?.example || ""),
        source: String(item?.source || "") as "base" | "api" | "device" | undefined,
        slug: String(item?.slug || ""),
        sourceLabel: String(item?.sourceLabel || ""),
      }))
    ),
    ...((templateRows.value || [])
      .map((tpl) => String(tpl?.slug || "").trim())
      .filter(Boolean)),
  ]);

  return rawRows
    .map((item) => {
      const path = String(item?.path || "").trim();
      const placeholder = String(item?.placeholder || `{{${path}}}`);
      const type = String(item?.type || "string");
      const example = String(item?.example || "");
      const first = path.split(".")[0] || "";
      const matchers = [
        /^api\.third\.([^.]+)/,
        /^api\.formatted_by_slug\.([^.]+)/,
        /^api\.raw_by_slug\.([^.]+)/,
        /^third\.([^.]+)/,
        /^third_formatted\.([^.]+)/,
        /^third_raw\.([^.]+)/,
        /^formatted_by_slug\.([^.]+)/,
        /^raw_by_slug\.([^.]+)/,
      ];
      const apiMatch = matchers
        .map((pattern) => path.match(pattern))
        .find((match) => Boolean(match?.[1]));
      const slug = String(item?.slug || apiMatch?.[1] || "").trim();
      const isDeviceVariable =
        first === "deviceVariables" ||
        first === "device_variables" ||
        first === "deviceVariableList" ||
        first === "device_variable_list";
      const isBase = homepageBaseVariableRoots.has(first) || ["formatted", "raw", "third_latest"].includes(first) || path === "formatted" || path === "raw";
      const inferredSource: "base" | "api" | "device" =
        isDeviceVariable
          ? "device"
          : isBase || (!slug && !knownApiSlugs.has(first) && !knownApiSlugs.has(path))
            ? "base"
            : "api";
      const source = String(item?.source || inferredSource) as "base" | "api" | "device";
      const resolvedSlug =
        source === "api" ? (slug || (knownApiSlugs.has(first) ? first : "latest")) : "";
      const category = source === "api" ? classifyHomepageApiVariable(path) : { categoryKey: "base", categoryLabel: "基础属性" };
      return {
        path,
        placeholder,
        type,
        example,
        source,
        slug: resolvedSlug,
        sourceLabel: source === "api" ? "API模板变量" : source === "device" ? "设备变量" : "基础变量",
        categoryKey: category.categoryKey,
        categoryLabel: category.categoryLabel,
      };
    })
    .filter((item) => Boolean(item.path))
    .sort((a, b) => {
      const sourceRank = (value: string) => (value === "api" ? 2 : value === "device" ? 1 : 0);
      const sourceDelta = sourceRank(a.source || "base") - sourceRank(b.source || "base");
      if (sourceDelta !== 0) return sourceDelta;
      const slugDelta = String(a.slug || "").localeCompare(String(b.slug || ""));
      if (slugDelta !== 0) return slugDelta;
      return String(a.path || "").localeCompare(String(b.path || ""));
    });
}

async function loadHomepageTemplateVariables() {
  if (!auth.token || !homepageDeviceId.value) {
    homepageTemplateVariables.value = [];
    return;
  }
  if (homepageInsertVarLoading.value) return;
  homepageInsertVarLoading.value = true;
  try {
    const data = await apiRequest<{ variables?: Array<{ path: string; placeholder: string; type: string; example: string }> }>(
      `/api/homepages/template-variables?deviceId=${encodeURIComponent(homepageDeviceId.value)}`,
      { token: auth.token }
    );
    homepageTemplateVariables.value = normalizeHomepageTemplateVariables(Array.isArray(data?.variables) ? data.variables : []);
  } catch (error) {
    homepageTemplateVariables.value = [];
    ElMessage.error((error as Error).message || "加载变量失败");
  } finally {
    homepageInsertVarLoading.value = false;
  }
}

function openHomepageVariablePanel() {
  if (!homepageDeviceId.value) {
    homepageInsertVarVisible.value = false;
    ElMessage.warning("请先选择主页目标设备");
    return;
  }
  homepageInsertVarVisible.value = true;
  void loadHomepageTemplateVariables();
}

function insertHomepageTemplateVariable(path: string) {
  const variable = `{{${String(path || "").trim()}}}`;
  const textarea = homepageTemplateHtmlInputRef.value?.textarea as HTMLTextAreaElement | undefined;
  if (!textarea) {
    homepageTemplateDraft.html = `${String(homepageTemplateDraft.html || "")}${variable}`;
    homepageInsertVarVisible.value = false;
    return;
  }

  const current = String(homepageTemplateDraft.html || "");
  const start = textarea.selectionStart ?? current.length;
  const end = textarea.selectionEnd ?? current.length;
  homepageTemplateDraft.html = `${current.slice(0, start)}${variable}${current.slice(end)}`;
  requestAnimationFrame(() => {
    const pos = start + variable.length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
  });
  homepageInsertVarVisible.value = false;
}

async function fetchHomepagePreview(url: string) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
    },
  });
  if (!response.ok) return "";
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

function clearPreviewRef(target: typeof homepagePreviewUrl | typeof homepageEditPreviewUrl) {
  if (target.value && target.value.startsWith("blob:")) {
    URL.revokeObjectURL(target.value);
  }
  target.value = "";
}

function buildHomepageTemplatePatchForRender() {
  return buildHomepageRenderTemplatePatch();
}

async function applyHomepagePreviewImage(image: Record<string, any>, target: typeof homepagePreviewUrl | typeof homepageEditPreviewUrl) {
  clearPreviewRef(target);
  if (!image || typeof image !== "object") return;

  const inlineDataUrl = String(image.preview_data_url || "").trim();
  if (inlineDataUrl.startsWith("data:image/")) {
    target.value = inlineDataUrl;
    return;
  }

  const url = String(image.admin_preview_url || image.preview_url || "").trim();
  if (!url) return;
  const objectUrl = await fetchHomepagePreview(url);
  if (objectUrl) {
    target.value = objectUrl;
  }
}

async function renderHomepageEditPreview(revision = homepageEditPreviewRevision) {
  if (!auth.token || !homepageDeviceId.value || homepagePreviewMode.value !== "edit") return;
  if (homepageEditPreviewInFlight) {
    homepageEditPreviewQueuedRevision = Math.max(homepageEditPreviewQueuedRevision || 0, revision);
    return;
  }
  homepageEditPreviewInFlight = true;
  homepageEditPreviewLoading.value = true;
  if (revision === homepageEditPreviewRevision) {
    homepageEditPreviewError.value = "";
  }
  try {
    const patch = buildHomepageConfigPatch();
    const data = await apiRequest<any>("/api/homepages/render", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({
        deviceId: homepageDeviceId.value,
        config: patch,
        template: buildHomepageTemplatePatchForRender(),
      }),
    });
    if (revision !== homepageEditPreviewRevision) return;
    Object.keys(homepageRenderMeta).forEach((k) => delete homepageRenderMeta[k]);
    Object.assign(homepageRenderMeta, data.image || {});
    await applyHomepagePreviewImage(data.image || {}, homepageEditPreviewUrl);
    await applyHomepagePreviewImage(data.image || {}, homepagePreviewUrl);
  } catch (_) {
    if (revision === homepageEditPreviewRevision) {
      clearPreviewRef(homepageEditPreviewUrl);
      homepageEditPreviewError.value = "渲染失败：浏览器渲染不可用，已回退（请检查后端日志）";
    }
  } finally {
    if (revision === homepageEditPreviewRevision) {
      homepageEditPreviewLoading.value = false;
    }
    homepageEditPreviewInFlight = false;
    const queued = homepageEditPreviewQueuedRevision;
    homepageEditPreviewQueuedRevision = null;
    if (queued && queued > revision && homepagePreviewMode.value === "edit") {
      void renderHomepageEditPreview(queued);
    }
  }
}

function scheduleHomepageEditPreview() {
  homepageEditPreviewRevision += 1;
  const revision = homepageEditPreviewRevision;
  if (homepageEditPreviewTimer) {
    clearTimeout(homepageEditPreviewTimer);
    homepageEditPreviewTimer = null;
  }
  if (homepagePreviewMode.value !== "edit") {
    homepageEditPreviewQueuedRevision = null;
    homepageEditPreviewLoading.value = false;
    return;
  }
  homepageEditPreviewTimer = setTimeout(() => {
    void renderHomepageEditPreview(revision);
  }, 260);
}

async function loadHomepageTemplates() {
  if (!auth.token) return;
  homepageTemplates.value = await apiRequest<HomepageTemplateRow[]>("/api/homepages/templates", { token: auth.token });
  syncHomepageTemplateDraftFromConfig();
  if (!homepageTemplateDraft.id && homepageTemplates.value.length) {
    const first = homepageTemplates.value[0];
    homepageTemplateDraft.id = first.id;
    homepageTemplateDraft.name = first.name;
    homepageTemplateDraft.type = first.type;
    homepageTemplateDraft.html = first.html;
    homepageTemplateDraft.builtin = Boolean(first.builtin);
    homepageTemplateDraft.targetDeviceTypes = normalizeHomepageTargetDeviceTypes(first.targetDeviceTypes);
  }
}

function onSelectHomepageTemplate(id: string) {
  const row = homepageTemplates.value.find((item) => item.id === id);
  if (!row) return;
  homepageTemplateDraft.id = row.id;
  homepageTemplateDraft.name = row.name;
  homepageTemplateDraft.type = row.type;
  homepageTemplateDraft.html = row.html;
  homepageTemplateDraft.builtin = Boolean(row.builtin);
  homepageTemplateDraft.targetDeviceTypes = normalizeHomepageTargetDeviceTypes(row.targetDeviceTypes);
}

function defaultHomepageTemplateHtml() {
  const selected = findHomepageTemplateRow(getHomepageTemplateId());
  if (selected?.html) return String(selected.html);
  const builtin = homepageTemplates.value.find((item) => Boolean(item.builtin)) || homepageTemplates.value[0];
  if (builtin?.html) return String(builtin.html);
  return `<div data-x="120" data-y="120" data-size="120" data-weight="700">主页模板</div>`;
}

function newHomepageTemplate() {
  homepageTemplateDraft.id = "";
  homepageTemplateDraft.name = "";
  homepageTemplateDraft.type = "custom_html";
  homepageTemplateDraft.builtin = false;
  homepageTemplateDraft.html = defaultHomepageTemplateHtml();
  homepageTemplateDraft.targetDeviceTypes = [];
  scheduleHomepageEditPreview();
}

async function loadHomepageConfig() {
  if (!auth.token || !homepageDeviceId.value) return;
  const data = await apiRequest<any>(`/api/homepages/config?deviceId=${encodeURIComponent(homepageDeviceId.value)}`, { token: auth.token });
  applyHomepageConfigModel(data);
  await refreshHomepageAutoRenderStatusOnly();
  syncHomepageTemplateDraftFromConfig();
  Object.keys(homepageRenderMeta).forEach((k) => delete homepageRenderMeta[k]);
  Object.assign(homepageRenderMeta, data.image || {});
  await applyHomepagePreviewImage(data.image || {}, homepagePreviewUrl);
  scheduleHomepageEditPreview();
}

async function refreshHomepageAutoRenderStatusOnly() {
  if (!auth.token || !homepageDeviceId.value) return;
  try {
    const status = await apiRequest<any>(
      `/api/homepages/auto-render/status?deviceId=${encodeURIComponent(homepageDeviceId.value)}`,
      { token: auth.token }
    );
    const picked: Record<string, any> = {};
    const setIfPresent = (key: string, value: any) => {
      if (value === undefined || value === null) return;
      picked[key] = value;
    };
    setIfPresent("enabled", status?.enabled);
    setIfPresent("interval_enabled", status?.interval_enabled);
    setIfPresent("window_start_time", status?.window_start_time);
    setIfPresent("window_end_time", status?.window_end_time);
    setIfPresent("fixed_times", status?.fixed_times);
    // legacy fields
    setIfPresent("daily_start_time", status?.daily_start_time);
    setIfPresent("interval_minutes", status?.interval_minutes);
    setIfPresent("next_run_at", status?.next_run_at);
    setIfPresent("last_run_at", status?.last_run_at);
    setIfPresent("last_result", status?.last_result);
    setIfPresent("last_error", status?.last_error);
    setIfPresent("last_reason", status?.last_reason);
    setIfPresent("scheduler_decision", status?.scheduler_decision);
    setIfPresent("scheduler", status?.scheduler);
    homepageConfigModel.auto_render_push = {
      ...(homepageConfigModel.auto_render_push || {}),
      ...picked,
    };
    ensureHomepageAutoRenderPushShape(homepageConfigModel.auto_render_push);
    syncHomepageConfigJsonFromModel();
  } catch (_) {
    // ignore status fetch error
  }
}

async function loadHomepageAll() {
  await loadHomepageTemplates();
  await loadHomepageConfig();
}

async function saveHomepageConfig() {
  if (!homepageDeviceId.value) return ElMessage.error("请先选择设备");
  homepageConfigSaving.value = true;
  try {
    const patch = buildHomepageConfigPatch();
    await apiRequest("/api/homepages/config", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({
        deviceId: homepageDeviceId.value,
        config: patch,
      }),
    });
    ElMessage.success("主页配置已保存");
    await loadHomepageConfig();
  } catch (error) {
    ElMessage.error((error as Error).message || "保存主页配置失败");
  } finally {
    homepageConfigSaving.value = false;
  }
}

async function renderHomepage() {
  if (!homepageDeviceId.value) return ElMessage.error("请先选择设备");
  try {
    const patch = buildHomepageConfigPatch();
    const data = await apiRequest<any>("/api/homepages/render", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({
        deviceId: homepageDeviceId.value,
        config: patch,
        template: buildHomepageTemplatePatchForRender(),
      }),
    });
    Object.keys(homepageRenderMeta).forEach((k) => delete homepageRenderMeta[k]);
    Object.assign(homepageRenderMeta, data.image || {});
    await applyHomepagePreviewImage(data.image || {}, homepagePreviewUrl);
    await applyHomepagePreviewImage(data.image || {}, homepageEditPreviewUrl);
    ElMessage.success("主页渲染完成");
  } catch (error) {
    ElMessage.error((error as Error).message || "主页渲染失败");
  }
}

async function pushHomepage() {
  homepagePushLoading.value = true;
  try {
    const patch = buildHomepageConfigPatch();
    const deviceIds = resolveBatchTargetDevices("homepage");
    const clusterIds = [...homepageClusterIds.value];
    if (!deviceIds.length && !clusterIds.length && !homepageDeviceId.value) {
      return ElMessage.error("请先选择设备或设备池");
    }
    const body: Record<string, any> = { config: patch, template: buildHomepageTemplatePatchForRender() };
    if (deviceIds.length) body.deviceIds = deviceIds;
    if (clusterIds.length) body.clusterIds = clusterIds;
    if (!deviceIds.length && !clusterIds.length && homepageDeviceId.value) body.deviceId = homepageDeviceId.value;

    const result = await apiRequest<any>("/api/homepages/push", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify(body),
    });
    ElMessage.success(`主页推送：成功 ${result.successCount || 0}，失败 ${result.failedCount || 0}`);
    // Keep current in-editor template selection after push.
    // Push is render+dispatch and should not force template selector rollback.
    syncHomepageConfigJsonFromModel();
    scheduleHomepageEditPreview();
  } catch (error) {
    ElMessage.error((error as Error).message || "主页推送失败");
  } finally {
    homepagePushLoading.value = false;
  }
}

async function runHomepageAutoRenderNow() {
  if (!homepageDeviceId.value) return ElMessage.error("请先选择设备");
  homepageAutoRunLoading.value = true;
  try {
    const patch = buildHomepageConfigPatch();
    const result = await apiRequest<any>("/api/homepages/auto-render/run", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({
        deviceId: homepageDeviceId.value,
        config: patch,
        template: buildHomepageTemplatePatchForRender(),
      }),
    });
    const status = String(result?.status || "");
    if (status === "running") {
      ElMessage.warning("任务已在执行中，请稍后查看结果");
    } else if (status === "success") {
      ElMessage.success("自动渲染并下发执行成功");
    } else {
      ElMessage.success("自动任务已触发");
    }
    await refreshHomepageAutoRenderStatusOnly();
    syncHomepageConfigJsonFromModel();
    scheduleHomepageEditPreview();
  } catch (error) {
    ElMessage.error((error as Error).message || "自动任务执行失败");
  } finally {
    homepageAutoRunLoading.value = false;
  }
}

async function saveHomepageTemplate() {
  if (!homepageTemplateDraft.name.trim() || !homepageTemplateDraft.html.trim()) {
    return ElMessage.error("模板名称和 HTML 不能为空");
  }
  try {
    const row = await apiRequest<any>("/api/homepages/templates", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({
        id: homepageTemplateDraft.id || undefined,
        name: homepageTemplateDraft.name.trim(),
        type: homepageTemplateDraft.builtin ? "default_html" : "custom_html",
        html: homepageTemplateDraft.html,
        targetDeviceTypes: normalizeHomepageTargetDeviceTypes(homepageTemplateDraft.targetDeviceTypes),
      }),
    });
    homepageTemplateDraft.id = row.id;
    homepageTemplateDraft.builtin = Boolean(row.builtin);
    homepageTemplateDraft.targetDeviceTypes = normalizeHomepageTargetDeviceTypes(row.targetDeviceTypes);
    ElMessage.success("主页模板已保存");
    await loadHomepageTemplates();
    scheduleHomepageEditPreview();
  } catch (error) {
    ElMessage.error((error as Error).message || "保存主页模板失败");
  }
}

async function deleteHomepageTemplate() {
  if (!homepageTemplateDraft.id) return;
  try {
    await apiRequest(`/api/homepages/templates/${homepageTemplateDraft.id}/delete`, {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({}),
    });
    ElMessage.success("主页模板已删除");
    homepageTemplateDraft.id = "";
    homepageTemplateDraft.name = "";
    homepageTemplateDraft.type = "custom_html";
    homepageTemplateDraft.html = "";
    homepageTemplateDraft.builtin = false;
    homepageTemplateDraft.targetDeviceTypes = [];
    await loadHomepageTemplates();
    scheduleHomepageEditPreview();
  } catch (error) {
    ElMessage.error((error as Error).message || "删除主页模板失败");
  }
}

async function dispatchTodoBatch() {
  const deviceIds = resolveBatchTargetDevices("todo");
  const clusterIds = [...todoBatchClusterIds.value];
  if (!deviceIds.length && !clusterIds.length) return ElMessage.error("请先选择设备或设备池");
  const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/todos/batch-dispatch", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deviceIds,
      clusterIds,
      mode: todoBatchForm.mode,
      content: todoBatchForm.content,
      regexSource: todoBatchForm.regexSource,
      regexPattern: todoBatchForm.regexPattern,
      regexReplace: todoBatchForm.regexReplace,
      done: todoBatchForm.done,
      priority: todoBatchForm.priority,
      replace: todoBatchForm.replace,
    }),
  });
  ElMessage.success(`TODO批量下发：成功 ${data.successCount}，失败 ${data.failedCount}`);
}

async function loadScheduleRows() {
  if (!auth.token || !scheduleDeviceId.value) return;
  const rows = await apiRequest<any[]>(`/api/schedules?deviceId=${encodeURIComponent(scheduleDeviceId.value)}`, { token: auth.token });
  scheduleRows.value = rows.map((row) => ({
    id: row.id,
    mode: row.mode === "meeting" ? "meeting" : "course",
    weekday: Number(row.weekday || 1),
    orderIndex: Number(row.orderIndex || 1),
    title: row.title || row.courseName || "",
    content: row.content || row.note || "",
    startTime: row.startTime || "",
    endTime: row.endTime || "",
  }));
  scheduleDeletedIds.value = [];
}

function addScheduleRow() {
  scheduleRows.value.push({ mode: "course", weekday: 1, orderIndex: 1, title: "", content: "", startTime: "", endTime: "" });
}

function removeScheduleRow(index: number) {
  const row = scheduleRows.value[index];
  if (row?.id) scheduleDeletedIds.value.push(String(row.id));
  scheduleRows.value.splice(index, 1);
}

async function saveScheduleRows() {
  if (!scheduleDeviceId.value) return ElMessage.error("请选择设备");
  await apiRequest("/api/schedules/batch-upsert", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deviceId: scheduleDeviceId.value,
      rows: scheduleRows.value.map((row) => ({
        id: row.id,
        mode: row.mode,
        weekday: row.weekday,
        orderIndex: row.orderIndex,
        title: row.title,
        content: row.content,
        startTime: row.startTime,
        endTime: row.endTime,
      })),
      deletedIds: scheduleDeletedIds.value,
    }),
  });
  ElMessage.success("日程保存成功");
  await loadScheduleRows();
}

async function dispatchScheduleBatch() {
  const deviceIds = resolveBatchTargetDevices("schedule");
  const clusterIds = [...scheduleBatchClusterIds.value];
  if (!deviceIds.length && !clusterIds.length) return ElMessage.error("请先选择设备或设备池");
  const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/schedules/batch-dispatch", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      deviceIds,
      clusterIds,
      mode: scheduleBatchForm.mode,
      scheduleMode: scheduleBatchForm.scheduleMode,
      title: scheduleBatchForm.title,
      content: scheduleBatchForm.content,
      weekday: scheduleBatchForm.weekday,
      orderIndex: scheduleBatchForm.orderIndex,
      startTime: scheduleBatchForm.startTime,
      endTime: scheduleBatchForm.endTime,
      regexSource: scheduleBatchForm.regexSource,
      regexPattern: scheduleBatchForm.regexPattern,
      regexReplace: scheduleBatchForm.regexReplace,
      replace: scheduleBatchForm.replace,
    }),
  });
  ElMessage.success(`日程批量下发：成功 ${data.successCount}，失败 ${data.failedCount}`);
}

function shortRemark(text: string, max = 18) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}...`;
}

function deviceOptionLabel(device: { id: string; mac: string; displayName?: string; remark?: string; clusterNames?: string[] }) {
  const display = shortRemark(device.displayName || "", 18);
  const remark = shortRemark(device.remark || "", 16);
  const pools = (device.clusterNames || []).slice(0, 2).join("、");
  const left = display ? `${display} / ${device.id}` : device.id;
  const tail = [remark, pools].filter(Boolean).join("｜");
  return tail ? `${left} (${device.mac})｜${tail}` : `${left} (${device.mac})`;
}

function homepageDeviceTypeOf(device: any) {
  return String(device?.type || device?.deviceType || "").trim();
}

function homepageDeviceTypeLabel(type: string) {
  const value = String(type || "").trim();
  if (!value || value === "unknown") return "未标记类型";
  return homepageDeviceTypeLabelMap.value.get(value) || value;
}

function normalizeHomepageTargetDeviceTypes(input: unknown) {
  if (Array.isArray(input)) return [...new Set(input.map((item) => String(item || "").trim()).filter(Boolean))];
  if (typeof input === "string") {
    return [...new Set(input.split(",").map((item) => item.trim()).filter(Boolean))];
  }
  return [];
}

function homepageTemplateOptionLabel(tpl: HomepageTemplateRow) {
  const targets = normalizeHomepageTargetDeviceTypes(tpl.targetDeviceTypes);
  if (!targets.length) return `${tpl.name} · 通用型`;
  return `${tpl.name} · ${targets.map(homepageDeviceTypeLabel).join("、")}`;
}

function clusterDevicePreview(ids: string[]) {
  if (!Array.isArray(ids) || ids.length === 0) return "-";
  const map = new Map(deviceStore.devices.map((d) => [d.id, d]));
  const list = ids.slice(0, 4).map((id) => {
    const d = map.get(id);
    if (!d) return id;
    const remark = shortRemark(d.remark || "", 8);
    return remark ? `${d.id}(${remark})` : d.id;
  });
  if (ids.length > 4) list.push(`...+${ids.length - 4}`);
  return list.join("，");
}

let clustersLoadPromise: Promise<void> | null = null;

async function loadClusters() {
  if (!auth.token) return;
  if (clustersLoadPromise) return clustersLoadPromise;
  const token = auth.token;
  clustersLoadPromise = (async () => {
    clusters.value = await apiRequest<ClusterRow[]>("/api/clusters", { token });
  })();
  try {
    await clustersLoadPromise;
  } finally {
    clustersLoadPromise = null;
  }
}

function openClusterEditor(row: ClusterRow) {
  clusterForm.id = row.id;
  clusterForm.name = row.name || "";
  clusterForm.description = row.description || "";
  poolPickerSelection.value = Array.isArray(row.deviceIds) ? [...row.deviceIds] : [];
  clusterEditDialogOpen.value = true;
}

function resetClusterCreateForm() {
  clusterCreateForm.name = "";
  clusterCreateForm.description = "";
}

async function createCluster() {
  if (!clusterCreateForm.name.trim()) return ElMessage.error("请填写设备池名称");
  const row = await apiRequest<ClusterRow>("/api/clusters", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      name: clusterCreateForm.name.trim(),
      description: clusterCreateForm.description.trim(),
    }),
  });
  ElMessage.success("设备池已创建");
  resetClusterCreateForm();
  await loadClusters();
  openClusterEditor(row);
}

async function saveCluster() {
  if (!clusterForm.id) return ElMessage.error("请先选择设备池");
  if (!clusterForm.name.trim()) return ElMessage.error("请填写设备池名称");
  const payload = {
    name: clusterForm.name.trim(),
    description: clusterForm.description.trim(),
  };
  await apiRequest(`/api/clusters/${clusterForm.id}`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify(payload),
  });
  await apiRequest(`/api/clusters/${clusterForm.id}/devices`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ mode: "replace", deviceIds: [...poolPickerSelection.value] }),
  });
  ElMessage.success(`设备池已更新（${poolPickerSelection.value.length} 台设备）`);
  await loadClusters();
  clusterEditDialogOpen.value = false;
}

async function deleteCluster() {
  if (!clusterForm.id) return;
  await apiRequest(`/api/clusters/${clusterForm.id}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({}),
  });
  ElMessage.success("设备池已删除");
  clusterForm.id = "";
  clusterForm.name = "";
  clusterForm.description = "";
  clearPoolPickerSelection();
  clusterEditDialogOpen.value = false;
  await loadClusters();
}

function resolveRemoteTargets() {
  const deviceIds = resolveBatchTargetDevices("remote");
  const clusterIds = [...remoteClusterIds.value];
  if (!deviceIds.length && !clusterIds.length) {
    throw new Error("请先选择目标设备或设备池");
  }
  return { deviceIds, clusterIds };
}

async function switchView() {
  try {
    const target = resolveRemoteTargets();
    const body = {
      ...target,
      view: remoteForm.view,
      saveToTf: true,
      setAsDefault: remoteForm.setAsDefault,
    };
    const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/remote/switch-view", { method: "POST", token: auth.token, body: JSON.stringify(body) });
    ElMessage.success(`已下发：成功 ${data.successCount}，失败 ${data.failedCount}`);
  } catch (error) {
    ElMessage.error((error as Error).message || "下发失败");
  }
}

async function showText() {
  try {
    const target = resolveRemoteTargets();
    const body = {
      ...target,
      text: remoteForm.text,
      announcementMode: remoteForm.announcementMode,
      durationValue: remoteForm.durationValue,
      durationUnit: remoteForm.durationUnit,
      hideInViews: ["nameplate", "cast"],
      saveToTf: true,
    };
    const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/remote/show-text", { method: "POST", token: auth.token, body: JSON.stringify(body) });
    ElMessage.success(`已下发：成功 ${data.successCount}，失败 ${data.failedCount}`);
  } catch (error) {
    ElMessage.error((error as Error).message || "下发失败");
  }
}

function onImageChange(event: Event) {
  const input = event.target as HTMLInputElement;
  imageFile.value = input.files?.[0] || null;
  if (imagePreviewUrl.value) {
    URL.revokeObjectURL(imagePreviewUrl.value);
    imagePreviewUrl.value = "";
  }
  if (imageFile.value) {
    imagePreviewUrl.value = URL.createObjectURL(imageFile.value);
  }
}

function openImagePreviewDialog() {
  if (!imageFile.value) return ElMessage.error("请先选择图片");
  imagePreviewDialogOpen.value = true;
}

async function showImage() {
  if (!imageFile.value) return ElMessage.error("请先选择图片");
  try {
    const target = resolveRemoteTargets();
    const fd = new FormData();
    fd.append("file", imageFile.value);
    fd.append("deviceIds", JSON.stringify(target.deviceIds));
    fd.append("clusterIds", JSON.stringify(target.clusterIds));
    fd.append("saveToTf", "true");
    const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/remote/show-image", { method: "POST", token: auth.token, body: fd });
    ElMessage.success(`图片下发：成功 ${data.successCount}，失败 ${data.failedCount}`);
  } catch (error) {
    ElMessage.error((error as Error).message || "图片下发失败");
  }
}

async function castStop() {
  try {
    const target = resolveRemoteTargets();
    const body = { ...target, reason: "ended" };
    const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/remote/cast-stop", { method: "POST", token: auth.token, body: JSON.stringify(body) });
    ElMessage.success(`停止投屏：成功 ${data.successCount}，失败 ${data.failedCount}`);
  } catch (error) {
    ElMessage.error((error as Error).message || "停止失败");
  }
}

function resetTemplateDraft() {
  templateDraft.id = "";
  templateDraft.name = "";
  templateDraft.slug = "";
  templateDraft.method = "GET";
  templateDraft.url = "";
  templateDraft.keyField = "key";
  templateDraft.keyIn = ["query"];
  templateDraft.deviceKeyRequired = true;
  templateDraft.enabled = true;
  templateDraft.userInputFields = [];
  templateDraft.advancedConfig = { output: "", timeoutMs: 8000, steps: [] };
  templateDraft.refreshConfig = buildDefaultTemplateRefreshConfig("");
  Object.keys(templateParamValues).forEach((k) => delete templateParamValues[k]);
  templateDeviceKey.value = "";
  templateResultText.value = "";
}

function normalizeTemplateAdvancedConfig(input?: any): TemplateAdvancedConfig {
  const source = input && typeof input === "object" ? input : {};
  const steps = Array.isArray(source.steps) ? source.steps : [];
  return {
    output: String(source.output || ""),
    timeoutMs: Number.isFinite(Number(source.timeoutMs)) ? Number(source.timeoutMs) : 8000,
    steps: steps.map((step: any) => ({
      name: String(step?.name || ""),
      method: String(step?.method || "GET").toUpperCase(),
      url: String(step?.url || ""),
      legacyCompat: Boolean(step?.legacyCompat),
      passInputParams: Boolean(step?.passInputParams),
      headers: Array.isArray(step?.headers)
        ? step.headers.map((item: any) => ({ key: String(item?.key || ""), value: String(item?.value || "") }))
        : [],
      params: Array.isArray(step?.params)
        ? step.params.map((item: any) => ({ key: String(item?.key || ""), value: String(item?.value || "") }))
        : [],
      body: Array.isArray(step?.body)
        ? step.body.map((item: any) => ({ key: String(item?.key || ""), value: String(item?.value || "") }))
        : [],
      extract: Array.isArray(step?.extract)
        ? step.extract.map((item: any) => ({
            type: String(item?.type || "regex"),
            source: String(item?.source || "body"),
            pattern: String(item?.pattern || ""),
            path: String(item?.path || ""),
            saveAs: String(item?.saveAs || ""),
            group: String(item?.group || "1"),
            flags: String(item?.flags || ""),
          }))
        : [],
    })),
  };
}

function defaultTemplateRefreshModeForSlug(slug: string): TemplateRefreshMode {
  return String(slug || "").trim() === "xique_schedule" ? "manual" : "interval";
}

function buildDefaultTemplateRefreshConfig(slug = ""): TemplateRefreshConfig {
  return {
    mode: defaultTemplateRefreshModeForSlug(slug),
    enabled: true,
    intervalMinutes: 10,
    ttlSeconds: 300,
    minRequestGapSeconds: 30,
    timeoutMs: 8000,
    fallbackToStale: true,
    jitterSeconds: 15,
  };
}

function normalizeTemplateRefreshConfig(input?: any, slug = ""): TemplateRefreshConfig {
  const defaults = buildDefaultTemplateRefreshConfig(slug);
  const safe = input && typeof input === "object" ? input : {};
  const modeRaw = String(safe.mode || defaults.mode || "interval").trim() as TemplateRefreshMode;
  const mode: TemplateRefreshMode = ["manual", "interval", "on_request", "stale_while_revalidate"].includes(modeRaw)
    ? modeRaw
    : defaults.mode;
  const intVal = (value: any, fallback: number, min: number, max: number) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const v = Math.floor(n);
    return Math.max(min, Math.min(max, v));
  };
  return {
    mode,
    enabled: safe.enabled === undefined ? defaults.enabled : Boolean(safe.enabled),
    intervalMinutes: intVal(safe.intervalMinutes, defaults.intervalMinutes, 1, 1440),
    ttlSeconds: intVal(safe.ttlSeconds, defaults.ttlSeconds, 30, 86400),
    minRequestGapSeconds: intVal(safe.minRequestGapSeconds, defaults.minRequestGapSeconds, 0, 86400),
    timeoutMs: intVal(safe.timeoutMs, defaults.timeoutMs, 500, 120000),
    fallbackToStale: safe.fallbackToStale === undefined ? defaults.fallbackToStale : Boolean(safe.fallbackToStale),
    jitterSeconds: intVal(safe.jitterSeconds, defaults.jitterSeconds, 0, 3600),
  };
}

function openTemplateAdvancedEditor() {
  templateDraft.advancedConfig = normalizeTemplateAdvancedConfig(templateDraft.advancedConfig);
  templateAdvancedDialogVisible.value = true;
}

function saveTemplateAdvancedConfig(config: TemplateAdvancedConfig) {
  templateDraft.advancedConfig = normalizeTemplateAdvancedConfig(config);
}

function resetXiqueTemplateState() {
  xiqueStatusSummary.value = "";
  xiqueKnownAccounts.value = [];
  xiqueSelectedAccount.value = "";
  xiqueAccountMode.value = "existing";
  xiqueCaptchaImage.value = "";
  xiqueCaptchaSession.value = "";
  xiqueCaptchaExpiresAt.value = "";
  templateParamValues.autoOcrEnabled = "1";
}

function applyXiqueAccountSelection() {
  const username = String(xiqueSelectedAccount.value || "").trim();
  if (!username) return;
  templateParamValues.loginUsername = username;
  templateParamValues.username = username;
}

async function refreshXiqueTemplateStatus() {
  if (!auth.token || !templateDeviceId.value || !isXiqueTemplate.value) return;
  xiqueStatusLoading.value = true;
  try {
    const data = await apiRequest<any>(`/api/schedules/xique/status?deviceId=${encodeURIComponent(templateDeviceId.value)}`, {
      token: auth.token,
    });
    const cfg = data?.config || {};
    const session = data?.session || {};
    const username = String(cfg.loginUsername || "").trim();
    const hasCredentialUsable = Boolean(session?.hasCredentialUsable);
    const options = username ? [{ value: username, label: `${username}（已登录）` }] : [];
    xiqueKnownAccounts.value = options;
    if (options.length > 0) {
      if (!xiqueSelectedAccount.value || !options.some((item) => item.value === xiqueSelectedAccount.value)) {
        xiqueSelectedAccount.value = options[0].value;
      }
      if (xiqueAccountMode.value !== "new") {
        xiqueAccountMode.value = "existing";
        applyXiqueAccountSelection();
      }
    } else {
      xiqueAccountMode.value = "new";
    }
    if (!templateParamValues.currentTermKey) {
      templateParamValues.currentTermKey = String(cfg.currentTermKey || "");
    }
    if (!templateParamValues.baseUrl) {
      templateParamValues.baseUrl = String(cfg.baseUrl || "");
    }
    if (!String(templateParamValues.autoOcrEnabled || "").trim()) {
      templateParamValues.autoOcrEnabled = "1";
    }
    xiqueCaptchaImage.value = String(data?.session?.captchaImage || "");
    xiqueCaptchaSession.value = String(data?.session?.captchaSession || "");
    xiqueCaptchaExpiresAt.value = String(data?.session?.captchaExpiresAt || "");
    if (xiqueCaptchaSession.value) {
      templateParamValues.captchaSession = xiqueCaptchaSession.value;
    }
    if (username && !hasCredentialUsable) {
      xiqueStatusSummary.value = "已登录账号凭证不可用，请切换“登录新账号”重新验证";
      xiqueAccountMode.value = "new";
    } else if (Boolean(cfg.needCaptchaReverify)) {
      xiqueStatusSummary.value = "登录态失效，需要重新验证";
    } else if (username) {
      xiqueStatusSummary.value = "已检测到可复用登录态";
    } else {
      xiqueStatusSummary.value = "未检测到已登录账号";
    }
  } catch (error) {
    xiqueKnownAccounts.value = [];
    xiqueStatusSummary.value = (error as Error).message || "状态读取失败";
  } finally {
    xiqueStatusLoading.value = false;
  }
}

async function refreshXiqueTemplateCaptcha() {
  if (!auth.token || !templateDeviceId.value || !isXiqueTemplate.value) return;
  if (xiqueTemplateAutoOcrEnabled.value) {
    xiqueStatusSummary.value = "已开启自动识别验证码，无需手动刷新验证码。";
    return;
  }
  xiqueStatusLoading.value = true;
  try {
    const payload: Record<string, any> = {
      deviceId: templateDeviceId.value,
      adapterMode: "remote",
      requireCaptcha: true,
      forceCaptcha: true,
      loginUsername: String(templateParamValues.loginUsername || templateParamValues.username || "").trim(),
      currentTermKey: String(templateParamValues.currentTermKey || "").trim(),
    };
    const data = await apiRequest<any>("/api/schedules/xique/init-login", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify(payload),
    });
    xiqueCaptchaImage.value = String(data?.captchaImage || "");
    xiqueCaptchaSession.value = String(data?.captchaSession || "");
    xiqueCaptchaExpiresAt.value = String(data?.captchaExpiresAt || "");
    templateParamValues.captchaSession = xiqueCaptchaSession.value;
    ElMessage.success("验证码已刷新");
  } catch (error) {
    ElMessage.error((error as Error).message || "刷新验证码失败");
  } finally {
    xiqueStatusLoading.value = false;
  }
}

async function handleXiqueTemplateCaptchaInputFocus() {
  if (xiqueTemplateAutoOcrEnabled.value) return;
  const now = Date.now();
  if (now - xiqueTemplateCaptchaFocusAt.value < 800) return;
  xiqueTemplateCaptchaFocusAt.value = now;
  await refreshXiqueTemplateCaptcha();
}

async function loginXiqueTemplate() {
  if (!auth.token || !templateDeviceId.value || !isXiqueTemplate.value) return;
  xiqueStatusLoading.value = true;
  try {
    const username = String(templateParamValues.loginUsername || templateParamValues.username || "").trim();
    const autoOcrEnabled = xiqueTemplateAutoOcrEnabled.value;
    const captchaAnswer = String(templateParamValues.captchaAnswer || "").trim();
    const payload: Record<string, any> = {
      deviceId: templateDeviceId.value,
      adapterMode: "remote",
      requireCaptcha: !autoOcrEnabled,
      forceCaptcha: !autoOcrEnabled && !captchaAnswer,
      autoOcrEnabled,
      loginUsername: username,
      currentTermKey: String(templateParamValues.currentTermKey || "").trim(),
      captchaAnswer,
      captchaSession: String(templateParamValues.captchaSession || xiqueCaptchaSession.value || "").trim(),
    };
    if (xiqueAccountMode.value === "new") {
      payload.password = String(templateParamValues.password || "").trim();
    }
    const data = await apiRequest<any>("/api/schedules/xique/init-login", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify(payload),
      timeoutMs: 120000,
    });
    xiqueCaptchaImage.value = String(data?.captchaImage || "");
    xiqueCaptchaSession.value = String(data?.captchaSession || "");
    xiqueCaptchaExpiresAt.value = String(data?.captchaExpiresAt || "");
    templateParamValues.captchaSession = xiqueCaptchaSession.value;
    if (Boolean(data?.captchaRequired)) {
      if (autoOcrEnabled) {
        xiqueStatusSummary.value = "自动识别未完成，需切换手动验证码模式";
        ElMessage.warning("自动识别失败，请关闭“自动识别验证码”后手动输入验证码");
      } else {
        xiqueStatusSummary.value = "需要验证码，已更新验证码图片";
        ElMessage.warning("请填写验证码后再次点“登录验证”");
      }
    } else {
      xiqueStatusSummary.value = "登录验证成功";
      templateParamValues.captchaAnswer = "";
      ElMessage.success("喜鹊登录验证成功");
      await refreshXiqueTemplateStatus();
    }
  } catch (error) {
    xiqueStatusSummary.value = (error as Error).message || "登录验证失败";
    ElMessage.error(xiqueStatusSummary.value);
  } finally {
    xiqueStatusLoading.value = false;
  }
}

async function loadTemplateRows() {
  templateRows.value = await apiRequest<TemplateRow[]>("/api/templates", { token: auth.token });
  if (!templateDraft.id && templateRows.value.length) {
    const homepageTemplateId = String(homepageConfigModel?.template?.template_id || "").trim();
    const preferred = templateRows.value.find((item) => item.id === homepageTemplateId) || templateRows.value[0];
    if (preferred) {
      pickTemplateRow(preferred);
    }
  }
}

function pickTemplateRow(row: TemplateRow) {
  templateDraft.id = row.id;
  templateDraft.name = row.name || "";
  templateDraft.slug = row.slug || "";
  templateDraft.method = row.method || "GET";
  templateDraft.url = row.url || "";
  templateDraft.keyField = row.keyField || "key";
  templateDraft.keyIn = Array.isArray(row.keyIn) && row.keyIn.length ? [...row.keyIn] : ["query"];
  templateDraft.deviceKeyRequired = Boolean(row.deviceKeyRequired);
  templateDraft.enabled = Boolean(row.enabled);
  templateDraft.userInputFields = Array.isArray(row.userInputFields) ? row.userInputFields.map((f) => ({ name: String(f.name || ""), placeholder: String(f.placeholder || "") })) : [];
  templateDraft.advancedConfig = normalizeTemplateAdvancedConfig(row.advancedConfig);
  templateDraft.refreshConfig = normalizeTemplateRefreshConfig(row.refreshConfig, row.slug);
  Object.keys(templateParamValues).forEach((k) => delete templateParamValues[k]);
  templateDraft.userInputFields.forEach((f) => {
    if (!templateParamValues[f.name]) templateParamValues[f.name] = "";
  });
  if (String(row.slug || "").trim() === "xique_schedule" && !String(templateParamValues.autoOcrEnabled || "").trim()) {
    templateParamValues.autoOcrEnabled = "1";
  }
  loadTemplateDeviceState();
}

function addTemplateInputField() {
  templateDraft.userInputFields.push({ name: "", placeholder: "" });
}

function removeTemplateInputField(index: number) {
  const row = templateDraft.userInputFields[index];
  if (row?.name && templateParamValues[row.name] !== undefined) {
    delete templateParamValues[row.name];
  }
  templateDraft.userInputFields.splice(index, 1);
}

async function saveTemplateDraft() {
  if (!isAdmin.value) return ElMessage.error("仅管理员可编辑模板");
  if (!templateDraft.name.trim() || !templateDraft.slug.trim()) {
    return ElMessage.error("请填写模板名称和slug");
  }
  const payload = {
    name: templateDraft.name.trim(),
    slug: templateDraft.slug.trim(),
    method: templateDraft.method,
    url: templateDraft.url.trim(),
    keyField: templateDraft.keyField.trim(),
    keyIn: templateDraft.keyIn,
    userInputFields: templateDraft.userInputFields
      .map((f) => ({ name: String(f.name || "").trim(), placeholder: String(f.placeholder || "").trim() }))
      .filter((f) => f.name),
    deviceKeyRequired: templateDraft.deviceKeyRequired,
    enabled: templateDraft.enabled,
    advancedConfig: normalizeTemplateAdvancedConfig(templateDraft.advancedConfig),
    refreshConfig: normalizeTemplateRefreshConfig(templateDraft.refreshConfig, templateDraft.slug),
  };
  if (templateDraft.id) {
    await apiRequest(`/api/templates/${templateDraft.id}`, {
      method: "POST",
      token: auth.token,
      body: JSON.stringify(payload),
    });
  } else {
    await apiRequest("/api/templates", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify(payload),
    });
  }
  ElMessage.success("模板已保存");
  await loadTemplateRows();
}

async function deleteTemplateDraft() {
  if (!isAdmin.value || !templateDraft.id) return;
  await apiRequest(`/api/templates/${templateDraft.id}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({}),
  });
  ElMessage.success("模板已删除");
  resetTemplateDraft();
  await loadTemplateRows();
}

async function loadTemplateDeviceState() {
  if (!templateDeviceId.value || !templateDraft.slug) {
    resetXiqueTemplateState();
    return;
  }
  const [keys, params] = await Promise.all([
    apiRequest<Record<string, string>>(`/api/templates/device/${templateDeviceId.value}/keys`, { token: auth.token }),
    apiRequest<Record<string, any>>(`/api/devices/${templateDeviceId.value}/third-params?slug=${encodeURIComponent(templateDraft.slug)}`, { token: auth.token }),
  ]);
  templateDeviceKey.value = String(keys[templateDraft.slug] || "");
  Object.keys(templateParamValues).forEach((k) => delete templateParamValues[k]);
  templateDraft.userInputFields.forEach((field) => {
    const key = String(field.name || "").trim();
    if (!key) return;
    const value = params && params[key] !== undefined ? params[key] : "";
    templateParamValues[key] = value === null || value === undefined ? "" : String(value);
  });
  if (isWeatherTemplate.value) {
    const city = String(params?.cityId || params?.location || templateParamValues.cityId || "101010100").trim();
    templateParamValues.cityId = city;
  }
  if (isXiqueTemplate.value) {
    if (String(params?.loginUsername || params?.username || "").trim()) {
      templateParamValues.loginUsername = String(params?.loginUsername || params?.username || "").trim();
      templateParamValues.username = String(params?.loginUsername || params?.username || "").trim();
      xiqueAccountMode.value = "existing";
      xiqueSelectedAccount.value = templateParamValues.loginUsername;
    } else {
      xiqueAccountMode.value = "new";
    }
    await refreshXiqueTemplateStatus();
  } else {
    resetXiqueTemplateState();
  }
}

async function saveTemplateDeviceKey() {
  if (!templateDeviceId.value || !templateDraft.slug) return ElMessage.error("请先选择模板和设备");
  await apiRequest(`/api/templates/device/${templateDeviceId.value}/keys`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ keys: { [templateDraft.slug]: templateDeviceKey.value.trim() } }),
  });
  ElMessage.success("设备Key已保存");
}

function buildTemplateParamsPayload() {
  const payload: Record<string, string> = {};
  templateDraft.userInputFields.forEach((field) => {
    const key = String(field.name || "").trim();
    if (!key) return;
    payload[key] = String(templateParamValues[key] || "").trim();
  });
  if (isWeatherTemplate.value) {
    const city = String(templateParamValues.cityId || payload.cityId || payload.location || "").trim();
    if (city) {
      payload.cityId = city;
      payload.location = city;
    }
  }
  if (isXiqueTemplate.value) {
    if (xiqueAccountMode.value === "existing") {
      const username = String(xiqueSelectedAccount.value || templateParamValues.loginUsername || "").trim();
      if (username) {
        payload.loginUsername = username;
        payload.username = username;
      }
      delete payload.password;
    } else {
      const username = String(templateParamValues.loginUsername || templateParamValues.username || "").trim();
      if (username) {
        payload.loginUsername = username;
        payload.username = username;
      }
      const password = String(templateParamValues.password || "").trim();
      if (password) payload.password = password;
    }
    const captcha = String(templateParamValues.captchaAnswer || "").trim();
    if (captcha) payload.captchaAnswer = captcha;
    const autoOcrRaw = String(templateParamValues.autoOcrEnabled || "1").trim().toLowerCase();
    payload.autoOcrEnabled = ["0", "false", "off", "no"].includes(autoOcrRaw) ? "false" : "true";
    const captchaSession = String(templateParamValues.captchaSession || xiqueCaptchaSession.value || "").trim();
    if (captchaSession) {
      payload.captchaSession = captchaSession;
      payload.sessionId = captchaSession;
    }
    const term = String(templateParamValues.currentTermKey || templateParamValues.termKey || "").trim();
    if (term) {
      payload.currentTermKey = term;
      payload.termKey = term;
    }
    if (!String(payload.adapterMode || "").trim()) {
      payload.adapterMode = "remote";
    }
  }
  return payload;
}

async function saveTemplateParams() {
  if (!templateDraft.slug) return ElMessage.error("请先选择模板");
  const deviceIds = resolveBatchTargetDevices("templates");
  const clusterIds = [...templateBatchClusterIds.value];
  if (!deviceIds.length && !clusterIds.length) return ElMessage.error("请先选择参数下发设备或设备池");
  const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/devices/batch/third-params", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ deviceIds, clusterIds, slug: templateDraft.slug, params: buildTemplateParamsPayload() }),
  });
  ElMessage.success(`参数已下发：成功 ${data.successCount}，失败 ${data.failedCount}`);
}

async function testTemplateApi() {
  if (!templateDeviceId.value || !templateDraft.slug) return ElMessage.error("请先选择模板和设备");
  const data = await apiRequest<any>(`/api/third/${templateDraft.slug}`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ deviceId: templateDeviceId.value, params: buildTemplateParamsPayload() }),
  });
  if (isXiqueTemplate.value) {
    xiqueCaptchaImage.value = String(data?.formatted?.captchaImage || data?.captchaImage || "");
    xiqueCaptchaSession.value = String(data?.formatted?.captchaSession || data?.captchaSession || "");
    xiqueCaptchaExpiresAt.value = String(data?.formatted?.captchaExpiresAt || data?.captchaExpiresAt || "");
    if (xiqueCaptchaSession.value) {
      templateParamValues.captchaSession = xiqueCaptchaSession.value;
    }
    if (Boolean(data?.formatted?.needRelogin || data?.needRelogin)) {
      ElMessage.warning("已登录账号凭证不可用，请切换“登录新账号”并重新验证");
      xiqueAccountMode.value = "new";
    }
    if (String(data?.formatted?.status || data?.status || "").trim() === "need_manual_captcha") {
      const attempts = Number(data?.formatted?.ocrAttempts || data?.ocrAttempts || data?.formatted?.ocrFailCount || 0);
      if (attempts > 0) {
        ElMessage.warning(`自动识别已尝试 ${attempts} 次，现请手动输入验证码后再次调用`);
      } else {
        ElMessage.warning("当前需要手动输入验证码后再次调用");
      }
    }
  }
  templateResultText.value = JSON.stringify(data, null, 2);
}

function onFirmwareFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  firmwareFile.value = input.files?.[0] || null;
}

function onFullFirmwareFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  fullFirmwareFile.value = input.files?.[0] || null;
}

async function loadFirmwareRows() {
  firmwareRows.value = await apiRequest<FirmwareRow[]>("/api/firmware", { token: auth.token });
}

async function loadFullFirmwareBundles() {
  fullFirmwareBundles.value = await apiRequest<any[]>("/api/firmware/full-bundles", { token: auth.token });
}

async function uploadFirmware() {
  if (!isAdmin.value) return ElMessage.error("仅管理员可上传固件");
  if (!firmwareForm.version.trim() || !firmwareFile.value) {
    return ElMessage.error("请填写版本并选择固件文件");
  }
  const fd = new FormData();
  fd.append("version", firmwareForm.version.trim());
  fd.append("deviceType", firmwareForm.deviceType.trim() || "ink-screen");
  fd.append("releaseNote", firmwareForm.releaseNote.trim());
  fd.append("file", firmwareFile.value);
  await apiRequest("/api/firmware/upload", {
    method: "POST",
    token: auth.token,
    body: fd,
  });
  ElMessage.success("固件上传成功");
  firmwareFile.value = null;
  await loadFirmwareRows();
}

async function uploadFullFirmwareBundle() {
  if (!isAdmin.value) return ElMessage.error("仅管理员可上传完整固件包");
  if (!fullFirmwareFile.value) return ElMessage.error("请先选择完整固件ZIP包");
  const fd = new FormData();
  fd.append("file", fullFirmwareFile.value);
  const row = await apiRequest<any>("/api/firmware/full/upload", {
    method: "POST",
    token: auth.token,
    body: fd,
    timeoutMs: 120000,
  });
  ElMessage.success(`完整固件包已校验：${row.version}`);
  fullFirmwareFile.value = null;
  await loadFullFirmwareBundles();
}

async function openFullFirmwareManifest(row: Record<string, any>) {
  const manifest = row?.id
    ? await apiRequest<any>(`/api/firmware/full/${encodeURIComponent(row.id)}/manifest`, { token: auth.token })
    : row?.manifest || {};
  ElMessage({
    type: "success",
    message: `manifest 已加载：${manifest.version || row.version || "-"}`,
  });
  console.info("[full-firmware-manifest]", manifest);
}

function downloadFullFirmwareBundle(row: Record<string, any>) {
  if (!row?.id) return;
  window.open(`/api/firmware/full/${encodeURIComponent(row.id)}/download?token=${encodeURIComponent(auth.token)}`, "_blank");
}

async function deleteFirmwareRow(id: string) {
  if (!isAdmin.value) return;
  await apiRequest(`/api/firmware/${id}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({}),
  });
  ElMessage.success("固件已删除");
  await loadFirmwareRows();
}

async function loadUpgradeJobs() {
  upgradeRows.value = await apiRequest<any[]>("/api/firmware/upgrades", { token: auth.token });
}

async function batchUpgradeLatest() {
  const deviceIds = resolveBatchTargetDevices("firmware");
  if (!deviceIds.length) return ElMessage.error("请先选择目标设备");
  const data = await apiRequest<{ success: any[]; failed: any[] }>("/api/firmware/batch-upgrade", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ deviceIds }),
  });
  ElMessage.success(`批量升级下发完成：成功 ${(data.success || []).length}，失败 ${(data.failed || []).length}`);
  await loadUpgradeJobs();
}

function onTfFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  tfUploadFile.value = input.files?.[0] || null;
}

async function loadTfRows() {
  const params = new URLSearchParams();
  if (tfQuery.category) params.set("category", tfQuery.category);
  if (tfQuery.deviceId) params.set("deviceId", tfQuery.deviceId);
  tfRows.value = await apiRequest<any[]>(`/api/tf${params.toString() ? `?${params.toString()}` : ""}`, { token: auth.token });
  if (selectedTfFile.value) {
    const matched = tfRows.value.find((item) => item.id === selectedTfFile.value?.id);
    selectedTfFile.value = matched || null;
  }
}

function pickTfRow(row: Record<string, any>) {
  selectedTfFile.value = row || null;
}

async function uploadTfFile() {
  if (!tfUploadFile.value) return ElMessage.error("请先选择文件");
  const fd = new FormData();
  fd.append("category", tfUpload.category);
  fd.append("file", tfUploadFile.value);
  await apiRequest("/api/tf/upload", {
    method: "POST",
    token: auth.token,
    body: fd,
  });
  ElMessage.success("文件已上传");
  tfUploadFile.value = null;
  await loadTfRows();
}

async function deleteTfFile(id: string) {
  await apiRequest(`/api/tf/${id}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({}),
  });
  ElMessage.success("文件已删除");
  await loadTfRows();
}

async function dispatchTfSelectedFile() {
  if (!selectedTfFile.value?.id) return ElMessage.error("请先在云端文件表中选中一条文件");
  const deviceIds = resolveBatchTargetDevices("tf");
  const clusterIds = [...tfBatchClusterIds.value];
  if (!deviceIds.length && !clusterIds.length) return ElMessage.error("请先选择目标设备或设备池");
  const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/tf/dispatch", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      fileIds: [selectedTfFile.value.id],
      deviceIds,
      clusterIds,
    }),
  });
  ElMessage.success(`文件下发通知：成功 ${data.successCount}，失败 ${data.failedCount}`);
}

function downloadTfFile(id: string) {
  window.open(`/api/tf/${id}/download`, "_blank");
}

async function loadTfLocalRows() {
  if (!tfQuery.deviceId) {
    tfLocalRows.value = [];
    return;
  }
  const data = await apiRequest<{ files: any[] }>(`/api/tf/device?deviceId=${encodeURIComponent(tfQuery.deviceId)}`, { token: auth.token });
  tfLocalRows.value = Array.isArray(data.files) ? data.files : [];
}

async function deleteTfLocalFile(row: { name: string; category: string }) {
  if (!tfQuery.deviceId) return;
  await apiRequest(`/api/tf/device/${encodeURIComponent(tfQuery.deviceId)}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ name: row.name, category: row.category }),
  });
  ElMessage.success("本地文件删除指令已下发");
  await loadTfLocalRows();
}

async function loadOperationLogs() {
  operationLogs.value = await apiRequest<any[]>("/api/logs/operations", { token: auth.token });
}

async function loadApiLogs() {
  apiLogs.value = await apiRequest<any[]>("/api/logs/apis", { token: auth.token });
}

function formatBytes(value: number) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

async function runLogCleanup(mode: "all" | "range") {
  if (!isAdmin.value) return;
  if (!logCleanupForm.includeOperationLogs && !logCleanupForm.includeApiLogs && !logCleanupForm.includeFiles) {
    ElMessage.warning("请至少选择一个清理项");
    return;
  }

  let startAt = "";
  let endAt = "";
  if (mode === "range") {
    if (!Array.isArray(logCleanupForm.range) || logCleanupForm.range.length !== 2) {
      ElMessage.warning("请先选择时间段");
      return;
    }
    startAt = logCleanupForm.range[0].toISOString();
    endAt = logCleanupForm.range[1].toISOString();
  }

  const confirmText =
    mode === "all"
      ? `确认${logCleanupForm.dryRun ? "预览" : "执行"}全部清理？`
      : `确认${logCleanupForm.dryRun ? "预览" : "执行"}所选时间段清理？`;
  if (!window.confirm(confirmText)) return;

  logCleanupLoading.value = true;
  try {
    const result = await apiRequest<any>("/api/logs/cleanup", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({
        mode,
        startAt,
        endAt,
        includeOperationLogs: logCleanupForm.includeOperationLogs,
        includeApiLogs: logCleanupForm.includeApiLogs,
        includeFiles: logCleanupForm.includeFiles,
        dryRun: logCleanupForm.dryRun,
      }),
    });

    const db = result?.db || {};
    const files = result?.files || {};
    logCleanupSummary.value =
      `DB: 操作日志删除 ${db.operationRemoved || 0}，API日志删除 ${db.apiRemoved || 0}；` +
      ` 文件: 扫描 ${files.scanned || 0}，选中 ${files.selected || 0}，删除 ${files.removed || 0}，` +
      `释放 ${formatBytes(files.removedBytes || 0)}${(files.failed || 0) > 0 ? `，失败 ${files.failed}` : ""}`;

    if (!logCleanupForm.dryRun) {
      if (logCleanupForm.includeOperationLogs) await loadOperationLogs();
      if (logCleanupForm.includeApiLogs) await loadApiLogs();
      ElMessage.success("清理完成");
    } else {
      ElMessage.success("清理预览完成");
    }
  } catch (error: any) {
    ElMessage.error(error?.message || "清理失败");
  } finally {
    logCleanupLoading.value = false;
  }
}

async function loadLayouts() {
  layouts.value = await apiRequest<LayoutRow[]>("/api/nameplates/layouts", { token: auth.token });
}

async function loadHistory() {
  history.value = await apiRequest<NameplateHistoryRow[]>("/api/nameplates/history", { token: auth.token });
}

async function deleteHistory(id: string) {
  if (!id) return;
  await apiRequest(`/api/nameplates/history/${id}/delete`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({}),
  });
  ElMessage.success("历史记录已删除");
  await loadHistory();
}

function pickLayout(row: LayoutRow) {
  layoutForm.id = row.id;
  layoutForm.layoutName = row.layoutName;
  layoutForm.deviceType = row.deviceType;
  layoutForm.fontFamily = row.fontFamily || "Microsoft YaHei";
  layoutForm.nameFontSize = row.nameFontSize;
  layoutForm.nameOffsetX = row.nameOffsetX || 0;
  layoutForm.nameOffsetY = row.nameOffsetY || 0;
  layoutForm.titleFontSize = row.titleFontSize;
  layoutForm.titleOffsetX = row.titleOffsetX || 0;
  layoutForm.titleOffsetY = row.titleOffsetY || 0;
  layoutForm.align = row.align;
  layoutForm.margin = row.margin;
  singleForm.layoutId = row.id;
}

function resetLayoutForm() {
  layoutForm.id = "";
  layoutForm.layoutName = "默认桌牌";
  layoutForm.deviceType = "ink-screen";
  layoutForm.fontFamily = "Microsoft YaHei";
  layoutForm.nameFontSize = 180;
  layoutForm.nameOffsetX = 0;
  layoutForm.nameOffsetY = 0;
  layoutForm.titleFontSize = 76;
  layoutForm.titleOffsetX = 0;
  layoutForm.titleOffsetY = 88;
  layoutForm.align = "center";
  layoutForm.margin = 40;
}

async function saveLayout() {
  await saveLayoutInternal(false);
}

async function saveLayoutInternal(silent: boolean): Promise<string> {
  const payload = { ...layoutForm };
  if (layoutForm.id) {
    const updated = await apiRequest<{ id: string }>(`/api/nameplates/layouts/${layoutForm.id}`, {
      method: "POST",
      token: auth.token,
      body: JSON.stringify(payload),
    });
    layoutForm.id = updated.id;
    singleForm.layoutId = updated.id;
    if (!silent) ElMessage.success("布局已更新");
  } else {
    const created = await apiRequest<{ id: string }>("/api/nameplates/layouts", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify(payload),
    });
    layoutForm.id = created.id;
    singleForm.layoutId = created.id;
    if (!silent) ElMessage.success("布局已创建");
  }
  await loadLayouts();
  return layoutForm.id;
}

async function ensureLayoutId(): Promise<string> {
  const existing = (singleForm.layoutId || layoutForm.id || "").trim();
  if (existing) return existing;
  if (!layoutForm.layoutName.trim()) {
    throw new Error("请先填写布局名称");
  }
  return await saveLayoutInternal(true);
}

async function deleteLayout(id: string) {
  await apiRequest(`/api/nameplates/layouts/${id}/delete`, { method: "POST", token: auth.token, body: JSON.stringify({}) });
  ElMessage.success("布局已删除");
  await loadLayouts();
}

async function pushSingle() {
  try {
    const layoutId = await ensureLayoutId();
    if (!singleForm.deviceId) return ElMessage.error("请选择目标设备");
    if (!singleForm.name.trim()) return ElMessage.error("请填写姓名");
    const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/nameplates/render-push", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({ layoutId, name: singleForm.name.trim(), title: singleForm.title.trim(), deviceIds: [singleForm.deviceId], switchView: true }),
    });
    ElMessage.success(`下发完成：成功 ${data.successCount}，失败 ${data.failedCount}`);
    await loadHistory();
  } catch (error) {
    ElMessage.error((error as Error).message || "下发失败");
  }
}

function addBatchRow() {
  batchRows.value.push({ name: "", title: "", mode: "specified", deviceIds: [], poolDeviceIds: [], randomCount: 1 });
}

function removeBatchRow(index: number) {
  batchRows.value.splice(index, 1);
}

async function loadBatchPlans() {
  batchPlans.value = await apiRequest<Array<Record<string, any>>>("/api/nameplates/plans", { token: auth.token });
}

function loadBatchPlanToRows() {
  const id = batchPlanId.value;
  const plan = batchPlans.value.find((x) => x.id === id);
  if (!plan) return;
  batchPlanName.value = String(plan.planName || "");
  if (plan.layoutId) singleForm.layoutId = String(plan.layoutId);
  if (plan.deviceType) layoutForm.deviceType = String(plan.deviceType);
  const entries = Array.isArray(plan.entries) ? plan.entries : [];
  batchRows.value = entries.map((item: any) => ({
    name: String(item.name || ""),
    title: String(item.title || ""),
    mode: Number(item.randomCount || 0) > 0 ? "random" : "specified",
    deviceIds: Array.isArray(item.deviceIds) ? item.deviceIds : [],
    poolDeviceIds: Array.isArray(item.poolDeviceIds)
      ? item.poolDeviceIds
      : (Array.isArray(item.deviceIds) ? item.deviceIds : []),
    randomCount: Number(item.randomCount || 1),
  }));
  if (!batchRows.value.length) addBatchRow();
}

async function saveBatchPlan() {
  try {
    const layoutId = await ensureLayoutId();
    if (!batchPlanName.value.trim()) return ElMessage.error("请填写方案名称");
    const entries = batchRows.value
      .map((row) => ({
        name: row.name.trim(),
        title: row.title.trim(),
        deviceIds: row.mode === "specified" ? [...row.deviceIds] : [...row.poolDeviceIds],
        randomCount: row.mode === "random" ? Math.max(1, Number(row.randomCount || 1)) : 0,
      }))
      .filter((x) => x.name);
    if (!entries.length) return ElMessage.error("请至少填写一条批量记录");
    const payload = { planName: batchPlanName.value.trim(), layoutId, deviceType: layoutForm.deviceType, entries };
    if (batchPlanId.value) {
      await apiRequest(`/api/nameplates/plans/${batchPlanId.value}`, { method: "POST", token: auth.token, body: JSON.stringify(payload) });
      ElMessage.success("方案已更新");
    } else {
      const row = await apiRequest<{ id: string }>("/api/nameplates/plans", { method: "POST", token: auth.token, body: JSON.stringify(payload) });
      batchPlanId.value = row.id;
      ElMessage.success("方案已保存");
    }
    await loadBatchPlans();
  } catch (error) {
    ElMessage.error((error as Error).message || "保存方案失败");
  }
}

async function deleteBatchPlan() {
  if (!batchPlanId.value) return;
  await apiRequest(`/api/nameplates/plans/${batchPlanId.value}/delete`, { method: "POST", token: auth.token, body: JSON.stringify({}) });
  ElMessage.success("方案已删除");
  batchPlanId.value = "";
  batchPlanName.value = "";
  batchRows.value = [];
  addBatchRow();
  await loadBatchPlans();
}

async function executeBatchPush() {
  try {
    const layoutId = await ensureLayoutId();
    const entries = batchRows.value
      .map((row) => ({
        name: row.name.trim(),
        title: row.title.trim(),
        deviceIds: row.mode === "specified" ? [...row.deviceIds] : [...row.poolDeviceIds],
        randomCount: row.mode === "random" ? Math.max(1, Number(row.randomCount || 1)) : 0,
      }))
      .filter((x) => x.name);
    if (!entries.length) return ElMessage.error("请至少填写一条批量记录");

    const data = await apiRequest<{ successCount: number; failedCount: number }>("/api/nameplates/render-push-batch", {
      method: "POST",
      token: auth.token,
      body: JSON.stringify({
        layoutId,
        entries,
        defaultDeviceIds: deviceStore.selectedIds,
        savePlan: false,
        switchView: true,
      }),
    });
    ElMessage.success(`批量下发完成：成功 ${data.successCount}，失败 ${data.failedCount}`);
    await loadHistory();
  } catch (error) {
    ElMessage.error((error as Error).message || "批量下发失败");
  }
}

function openBatchDialog() {
  batchDialogOpen.value = true;
  if (!batchRows.value.length) addBatchRow();
  loadBatchPlans();
}

function onPreviewDown(target: "name" | "title", e: PointerEvent) {
  if (!previewRef.value) return;
  drag.active = true;
  drag.target = target;
  drag.pointerId = e.pointerId;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  drag.startOffsetX = target === "name" ? layoutForm.nameOffsetX : layoutForm.titleOffsetX;
  drag.startOffsetY = target === "name" ? layoutForm.nameOffsetY : layoutForm.titleOffsetY;
  previewRef.value.setPointerCapture(e.pointerId);
}

function onPreviewMove(e: PointerEvent) {
  if (!drag.active || drag.pointerId !== e.pointerId) return;
  const dx = Math.round((e.clientX - drag.startX) / stageScale.value);
  const dy = Math.round((e.clientY - drag.startY) / stageScale.value);
  if (drag.target === "name") {
    layoutForm.nameOffsetX = Math.max(-1200, Math.min(1200, drag.startOffsetX + dx));
    layoutForm.nameOffsetY = Math.max(-900, Math.min(900, drag.startOffsetY + dy));
  } else {
    layoutForm.titleOffsetX = Math.max(-1200, Math.min(1200, drag.startOffsetX + dx));
    layoutForm.titleOffsetY = Math.max(-900, Math.min(900, drag.startOffsetY + dy));
  }
}

function onPreviewUp(e: PointerEvent) {
  if (!drag.active || drag.pointerId !== e.pointerId) return;
  if (previewRef.value?.hasPointerCapture(e.pointerId)) previewRef.value.releasePointerCapture(e.pointerId);
  drag.active = false;
  drag.target = "";
  drag.pointerId = -1;
}

onMounted(async () => {
  window.addEventListener("resize", handleResize);
  applyTheme((localStorage.getItem("ink-screen-theme") || "light") === "dark");
  if (auth.token) {
    await loadInitialDashboardData();
  }
  handleResize();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", handleResize);
  if (imagePreviewUrl.value) {
    URL.revokeObjectURL(imagePreviewUrl.value);
    imagePreviewUrl.value = "";
  }
  if (homepageEditPreviewTimer) {
    clearTimeout(homepageEditPreviewTimer);
    homepageEditPreviewTimer = null;
  }
  clearPreviewRef(homepagePreviewUrl);
  clearPreviewRef(homepageEditPreviewUrl);
});

watch(
  () => [templateDraft.slug, templateDeviceId.value, auth.token],
  () => {
    if (!auth.token || !templateDeviceId.value) {
      resetXiqueTemplateState();
      return;
    }
    if (isXiqueTemplate.value) {
      void refreshXiqueTemplateStatus();
    } else {
      resetXiqueTemplateState();
    }
  },
  { immediate: true }
);

watch(
  () => xiqueAccountMode.value,
  (mode) => {
    if (mode === "existing") {
      applyXiqueAccountSelection();
    }
  }
);

watch(
  () => [
    auth.token,
    homepageDeviceId.value,
    homepagePreviewMode.value,
    homepageConfigModel?.template?.template_id,
    homepageConfigJson.value,
    homepageTemplateDraft.id,
    homepageTemplateDraft.name,
    homepageTemplateDraft.html,
    JSON.stringify(homepageTemplateDraft.targetDeviceTypes || []),
  ],
  () => {
    scheduleHomepageEditPreview();
  }
);
</script>

<style scoped>
.page { padding: 12px; }
.panel { max-width: 1680px; margin: 0 auto; border-radius: 20px; overflow: hidden; }
.header-row { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
.header-left { display:flex; align-items:center; gap:10px; min-width:0; }
.menu-toggle { flex:0 0 auto; }
.menu-toggle-icon { width:32px; height:32px; padding:0; font-size:18px; font-weight:700; }
.header-user { display:flex; align-items:center; gap:10px; }
.header-username { color:#374151; font-size:14px; }
.theme-toggle { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:rgba(15, 23, 42, 0.05); }
.theme-label { font-size:12px; color:#475569; }
.login-wrap { max-width: 460px; }
.workbench-shell { min-height: 760px; max-height: calc(100vh - 180px); border: 1px solid #e5e7eb; border-radius: 18px; overflow: hidden; background:rgba(255,255,255,0.82); backdrop-filter: blur(16px); display:flex; align-items:stretch; }
.workbench-shell :deep(.el-aside) { overflow:hidden; }
.aside-nav { border-right: 1px solid #e5e7eb; background: linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.92) 100%); display:flex; min-height:0; }
.side-menu { width:100%; min-height:0; flex:1; overflow-y:auto; border-right:none; }
.menu-item-content { display:flex; align-items:center; gap:10px; min-width:0; width:100%; }
.menu-svg { width:18px; height:18px; flex:0 0 18px; fill:currentColor; opacity:0.82; }
.menu-item-content span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sidebar-rail { flex:0 0 48px; width:48px; border-right:1px solid #e5e7eb; background:linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.92) 100%); display:flex; align-items:stretch; justify-content:center; }
.sidebar-rail-button { width:100%; height:100%; border:none; border-radius:0; font-size:20px; font-weight:700; color:#334155; background:transparent; }
.sidebar-rail-button:hover { background:rgba(59,130,246,0.08); color:#2563eb; }
.content-main { display:grid; gap:12px; padding:12px; flex:1; min-width:0; overflow:auto; }
.mobile-nav-drawer :deep(.el-drawer__body) { padding:0; height:100%; overflow:hidden; }
.drawer-shell { display:flex; flex-direction:column; gap:12px; height:100%; min-height:0; overflow:hidden; padding:16px; box-sizing:border-box; }
.drawer-title { display:flex; flex-direction:column; gap:4px; }
.drawer-hint { font-size:12px; color:#64748b; }
.drawer-menu { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; -webkit-overflow-scrolling:touch; border-right:none; }
.section-wrap { display:grid; gap:10px; }
.ai-page-wrap { min-height:0; }
.ai-settings-drawer { display:grid; gap:12px; padding-bottom:18px; }
.stack-vertical { display:grid; gap:12px; }
.row-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.row-between { display:flex; justify-content:space-between; align-items:center; }
.usb-nvs-mode-tabs { margin-bottom:12px; }
.usb-nvs-page { display:grid; gap:10px; padding-top:2px; }
.usb-nvs-page :deep(.el-alert__content) { min-width:0; }
.pool-vertical :deep(.el-col) { max-width: 100%; flex: 0 0 100%; }
.overview-hero { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; padding:24px 28px; border-radius:24px; background:linear-gradient(135deg, #0f172a 0%, #1d4ed8 58%, #38bdf8 100%); color:#fff; box-shadow:0 22px 50px rgba(37, 99, 235, 0.18); }
.overview-eyebrow { font-size:12px; letter-spacing:0.16em; text-transform:uppercase; opacity:0.72; margin-bottom:10px; }
.overview-hero h3 { margin:0; font-size:28px; }
.overview-summary { margin-top:8px; color:rgba(255,255,255,0.84); max-width:720px; line-height:1.6; }
.overview-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:12px; }
.overview-card { border-radius:18px; border:none; }
.overview-card-label { font-size:13px; color:#64748b; }
.overview-card-value { margin-top:10px; font-size:34px; font-weight:700; color:#0f172a; line-height:1; }
.overview-card-note { margin-top:10px; font-size:12px; color:#94a3b8; line-height:1.5; }
.cluster-edit-shell { display:grid; gap:12px; }
.cluster-edit-meta { border-radius:16px; }
.nameplate-stage { position:relative; margin: 0 auto; border:1px solid #d9dee8; border-radius: 10px; background:#fff; overflow:hidden; }
.nameplate-stage.dialog { max-width: 100%; }
.preview-name, .preview-title { position:absolute; line-height:1.1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; user-select:none; }
.preview-name { font-weight:700; cursor:move; }
.preview-title { color:#2f3948; cursor:move; }
.dialog-preview-wrap { overflow:auto; max-height:72vh; }
.image-preview-shell { display:flex; justify-content:center; overflow:auto; }
.image-preview-stage { position:relative; border:1px solid #d9dee8; border-radius:10px; background:#fff; overflow:hidden; }
.image-preview-img { width:100%; height:100%; object-fit:cover; display:block; }
.homepage-preview-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  image-rendering: crisp-edges;
}
.image-preview-empty { height:100%; display:flex; align-items:center; justify-content:center; color:#64748b; font-size:14px; }
.time-overlay-preview { position:absolute; border:none; background:transparent; box-sizing:border-box; pointer-events:none; overflow:hidden; padding:0; margin:0; }
.time-overlay-preview :deep(.segment-time-preview) { width:100%; height:100%; background:transparent; }
.homepage-edit-preview-frame { width:100%; height:100%; border:0; background:#fff; display:block; }
.dark-mode .panel { background:rgba(15, 23, 42, 0.82); border-color:#233047; }
.dark-mode .header-username { color:#dbe7f4; }
.dark-mode .theme-toggle { background:rgba(148, 163, 184, 0.12); }
.dark-mode .theme-label { color:#cbd5e1; }
.dark-mode .workbench-shell { border-color:#253247; background:rgba(15, 23, 42, 0.78); }
.dark-mode .aside-nav { border-right-color:#253247; background:linear-gradient(180deg, rgba(15,23,42,0.96) 0%, rgba(15,23,42,0.88) 100%); }
.dark-mode .overview-hero { background:linear-gradient(135deg, #020617 0%, #0f172a 50%, #1d4ed8 100%); box-shadow:0 22px 54px rgba(2, 6, 23, 0.55); }
.dark-mode .overview-card-label { color:#94a3b8; }
.dark-mode .overview-card-value { color:#f8fafc; }
.dark-mode .overview-card-note { color:#64748b; }
.dark-mode .nameplate-stage,
.dark-mode .image-preview-stage { border-color:#334155; background:#0f172a; }
.dark-mode .preview-title { color:#cbd5e1; }

@media (max-width: 900px) {
  .header-row { align-items:flex-start; }
  .header-user { width:100%; flex-wrap:wrap; justify-content:flex-start; }
  .workbench-shell {
    max-height:none;
    min-height:unset;
    flex-direction:column;
    overflow-x:auto;
    overflow-y:visible;
    -webkit-overflow-scrolling: touch;
  }
  .content-main {
    overflow-x:auto;
    overflow-y:visible;
    -webkit-overflow-scrolling: touch;
    padding:10px;
  }
  .aside-nav { display:none; }
  .sidebar-rail { display:none; }
  .overview-hero { flex-direction:column; align-items:flex-start; }
  .mobile-nav-drawer :deep(.el-drawer) {
    max-width: calc(100vw - 10px);
  }
  .mobile-nav-drawer :deep(.el-drawer__body) {
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  :deep(.el-dialog) {
    width: calc(100vw - 14px) !important;
    max-width: calc(100vw - 14px) !important;
    margin: 7px auto !important;
  }
  :deep(.el-dialog__body) {
    overflow-x: auto;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
}
</style>
