const N_MAX = 30000; // ~36s DFT; simple shapes will use far fewer points

let cvReady = false;
let animationId = null;
let frequencies = [];
let approvedContourPoints = []; // centered points passed to DFT after user approval
let precomputedPath = [];
let animFrame = 0;
let stepsAccumulator = 0;
let numCircles = 100;
let speed = 1;
let canvasW = 0;
let canvasH = 0;
let cannyThreshold = 80;

let dftWorker = null;

// DOM
const uploadZone    = document.getElementById('upload-zone');
const fileInput     = document.getElementById('file-input');
const statusEl      = document.getElementById('status');
const contourSection = document.getElementById('contour-section');
const animSection   = document.getElementById('anim-section');
const previewCanvas = document.getElementById('preview-canvas');
const contourCanvas = document.getElementById('contour-canvas');
const originalCanvas = document.getElementById('original-canvas');
const animCanvas    = document.getElementById('anim-canvas');
const previewCtx    = previewCanvas.getContext('2d');
const contourCtx    = contourCanvas.getContext('2d');
const originalCtx   = originalCanvas.getContext('2d');
const animCtx       = animCanvas.getContext('2d');
const cannySlider   = document.getElementById('canny-slider');
const cannyVal      = document.getElementById('canny-val');
const progressBar   = document.getElementById('dft-progress');
const progressWrap  = document.getElementById('dft-progress-wrap');
const animateBtn    = document.getElementById('animate-btn');
const backBtn       = document.getElementById('back-btn');
const startBtn      = document.getElementById('start-btn');
const resetBtn      = document.getElementById('reset-btn');
const numCirclesSlider = document.getElementById('num-circles');
const speedSlider   = document.getElementById('speed');
const numCirclesVal = document.getElementById('num-circles-val');
const speedVal      = document.getElementById('speed-val');

// Called by opencv.js onload
function onOpenCvReady() {
  cvReady = true;
  setStatus('Ready — upload an image to begin.');
}
setStatus('Loading OpenCV.js…');

// ─── Upload ────────────────────────────────────────────────────────────────

uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) handleFile(file);
});
fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

