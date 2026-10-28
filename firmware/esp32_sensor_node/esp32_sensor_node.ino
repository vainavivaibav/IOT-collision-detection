#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <math.h>

#include "secrets.h"

const char* API_BASE_URL = "https://iot-collision-detection.onrender.com";
const char* API_KEY = SAFERIDE_DEVICE_API_KEY;
const char* EMERGENCY_PHONE = SAFERIDE_EMERGENCY_PHONE;

const int SDA_PIN = 21;
const int SCL_PIN = 22;
const int VIBRATION_PIN = 18;
const byte ADXL_ADDR = 0x53;

const int IN1 = 26;
const int IN2 = 27;
const int IN3 = 14;
const int IN4 = 13;

const int GSM_RX_PIN = 32;
const int GSM_TX_PIN = 33;
HardwareSerial GSMSerial(1);

WiFiServer sensorServer(3333);
WiFiClient gatewayClient;
WebServer webServer(80);

const int IMPACT_DELTA_THRESHOLD = 200;
const int VIBRATION_DELTA_THRESHOLD = 70;
const unsigned long EVENT_COOLDOWN_MS = 3000;
const unsigned long SAMPLE_INTERVAL_MS = 50;
const unsigned long COMMAND_TIMEOUT_MS = 800;
const unsigned long HEARTBEAT_INTERVAL_MS = 10000;
const unsigned long GATEWAY_FRESH_MS = 15000;
portMUX_TYPE telemetryMux = portMUX_INITIALIZER_UNLOCKED;

int16_t prevX = 0, prevY = 0, prevZ = 0;
int16_t latestX = 0, latestY = 0, latestZ = 0;
int latestDelta = 0;
int latestVibration = 0;
bool havePrevious = false;
bool adxlReady = false;
bool lastAdxlReadOk = false;
bool haveValidAdxlSample = false;
bool adxlReadAttempted = false;
bool gatewayTcpConnected = false;

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

void handleCommand() {
  if (!webServer.hasArg("m") || webServer.arg("m").length() == 0) {
    webServer.send(400, "text/plain", "Missing command");
    return;
  }

  char cmd = webServer.arg("m").charAt(0);
  switch (cmd) {
    case 'F': driveForward(); break;
    case 'B': driveReverse(); break;
    case 'L': turnLeft(); break;
    case 'R': turnRight(); break;
    case 'S': stopMotors(); break;
    default:
      stopMotors();
      webServer.send(400, "text/plain", "Invalid command");
      return;
  }

  lastMotionCommand = millis();
  webServer.send(200, "text/plain", "OK");
}

