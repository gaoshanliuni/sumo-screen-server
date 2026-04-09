<template>
  <div class="page" :class="{ 'dark-mode': darkMode }">
    <el-card class="panel">
      <template #header>
        <div class="header-row">
          <div class="header-left">
            <el-button v-if="isMobile || !sidebarCollapsed" class="menu-toggle" plain @click="toggleSidebar">
              {{ isMobile ? (mobileNavOpen ? "关闭菜单" : "菜单") : sidebarCollapsed ? "展开侧栏" : "收起侧栏" }}
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
          <el-form-item label="用户名"><el-input v-model="loginForm.username" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="loginForm.password" show-password /></el-form-item>
          <el-button type="primary" :loading="loginLoading" @click="doLogin">登录</el-button>
        </el-form>
      </div>

      <el-container v-else class="workbench-shell">
        <el-drawer v-model="mobileNavOpen" class="mobile-nav-drawer" direction="ltr" :show-close="true" :with-header="false" size="82%">
          <div class="drawer-shell">
            <div class="drawer-title">
              <strong>功能菜单</strong>
              <span class="drawer-hint">点击切换页面</span>
            </div>
            <el-menu :default-active="activePanel" class="drawer-menu" @select="onSelectPanel">
              <el-menu-item v-for="item in sidebarMenuItems" :key="item.index" :index="item.index">
                {{ item.label }}
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
              {{ item.label }}
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
                  <div style="display:grid; gap:8px">
                    <div v-for="(field, idx) in templateDraft.userInputFields" :key="`param-${idx}`">
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
              <el-button @click="loadUpgradeJobs">刷新升级任务</el-button>
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
            </div>
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
            <el-card>
              <template #header>已选设备快速编辑</template>
              <el-table :data="quickEditRows" height="280" size="small">
                <el-table-column prop="id" label="设备ID" min-width="150" />
                <el-table-column label="在线状态" width="100">
                  <template #default="scope">{{ scope.row.online ? "在线" : "离线" }}</template>
                </el-table-column>
                <el-table-column label="绑定用户" min-width="190">
                  <template #default="scope">{{ scope.row.ownerNickname || scope.row.ownerUsername || scope.row.ownerId || "-" }}</template>
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
                      <el-radio-button label="edit">编辑预览</el-radio-button>
                      <el-radio-button label="delivery">下发预览</el-radio-button>
                    </el-radio-group>
                  </div>
                </template>
                <div v-if="homepagePreviewMode === 'edit'" class="image-preview-shell">
                  <div class="image-preview-stage" :style="imagePreviewStageStyle">
                    <img v-if="homepageEditPreviewUrl" :src="homepageEditPreviewUrl" class="image-preview-img" alt="homepage edit preview" />
                    <div v-else class="image-preview-empty">{{ homepageEditPreviewLoading ? "编辑预览渲染中..." : "编辑模板后自动生成预览" }}</div>
                    <div v-if="showHomepageTimeOverlayPreview" class="time-overlay-preview" :style="homepageTimeOverlayPreviewStyle">
                      <SegmentTimePreview
                        :width="homepageTimeOverlayBox.width"
                        :height="homepageTimeOverlayBox.height"
                        :format="homepageTimeOverlayFormat"
                        :font-size="homepageTimeOverlayFontSize"
                        :align="homepageTimeOverlayAlign"
                        color="#111111"
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
                    <div class="image-preview-stage" :style="imagePreviewStageStyle">
                      <img v-if="homepagePreviewUrl" :src="homepagePreviewUrl" class="image-preview-img" alt="homepage preview" />
                      <div v-else class="image-preview-empty">先执行一次渲染</div>
                      <div v-if="showHomepageTimeOverlayPreview" class="time-overlay-preview" :style="homepageTimeOverlayPreviewStyle">
                        <SegmentTimePreview
                          :width="homepageTimeOverlayBox.width"
                          :height="homepageTimeOverlayBox.height"
                          :format="homepageTimeOverlayFormat"
                          :font-size="homepageTimeOverlayFontSize"
                          :align="homepageTimeOverlayAlign"
                          color="#111111"
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
                      <el-option v-for="d in deviceStore.devices" :key="d.id" :label="deviceOptionLabel(d)" :value="d.id" />
                    </el-select>
                  </el-form-item>
                  <el-form-item label="模板 ID">
                    <el-select v-model="homepageConfigModel.template.template_id" filterable style="width:100%">
                      <el-option v-for="tpl in homepageTemplates" :key="tpl.id" :label="tpl.name" :value="tpl.id" />
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
                  <el-form-item label="JSON 高级配置">
                    <el-input v-model="homepageConfigJson" type="textarea" :rows="11" />
                  </el-form-item>
                </el-form>
                <div class="row-actions">
                  <el-button type="primary" @click="saveHomepageConfig">保存配置</el-button>
                  <el-button @click="renderHomepage">仅渲染</el-button>
                  <el-button type="success" @click="pushHomepage">渲染并推送</el-button>
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
                  <el-form-item label="HTML">
                    <el-input ref="homepageTemplateHtmlInputRef" v-model="homepageTemplateDraft.html" type="textarea" :rows="13" />
                  </el-form-item>
                </el-form>
                <div class="row-actions">
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
      subtitle="基础变量 / API模板变量"
      @refresh="loadHomepageTemplateVariables"
      @insert="insertHomepageTemplateVariable"
    />

    <el-dialog v-model="previewDialogOpen" title="桌牌等比例预览" width="80%">
      <div class="dialog-preview-wrap">
        <div class="nameplate-stage dialog" :style="stageDialogStyle">
          <div class="preview-name" :style="nameDialogStyle">{{ singleForm.name || '张三' }}</div>
          <div class="preview-title" :style="titleDialogStyle">{{ singleForm.title || '产品经理' }}</div>
        </div>
      </div>
    </el-dialog>

    <el-dialog v-model="batchDialogOpen" title="批量桌牌下发（表格）" width="88%">
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

    <el-dialog v-model="clusterEditDialogOpen" :title="clusterForm.name ? `编辑设备池：${clusterForm.name}` : '编辑设备池'" width="92%">
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

    <el-dialog v-model="dispatchPickerDialogOpen" :title="`选择目标设备（${dispatchTargetKeyLabel}）`" width="92%">
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

    <el-dialog v-model="imagePreviewDialogOpen" title="投屏预览（设备分辨率）" width="86%">
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
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { useAuthStore, type AppRole } from "../stores/auth";
import { useDeviceStore } from "../stores/devices";
import { apiRequest } from "../services/api";
import DeviceLassoPicker from "../components/DeviceLassoPicker.vue";
import TemplateVariablePanel from "../components/TemplateVariablePanel.vue";
import TemplateAdvancedEditorDialog from "../components/TemplateAdvancedEditorDialog.vue";
import SegmentTimePreview from "../components/SegmentTimePreview.vue";

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
const dispatchTargetKey = ref<"todo" | "schedule" | "templates" | "tf" | "remote" | "homepage">("remote");

