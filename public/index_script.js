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
const FACE_SAMPLES_REQUIRED = 5;

const state = {
  mode: 'password',
  afterPasswordGate: false,
  descriptor: null,
  stream: null,
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
    stageSubtitle.textContent = 'Enter your access password to continue.';
    stopCamera();
  } else if (isFace) {
    stageSubtitle.textContent = state.afterPasswordGate
      ? 'Face scan required. If new, create your nickname next.'
      : 'Position your face inside the frame to sign in.';
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
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',
      width: { ideal: 720 },
      height: { ideal: 480 }
    },
    audio: false
  });
  state.stream = stream;
  faceVideo.srcObject = stream;
  await faceVideo.play();
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

async function captureFaceDescriptor() {
  await loadFaceModels();
  await startCamera();

  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: 224,
    scoreThreshold: 0.45
  });

  const descriptors = [];
  const maxAttempts = 80;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const detection = await faceapi
      .detectSingleFace(faceVideo, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (detection?.descriptor) {
      descriptors.push(Array.from(detection.descriptor));
      setMessage(`Face detected (${descriptors.length}/${FACE_SAMPLES_REQUIRED})... hold still`, 'ok');
      if (descriptors.length >= FACE_SAMPLES_REQUIRED) {
        return averageDescriptors(descriptors);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('No stable face detected. Ensure your face is centered and well-lit.');
}

async function loginByFace(descriptor) {
  const res = await fetch('/login/face', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descriptor })
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
  setMessage('Sign in successful. Redirecting...', 'ok');
  setTimeout(() => {
    window.location.href = 'chat.html';
  }, 450);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = passwordInput.value;
  setMessage('', '');
  setLoading(loginBtn, true, 'Checking...', 'Continue');

  try {
    const res = await fetch('/login/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: pwd })
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.message || 'Password verification failed.');
    }

    state.afterPasswordGate = true;
    state.descriptor = null;
    setStage('face');
    setMessage('Password accepted. Continue with your face scan.', 'ok');
  } catch (err) {
    setMessage(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(loginBtn, false, 'Checking...', 'Continue');
  }
});

faceSignInBtn.addEventListener('click', () => {
  state.afterPasswordGate = false;
  state.descriptor = null;
  setMessage('', '');
  setStage('face');
});

scanFaceBtn.addEventListener('click', async () => {
  setLoading(scanFaceBtn, true, 'Scanning...', 'Scan Face');

  try {
    const descriptor = await captureFaceDescriptor();
    state.descriptor = descriptor;

    const result = await loginByFace(descriptor);
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
      setMessage('Face not recognized. Use password login first, then enroll as a new user.', 'error');
      return;
    }

    throw new Error(result.data?.message || 'Face sign-in failed.');
  } catch (err) {
    setMessage(`Error: ${err.message}`, 'error');
  } finally {
    setLoading(scanFaceBtn, false, 'Scanning...', 'Scan Face');
  }
});

nicknameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nickname = nicknameInput.value.trim();

  if (!state.descriptor) {
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
      body: JSON.stringify({ nickname, descriptor: state.descriptor })
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
  state.descriptor = null;
  setStage('password');
});

window.addEventListener('beforeunload', stopCamera);

setStage('password');
