
#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <math.h>

// =====================================================
// SAFERIDE - ESP32 #1 SENSOR NODE + MOTOR CONTROLLER
// =====================================================

// ---------------- WIFI CONFIGURATION ----------------

const char* AP_SSID = "CollisionNet";
const char* AP_PASSWORD = "Saferide123";

const char* HOTSPOT_SSID = "Munchkin";
const char* HOTSPOT_PASSWORD = "vainu12345";

// ---------------- CLOUD CONFIGURATION ----------------

const char* API_URL =
  "https://iot-collision-detection.onrender.com/api/events";
// Cloud health endpoint — separate from collision uploads
const char* CLOUD_HEALTH_URL =
  "https://iot-collision-detection.onrender.com/health";

// Set when ESP32 #2 requests a cloud health check
portMUX_TYPE healthMux = portMUX_INITIALIZER_UNLOCKED;
bool cloudHealthCheckRequested = false;
// Generate a new key if the previous key was exposed.
const char* API_KEY = "5ecd4d1928d83ba7eade55bb763e71cdfb3a2efb9e4024c2f23e852d284bfb53";
// ---------------- EMERGENCY CONTACT ------------------

// Include country code, e.g. +91XXXXXXXXXX.
const char* EMERGENCY_PHONE = "+919380056982";

// ---------------- SENSOR PINS -----------------------

const int SDA_PIN = 21;
const int SCL_PIN = 22;
const int VIBRATION_PIN = 18;
const uint8_t ADXL_ADDR = 0x53;

// ---------------- MOTOR PINS -------------------------

const int IN1 = 26;
const int IN2 = 27;
const int IN3 = 14;
const int IN4 = 13;

// ---------------- SIM800L UART -----------------------

// ESP32 RX receives SIM800L TXD.
// ESP32 TX transmits to SIM800L RXD.
const int GSM_RX_PIN = 32;
const int GSM_TX_PIN = 33;

HardwareSerial GSMSerial(1);

// ---------------- COMMUNICATION ----------------------

WiFiServer sensorServer(3333);
WiFiClient gatewayClient;
WebServer webServer(80);

SemaphoreHandle_t gatewayMutex = nullptr;
QueueHandle_t collisionQueue = nullptr;

// ---------------- COLLISION SETTINGS -----------------

const int IMPACT_DELTA_THRESHOLD = 200;
const int VIBRATION_DELTA_THRESHOLD = 70;

const unsigned long EVENT_COOLDOWN_MS = 3000;
const unsigned long SAMPLE_INTERVAL_MS = 50;
const unsigned long COMMAND_TIMEOUT_MS = 800;
const unsigned long GPS_FRESH_MS = 15000;

int16_t prevX = 0;
int16_t prevY = 0;
int16_t prevZ = 0;

bool havePrevious = false;
bool adxlReady = false;

unsigned long lastSample = 0;
unsigned long lastEvent = 0;
unsigned long lastTelemetryPrint = 0;
unsigned long lastMotionCommand = 0;
unsigned long lastHotspotAttempt = 0;

char currentMotion = 'S';

float latestLat = 0.0f;
float latestLon = 0.0f;
bool latestGpsValid = false;
unsigned long latestGpsAt = 0;

String gatewayLine;
void sendLineToGateway(const String &line);
// ---------------- COLLISION QUEUE DATA ---------------

struct CollisionEvent {
  int16_t x;
  int16_t y;
  int16_t z;

  int vibration;
  int delta;

  float latitude;
  float longitude;
  bool gpsValid;
};
// =====================================================
// CLOUD HEALTH CHECK
// =====================================================

bool checkCloudHealth() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cloud heartbeat failed: no internet.");
    return false;
  }

  WiFiClientSecure secureClient;

  // Prototype only; production should validate the certificate.
  secureClient.setInsecure();

  HTTPClient https;
  https.setConnectTimeout(4000);
  https.setTimeout(4000);

  if (!https.begin(secureClient, CLOUD_HEALTH_URL)) {
    Serial.println("Cloud heartbeat: HTTPS begin failed.");
    return false;
  }

  int code = https.GET();
  String response = https.getString();

  https.end();

  Serial.printf("Cloud health HTTP status: %d\n", code);

  if (response.length()) {
    Serial.println("Health response: " + response);
  }

  return code >= 200 && code < 300;
}
// =====================================================
// CLOUD HEALTH MONITOR TASK
// =====================================================

