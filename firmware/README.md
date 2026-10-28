# SAFERIDE ESP32 Firmware

The sketches in this folder are the Arduino firmware sources for the two boards:

- `esp32_sensor_node/esp32_sensor_node.ino`: ESP32 #1 reads the ADXL345 and SW-420, hosts the local `CollisionNet` access point and motor-control page, receives GPS messages from ESP32 #2, uploads telemetry/heartbeats to the cloud, and uploads collision events.
- `esp32_gateway/esp32_gateway.ino`: ESP32 #2 reads the NEO-6M GPS, sends GPS status to ESP32 #1 over TCP, and operates its OLED and buzzer for alerts.

The status sent for ESP32 #2 is relayed by ESP32 #1. The dashboard therefore reports whether ESP32 #1 recently received GPS messages from ESP32 #2; ESP32 #2 does not connect to the cloud itself.

## Private configuration

For each sketch folder, copy `secrets.example.h` to `secrets.h`, then set the local access-point credentials there. For ESP32 #1, also set the phone hotspot credentials, backend API key, and emergency phone number. `secrets.h` is ignored by Git; do not commit it or share real credentials.

The sketches will not compile until the matching local `secrets.h` file exists. Configure the same `DEVICE_API_KEY` on the backend host and in ESP32 #1's private configuration. The backend URL is the existing Render service URL in the ESP32 #1 sketch; update it only if the backend URL changes.

**Rotate the phone-hotspot password that was pasted into chat before using it again.** Do not reuse it in the new private configuration.

## Arduino dependencies

Install the ESP32 Arduino board support package. ESP32 #2 additionally requires these Arduino libraries:

- TinyGPSPlus
- Adafruit GFX Library
- Adafruit SSD1306

ESP32 #1 uses libraries included with the ESP32 Arduino core. Check that the selected board and serial port match the physical device before uploading.

## Data and health reporting

- ESP32 #1 sends a heartbeat with its latest sensor state and ADXL345 readings approximately every 10 seconds when it has internet access.
- ESP32 #1 reports ESP32 #2 as online only while its TCP connection and recent GPS messages are present. A valid GPS fix is reported separately from gateway connectivity.
- Heartbeats older than 60 seconds are shown as stale by the backend.
- SW-420 health is reported as `unknown`: a digital input read alone cannot establish that the module is physically functioning.
- Collision events are still posted to `POST /api/events`; coordinates are both `null` when no fresh GPS fix exists.
- Live telemetry comes from heartbeats; the event history continues to contain collision events only.

The ESP32 TLS client currently uses `setInsecure()` for prototype connectivity. This encrypts the connection but does not validate the server certificate. Replace it with trusted certificate validation before production use.

## First power-up

Keep the robot wheels off the ground during initial motor checks. Confirm the sensor, GPS, OLED, buzzer, motor-driver and power wiring against the actual board pinout, and use appropriate power supplies and common ground. The firmware does not verify the physical wiring or provide electrical safety validation.

After deploying the backend changes, connect ESP32 #1 to the configured internet hotspot and ESP32 #2 to the `CollisionNet` access point. Check the Serial Monitor for Wi-Fi, sensor, TCP and cloud request results. A cloud heartbeat is only possible when ESP32 #1 has internet access.
