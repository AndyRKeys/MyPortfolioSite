import sys
import json
import argparse
import os
from pathlib import Path
from unittest.mock import patch

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
