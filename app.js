const MAX_POINTS = 512;
const TARGET_FRAMES = 400; // frames per cycle at speed=1

let animationId = null;
let frequencies = [];
let drawnPath = [];
let timeStep = 0;
let numCircles = 100;
let speed = 1;
let canvasW = 0;
let canvasH = 0;
let dt = 0;

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

  setStatus('Detecting edges...');
  setTimeout(() => {
    const points = extractContour(w, h);
    if (points.length < 3) {
      setStatus('Could not find clear edges. Try a higher-contrast image.');
      return;
    }
    setStatus(`Computing Fourier transform for ${points.length} points...`);
    setTimeout(() => {
      frequencies = computeDFT(points);
      const maxCircles = Math.min(500, frequencies.length);
      numCirclesSlider.max = maxCircles;
      numCircles = Math.min(numCircles, maxCircles);
      numCirclesSlider.value = numCircles;
      numCirclesVal.textContent = numCircles;
      setStatus(`Ready — ${points.length} edge points. Click Start.`);
      startBtn.disabled = false;
    }, 20);
  }, 20);
}

// ─── Image Processing ──────────────────────────────────────────────────────

function extractContour(w, h) {
  const imageData = previewCtx.getImageData(0, 0, w, h);
  const data = imageData.data;

  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  const blurred = gaussianBlur(gray, w, h);
  const mag = sobelMagnitude(blurred, w, h);

  // Threshold to keep roughly 3× MAX_POINTS edge pixels before filtering
  const threshold = adaptiveThreshold(mag, MAX_POINTS * 3);
  const edgeMap = new Uint8Array(w * h);
  for (let i = 0; i < mag.length; i++) edgeMap[i] = mag[i] > threshold ? 1 : 0;

  // Keep only the largest connected blob — drops scattered texture noise
  const component = largestConnectedComponent(edgeMap, w, h);

  const edgePixels = [];
  for (let i = 0; i < w * h; i++) {
    if (component[i]) edgePixels.push({ x: i % w, y: Math.floor(i / w) });
  }
  if (edgePixels.length < 3) return [];

  // Sort by angle around centroid — turns the pixel set into an ordered ring
  const ordered = sortByAngle(edgePixels);
  const resampled = resampleEvenly(ordered, MAX_POINTS);

  // Center at origin
  const cx = resampled.reduce((s, p) => s + p.x, 0) / resampled.length;
  const cy = resampled.reduce((s, p) => s + p.y, 0) / resampled.length;
  return resampled.map(p => ({ x: p.x - cx, y: p.y - cy }));
}

function gaussianBlur(gray, w, h) {
  // 5×5 Gaussian kernel (sigma ≈ 1)
  const k = [1, 4, 6, 4, 1, 4, 16, 24, 16, 4, 6, 24, 36, 24, 6, 4, 16, 24, 16, 4, 1, 4, 6, 4, 1];
  const result = new Float32Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      let sum = 0, ki = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          sum += k[ki++] * gray[(y + dy) * w + (x + dx)];
        }
      }
      result[y * w + x] = sum / 256;
    }
  }
  return result;
}

function sobelMagnitude(gray, w, h) {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -gray[(y - 1) * w + (x - 1)] - 2 * gray[y * w + (x - 1)] - gray[(y + 1) * w + (x - 1)]
        + gray[(y - 1) * w + (x + 1)] + 2 * gray[y * w + (x + 1)] + gray[(y + 1) * w + (x + 1)];
      const gy =
        -gray[(y - 1) * w + (x - 1)] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + (x + 1)]
        + gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)];
      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return mag;
}

// Find threshold such that ~targetCount pixels are above it
function adaptiveThreshold(mag, targetCount) {
  const vals = [];
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] > 0) vals.push(mag[i]);
  }
  if (vals.length === 0) return 0;
  vals.sort((a, b) => a - b);
  const idx = Math.max(0, vals.length - targetCount);
  return vals[idx];
}

