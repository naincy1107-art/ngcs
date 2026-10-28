/**
 * camera_live.js
 * Live camera -> terrain classifier (existing /api/predict/terrain) + MP4 recording.
 *
 * Self-contained: only reads the helpers script.js already defines (getApiUrl,
 * renderTerrainPanel). If the camera block is missing from the page it does nothing.
 *
 *  - The camera runs in the browser (works on the Vercel https site and on localhost).
 *  - Raw frames (no overlay) are sent to the backend a few times per second.
 *  - Recording = the on-screen picture incl. the class/confidence overlay. It is streamed to
 *    the backend in 2 s chunks (saved to recordings/camera_<time>.mp4 on the GCS laptop), so a
 *    crash or closed tab never loses the whole video. If the backend can't be reached, the
 *    file is downloaded by the browser instead.
 */
(function () {
  'use strict';

  const CLASSIFY_EVERY_MS = 300;
  const MAX_CANVAS_W = 1280;     // preview / recording width cap
  const SEND_W = 640;            // width of frames sent to the classifier
  const VIDEO_BPS = 2500000;
  const CHUNK_MS = 2000;

  const $ = (id) => document.getElementById(id);
  const selectEl = $('cam-select'), startBtn = $('cam-start-btn'), recBtn = $('cam-rec-btn');
  const statusEl = $('cam-status'), canvas = $('cam-canvas'), video = $('cam-video');
  if (!selectEl || !startBtn || !recBtn || !statusEl || !canvas || !video) return;

  const ctx = canvas.getContext('2d');
  const sendCanvas = document.createElement('canvas');
  const api = (p) => (typeof getApiUrl === 'function' ? getApiUrl(p) : 'http://localhost:5000' + p);

  let stream = null, running = false, rafId = 0, classifyTimer = 0, inflight = false;
  let last = null, lastOkAt = 0;
  let recorder = null, recId = null, recExt = 'webm', recMime = '', recChunks = [];
  let recSeq = 0, recChain = Promise.resolve(), recUploadFailed = false, recStart = 0, recTick = 0;

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.style.color = kind === 'err' ? '#d32f2f' : kind === 'warn' ? '#b26a00' : kind === 'ok' ? '#1b8a3a' : '';
  }
  const setEnabled = (btn, on) => btn.classList.toggle('idle-disabled', !on);

  // ---------------------------------------------------------------- camera
  async function refreshDevices() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      const current = stream && stream.getVideoTracks()[0] ? stream.getVideoTracks()[0].getSettings().deviceId : '';
      selectEl.innerHTML = '';
      devs.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || 'Camera ' + (i + 1);
        if (d.deviceId === current) o.selected = true;
        selectEl.appendChild(o);
      });
    } catch (e) { /* keep default list */ }
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Camera not available here (needs https or localhost).', 'err');
      return;
    }
    const constraints = { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
    if (selectEl.value) constraints.video.deviceId = { exact: selectEl.value };
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      setStatus('Camera error: ' + (e.name === 'NotAllowedError' ? 'permission denied' : e.message), 'err');
      return;
    }
    stream.getVideoTracks()[0].onended = () => { stopCamera(); setStatus('Camera disconnected.', 'err'); };
    video.srcObject = stream;
    await video.play();

    const scale = Math.min(1, MAX_CANVAS_W / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.style.display = 'block';
    await refreshDevices();

    running = true;
    startBtn.textContent = 'Stop Camera';
    setEnabled(recBtn, true);
    setStatus('Camera live - classifying...', 'ok');
    rafId = requestAnimationFrame(draw);
    classifyTimer = setInterval(classifyOnce, CLASSIFY_EVERY_MS);
  }

  async function stopCamera() {
    if (recorder) await stopRecording();
    running = false;
    cancelAnimationFrame(rafId);
    clearInterval(classifyTimer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    canvas.style.display = 'none';
    startBtn.textContent = 'Start Camera';
    setEnabled(recBtn, false);
    setStatus('Camera off');
  }

  // --------------------------------------------------- drawing (preview + recording)
  function draw() {
    if (!running) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    drawOverlay();
    rafId = requestAnimationFrame(draw);
  }

  function drawOverlay() {
    const W = canvas.width, H = canvas.height;
    const fs = Math.max(16, Math.round(H * 0.05));
    const bar = Math.round(fs * 2.6);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, W, bar);
    ctx.textBaseline = 'top';
    if (last) {
      const fresh = Date.now() - lastOkAt < 3000;
      ctx.fillStyle = fresh ? '#33ff77' : '#9aa0a6';
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.fillText(`${String(last.class_name).toUpperCase()}  ${Number(last.confidence).toFixed(1)}%`, 12, 8);
      const top = Object.entries(last.probabilities || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
      ctx.fillStyle = '#e0e0e0';
      ctx.font = `${Math.round(fs * 0.55)}px sans-serif`;
      ctx.fillText(top.map(([k, v]) => `${k} ${v.toFixed(0)}%`).join('   '), 12, 8 + fs * 1.2);
    } else {
      ctx.fillStyle = '#ffc107';
      ctx.font = `bold ${fs}px sans-serif`;
      ctx.fillText('classifying...', 12, 8);
    }
  }

  // ------------------------------------------------------------ classification
  function frameBlob() {
    const sc = Math.min(1, SEND_W / video.videoWidth);
    sendCanvas.width = Math.round(video.videoWidth * sc);
    sendCanvas.height = Math.round(video.videoHeight * sc);
    sendCanvas.getContext('2d').drawImage(video, 0, 0, sendCanvas.width, sendCanvas.height);   // raw frame, no overlay
    return new Promise((res) => sendCanvas.toBlob(res, 'image/jpeg', 0.85));
  }

  async function classifyOnce() {
    if (!running || inflight || !video.videoWidth) return;
    inflight = true;
    try {
      const blob = await frameBlob();
      if (!blob) return;
      const fd = new FormData();
      fd.append('image', blob, 'frame.jpg');
      const r = await fetch(api('/api/predict/terrain'), { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'HTTP ' + r.status);
      last = d;
      lastOkAt = Date.now();
      if (typeof renderTerrainPanel === 'function') {
        renderTerrainPanel({
          class_name: d.class_name, confidence: d.confidence, probabilities: d.probabilities,
          last_update: Date.now() / 1000, available: true,
        });
      }
      if (!recorder) {
        d.simulated ? setStatus('Model NOT loaded - results are SIMULATED', 'warn')
                    : setStatus('Camera live - classifying', 'ok');
      }
    } catch (e) {
      if (!recorder) setStatus('Backend not reachable: ' + e.message, 'err');
    } finally {
      inflight = false;
    }
  }

  // ----------------------------------------------------------------- recording
  function pickMime() {
    const list = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
                  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  async function post(path, fd) {
    const r = await fetch(api(path), { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok || !d.success) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
  }

  async function sendChunk(blob, seq) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = new FormData();
        fd.append('id', recId); fd.append('seq', String(seq)); fd.append('chunk', blob, 'c.bin');
        await post('/api/camera/recording/chunk', fd);
        return;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    recUploadFailed = true;
  }

  async function startRecording() {
    if (!running || recorder) return;
    recMime = pickMime();
    if (!recMime) { setStatus('This browser cannot record video.', 'err'); return; }
    recExt = recMime.startsWith('video/mp4') ? 'mp4' : 'webm';
    recChunks = []; recSeq = 0; recUploadFailed = false; recChain = Promise.resolve(); recId = null;

    try {
      const fd = new FormData();
      fd.append('ext', recExt);
      recId = (await post('/api/camera/recording/start', fd)).id;
    } catch (e) {
      recUploadFailed = true;      // backend unreachable: still record, download at the end
    }

    recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: recMime, videoBitsPerSecond: VIDEO_BPS });
    recorder.ondataavailable = (ev) => {
      if (!ev.data || !ev.data.size) return;
      recChunks.push(ev.data);
      if (recId && !recUploadFailed) {
        const seq = recSeq++;
        recChain = recChain.then(() => sendChunk(ev.data, seq));
      }
    };
    recorder.start(CHUNK_MS);

    recStart = Date.now();
    recBtn.textContent = '\u25A0 Stop Recording';
    recBtn.classList.add('cam-rec-on');
    startBtn.classList.add('idle-disabled');
    selectEl.disabled = true;
    recTick = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      const t = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
      setStatus('\u25CF REC ' + t + (recUploadFailed ? '  (backend unreachable - will download)' : ''), recUploadFailed ? 'warn' : 'err');
    }, 500);
  }

  function downloadLocal() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(recChunks, { type: recMime }));
    a.download = 'camera_' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + recExt;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  async function stopRecording() {
    if (!recorder) return;
    const rec = recorder;
    recorder = null;
    clearInterval(recTick);
    recBtn.textContent = 'Saving...';
    setStatus('Saving recording...', 'warn');
    await new Promise((res) => { rec.onstop = res; rec.stop(); });
    await recChain;                                   // every chunk uploaded

    let saved = false;
    if (recId && !recUploadFailed) {
      try {
        const fd = new FormData();
        fd.append('id', recId);
        const d = await post('/api/camera/recording/finish', fd);
        setStatus('Saved: ' + d.path + (d.note ? '  - ' + d.note : ''), d.note ? 'warn' : 'ok');
        saved = true;
      } catch (e) { /* fall through to local download */ }
    }
    if (!saved) {
      downloadLocal();
      setStatus('Backend save failed - recording downloaded by the browser instead.', 'warn');
    }

    recChunks = []; recId = null;
    recBtn.textContent = '\u25CF Record';
    recBtn.classList.remove('cam-rec-on');
    startBtn.classList.remove('idle-disabled');
    selectEl.disabled = false;
  }

  // ------------------------------------------------------------------- wiring
  startBtn.addEventListener('click', () => { if (!recorder) (running ? stopCamera() : startCamera()); });
  recBtn.addEventListener('click', () => { if (!running) return; recorder ? stopRecording() : startRecording(); });
  selectEl.addEventListener('change', async () => { if (running && !recorder) { await stopCamera(); await startCamera(); } });
  window.addEventListener('beforeunload', (e) => { if (recorder) { e.preventDefault(); e.returnValue = ''; } });
  setEnabled(recBtn, false);
})();
