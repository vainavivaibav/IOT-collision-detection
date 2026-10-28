#include <WiFi.h>
#include <TinyGPSPlus.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#include "secrets.h"

const char* SERVER_IP = "192.168.4.1";
const uint16_t SERVER_PORT = 3333;

const int GPS_RX_PIN = 16;
const int GPS_TX_PIN = 17;
TinyGPSPlus gps;
HardwareSerial GPSSerial(2);

const int OLED_SDA = 21;
const int OLED_SCL = 22;
const int OLED_WIDTH = 128;
const int OLED_HEIGHT = 64;
Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
bool oledReady = false;

const int BUZZER_PIN = 25;
bool alertActive = false;
unsigned long alertStarted = 0;
const unsigned long ALERT_DURATION_MS = 2000;

WiFiClient client;
String incomingLine;
unsigned long lastConnectAttempt = 0;
unsigned long lastWiFiRetry = 0;
unsigned long lastGPSReport = 0;
unsigned long lastGPSPrint = 0;

const unsigned long WIFI_RETRY_INTERVAL_MS = 5000;
const unsigned long TCP_RETRY_INTERVAL_MS = 2000;
const unsigned long GPS_REPORT_INTERVAL_MS = 1000;

void showStatus(const String &line1, const String &line2) {
  if (!oledReady) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("SAFERIDE");
  display.println("---------------------");
  display.println(line1);
  display.println(line2);
  display.display();
}

bool gpsIsFresh() {
  return gps.location.isValid() && gps.location.age() < 10000;
}

void triggerCollisionAlert(const String &line) {
  Serial.println();
  Serial.println("!!! POSSIBLE COLLISION !!!");
  Serial.println(line);
  alertActive = true;
  alertStarted = millis();
  digitalWrite(BUZZER_PIN, HIGH);

  if (oledReady) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(2);
    display.setCursor(0, 0);
    display.println("COLLISION");
    display.println("ALERT!");
    display.setTextSize(1);
    display.println();
    if (gpsIsFresh()) {
      display.print("Lat:");
      display.println(gps.location.lat(), 4);
      display.print("Lon:");
      display.println(gps.location.lng(), 4);
    } else {
      display.println("GPS fix pending");
    }
    display.display();
  }
}

void processLine(String line) {
  line.trim();
  if (!line.length()) return;

  if (line.startsWith("EVENT,")) {
    triggerCollisionAlert(line);
  } else if (line.startsWith("STATUS,")) {
    Serial.println(line);
    if (line.indexOf("SMS_SUBMITTED") >= 0) {
      showStatus("Collision alert", "SMS submitted");
    } else if (line.indexOf("CLOUD_UPLOAD_OK") >= 0 ||
               line.indexOf("CLOUD_HEARTBEAT_OK") >= 0) {
      showStatus("Cloud status", "Upload successful");
    } else if (line.indexOf("SMS_FAILED") >= 0 ||
               line.indexOf("CLOUD_UPLOAD_FAILED") >= 0 ||
               line.indexOf("CLOUD_HEARTBEAT_FAILED") >= 0) {
      showStatus("Alert status", "Check Serial");
    }
  } else if (line.startsWith("DATA,")) {
    Serial.println(line);
  } else {
    Serial.print("ESP32 #1: ");
    Serial.println(line);
  }
}

void connectToSensorNode() {
  if (WiFi.status() != WL_CONNECTED || client.connected()) return;
  if (millis() - lastConnectAttempt < TCP_RETRY_INTERVAL_MS) return;

  lastConnectAttempt = millis();
  client.stop();
  Serial.println("Connecting to ESP32 #1 TCP server...");
  if (client.connect(SERVER_IP, SERVER_PORT)) {
    client.setNoDelay(true);
    client.setTimeout(50);
    Serial.println("Connected to SafeRide ESP32 #1.");
    showStatus("WiFi connected", "TCP link ready");
  } else {
    Serial.println("TCP connection failed; retrying.");
    showStatus("WiFi connected", "TCP retry pending");
  }
}

void sendGPSUpdate() {
  if (!client.connected()) return;
  bool valid = gpsIsFresh();
  String line = "GPS,VALID=";
  line += valid ? "1" : "0";
  line += ",LAT=";
  line += valid ? String(gps.location.lat(), 6) : "0.000000";
  line += ",LON=";
  line += valid ? String(gps.location.lng(), 6) : "0.000000";
  client.println(line);
}

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Wire.begin(OLED_SDA, OLED_SCL);
  oledReady = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (oledReady) {
    showStatus("Starting...", "GPS initializing");
    Serial.println("OLED initialized.");
  } else {
    Serial.println("OLED not detected; continuing without display.");
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(SAFERIDE_AP_SSID, SAFERIDE_AP_PASSWORD);
  Serial.println();
  Serial.println("SafeRide ESP32 #2 - GPS + OLED + buzzer");
  Serial.println("Connecting to CollisionNet...");

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("ESP32 #2 IP: ");
    Serial.println(WiFi.localIP());
    showStatus("WiFi connected", "Linking to ESP32 #1");
  } else {
    Serial.println("Wi-Fi not connected; background retry enabled.");
    showStatus("WiFi waiting", "Check ESP32 #1");
  }
}

void loop() {
  while (GPSSerial.available() > 0) gps.encode(GPSSerial.read());

  if (WiFi.status() != WL_CONNECTED &&
      millis() - lastWiFiRetry >= WIFI_RETRY_INTERVAL_MS) {
    lastWiFiRetry = millis();
    Serial.println("Retrying CollisionNet...");
    WiFi.reconnect();
  }

  connectToSensorNode();
  while (client.connected() && client.available()) {
    char c = (char)client.read();
    if (c == '\n') {
      processLine(incomingLine);
      incomingLine = "";
    } else if (c != '\r') {
      if (incomingLine.length() < 240) incomingLine += c;
      else incomingLine = "";
    }
  }

  if (client.connected() &&
      millis() - lastGPSReport >= GPS_REPORT_INTERVAL_MS) {
    lastGPSReport = millis();
    sendGPSUpdate();
  }

  if (millis() - lastGPSPrint >= 5000) {
    lastGPSPrint = millis();
    if (gpsIsFresh()) {
      Serial.print("GPS: ");
      Serial.print(gps.location.lat(), 6);
      Serial.print(", ");
      Serial.println(gps.location.lng(), 6);
      if (oledReady && !alertActive) showStatus("GPS: VALID", "TCP connected");
    } else {
      Serial.println("GPS: Waiting for a recent fix");
      if (oledReady && !alertActive) showStatus("GPS: WAITING", "Go outdoors");
    }
  }

  if (alertActive && millis() - alertStarted >= ALERT_DURATION_MS) {
    alertActive = false;
    digitalWrite(BUZZER_PIN, LOW);
    if (oledReady) {
      showStatus(
        gpsIsFresh() ? "GPS: VALID" : "GPS: WAITING",
        client.connected() ? "TCP connected" : "TCP reconnect"
      );
    }
  }
  delay(2);
}
