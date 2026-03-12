const loginForm = document.getElementById('loginForm');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const message = document.getElementById('message');
const stageSubtitle = document.getElementById('stageSubtitle');

const faceSignInBtn = document.getElementById('faceSignInBtn');
const faceSection = document.getElementById('faceSection');
const faceVideo = document.getElementById('faceVideo');
const scanFaceBtn = document.getElementById('scanFaceBtn');
const backBtn = document.getElementById('backBtn');
const reEnrollBtn = document.getElementById('reEnrollBtn');

const nicknameForm = document.getElementById('nicknameForm');
const nicknameInput = document.getElementById('nickname');
const enrollBtn = document.getElementById('enrollBtn');

const FACE_MODEL_URI = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
const FACE_SCAN_STEPS = [
  {
    key: 'front',
    label: 'Front view',
    prompt: 'Look straight at the camera.',
    validateYaw: (yaw) => Math.abs(yaw) <= 0.1,
    guidance: 'Keep your face centered and look straight.'
  },
  {
    key: 'left',
    label: 'Left side view',
    prompt: 'Turn slightly to your LEFT.',
    validateYaw: (yaw) => yaw <= -0.13,
    guidance: 'Turn your head more to your LEFT (or the opposite if your preview feels mirrored).'
  },
  {
    key: 'right',
    label: 'Right side view',
    prompt: 'Turn slightly to your RIGHT.',
    validateYaw: (yaw) => yaw >= 0.13,
    guidance: 'Turn your head more to your RIGHT (or the opposite if your preview feels mirrored).'
  }
];
const FACE_SAMPLES_PER_STEP = 5;
const FACE_SCAN_MAX_ATTEMPTS = 56;
const FACE_SCAN_INTERVAL_MS = 220;
const FACE_MIN_FACE_FRACTION = 0.08;
const FACE_MIN_BRIGHTNESS = 55;
const FACE_MAX_BRIGHTNESS = 210;
const FACE_MIN_SHARPNESS = 12;
const FACE_MAX_STABLE_SPREAD = 0.28;
const FACE_FAIL_CODES = {
  LOW_LIGHT: 'LOW_LIGHT',
  POSE_INVALID: 'POSE_INVALID',
  FACE_TOO_SMALL: 'FACE_TOO_SMALL',
  MULTIPLE_FACES: 'MULTIPLE_FACES',
  UNSTABLE_SAMPLES: 'UNSTABLE_SAMPLES',
  INCOMPLETE_SCAN: 'INCOMPLETE_SCAN',
  FACE_NOT_RECOGNIZED: 'FACE_NOT_RECOGNIZED',
  FACE_AMBIGUOUS: 'FACE_AMBIGUOUS'
};

const state = {
  mode: 'password',
  afterPasswordGate: false,
  faceScan: null,
  stream: null,
  cameraStarting: null,
  scanInProgress: false,
  modelsReady: false,
  modelsLoading: null,
  scanCanvas: null,
  scanContext: null
};

function setMessage(text, type) {
  message.textContent = text || '';
  message.classList.remove('ok', 'error');
  if (type) message.classList.add(type);
}

function setLoading(button, isLoading, loadingText, defaultText) {
  button.disabled = isLoading;
  button.textContent = isLoading ? loadingText : defaultText;
}

function toggleReEnrollButton(show) {
  if (!reEnrollBtn) return;
  reEnrollBtn.classList.toggle('hidden', !show);
}

function getCameraErrorMessage(err) {
  const name = String(err?.name || '').toLowerCase();
  const message = String(err?.message || '').trim();
  if (name === 'notallowederror' || name === 'securityerror') {
    return 'Camera permission was denied. Allow camera access and try again.';
  }
  if (name === 'notfounderror' || name === 'devicesnotfounderror') {
    return 'No camera device was found on this system.';
  }
  if (name === 'notreadableerror' || /could not start video source/i.test(message)) {
    return 'Camera is busy or blocked by another app/tab. Close other camera apps and retry.';
  }
  if (name === 'overconstrainederror') {
    return 'Camera constraints were unsupported. Retrying with a basic camera profile is required.';
  }
  return message || 'Unable to access camera.';
}

