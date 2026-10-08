import { createApp } from "vue";
import { createPinia } from "pinia";
import { ElAlert } from "element-plus/es/components/alert/index.mjs";
import { ElButton, ElButtonGroup } from "element-plus/es/components/button/index.mjs";
import { ElCard } from "element-plus/es/components/card/index.mjs";
import { ElCheckbox, ElCheckboxGroup } from "element-plus/es/components/checkbox/index.mjs";
import { ElCol } from "element-plus/es/components/col/index.mjs";
import { ElCollapse, ElCollapseItem } from "element-plus/es/components/collapse/index.mjs";
import { ElAside, ElContainer, ElMain } from "element-plus/es/components/container/index.mjs";
import { ElDatePicker } from "element-plus/es/components/date-picker/index.mjs";
import { ElDescriptions, ElDescriptionsItem } from "element-plus/es/components/descriptions/index.mjs";
import { ElDialog } from "element-plus/es/components/dialog/index.mjs";
import { ElDivider } from "element-plus/es/components/divider/index.mjs";
import { ElDrawer } from "element-plus/es/components/drawer/index.mjs";
import { ElEmpty } from "element-plus/es/components/empty/index.mjs";
import { ElForm, ElFormItem } from "element-plus/es/components/form/index.mjs";
import { ElInput } from "element-plus/es/components/input/index.mjs";
import { ElInputNumber } from "element-plus/es/components/input-number/index.mjs";
import { ElLoading } from "element-plus/es/components/loading/index.mjs";
import { ElMenu, ElMenuItem } from "element-plus/es/components/menu/index.mjs";
import { ElPopover } from "element-plus/es/components/popover/index.mjs";
import { ElProgress } from "element-plus/es/components/progress/index.mjs";
import { ElRadio, ElRadioButton, ElRadioGroup } from "element-plus/es/components/radio/index.mjs";
import { ElRow } from "element-plus/es/components/row/index.mjs";
import { ElSegmented } from "element-plus/es/components/segmented/index.mjs";
import { ElOption, ElOptionGroup, ElSelect } from "element-plus/es/components/select/index.mjs";
import { ElSwitch } from "element-plus/es/components/switch/index.mjs";
import { ElTable, ElTableColumn } from "element-plus/es/components/table/index.mjs";
import { ElTabPane, ElTabs } from "element-plus/es/components/tabs/index.mjs";
import { ElTag } from "element-plus/es/components/tag/index.mjs";
import { ElTimePicker } from "element-plus/es/components/time-picker/index.mjs";

import "element-plus/es/components/alert/style/css";
import "element-plus/es/components/aside/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/button-group/style/css";
import "element-plus/es/components/card/style/css";
import "element-plus/es/components/checkbox/style/css";
import "element-plus/es/components/checkbox-group/style/css";
import "element-plus/es/components/col/style/css";
import "element-plus/es/components/collapse/style/css";
import "element-plus/es/components/collapse-item/style/css";
import "element-plus/es/components/container/style/css";
import "element-plus/es/components/date-picker/style/css";
import "element-plus/es/components/descriptions/style/css";
import "element-plus/es/components/descriptions-item/style/css";
import "element-plus/es/components/dialog/style/css";
import "element-plus/es/components/divider/style/css";
import "element-plus/es/components/drawer/style/css";
import "element-plus/es/components/empty/style/css";
import "element-plus/es/components/form/style/css";
import "element-plus/es/components/form-item/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/input-number/style/css";
import "element-plus/es/components/loading/style/css";
import "element-plus/es/components/main/style/css";
import "element-plus/es/components/menu/style/css";
import "element-plus/es/components/menu-item/style/css";
import "element-plus/es/components/message/style/css";
import "element-plus/es/components/message-box/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/option-group/style/css";
import "element-plus/es/components/popover/style/css";
import "element-plus/es/components/progress/style/css";
import "element-plus/es/components/radio/style/css";
import "element-plus/es/components/radio-button/style/css";
import "element-plus/es/components/radio-group/style/css";
import "element-plus/es/components/row/style/css";
import "element-plus/es/components/segmented/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/switch/style/css";
import "element-plus/es/components/tab-pane/style/css";
import "element-plus/es/components/table/style/css";
import "element-plus/es/components/table-column/style/css";
import "element-plus/es/components/tabs/style/css";
import "element-plus/es/components/tag/style/css";
import "element-plus/es/components/time-picker/style/css";

import App from "./App.vue";
import router from "./router";

const app = createApp(App);
app.use(createPinia());
app.use(router);
[
  ElAlert,
  ElAside,
  ElButton,
  ElButtonGroup,
  ElCard,
  ElCheckbox,
  ElCheckboxGroup,
  ElCol,
  ElCollapse,
  ElCollapseItem,
  ElContainer,
  ElDatePicker,
  ElDescriptions,
  ElDescriptionsItem,
  ElDialog,
  ElDivider,
  ElDrawer,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElInput,
  ElInputNumber,
  ElLoading,
  ElMain,
  ElMenu,
  ElMenuItem,
  ElOption,
  ElOptionGroup,
  ElPopover,
  ElProgress,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElRow,
  ElSegmented,
  ElSelect,
  ElSwitch,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElTimePicker,
].forEach((plugin) => app.use(plugin));
app.mount("#app");
