#define SECRET_SSID "Ardy local AP"
#define SECRET_PASS "12345678qaz"

// Relay mode credentials (UNO as STA client with internet access)
// NOTE: WiFiS3 switches mode between AP and STA. You cannot keep AP active
// while using this relay path with current WiFiS3 mode handling.
#define UPLINK_WIFI_SSID "SAA Laptop1"
#define UPLINK_WIFI_PASS "8P12b29;"

// ESP32-CAM endpoint reachable from UNO in STA network.
// Prefer /capture (single JPEG frame) over parsing /stream MJPEG.
#define CAM_CAPTURE_HOST "192.48.56.3"
#define CAM_CAPTURE_PORT 81
#define CAM_CAPTURE_PATH "/stream"

// Public API endpoint configured in your Node backend.
#define CAM_PUSH_HOST "ardy-mk-2.vercel.app"
#define CAM_PUSH_PORT 443
#define CAM_PUSH_PATH "/api/cam/push-frame"
#define CAM_PUSH_KEY "lenard10"
