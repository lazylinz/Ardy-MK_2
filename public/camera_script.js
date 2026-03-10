const feedImg = document.getElementById("camera-feed");
const statusEl = document.getElementById("feed-status");
const modeMjpegBtn = document.getElementById("mode-mjpeg");
const modeSnapshotBtn = document.getElementById("mode-snapshot");
const refreshBtn = document.getElementById("refresh-btn");
const monitorToggleBtn = document.getElementById("monitor-toggle-btn");
const notifPermissionBtn = document.getElementById("notif-permission-btn");
const faceMonitorStatusEl = document.getElementById("face-monitor-status");
const faceAlertLayerEl = document.getElementById("face-alert-layer");

const FACE_MODEL_URI = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/";
const FACE_SCAN_INTERVAL_MS = 1800;
const FACE_MATCH_ALERT_COOLDOWN_MS = 60000;
const FACE_UNKNOWN_ALERT_COOLDOWN_MS = 25000;
const FACE_BATCH_LIMIT = 5;

let snapshotTimer = null;
let faceScanTimer = null;
let mode = "mjpeg";

const monitorState = {
  enabled: true,
  scanInProgress: false,
  modelsReady: false,
  modelsLoading: null,
  activeNotification: null,
  recentAlerts: new Map()
};

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setFaceMonitorStatus(text, isError = false) {
  if (!faceMonitorStatusEl) return;
  faceMonitorStatusEl.textContent = text;
  faceMonitorStatusEl.style.color = isError ? "#ff9ea3" : "#8fd6ff";
}

function setActiveButton() {
  modeMjpegBtn.classList.toggle("active", mode === "mjpeg");
  modeSnapshotBtn.classList.toggle("active", mode === "snapshot");
}

function setMonitorToggleButton() {
  monitorToggleBtn.classList.toggle("active", monitorState.enabled);
  monitorToggleBtn.textContent = monitorState.enabled ? "Face Monitor: ON" : "Face Monitor: OFF";
}

function updateNotificationButton() {
  if (!("Notification" in window)) {
    notifPermissionBtn.disabled = true;
    notifPermissionBtn.textContent = "Notifications Unsupported";
    return;
  }
  const permission = Notification.permission;
  if (permission === "granted") {
    notifPermissionBtn.disabled = true;
    notifPermissionBtn.textContent = "Notifications Enabled";
    return;
  }
  if (permission === "denied") {
    notifPermissionBtn.disabled = true;
    notifPermissionBtn.textContent = "Notifications Blocked";
    return;
  }
  notifPermissionBtn.disabled = false;
  notifPermissionBtn.textContent = "Enable Notifications";
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

async function ensureFaceModelsReady() {
  if (monitorState.modelsReady) return;
  if (monitorState.modelsLoading) {
    await monitorState.modelsLoading;
    return;
  }
  if (!window.faceapi) {
    throw new Error("Face model runtime not loaded.");
  }

  monitorState.modelsLoading = Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URI),
    faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URI),
    faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URI)
  ]).then(() => {
    monitorState.modelsReady = true;
  });

  await monitorState.modelsLoading;
}

function descriptorFingerprint(descriptor) {
  if (!Array.isArray(descriptor)) return `unknown-${Date.now()}`;
  const sample = descriptor.slice(0, 24);
  return sample.map((value) => Math.round(Number(value) * 20)).join(":");
}

function shouldAlertNow(alertKey, cooldownMs) {
  const now = Date.now();
  const lastAlertAt = Number(monitorState.recentAlerts.get(alertKey) || 0);
  if (now - lastAlertAt < cooldownMs) return false;
  monitorState.recentAlerts.set(alertKey, now);
  return true;
}

function playAlertSound() {
  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    const ctx = new AudioContextCtor();
    const gain = ctx.createGain();
    gain.gain.value = 0.001;
    gain.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = "triangle";
    osc1.frequency.value = 880;
    osc1.connect(gain);

    const osc2 = ctx.createOscillator();
    osc2.type = "triangle";
    osc2.frequency.value = 660;
    osc2.connect(gain);

    const now = ctx.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    osc1.start(now);
    osc2.start(now + 0.06);
    osc1.stop(now + 0.32);
    osc2.stop(now + 0.36);

    setTimeout(() => {
      ctx.close().catch(() => undefined);
    }, 600);
  } catch (error) {
    // Ignore autoplay/audio context restrictions.
  }
}

function showFaceToast({ title, message, isUnknown = false }) {
  if (!faceAlertLayerEl) return;
  const toast = document.createElement("div");
  toast.className = `face-alert-toast${isUnknown ? " unknown" : ""}`;

  const titleEl = document.createElement("div");
  titleEl.className = "face-alert-title";
  titleEl.textContent = title;
  const messageEl = document.createElement("div");
  messageEl.className = "face-alert-text";
  messageEl.textContent = message;
  toast.appendChild(titleEl);
  toast.appendChild(messageEl);
  faceAlertLayerEl.prepend(toast);

  setTimeout(() => {
    toast.remove();
  }, 4800);
}

