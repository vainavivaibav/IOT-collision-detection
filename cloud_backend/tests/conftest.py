
import os
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Locate the cloud_backend folder
BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

# Prevent database initialization during tests
os.environ["DATABASE_URL"] = ""

# Mock psycopg so tests do not need a real PostgreSQL connection
psycopg_stub = types.ModuleType("psycopg")
psycopg_stub.connect = MagicMock()

json_module = types.ModuleType("psycopg.types.json")
json_module.Jsonb = lambda value: value

types_module = types.ModuleType("psycopg.types")
types_module.json = json_module

psycopg_stub.types = types_module

sys.modules["psycopg"] = psycopg_stub
sys.modules["psycopg.types"] = types_module
sys.modules["psycopg.types.json"] = json_module

# Import Flask application
import app as backend


@pytest.fixture
def backend_app():
    backend.DEVICE_API_KEY = "test-device-key"
    return backend


@pytest.fixture
def client(backend_app):
    return backend_app.app.test_client()
