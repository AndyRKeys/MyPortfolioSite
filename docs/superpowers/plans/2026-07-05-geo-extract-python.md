# Python Geo-Location Extractor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `scripts/tools/extract-geo-loc.ps1` with a Python script that scans ~13k travel photos/videos in parallel, extracts GPS coordinates, reverse-geocodes them to city/town names, and produces a `04-travel-import.csv` for the bulk-import admin route.

**Architecture:** Four sequential stages (extract → group → resolve → export) with intermediate CSVs. Extract uses `ThreadPoolExecutor` for parallel EXIF/video metadata reading. Group runs sequential forward geocoding for folder-name inference. Resolve runs `asyncio` + `aiohttp` for concurrent reverse geocoding. Export deduplicates by resolved name and writes the final CSV.

**Tech Stack:** Python 3.10+, `exifread` (EXIF image parsing), `aiohttp` (async HTTP), `ffprobe` subprocess (video GPS), `urllib.request` stdlib (synchronous HTTP in Group), `pytest` + `pytest-asyncio` (tests)

## Global Constraints

- Python 3.10+ required (union type hints `X | Y`, `match` statements)
- Two pip runtime deps only: `exifread`, `aiohttp` — no `requests`, no `Pillow`
- `ffprobe` is a system dep (FFmpeg) — absence must degrade gracefully, not crash
- All intermediate files use the same names as the PowerShell script for cache compatibility: `01-extracted.csv`, `02-lookup-groups.csv`, `03-resolved.csv`, `04-travel-import.csv`, `photo-location-cache.json`
- Config priority: `.geo-config.json` → `GEOAPIFY_API_KEY` env var → `--api-key` CLI arg
- Nominatim: `Semaphore(1)` + 1200 ms throttle per request; Geoapify: `Semaphore(5)` + 250 ms throttle
- Cache key format: `"{rounded_lat},{rounded_lng}|{provider}|city"` — same as PS script
- Nominatim `zoom=10` (city-level, no street noise)
- GPS address field priority: city → town → village → hamlet → municipality → county → state_district → state
- `scripts/tools/.geo-config.json` must be in `.gitignore`
- No code runs at module import (all logic in functions; `if __name__ == '__main__': main()` guard)

---

## File Map

```
scripts/tools/
  extract_geo_loc.py          CREATE  — single script, all four stages + helpers
  requirements.txt            CREATE  — exifread, aiohttp
  requirements-dev.txt        CREATE  — pytest, pytest-asyncio
  .geo-config.example.json    CREATE  — committed template
  tests/
    __init__.py               CREATE  — empty, makes tests a package
    test_extract_geo_loc.py   CREATE  — full test suite (all tasks)
.gitignore                    MODIFY  — add scripts/tools/.geo-config.json
```

---

## Task 1: Scaffold — project files, config loading, CLI skeleton

**Files:**
- Create: `scripts/tools/extract_geo_loc.py`
- Create: `scripts/tools/requirements.txt`
- Create: `scripts/tools/requirements-dev.txt`
- Create: `scripts/tools/.geo-config.example.json`
- Create: `scripts/tools/tests/__init__.py`
- Create: `scripts/tools/tests/test_extract_geo_loc.py`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `load_config(args: argparse.Namespace) -> dict` — all later tasks call this to get the merged config

- [ ] **Step 1: Add `.geo-config.json` to `.gitignore`**

Open `.gitignore` and append:

```
# Geo-extract tool — local config with API key
scripts/tools/.geo-config.json
scripts/tools/.venv/
scripts/tools/__pycache__/
scripts/tools/tests/__pycache__/
```

- [ ] **Step 2: Create `requirements.txt` and `requirements-dev.txt`**

`scripts/tools/requirements.txt`:
```
exifread>=2.3.2
aiohttp>=3.9.0
```

`scripts/tools/requirements-dev.txt`:
```
pytest>=8.0.0
pytest-asyncio>=0.23.0
```

- [ ] **Step 3: Create `.geo-config.example.json`**

```json
{
  "_comment": "Copy to .geo-config.json and fill in values. geoapify_api_key is optional — omit to use Nominatim (free, no signup).",
  "geoapify_api_key":       "",
  "workers":                16,
  "throttle_ms":          1200,
  "coordinate_precision":    4,
  "lookup_precision":        3,
  "title_prefix":        "Trip",
  "skip_folder_inference": false,
  "user_agent": "PhotoGeoExportScript/1.0 (andykeys.me)"
}
```

- [ ] **Step 4: Create `scripts/tools/tests/__init__.py`**

Empty file — makes `tests/` a package so pytest discovers it.

- [ ] **Step 5: Write the failing config test**

`scripts/tools/tests/test_extract_geo_loc.py`:

```python
import sys
import json
import argparse
import os
from pathlib import Path
from unittest.mock import patch, mock_open

sys.path.insert(0, str(Path(__file__).parent.parent))
import extract_geo_loc as geo


def _args(**kwargs):
    """Build a minimal argparse.Namespace for testing."""
    defaults = {
        'api_key': None, 'workers': None, 'throttle_ms': None,
        'title_prefix': None, 'notes': '', 'publish': False,
        'skip_folder_inference': False,
        'root_folder': None, 'working_folder': '/tmp/work',
        'output_csv': None, 'stage': 'extract',
    }
    defaults.update(kwargs)
    return argparse.Namespace(**defaults)


def test_load_config_defaults_when_no_file(tmp_path):
    """No config file → falls back to built-in defaults."""
    config = geo.load_config(_args(), config_path=tmp_path / '.geo-config.json')
    assert config['workers'] == 16
    assert config['throttle_ms'] == 1200
    assert config['coordinate_precision'] == 4
    assert config['lookup_precision'] == 3
    assert config['title_prefix'] == 'Trip'
    assert config['skip_folder_inference'] is False
    assert config['geoapify_api_key'] == ''


def test_load_config_reads_json_file(tmp_path):
    """Values in .geo-config.json override defaults."""
    cfg = tmp_path / '.geo-config.json'
    cfg.write_text(json.dumps({'workers': 32, 'throttle_ms': 500}))
    config = geo.load_config(_args(), config_path=cfg)
    assert config['workers'] == 32
    assert config['throttle_ms'] == 500
    assert config['coordinate_precision'] == 4  # default preserved


def test_load_config_env_var_overrides_file(tmp_path):
    """GEOAPIFY_API_KEY env var overrides config file."""
    cfg = tmp_path / '.geo-config.json'
    cfg.write_text(json.dumps({'geoapify_api_key': 'from-file'}))
    with patch.dict(os.environ, {'GEOAPIFY_API_KEY': 'from-env'}):
        config = geo.load_config(_args(), config_path=cfg)
    assert config['geoapify_api_key'] == 'from-env'


def test_load_config_cli_arg_overrides_env(tmp_path):
    """--api-key CLI arg overrides env var."""
    with patch.dict(os.environ, {'GEOAPIFY_API_KEY': 'from-env'}):
        config = geo.load_config(_args(api_key='from-cli'),
                                  config_path=tmp_path / '.geo-config.json')
    assert config['geoapify_api_key'] == 'from-cli'
```

- [ ] **Step 6: Run test — confirm it fails**

```bash
cd scripts/tools
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt
pytest tests/test_extract_geo_loc.py::test_load_config_defaults_when_no_file -v
```

Expected: `FAILED` — `ModuleNotFoundError: No module named 'extract_geo_loc'`

- [ ] **Step 7: Create `extract_geo_loc.py` with config loading and CLI skeleton**

