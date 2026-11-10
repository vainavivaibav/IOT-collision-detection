
import datetime


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def execute(self, query, params=None):
        pass

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, rows):
        self.rows = rows

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def cursor(self):
        return FakeCursor(self.rows)


def test_devices_without_heartbeats_are_never_seen(client, backend_app, monkeypatch):
    monkeypatch.setattr(
        backend_app,
        "get_db_connection",
        lambda: FakeConnection([]),
    )

    response = client.get("/api/devices/status")

    assert response.status_code == 200

    devices = response.get_json()["devices"]

    assert len(devices) == 2

    for device in devices:
        assert device["status"] == "never_seen"
        assert device["last_seen"] is None
        assert device["age_seconds"] is None


def test_recent_heartbeat_marks_device_online(client, backend_app, monkeypatch):
    now = datetime.datetime.now(datetime.timezone.utc)

    rows = [
        (
            "sensor-node-1",
            {"adxl345": "ok", "sw420": "ok"},
            {},
            now - datetime.timedelta(seconds=20),
        )
    ]

    monkeypatch.setattr(
        backend_app,
        "get_db_connection",
        lambda: FakeConnection(rows),
    )

    response = client.get("/api/devices/status")

    assert response.status_code == 200

    devices = response.get_json()["devices"]
    sensor = next(
        device for device in devices
        if device["device_id"] == "sensor-node-1"
    )

    assert sensor["status"] == "online"
    assert sensor["age_seconds"] <= 60
    assert sensor["components"]["adxl345"] == "ok"


def test_old_heartbeat_marks_device_stale(client, backend_app, monkeypatch):
    now = datetime.datetime.now(datetime.timezone.utc)

    rows = [
        (
            "gateway-node-2",
            {"tcp_link": "connected", "gps_fix": "valid"},
            {},
            now - datetime.timedelta(seconds=120),
        )
    ]

    monkeypatch.setattr(
        backend_app,
        "get_db_connection",
        lambda: FakeConnection(rows),
    )

    response = client.get("/api/devices/status")

    assert response.status_code == 200

    devices = response.get_json()["devices"]
    gateway = next(
        device for device in devices
        if device["device_id"] == "gateway-node-2"
    )

    assert gateway["status"] == "stale"
    assert gateway["age_seconds"] > 60


def test_database_error_returns_generic_error(client, backend_app, monkeypatch):
    def database_failure():
        raise RuntimeError("Database connection details")

    monkeypatch.setattr(
        backend_app,
        "get_db_connection",
        database_failure,
    )

    response = client.get("/api/devices/status")

    assert response.status_code == 500
    assert response.get_json()["error"] == "Could not retrieve device status"
    assert "Database connection details" not in response.get_data(as_text=True)
