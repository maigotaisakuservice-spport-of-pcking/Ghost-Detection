// ======================
// 幽霊検知システム Cordova 完全版 app.js
// ======================

// HTML要素取得
const video = document.getElementById('video');
const videoCanvas = document.getElementById('videoCanvas');
const videoCtx = videoCanvas.getContext('2d');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const audioCanvas = document.getElementById('audioCanvas');
const modeSelect = document.getElementById('modeSelect');

// ======================
// 定点マーカー ON/OFF
// ======================
let markerEnabled = false;
document.getElementById('markerToggle').onchange = e => markerEnabled = e.target.checked;
let markers = [];
videoCanvas.addEventListener('click', e => {
  if(markerEnabled){
    const rect = videoCanvas.getBoundingClientRect();
    markers.push({x: e.clientX - rect.left, y: e.clientY - rect.top, w:50, h:50});
  }
});

// ======================
// 加速度/ジャイロ ON/OFF
// ======================
let motionEnabled = false;
document.getElementById('motionToggle').onchange = e => motionEnabled = e.target.checked;

// ======================
// カメラ＆マイク初期化
// ======================
let audioCtx, micStream, fft;
let videoStream, mediaRecorder, recordedChunks = [];

async function initMedia(){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({video:true, audio:true});
    video.srcObject = stream;
    videoStream = stream;

    // MediaRecorder録画
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => { if(e.data.size>0) recordedChunks.push(e.data); };
    mediaRecorder.start();

    // オーディオ解析（p5.FFT）
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    micStream = audioCtx.createMediaStreamSource(stream);
    fft = new p5.FFT();
    fft.setInput(micStream);

    updateStatus('AWAITING ANOMALY...');
  }catch(e){
    updateStatus('ERROR: CAMERA/MIC ACCESS FAILED');
    console.error(e);
  }
}

// ======================
// TensorFlow coco-ssd 物体検知
// ======================
let model;
async function loadModel(){
  updateStatus('LOADING MODEL...');
  model = await cocoSsd.load();
  updateStatus('MODEL LOADED');
}

// ======================
// 自動復旧（ハートビート監視）
// ======================
let heartbeat = true;
setInterval(()=>{
  if(!heartbeat){
    updateStatus('SYSTEM RECOVERING...');
    restartStreams();
  }
  heartbeat = false;
}, 2000);

