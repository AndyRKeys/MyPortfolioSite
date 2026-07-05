import sys
import json
import argparse
import os
import re
from pathlib import Path
from unittest.mock import patch, MagicMock

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