void cloudHealthTask(void *parameter) {
  for (;;) {
  bool runHealthCheck;

  portENTER_CRITICAL(&healthMux);
  runHealthCheck = cloudHealthCheckRequested;
  cloudHealthCheckRequested = false;
  portEXIT_CRITICAL(&healthMux);

  if (runHealthCheck) {
    Serial.println("Checking Render cloud health...");

    if (checkCloudHealth()) {
      sendLineToGateway("STATUS,CLOUD_HEARTBEAT_OK");
    } else {
      sendLineToGateway("STATUS,CLOUD_HEARTBEAT_FAILED");
    }
  }

  vTaskDelay(pdMS_TO_TICKS(100));
}
}
volatile unsigned long cloudSuccessCount = 0;
volatile unsigned long cloudFailureCount = 0;
volatile unsigned long smsSuccessCount = 0;
volatile unsigned long smsFailureCount = 0;

// =====================================================
// MOTOR CONTROL
// =====================================================

void stopMotors() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, LOW);

  currentMotion = 'S';
}

void driveForward() {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);

  currentMotion = 'F';
}

void driveReverse() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);

  currentMotion = 'B';
}

void turnLeft() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  digitalWrite(IN3, HIGH);
  digitalWrite(IN4, LOW);

  currentMotion = 'L';
}

void turnRight() {
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  digitalWrite(IN3, LOW);
  digitalWrite(IN4, HIGH);

  currentMotion = 'R';
}

// =====================================================
// WEB MOTOR CONTROL
// =====================================================

void handleCommand() {
  if (!webServer.hasArg("m") ||
      webServer.arg("m").length() == 0) {
    webServer.send(400, "text/plain", "Missing command");
    return;
  }

  char cmd = webServer.arg("m").charAt(0);

  switch (cmd) {
    case 'F':
      driveForward();
      break;

    case 'B':
      driveReverse();
      break;

    case 'L':
      turnLeft();
      break;

    case 'R':
      turnRight();
      break;

    case 'S':
      stopMotors();
      break;

    default:
      stopMotors();
      webServer.send(400, "text/plain", "Invalid command");
      return;
  }

  lastMotionCommand = millis();
  webServer.send(200, "text/plain", "OK");
}

const char PAGE[] PROGMEM = R"HTML(
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SafeRide Control</title>

<style>
body {
  font-family: Arial, sans-serif;
  text-align: center;
  background: #101827;
  color: white;
  margin: 0;
  padding: 20px;
}

h1 { margin-bottom: 5px; }

