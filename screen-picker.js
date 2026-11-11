const box = document.getElementById('selection');
const hint = document.getElementById('hint');
let start;
let finishing = false;
let cancelled = false;
let pinned;
let crop;
let aspect;
const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
video.hidden = true;
document.body.append(video);
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { alpha: false });

function rectangle(event) {
  const x = Math.max(0, Math.min(innerWidth, event.clientX));
  const y = Math.max(0, Math.min(innerHeight, event.clientY));
  return { x: Math.min(x, start.x), y: Math.min(y, start.y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
}

function stopCapture() {
  video.srcObject?.getTracks().forEach(track => track.stop());
  video.srcObject = null;
}

window.captureRegionFrame = () => {
  const track = video.srcObject?.getVideoTracks()[0];
  if (!crop || !track || track.readyState !== 'live' || track.muted || video.readyState < 2) return null;
  const { videoWidth, videoHeight } = video;
  if (Math.abs(videoWidth / videoHeight / aspect - 1) > 0.03) return { resized: true };
  const x = Math.floor(crop.x * videoWidth);
  const y = Math.floor(crop.y * videoHeight);
  const width = Math.min(videoWidth, Math.ceil((crop.x + crop.width) * videoWidth)) - x;
  const height = Math.min(videoHeight, Math.ceil((crop.y + crop.height) * videoHeight)) - y;
  const scale = Math.min(3, Math.max(2, 110 / height), 2400 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  context.drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return { png: canvas.toDataURL('image/png').slice('data:image/png;base64,'.length), capturedAt: Date.now() };
};

async function finish(region) {
  if (finishing) return;
  finishing = true;
  hint.textContent = 'Opening capture for the selected window…';
  try {
    await pinned;
    const selected = await window.regionPicker.source(region);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: selected.id, maxFrameRate: 5 } },
    });
    if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
    video.srcObject = stream;
    let timeout;
    try {
      await Promise.race([video.play(), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('No frames received from the selected window.')), 5000);
      })]);
    } finally { clearTimeout(timeout); }
    if (cancelled) return;
    aspect = video.videoWidth / video.videoHeight;
    crop = selected.crop;
    await window.regionPicker.finish(true);
  } catch (error) {
    stopCapture();
    finishing = false;
    box.hidden = true;
    if (!cancelled) hint.textContent = error.message || 'Could not capture the selected window. Try again or press Esc.';
  }
}

document.body.onpointerdown = event => {
  if (event.button !== 0 || finishing) return;
  start = { x: event.clientX, y: event.clientY };
  pinned = window.regionPicker.anchor({ x: start.x / innerWidth, y: start.y / innerHeight });
  pinned.catch(() => {});
  box.hidden = false;
  document.body.setPointerCapture(event.pointerId);
  document.body.onpointermove(event);
};
document.body.onpointermove = event => {
  if (!start) return;
  const { x, y, width, height } = rectangle(event);
  Object.assign(box.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px' });
};
document.body.onpointerup = event => {
  if (!start) return;
  const { x, y, width, height } = rectangle(event);
  start = undefined;
  if (width < 12 || height < 12) { box.hidden = true; return; }
  finish({ x: x / innerWidth, y: y / innerHeight, width: width / innerWidth, height: height / innerHeight });
};
document.body.onpointercancel = () => { start = undefined; box.hidden = true; };
window.onkeydown = event => {
  if (event.key !== 'Escape') return;
  cancelled = true;
  stopCapture();
  window.regionPicker.finish(false).catch(() => {});
};
window.addEventListener('pagehide', stopCapture);