const loginForm = reactive({ username: props.role === "admin" ? "admin" : "demo", password: props.role === "admin" ? "admin123" : "user123" });
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

const deviceFilters = reactive({ bound: "", online: "", status: "", keyword: "" });
const singleDeviceId = ref("");
const deviceEditForm = reactive({ displayName: "", remark: "", status: "enabled", ownerId: "" });
const quickEditRows = computed(() => deviceStore.devices.filter((item) => deviceStore.selectedIds.includes(item.id)));
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
};
type HomepageTemplateVariableRow = {
  path: string;
  placeholder: string;
  type: string;
  example: string;
  source?: "base" | "api";
  slug?: string;
  sourceLabel?: string;
};
const homepageDeviceId = ref("");
const homepageTemplates = ref<HomepageTemplateRow[]>([]);
const homepageTemplateDraft = reactive<HomepageTemplateRow>({
  id: "",
  name: "",
  type: "custom_html",
  html: "",
  builtin: false,
});
const homepageTemplateVariables = ref<HomepageTemplateVariableRow[]>([]);
const homepageInsertVarVisible = ref(false);
const homepageInsertVarLoading = ref(false);
const homepageTemplateHtmlInputRef = ref<any>(null);
const homepageConfigModel = reactive<any>({
  template: { template_id: "tpl_home_default" },
  time_overlay: {
    enabled: true,
    x: 1820,
    y: 80,
    width: 680,
    height: 180,
    format: "HH:mm",
    font_size: 88,
    refresh_interval_sec: 60,
  },
});
const homepageConfigJson = ref("{}");
const homepageClusterIds = ref<string[]>([]);
const homepagePreviewUrl = ref("");
const homepageEditPreviewUrl = ref("");
const homepageEditPreviewLoading = ref(false);
const homepageRenderMeta = reactive<Record<string, any>>({});
const homepagePreviewMode = ref<"edit" | "delivery">("edit");
let homepageEditPreviewTimer: ReturnType<typeof setTimeout> | null = null;