.panel {
  max-width: 380px;
  margin: 20px auto;
  padding: 20px;
  background: #1e293b;
  border-radius: 18px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

button {
  height: 75px;
  border: 0;
  border-radius: 14px;
  font-size: 17px;
  font-weight: bold;
  background: #38bdf8;
  color: #082f49;
  touch-action: none;
  user-select: none;
}

.stop {
  background: #fb7185;
  color: #4c0519;
}

small { color: #cbd5e1; }
</style>
</head>

<body>
<h1>SafeRide</h1>
<p>Local Wi-Fi motor control</p>

<div class="panel">
  <div class="grid">
    <div></div>
    <button data-cmd="F">FORWARD ▲</button>
    <div></div>

    <button data-cmd="L">LEFT ◀</button>
    <button class="stop" data-cmd="S">STOP</button>
    <button data-cmd="R">RIGHT ▶</button>

    <div></div>
    <button data-cmd="B">REVERSE ▼</button>
    <div></div>
  </div>

  <p id="status">Connecting...</p>
  <small>Release a direction button to stop.</small>
</div>

<script>
let active = null;
let timer = null;
let busy = false;
let pendingStop = false;
let requestController = null;

const statusEl = document.getElementById('status');

async function sendCommand(cmd) {
  if (cmd === 'S') {
    pendingStop = true;

    // Abort an outstanding browser request so STOP can be sent.
    if (requestController) {
      requestController.abort();
    }
  }

  if (busy && cmd !== 'S') return;

  busy = true;
  pendingStop = false;

  const controller = new AbortController();
  requestController = controller;

  try {
    const r = await fetch('/cmd?m=' + cmd + '&t=' + Date.now(), {
      cache: 'no-store',
      signal: controller.signal
    });

    statusEl.textContent = r.ok
      ? (cmd === 'S' ? 'Car stopped' : 'Car connected')
      : 'Command failed';

  } catch (e) {
    if (e.name !== 'AbortError') {
      statusEl.textContent = 'Connection lost';
    }
  } finally {
    if (requestController === controller) {
      requestController = null;
    }

    busy = false;

    if (pendingStop) {
      pendingStop = false;
      sendCommand('S');
    }
  }
}

function start(cmd) {
  clearInterval(timer);
  active = cmd;

  if (cmd === 'S') {
    stop();
    return;
  }

  sendCommand(cmd);

  // Repeat while held, helping maintain control.
  timer = setInterval(() => {
    if (active === cmd && !busy) {
      sendCommand(cmd);
    }
  }, 250);
}

function stop() {
  active = null;
  clearInterval(timer);
  sendCommand('S');
}

document.querySelectorAll('button[data-cmd]').forEach(btn => {
  const cmd = btn.dataset.cmd;

  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    start(cmd);
  });

  btn.addEventListener('pointerup', e => {
    e.preventDefault();
    stop();
  });

  btn.addEventListener('pointercancel', stop);

  btn.addEventListener('lostpointercapture', stop);

  btn.addEventListener('pointerleave', () => {
    if (active === cmd) stop();
  });
});

window.addEventListener('blur', stop);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
});

sendCommand('S');
</script>
</body>
</html>
)HTML";

// =====================================================
// ADXL345
// =====================================================

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(ADXL_ADDR);
  Wire.write(reg);
  Wire.write(value);

  return Wire.endTransmission() == 0;
}

bool readAxisData(int16_t &x, int16_t &y, int16_t &z) {
  Wire.beginTransmission(ADXL_ADDR);
  Wire.write(0x32);

  if (Wire.endTransmission(false) != 0) {
    return false;
  }

  if (Wire.requestFrom(ADXL_ADDR, (uint8_t)6) != 6) {
    return false;
  }

  uint8_t xl = Wire.read();
  uint8_t xh = Wire.read();
  uint8_t yl = Wire.read();
  uint8_t yh = Wire.read();
  uint8_t zl = Wire.read();
  uint8_t zh = Wire.read();

  x = (int16_t)((xh << 8) | xl);
  y = (int16_t)((yh << 8) | yl);
  z = (int16_t)((zh << 8) | zl);

  return true;
}

// =====================================================
// ESP32 #2 TCP COMMUNICATION
// =====================================================

void sendLineToGateway(const String &line) {
  Serial.println(line);

  if (gatewayMutex == nullptr) return;

  if (xSemaphoreTake(gatewayMutex, pdMS_TO_TICKS(100)) == pdTRUE) {
    if (gatewayClient && gatewayClient.connected()) {
      gatewayClient.println(line);
    }

    xSemaphoreGive(gatewayMutex);
  }
}

