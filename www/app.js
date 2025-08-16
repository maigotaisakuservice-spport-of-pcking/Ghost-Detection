/* =========================================================================
  幽霊検知システム — Cordova最強完全版 app.js
  対応プラグイン（推奨）
    - cordova-plugin-android-permissions
    - cordova-plugin-camera-preview
    - cordova-plugin-device-motion
    - cordova-plugin-file
    - cordova-plugin-vibration
    - cordova-plugin-flashlight
    - cordova-plugin-network-information
    - cordova-plugin-background-mode
    - (その他: cordova-plugin-battery-status, cordova-plugin-geolocation ...)
  概要：
    - 起動毎にネイティブ権限を要求（Android）／ユーザー操作でiOSのDeviceMotion権限を要求
    - CameraPreviewを優先、なければ getUserMedia にフォールバック
    - p5.FFT で音声解析
    - coco-ssd で物体検知（person/chair/table以外をUNKNOWNに扱う）
    - 残像解析（フレーム差分）・光量急変検知・シルエット追跡・軌跡可視化
    - Canvas録画（軌跡付き） & 緊急録画ボタン
    - 加速度/ジャイロ（Cordova accelerometer or DeviceMotion）ON/OFF
    - 自動復旧（heartbeat）、ログ収集、ZIPダウンロード（JSZip利用）
  注意:
    - index.html に記載の要素ID（startBtn, videoElem, videoCanvas, overlayCanvas, ...）を前提
    - 実機で動かす前に必ず Info.plist / AndroidManifest に必要説明と権限を追加
  ======================================================================== */

'use strict';

/* ---------------- DOM参照 ---------------- */
const startBtn = document.getElementById('startBtn');
const restartBtn = document.getElementById('restartBtn');
const emergencyBtn = document.getElementById('emergencyBtn');
const markerToggle = document.getElementById('markerToggle');
const motionToggle = document.getElementById('motionToggle');
const audioToggle = document.getElementById('audioToggle');
const modeSelect = document.getElementById('modeSelect');
const sensitivityRange = document.getElementById('sensitivityRange');
const lumRange = document.getElementById('lumRange');
const downloadLogsBtn = document.getElementById('downloadLogs');
const statusText = document.getElementById('statusText');
const logEl = document.getElementById('log');

const videoElem = document.getElementById('videoElem');
const videoCanvas = document.getElementById('videoCanvas');
const overlayCanvas = document.getElementById('overlayCanvas');
const alertOverlay = document.getElementById('alertOverlay');

const vctx = videoCanvas.getContext('2d', { willReadFrequently: true });
const octx = overlayCanvas.getContext('2d', { willReadFrequently: true });

/* ---------------- 状態 ---------------- */
let usingCameraPreview = false;
let videoStream = null;
let audioCtx = null;
let micSource = null;
let fft = null;
let mediaRecorder = null;       // raw stream recorder (optional)
let canvasRecorder = null;      // for trajectory recordings
let recordedChunks = [];

let cocoModel = null;
let prevFrames = [];
const maxHistory = 6;
let ghostTrails = [];
const maxTrails = 12;

let logs = [];
let heartbeat = true;
let processing = false;
let cameraPreviewInterval = null;

/* ---------------- ユーティリティ ---------------- */
function log(msg) {
  const t = new Date().toISOString();
  logs.push({ time: t, msg });
  if (logEl) {
    logEl.innerText = logs.slice(-200).map(l => `[${l.time}] ${l.msg}`).reverse().join('\n');
  }
  console.log(`[${t}] ${msg}`);
}
function updateStatus(msg) {
  if (statusText) statusText.innerText = msg;
  log(msg);
}
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- Cordova 権限 （毎回要求） ---------------- */
function requestCordovaPermissionsEveryTime() {
  return new Promise((resolve, reject) => {
    try {
      const perms = window.cordova?.plugins?.permissions;
      if (!perms) {
        log('cordova-permissions plugin not found; skipping native permission flow.');
        return resolve();
      }
      const required = [perms.CAMERA, perms.RECORD_AUDIO];
      perms.requestPermissions(required,
        status => {
          if (status && status.hasPermission) {
            log('Permissions granted (Cordova)');
            resolve();
          } else {
            log('Permissions denied (Cordova)');
            reject(new Error('PERMISSION_DENIED'));
          }
        },
        err => {
          console.warn('requestPermissions error', err);
          reject(err);
        });
    } catch (e) {
      console.warn('requestCordovaPermissionsEveryTime fallback', e);
      resolve();
    }
  });
}

