#!/usr/bin/env bash
# Builds a Stash plugin source into ./_site:
#   _site/index.yml          - add this URL in Stash > Settings > Plugins > Available Plugins
#   _site/<PluginId>.zip     - one zip per plugin folder under plugins/
set -euo pipefail

outdir="${1:-_site}"
rm -rf "$outdir"
mkdir -p "$outdir"
outdir=$(cd "$outdir" && pwd)
index="$outdir/index.yml"
: > "$index"

for ymlfile in plugins/*/*.yml; do
  dir=$(dirname "$ymlfile")
  id=$(basename "$ymlfile" .yml)
  # Only the folder's main config (named after the folder) defines a plugin.
  [ "$id" = "$(basename "$dir")" ] || continue

  name=$(grep -m1 '^name:' "$ymlfile" | cut -d: -f2- | sed 's/^ *//')
  description=$(grep -m1 '^description:' "$ymlfile" | cut -d: -f2- | sed 's/^ *//')
  version=$(grep -m1 '^version:' "$ymlfile" | cut -d: -f2- | sed 's/^ *//')
  commit=$(git log -n 1 --pretty=format:%h -- "$dir")
  updated=$(TZ=UTC0 git log -n 1 --date="format-local:%F %T" --pretty=format:%ad -- "$dir")

  zipfile="$outdir/$id.zip"
  (cd "$dir" && TZ=UTC0 zip -r -X -q "$zipfile" . -x '__pycache__/*' '*.pyc')
  sha=$(sha256sum "$zipfile" | cut -d' ' -f1)

  cat >> "$index" <<YML
- id: $id
  name: $name
  metadata:
    description: $description
  version: $version-$commit
  date: $updated
  path: $id.zip
  sha256: $sha
YML
done

echo "Built $(grep -c '^- id:' "$index") plugin(s) into $outdir"