```python
"""
extract_geo_loc.py — Travel photo geo-location extractor.

Usage:
    python extract_geo_loc.py --stage all --root-folder "D:\\Photos" --working-folder "D:\\geo-work"
    python extract_geo_loc.py --stage resolve --working-folder "D:\\geo-work" --api-key "abc123"
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import functools
import json
import math
import os
import re
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import aiohttp
import exifread

# ── Constants

DEFAULTS: dict = {
    'geoapify_api_key':      '',
    'workers':               16,
    'throttle_ms':         1200,
    'coordinate_precision':   4,
    'lookup_precision':       3,
    'title_prefix':       'Trip',
    'skip_folder_inference': False,
    'user_agent': 'PhotoGeoExportScript/1.0 (andykeys.me)',
}

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.tif', '.tiff', '.png'}
VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi'}

FOLDER_IGNORE = {
    'photos', 'pictures', 'camera', 'phone', 'mobile', 'dcim', 'imports', 'import',
    'unsorted', 'misc', 'random', 'favorites', 'favourites', 'edited', 'exports',
    'raw', 'jpg', 'jpeg', 'png', 'heic', 'tiff', 'img', 'images', 'album', 'albums',
    'holidays', 'holiday', 'trip', 'travel',
    '2020', '2021', '2022', '2023', '2024', '2025', '2026', '2027',
}

ADDRESS_FIELDS = ('city', 'town', 'village', 'hamlet', 'municipality',
                  'county', 'state_district', 'state')

# ── Config

def load_config(args: argparse.Namespace,
                config_path: Path | None = None) -> dict:
    """Merge config from file → env var → CLI args. Returns complete config dict."""
    config = dict(DEFAULTS)

    # 1. JSON file
    if config_path is None:
        config_path = Path(__file__).parent / '.geo-config.json'
    if config_path.exists():
        with open(config_path, encoding='utf-8') as f:
            file_cfg = json.load(f)
        for k, v in file_cfg.items():
            if not k.startswith('_') and k in DEFAULTS:
                config[k] = v

    # 2. Env var
    env_key = os.environ.get('GEOAPIFY_API_KEY', '').strip()
    if env_key:
        config['geoapify_api_key'] = env_key

    # 3. CLI args
    if getattr(args, 'api_key', None):
        config['geoapify_api_key'] = args.api_key
    if getattr(args, 'workers', None) is not None:
        config['workers'] = args.workers
    if getattr(args, 'throttle_ms', None) is not None:
        config['throttle_ms'] = args.throttle_ms
    if getattr(args, 'title_prefix', None) is not None:
        config['title_prefix'] = args.title_prefix
    if getattr(args, 'skip_folder_inference', False):
        config['skip_folder_inference'] = True

    # Attach non-config CLI args for stage functions
    config['notes']   = getattr(args, 'notes', '')
    config['publish'] = getattr(args, 'publish', False)

    return config


# ── CLI (placeholder — filled in Task 7)

def main() -> None:
    pass


if __name__ == '__main__':
    main()
```

- [ ] **Step 8: Run tests — confirm they pass**

```bash
pytest tests/test_extract_geo_loc.py -k "config" -v
```

Expected: `4 passed`

- [ ] **Step 9: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/requirements.txt \
        scripts/tools/requirements-dev.txt scripts/tools/.geo-config.example.json \
        scripts/tools/tests/__init__.py scripts/tools/tests/test_extract_geo_loc.py \
        .gitignore
git commit -m "feat(geo-extract): scaffold — config loading, CLI skeleton, test harness"
```

---

## Task 2: Image EXIF GPS + date parsing

**Files:**
- Modify: `scripts/tools/extract_geo_loc.py` — add `_rational_to_decimal`, `parse_gps_exif`, `parse_date_exif`
- Modify: `scripts/tools/tests/test_extract_geo_loc.py` — add image parsing tests

**Interfaces:**
- Produces:
  - `parse_gps_exif(path: Path) -> tuple[float, float] | None` — `(lat, lng)` decimal degrees, or `None`
  - `parse_date_exif(path: Path) -> str` — `"YYYY-MM-DD"`, never raises

- [ ] **Step 1: Write failing tests**

Append to `test_extract_geo_loc.py`:

```python
# ── Image EXIF tests

from unittest.mock import MagicMock


def _make_rational(deg, min_, sec):
    """Build exifread-style IfdTag with rational GPS values."""
    def ratio(n, d=1):
        r = MagicMock()
        r.num = n
        r.den = d
        return r
    tag = MagicMock()
    tag.values = [ratio(deg), ratio(int(min_), 1), ratio(int(sec * 1000), 1000)]
    return tag


def test_rational_to_decimal_basic():
    tag = _make_rational(51, 30, 26.0)
    result = geo._rational_to_decimal(tag.values)
    assert result is not None
    assert abs(result - 51.507222) < 0.0001


def test_rational_to_decimal_zero_denominator():
    tag = MagicMock()
    bad = MagicMock(); bad.num = 1; bad.den = 0
    tag.values = [bad, bad, bad]
    assert geo._rational_to_decimal(tag.values) is None


def test_parse_gps_exif_north_east(tmp_path):
    """Standard northern/eastern GPS returns positive lat and lng."""
    img = tmp_path / 'photo.jpg'
    img.write_bytes(b'')
    lat_tag = _make_rational(51, 30, 26.0)   # 51.507°N
    lon_tag = _make_rational(0, 7, 39.0)     # 0.1275°E
    ref_n = MagicMock(); ref_n.__str__ = lambda _: 'N'
    ref_e = MagicMock(); ref_e.__str__ = lambda _: 'E'

    tags = {
        'GPS GPSLatitude':     lat_tag,
        'GPS GPSLatitudeRef':  ref_n,
        'GPS GPSLongitude':    lon_tag,
        'GPS GPSLongitudeRef': ref_e,
    }
    with patch('exifread.process_file', return_value=tags):
        result = geo.parse_gps_exif(img)
    assert result is not None
    lat, lng = result
    assert abs(lat - 51.5072) < 0.001
    assert lng > 0


def test_parse_gps_exif_south_west(tmp_path):
    """Southern/western GPS flips signs."""
    img = tmp_path / 'photo.jpg'
    img.write_bytes(b'')
    lat_tag = _make_rational(33, 51, 54.0)
    lon_tag = _make_rational(151, 12, 25.0)
    ref_s = MagicMock(); ref_s.__str__ = lambda _: 'S'
    ref_w = MagicMock(); ref_w.__str__ = lambda _: 'W'

    tags = {
        'GPS GPSLatitude':     lat_tag,
        'GPS GPSLatitudeRef':  ref_s,
        'GPS GPSLongitude':    lon_tag,
        'GPS GPSLongitudeRef': ref_w,
    }
    with patch('exifread.process_file', return_value=tags):
        result = geo.parse_gps_exif(img)
    assert result is not None
    lat, lng = result
    assert lat < 0
    assert lng < 0


def test_parse_gps_exif_no_gps_tag(tmp_path):
    """Missing GPS tags returns None."""
    img = tmp_path / 'photo.jpg'
    img.write_bytes(b'')
    with patch('exifread.process_file', return_value={}):
        assert geo.parse_gps_exif(img) is None


def test_parse_gps_exif_corrupt_file(tmp_path):
    """Exception during EXIF read returns None, does not raise."""
    img = tmp_path / 'bad.jpg'
    img.write_bytes(b'not an image')
    with patch('exifread.process_file', side_effect=Exception('corrupt')):
        assert geo.parse_gps_exif(img) is None


def test_parse_date_exif_from_tag(tmp_path):
    """DateTimeOriginal EXIF tag is preferred."""
    img = tmp_path / 'photo.jpg'
    img.write_bytes(b'')
    date_tag = MagicMock(); date_tag.__str__ = lambda _: '2024:06:15 10:30:00'
    with patch('exifread.process_file', return_value={'EXIF DateTimeOriginal': date_tag}):
        assert geo.parse_date_exif(img) == '2024-06-15'


def test_parse_date_exif_fallback_to_mtime(tmp_path):
    """Falls back to file mtime when no EXIF date."""
    img = tmp_path / 'photo.jpg'
    img.write_bytes(b'')
    with patch('exifread.process_file', return_value={}):
        result = geo.parse_date_exif(img)
    assert re.match(r'\d{4}-\d{2}-\d{2}', result)
```

- [ ] **Step 2: Run — confirm failure**

```bash
pytest tests/test_extract_geo_loc.py -k "rational or exif or parse_date_exif" -v
```

Expected: `FAILED` — `AttributeError: module 'extract_geo_loc' has no attribute '_rational_to_decimal'`

- [ ] **Step 3: Implement in `extract_geo_loc.py`**

Add after the `DEFAULTS` / constants block, before `load_config`:

```python
# ── EXIF image parsing

