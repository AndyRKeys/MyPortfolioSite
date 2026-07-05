# extract_geo_loc.py — Travel Photo Geo-Location Extractor

Scans a folder tree of travel photos and videos, extracts GPS coordinates from
EXIF/video metadata, reverse-geocodes them to city/town names, deduplicates, and
produces a `04-travel-import.csv` ready for the bulk-import route in the admin panel.

---

## Quick start (PowerShell)

```powershell
cd scripts/tools

# 1. Create a virtual environment and install dependencies
python -m venv .venv
.venv\Scripts\activate

pip install -r requirements.txt

# 2. Copy and edit the config file (optional — see Config section below)
Copy-Item .geo-config.example.json .geo-config.json
#    Verify it was createG:
Test-Path .geo-config.json        # should print: True
#    Open in VS Code to edit (leave geoapify_api_key blank to use free Nominatim geocoder):
code .geo-config.json

# 3. Run all four stages (use backtick ` for line continuation in PowerShell)
python extract_geo_loc.py --stage all `
  --root-folder "G:\Pictures" `
  --working-folder "G:\Pictures\geo-work"

# 4. Upload the result via the admin panel
#    Admin → Travel → Bulk import → choose G:\Pictures\geo-work\04-travel-import.csv
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

```powershell
# Windows — install FFmpeg (pick one)
winget install ffmpeg
# or
choco install ffmpeg

# After installing, close and reopen PowerShell, then verify:
ffprobe -version
```

> **Important:** After installing FFmpeg you must **close and reopen your PowerShell window** before running the script — the new `ffprobe` command won't be on the PATH in your current session.

If `ffprobe -version` still fails after reopening, add FFmpeg to your PATH manually:
1. Download from [ffmpeg.org/download.html](https://ffmpeg.org/download.html) and extract the zip
2. Copy the path to the `bin\` folder inside (e.g. `C:\ffmpeg\bin`)
3. Search Windows for **"Edit the system environment variables"** → Environment Variables → select `Path` → Edit → New → paste the path
4. Restart PowerShell and run `ffprobe -version` to confirm

### exiftool (for writing GPS back to photos)

Required only if you use the `geotag-write` stage. Writes GPS coordinates
into photos that were missing them.

```powershell
winget install exiftool
# After installing, close and reopen PowerShell, then verify:
exiftool -ver
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
| `lookup_precision` | `3` | Decimal places for initial GPS grouping (3 dp ≈ 111 m — photos within ~100 m share a bucket). |
| `city_precision` | `1` | Decimal places for city-level dedup before geocoding (1 dp ≈ 11 km — merges all groups in the same city into one geocode call). Increase to `2` for neighbourhood-level if you travel within large cities. |
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

```powershell
python extract_geo_loc.py --stage all `
  --root-folder "G:\Pictures" `
  --working-folder "G:\Pictures\geo-work"
```

### Stage by stage (useful for large libraries or re-running Resolve with a different provider)

```powershell
# Stage 1: scan all files (slow — reads ~13k files in parallel)
python extract_geo_loc.py --stage extract `
  --root-folder "G:\Pictures" `
  --working-folder "G:\Pictures\geo-work"

# Stage 2: group GPS coords + infer locations from folder names
python extract_geo_loc.py --stage group `
  --root-folder "G:\Pictures" `
  --working-folder "G:\Pictures\geo-work"

# Stage 3: reverse geocode all groups (slow — one API call per group)
python extract_geo_loc.py --stage resolve `
  --working-folder "G:\Pictures\geo-work"

# Stage 4: deduplicate and write final CSV
python extract_geo_loc.py --stage export `
  --working-folder "G:\Pictures\geo-work" `
  --title-prefix "My Trip" `
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

1. **Run Extract and Group:**
   ```powershell
   python extract_geo_loc.py --stage extract `
     --root-folder "G:\Pictures" `
     --working-folder "G:\Pictures\geo-work"

   python extract_geo_loc.py --stage group `
     --root-folder "G:\Pictures" `
     --working-folder "G:\Pictures\geo-work"
   ```

2. **Run Resolve** (one geocode call per city-level group — progress is printed):
   ```powershell
   python extract_geo_loc.py --stage resolve `
     --working-folder "G:\Pictures\geo-work"
   ```

3. **Review and edit `03-resolved.csv` in Excel** — this is the right stage to
   curate. Each row is one city-level group with a geocoded `resolved_location`.
   - Delete rows for places you haven't personally visited (e.g. photos someone
     sent you, or screenshots)
   - Fix any wrong city names by editing the `resolved_location` column directly
   - Save and close Excel before running the next step
   > **Tip:** the geocode cache (`photo-location-cache.json`) means re-running
   > Resolve is free — already-resolved groups are skipped. If you want to
   > re-geocode a row, set its `status` back to `pending` and re-run Resolve.

4. **Run Export** to produce the final import CSV:
   ```powershell
   python extract_geo_loc.py --stage export `
     --working-folder "G:\Pictures\geo-work" `
     --title-prefix "Trip"
   ```

5. **Import via admin panel** — Admin → Travel → Bulk import → choose
   `G:\Pictures\geo-work\04-travel-import.csv`.
   The route returns `{ imported, skipped, errors }`. Skipped rows have missing
   required fields; errors include the row number and reason.

6. **Add photos** — travel memories are imported as drafts with no photos.
   Use the admin Travel editor to attach photos and publish each entry.

---

## Troubleshooting

**`ffprobe not found` warning**
Install FFmpeg (see Prerequisites). Video files will still be processed via
folder-name inference in the meantime.

**Many `status: failed` rows in `03-resolved.csv`**
Network issue or rate limit hit. Re-run just the Resolve stage — the cache means
already-resolved groups are skippeG:
```powershell
python extract_geo_loc.py --stage resolve --working-folder "G:\Pictures\geo-work"
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

## Optional: writing GPS back to photos

After completing the main workflow, you can write the resolved GPS
coordinates back into the original photo files that were missing GPS data.

**This only modifies files where GPS was absent** — photos that already
have GPS coordinates are never touched.

```powershell
# Step 1: Generate the review file (reads 02-file-group-map.csv + 03-resolved.csv)
python extract_geo_loc.py --stage geotag-preview `
  --working-folder "G:\Pictures\geo-work"

# Step 2: Open 05-geotag-preview.csv in Excel
#   - Review which files would be tagged and with what location
#   - Delete any rows for files you do NOT want GPS written to
#   - Save and close Excel

# Step 3: Write GPS to all remaining rows
python extract_geo_loc.py --stage geotag-write `
  --working-folder "G:\Pictures\geo-work"
```

> **Note:** `geotag-write` uses exiftool's `-overwrite_original` flag —
> it modifies files in-place with no backup. Review the preview CSV
> carefully before running this stage.

---

## Running tests

```bash
# Requires Docker
docker run --rm -v "$(pwd)":/work -w /work python:3.12-slim bash -c \
  "pip install -q exifread aiohttp pytest pytest-asyncio && pytest tests/ -v"
```
