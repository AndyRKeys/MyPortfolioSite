# extract_geo_loc.py — Travel Photo Geo-Location Extractor

Scans a folder tree of travel photos and videos, extracts GPS coordinates from
EXIF/video metadata, reverse-geocodes them to city/town names, deduplicates, and
produces a `04-travel-import.csv` ready for the bulk-import route in the admin panel.

---

## Quick start

```bash
cd scripts/tools

# 1. Create a virtual environment and install dependencies
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux

pip install -r requirements.txt

# 2. Copy and edit the config file (optional — see Config section below)
copy .geo-config.example.json .geo-config.json
#    Then open scripts/tools/.geo-config.json in your editor.
#    At minimum, leave geoapify_api_key blank to use the free Nominatim geocoder.

# 3. Run all four stages
python extract_geo_loc.py --stage all \
  --root-folder "D:\Photos" \
  --working-folder "D:\geo-work"

# 4. Upload the result via the admin panel
#    Admin → Travel → Bulk import → choose D:\geo-work\04-travel-import.csv
```

---

## Prerequisites

### Python 3.10+

```bash
python --version   # must be 3.10 or higher
```

### FFmpeg (for video GPS extraction)

Required to extract GPS from DJI Osmo / Samsung video files. Without it, videos
fall through to folder-name inference with a warning — image extraction is unaffected.

```bash
# Windows (pick one)
winget install ffmpeg
choco install ffmpeg

# Verify
ffprobe -version
```

### Python dependencies

```bash
pip install -r requirements.txt
# exifread  — image EXIF parsing
# aiohttp   — async HTTP for reverse geocoding
```

---

## Config file

Copy `.geo-config.example.json` to `.geo-config.json` (gitignored — never committed).

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

| Key | Default | Description |
|-----|---------|-------------|
| `geoapify_api_key` | `""` | Geoapify API key. Leave empty to use Nominatim (free, no signup). |
| `workers` | `16` | Thread count for the Extract stage. Increase on fast SSDs, decrease on HDDs. |
| `throttle_ms` | `1200` | Milliseconds between geocoding requests. 1200 = Nominatim's 1 req/sec policy. Drop to 250 when using Geoapify. |
| `coordinate_precision` | `4` | Decimal places for export lat/lng (4 dp ≈ 11 m accuracy). |
| `lookup_precision` | `3` | Decimal places for grouping (3 dp ≈ 111 m — photos within ~100 m share one geocode call). |
| `title_prefix` | `"Trip"` | Value written to the `title` column in the output CSV. |
| `skip_folder_inference` | `false` | Set `true` to skip the folder-name geocoding fallback for non-GPS files. |
| `user_agent` | `"PhotoGeoExportScript/1.0 (andykeys.me)"` | Sent with Nominatim requests (required by their policy). |

### API key priority

`geoapify_api_key` is resolved in this order (later overrides earlier):

1. `.geo-config.json`
2. `GEOAPIFY_API_KEY` environment variable
3. `--api-key` CLI flag

---

## Geocoding providers

### Nominatim (default — free, no signup)

Uses OpenStreetMap data. Rate limit: 1 request/second. The default `throttle_ms: 1200`
respects this. Good for personal use at this volume.

No configuration needed — works out of the box.

### Geoapify (faster — free tier available)

