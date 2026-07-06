"""
extract_geo_loc.py — Travel photo geo-location extractor.

Usage:
    python extract_geo_loc.py --stage all --root-folder "D:\\Photos" --working-folder "D:\\geo-work"
    python extract_geo_loc.py --stage resolve --working-folder "D:\\geo-work" --api-key "abc123"
"""
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

DEFAULTS: dict[str, object] = {
    'geoapify_api_key':      '',
    'workers':               16,
    'throttle_ms':         1200,
    'coordinate_precision':   4,
    'lookup_precision':       3,
    'city_precision':         1,
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


_EXIF_DATE_FORMATS = (
    '%Y:%m:%d %H:%M:%S',  # standard EXIF:  2024:06:15 10:30:00
    '%Y-%m-%d %H:%M:%S',  # ISO variant:    2024-06-15 10:30:00
    '%d/%m/%Y %H:%M:%S',  # some older cams: 22/07/2011 10:30:00
    '%m/%d/%Y %H:%M:%S',  # US variant:     07/22/2011 10:30:00
    '%Y:%m:%d',
    '%Y-%m-%d',
    '%d/%m/%Y',
    '%m/%d/%Y',
)

def _parse_exif_date_str(raw: str) -> str | None:
    """Try multiple EXIF date formats; return YYYY-MM-DD string or None."""
    raw = raw.strip()
    for fmt in _EXIF_DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).strftime('%Y-%m-%d')
        except ValueError:
            continue
    return None


def parse_date_exif(path: Path) -> str:
    """Extract date taken from EXIF; falls back to file mtime. Always returns YYYY-MM-DD."""
    try:
        with open(path, 'rb') as f:
            tags = exifread.process_file(f, details=False,
                                         stop_tag='EXIF DateTimeOriginal')
        tag = tags.get('EXIF DateTimeOriginal') or tags.get('Image DateTime')
        if tag:
            parsed = _parse_exif_date_str(str(tag))
            if parsed:
                return parsed
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


_exiftool_warned = False