void processGatewayLine(String line) {
  line.trim();

  // ESP32 #2 requested a cloud health check
  if (line == "HEALTH_CHECK") {
  portENTER_CRITICAL(&healthMux);
  cloudHealthCheckRequested = true;
  portEXIT_CRITICAL(&healthMux);
  return;
}

  if (!line.startsWith("GPS,")) return;

  int validPos = line.indexOf("VALID=");
  int latPos = line.indexOf("LAT=");
  int lonPos = line.indexOf("LON=");

  if (validPos < 0 || latPos < 0 || lonPos < 0) return;

  int validEnd = line.indexOf(',', validPos);

  String validText = validEnd >= 0
    ? line.substring(validPos + 6, validEnd)
    : line.substring(validPos + 6);

  int latEnd = line.indexOf(',', latPos);
  String latText = latEnd >= 0
    ? line.substring(latPos + 4, latEnd)
    : line.substring(latPos + 4);

  int lonEnd = line.indexOf(',', lonPos);
  String lonText = lonEnd >= 0
    ? line.substring(lonPos + 4, lonEnd)
    : line.substring(lonPos + 4);

  latestGpsValid = (validText == "1");
  latestLat = latText.toFloat();
  latestLon = lonText.toFloat();
  latestGpsAt = millis();
}

void acceptGateway() {
  if (gatewayMutex == nullptr) return;

  if (xSemaphoreTake(gatewayMutex, 0) != pdTRUE) return;

  if (!gatewayClient || !gatewayClient.connected()) {
    WiFiClient incoming = sensorServer.available();

    if (incoming) {
      gatewayClient.stop();
      gatewayClient = incoming;
      gatewayClient.setNoDelay(true);

      Serial.println("ESP32 #2 connected over TCP.");
      gatewayClient.println("STATUS,ESP32_1_READY");
    }
  }

  while (gatewayClient &&
         gatewayClient.connected() &&
         gatewayClient.available()) {
    char c = (char)gatewayClient.read();

    if (c == '\n') {
      String line = gatewayLine;
      gatewayLine = "";

      xSemaphoreGive(gatewayMutex);
      processGatewayLine(line);

      if (xSemaphoreTake(gatewayMutex, 0) != pdTRUE) {
        return;
      }
    } else if (c != '\r') {
      if (gatewayLine.length() < 220) {
        gatewayLine += c;
      } else {
        gatewayLine = "";
      }
    }
  }

  xSemaphoreGive(gatewayMutex);
}

// =====================================================
// SIM800L DIAGNOSTICS AND SMS
// =====================================================

bool gsmCommand(
  const String &command,
  const char* expected,
  unsigned long timeoutMs
) {
  while (GSMSerial.available()) {
    GSMSerial.read();
  }

  GSMSerial.println(command);

  unsigned long started = millis();
  String response;

  while (millis() - started < timeoutMs) {
    while (GSMSerial.available()) {
      response += (char)GSMSerial.read();

      if (response.indexOf(expected) >= 0) {
        Serial.println("GSM response: " + response);
        return true;
      }

      if (response.indexOf("ERROR") >= 0) {
        Serial.println("GSM modem error: " + response);
        return false;
      }
    }

    vTaskDelay(pdMS_TO_TICKS(2));
  }

  Serial.println("GSM timeout for command: " + command);

  if (response.length()) {
    Serial.println("GSM received: " + response);
  }

  return false;
}

