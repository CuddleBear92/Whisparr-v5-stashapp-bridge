"""Import a tagged Stash scene's file into Whisparr.

Flow, for a Stash scene that has an ID from Whisparr's stash-box:
  1. Find the scene in Whisparr by that ID; add it (and monitor it) if needed.
  2. Map the Stash file path to the path Whisparr sees (path mappings setting).
  3. Ask Whisparr's manual import about that file for that scene, using the
     download ID when the file is sitting in Activity > Queue.
  4. Run Whisparr's ManualImport command with "move", so Whisparr moves and
     renames the file like any other import, and wait for it.
  5. Map the new path back and start a Stash scan of that folder, so Stash
     follows the moved file (it keeps the scene, matched by fingerprint).

hook_scene_update runs inside Stash's save request, so it only does quick
checks and queues import_scene as a background Stash job.

Standard library only.
"""

import json
import os
import posixpath
import time
import urllib.parse

from whisparr_tasks import BOX_HOSTS, PLUGIN_ID, Stash, whisparr, whisparr_settings

TASK_LABEL = "Import scene into Whisparr"
COMMAND_TIMEOUT = 15 * 60
POLL_EVERY = 3


# ---------------------------------------------------------------------------
# Settings and paths
# ---------------------------------------------------------------------------


def plugin_settings(stash):
    return (stash.gql("query { configuration { plugins } }")["configuration"]["plugins"] or {}).get(PLUGIN_ID) or {}


def parse_mappings(text):
    """'stash prefix => whisparr prefix' per line. Returns [(stash, whisparr)]."""
    pairs = []
    for line in str(text or "").splitlines():
        if "=>" not in line:
            continue
        left, right = line.split("=>", 1)
        left, right = left.strip().rstrip("/\\"), right.strip().rstrip("/\\")
        if left and right:
            pairs.append((left, right))
    return pairs


def _swap(path, pairs, src, dst):
    best = None
    for pair in pairs:
        prefix = pair[src]
        norm = path.replace("\\", "/")
        pnorm = prefix.replace("\\", "/")
        if norm == pnorm or norm.startswith(pnorm + "/"):
            if best is None or len(pnorm) > len(best[src].replace("\\", "/")):
                best = pair
    if best is None:
        return path
    rest = path.replace("\\", "/")[len(best[src].replace("\\", "/")) :]
    out = best[dst] + rest
    # Keep Windows-style separators if the target prefix uses them.
    return out.replace("/", "\\") if "\\" in best[dst] else out


def to_whisparr(path, pairs):
    return _swap(path, pairs, 0, 1)


def to_stash(path, pairs):
    return _swap(path, pairs, 1, 0)


def box_ids(stash_ids, box):
    host = BOX_HOSTS[box]
    seen, out = set(), []
    for s in stash_ids or []:
        sid = s.get("stash_id")
        if sid and host in (s.get("endpoint") or "").lower() and sid.lower() not in seen:
            seen.add(sid.lower())
            out.append(sid)
    return out


def import_enabled(raw):
    return bool(raw.get("importOnTag"))


# ---------------------------------------------------------------------------
# Last result per scene, so the scene tab can show what happened to an import
# that ran in the background. Served to the UI as a plugin asset (state/).
# ---------------------------------------------------------------------------

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state")
RESULTS_FILE = os.path.join(STATE_DIR, "imports.json")
KEEP_RESULTS = 300


def record_result(scene_id, ok, message, log):
    if not scene_id:
        return
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        try:
            with open(RESULTS_FILE, "r", encoding="utf-8") as f:
                results = json.load(f)
        except (OSError, ValueError):
            results = {}
        results[str(scene_id)] = {"ok": bool(ok), "message": message, "time": int(time.time())}
        if len(results) > KEEP_RESULTS:
            newest = sorted(results.items(), key=lambda kv: kv[1].get("time", 0))[-KEEP_RESULTS:]
            results = dict(newest)
        tmp = RESULTS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(results, f)
        os.replace(tmp, RESULTS_FILE)
    except OSError as e:
        log("d", "Could not save the import result: %s" % e)


# ---------------------------------------------------------------------------
# Hook: runs inside Stash's save request, so keep it quick
# ---------------------------------------------------------------------------


