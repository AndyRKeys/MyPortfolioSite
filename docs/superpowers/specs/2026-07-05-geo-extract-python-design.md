# Design: Python geo-location extractor (`extract_geo_loc.py`)

**Date:** 2026-07-05
**Branch:** feature/issue-245-csv-import
**Replaces:** `scripts/tools/extract-geo-loc.ps1`

---

## Purpose

Scan a folder tree of travel photos, extract GPS coordinates from EXIF data (or infer
location from folder names when GPS is absent), reverse-geocode all locations to
consistent city/town names via Nominatim or Geoapify, deduplicate, and produce a
`04-travel-import.csv` ready for the bulk-import route (`POST /travel/import`).

---

## Context

- ~13,000 photos, dozens of folders
- Shot on Android (Samsung Galaxy S22 Ultra) and DJI (Osmo Action 5) — all JPEG, no HEIC, no RAW
- Run on Windows (local machine where photos live)
- Geocoding: Nominatim by default (free, no API key); Geoapify when API key is configured

---

## File layout

```
scripts/tools/
  extract_geo_loc.py        # single script, all four stages
  requirements.txt          # exifread, aiohttp
  .geo-config.json          # gitignored — user creates from example
  .geo-config.example.json  # committed template with placeholder values
```

`.geo-config.json` is added to the project root `.gitignore`.

---

## Config schema

`.geo-config.json` (user-created, not committed):

```json
{
  "geoapify_api_key":      "",
  "workers":               16,
  "throttle_ms":         1200,
  "coordinate_precision":   4,
  "lookup_precision":       3,
  "title_prefix":       "Trip",
  "skip_folder_inference": false,
  "user_agent": "PhotoGeoExportScript/1.0 (andykeys.me)"
}
```

`.geo-config.example.json` (committed):

```json
{
  "_comment": "Copy to .geo-config.json and fill in values. See README for details.",
  "geoapify_api_key":      "",
  "workers":               16,
  "throttle_ms":         1200,
  "coordinate_precision":   4,
  "lookup_precision":       3,
  "title_prefix":       "Trip",
  "skip_folder_inference": false,
  "user_agent": "PhotoGeoExportScript/1.0 (andykeys.me)"
}
```

**Load priority (each level overrides the previous):**
1. `.geo-config.json` (base)
2. `GEOAPIFY_API_KEY` environment variable
3. `--api-key` CLI argument

`throttle_ms` defaults to 1200 (Nominatim 1-req/sec policy). Drop to 250 when using
Geoapify.

---

## CLI

```
python extract_geo_loc.py --stage <stage> [options]

--stage         extract | group | resolve | export | all  (required)
--root-folder   Root photo folder. Required for extract / all.
--working-folder Folder for intermediate CSVs and cache. Required always.
--output-csv    Final CSV path. Defaults to <working-folder>/04-travel-import.csv.
--api-key       Geoapify API key (overrides config file and env var).
--workers       Thread count for Extract stage (overrides config file).
--title-prefix  Title field in output CSV (overrides config file).
--notes         Notes field in output CSV.
--publish       Set publish=true in output CSV (flag, default false).
--skip-folder-inference  Disable folder-name fallback for non-GPS files.
```

**Example — full run:**
```
python extract_geo_loc.py --stage all --root-folder "D:\Photos" --working-folder "D:\geo-work"
```

**Example — resolve only, using Geoapify:**
```
python extract_geo_loc.py --stage resolve --working-folder "D:\geo-work" --api-key "abc123"
```

---

## Intermediate files

Same names as the PowerShell script so existing working folders remain compatible:

| File | Written by | Read by |
|------|-----------|---------|
| `01-extracted.csv` | Extract | Group |
| `02-lookup-groups.csv` | Group | Resolve |
| `03-resolved.csv` | Resolve | Export |
| `04-travel-import.csv` | Export | — |
| `photo-location-cache.json` | Resolve | Resolve |

---

## Stage 1 — Extract (parallel)

**Goal:** Read EXIF from every image file; record GPS coords and date taken.
No API calls.

**Implementation:**
- Recursively collect all `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.png` files under `--root-folder`
- `concurrent.futures.ThreadPoolExecutor(max_workers=workers)`
- Each thread calls a pure function `extract_file(path) -> dict`:
  - Opens file with `exifread` (reads tag headers only — never decodes the full image)
  - Extracts GPS rational triplets (lat, lng, lat_ref, lng_ref) → decimal degrees
  - Extracts date taken (EXIF tag 0x9003, fallback 0x0132, fallback file mtime)
  - Returns `{file_path, folder_path, file_name, post_date, latitude, longitude, gps_found}`
  - On any exception: logs a warning, returns row with `gps_found=False` and null coords
- Main thread collects results as futures complete; prints progress every 500 files
  via a `threading.Lock` counter
- Writes `01-extracted.csv`

