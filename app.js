const MAX_POINTS = 512;

let cvReady = false;
let animationId = null;
let frequencies = [];
let precomputedPath = []; // all path points computed upfront
let animFrame = 0;        // index into precomputedPath
let stepsAccumulator = 0;
let numCircles = 100;
let speed = 1;
let canvasW = 0;
let canvasH = 0;

const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
const previewCanvas = document.getElementById('preview-canvas');
const animCanvas = document.getElementById('anim-canvas');
const previewCtx = previewCanvas.getContext('2d');
const animCtx = animCanvas.getContext('2d');
const statusEl = document.getElementById('status');
const numCirclesSlider = document.getElementById('num-circles');
const speedSlider = document.getElementById('speed');
const numCirclesVal = document.getElementById('num-circles-val');
const speedVal = document.getElementById('speed-val');
const startBtn = document.getElementById('start-btn');
const resetBtn = document.getElementById('reset-btn');

// Called by the opencv.js onload attribute
function onOpenCvReady() {
  cvReady = true;
  setStatus('Ready — upload an image to begin.');
}

setStatus('Loading OpenCV.js…');

uploadZone.addEventListener('click', () => fileInput.click());
uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) handleFile(file);
});
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

numCirclesSlider.addEventListener('input', e => {
  numCircles = parseInt(e.target.value);
  numCirclesVal.textContent = numCircles;
});

speedSlider.addEventListener('input', e => {
  speed = parseFloat(e.target.value);
  speedVal.textContent = speed + 'x';
});

startBtn.addEventListener('click', startAnimation);
resetBtn.addEventListener('click', resetAnimation);

function handleFile(file) {
  if (!cvReady) { setStatus('Still loading OpenCV.js — please wait a moment.'); return; }
  resetAnimation();
  startBtn.disabled = true;
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
  canvasW = w;
  canvasH = h;
  previewCanvas.width = w;
  previewCanvas.height = h;
  previewCtx.drawImage(img, 0, 0, w, h);

  setStatus('Detecting contour…');
  setTimeout(() => {
    const points = extractContour();
    if (points.length < 3) {
      setStatus('No clear contour found. Try a higher-contrast image.');
      return;
    }
    setStatus(`Computing DFT for ${points.length} points…`);
    setTimeout(() => {
      frequencies = computeDFT(points);
      const maxCircles = Math.min(500, frequencies.length);
      numCirclesSlider.max = maxCircles;
      numCircles = Math.min(numCircles, maxCircles);
      numCirclesSlider.value = numCircles;
      numCirclesVal.textContent = numCircles;
      setStatus(`Ready — ${points.length} contour points. Click Start.`);
      startBtn.disabled = false;
    }, 20);
  }, 20);
}

// ─── Contour extraction via OpenCV.js ──────────────────────────────────────

function extractContour() {
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
    cv.Canny(blurred, edges, 50, 150);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    // Pick the longest contour — that's the main subject outline
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

    const resampled = resampleEvenly(points, MAX_POINTS);
    const cx = resampled.reduce((s, p) => s + p.x, 0) / resampled.length;
    const cy = resampled.reduce((s, p) => s + p.y, 0) / resampled.length;
    return resampled.map(p => ({ x: p.x - cx, y: p.y - cy }));

  } finally {
    src?.delete();
    gray?.delete();
    blurred?.delete();
    edges?.delete();
    contours?.delete();
    hierarchy?.delete();
  }
}

// Pick n evenly-spaced points from an ordered path array
function resampleEvenly(path, n) {
  if (path.length <= n) return path;
  const result = [];
  const step = path.length / n;
  for (let i = 0; i < n; i++) result.push(path[Math.floor(i * step)]);
  return result;
}

// ─── Fourier Transform ─────────────────────────────────────────────────────

function computeDFT(points) {
  const N = points.length;
  const result = [];

  for (let k = 0; k < N; k++) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const angle = -2 * Math.PI * k * n / N;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      re += points[n].x * cos - points[n].y * sin;
      im += points[n].x * sin + points[n].y * cos;
    }
    re /= N;
    im /= N;

    // Map k > N/2 to negative frequencies for a nicer visual (slow circles first)
    const freq = k <= N / 2 ? k : k - N;

    result.push({
      freq,
      amp: Math.sqrt(re * re + im * im),
      phase: Math.atan2(im, re),
    });
  }

  result.sort((a, b) => b.amp - a.amp);
  return result;
}

// ─── Animation ─────────────────────────────────────────────────────────────

function startAnimation() {
  if (animationId) return;

  animCanvas.width = canvasW;
  animCanvas.height = canvasH;
  animCtx.fillStyle = '#0d0d1a';
  animCtx.fillRect(0, 0, canvasW, canvasH);

  // Pre-compute every point on the path before animation starts.
  // N+1 samples: t = 0, 2π/N, 4π/N, ..., 2π  (last == first by DFT periodicity).
  const N = frequencies.length;
  const cx = canvasW / 2, cy = canvasH / 2;
  const active = frequencies.slice(0, Math.min(numCircles, N));
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

function drawFrame() {
  const total = precomputedPath.length; // N+1
  const active = frequencies.slice(0, Math.min(numCircles, frequencies.length));

  // Advance frame counter. Base rate: ~300 frames per full cycle at speed=1.
  stepsAccumulator += (total / 300) * speed;
  const steps = Math.floor(stepsAccumulator);
  stepsAccumulator -= steps;
  animFrame = Math.min(animFrame + steps, total - 1);

  const done = animFrame >= total - 1;

  // Clear
  animCtx.fillStyle = '#0d0d1a';
  animCtx.fillRect(0, 0, canvasW, canvasH);

  // Draw the revealed portion of the path
  if (animFrame > 0) {
    animCtx.beginPath();
    animCtx.moveTo(precomputedPath[0].x, precomputedPath[0].y);
    for (let i = 1; i <= animFrame; i++) {
      animCtx.lineTo(precomputedPath[i].x, precomputedPath[i].y);
    }
    animCtx.strokeStyle = '#ff6b6b';
    animCtx.lineWidth = 1.5;
    animCtx.stroke();
  }

  // Draw epicycle chain at the current tip
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
    setStatus('Done! Adjust circles or speed and click Start to replay.');
  }
}

function resetAnimation() {
  if (animationId) { cancelAnimationFrame(animationId); animationId = null; }
  precomputedPath = [];
  animFrame = 0;
  animCtx.fillStyle = '#0d0d1a';
  animCtx.fillRect(0, 0, canvasW, canvasH);
  startBtn.disabled = false;
  resetBtn.disabled = true;
  setStatus('Ready — click Start to animate.');
}

function setStatus(msg) {
  statusEl.textContent = msg;
}