def check_exiftool() -> bool:
    """Return True if exiftool is on PATH. Prints a one-time warning if absent."""
    global _exiftool_warned
    try:
        subprocess.run(['exiftool', '-ver'], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        if not _exiftool_warned:
            print('[geotag] WARNING: exiftool not found. Install it to use geotag-write.')
            _exiftool_warned = True
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
        all_files = [f for f in root_folder.rglob('*') if f.is_file()]
        if all_files:
            found_exts = sorted({f.suffix.lower() for f in all_files})
            print(f'[extract] Found {len(all_files)} files but none with supported extensions.')
            print(f'[extract] Extensions found: {", ".join(found_exts) or "(none)"}')
            print(f'[extract] Supported: {", ".join(sorted(extensions))}')
        else:
            print(f'[extract] No files found at all under: {root_folder}')
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
    with open(out, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(results)
    print(f'[extract] Done → {out}')


# ── Group stage

def get_candidate_folders(file_path: Path, root: Path) -> list[str]:
    """Return up to 3 usable place-name candidates from the folder path.

    For clean folder names like "Paris" or "New York", the whole name is used.
    For descriptive names like "2006 - CCF - Dorset Dash", digits and ignored
    tokens are stripped and individual words are tried as fallback candidates.
    """
    try:
        relative = file_path.parent.relative_to(root)
    except ValueError:
        return []

    candidates: list[str] = []
    seen: set[str] = set()

    for part in relative.parts:
        clean = re.sub(r'[_\-]+', ' ', part).strip()
        if len(clean) < 3 or clean.isdigit() or clean.lower() in FOLDER_IGNORE:
            continue

        if re.match(r'^[A-Za-zÀ-ÿ\'\.\-\s,]+$', clean):
            # Simple place name — use as-is
            if clean not in seen:
                seen.add(clean)
                candidates.append(clean)
        else:
            # Mixed name (e.g. "2006 - CCF - Dorset Dash") — extract word-level candidates
            words = clean.split()
            place_words = [
                w for w in words
                if not w.isdigit()
                and len(w) >= 3
                and w.lower() not in FOLDER_IGNORE
                and re.match(r'^[A-Za-zÀ-ÿ\'\.\-]+$', w)
            ]
            # Try longest-to-shortest: full phrase first, then each word alone
            phrase = ' '.join(place_words)
            for token in ([phrase] + place_words) if phrase else place_words:
                if token and token not in seen:
                    seen.add(token)
                    candidates.append(token)

    return candidates[-3:]  # deepest folders last; caller uses reversed() for most-specific-first


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

    with open(extracted_csv, encoding='utf-8-sig') as f:
        rows = list(csv.DictReader(f))
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
    file_to_fine: dict[str, str] = {}
    file_gps_found: dict[str, str] = {}

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
        for r in bucket:
            file_to_fine[r['file_path']] = key
            file_gps_found[r['file_path']] = 'True'

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
                file_to_fine[row['file_path']] = key
                file_gps_found[row['file_path']] = 'False'

    # City-level dedup: merge groups within the same ~11km cell to cut geocode calls
    # city_precision=0 disables this pass (useful in tests or when fine resolution is wanted)
    city_p = config.get('city_precision', 1)
    fine_to_merged: dict[str, str] = {}
    if city_p < 1:
        print(f'[group] {len(groups)} fine-grained groups (city-level dedup disabled)')
        merged = groups
        for g in groups:
            fine_to_merged[g['group_key']] = g['group_key']
    else:
        city_buckets: dict[str, list[dict]] = {}
        for g in groups:
            city_key = f'{round(float(g["lookup_latitude"]), city_p)}|{round(float(g["lookup_longitude"]), city_p)}'
            city_buckets.setdefault(city_key, []).append(g)

        merged = []
        for city_key, cluster in city_buckets.items():
            avg_lat = sum(float(g['lookup_latitude'])  for g in cluster) / len(cluster)
            avg_lng = sum(float(g['lookup_longitude']) for g in cluster) / len(cluster)
            earliest = min((g['post_date'] for g in cluster if g.get('post_date')), default='')
            total    = sum(int(g['item_count']) for g in cluster)
            source   = 'GPS' if any(g['source'] == 'GPS' for g in cluster) else 'Folder'
            merged_key = cluster[0]['group_key']
            merged.append({
                'group_key':        merged_key,
                'item_count':       total,
                'source':           source,
                'lookup_latitude':  round(avg_lat, city_p),
                'lookup_longitude': round(avg_lng, city_p),
                'export_lat':       round(avg_lat, cp),
                'export_lng':       round(avg_lng, cp),
                'post_date':        earliest,
                'status':           'pending',
            })
            for g in cluster:
                fine_to_merged[g['group_key']] = merged_key
        print(f'[group] {len(groups)} fine-grained groups → {len(merged)} city-level groups (saved {len(groups) - len(merged)} geocode calls)')

    out = working_folder / '02-lookup-groups.csv'
    fieldnames = ['group_key', 'item_count', 'source', 'lookup_latitude',
                  'lookup_longitude', 'export_lat', 'export_lng', 'post_date', 'status']
    with open(out, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(merged)
    print(f'[group] → {out}')

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


async def resolve_all(groups: list[dict], config: dict, cache: dict) -> list[dict]:
    """Reverse geocode all pending groups concurrently under a rate-limit semaphore."""
    sem_count = 5 if config.get('geoapify_api_key') else 1
    sem       = asyncio.Semaphore(sem_count)
    provider  = 'Geoapify' if config.get('geoapify_api_key') else 'Nominatim'
    print(f'[resolve] {len(groups)} groups via {provider} '
          f'(semaphore={sem_count}, throttle={config.get("throttle_ms")}ms)')

    total     = len(groups)
    results   = []
    done      = 0
    failed    = 0
    interval  = max(1, min(10, total // 20))  # print ~20 updates, min every 1

    connector = aiohttp.TCPConnector(limit=sem_count)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [resolve_group(session, sem, g, config, cache) for g in groups]
        for coro in asyncio.as_completed(tasks):
            result = await coro
            results.append(result)
            done += 1
            if result.get('status') == 'failed':
                failed += 1
            if done % interval == 0 or done == total:
                pct = int(done / total * 100)
                print(f'[resolve] {done}/{total} ({pct}%) — {failed} failed so far', flush=True)

    return results


def run_resolve(config: dict, working_folder: Path) -> None:
    """Stage 3: async reverse geocode all groups → 03-resolved.csv."""
    groups_csv = working_folder / '02-lookup-groups.csv'
    if not groups_csv.exists():
        raise FileNotFoundError(f'Run group stage first: {groups_csv}')

    cache_path = working_folder / 'photo-location-cache.json'
    cache      = load_cache(cache_path)
    with open(groups_csv, encoding='utf-8-sig') as f:
        groups = list(csv.DictReader(f))
    pending    = [g for g in groups if g.get('status') != 'resolved']

    resolved = asyncio.run(resolve_all(pending, config, cache))
    save_cache(cache, cache_path)

    out       = working_folder / '03-resolved.csv'
    fieldnames = ['group_key', 'item_count', 'source', 'lookup_latitude',
                  'lookup_longitude', 'export_lat', 'export_lng',
                  'post_date', 'status', 'resolved_location']
    with open(out, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(resolved)
    resolved_count = sum(1 for r in resolved if r.get('status') == 'resolved')
    print(f'[resolve] {resolved_count}/{len(resolved)} resolved → {out}')


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


# ── Export stage

def run_export(config: dict, working_folder: Path, output_csv: Path) -> None:
    """Stage 4: deduplicate resolved groups by name, write final import CSV."""
    resolved_csv = working_folder / '03-resolved.csv'
    if not resolved_csv.exists():
        raise FileNotFoundError(f'Run resolve stage first: {resolved_csv}')

    with open(resolved_csv, encoding='utf-8-sig') as f:
        rows = [r for r in csv.DictReader(f)
                if r.get('status') == 'resolved' and r.get('resolved_location')]
    if not rows:
        raise ValueError('No resolved locations found — nothing to export.')

    # Name dedup: group by resolved_location, keep earliest post_date
    by_name: dict[str, dict] = {}
    for row in rows:
        name = row['resolved_location']
        if name not in by_name or row['post_date'] < by_name[name]['post_date']:
            by_name[name] = row

    cp    = config.get('coordinate_precision', 4)
    final = sorted(by_name.values(), key=lambda r: r['resolved_location'])

    with open(output_csv, 'w', newline='', encoding='utf-8-sig') as f:
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


# ── Geotag stages

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

    file_paths = [r['file_path'] for r in rows]
    print(f'[geotag-write] Writing GPS to {len(rows)} files...')
    try:
        result = subprocess.run(
            ['exiftool', f'-csv={etool_csv}', '-overwrite_original', '-q'] + file_paths,
            capture_output=True, text=True)
        if result.returncode != 0:
            print(f'[geotag-write] exiftool error:\n{result.stderr}')
            raise RuntimeError(f'exiftool exited with code {result.returncode}')
    finally:
        etool_csv.unlink(missing_ok=True)
    print(f'[geotag-write] Done — GPS written to {len(rows)} files.')


# ── CLI

_STAGES = ['extract', 'group', 'resolve', 'export', 'geotag-preview', 'geotag-write']


def _parse_stage_arg(value: str) -> list[str]:
    if value == 'all':
        return ['extract', 'group', 'resolve', 'export']
    if value in _STAGES:
        return [value]
    m = re.match(r'^(\d+)(?:-(\d+))?$', value)
    if m:
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else start
        if 1 <= start <= end <= len(_STAGES):
            return _STAGES[start - 1:end]
    raise argparse.ArgumentTypeError(
        f"invalid stage {value!r} — use a name ({', '.join(_STAGES)}, all) "
        f"or a numeric range like 1, 1-3, 2-4 (1=extract … 6=geotag-write)")


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Extract GPS locations from photos/videos and produce a travel-import CSV.')
    parser.add_argument('--stage', required=True, type=_parse_stage_arg, metavar='STAGE')
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

    config     = load_config(args)
    working    = args.working_folder
    working.mkdir(parents=True, exist_ok=True)
    output_csv = args.output_csv or working / '04-travel-import.csv'

    def _extract():
        if not args.root_folder:
            parser.error('--root-folder is required for extract stage')
        run_extract(config, args.root_folder, working)

    def _group():
        run_group(config, working, root_folder=args.root_folder)

    _dispatch = {
        'extract':        _extract,
        'group':          _group,
        'resolve':        lambda: run_resolve(config, working),
        'export':         lambda: run_export(config, working, output_csv),
        'geotag-preview': lambda: run_geotag_preview(working),
        'geotag-write':   lambda: run_geotag_write(working),
    }
    for stage in args.stage:
        _dispatch[stage]()


if __name__ == '__main__':
    main()