/* ---------------- Camera 起動 ---------------- */
async function startCameraViaGetUserMedia() {
  updateStatus('Starting camera via getUserMedia...');
  const constraints = {
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  videoElem.srcObject = stream;
  videoStream = stream;

  try {
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.start();
  } catch (e) {
    console.warn('MediaRecorder not available for raw stream', e);
  }

  return stream;
}

function startCameraViaCameraPreview() {
  if (!window.CameraPreview) throw new Error('CameraPreview plugin not installed');
  usingCameraPreview = true;
  updateStatus('Starting native CameraPreview...');
  CameraPreview.startCamera({
    x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
    camera: CameraPreview.CAMERA_DIRECTION.BACK,
    toBack: true, tapPhoto: false, previewDrag: false, alpha: 1
  });
  // We'll snapshot periodically into canvas
  if (cameraPreviewInterval) clearInterval(cameraPreviewInterval);
  cameraPreviewInterval = setInterval(() => {
    CameraPreview.takeSnapshot({ quality: 70 }, (base64) => {
      drawBase64ToCanvas(base64, videoCanvas, vctx);
    }, err => { /* ignore snapshot errors */ });
  }, 120); // ~8-10fps snapshot - adjust if needed
}
function drawBase64ToCanvas(base64, canvas, ctx) {
  const img = new Image();
  img.onload = () => {
    canvas.width = img.width; canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
  };
  img.onerror = e => console.warn('snapshot image load error', e);
  img.src = 'data:image/jpeg;base64,' + base64;
}

/* ---------------- Audio(p5.FFT) セットアップ ---------------- */
async function setupAudioFromStream(stream) {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    micSource = audioCtx.createMediaStreamSource(stream);
    // Use p5.FFT for convenience (p5 must be loaded)
    fft = new p5.FFT();
    fft.setInput(micSource);
    log('Audio FFT ready');
  } catch (e) {
    console.error('Audio setup failed', e);
    updateStatus('ERROR: Audio init failed');
  }
}

/* ---------------- TensorFlow (coco-ssd) ---------------- */
async function loadCocoModel() {
  updateStatus('Loading coco-ssd model...');
  cocoModel = await cocoSsd.load();
  updateStatus('Model loaded');
}

/* ---------------- 残像・差分・軌跡ロジック ---------------- */
function computeDiffPositions(currData, prevData, width, height, sensitivity) {
  const diffs = [];
  const len = currData.length;
  for (let i = 0; i < len; i += 4) {
    const dr = Math.abs(currData[i] - prevData[i]);
    const dg = Math.abs(currData[i + 1] - prevData[i + 1]);
    const db = Math.abs(currData[i + 2] - prevData[i + 2]);
    const delta = dr + dg + db;
    if (delta > sensitivity) {
      const idx = i / 4;
      const x = idx % width;
      const y = Math.floor(idx / width);
      diffs.push({ x, y });
    }
  }
  return diffs;
}
function drawGhostTrails(diffPositions) {
  if (!diffPositions.length) return;
  ghostTrails.push(diffPositions);
  if (ghostTrails.length > maxTrails) ghostTrails.shift();

  // semi-transparent overlay to keep history
  octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  octx.strokeStyle = '#00ff66';
  octx.lineWidth = 2;
  ghostTrails.forEach(trail => {
    octx.beginPath();
    // sample trail to avoid huge paths
    const step = Math.max(1, Math.floor(trail.length / 60));
    for (let i = 0; i < trail.length; i += step) {
      const p = trail[i];
      if (i === 0) octx.moveTo(p.x, p.y);
      else octx.lineTo(p.x, p.y);
    }
    octx.stroke();
  });
}

