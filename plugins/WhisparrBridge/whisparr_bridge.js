/* Whisparr Bridge — Stash UI plugin for Whisparr v5.
 *
 * Adds a Whisparr panel to performer and studio pages and a Whisparr tab to
 * scene pages. Items are matched by their Stash ID from the stash-box that
 * Whisparr uses (StashDB or ThePornDB). All requests go through
 * whisparr_proxy.py on the Stash server via the runPluginOperation mutation.
 */
(function () {
  "use strict";

  const PLUGIN_ID = "WhisparrBridge";
  const API = "/api/v5";

  const PluginApi = window.PluginApi;
  const React = PluginApi.React;
  const { Fragment, useState, useEffect, useCallback, useMemo } = React;
  const h = React.createElement;
  const Bootstrap = PluginApi.libraries.Bootstrap;
  const { Button, Form, Spinner, Nav, Tab } = Bootstrap;

  const STASH_BOXES = {
    stashdb: { label: "StashDB", host: "stashdb.org", whisparrName: "stashdb" },
    tpdb: { label: "ThePornDB", host: "theporndb.net", whisparrName: "tpdb" },
  };

  // ---------------------------------------------------------------------------
  // Stash GraphQL helpers
  // ---------------------------------------------------------------------------

  async function stashGql(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors && json.errors.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }
    return json.data;
  }

  let settingsPromise = null;

  // Re-read on every page change so edits on the settings page apply without a reload.
  function loadSettings(force) {
    if (!settingsPromise || force) {
      settingsPromise = stashGql("query { configuration { plugins } }")
        .then((data) => normaliseSettings((data.configuration.plugins || {})[PLUGIN_ID] || {}))
        .catch((err) => {
          settingsPromise = null;
          throw err;
        });
    }
    return settingsPromise;
  }

  function normaliseSettings(raw) {
    let host = String(raw.whisparrHost || "").trim().replace(/\/+$/, "");
    const port = Number(raw.whisparrPort) || 0;
    let urlBase = String(raw.whisparrUrlBase || "").trim().replace(/\/+$/, "");
    if (urlBase && !urlBase.startsWith("/")) urlBase = "/" + urlBase;

    let baseUrl = "";
    if (host) {
      if (!/^https?:\/\//i.test(host)) host = "http://" + host;
      try {
        const u = new URL(host);
        if (port) u.port = String(port);
        else if (!u.port && u.protocol === "http:") u.port = "6969";
        baseUrl = u.origin + (u.pathname.replace(/\/+$/, "") || "") + urlBase;
      } catch (e) {
        baseUrl = "";
      }
    }

    const publicUrl = String(raw.whisparrPublicUrl || "").trim().replace(/\/+$/, "") || baseUrl;

    return {
      baseUrl,
      publicUrl,
      apiKey: String(raw.whisparrApiKey || "").trim(),
      box: raw.useTpdb ? "tpdb" : "stashdb",
      yearPreset: String(raw.yearPreset || "").trim(),
      yearPresetUnmonitorOthers: !!raw.yearPresetUnmonitorOthers,
      yearPresetMonitorItem: !!raw.yearPresetMonitorItem,
      disabled: {
        performer: !!raw.disablePerformers,
        studio: !!raw.disableStudios,
        scene: !!raw.disableScenes,
      },
    };
  }

  PluginApi.Event.addEventListener("stash:location", () => {
    settingsPromise = null;
  });

  // ---------------------------------------------------------------------------
  // Whisparr API (through the Python relay)
  // ---------------------------------------------------------------------------

  class WhisparrError extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  function describeError(status, body) {
    if (Array.isArray(body) && body.length && body[0].errorMessage) {
      // FluentValidation errors
      return body.map((e) => (e.propertyName ? e.propertyName + ": " : "") + e.errorMessage).join("\n");
    }
    if (body && typeof body === "object" && body.message) return body.message;
    if (typeof body === "string" && body) return body;
    if (status === 401) return "Whisparr rejected the API key (401)";
    return "Whisparr answered with HTTP " + status;
  }

  async function whisparr(settings, method, path, body) {
    const data = await stashGql(
      "mutation ($plugin_id: ID!, $args: Map) { runPluginOperation(plugin_id: $plugin_id, args: $args) }",
      {
        plugin_id: PLUGIN_ID,
        args: {
          url: settings.baseUrl,
          apiKey: settings.apiKey,
          method,
          path: API + path,
          body: body === undefined ? "" : JSON.stringify(body),
        },
      }
    );
    const out = data.runPluginOperation;
    if (!out || typeof out !== "object") {
      throw new WhisparrError("No response from the plugin relay. Is Python available to Stash?", 0, out);
    }
    if (out.status >= 200 && out.status < 300) return out.body;
    throw new WhisparrError(describeError(out.status, out.body), out.status, out.body);
  }

  // Root folders, quality profiles and tags rarely change; keep them for a minute.
  const metaCache = {};
  function cachedGet(settings, path) {
    const key = settings.baseUrl + path;
    const hit = metaCache[key];
    if (hit && Date.now() - hit.at < 60000) return hit.promise;
    const promise = whisparr(settings, "GET", path).catch((err) => {
      delete metaCache[key];
      throw err;
    });
    metaCache[key] = { at: Date.now(), promise };
    return promise;
  }

  function loadMeta(settings) {
    return Promise.all([
      cachedGet(settings, "/qualityprofile"),
      cachedGet(settings, "/rootfolder"),
      cachedGet(settings, "/tag"),
      cachedGet(settings, "/config/metadatasource").catch(() => null),
    ]).then(([profiles, rootFolders, tags, source]) => ({ profiles, rootFolders, tags, source }));
  }

  // ---------------------------------------------------------------------------
  // Item kinds
  // ---------------------------------------------------------------------------

  const KINDS = {
    performer: {
      label: "performer",
      resource: "/performer",
      lookup: "/lookup/performer",
      lookupKey: "performer",
      whisparrPath: (item) => "/performer/" + item.foreignId,
      name: (item) => item.fullName || item.name,
      searchCommand: (item) => ({ name: "PerformersSearch", performerIds: [item.id] }),
      refreshCommand: (item) => ({ name: "RefreshPerformers", performerIds: [item.id] }),
      // A hidden performer was only pulled in alongside another one; Whisparr
      // makes it visible again when it is added.
      exists: (item) => item && item.visibility !== "hidden",
      hasChildren: true,
      worksPath: (item) => "/performer/" + encodeURIComponent(item.foreignId) + "/works",
      deleteWarning:
        "This removes the performer and every scene/movie Whisparr has for them.",
    },
    studio: {
      label: "studio",
      resource: "/studio",
      lookup: "/lookup/studio",
      lookupKey: "studio",
      whisparrPath: (item) => "/studio/" + item.foreignId,
      name: (item) => item.title,
      searchCommand: (item) => ({ name: "StudiosSearch", studioIds: [item.id] }),
      refreshCommand: (item) => ({ name: "RefreshStudios", studioIds: [item.id] }),
      exists: (item) => !!item,
      hasChildren: true,
      worksPath: (item) => "/studio/" + encodeURIComponent(item.foreignId) + "/works",
      deleteWarning: "This removes the studio and every scene/movie Whisparr has for it.",
    },
    scene: {
      label: "scene",
      resource: "/movie",
      lookup: "/lookup/scene",
      lookupKey: "movie",
      whisparrPath: (item) => "/movie/" + item.foreignId,
      name: (item) => item.title,
      searchCommand: (item) => ({ name: "MoviesSearch", movieIds: [item.id] }),
      refreshCommand: (item) => ({ name: "RefreshMovie", movieIds: [item.id] }),
      exists: (item) => !!item,
      hasChildren: false,
      deleteWarning: "This removes the scene from Whisparr.",
    },
  };

  function findStashId(entity, box) {
    const host = STASH_BOXES[box].host;
    const match = (entity.stash_ids || []).find((s) => (s.endpoint || "").toLowerCase().includes(host));
    return match ? match.stash_id : null;
  }

  // ---------------------------------------------------------------------------
  // Small UI helpers
  // ---------------------------------------------------------------------------

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  }

  function Pill({ on, children, title }) {
    return h("span", { className: "wb-pill " + (on ? "wb-pill-on" : "wb-pill-off"), title }, children);
  }

  function Row({ label, children }) {
    return h("div", { className: "wb-row" }, h("span", { className: "wb-label" }, label), h("span", { className: "wb-value" }, children));
  }

  function Switch({ id, label, checked, onChange, disabled, help }) {
    return h(
      Form.Group,
      { className: "wb-switch" },
      h(Form.Check, {
        type: "switch",
        id,
        label,
        checked: !!checked,
        disabled,
        onChange: (e) => onChange(e.target.checked),
      }),
      help ? h(Form.Text, { className: "text-muted" }, help) : null
    );
  }

  let fieldSeq = 0;
  function useFieldId(prefix) {
    const [id] = useState(() => "wb-" + prefix + "-" + ++fieldSeq);
    return id;
  }

  function Select({ label, value, options, onChange }) {
    const id = useFieldId("select");
    return h(
      Form.Group,
      { controlId: id },
      h(Form.Label, null, label),
      h(
        Form.Control,
        { as: "select", size: "sm", value: value == null ? "" : value, onChange: (e) => onChange(e.target.value) },
        options.map((o) => h("option", { key: o.value, value: o.value }, o.label))
      )
    );
  }

  function TagPicker({ tags, value, onChange }) {
    const selected = new Set(value || []);
    if (!tags.length) return null;
    return h(
      Form.Group,
      { role: "group", "aria-label": "Whisparr tags" },
      h(Form.Label, { as: "div" }, "Whisparr tags"),
      h(
        "div",
        { className: "wb-tags" },
        tags.map((t) =>
          h(
            "button",
            {
              type: "button",
              key: t.id,
              className: "wb-tag " + (selected.has(t.id) ? "wb-tag-on" : ""),
              "aria-pressed": selected.has(t.id),
              onClick: () => {
                const next = new Set(selected);
                if (next.has(t.id)) next.delete(t.id);
                else next.add(t.id);
                onChange(Array.from(next));
              },
            },
            t.label
          )
        )
      )
    );
  }

  function remember(key, value) {
    try {
      localStorage.setItem("whisparrBridge." + key, JSON.stringify(value));
    } catch (e) {
      /* ignore */
    }
  }

  function recall(key, fallback) {
    try {
      const v = localStorage.getItem("whisparrBridge." + key);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // Forms
  // ---------------------------------------------------------------------------

  function monitorFields(kind, form, set, idPrefix) {
    const fields = [
      h(Switch, {
        key: "monitored",
        id: idPrefix + "-monitored",
        label: "Monitored",
        checked: form.monitored,
        onChange: (v) => set({ monitored: v }),
        help: kind === "scene" ? "Whisparr searches for and grabs this scene" : "Whisparr follows this " + KINDS[kind].label + "'s scenes",
      }),
    ];
    if (KINDS[kind].hasChildren) {
      fields.push(
        h(Switch, {
          key: "moviesMonitored",
          id: idPrefix + "-movies",
          label: "Monitor movies",
          checked: form.moviesMonitored,
          onChange: (v) => set({ moviesMonitored: v }),
          help: "Also follow full-length movies (needs a TMDB/TPDB link on the stash-box)",
        }),
        h(Switch, {
          key: "monitorNew",
          id: idPrefix + "-new",
          label: "Monitor new items",
          checked: form.whisparrMonitorNewItems,
          onChange: (v) => set({ whisparrMonitorNewItems: v }),
          help: "Newly released scenes are added as monitored",
        }),
        h(
          Form.Group,
          { key: "afterDate", controlId: idPrefix + "-after" },
          h(Form.Label, null, "Only items released on or after"),
          h(Form.Control, {
            type: "date",
            size: "sm",
            value: form.afterDate || "",
            onChange: (e) => set({ afterDate: e.target.value || null }),
          })
        )
      );
    }
    return fields;
  }

  function AddForm({ kind, settings, meta, stashId, onAdded, onCancel }) {
    const k = KINDS[kind];
    const [form, setForm] = useState(() => ({
      rootFolderPath: recall("rootFolderPath", meta.rootFolders[0] ? meta.rootFolders[0].path : ""),
      qualityProfileId: recall("qualityProfileId", meta.profiles[0] ? meta.profiles[0].id : 0),
      monitored: true,
      moviesMonitored: false,
      whisparrMonitorNewItems: true,
      afterDate: null,
      tags: [],
      search: recall("searchOnAdd." + kind, false),
    }));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const set = (patch) => setForm((f) => Object.assign({}, f, patch));

    const rootOk = meta.rootFolders.some((r) => r.path === form.rootFolderPath);
    const profileOk = meta.profiles.some((p) => p.id === Number(form.qualityProfileId));

    async function add() {
      setBusy(true);
      setError(null);
      try {
        const results = await whisparr(settings, "GET", k.lookup + "?term=" + encodeURIComponent("stash:" + stashId));
        const candidates = (results || []).map((r) => r[k.lookupKey]).filter(Boolean);
        // An id lookup returns at most one item; prefer an exact foreignId match.
        const found =
          candidates.find((x) => x.foreignId && x.foreignId.toLowerCase() === stashId.toLowerCase()) ||
          (candidates.length === 1 ? candidates[0] : null);
        if (!found) {
          throw new Error(
            "Whisparr could not find this " + k.label + " on " + STASH_BOXES[settings.box].label + " (" + stashId + ")"
          );
        }

        const body = Object.assign({}, found, {
          id: 0,
          monitored: form.monitored,
          qualityProfileId: Number(form.qualityProfileId),
          rootFolderPath: form.rootFolderPath,
          tags: form.tags,
        });
        if (k.hasChildren) {
          Object.assign(body, {
            moviesMonitored: form.moviesMonitored,
            javMonitored: false,
            whisparrMonitorNewItems: form.whisparrMonitorNewItems,
            afterDate: form.afterDate,
            searchOnAdd: form.search,
            addOptions: { monitored: form.monitored, moviesMonitored: form.moviesMonitored, searchForMovie: form.search },
          });
        } else {
          body.addOptions = { monitored: form.monitored, searchForMovie: form.search };
        }

        await whisparr(settings, "POST", k.resource, body);
        remember("rootFolderPath", form.rootFolderPath);
        remember("qualityProfileId", Number(form.qualityProfileId));
        remember("searchOnAdd." + kind, form.search);
        onAdded();
      } catch (err) {
        setError(err.message);
        setBusy(false);
      }
    }

    if (!meta.rootFolders.length) {
      return h("div", { className: "wb-warning" }, "Whisparr has no root folders yet. Add one in Whisparr under Settings > Media Management.");
    }

    return h(
      "div",
      { className: "wb-form" },
      h(Select, {
        label: "Root folder",
        value: rootOk ? form.rootFolderPath : "",
        options: (rootOk ? [] : [{ value: "", label: "Choose…" }]).concat(
          meta.rootFolders.map((r) => ({
            value: r.path,
            label: r.path + (r.freeSpace != null ? " (" + formatBytes(r.freeSpace) + " free)" : ""),
          }))
        ),
        onChange: (v) => set({ rootFolderPath: v }),
      }),
      h(Select, {
        label: "Quality profile",
        value: profileOk ? form.qualityProfileId : "",
        options: (profileOk ? [] : [{ value: "", label: "Choose…" }]).concat(meta.profiles.map((p) => ({ value: p.id, label: p.name }))),
        onChange: (v) => set({ qualityProfileId: Number(v) }),
      }),
      monitorFields(kind, form, set, "wb-add-" + kind),
      h(TagPicker, { tags: meta.tags, value: form.tags, onChange: (v) => set({ tags: v }) }),
      h(Switch, {
        id: "wb-add-search-" + kind,
        label: "Start search after adding",
        checked: form.search,
        onChange: (v) => set({ search: v }),
      }),
      error ? h("div", { className: "wb-error" }, error) : null,
      h(
        "div",
        { className: "wb-actions" },
        h(
          Button,
          { variant: "primary", size: "sm", disabled: busy || !rootOk || !profileOk, onClick: add },
          busy ? h(Spinner, { animation: "border", size: "sm" }) : "Add to Whisparr"
        ),
        h(Button, { variant: "secondary", size: "sm", disabled: busy, onClick: onCancel }, "Cancel")
      )
    );
  }

  function EditForm({ kind, settings, meta, item, onSaved, onCancel }) {
    const k = KINDS[kind];
    const [form, setForm] = useState(() => ({
      monitored: item.monitored,
      moviesMonitored: item.moviesMonitored,
      whisparrMonitorNewItems: item.whisparrMonitorNewItems,
      afterDate: item.afterDate || null,
      qualityProfileId: item.qualityProfileId,
      tags: item.tags || [],
    }));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const set = (patch) => setForm((f) => Object.assign({}, f, patch));

    async function save() {
      setBusy(true);
      setError(null);
      try {
        const body = Object.assign({}, item, {
          monitored: form.monitored,
          qualityProfileId: Number(form.qualityProfileId),
          tags: form.tags,
        });
        if (k.hasChildren) {
          Object.assign(body, {
            moviesMonitored: form.moviesMonitored,
            whisparrMonitorNewItems: form.whisparrMonitorNewItems,
            afterDate: form.afterDate,
          });
        }
        await whisparr(settings, "PUT", k.resource + "/" + item.id, body);
        onSaved();
      } catch (err) {
        setError(err.message);
        setBusy(false);
      }
    }

    return h(
      "div",
      { className: "wb-form" },
      monitorFields(kind, form, set, "wb-edit-" + kind),
      h(Select, {
        label: "Quality profile",
        value: form.qualityProfileId,
        options: meta.profiles.map((p) => ({ value: p.id, label: p.name })),
        onChange: (v) => set({ qualityProfileId: Number(v) }),
      }),
      h(TagPicker, { tags: meta.tags, value: form.tags, onChange: (v) => set({ tags: v }) }),
      error ? h("div", { className: "wb-error" }, error) : null,
      h(
        "div",
        { className: "wb-actions" },
        h(
          Button,
          { variant: "primary", size: "sm", disabled: busy, onClick: save },
          busy ? h(Spinner, { animation: "border", size: "sm" }) : "Save"
        ),
        h(Button, { variant: "secondary", size: "sm", disabled: busy, onClick: onCancel }, "Cancel")
      )
    );
  }

  function DeleteForm({ kind, settings, item, onDeleted, onCancel }) {
    const k = KINDS[kind];
    const [deleteFiles, setDeleteFiles] = useState(false);
    const [exclude, setExclude] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    async function remove() {
      setBusy(true);
      setError(null);
      try {
        await whisparr(
          settings,
          "DELETE",
          k.resource + "/" + item.id + "?deleteFiles=" + deleteFiles + "&addImportExclusion=" + exclude
        );
        onDeleted();
      } catch (err) {
        setError(err.message);
        setBusy(false);
      }
    }

    return h(
      "div",
      { className: "wb-form" },
      h("div", { className: "wb-warning" }, k.deleteWarning),
      h(Switch, {
        id: "wb-del-files-" + kind,
        label: "Also delete files from disk",
        checked: deleteFiles,
        onChange: setDeleteFiles,
        help: "The files Stash scanned would be gone too",
      }),
      h(Switch, {
        id: "wb-del-excl-" + kind,
        label: "Add import exclusion",
        checked: exclude,
        onChange: setExclude,
        help: "Stops lists from adding it back",
      }),
      error ? h("div", { className: "wb-error" }, error) : null,
      h(
        "div",
        { className: "wb-actions" },
        h(
          Button,
          { variant: "danger", size: "sm", disabled: busy, onClick: remove },
          busy ? h(Spinner, { animation: "border", size: "sm" }) : "Remove from Whisparr"
        ),
        h(Button, { variant: "secondary", size: "sm", disabled: busy, onClick: onCancel }, "Cancel")
      )
    );
  }

  // ---------------------------------------------------------------------------
  // Years (per-year monitoring, like the bookmarks on Whisparr's studio/performer pages)
  // ---------------------------------------------------------------------------

  // Parses the "Year preset" setting into a test function.
  // Accepts: empty or "all", "2020", "2018-2022", "2020+" or "2020-", "-2015",
  // "last 5" (this year and the 4 before it), and comma/space separated mixes.
  function parseYearPreset(text) {
    const raw = String(text || "").trim().toLowerCase();
    if (!raw || raw === "all" || raw === "*") return { label: "all years", test: () => true };

    const thisYear = new Date().getFullYear();
    const ranges = [];
    const parts = raw.replace(/last\s+(\d+)/g, "last:$1").split(/[\s,;]+/).filter(Boolean);
    for (const part of parts) {
      let m;
      if ((m = part.match(/^last:(\d+)$/))) {
        const n = Number(m[1]);
        if (!n) throw new Error('"last 0" matches no years');
        ranges.push([thisYear - n + 1, Infinity]);
      } else if ((m = part.match(/^(\d{4})$/))) {
        ranges.push([Number(m[1]), Number(m[1])]);
      } else if ((m = part.match(/^(\d{4})-(\d{4})$/))) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        ranges.push([Math.min(a, b), Math.max(a, b)]);
      } else if ((m = part.match(/^(\d{4})(\+|-)$/))) {
        ranges.push([Number(m[1]), Infinity]);
      } else if ((m = part.match(/^-(\d{4})$/))) {
        ranges.push([-Infinity, Number(m[1])]);
      } else {
        throw new Error('Year preset "' + text + '" is not understood at "' + part + '"');
      }
    }
    return {
      label: text.trim(),
      test: (year) => ranges.some(([a, b]) => year >= a && year <= b),
    };
  }

  function groupWorksByYear(works) {
    const byYear = new Map();
    for (const w of works || []) {
      if (!w || !w.year) continue; // Whisparr leaves undated works out of its year list too
      if (!byYear.has(w.year)) byYear.set(w.year, []);
      byYear.get(w.year).push(w);
    }
    return Array.from(byYear.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([year, list]) => ({
        year,
        works: list,
        total: list.length,
        monitored: list.filter((w) => w.monitored).length,
        onDisk: list.filter((w) => w.hasFile).length,
        size: list.reduce((n, w) => n + (w.sizeOnDisk || 0), 0),
      }));
  }

  function setMonitored(settings, ids, monitored) {
    if (!ids.length) return Promise.resolve();
    return whisparr(settings, "PATCH", "/movie/bulk/monitor?monitored=" + monitored, ids);
  }

  // Works the preset would change: [toMonitor, toUnmonitor], each a list of {year, ids}.
  function planPreset(years, preset, unmonitorOthers) {
    const on = [];
    const off = [];
    for (const y of years) {
      if (preset.test(y.year)) {
        const ids = y.works.filter((w) => !w.monitored).map((w) => w.id);
        if (ids.length) on.push({ year: y.year, ids });
      } else if (unmonitorOthers) {
        const ids = y.works.filter((w) => w.monitored).map((w) => w.id);
        if (ids.length) off.push({ year: y.year, ids });
      }
    }
    return [on, off];
  }

  function describeYears(list) {
    const years = list.map((x) => x.year).sort((a, b) => a - b);
    // Collapse runs: 2018, 2019, 2020 -> 2018-2020
    const out = [];
    let start = null;
    let prev = null;
    for (const y of years.concat([null])) {
      if (start !== null && y === prev + 1) {
        prev = y;
        continue;
      }
      if (start !== null) out.push(start === prev ? String(start) : start + "-" + prev);
      start = y;
      prev = y;
    }
    return out.join(", ");
  }

  function YearsView({ kind, settings, item, showPreset, onChanged, onClose }) {
    const k = KINDS[kind];
    const Toast = PluginApi.hooks.useToast ? PluginApi.hooks.useToast() : null;
    const [years, setYears] = useState(null);
    const [error, setError] = useState(null);
    const [busyYear, setBusyYear] = useState(null);
    const [applying, setApplying] = useState(false);
    const [loadKey, setLoadKey] = useState(0);
    const [presetOpen, setPresetOpen] = useState(!!showPreset);

    useEffect(() => {
      let cancelled = false;
      setError(null);
      whisparr(settings, "GET", k.worksPath(item)).then(
        (works) => !cancelled && setYears(groupWorksByYear(works)),
        (err) => !cancelled && setError(err.message)
      );
      return () => {
        cancelled = true;
      };
    }, [loadKey]);

    let preset = null;
    let presetError = null;
    try {
      preset = parseYearPreset(settings.yearPreset);
    } catch (err) {
      presetError = err.message;
    }

    async function toggleYear(y, monitored) {
      setBusyYear(y.year);
      try {
        await setMonitored(settings, y.works.map((w) => w.id), monitored);
        setLoadKey((n) => n + 1);
        onChanged();
      } catch (err) {
        if (Toast) Toast.error(err);
        else alert(err.message);
      } finally {
        setBusyYear(null);
      }
    }

    async function applyPreset(on, off) {
      setApplying(true);
      try {
        const ids = (list) => [].concat.apply([], list.map((x) => x.ids));
        await setMonitored(settings, ids(on), true);
        await setMonitored(settings, ids(off), false);
        if (settings.yearPresetMonitorItem && (!item.monitored || !item.whisparrMonitorNewItems)) {
          await whisparr(
            settings,
            "PUT",
            k.resource + "/" + item.id,
            Object.assign({}, item, { monitored: true, whisparrMonitorNewItems: true })
          );
        }
        if (Toast) Toast.success("Year preset applied");
        setPresetOpen(false);
        setLoadKey((n) => n + 1);
        onChanged();
      } catch (err) {
        if (Toast) Toast.error(err);
        else alert(err.message);
      } finally {
        setApplying(false);
      }
    }

    if (error) {
      return h(
        Fragment,
        null,
        h("div", { className: "wb-error" }, error),
        h(
          "div",
          { className: "wb-actions" },
          h(Button, { size: "sm", variant: "secondary", onClick: () => setLoadKey((n) => n + 1) }, "Retry"),
          h(Button, { size: "sm", variant: "secondary", onClick: onClose }, "Back")
        )
      );
    }
    if (!years) {
      return h("div", { className: "wb-loading" }, h(Spinner, { animation: "border", size: "sm" }), " Loading works from Whisparr…");
    }

    // ---- preset confirmation
    let presetBox = null;
    if (presetOpen) {
      if (presetError) {
        presetBox = h("div", { className: "wb-error" }, presetError + ". Fix it under Settings > Plugins > Whisparr Bridge.");
      } else {
        const [on, off] = planPreset(years, preset, settings.yearPresetUnmonitorOthers);
        const count = (list) => list.reduce((n, x) => n + x.ids.length, 0);
        const itemChange =
          settings.yearPresetMonitorItem && (!item.monitored || !item.whisparrMonitorNewItems)
            ? "Turn on Monitored and Monitor new items for this " + k.label + "."
            : null;
        const lines = [];
        if (on.length) lines.push("Monitor " + count(on) + " works in " + describeYears(on) + ".");
        if (off.length) lines.push("Unmonitor " + count(off) + " works in " + describeYears(off) + ".");
        if (itemChange) lines.push(itemChange);
        presetBox = h(
          "div",
          { className: "wb-preset" },
          h(
            "div",
            { className: "wb-preset-title" },
            "Year preset: ",
            h("strong", null, preset.label),
            settings.yearPresetUnmonitorOthers ? " (other years are unmonitored)" : null
          ),
          lines.length
            ? h("ul", { className: "wb-preset-list" }, lines.map((l, i) => h("li", { key: i }, l)))
            : h("div", { className: "text-muted" }, "Nothing to change. This " + k.label + " already matches the preset."),
          h(
            "div",
            { className: "wb-actions" },
            lines.length
              ? h(
                  Button,
                  { variant: "primary", size: "sm", disabled: applying, onClick: () => applyPreset(on, off) },
                  applying ? h(Spinner, { animation: "border", size: "sm" }) : "Apply"
                )
              : null,
            h(Button, { variant: "secondary", size: "sm", disabled: applying, onClick: () => setPresetOpen(false) }, lines.length ? "Cancel" : "OK")
          )
        );
      }
    }

    const rows = years.length
      ? years.map((y) =>
          h(
            "div",
            { key: y.year, className: "wb-year" },
            h("span", { className: "wb-year-name" }, y.year),
            h(
              "span",
              {
                className: "wb-year-count " + (y.monitored === y.total ? "wb-full" : y.monitored ? "wb-partial" : ""),
                title: "Monitored / total works",
              },
              y.monitored + " / " + y.total + " monitored"
            ),
            h("span", { className: "wb-year-disk", title: "Works on disk" }, y.onDisk + " on disk" + (y.size ? " · " + formatBytes(y.size) : "")),
            busyYear === y.year
              ? h(Spinner, { animation: "border", size: "sm" })
              : h(Form.Check, {
                  type: "switch",
                  id: "wb-year-" + kind + "-" + y.year,
                  label: h("span", { className: "sr-only" }, "Monitor " + y.year),
                  checked: y.monitored === y.total,
                  disabled: busyYear !== null || applying,
                  onChange: (e) => toggleYear(y, e.target.checked),
                })
          )
        )
      : h("div", { className: "text-muted" }, "Whisparr has no dated works for this " + k.label + " yet.");

    return h(
      Fragment,
      null,
      presetBox,
      h(
        "div",
        { className: "wb-actions wb-years-head" },
        h("span", { className: "wb-grow text-muted" }, "Switching a year on monitors every work from that year."),
        presetOpen ? null : h(Button, { variant: "primary", size: "sm", disabled: applying, onClick: () => setPresetOpen(true) }, "Apply year preset"),
        h(Button, { variant: "secondary", size: "sm", onClick: onClose }, "Back")
      ),
      h("div", { className: "wb-years" }, rows)
    );
  }

  // ---------------------------------------------------------------------------
  // Status view
  // ---------------------------------------------------------------------------

  function StatusView({ kind, item, meta }) {
    const k = KINDS[kind];
    const profile = meta.profiles.find((p) => p.id === item.qualityProfileId);
    const tagNames = (item.tags || [])
      .map((id) => (meta.tags.find((t) => t.id === id) || {}).label)
      .filter(Boolean);

    const rows = [
      h(
        Row,
        { key: "mon", label: "Monitoring" },
        h(Pill, { on: item.monitored }, item.monitored ? "Monitored" : "Unmonitored"),
        k.hasChildren ? h(Pill, { on: item.moviesMonitored }, "Movies") : null,
        k.hasChildren ? h(Pill, { on: item.whisparrMonitorNewItems }, "New items") : null
      ),
      h(Row, { key: "qp", label: "Quality profile" }, profile ? profile.name : "#" + item.qualityProfileId),
    ];

    if (k.hasChildren) {
      if (item.afterDate) rows.push(h(Row, { key: "after", label: "Released after" }, item.afterDate));
      rows.push(
        h(
          Row,
          { key: "count", label: "Scenes on disk" },
          (item.sceneCount || 0) + " / " + (item.totalSceneCount || 0)
        )
      );
      if (item.totalMovieCount) {
        rows.push(h(Row, { key: "movies", label: "Movies on disk" }, (item.movieCount || 0) + " / " + item.totalMovieCount));
      }
      rows.push(h(Row, { key: "size", label: "Size on disk" }, formatBytes(item.sizeOnDisk)));
      if (item.rootFolderPath) rows.push(h(Row, { key: "root", label: "Root folder" }, item.rootFolderPath));
    } else {
      const file = item.movieFile;
      rows.push(
        h(
          Row,
          { key: "file", label: "File" },
          item.hasFile && file
            ? (file.quality && file.quality.quality ? file.quality.quality.name + " · " : "") + formatBytes(file.size)
            : h(Pill, { on: false }, "Missing")
        )
      );
      if (item.releaseDate) rows.push(h(Row, { key: "date", label: "Release date" }, String(item.releaseDate).slice(0, 10)));
      if (item.path) rows.push(h(Row, { key: "path", label: "Path" }, item.path));
    }

    if (tagNames.length) rows.push(h(Row, { key: "tags", label: "Tags" }, tagNames.join(", ")));
    return h("div", { className: "wb-status" }, rows);
  }

  // ---------------------------------------------------------------------------
  // Main panel
  // ---------------------------------------------------------------------------

  function WhisparrPanel({ kind, entity, startOpen }) {
    const k = KINDS[kind];
    const Toast = PluginApi.hooks.useToast ? PluginApi.hooks.useToast() : null;
    const [settings, setSettings] = useState(null);
    const [state, setState] = useState({ phase: "loading" });
    const [open, setOpen] = useState(!!startOpen || recall("open." + kind, false));
    const [mode, setMode] = useState("view");
    const [reloadKey, setReloadKey] = useState(0);
    const [busyCommand, setBusyCommand] = useState(null);

    const reload = useCallback(() => {
      setMode("view");
      setReloadKey((n) => n + 1);
    }, []);

    useEffect(() => {
      let cancelled = false;
      loadSettings().then(
        (s) => !cancelled && setSettings(s),
        (err) => !cancelled && setState({ phase: "error", message: "Could not read plugin settings: " + err.message })
      );
      return () => {
        cancelled = true;
      };
    }, []);

    const stashId = useMemo(() => (settings ? findStashId(entity, settings.box) : null), [settings, entity]);

    useEffect(() => {
      if (!settings) return;
      if (settings.disabled[kind]) return;
      if (!settings.baseUrl || !settings.apiKey) {
        setState({ phase: "setup" });
        return;
      }
      if (!stashId) {
        setState({ phase: "noid" });
        return;
      }
      let cancelled = false;
      setState((s) => (s.phase === "ready" ? s : { phase: "loading" }));
      Promise.all([
        whisparr(settings, "GET", k.resource + "/" + encodeURIComponent(stashId)).catch((err) => {
          if (err.status === 404) return null;
          throw err;
        }),
        loadMeta(settings),
      ]).then(
        ([item, meta]) => !cancelled && setState({ phase: "ready", item: k.exists(item) ? item : null, meta }),
        (err) => !cancelled && setState({ phase: "error", message: err.message })
      );
      return () => {
        cancelled = true;
      };
    }, [settings, stashId, kind, reloadKey]);

    if (settings && settings.disabled[kind]) return null;

    async function runCommand(label, command) {
      setBusyCommand(label);
      try {
        await whisparr(settings, "POST", "/command", command);
        if (Toast) Toast.success(label + " started in Whisparr");
      } catch (err) {
        if (Toast) Toast.error(err);
        else alert(err.message);
      } finally {
        setBusyCommand(null);
      }
    }

    function toggleOpen() {
      remember("open." + kind, !open);
      setOpen(!open);
    }

    // ---- header summary
    let summary;
    if (!settings || state.phase === "loading") summary = h(Spinner, { animation: "border", size: "sm" });
    else if (state.phase === "setup") summary = h(Pill, { on: false }, "Not set up");
    else if (state.phase === "noid") summary = h(Pill, { on: false }, "No " + STASH_BOXES[settings.box].label + " ID");
    else if (state.phase === "error") summary = h(Pill, { on: false }, "Error");
    else if (!state.item) summary = h(Pill, { on: false }, "Not in Whisparr");
    else
      summary = h(
        Fragment,
        null,
        h(Pill, { on: true }, "In Whisparr"),
        h(Pill, { on: state.item.monitored }, state.item.monitored ? "Monitored" : "Unmonitored"),
        kind === "scene" ? h(Pill, { on: !!state.item.hasFile }, state.item.hasFile ? "Downloaded" : "Missing") : null
      );

    // ---- body
    let body = null;
    if (open && settings) {
      if (state.phase === "setup") {
        body = h(
          "div",
          { className: "wb-warning" },
          "Set the Whisparr host and API key under Settings > Plugins > Whisparr Bridge."
        );
      } else if (state.phase === "noid") {
        body = h(
          "div",
          { className: "wb-warning" },
          "This " +
            k.label +
            " has no " +
            STASH_BOXES[settings.box].label +
            " Stash ID, so it can't be matched to Whisparr. Tag it with the " +
            STASH_BOXES[settings.box].label +
            " stash-box first" +
            (settings.box === "stashdb" ? " (or turn on \"Whisparr uses ThePornDB\" if that's your source)." : ".")
        );
      } else if (state.phase === "error") {
        body = h(
          Fragment,
          null,
          h("div", { className: "wb-error" }, state.message),
          h("div", { className: "wb-actions" }, h(Button, { size: "sm", variant: "secondary", onClick: reload }, "Retry"))
        );
      } else if (state.phase === "ready") {
        const { item, meta } = state;
        const source = meta.source && meta.source.sceneMetadataSource;
        const mismatch =
          source && String(source).toLowerCase() !== STASH_BOXES[settings.box].whisparrName
            ? h(
                "div",
                { className: "wb-warning" },
                "Whisparr's scene source is " +
                  (String(source).toLowerCase() === "tpdb" ? "ThePornDB" : "StashDB") +
                  " but the plugin is set to " +
                  STASH_BOXES[settings.box].label +
                  ". Fix \"Whisparr uses ThePornDB\" in the plugin settings."
              )
            : null;

        if (!item) {
          body = h(
            Fragment,
            null,
            mismatch,
            mode === "add"
              ? h(AddForm, { kind, settings, meta, stashId, onAdded: reload, onCancel: () => setMode("view") })
              : h(
                  "div",
                  { className: "wb-actions" },
                  h("span", { className: "text-muted wb-grow" }, "Whisparr doesn't have this " + k.label + " yet."),
                  h(Button, { variant: "primary", size: "sm", onClick: () => setMode("add") }, "Add to Whisparr")
                )
          );
        } else {
          const link = settings.publicUrl ? settings.publicUrl + k.whisparrPath(item) : null;
          body = h(
            Fragment,
            null,
            mismatch,
            mode === "edit"
              ? h(EditForm, { kind, settings, meta, item, onSaved: reload, onCancel: () => setMode("view") })
              : mode === "delete"
              ? h(DeleteForm, { kind, settings, item, onDeleted: reload, onCancel: () => setMode("view") })
              : mode === "years" || mode === "preset"
              ? h(YearsView, {
                  kind,
                  settings,
                  item,
                  showPreset: mode === "preset",
                  onChanged: () => setReloadKey((n) => n + 1),
                  onClose: () => setMode("view"),
                })
              : h(
                  Fragment,
                  null,
                  h(StatusView, { kind, item, meta }),
                  h(
                    "div",
                    { className: "wb-actions" },
                    h(Button, { variant: "primary", size: "sm", onClick: () => setMode("edit") }, "Edit"),
                    k.hasChildren
                      ? h(Button, { variant: "secondary", size: "sm", onClick: () => setMode("years") }, "Years")
                      : null,
                    k.hasChildren
                      ? h(
                          Button,
                          { variant: "secondary", size: "sm", onClick: () => setMode("preset"), title: "Monitor years using the preset from the plugin settings" },
                          "Apply year preset"
                        )
                      : null,
                    h(
                      Button,
                      {
                        variant: "secondary",
                        size: "sm",
                        disabled: !!busyCommand,
                        onClick: () => runCommand("Search", k.searchCommand(item)),
                      },
                      busyCommand === "Search" ? h(Spinner, { animation: "border", size: "sm" }) : "Search"
                    ),
                    h(
                      Button,
                      {
                        variant: "secondary",
                        size: "sm",
                        disabled: !!busyCommand,
                        onClick: () => runCommand("Refresh", k.refreshCommand(item)).then(reload),
                      },
                      busyCommand === "Refresh" ? h(Spinner, { animation: "border", size: "sm" }) : "Refresh"
                    ),
                    link
                      ? h(
                          "a",
                          { className: "btn btn-secondary btn-sm", href: link, target: "_blank", rel: "noopener noreferrer" },
                          "Open in Whisparr"
                        )
                      : null,
                    h("span", { className: "wb-grow" }),
                    h(Button, { variant: "outline-danger", size: "sm", onClick: () => setMode("delete") }, "Remove")
                  )
                )
          );
        }
      }
    }

    return h(
      "div",
      { className: "wb-panel wb-panel-" + kind },
      h(
        "div",
        { className: "wb-header", role: "button", tabIndex: 0, onClick: toggleOpen, onKeyDown: (e) => (e.key === "Enter" ? toggleOpen() : null) },
        h("span", { className: "wb-caret" }, open ? "▾" : "▸"),
        h("span", { className: "wb-title" }, "Whisparr"),
        h("span", { className: "wb-summary" }, summary)
      ),
      body ? h("div", { className: "wb-body" }, body) : null
    );
  }

  // ---------------------------------------------------------------------------
  // Hook into Stash pages
  // ---------------------------------------------------------------------------

  // Stash calls an "after" patch with every argument React passed the component
  // (props plus React's second argument), then the rendered result last. So the
  // result is always the final argument, not necessarily the second.
  function afterPatch(component, fn) {
    PluginApi.patch.after(component, function () {
      const args = Array.prototype.slice.call(arguments);
      const result = args[args.length - 1];
      const props = args.length > 1 ? args[0] : null;
      try {
        return fn(props, result);
      } catch (err) {
        console.error("[WhisparrBridge] patch for " + component + " failed", err);
        return result;
      }
    });
  }

  afterPatch("PerformerDetailsPanel", function (props, result) {
    if (!props || !props.performer) return result;
    return h(Fragment, null, result, h(WhisparrPanel, { key: "wb-" + props.performer.id, kind: "performer", entity: props.performer }));
  });

  afterPatch("StudioDetailsPanel", function (props, result) {
    if (!props || !props.studio) return result;
    return h(Fragment, null, result, h(WhisparrPanel, { key: "wb-" + props.studio.id, kind: "studio", entity: props.studio }));
  });

  // Scene pages get their own tab. The tab is hidden when the setting turns it off.
  function SceneTabNav() {
    const [hidden, setHidden] = useState(true);
    useEffect(() => {
      let cancelled = false;
      loadSettings().then(
        (s) => !cancelled && setHidden(s.disabled.scene),
        () => !cancelled && setHidden(false)
      );
      return () => {
        cancelled = true;
      };
    }, []);
    if (hidden) return null;
    return h(Nav.Item, null, h(Nav.Link, { eventKey: "whisparr-bridge-panel" }, "Whisparr"));
  }

  afterPatch("ScenePage.Tabs", function (props, result) {
    return h(Fragment, null, result, h(SceneTabNav, { key: "wb-scene-tab" }));
  });

  afterPatch("ScenePage.TabContent", function (props, result) {
    if (!props || !props.scene) return result;
    return h(
      Fragment,
      null,
      result,
      h(
        Tab.Pane,
        { key: "wb-scene-pane", eventKey: "whisparr-bridge-panel", mountOnEnter: true },
        h(WhisparrPanel, { key: "wb-" + props.scene.id, kind: "scene", entity: props.scene, startOpen: true })
      )
    );
  });
})();