function notifyOffsite({ title, body }) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  try {
    if (monitorState.activeNotification) {
      monitorState.activeNotification.close();
    }
    monitorState.activeNotification = new Notification(title, {
      body,
      tag: "ardy-face-monitor",
      renotify: true
    });
  } catch (error) {
    // Ignore browser notification failures.
  }
}

function fireFaceAlert({ label, distance, isUnknown = false }) {
  const certaintyText = Number.isFinite(distance)
    ? ` (distance ${distance.toFixed(3)})`
    : "";
  const title = isUnknown ? "Unknown person detected" : "Known face detected";
  const message = isUnknown ? "Unknown person is on camera." : `${label} is on camera${certaintyText}`;

  if (document.visibilityState === "visible" && document.hasFocus()) {
    showFaceToast({ title, message, isUnknown });
    playAlertSound();
    return;
  }

  notifyOffsite({
    title: "Ardy Camera Alert",
    body: message
  });
}

async function requestMatchBatch(descriptors) {
  const response = await fetch("/api/faces/match-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ descriptors })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || "Face matching request failed.");
  }
  return payload;
}

async function runFaceMonitorTick() {
  if (!monitorState.enabled || monitorState.scanInProgress) return;
  if (!feedImg || !feedImg.complete || !feedImg.naturalWidth || !feedImg.naturalHeight) return;

  monitorState.scanInProgress = true;
  try {
    await ensureFaceModelsReady();
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: 160,
      scoreThreshold: 0.5
    });
    const detections = await faceapi
      .detectAllFaces(feedImg, options)
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (!Array.isArray(detections) || detections.length === 0) {
      setFaceMonitorStatus("Face monitor active: no faces detected in latest frame.");
      return;
    }

    const descriptors = detections
      .map((item) => Array.from(item?.descriptor || []))
      .filter((item) => Array.isArray(item) && item.length >= 32)
      .slice(0, FACE_BATCH_LIMIT);

    if (!descriptors.length) {
      setFaceMonitorStatus("Faces found but descriptors were unstable. Retrying...");
      return;
    }

    const payload = await requestMatchBatch(descriptors);
    const results = Array.isArray(payload?.matches) ? payload.matches : [];
    const nowSeen = new Set();
    let matchCount = 0;

    for (let i = 0; i < results.length; i += 1) {
      const result = results[i] || {};
      const descriptor = descriptors[i];
      const isMatched = Boolean(result.matched && result.userId);

      if (isMatched) {
        matchCount += 1;
        const key = `user:${result.userId}`;
        if (nowSeen.has(key)) continue;
        nowSeen.add(key);
        if (!shouldAlertNow(key, FACE_MATCH_ALERT_COOLDOWN_MS)) continue;

        fireFaceAlert({
          label: String(result.nickname || result.userId),
          distance: Number(result.distance),
          isUnknown: false
        });
        continue;
      }

      const unknownKey = `unknown:${descriptorFingerprint(descriptor)}`;
      if (nowSeen.has(unknownKey)) continue;
      nowSeen.add(unknownKey);
      if (!shouldAlertNow(unknownKey, FACE_UNKNOWN_ALERT_COOLDOWN_MS)) continue;
      fireFaceAlert({
        label: "Unknown",
        distance: Number(result.distance),
        isUnknown: true
      });
    }

    setFaceMonitorStatus(`Face monitor active: ${detections.length} face(s), ${matchCount} known match(es).`);
  } catch (error) {
    setFaceMonitorStatus(`Face monitor error: ${error.message}`, true);
  } finally {
    monitorState.scanInProgress = false;
  }
}

function stopFaceMonitor() {
  if (!faceScanTimer) return;
  clearInterval(faceScanTimer);
  faceScanTimer = null;
}

function startFaceMonitor() {
  stopFaceMonitor();
  runFaceMonitorTick().catch(() => undefined);
  faceScanTimer = setInterval(() => {
    runFaceMonitorTick().catch(() => undefined);
  }, FACE_SCAN_INTERVAL_MS);
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

monitorToggleBtn.addEventListener("click", () => {
  monitorState.enabled = !monitorState.enabled;
  setMonitorToggleButton();
  if (!monitorState.enabled) {
    stopFaceMonitor();
    setFaceMonitorStatus("Face monitor paused.");
    return;
  }
  setFaceMonitorStatus("Face monitor resumed.");
  startFaceMonitor();
});

notifPermissionBtn.addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted" || Notification.permission === "denied") {
    updateNotificationButton();
    return;
  }
  try {
    await Notification.requestPermission();
  } catch (error) {
    // Ignore permission request errors.
  }
  updateNotificationButton();
});

window.addEventListener("beforeunload", () => {
  stopSnapshotTimer();
  stopFaceMonitor();
});

setMonitorToggleButton();
updateNotificationButton();
startMjpegMode();
startFaceMonitor();
