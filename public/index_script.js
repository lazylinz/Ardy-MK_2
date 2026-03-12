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
const FACE_SAMPLES_REQUIRED = 8;
const FACE_SAMPLES_MIN_ACCEPTED = 5;
const FACE_SCAN_MAX_ATTEMPTS = 120;
const FACE_SCAN_INTERVAL_MS = 180;
const FACE_MIN_DETECTION_SCORE = 0.72;
const FACE_MIN_BOX_RATIO = 0.08;
const FACE_MAX_OUTLIER_DISTANCE = 0.55;
const FACE_MIN_VARIATION_DISTANCE = 0.035;

const state = {
  mode: 'password',
  afterPasswordGate: false,
  faceCapture: null,
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
      ? 'Face scan required. If new, create your nickname next.'
      : 'Position your face inside the frame to continue.';
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

function faceDistance(descriptorA, descriptorB) {
  if (!Array.isArray(descriptorA) || !Array.isArray(descriptorB)) return Number.POSITIVE_INFINITY;
  const dims = Math.min(descriptorA.length, descriptorB.length);
  if (dims < 32) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < dims; i += 1) {
    const delta = Number(descriptorA[i]) - Number(descriptorB[i]);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function getFaceBoxRatio(detection) {
  const box = detection?.detection?.box;
  const width = Number(faceVideo?.videoWidth || 0);
  const height = Number(faceVideo?.videoHeight || 0);
  if (!box || !width || !height) return 0;
  const boxWidth = Math.max(0, Number(box.width || 0));
  const boxHeight = Math.max(0, Number(box.height || 0));
  return (boxWidth * boxHeight) / (width * height);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureFaceSignature() {
  await loadFaceModels();
  await startCamera();

  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: 224,
    scoreThreshold: 0.55
  });

  const descriptors = [];
  let misses = 0;

  for (let attempt = 0; attempt < FACE_SCAN_MAX_ATTEMPTS; attempt += 1) {
    const detection = await faceapi
      .detectSingleFace(faceVideo, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    const score = Number(detection?.detection?.score || 0);
    const boxRatio = getFaceBoxRatio(detection);

    if (detection?.descriptor && score >= FACE_MIN_DETECTION_SCORE && boxRatio >= FACE_MIN_BOX_RATIO) {
      const sample = Array.from(detection.descriptor);
      const rollingDescriptor = descriptors.length ? averageDescriptors(descriptors) : null;
      if (rollingDescriptor) {
        const drift = faceDistance(sample, rollingDescriptor);
        if (Number.isFinite(drift) && drift > FACE_MAX_OUTLIER_DISTANCE) {
          setMessage('Hold a steady angle and keep your whole face in frame.', 'ok');
          await wait(FACE_SCAN_INTERVAL_MS);
          continue;
        }
      }
      if (descriptors.length) {
        const last = descriptors[descriptors.length - 1];
        const variation = faceDistance(last, sample);
        if (Number.isFinite(variation) && variation < FACE_MIN_VARIATION_DISTANCE) {
          await wait(FACE_SCAN_INTERVAL_MS);
          continue;
        }
      }

      descriptors.push(sample);
      setMessage(`Collecting stable frames (${descriptors.length}/${FACE_SAMPLES_REQUIRED})...`, 'ok');
      if (descriptors.length >= FACE_SAMPLES_REQUIRED) {
        return {
          descriptor: averageDescriptors(descriptors),
          descriptors
        };
      }
      misses = 0;
    } else {
      misses += 1;
      if (misses > 10) {
        setMessage('Center your full face in the ring with brighter lighting.', 'ok');
      }
    }

    await wait(FACE_SCAN_INTERVAL_MS);
  }

  if (descriptors.length >= FACE_SAMPLES_MIN_ACCEPTED) {
    return {
      descriptor: averageDescriptors(descriptors),
      descriptors
    };
  }
  throw new Error('No stable face detected. Ensure your face is centered and well-lit.');
}

async function loginByFace(faceCapture) {
  const descriptor = Array.isArray(faceCapture?.descriptor) ? faceCapture.descriptor : null;
  const descriptors = Array.isArray(faceCapture?.descriptors) ? faceCapture.descriptors : [];
  const res = await fetch('/login/face', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descriptor, descriptors })
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
    state.faceCapture = null;
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
  state.faceCapture = null;
  setMessage('', '');
  setStage('face');
});

scanFaceBtn.addEventListener('click', async () => {
  if (state.scanInProgress) return;
  state.scanInProgress = true;
  setLoading(scanFaceBtn, true, 'Scanning...', 'Scan Face');

  try {
    const faceCapture = await captureFaceSignature();
    state.faceCapture = faceCapture;

    const result = await loginByFace(faceCapture);
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
    setLoading(scanFaceBtn, false, 'Scanning...', 'Scan Face');
  }
});

nicknameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nickname = nicknameInput.value.trim();

  if (!state.faceCapture?.descriptor) {
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
      body: JSON.stringify({
        nickname,
        descriptor: state.faceCapture.descriptor,
        descriptors: state.faceCapture.descriptors
      })
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
  state.faceCapture = null;
  setStage('password');
});

window.addEventListener('beforeunload', stopCamera);

setStage('password');