// BFS flood-fill — returns a binary map containing only the largest
// 8-connected component of edgeMap, discarding scattered noise pixels.
function largestConnectedComponent(edgeMap, w, h) {
  const visited = new Uint8Array(w * h);
  let bestStart = -1, bestSize = 0;

  for (let i = 0; i < w * h; i++) {
    if (!edgeMap[i] || visited[i]) continue;
    // BFS to measure component size
    const queue = [i];
    visited[i] = 1;
    let size = 0;
    while (queue.length > 0) {
      const idx = queue.pop();
      size++;
      const y = Math.floor(idx / w), x = idx % w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx === 0) continue;
          const ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (edgeMap[ni] && !visited[ni]) { visited[ni] = 1; queue.push(ni); }
        }
      }
    }
    if (size > bestSize) { bestSize = size; bestStart = i; }
  }

  if (bestStart === -1) return new Uint8Array(w * h);

  // Second BFS to collect the winning component
  const result = new Uint8Array(w * h);
  const visited2 = new Uint8Array(w * h);
  const queue = [bestStart];
  visited2[bestStart] = 1;
  while (queue.length > 0) {
    const idx = queue.pop();
    result[idx] = 1;
    const y = Math.floor(idx / w), x = idx % w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dy === 0 && dx === 0) continue;
        const ny = y + dy, nx = x + dx;
        if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
        const ni = ny * w + nx;
        if (edgeMap[ni] && !visited2[ni]) { visited2[ni] = 1; queue.push(ni); }
      }
    }
  }
  return result;
}

// Sort edge pixels by angle from their centroid, turning the pixel set
// into an ordered ring suitable for DFT.
function sortByAngle(points) {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  return [...points].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
}

// Pick N evenly-spaced points from a path array.
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

    // Map k > N/2 to negative frequencies for nicer visualization
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

  timeStep = 0;
  drawnPath = [];
  dt = (2 * Math.PI) / TARGET_FRAMES;

  startBtn.disabled = true;
  resetBtn.disabled = false;
  setStatus('Animating...');

  drawFrame();
}

function drawFrame() {
  const cx = canvasW / 2;
  const cy = canvasH / 2;

  // Clear frame
  animCtx.fillStyle = '#0d0d1a';
  animCtx.fillRect(0, 0, canvasW, canvasH);

  // Draw accumulated path so far
  if (drawnPath.length > 1) {
    animCtx.beginPath();
    animCtx.moveTo(drawnPath[0].x, drawnPath[0].y);
    for (let i = 1; i < drawnPath.length; i++) {
      animCtx.lineTo(drawnPath[i].x, drawnPath[i].y);
    }
    animCtx.strokeStyle = '#ff6b6b';
    animCtx.lineWidth = 1.5;
    animCtx.stroke();
  }

  // Draw epicycles
  const active = frequencies.slice(0, Math.min(numCircles, frequencies.length));
  let x = cx, y = cy;

  for (const f of active) {
    const prevX = x, prevY = y;
    const angle = f.freq * timeStep + f.phase;
    x += f.amp * Math.cos(angle);
    y += f.amp * Math.sin(angle);

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

  // Dot at tip
  animCtx.beginPath();
  animCtx.arc(x, y, 2.5, 0, 2 * Math.PI);
  animCtx.fillStyle = '#ff6b6b';
  animCtx.fill();

  drawnPath.push({ x, y });
  timeStep += dt * speed;

  if (timeStep < 2 * Math.PI) {
    animationId = requestAnimationFrame(drawFrame);
  } else {
    // Close and finalize the path
    animCtx.fillStyle = '#0d0d1a';
    animCtx.fillRect(0, 0, canvasW, canvasH);
    animCtx.beginPath();
    animCtx.moveTo(drawnPath[0].x, drawnPath[0].y);
    for (let i = 1; i < drawnPath.length; i++) {
      animCtx.lineTo(drawnPath[i].x, drawnPath[i].y);
    }
    animCtx.closePath();
    animCtx.strokeStyle = '#ff6b6b';
    animCtx.lineWidth = 1.5;
    animCtx.stroke();

    animationId = null;
    startBtn.disabled = false;
    setStatus('Done! Adjust circles or speed and click Start to replay.');
  }
}

function resetAnimation() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  drawnPath = [];
  timeStep = 0;
  animCtx.fillStyle = '#0d0d1a';
  animCtx.fillRect(0, 0, canvasW, canvasH);
  startBtn.disabled = false;
  resetBtn.disabled = true;
  setStatus('Ready — click Start to animate.');
}

function setStatus(msg) {
  statusEl.textContent = msg;
}