const char PAGE[] PROGMEM = R"HTML(
<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SafeRide Control</title>
<style>
body{font-family:Arial,sans-serif;text-align:center;background:#101827;color:white;margin:0;padding:20px}
h1{margin-bottom:5px}.panel{max-width:380px;margin:20px auto;padding:20px;background:#1e293b;border-radius:18px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
button{height:75px;border:0;border-radius:14px;font-size:22px;font-weight:bold;background:#38bdf8;color:#082f49;touch-action:none}
.stop{background:#fb7185;color:#4c0519}small{color:#cbd5e1}
</style></head><body>
<h1>SafeRide</h1><p>Local Wi-Fi motor control</p>
<div class="panel"><div class="grid">
<div></div><button data-cmd="F">front▲</button><div></div>
<button data-cmd="L">left◀</button><button class="stop" data-cmd="S">STOP</button><button data-cmd="R">right▶</button>
<div></div><button data-cmd="B">back▼</button><div></div>
</div><p id="status">Connecting...</p><small>Release a direction button to stop.</small></div>
<script>
let active=null,timer=null,busy=false;
const statusEl=document.getElementById('status');
async function sendCommand(cmd){
  if(busy)return; busy=true;
  try{const r=await fetch('/cmd?m='+cmd,{cache:'no-store'});statusEl.textContent=r.ok?'Car connected':'Command failed'}
  catch(e){statusEl.textContent='Connection lost'} busy=false;
}
function start(cmd){clearInterval(timer);active=cmd;sendCommand(cmd);if(cmd!=='S')timer=setInterval(()=>{if(active)sendCommand(active)},250)}
function stop(){active=null;clearInterval(timer);sendCommand('S')}
document.querySelectorAll('button[data-cmd]').forEach(btn=>{
  const cmd=btn.dataset.cmd;
  btn.addEventListener('pointerdown',e=>{e.preventDefault();start(cmd)});
  btn.addEventListener('pointerup',e=>{e.preventDefault();stop()});
  btn.addEventListener('pointercancel',stop);
  btn.addEventListener('pointerleave',()=>{if(active===cmd)stop()});
});
window.addEventListener('blur',stop);
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop()});
sendCommand('S');
</script></body></html>
)HTML";

bool writeRegister(byte reg, byte value) {
  Wire.beginTransmission(ADXL_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readAxisData(int16_t &x, int16_t &y, int16_t &z) {
  Wire.beginTransmission(ADXL_ADDR);
  Wire.write(0x32);
  if (Wire.endTransmission(false) != 0 ||
      Wire.requestFrom(ADXL_ADDR, (uint8_t)6) != 6) {
    return false;
  }

  uint8_t xl = Wire.read(), xh = Wire.read();
  uint8_t yl = Wire.read(), yh = Wire.read();
  uint8_t zl = Wire.read(), zh = Wire.read();
  x = (int16_t)((xh << 8) | xl);
  y = (int16_t)((yh << 8) | yl);
  z = (int16_t)((zh << 8) | zl);
  return true;
}

void sendLineToGateway(const String &line) {
  Serial.println(line);
  if (gatewayClient && gatewayClient.connected()) gatewayClient.println(line);
}

void processGatewayLine(String line) {
  line.trim();
  if (!line.startsWith("GPS,")) return;

  int validPos = line.indexOf("VALID=");
  int latPos = line.indexOf("LAT=");
  int lonPos = line.indexOf("LON=");
  if (validPos < 0 || latPos < 0 || lonPos < 0) return;

  int validEnd = line.indexOf(',', validPos);
  String validText = validEnd >= 0
    ? line.substring(validPos + 6, validEnd)
    : line.substring(validPos + 6);
  bool gpsValid = validText == "1";

  int latEnd = line.indexOf(',', latPos);
  String latText = latEnd >= 0
    ? line.substring(latPos + 4, latEnd)
    : line.substring(latPos + 4);
  int lonEnd = line.indexOf(',', lonPos);
  String lonText = lonEnd >= 0
    ? line.substring(lonPos + 4, lonEnd)
    : line.substring(lonPos + 4);

  float latitude = latText.toFloat();
  float longitude = lonText.toFloat();
  portENTER_CRITICAL(&telemetryMux);
  latestGpsValid = gpsValid;
  latestLat = latitude;
  latestLon = longitude;
  latestGpsAt = millis();
  portEXIT_CRITICAL(&telemetryMux);
}

void acceptGateway() {
  if (!gatewayClient || !gatewayClient.connected()) {
    WiFiClient incoming = sensorServer.available();
    if (incoming) {
      if (gatewayClient) gatewayClient.stop();
      gatewayClient = incoming;
      gatewayClient.setNoDelay(true);
      portENTER_CRITICAL(&telemetryMux);
      gatewayTcpConnected = true;
      portEXIT_CRITICAL(&telemetryMux);
      Serial.println("ESP32 #2 connected over TCP.");
      gatewayClient.println("STATUS,ESP32_1_READY");
    }
  }

  while (gatewayClient && gatewayClient.connected() && gatewayClient.available()) {
    char c = (char)gatewayClient.read();
    if (c == '\n') {
      processGatewayLine(gatewayLine);
      gatewayLine = "";
    } else if (c != '\r') {
      if (gatewayLine.length() < 220) gatewayLine += c;
      else gatewayLine = "";
    }
  }
  if (!gatewayClient || !gatewayClient.connected()) {
    portENTER_CRITICAL(&telemetryMux);
    gatewayTcpConnected = false;
    portEXIT_CRITICAL(&telemetryMux);
  }
}

bool postCloudJson(const char* path, const String &body) {
  if (WiFi.status() != WL_CONNECTED) return false;
  if (String(API_KEY).startsWith("REPLACE_") || String(API_KEY).length() < 16) {
    Serial.println("Configure SAFERIDE_DEVICE_API_KEY in secrets.h.");
    return false;
  }

  WiFiClientSecure secureClient;
  // Prototype setting: use certificate validation before production deployment.
  secureClient.setInsecure();
  HTTPClient https;
  https.setTimeout(8000);

  String url = String(API_BASE_URL) + path;
  if (!https.begin(secureClient, url)) {
    Serial.println("Could not start HTTPS request.");
    return false;
  }
  https.addHeader("Content-Type", "application/json");
  https.addHeader("X-API-Key", API_KEY);
  int code = https.POST(body);
  String response = https.getString();
  https.end();

  Serial.printf("Cloud POST %s: HTTP %d\n", path, code);
  if (response.length()) Serial.println(response);
  return code >= 200 && code < 300;
}

void uploadCollisionEvent(int16_t x, int16_t y, int16_t z,
                          int vibration, int delta) {
  bool gpsFresh = latestGpsAt > 0 && latestGpsValid &&
                  millis() - latestGpsAt < GATEWAY_FRESH_MS;
  String body = "{\"event_type\":\"POSSIBLE_COLLISION\",\"latitude\":";
  body += gpsFresh ? String(latestLat, 6) : "null";
  body += ",\"longitude\":";
  body += gpsFresh ? String(latestLon, 6) : "null";
  body += ",\"x\":" + String(x) + ",\"y\":" + String(y);
  body += ",\"z\":" + String(z) + ",\"vibration\":" + String(vibration);
  body += ",\"delta\":" + String(delta) + "}";

  bool uploaded = postCloudJson("/api/events", body);
  sendLineToGateway(uploaded
    ? "STATUS,CLOUD_UPLOAD_OK"
    : "STATUS,CLOUD_UPLOAD_FAILED");
}

void uploadHeartbeat(const char* deviceId, const String &components,
                     bool includeTelemetry, int16_t x, int16_t y, int16_t z,
                     int vibration, int delta, bool gpsFresh,
                     float latitude, float longitude) {
  String body = "{\"device_id\":\"";
  body += deviceId;
  body += "\",\"components\":";
  body += components;

  if (includeTelemetry) {
    body += ",\"telemetry\":{\"x\":" + String(x);
    body += ",\"y\":" + String(y) + ",\"z\":" + String(z);
    body += ",\"vibration\":" + String(vibration);
    body += ",\"delta\":" + String(delta);
    body += ",\"latitude\":";
    body += gpsFresh ? String(latitude, 6) : "null";
    body += ",\"longitude\":";
    body += gpsFresh ? String(longitude, 6) : "null";
    body += "}";
  }
  body += "}";

  bool uploaded = postCloudJson("/api/heartbeat", body);
  Serial.printf("Heartbeat %s: %s\n", deviceId, uploaded ? "uploaded" : "failed");
}

void uploadDeviceHeartbeats() {
  int16_t x, y, z;
  int vibration, delta;
  bool sampleOk, sampleExists, sampleAttempted, gatewayConnected, gpsValid;
  float latitude, longitude;
  unsigned long sampleAt, gpsAt;
  portENTER_CRITICAL(&telemetryMux);
  x = latestX; y = latestY; z = latestZ;
  vibration = latestVibration; delta = latestDelta;
  sampleOk = lastAdxlReadOk;
  sampleExists = haveValidAdxlSample;
  sampleAttempted = adxlReadAttempted;
  gatewayConnected = gatewayTcpConnected;
  gpsValid = latestGpsValid;
  latitude = latestLat; longitude = latestLon;
  sampleAt = lastSample; gpsAt = latestGpsAt;
  portEXIT_CRITICAL(&telemetryMux);

  const char* adxlState = !adxlReady || (sampleAttempted && !sampleOk)
    ? "error"
    : sampleAttempted && sampleOk ? "ok" : "unknown";
  String sensorComponents = "{\"adxl345\":\"";
  sensorComponents += adxlState;
  sensorComponents += "\",\"sw420\":\"unknown\"}";
  unsigned long now = millis();
  bool telemetryFresh = sampleExists && sampleOk && now - sampleAt < 5000;
  bool gpsFresh = gpsAt > 0 && gpsValid && now - gpsAt < GATEWAY_FRESH_MS;
  uploadHeartbeat("sensor-node-1", sensorComponents, telemetryFresh,
                  x, y, z, vibration, delta, gpsFresh, latitude, longitude);

  bool gatewayFresh = gatewayConnected && gpsAt > 0 &&
                      now - gpsAt < GATEWAY_FRESH_MS;
  if (gatewayFresh) {
    String gatewayComponents = "{\"tcp_link\":\"connected\",\"gps_fix\":\"";
    gatewayComponents += gpsValid ? "valid" : "no_fix";
    gatewayComponents += "\"}";
    uploadHeartbeat("gateway-node-2", gatewayComponents, false,
                    x, y, z, vibration, delta, gpsFresh, latitude, longitude);
  }
}

void cloudHeartbeatTask(void* parameter) {
  for (;;) {
    uploadDeviceHeartbeats();
    vTaskDelay(pdMS_TO_TICKS(HEARTBEAT_INTERVAL_MS));
  }
}

bool gsmCommand(const String &command, const char* expected,
                unsigned long timeoutMs) {
  while (GSMSerial.available()) GSMSerial.read();
  GSMSerial.println(command);
  unsigned long start = millis();
  String response;
  while (millis() - start < timeoutMs) {
    while (GSMSerial.available()) {
      response += (char)GSMSerial.read();
      if (response.indexOf(expected) >= 0) return true;
    }
    delay(2);
  }
  Serial.println("GSM command timed out: " + command);
  return false;
}

bool sendSMS(const String &message) {
  if (String(EMERGENCY_PHONE).indexOf("REPLACE") >= 0 ||
      String(EMERGENCY_PHONE).length() < 8) {
    Serial.println("Configure SAFERIDE_EMERGENCY_PHONE in secrets.h.");
    sendLineToGateway("STATUS,SMS_SKIPPED_NO_NUMBER");
    return false;
  }
  if (!gsmCommand("AT", "OK", 1500)) {
    sendLineToGateway("STATUS,SMS_FAILED_MODEM_NO_RESPONSE");
    return false;
  }
  gsmCommand("ATE0", "OK", 1500);
  if (!gsmCommand("AT+CMGF=1", "OK", 1500)) {
    sendLineToGateway("STATUS,SMS_FAILED_TEXT_MODE");
    return false;
  }

  while (GSMSerial.available()) GSMSerial.read();
  GSMSerial.print("AT+CMGS=\"");
  GSMSerial.print(EMERGENCY_PHONE);
  GSMSerial.println("\"");

  unsigned long start = millis();
  String response;
  while (millis() - start < 5000) {
    while (GSMSerial.available()) {
      char c = (char)GSMSerial.read();
      response += c;
      if (c == '>') {
        GSMSerial.print(message);
        GSMSerial.write(26);
        start = millis();
        response = "";
        while (millis() - start < 20000) {
          while (GSMSerial.available()) {
            response += (char)GSMSerial.read();
            if (response.indexOf("+CMGS:") >= 0) {
              sendLineToGateway("STATUS,SMS_SUBMITTED");
              return true;
            }
            if (response.indexOf("ERROR") >= 0) {
              sendLineToGateway("STATUS,SMS_FAILED_MODEM_ERROR");
              return false;
            }
          }
          delay(5);
        }
        sendLineToGateway("STATUS,SMS_STATUS_UNKNOWN");
        return false;
      }
    }
    delay(2);
  }
  sendLineToGateway("STATUS,SMS_FAILED_NO_PROMPT");
  return false;
}

void handleCollision(int16_t x, int16_t y, int16_t z,
                     int vibration, int delta) {
  String event = "EVENT,POSSIBLE_COLLISION,X=" + String(x) +
                 ",Y=" + String(y) + ",Z=" + String(z) +
                 ",VIB=" + String(vibration) + ",DELTA=" + String(delta);
  sendLineToGateway(event);

  String sms = "SafeRide ALERT: possible vehicle collision detected.";
  if (latestGpsValid && latestGpsAt > 0 &&
      millis() - latestGpsAt < GATEWAY_FRESH_MS) {
    sms += " Location: https://maps.google.com/?q=";
    sms += String(latestLat, 6) + "," + String(latestLon, 6);
  } else {
    sms += " GPS location is currently unavailable.";
  }
  sendSMS(sms);
  uploadCollisionEvent(x, y, z, vibration, delta);
}

void setup() {
  Serial.begin(115200);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  stopMotors();

  pinMode(VIBRATION_PIN, INPUT);
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.beginTransmission(ADXL_ADDR);
  adxlReady = Wire.endTransmission() == 0;
  if (adxlReady) {
    adxlReady = writeRegister(0x2C, 0x0A) &&
                writeRegister(0x31, 0x08) &&
                writeRegister(0x2D, 0x08);
  }
  Serial.println(adxlReady ? "ADXL345 ready." : "WARNING: ADXL345 not detected.");

  GSMSerial.begin(9600, SERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN);
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(false);
  bool apOk = WiFi.softAP(SAFERIDE_AP_SSID, SAFERIDE_AP_PASSWORD);
  Serial.println(apOk ? "CollisionNet AP started." : "ERROR: AP failed.");
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
    json += ",\"gateway_tcp\":";
    json += gatewayClient && gatewayClient.connected() ? "true" : "false";
    json += "}";
    webServer.send(200, "application/json", json);
  });
  webServer.onNotFound([]() {
    webServer.send(404, "text/plain", "Not found");
  });
  webServer.begin();

  Serial.println("SafeRide ESP32 #1 ready; motors are stopped.");
  Serial.println("Join the local AP and open http://192.168.4.1");
  Serial.println("ESP32 #2 TCP port: 3333");
  WiFi.begin(SAFERIDE_HOTSPOT_SSID, SAFERIDE_HOTSPOT_PASSWORD);
  lastHotspotAttempt = millis();
  Serial.println("Connecting to configured internet hotspot...");

  BaseType_t taskCreated = xTaskCreatePinnedToCore(
    cloudHeartbeatTask,
    "cloudHeartbeat",
    12288,
    nullptr,
    1,
    nullptr,
    0
  );
  if (taskCreated != pdPASS) {
    Serial.println("ERROR: Could not start cloud heartbeat task.");
  }
}

void loop() {
  webServer.handleClient();
  acceptGateway();

  if (currentMotion != 'S' &&
      millis() - lastMotionCommand > COMMAND_TIMEOUT_MS) {
    stopMotors();
    Serial.println("Safety timeout: motors stopped.");
  }

  if (WiFi.status() != WL_CONNECTED &&
      millis() - lastHotspotAttempt > 15000) {
    lastHotspotAttempt = millis();
    WiFi.begin(SAFERIDE_HOTSPOT_SSID, SAFERIDE_HOTSPOT_PASSWORD);
  }

  if (millis() - lastSample >= SAMPLE_INTERVAL_MS) {
    portENTER_CRITICAL(&telemetryMux);
    lastSample = millis();
    portEXIT_CRITICAL(&telemetryMux);
    if (adxlReady) {
      int16_t x, y, z;
      if (readAxisData(x, y, z)) {
        int vibration = digitalRead(VIBRATION_PIN);
        int delta = 0;
        if (havePrevious) {
          float dx = (float)x - prevX;
          float dy = (float)y - prevY;
          float dz = (float)z - prevZ;
          delta = (int)sqrtf(dx * dx + dy * dy + dz * dz);
        }
        prevX = x; prevY = y; prevZ = z;
        havePrevious = true;
        portENTER_CRITICAL(&telemetryMux);
        adxlReadAttempted = true;
        lastAdxlReadOk = true;
        haveValidAdxlSample = true;
        latestX = x; latestY = y; latestZ = z;
        latestVibration = vibration; latestDelta = delta;
        portEXIT_CRITICAL(&telemetryMux);

        String data = "DATA,X=" + String(x) + ",Y=" + String(y) +
                      ",Z=" + String(z) + ",VIB=" + String(vibration) +
                      ",DELTA=" + String(delta);
        if (millis() - lastTelemetryPrint >= 1000) {
          lastTelemetryPrint = millis();
          sendLineToGateway(data);
        }

        bool sharpChange = delta >= IMPACT_DELTA_THRESHOLD;
        bool vibrationWithChange = vibration == HIGH &&
                                   delta >= VIBRATION_DELTA_THRESHOLD;
        if ((sharpChange || vibrationWithChange) &&
            (lastEvent == 0 || millis() - lastEvent >= EVENT_COOLDOWN_MS)) {
          lastEvent = millis();
          handleCollision(x, y, z, vibration, delta);
        }
      } else {
        portENTER_CRITICAL(&telemetryMux);
        adxlReadAttempted = true;
        lastAdxlReadOk = false;
        portEXIT_CRITICAL(&telemetryMux);
        havePrevious = false;
        Serial.println("ERROR: Failed to read ADXL345.");
      }
    }
  }

  delay(1);
}