function setStage(stage) {
  state.mode = stage;
  const isPassword = stage === 'password';
  const isFace = stage === 'face';
  const isNickname = stage === 'nickname';

  loginForm.classList.toggle('hidden', !isPassword);
  faceSignInBtn.classList.toggle('hidden', !isPassword);
  faceSection.classList.toggle('hidden', !isFace);
  nicknameForm.classList.toggle('hidden', !isNickname);

  if (isPassword) {
    stageSubtitle.textContent = 'Enter your project access code to continue.';
    toggleReEnrollButton(false);
    stopCamera();
  } else if (isFace) {
    stageSubtitle.textContent = state.afterPasswordGate
      ? '3-step face scan required: front, left, right. If new, create your nickname next.'
      : 'Run a 3-step face scan: front, left, right.';
    toggleReEnrollButton(false);
    startCamera().catch((err) => {
      setMessage(`Camera error: ${err.message}`, 'error');
    });
  } else if (isNickname) {
    stageSubtitle.textContent = 'New face detected. Choose your nickname to create your profile.';
    toggleReEnrollButton(false);
    stopCamera();
  }
}

async function loadFaceModels() {
  if (state.modelsReady) return;
  if (state.modelsLoading) {
    await state.modelsLoading;
    return;
  }

  if (!window.faceapi) {
    throw new Error('Face engine failed to load. Refresh and try again.');
  }

  state.modelsLoading = Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URI),
    faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URI),
    faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URI)
  ]).then(() => {
    state.modelsReady = true;
  });

  await state.modelsLoading;
}

async function startCamera() {
  if (state.stream) return;
  if (state.cameraStarting) {
    await state.cameraStarting;
    return;
  }

  state.cameraStarting = (async () => {
    const constraintProfiles = [
      {
        video: {
          facingMode: 'user',
          width: { ideal: 480, max: 640 },
          height: { ideal: 360, max: 480 },
          frameRate: { ideal: 15, max: 20 }
        },
        audio: false
      },
      { video: true, audio: false }
    ];

    let lastError = null;
    for (const constraints of constraintProfiles) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (state.stream) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        state.stream = stream;
        faceVideo.srcObject = stream;
        await faceVideo.play().catch(() => undefined);
        return;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw new Error(getCameraErrorMessage(lastError));
  })();

  try {
    await state.cameraStarting;
  } finally {
    state.cameraStarting = null;
  }
}

function stopCamera() {
  if (!state.stream) return;
  state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
  faceVideo.srcObject = null;
}

function averageDescriptors(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) return null;
  const length = descriptors[0].length;
  const avg = new Array(length).fill(0);

  for (const descriptor of descriptors) {
    for (let i = 0; i < length; i += 1) {
      avg[i] += descriptor[i];
    }
  }
  for (let i = 0; i < length; i += 1) {
    avg[i] /= descriptors.length;
  }
  return avg;
}

function averagePoint(points = []) {
  if (!Array.isArray(points) || points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += Number(point?.x || 0);
    y += Number(point?.y || 0);
  }
  return { x: x / points.length, y: y / points.length };
}

function estimateYaw(landmarks) {
  if (!landmarks || typeof landmarks.getLeftEye !== 'function' || typeof landmarks.getRightEye !== 'function' || typeof landmarks.getNose !== 'function') {
    return null;
  }
  const leftEye = averagePoint(landmarks.getLeftEye());
  const rightEye = averagePoint(landmarks.getRightEye());
  const nose = landmarks.getNose();
  const noseTip = nose?.[3] || nose?.[0];
  if (!noseTip) return null;

  const eyeDistance = Math.abs(rightEye.x - leftEye.x);
  if (!Number.isFinite(eyeDistance) || eyeDistance < 1) return null;
  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  return (noseTip.x - eyeMidX) / eyeDistance;
}

function getScanContext() {
  if (state.scanContext && state.scanCanvas) return state.scanContext;
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  state.scanCanvas = canvas;
  state.scanContext = canvas.getContext('2d', { willReadFrequently: true });
  return state.scanContext;
}

function computeBrightnessAndSharpness() {
  const ctx = getScanContext();
  if (!ctx || !faceVideo.videoWidth || !faceVideo.videoHeight) {
    return { brightness: null, sharpness: null };
  }
  const canvas = state.scanCanvas;
  ctx.drawImage(faceVideo, 0, 0, canvas.width, canvas.height);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  let brightnessSum = 0;
  let edgeSum = 0;
  const width = canvas.width;
  const height = canvas.height;

  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < image.length; i += 4, p += 1) {
    const g = (0.299 * image[i]) + (0.587 * image[i + 1]) + (0.114 * image[i + 2]);
    gray[p] = g;
    brightnessSum += g;
  }

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = (y * width) + x;
      const gx = Math.abs(gray[idx + 1] - gray[idx - 1]);
      const gy = Math.abs(gray[idx + width] - gray[idx - width]);
      edgeSum += gx + gy;
    }
  }
  const brightness = brightnessSum / (width * height);
  const sharpness = edgeSum / ((width - 2) * (height - 2));
  return { brightness, sharpness };
}

