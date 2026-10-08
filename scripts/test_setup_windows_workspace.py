from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "setup_windows_workspace.ps1"


class SetupWindowsWorkspaceScriptTests(unittest.TestCase):
    def test_setup_script_documents_core_toolchain(self):
        text = SCRIPT.read_text(encoding="utf-8")

        self.assertIn("Node.js LTS", text)
        self.assertIn("Python 3.11", text)
        self.assertIn("PlatformIO", text)
        self.assertIn("ESP-IDF 4.4.7", text)
        self.assertIn("espressif32@6.5.0", text)

    def test_setup_script_has_dry_run_and_project_env_defaults(self):
        text = SCRIPT.read_text(encoding="utf-8")

        self.assertIn("[switch]$DryRun", text)
        self.assertIn("PORT=8890", text)
        self.assertIn("https://epd.gaoshanliuni.top:19999", text)
        self.assertIn("PLAYWRIGHT_BROWSERS_PATH", text)
        self.assertIn("pio run -e 4d_systems_esp32s3_gen4_r8n16", text)


if __name__ == "__main__":
    unittest.main()
