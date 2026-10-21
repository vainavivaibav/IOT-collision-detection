/* ============================================================
   IoT Vehicle Collision Detection Dashboard — JavaScript
   ============================================================
   
   ARCHITECTURE NOTE FOR FUTURE INTEGRATION:
   ------------------------------------------
   All dashboard rendering reads from the `vehicleData` object.
   
   When connecting to the Flask backend, replace the contents of
   fetchVehicleStatus(), fetchSensorData(), fetchLocationData(),
   and fetchHistoryData() with real fetch() / XMLHttpRequest
   calls to your API endpoints:
   
     GET /api/vehicle/status
     GET /api/vehicle/sensors
     GET /api/vehicle/location
     GET /api/vehicle/history
   
   The rendering functions (render*) do NOT need to change — they
   only read from vehicleData.
   ============================================================ */

// ============================================================
// 0. CLOUD API CONFIGURATION & MODULE
//    Fetches collision events from the cloud backend.
//    The GET /api/events endpoint is PUBLIC — no API key needed.
//    Device ingestion (POST) uses X-API-Key server-side only.
// ============================================================

// ── Configuration ──────────────────────────────────────────────
// Change this URL when deploying to Render:
//   const CLOUD_API_BASE_URL = "https://your-app.onrender.com";
const CLOUD_API_BASE_URL = "http://localhost:5000";

// How often to poll the cloud API (milliseconds)
const CLOUD_POLL_INTERVAL_MS = 15000; // 15 seconds

// ── Cloud state object ─────────────────────────────────────────
const cloudState = {
  connected: false,        // true when last fetch succeeded
  events: [],              // array of event objects from API
  lastFetchTime: null,     // Date of last successful fetch
  error: null,             // error message string or null
  loading: true,           // true during initial fetch
};

// ── Cloud API fetch ────────────────────────────────────────────
async function fetchCloudEvents() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(`${CLOUD_API_BASE_URL}/api/events?limit=50`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    cloudState.connected = true;
    cloudState.events = Array.isArray(data.events) ? data.events : [];
    cloudState.lastFetchTime = new Date();
    cloudState.error = null;
    cloudState.loading = false;

  } catch (err) {
    cloudState.connected = false;
    cloudState.error = err.name === "AbortError"
      ? "Request timed out — backend may be starting up."
      : `Could not reach cloud backend (${err.message}).`;
    cloudState.loading = false;
  }

  renderCloudSection();
}

// ── Cloud section renderer ─────────────────────────────────────
function renderCloudSection() {
  // -- Header cloud badge --
  const cloudBadge = document.getElementById("cloud-status");
  if (cloudBadge) {
    if (cloudState.connected) {
      cloudBadge.className = "connection-indicator cloud-online";
      cloudBadge.innerHTML = '<span class="status-dot green"></span> CLOUD';
      cloudBadge.title = "Cloud backend connected";
    } else {
      cloudBadge.className = "connection-indicator cloud-offline";
      cloudBadge.innerHTML = '<span class="status-dot grey"></span> CLOUD';
      cloudBadge.title = cloudState.error || "Cloud backend disconnected";
    }
  }

  // -- Cloud connection label in card header --
  const connLabel = document.getElementById("cloud-connection-label");
  if (connLabel) {
    if (cloudState.loading) {
      connLabel.textContent = "CHECKING\u2026";
      connLabel.className = "badge badge-info";
    } else if (cloudState.connected) {
      connLabel.textContent = "CONNECTED";
      connLabel.className = "badge badge-normal";
    } else {
      connLabel.textContent = "OFFLINE";
      connLabel.className = "badge badge-warning";
    }
  }

  // -- Hero footer cloud stats --
  const countEl = document.getElementById("cloud-event-count");
  const latestEl = document.getElementById("cloud-latest-time");
  if (countEl) {
    countEl.textContent = cloudState.connected ? String(cloudState.events.length) : "\u2014";
  }
  if (latestEl) {
    if (cloudState.connected && cloudState.events.length > 0) {
      latestEl.textContent = formatTime(cloudState.events[0].received_at);
    } else {
      latestEl.textContent = "\u2014";
    }
  }

  // -- State visibility --
  const stateLoading = document.getElementById("cloud-state-loading");
  const stateEmpty   = document.getElementById("cloud-state-empty");
  const stateError   = document.getElementById("cloud-state-error");
  const stateData    = document.getElementById("cloud-state-data");

  if (!stateLoading) return; // elements not in DOM yet

  // Hide all states first
  stateLoading.style.display = "none";
  stateEmpty.style.display   = "none";
  stateError.style.display   = "none";
  stateData.style.display    = "none";

  if (cloudState.loading) {
    stateLoading.style.display = "flex";
  } else if (cloudState.error) {
    stateError.style.display = "flex";
    const errorText = document.getElementById("cloud-error-text");
    if (errorText) errorText.textContent = cloudState.error;
  } else if (cloudState.events.length === 0) {
    stateEmpty.style.display = "flex";
  } else {
    stateData.style.display = "block";
    renderCloudEventsTable();
  }
}