**Thread safety:** `extract_file` is a pure function with no shared mutable state.
Results aggregated only in the main thread.

---

## Stage 2 — Group (sequential, optional network)

**Goal:** Bucket photos into unique location groups. All groups produce coordinates
so Resolve can reverse-geocode everything through a single consistent code path.

**GPS files:**
- Group by `(round(lat, lookup_precision), round(lng, lookup_precision))`
- Average coordinates within each bucket → `lookup_lat`, `lookup_lng`
- Earliest `post_date` in bucket used for the group
- `source = "GPS"`, `status = "pending"`

**Non-GPS files (folder inference):**
- Extract candidate folder names from the path between `root_folder` and the file,
  applying the ignore list (generic words: photos, camera, dcim, year numbers, etc.)
- For each candidate (longest first): call forward geocode (Nominatim search or
  Geoapify search) to get coordinates for the place name
- On a match: record `lookup_lat`, `lookup_lng` from the geocode result,
  `source = "Folder"`, `status = "pending"`
- Throttle between forward geocode calls (`throttle_ms`)
- Cache successful lookups in memory to avoid repeat calls for the same folder name
- Files with no resolvable folder name are dropped (no group created)

**Key design decision:** Folder-inferred groups are marked `status = "pending"` and
pass through Resolve for reverse-geocoding, exactly like GPS groups. This ensures all
resolved location names come from the same geocoder call direction (reverse), making
string-based dedup in Export reliable.

**Writes:** `02-lookup-groups.csv`

---

## Stage 3 — Resolve (async)

**Goal:** Reverse-geocode every group to a human-readable city/town name.

**Implementation:**
- Load `photo-location-cache.json` at start
- `asyncio` + `aiohttp`, single `ClientSession` for the run
- Concurrency control:
  - Nominatim: `asyncio.Semaphore(1)` — 1 concurrent request (1-req/sec policy)
  - Geoapify: `asyncio.Semaphore(5)` — 5 concurrent requests
- `asyncio.gather()` fires all pending groups up to the semaphore limit
- Per group: call reverse geocode → extract city/town/village from address fields
  (priority order: city → town → village → hamlet → county → state) + country
- Retry 3× with exponential backoff on failure; mark `status = "failed"` if all
  retries exhausted
- Cache written after each successful geocode; final save at stage end
- Cache key: `"{rounded_lat},{rounded_lng}|{provider}|city"` (same format as PS script
  for cache file compatibility)
- Nominatim `zoom=10` (city-level granularity, no street noise)
- Writes `03-resolved.csv`

**Geocoder selection:** Geoapify if `geoapify_api_key` is non-empty, else Nominatim.

---

## Stage 4 — Export (sequential)

**Goal:** Deduplicate resolved groups and produce the final import CSV.

**Dedup logic:**
1. Filter to `status = "resolved"` rows only
2. Group by `resolved_location` string — all groups with the same city name merge
3. Within each name group, pick the row with the earliest `post_date`
4. Sort by `resolved_location` alphabetically

**Output columns** (matches bulk-import CSV format):
```
title, location, notes, post_date, lat, lng, publish
```

- `title` = `title_prefix` from config (e.g. `"Trip"`)
- `location` = `resolved_location`
- `lat`/`lng` = `export_lat`/`export_lng` from the winning row

Writes `04-travel-import.csv`.

---

## Deduplication summary

| Level | Stage | Catches |
|-------|-------|---------|
| Coordinate bucketing | Group | Multiple photos at same location → one geocode call |
| Folder name cache | Group | Same folder name appearing in multiple paths → one forward geocode |
| Name string match | Export | GPS group + folder group that both resolve to same city → one CSV row |

Because all groups (GPS and folder-inferred) pass through the same reverse geocoder
in Resolve, the name string match in Export is reliable — both sources produce names
from the same service and call direction.

---

## Error handling

| Scenario | Behaviour |
|----------|-----------|
| Corrupt / unreadable image | Warning logged; file skipped; Extract continues |
| No GPS and no usable folder name | File produces no group; silently dropped |
| Forward geocode returns no result | Folder candidate skipped; next candidate tried |
| Reverse geocode fails after 3 retries | Group marked `status = "failed"`; excluded from Export |
| No resolved rows in Export | Fatal error with clear message |
| Missing intermediate file for a stage | Fatal error naming the missing file |

---

## Dependencies

```
# requirements.txt
exifread    # EXIF tag reading — header-only, never decodes full image
aiohttp     # async HTTP for Resolve stage
```

No other runtime dependencies. `aiohttp` requires Python 3.8+.

---

## Not in scope

- Video files (MP4 from DJI) — GPS telemetry extraction requires ffprobe; out of scope
- HEIC files — not present in this photo library
- RAW files (DNG) — not present; standard JPEG assumed throughout
- GUI or interactive mode
- Uploading results — script produces the CSV; import is a separate step via the admin panel