bool sendSMS(const String &message) {
  String phone = String(EMERGENCY_PHONE);
  phone.trim();

  if (phone.length() < 8 ||
      phone.indexOf("REPLACE_") >= 0) {
    Serial.println("SMS skipped: configure EMERGENCY_PHONE.");
    return false;
  }

  // Diagnose modem response before trying to send an SMS.
  if (!gsmCommand("AT", "OK", 2500)) {
    Serial.println("Check SIM800L power, ground and UART wiring.");
    return false;
  }

  gsmCommand("ATE0", "OK", 1500);

  if (!gsmCommand("AT+CPIN?", "OK", 2500)) {
    Serial.println("SIM readiness check failed.");
    return false;
  }

  if (!gsmCommand("AT+CREG?", "OK", 2500)) {
    Serial.println("Network registration query failed.");
    return false;
  }

  if (!gsmCommand("AT+CMGF=1", "OK", 2500)) {
    Serial.println("Could not enable SMS text mode.");
    return false;
  }

  while (GSMSerial.available()) GSMSerial.read();

  GSMSerial.print("AT+CMGS=\"");
  GSMSerial.print(phone);
  GSMSerial.println("\"");

  unsigned long started = millis();
  String response;
  bool promptReceived = false;

  while (millis() - started < 7000) {
    while (GSMSerial.available()) {
      char c = (char)GSMSerial.read();
      response += c;

      if (c == '>') {
        promptReceived = true;
        break;
      }

      if (response.indexOf("ERROR") >= 0) {
        Serial.println("SMS command rejected: " + response);
        return false;
      }
    }

    if (promptReceived) break;

    vTaskDelay(pdMS_TO_TICKS(2));
  }

  if (!promptReceived) {
    Serial.println("SMS failed: no message-entry prompt.");
    Serial.println(response);
    return false;
  }

  GSMSerial.print(message);
  GSMSerial.write(26); // Ctrl+Z submits the message.

  started = millis();
  response = "";

  while (millis() - started < 25000) {
    while (GSMSerial.available()) {
      response += (char)GSMSerial.read();

      if (response.indexOf("+CMGS:") >= 0) {
        Serial.println("SMS accepted by modem: " + response);
        return true;
      }

      if (response.indexOf("ERROR") >= 0) {
        Serial.println("SMS sending error: " + response);
        return false;
      }
    }

    vTaskDelay(pdMS_TO_TICKS(5));
  }

  Serial.println("SMS result unknown: " + response);
  return false;
}

// =====================================================
// CLOUD EVENT UPLOAD
// =====================================================

bool uploadCollisionEvent(const CollisionEvent &event) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Cloud upload failed: hotspot not connected.");
    return false;
  }

  String key = String(API_KEY);

  if (key.length() < 8 ||
      key.indexOf("REPLACE_") >= 0) {
    Serial.println("Cloud upload skipped: configure API_KEY.");
    return false;
  }

  WiFiClientSecure secureClient;

  // Prototype only. For production, validate the server certificate.
  secureClient.setInsecure();

  HTTPClient https;
  https.setConnectTimeout(4000);
  https.setTimeout(5000);

  if (!https.begin(secureClient, API_URL)) {
    Serial.println("Cloud HTTPS begin failed.");
    return false;
  }

  https.addHeader("Content-Type", "application/json");
  https.addHeader("X-API-Key", API_KEY);

  String body = "{\"event_type\":\"POSSIBLE_COLLISION\",\"latitude\":";

  body += event.gpsValid
    ? String(event.latitude, 6)
    : "null";

  body += ",\"longitude\":";

  body += event.gpsValid
    ? String(event.longitude, 6)
    : "null";

  body += ",\"x\":" + String(event.x);
  body += ",\"y\":" + String(event.y);
  body += ",\"z\":" + String(event.z);
  body += ",\"vibration\":" + String(event.vibration);
  body += ",\"delta\":" + String(event.delta);
  body += "}";

  int code = https.POST(body);
  String response = https.getString();

  https.end();

  Serial.printf("Cloud HTTP status: %d\n", code);

  if (response.length()) {
    Serial.println(response);
  }

  return code >= 200 && code < 300;
}

// =====================================================
// BACKGROUND COLLISION RESPONSE TASK
// =====================================================

// This task performs slow GSM and HTTPS operations away
// from the main motor-control loop.
void collisionWorker(void *parameter) {
  CollisionEvent event;

  for (;;) {
    if (xQueueReceive(
          collisionQueue,
          &event,
          portMAX_DELAY
        ) != pdTRUE) {
      continue;
    }

    String sms = "SafeRide ALERT: possible vehicle collision detected.";

    if (event.gpsValid) {
      sms += " Location: https://maps.google.com/?q=";
      sms += String(event.latitude, 6);
      sms += ",";
      sms += String(event.longitude, 6);
    } else {
      sms += " GPS location is currently unavailable.";
    }

    Serial.println("Sending emergency SMS...");

    if (sendSMS(sms)) {
      smsSuccessCount++;
      sendLineToGateway("STATUS,SMS_SUBMITTED");
    } else {
      smsFailureCount++;
      sendLineToGateway("STATUS,SMS_FAILED_CHECK_MODEM");
    }

    Serial.println("Uploading collision to cloud...");

    if (uploadCollisionEvent(event)) {
      cloudSuccessCount++;
      sendLineToGateway("STATUS,CLOUD_UPLOAD_OK");
    } else {
      cloudFailureCount++;
      sendLineToGateway("STATUS,CLOUD_UPLOAD_FAILED");
    }

    Serial.printf(
      "Totals: SMS success=%lu fail=%lu; Cloud success=%lu fail=%lu\n",
      (unsigned long)smsSuccessCount,
      (unsigned long)smsFailureCount,
      (unsigned long)cloudSuccessCount,
      (unsigned long)cloudFailureCount
    );
  }
}

