# SAFERIDE IoT — Cloud Backend

Flask + PostgreSQL API that receives collision events from the ESP32 gateway and serves stored event history to the SAFERIDE dashboard.

## Architecture

```
ESP32 Gateway  ──POST /api/events──▶  Flask Backend  ──▶  PostgreSQL
                   (X-API-Key)              │
                                            │
Dashboard      ◀──GET /api/events───────────┘
                   (public, read-only)
```

## SAFERIDE System Architecture and Integration Status

The intended vehicle and motion platform is a four-wheeled robot chassis with two DC geared motors, an L298N motor driver, and a suitable motor power supply. ESP32 #1 reads the ADXL345 and SW-420, hosts the `CollisionNet` access point, and acts as the internet gateway to this API. ESP32 #2 reads the NEO-6M GPS and sends GPS updates to ESP32 #1 over TCP.

For cloud monitoring, ESP32 #1 joins a configured Wi-Fi hotspot while hosting `CollisionNet` for ESP32 #2, then sends telemetry and collision events to this existing Render-hosted Flask API and PostgreSQL database. The dashboard reads event history and device status through public GET endpoints. Successful dashboard retrieval alone does not verify that either ESP32 is connected.

A separate SIM800L GSM module is planned to send collision and location details by SMS to a designated contact. It is not part of the Wi-Fi cloud route. Its supply and wiring must be checked with a multimeter before integration. SIM800L wiring, SMS functionality, and delivery have not been verified or implemented by this backend or dashboard.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | None | Service info |
| `GET` | `/health` | None | Database connectivity check |
| `POST` | `/api/events` | `X-API-Key` header | Ingest a collision event |
| `GET` | `/api/events` | None (public) | Retrieve recent events (newest first) |
| `POST` | `/api/heartbeat` | `X-API-Key` header | Record device heartbeat, component states, and sensor telemetry |
| `GET` | `/api/devices/status` | None (public) | Retrieve latest device status and telemetry |

### POST /api/events — Request Body

```json
{
  "event_type": "POSSIBLE_COLLISION",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "x": 8.42,
  "y": 6.31,
  "z": 14.87,
  "vibration": 1.0,
  "delta": 12.5
}
```

If there is no fresh GPS fix, both `latitude` and `longitude` may be `null`.

### POST /api/heartbeat — Request Bodies

ESP32 #1 reports its sensor state and latest readings:

```json
{
  "device_id": "sensor-node-1",
  "components": {
    "adxl345": "ok",
    "sw420": "unknown"
  },
  "telemetry": {
    "x": 12,
    "y": -3,
    "z": 245,
    "vibration": 0,
    "delta": 4,
    "latitude": null,
    "longitude": null
  }
}
```

ESP32 #1 relays a gateway heartbeat only while recent TCP/GPS messages from ESP32 #2 are being received:

```json
{
  "device_id": "gateway-node-2",
  "components": {
    "tcp_link": "connected",
    "gps_fix": "valid"
  }
}
```

The backend timestamps heartbeats when received. A device is `online` for 60 seconds after its most recent heartbeat, then `stale`; a device without a heartbeat is `never_seen`. The dashboard polls status independently from collision-event history.

### GET /api/events — Response

```json
{
  "count": 1,
  "events": [
    {
      "id": 1,
      "event_type": "POSSIBLE_COLLISION",
      "latitude": 12.9716,
      "longitude": 77.5946,
      "x": 8.42,
      "y": 6.31,
      "z": 14.87,
      "vibration": 1.0,
      "delta": 12.5,
      "received_at": "2026-10-21T13:30:00+00:00"
    }
  ]
}
```

---

## Local Development Setup

### 1. Prerequisites

- Python 3.10+
- PostgreSQL 14+ (running locally or via Docker)

### 2. Create the database

```bash
# Option A: Local PostgreSQL
psql -U postgres -c "CREATE DATABASE saferide;"

# Option B: Docker (quick setup)
docker run --name saferide-db -e POSTGRES_DB=saferide -e POSTGRES_PASSWORD=devpass -p 5432:5432 -d postgres:16
```

### 3. Set up the backend

