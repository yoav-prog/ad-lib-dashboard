"""Shared test setup.

The scraper module validates its API keys at import time, so dummy values are
set here BEFORE any test imports it. os.environ.setdefault never overrides a
real value, and run_scrape's load_dotenv(.env) never overrides these, so tests
are hermetic on both a dev machine and CI.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

os.environ.setdefault('APIFY_API_TOKEN', 'test-apify-token')
os.environ.setdefault('SCRAPINGBEE_API_KEY', 'test-scrapingbee-key')
os.environ.setdefault('OPENAI_API_KEY', 'test-openai-key')

import pytest

import run_scrape


@pytest.fixture(scope='session')
def fb():
    """The scraper module, loaded once through run_scrape's own loader (the
    same spec/exec path production uses for the hyphen-named file)."""
    return run_scrape._load_scraper()
