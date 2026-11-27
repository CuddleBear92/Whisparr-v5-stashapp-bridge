"""Library-wide jobs for the Whisparr Bridge plugin, run from Stash's Tasks page.

sync_watched_tags: puts the "Whisparr Watched" tag (name configurable) on every
Stash performer, studio and scene that is monitored in Whisparr, and takes it
off the ones that are not. Items are matched by their Stash ID from the
stash-box Whisparr uses (StashDB or ThePornDB).

Standard library only.
"""

import json
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

PLUGIN_ID = "WhisparrBridge"
DEFAULT_TAG = "Whisparr Watched"
STASH_PAGE = 500
WHISPARR_PAGE = 1000
UPDATE_CHUNK = 250
BOX_HOSTS = {"stashdb": "stashdb.org", "tpdb": "theporndb.net"}


def progress(fraction):
    sys.stderr.write("\x01p\x02%0.3f\n" % max(0.0, min(1.0, fraction)))
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# Stash
# ---------------------------------------------------------------------------


class Stash:
    def __init__(self, conn):
        scheme = conn.get("Scheme") or "http"
        host = conn.get("Host") or "localhost"
        if host in ("0.0.0.0", "::", "[::]"):
            host = "localhost"
        if ":" in host and not host.startswith("["):
            host = "[%s]" % host
        self.url = "%s://%s:%s/graphql" % (scheme, host, conn.get("Port") or 9999)
        cookie = conn.get("SessionCookie") or {}
        self.headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if cookie.get("Name"):
            self.headers["Cookie"] = "%s=%s" % (cookie["Name"], cookie.get("Value", ""))
        # Stash is on this machine; a self-signed certificate is normal there.
        self.ctx = ssl._create_unverified_context() if scheme == "https" else None

    def gql(self, query, variables=None):
        data = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
        req = urllib.request.Request(self.url, data=data, headers=self.headers, method="POST")
        with urllib.request.urlopen(req, timeout=120, context=self.ctx) as res:
            body = json.loads(res.read().decode("utf-8"))
        if body.get("errors"):
            raise RuntimeError("; ".join(e.get("message", str(e)) for e in body["errors"]))
        return body["data"]

    def all(self, kind):
        """Yields every performer/studio/scene as {id, stash_ids, tags}."""
        query = (
            "query ($filter: FindFilterType) { find%s(filter: $filter) { count %s { id stash_ids { endpoint stash_id } tags { id } } } }"
            % (kind.capitalize() + "s", kind + "s")
        )
        page = 1
        while True:
            data = self.gql(query, {"filter": {"page": page, "per_page": STASH_PAGE}})["find%ss" % kind.capitalize()]
            items = data[kind + "s"]
            for item in items:
                yield item
            if not items or page * STASH_PAGE >= data["count"]:
                return
            page += 1


# ---------------------------------------------------------------------------
# Whisparr
# ---------------------------------------------------------------------------


def whisparr_settings(raw):
    host = str(raw.get("whisparrHost") or "").strip().rstrip("/")
    if not host:
        raise RuntimeError("Whisparr host is not set in the plugin settings")
    if not host.lower().startswith(("http://", "https://")):
        host = "http://" + host
    u = urllib.parse.urlsplit(host)
    port = int(raw.get("whisparrPort") or 0)
    netloc = u.hostname if ":" not in (u.hostname or "") else "[%s]" % u.hostname
    if port:
        netloc += ":%d" % port
    elif u.port:
        netloc += ":%d" % u.port
    elif u.scheme == "http":
        netloc += ":6969"
    url_base = str(raw.get("whisparrUrlBase") or "").strip().rstrip("/")
    if url_base and not url_base.startswith("/"):
        url_base = "/" + url_base
    base = "%s://%s%s%s" % (u.scheme, netloc, u.path.rstrip("/"), url_base)
    api_key = str(raw.get("whisparrApiKey") or "").strip()
    if not api_key:
        raise RuntimeError("Whisparr API key is not set in the plugin settings")
    return base, api_key


