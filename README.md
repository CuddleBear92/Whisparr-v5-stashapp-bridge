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
- **Apply year preset** (performers/studios): one button that monitors the years
  set in the plugin's **Year preset** setting. It shows exactly what will change
  before applying.
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

**Settings › Plugins › Whisparr Bridge**:

| Setting | Notes |
|---|---|
| Whisparr host | IP/hostname **as seen from the Stash server**, e.g. `192.168.1.20`, `whisparr` (Docker), or a full `https://whisparr.example.com`. |
| Whisparr port | `0` = default (`6969` for http, scheme default for an https URL). |
| Whisparr URL base | Only if Whisparr has a URL base set, e.g. `/whisparr`. |
| Whisparr API key | Required. |
| Whisparr uses ThePornDB | Off = StashDB. The panel warns if this doesn't match what Whisparr reports. |
| Whisparr link URL | Optional. Address your *browser* uses for the "Open in Whisparr" link, if different from the host above. |
| Year preset | Years the **Apply year preset** button monitors: `all` (or empty), `2020+`, `2018-2022`, `-2015` (up to 2015), `last 5` (this year and the 4 before), or a mix like `2015, 2019-2021`. |
| Year preset unmonitors other years | Also unmonitor works from years outside the preset. Off = the preset only adds monitoring. |
| Year preset monitors the performer/studio | Also turn on Monitored and Monitor new items when applying the preset. |
| Off on performer / studio / scene pages | Hide the plugin on that kind of page. |

To turn the whole plugin off, use the enable switch Stash shows next to each
plugin under **Settings › Plugins**.

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