// =====================================================
// COLLISION DETECTION
// =====================================================

void handleCollision(
  int16_t x,
  int16_t y,
  int16_t z,
  int vibration,
  int delta
) {
  String line =
    "EVENT,POSSIBLE_COLLISION,X=" + String(x) +
    ",Y=" + String(y) +
    ",Z=" + String(z) +
    ",VIB=" + String(vibration) +
    ",DELTA=" + String(delta);

  sendLineToGateway(line);

  CollisionEvent event;

  event.x = x;
  event.y = y;
  event.z = z;
  event.vibration = vibration;
  event.delta = delta;

  event.gpsValid =
    latestGpsValid &&
    (millis() - latestGpsAt < GPS_FRESH_MS);

  event.latitude = latestLat;
  event.longitude = latestLon;

  // Never wait for SMS/cloud operations here.
  if (xQueueSend(collisionQueue, &event, 0) != pdTRUE) {
    Serial.println("WARNING: Collision queue full; event not queued.");
    sendLineToGateway("STATUS,COLLISION_QUEUE_FULL");
  } else {
    Serial.println("Collision queued for background processing.");
  }
}

// =====================================================
// SETUP
// =====================================================

void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);

  stopMotors();

  pinMode(VIBRATION_PIN, INPUT);
  Wire.begin(SDA_PIN, SCL_PIN);

  Wire.beginTransmission(ADXL_ADDR);
  adxlReady = (Wire.endTransmission() == 0);

  if (adxlReady) {
    adxlReady =
      writeRegister(0x2C, 0x0A) &&
      writeRegister(0x31, 0x08) &&
      writeRegister(0x2D, 0x08);
  }

  Serial.println(
    adxlReady
      ? "ADXL345 ready."
      : "WARNING: ADXL345 not detected."
  );

  GSMSerial.begin(
    9600,
    SERIAL_8N1,
    GSM_RX_PIN,
    GSM_TX_PIN
  );

  Serial.println("SIM800L UART initialized.");

  gatewayMutex = xSemaphoreCreateMutex();

  collisionQueue = xQueueCreate(
    5,
    sizeof(CollisionEvent)
  );

  if (gatewayMutex == nullptr || collisionQueue == nullptr) {
    Serial.println("FATAL: Failed to create RTOS resources.");
    stopMotors();

    while (true) {
      delay(1000);
    }
  }

  BaseType_t taskResult = xTaskCreate(
    collisionWorker,
    "CollisionWorker",
    8192,
    nullptr,
    1,
    nullptr
  );

  if (taskResult != pdPASS) {
    Serial.println("FATAL: Could not start collision worker.");
    stopMotors();

    while (true) {
      delay(1000);
    }
  }
BaseType_t healthTaskResult = xTaskCreate(
  cloudHealthTask,
  "CloudHealth",
  6144,
  nullptr,
  1,
  nullptr
);

