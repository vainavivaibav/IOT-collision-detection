"""
VehicleGuard IoT — Cloud Backend
=================================
Flask API that receives collision events from the ESP32 gateway,
stores them in a PostgreSQL database, and serves event history
to the VehicleGuard dashboard.

Environment variables:
    DATABASE_URL    — PostgreSQL connection string
    DEVICE_API_KEY  — Secret key for device ingestion (POST /api/events)
    PORT            — Server port (default 5000)

Production start command:
    gunicorn app:app --bind 0.0.0.0:$PORT --workers 2
"""

import os
import logging
import datetime
import math

from flask import Flask, request, jsonify
import psycopg

# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────

app = Flask(__name__)

# Logging — log errors but never expose secrets
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
DEVICE_API_KEY = os.environ.get("DEVICE_API_KEY")

# Render provides postgres:// but some psycopg versions expect postgresql://
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

if not DATABASE_URL:
    logger.warning("DATABASE_URL is not set — database operations will fail.")
if not DEVICE_API_KEY:
    logger.warning("DEVICE_API_KEY is not set — device ingestion will be disabled.")

EXPECTED_DEVICES = {
    "sensor-node-1": {
        "label": "Motion and impact sensor node",
        "components": {
            "adxl345": {"ok", "error", "unknown"},
            "sw420": {"ok", "error", "unknown"},
        },
    },
    "gateway-node-2": {
        "label": "Gateway and GPS node",
        "components": {
            "tcp_link": {"connected", "disconnected", "unknown"},
            "gps_fix": {"valid", "no_fix", "unknown"},
        },
    },
}
DEVICE_ONLINE_WINDOW_SECONDS = 60


# ──────────────────────────────────────────────
# Database helpers
# ──────────────────────────────────────────────

def get_db_connection():
    """Open a new database connection using DATABASE_URL."""
    return psycopg.connect(DATABASE_URL)


def init_db():
    """Create the events table if it doesn't already exist."""
    schema_statements = [
        """
        CREATE TABLE IF NOT EXISTS collision_events (
            id              SERIAL PRIMARY KEY,
            event_type      VARCHAR(50)     NOT NULL,
            latitude        DOUBLE PRECISION NOT NULL,
            longitude       DOUBLE PRECISION NOT NULL,
            x               DOUBLE PRECISION NOT NULL,
            y               DOUBLE PRECISION NOT NULL,
            z               DOUBLE PRECISION NOT NULL,
            vibration       DOUBLE PRECISION NOT NULL,
            delta           DOUBLE PRECISION NOT NULL,
            received_at     TIMESTAMPTZ     NOT NULL DEFAULT NOW()
        );
        """,
        """
        CREATE TABLE IF NOT EXISTS device_heartbeats (
            device_id       VARCHAR(64) PRIMARY KEY,
            components      JSONB       NOT NULL,
            telemetry       JSONB       NOT NULL DEFAULT '{}'::jsonb,
            last_seen       TIMESTAMPTZ NOT NULL
        );
        """,
        """
        ALTER TABLE device_heartbeats
            ADD COLUMN IF NOT EXISTS telemetry JSONB NOT NULL DEFAULT '{}'::jsonb;
        """,
        """
        ALTER TABLE collision_events
            ALTER COLUMN latitude DROP NOT NULL,
            ALTER COLUMN longitude DROP NOT NULL;
        """,
    ]
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                for statement in schema_statements:
                    cur.execute(statement)
            conn.commit()
        logger.info("Database schema initialized successfully.")
    except Exception:
        logger.exception("Failed to initialize database schema.")


# ──────────────────────────────────────────────
# CORS headers (allow dashboard on any origin)
# ──────────────────────────────────────────────

@app.after_request
def add_cors_headers(response):
    """Add CORS headers so the local dashboard can fetch events."""
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-API-Key"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response


# ──────────────────────────────────────────────
# Authentication helper
# ──────────────────────────────────────────────

