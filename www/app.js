document.addEventListener('deviceready', async () => {
  const statusEl = document.getElementById('status');
  const overlayEl = document.getElementById('overlay');
  const emergencyBtn = document.getElementById('emergencyBtn');
  const accelToggle = document.getElementById('accelToggle');
  const recordMinutesInput = document.getElementById('recordMinutes');
  const videoEl = document.getElementById('camera');
  const audioCanvas = document.getElementById('audioCanvas');

  statusEl.innerText = "AWAITING PERMISSIONS...";

  // Cordova 権限要求
  const permissions = cordova.plugins.permissions;
  const perms = [
    permissions.CAMERA,
    permissions.RECORD_AUDIO,
    permissions.WRITE_EXTERNAL_STORAGE,
    permissions.READ_EXTERNAL_STORAGE
  ];
  for (let perm of perms) {
    await new Promise(resolve => {
      permissions.hasPermission(perm, function(status) {
        if (!status.hasPermission) {
          permissions.requestPermission(perm, resolve, resolve);
        } else resolve();
      }, resolve);
    });
  }

  statusEl.innerText = "PERMISSIONS GRANTED";

  // カメラ映像取得
  navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
      videoEl.srcObject = stream;
      initAudioVisualization(stream);
      initObjectDetection(videoEl);
    })
    .catch(err => {
      console.error(err);
      statusEl.innerText = "CAMERA/MIC ERROR";
    });

  // 音声解析（p5.FFT）
  function initAudioVisualization(stream) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const fft = new p5.FFT();
    fft.setInput(source);

    function draw() {
      const spectrum = fft.analyze();
      const ctx = audioCanvas.getContext('2d');
      ctx.clearRect(0,0,audioCanvas.width,audioCanvas.height);
      const w = audioCanvas.width / spectrum.length;
      spectrum.forEach((v,i) => {
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(i*w, audioCanvas.height - v, w, v);
      });
      const avg = spectrum.reduce((a,b)=>a+b)/spectrum.length;
      if(avg > 200) triggerAudioAnomaly();
      requestAnimationFrame(draw);
    }
    draw();
  }

  function triggerAudioAnomaly() {
    statusEl.innerText = "AUDIO ANOMALY DETECTED";
    overlayEl.style.display = 'block';
    if(navigator.vibrate) navigator.vibrate([200,100,200]);
  }

  // 物体検知（coco-ssd）
  async function initObjectDetection(video) {
    const model = await cocoSsd.load();
    statusEl.innerText = "OBJECT DETECTION READY";
    function detect() {
      model.detect(video).then(predictions => {
        const unknown = predictions.some(p => !['person','chair','table'].includes(p.class));
        if(unknown) triggerUnknownEntity();
      }).catch(console.error);
      requestAnimationFrame(detect);
    }
    detect();
  }

  function triggerUnknownEntity() {
    statusEl.innerText = "UNKNOWN ENTITY DETECTED";
    overlayEl.style.display = 'block';
    if(navigator.vibrate) navigator.vibrate([300,100,300]);
  }

  // 緊急録画（ユーザー指定分数）
  let recorder;
  emergencyBtn.addEventListener('click', async () => {
    const stream = videoEl.srcObject;
    if(!stream) return;

    let minutes = parseInt(recordMinutesInput.value, 10);
    if(isNaN(minutes) || minutes < 1) minutes = 1;
    const durationMs = minutes * 60 * 1000;

    recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const timestamp = new Date().toISOString().replace(/[:.]/g,'-');
      const filename = `emergency_${timestamp}.webm`;

      window.resolveLocalFileSystemURL(cordova.file.externalDataDirectory, dir => {
        dir.getFile(filename, { create: true }, fileEntry => {
          fileEntry.createWriter(writer => {
            writer.write(blob);
            alert(`緊急録画 (${minutes}分) 保存完了`);
          });
        });
      });
    };

    recorder.start();
    statusEl.innerText = `EMERGENCY RECORDING (${minutes}分)...`;
    setTimeout(()=>recorder.stop(), durationMs);
  });

  // 加速度検知（ON/OFF）
  let accelActive = accelToggle.checked;
  accelToggle.addEventListener('change', () => accelActive = accelToggle.checked);

  if(window.DeviceMotionEvent) {
    window.addEventListener('devicemotion', e => {
      if(!accelActive) return;
      const a = e.accelerationIncludingGravity;
      if(Math.abs(a.x)+Math.abs(a.y)+Math.abs(a.z) > 30) {
        statusEl.innerText = "SUDDEN MOTION DETECTED";
        overlayEl.style.display = 'block';
        if(navigator.vibrate) navigator.vibrate([150,50,150]);
      }
    });
  }

  // 画面サイズ変更に対応
  window.addEventListener('resize', () => {
    audioCanvas.width = window.innerWidth;
    audioCanvas.height = window.innerHeight;
  });
  audioCanvas.width = window.innerWidth;
  audioCanvas.height = window.innerHeight;
});