def hook_scene_update(conn, hook, log):
    fields = hook.get("inputFields") or []
    if "stash_ids" not in fields:
        return "no stash_ids change"
    stash_ids = (hook.get("input") or {}).get("stash_ids") or []
    if not any(h in (s.get("endpoint") or "").lower() for s in stash_ids for h in BOX_HOSTS.values()):
        return "no stash-box ID"

    stash = Stash(conn)
    raw = plugin_settings(stash)
    if not import_enabled(raw):
        return "import on tag is off"
    box = "tpdb" if raw.get("useTpdb") else "stashdb"
    ids = box_ids(stash_ids, box)
    if not ids:
        return "no ID from Whisparr's stash-box"

    # Skip the job when Whisparr already has this scene's file.
    try:
        base, api_key = whisparr_settings(raw)
        for sid in ids:
            movie = whisparr(base, api_key, "GET", "/movie/" + urllib.parse.quote(sid), timeout=4, allow_404=True)
            if movie and movie.get("hasFile"):
                return "already imported in Whisparr"
    except Exception as e:  # unreachable Whisparr etc.: let the job report it properly
        log("d", "Quick Whisparr check failed, queueing the import anyway: %s" % e)

    scene_id = str(hook.get("id"))
    stash.gql(
        "mutation ($id: ID!, $desc: String, $args: Map) { runPluginTask(plugin_id: $id, description: $desc, args_map: $args) }",
        {"id": PLUGIN_ID, "desc": "%s (scene %s)" % (TASK_LABEL, scene_id), "args": {"mode": "importScene", "sceneId": scene_id}},
    )
    log("i", "Queued import into Whisparr for scene %s" % scene_id)
    return "queued"


# ---------------------------------------------------------------------------
# The import job
# ---------------------------------------------------------------------------


def ensure_movie(base, api_key, raw, sid, log):
    """The Whisparr scene for this ID, added (and monitored, if set) when missing."""
    monitor = raw.get("importMonitor") is not False
    movie = whisparr(base, api_key, "GET", "/movie/" + urllib.parse.quote(sid), allow_404=True)
    if movie and movie.get("id"):
        if monitor and not movie.get("monitored"):
            movie = whisparr(base, api_key, "PATCH", "/movie/%d" % movie["id"], {"monitored": True})
            log("i", "Monitored %s in Whisparr" % movie.get("title"))
        return movie

    results = whisparr(base, api_key, "GET", "/lookup/scene?term=" + urllib.parse.quote("stash:" + sid)) or []
    candidates = [r.get("movie") for r in results if r.get("movie")]
    found = next((m for m in candidates if (m.get("foreignId") or "").lower() == sid.lower()), None)
    if not found and len(candidates) == 1:
        found = candidates[0]
    if not found:
        raise RuntimeError("Whisparr could not find scene %s on its stash-box" % sid)

    roots = whisparr(base, api_key, "GET", "/rootfolder") or []
    profiles = whisparr(base, api_key, "GET", "/qualityprofile") or []
    root = raw.get("importRootFolder") or (roots[0]["path"] if roots else None)
    profile = int(raw.get("importQualityProfileId") or 0) or (profiles[0]["id"] if profiles else 0)
    if not root or not profile:
        raise RuntimeError("Whisparr needs a root folder and a quality profile before scenes can be added")

    body = dict(found)
    body.update(
        {
            "id": 0,
            "monitored": monitor,
            "rootFolderPath": root,
            "qualityProfileId": profile,
            "tags": body.get("tags") or [],
            "addOptions": {"monitored": monitor, "searchForMovie": False},
        }
    )
    whisparr(base, api_key, "POST", "/movie", body)
    movie = whisparr(base, api_key, "GET", "/movie/" + urllib.parse.quote(sid))
    log("i", "Added %s to Whisparr%s" % (movie.get("title"), " (monitored)" if monitor else ""))
    return movie


def _norm(path):
    return (path or "").replace("\\", "/").rstrip("/")


def _name(path):
    return posixpath.basename(_norm(path))


def queue_records(base, api_key):
    res = whisparr(base, api_key, "GET", "/queue?page=1&pageSize=2000&includeUnknownMovieItems=true") or {}
    return [r for r in res.get("records") or [] if r.get("outputPath")]