/* ---------------- 光量急変 ---------------- */
function computeAverageLuminance(data) {
  let sum = 0;
  const pixels = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 709
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return sum / pixels;
}

/* ---------------- アラート演出 ---------------- */
let alertTimeout = null;
function triggerAlert(msg) {
  updateStatus(msg);
  alertOverlay.style.display = 'block';
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (alertTimeout) clearTimeout(alertTimeout);
  alertTimeout = setTimeout(() => {
    alertOverlay.style.display = 'none';
    updateStatus('AWAITING ANOMALY...');
  }, 2000);
  logs.push({ time: new Date().toISOString(), event: msg });
}

/* ---------------- Canvas 録画（軌跡付き） ---------------- */
function startCanvasRecordingFor(durationMs = 10000) {
  try {
    const stream = videoCanvas.captureStream(30);
    canvasRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
    const chunks = [];
    canvasRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    canvasRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      saveBlob(blob, `ghost_trail_${Date.now()}.webm`);
    };
    canvasRecorder.start();
    log('Canvas recorder started');
    setTimeout(() => {
      if (canvasRecorder && canvasRecorder.state === 'recording') canvasRecorder.stop();
    }, durationMs);
  } catch (e) {
    console.warn('Canvas recording not supported', e);
    updateStatus('ERROR: Canvas recording not supported');
  }
}

/* ---------------- coco-ssd 実行 ---------------- */
async function runCocoDetection(inputEl) {
  if (!cocoModel) return;
  try {
    const preds = await cocoModel.detect(inputEl);
    // draw boxes
    const ctx = octx;
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    ctx.strokeStyle = '#00ff66';
    ctx.lineWidth = 2;
    ctx.font = '16px monospace';
    preds.forEach(p => {
      const [x, y, w, h] = p.bbox;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = '#00ff66';
      ctx.fillText(`${p.class} ${(p.score * 100 | 0)}%`, x, y > 10 ? y - 6 : 10);
    });
    const unknown = preds.find(p => !['person', 'chair', 'table'].includes(p.class) && p.score > 0.45);
    if (unknown) {
      triggerAlert('UNKNOWN ENTITY DETECTED');
      log(`Unknown object: ${unknown.class} (${(unknown.score*100|0)}%)`);
    }
  } catch (e) {
    console.warn('coco detect error', e);
  }
}

/* ---------------- メインループ ---------------- */
function renderVideoToCanvasIfNeeded() {
  if (usingCameraPreview) return; // CameraPreview snapshots already copy into canvas
  if (videoElem.readyState >= 2) {
    if (videoCanvas.width !== videoElem.videoWidth || videoCanvas.height !== videoElem.videoHeight) {
      videoCanvas.width = overlayCanvas.width = videoElem.videoWidth;
      videoCanvas.height = overlayCanvas.height = videoElem.videoHeight;
    }
    vctx.drawImage(videoElem, 0, 0, videoCanvas.width, videoCanvas.height);
  }
}