function buildScanError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function descriptorDistance(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) return Number.POSITIVE_INFINITY;
  const dims = Math.min(left.length, right.length);
  let sum = 0;
  for (let i = 0; i < dims; i += 1) {
    const delta = Number(left[i]) - Number(right[i]);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function robustCentroid(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length < 3) return null;
  const provisional = averageDescriptors(descriptors);
  if (!provisional) return null;
  const ranked = descriptors
    .map((descriptor) => ({
      descriptor,
      distance: descriptorDistance(descriptor, provisional)
    }))
    .sort((a, b) => a.distance - b.distance);
  const keepCount = Math.max(3, Math.ceil(ranked.length * 0.8));
  const kept = ranked.slice(0, keepCount).map((item) => item.descriptor);
  const centroid = averageDescriptors(kept);
  if (!centroid) return null;
  const spread = Math.max(...kept.map((descriptor) => descriptorDistance(descriptor, centroid)));
  return { centroid, spread, keptSamples: kept.length };
}

function getFailureHint(code) {
  const hintMap = {
    [FACE_FAIL_CODES.LOW_LIGHT]: 'Increase lighting and avoid bright backlight.',
    [FACE_FAIL_CODES.POSE_INVALID]: 'Follow the angle prompt and keep your head steady.',
    [FACE_FAIL_CODES.FACE_TOO_SMALL]: 'Move closer so your face fills more of the frame.',
    [FACE_FAIL_CODES.MULTIPLE_FACES]: 'Only one face should be visible during scan.',
    [FACE_FAIL_CODES.UNSTABLE_SAMPLES]: 'Hold still for a moment before scanning again.',
    [FACE_FAIL_CODES.FACE_AMBIGUOUS]: 'Scan again with steady head position and consistent lighting.',
    [FACE_FAIL_CODES.INCOMPLETE_SCAN]: 'Complete all three steps: front, left, and right.'
  };
  return hintMap[code] || 'Please retry the scan with stable lighting.';
}