def queue_download_id(records, path):
    """downloadId of the Activity > Queue item for this (Whisparr-side) file: the item
    whose output is the file itself, else the one with the most specific folder.
    Single-file downloads often share one download folder, so a folder that merely
    contains the file says nothing on its own; it has to be the file or its own folder."""
    norm = _norm(path)
    best, best_len = None, -1
    for rec in records:
        out = _norm(rec.get("outputPath"))
        if not out or not rec.get("downloadId"):
            continue
        if norm == out:
            return rec["downloadId"]
        # A folder download is named after its folder; a single-file download that
        # sits in a shared download folder is named after its file, so it never matches here.
        title = (rec.get("title") or "").strip()
        if norm.startswith(out + "/") and title == _name(out) and len(out) > best_len:
            best, best_len = rec["downloadId"], len(out)
    return best


def queue_matches(stash_path, records):
    """Queue items that look like this file's download: the output (or its title) is the
    file itself or the folder it sits in."""
    file_name = _name(stash_path)
    stem = posixpath.splitext(file_name)[0]
    parent_name = _name(posixpath.dirname(_norm(stash_path)))
    out = []
    for rec in records:
        names = {_name(rec.get("outputPath")), (rec.get("title") or "").strip()}
        if names & {file_name, stem, parent_name} and rec.get("downloadId"):
            out.append(rec)
    return out


def path_candidates(stash_path, pairs, records):
    """Where Whisparr might see this file, most specific first: [(path, how)]."""
    out = []
    mapped = to_whisparr(stash_path, pairs)
    if mapped != stash_path:
        out.append((mapped, "path mappings"))
    # Whisparr's download folder, as listed in Activity > Queue: the Stash file is
    # either the queue item's output itself or inside a folder with the same name.
    file_name = _name(stash_path)
    parent_name = _name(posixpath.dirname(_norm(stash_path)))
    for rec in records:
        out_path = _norm(rec.get("outputPath"))
        name = _name(out_path)
        if name and name == parent_name:
            out.append((out_path + "/" + file_name, "Whisparr's download folder"))
        elif name and name == file_name:
            out.append((out_path, "Whisparr's download folder"))
    out.append((stash_path, "the same path as Stash"))
    seen, unique = set(), []
    for path, how in out:
        if path not in seen:
            seen.add(path)
            unique.append((path, how))
    return unique


def learned_pair(stash_path, whisparr_path):
    """The differing prefixes of two paths to the same file, e.g. ('/media/dl', '/downloads')."""
    a, b = _norm(stash_path).split("/"), _norm(whisparr_path).split("/")
    while a and b and a[-1] == b[-1]:
        a.pop()
        b.pop()
    if not a or not b or a == b:
        return None
    return ("/".join(a) or "/", "/".join(b) or "/")


def stash_folder_for(stash, whisparr_path, pairs, log):
    """The Stash-side folder of a Whisparr path, for the rescan. None when unknown."""
    folder = posixpath.dirname(_norm(whisparr_path))
    mapped = to_stash(folder, pairs)
    if mapped != folder:
        return mapped
    libraries = [
        _norm(s.get("path"))
        for s in (stash.gql("query { configuration { general { stashes { path } } } }")["configuration"]["general"]["stashes"] or [])
    ]
    # Same path in both (shared mounts)?
    for lib in libraries:
        if folder == lib or folder.startswith(lib + "/"):
            return folder
    # Otherwise match a library folder by name, e.g. Whisparr /synology/whisparr/Studio
    # and Stash library /data/whisparr -> /data/whisparr/Studio.
    parts = folder.split("/")
    for lib in libraries:
        name = _name(lib)
        if name and name in parts:
            idx = len(parts) - 1 - parts[::-1].index(name)
            return lib + "/" + "/".join(parts[idx + 1 :]) if idx + 1 < len(parts) else lib
    return None


