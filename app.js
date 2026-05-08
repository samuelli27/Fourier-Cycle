const N_MAX = 30000; // total point budget across all contours; worst-case ~36s DFT

let cvReady = false;
let animationId = null;
let allFrequencies = [];        // array of sorted freq arrays, one per contour
let approvedContourPoints = []; // array of point arrays (canvas-centered), one per contour
let allPaths = [];              // array of precomputed path arrays
let animFrame = 0;
let stepsAccumulator = 0;
let numCircles = 100;
let speed = 1;
let canvasW = 0;
let canvasH = 0;
let cannyThreshold = 80;

let dftWorker = null;

const ANIM_STEPS = 600; // unified path resolution across all contours

// Color palette — one hue per contour for paths and epicycles
const PALETTE = [
  { hex: '#ff6b6b', rgb: [255, 107, 107] },
  { hex: '#ffd93d', rgb: [255, 217,  61] },
  { hex: '#6bff9f', rgb: [ 107, 255, 159] },
  { hex: '#6b9fff', rgb: [ 107, 159, 255] },
  { hex: '#ff9f6b', rgb: [255, 159, 107] },
  { hex: '#d86bff', rgb: [216, 107, 255] },
  { hex: '#ff6bd8', rgb: [255, 107, 216] },
  { hex: '#9fff6b', rgb: [159, 255, 107] },
];

// DOM
const uploadZone     = document.getElementById('upload-zone');
const fileInput      = document.getElementById('file-input');
const statusEl       = document.getElementById('status');
const contourSection = document.getElementById('contour-section');
const animSection    = document.getElementById('anim-section');
const previewCanvas  = document.getElementById('preview-canvas');
const contourCanvas  = document.getElementById('contour-canvas');
const originalCanvas = document.getElementById('original-canvas');
const animCanvas     = document.getElementById('anim-canvas');
const previewCtx     = previewCanvas.getContext('2d');
const contourCtx     = contourCanvas.getContext('2d');
const originalCtx    = originalCanvas.getContext('2d');
const animCtx        = animCanvas.getContext('2d');
const cannySlider    = document.getElementById('canny-slider');
const cannyVal       = document.getElementById('canny-val');
const progressBar    = document.getElementById('dft-progress');
const progressWrap   = document.getElementById('dft-progress-wrap');
const animateBtn     = document.getElementById('animate-btn');
const backBtn        = document.getElementById('back-btn');
const startBtn       = document.getElementById('start-btn');
const resetBtn       = document.getElementById('reset-btn');
const numCirclesSlider = document.getElementById('num-circles');
const speedSlider    = document.getElementById('speed');
const numCirclesVal  = document.getElementById('num-circles-val');
const speedVal       = document.getElementById('speed-val');

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

  previewCanvas.width = w;  previewCanvas.height = h;
  previewCtx.drawImage(img, 0, 0, w, h);

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
  setStatus('Detecting outlines…');
  setTimeout(() => {
    const contours = extractContours(cannyThreshold);
    const totalPts = contours.reduce((s, c) => s + c.length, 0);
    if (totalPts < 3) {
      setStatus('No clear outline found — try lowering edge sensitivity.');
      drawContourPreview([]);
      showStep('contour');
      return;
    }
    approvedContourPoints = contours;
    drawContourPreview(contours);
    showStep('contour');
    const desc = contours.length === 1
      ? `Found ${contours[0].length}-point outline.`
      : `Found ${contours.length} outlines (${totalPts} pts total).`;
    setStatus(`${desc} Happy with it? Click Animate.`);
  }, 20);
}

function drawContourPreview(contours) {
  contourCanvas.width = canvasW;
  contourCanvas.height = canvasH;

  contourCtx.fillStyle = '#0d0d1a';
  contourCtx.fillRect(0, 0, canvasW, canvasH);

  contourCtx.globalAlpha = 0.25;
  contourCtx.drawImage(previewCanvas, 0, 0);
  contourCtx.globalAlpha = 1;

  const ox = canvasW / 2, oy = canvasH / 2;
  contours.forEach((pts, ci) => {
    if (pts.length < 2) return;
    contourCtx.beginPath();
    contourCtx.moveTo(pts[0].x + ox, pts[0].y + oy);
    for (let i = 1; i < pts.length; i++) contourCtx.lineTo(pts[i].x + ox, pts[i].y + oy);
    contourCtx.closePath();
    contourCtx.strokeStyle = PALETTE[ci % PALETTE.length].hex;
    contourCtx.lineWidth = 1.5;
    contourCtx.stroke();
  });
}