def whisparr(base, api_key, method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json", "X-Api-Key": api_key}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + "/api/v5" + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return json.loads(res.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError("Whisparr answered %s %s with HTTP %d %s" % (method, path, e.code, detail))
    except urllib.error.URLError as e:
        raise RuntimeError("Could not reach Whisparr at %s: %s" % (base, e.reason))


def monitored_paged(base, api_key, resource, label, log):
    """foreignIds of monitored items, using Whisparr's paged, filtered endpoint.

    Asking only for monitored items matters: Whisparr v5 also keeps every
    performer seen in a scene (hidden), so the full lists can be huge.
    """
    ids = set()
    page = 1
    while True:
        res = whisparr(
            base,
            api_key,
            "POST",
            resource + "/paged",
            {
                "page": page,
                "pageSize": WHISPARR_PAGE,
                "filters": [{"key": "monitored", "type": "equal", "value": True}],
            },
        )
        records = res.get("records") or []
        for m in records:
            if m.get("monitored") and m.get("foreignId"):
                ids.add(m["foreignId"].lower())
        total = res.get("totalRecords") or 0
        if page == 1 or page % 10 == 0:
            log("i", "Whisparr %s: read %d of %d monitored" % (label, min(page * WHISPARR_PAGE, total), total))
        if not records or page * WHISPARR_PAGE >= total:
            return ids
        page += 1


def monitored_ids(base, api_key, log):
    result = {}
    for kind, resource, label in (
        ("performer", "/performer", "performers"),
        ("studio", "/studio", "studios"),
        ("scene", "/movie", "scenes/movies"),
    ):
        result[kind] = monitored_paged(base, api_key, resource, label, log)
    log(
        "i",
        "Whisparr monitors %d performers, %d studios and %d scenes/movies"
        % (len(result["performer"]), len(result["studio"]), len(result["scene"])),
    )
    return result


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------


def find_tag(stash, name, create):
    data = stash.gql(
        "query ($name: String!) { findTags(filter: { per_page: -1 }, tag_filter: { name: { value: $name, modifier: EQUALS } }) { tags { id name ignore_auto_tag } } }",
        {"name": name},
    )
    for t in data["findTags"]["tags"]:
        if t["name"].lower() == name.lower():
            # Auto Tag must never put this tag on anything: only the plugin manages it.
            if not t.get("ignore_auto_tag"):
                stash.gql(
                    "mutation ($input: TagUpdateInput!) { tagUpdate(input: $input) { id } }",
                    {"input": {"id": t["id"], "ignore_auto_tag": True}},
                )
            return t["id"]
    if not create:
        return None
    created = stash.gql(
        "mutation ($input: TagCreateInput!) { tagCreate(input: $input) { id } }",
        {
            "input": {
                "name": name,
                "ignore_auto_tag": True,
                "description": "Monitored in Whisparr. Managed by the Whisparr Bridge plugin.",
            }
        },
    )
    return created["tagCreate"]["id"]


def bulk_tag(stash, kind, ids, tag_id, mode, existing_tags):
    """Adds or removes the tag on many items, in chunks."""
    mutation = {
        "performer": ("bulkPerformerUpdate", "BulkPerformerUpdateInput"),
        "studio": ("bulkStudioUpdate", "BulkStudioUpdateInput"),
        "scene": ("bulkSceneUpdate", "BulkSceneUpdateInput"),
    }[kind]
    query = "mutation ($input: %s!) { %s(input: $input) { id } }" % (mutation[1], mutation[0])
    for i in range(0, len(ids), UPDATE_CHUNK):
        chunk = ids[i : i + UPDATE_CHUNK]
        try:
            stash.gql(query, {"input": {"ids": chunk, "tag_ids": {"ids": [tag_id], "mode": mode}}})
        except RuntimeError as e:
            if kind != "studio" or "bulkStudioUpdate" not in str(e):
                raise
            # Older Stash versions have no bulkStudioUpdate: set each studio's full tag list.
            for sid in chunk:
                tags = set(existing_tags.get(sid, []))
                if mode == "ADD":
                    tags.add(tag_id)
                else:
                    tags.discard(tag_id)
                stash.gql(
                    "mutation ($input: StudioUpdateInput!) { studioUpdate(input: $input) { id } }",
                    {"input": {"id": sid, "tag_ids": sorted(tags)}},
                )


def sync_watched_tags(conn, log):
    stash = Stash(conn)
    raw = (stash.gql("query { configuration { plugins } }")["configuration"]["plugins"] or {}).get(PLUGIN_ID) or {}
    if raw.get("disableWatchedTag"):
        log("w", "The Whisparr Watched tag is turned off in the plugin settings; nothing to do")
        return "Tag management is turned off in the plugin settings"

    tag_name = str(raw.get("watchedTagName") or "").strip() or DEFAULT_TAG
    box = "tpdb" if raw.get("useTpdb") else "stashdb"
    host = BOX_HOSTS[box]
    base, api_key = whisparr_settings(raw)

    log("i", "Reading monitored items from Whisparr at %s" % base)
    progress(0.02)
    watched = monitored_ids(base, api_key, log)
    progress(0.15)

    tag_id = find_tag(stash, tag_name, create=False)
    summary = []
    kinds = ["performer", "studio", "scene"]
    for n, kind in enumerate(kinds):
        log("i", "Checking Stash %ss" % kind)
        add, remove, tags_by_id = [], [], {}
        seen = 0
        for item in stash.all(kind):
            seen += 1
            if seen % 5000 == 0:
                log("i", "Stash %ss: %d checked so far" % (kind, seen))
            tags = [t["id"] for t in item.get("tags") or []]
            tags_by_id[item["id"]] = tags
            sid = next(
                (s["stash_id"] for s in item.get("stash_ids") or [] if host in (s.get("endpoint") or "").lower()),
                None,
            )
            should = bool(sid) and sid.lower() in watched[kind]
            has = tag_id is not None and tag_id in tags
            if should and not has:
                add.append(item["id"])
            elif has and not should:
                remove.append(item["id"])

        if add and tag_id is None:
            tag_id = find_tag(stash, tag_name, create=True)
            log("i", 'Created tag "%s"' % tag_name)
        if add:
            bulk_tag(stash, kind, add, tag_id, "ADD", tags_by_id)
        if remove:
            bulk_tag(stash, kind, remove, tag_id, "REMOVE", tags_by_id)

        line = "%ss: %d checked, %d tagged, %d untagged" % (kind.capitalize(), seen, len(add), len(remove))
        log("i", line)
        summary.append(line)
        progress(0.15 + 0.85 * (n + 1) / len(kinds))

    return 'Whisparr Watched tag sync done ("%s"). %s' % (tag_name, "; ".join(summary))