def require_device_api_key():
    """
    Validate the X-API-Key header against DEVICE_API_KEY.
    Returns an error response tuple if invalid, or None if valid.
    """
    if not DEVICE_API_KEY:
        return jsonify({"error": "Server misconfigured — device ingestion disabled"}), 503

    provided_key = request.headers.get("X-API-Key", "")
    if provided_key != DEVICE_API_KEY:
        return jsonify({"error": "Unauthorized — invalid or missing API key"}), 401

    return None  # Key is valid


# ──────────────────────────────────────────────
# Validation helpers
# ──────────────────────────────────────────────

ALLOWED_EVENT_TYPES = {"POSSIBLE_COLLISION"}


def validate_event_payload(data):
    """
    Validate the incoming event JSON. Returns (cleaned_data, None)
    on success or (None, error_response_tuple) on failure.
    """
    if not isinstance(data, dict):
        return None, (jsonify({"error": "Request body must be a JSON object"}), 400)

    required_fields = ["event_type", "latitude", "longitude", "x", "y", "z", "vibration", "delta"]
    missing = [f for f in required_fields if f not in data]
    if missing:
        return None, (jsonify({"error": f"Missing required fields: {', '.join(missing)}"}), 400)

    # Validate event_type
    event_type = data["event_type"]
    if not isinstance(event_type, str) or event_type not in ALLOWED_EVENT_TYPES:
        return None, (jsonify({
            "error": f"Invalid event_type. Allowed: {', '.join(ALLOWED_EVENT_TYPES)}"
        }), 400)

    # Validate numeric fields
    numeric_fields = {
        "latitude": (-90.0, 90.0),
        "longitude": (-180.0, 180.0),
        "x": (None, None),
        "y": (None, None),
        "z": (None, None),
        "vibration": (None, None),
        "delta": (None, None),
    }

    cleaned = {"event_type": event_type}

    for field, (min_val, max_val) in numeric_fields.items():
        value = data[field]
        if field in {"latitude", "longitude"} and value is None:
            cleaned[field] = None
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None, (jsonify({"error": f"Field '{field}' must be a number"}), 400)
        try:
            numeric_value = float(value)
        except OverflowError:
            return None, (jsonify({"error": f"Field '{field}' must be finite"}), 400)
        if not math.isfinite(numeric_value):
            return None, (jsonify({"error": f"Field '{field}' must be finite"}), 400)

        if min_val is not None and numeric_value < min_val:
            return None, (jsonify({"error": f"Field '{field}' out of range (min {min_val})"}), 400)
        if max_val is not None and numeric_value > max_val:
            return None, (jsonify({"error": f"Field '{field}' out of range (max {max_val})"}), 400)

        cleaned[field] = numeric_value

    if (cleaned.get("latitude") is None) != (cleaned.get("longitude") is None):
        return None, (jsonify({
            "error": "Latitude and longitude must both be numbers or both be null"
        }), 400)

    return cleaned, None


# ──────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────

@app.route("/", methods=["GET"])
def index():
    """Basic service information."""
    return jsonify({
        "service": "VehicleGuard IoT — Cloud Backend",
        "version": "1.0.0",
        "endpoints": {
            "health": "/health",
            "events_ingest": "POST /api/events",
            "events_list": "GET /api/events",
            "heartbeat": "POST /api/heartbeat",
            "device_status": "GET /api/devices/status",
        },
    })