function handleFile(file) {
  if (!cvReady) { setStatus('Still loading OpenCV.js — please wait.'); return; }
  stopAnimation();
  showStep('upload');
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => loadImageToCanvas(img);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function loadImageToCanvas(img) {
  const MAX_DIM = 500;
  let w = img.width, h = img.height;
  if (w > MAX_DIM || h > MAX_DIM) {
    const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  canvasW = w; canvasH = h;

  // Draw to the preview canvas used for edge detection
  previewCanvas.width = w; previewCanvas.height = h;
  previewCtx.drawImage(img, 0, 0, w, h);

  // Also copy to the original canvas shown in the animation step
  originalCanvas.width = w; originalCanvas.height = h;
  originalCtx.drawImage(img, 0, 0, w, h);

  runContourPreview();
}

// ─── Step 1: Contour preview ───────────────────────────────────────────────

cannySlider.addEventListener('input', () => {
  cannyThreshold = parseInt(cannySlider.value);
  cannyVal.textContent = cannyThreshold;
  runContourPreview();
});

function runContourPreview() {
  setStatus('Detecting outline…');
  setTimeout(() => {
    const points = extractContour(cannyThreshold);
    if (points.length < 3) {
      setStatus('No clear outline found — try lowering edge sensitivity.');
      drawContourPreview([]);
      showStep('contour');
      return;
    }
    approvedContourPoints = points;
    drawContourPreview(points);
    showStep('contour');
    setStatus(`Found ${points.length}-point outline. Happy with it? Click Animate.`);
  }, 20);
}

function drawContourPreview(points) {
  contourCanvas.width = canvasW;
  contourCanvas.height = canvasH;

  // Dark background
  contourCtx.fillStyle = '#0d0d1a';
  contourCtx.fillRect(0, 0, canvasW, canvasH);

  // Original image faded
  contourCtx.globalAlpha = 0.25;
  contourCtx.drawImage(previewCanvas, 0, 0);
  contourCtx.globalAlpha = 1;

  if (points.length < 2) return;

  // Draw the contour (points are centered — shift back to canvas coords)
  contourCtx.beginPath();
  contourCtx.moveTo(points[0].x + canvasW / 2, points[0].y + canvasH / 2);
  for (let i = 1; i < points.length; i++) {
    contourCtx.lineTo(points[i].x + canvasW / 2, points[i].y + canvasH / 2);
  }
  contourCtx.closePath();
  contourCtx.strokeStyle = '#00ffaa';
  contourCtx.lineWidth = 2;
  contourCtx.stroke();
}

animateBtn.addEventListener('click', () => {
  if (approvedContourPoints.length < 3) return;
  const N = approvedContourPoints.length;
  const estMs = Math.round((N * N) / 250000); // ~250M ops/sec
  setStatus(`Computing Fourier transform (${N} points, ~${estMs < 1 ? '<1' : estMs}s)…`);
  animateBtn.disabled = true;

  computeDFTAsync(approvedContourPoints,
    pct => {
      progressWrap.classList.remove('hidden');
      progressBar.value = pct;
    },
    result => {
      progressWrap.classList.add('hidden');
      animateBtn.disabled = false;
      frequencies = result;
      const maxCircles = Math.min(500, frequencies.length);
      numCirclesSlider.max = maxCircles;
      numCircles = Math.min(numCircles, maxCircles);
      numCirclesSlider.value = numCircles;
      numCirclesVal.textContent = numCircles;
      showStep('anim');
      startAnimation();
    }
  );
});

backBtn.addEventListener('click', () => {
  stopAnimation();
  showStep('contour');
  setStatus(`Found ${approvedContourPoints.length}-point outline. Happy with it? Click Animate.`);
});

// ─── Contour extraction via OpenCV.js ──────────────────────────────────────

function extractContour(highThreshold = 80) {
  let src, gray, blurred, edges, contours, hierarchy;
  try {
    src       = cv.imread(previewCanvas);
    gray      = new cv.Mat();
    blurred   = new cv.Mat();
    edges     = new cv.Mat();
    contours  = new cv.MatVector();
    hierarchy = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, highThreshold / 2, highThreshold);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    // Pick the longest contour — main subject outline
    let bestIdx = -1, bestLen = 0;
    for (let i = 0; i < contours.size(); i++) {
      const len = contours.get(i).rows;
      if (len > bestLen) { bestLen = len; bestIdx = i; }
    }
    if (bestIdx === -1 || bestLen < 3) return [];

    const contour = contours.get(bestIdx);
    const points = [];
    for (let i = 0; i < contour.rows; i++) {
      points.push({ x: contour.data32S[i * 2], y: contour.data32S[i * 2 + 1] });
    }

    const n = Math.min(points.length, N_MAX);
    const resampled = n < points.length ? resampleEvenly(points, n) : points;
    const cx = resampled.reduce((s, p) => s + p.x, 0) / resampled.length;
    const cy = resampled.reduce((s, p) => s + p.y, 0) / resampled.length;
    return resampled.map(p => ({ x: p.x - cx, y: p.y - cy }));

  } finally {
    src?.delete(); gray?.delete(); blurred?.delete();
    edges?.delete(); contours?.delete(); hierarchy?.delete();
  }
}

function resampleEvenly(path, n) {
  if (path.length <= n) return path;
  const result = [];
  const step = path.length / n;
  for (let i = 0; i < n; i++) result.push(path[Math.floor(i * step)]);
  return result;
}

// ─── Fourier Transform (async Web Worker via Blob URL) ────────────────────

const DFT_WORKER_SRC = `
self.onmessage = function(e) {
  const pts = e.data;
  const N = pts.length;
  const TAU = 2 * Math.PI;
  const result = [];
  const reportEvery = Math.max(1, Math.floor(N / 100));
  for (let k = 0; k < N; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const angle = -TAU * k * n / N;
      re += pts[n].x * Math.cos(angle) - pts[n].y * Math.sin(angle);
      im += pts[n].x * Math.sin(angle) + pts[n].y * Math.cos(angle);
    }
    re /= N; im /= N;
    const freq = k <= N / 2 ? k : k - N;
    result.push({ freq, amp: Math.sqrt(re * re + im * im), phase: Math.atan2(im, re) });
    if (k % reportEvery === 0) self.postMessage({ type: 'progress', pct: Math.round(k / N * 100) });
  }
  result.sort((a, b) => b.amp - a.amp);
  self.postMessage({ type: 'done', result });
};
`;

function computeDFTAsync(points, onProgress, onDone) {
  if (dftWorker) { dftWorker.terminate(); dftWorker = null; }
  const blob = new Blob([DFT_WORKER_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  dftWorker = new Worker(url);
  URL.revokeObjectURL(url);
  dftWorker.onmessage = e => {
    if (e.data.type === 'progress') {
      onProgress(e.data.pct);
    } else {
      dftWorker.terminate();
      dftWorker = null;
      onDone(e.data.result);
    }
  };
  dftWorker.postMessage(points);
}

// ─── Animation ─────────────────────────────────────────────────────────────

startBtn.addEventListener('click', startAnimation);
resetBtn.addEventListener('click', () => {
  stopAnimation();
  animCtx.fillStyle = '#0d0d1a';
  animCtx.fillRect(0, 0, canvasW, canvasH);
  startBtn.disabled = false;
  resetBtn.disabled = true;
  setStatus('Ready — click Start to animate.');
});

numCirclesSlider.addEventListener('input', e => {
  numCircles = parseInt(e.target.value);
  numCirclesVal.textContent = numCircles;
});
speedSlider.addEventListener('input', e => {
  speed = parseFloat(e.target.value);
  speedVal.textContent = speed + 'x';
});

function startAnimation() {
  if (animationId) return;

  animCanvas.width = canvasW; animCanvas.height = canvasH;
  animCtx.fillStyle = '#0d0d1a';
  animCtx.fillRect(0, 0, canvasW, canvasH);

  const N = frequencies.length;
  const cx = canvasW / 2, cy = canvasH / 2;
  const active = frequencies.slice(0, Math.min(numCircles, N));

  // Pre-compute all N+1 path points (last == first by DFT periodicity)
  precomputedPath = [];
  for (let i = 0; i <= N; i++) {
    const t = (2 * Math.PI * i) / N;
    let x = cx, y = cy;
    for (const f of active) {
      x += f.amp * Math.cos(f.freq * t + f.phase);
      y += f.amp * Math.sin(f.freq * t + f.phase);
    }
    precomputedPath.push({ x, y, t });
  }

  animFrame = 0;
  stepsAccumulator = 0;
  startBtn.disabled = true;
  resetBtn.disabled = false;
  setStatus('Animating…');
  drawFrame();
}

function stopAnimation() {
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
  precomputedPath = [];
  animFrame = 0;
  startBtn.disabled = false;
  resetBtn.disabled = true;
}

function drawFrame() {
  const total = precomputedPath.length;
  const active = frequencies.slice(0, Math.min(numCircles, frequencies.length));

  // Advance frame — ~300 frames per cycle at speed=1
  stepsAccumulator += (total / 300) * speed;
  const steps = Math.floor(stepsAccumulator);
  stepsAccumulator -= steps;
  animFrame = Math.min(animFrame + steps, total - 1);
  const done = animFrame >= total - 1;

  animCtx.fillStyle = '#0d0d1a';
  animCtx.fillRect(0, 0, canvasW, canvasH);

  // Revealed path
  if (animFrame > 0) {
    animCtx.beginPath();
    animCtx.moveTo(precomputedPath[0].x, precomputedPath[0].y);
    for (let i = 1; i <= animFrame; i++) animCtx.lineTo(precomputedPath[i].x, precomputedPath[i].y);
    animCtx.strokeStyle = '#ff6b6b';
    animCtx.lineWidth = 1.5;
    animCtx.stroke();
  }

  // Epicycle chain
  if (!done) {
    const t = precomputedPath[animFrame].t;
    let x = canvasW / 2, y = canvasH / 2;
    for (const f of active) {
      const prevX = x, prevY = y;
      x += f.amp * Math.cos(f.freq * t + f.phase);
      y += f.amp * Math.sin(f.freq * t + f.phase);
      if (f.amp > 1) {
        animCtx.beginPath();
        animCtx.arc(prevX, prevY, f.amp, 0, 2 * Math.PI);
        animCtx.strokeStyle = 'rgba(100, 200, 255, 0.18)';
        animCtx.lineWidth = 0.5;
        animCtx.stroke();
      }
      animCtx.beginPath();
      animCtx.moveTo(prevX, prevY);
      animCtx.lineTo(x, y);
      animCtx.strokeStyle = 'rgba(180, 230, 255, 0.65)';
      animCtx.lineWidth = 1;
      animCtx.stroke();
    }
    animCtx.beginPath();
    animCtx.arc(x, y, 2.5, 0, 2 * Math.PI);
    animCtx.fillStyle = '#ff6b6b';
    animCtx.fill();
  }

  if (!done) {
    animationId = requestAnimationFrame(drawFrame);
  } else {
    animationId = null;
    startBtn.disabled = false;
    setStatus('Done! Click Start to replay or ← to adjust the outline.');
  }
}

// ─── Step visibility ───────────────────────────────────────────────────────

function showStep(step) {
  contourSection.classList.toggle('hidden', step !== 'contour');
  animSection.classList.toggle('hidden', step !== 'anim');
}

function setStatus(msg) { statusEl.textContent = msg; }
