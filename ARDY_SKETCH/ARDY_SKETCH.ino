#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <WiFiS3.h>
#include "tv_house_monitor.h"
#include "WiFiAPWebServer.h"
#include "arduino_secrets.h"

WiFiAPWebServer webServer;

LiquidCrystal_I2C lcd(0x27, 16, 2);

static const bool kEnableApServer = true;
static const bool kEnableCameraRelay = false;
static const bool kForwardAfterApVerify = true;
static const unsigned long kRelayIntervalMs = 1200;
static const unsigned long kConnectRetryIntervalMs = 5000;
static const unsigned long kCameraVerifyIntervalMs = 3000;

WiFiClient camClient;
WiFiSSLClient uploadClient;

unsigned long lastRelayAtMs = 0;
unsigned long lastConnectAttemptAtMs = 0;
unsigned long lastCameraVerifyAttemptAtMs = 0;
bool cameraVerifiedOnAp = false;

bool hasValidLocalIp() {
  IPAddress ip = WiFi.localIP();
  return !(ip[0] == 0 && ip[1] == 0 && ip[2] == 0 && ip[3] == 0);
}

bool readHttpLine(WiFiClient &client, String &line, unsigned long timeoutMs) {
  line = "";
  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    while (client.available()) {
      char c = static_cast<char>(client.read());
      if (c == '\r') {
        continue;
      }
      if (c == '\n') {
        return true;
      }
      line += c;
    }
    delay(1);
  }
  return false;
}

bool ensureUplinkConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    return true;
  }

  unsigned long now = millis();
  if (now - lastConnectAttemptAtMs < kConnectRetryIntervalMs) {
    return false;
  }
  lastConnectAttemptAtMs = now;

  Serial.print("Connecting uplink STA: ");
  Serial.println(UPLINK_WIFI_SSID);

  int status = WiFi.begin(UPLINK_WIFI_SSID, UPLINK_WIFI_PASS);
  if (status == WL_CONNECTED && hasValidLocalIp()) {
    Serial.print("Uplink connected. UNO IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("Gateway: ");
    Serial.println(WiFi.gatewayIP());
    Serial.print("Subnet: ");
    Serial.println(WiFi.subnetMask());
    return true;
  }

  if (status == WL_CONNECTED) {
    Serial.println("Uplink status is connected but IP is still 0.0.0.0. Retrying...");
  } else {
    Serial.print("Uplink connect failed. status=");
    Serial.println(status);
  }
  return false;
}

