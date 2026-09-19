/* eslint-disable no-console */
const assert = require("assert");
const { listTools } = require("../src/tools/registry");

const REQUIRED_TOOLS = [
  "ink_device_update",
  "ink_ai_config_save",
  "ink_pin_bind_device",
  "ink_device_pool_list",
  "ink_device_pool_save",
  "ink_device_pool_delete",
  "ink_nvs_dispatch_server_addresses",
  "ink_device_variable_batch_set",
  "ink_task_plan_list",
  "ink_task_plan_save",
  "ink_task_plan_delete",
  "ink_task_plan_run_status",
  "ink_todo_list",
  "ink_todo_upsert",
  "ink_todo_delete",
  "ink_xique_import",
  "ink_collection_push_to_device",
  "ink_collection_push_image_to_device",
  "ink_remote_switch_view",
  "ink_remote_publish_announcement",
  "ink_remote_project_image",
  "ink_remote_refresh_page",
  "ink_page_render_and_push",
  "ink_nameplate_push",
  "ink_template_list",
  "ink_template_save",
  "ink_log_list",
];

async function main() {
  const tools = listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of REQUIRED_TOOLS) {
    assert.ok(byName.has(name), `missing MCP tool ${name}`);
    assert.ok(/使用方法|调用建议/.test(String(byName.get(name).description || "")), `${name} should include usage hint`);
  }
  const xique = byName.get("ink_xique_import");
  assert.ok(String(xique.description || "").includes("账号密码"), "xique import tool must tell AI to ask user for account/password");
  const ownerProps = byName.get("ink_device_update").inputSchema.properties;
  assert.ok(ownerProps.ownerId, "device update should support ownerId for admin");
  const batchProps = byName.get("ink_device_variable_batch_set").inputSchema.properties;
  assert.ok(batchProps.deviceIds && batchProps.clusterIds, "batch variable tool should support devices and pools");
  console.log("[ok] full MCP tool coverage contract passed");
}

main().catch((error) => {
  console.error(`[fail] ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