```bash
cd cloud_backend

# Create virtual environment
python -m venv venv

# Activate it
# Windows:
venv\Scripts\activate
# macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

### 4. Configure environment variables

Create a `.env` file (never commit this):

```bash
# cloud_backend/.env
DATABASE_URL=postgresql://postgres:devpass@localhost:5432/saferide
DEVICE_API_KEY=YOUR_DEVICE_API_KEY
PORT=5000
```

Configure the real `DEVICE_API_KEY` as a backend environment variable (or in an uncommitted local `.env` file). Never include the real key or placeholder in frontend HTML, CSS, JavaScript, or other public files.

Load them before running:

```bash
# Windows PowerShell:
Get-Content .env | ForEach-Object { if ($_ -match '^([^#=]+)=(.*)$') { [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process') } }

# macOS/Linux:
export $(grep -v '^#' .env | xargs)
```

### 5. Run the development server

```bash
python app.py
```

The server starts at `http://localhost:5000`.

### 6. Test the API

```bash
# Health check
curl http://localhost:5000/health

# Ingest a test event
curl -X POST http://localhost:5000/api/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_DEVICE_API_KEY" \
  -d '{"event_type":"POSSIBLE_COLLISION","latitude":12.9716,"longitude":77.5946,"x":8.42,"y":6.31,"z":14.87,"vibration":1.0,"delta":12.5}'

# Retrieve events
curl http://localhost:5000/api/events
```

---

## Dashboard Configuration

The dashboard fetches stored events from the existing Render backend at `https://iot-collision-detection.onrender.com`. Its configuration in `script.js` is:

```javascript
const CONFIG = {
  API_BASE_URL: 'https://iot-collision-detection.onrender.com'
};
```

The dashboard requests `GET /api/events?limit=50` using the public read-only endpoint. It does not need an API key, and it does not send authenticated `POST` requests from the browser. The POST endpoint requires `X-API-Key`; keep that key on a trusted device or backend component. A healthy API or successful event query confirms backend availability and retrieval, not that an ESP32 is connected or generating events.

Verify the existing production backend with:

```bash
curl https://iot-collision-detection.onrender.com/health
curl "https://iot-collision-detection.onrender.com/api/events?limit=50"
```

The events response has the documented `{ "count": ..., "events": [...] }` shape; the count may be zero or nonzero depending on stored records.

---

## Provisioning a Separate Render Backend

The backend for this project already exists at `https://iot-collision-detection.onrender.com`. Do not follow these provisioning steps when deploying the frontend. The steps below are only for creating a separate backend instance.

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Add SAFERIDE cloud backend"
git remote add origin https://github.com/vainavivaibav/IOT-collision-detection.git
git push -u origin main
```

### 2. Create PostgreSQL on Render

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **New → PostgreSQL**
3. Name: `saferide-db`
4. Plan: **Free** (for development) or **Starter** (for production)
5. Click **Create Database**
6. Copy the **Internal Database URL** — you'll need it for the web service

### 3. Create the Web Service on Render

1. Click **New → Web Service**
2. Connect your GitHub repository
3. Configure:

| Setting | Value |
|---------|-------|
| **Name** | `saferide-api` |
| **Root Directory** | `cloud_backend` |
| **Runtime** | Python 3 |
| **Build Command** | `pip install -r requirements.txt` |
| **Start Command** | `gunicorn app:app --bind 0.0.0.0:$PORT --workers 2` |

4. Add **Environment Variables**:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | *(paste the Internal Database URL from step 2)* |
| `DEVICE_API_KEY` | *(generate a strong random key, e.g. `openssl rand -hex 32`)* |
| `PYTHON_VERSION` | `3.11.9` |

5. Set **Health Check Path**: `/health`
6. Click **Create Web Service**

### 4. Verify deployment

```bash
curl https://YOUR_NEW_SERVICE.onrender.com/health
# Expected: {"database":"connected","status":"healthy"}

curl "https://YOUR_NEW_SERVICE.onrender.com/api/events?limit=50"
# Expected: {"count":0,"events":[]}
```

### 5. Dashboard deployment

The existing dashboard is already configured for this API URL. For the static website, deploy the HTML, CSS, and JavaScript as a Render Static Site; do not create or replace this backend service as part of the frontend deployment.

---

## Security Notes

- **`DEVICE_API_KEY`** is a server-side secret configured as a backend environment variable. Never include its real value in frontend HTML, CSS, JavaScript, or other public files.
- The `GET /api/events` endpoint is intentionally public (read-only) so the dashboard can fetch events without exposing secrets.
- If you need to restrict dashboard access in the future, consider:
  - A separate read-only API key checked server-side
  - JWT-based authentication
  - IP allowlisting on Render
- All SQL queries use **parameterized statements** — no SQL injection risk.
- **Render DATABASE_URL**: Render provides `postgres://...` but some psycopg versions expect `postgresql://...`. The backend automatically rewrites the prefix on startup — no manual action needed.

---

## Device Integration and Limitations

Arduino sketches and setup guidance are in [`../firmware/README.md`](../firmware/README.md). ESP32 #1 uploads heartbeats and latest sensor telemetry when connected to the internet, while collision events are stored separately through `POST /api/events`. ESP32 #2's cloud-visible status is relayed by ESP32 #1 based on its local TCP/GPS messages. Physical wiring, hotspot connectivity, and hardware behavior still need to be tested on the assembled device.

The SW-420 status is `unknown` because a digital input read alone cannot establish that the module is physically functioning. ESP32 #2 reports GPS fix separately from gateway connectivity. The ESP32 TLS client currently skips certificate verification for this prototype; configure certificate validation before production use.

The SIM800L is a separate planned GSM path for SMS alerts containing collision and GPS information. Before integrating it, verify its power supply and wiring with a multimeter. No SMS endpoint, firmware integration, or SMS delivery verification is provided by this Flask backend.