def _rational_to_decimal(values: list) -> float | None:
    """Convert exifread GPS rational triplet (deg, min, sec) to decimal degrees."""
    try:
        d = values[0].num / values[0].den
        m = values[1].num / values[1].den
        s = values[2].num / values[2].den
        return d + m / 60.0 + s / 3600.0
    except (IndexError, ZeroDivisionError, AttributeError):
        return None


def parse_gps_exif(path: Path) -> tuple[float, float] | None:
    """Extract (latitude, longitude) decimal degrees from JPEG/TIFF EXIF.
    Returns None if GPS tags absent or file is unreadable."""
    try:
        with open(path, 'rb') as f:
            tags = exifread.process_file(f, details=False,
                                         stop_tag='GPS GPSLongitude')
        lat_tag = tags.get('GPS GPSLatitude')
        lng_tag = tags.get('GPS GPSLongitude')
        if not (lat_tag and lng_tag):
            return None

        lat = _rational_to_decimal(lat_tag.values)
        lng = _rational_to_decimal(lng_tag.values)
        if lat is None or lng is None:
            return None

        if str(tags.get('GPS GPSLatitudeRef', 'N')) == 'S':
            lat = -lat
        if str(tags.get('GPS GPSLongitudeRef', 'E')) == 'W':
            lng = -lng

        return round(lat, 6), round(lng, 6)
    except Exception:
        return None


def parse_date_exif(path: Path) -> str:
    """Extract date taken from EXIF; falls back to file mtime. Always returns YYYY-MM-DD."""
    try:
        with open(path, 'rb') as f:
            tags = exifread.process_file(f, details=False,
                                         stop_tag='EXIF DateTimeOriginal')
        tag = tags.get('EXIF DateTimeOriginal') or tags.get('Image DateTime')
        if tag:
            raw = str(tag)  # "2024:06:15 10:30:00"
            return raw[:10].replace(':', '-')
    except Exception:
        pass
    return datetime.fromtimestamp(path.stat().st_mtime).strftime('%Y-%m-%d')
```

- [ ] **Step 4: Run — confirm pass**

```bash
pytest tests/test_extract_geo_loc.py -k "rational or exif or parse_date_exif" -v
```

Expected: `9 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/tests/test_extract_geo_loc.py
git commit -m "feat(geo-extract): image EXIF GPS and date parsing"
```

---

## Task 3: Video GPS + date parsing via ffprobe

**Files:**
- Modify: `scripts/tools/extract_geo_loc.py` — add `_parse_iso6709`, `parse_gps_video`, `parse_date_video`, `check_ffprobe`
- Modify: `scripts/tools/tests/test_extract_geo_loc.py` — add video parsing tests

**Interfaces:**
- Produces:
  - `check_ffprobe() -> bool` — returns True if `ffprobe` is on PATH, prints warning once if not
  - `parse_gps_video(path: Path) -> tuple[float, float] | None`
  - `parse_date_video(path: Path) -> str` — always returns `"YYYY-MM-DD"`

- [ ] **Step 1: Write failing tests**

Append to `test_extract_geo_loc.py`:

```python
# ── Video / ffprobe tests

def test_parse_iso6709_north_east():
    assert geo._parse_iso6709('+51.5074-000.1278/') == (51.5074, -0.1278)


def test_parse_iso6709_south_west():
    lat, lng = geo._parse_iso6709('-33.8651+151.2099/')
    assert lat < 0 and lng > 0


def test_parse_iso6709_no_match():
    assert geo._parse_iso6709('not-a-location') is None


def _ffprobe_output(location=None, creation_time=None):
    tags = {}
    if location:
        tags['location'] = location
    if creation_time:
        tags['creation_time'] = creation_time
    return json.dumps({'format': {'tags': tags}, 'streams': []})