// ── Cloud events table ─────────────────────────────────────────
function renderCloudEventsTable() {
  const tbody = document.getElementById("cloud-events-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  cloudState.events.forEach((evt) => {
    const tr = document.createElement("tr");

    // Format received_at for display
    const timeStr = evt.received_at ? formatTime(evt.received_at) : "\u2014";
    const locStr = `${Number(evt.latitude).toFixed(6)}, ${Number(evt.longitude).toFixed(6)}`;
    const mapsUrl = `https://www.google.com/maps?q=${evt.latitude},${evt.longitude}`;

    tr.innerHTML = `
      <td>${timeStr}</td>
      <td><span class="badge badge-cloud">${escapeHtml(evt.event_type)}</span></td>
      <td>${Number(evt.x).toFixed(2)}</td>
      <td>${Number(evt.y).toFixed(2)}</td>
      <td>${Number(evt.z).toFixed(2)}</td>
      <td>${Number(evt.vibration).toFixed(2)}</td>
      <td>${Number(evt.delta).toFixed(2)}</td>
      <td><a href="${mapsUrl}" target="_blank" rel="noopener noreferrer">${locStr}</a></td>
    `;
    tbody.appendChild(tr);
  });
}

// ── HTML escape helper (prevent XSS from event data) ───────────
function escapeHtml(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ── Cloud polling lifecycle ────────────────────────────────────
function startCloudPolling() {
  // Initial fetch
  fetchCloudEvents();

  // Poll periodically
  setInterval(fetchCloudEvents, CLOUD_POLL_INTERVAL_MS);

  // Retry button
  const retryBtn = document.getElementById("btn-cloud-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", () => {
      cloudState.loading = true;
      renderCloudSection();
      fetchCloudEvents();
    });
  }
}

// ============================================================
// 1. MOCK DATA OBJECT
//    This single object drives the entire dashboard.
//    Replace contents with API responses later.
// ============================================================

const vehicleData = {
  // -- Vehicle identity --
  vehicleId: "VH-001",
  connectionStatus: "online",        // "online" | "offline"

  // -- Overall status --
  overallStatus: "NORMAL",           // "NORMAL" | "WARNING" | "CRITICAL"
  systemHealth: "All systems operational",
  lastUpdate: new Date().toISOString(),

  // -- Motion sensor data (from Motion Node / MPU6050) --
  motion: {
    accelX: 0.12,     // g
    accelY: -0.05,    // g
    accelZ: 9.78,     // g (gravity)
    accelMagnitude: 9.79,
    gyroX: 0.8,       // °/s
    gyroY: -0.3,      // °/s
    gyroZ: 0.1,       // °/s
  },

  // -- Collision detection --
  collision: {
    impactDetected: false,
    rolloverDetected: false,
    confidence: 2,                   // 0-100 %
    severity: "NONE",                // "NONE" | "LOW" | "MODERATE" | "HIGH" | "CRITICAL"
    state: "NORMAL",                 // "NORMAL" | "POSSIBLE IMPACT" | "COLLISION" | "CRITICAL ACCIDENT"
    timestamp: null,
  },

  // -- GPS / location (from Gateway Node) --
  gps: {
    latitude: 12.9716,
    longitude: 77.5946,
    status: "FIX ACQUIRED",          // "FIX ACQUIRED" | "NO FIX" | "SEARCHING"
    lastUpdate: new Date().toISOString(),
  },

  // -- Sensor node health --
  nodes: {
    motion: {
      name: "Motion Node",
      icon: "📐",
      status: "online",              // "online" | "offline"
      sensorStatus: "MPU6050 OK",
      lastHeartbeat: new Date().toISOString(),
    },
    impact: {
      name: "Impact Node",
      icon: "💥",
      status: "online",
      sensorStatus: "Impact Sensor OK",
      lastHeartbeat: new Date().toISOString(),
    },
    gateway: {
      name: "Gateway Node",
      icon: "📡",
      status: "online",
      sensorStatus: "GPS + Wi-Fi OK",
      lastHeartbeat: new Date().toISOString(),
    },
  },

  // -- Emergency alert --
  alert: {
    status: "NO ACTIVE ALERT",      // "NO ACTIVE ALERT" | "ALERT PENDING" | "EMERGENCY ALERT SENT"
    type: "—",
    time: null,
    sentTo: "—",
  },

  // -- Accident history --
  history: [
    { timestamp: "2026-09-29 11:45:12", vehicleId: "VH-001", event: "System Boot",       severity: "normal",   location: "12.9716, 77.5946", alertStatus: "None" },
    { timestamp: "2026-09-29 10:32:08", vehicleId: "VH-001", event: "Possible Impact",    severity: "warning",  location: "12.9720, 77.5950", alertStatus: "Pending" },
    { timestamp: "2026-09-28 18:15:44", vehicleId: "VH-001", event: "Normal Operation",   severity: "normal",   location: "12.9710, 77.5940", alertStatus: "None" },
    { timestamp: "2026-09-28 14:22:31", vehicleId: "VH-001", event: "Collision Detected", severity: "critical", location: "12.9725, 77.5955", alertStatus: "Sent" },
    { timestamp: "2026-09-28 09:05:17", vehicleId: "VH-001", event: "Rollover Warning",   severity: "warning",  location: "12.9718, 77.5948", alertStatus: "Pending" },
  ],
};

