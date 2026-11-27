# Whisparr v5 ⇄ Stash bridge

A [Stash](https://github.com/stashapp/stash) plugin that shows what your
[Whisparr v5](https://github.com/Whisparr/whisparr-next) server knows about a
performer, studio or scene, and lets you manage it from that Stash page.

> Built for **Whisparr v5** (`/api/v5`) only. Whisparr v2/v3 use a different API and won't work.

## What it does

| Stash page | Where | What you can do |
|---|---|---|
| Performer | Whisparr card under the performer details | See if Whisparr has them, monitoring, quality profile, scenes on disk / total, size, root folder, tags. Add, edit, search, refresh, open in Whisparr, remove. |
| Studio | Whisparr card under the studio details | Same as performers. |
| Scene | New **Whisparr** tab | See if it's in Whisparr and whether the file is downloaded (quality, size, path). Add, monitor/unmonitor, change profile/tags, search, refresh, remove. |

Matching uses the item's **Stash ID** from the stash-box your Whisparr uses
(StashDB or ThePornDB). An item that has no Stash ID from that stash-box shows
"No StashDB ID" / "No ThePornDB ID"; tag it in Stash first.

Editing options:

- **Monitored**: whether Whisparr follows / grabs it.
- **Monitor movies** (performers/studios): also follow full-length movies.
- **Monitor new items** (performers/studios): newly released scenes are added as monitored.
- **Only items released on or after** (performers/studios): a date cut-off.
- **Quality profile**, **root folder** (when adding) and **tags**.
- **Start search after adding**.
- **Years** (performers/studios): every year Whisparr has works for, with monitored
  and on-disk counts, and a switch per year. Like the bookmarks on Whisparr's own
  studio/performer pages, switching a year on monitors every work from that year.
- **Apply preset** (performers/studios): one button that sets the watch settings
  (Monitor scenes, Monitor movies, Monitor new items, Search on add) and the
  monitored years to the preset from the plugin settings. It lists exactly what
  will change before applying. The **Add** form also starts from the preset.
- **Remove**, optionally deleting files and adding an import exclusion. Removing a
  performer or studio removes all of its scenes from Whisparr too.

## Install

### From a plugin source (recommended)

1. In Stash go to **Settings › Plugins › Available Plugins › Add Source**.
2. Name: `Whisparr Bridge`, Source URL:
   `https://cuddlebear92.github.io/Whisparr-v5-stashapp-bridge/index.yml`
3. Install **Whisparr Bridge** from that source.

### Manually

Copy the `plugins/WhisparrBridge` folder into your Stash `plugins` folder
(next to Stash's `config.yml`), then **Settings › Plugins › Reload Plugins**.

### Requirements

- Python 3 available to Stash (the official Stash Docker image has it; otherwise
  set **Settings › System › Python executable path**). The plugin's relay script
  uses the standard library only.
- A Whisparr v5 API key (Whisparr › Settings › General › Security).

## Settings

**Settings › Plugins › Whisparr Bridge** shows four rows:

| Row | What's in it |
|---|---|
| **Whisparr connection** | Edit opens a window with host (as seen from the Stash server), port (empty = 6969), API key, Whisparr's stash-box (StashDB or ThePornDB), optional URL base and optional link URL for "Open in Whisparr". **Test connection** checks the details and warns if the stash-box doesn't match Whisparr's. |
| **Show on** | Performers / Studios / Scenes switches for where the panel appears. |
| **Preset** | On/off switch, and Edit for the preset window: Monitor scenes, Monitor movies, Monitor new items, Search on add, years to monitor (`all`, `none`, `2020+`, `2018-2022`, `-2015`, `last 5`, or a mix like `2015, 2019-2021`), unmonitor other years, and **Ask before applying**. |
| **Watched tag** | On/off switch, Edit for the tag name, and **Sync library now** to tag the whole library. |

With the preset on, performer and studio panels show **Apply preset** in their
header, even when collapsed. It applies in one click and shows a summary of what
changed; with **Ask before applying** on, it opens a preview first. If Whisparr
refuses Monitor movies (it needs a TMDB/TPDB link), the rest is still applied.

To turn the whole plugin off, use the Disable button Stash shows next to it.

## How items are matched

Only by **stash-box ID**, never by name. Whisparr v5 identifies performers,
studios and scenes by their StashDB (or ThePornDB) ID. The plugin takes the
Stash ID for that stash-box from the Stash item and asks Whisparr for exactly
that ID. Items without one show "No StashDB ID" / "No ThePornDB ID".

## The "Whisparr Watched" tag

The plugin keeps a Stash tag (default **Whisparr Watched**) on every performer,
studio and scene that is monitored in Whisparr, and takes it off ones that are
not, so you can filter for them in Stash. The tag is created the first time it's
needed, with Stash's Auto Tag switched off for it (an existing tag of that name
gets Auto Tag switched off too), so only the plugin ever applies it.

- Opening a performer, studio or scene page updates that item's tag.
- **Sync library now** in the plugin settings, or **Settings › Tasks › Plugin
  Tasks › Sync Whisparr Watched tags**, goes through
  your whole library. Run it once after installing, and again whenever you want
  everything caught up (it can also be scheduled like any Stash task).

Items without a Stash ID from Whisparr's stash-box are never tagged. If you
rename the tag in the settings, the old tag is left as it is.

## How it talks to Whisparr

Stash's Content-Security-Policy stops plugin JavaScript from calling other
hosts, so requests go through `whisparr_proxy.py` on the Stash server via
Stash's `runPluginOperation` GraphQL mutation. This also means Whisparr only
needs to be reachable from the Stash server, not from your browser. The relay
only forwards to paths under `/api/` on the configured Whisparr URL.

## Publishing (for the repo owner)

`.github/workflows/publish.yml` builds `index.yml` and the plugin zip with
`build_site.sh` and deploys them to GitHub Pages on every push to the repo's default branch
that touches `plugins/` (or when run by hand from the Actions tab). Enable it once under **Settings › Pages › Build and
deployment › Source: GitHub Actions**.

Bump `version:` in `plugins/WhisparrBridge/WhisparrBridge.yml` for each release;
the published version also carries the commit hash, so Stash sees updates.

## Ideas / roadmap

- Badges on performer/studio/scene **cards** in lists showing Whisparr status.
- Scene tab: show the scene's performers and studio and their Whisparr status, with quick-monitor buttons.
- Bulk actions from Stash lists (add/monitor all selected performers).
- Whisparr queue/download progress for a scene.
- Compare Whisparr's "on disk" scenes with what Stash has, e.g. "in Whisparr but not in Stash".
- Optional TLS verification toggle for self-signed Whisparr certificates.