Allows 5 concurrent requests. After getting an API key from
[myprojects.geoapify.com](https://myprojects.geoapify.com):

```json
{
  "geoapify_api_key": "your-key-here",
  "throttle_ms": 250
}
```

Or pass it at runtime: `--api-key your-key-here`

---

## CLI reference

```
python extract_geo_loc.py --stage <stage> [options]
```

### Required

| Flag | Description |
|------|-------------|
| `--stage` | `extract`, `group`, `resolve`, `export`, or `all` |
| `--working-folder` | Folder for intermediate CSVs and cache file. Created if absent. |

### Conditional

| Flag | When required | Description |
|------|--------------|-------------|
| `--root-folder` | `extract` and `all` | Root folder of your photo library. Scanned recursively. |

### Optional

| Flag | Description |
|------|-------------|
| `--output-csv` | Final CSV path. Default: `<working-folder>/04-travel-import.csv` |
| `--api-key` | Geoapify API key (overrides config file and env var) |
| `--workers` | Thread count for Extract (overrides config file) |
| `--throttle-ms` | Milliseconds between geocode requests (overrides config file) |
| `--title-prefix` | Value for the `title` column in the output CSV |
| `--notes` | Value for the `notes` column in the output CSV |
| `--publish` | Flag — sets `publish=true` in the output CSV (default: false) |
| `--skip-folder-inference` | Skip folder-name geocoding for non-GPS files |

---

## Running stages

### All at once

```bash
python extract_geo_loc.py --stage all \
  --root-folder "D:\Photos" \
  --working-folder "D:\geo-work"
```

### Stage by stage (useful for large libraries or re-running Resolve with a different provider)

```bash
# Stage 1: scan all files (slow — reads ~13k files in parallel)
python extract_geo_loc.py --stage extract \
  --root-folder "D:\Photos" \
  --working-folder "D:\geo-work"

# Stage 2: group GPS coords + infer locations from folder names
python extract_geo_loc.py --stage group \
  --root-folder "D:\Photos" \
  --working-folder "D:\geo-work"

# Stage 3: reverse geocode all groups (slow — one API call per group)
python extract_geo_loc.py --stage resolve \
  --working-folder "D:\geo-work"

# Stage 4: deduplicate and write final CSV
python extract_geo_loc.py --stage export \
  --working-folder "D:\geo-work" \
  --title-prefix "My Trip" \
  --publish
```

Re-running a stage overwrites its output file. The geocode cache
(`photo-location-cache.json`) persists across runs so you are never charged
twice for the same coordinate.

---

## Intermediate files

All written to `--working-folder`:

| File | Written by | Contents |
|------|-----------|----------|
| `01-extracted.csv` | Extract | One row per photo/video — path, date, GPS coords, gps_found flag |
| `02-lookup-groups.csv` | Group | One row per unique location — averaged coords, source (GPS or Folder), status |
| `03-resolved.csv` | Resolve | Groups with `resolved_location` added |
| `04-travel-import.csv` | Export | Final deduplicated import CSV |
| `photo-location-cache.json` | Resolve | Geocode cache — safe to keep across runs |

---

## What gets picked up

| File type | GPS source |
|-----------|-----------|
| `.jpg`, `.jpeg`, `.tif`, `.tiff`, `.png` | EXIF tags (via `exifread`) |
| `.mp4`, `.mov`, `.avi` | ISO 6709 location tag (via `ffprobe`) — DJI Osmo and Samsung Galaxy both embed this |

Files with no GPS data fall through to **folder-name inference**: the script
looks at the folder names between the root and the file, ignores generic words
(`photos`, `camera`, `2024`, etc.), and tries forward-geocoding the most specific
remaining folder name to get approximate coordinates.

---

## Typical workflow for populating travel memories

1. **Run the extractor** on your photo library (takes a few minutes for 13k files):
   ```bash
   python extract_geo_loc.py --stage all \
     --root-folder "D:\Photos" \
     --working-folder "D:\geo-work" \
     --title-prefix "Trip"
   ```

2. **Review the output** — open `04-travel-import.csv` in Excel or VS Code and
   check the `location` column. Edit any wrong city names before importing.

3. **Import via admin panel** — Admin → Travel → Bulk import → choose the CSV.
   The route returns `{ imported, skipped, errors }`. Skipped rows have missing
   required fields; errors include the row number and reason.

4. **Add photos** — travel memories are imported as drafts with no photos.
   Use the admin Travel editor to attach photos and publish each entry.

---

## Troubleshooting

**`ffprobe not found` warning**
Install FFmpeg (see Prerequisites). Video files will still be processed via
folder-name inference in the meantime.

**Many `status: failed` rows in `03-resolved.csv`**
Network issue or rate limit hit. Re-run just the Resolve stage — the cache means
already-resolved groups are skipped:
```bash
python extract_geo_loc.py --stage resolve --working-folder "D:\geo-work"
```

**Folder inference not finding a city**
The folder name didn't match anything in the geocoder. Check `02-lookup-groups.csv`
for rows with `source: Folder` — the `group_key` contains the file path, which
tells you which folder name was tried. Rename the folder or edit the resolved CSV
manually before running Export.

**Output has too many duplicate cities**
Reduce `lookup_precision` (e.g. `2` instead of `3`) so a larger radius is treated
as one group. Or edit `03-resolved.csv` directly to merge entries before running
Export.

**`No resolved locations found` error in Export**
All groups failed geocoding. Check your internet connection and run Resolve again.
If using Nominatim, make sure `throttle_ms` is at least `1200`.

---

## Running tests

```bash
# Requires Docker
docker run --rm -v "$(pwd)":/work -w /work python:3.12-slim bash -c \
  "pip install -q exifread aiohttp pytest pytest-asyncio && pytest tests/ -v"
```
