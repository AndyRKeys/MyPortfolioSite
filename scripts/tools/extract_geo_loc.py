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
