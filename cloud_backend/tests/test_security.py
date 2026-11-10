
import pytest


@pytest.mark.parametrize(
    "endpoint,payload",
    [
        (
            "/api/events",
            {
                "event_type": "POSSIBLE_COLLISION",
                "latitude": 12.97,
                "longitude": 77.59,
                "x": 1.0,
                "y": 2.0,
                "z": 3.0,
                "vibration": 1.0,
                "delta": 0.5,
            },
        ),
        (
            "/api/heartbeat",
            {
                "device_id": "sensor-node-1",
                "components": {
                    "adxl345": "ok",
                    "sw420": "ok",
                },
            },
        ),
    ],
)
def test_missing_api_key_returns_401(client, endpoint, payload):
    response = client.post(endpoint, json=payload)

    assert response.status_code == 401
    assert "Unauthorized" in response.get_json()["error"]


@pytest.mark.parametrize(
    "endpoint,payload",
    [
        (
            "/api/events",
            {
                "event_type": "POSSIBLE_COLLISION",
                "latitude": 12.97,
                "longitude": 77.59,
                "x": 1.0,
                "y": 2.0,
                "z": 3.0,
                "vibration": 1.0,
                "delta": 0.5,
            },
        ),
        (
            "/api/heartbeat",
            {
                "device_id": "sensor-node-1",
                "components": {
                    "adxl345": "ok",
                    "sw420": "ok",
                },
            },
        ),
    ],
)
def test_invalid_api_key_returns_401(client, endpoint, payload):
    response = client.post(
        endpoint,
        json=payload,
        headers={"X-API-Key": "wrong-key"},
    )

    assert response.status_code == 401


def test_missing_server_api_key_returns_503(client, backend_app, monkeypatch):
    monkeypatch.setattr(backend_app, "DEVICE_API_KEY", None)

    response = client.post(
        "/api/events",
        json={},
    )

    assert response.status_code == 503
    assert "misconfigured" in response.get_json()["error"]


@pytest.mark.parametrize(
    "endpoint",
    ["/api/events", "/api/heartbeat"],
)
def test_options_preflight_does_not_require_api_key(client, endpoint):
    response = client.options(endpoint)

    assert response.status_code == 204
