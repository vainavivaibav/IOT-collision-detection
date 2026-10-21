# VehicleGuard IoT — Cloud Backend

Flask + PostgreSQL API that receives collision events from the ESP32 gateway and serves event history to the VehicleGuard dashboard.

## Architecture

```
ESP32 Gateway  ──POST /api/events──▶  Flask Backend  ──▶  PostgreSQL
                   (X-API-Key)              │
                                            │
Dashboard      ◀──GET /api/events───────────┘
                   (public, read-only)
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | None | Service info |
| `GET` | `/health` | None | Database connectivity check |
| `POST` | `/api/events` | `X-API-Key` header | Ingest a collision event |
| `GET` | `/api/events` | None (public) | Retrieve recent events (newest first) |

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
psql -U postgres -c "CREATE DATABASE vehicleguard;"

# Option B: Docker (quick setup)
docker run --name vehicleguard-db -e POSTGRES_DB=vehicleguard -e POSTGRES_PASSWORD=devpass -p 5432:5432 -d postgres:16
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
DATABASE_URL=postgresql://postgres:devpass@localhost:5432/vehicleguard
DEVICE_API_KEY=dev-test-key-change-in-production
PORT=5000
```

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
  -H "X-API-Key: dev-test-key-change-in-production" \
  -d '{"event_type":"POSSIBLE_COLLISION","latitude":12.9716,"longitude":77.5946,"x":8.42,"y":6.31,"z":14.87,"vibration":1.0,"delta":12.5}'

# Retrieve events
curl http://localhost:5000/api/events
```

---

## Dashboard Configuration

The dashboard fetches events from the cloud backend. Configure the API URL in `script.js`:

```javascript
// For local development:
const CLOUD_API_BASE_URL = "http://localhost:5000";

// For production (after Render deployment):
// const CLOUD_API_BASE_URL = "https://your-app-name.onrender.com";
```

The dashboard uses the **public** `GET /api/events` endpoint — no API key is exposed in browser JavaScript.

---

## Render Deployment

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Add VehicleGuard cloud backend"
git remote add origin https://github.com/YOUR_USERNAME/vehicleguard-iot.git
git push -u origin main
```

### 2. Create PostgreSQL on Render

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **New → PostgreSQL**
3. Name: `vehicleguard-db`
4. Plan: **Free** (for development) or **Starter** (for production)
5. Click **Create Database**
6. Copy the **Internal Database URL** — you'll need it for the web service

### 3. Create the Web Service on Render

1. Click **New → Web Service**
2. Connect your GitHub repository
3. Configure:

| Setting | Value |
|---------|-------|
| **Name** | `vehicleguard-api` |
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
# Replace with your actual Render URL
curl https://vehicleguard-api.onrender.com/health
# Expected: {"database":"connected","status":"healthy"}

curl https://vehicleguard-api.onrender.com/api/events
# Expected: {"count":0,"events":[]}
```

### 5. Update the dashboard

Update `CLOUD_API_BASE_URL` in `script.js` to your Render URL.

---

## Security Notes

- **`DEVICE_API_KEY`** is a server-side secret. It is **never** included in dashboard JavaScript.
- The `GET /api/events` endpoint is intentionally public (read-only) so the dashboard can fetch events without exposing secrets.
- If you need to restrict dashboard access in the future, consider:
  - A separate read-only API key checked server-side
  - JWT-based authentication
  - IP allowlisting on Render
- All SQL queries use **parameterized statements** — no SQL injection risk.
- **Render DATABASE_URL**: Render provides `postgres://...` but some psycopg versions expect `postgresql://...`. The backend automatically rewrites the prefix on startup — no manual action needed.

---

## ESP32 Networking — Next Steps

The existing system uses ESP32 #1 as a Wi-Fi AP and ESP32 #2 (gateway) as its client. To reach the cloud backend, the gateway needs internet access.

**Recommended minimal change** (do NOT apply without testing):

1. Configure ESP32 #2 (gateway) in **Wi-Fi STA+AP mode** — it connects to a home/mobile Wi-Fi router for internet while still accepting connections from ESP32 #1.
2. After receiving a `POSSIBLE_COLLISION` event over the local TCP link, the gateway sends an HTTPS POST to the cloud backend.
3. This change affects **only the gateway's Wi-Fi configuration** — no sensor thresholds, pin assignments, or collision detection logic changes.

This networking change should be implemented and tested separately after the cloud backend is verified working.
