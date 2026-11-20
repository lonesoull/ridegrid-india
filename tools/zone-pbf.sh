#!/usr/bin/env bash
# Download one India zone's OpenStreetMap extract to $2.
# Uses Geofabrik's zone file when it exists; if Geofabrik has renamed / removed the India zones (404)
# or the download fails, falls back to the whole-India extract cut to the zone's bounding box.
set -euo pipefail
zone="$1"; out="$2"
declare -A BBOX=(
  [southern-zone]="72.5,6.5,87.5,20.5" [western-zone]="67.8,14.8,80.5,24.8" [northern-zone]="68.0,23.0,81.5,37.2"
  [central-zone]="74.0,17.7,84.5,26.9" [eastern-zone]="81.3,17.7,90.0,27.5" [north-eastern-zone]="87.9,21.9,97.5,29.5"
)
if curl -fsSL --retry 4 --retry-delay 20 -o "$out" "https://download.geofabrik.de/asia/india/${zone}-latest.osm.pbf"; then
  echo "zone extract: $zone"; exit 0
fi
echo "zone file unavailable — using the India extract cut to ${BBOX[$zone]}"
india=/tmp/india-latest.osm.pbf
[ -s "$india" ] || curl -fsSL --retry 6 --retry-delay 30 --retry-all-errors -o "$india" https://download.geofabrik.de/asia/india-latest.osm.pbf
osmium extract -b "${BBOX[$zone]}" -s complete_ways "$india" -o "$out" --overwrite
