const ARDUINO_CLOUD_URL = "https://app.arduino.cc/dashboards/6ead67b9-23dd-4aa0-a434-4977248f3a10";

const frame = document.querySelector("#arduino-cloud-frame");
if (frame) {
  frame.src = ARDUINO_CLOUD_URL;
}