// ============================================================
// 2. ACCELERATION CHART DATA (rolling buffer for mini graphs)
// ============================================================

const CHART_POINTS = 60; // number of data points visible

const chartBuffers = {
  accelX: new Array(CHART_POINTS).fill(0),
  accelY: new Array(CHART_POINTS).fill(0),
  accelZ: new Array(CHART_POINTS).fill(9.8),
  magnitude: new Array(CHART_POINTS).fill(9.8),
};

// ============================================================
// 3. DATA FETCH FUNCTIONS
//    Replace these with real API calls later.
// ============================================================

/**
 * Fetch vehicle status from the backend.
 * FUTURE: return fetch('/api/vehicle/status').then(r => r.json());
 */
function fetchVehicleStatus() {
  return Promise.resolve({
    vehicleId:        vehicleData.vehicleId,
    connectionStatus: vehicleData.connectionStatus,
    overallStatus:    vehicleData.overallStatus,
    systemHealth:     vehicleData.systemHealth,
    lastUpdate:       vehicleData.lastUpdate,
  });
}

/**
 * Fetch sensor data from the backend.
 * FUTURE: return fetch('/api/vehicle/sensors').then(r => r.json());
 */
function fetchSensorData() {
  return Promise.resolve({ ...vehicleData.motion });
}

/**
 * Fetch GPS location from the backend.
 * FUTURE: return fetch('/api/vehicle/location').then(r => r.json());
 */
function fetchLocationData() {
  return Promise.resolve({ ...vehicleData.gps });
}

/**
 * Fetch accident history from the backend.
 * FUTURE: return fetch('/api/vehicle/history').then(r => r.json());
 */
function fetchHistoryData() {
  return Promise.resolve([...vehicleData.history]);
}

// ============================================================
// 4. THEME MANAGEMENT
//    Toggle dark/light mode and persist preference.
// ============================================================

function initTheme() {
  const saved = localStorage.getItem("vehicleguard-theme");
  if (saved === "light" || saved === "dark") {
    document.documentElement.setAttribute("data-theme", saved);
  }
  updateThemeToggle();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("vehicleguard-theme", next);
  updateThemeToggle();
}

function updateThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  btn.textContent = isDark ? "☀️" : "🌙";
  btn.title = isDark ? "Switch to light mode" : "Switch to dark mode";
}

// ============================================================
// 5. RENDERING FUNCTIONS
//    These read vehicleData and update the DOM.
//    DO NOT CHANGE these when connecting the ESP32 —
//    only change the fetch functions above.
// ============================================================

