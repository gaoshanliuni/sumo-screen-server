const fs = require("fs");
const path = require("path");

const { renderPageBuffers } = require("../src/services/page_profile.service");
const homepageService = require("../src/services/homepage_page.service");

const OUT_DIR = path.join(__dirname, "../tmp_template_hybrid");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function buildModel() {
  return {
    profile: {
      name: "刘文博",
      title: "项目经理",
      department: "设备平台",
      workstation: "A-12",
      status: "online",
    },
    todo_summary: { text: "Open 1, next: 123123", count: 1 },
    schedule_summary: { text: "No schedule", count: 0 },
    weather: { city: "Shanghai", temp: "26", text: "Sunny", code: "100" },
    meta: {
      rendered_at: new Date().toISOString(),
      device_id: "debug-device",
      backend: "hybrid-test",
    },
    api: {
      formatted_by_slug: {
        xique_schedule: {
          formatted: {
            view: {
              todayCourseText: "1. 08:20-10:00\nPython自动化测试｜曲文鹏｜二教117",
            },
          },
        },
      },
    },
  };
}

function buildConfig(renderMode) {
  const cfg = homepageService.loadDefaultConfig();
  cfg.template = cfg.template || {};
  cfg.template.render_engine = renderMode === "legacy" ? "legacy" : "auto";
  cfg.template.render_mode = renderMode;
  cfg.template.debug = true;
  cfg.screen = cfg.screen || {};
  cfg.screen.width = 2560;
  cfg.screen.height = 1600;
  return homepageService.normalizeConfig(cfg);
}

const cases = [
  {
    name: "case1_legacy_only",
    mode: "hybrid",
    html: `
      <p data-x="120" data-y="160" data-size="108" data-weight="700" data-align="left">{{profile.name}}</p>
      <p data-x="120" data-y="360" data-size="52" data-weight="400" data-align="left">{{profile.department}} · {{profile.workstation}}</p>
    `,
  },
  {
    name: "case2_web_only",
    mode: "web",
    html: `
      <section style="padding: 64px 88px;">
        <h1 style="margin: 0 0 24px 0; font-size: 128px;">{{profile.name}}</h1>
        <p style="margin: 0 0 16px 0; font-size: 54px;">{{profile.title}}</p>
        <div style="display:flex; gap:24px; margin-top:42px;">
          <article style="padding:20px 26px; border:2px solid #000;">
            <h2 style="font-size:42px; margin:0 0 12px 0;">今日待办</h2>
            <p style="font-size:34px; margin:0;">{{todo_summary.text}}</p>
          </article>
          <article style="padding:20px 26px; border:2px solid #000;">
            <h2 style="font-size:42px; margin:0 0 12px 0;">今日课程</h2>
            <p style="font-size:34px; margin:0; white-space: pre-line;">{{api.formatted_by_slug.xique_schedule.formatted.view.todayCourseText}}</p>
          </article>
        </div>
      </section>
    `,
  },
  {
    name: "case3_hybrid_mix",
    mode: "hybrid",
    html: `
      <section style="padding: 70px 80px; width: 1500px;">
        <h1 style="margin:0; font-size: 132px;">{{profile.name}}</h1>
        <p style="font-size: 56px; margin: 24px 0 0 0;">{{profile.title}}</p>
      </section>
      <div data-x="1680" data-y="220" data-size="56" data-weight="700" data-width="760">Schedule</div>
      <div data-x="1680" data-y="320" data-size="42" data-width="760">{{schedule_summary.text}}</div>
      <div data-x="1680" data-y="560" data-size="56" data-weight="700" data-width="760">TODO</div>
      <div data-x="1680" data-y="660" data-size="42" data-width="760">{{todo_summary.text}}</div>
    `,
  },
  {
    name: "case4_script_dom",
    mode: "hybrid",
    html: `
      <div id="date-box" data-x="120" data-y="120" data-size="96" data-weight="700">loading...</div>
      <script>
        const iso = window.__PAGE_RESOLVE__("meta.rendered_at") || "";
        const hhmm = iso.length >= 16 ? iso.slice(11, 16) : "--:--";
        const el = document.getElementById("date-box");
        if (el) {
          el.textContent = "Now " + hhmm;
        }
      </script>
    `,
  },
];

async function run() {
  ensureDir(OUT_DIR);
  const model = buildModel();
  for (const item of cases) {
    const config = buildConfig(item.mode);
    const rendered = await renderPageBuffers({
      config,
      templateHtml: item.html,
      dataModel: model,
      pageType: "homepage",
    });

    const pngPath = path.join(OUT_DIR, `${item.name}.png`);
    const debugPath = path.join(OUT_DIR, `${item.name}.debug.json`);
    fs.writeFileSync(pngPath, rendered.pngBuffer);
    fs.writeFileSync(debugPath, JSON.stringify(rendered.debug || {}, null, 2), "utf8");
    console.log(`[ok] ${item.name} -> ${pngPath}`);
  }
}

run().catch((error) => {
  console.error("[fail] hybrid render test error:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