def wait_for_command(base, api_key, command_id, log):
    deadline = time.time() + COMMAND_TIMEOUT
    while time.time() < deadline:
        cmd = whisparr(base, api_key, "GET", "/command/%d" % command_id)
        status = str(cmd.get("status") or "").lower()
        if status in ("completed", "failed", "aborted", "cancelled", "orphaned"):
            return status, cmd.get("message") or cmd.get("exception") or ""
        time.sleep(POLL_EVERY)
    return "timeout", "Whisparr did not finish the import within %d minutes" % (COMMAND_TIMEOUT // 60)


def queue_rescan(stash, scene_id, folder, file_name, old_path, log):
    """Queues a Stash scan of the folder Whisparr moved the file to, then a job that
    points the scene at the file's new path.

    Stash runs jobs one at a time, so this must not wait for the scan from inside a
    job (it would wait forever). Jobs run in order, so the relink job runs after
    the scan."""
    new_path = folder.rstrip("/\\") + ("\\" if "\\" in folder else "/") + file_name
    stash.gql("mutation ($input: ScanMetadataInput!) { metadataScan(input: $input) }", {"input": {"paths": [folder]}})
    stash.gql(
        "mutation ($id: ID!, $desc: String, $args: Map) { runPluginTask(plugin_id: $id, description: $desc, args_map: $args) }",
        {
            "id": PLUGIN_ID,
            "desc": "Point scene %s at its new file" % scene_id,
            "args": {"mode": "relinkScene", "sceneId": str(scene_id), "newPath": new_path, "oldPath": old_path, "folder": folder},
        },
    )
    log("i", "Queued a Stash scan of %s; scene %s is relinked after it" % (folder, scene_id))
    return "Stash is scanning %s and will then point the scene at %s" % (folder, new_path)


def relink_scene(conn, args, log):
    """Runs after the scan: makes sure the Stash scene uses the file at its new path."""
    stash = Stash(conn)
    scene_id, new_path = str(args.get("sceneId") or ""), str(args.get("newPath") or "")
    old_path, folder = str(args.get("oldPath") or ""), str(args.get("folder") or "")
    scene = stash.gql("query ($id: ID!) { findScene(id: $id) { files { id path } } }", {"id": scene_id})["findScene"]
    files = (scene or {}).get("files") or []
    match = next((f for f in files if _norm(f["path"]) == _norm(new_path)), None)
    if match is None:
        log("w", "After scanning %s, scene %s still has: %s" % (folder, scene_id, ", ".join(f["path"] for f in files)))
        raise RuntimeError(
            "Whisparr imported the file, but after scanning %s the Stash scene still points at %s. Check that this "
            "folder is inside one of Stash's library paths, or add a path mapping for Whisparr's root folder"
            % (folder, files[0]["path"] if files else old_path)
        )
    if files and files[0]["id"] != match["id"]:
        # Whisparr copied or hardlinked (e.g. a download still seeding), so Stash
        # added the new path as a second file: make it the scene's main file.
        stash.gql(
            "mutation ($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
            {"input": {"id": scene_id, "primary_file_id": match["id"]}},
        )
        log("i", "Made %s the main file of scene %s" % (new_path, scene_id))
        return "Imported into Whisparr; Stash now uses %s as the scene's main file (the old copy at %s is still there)" % (
            new_path,
            old_path,
        )
    log("i", "Scene %s now points at %s" % (scene_id, new_path))
    return "Imported into Whisparr; Stash now points at %s" % new_path


def import_scene(conn, scene_id, log, progress):
    stash = Stash(conn)
    raw = plugin_settings(stash)
    base, api_key = whisparr_settings(raw)
    box = "tpdb" if raw.get("useTpdb") else "stashdb"
    pairs = parse_mappings(raw.get("importPathMappings"))

    scene = stash.gql(
        "query ($id: ID!) { findScene(id: $id) { id title files { path } stash_ids { endpoint stash_id } } }",
        {"id": scene_id},
    )["findScene"]
    if not scene:
        raise RuntimeError("Stash scene %s not found" % scene_id)
    if not scene.get("files"):
        raise RuntimeError("Stash scene %s has no file" % scene_id)
    ids = box_ids(scene.get("stash_ids"), box)
    if not ids:
        raise RuntimeError("Scene %s has no ID from Whisparr's stash-box" % scene_id)
    if len(ids) > 1:
        log("w", "Scene %s has %d IDs from Whisparr's stash-box; importing the file for the first one" % (scene_id, len(ids)))

    progress(0.1)
    movie = ensure_movie(base, api_key, raw, ids[0], log)
    if movie.get("hasFile"):
        return "Whisparr already has a file for %s; nothing imported" % movie.get("title")

    stash_path = scene["files"][0]["path"]
    progress(0.25)

    # Find the file as Whisparr sees it. First through its queue item (Whisparr lists
    # that download's files itself, so no path guessing), then by path.
    records = queue_records(base, api_key)
    path = item = None
    download_id = None
    tried = []
    file_name = _name(stash_path)
    for rec in queue_matches(stash_path, records):
        tried.append("download " + str(rec.get("title") or rec.get("downloadId")))
        items = whisparr(
            base,
            api_key,
            "GET",
            "/manualimport?downloadId=%s&movieId=%d&filterExistingFiles=false" % (urllib.parse.quote(rec["downloadId"]), movie["id"]),
        ) or []
        # Only the exact same file name: many downloads can share a folder, so a
        # download's only file is not necessarily this one.
        found = next((i for i in items if _name(i.get("path")) == file_name), None)
        if found is not None:
            path, item, download_id = found.get("path"), found, rec["downloadId"]
            log("i", "Found the file in Whisparr's queue: %s (download %s)" % (path, rec.get("title")))
            break
    candidates = [] if item is not None else path_candidates(stash_path, pairs, records)
    for candidate, how in candidates:
        tried.append(candidate)
        items = whisparr(
            base,
            api_key,
            "GET",
            "/manualimport?folder=%s&movieId=%d&filterExistingFiles=false" % (urllib.parse.quote(candidate), movie["id"]),
        ) or []
        found = next((i for i in items if _norm(i.get("path")) == _norm(candidate)), None)
        if found is None and len(items) == 1:
            found = items[0]
        if found is not None:
            path, item = candidate, found
            log("i", "Whisparr sees the file as %s (found via %s)" % (path, how))
            break
    if item is None:
        raise RuntimeError(
            "Whisparr can't see the file. Stash has it at %s; tried: %s. If Whisparr sees that folder under another path, "
            "add it in Settings > Plugins > Whisparr Bridge > Import tagged scenes > Edit > Path mappings, "
            "e.g. '%s => /path/as/whisparr/sees/it'."
            % (stash_path, ", ".join(tried) or "nothing", posixpath.dirname(_norm(stash_path)))
        )
    pair = learned_pair(stash_path, path)
    if pair and pair not in pairs:
        pairs = pairs + [pair]
    download_id = download_id or queue_download_id(records, path)
    log("i", "Importing %s as %s%s" % (path, movie.get("title"), " (download %s)" % download_id if download_id else ""))

    # Re-check the file against this scene (quality, upgrade rules, ...).
    checked = whisparr(
        base,
        api_key,
        "POST",
        "/manualimport",
        [
            {
                "path": item["path"],
                "movieId": movie["id"],
                "downloadId": download_id or item.get("downloadId"),
                "releaseGroup": item.get("releaseGroup"),
                "quality": item.get("quality"),
                "languages": item.get("languages") or [],
                "indexerFlags": item.get("indexerFlags") or 0,
            }
        ],
    ) or [item]
    final = checked[0]
    blocking = [r.get("reason") for r in final.get("rejections") or [] if str(r.get("type", "")).lower() == "permanent"]
    if blocking:
        raise RuntimeError("Whisparr won't import %s: %s" % (path, "; ".join(blocking)))

    progress(0.4)
    command = whisparr(
        base,
        api_key,
        "POST",
        "/command",
        {
            "name": "ManualImport",
            "importMode": "move",
            "files": [
                {
                    "path": final.get("path") or item["path"],
                    "movieId": movie["id"],
                    "quality": final.get("quality") or item.get("quality"),
                    "languages": final.get("languages") or item.get("languages") or [],
                    "releaseGroup": final.get("releaseGroup") or item.get("releaseGroup"),
                    "indexerFlags": final.get("indexerFlags") or 0,
                    "downloadId": download_id or final.get("downloadId") or item.get("downloadId"),
                }
            ],
        },
    )
    status, message = wait_for_command(base, api_key, command["id"], log)
    if status != "completed":
        raise RuntimeError("Whisparr's import %s: %s" % (status, message))
    progress(0.8)

    movie = whisparr(base, api_key, "GET", "/movie/%d" % movie["id"])
    new_path = ((movie.get("movieFile") or {}).get("path")) or ""
    if not movie.get("hasFile") or not new_path:
        raise RuntimeError("Whisparr finished, but %s still has no file. See Whisparr's log." % movie.get("title"))
    log("i", "Whisparr imported it to %s" % new_path)

    scanned = ""
    if raw.get("importRescan") is not False:
        folder = stash_folder_for(stash, new_path, pairs, log)
        if folder:
            scanned = "; " + queue_rescan(stash, scene_id, folder, _name(new_path), stash_path, log)
        else:
            scanned = "; couldn't work out where Stash sees %s, so no scan was started (add a path mapping)" % new_path
            log("w", "No Stash folder found for %s; add a path mapping for Whisparr's root folder" % new_path)
    progress(1.0)
    return "Imported %s into Whisparr as %s%s" % (stash_path, movie.get("title"), scanned)