async function captureFaceStep(step, index, totalSteps) {
  await loadFaceModels();
  await startCamera();

  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: 224,
    scoreThreshold: 0.5
  });

  const samples = [];
  const qualitySnapshots = [];
  let noFaceCount = 0;
  let poseMissCount = 0;
  let lowLightCount = 0;
  let faceSmallCount = 0;
  let blurCount = 0;
  setMessage(`Step ${index}/${totalSteps}: ${step.label}. ${step.prompt}`, 'ok');

  for (let attempt = 0; attempt < FACE_SCAN_MAX_ATTEMPTS; attempt += 1) {
    const detections = await faceapi
      .detectAllFaces(faceVideo, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detections.length) {
      noFaceCount += 1;
      if (noFaceCount > 8) {
        setMessage(`Step ${index}/${totalSteps}: Looking for your face. Center your face in the ring.`, 'ok');
      }
      await new Promise((resolve) => setTimeout(resolve, FACE_SCAN_INTERVAL_MS));
      continue;
    }

    if (detections.length > 1) {
      throw buildScanError(FACE_FAIL_CODES.MULTIPLE_FACES, `Step ${index}/${totalSteps}: Multiple faces detected. Keep only one face in view.`);
    }

    const detection = detections[0];
    const descriptor = Array.from(detection?.descriptor || []);
    const box = detection?.detection?.box || detection?.detection?._box;
    const frameArea = Math.max(1, faceVideo.videoWidth * faceVideo.videoHeight);
    const faceArea = Math.max(0, Number(box?.width || 0) * Number(box?.height || 0));
    const faceBoxFraction = faceArea / frameArea;
    if (!Number.isFinite(faceBoxFraction) || faceBoxFraction < FACE_MIN_FACE_FRACTION) {
      faceSmallCount += 1;
      if (faceSmallCount >= 4) {
        throw buildScanError(FACE_FAIL_CODES.FACE_TOO_SMALL, `Step ${index}/${totalSteps}: Move closer to the camera.`);
      }
      await new Promise((resolve) => setTimeout(resolve, FACE_SCAN_INTERVAL_MS));
      continue;
    }

    const { brightness, sharpness } = computeBrightnessAndSharpness();
    if (!Number.isFinite(brightness) || brightness < FACE_MIN_BRIGHTNESS || brightness > FACE_MAX_BRIGHTNESS) {
      lowLightCount += 1;
      if (lowLightCount >= 4) {
        throw buildScanError(FACE_FAIL_CODES.LOW_LIGHT, `Step ${index}/${totalSteps}: Lighting is not suitable.`);
      }
      await new Promise((resolve) => setTimeout(resolve, FACE_SCAN_INTERVAL_MS));
      continue;
    }
    if (!Number.isFinite(sharpness) || sharpness < FACE_MIN_SHARPNESS) {
      blurCount += 1;
      if (blurCount >= 4) {
        throw buildScanError(FACE_FAIL_CODES.UNSTABLE_SAMPLES, `Step ${index}/${totalSteps}: Image is too blurry. Hold still.`);
      }
      await new Promise((resolve) => setTimeout(resolve, FACE_SCAN_INTERVAL_MS));
      continue;
    }

    const yaw = estimateYaw(detection?.landmarks);
    if (!step.validateYaw(yaw)) {
      poseMissCount += 1;
      if (poseMissCount % 3 === 0) {
        setMessage(`Step ${index}/${totalSteps}: ${step.guidance}`, 'ok');
      }
      await new Promise((resolve) => setTimeout(resolve, FACE_SCAN_INTERVAL_MS));
      continue;
    }

    if (descriptor.length) {
      lowLightCount = 0;
      faceSmallCount = 0;
      blurCount = 0;
      samples.push(descriptor);
      qualitySnapshots.push({ brightness, sharpness, faceBoxFraction, yaw });
      setMessage(`Step ${index}/${totalSteps}: ${step.label} (${samples.length}/${FACE_SAMPLES_PER_STEP}). Hold still.`, 'ok');
      if (samples.length >= FACE_SAMPLES_PER_STEP) {
        const robust = robustCentroid(samples);
        if (!robust || !Number.isFinite(robust.spread) || robust.spread > FACE_MAX_STABLE_SPREAD) {
          throw buildScanError(FACE_FAIL_CODES.UNSTABLE_SAMPLES, `Step ${index}/${totalSteps}: Samples were unstable. Try again.`);
        }
        const stats = qualitySnapshots.reduce((acc, item) => ({
          brightness: acc.brightness + Number(item.brightness || 0),
          sharpness: acc.sharpness + Number(item.sharpness || 0),
          faceBoxFraction: acc.faceBoxFraction + Number(item.faceBoxFraction || 0),
          yaw: acc.yaw + Number(item.yaw || 0)
        }), { brightness: 0, sharpness: 0, faceBoxFraction: 0, yaw: 0 });
        const count = qualitySnapshots.length || 1;
        return {
          descriptor: robust.centroid,
          quality: {
            status: 'ok',
            reasonCode: '',
            brightness: stats.brightness / count,
            sharpness: stats.sharpness / count,
            faceBoxFraction: stats.faceBoxFraction / count,
            yaw: stats.yaw / count,
            stableSpread: robust.spread,
            samples: robust.keptSamples
          }
        };
      }
      noFaceCount = 0;
    }

    await new Promise((resolve) => setTimeout(resolve, FACE_SCAN_INTERVAL_MS));
  }

  if (poseMissCount > 0 && samples.length === 0) {
    throw buildScanError(FACE_FAIL_CODES.POSE_INVALID, `Step ${index}/${totalSteps} timed out. ${step.guidance}`);
  }
  throw buildScanError(FACE_FAIL_CODES.UNSTABLE_SAMPLES, `Step ${index}/${totalSteps} timed out. ${step.guidance} Ensure lighting is stable.`);
}

async function captureFaceScan() {
  const descriptorsByAngle = {};
  const qualityByAngle = {};
  for (let i = 0; i < FACE_SCAN_STEPS.length; i += 1) {
    const step = FACE_SCAN_STEPS[i];
    const captured = await captureFaceStep(step, i + 1, FACE_SCAN_STEPS.length);
    descriptorsByAngle[step.key] = captured.descriptor;
    qualityByAngle[step.key] = captured.quality;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (!FACE_SCAN_STEPS.every((step) => descriptorsByAngle[step.key])) {
    throw buildScanError(FACE_FAIL_CODES.INCOMPLETE_SCAN, 'Face scan incomplete. Complete front, left, and right steps.');
  }

  const descriptor = averageDescriptors(Object.values(descriptorsByAngle));
  if (!descriptor) {
    throw buildScanError(FACE_FAIL_CODES.UNSTABLE_SAMPLES, 'Face scan failed. Please retry in stable lighting.');
  }

  return {
    descriptor,
    descriptorsByAngle,
    quality: {
      capturedAt: Date.now(),
      byAngle: qualityByAngle
    }
  };
}

async function loginByFace(faceScan) {
  const res = await fetch('/login/face', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(faceScan)
  });

  let data = {};
  try {
    data = await res.json();
  } catch (err) {}

  if (res.ok) return { ok: true, data };
  return { ok: false, status: res.status, data };
}

