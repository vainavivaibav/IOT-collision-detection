
import math
import pytest
import app as backend


def valid_payload():
    return {
        "event_type": "POSSIBLE_COLLISION",
        "latitude": 12.97,
        "longitude": 77.59,
        "x": 1.0,
        "y": 2.0,
        "z": 3.0,
        "vibration": 1.0,
        "delta": 0.5,
    }


def validate(client_app, payload):
    with client_app.app.test_request_context():
        return backend.validate_event_payload(payload)


def test_valid_event_payload(backend_app):
    cleaned, error = validate(backend_app, valid_payload())

    assert error is None
    assert cleaned["event_type"] == "POSSIBLE_COLLISION"
    assert cleaned["latitude"] == 12.97
    assert cleaned["longitude"] == 77.59


def test_valid_payload_with_both_gps_values_null(backend_app):
    payload = valid_payload()
    payload["latitude"] = None
    payload["longitude"] = None

    cleaned, error = validate(backend_app, payload)

    assert error is None
    assert cleaned["latitude"] is None
    assert cleaned["longitude"] is None


def test_non_dictionary_payload_is_rejected(backend_app):
    cleaned, error = validate(backend_app, ["invalid"])

    assert cleaned is None
    assert error[1] == 400


def test_missing_required_field_is_rejected(backend_app):
    payload = valid_payload()
    del payload["event_type"]

    cleaned, error = validate(backend_app, payload)

    assert cleaned is None
    assert error[1] == 400


def test_invalid_event_type_is_rejected(backend_app):
    payload = valid_payload()
    payload["event_type"] = "UNKNOWN_EVENT"

    cleaned, error = validate(backend_app, payload)

    assert cleaned is None
    assert error[1] == 400


@pytest.mark.parametrize(
    "field,value",
    [
        ("x", True),
        ("y", "invalid"),
        ("z", None),
        ("vibration", math.inf),
        ("delta", math.nan),
    ],
)
def test_invalid_numeric_values_are_rejected(backend_app, field, value):
    payload = valid_payload()
    payload[field] = value

    cleaned, error = validate(backend_app, payload)

    assert cleaned is None
    assert error[1] == 400


@pytest.mark.parametrize(
    "field,value",
    [
        ("latitude", 91),
        ("latitude", -91),
        ("longitude", 181),
        ("longitude", -181),
    ],
)
def test_gps_out_of_range_values_are_rejected(backend_app, field, value):
    payload = valid_payload()
    payload[field] = value

    cleaned, error = validate(backend_app, payload)

    assert cleaned is None
    assert error[1] == 400


def test_only_one_null_gps_coordinate_is_rejected(backend_app):
    payload = valid_payload()
    payload["latitude"] = None

    cleaned, error = validate(backend_app, payload)

    assert cleaned is None
    assert error[1] == 400
