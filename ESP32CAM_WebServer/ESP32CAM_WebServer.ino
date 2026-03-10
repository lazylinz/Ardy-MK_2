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

// Optional local AP so clients can still open the camera UI directly.
const bool kEnableLocalAp = false;
const char *apSsid = "ArdyCam-AP";
const char *apPassword = "12345678";

// Cloud relay target (your backend endpoint).
const bool kEnableCloudPush = true;
const char *cloudPushUrl = "https://ardy-mk-2.vercel.app/api/cam/push-frame";
const char *cloudPushKey = "lenard10";
const unsigned long kCloudPushIntervalMs = 1200;

unsigned long lastCloudPushAtMs = 0;
unsigned long pushAttemptCount = 0;
unsigned long pushSuccessCount = 0;
unsigned long pushFailCount = 0;

bool pushFrameToCloud() {
  if (!kEnableCloudPush) return false;
  if (String(cloudPushKey).length() == 0 || String(cloudPushKey) == "REPLACE_WITH_CAM_INGEST_KEY") {
    Serial.println("[PUSH] Skipped: set cloudPushKey first.");
    return false;
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[PUSH] Skipped: uplink WiFi not connected.");
    return false;
  }

  pushAttemptCount += 1;
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb || !fb->buf || fb->len == 0) {
    Serial.println("[PUSH] Camera frame capture failed.");
    if (fb) esp_camera_fb_return(fb);
    pushFailCount += 1;
    return false;
  }

  Serial.printf("[PUSH] Sending frame bytes=%u\n", fb->len);

  WiFiClientSecure secureClient;
  secureClient.setInsecure();
  HTTPClient http;
  bool ok = false;

  if (!http.begin(secureClient, cloudPushUrl)) {
    Serial.println("[PUSH] HTTP begin failed.");
    esp_camera_fb_return(fb);
    pushFailCount += 1;
    return false;
  }

  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("x-cam-key", cloudPushKey);

  int statusCode = http.POST(fb->buf, fb->len);
  String responseBody = (statusCode > 0) ? http.getString() : http.errorToString(statusCode);

  if (statusCode >= 200 && statusCode < 300) {
    ok = true;
    pushSuccessCount += 1;
  } else {
    pushFailCount += 1;
  }

  Serial.printf("[PUSH] status=%d attempts=%lu success=%lu fail=%lu\n", statusCode, pushAttemptCount, pushSuccessCount, pushFailCount);
  if (responseBody.length() > 0) {
    Serial.printf("[PUSH] body=%s\n", responseBody.c_str());
  }

  http.end();
  esp_camera_fb_return(fb);
  return ok;
}

void startCameraServer();
void setupLedFlash();

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
  config.pixel_format = PIXFORMAT_JPEG;  // for streaming
  //config.pixel_format = PIXFORMAT_RGB565; // for face detection/recognition
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  // if PSRAM IC present, init with UXGA resolution and higher JPEG quality
  //                      for larger pre-allocated frame buffer.
  if (config.pixel_format == PIXFORMAT_JPEG) {
    if (psramFound()) {
      config.jpeg_quality = 10;
      config.fb_count = 2;
      config.grab_mode = CAMERA_GRAB_LATEST;
    } else {
      // Limit the frame size when PSRAM is not available
      config.frame_size = FRAMESIZE_SVGA;
      config.fb_location = CAMERA_FB_IN_DRAM;
    }
  } else {
    // Best option for face detection/recognition
    config.frame_size = FRAMESIZE_240X240;
#if CONFIG_IDF_TARGET_ESP32S3
    config.fb_count = 2;
#endif
  }

#if defined(CAMERA_MODEL_ESP_EYE)
  pinMode(13, INPUT_PULLUP);
  pinMode(14, INPUT_PULLUP);
#endif

  // camera init
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x", err);
    return;
  }

  sensor_t *s = esp_camera_sensor_get();
  // initial sensors are flipped vertically and colors are a bit saturated
  if (s->id.PID == OV3660_PID) {
    s->set_vflip(s, 1);        // flip it back
    s->set_brightness(s, 1);   // up the brightness just a bit
    s->set_saturation(s, -2);  // lower the saturation
  }
  // drop down frame size for higher initial frame rate
  if (config.pixel_format == PIXFORMAT_JPEG) {
    s->set_framesize(s, FRAMESIZE_QVGA);
  }

#if defined(CAMERA_MODEL_M5STACK_WIDE) || defined(CAMERA_MODEL_M5STACK_ESP32CAM)
  s->set_vflip(s, 1);
  s->set_hmirror(s, 1);
#endif

#if defined(CAMERA_MODEL_ESP32S3_EYE)
  s->set_vflip(s, 1);
#endif

// Setup LED FLash if LED pin is defined in camera_pins.h
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

  startCameraServer();

  Serial.print("Camera Ready! Use 'http://");
  Serial.print(WiFi.localIP());
  Serial.println("' to connect");
  Serial.println("Cloud push: enabled");
  Serial.print("Cloud push URL: ");
  Serial.println(cloudPushUrl);
}

void loop() {
  if (kEnableCloudPush) {
    unsigned long now = millis();
    if (now - lastCloudPushAtMs >= kCloudPushIntervalMs) {
      lastCloudPushAtMs = now;
      pushFrameToCloud();
    }
  }

  delay(50);
}
