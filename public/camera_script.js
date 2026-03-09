const feedImg = document.getElementById("camera-feed");
const statusEl = document.getElementById("feed-status");
const modeMjpegBtn = document.getElementById("mode-mjpeg");
const modeSnapshotBtn = document.getElementById("mode-snapshot");
const refreshBtn = document.getElementById("refresh-btn");

let snapshotTimer = null;
let mode = "mjpeg";

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setActiveButton() {
  modeMjpegBtn.classList.toggle("active", mode === "mjpeg");
  modeSnapshotBtn.classList.toggle("active", mode === "snapshot");
}

function stopSnapshotTimer() {
  if (!snapshotTimer) return;
  clearInterval(snapshotTimer);
  snapshotTimer = null;
}

function loadSnapshotFrame() {
  feedImg.src = `/api/cam/latest.jpg?t=${Date.now()}`;
}

function startSnapshotMode() {
  stopSnapshotTimer();
  mode = "snapshot";
  setActiveButton();
  setStatus("Snapshot mode active. Refreshes every 1.2s.");
  loadSnapshotFrame();
  snapshotTimer = setInterval(loadSnapshotFrame, 1200);
}

function startMjpegMode() {
  stopSnapshotTimer();
  mode = "mjpeg";
  setActiveButton();
  setStatus("Live MJPEG mode active.");
  feedImg.src = `/api/cam/stream.mjpeg?t=${Date.now()}`;
}

feedImg.addEventListener("load", () => {
  if (mode === "mjpeg") {
    setStatus("Live stream connected.");
  } else {
    setStatus(`Snapshot updated ${new Date().toLocaleTimeString()}.`);
  }
});

feedImg.addEventListener("error", () => {
  setStatus("No frame received. Check camera relay and ingest key.");
});

modeMjpegBtn.addEventListener("click", startMjpegMode);
modeSnapshotBtn.addEventListener("click", startSnapshotMode);
refreshBtn.addEventListener("click", () => {
  if (mode === "mjpeg") {
    startMjpegMode();
    return;
  }
  loadSnapshotFrame();
});

startMjpegMode();
