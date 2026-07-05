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
    except Exception:
        pass
    return datetime.fromtimestamp(path.stat().st_mtime).strftime('%Y-%m-%d')


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
