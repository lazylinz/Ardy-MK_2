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

const FACE_CAPTURE_TARGET_SAMPLES = 5;
const FACE_CAPTURE_MIN_SAMPLES = 3;
const FACE_CAPTURE_MAX_ATTEMPTS = 40;
const FACE_CAPTURE_INTERVAL_MS = 220;

const state = {
  mode: 'password',
  afterPasswordGate: false,
  faceCapture: null,
  stream: null,
  cameraStarting: null,
  scanInProgress: false,
  captureCanvas: null,
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
  const text = String(err?.message || '').trim();
  if (name === 'notallowederror' || name === 'securityerror') {
    return 'Camera permission was denied. Allow camera access and try again.';
  }
  if (name === 'notfounderror' || name === 'devicesnotfounderror') {
    return 'No camera device was found on this system.';
  }
  if (name === 'notreadableerror' || /could not start video source/i.test(text)) {
    return 'Camera is busy or blocked by another app/tab. Close other camera apps and retry.';
  }
  if (name === 'overconstrainederror') {
    return 'Camera constraints were unsupported. Retrying with a basic camera profile is required.';
  }
  return text || 'Unable to access camera.';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  }
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
        await wait(250);
        return;
      } catch (err) {
        lastError = err;
        await wait(150);
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

function ensureCaptureCanvas() {
  if (state.captureCanvas) return state.captureCanvas;
  state.captureCanvas = document.createElement('canvas');
  return state.captureCanvas;
}

function captureFrameAsDataUrl() {
  const videoWidth = Number(faceVideo?.videoWidth || 0);
  const videoHeight = Number(faceVideo?.videoHeight || 0);
  if (!videoWidth || !videoHeight) return '';

  const canvas = ensureCaptureCanvas();
  canvas.width = Math.max(160, Math.min(640, videoWidth));
  canvas.height = Math.max(120, Math.min(480, videoHeight));

  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) return '';
  ctx.drawImage(faceVideo, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function collectFaceImages() {
  await startCamera();

  const images = [];
  for (let attempt = 0; attempt < FACE_CAPTURE_MAX_ATTEMPTS; attempt += 1) {
    const frame = captureFrameAsDataUrl();
    if (frame && frame.length > 200) {
      images.push(frame);
      setMessage(`Capturing face frames (${images.length}/${FACE_CAPTURE_TARGET_SAMPLES})...`, 'ok');
      if (images.length >= FACE_CAPTURE_TARGET_SAMPLES) break;
    }
    await wait(FACE_CAPTURE_INTERVAL_MS);
  }

  if (images.length < FACE_CAPTURE_MIN_SAMPLES) {
    throw new Error('No stable face capture. Keep your face centered and retry.');
  }
  return { images };
}

async function loginByFaceOpenCv(faceCapture) {
  const images = Array.isArray(faceCapture?.images) ? faceCapture.images : [];
  const res = await fetch('/login/face-opencv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images })
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
    const faceCapture = await collectFaceImages();
    state.faceCapture = faceCapture;

    const result = await loginByFaceOpenCv(faceCapture);
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

  if (!Array.isArray(state.faceCapture?.images) || !state.faceCapture.images.length) {
    setMessage('Face data missing. Please run face scan again.', 'error');
    setStage('face');
    return;
  }

  setLoading(enrollBtn, true, 'Creating...', 'Create Profile');
  setMessage('', '');

  try {
    const res = await fetch('/login/enroll-opencv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nickname,
        images: state.faceCapture.images
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
  state.faceCapture = null;
  if (state.afterPasswordGate) {
    setStage('password');
    setMessage('Face scan was cancelled.', 'ok');
  } else {
    setStage('password');
    setMessage('', '');
  }
});

window.addEventListener('beforeunload', stopCamera);
setStage('password');
