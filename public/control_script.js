const ARDUINO_CLOUD_URL = "https://app.arduino.cc/dashboards/6ead67b9-23dd-4aa0-a434-4977248f3a10";
const ARDUINO_LOGIN_URL = "https://app.arduino.cc/";

const frame = document.querySelector("#arduino-cloud-frame");
const status = document.querySelector("#cloud-gate-status");
const loginBtn = document.querySelector("#arduino-login-btn");
const connectBtn = document.querySelector("#arduino-connect-btn");

const setStatus = (text) => {
  if (!status) return;
  status.textContent = text;
};

const connectDashboard = () => {
  if (!frame) return;
  frame.src = ARDUINO_CLOUD_URL;
  setStatus("Connecting to Arduino Cloud dashboard. If it fails/refuses, log in to arduino.cc in this browser and connect again.");
};

if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    window.open(ARDUINO_LOGIN_URL, "_blank", "noopener,noreferrer");
  });
}

if (connectBtn) {
  connectBtn.addEventListener("click", connectDashboard);
}
