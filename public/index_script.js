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
const FACE_SAMPLES_PER_STEP = 4;
const FACE_SCAN_MAX_ATTEMPTS = 56;
const FACE_SCAN_INTERVAL_MS = 220;

const state = {
  mode: 'password',
  afterPasswordGate: false,
  faceScan: null,
  stream: null,
  cameraStarting: null,
  scanInProgress: false,
  modelsReady: false,
  modelsLoading: null,
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
    stopCamera();
  } else if (isFace) {
    stageSubtitle.textContent = state.afterPasswordGate
      ? '3-step face scan required: front, left, right. If new, create your nickname next.'
      : 'Run a 3-step face scan: front, left, right.';
    startCamera().catch((err) => {
      setMessage(`Camera error: ${err.message}`, 'error');
    });
  } else if (isNickname) {
    stageSubtitle.textContent = 'New face detected. Choose your nickname to create your profile.';
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

async function captureFaceStep(step, index, totalSteps) {
  await loadFaceModels();
  await startCamera();

  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: 160,
    scoreThreshold: 0.5
  });

  const samples = [];
  let noFaceCount = 0;
  let poseMissCount = 0;
  setMessage(`Step ${index}/${totalSteps}: ${step.label}. ${step.prompt}`, 'ok');

  for (let attempt = 0; attempt < FACE_SCAN_MAX_ATTEMPTS; attempt += 1) {
    const detection = await faceapi
      .detectSingleFace(faceVideo, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    const descriptor = Array.from(detection?.descriptor || []);
    if (descriptor.length) {
      const yaw = estimateYaw(detection?.landmarks);
      if (step.validateYaw(yaw)) {
        samples.push(descriptor);
        setMessage(`Step ${index}/${totalSteps}: ${step.label} (${samples.length}/${FACE_SAMPLES_PER_STEP}). Hold still.`, 'ok');
        if (samples.length >= FACE_SAMPLES_PER_STEP) {
          return averageDescriptors(samples);
        }
        poseMissCount = 0;
      } else {
        poseMissCount += 1;
        if (poseMissCount % 5 === 0) {
          setMessage(`Step ${index}/${totalSteps}: ${step.label}. ${step.guidance}`, 'ok');
        }
      }
      noFaceCount = 0;
    } else {
      noFaceCount += 1;
      if (noFaceCount > 10) {
        setMessage(`Step ${index}/${totalSteps}: Looking for your face. Center your face in the ring.`, 'ok');
      }
    }

    await new Promise((resolve) => setTimeout(resolve, FACE_SCAN_INTERVAL_MS));
  }

  throw new Error(`Step ${index}/${totalSteps} timed out. ${step.guidance} Ensure lighting is stable.`);
}

async function captureFaceScan() {
  const descriptorsByAngle = {};
  for (let i = 0; i < FACE_SCAN_STEPS.length; i += 1) {
    const step = FACE_SCAN_STEPS[i];
    const descriptor = await captureFaceStep(step, i + 1, FACE_SCAN_STEPS.length);
    descriptorsByAngle[step.key] = descriptor;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const descriptor = averageDescriptors(Object.values(descriptorsByAngle));
  if (!descriptor) {
    throw new Error('Face scan failed. Please retry in stable lighting.');
  }

  return { descriptor, descriptorsByAngle };
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

    if (result.status === 404 && state.afterPasswordGate) {
      setStage('nickname');
      setMessage('New face detected. Choose a nickname to create your account.', 'ok');
      return;
    }

    if (result.status === 404) {
      setMessage('Face not recognized. Use access code first, then enroll as a new user.', 'error');
      return;
    }

    throw new Error(result.data?.message || 'Face sign-in failed.');
  } catch (err) {
    setMessage(`Error: ${err.message}`, 'error');
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
      throw new Error(payload.message || 'Enrollment failed.');
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

window.addEventListener('beforeunload', stopCamera);

setStage('password');
