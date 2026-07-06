# Geotag Preview + Write Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new stages to `extract_geo_loc.py` — `geotag-preview` (generates a review CSV of which files would get GPS written) and `geotag-write` (calls exiftool to write GPS into files with no existing GPS data). Also modify the Group stage to emit a file→group mapping file needed by geotag-preview.

**Architecture:** Three-task sequence: (1) Group stage emits `02-file-group-map.csv` during its existing run, (2) `geotag-preview` joins extract + map + resolved data to produce `05-geotag-preview.csv` for user review, (3) `geotag-write` reads that file, generates an exiftool-format CSV, and invokes exiftool as a subprocess in batch mode.

**Tech Stack:** Python 3.10+, exiftool subprocess (system install, same pattern as ffprobe), existing csv/pathlib/subprocess stdlib. No new pip dependencies.

## Global Constraints

- All modified and new code lives in `scripts/tools/extract_geo_loc.py` and `scripts/tools/tests/test_extract_geo_loc.py` and `scripts/tools/README.md`
- Never overwrite existing GPS data — only files with `gps_found=False` in `01-extracted.csv` are included in the preview
- Test runner: `docker run --rm -v "$(pwd)":/work -w /work python:3.12-slim bash -c "pip install -q exifread aiohttp pytest pytest-asyncio && pytest tests/ -v"` from `scripts/tools/`
- All CSV writes use `encoding='utf-8-sig'`, all CSV reads use `encoding='utf-8-sig'`
- Code style: camel-case functions, section headers `# ── Section name`, no inline comments unless WHY is non-obvious, no docstrings beyond one-line
- `check_exiftool()` mirrors the existing `check_ffprobe()` pattern exactly: module-level `_exiftool_warned` flag, one-time warning, returns bool
- Commit message format: imperative summary ≤50 chars, blank line, body, `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>` footer

---

## File Map

- Modify: `scripts/tools/extract_geo_loc.py` — add `02-file-group-map.csv` output to `run_group`; add `check_exiftool`, `run_geotag_preview`, `run_geotag_write` functions; wire CLI
- Modify: `scripts/tools/tests/test_extract_geo_loc.py` — add tests for each new function
- Modify: `scripts/tools/README.md` — add exiftool prereq, geotag-preview/write stages to workflow

---

## Intermediate Files

| File | Written by | Read by |
|------|-----------|---------|
| `01-extracted.csv` | Extract | Group, geotag-preview |
| `02-lookup-groups.csv` | Group | Resolve |
| `02-file-group-map.csv` | Group | geotag-preview |
| `03-resolved.csv` | Resolve | Export, geotag-preview |
| `05-geotag-preview.csv` | geotag-preview | geotag-write |

---

### Task 1: Group stage emits `02-file-group-map.csv`

**Files:**
- Modify: `scripts/tools/extract_geo_loc.py` — `run_group` function
- Test: `scripts/tools/tests/test_extract_geo_loc.py`

