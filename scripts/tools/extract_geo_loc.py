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
        return datetime.fromtimestamp(path.stat().st_mtime).strftime('%Y-%m-%d')
    except Exception:
        return '1970-01-01'


# ── Video GPS parsing via ffprobe

_ffprobe_warned = False

def check_ffprobe() -> bool:
    """Return True if ffprobe is on PATH. Prints a one-time warning if absent."""
    global _ffprobe_warned
    try:
        subprocess.run(['ffprobe', '-version'], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        if not _ffprobe_warned:
            print('[extract] WARNING: ffprobe not found — video files will fall through '
                  'to folder inference. Install FFmpeg to enable video GPS extraction.')
            _ffprobe_warned = True
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
    """Extract recording date from video metadata; falls back to file mtime. Always returns YYYY-MM-DD."""
    try:
        data = _run_ffprobe(path)
        if data:
            creation_time = data.get('format', {}).get('tags', {}).get('creation_time', '')
            if creation_time:
                return creation_time[:10]
        return datetime.fromtimestamp(path.stat().st_mtime).strftime('%Y-%m-%d')
    except Exception:
        return '1970-01-01'


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