function getFaceApiMessage(result) {
  const code = String(result?.data?.reasonCode || result?.data?.code || '').trim().toUpperCase();
  const hint = getFailureHint(code);
  if (result?.data?.message) return `${result.data.message} ${hint}`;
  return hint;
}

function redirectToChat() {
  stopCamera();
  setMessage('Access granted. Redirecting...', 'ok');
  setTimeout(() => {
    window.location.href = 'chat.html';
  }, 450);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = passwordInput.value;
  setMessage('', '');
  setLoading(loginBtn, true, 'Checking...', 'Enter Workspace');

  try {
    const res = await fetch('/login/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: pwd })
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(payload.message || 'Password verification failed.');
    }

    if (payload.requiresFaceScan === false) {
      redirectToChat();
      return;
    }

    state.afterPasswordGate = true;
    state.faceScan = null;
    setStage('face');
    setMessage('Access code accepted. Continue with your face scan.', 'ok');
  } catch (err) {
    setMessage(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(loginBtn, false, 'Checking...', 'Enter Workspace');
  }
});

faceSignInBtn.addEventListener('click', () => {
  state.afterPasswordGate = false;
  state.faceScan = null;
  setMessage('', '');
  setStage('face');
});

scanFaceBtn.addEventListener('click', async () => {
  if (state.scanInProgress) return;
  state.scanInProgress = true;
  setLoading(scanFaceBtn, true, 'Scanning 3 steps...', 'Start 3-Step Scan');

  try {
    const faceScan = await captureFaceScan();
    state.faceScan = faceScan;

    const result = await loginByFace(faceScan);
    if (result.ok) {
      redirectToChat();
      return;
    }

    if (state.afterPasswordGate && (result.status === 404 || result.status === 409)) {
      toggleReEnrollButton(Boolean(state.faceScan?.descriptor));
      setMessage(`Face login failed: ${getFaceApiMessage(result)}`, 'error');
      return;
    }

    if (result.status === 404) {
      setMessage(`Face not recognized. ${getFailureHint(FACE_FAIL_CODES.FACE_NOT_RECOGNIZED)}`, 'error');
      return;
    }

    throw new Error(getFaceApiMessage(result) || 'Face sign-in failed.');
  } catch (err) {
    const code = String(err?.code || '').toUpperCase();
    const hint = getFailureHint(code);
    setMessage(`Error: ${err.message} ${hint}`, 'error');
    if (state.afterPasswordGate && state.faceScan?.descriptor) {
      toggleReEnrollButton(true);
    }
  } finally {
    state.scanInProgress = false;
    setLoading(scanFaceBtn, false, 'Scanning 3 steps...', 'Start 3-Step Scan');
  }
});

nicknameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nickname = nicknameInput.value.trim();

  if (!state.faceScan?.descriptor) {
    setMessage('Face data missing. Please run face scan again.', 'error');
    setStage('face');
    return;
  }

  setLoading(enrollBtn, true, 'Creating...', 'Create Profile');
  setMessage('', '');

  try {
    const res = await fetch('/login/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname, ...state.faceScan })
    });

    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = payload?.code ? `${payload.code}: ${payload.message || 'Enrollment failed.'}` : (payload.message || 'Enrollment failed.');
      throw new Error(reason);
    }

    redirectToChat();
  } catch (err) {
    setMessage(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(enrollBtn, false, 'Creating...', 'Create Profile');
  }
});

backBtn.addEventListener('click', () => {
  setMessage('', '');
  state.afterPasswordGate = false;
  state.faceScan = null;
  setStage('password');
});

if (reEnrollBtn) {
  reEnrollBtn.addEventListener('click', () => {
    if (!state.faceScan?.descriptor) {
      setMessage('Run a complete 3-step scan first.', 'error');
      return;
    }
    setStage('nickname');
    setMessage('Face scan ready. Enter nickname to re-enroll this scan.', 'ok');
  });
}

window.addEventListener('beforeunload', stopCamera);

setStage('password');