/** Format ISO date string for display */
function formatTime(isoStr) {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return d.toLocaleString("en-IN", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

/** Short time only */
function formatTimeShort(isoStr) {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Update the header clock */
function renderClock() {
  const el = document.getElementById("header-clock");
  if (el) {
    const now = new Date();
    el.textContent = now.toLocaleString("en-IN", {
      weekday: "short", year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  }
}

/** Render connection indicator */
function renderConnection() {
  const el = document.getElementById("connection-status");
  if (!el) return;
  const online = vehicleData.connectionStatus === "online";
  el.className = "connection-indicator " + (online ? "online" : "offline");
  el.innerHTML = `<span class="status-dot ${online ? "green" : "red"}"></span> ${online ? "CONNECTED" : "DISCONNECTED"}`;

  // Also update hero connection display
  const heroConn = document.getElementById("hero-connection");
  if (heroConn) {
    heroConn.innerHTML = `<span class="status-dot ${online ? "green" : "red"}"></span> ${online ? "ONLINE" : "OFFLINE"}`;
  }
}

/** Render the main vehicle status hero card */
function renderVehicleStatus() {
  const statusEl    = document.getElementById("vehicle-status-value");
  const subEl       = document.getElementById("vehicle-status-sub");
  const healthEl    = document.getElementById("vehicle-health");
  const lastUpdEl   = document.getElementById("vehicle-last-update");
  const vidEl       = document.getElementById("vehicle-id-display");
  const heroCard    = document.getElementById("vehicle-status-card");
  const heroBadge   = document.getElementById("hero-status-badge");
  const vehicleViz  = document.getElementById("vehicle-viz");

  if (!statusEl) return;

  const s = vehicleData.overallStatus;

  // Remove old border + vehicle animation classes
  heroCard.classList.remove("border-normal", "border-warning", "border-critical");
  if (vehicleViz) {
    vehicleViz.classList.remove("vehicle-normal", "vehicle-warning", "vehicle-critical");
  }

  // Status-dependent styling
  let dotColor = "green";
  let statusClass = "normal";

  if (s === "NORMAL") {
    heroCard.classList.add("border-normal");
    if (vehicleViz) vehicleViz.classList.add("vehicle-normal");
    dotColor = "green";
    statusClass = "normal";
  } else if (s === "WARNING") {
    heroCard.classList.add("border-warning");
    if (vehicleViz) vehicleViz.classList.add("vehicle-warning");
    dotColor = "yellow";
    statusClass = "warning";
  } else {
    heroCard.classList.add("border-critical");
    if (vehicleViz) vehicleViz.classList.add("vehicle-critical");
    dotColor = "red";
    statusClass = "critical";
  }

  statusEl.className = "hero-stat-value " + statusClass;
  statusEl.innerHTML = `<span class="status-dot ${dotColor}"></span> ${s}`;

  subEl.textContent    = vehicleData.systemHealth;
  healthEl.textContent = vehicleData.systemHealth;
  lastUpdEl.textContent = formatTime(vehicleData.lastUpdate);
  vidEl.textContent     = vehicleData.vehicleId;

  // Update hero badge
  if (heroBadge) {
    heroBadge.textContent = s;
    heroBadge.className = "badge badge-" + (s === "CRITICAL" ? "critical" : s === "WARNING" ? "warning" : "normal");
  }

  // Update node count in hero footer
  const nodeCount = document.getElementById("node-count-display");
  if (nodeCount) {
    const onlineCount = Object.values(vehicleData.nodes).filter(n => n.status === "online").length;
    const totalCount = Object.keys(vehicleData.nodes).length;
    nodeCount.textContent = `${onlineCount}/${totalCount} Online`;
  }
}

/** Render live motion sensor readings */
function renderMotionData() {
  const m = vehicleData.motion;
  setText("accel-x", m.accelX.toFixed(2));
  setText("accel-y", m.accelY.toFixed(2));
  setText("accel-z", m.accelZ.toFixed(2));
  setText("accel-mag", m.accelMagnitude.toFixed(2));
  setText("gyro-x", m.gyroX.toFixed(1));
  setText("gyro-y", m.gyroY.toFixed(1));
  setText("gyro-z", m.gyroZ.toFixed(1));
}

/** Render collision detection panel */
function renderCollision() {
  const c = vehicleData.collision;

  // Impact
  const impactEl = document.getElementById("impact-value");
  if (impactEl) {
    impactEl.textContent = c.impactDetected ? "DETECTED" : "NOT DETECTED";
    impactEl.className = "det-value " + (c.impactDetected ? "danger" : "safe");
  }

  // Rollover
  const rollEl = document.getElementById("rollover-value");
  if (rollEl) {
    rollEl.textContent = c.rolloverDetected ? "DETECTED" : "NOT DETECTED";
    rollEl.className = "det-value " + (c.rolloverDetected ? "danger" : "safe");
  }

  // Confidence
  const confEl = document.getElementById("confidence-value");
  if (confEl) {
    confEl.textContent = c.confidence + "%";
    confEl.className = "det-value " + (c.confidence > 70 ? "danger" : c.confidence > 30 ? "warning" : "safe");
  }

  // Severity
  const sevEl = document.getElementById("severity-value");
  if (sevEl) {
    sevEl.textContent = c.severity;
    const sevClass = c.severity === "CRITICAL" || c.severity === "HIGH" ? "danger"
                   : c.severity === "MODERATE" ? "warning"
                   : c.severity === "LOW" ? "info" : "safe";
    sevEl.className = "det-value " + sevClass;
  }

  // State
  const stateEl = document.getElementById("collision-state");
  if (stateEl) {
    stateEl.textContent = c.state;
    const stClass = c.state.includes("CRITICAL") ? "danger"
                  : c.state === "COLLISION" ? "danger"
                  : c.state.includes("IMPACT") ? "warning" : "safe";
    stateEl.className = "det-value " + stClass;
  }

  // Timestamp
  setText("collision-timestamp", c.timestamp ? formatTime(c.timestamp) : "—");
}

/** Render GPS panel */
function renderGPS() {
  const g = vehicleData.gps;
  setText("gps-lat", g.latitude.toFixed(6));
  setText("gps-lng", g.longitude.toFixed(6));
  setText("gps-status", g.status);
  setText("gps-update", formatTimeShort(g.lastUpdate));

  // Update "Open Location" link
  const link = document.getElementById("gps-open-link");
  if (link) {
    link.href = `https://www.google.com/maps?q=${g.latitude},${g.longitude}`;
  }
}

/** Render node health list */
function renderNodes() {
  const nodes = vehicleData.nodes;
  for (const key of Object.keys(nodes)) {
    const n = nodes[key];
    const statusEl = document.getElementById(`node-${key}-status`);
    const hbEl     = document.getElementById(`node-${key}-heartbeat`);
    const sensorEl = document.getElementById(`node-${key}-sensor`);

    if (statusEl) {
      const online = n.status === "online";
      statusEl.innerHTML = `<span class="status-dot ${online ? "green" : "red"}"></span> ${online ? "ONLINE" : "OFFLINE"}`;
      statusEl.className = "node-status " + (online ? "online" : "offline");
    }
    if (hbEl)     hbEl.textContent = formatTimeShort(n.lastHeartbeat);
    if (sensorEl) sensorEl.textContent = n.sensorStatus;
  }
}

/** Render emergency alert panel */
function renderAlert() {
  const a = vehicleData.alert;
  const box = document.getElementById("alert-status-box");
  const iconEl = document.getElementById("alert-icon");
  const textEl = document.getElementById("alert-text");
  const subEl  = document.getElementById("alert-sub");

  if (!box) return;

  box.classList.remove("no-alert", "pending", "sent");

  if (a.status === "EMERGENCY ALERT SENT") {
    box.classList.add("sent");
    iconEl.textContent = "🚨";
    textEl.textContent = "EMERGENCY ALERT SENT";
    subEl.textContent  = a.time ? formatTime(a.time) : "";
  } else if (a.status === "ALERT PENDING") {
    box.classList.add("pending");
    iconEl.textContent = "⚠️";
    textEl.textContent = "ALERT PENDING";
    subEl.textContent  = "Awaiting confirmation...";
  } else {
    box.classList.add("no-alert");
    iconEl.textContent = "✅";
    textEl.textContent = "NO ACTIVE ALERT";
    subEl.textContent  = "System monitoring";
  }

  setText("alert-type", a.type);
  setText("alert-time", a.time ? formatTime(a.time) : "—");
  setText("alert-sent-to", a.sentTo);
}

/** Render the accident history table */
function renderHistory() {
  const tbody = document.getElementById("history-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  vehicleData.history.forEach((row) => {
    const tr = document.createElement("tr");

    const severityBadge = row.severity === "critical" ? "badge-critical"
                        : row.severity === "warning"  ? "badge-warning"
                        : "badge-normal";

    const alertBadge = row.alertStatus === "Sent"    ? "badge-critical"
                     : row.alertStatus === "Pending" ? "badge-warning"
                     : "badge-normal";

    tr.innerHTML = `
      <td>${row.timestamp}</td>
      <td>${row.vehicleId}</td>
      <td>${row.event}</td>
      <td><span class="badge ${severityBadge}">${row.severity}</span></td>
      <td>${row.location}</td>
      <td><span class="badge ${alertBadge}">${row.alertStatus}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

/** Helper: set text content by ID */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ============================================================
// 6. MINI CHARTS (Canvas-based acceleration graphs)
// ============================================================

function pushChartData() {
  const m = vehicleData.motion;
  chartBuffers.accelX.push(m.accelX);
  chartBuffers.accelX.shift();
  chartBuffers.accelY.push(m.accelY);
  chartBuffers.accelY.shift();
  chartBuffers.accelZ.push(m.accelZ);
  chartBuffers.accelZ.shift();
  chartBuffers.magnitude.push(m.accelMagnitude);
  chartBuffers.magnitude.shift();
}

/** Get chart colours from CSS variables based on current theme */
function getChartColors() {
  const isDark = document.documentElement.getAttribute("data-theme") !== "light";
  return {
    gridLine:  isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)",
    zeroLine:  isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)",
  };
}

function drawChart(canvasId, data, color, minVal, maxVal) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const theme = getChartColors();

  ctx.clearRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = theme.gridLine;
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Zero line
  const zeroY = h - ((0 - minVal) / (maxVal - minVal)) * h;
  ctx.strokeStyle = theme.zeroLine;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  ctx.lineTo(w, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Data line
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.beginPath();

  const step = w / (data.length - 1);
  for (let i = 0; i < data.length; i++) {
    const x = i * step;
    const norm = (data[i] - minVal) / (maxVal - minVal);
    const y = h - norm * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Gradient fill below line
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, color.replace(")", ",0.12)").replace("rgb", "rgba"));
  gradient.addColorStop(1, color.replace(")", ",0.0)").replace("rgb", "rgba"));
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Current value dot
  const lastVal = data[data.length - 1];
  const lastNorm = (lastVal - minVal) / (maxVal - minVal);
  const dotY = h - lastNorm * h;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(w - 1, dotY, 3, 0, Math.PI * 2);
  ctx.fill();
}

function renderCharts() {
  drawChart("chart-accel-x",  chartBuffers.accelX,    "rgb(59,130,246)",  -3, 3);    // Blue
  drawChart("chart-accel-y",  chartBuffers.accelY,    "rgb(245,158,11)",  -3, 3);    // Amber
  drawChart("chart-accel-z",  chartBuffers.accelZ,    "rgb(16,185,129)",   5, 15);   // Green
  drawChart("chart-magnitude", chartBuffers.magnitude, "rgb(139,92,246)",   5, 20);  // Purple
}

// ============================================================
// 7. SIMULATION ENGINE (mock data variation)
// ============================================================

/** Add small random noise to simulate live sensor feed */
function simulateLiveNoise() {
  if (vehicleData.overallStatus === "NORMAL") {
    vehicleData.motion.accelX = +(0.1 + (Math.random() - 0.5) * 0.3).toFixed(3);
    vehicleData.motion.accelY = +(-0.05 + (Math.random() - 0.5) * 0.2).toFixed(3);
    vehicleData.motion.accelZ = +(9.78 + (Math.random() - 0.5) * 0.1).toFixed(3);
    vehicleData.motion.gyroX  = +(0.5 + (Math.random() - 0.5) * 1.0).toFixed(2);
    vehicleData.motion.gyroY  = +(-0.2 + (Math.random() - 0.5) * 0.8).toFixed(2);
    vehicleData.motion.gyroZ  = +(0.1 + (Math.random() - 0.5) * 0.5).toFixed(2);
  }

  // Always recalculate magnitude
  const m = vehicleData.motion;
  m.accelMagnitude = +Math.sqrt(m.accelX ** 2 + m.accelY ** 2 + m.accelZ ** 2).toFixed(3);

  // Update timestamps
  vehicleData.lastUpdate = new Date().toISOString();
  vehicleData.gps.lastUpdate = new Date().toISOString();

  // Update node heartbeats
  for (const key of Object.keys(vehicleData.nodes)) {
    if (vehicleData.nodes[key].status === "online") {
      vehicleData.nodes[key].lastHeartbeat = new Date().toISOString();
    }
  }
}

// ============================================================
// 8. DEMO / SIMULATION BUTTONS
// ============================================================

function simulateNormal() {
  vehicleData.overallStatus = "NORMAL";
  vehicleData.systemHealth  = "All systems operational";
  vehicleData.connectionStatus = "online";

  vehicleData.motion.accelX = 0.12;
  vehicleData.motion.accelY = -0.05;
  vehicleData.motion.accelZ = 9.78;
  vehicleData.motion.gyroX  = 0.8;
  vehicleData.motion.gyroY  = -0.3;
  vehicleData.motion.gyroZ  = 0.1;

  vehicleData.collision.impactDetected  = false;
  vehicleData.collision.rolloverDetected = false;
  vehicleData.collision.confidence = 2;
  vehicleData.collision.severity   = "NONE";
  vehicleData.collision.state      = "NORMAL";
  vehicleData.collision.timestamp  = null;

  vehicleData.alert.status = "NO ACTIVE ALERT";
  vehicleData.alert.type   = "—";
  vehicleData.alert.time   = null;
  vehicleData.alert.sentTo = "—";

  // Restore all nodes
  for (const key of Object.keys(vehicleData.nodes)) {
    vehicleData.nodes[key].status = "online";
    vehicleData.nodes[key].lastHeartbeat = new Date().toISOString();
    // Restore sensor status
    if (key === "motion")  vehicleData.nodes[key].sensorStatus = "MPU6050 OK";
    if (key === "impact")  vehicleData.nodes[key].sensorStatus = "Impact Sensor OK";
    if (key === "gateway") vehicleData.nodes[key].sensorStatus = "GPS + Wi-Fi OK";
  }

  renderAll();
}

function simulateBump() {
  vehicleData.overallStatus = "WARNING";
  vehicleData.systemHealth  = "Minor impact detected — monitoring";

  vehicleData.motion.accelX = +(2.5 + Math.random() * 1.5).toFixed(2);
  vehicleData.motion.accelY = +(1.2 + Math.random() * 0.8).toFixed(2);
  vehicleData.motion.accelZ = +(10.5 + Math.random() * 1.0).toFixed(2);
  vehicleData.motion.gyroX  = +(5 + Math.random() * 3).toFixed(1);
  vehicleData.motion.gyroY  = +(3 + Math.random() * 2).toFixed(1);
  vehicleData.motion.gyroZ  = +(2 + Math.random() * 1.5).toFixed(1);

  vehicleData.collision.impactDetected  = true;
  vehicleData.collision.rolloverDetected = false;
  vehicleData.collision.confidence = 35;
  vehicleData.collision.severity   = "LOW";
  vehicleData.collision.state      = "POSSIBLE IMPACT";
  vehicleData.collision.timestamp  = new Date().toISOString();

  vehicleData.alert.status = "ALERT PENDING";
  vehicleData.alert.type   = "Possible Impact";
  vehicleData.alert.time   = new Date().toISOString();
  vehicleData.alert.sentTo = "—";

  addHistoryEntry("Possible Impact", "warning", "Pending");
  renderAll();
}

function simulateCollision() {
  vehicleData.overallStatus = "CRITICAL";
  vehicleData.systemHealth  = "COLLISION DETECTED — Emergency protocol active";

  vehicleData.motion.accelX = +(8 + Math.random() * 4).toFixed(2);
  vehicleData.motion.accelY = +(6 + Math.random() * 3).toFixed(2);
  vehicleData.motion.accelZ = +(14 + Math.random() * 3).toFixed(2);
  vehicleData.motion.gyroX  = +(25 + Math.random() * 15).toFixed(1);
  vehicleData.motion.gyroY  = +(18 + Math.random() * 10).toFixed(1);
  vehicleData.motion.gyroZ  = +(12 + Math.random() * 8).toFixed(1);

  vehicleData.collision.impactDetected   = true;
  vehicleData.collision.rolloverDetected = false;
  vehicleData.collision.confidence = 85;
  vehicleData.collision.severity   = "HIGH";
  vehicleData.collision.state      = "COLLISION";
  vehicleData.collision.timestamp  = new Date().toISOString();

  vehicleData.alert.status = "EMERGENCY ALERT SENT";
  vehicleData.alert.type   = "Collision";
  vehicleData.alert.time   = new Date().toISOString();
  vehicleData.alert.sentTo = "Emergency Services";

  addHistoryEntry("Collision Detected", "critical", "Sent");
  renderAll();
}

function simulateRollover() {
  vehicleData.overallStatus = "CRITICAL";
  vehicleData.systemHealth  = "ROLLOVER DETECTED — Emergency protocol active";

  vehicleData.motion.accelX = +(1.5 + Math.random() * 2).toFixed(2);
  vehicleData.motion.accelY = +(7 + Math.random() * 3).toFixed(2);
  vehicleData.motion.accelZ = +(2 + Math.random() * 2).toFixed(2);
  vehicleData.motion.gyroX  = +(80 + Math.random() * 40).toFixed(1);
  vehicleData.motion.gyroY  = +(60 + Math.random() * 30).toFixed(1);
  vehicleData.motion.gyroZ  = +(40 + Math.random() * 20).toFixed(1);

  vehicleData.collision.impactDetected   = false;
  vehicleData.collision.rolloverDetected = true;
  vehicleData.collision.confidence = 92;
  vehicleData.collision.severity   = "HIGH";
  vehicleData.collision.state      = "CRITICAL ACCIDENT";
  vehicleData.collision.timestamp  = new Date().toISOString();

  vehicleData.alert.status = "EMERGENCY ALERT SENT";
  vehicleData.alert.type   = "Rollover";
  vehicleData.alert.time   = new Date().toISOString();
  vehicleData.alert.sentTo = "Emergency Services";

  addHistoryEntry("Rollover Detected", "critical", "Sent");
  renderAll();
}

function simulateCriticalAccident() {
  vehicleData.overallStatus = "CRITICAL";
  vehicleData.systemHealth  = "CRITICAL ACCIDENT — All emergency protocols activated";

  vehicleData.motion.accelX = +(12 + Math.random() * 5).toFixed(2);
  vehicleData.motion.accelY = +(10 + Math.random() * 4).toFixed(2);
  vehicleData.motion.accelZ = +(3 + Math.random() * 3).toFixed(2);
  vehicleData.motion.gyroX  = +(120 + Math.random() * 50).toFixed(1);
  vehicleData.motion.gyroY  = +(90 + Math.random() * 40).toFixed(1);
  vehicleData.motion.gyroZ  = +(70 + Math.random() * 30).toFixed(1);

  vehicleData.collision.impactDetected   = true;
  vehicleData.collision.rolloverDetected = true;
  vehicleData.collision.confidence = 98;
  vehicleData.collision.severity   = "CRITICAL";
  vehicleData.collision.state      = "CRITICAL ACCIDENT";
  vehicleData.collision.timestamp  = new Date().toISOString();

  vehicleData.alert.status = "EMERGENCY ALERT SENT";
  vehicleData.alert.type   = "Critical Accident (Impact + Rollover)";
  vehicleData.alert.time   = new Date().toISOString();
  vehicleData.alert.sentTo = "Emergency Services + Hospital";

  addHistoryEntry("Critical Accident", "critical", "Sent");
  renderAll();
}

function simulateNodeFailure() {
  vehicleData.overallStatus = "WARNING";
  vehicleData.systemHealth  = "Node communication failure detected";

  // Randomly take a node offline
  const keys = Object.keys(vehicleData.nodes);
  const failKey = keys[Math.floor(Math.random() * keys.length)];
  vehicleData.nodes[failKey].status = "offline";
  vehicleData.nodes[failKey].sensorStatus = "NO RESPONSE";

  addHistoryEntry(`${vehicleData.nodes[failKey].name} Offline`, "warning", "Pending");
  renderAll();
}

/** Add an event to the history log */
function addHistoryEntry(event, severity, alertStatus) {
  const now = new Date();
  const ts  = now.toISOString().replace("T", " ").substring(0, 19);

  vehicleData.history.unshift({
    timestamp:   ts,
    vehicleId:   vehicleData.vehicleId,
    event:       event,
    severity:    severity,
    location:    `${vehicleData.gps.latitude.toFixed(4)}, ${vehicleData.gps.longitude.toFixed(4)}`,
    alertStatus: alertStatus,
  });

  // Keep history at a reasonable length
  if (vehicleData.history.length > 50) {
    vehicleData.history.pop();
  }
}

// ============================================================
// 9. MASTER RENDER
// ============================================================

function renderAll() {
  renderClock();
  renderConnection();
  renderVehicleStatus();
  renderMotionData();
  renderCollision();
  renderGPS();
  renderNodes();
  renderAlert();
  renderHistory();
  pushChartData();
  renderCharts();
}

// ============================================================
// 10. INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", () => {
  // Initialize theme from localStorage
  initTheme();

  // Initial render
  renderAll();

  // Live update loop — simulates incoming sensor data every 1 second
  setInterval(() => {
    simulateLiveNoise();
    renderAll();
  }, 1000);

  // Bind theme toggle
  document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);

  // Bind demo buttons
  document.getElementById("btn-sim-normal")?.addEventListener("click", simulateNormal);
  document.getElementById("btn-sim-bump")?.addEventListener("click", simulateBump);
  document.getElementById("btn-sim-collision")?.addEventListener("click", simulateCollision);
  document.getElementById("btn-sim-rollover")?.addEventListener("click", simulateRollover);
  document.getElementById("btn-sim-critical")?.addEventListener("click", simulateCriticalAccident);
  document.getElementById("btn-sim-node-fail")?.addEventListener("click", simulateNodeFailure);

  // ── Start cloud event polling ──
  startCloudPolling();
});
