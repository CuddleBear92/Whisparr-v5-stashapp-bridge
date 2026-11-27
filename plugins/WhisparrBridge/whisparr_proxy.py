#!/usr/bin/env python3
"""Relays one HTTP request from the Stash UI to the Whisparr v5 API.

Stash runs this script for each `runPluginOperation` call and sends a JSON
object on stdin:

    {"server_connection": {...}, "args": {
        "url": "http://whisparr:6969",   # base URL incl. any URL base
        "apiKey": "...",
        "method": "GET",
        "path": "/api/v5/performer/<id>",
        "body": "<JSON string>",          # optional
        "timeout": 30                     # optional, seconds
    }}

It prints {"output": {"status": <int>, "body": <parsed JSON or text>}}.
HTTP errors from Whisparr are returned the same way, so the UI can show
Whisparr's own validation messages. Only network/setup problems use "error".

With args {"mode": "syncTags"} (the "Sync Whisparr Watched tags" task) it
runs whisparr_tasks.sync_watched_tags instead.

Standard library only, so it runs on any Python 3 that Stash can find.
"""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request

ALLOWED_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}


def log(level, message):
    # Stash log-level prefix: SOH + level char + STX
    sys.stderr.write("\x01" + level + "\x02" + "[WhisparrBridge] " + message + "\n")
    sys.stderr.flush()


def respond(output=None, error=None):
    result = {"output": output}
    if error:
        result["error"] = error
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


def parse_body(raw):
    if not raw:
        return None
    text = raw.decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except ValueError:
        return text


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        respond(error="Invalid input from Stash: %s" % e)
        return

    args = payload.get("args") or {}
    hook = args.get("hookContext")
    if hook and "stash_ids" not in (hook.get("inputFields") or []):
        respond("no stash_ids change")  # most saves: nothing to do, return straight away
        return
    if hook:
        # Scene.Update.Post: runs inside Stash's save request, so it only queues work.
        import whisparr_import

        try:
            respond(whisparr_import.hook_scene_update(payload.get("server_connection") or {}, hook, log))
        except Exception as e:
            log("w", "Whisparr import hook: %s" % e)
            respond("hook skipped: %s" % e)
        return

    if args.get("mode") == "importScene":
        import whisparr_import
        import whisparr_tasks

        try:
            respond(
                whisparr_import.import_scene(
                    payload.get("server_connection") or {}, str(args.get("sceneId") or ""), log, whisparr_tasks.progress
                )
            )
        except Exception as e:
            log("e", "Import into Whisparr failed: %s" % e)
            respond(error="Import into Whisparr failed: %s" % e)
        return

    if args.get("mode") == "syncTags":
        import whisparr_tasks

        try:
            respond(whisparr_tasks.sync_watched_tags(payload.get("server_connection") or {}, log))
        except Exception as e:  # report any failure on the Tasks page / log
            log("e", "Tag sync failed: %s" % e)
            respond(error="Tag sync failed: %s" % e)
        return

    base = str(args.get("url") or "").rstrip("/")
    api_key = str(args.get("apiKey") or "")
    method = str(args.get("method") or "GET").upper()
    path = str(args.get("path") or "")
    body = args.get("body")
    try:
        timeout = float(args.get("timeout") or 30)
    except (TypeError, ValueError):
        timeout = 30.0

    if not base:
        respond(error="Whisparr host is not set in the plugin settings")
        return
    if urllib.parse.urlparse(base).scheme not in ("http", "https"):
        respond(error="Whisparr URL must start with http:// or https://")
        return
    if method not in ALLOWED_METHODS:
        respond(error="Unsupported method %s" % method)
        return
    # Only the Whisparr API may be reached through this relay.
    if not path.startswith("/api/") or ".." in path:
        respond(error="Refusing to relay path %s" % path)
        return

    data = None
    headers = {"Accept": "application/json", "X-Api-Key": api_key}
    if body is not None and body != "":
        if not isinstance(body, str):
            body = json.dumps(body)
        data = body.encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(base + path, data=data, method=method, headers=headers)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            respond({"status": response.status, "body": parse_body(response.read())})
    except urllib.error.HTTPError as e:
        respond({"status": e.code, "body": parse_body(e.read())})
    except urllib.error.URLError as e:
        log("w", "Could not reach Whisparr at %s: %s" % (base, e.reason))
        respond({"status": 0, "body": "Could not reach Whisparr at %s: %s" % (base, e.reason)})
    except Exception as e:  # timeouts, TLS errors, ...
        log("w", "Request to Whisparr failed: %s" % e)
        respond({"status": 0, "body": "Request to Whisparr failed: %s" % e})


if __name__ == "__main__":
    main()