if (healthTaskResult != pdPASS) {
  Serial.println("WARNING: Cloud health task failed to start.");
}
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(false);

  bool apOk = WiFi.softAP(AP_SSID, AP_PASSWORD);

  Serial.println(
    apOk
      ? "CollisionNet AP started."
      : "ERROR: AP failed."
  );

  Serial.print("CollisionNet IP: ");
  Serial.println(WiFi.softAPIP());

  sensorServer.begin();
  sensorServer.setNoDelay(true);

  webServer.on("/", HTTP_GET, []() {
    webServer.send_P(200, "text/html", PAGE);
  });

  webServer.on("/cmd", HTTP_GET, handleCommand);

  webServer.on("/health", HTTP_GET, []() {
    String json = "{\"status\":\"ok\",\"adxl345\":";
    json += adxlReady ? "true" : "false";
    json += ",\"internet\":";
    json += WiFi.status() == WL_CONNECTED ? "true" : "false";
    json += ",\"motion\":\"";
    json += currentMotion;
    json += "\"}";

    webServer.send(200, "application/json", json);
  });

  webServer.onNotFound([]() {
    webServer.send(404, "text/plain", "Not found");
  });

  webServer.begin();

  Serial.println("SafeRide ESP32 #1 ready.");
  Serial.println("Motors are STOPPED.");
  Serial.println("Join CollisionNet and open http://192.168.4.1");
  Serial.println("ESP32 #2 TCP port: 3333");

  if (String(HOTSPOT_SSID).length() > 0 &&
      String(HOTSPOT_SSID).indexOf("REPLACE_") < 0) {
    WiFi.begin(HOTSPOT_SSID, HOTSPOT_PASSWORD);
    lastHotspotAttempt = millis();
    Serial.println("Connecting to phone hotspot...");
  } else {
    Serial.println("Configure hotspot credentials for cloud uploads.");
  }
}

// =====================================================
// MAIN LOOP
// =====================================================

void loop() {
  // Keep local control requests serviced frequently.
  webServer.handleClient();

  acceptGateway();

  // Fallback stop if repeated movement commands disappear.
  if (currentMotion != 'S' &&
      millis() - lastMotionCommand > COMMAND_TIMEOUT_MS) {
    stopMotors();
    Serial.println("Safety timeout: motors stopped.");
  }

  // Reconnect to phone hotspot when disconnected.
  if (String(HOTSPOT_SSID).length() > 0 &&
      String(HOTSPOT_SSID).indexOf("REPLACE_") < 0 &&
      WiFi.status() != WL_CONNECTED &&
      millis() - lastHotspotAttempt > 15000) {
    lastHotspotAttempt = millis();
    WiFi.begin(HOTSPOT_SSID, HOTSPOT_PASSWORD);
  }

  // Periodic sensor sampling.
  if (millis() - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = millis();

    if (adxlReady) {
      int16_t x, y, z;

      if (readAxisData(x, y, z)) {
        int vibration = digitalRead(VIBRATION_PIN);
        int delta = 0;

        if (havePrevious) {
          float dx = (float)x - prevX;
          float dy = (float)y - prevY;
          float dz = (float)z - prevZ;

          delta = (int)sqrtf(
            dx * dx + dy * dy + dz * dz
          );
        }

        prevX = x;
        prevY = y;
        prevZ = z;
        havePrevious = true;

        String data =
          "DATA,X=" + String(x) +
          ",Y=" + String(y) +
          ",Z=" + String(z) +
          ",VIB=" + String(vibration) +
          ",DELTA=" + String(delta);

        if (millis() - lastTelemetryPrint >= 1000) {
          lastTelemetryPrint = millis();
          sendLineToGateway(data);
        }

        bool sharpChange =
          delta >= IMPACT_DELTA_THRESHOLD;

        bool vibrationWithChange =
          vibration == HIGH &&
          delta >= VIBRATION_DELTA_THRESHOLD;

        if ((sharpChange || vibrationWithChange) &&
            (lastEvent == 0 ||
             millis() - lastEvent >= EVENT_COOLDOWN_MS)) {
          lastEvent = millis();

          handleCollision(
            x,
            y,
            z,
            vibration,
            delta
          );
        }
      } else {
        Serial.println("ERROR: Failed to read ADXL345.");
        havePrevious = false;
      }
    }
  }

  delay(1);
}
