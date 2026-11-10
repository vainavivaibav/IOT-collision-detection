
# VehicleGuard IoT — Security and Monitoring

## 1. Overview

This document describes the cloud backend security, input validation, device health monitoring, logging, and automated testing implemented for the VehicleGuard IoT system.

The Flask backend receives collision events and device heartbeats from ESP32 devices, stores the information in PostgreSQL, and provides data to the dashboard.

## 2. API Security

### Device API Key Authentication

The backend uses API-key authentication for device data ingestion.

- The API key is configured using the `DEVICE_API_KEY` environment variable.
- Devices must send the key through the `X-API-Key` HTTP header.
- The `POST /api/events` endpoint requires authentication.
- The `POST /api/heartbeat` endpoint requires authentication.

HTTP responses:

| Condition | Status Code |
|---|---|
| Missing API key | 401 Unauthorized |
| Invalid API key | 401 Unauthorized |
| Server API key not configured | 503 Service Unavailable |
| Valid API key | Request proceeds |

API keys are not hardcoded into the backend source code.

### CORS Configuration

The backend provides CORS headers to allow the dashboard to communicate with the API.

Supported methods:
- GET
- POST
- OPTIONS

Allowed request headers include:
- Content-Type
- X-API-Key

CORS allows browser-based cross-origin requests. It does not replace API authentication.

## 3. Input Validation

Incoming collision-event data is validated before database insertion.

Validation checks include:

- Request body must be a JSON object.
- All required fields must be present.
- Event type must be `POSSIBLE_COLLISION`.
- Latitude must be between -90 and 90.
- Longitude must be between -180 and 180.
- Numeric fields must contain finite numbers.
- Boolean values are rejected as numeric inputs.
- Latitude and longitude must either both contain valid values or both be null.

Invalid requests receive HTTP 400 Bad Request.

### Heartbeat Validation

Device heartbeat requests are also validated.

- Only registered device IDs are accepted.
- Each device must provide its expected component names.
- Component states must match the allowed values.
- Sensor telemetry is accepted only from `sensor-node-1`.
- Telemetry values must be finite numbers.
- GPS coordinates must be valid and supplied together.

## 4. Device Health Monitoring

The backend monitors two registered devices:

| Device ID | Purpose |
|---|---|
| sensor-node-1 | Motion and impact sensor node |
| gateway-node-2 | Gateway and GPS node |

Devices report their status through:

`POST /api/heartbeat`

The backend stores:
- Device ID
- Component states
- Sensor telemetry
- Last heartbeat timestamp

### Device Status Conditions

The device status endpoint is:

`GET /api/devices/status`

| Status | Condition |
|---|---|
| Online | Heartbeat received within 60 seconds |
| Stale | Last heartbeat received more than 60 seconds ago |
| Never Seen | No heartbeat record exists |

The dashboard can use this information to identify devices that are active or may have stopped communicating.

## 5. Backend Logging and Error Handling

The backend uses Python's logging module.

- Logging level is set to INFO.
- Errors are recorded using `logger.exception()`.
- Database and backend failures are logged.
- Internal exception details are not returned in API error responses.
- Sensitive credentials are not intentionally printed in application logs.

The `/health` endpoint checks database connectivity.

| Condition | Response |
|---|---|
| Database connected | HTTP 200 — Healthy |
| Database unavailable | HTTP 503 — Unhealthy |

## 6. Automated Testing

Automated tests are implemented using pytest and Flask's test client.

Test files:

| Test File | Purpose |
|---|---|
| test_security.py | API-key authentication and CORS preflight |
| test_validation.py | Collision-event payload validation |
| test_monitoring.py | Device status and database error handling |
| conftest.py | Shared test configuration and fixtures |

The tests use mocked database dependencies. They do not require a live PostgreSQL connection.

### Test Execution

Run all tests from the repository root:

```bash
python -m pytest cloud_backend/tests/ -v
```

### Test Results

| Test Area | Passed |
|---|---:|
| Security | 7 |
| Validation | 15 |
| Monitoring | 4 |
| **Total** | **26** |

All 26 automated tests passed successfully in the local test environment.

## 7. Security Considerations and Limitations

- Production API keys should be stored as environment variables or secure deployment secrets.
- Exposed credentials should be rotated.
- The current CORS configuration allows all origins and should be restricted to trusted dashboard origins before production use.
- The firmware currently uses `setInsecure()` for HTTPS. Certificate validation should be implemented before production deployment.
- Public read-only dashboard endpoints should be reviewed for data exposure before production use.
- The automated tests use mocked database connections; live PostgreSQL integration testing is separate.

## 8. Conclusion

The cloud backend has automated coverage for device API authentication, collision-event validation, device health monitoring, and database error handling.

The implementation strengthens the existing VehicleGuard IoT backend without changing its existing API routes or database schema.
