#!/usr/bin/env python3
"""Install, activate, update or remove the native New API FC plugin."""

import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


PLUGIN_KEY = "newapi_fc_gateway"
DEFAULT_SOURCE = Path(__file__).resolve().parents[1] / "dist" / "newapi-fc.plugin.js"


def api_request(args, method, path, body=None):
    headers = {"Authorization": f"Bearer {args.token}", "Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = Request(args.url.rstrip("/") + path, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            message = json.loads(raw).get("message", error.reason)
        except ValueError:
            message = error.reason
        raise RuntimeError(f"HTTP {error.code}: {message}") from None
    if not payload.get("success"):
        raise RuntimeError(payload.get("message") or "New API rejected the request")
    return payload.get("data")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "update", "remove"))
    parser.add_argument("--url", default=os.environ.get("NEW_API_URL"),
                        help="New API root URL; defaults to NEW_API_URL")
    parser.add_argument("--token", default=os.environ.get("NEW_API_ADMIN_TOKEN"),
                        help="Root management access token; defaults to NEW_API_ADMIN_TOKEN")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE,
                        help="Plugin source for install/update (default: dist/newapi-fc.plugin.js)")
    parser.add_argument("--version", help="Exact stored version to remove, e.g. 2.1.0")
    parser.add_argument("--enable-runtime", action="store_true",
                        help="Also enable New API's global plugin switch after upload")
    args = parser.parse_args()
    if not args.url or not args.token:
        parser.error("set NEW_API_URL and NEW_API_ADMIN_TOKEN, or pass --url and --token")
    if args.command == "remove" and (not args.version or args.enable_runtime):
        parser.error("remove requires --version and does not use --enable-runtime")

    try:
        if args.command == "remove":
            path = f"/api/plugin/task/{PLUGIN_KEY}/versions/{quote(args.version, safe='')}"
            api_request(args, "DELETE", path)
            print(f"Removed {PLUGIN_KEY}@{args.version}.")
        else:
            source = args.source.read_text(encoding="utf-8")
            method = "POST" if args.command == "install" else "PUT"
            result = api_request(args, method, "/api/plugin/task", {"source": source, "enabled": True})
            meta = result["meta"]
            if not result["plugin"]["active"]:
                api_request(args, "POST", f"/api/plugin/task/{meta['key']}/activate",
                            {"version": meta["version"]})
            print(f"Activated {meta['key']}@{meta['version']} ({args.command}).")
            if args.enable_runtime:
                api_request(args, "PUT", "/api/option/", {"key": "TaskPluginEnabled", "value": "true"})
                print("Global plugin switch enabled.")
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