bool fetchCameraCaptureAndForward() {
  Serial.print("Camera target: ");
  Serial.print(CAM_CAPTURE_HOST);
  Serial.print(":");
  Serial.print(CAM_CAPTURE_PORT);
  Serial.print(CAM_CAPTURE_PATH);
  Serial.println();

  if (!camClient.connect(CAM_CAPTURE_HOST, CAM_CAPTURE_PORT)) {
    Serial.println("Camera connect failed. Check camera IP/port and ensure same subnet as UNO.");
    return false;
  }

  camClient.print("GET ");
  camClient.print(CAM_CAPTURE_PATH);
  camClient.print(" HTTP/1.1\r\nHost: ");
  camClient.print(CAM_CAPTURE_HOST);
  camClient.print("\r\nAccept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
  camClient.print("\r\nAccept-Language: en-PH,en-US;q=0.9,en;q=0.8");
  camClient.print("\r\nUser-Agent: Mozilla/5.0 Arduino-UNO-R4-WiFi Relay");
  camClient.print("\r\nConnection: keep-alive\r\n\r\n");

  String line;
  if (!readHttpLine(camClient, line, 5000)) {
    Serial.println("Camera response timeout.");
    camClient.stop();
    return false;
  }
  if (line.indexOf("200") < 0) {
    Serial.print("Camera HTTP error: ");
    Serial.println(line);
    camClient.stop();
    return false;
  }

  int contentLength = -1;
  while (readHttpLine(camClient, line, 5000)) {
    if (line.length() == 0) {
      break;
    }
    line.toLowerCase();
    if (line.startsWith("content-length:")) {
      String value = line.substring(15);
      value.trim();
      contentLength = value.toInt();
    }
  }

  // If endpoint is MJPEG (/stream), find first part headers and parse length there.
  if (contentLength <= 0) {
    while (readHttpLine(camClient, line, 5000)) {
      if (line.length() == 0) {
        if (contentLength > 0) {
          break;
        }
        continue;
      }
      line.toLowerCase();
      if (line.startsWith("content-length:")) {
        String value = line.substring(15);
        value.trim();
        contentLength = value.toInt();
      }
    }
  }

  if (contentLength <= 0) {
    Serial.println("Camera content-length missing/invalid (capture or stream part).");
    camClient.stop();
    return false;
  }

  if (!uploadClient.connect(CAM_PUSH_HOST, CAM_PUSH_PORT)) {
    Serial.println("Upload connect failed.");
    camClient.stop();
    return false;
  }

  uploadClient.print("POST ");
  uploadClient.print(CAM_PUSH_PATH);
  uploadClient.print(" HTTP/1.1\r\nHost: ");
  uploadClient.print(CAM_PUSH_HOST);
  uploadClient.print("\r\nx-cam-key: ");
  uploadClient.print(CAM_PUSH_KEY);
  uploadClient.print("\r\nContent-Type: image/jpeg\r\nConnection: close\r\nContent-Length: ");
  uploadClient.print(contentLength);
  uploadClient.print("\r\n\r\n");

  uint8_t buffer[768];
  int remaining = contentLength;
  unsigned long copyStart = millis();

  while (remaining > 0) {
    if (!camClient.connected() && !camClient.available()) {
      Serial.println("Camera disconnected mid-frame.");
      camClient.stop();
      uploadClient.stop();
      return false;
    }

    int toRead = remaining > static_cast<int>(sizeof(buffer)) ? static_cast<int>(sizeof(buffer)) : remaining;
    int n = camClient.read(buffer, toRead);
    if (n > 0) {
      uploadClient.write(buffer, n);
      remaining -= n;
      copyStart = millis();
      continue;
    }

    if (millis() - copyStart > 4000) {
      Serial.println("Frame copy timeout.");
      camClient.stop();
      uploadClient.stop();
      return false;
    }
    delay(1);
  }

  camClient.stop();

  if (!readHttpLine(uploadClient, line, 5000)) {
    Serial.println("Upload response timeout.");
    uploadClient.stop();
    return false;
  }

  bool ok = line.indexOf("200") >= 0;
  Serial.print("Upload result: ");
  Serial.println(line);

  uploadClient.stop();
  return ok;
}

bool verifyCameraEndpoint() {
  Serial.print("Verifying camera on AP target: ");
  Serial.print(CAM_CAPTURE_HOST);
  Serial.print(":");
  Serial.print(CAM_CAPTURE_PORT);
  Serial.print(CAM_CAPTURE_PATH);
  Serial.println();

  if (!camClient.connect(CAM_CAPTURE_HOST, CAM_CAPTURE_PORT)) {
    Serial.println("Verification failed: cannot connect to camera host/port.");
    return false;
  }

  camClient.print("GET ");
  camClient.print(CAM_CAPTURE_PATH);
  camClient.print(" HTTP/1.1\r\nHost: ");
  camClient.print(CAM_CAPTURE_HOST);
  camClient.print("\r\nAccept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
  camClient.print("\r\nAccept-Language: en-PH,en-US;q=0.9,en;q=0.8");
  camClient.print("\r\nUser-Agent: Mozilla/5.0 Arduino-UNO-R4-WiFi Verify");
  camClient.print("\r\nConnection: keep-alive\r\n\r\n");

  String line;
  if (!readHttpLine(camClient, line, 3000)) {
    Serial.println("Verification failed: camera response timeout.");
    camClient.stop();
    return false;
  }

  if (line.indexOf("200") < 0) {
    Serial.print("Verification failed: HTTP status ");
    Serial.println(line);
    camClient.stop();
    return false;
  }

  bool cameraLikeContent = false;
  while (readHttpLine(camClient, line, 3000)) {
    if (line.length() == 0) break;
    String lower = line;
    lower.toLowerCase();
    if (lower.startsWith("content-type:")) {
      if (lower.indexOf("image/jpeg") >= 0 || lower.indexOf("multipart/x-mixed-replace") >= 0) {
        cameraLikeContent = true;
      }
    }
  }

  camClient.stop();

  if (!cameraLikeContent) {
    Serial.println("Verification failed: endpoint is reachable but did not return camera content type.");
    return false;
  }

  Serial.println("Camera verified on AP.");
  return true;
}

void setup() {
  lcd.init();
  lcd.backlight();

  Serial.begin(9600);
  while (!Serial) {
    ;
  }

  if (kEnableApServer && kEnableCameraRelay) {
    Serial.println("Invalid config: AP + STA relay mode requested together.");
    Serial.println("Use AP mode with post-verify forwarding, or STA relay mode.");
    while (true) {
      delay(1000);
    }
  }

  if (kEnableApServer) {
    webServer.begin();
    if (kForwardAfterApVerify) {
      Serial.print("AP mode forwarding enabled. Push target: https://");
      Serial.print(CAM_PUSH_HOST);
      Serial.print(CAM_PUSH_PATH);
      Serial.println();
    }
  }

  if (kEnableCameraRelay) {
    ensureUplinkConnected();
  }

  tvHouseMonitorInit(&lcd);

  tvHouseMonitorSetFanState(true);
  tvHouseMonitorSetLightBrightness(78);
  tvHouseMonitorSetLightWarmness(64);
}

void loop() {
  if (kEnableApServer) {
    webServer.update();

    if (!webServer.isApClientConnected()) {
      if (cameraVerifiedOnAp) {
        cameraVerifiedOnAp = false;
        Serial.println("AP client disconnected. Camera verification reset.");
      }
    } else if (!cameraVerifiedOnAp) {
      unsigned long now = millis();
      if (now - lastCameraVerifyAttemptAtMs >= kCameraVerifyIntervalMs) {
        lastCameraVerifyAttemptAtMs = now;
        cameraVerifiedOnAp = verifyCameraEndpoint();
      }
    } else if (kForwardAfterApVerify) {
      unsigned long now = millis();
      if (now - lastRelayAtMs >= kRelayIntervalMs) {
        lastRelayAtMs = now;
        fetchCameraCaptureAndForward();
      }
    }
  }

  if (kEnableCameraRelay) {
    if (ensureUplinkConnected()) {
      unsigned long now = millis();
      if (now - lastRelayAtMs >= kRelayIntervalMs) {
        lastRelayAtMs = now;
        fetchCameraCaptureAndForward();
      }
    }
  }

  tvHouseMonitorUpdate();

  // Example: update these from your real sensors / variables
  // tvHouseMonitorSetFanState(fanOn);
  // tvHouseMonitorSetLightBrightness(brightnessPercent);
  // tvHouseMonitorSetLightWarmness(warmnessPercent);
}