let processingFlag = false;
async function loop() {
  heartbeat = true;
  try {
    renderVideoToCanvasIfNeeded();

    if (videoCanvas.width && videoCanvas.height) {
      const frame = vctx.getImageData(0, 0, videoCanvas.width, videoCanvas.height);
      const data = frame.data;

      // mode visual (infra / nv)
      const mode = modeSelect?.value || 'normal';
      if (mode === 'infra' || mode === 'nv') {
        for (let i = 0; i < data.length; i += 4) {
          const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
          if (mode === 'infra') { data[i] = v; data[i + 1] = v * 0.3; data[i + 2] = 0; }
          else { data[i] = v * 0.5; data[i + 1] = v; data[i + 2] = v * 0.5; }
        }
        vctx.putImageData(frame, 0, 0);
      }

      // luminance spike
      const avgLum = computeAverageLuminance(data);
      const prevLum = prevFrames.length ? computeAverageLuminance(prevFrames[prevFrames.length - 1]) : avgLum;
      const lumDeltaPercent = prevLum ? Math.abs((avgLum - prevLum) / prevLum) * 100 : 0;
      if (lumDeltaPercent > Number(lumRange.value)) {
        triggerAlert('LUMINANCE SPIKE DETECTED');
      }

      prevFrames.push(new Uint8ClampedArray(data));
      if (prevFrames.length > maxHistory) prevFrames.shift();

      // difference -> trajectories
      if (prevFrames.length >= 2) {
        const prev = prevFrames[prevFrames.length - 2];
        const sensitivity = Number(sensitivityRange.value);
        const diffs = computeDiffPositions(data, prev, videoCanvas.width, videoCanvas.height, sensitivity);
        if (diffs.length) {
          drawGhostTrails(diffs);
          if (mode === 'ghost') {
            const motionRatio = diffs.length / (data.length / 4);
            if (motionRatio > 0.02) triggerAlert('GHOST-LIKE MOTION DETECTED');
          }
        }
      }

      // audio visual + detection
      if (audioToggle && audioToggle.checked && fft) {
        const spectrum = fft.analyze();
        const peak = Math.max(...spectrum);
        if (peak > 250) triggerAlert('AUDIO PEAK / DISTRESS');
        // draw mini visualizer on overlay
        octx.fillStyle = 'rgba(0,0,0,0.16)';
        octx.fillRect(0, 0, overlayCanvas.width, 40);
        octx.fillStyle = '#00ff66';
        for (let i = 0; i < Math.min(spectrum.length, overlayCanvas.width); i += Math.ceil(spectrum.length / overlayCanvas.width)) {
          const h = (spectrum[i] / 255) * 30;
          octx.fillRect(i, 30 - h, 2, h);
        }
      }

      // coco detection throttled
      if (cocoModel && !processingFlag) {
        processingFlag = true;
        const inputForModel = (usingCameraPreview || videoElem.readyState < 2) ? videoCanvas : videoElem;
        runCocoDetection(inputForModel).finally(() => { processingFlag = false; });
      }
    }
  } catch (e) {
    console.error('Loop error', e);
  } finally {
    requestAnimationFrame(loop);
  }
}

/* ---------------- DeviceMotion / Accelerometer bridge ---------------- */
function setupDeviceMotionBridge() {
  if (navigator.accelerometer && typeof navigator.accelerometer.watchAcceleration === 'function') {
    navigator.accelerometer.watchAcceleration(acc => {
      if (!motionToggle.checked) return;
      if (Math.abs(acc.x) > 15 || Math.abs(acc.y) > 15 || Math.abs(acc.z) > 15) {
        triggerAlert('DEVICE MOTION ANOMALY DETECTED');
      }
    }, err => console.warn('accelerometer watch err', err), { frequency: 200 });
    log('Cordova accelerometer watch started');
  } else if (window.DeviceMotionEvent) {
    // iOS requires user gesture for requestPermission - handled at start
    window.addEventListener('devicemotion', ev => {
      if (!motionToggle.checked) return;
      const r = ev.rotationRate || {};
      if (Math.abs(r.alpha || 0) > 200 || Math.abs(r.beta || 0) > 200 || Math.abs(r.gamma || 0) > 200) {
        triggerAlert('DEVICE ROTATION ANOMALY DETECTED');
      }
    });
    log('Web DeviceMotion listener added');
  } else {
    log('No device motion available on this platform');
  }
}