async function restartStreams(){
  if(videoStream) videoStream.getTracks().forEach(t => t.stop());
  if(micStream) micStream.disconnect();
  if(mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  await initMedia();
  draw();
}

// ======================
// ステータス更新
// ======================
function updateStatus(msg){
  statusEl.textContent = msg;
}

// ======================
// 緊急録画（軌跡付き）
// ======================
let canvasRecorder;
function startCanvasRecording(){
  const stream = videoCanvas.captureStream(30);
  canvasRecorder = new MediaRecorder(stream);
  let chunks = [];
  canvasRecorder.ondataavailable = e => { if(e.data.size>0) chunks.push(e.data); };
  canvasRecorder.onstop = () => {
    const blob = new Blob(chunks, {type:'video/webm'});
    saveBlob(blob, 'ghost_trail_recording.webm');
    chunks = [];
  };
  canvasRecorder.start();
}

function stopCanvasRecording(){
  if(canvasRecorder && canvasRecorder.state === 'recording') canvasRecorder.stop();
}

document.getElementById('emergencyBtn').onclick = () => {
  updateStatus('EMERGENCY RECORDING...');
  startCanvasRecording();
  setTimeout(()=>stopCanvasRecording(), 10000);
};

// ======================
// Blob保存ヘルパー
// ======================
function saveBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ======================
// フレーム履歴（残像解析＋軌跡用）
// ======================
let prevFrames = [];
const maxHistory = 5;
let ghostTrails = [];
const maxTrails = 10;

// ======================
// 描画ループ
// ======================
function draw(){
  heartbeat = true;

  if(video.videoWidth && video.videoHeight){
    videoCanvas.width = video.videoWidth;
    videoCanvas.height = video.videoHeight;
    videoCtx.drawImage(video,0,0);

    let frame = videoCtx.getImageData(0,0,videoCanvas.width,videoCanvas.height);
    let data = frame.data;

    // モード変換
    const mode = modeSelect.value;
    if(mode==='infra'){
      for(let i=0;i<data.length;i+=4){
        let v=(data[i]+data[i+1]+data[i+2])/3;
        data[i]=v; data[i+1]=v*0.3; data[i+2]=0;
      }
    } else if(mode==='nv'){
      for(let i=0;i<data.length;i+=4){
        let v=(data[i]+data[i+1]+data[i+2])/3;
        data[i]=v*0.5; data[i+1]=v; data[i+2]=v*0.5;
      }
    }

    // 履歴保存
    prevFrames.push(new Uint8ClampedArray(data));
    if(prevFrames.length>maxHistory) prevFrames.shift();

    // 差分解析＋軌跡描画
    let diffPositions = [];
    if(prevFrames.length>=2){
      const prev = prevFrames[prevFrames.length-2];
      for(let i=0;i<data.length;i+=4){
        const delta = Math.abs(data[i]-prev[i]) + Math.abs(data[i+1]-prev[i+1]) + Math.abs(data[i+2]-prev[i+2]);
        if(delta>50){
          const idx = i/4;
          const x = idx % videoCanvas.width;
          const y = Math.floor(idx / videoCanvas.width);
          diffPositions.push({x,y});
        }
      }
      if(mode==='ghost'){
        const motionRatio = diffPositions.length / (data.length/4);
        if(motionRatio>0.02) triggerUnknownAlert();
      }
      drawGhostTrails(diffPositions);
    }

    videoCtx.putImageData(frame,0,0);

    // 定点マーカー描画
    if(markerEnabled){
      videoCtx.strokeStyle='lime';
      markers.forEach(m => videoCtx.strokeRect(m.x,m.y,m.w,m.h));
    }
  }

  drawAudio();
  detectUnknown();
  requestAnimationFrame(draw);
}

// ======================
// 軌跡描画
// ======================
function drawGhostTrails(diffPositions){
  if(diffPositions.length === 0) return;
  ghostTrails.push(diffPositions);
  if(ghostTrails.length>maxTrails) ghostTrails.shift();

  videoCtx.strokeStyle = 'lime';
  videoCtx.lineWidth = 2;
  ghostTrails.forEach(trail=>{
    videoCtx.beginPath();
    trail.forEach((p,i)=>{
      if(i===0) videoCtx.moveTo(p.x,p.y);
      else videoCtx.lineTo(p.x,p.y);
    });
    videoCtx.stroke();
  });
}

// ======================
// オーディオビジュアライザー
// ======================
function drawAudio(){
  if(!fft) return;
  const spectrum = fft.analyze();
  const ctx = audioCanvas.getContext('2d');
  audioCanvas.width = audioCanvas.clientWidth;
  audioCanvas.height = audioCanvas.clientHeight;
  ctx.clearRect(0,0,audioCanvas.width,audioCanvas.height);
  const w = audioCanvas.width/spectrum.length;
  for(let i=0;i<spectrum.length;i++){
    const h = (spectrum[i]/255)*audioCanvas.height;
    ctx.fillStyle='#0F0';
    ctx.fillRect(i*w,audioCanvas.height-h,w,h);
    if(spectrum[i]>250) triggerAudioAlert();
  }
}

// ======================
// アラート系
// ======================
function triggerAudioAlert(){
  updateStatus('AUDIO ANOMALY DETECTED');
  overlay.style.display='block';
  setTimeout(()=>overlay.style.display='none',500);
}

function triggerMotionAlert(){
  updateStatus('MOTION ANOMALY DETECTED');
  overlay.style.display='block';
  setTimeout(()=>overlay.style.display='none',500);
}

function triggerUnknownAlert(){
  updateStatus('UNKNOWN ENTITY DETECTED');
  overlay.style.display='block';
  setTimeout(()=>overlay.style.display='none',500);
}

// ======================
// TensorFlow物体検知
// ======================
function detectUnknown(){
  if(!model) return;
  model.detect(video).then(predictions=>{
    let unknown = predictions.find(p => !['person','chair','table'].includes(p.class));
    if(unknown) triggerUnknownAlert();
  });
}

// ======================
// Cordova初期化
// ======================
document.addEventListener('deviceready', async () => {
  // メディア初期化
  await initMedia();

  // 加速度/ジャイロ監視
  if(motionEnabled && navigator.accelerometer){
    const options = { frequency: 100 };
    navigator.accelerometer.watchAcceleration(
      function(acc){
        if(Math.abs(acc.x)>15 || Math.abs(acc.y)>15 || Math.abs(acc.z)>15){
          triggerMotionAlert();
        }
      },
      function(err){ console.warn('Accelerometer error', err); },
      options
    );
  }

  // モデルロードと描画開始
  await loadModel();
  draw();
});
