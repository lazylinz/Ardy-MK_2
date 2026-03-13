#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// ===========================
// Select camera model in board_config.h
// ===========================
#include "board_config.h"

// ===========================
// Enter your WiFi credentials
// ===========================
const char *uplinkSsid = "SAA Laptop1";
const char *uplinkPassword = "8P12b29;";

// Optional local AP fallback.
const bool kEnableLocalAp = false;
const char *apSsid = "ArdyCam-AP";
const char *apPassword = "12345678";

// Snapshot uplink target (server does counting + Arduino Cloud variable update).
const bool kEnableImagePush = true;
const char *imagePushUrl = "https://ardy-mk-2.vercel.app/api/cam/push-frame";
const char *imagePushKey = "lenard10";
const unsigned long kImagePushIntervalMs = 1000;

unsigned long gLastImagePushAtMs = 0;
unsigned long gPushAttemptCount = 0;
unsigned long gPushSuccessCount = 0;
unsigned long gPushFailCount = 0;

void setupLedFlash();

bool pushSnapshotForCounting() {
  if (!kEnableImagePush) return false;
  if (String(imagePushKey).length() == 0 || String(imagePushKey) == "REPLACE_WITH_CAM_INGEST_KEY") {
    Serial.println("[IMAGE PUSH] Skipped: set imagePushKey first.");
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[IMAGE PUSH] Skipped: WiFi not connected.");
    return false;
  }

  gPushAttemptCount += 1;
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb || !fb->buf || fb->len == 0) {
    Serial.println("[IMAGE PUSH] Camera frame capture failed.");
    if (fb) esp_camera_fb_return(fb);
    gPushFailCount += 1;
    return false;
  }

  WiFiClientSecure secureClient;
  secureClient.setInsecure();
  HTTPClient http;

  if (!http.begin(secureClient, imagePushUrl)) {
    Serial.println("[IMAGE PUSH] HTTP begin failed.");
    esp_camera_fb_return(fb);
    gPushFailCount += 1;
    return false;
  }

  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("x-cam-key", imagePushKey);

  int statusCode = http.POST(fb->buf, fb->len);
  String responseBody = (statusCode > 0) ? http.getString() : http.errorToString(statusCode);

  bool ok = statusCode >= 200 && statusCode < 300;
  if (ok) {
    gPushSuccessCount += 1;
  } else {
    gPushFailCount += 1;
  }

  Serial.printf("[IMAGE PUSH] status=%d attempts=%lu success=%lu fail=%lu bytes=%u\n",
                statusCode,
                gPushAttemptCount,
                gPushSuccessCount,
                gPushFailCount,
                fb->len);
  if (responseBody.length() > 0) {
    Serial.printf("[IMAGE PUSH] body=%s\n", responseBody.c_str());
  }

  http.end();
  esp_camera_fb_return(fb);
  return ok;
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.frame_size = FRAMESIZE_UXGA;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 4;
  config.fb_count = 1;

  if (config.pixel_format == PIXFORMAT_JPEG) {
    if (psramFound()) {
      config.jpeg_quality = 4;
      config.fb_count = 2;
      config.grab_mode = CAMERA_GRAB_LATEST;
    } else {
      config.frame_size = FRAMESIZE_SVGA;
      config.fb_location = CAMERA_FB_IN_DRAM;
    }
  }

#if defined(CAMERA_MODEL_ESP_EYE)
  pinMode(13, INPUT_PULLUP);
  pinMode(14, INPUT_PULLUP);
#endif

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    return;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);
    s->set_brightness(s, 1);
    s->set_saturation(s, -2);
  }
  if (config.pixel_format == PIXFORMAT_JPEG) {
    s->set_framesize(s, FRAMESIZE_SVGA);
  }

#if defined(CAMERA_MODEL_M5STACK_WIDE) || defined(CAMERA_MODEL_M5STACK_ESP32CAM)
  s->set_vflip(s, 1);
  s->set_hmirror(s, 1);
#endif

#if defined(CAMERA_MODEL_ESP32S3_EYE)
  s->set_vflip(s, 1);
#endif

#if defined(LED_GPIO_NUM)
  setupLedFlash();
#endif

  if (kEnableLocalAp) {
    WiFi.mode(WIFI_AP_STA);
  } else {
    WiFi.mode(WIFI_STA);
  }

  WiFi.begin(uplinkSsid, uplinkPassword);
  WiFi.setSleep(false);

  Serial.print("WiFi connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("");
  Serial.println("WiFi connected");

  if (kEnableLocalAp) {
    bool apOk = WiFi.softAP(apSsid, apPassword);
    Serial.printf("Local AP %s (%s)\n", apOk ? "started" : "failed", apSsid);
    if (apOk) {
      Serial.print("Local AP IP: ");
      Serial.println(WiFi.softAPIP());
    }
  }

  Serial.println("Snapshot uploader ready (server-side human counting enabled).");
  Serial.print("Push URL: ");
  Serial.println(imagePushUrl);
}

void loop() {
  unsigned long now = millis();
  if (kEnableImagePush && now - gLastImagePushAtMs >= kImagePushIntervalMs) {
    gLastImagePushAtMs = now;
    pushSnapshotForCounting();
  }
  delay(50);
}