/* ---------------- Init media (CameraPreview preferred) ---------------- */
async function initMedia(userGesture = false) {
  // set canvas to window size
  videoCanvas.width = overlayCanvas.width = window.innerWidth;
  videoCanvas.height = overlayCanvas.height = window.innerHeight;

  // Try CameraPreview plugin if available (many WebViews are more stable with native preview)
  if (window.CameraPreview) {
    try {
      startCameraViaCameraPreview();
      // Acquire audio-only stream for FFT
      const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      await setupAudioFromStream(audioOnly);
      return;
    } catch (e) {
      console.warn('CameraPreview failed, falling back to getUserMedia', e);
      usingCameraPreview = false;
    }
  }

  // Fallback: getUserMedia (video+audio)
  const stream = await startCameraViaGetUserMedia();
  await setupAudioFromStream(stream);
}

/* ---------------- Permissions + init flow ---------------- */
async function initApp(requireUserGesture = false) {
  try {
    updateStatus('REQUESTING PERMISSIONS...');
    await requestCordovaPermissionsEveryTime();

    // iOS DeviceMotion permission requires user gesture: attempt if available
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        await DeviceMotionEvent.requestPermission(); // may throw if not allowed
        log('DeviceMotion permission requested');
      } catch (e) {
        log('DeviceMotion requestPermission failed (iOS may require a user gesture)');
      }
    }

    // initialize media (camera + audio)
    await initMedia(requireUserGesture);

    // setup motion bridge
    setupDeviceMotionBridge();

    // load TF model
    await loadCocoModel();

    updateStatus('SYSTEM INITIALIZED');
    requestAnimationFrame(loop);
  } catch (e) {
    console.error('initApp error', e);
    updateStatus('ERROR: INIT FAILED OR PERMISSION DENIED');
  }
}

/* ---------------- Auto-restart heartbeat ---------------- */
setInterval(() => {
  if (!heartbeat) {
    updateStatus('HEARTBEAT LOST - RESTARTING STREAMS...');
    restartStreams();
  }
  heartbeat = false;
}, 2000);

/* ---------------- Download logs (JSZip required in index.html) ---------------- */
async function downloadLogs() {
  if (!window.JSZip) {
    updateStatus('ERROR: JSZip not available');
    return;
  }
  const zip = new JSZip();
  zip.file('logs.json', JSON.stringify(logs, null, 2));
  try {
    const imgData = videoCanvas.toDataURL('image/png');
    zip.file('last_frame.png', imgData.split(',')[1], { base64: true });
  } catch (e) { /* may fail if canvas empty */ }
  const blob = await zip.generateAsync({ type: 'blob' });
  saveBlob(blob, `ghost_logs_${Date.now()}.zip`);
  updateStatus('Logs downloaded');
}

/* ---------------- Button wiring and Cordova ready ---------------- */
if (window.cordova) {
  document.addEventListener('deviceready', () => {
    log('Device ready');
    // Connect start button (user gesture required for some APIs on iOS)
    startBtn.addEventListener('click', () => initApp(true));
  }, false);
} else {
  // Browser: attach start button too (for testing)
  log('Running in browser mode (no Cordova). Press START to initialize media & model.');
  startBtn.addEventListener('click', () => initApp(true));
}

/* Restart btn */
restartBtn.addEventListener('click', async () => {
  updateStatus('Manual restart requested');
  await restartStreams();
});

/* Emergency btn */
emergencyBtn.addEventListener('click', () => {
  updateStatus('Emergency recording started');
  startCanvasRecordingFor(10000);
});

/* Download logs */
downloadLogsBtn.addEventListener('click', downloadLogs);

/* Ensure window unload stops preview / intervals */
window.addEventListener('beforeunload', () => {
  try { if (cameraPreviewInterval) clearInterval(cameraPreviewInterval); } catch (e) { /* ignore */ }
  try { if (videoStream) videoStream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
});

/* End of file */