function toPreviewNum(value: unknown, fallback: number) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

const homepageTimeOverlayBox = computed(() => {
  const overlay = homepageConfigModel?.time_overlay || {};
  const image = homepageRenderMeta || {};
  const screen = homepageConfigModel?.screen || {};
  const sw = Math.max(1, toPreviewNum(screen.width, toPreviewNum(image.image_width, 2560)));
  const sh = Math.max(1, toPreviewNum(screen.height, toPreviewNum(image.image_height, 1600)));
  const width = Math.max(1, toPreviewNum(overlay.width, 680));
  const height = Math.max(1, toPreviewNum(overlay.height, 180));
  const x = Math.max(0, toPreviewNum(overlay.x, Math.max(0, sw - width - 32)));
  const y = Math.max(0, toPreviewNum(overlay.y, 80));
  return { sw, sh, x, y, width, height };
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
  return Boolean(overlay.enabled) && homepageTimeOverlayBox.value.width > 0 && homepageTimeOverlayBox.value.height > 0;
});

const homepageTimeOverlayPreviewStyle = computed(() => {
  const box = homepageTimeOverlayBox.value;
  return {
    left: `${(box.x / box.sw) * 100}%`,
    top: `${(box.y / box.sh) * 100}%`,
    width: `${(box.width / box.sw) * 100}%`,
    height: `${(box.height / box.sh) * 100}%`,
    display: "flex",
    justifyContent:
      homepageTimeOverlayAlign.value === "left"
        ? "flex-start"
        : homepageTimeOverlayAlign.value === "center"
          ? "center"
          : "flex-end",
    alignItems: "center",
  };
});
const batchTargetDeviceIds = reactive<Record<"todo" | "schedule" | "templates" | "tf" | "remote" | "homepage", string[]>>({
  todo: [],
  schedule: [],
  templates: [],
  tf: [],
  remote: [],
  homepage: [],
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
const sidebarMenuItems = computed(() => {
  const items = [
    { index: "overview", label: "主页概览" },
    { index: "account", label: "账号管理" },
    { index: "devicePin", label: "设备与PIN" },
    { index: "devices", label: "设备管理" },
    { index: "todo", label: "TODO" },
    { index: "schedule", label: "日程安排" },
    { index: "tf", label: "文件管理" },
    { index: "remote", label: "远程控制" },
    { index: "homepage", label: "主页" },
    { index: "layout", label: "桌牌设置" },
    { index: "history", label: "桌牌历史" },
    { index: "templates", label: "API模板" },
    { index: "firmware", label: "固件管理" },
  ];
  if (isAdmin.value) {
    items.splice(4, 0, { index: "pools", label: "设备池管理" });
    items.push({ index: "logs", label: "日志中心" });
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
  if (["todo", "schedule", "templates", "tf", "remote", "homepage"].includes(index)) {
    loadClusters();
  }
  if (index === "overview") {
    refreshOverview();
  } else if (index === "account" && isAdmin.value) {
    loadAdminUsers();
  } else if (index === "devicePin" && isAdmin.value) {
    loadAdminUsers();
  } else if (index === "todo") {
    loadTodoRows();
  } else if (index === "schedule") {
    loadScheduleRows();
  } else if (index === "templates") {
    loadTemplateRows();
  } else if (index === "homepage") {
    loadHomepageAll();
  } else if (index === "firmware") {
    loadFirmwareRows();
    loadUpgradeJobs();
  } else if (index === "tf") {
    loadTfRows();
    loadTfLocalRows();
  } else if (index === "logs" && isAdmin.value) {
    loadOperationLogs();
    loadApiLogs();
  } else if (index === "layout") {
    loadLayouts();
  } else if (index === "pools" && isAdmin.value) {
    loadClusters();
  } else if (index === "devices") {
    loadClusters();
  } else if (index === "history") {
    loadHistory();
  }
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
function openDispatchPicker(key: "todo" | "schedule" | "templates" | "tf" | "remote" | "homepage") {
  dispatchTargetKey.value = key;
  dispatchPickerSelection.value = [...(batchTargetDeviceIds[key] || [])];
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
    await refreshDevices();
    await refreshOverview();
    await loadClusters();
    if (isAdmin.value) {
      await loadAdminUsers();
    }
    await loadTemplateRows();
    await loadHomepageAll();
    scheduleHomepageEditPreview();
    await loadFirmwareRows();
    await loadUpgradeJobs();
    await loadTfRows();
    await loadLayouts();
    await loadHistory();
    ElMessage.success("登录成功");
  } catch (error) {
    ElMessage.error((error as Error).message || "登录失败");
  } finally {
    loginLoading.value = false;
  }
}

function logout() { auth.logout(); deviceStore.clearSelection(); }

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
  if (!singleForm.deviceId && deviceStore.devices.length) singleForm.deviceId = deviceStore.devices[0].id;
  const valid = new Set(deviceStore.devices.map((item) => item.id));
  (Object.keys(batchTargetDeviceIds) as Array<keyof typeof batchTargetDeviceIds>).forEach((key) => {
    batchTargetDeviceIds[key] = (batchTargetDeviceIds[key] || []).filter((id) => valid.has(id));
  });
  onSingleDeviceChanged();
}

async function refreshOverview() {
  if (!auth.token) return;
  const [devices, todos, schedules, firmwares] = await Promise.all([
    apiRequest<any[]>("/api/devices", { token: auth.token }),
    apiRequest<any[]>("/api/todos", { token: auth.token }),
    apiRequest<any[]>("/api/schedules", { token: auth.token }),
    apiRequest<any[]>("/api/firmware", { token: auth.token }),
  ]);
  overview.deviceTotal = devices.length;
  overview.deviceBound = devices.filter((d) => d.bindState === "bound").length;
  overview.deviceUnbound = devices.length - overview.deviceBound;
  overview.deviceOnline = devices.filter((d) => d.online).length;
  overview.deviceOffline = devices.length - overview.deviceOnline;
  overview.todoCount = todos.length;
  overview.scheduleCount = schedules.length;
  overview.firmwareCount = firmwares.length;
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
  await apiRequest(`/api/devices/${row.id}`, {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({
      displayName: String(row.displayName || "").trim(),
      remark: String(row.remark || "").trim(),
    }),
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

function resolveBatchTargetDevices(key: "todo" | "schedule" | "templates" | "tf" | "remote" | "homepage") {
  const ids = [...(batchTargetDeviceIds[key] || [])];
  if (ids.length) return ids;
  return [...deviceStore.selectedIds];
}

function syncHomepageConfigJsonFromModel() {
  homepageConfigJson.value = JSON.stringify(homepageConfigModel, null, 2);
}

function applyHomepageConfigModel(data: Record<string, any>) {
  Object.keys(homepageConfigModel).forEach((k) => delete homepageConfigModel[k]);
  Object.assign(homepageConfigModel, data || {});
  if (!homepageConfigModel.template) homepageConfigModel.template = { template_id: "tpl_home_default" };
  if (!homepageConfigModel.time_overlay) {
    homepageConfigModel.time_overlay = {
      enabled: true,
      x: 1820,
      y: 80,
      width: 680,
      height: 180,
      format: "HH:mm",
      font_size: 88,
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
    };
  }

  if (configTemplate) {
    return {
      id: String(configTemplate.id || selectedId),
      name: String(configTemplate.name || "Homepage Template"),
      type: String(configTemplate.type || "custom_html"),
      html: String(configTemplate.html || ""),
    };
  }

  return {
    id: selectedId,
    name: "Homepage Template",
    type: "custom_html",
    html: "",
  };
}

const homepageBaseVariableRoots = new Set(["profile", "todo_summary", "schedule_summary", "weather", "custom_fields", "meta"]);

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
  const knownApiSlugs = collectHomepageApiSlugs(
    rawRows.map((item) => ({
      path: String(item?.path || ""),
      placeholder: String(item?.placeholder || ""),
      type: String(item?.type || ""),
      example: String(item?.example || ""),
      source: String(item?.source || "") as "base" | "api" | undefined,
      slug: String(item?.slug || ""),
      sourceLabel: String(item?.sourceLabel || ""),
    }))
  );

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
      const isBase = homepageBaseVariableRoots.has(first) || ["formatted", "raw", "third_latest"].includes(first) || path === "formatted" || path === "raw";
      const inferredSource: "base" | "api" = isBase || (!slug && !knownApiSlugs.has(first) && !knownApiSlugs.has(path)) ? "base" : "api";
      const source = String(item?.source || inferredSource) as "base" | "api";
      const resolvedSlug = source === "api" ? (slug || (knownApiSlugs.has(first) ? first : "latest")) : "";
      return {
        path,
        placeholder,
        type,
        example,
        source,
        slug: resolvedSlug,
        sourceLabel: source === "api" ? "API模板变量" : "基础变量",
      };
    })
    .filter((item) => Boolean(item.path))
    .sort((a, b) => {
      const sourceRank = (value: string) => (value === "api" ? 1 : 0);
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

async function renderHomepageEditPreview() {
  if (!auth.token || !homepageDeviceId.value || homepagePreviewMode.value !== "edit") return;
  homepageEditPreviewLoading.value = true;
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
    await applyHomepagePreviewImage(data.image || {}, homepageEditPreviewUrl);
    await applyHomepagePreviewImage(data.image || {}, homepagePreviewUrl);
  } catch (_) {
    clearPreviewRef(homepageEditPreviewUrl);
  } finally {
    homepageEditPreviewLoading.value = false;
  }
}

function scheduleHomepageEditPreview() {
  if (homepageEditPreviewTimer) {
    clearTimeout(homepageEditPreviewTimer);
    homepageEditPreviewTimer = null;
  }
  if (homepagePreviewMode.value !== "edit") return;
  homepageEditPreviewTimer = setTimeout(() => {
    void renderHomepageEditPreview();
  }, 450);
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
}

async function loadHomepageConfig() {
  if (!auth.token || !homepageDeviceId.value) return;
  const data = await apiRequest<any>(`/api/homepages/config?deviceId=${encodeURIComponent(homepageDeviceId.value)}`, { token: auth.token });
  applyHomepageConfigModel(data);
  syncHomepageTemplateDraftFromConfig();
  Object.keys(homepageRenderMeta).forEach((k) => delete homepageRenderMeta[k]);
  Object.assign(homepageRenderMeta, data.image || {});
  await applyHomepagePreviewImage(data.image || {}, homepagePreviewUrl);
  scheduleHomepageEditPreview();
}

async function loadHomepageAll() {
  await Promise.all([loadHomepageTemplates(), loadHomepageConfig()]);
}

async function saveHomepageConfig() {
  if (!homepageDeviceId.value) return ElMessage.error("请先选择设备");
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
    await loadHomepageConfig();
  } catch (error) {
    ElMessage.error((error as Error).message || "主页推送失败");
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
      }),
    });
    homepageTemplateDraft.id = row.id;
    homepageTemplateDraft.builtin = Boolean(row.builtin);
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

async function loadClusters() {
  if (!auth.token) return;
  clusters.value = await apiRequest<ClusterRow[]>("/api/clusters", { token: auth.token });
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

function openTemplateAdvancedEditor() {
  templateDraft.advancedConfig = normalizeTemplateAdvancedConfig(templateDraft.advancedConfig);
  templateAdvancedDialogVisible.value = true;
}

function saveTemplateAdvancedConfig(config: TemplateAdvancedConfig) {
  templateDraft.advancedConfig = normalizeTemplateAdvancedConfig(config);
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
  Object.keys(templateParamValues).forEach((k) => delete templateParamValues[k]);
  templateDraft.userInputFields.forEach((f) => {
    if (!templateParamValues[f.name]) templateParamValues[f.name] = "";
  });
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
  if (!templateDeviceId.value || !templateDraft.slug) return;
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
  templateResultText.value = JSON.stringify(data, null, 2);
}

function onFirmwareFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  firmwareFile.value = input.files?.[0] || null;
}

async function loadFirmwareRows() {
  firmwareRows.value = await apiRequest<FirmwareRow[]>("/api/firmware", { token: auth.token });
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
  if (!deviceStore.selectedIds.length) return ElMessage.error("请先框选目标设备");
  const data = await apiRequest<{ success: any[]; failed: any[] }>("/api/firmware/batch-upgrade", {
    method: "POST",
    token: auth.token,
    body: JSON.stringify({ deviceIds: deviceStore.selectedIds }),
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
    await refreshDevices();
    await refreshOverview();
    await loadClusters();
    if (isAdmin.value) {
      await loadAdminUsers();
    }
    await loadTemplateRows();
    await loadHomepageAll();
    await loadFirmwareRows();
    await loadUpgradeJobs();
    await loadTfRows();
    await loadTfLocalRows();
    await loadLayouts();
    await loadHistory();
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
  () => [
    auth.token,
    homepageDeviceId.value,
    homepagePreviewMode.value,
    homepageConfigModel?.template?.template_id,
    homepageConfigJson.value,
    homepageTemplateDraft.id,
    homepageTemplateDraft.name,
    homepageTemplateDraft.html,
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
.header-user { display:flex; align-items:center; gap:10px; }
.header-username { color:#374151; font-size:14px; }
.theme-toggle { display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px; background:rgba(15, 23, 42, 0.05); }
.theme-label { font-size:12px; color:#475569; }
.login-wrap { max-width: 460px; }
.workbench-shell { min-height: 760px; max-height: calc(100vh - 180px); border: 1px solid #e5e7eb; border-radius: 18px; overflow: hidden; background:rgba(255,255,255,0.82); backdrop-filter: blur(16px); display:flex; align-items:stretch; }
.workbench-shell :deep(.el-aside) { overflow:hidden; }
.aside-nav { border-right: 1px solid #e5e7eb; background: linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.92) 100%); display:flex; min-height:0; }
.side-menu { width:100%; min-height:0; flex:1; overflow-y:auto; border-right:none; }
.sidebar-rail { flex:0 0 48px; width:48px; border-right:1px solid #e5e7eb; background:linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(248,250,252,0.92) 100%); display:flex; align-items:stretch; justify-content:center; }
.sidebar-rail-button { width:100%; height:100%; border:none; border-radius:0; font-size:20px; font-weight:700; color:#334155; background:transparent; }
.sidebar-rail-button:hover { background:rgba(59,130,246,0.08); color:#2563eb; }
.content-main { display:grid; gap:12px; padding:12px; flex:1; min-width:0; overflow:auto; }
.mobile-nav-drawer :deep(.el-drawer__body) { padding:0; }
.drawer-shell { display:flex; flex-direction:column; gap:12px; height:100%; padding:16px; box-sizing:border-box; }
.drawer-title { display:flex; flex-direction:column; gap:4px; }
.drawer-hint { font-size:12px; color:#64748b; }
.drawer-menu { flex:1; min-height:0; overflow-y:auto; border-right:none; }
.section-wrap { display:grid; gap:10px; }
.stack-vertical { display:grid; gap:12px; }
.row-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.row-between { display:flex; justify-content:space-between; align-items:center; }
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
.image-preview-empty { height:100%; display:flex; align-items:center; justify-content:center; color:#64748b; font-size:14px; }
.time-overlay-preview { position:absolute; border:2px solid rgba(239, 68, 68, 0.85); background:transparent; box-sizing:border-box; pointer-events:none; overflow:hidden; padding:0; margin:0; }
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
  .workbench-shell { max-height:none; min-height:unset; flex-direction:column; }
  .content-main { overflow:visible; padding:10px; }
  .aside-nav { display:none; }
  .sidebar-rail { display:none; }
  .overview-hero { flex-direction:column; align-items:flex-start; }
}
</style>