@app.route("/health", methods=["GET"])
def health():
    """Health check — verify database connectivity."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
        return jsonify({"status": "healthy", "database": "connected"}), 200
    except Exception:
        logger.exception("Health check failed — database unreachable.")
        return jsonify({"status": "unhealthy", "database": "disconnected"}), 503


@app.route("/api/heartbeat", methods=["POST", "OPTIONS"])
def receive_heartbeat():
    """Record an authenticated device heartbeat and its reported component states."""
    if request.method == "OPTIONS":
        return "", 204

    auth_error = require_device_api_key()
    if auth_error:
        return auth_error

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400

    device_id = data.get("device_id")
    device = EXPECTED_DEVICES.get(device_id) if isinstance(device_id, str) else None
    if device is None:
        return jsonify({"error": "Unknown device_id"}), 400

    components = data.get("components")
    allowed_components = device["components"]
    if (
        not isinstance(components, dict)
        or set(components) != set(allowed_components)
        or any(
            not isinstance(value, str) or value not in allowed_components[key]
            for key, value in components.items()
        )
    ):
        return jsonify({"error": "Invalid component states for device_id"}), 400

    telemetry = {}
    if device_id == "sensor-node-1" and "telemetry" in data:
        supplied_telemetry = data["telemetry"]
        telemetry_fields = {
            "x", "y", "z", "vibration", "delta", "latitude", "longitude"
        }
        if (
            not isinstance(supplied_telemetry, dict)
            or set(supplied_telemetry) != telemetry_fields
        ):
            return jsonify({"error": "Invalid sensor telemetry fields"}), 400

        for field in ("x", "y", "z", "vibration", "delta"):
            value = supplied_telemetry[field]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return jsonify({
                    "error": f"Telemetry field '{field}' must be a finite number"
                }), 400
            try:
                numeric_value = float(value)
            except OverflowError:
                return jsonify({
                    "error": f"Telemetry field '{field}' must be a finite number"
                }), 400
            if not math.isfinite(numeric_value):
                return jsonify({
                    "error": f"Telemetry field '{field}' must be a finite number"
                }), 400
            telemetry[field] = numeric_value

        latitude = supplied_telemetry["latitude"]
        longitude = supplied_telemetry["longitude"]
        if (latitude is None) != (longitude is None):
            return jsonify({
                "error": "Latitude and longitude must both be numbers or both be null"
            }), 400
        if latitude is None:
            telemetry["latitude"] = None
            telemetry["longitude"] = None
        else:
            if (
                isinstance(latitude, bool)
                or not isinstance(latitude, (int, float))
                or isinstance(longitude, bool)
                or not isinstance(longitude, (int, float))
            ):
                return jsonify({"error": "Invalid GPS coordinates"}), 400
            try:
                latitude_value = float(latitude)
                longitude_value = float(longitude)
            except OverflowError:
                return jsonify({"error": "Invalid GPS coordinates"}), 400
            if (
                not math.isfinite(latitude_value)
                or not math.isfinite(longitude_value)
                or not -90 <= latitude_value <= 90
                or not -180 <= longitude_value <= 180
            ):
                return jsonify({"error": "Invalid GPS coordinates"}), 400
            telemetry["latitude"] = latitude_value
            telemetry["longitude"] = longitude_value
    elif "telemetry" in data:
        return jsonify({"error": "Telemetry is only accepted from sensor-node-1"}), 400

    received_at = datetime.datetime.now(datetime.timezone.utc)
    upsert_sql = """
    INSERT INTO device_heartbeats (device_id, components, telemetry, last_seen)
    VALUES (%(device_id)s, %(components)s, %(telemetry)s, %(last_seen)s)
    ON CONFLICT (device_id)
    DO UPDATE SET components = EXCLUDED.components,
                  telemetry = EXCLUDED.telemetry,
                  last_seen = EXCLUDED.last_seen
    """

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(upsert_sql, {
                    "device_id": device_id,
                    "components": psycopg.types.json.Jsonb(components),
                    "telemetry": psycopg.types.json.Jsonb(telemetry),
                    "last_seen": received_at,
                })
            conn.commit()
        return jsonify({
            "status": "recorded",
            "device_id": device_id,
            "received_at": received_at.isoformat(),
        }), 200
    except Exception:
        logger.exception("Failed to record device heartbeat.")
        return jsonify({"error": "Could not record device heartbeat"}), 500


@app.route("/api/devices/status", methods=["GET"])
def get_device_status():
    """Return recent heartbeat state for the known devices."""
    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT device_id, components, telemetry, last_seen "
                    "FROM device_heartbeats"
                )
                rows = cur.fetchall()

        now = datetime.datetime.now(datetime.timezone.utc)
        stored = {
            device_id: (components, telemetry, last_seen)
            for device_id, components, telemetry, last_seen in rows
        }
        devices = []
        for device_id, definition in EXPECTED_DEVICES.items():
            record = stored.get(device_id)
            if record is None:
                components = {}
                telemetry = {}
                last_seen = None
                age_seconds = None
                status = "never_seen"
            else:
                components, telemetry, last_seen = record
                age_seconds = max(0, int((now - last_seen).total_seconds()))
                status = (
                    "online"
                    if age_seconds <= DEVICE_ONLINE_WINDOW_SECONDS
                    else "stale"
                )

            devices.append({
                "device_id": device_id,
                "label": definition["label"],
                "status": status,
                "last_seen": last_seen.isoformat() if last_seen else None,
                "age_seconds": age_seconds,
                "components": components,
                "telemetry": telemetry,
            })

        return jsonify({"devices": devices}), 200
    except Exception:
        logger.exception("Failed to retrieve device status.")
        return jsonify({"error": "Could not retrieve device status"}), 500


@app.route("/api/events", methods=["POST", "OPTIONS"])
def ingest_event():
    """
    Accept a collision event from the ESP32 gateway.
    Requires X-API-Key header matching DEVICE_API_KEY.
    """
    # Handle CORS preflight
    if request.method == "OPTIONS":
        return "", 204

    # Authenticate
    auth_error = require_device_api_key()
    if auth_error:
        return auth_error

    # Parse JSON
    try:
        data = request.get_json(force=True)
    except Exception:
        return jsonify({"error": "Invalid JSON in request body"}), 400

    if data is None:
        return jsonify({"error": "Request body must be valid JSON"}), 400

    # Validate
    cleaned, validation_error = validate_event_payload(data)
    if validation_error:
        return validation_error

    # Store in database with server-generated UTC timestamp
    received_at = datetime.datetime.now(datetime.timezone.utc)

    insert_sql = """
    INSERT INTO collision_events
        (event_type, latitude, longitude, x, y, z, vibration, delta, received_at)
    VALUES
        (%(event_type)s, %(latitude)s, %(longitude)s,
         %(x)s, %(y)s, %(z)s, %(vibration)s, %(delta)s, %(received_at)s)
    RETURNING id, received_at
    """

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(insert_sql, {**cleaned, "received_at": received_at})
                row = cur.fetchone()
            conn.commit()

        event_id = row[0]
        stored_at = row[1].isoformat()

        logger.info("Stored collision event id=%d type=%s", event_id, cleaned["event_type"])

        return jsonify({
            "status": "stored",
            "event_id": event_id,
            "received_at": stored_at,
        }), 201

    except Exception:
        logger.exception("Failed to store collision event.")
        return jsonify({"error": "Internal server error — could not store event"}), 500


@app.route("/api/events", methods=["GET"])
def list_events():
    """
    Retrieve recent collision events, newest first.
    This is a PUBLIC read-only endpoint — no API key required.
    The dashboard fetches from this endpoint.

    Query parameters:
        limit   — max number of events to return (default 50, max 200)
    """
    try:
        limit = max(1, min(int(request.args.get("limit", 50)), 200))
    except (ValueError, TypeError):
        limit = 50

    select_sql = """
    SELECT id, event_type, latitude, longitude, x, y, z, vibration, delta, received_at
    FROM collision_events
    ORDER BY received_at DESC
    LIMIT %(limit)s
    """

    try:
        with get_db_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(select_sql, {"limit": limit})
                rows = cur.fetchall()

        events = []
        for row in rows:
            events.append({
                "id": row[0],
                "event_type": row[1],
                "latitude": row[2],
                "longitude": row[3],
                "x": row[4],
                "y": row[5],
                "z": row[6],
                "vibration": row[7],
                "delta": row[8],
                "received_at": row[9].isoformat() if row[9] else None,
            })

        return jsonify({
            "count": len(events),
            "events": events,
        }), 200

    except Exception:
        logger.exception("Failed to retrieve events.")
        return jsonify({"error": "Internal server error — could not retrieve events"}), 500


# ──────────────────────────────────────────────
# Startup
# ──────────────────────────────────────────────

# Initialize database on import (safe for Gunicorn workers)
if DATABASE_URL:
    init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    logger.info("Starting VehicleGuard Cloud Backend on port %d", port)
    app.run(host="0.0.0.0", port=port, debug=True)
