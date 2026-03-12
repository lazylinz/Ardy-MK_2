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
const FACE_BATCH_LIMIT = 5;
const FACE_NEW_PERSON_THRESHOLD = 0.52;
const FACE_MAX_TRACKED = 150;

let snapshotTimer = null;
let faceScanTimer = null;
let mode = "mjpeg";

const monitorState = {
  enabled: true,
  scanInProgress: false,
  modelsReady: false,
  modelsLoading: null,
  activeNotification: null,
  trackedFaces: [],
  nextFaceId: 1
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
h  });

  await monitorState.modelsLoading;
}

function faceDistance(descriptorA, descriptorB) {
  if (!Array.isArray(descriptorA) || !Array.isArray(descriptorB)) return Number.POSITIVE_INFINITY;
  const dimensions = Math.min(descriptorA.length, descriptorB.length);
  if (dimensions < 32) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < dimensions; i += 1) {
    const delta = Number(descriptorA[i]) - Number(descriptorB[i]);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function getBestTrackedFaceMatch(descriptor) {
  let best = null;
  for (const tracked of monitorState.trackedFaces) {
    const distance = faceDistance(descriptor, tracked.descriptor);
    if (!best || distance < best.distance) {
      best = { tracked, distance };
    }
  }
  if (!best) return null;
  if (!Number.isFinite(best.distance) || best.distance > FACE_NEW_PERSON_THRESHOLD) return null;
  return best;
}

function registerFace(descriptor) {
  const now = Date.now();
  const bestMatch = getBestTrackedFaceMatch(descriptor);
  if (bestMatch) {
    bestMatch.tracked.lastSeenAt = now;
    bestMatch.tracked.seenCount += 1;
    return {
      isNew: false,
      faceId: bestMatch.tracked.id,
      distance: bestMatch.distance
    };
  }

  const entry = {
    id: monitorState.nextFaceId,
    descriptor: descriptor.slice(0, 256),
    firstSeenAt: now,
    lastSeenAt: now,
    seenCount: 1
  };
  monitorState.nextFaceId += 1;
  monitorState.trackedFaces.push(entry);

  if (monitorState.trackedFaces.length > FACE_MAX_TRACKED) {
    monitorState.trackedFaces.sort((a, b) => Number(a.lastSeenAt || 0) - Number(b.lastSeenAt || 0));
    monitorState.trackedFaces = monitorState.trackedFaces.slice(
      monitorState.trackedFaces.length - FACE_MAX_TRACKED
    );
  }

  return {
    isNew: true,
    faceId: entry.id,
    distance: null
  };
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

function showFaceToast({ title, message }) {
  if (!faceAlertLayerEl) return;
  const toast = document.createElement("div");
  toast.className = "face-alert-toast";

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

function fireFaceAlert({ faceId }) {
  const title = "New face detected";
  const message = `Face #${faceId} appeared on camera.`;

  if (document.visibilityState === "visible" && document.hasFocus()) {
    showFaceToast({ title, message });
    playAlertSound();
    return;
  }

  notifyOffsite({
    title: "Ardy Camera Alert",
    body: message
  });
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

    let newFaceCount = 0;
    for (const descriptor of descriptors) {
      const registration = registerFace(descriptor);
      if (!registration.isNew) continue;
      newFaceCount += 1;
      fireFaceAlert({ faceId: registration.faceId });
    }

    setFaceMonitorStatus(
      `Face monitor active: ${detections.length} face(s), ${newFaceCount} new, ${monitorState.trackedFaces.length} tracked.`
    );
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