animateBtn.addEventListener('click', () => {
  if (!approvedContourPoints.length) return;
  const totalPts = approvedContourPoints.reduce((s, c) => s + c.length, 0);
  // Estimate: worst case is all pts in one contour → N²/25M ops per sec
  const estSec = Math.round(totalPts * totalPts / 25000000);
  setStatus(`Computing Fourier transforms (${totalPts} pts, ~${estSec < 1 ? '<1' : estSec}s)…`);
  animateBtn.disabled = true;

  computeDFTAsync(approvedContourPoints,
    pct => {
      progressWrap.classList.remove('hidden');
      progressBar.value = pct;
    },
    result => {
      progressWrap.classList.add('hidden');
      animateBtn.disabled = false;
      allFrequencies = result;
      const maxCircles = Math.min(500, Math.max(...result.map(r => r.length)));
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
  const totalPts = approvedContourPoints.reduce((s, c) => s + c.length, 0);
  const desc = approvedContourPoints.length === 1
    ? `Found ${approvedContourPoints[0].length}-point outline.`
    : `Found ${approvedContourPoints.length} outlines (${totalPts} pts total).`;
  setStatus(`${desc} Happy with it? Click Animate.`);
});

// ─── Contour extraction via OpenCV.js ──────────────────────────────────────

function extractContours(highThreshold = 80) {
  let src, gray, blurred, edges, contoursMat, hierarchy;
  try {
    src        = cv.imread(previewCanvas);
    gray       = new cv.Mat();
    blurred    = new cv.Mat();
    edges      = new cv.Mat();
    contoursMat = new cv.MatVector();
    hierarchy  = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, highThreshold / 2, highThreshold);
    // RETR_LIST retrieves all contours including internal ones
    cv.findContours(edges, contoursMat, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);

    const MIN_LEN = 20;
    const MAX_CONTOURS = 8;

    // Collect and rank by length
    const candidates = [];
    for (let i = 0; i < contoursMat.size(); i++) {
      const len = contoursMat.get(i).rows;
      if (len >= MIN_LEN) candidates.push({ i, len });
    }
    candidates.sort((a, b) => b.len - a.len);
    const selected = candidates.slice(0, MAX_CONTOURS);
    if (!selected.length) return [];

    // Split N_MAX budget proportionally by contour length
    const totalLen = selected.reduce((s, c) => s + c.len, 0);
    const ox = canvasW / 2, oy = canvasH / 2;

    return selected.map(({ i, len }) => {
      const c = contoursMat.get(i);
      const raw = [];
      for (let j = 0; j < c.rows; j++) {
        // Subtract canvas center so each contour keeps its relative position
        raw.push({ x: c.data32S[j * 2] - ox, y: c.data32S[j * 2 + 1] - oy });
      }
      const n = totalLen <= N_MAX
        ? len
        : Math.max(MIN_LEN, Math.floor(N_MAX * len / totalLen));
      return n < raw.length ? resampleEvenly(raw, n) : raw;
    });

  } finally {
    src?.delete(); gray?.delete(); blurred?.delete();
    edges?.delete(); contoursMat?.delete(); hierarchy?.delete();
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
  const allContours = e.data; // array of point arrays
  const TAU = 2 * Math.PI;
  let totalPts = 0;
  for (const c of allContours) totalPts += c.length;
  let donePts = 0;

  const results = [];
  for (const pts of allContours) {
    const N = pts.length;
    const reportEvery = Math.max(1, Math.floor(N / 50));
    const freqs = [];
    for (let k = 0; k < N; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const angle = -TAU * k * n / N;
        re += pts[n].x * Math.cos(angle) - pts[n].y * Math.sin(angle);
        im += pts[n].x * Math.sin(angle) + pts[n].y * Math.cos(angle);
      }
      re /= N; im /= N;
      const freq = k <= N / 2 ? k : k - N;
      freqs.push({ freq, amp: Math.sqrt(re * re + im * im), phase: Math.atan2(im, re) });
      if (k % reportEvery === 0) {
        self.postMessage({ type: 'progress', pct: Math.round((donePts + k) / totalPts * 100) });
      }
    }
    freqs.sort((a, b) => b.amp - a.amp);
    results.push(freqs);
    donePts += N;
  }
  self.postMessage({ type: 'done', result: results });
};
`;

function computeDFTAsync(contours, onProgress, onDone) {
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
  dftWorker.postMessage(contours);
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

  const ox = canvasW / 2, oy = canvasH / 2;

  // Pre-compute ANIM_STEPS+1 path points per contour using current numCircles
  allPaths = allFrequencies.map(freqs => {
    const active = freqs.slice(0, Math.min(numCircles, freqs.length));
    const path = [];
    for (let i = 0; i <= ANIM_STEPS; i++) {
      const t = (2 * Math.PI * i) / ANIM_STEPS;
      let x = ox, y = oy;
      for (const f of active) {
        x += f.amp * Math.cos(f.freq * t + f.phase);
        y += f.amp * Math.sin(f.freq * t + f.phase);
      }
      path.push({ x, y, t });
    }
    return path;
  });

  animFrame = 0;
  stepsAccumulator = 0;
  startBtn.disabled = true;
  resetBtn.disabled = false;
  setStatus('Animating…');
  drawFrame();
}

function stopAnimation() {
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
  allPaths = [];
  animFrame = 0;
  startBtn.disabled = false;
  resetBtn.disabled = true;
}

function drawFrame() {
  const total = ANIM_STEPS + 1;

  stepsAccumulator += (total / 300) * speed;
  const steps = Math.floor(stepsAccumulator);
  stepsAccumulator -= steps;
  animFrame = Math.min(animFrame + steps, total - 1);
  const done = animFrame >= total - 1;

  animCtx.fillStyle = '#0d0d1a';
  animCtx.fillRect(0, 0, canvasW, canvasH);

  allPaths.forEach((path, ci) => {
    const { hex, rgb } = PALETTE[ci % PALETTE.length];
    const [r, g, b] = rgb;

    // Revealed path so far
    if (animFrame > 0) {
      animCtx.beginPath();
      animCtx.moveTo(path[0].x, path[0].y);
      for (let i = 1; i <= animFrame; i++) animCtx.lineTo(path[i].x, path[i].y);
      animCtx.strokeStyle = hex;
      animCtx.lineWidth = 1.5;
      animCtx.stroke();
    }

    // Epicycle chain (only while still drawing)
    if (!done) {
      const freqs = allFrequencies[ci];
      const active = freqs.slice(0, Math.min(numCircles, freqs.length));
      const t = path[animFrame].t;
      let x = canvasW / 2, y = canvasH / 2;
      for (const f of active) {
        const prevX = x, prevY = y;
        x += f.amp * Math.cos(f.freq * t + f.phase);
        y += f.amp * Math.sin(f.freq * t + f.phase);
        if (f.amp > 1) {
          animCtx.beginPath();
          animCtx.arc(prevX, prevY, f.amp, 0, 2 * Math.PI);
          animCtx.strokeStyle = `rgba(${r},${g},${b},0.15)`;
          animCtx.lineWidth = 0.5;
          animCtx.stroke();
        }
        animCtx.beginPath();
        animCtx.moveTo(prevX, prevY);
        animCtx.lineTo(x, y);
        animCtx.strokeStyle = `rgba(${r},${g},${b},0.65)`;
        animCtx.lineWidth = 1;
        animCtx.stroke();
      }
      animCtx.beginPath();
      animCtx.arc(x, y, 2.5, 0, 2 * Math.PI);
      animCtx.fillStyle = hex;
      animCtx.fill();
    }
  });

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
