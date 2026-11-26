"""Run the management CLI against New API's HTTP contract."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "manage-plugin.py"
KEY = "newapi_fc_gateway"
VERSION = "2.1.0"


def uploaded(active=True):
    return {"success": True, "data": {
        "meta": {"key": KEY, "version": VERSION},
        "plugin": {"active": active, "enabled": True},
    }}


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.replies = []
        calls, replies = self.calls, self.replies

        class Handler(BaseHTTPRequestHandler):
            def handle_request(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                calls.append((self.command, self.path, dict(self.headers),
                              json.loads(raw) if raw else None))
                status, reply = replies.pop(0) if replies else (200, uploaded())
                payload = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_POST = do_PUT = do_DELETE = handle_request

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.temp = tempfile.TemporaryDirectory(prefix=".test-manage-", dir=ROOT)
        self.source = Path(self.temp.name) / "plugin.js"
        self.source.write_text('export const meta = {name: "正文输出"};\n', encoding="utf-8")
        self.env = {**os.environ,
                    "NEW_API_URL": f"http://127.0.0.1:{self.server.server_port}",
                    "NEW_API_ADMIN_TOKEN": "admin-test-secret"}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def run_cli(self, command, *args, script=SCRIPT):
        return subprocess.run([sys.executable, str(script), command, *args],
                              env=self.env, text=True, capture_output=True, timeout=10)

    def paths(self):
        return [(call[0], call[1]) for call in self.calls]

    def test_install_uploads_utf8_source_with_root_credentials(self):
        result = self.run_cli("install", "--source", str(self.source))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.paths(), [("POST", "/api/plugin/task")])
        _, _, headers, body = self.calls[0]
        self.assertEqual(headers["Authorization"], "Bearer admin-test-secret")
        self.assertEqual(body, {"source": self.source.read_text(encoding="utf-8"), "enabled": True})
        self.assertIn(KEY + "@" + VERSION, result.stdout)
        self.assertNotIn("admin-test-secret", result.stdout + result.stderr)

    def test_pending_uploaded_version_is_activated_before_success(self):
        self.replies.append((200, uploaded(active=False)))
        result = self.run_cli("install", "--source", str(self.source))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.paths(), [
            ("POST", "/api/plugin/task"),
            ("POST", f"/api/plugin/task/{KEY}/activate"),
        ])
        self.assertEqual(self.calls[1][3], {"version": VERSION})

    def test_update_activates_then_explicitly_enables_runtime(self):
        self.replies.append((200, uploaded(active=False)))
        result = self.run_cli("update", "--source", str(self.source), "--enable-runtime")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.paths(), [
            ("PUT", "/api/plugin/task"),
            ("POST", f"/api/plugin/task/{KEY}/activate"),
            ("PUT", "/api/option/"),
        ])
        self.assertEqual(self.calls[2][3], {"key": "TaskPluginEnabled", "value": "true"})

    def test_activation_failure_stops_without_enabling_runtime_or_retrying(self):
        self.replies.extend([
            (200, uploaded(active=False)),
            (200, {"success": False, "message": "activation rejected"}),
        ])
        result = self.run_cli("update", "--source", str(self.source), "--enable-runtime")
        self.assertEqual(result.returncode, 1)
        self.assertIn("activation rejected", result.stderr)
        self.assertEqual(self.paths(), [
            ("PUT", "/api/plugin/task"),
            ("POST", f"/api/plugin/task/{KEY}/activate"),
        ])

    def test_default_source_is_the_distributed_plugin_relative_to_script(self):
        project = Path(self.temp.name) / "project"
        (project / "scripts").mkdir(parents=True)
        (project / "dist").mkdir()
        script = project / "scripts" / SCRIPT.name
        shutil.copyfile(SCRIPT, script)
        content = 'export const meta = {key: "newapi_fc_gateway"};\n'
        (project / "dist" / "newapi-fc.plugin.js").write_text(content, encoding="utf-8")
        result = self.run_cli("install", script=script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.calls[0][3]["source"], content)

    def test_remove_deletes_only_the_explicit_plugin_version(self):
        result = self.run_cli("remove", "--version", VERSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.paths(), [("DELETE", f"/api/plugin/task/{KEY}/versions/{VERSION}")])
        self.assertIsNone(self.calls[0][3])

    def test_remove_requires_version_before_sending_any_request(self):
        result = self.run_cli("remove")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--version", result.stderr)
        self.assertEqual(self.calls, [])

    def test_http_error_reports_server_message_without_retrying(self):
        self.replies.append((403, {"success": False, "message": "insufficient privileges"}))
        result = self.run_cli("install", "--source", str(self.source))
        self.assertEqual(result.returncode, 1)
        self.assertIn("HTTP 403: insufficient privileges", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(len(self.calls), 1)

    def test_missing_token_stops_before_sending_any_request(self):
        self.env.pop("NEW_API_ADMIN_TOKEN")
        result = self.run_cli("install", "--source", str(self.source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("NEW_API_ADMIN_TOKEN", result.stderr)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
