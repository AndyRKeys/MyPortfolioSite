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

    with open(extracted_csv, encoding='utf-8') as f:
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
    with open(groups_csv, encoding='utf-8') as f:
        groups = list(csv.DictReader(f))
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

    with open(resolved_csv, encoding='utf-8') as f:
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


# ── CLI

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


if __name__ == '__main__':
    main()