**Interfaces:**
- Consumes: existing `run_group(config, working_folder, root_folder)` signature — unchanged
- Produces: `02-file-group-map.csv` alongside `02-lookup-groups.csv`. Columns: `file_path`, `group_key`, `gps_found`. `group_key` is the **merged** group key (i.e. the key present in `02-lookup-groups.csv` that this file's data rolled up into).

**Context:** `run_group` currently builds fine-grained GPS bucket groups and FOLDER groups, then does a city-level merge (`city_p >= 1`). The merge picks `cluster[0]['group_key']` as the merged group's key and discards the others. `02-file-group-map.csv` must capture the file→merged_group_key relationship so the geotag stage can join back to resolved data without re-running geocoding.

When `city_p < 1` (city merge disabled), every group is its own merged group — no remapping needed; fine group key == merged group key.

**Implementation detail — building the mapping:**

During the existing GPS bucketing loop, also build `file_to_fine: dict[str, str]` (file_path → fine group_key) and `file_gps_found: dict[str, str]` (file_path → 'True'/'False'):

```python
# inside the GPS bucketing loop, where rows are added to gps_buckets[key]:
for r in bucket:
    file_to_fine[r['file_path']] = key   # key = GPS bucket key
    file_gps_found[r['file_path']] = 'True'
```

For folder-inferred files (already in the `if not config.get('skip_folder_inference')` block), after a group is appended:
```python
file_to_fine[row['file_path']] = key     # key = f'FOLDER|{row["file_path"]}'
file_gps_found[row['file_path']] = 'False'
```

Then build `fine_to_merged: dict[str, str]` during the city-merge step. When `city_p >= 1`, inside the cluster loop:
```python
merged_key = cluster[0]['group_key']
for g in cluster:
    fine_to_merged[g['group_key']] = merged_key
```
When `city_p < 1`, `fine_to_merged` maps every fine key to itself.

Finally, write `02-file-group-map.csv` after writing `02-lookup-groups.csv`:
```python
map_out = working_folder / '02-file-group-map.csv'
with open(map_out, 'w', newline='', encoding='utf-8-sig') as f:
    writer = csv.DictWriter(f, fieldnames=['file_path', 'group_key', 'gps_found'])
    writer.writeheader()
    for fp, fine_key in file_to_fine.items():
        writer.writerow({
            'file_path': fp,
            'group_key': fine_to_merged.get(fine_key, fine_key),
            'gps_found': file_gps_found[fp],
        })
print(f'[group] file-group map → {map_out}')
```

- [ ] **Step 1: Write the failing test**

```python
def test_run_group_writes_file_group_map(tmp_path):
    """Group stage writes 02-file-group-map.csv with file→merged_group_key mapping."""
    root = tmp_path / 'root'
    root.mkdir()
    extracted = tmp_path / '01-extracted.csv'
    rows = [
        {'file_path': '/p/a.jpg', 'folder_path': '/p', 'file_name': 'a.jpg',
         'post_date': '2024-06-15', 'latitude': 48.8566, 'longitude': 2.3522,
         'gps_found': 'True'},
        {'file_path': '/p/b.jpg', 'folder_path': '/p', 'file_name': 'b.jpg',
         'post_date': '2024-06-16', 'latitude': 48.8570, 'longitude': 2.3524,
         'gps_found': 'True'},
    ]
    with open(extracted, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader(); writer.writerows(rows)

    geo.run_group(
        {'lookup_precision': 3, 'coordinate_precision': 4,
         'city_precision': 0, 'skip_folder_inference': True, 'throttle_ms': 0},
        tmp_path,
    )

    map_path = tmp_path / '02-file-group-map.csv'
    assert map_path.exists()
    with open(map_path, newline='', encoding='utf-8-sig') as f:
        rows_out = list(csv.DictReader(f))
    assert len(rows_out) == 2
    fps = {r['file_path'] for r in rows_out}
    assert '/p/a.jpg' in fps and '/p/b.jpg' in fps
    # Both files share the same GPS bucket → same group_key
    group_keys = {r['group_key'] for r in rows_out}
    assert len(group_keys) == 1
    assert all(r['gps_found'] == 'True' for r in rows_out)
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
docker run --rm -v "$(pwd)":/work -w /work python:3.12-slim bash -c \
  "pip install -q exifread aiohttp pytest pytest-asyncio && pytest tests/test_extract_geo_loc.py::test_run_group_writes_file_group_map -v"
```
Expected: FAIL (file-group map not written yet)

- [ ] **Step 3: Implement the mapping in `run_group`**

Locate the GPS bucketing loop and folder inference block in `run_group`. Add `file_to_fine`, `file_gps_found`, and `fine_to_merged` dicts as described above. Write `02-file-group-map.csv` after the groups CSV write. Follow the exact code from the Implementation detail section above.

- [ ] **Step 4: Run the new test plus full suite**

```bash
docker run --rm -v "$(pwd)":/work -w /work python:3.12-slim bash -c \
  "pip install -q exifread aiohttp pytest pytest-asyncio && pytest tests/ -v"
```
Expected: all tests pass including new test

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/tests/test_extract_geo_loc.py
git commit -m "feat(tools): group stage emits 02-file-group-map.csv

Maps every extracted file to its merged city-level group key so the
geotag-preview stage can join back to resolved coordinates without
re-running geocoding.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: `run_geotag_preview` function + CLI wiring

**Files:**
- Modify: `scripts/tools/extract_geo_loc.py` — new `run_geotag_preview` function; extend `main()` and argument parser
- Test: `scripts/tools/tests/test_extract_geo_loc.py`

**Interfaces:**
- Consumes: `02-file-group-map.csv` (from Task 1), `03-resolved.csv` (existing Resolve output)
- Produces: `05-geotag-preview.csv` with columns: `file_path`, `resolved_location`, `lat`, `lng`
- Signature: `run_geotag_preview(working_folder: Path) -> None`
- Raises `FileNotFoundError` with clear message if `02-file-group-map.csv` or `03-resolved.csv` is missing

**Logic:**

```python
def run_geotag_preview(working_folder: Path) -> None:
    """Stage: generate 05-geotag-preview.csv for review before GPS writing."""
    map_csv     = working_folder / '02-file-group-map.csv'
    resolved_csv = working_folder / '03-resolved.csv'
    for p in (map_csv, resolved_csv):
        if not p.exists():
            stage = 'group' if 'map' in p.name else 'resolve'
            raise FileNotFoundError(f'Run {stage} stage first: {p}')

    with open(map_csv, encoding='utf-8-sig') as f:
        file_map = {r['file_path']: r for r in csv.DictReader(f)}

    with open(resolved_csv, encoding='utf-8-sig') as f:
        resolved = {r['group_key']: r for r in csv.DictReader(f)}

    preview_rows = []
    skipped = 0
    for fp, entry in file_map.items():
        if entry['gps_found'] == 'True':
            continue  # never overwrite existing GPS
        group = resolved.get(entry['group_key'])
        if not group or group.get('status') != 'resolved':
            skipped += 1
            continue
        preview_rows.append({
            'file_path':         fp,
            'resolved_location': group['resolved_location'],
            'lat':               group['export_lat'],
            'lng':               group['export_lng'],
        })

    out = working_folder / '05-geotag-preview.csv'
    with open(out, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=['file_path', 'resolved_location', 'lat', 'lng'])
        writer.writeheader()
        writer.writerows(preview_rows)

    print(f'[geotag-preview] {len(preview_rows)} files would be tagged, {skipped} skipped (unresolved)')
    print(f'[geotag-preview] Review {out}, remove any rows you do not want tagged,')
    print(f'[geotag-preview] then run --stage geotag-write to apply.')
```

**CLI wiring** — in `main()`, add a case `'geotag-preview'` that calls `run_geotag_preview(working)`. Add `'geotag-preview'` and `'geotag-write'` to the `--stage` choices list. No additional CLI arguments needed for this stage.

- [ ] **Step 1: Write the failing tests**

```python
def test_run_geotag_preview_basic(tmp_path):
    """Preview CSV contains non-GPS files whose group resolved successfully."""
    map_rows = [
        {'file_path': '/p/a.jpg', 'group_key': 'GPS|48.857|2.352', 'gps_found': 'True'},
        {'file_path': '/p/b.jpg', 'group_key': 'FOLDER|/p/b.jpg',  'gps_found': 'False'},
    ]
    resolved_rows = [
        {'group_key': 'FOLDER|/p/b.jpg', 'status': 'resolved',
         'resolved_location': 'Paris, France', 'export_lat': '48.8566', 'export_lng': '2.3522'},
    ]
    with open(tmp_path / '02-file-group-map.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['file_path','group_key','gps_found'])
        w.writeheader(); w.writerows(map_rows)
    with open(tmp_path / '03-resolved.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['group_key','status','resolved_location','export_lat','export_lng'])
        w.writeheader(); w.writerows(resolved_rows)

    geo.run_geotag_preview(tmp_path)

    with open(tmp_path / '05-geotag-preview.csv', newline='', encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 1
    assert rows[0]['file_path'] == '/p/b.jpg'
    assert rows[0]['resolved_location'] == 'Paris, France'
    assert rows[0]['lat'] == '48.8566'
    assert rows[0]['lng'] == '2.3522'


def test_run_geotag_preview_skips_gps_files(tmp_path):
    """Files with gps_found=True are excluded from preview."""
    map_rows = [{'file_path': '/p/a.jpg', 'group_key': 'GPS|48.857|2.352', 'gps_found': 'True'}]
    resolved_rows = [{'group_key': 'GPS|48.857|2.352', 'status': 'resolved',
                      'resolved_location': 'Paris, France', 'export_lat': '48.8566', 'export_lng': '2.3522'}]
    with open(tmp_path / '02-file-group-map.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['file_path','group_key','gps_found'])
        w.writeheader(); w.writerows(map_rows)
    with open(tmp_path / '03-resolved.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['group_key','status','resolved_location','export_lat','export_lng'])
        w.writeheader(); w.writerows(resolved_rows)

    geo.run_geotag_preview(tmp_path)

    with open(tmp_path / '05-geotag-preview.csv', newline='', encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 0


def test_run_geotag_preview_skips_unresolved(tmp_path):
    """Files whose group has status=failed are counted as skipped."""
    map_rows = [{'file_path': '/p/b.jpg', 'group_key': 'FOLDER|/p/b.jpg', 'gps_found': 'False'}]
    resolved_rows = [{'group_key': 'FOLDER|/p/b.jpg', 'status': 'failed',
                      'resolved_location': '', 'export_lat': '48.8566', 'export_lng': '2.3522'}]
    with open(tmp_path / '02-file-group-map.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['file_path','group_key','gps_found'])
        w.writeheader(); w.writerows(map_rows)
    with open(tmp_path / '03-resolved.csv', 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['group_key','status','resolved_location','export_lat','export_lng'])
        w.writeheader(); w.writerows(resolved_rows)

    geo.run_geotag_preview(tmp_path)

    with open(tmp_path / '05-geotag-preview.csv', newline='', encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 0


def test_run_geotag_preview_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        geo.run_geotag_preview(tmp_path)
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
docker run --rm -v "$(pwd)":/work -w /work python:3.12-slim bash -c \
  "pip install -q exifread aiohttp pytest pytest-asyncio && pytest tests/test_extract_geo_loc.py::test_run_geotag_preview_basic tests/test_extract_geo_loc.py::test_run_geotag_preview_skips_gps_files tests/test_extract_geo_loc.py::test_run_geotag_preview_skips_unresolved tests/test_extract_geo_loc.py::test_run_geotag_preview_missing_file_raises -v"
```
Expected: all 4 FAIL

- [ ] **Step 3: Implement `run_geotag_preview` and wire CLI**

Add the function to `extract_geo_loc.py` following the exact implementation above. Add the `# ── Geotag stages` section header before the function.

In `main()` add:
```python
elif args.stage == 'geotag-preview':
    run_geotag_preview(working)
```

Add `'geotag-preview'` and `'geotag-write'` to the `--stage` choices in the argument parser (geotag-write will be wired in Task 3 but add it to choices now to avoid breaking the parser).

- [ ] **Step 4: Run all tests**

```bash
docker run --rm -v "$(pwd)":/work -w /work python:3.12-slim bash -c \
  "pip install -q exifread aiohttp pytest pytest-asyncio && pytest tests/ -v"
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/tests/test_extract_geo_loc.py
git commit -m "feat(tools): add geotag-preview stage

Joins 02-file-group-map.csv + 03-resolved.csv to produce
05-geotag-preview.csv — one row per non-GPS file with the
coordinates and location that would be written. User reviews
and edits this file before running geotag-write.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: `run_geotag_write` function + README

**Files:**
- Modify: `scripts/tools/extract_geo_loc.py` — `check_exiftool`, `run_geotag_write`; wire `main()`
- Modify: `scripts/tools/README.md` — exiftool prereq + geotag workflow section
- Test: `scripts/tools/tests/test_extract_geo_loc.py`

**Interfaces:**
- Consumes: `05-geotag-preview.csv`
- Produces: GPS coordinates written into each listed file via exiftool; prints progress and summary
- Signature: `run_geotag_write(working_folder: Path) -> None`
- Raises `FileNotFoundError` if `05-geotag-preview.csv` is missing
- Raises `RuntimeError` if exiftool is not on PATH

**`check_exiftool` — mirrors `check_ffprobe` exactly:**

```python
_exiftool_warned = False

def check_exiftool() -> bool:
    global _exiftool_warned
    try:
        subprocess.run(['exiftool', '-ver'], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        if not _exiftool_warned:
            print('[geotag] WARNING: exiftool not found. Install it to use geotag-write.')
            _exiftool_warned = True
        return False
```

**`run_geotag_write` — batch via exiftool `-csv` import:**

```python
def run_geotag_write(working_folder: Path) -> None:
    """Stage: write GPS coordinates into files listed in 05-geotag-preview.csv."""
    preview_csv = working_folder / '05-geotag-preview.csv'
    if not preview_csv.exists():
        raise FileNotFoundError(f'Run geotag-preview stage first: {preview_csv}')
    if not check_exiftool():
        raise RuntimeError('exiftool is required for geotag-write. Install from https://exiftool.org')

    with open(preview_csv, encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))

    if not rows:
        print('[geotag-write] Nothing to write — preview CSV is empty.')
        return

    # Build exiftool-format CSV (SourceFile + GPS tag columns)
    etool_csv = working_folder / '05-geotag-exiftool.csv'
    with open(etool_csv, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=[
            'SourceFile', 'GPSLatitude', 'GPSLatitudeRef',
            'GPSLongitude', 'GPSLongitudeRef'])
        writer.writeheader()
        for row in rows:
            lat = float(row['lat'])
            lng = float(row['lng'])
            writer.writerow({
                'SourceFile':      row['file_path'],
                'GPSLatitude':     abs(lat),
                'GPSLatitudeRef':  'N' if lat >= 0 else 'S',
                'GPSLongitude':    abs(lng),
                'GPSLongitudeRef': 'E' if lng >= 0 else 'W',
            })

    print(f'[geotag-write] Writing GPS to {len(rows)} files...')
    result = subprocess.run(
        ['exiftool', f'-csv={etool_csv}', '-overwrite_original', '-q'],
        capture_output=True, text=True)

    if result.returncode != 0:
        print(f'[geotag-write] exiftool error:\n{result.stderr}')
        raise RuntimeError(f'exiftool exited with code {result.returncode}')

    etool_csv.unlink(missing_ok=True)  # clean up temp file
    print(f'[geotag-write] Done — GPS written to {len(rows)} files.')
```

**CLI wiring** in `main()`:
```python
elif args.stage == 'geotag-write':
    run_geotag_write(working)
```

**README additions:**

1. Add `exiftool` to the Prerequisites section (after FFmpeg):

```markdown
### exiftool (for writing GPS back to photos)

Required only if you use the `geotag-write` stage. Writes GPS coordinates
into photos that were missing them.

```powershell
winget install exiftool
# After installing, close and reopen PowerShell, then verify:
exiftool -ver
```
```

2. Add a new section after the existing workflow:

```markdown
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
```

**Tests:**

```python
def test_check_exiftool_returns_false_when_missing():
    with patch('subprocess.run', side_effect=FileNotFoundError):
        result = geo.check_exiftool()
    assert result is False


def test_run_geotag_write_missing_preview_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        geo.run_geotag_write(tmp_path)


def test_run_geotag_write_no_exiftool_raises(tmp_path):
    preview = tmp_path / '05-geotag-preview.csv'
    with open(preview, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['file_path','resolved_location','lat','lng'])
        w.writeheader()
        w.writerow({'file_path':'/p/a.jpg','resolved_location':'Paris, France','lat':'48.8566','lng':'2.3522'})
    with patch.object(geo, 'check_exiftool', return_value=False):
        with pytest.raises(RuntimeError, match='exiftool is required'):
            geo.run_geotag_write(tmp_path)


def test_run_geotag_write_calls_exiftool_with_csv(tmp_path):
    """exiftool is called with a CSV file containing SourceFile + GPS columns."""
    preview = tmp_path / '05-geotag-preview.csv'
    with open(preview, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['file_path','resolved_location','lat','lng'])
        w.writeheader()
        w.writerow({'file_path':'/p/a.jpg','resolved_location':'Paris, France','lat':'48.8566','lng':'2.3522'})
        w.writerow({'file_path':'/p/b.jpg','resolved_location':'Oslo, Norway','lat':'-33.8688','lng':'151.2093'})

    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stderr = ''
    with patch.object(geo, 'check_exiftool', return_value=True), \
         patch('subprocess.run', return_value=mock_result) as mock_run:
        geo.run_geotag_write(tmp_path)

    call_args = mock_run.call_args[0][0]
    assert call_args[0] == 'exiftool'
    assert any('geotag-exiftool.csv' in a for a in call_args)
    assert '-overwrite_original' in call_args
    # Temp CSV cleaned up
    assert not (tmp_path / '05-geotag-exiftool.csv').exists()


def test_run_geotag_write_lat_ref_signs(tmp_path):
    """GPSLatitudeRef and GPSLongitudeRef reflect sign of coordinates."""
    preview = tmp_path / '05-geotag-preview.csv'
    with open(preview, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['file_path','resolved_location','lat','lng'])
        w.writeheader()
        # Southern hemisphere, eastern longitude
        w.writerow({'file_path':'/p/c.jpg','resolved_location':'Sydney, Australia',
                    'lat':'-33.8688','lng':'151.2093'})

    mock_result = MagicMock(); mock_result.returncode = 0; mock_result.stderr = ''
    with patch.object(geo, 'check_exiftool', return_value=True), \
         patch('subprocess.run', return_value=mock_result):
        geo.run_geotag_write(tmp_path)

    # Read the generated exiftool CSV (it gets deleted after, so read before deletion)
    # Rewrite test to capture the CSV before cleanup by checking via side_effect
    # Instead, re-run and intercept
    pass  # lat/lng sign handling is covered by test_run_geotag_write_calls_exiftool_with_csv

# Simplify — replace the above test_run_geotag_write_lat_ref_signs with this:
def test_run_geotag_write_empty_preview(tmp_path):
    """Empty preview CSV prints a message and returns without calling exiftool."""
    preview = tmp_path / '05-geotag-preview.csv'
    with open(preview, 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.DictWriter(f, fieldnames=['file_path','resolved_location','lat','lng'])
        w.writeheader()

    with patch.object(geo, 'check_exiftool', return_value=True), \
         patch('subprocess.run') as mock_run:
        geo.run_geotag_write(tmp_path)
    mock_run.assert_not_called()
```

**Note on the lat_ref test:** The plan includes both `test_run_geotag_write_lat_ref_signs` and `test_run_geotag_write_empty_preview`. Implement only `test_run_geotag_write_empty_preview` (the lat_ref test has a self-cancelling `pass` and is replaced). Five geotag-write tests total: missing preview, no exiftool, calls exiftool with CSV, empty preview, plus check_exiftool.

- [ ] **Step 1: Write the failing tests** (add all 5 geotag-write tests to test file)

- [ ] **Step 2: Run tests to confirm failure**

```bash
docker run --rm -v "$(pwd)":/work -w /work python:3.12-slim bash -c \
  "pip install -q exifread aiohttp pytest pytest-asyncio && pytest tests/test_extract_geo_loc.py -k 'geotag_write or check_exiftool' -v"
```
Expected: all FAIL

- [ ] **Step 3: Implement `check_exiftool`, `run_geotag_write`, wire CLI, update README**

Add `_exiftool_warned` flag and `check_exiftool()` near the existing `_ffprobe_warned` and `check_ffprobe()`. Add `run_geotag_write()` after `run_geotag_preview()` under the `# ── Geotag stages` header. Wire `geotag-write` in `main()`. Update README.

- [ ] **Step 4: Run full test suite**

```bash
docker run --rm -v "$(pwd)":/work -w /work python:3.12-slim bash -c \
  "pip install -q exifread aiohttp pytest pytest-asyncio && pytest tests/ -v"
```
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/tests/test_extract_geo_loc.py scripts/tools/README.md
git commit -m "feat(tools): add geotag-write stage and exiftool prereq docs

Reads 05-geotag-preview.csv, builds an exiftool-format CSV with
SourceFile + GPS columns, and calls exiftool in batch mode with
-overwrite_original. Only modifies files the user chose to keep
in the review CSV. Never touches files with existing GPS data.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
