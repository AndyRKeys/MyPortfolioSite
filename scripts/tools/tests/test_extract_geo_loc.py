import sys
import csv
import json
import argparse
import asyncio
import os
import re
from pathlib import Path
from unittest.mock import patch, MagicMock, AsyncMock

import pytest

pytest_plugins = ('pytest_asyncio',)

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
    with patch.dict(os.environ, {'GEOAPIFY_API_KEY': ''}):
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


# ── Image EXIF tests

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
    mock_date.assert_not_called()
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
    with open(csv_path, newline='') as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 2
    gps_rows = [r for r in rows if r['gps_found'] == 'True']
    assert len(gps_rows) == 1


# ── Group stage tests

def test_get_candidate_folders_basic(tmp_path):
    root = tmp_path / 'photos'
    file = root / 'Paris' / 'Day1' / 'img.jpg'
    result = geo.get_candidate_folders(file, root)
    assert 'Paris' in result
    assert 'Day1' not in result  # generic digit-containing folder names are excluded


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
         'post_date': '2024-06-16', 'latitude': 48.8570, 'longitude': 2.3524,
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

    with open(tmp_path / '02-lookup-groups.csv', newline='') as f:
        groups = list(csv.DictReader(f))
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
             'city_precision': 0, 'skip_folder_inference': False,
             'throttle_ms': 0, 'geoapify_api_key': '', 'user_agent': 'test/1.0'},
            tmp_path,
            root_folder=root,
        )

    with open(tmp_path / '02-lookup-groups.csv', newline='') as f:
        groups = list(csv.DictReader(f))
    assert len(groups) == 1
    assert groups[0]['source'] == 'Folder'
    assert groups[0]['status'] == 'pending'
    assert float(groups[0]['lookup_latitude']) == pytest.approx(35.6762, abs=0.01)


# ── Resolve stage tests

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
    mock_resp.__aenter__ = AsyncMock(return_value=mock_resp)
    mock_resp.__aexit__  = AsyncMock(return_value=None)
    mock_resp.json       = AsyncMock(return_value=nominatim_resp)
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
                      side_effect=Exception('network error')), \
         patch('asyncio.sleep', new=AsyncMock()):
        result = await geo.resolve_group(None, sem, group, config, {})
    assert result['status'] == 'failed'
    assert result['resolved_location'] is None


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

    with open(tmp_path / '04-travel-import.csv', newline='') as f:
        rows = list(csv.DictReader(f))
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

    with open(tmp_path / '04-travel-import.csv', newline='') as f:
        rows = list(csv.DictReader(f))
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

    with open(tmp_path / '04-travel-import.csv', newline='') as f:
        rows = list(csv.DictReader(f))
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