def test_parse_gps_video_from_format_tags(tmp_path):
    vid = tmp_path / 'clip.mp4'
    vid.write_bytes(b'')
    ffout = _ffprobe_output(location='+48.8566+002.3522/')
    with patch('subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout=ffout)
        result = geo.parse_gps_video(vid)
    assert result is not None
    lat, lng = result
    assert abs(lat - 48.8566) < 0.001
    assert abs(lng - 2.3522) < 0.001


def test_parse_gps_video_no_location_tag(tmp_path):
    vid = tmp_path / 'clip.mp4'
    vid.write_bytes(b'')
    with patch('subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(returncode=0,
                                           stdout=json.dumps({'format': {'tags': {}}, 'streams': []}))
        assert geo.parse_gps_video(vid) is None


def test_parse_gps_video_ffprobe_absent(tmp_path):
    vid = tmp_path / 'clip.mp4'
    vid.write_bytes(b'')
    with patch('subprocess.run', side_effect=FileNotFoundError):
        assert geo.parse_gps_video(vid) is None


def test_parse_date_video_from_creation_time(tmp_path):
    vid = tmp_path / 'clip.mp4'
    vid.write_bytes(b'')
    ffout = _ffprobe_output(creation_time='2024-06-15T10:30:00.000000Z')
    with patch('subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout=ffout)
        assert geo.parse_date_video(vid) == '2024-06-15'


def test_parse_date_video_fallback_to_mtime(tmp_path):
    vid = tmp_path / 'clip.mp4'
    vid.write_bytes(b'')
    with patch('subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(returncode=0,
                                           stdout=json.dumps({'format': {'tags': {}}, 'streams': []}))
        result = geo.parse_date_video(vid)
    assert re.match(r'\d{4}-\d{2}-\d{2}', result)


def test_check_ffprobe_available():
    with patch('subprocess.run') as mock_run:
        mock_run.return_value = MagicMock(returncode=0)
        assert geo.check_ffprobe() is True


def test_check_ffprobe_absent():
    with patch('subprocess.run', side_effect=FileNotFoundError):
        assert geo.check_ffprobe() is False
```

- [ ] **Step 2: Run — confirm failure**

```bash
pytest tests/test_extract_geo_loc.py -k "iso6709 or video or ffprobe" -v
```

Expected: `FAILED` — attribute errors

- [ ] **Step 3: Implement in `extract_geo_loc.py`**

Add after the `parse_date_exif` function:

```python
# ── Video GPS parsing via ffprobe

def check_ffprobe() -> bool:
    """Return True if ffprobe is on PATH. Prints a one-time warning if absent."""
    try:
        subprocess.run(['ffprobe', '-version'], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        print('[extract] WARNING: ffprobe not found — video files will fall through '
              'to folder inference. Install FFmpeg to enable video GPS extraction.')
        return False


def _parse_iso6709(location_str: str) -> tuple[float, float] | None:
    """Parse ISO 6709 location string e.g. '+51.5074-000.1278/' → (lat, lng)."""
    match = re.match(r'^([+-]\d+\.?\d*)([+-]\d+\.?\d*)', location_str.strip())
    if not match:
        return None
    return float(match.group(1)), float(match.group(2))


def _run_ffprobe(path: Path) -> dict | None:
    """Run ffprobe and return parsed JSON, or None on any failure."""
    try:
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json',
             '-show_format', '-show_streams', str(path)],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError,
            OSError):
        return None


def parse_gps_video(path: Path) -> tuple[float, float] | None:
    """Extract (latitude, longitude) from video metadata via ffprobe.
    Returns None if GPS absent, ffprobe unavailable, or file unreadable."""
    data = _run_ffprobe(path)
    if data is None:
        return None

    # Check format tags (DJI and Samsung both store location here)
    tags = data.get('format', {}).get('tags', {})
    location = (tags.get('location') or
                tags.get('com.apple.quicktime.location.ISO6709') or
                tags.get('location-eng'))

    # Fall back to stream tags
    if not location:
        for stream in data.get('streams', []):
            location = stream.get('tags', {}).get('location')
            if location:
                break

    return _parse_iso6709(location) if location else None


def parse_date_video(path: Path) -> str:
    """Extract recording date from video metadata; falls back to file mtime."""
    data = _run_ffprobe(path)
    if data:
        creation_time = data.get('format', {}).get('tags', {}).get('creation_time', '')
        if creation_time:
            return creation_time[:10]  # "2024-06-15T10:30:00Z" → "2024-06-15"
    return datetime.fromtimestamp(path.stat().st_mtime).strftime('%Y-%m-%d')
```

- [ ] **Step 4: Run — confirm pass**

```bash
pytest tests/test_extract_geo_loc.py -k "iso6709 or video or ffprobe" -v
```

Expected: `10 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/tests/test_extract_geo_loc.py
git commit -m "feat(geo-extract): video GPS and date extraction via ffprobe subprocess"
```

---

## Task 4: Extract stage — parallel file scanning

**Files:**
- Modify: `scripts/tools/extract_geo_loc.py` — add `extract_file`, `run_extract`
- Modify: `scripts/tools/tests/test_extract_geo_loc.py` — add extract stage tests

**Interfaces:**
- Consumes: `parse_gps_exif`, `parse_date_exif`, `parse_gps_video`, `parse_date_video`, `check_ffprobe`
- Produces: `run_extract(config: dict, root_folder: Path, working_folder: Path) -> None` — writes `01-extracted.csv` with columns: `file_path, folder_path, file_name, post_date, latitude, longitude, gps_found`

- [ ] **Step 1: Write failing tests**

Append to `test_extract_geo_loc.py`:

```python
# ── Extract stage tests

def test_extract_file_image_with_gps(tmp_path):
    img = tmp_path / 'photo.jpg'
    img.write_bytes(b'')
    with patch.object(geo, 'parse_gps_exif', return_value=(51.5, -0.12)), \
         patch.object(geo, 'parse_date_exif', return_value='2024-06-15'):
        row = geo.extract_file(img, ffprobe_available=False)
    assert row['gps_found'] is True
    assert row['latitude'] == 51.5
    assert row['longitude'] == -0.12
    assert row['post_date'] == '2024-06-15'
    assert row['file_name'] == 'photo.jpg'


def test_extract_file_image_no_gps(tmp_path):
    img = tmp_path / 'photo.jpg'
    img.write_bytes(b'')
    with patch.object(geo, 'parse_gps_exif', return_value=None), \
         patch.object(geo, 'parse_date_exif', return_value='2024-01-01'):
        row = geo.extract_file(img, ffprobe_available=False)
    assert row['gps_found'] is False
    assert row['latitude'] is None


def test_extract_file_video_with_gps(tmp_path):
    vid = tmp_path / 'clip.mp4'
    vid.write_bytes(b'')
    with patch.object(geo, 'parse_gps_video', return_value=(48.8, 2.35)), \
         patch.object(geo, 'parse_date_video', return_value='2024-07-01'):
        row = geo.extract_file(vid, ffprobe_available=True)
    assert row['gps_found'] is True
    assert row['latitude'] == 48.8


def test_extract_file_video_ffprobe_unavailable(tmp_path):
    """When ffprobe absent, video is processed as no-GPS without calling parse_gps_video."""
    vid = tmp_path / 'clip.mp4'
    vid.write_bytes(b'')
    with patch.object(geo, 'parse_date_video', return_value='2024-01-01') as mock_date, \
         patch.object(geo, 'parse_gps_video') as mock_gps:
        row = geo.extract_file(vid, ffprobe_available=False)
    mock_gps.assert_not_called()
    assert row['gps_found'] is False


def test_run_extract_writes_csv(tmp_path):
    root = tmp_path / 'photos'
    root.mkdir()
    (root / 'photo.jpg').write_bytes(b'')
    (root / 'clip.mp4').write_bytes(b'')

    with patch.object(geo, 'check_ffprobe', return_value=False), \
         patch.object(geo, 'parse_gps_exif', return_value=(51.5, -0.12)), \
         patch.object(geo, 'parse_date_exif', return_value='2024-06-15'), \
         patch.object(geo, 'parse_date_video', return_value='2024-06-15'):
        geo.run_extract({'workers': 2, 'skip_folder_inference': True},
                        root, tmp_path)

    csv_path = tmp_path / '01-extracted.csv'
    assert csv_path.exists()
    rows = list(csv.DictReader(csv_path.open()))
    assert len(rows) == 2
    gps_rows = [r for r in rows if r['gps_found'] == 'True']
    assert len(gps_rows) == 1
```

- [ ] **Step 2: Run — confirm failure**

```bash
pytest tests/test_extract_geo_loc.py -k "extract_file or run_extract" -v
```

Expected: `FAILED` — attribute errors

- [ ] **Step 3: Implement in `extract_geo_loc.py`**

Add after the video parsing functions:

```python
# ── Extract stage

def extract_file(path: Path, ffprobe_available: bool) -> dict:
    """Extract GPS + date from one file. Pure function safe for ThreadPoolExecutor.
    Never raises — returns gps_found=False on any error."""
    row: dict = {
        'file_path':  str(path),
        'folder_path': str(path.parent),
        'file_name':  path.name,
        'post_date':  None,
        'latitude':   None,
        'longitude':  None,
        'gps_found':  False,
    }
    try:
        ext = path.suffix.lower()
        if ext in IMAGE_EXTENSIONS:
            gps = parse_gps_exif(path)
            row['post_date'] = parse_date_exif(path)
        elif ext in VIDEO_EXTENSIONS and ffprobe_available:
            gps = parse_gps_video(path)
            row['post_date'] = parse_date_video(path)
        else:
            gps = None
            row['post_date'] = datetime.fromtimestamp(
                path.stat().st_mtime).strftime('%Y-%m-%d')

        if gps:
            row['latitude']  = gps[0]
            row['longitude'] = gps[1]
            row['gps_found'] = True
    except Exception as exc:
        print(f'[extract] WARNING: skipping {path.name} — {exc}')
    return row


def run_extract(config: dict, root_folder: Path, working_folder: Path) -> None:
    """Stage 1: scan all images and videos in parallel, write 01-extracted.csv."""
    extensions = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
    files = [
        f for f in root_folder.rglob('*')
        if f.is_file() and f.suffix.lower() in extensions
    ]
    if not files:
        raise FileNotFoundError(f'No supported files found under: {root_folder}')

    ffprobe_ok = check_ffprobe()
    worker = functools.partial(extract_file, ffprobe_available=ffprobe_ok)
    total = len(files)
    results: list[dict] = []

    print(f'[extract] Scanning {total} files with {config["workers"]} workers...')
    with ThreadPoolExecutor(max_workers=config['workers']) as executor:
        futures = {executor.submit(worker, f): f for f in files}
        for i, future in enumerate(as_completed(futures), 1):
            results.append(future.result())
            if i % 500 == 0 or i == total:
                print(f'[extract] {i}/{total}')

    out = working_folder / '01-extracted.csv'
    fieldnames = ['file_path', 'folder_path', 'file_name',
                  'post_date', 'latitude', 'longitude', 'gps_found']
    with open(out, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)
    print(f'[extract] Done → {out}')
```

- [ ] **Step 4: Run — confirm pass**

```bash
pytest tests/test_extract_geo_loc.py -k "extract_file or run_extract" -v
```

Expected: `5 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/tests/test_extract_geo_loc.py
git commit -m "feat(geo-extract): Extract stage — parallel EXIF/video scanning with ThreadPoolExecutor"
```

---

## Task 5: Group stage — GPS bucketing + folder inference

**Files:**
- Modify: `scripts/tools/extract_geo_loc.py` — add `get_candidate_folders`, `_http_get_json`, `forward_geocode`, `extract_location_label`, `run_group`
- Modify: `scripts/tools/tests/test_extract_geo_loc.py` — add group stage tests

**Interfaces:**
- Consumes: `01-extracted.csv` (written by Task 4)
- Produces:
  - `get_candidate_folders(file_path: Path, root: Path) -> list[str]`
  - `extract_location_label(addr: dict, country: str | None) -> str | None`
  - `run_group(config: dict, working_folder: Path) -> None` — writes `02-lookup-groups.csv` with columns: `group_key, item_count, source, lookup_latitude, lookup_longitude, export_lat, export_lng, post_date, status`

- [ ] **Step 1: Write failing tests**

Append to `test_extract_geo_loc.py`:

```python
# ── Group stage tests

def test_get_candidate_folders_basic(tmp_path):
    root = tmp_path / 'photos'
    file = root / 'Paris' / 'Day1' / 'img.jpg'
    result = geo.get_candidate_folders(file, root)
    assert 'Paris' in result
    assert 'Day1' not in result  # too short? no — "Day1" has digits... check ignore


def test_get_candidate_folders_ignores_generic(tmp_path):
    root = tmp_path / 'photos'
    file = root / 'holidays' / 'Barcelona' / 'img.jpg'
    result = geo.get_candidate_folders(file, root)
    assert 'holidays' not in result
    assert 'Barcelona' in result


def test_get_candidate_folders_ignores_year(tmp_path):
    root = tmp_path / 'photos'
    file = root / '2024' / 'Tokyo' / 'img.jpg'
    result = geo.get_candidate_folders(file, root)
    assert '2024' not in result
    assert 'Tokyo' in result


def test_get_candidate_folders_returns_max_3(tmp_path):
    root = tmp_path / 'photos'
    file = root / 'Europe' / 'France' / 'Paris' / 'Montmartre' / 'img.jpg'
    result = geo.get_candidate_folders(file, root)
    assert len(result) <= 3


def test_get_candidate_folders_file_at_root(tmp_path):
    root = tmp_path / 'photos'
    file = root / 'img.jpg'
    assert geo.get_candidate_folders(file, root) == []


def test_extract_location_label_prefers_city():
    addr = {'city': 'Paris', 'town': 'Elsewhere', 'country': 'France'}
    assert geo.extract_location_label(addr, 'France') == 'Paris, France'


def test_extract_location_label_falls_back_to_town():
    addr = {'town': 'Totnes', 'state': 'Devon'}
    assert geo.extract_location_label(addr, 'United Kingdom') == 'Totnes, United Kingdom'


def test_extract_location_label_no_match_returns_country():
    assert geo.extract_location_label({}, 'France') == 'France'


def test_extract_location_label_all_empty_returns_none():
    assert geo.extract_location_label({}, None) is None


def test_run_group_gps_bucketing(tmp_path):
    """GPS photos in same bucket → one group."""
    extracted = tmp_path / '01-extracted.csv'
    rows = [
        {'file_path': '/p/a.jpg', 'folder_path': '/p', 'file_name': 'a.jpg',
         'post_date': '2024-06-15', 'latitude': 48.8566, 'longitude': 2.3522,
         'gps_found': 'True'},
        {'file_path': '/p/b.jpg', 'folder_path': '/p', 'file_name': 'b.jpg',
         'post_date': '2024-06-16', 'latitude': 48.8570, 'longitude': 2.3530,
         'gps_found': 'True'},
    ]
    with open(extracted, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader(); writer.writerows(rows)

    geo.run_group(
        {'lookup_precision': 3, 'coordinate_precision': 4,
         'skip_folder_inference': True, 'throttle_ms': 0},
        tmp_path,
    )

    groups = list(csv.DictReader(open(tmp_path / '02-lookup-groups.csv')))
    assert len(groups) == 1
    assert groups[0]['source'] == 'GPS'
    assert groups[0]['status'] == 'pending'


def test_run_group_folder_inference(tmp_path):
    """Non-GPS file with resolvable folder name → one pending group with coords."""
    root = tmp_path / 'photos'
    root.mkdir()
    extracted = tmp_path / '01-extracted.csv'
    rows = [{'file_path': str(root / 'Tokyo' / 'img.jpg'),
             'folder_path': str(root / 'Tokyo'),
             'file_name': 'img.jpg', 'post_date': '2024-03-01',
             'latitude': '', 'longitude': '', 'gps_found': 'False'}]
    with open(extracted, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader(); writer.writerows(rows)

    geocode_result = {'lat': 35.6762, 'lng': 139.6503}
    with patch.object(geo, 'forward_geocode', return_value=geocode_result):
        geo.run_group(
            {'lookup_precision': 3, 'coordinate_precision': 4,
             'skip_folder_inference': False, 'throttle_ms': 0,
             'geoapify_api_key': '', 'user_agent': 'test/1.0'},
            tmp_path,
            root_folder=root,
        )

    groups = list(csv.DictReader(open(tmp_path / '02-lookup-groups.csv')))
    assert len(groups) == 1
    assert groups[0]['source'] == 'Folder'
    assert groups[0]['status'] == 'pending'
    assert float(groups[0]['lookup_latitude']) == pytest.approx(35.6762, abs=0.01)
```

- [ ] **Step 2: Run — confirm failure**

```bash
pytest tests/test_extract_geo_loc.py -k "candidate_folders or location_label or run_group" -v
```

Expected: `FAILED` — attribute errors

- [ ] **Step 3: Implement in `extract_geo_loc.py`**

Add after `run_extract`:

```python
# ── Group stage

def get_candidate_folders(file_path: Path, root: Path) -> list[str]:
    """Return up to 3 usable place-name candidates from the folder path."""
    try:
        relative = file_path.parent.relative_to(root)
    except ValueError:
        return []

    candidates: list[str] = []
    seen: set[str] = set()
    for part in relative.parts:
        clean = re.sub(r'[_\-]+', ' ', part).strip()
        if len(clean) < 3:
            continue
        if clean.isdigit():
            continue
        if clean.lower() in FOLDER_IGNORE:
            continue
        if not re.match(r'^[A-Za-zÀ-ÿ\'\.\-\s,]+$', clean):
            continue
        if clean not in seen:
            seen.add(clean)
            candidates.append(clean)

    return candidates[-3:]  # most specific (deepest) folders first


def extract_location_label(addr: dict, country: str | None) -> str | None:
    """Pick the best human-readable place name from a geocoder address dict."""
    for field in ADDRESS_FIELDS:
        value = addr.get(field, '').strip()
        if value:
            return f'{value}, {country}' if country else value
    return country or None


def _http_get_json(url: str, user_agent: str) -> object:
    """Minimal synchronous HTTP GET → parsed JSON. Uses stdlib only."""
    req = urllib.request.Request(
        url, headers={'User-Agent': user_agent, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


def forward_geocode(query: str, config: dict) -> dict | None:
    """Forward geocode a place name → {'lat': float, 'lng': float}.
    Uses Geoapify if api key present, else Nominatim. Returns None on failure."""
    try:
        encoded = urllib.parse.quote(query)
        if config.get('geoapify_api_key'):
            url = (f'https://api.geoapify.com/v1/geocode/search'
                   f'?text={encoded}&format=json&limit=1'
                   f'&apiKey={config["geoapify_api_key"]}')
            data = _http_get_json(url, config['user_agent'])
            items = data.get('results', [])
            if not items:
                return None
            return {'lat': float(items[0]['lat']), 'lng': float(items[0]['lon'])}
        else:
            url = (f'https://nominatim.openstreetmap.org/search'
                   f'?q={encoded}&format=json&limit=1&addressdetails=1')
            data = _http_get_json(url, config['user_agent'])
            if not data:
                return None
            return {'lat': float(data[0]['lat']), 'lng': float(data[0]['lon'])}
    except Exception as exc:
        print(f'[group] WARNING: forward geocode failed for "{query}" — {exc}')
        return None


def run_group(config: dict, working_folder: Path,
              root_folder: Path | None = None) -> None:
    """Stage 2: bucket GPS coords + resolve folder names → 02-lookup-groups.csv."""
    extracted_csv = working_folder / '01-extracted.csv'
    if not extracted_csv.exists():
        raise FileNotFoundError(f'Run extract stage first: {extracted_csv}')

    rows = list(csv.DictReader(open(extracted_csv, encoding='utf-8')))
    lp = config['lookup_precision']
    cp = config['coordinate_precision']
    throttle = config['throttle_ms'] / 1000

    # GPS bucketing
    gps_buckets: dict[str, list[dict]] = {}
    for row in rows:
        if row['gps_found'] != 'True':
            continue
        try:
            lat = round(float(row['latitude']),  lp)
            lng = round(float(row['longitude']), lp)
        except (ValueError, TypeError):
            continue
        key = f'GPS|{lat}|{lng}'
        gps_buckets.setdefault(key, []).append(row)

    groups: list[dict] = []

    for key, bucket in gps_buckets.items():
        lats = [float(r['latitude'])  for r in bucket]
        lngs = [float(r['longitude']) for r in bucket]
        avg_lat = sum(lats) / len(lats)
        avg_lng = sum(lngs) / len(lngs)
        earliest = min(r['post_date'] for r in bucket if r.get('post_date'))
        groups.append({
            'group_key':        key,
            'item_count':       len(bucket),
            'source':           'GPS',
            'lookup_latitude':  round(avg_lat, lp),
            'lookup_longitude': round(avg_lng, lp),
            'export_lat':       round(avg_lat, cp),
            'export_lng':       round(avg_lng, cp),
            'post_date':        earliest,
            'status':           'pending',
        })

    # Folder inference for non-GPS files
    if not config.get('skip_folder_inference') and root_folder:
        folder_cache: dict[str, dict | None] = {}
        for row in rows:
            if row['gps_found'] == 'True':
                continue
            candidates = get_candidate_folders(
                Path(row['file_path']), root_folder)
            result = None
            for candidate in reversed(candidates):  # most specific first
                if candidate in folder_cache:
                    result = folder_cache[candidate]
                else:
                    result = forward_geocode(candidate, config)
                    folder_cache[candidate] = result
                    if throttle > 0:
                        time.sleep(throttle)
                if result:
                    break
            if result:
                key = f'FOLDER|{row["file_path"]}'
                groups.append({
                    'group_key':        key,
                    'item_count':       1,
                    'source':           'Folder',
                    'lookup_latitude':  round(result['lat'], lp),
                    'lookup_longitude': round(result['lng'], lp),
                    'export_lat':       round(result['lat'], cp),
                    'export_lng':       round(result['lng'], cp),
                    'post_date':        row.get('post_date', ''),
                    'status':           'pending',
                })

    out = working_folder / '02-lookup-groups.csv'
    fieldnames = ['group_key', 'item_count', 'source', 'lookup_latitude',
                  'lookup_longitude', 'export_lat', 'export_lng', 'post_date', 'status']
    with open(out, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(groups)
    print(f'[group] {len(groups)} location groups → {out}')
```

- [ ] **Step 4: Run — confirm pass**

```bash
pytest tests/test_extract_geo_loc.py -k "candidate_folders or location_label or run_group" -v
```

Expected: `10 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/tests/test_extract_geo_loc.py
git commit -m "feat(geo-extract): Group stage — GPS bucketing and folder-name inference"
```

---

## Task 6: Resolve stage — async reverse geocoding

**Files:**
- Modify: `scripts/tools/extract_geo_loc.py` — add `load_cache`, `save_cache`, `reverse_geocode_nominatim`, `reverse_geocode_geoapify`, `resolve_group`, `resolve_all`, `run_resolve`
- Modify: `scripts/tools/tests/test_extract_geo_loc.py` — add resolve tests

**Interfaces:**
- Consumes: `extract_location_label` (Task 5), `02-lookup-groups.csv`
- Produces: `run_resolve(config: dict, working_folder: Path) -> None` — writes `03-resolved.csv`, adds `resolved_location` column

- [ ] **Step 1: Write failing tests**

Append to `test_extract_geo_loc.py`:

```python
# ── Resolve stage tests

import pytest
import asyncio

pytest_plugins = ('pytest_asyncio',)


def test_load_cache_empty_when_file_missing(tmp_path):
    cache = geo.load_cache(tmp_path / 'photo-location-cache.json')
    assert cache == {}


def test_load_cache_reads_existing(tmp_path):
    p = tmp_path / 'photo-location-cache.json'
    p.write_text(json.dumps({'48.857,2.352|Nominatim|city': {'Location': 'Paris, France'}}))
    cache = geo.load_cache(p)
    assert cache['48.857,2.352|Nominatim|city']['Location'] == 'Paris, France'


def test_save_cache_round_trips(tmp_path):
    p = tmp_path / 'photo-location-cache.json'
    data = {'key': {'Location': 'Tokyo, Japan'}}
    geo.save_cache(data, p)
    assert json.loads(p.read_text())['key']['Location'] == 'Tokyo, Japan'


@pytest.mark.asyncio
async def test_reverse_geocode_nominatim_returns_label():
    nominatim_resp = {
        'address': {'city': 'Paris', 'country': 'France'},
        'display_name': 'Paris, Île-de-France, France',
    }
    mock_resp = MagicMock()
    mock_resp.__aenter__ = asyncio.coroutine(lambda _: mock_resp)
    mock_resp.__aexit__  = asyncio.coroutine(lambda *_: None)
    mock_resp.json       = asyncio.coroutine(lambda: nominatim_resp)
    mock_resp.status     = 200

    mock_session = MagicMock()
    mock_session.get = MagicMock(return_value=mock_resp)

    config = {'user_agent': 'test/1.0'}
    label = await geo.reverse_geocode_nominatim(mock_session, 48.857, 2.352, config)
    assert label == 'Paris, France'


@pytest.mark.asyncio
async def test_resolve_group_uses_cache():
    cache = {'48.857,2.352|Nominatim|city': {'Location': 'Paris, France'}}
    group = {'group_key': 'GPS|48.857|2.352', 'item_count': 5,
             'source': 'GPS', 'lookup_latitude': 48.857,
             'lookup_longitude': 2.352, 'export_lat': 48.857,
             'export_lng': 2.352, 'post_date': '2024-06-15', 'status': 'pending'}
    config = {'geoapify_api_key': '', 'user_agent': 'test/1.0',
              'throttle_ms': 0, 'lookup_precision': 3}
    sem = asyncio.Semaphore(1)

    result = await geo.resolve_group(None, sem, group, config, cache)
    assert result['resolved_location'] == 'Paris, France'
    assert result['status'] == 'resolved'


@pytest.mark.asyncio
async def test_resolve_group_marks_failed_after_retries():
    group = {'group_key': 'GPS|48.857|2.352', 'item_count': 1,
             'source': 'GPS', 'lookup_latitude': 48.857,
             'lookup_longitude': 2.352, 'export_lat': 48.857,
             'export_lng': 2.352, 'post_date': '2024-06-15', 'status': 'pending'}
    config = {'geoapify_api_key': '', 'user_agent': 'test/1.0',
              'throttle_ms': 0, 'lookup_precision': 3}
    sem = asyncio.Semaphore(1)

    with patch.object(geo, 'reverse_geocode_nominatim',
                      side_effect=Exception('network error')):
        result = await geo.resolve_group(None, sem, group, config, {})
    assert result['status'] == 'failed'
    assert result['resolved_location'] is None
```

- [ ] **Step 2: Run — confirm failure**

```bash
pytest tests/test_extract_geo_loc.py -k "cache or nominatim or resolve_group" -v
```

Expected: `FAILED` — attribute errors

- [ ] **Step 3: Implement in `extract_geo_loc.py`**

Add after `run_group`:

```python
# ── Resolve stage

def load_cache(path: Path) -> dict:
    """Load geocode cache from JSON. Returns empty dict if file absent or corrupt."""
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
        return {}


def save_cache(cache: dict, path: Path) -> None:
    """Persist geocode cache to JSON, sorted for stable diffs."""
    try:
        path.write_text(
            json.dumps(dict(sorted(cache.items())), indent=2, ensure_ascii=False),
            encoding='utf-8')
    except OSError as exc:
        print(f'[resolve] WARNING: could not save cache — {exc}')


async def reverse_geocode_nominatim(
        session: aiohttp.ClientSession,
        lat: float, lng: float,
        config: dict) -> str | None:
    """Reverse geocode via Nominatim. Returns city/town label or None."""
    url = (f'https://nominatim.openstreetmap.org/reverse'
           f'?lat={lat}&lon={lng}&format=json&zoom=10')
    async with session.get(url, headers={'User-Agent': config['user_agent']}) as resp:
        data = await resp.json(content_type=None)
    addr    = data.get('address', {})
    country = addr.get('country')
    label   = extract_location_label(addr, country)
    if not label:
        display = data.get('display_name', '')
        parts   = display.split(',')
        label   = f'{parts[0].strip()}, {parts[-1].strip()}' if len(parts) >= 2 else display
    return label or None


async def reverse_geocode_geoapify(
        session: aiohttp.ClientSession,
        lat: float, lng: float,
        config: dict) -> str | None:
    """Reverse geocode via Geoapify. Returns city/town label or None."""
    url = (f'https://api.geoapify.com/v1/geocode/reverse'
           f'?lat={lat}&lon={lng}&type=city&format=json'
           f'&apiKey={config["geoapify_api_key"]}')
    async with session.get(url, headers={'User-Agent': config['user_agent']}) as resp:
        data = await resp.json(content_type=None)
    results = data.get('results', [])
    if not results:
        return None
    item    = results[0]
    country = item.get('country')
    label   = extract_location_label(item, country)
    if not label:
        formatted = item.get('formatted', '')
        parts     = formatted.split(',')
        label     = f'{parts[0].strip()}, {parts[-1].strip()}' if len(parts) >= 2 else formatted
    return label or None


async def resolve_group(
        session: aiohttp.ClientSession | None,
        sem: asyncio.Semaphore,
        group: dict,
        config: dict,
        cache: dict) -> dict:
    """Reverse geocode one group; returns updated group dict."""
    lp        = config.get('lookup_precision', 3)
    provider  = 'Geoapify' if config.get('geoapify_api_key') else 'Nominatim'
    lat       = round(float(group['lookup_latitude']),  lp)
    lng       = round(float(group['lookup_longitude']), lp)
    cache_key = f'{lat},{lng}|{provider}|city'

    if cache_key in cache:
        return {**group,
                'resolved_location': cache[cache_key].get('Location'),
                'status': 'resolved'}

    async with sem:
        throttle = config.get('throttle_ms', 1200) / 1000
        if throttle > 0:
            await asyncio.sleep(throttle)

        for attempt in range(3):
            try:
                if config.get('geoapify_api_key'):
                    label = await reverse_geocode_geoapify(session, lat, lng, config)
                else:
                    label = await reverse_geocode_nominatim(session, lat, lng, config)

                if label:
                    cache[cache_key] = {'Location': label, 'Lat': lat, 'Lng': lng}
                    return {**group, 'resolved_location': label, 'status': 'resolved'}
                return {**group, 'resolved_location': None, 'status': 'failed'}

            except Exception as exc:
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt)
                else:
                    print(f'[resolve] FAILED after 3 attempts: {group["group_key"]} — {exc}')
                    return {**group, 'resolved_location': None, 'status': 'failed'}

    return {**group, 'resolved_location': None, 'status': 'failed'}


async def resolve_all(groups: list[dict], config: dict, cache: dict) -> list[dict]:
    """Reverse geocode all pending groups concurrently under a rate-limit semaphore."""
    sem_count = 5 if config.get('geoapify_api_key') else 1
    sem       = asyncio.Semaphore(sem_count)
    provider  = 'Geoapify' if config.get('geoapify_api_key') else 'Nominatim'
    print(f'[resolve] {len(groups)} groups via {provider} '
          f'(semaphore={sem_count}, throttle={config.get("throttle_ms")}ms)')

    connector = aiohttp.TCPConnector(limit=sem_count)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks   = [resolve_group(session, sem, g, config, cache) for g in groups]
        results = await asyncio.gather(*tasks)
    return list(results)


def run_resolve(config: dict, working_folder: Path) -> None:
    """Stage 3: async reverse geocode all groups → 03-resolved.csv."""
    groups_csv = working_folder / '02-lookup-groups.csv'
    if not groups_csv.exists():
        raise FileNotFoundError(f'Run group stage first: {groups_csv}')

    cache_path = working_folder / 'photo-location-cache.json'
    cache      = load_cache(cache_path)
    groups     = list(csv.DictReader(open(groups_csv, encoding='utf-8')))
    pending    = [g for g in groups if g.get('status') != 'resolved']

    resolved = asyncio.run(resolve_all(pending, config, cache))
    save_cache(cache, cache_path)

    out       = working_folder / '03-resolved.csv'
    fieldnames = ['group_key', 'item_count', 'source', 'lookup_latitude',
                  'lookup_longitude', 'export_lat', 'export_lng',
                  'post_date', 'status', 'resolved_location']
    with open(out, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(resolved)
    resolved_count = sum(1 for r in resolved if r.get('status') == 'resolved')
    print(f'[resolve] {resolved_count}/{len(resolved)} resolved → {out}')
```

- [ ] **Step 4: Run — confirm pass**

```bash
pytest tests/test_extract_geo_loc.py -k "cache or nominatim or resolve_group" -v
```

Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/tests/test_extract_geo_loc.py
git commit -m "feat(geo-extract): Resolve stage — async reverse geocoding with aiohttp + semaphore"
```

---

## Task 7: Export stage + `main()` wiring

**Files:**
- Modify: `scripts/tools/extract_geo_loc.py` — add `run_export`, complete `main()`
- Modify: `scripts/tools/tests/test_extract_geo_loc.py` — add export + integration tests

**Interfaces:**
- Consumes: `03-resolved.csv`
- Produces: `run_export(config: dict, working_folder: Path, output_csv: Path) -> None` — writes final CSV with columns `title, location, notes, post_date, lat, lng, publish`

- [ ] **Step 1: Write failing tests**

Append to `test_extract_geo_loc.py`:

```python
# ── Export stage tests

def _write_resolved(path, rows):
    fieldnames = ['group_key', 'item_count', 'source', 'lookup_latitude',
                  'lookup_longitude', 'export_lat', 'export_lng',
                  'post_date', 'status', 'resolved_location']
    with open(path, 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader(); writer.writerows(rows)


def test_run_export_deduplicates_by_name(tmp_path):
    """Two groups with same resolved name → one output row."""
    _write_resolved(tmp_path / '03-resolved.csv', [
        {'group_key': 'GPS|48.856|2.352', 'item_count': 3, 'source': 'GPS',
         'lookup_latitude': 48.856, 'lookup_longitude': 2.352,
         'export_lat': 48.8566, 'export_lng': 2.3522,
         'post_date': '2024-06-15', 'status': 'resolved',
         'resolved_location': 'Paris, France'},
        {'group_key': 'FOLDER|/p/Paris/img.jpg', 'item_count': 1, 'source': 'Folder',
         'lookup_latitude': 48.860, 'lookup_longitude': 2.360,
         'export_lat': 48.860, 'export_lng': 2.360,
         'post_date': '2024-07-01', 'status': 'resolved',
         'resolved_location': 'Paris, France'},
    ])
    geo.run_export({'title_prefix': 'Trip', 'notes': '', 'publish': False,
                    'coordinate_precision': 4},
                   tmp_path, tmp_path / '04-travel-import.csv')

    rows = list(csv.DictReader(open(tmp_path / '04-travel-import.csv')))
    assert len(rows) == 1
    assert rows[0]['location'] == 'Paris, France'
    assert rows[0]['post_date'] == '2024-06-15'  # earliest date wins


def test_run_export_skips_failed_groups(tmp_path):
    """Failed groups are excluded from output."""
    _write_resolved(tmp_path / '03-resolved.csv', [
        {'group_key': 'GPS|1|1', 'item_count': 1, 'source': 'GPS',
         'lookup_latitude': 1, 'lookup_longitude': 1,
         'export_lat': 1.0, 'export_lng': 1.0,
         'post_date': '2024-01-01', 'status': 'failed',
         'resolved_location': ''},
        {'group_key': 'GPS|48.856|2.352', 'item_count': 2, 'source': 'GPS',
         'lookup_latitude': 48.856, 'lookup_longitude': 2.352,
         'export_lat': 48.8566, 'export_lng': 2.3522,
         'post_date': '2024-06-15', 'status': 'resolved',
         'resolved_location': 'Paris, France'},
    ])
    geo.run_export({'title_prefix': 'Trip', 'notes': '', 'publish': False,
                    'coordinate_precision': 4},
                   tmp_path, tmp_path / '04-travel-import.csv')

    rows = list(csv.DictReader(open(tmp_path / '04-travel-import.csv')))
    assert len(rows) == 1


def test_run_export_output_columns(tmp_path):
    """Output CSV has exactly the columns the bulk-import route expects."""
    _write_resolved(tmp_path / '03-resolved.csv', [
        {'group_key': 'GPS|48.856|2.352', 'item_count': 1, 'source': 'GPS',
         'lookup_latitude': 48.856, 'lookup_longitude': 2.352,
         'export_lat': 48.8566, 'export_lng': 2.3522,
         'post_date': '2024-06-15', 'status': 'resolved',
         'resolved_location': 'Paris, France'},
    ])
    geo.run_export({'title_prefix': 'My Trip', 'notes': 'Nice', 'publish': True,
                    'coordinate_precision': 4},
                   tmp_path, tmp_path / '04-travel-import.csv')

    rows = list(csv.DictReader(open(tmp_path / '04-travel-import.csv')))
    assert rows[0]['title']    == 'My Trip'
    assert rows[0]['location'] == 'Paris, France'
    assert rows[0]['notes']    == 'Nice'
    assert rows[0]['publish']  == 'true'
    assert set(rows[0].keys()) == {'title', 'location', 'notes', 'post_date', 'lat', 'lng', 'publish'}


def test_run_export_no_resolved_raises(tmp_path):
    _write_resolved(tmp_path / '03-resolved.csv', [
        {'group_key': 'GPS|1|1', 'item_count': 1, 'source': 'GPS',
         'lookup_latitude': 1, 'lookup_longitude': 1,
         'export_lat': 1, 'export_lng': 1,
         'post_date': '2024-01-01', 'status': 'failed', 'resolved_location': ''},
    ])
    with pytest.raises(ValueError, match='No resolved'):
        geo.run_export({'title_prefix': 'Trip', 'notes': '', 'publish': False,
                        'coordinate_precision': 4},
                       tmp_path, tmp_path / '04-travel-import.csv')
```

- [ ] **Step 2: Run — confirm failure**

```bash
pytest tests/test_extract_geo_loc.py -k "run_export" -v
```

Expected: `FAILED` — attribute error

- [ ] **Step 3: Implement `run_export` in `extract_geo_loc.py`**

Add after `run_resolve`:

```python
# ── Export stage

def run_export(config: dict, working_folder: Path, output_csv: Path) -> None:
    """Stage 4: deduplicate resolved groups by name, write final import CSV."""
    resolved_csv = working_folder / '03-resolved.csv'
    if not resolved_csv.exists():
        raise FileNotFoundError(f'Run resolve stage first: {resolved_csv}')

    rows = [r for r in csv.DictReader(open(resolved_csv, encoding='utf-8'))
            if r.get('status') == 'resolved' and r.get('resolved_location')]
    if not rows:
        raise ValueError('No resolved locations found — nothing to export.')

    # Name dedup: group by resolved_location, keep earliest post_date
    by_name: dict[str, dict] = {}
    for row in rows:
        name = row['resolved_location']
        if name not in by_name or row['post_date'] < by_name[name]['post_date']:
            by_name[name] = row

    cp     = config.get('coordinate_precision', 4)
    final  = sorted(by_name.values(), key=lambda r: r['resolved_location'])

    with open(output_csv, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(
            f, fieldnames=['title', 'location', 'notes', 'post_date', 'lat', 'lng', 'publish'])
        writer.writeheader()
        for row in final:
            writer.writerow({
                'title':     config.get('title_prefix', 'Trip'),
                'location':  row['resolved_location'],
                'notes':     config.get('notes', ''),
                'post_date': row['post_date'],
                'lat':       round(float(row['export_lat']), cp),
                'lng':       round(float(row['export_lng']), cp),
                'publish':   str(config.get('publish', False)).lower(),
            })
    print(f'[export] {len(final)} unique locations → {output_csv}')
```

- [ ] **Step 4: Run — confirm export tests pass**

```bash
pytest tests/test_extract_geo_loc.py -k "run_export" -v
```

Expected: `4 passed`

- [ ] **Step 5: Implement `main()` with full argparse**

Replace the `main()` stub in `extract_geo_loc.py`:

```python
def main() -> None:
    parser = argparse.ArgumentParser(
        description='Extract GPS locations from photos/videos and produce a travel-import CSV.')
    parser.add_argument('--stage', required=True,
                        choices=['extract', 'group', 'resolve', 'export', 'all'])
    parser.add_argument('--root-folder',    type=Path)
    parser.add_argument('--working-folder', type=Path, required=True)
    parser.add_argument('--output-csv',     type=Path)
    parser.add_argument('--api-key')
    parser.add_argument('--workers',        type=int)
    parser.add_argument('--throttle-ms',    type=int, dest='throttle_ms')
    parser.add_argument('--title-prefix',   dest='title_prefix')
    parser.add_argument('--notes',          default='')
    parser.add_argument('--publish',        action='store_true')
    parser.add_argument('--skip-folder-inference', action='store_true',
                        dest='skip_folder_inference')
    args = parser.parse_args()

    config       = load_config(args)
    working      = args.working_folder
    working.mkdir(parents=True, exist_ok=True)
    output_csv   = args.output_csv or working / '04-travel-import.csv'

    def _extract():
        if not args.root_folder:
            parser.error('--root-folder is required for extract stage')
        run_extract(config, args.root_folder, working)

    def _group():
        run_group(config, working, root_folder=args.root_folder)

    if args.stage == 'extract':
        _extract()
    elif args.stage == 'group':
        _group()
    elif args.stage == 'resolve':
        run_resolve(config, working)
    elif args.stage == 'export':
        run_export(config, working, output_csv)
    elif args.stage == 'all':
        _extract()
        _group()
        run_resolve(config, working)
        run_export(config, working, output_csv)
```

- [ ] **Step 6: Run full test suite**

```bash
pytest tests/test_extract_geo_loc.py -v
```

Expected: all tests pass (no failures)

- [ ] **Step 7: Smoke-test the CLI**

```bash
python extract_geo_loc.py --help
```

Expected: usage printed listing all flags with no errors.

- [ ] **Step 8: Commit**

```bash
git add scripts/tools/extract_geo_loc.py scripts/tools/tests/test_extract_geo_loc.py
git commit -m "feat(geo-extract): Export stage, main() CLI wiring — all stages complete"
```

---

## Self-Review Checklist

- [x] **Spec: parallel Extract** → Task 4 `ThreadPoolExecutor`
- [x] **Spec: ffprobe video parsing** → Task 3 `parse_gps_video`, graceful fallback
- [x] **Spec: folder inference in Group (not Extract)** → Task 5 `run_group`
- [x] **Spec: folder groups marked pending, pass through Resolve** → Task 5 `status='pending'`, Task 6 `resolve_group` handles all pending
- [x] **Spec: Nominatim Semaphore(1) / Geoapify Semaphore(5)** → Task 6 `resolve_all`
- [x] **Spec: throttle inside semaphore** → Task 6 `resolve_group` sleeps inside `async with sem`
- [x] **Spec: cache key format matches PS script** → `"{lat},{lng}|{provider}|city"`
- [x] **Spec: name dedup in Export** → Task 7 `run_export` `by_name` dict
- [x] **Spec: config priority chain** → Task 1 `load_config`
- [x] **Spec: .geo-config.json gitignored** → Task 1 `.gitignore`
- [x] **Spec: intermediate file names unchanged** → all stages use `01-` through `04-` prefix
- [x] **Spec: `zoom=10` Nominatim** → Task 6 `reverse_geocode_nominatim` URL
- [x] **Spec: two pip deps only** → `requirements.txt` has `exifread`, `aiohttp`; urllib used for sync HTTP
