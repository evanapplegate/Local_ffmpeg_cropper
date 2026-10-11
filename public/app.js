(function() {
  const fileInfo = document.getElementById('fileInfo');
  const editor = document.getElementById('editor');
  const video = document.getElementById('video');
  const videoWrap = document.getElementById('videoWrap');
  const outName = document.getElementById('outName');
  const exportBtn = document.getElementById('exportBtn');
  const playPauseBtn = document.getElementById('playPauseBtn');

  let cropper = null;
  let cropperLocalPath = null;

  document.getElementById('cropperBrowseBtn').addEventListener('click', async () => {
    const paths = await browseFiles('mov,mp4');
    if (!paths.length) return;
    const p = paths[0];
    try {
      const info = await probeLocalPath(p);
      cropperLocalPath = p;
      video.src = `/api/localfile?path=${encodeURIComponent(p)}`;
      video.load();
      fileInfo.textContent = `${info.filename} • ${(info.size/1e6).toFixed(1)} MB`;
      setHidden(fileInfo, false);
      setHidden(editor, false);
      const base = info.filename.replace(/\.[^.]+$/, '');
      outName.value = `${base}_crop.mp4`;
      setTimeout(() => video.play().catch(() => {}), 50);
    } catch (err) { alert('Path error: ' + err.message); }
  });

  function setHidden(el, hidden) {
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  async function probeLocalPath(filePath) {
    const resp = await fetch('/api/probe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath })
    });
    if (!resp.ok) throw new Error((await resp.json()).error || 'Probe failed');
    return await resp.json();
  }

  async function browseFiles(accept, multiple) {
    const resp = await fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: accept || 'mov,mp4', multiple: !!multiple })
    });
    if (!resp.ok) throw new Error('Browse failed');
    const data = await resp.json();
    if (data.canceled) return [];
    return data.paths || [];
  }

  video.addEventListener('loadedmetadata', () => {
    if (!cropper) cropper = new Cropper(videoWrap, video);
    waitForLayout(video).then(() => {
      cropper.resetToDefault();
      if (!outName.value) outName.value = 'output_crop.mp4';
    });
  });

  document.querySelectorAll('input[name="aspect"]').forEach(r => {
    r.addEventListener('change', () => {
      const val = document.querySelector('input[name="aspect"]:checked').value;
      cropper && cropper.setAspect(val);
    });
  });

  exportBtn.addEventListener('click', async () => {
    if (!cropperLocalPath || !cropper) return;
    const rect = cropper.getCropInSourcePixels();
    if (!rect) return;

    const form = new FormData();
    form.append('filePath', cropperLocalPath);
    form.append('x', String(rect.x));
    form.append('y', String(rect.y));
    form.append('w', String(rect.w));
    form.append('h', String(rect.h));
    form.append('filename', sanitizeFilename(outName.value));

    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting 0%';

    try {
      const resp = await fetch('/api/crop', { method: 'POST', body: form });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.type === 'progress') {
              exportBtn.textContent = `Exporting ${d.percent}%`;
            } else if (d.type === 'complete') {
              if (d.downloadUrl) {
                const a = document.createElement('a');
                a.href = d.downloadUrl;
                a.download = d.filename || 'cropped.mp4';
                document.body.appendChild(a);
                a.click();
                a.remove();
              }
            } else if (d.type === 'error') {
              throw new Error(d.error + (d.details ? ': ' + d.details : ''));
            }
          } catch (e) {
            if (e.message && !e.message.includes('JSON')) throw e;
          }
        }
      }
    } catch (err) {
      alert(err.message || String(err));
    } finally {
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export Crop';
    }
  });

  playPauseBtn.addEventListener('click', () => {
    if (video.paused) {
      video.play().then(() => {
        playPauseBtn.textContent = 'Pause';
      }).catch(() => {});
    } else {
      video.pause();
      playPauseBtn.textContent = 'Play';
    }
  });

  video.addEventListener('play', () => {
    playPauseBtn.textContent = 'Pause';
  });

  video.addEventListener('pause', () => {
    playPauseBtn.textContent = 'Play';
  });

  function sanitizeFilename(s) {
    s = s.trim();
    if (!s) return 'output.mp4';
    if (!/\.mp4$/i.test(s)) s += '.mp4';
    return s.replace(/[^A-Za-z0-9_.-]/g, '_');
  }

  class Cropper {
    constructor(container, videoEl) {
      this.container = container;
      this.videoEl = videoEl;
      this.aspect = 'free';
      this.minSize = 30; // px (display)
      this._build();
      this._attach();
    }

    _build() {
      const box = document.createElement('div');
      box.className = 'crop-box';
      this.box = box;
      const makeHandle = (cls) => { const h = document.createElement('div'); h.className = 'handle ' + cls; h.dataset.handle = cls; return h; };
      this.handles = {
        n: makeHandle('n'), s: makeHandle('s'), e: makeHandle('e'), w: makeHandle('w'),
        nw: makeHandle('nw'), ne: makeHandle('ne'), sw: makeHandle('sw'), se: makeHandle('se')
      };
      Object.values(this.handles).forEach(h => box.appendChild(h));
      this.container.appendChild(box);
    }

    _attach() {
      const onDown = (e) => {
        e.preventDefault();
        const target = e.target;
        const rect = this._rect();
        const vr = this._videoRect();
        const rawMode = (target.classList.contains('handle') && target.dataset.handle) || 'move';
        const mode = this.aspect === 'free' ? rawMode : this._mapSideHandleToCorner(rawMode, rect, this._pt(e));
        if (this.state) return; // avoid double-binding
        this.state = {
          mode,
          startMouse: this._pt(e),
          startRect: { ...rect },
          videoRect: vr
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };
      const onMove = (e) => {
        if (!this.state) return;
        const { mode, startMouse, startRect, videoRect } = this.state;
        const cur = this._pt(e);
        const dx = cur.x - startMouse.x;
        const dy = cur.y - startMouse.y;
        let { left, top, width, height } = startRect;

        const clamp = (l, t, w, h) => {
          // keep inside videoRect
          l = Math.max(videoRect.left, Math.min(l, videoRect.right - w));
          t = Math.max(videoRect.top, Math.min(t, videoRect.bottom - h));
          w = Math.max(this.minSize, Math.min(w, videoRect.right - l));
          h = Math.max(this.minSize, Math.min(h, videoRect.bottom - t));
          return { l, t, w, h };
        };

        const moveMode = mode === 'move';
        if (moveMode) {
          left = startRect.left + dx;
          top = startRect.top + dy;
          ({ l: left, t: top, w: width, h: height } = clamp(left, top, width, height));
        } else {
          if (this.aspect === 'free') {
            // Free resize similar to before
            switch (mode) {
              case 'n':
                top = startRect.top + dy;
                height = startRect.bottom - top;
                break;
              case 's':
                height = startRect.height + dy;
                break;
              case 'w':
                left = startRect.left + dx;
                width = startRect.right - left;
                break;
              case 'e':
                width = startRect.width + dx;
                break;
              case 'nw':
                left = startRect.left + dx;
                width = startRect.right - left;
                top = startRect.top + dy;
                height = startRect.bottom - top;
                break;
              case 'ne':
                width = startRect.width + dx;
                top = startRect.top + dy;
                height = startRect.bottom - top;
                break;
              case 'sw':
                left = startRect.left + dx;
                width = startRect.right - left;
                height = startRect.height + dy;
                break;
              case 'se':
                width = startRect.width + dx;
                height = startRect.height + dy;
                break;
            }
            ({ l: left, t: top, w: width, h: height } = clamp(left, top, width, height));
          } else {
            // Aspect-locked: anchor opposite corner and project pointer to ratio
            const ratio = this.aspect === '1:1' ? 1 : this.aspect === '16:9' ? (16/9) : (9/16);
            const corners = this._corners(startRect);
            const fixed = this._fixedCornerForMode(mode, corners);
            const pointer = { x: startMouse.x + dx, y: startMouse.y + dy };
            const proj = this._projectToRatioBox(fixed, pointer, ratio, videoRect);
            left = proj.left; top = proj.top; width = proj.width; height = proj.height;
          }
        }

        this._apply({ left, top, width, height });
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        this.state = null;
      };

      this.box.addEventListener('mousedown', onDown);
    }

    _pt(e) {
      const p = (e.touches && e.touches[0]) || e;
      const cb = this.container.getBoundingClientRect();
      return { x: p.clientX - cb.left, y: p.clientY - cb.top };
    }

    _mapSideHandleToCorner(mode, rect, pt) {
      if (this.aspect === 'free') return mode;
      if (mode === 'n' || mode === 's' || mode === 'e' || mode === 'w') {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        if (mode === 'n') return pt.x >= cx ? 'ne' : 'nw';
        if (mode === 's') return pt.x >= cx ? 'se' : 'sw';
        if (mode === 'e') return pt.y >= cy ? 'se' : 'ne';
        if (mode === 'w') return pt.y >= cy ? 'sw' : 'nw';
      }
      return mode;
    }

    _corners(rect) {
      return {
        nw: { x: rect.left, y: rect.top },
        ne: { x: rect.left + rect.width, y: rect.top },
        sw: { x: rect.left, y: rect.top + rect.height },
        se: { x: rect.left + rect.width, y: rect.top + rect.height }
      };
    }

    _fixedCornerForMode(mode, corners) {
      switch (mode) {
        case 'nw': return corners.se;
        case 'ne': return corners.sw;
        case 'sw': return corners.ne;
        case 'se': return corners.nw;
        default: return corners.nw;
      }
    }

    _projectToRatioBox(fixed, pointer, ratio, bounds) {
      // ratio = width/height, fixed is fixed corner; build rect toward pointer
      const dx = pointer.x - fixed.x;
      const dy = pointer.y - fixed.y;
      // Determine quadrant and make sizes positive
      const sx = dx >= 0 ? 1 : -1;
      const sy = dy >= 0 ? 1 : -1;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      // choose size limited by pointer rectangle
      let width = Math.max(this.minSize, Math.min(adx, ratio * ady));
      let height = Math.max(this.minSize, Math.round(width / ratio));
      width = Math.round(width);
      // compute box
      let left = sx > 0 ? fixed.x : fixed.x - width;
      let top = sy > 0 ? fixed.y : fixed.y - height;
      // clamp inside bounds
      const clamp = (l, t, w, h) => {
        l = Math.max(bounds.left, Math.min(l, bounds.right - w));
        t = Math.max(bounds.top, Math.min(t, bounds.bottom - h));
        return { left: l, top: t, width: w, height: h };
      };
      return clamp(left, top, width, height);
    }

    _videoRect() {
      const vb = this.videoEl.getBoundingClientRect();
      const cb = this.container.getBoundingClientRect();
      return {
        left: Math.round(vb.left - cb.left),
        top: Math.round(vb.top - cb.top),
        right: Math.round(vb.right - cb.left),
        bottom: Math.round(vb.bottom - cb.top),
        width: Math.round(vb.width),
        height: Math.round(vb.height)
      };
    }

    _rect() {
      const style = getComputedStyle(this.box);
      const left = parseFloat(style.left);
      const top = parseFloat(style.top);
      const width = parseFloat(style.width);
      const height = parseFloat(style.height);
      return { left, top, width, height, right: left + width, bottom: top + height };
    }

    _apply({ left, top, width, height }) {
      this.box.style.left = Math.round(left) + 'px';
      this.box.style.top = Math.round(top) + 'px';
      this.box.style.width = Math.round(width) + 'px';
      this.box.style.height = Math.round(height) + 'px';
    }

    resetToDefault() {
      const vr = this._videoRect();
      if (vr.width <= 0 || vr.height <= 0) return;
      const w = Math.round(Math.min(vr.width, vr.height) * 0.6);
      const h = this.aspect === '9:16' ? Math.round(w * 16 / 9) : this.aspect === '16:9' ? Math.round(w * 9 / 16) : w;
      const ww = Math.min(w, vr.width - 10);
      const hh = Math.min(h, vr.height - 10);
      const left = Math.round(vr.left + (vr.width - ww) / 2);
      const top = Math.round(vr.top + (vr.height - hh) / 2);
      this._apply({ left, top, width: ww, height: hh });
    }

    setAspect(val) {
      this.aspect = val; // 'free' | '1:1' | '9:16' | '16:9'
      this.resetToDefault();
    }

    getCropInSourcePixels() {
      const vr = this._videoRect();
      const r = this._rect();
      const sx = this.videoEl.videoWidth / vr.width;
      const sy = this.videoEl.videoHeight / vr.height;
      if (!isFinite(sx) || !isFinite(sy) || vr.width <= 0 || vr.height <= 0) return null;
      const x = Math.max(0, Math.round((r.left - vr.left) * sx));
      const y = Math.max(0, Math.round((r.top - vr.top) * sy));
      const w = Math.max(2, Math.round(r.width * sx));
      const h = Math.max(2, Math.round(r.height * sy));
      return { x, y, w, h };
    }
  }

  function waitForLayout(el, tries = 30) {
    return new Promise((resolve) => {
      function tick(remaining) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return resolve();
        if (remaining <= 0) return resolve();
        requestAnimationFrame(() => tick(remaining - 1));
      }
      tick(tries);
    });
  }

  // Combiner functionality
  const videoFileInfo = document.getElementById('videoFileInfo');
  const audioFileInfo = document.getElementById('audioFileInfo');
  const timelineSection = document.getElementById('timelineSection');
  const timelineContainer = document.getElementById('timelineContainer');
  const videoTrack = document.getElementById('videoTrack');
  const audioTrack = document.getElementById('audioTrack');
  const videoBlock = document.getElementById('videoBlock');
  const audioBlock = document.getElementById('audioBlock');
  const selectionBox = document.getElementById('selectionBox');
  const previewVideo = document.getElementById('previewVideo');
  const combineExportBtn = document.getElementById('combineExportBtn');
  const timelineRuler = document.getElementById('timelineRuler');
  const previewPlayPauseBtn = document.getElementById('previewPlayPauseBtn');
  const playhead = document.getElementById('playhead');

  let combinerVideoLocalPath = null;
  let combinerAudioLocalPath = null;
  let combinerTimeline = null;
  let previewAudioEl = null;
  document.getElementById('combinerVideoBrowseBtn').addEventListener('click', async () => {
    const paths = await browseFiles('mov,mp4');
    if (!paths.length) return;
    try {
      const info = await probeLocalPath(paths[0]);
      combinerVideoLocalPath = paths[0];
      videoFileInfo.textContent = `${info.filename} • ${(info.size/1e6).toFixed(1)} MB`;
      setHidden(videoFileInfo, false);
      initTimeline();
    } catch (err) { alert('Path error: ' + err.message); }
  });

  document.getElementById('combinerAudioBrowseBtn').addEventListener('click', async () => {
    const paths = await browseFiles('mov,mp4,mp3,wav,m4a');
    if (!paths.length) return;
    try {
      const info = await probeLocalPath(paths[0]);
      combinerAudioLocalPath = paths[0];
      audioFileInfo.textContent = `${info.filename} • ${(info.size/1e6).toFixed(1)} MB`;
      setHidden(audioFileInfo, false);
      initTimeline();
    } catch (err) { alert('Path error: ' + err.message); }
  });

  async function initTimeline() {
    if (!combinerVideoLocalPath || !combinerAudioLocalPath) return;
    if (!combinerTimeline) {
      combinerTimeline = new Timeline(timelineContainer, videoBlock, audioBlock, selectionBox, timelineRuler);
    }
    setHidden(timelineSection, false);
    const controls = document.querySelector('.combiner-controls');
    if (controls) controls.style.display = 'flex';
    try {
      const [videoInfo, audioInfo] = await Promise.all([
        probeLocalPath(combinerVideoLocalPath),
        probeLocalPath(combinerAudioLocalPath)
      ]);
      combinerTimeline.setLocalPaths(combinerVideoLocalPath, combinerAudioLocalPath, videoInfo.duration, audioInfo.duration);
      combineExportBtn.disabled = true;
      combinerTimeline._playPreview();
    } catch (err) {
      console.error('Failed to probe media:', err);
    }
  }

  function extractFirstFrame(fileOrUrl) {
    return new Promise((resolve, reject) => {
      const isFile = fileOrUrl instanceof File;
      const url = isFile ? URL.createObjectURL(fileOrUrl) : fileOrUrl;
      const vid = document.createElement('video');
      vid.muted = true;
      vid.crossOrigin = 'anonymous';
      vid.preload = 'auto';
      vid.onloadedmetadata = () => { vid.currentTime = Math.max(0, vid.duration - 0.5); };
      vid.onseeked = () => {
        const c = document.createElement('canvas');
        c.width = vid.videoWidth;
        c.height = vid.videoHeight;
        c.getContext('2d').drawImage(vid, 0, 0);
        if (isFile) URL.revokeObjectURL(url);
        resolve({ canvas: c, naturalWidth: vid.videoWidth, naturalHeight: vid.videoHeight });
      };
      vid.onerror = () => { if (isFile) URL.revokeObjectURL(url); reject(new Error('Frame extraction failed')); };
      vid.src = url;
    });
  }

  class PaneController {
    constructor(paneEl, frameCanvas, targetW, targetH) {
      this.paneEl = paneEl;
      this.targetW = targetW;
      this.targetH = targetH;
      this.srcW = frameCanvas.width;
      this.srcH = frameCanvas.height;
      this.panX = 0.5;
      this.panY = 0.5;
      this.zoom = 1.0;
      this.minZoom = 1.0;
      this.baseScaledW = 0;
      this.baseScaledH = 0;
      this.scaledW = 0;
      this.scaledH = 0;
      this.excessX = 0;
      this.excessY = 0;
      this._setupImage(frameCanvas);
      this._attachDrag();
      this._attachZoom();
    }

    setScaleMode(mode) {
      this.scaleMode = mode;
      if (mode === 'width') {
        this.baseScaledW = this.targetW;
        this.baseScaledH = Math.round(this.srcH * (this.targetW / this.srcW));
      } else {
        this.baseScaledH = this.targetH;
        this.baseScaledW = Math.round(this.srcW * (this.targetH / this.srcH));
      }
      // Min zoom: both dimensions must cover the crop target
      const minZW = this.targetW / this.baseScaledW;
      const minZH = this.targetH / this.baseScaledH;
      this.minZoom = Math.max(1.0, minZW, minZH);
      this.zoom = this.minZoom;
      this._applyZoom();
    }

    _applyZoom() {
      this.scaledW = Math.round(this.baseScaledW * this.zoom);
      this.scaledH = Math.round(this.baseScaledH * this.zoom);
      this.excessX = Math.max(0, this.scaledW - this.targetW);
      this.excessY = Math.max(0, this.scaledH - this.targetH);
      // Clamp pan so it stays in bounds
      this.panX = Math.max(0, Math.min(1, this.panX));
      this.panY = Math.max(0, Math.min(1, this.panY));
      this._render();
      this._updateLabel();
    }

    _setupImage(frameCanvas) {
      const img = new Image();
      img.src = frameCanvas.toDataURL('image/jpeg', 0.8);
      this.img = img;
      this.paneEl.innerHTML = '';
      this.paneEl.appendChild(img);
      // Zoom label
      const label = document.createElement('span');
      label.className = 'zoom-label';
      this.zoomLabel = label;
      this.paneEl.appendChild(label);
    }

    _updateLabel() {
      if (this.zoomLabel) this.zoomLabel.textContent = this.zoom.toFixed(1) + 'x';
    }

    _attachDrag() {
      let dragging = false;
      let startX, startY, startPanX, startPanY;

      const onDown = (e) => {
        e.preventDefault();
        dragging = true;
        const pt = e.touches ? e.touches[0] : e;
        startX = pt.clientX;
        startY = pt.clientY;
        startPanX = this.panX;
        startPanY = this.panY;
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
      };

      const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const pt = e.touches ? e.touches[0] : e;
        const dx = pt.clientX - startX;
        const dy = pt.clientY - startY;
        const paneRect = this.paneEl.getBoundingClientRect();
        const screenPerSourceX = paneRect.width / this.targetW;
        const screenPerSourceY = paneRect.height / this.targetH;
        if (this.excessX > 0) {
          const sourceDx = dx / screenPerSourceX;
          this.panX = Math.max(0, Math.min(1, startPanX - sourceDx / this.excessX));
        }
        if (this.excessY > 0) {
          const sourceDy = dy / screenPerSourceY;
          this.panY = Math.max(0, Math.min(1, startPanY - sourceDy / this.excessY));
        }
        this._render();
      };

      const onUp = () => {
        dragging = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onUp);
      };

      this.paneEl.addEventListener('mousedown', onDown);
      this.paneEl.addEventListener('touchstart', onDown, { passive: false });
    }

    _attachZoom() {
      this.paneEl.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = 0.1;
        const dir = e.deltaY < 0 ? 1 : -1; // scroll up = zoom in
        this.zoom = Math.max(this.minZoom, Math.min(5.0, this.zoom + dir * step));
        this._applyZoom();
      }, { passive: false });
    }

    _render() {
      if (!this.img || !this.scaledW) return;
      const paneRect = this.paneEl.getBoundingClientRect();
      const displayW = paneRect.width;
      const displayH = paneRect.height;
      const ratio = displayW / this.targetW;
      const imgDisplayW = this.scaledW * ratio;
      const imgDisplayH = this.scaledH * ratio;
      this.img.style.width = imgDisplayW + 'px';
      this.img.style.height = imgDisplayH + 'px';
      const maxOffsetX = Math.max(0, imgDisplayW - displayW);
      const maxOffsetY = Math.max(0, imgDisplayH - displayH);
      this.img.style.left = -(this.panX * maxOffsetX) + 'px';
      this.img.style.top = -(this.panY * maxOffsetY) + 'px';
    }

    getCropX() { return Math.round(this.panX * this.excessX); }
    getCropY() { return Math.round(this.panY * this.excessY); }
    getZoom() { return this.zoom; }
  }

  class Timeline {
    constructor(container, videoBlockEl, audioBlockEl, selectionBoxEl, rulerEl) {
      this.container = container;
      this.videoBlock = videoBlockEl;
      this.audioBlock = audioBlockEl;
      this.selectionBox = selectionBoxEl;
      this.ruler = rulerEl;
      this.videoFile = null;
      this.audioFile = null;
      this.videoDuration = 0;
      this.audioDuration = 0;
      this.videoOffset = 0;
      this.audioOffset = 0; // Can be negative (audio starts before video)
      this.selectionStart = null;
      this.selectionEnd = null;
      this.pixelsPerSecond = 50; // Will be recalculated to fit
      this.dragState = null;
      this.labelWidth = 60;
      this._attach();
      this._attachResize();
      this._attachPlayhead();
    }

    setLocalPaths(videoPath, audioPath, videoDur, audioDur) {
      this.videoLocalPath = videoPath;
      this.audioLocalPath = audioPath;
      this.videoDuration = videoDur || 1;
      this.audioDuration = audioDur || 1;
      this.videoOffset = 0;
      this.audioOffset = 0;
      this.selectionStart = null;
      this.selectionEnd = null;
      this._offsetShift = 0;
      this._render();
      this.updatePlayhead(0);
    }

    _render() {
      // Account for negative audio offset in timeline range
      const minOffset = Math.min(0, this.audioOffset);
      const maxEnd = Math.max(
        this.videoOffset + this.videoDuration,
        this.audioOffset + this.audioDuration
      );
      // Ensure we fit exactly without extra padding that causes scroll
      const totalDuration = Math.max(1, maxEnd - minOffset); 
      
      const rect = this.container.getBoundingClientRect();
      if (rect.width === 0) return; // Wait for layout

      const containerWidth = rect.width - 24 - this.labelWidth;
      // Calculate pixelsPerSecond to fit exactly
      this.pixelsPerSecond = containerWidth / totalDuration;
      
      // Shift everything so minOffset maps to 0px
      const offsetShift = -minOffset;
      
      this.videoBlock.style.width = (this.videoDuration * this.pixelsPerSecond) + 'px';
      this.videoBlock.style.left = ((this.videoOffset + offsetShift) * this.pixelsPerSecond) + 'px';
      this.audioBlock.style.width = (this.audioDuration * this.pixelsPerSecond) + 'px';
      this.audioBlock.style.left = ((this.audioOffset + offsetShift) * this.pixelsPerSecond) + 'px';

      this._renderRuler(totalDuration, minOffset);
      this._updateSelection(offsetShift);
      
      // Store for playhead calculation
      this._offsetShift = offsetShift;

      // Update playhead position immediately to match new layout
      if (typeof previewVideo !== 'undefined') {
        this.updatePlayhead(previewVideo.currentTime || 0);
      }
    }

    _attachResize() {
      // Use ResizeObserver for more robust size tracking
      const ro = new ResizeObserver(() => {
         if (this.videoDuration > 0) this._render();
      });
      ro.observe(this.container);
    }

    _attachPlayhead() {
      previewVideo.addEventListener('timeupdate', () => {
        if (!this.videoDuration) return;
        this.updatePlayhead(previewVideo.currentTime);
      });
    }

    updatePlayhead(videoTime) {
      // Get the actual left offset of track-content relative to container
      const trackContent = this.videoBlock.parentElement;
      const containerRect = this.container.getBoundingClientRect();
      const trackContentRect = trackContent.getBoundingClientRect();
      const trackContentLeft = trackContentRect.left - containerRect.left;
      
      // Timeline position = videoOffset + videoTime, shifted by offsetShift
      const timelinePos = this.videoOffset + videoTime + (this._offsetShift || 0);
      const pxPos = trackContentLeft + (timelinePos * this.pixelsPerSecond);
      playhead.style.left = pxPos + 'px';
    }

    _renderRuler(totalDuration, minOffset) {
      this.ruler.innerHTML = '';
      // Dynamically calculate step to avoid overcrowding
      // Aim for ~10 ticks
      const targetTicks = 10;
      let step = totalDuration / targetTicks;
      // Round step to nice number (1, 2, 5, 10, 30, 60 etc)
      if (step < 1) step = 1;
      else if (step < 2) step = 2;
      else if (step < 5) step = 5;
      else if (step < 10) step = 10;
      else step = Math.ceil(step / 10) * 10;

      const startTime = Math.floor(minOffset / step) * step;
      const endTime = Math.ceil((minOffset + totalDuration) / step) * step;
      
      for (let t = startTime; t <= endTime; t += step) {
        const tick = document.createElement('div');
        tick.className = 'ruler-tick';
        tick.style.left = ((t - minOffset) * this.pixelsPerSecond) + 'px';
        const label = document.createElement('div');
        label.className = 'ruler-label';
        label.textContent = formatTime(t);
        tick.appendChild(label);
        this.ruler.appendChild(tick);
      }
    }

    _updateSelection(offsetShift) {
      if (this.selectionStart === null || this.selectionEnd === null) {
        setHidden(this.selectionBox, true);
        return;
      }
      const shift = offsetShift !== undefined ? offsetShift : (this._offsetShift || 0);
      const start = Math.min(this.selectionStart, this.selectionEnd);
      const end = Math.max(this.selectionStart, this.selectionEnd);
      this.selectionBox.style.left = (this.labelWidth + (start + shift) * this.pixelsPerSecond) + 'px';
      this.selectionBox.style.width = ((end - start) * this.pixelsPerSecond) + 'px';
      setHidden(this.selectionBox, false);
    }

    _attach() {
      const onVideoDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.dragState = {
          type: 'video',
          startX: e.clientX,
          startOffset: this.videoOffset
        };
        window.addEventListener('mousemove', onVideoMove);
        window.addEventListener('mouseup', onVideoUp);
      };

      const onVideoMove = (e) => {
        if (!this.dragState || this.dragState.type !== 'video') return;
        const dx = (e.clientX - this.dragState.startX) / this.pixelsPerSecond;
        this.videoOffset = Math.max(0, this.dragState.startOffset + dx);
        this._render();
      };

      const onVideoUp = () => {
        if (this.dragState && this.dragState.type === 'video') {
          window.removeEventListener('mousemove', onVideoMove);
          window.removeEventListener('mouseup', onVideoUp);
          this.dragState = null;
          this._playPreview();
          // Force update playhead to video start (preview resets to 0)
          this.updatePlayhead(0);
        }
      };

      const onAudioDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.dragState = {
          type: 'audio',
          startX: e.clientX,
          startOffset: this.audioOffset
        };
        window.addEventListener('mousemove', onAudioMove);
        window.addEventListener('mouseup', onAudioUp);
      };

      const onAudioMove = (e) => {
        if (!this.dragState || this.dragState.type !== 'audio') return;
        const dx = (e.clientX - this.dragState.startX) / this.pixelsPerSecond;
        // Allow negative offset (audio starts before video in timeline)
        this.audioOffset = this.dragState.startOffset + dx;
        this._render();
      };

      const onAudioUp = () => {
        if (this.dragState && this.dragState.type === 'audio') {
          window.removeEventListener('mousemove', onAudioMove);
          window.removeEventListener('mouseup', onAudioUp);
          this.dragState = null;
          this._playPreview();
        }
      };

      let selectionStartX = null;
      let isSelectionDragging = false;
      
      const onSelectionDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        const x = e.clientX - rect.left - this.labelWidth;
        const time = (x / this.pixelsPerSecond) - (this._offsetShift || 0);
        this.selectionStart = time;
        this.selectionEnd = time;
        selectionStartX = e.clientX;
        isSelectionDragging = false;
        this.dragState = { type: 'selection' };
        window.addEventListener('mousemove', onSelectionMove);
        window.addEventListener('mouseup', onSelectionUp);
      };

      const onSelectionMove = (e) => {
        if (!this.dragState || this.dragState.type !== 'selection') return;
        
        // Check if we've moved enough to consider it a drag (5px threshold)
        if (!isSelectionDragging && Math.abs(e.clientX - selectionStartX) > 5) {
          isSelectionDragging = true;
          this._updateSelection();
        }
        
        if (isSelectionDragging) {
          const rect = this.container.getBoundingClientRect();
          const x = e.clientX - rect.left - this.labelWidth;
          const time = (x / this.pixelsPerSecond) - (this._offsetShift || 0);
          this.selectionEnd = time;
          this._updateSelection();
        }
      };

      const onSelectionUp = (e) => {
        if (this.dragState && this.dragState.type === 'selection') {
          window.removeEventListener('mousemove', onSelectionMove);
          window.removeEventListener('mouseup', onSelectionUp);
          this.dragState = null;
          
          if (isSelectionDragging) {
            // Was a drag - enable export if we have valid selection
            if (this.selectionStart !== null && this.selectionEnd !== null) {
              console.log('Enabling export button');
              combineExportBtn.disabled = false;
            } else {
               console.log('Selection is null', this.selectionStart, this.selectionEnd);
            }
          } else {
            // Was just a click - seek to that position
            const clickTime = this.selectionStart + this.videoOffset;
            if (previewVideo.src) {
              previewVideo.currentTime = Math.max(0, clickTime);
              this.updatePlayhead(previewVideo.currentTime);
            }
            // Clear selection since we clicked, not dragged
            this.selectionStart = null;
            this.selectionEnd = null;
            setHidden(this.selectionBox, true);
          }
          
          selectionStartX = null;
          isSelectionDragging = false;
        }
      };

      // Add mouseup to window to catch drags ending outside container
      window.addEventListener('mouseup', () => {
         if (this.dragState && this.dragState.type === 'selection') {
            onSelectionUp();
         }
      });

      this.videoBlock.addEventListener('mousedown', onVideoDown);
      this.audioBlock.addEventListener('mousedown', onAudioDown);
      this.container.addEventListener('mousedown', (e) => {
        // Only start selection if clicking ruler or empty space in container
        // But allow it if we are not clicking on a block
        if (e.target.closest('.track-block')) return;
        
        onSelectionDown(e);
      });
    }

    _playPreview() {
      if (!this.videoLocalPath || !this.audioLocalPath) return;
      cleanupPreview();

      previewAudioEl = document.createElement('audio');
      previewAudioEl.src = `/api/localfile?path=${encodeURIComponent(this.audioLocalPath)}`;
      previewAudioEl.volume = 0.8;

      previewVideo.src = `/api/localfile?path=${encodeURIComponent(this.videoLocalPath)}`;
      previewVideo.muted = true;
      
      // Calculate sync: when video is at time T, audio should be at (videoOffset + T - audioOffset)
      const vOffset = this.videoOffset;
      const aOffset = this.audioOffset;
      const audioSyncOffset = vOffset - aOffset; // Add to video.currentTime to get audio.currentTime
      
      previewVideo.onloadedmetadata = () => {
        previewVideo.currentTime = 0;
        this.updatePlayhead(0);
      };
      
      previewAudioEl.onloadedmetadata = () => {
        const audioTime = Math.max(0, audioSyncOffset);
        previewAudioEl.currentTime = audioTime;
      };
      
      previewVideo.oncanplay = () => {
        previewPlayPauseBtn.disabled = false;
        const audioTime = Math.max(0, previewVideo.currentTime + audioSyncOffset);
        previewAudioEl.currentTime = audioTime;
        previewVideo.play().then(() => {
          previewAudioEl.play().catch(e => console.error('Audio play error:', e));
        }).catch(e => console.error('Video play error:', e));
      };
      
      // Keep audio synced during playback
      previewVideo.ontimeupdate = () => {
        if (previewAudioEl && !previewAudioEl.paused) {
          const targetAudioTime = previewVideo.currentTime + audioSyncOffset;
          if (targetAudioTime < 0) {
            previewAudioEl.pause();
          } else if (Math.abs(previewAudioEl.currentTime - targetAudioTime) > 0.3) {
            previewAudioEl.currentTime = targetAudioTime;
          }
        }
      };
    }

    getSelection() {
      if (this.selectionStart === null || this.selectionEnd === null) return null;
      const start = Math.min(this.selectionStart, this.selectionEnd);
      const end = Math.max(this.selectionStart, this.selectionEnd);
      return { start, end };
    }
  }

  function formatTime(seconds) {
    const absSeconds = Math.abs(seconds);
    const mins = Math.floor(absSeconds / 60);
    const secs = Math.floor(absSeconds % 60);
    const sign = seconds < 0 ? '-' : '';
    return `${sign}${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // Parse a timecode string ("2:45", "2:45.5", "1:02:03", or plain "165") into seconds. Returns null if invalid.
  function parseTime(str) {
    str = String(str).trim();
    if (!str) return null;
    const neg = str.startsWith('-');
    if (neg) str = str.slice(1);
    let total;
    if (str.includes(':')) {
      const parts = str.split(':').map(p => Number(p));
      if (parts.some(p => isNaN(p))) return null;
      total = parts.reduce((acc, p) => acc * 60 + p, 0);
    } else {
      total = Number(str);
      if (isNaN(total)) return null;
    }
    return neg ? -total : total;
  }

  function cleanupPreview() {
    if (previewAudioEl) {
      previewAudioEl.pause();
      previewAudioEl.src = '';
      previewAudioEl = null;
    }
    previewVideo.pause();
    previewVideo.src = '';
  }

  previewPlayPauseBtn.addEventListener('click', () => {
    if (previewVideo.paused) {
      previewVideo.play().then(() => {
        if (previewAudioEl) previewAudioEl.play().catch(() => {});
        previewPlayPauseBtn.textContent = 'Pause';
      }).catch(() => {});
    } else {
      previewVideo.pause();
      if (previewAudioEl) previewAudioEl.pause();
      previewPlayPauseBtn.textContent = 'Play';
    }
  });

  previewVideo.addEventListener('play', () => {
    previewPlayPauseBtn.textContent = 'Pause';
  });

  previewVideo.addEventListener('pause', () => {
    previewPlayPauseBtn.textContent = 'Play';
  });

  combineExportBtn.addEventListener('click', async () => {
    if (!combinerTimeline || !combinerVideoLocalPath || !combinerAudioLocalPath) return;
    const selection = combinerTimeline.getSelection();
    if (!selection) {
      alert('Please select a time range on the timeline');
      return;
    }

    const form = new FormData();
    form.append('videoFilePath', combinerVideoLocalPath);
    form.append('audioFilePath', combinerAudioLocalPath);
    form.append('videoOffset', String(combinerTimeline.videoOffset));
    form.append('audioOffset', String(combinerTimeline.audioOffset));
    form.append('startTime', String(selection.start));
    form.append('endTime', String(selection.end));
    form.append('videoSpeed', String(parseFloat(document.getElementById('combineVideoSpeed').value) || 1));
    form.append('filename', sanitizeFilename('combined.mp4'));

    combineExportBtn.disabled = true;
    combineExportBtn.textContent = 'Export 0%';

    try {
      const resp = await fetch('/api/combine', { method: 'POST', body: form });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'progress') {
              combineExportBtn.textContent = `Export ${data.percent}%`;
            } else if (data.type === 'complete') {
              // Convert base64 to blob and download
              const binary = atob(data.data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: 'video/mp4' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = data.filename || 'combined.mp4';
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            } else if (data.type === 'error') {
              throw new Error(data.error + (data.details ? ': ' + data.details : ''));
            }
          } catch (e) {
            if (e.message && !e.message.includes('JSON')) throw e;
          }
        }
      }
    } catch (err) {
      console.error('Export error:', err);
      alert(err.message || String(err));
    } finally {
      combineExportBtn.disabled = false;
      combineExportBtn.textContent = 'Export MP4';
    }
  });

  // Spacebar play/pause - works for both combiner and concatenator
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      
      // Check which section is visible/active - prefer concat if it has video loaded
      const concatVideo = document.getElementById('concatPreviewVideo');
      const concatPlayBtn = document.getElementById('concatPlayPauseBtn');
      
      if (concatVideo && concatVideo.src && !concatPlayBtn.disabled) {
        // Concat video is loaded - use it
        if (concatVideo.paused) {
          concatVideo.play().catch(() => {});
        } else {
          concatVideo.pause();
        }
      } else if (previewVideo.src && !previewPlayPauseBtn.disabled) {
        // Fall back to combiner video
        if (previewVideo.paused) {
          previewVideo.play().then(() => {
            if (previewAudioEl) previewAudioEl.play().catch(() => {});
          }).catch(() => {});
        } else {
          previewVideo.pause();
          if (previewAudioEl) previewAudioEl.pause();
        }
      }
    }
  });

  // ========== CONCATENATOR ==========
  const concatFileInfo = document.getElementById('concatFileInfo');
  const concatTimelineSection = document.getElementById('concatTimelineSection');
  const concatTimelineContainer = document.getElementById('concatTimelineContainer');
  const concatTrackContent = document.getElementById('concatTrackContent');
  const concatVideoBlock = document.getElementById('concatVideoBlock');
  const concatSelectionsContainer = document.getElementById('concatSelections');
  const concatTimelineRuler = document.getElementById('concatTimelineRuler');
  const concatPlayhead = document.getElementById('concatPlayhead');
  const concatPreviewVideo = document.getElementById('concatPreviewVideo');
  const concatPlayPauseBtn = document.getElementById('concatPlayPauseBtn');
  const concatExportBtn = document.getElementById('concatExportBtn');
  const selectionListEl = document.getElementById('selectionList');

  let concatLocalPath = null;
  let concatTimeline = null;
  document.getElementById('concatBrowseBtn').addEventListener('click', async () => {
    const paths = await browseFiles('mov,mp4');
    if (!paths.length) return;
    const p = paths[0];
    try {
      const info = await probeLocalPath(p);
      concatLocalPath = p;
      concatFileInfo.textContent = `${info.filename} • ${(info.size/1e6).toFixed(1)} MB`;
      setHidden(concatFileInfo, false);
      if (!concatTimeline) {
        concatTimeline = new ConcatTimeline(
          concatTimelineContainer, concatTrackContent, concatVideoBlock,
          concatSelectionsContainer, concatTimelineRuler, concatPlayhead, concatPreviewVideo
        );
      }
      setHidden(concatTimelineSection, false);
      concatTimeline.setLocalPath(concatLocalPath, info.duration);
      concatPlayPauseBtn.disabled = false;
    } catch (err) { alert('Path error: ' + err.message); }
  });

  class ConcatTimeline {
    constructor(container, trackContent, videoBlock, selectionsContainer, ruler, playheadEl, previewVideoEl) {
      this.container = container;
      this.trackContent = trackContent;
      this.videoBlock = videoBlock;
      this.selectionsContainer = selectionsContainer;
      this.ruler = ruler;
      this.playhead = playheadEl;
      this.previewVideo = previewVideoEl;
      this.file = null;
      this.duration = 0;
      this.selections = []; // Array of {start, end, el}
      this.pixelsPerSecond = 50;
      this.dragState = null;
      this._attach();
      this._attachResize();
      this._attachPlayhead();
    }

    setFile(file, duration) {
      this.file = file;
      this.localPath = null;
      this.duration = duration;
      this.selections = [];
      this._render();
      this._renderSelections();
      this._loadPreview();
    }

    setLocalPath(localPath, duration) {
      this.file = null;
      this.localPath = localPath;
      this.duration = duration;
      this.selections = [];
      this._render();
      this._renderSelections();
      this._loadPreview();
    }

    _loadPreview() {
      this.previewVideo.src = `/api/localfile?path=${encodeURIComponent(this.localPath)}`;
      this.previewVideo.currentTime = 0;
    }

    _render() {
      const rect = this.container.getBoundingClientRect();
      if (rect.width === 0) return;

      const containerWidth = rect.width - 24 - 60; // padding + label
      this.pixelsPerSecond = containerWidth / this.duration;

      this.videoBlock.style.width = (this.duration * this.pixelsPerSecond) + 'px';
      this.videoBlock.style.left = '0px';

      this._renderRuler();
      this.updatePlayhead(this.previewVideo.currentTime || 0);
    }

    _renderRuler() {
      this.ruler.innerHTML = '';
      const totalDuration = this.duration;
      const targetTicks = 10;
      let step = totalDuration / targetTicks;
      if (step < 1) step = 1;
      else if (step < 2) step = 2;
      else if (step < 5) step = 5;
      else if (step < 10) step = 10;
      else step = Math.ceil(step / 10) * 10;

      for (let t = 0; t <= totalDuration; t += step) {
        const tick = document.createElement('div');
        tick.className = 'ruler-tick';
        tick.style.left = (t * this.pixelsPerSecond) + 'px';
        const label = document.createElement('div');
        label.className = 'ruler-label';
        label.textContent = formatTime(t);
        tick.appendChild(label);
        this.ruler.appendChild(tick);
      }
    }

    _renderSelections() {
      // Remove old selection elements from trackContent
      this.trackContent.querySelectorAll('.concat-selection').forEach(el => el.remove());
      selectionListEl.innerHTML = '';

      this.selections.forEach((sel, idx) => {
        // Timeline visual — inside trackContent so coordinates match exactly
        const el = document.createElement('div');
        el.className = 'concat-selection';
        el.style.left = this._timeToPx(sel.start) + 'px';
        el.style.width = this._timeToPx(sel.end - sel.start) + 'px';

        // Number label on timeline selection
        const numLabel = document.createElement('span');
        numLabel.className = 'concat-selection-num';
        numLabel.textContent = idx + 1;
        el.appendChild(numLabel);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = '×';
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          this.removeSelection(idx);
        };
        el.appendChild(removeBtn);

        el.onclick = () => {
          this.previewVideo.currentTime = sel.start;
          this.previewVideo.play().catch(() => {});
        };

        this.trackContent.appendChild(el);

        // Chip list — draggable via pointer events
        const chip = document.createElement('div');
        chip.className = 'selection-chip';
        chip.dataset.idx = idx;

        const dur = sel.end - sel.start;
        chip.innerHTML = `<span class="chip-grip">⠿</span><span class="chip-idx">${idx + 1}.</span>`;

        // Editable start/end timecodes
        const startInput = document.createElement('input');
        startInput.className = 'chip-time';
        startInput.type = 'text';
        startInput.value = formatTime(sel.start);
        const dash = document.createElement('span');
        dash.textContent = '–';
        const endInput = document.createElement('input');
        endInput.className = 'chip-time';
        endInput.type = 'text';
        endInput.value = formatTime(sel.end);

        const commit = (input, field) => {
          const t = parseTime(input.value);
          if (t === null) { input.value = formatTime(field === 'start' ? sel.start : sel.end); return; }
          this.editSelectionTime(idx, field, t);
        };
        [[startInput, 'start'], [endInput, 'end']].forEach(([input, field]) => {
          // Don't let clicks/drags inside the input start a chip reorder
          input.addEventListener('mousedown', e => e.stopPropagation());
          input.addEventListener('change', () => commit(input, field));
          input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
        });

        chip.appendChild(startInput);
        chip.appendChild(dash);
        chip.appendChild(endInput);

        const durLabel = document.createElement('span');
        durLabel.className = 'chip-dur';
        durLabel.textContent = formatTime(dur);
        chip.appendChild(durLabel);

        const chipRemove = document.createElement('button');
        chipRemove.className = 'chip-remove';
        chipRemove.textContent = '×';
        chipRemove.onclick = () => this.removeSelection(idx);
        chip.appendChild(chipRemove);

        // Pointer-based drag reorder
        chip.style.touchAction = 'none';
        chip.addEventListener('mousedown', (e) => {
          if (e.target.closest('.chip-remove')) return;
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          this._startChipDrag(chip, idx, e);
        });

        selectionListEl.appendChild(chip);
      });

      // Timecode summary below chips
      this._renderTimecodeBar();
      concatExportBtn.disabled = this.selections.length === 0;
    }

    _renderTimecodeBar() {
      let bar = document.getElementById('concatTimecodeBar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'concatTimecodeBar';
        bar.className = 'concat-timecode-bar';
        selectionListEl.parentNode.insertBefore(bar, selectionListEl.nextSibling);
      }
      if (this.selections.length === 0) {
        bar.textContent = '';
        return;
      }
      const totalDur = this.selections.reduce((sum, s) => sum + (s.end - s.start), 0);
      const parts = this.selections.map((s, i) => `${formatTime(s.end - s.start)}`);
      bar.innerHTML = `<span class="timecode-segments">${parts.join(' + ')}</span> = <strong>${formatTime(totalDur)}</strong> total`;
    }

    _startChipDrag(chip, fromIdx, startEvent) {
      const chips = [...selectionListEl.querySelectorAll('.selection-chip')];
      const startX = startEvent.clientX;
      const startY = startEvent.clientY;
      let dragging = false;
      let ghost = null;
      let currentOver = null;

      const onMove = (e) => {
        e.preventDefault();
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!dragging && Math.abs(dx) + Math.abs(dy) > 5) {
          dragging = true;
          ghost = chip.cloneNode(true);
          ghost.className = 'selection-chip chip-ghost';
          const rect = chip.getBoundingClientRect();
          ghost.style.width = rect.width + 'px';
          document.body.appendChild(ghost);
          chip.classList.add('dragging');
        }
        if (dragging && ghost) {
          ghost.style.left = (e.clientX - ghost.offsetWidth / 2) + 'px';
          ghost.style.top = (e.clientY - ghost.offsetHeight / 2) + 'px';

          // Find which chip we're over
          chips.forEach(c => c.classList.remove('drag-over'));
          currentOver = null;
          for (const c of chips) {
            if (c === chip) continue;
            const r = c.getBoundingClientRect();
            if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
              c.classList.add('drag-over');
              currentOver = parseInt(c.dataset.idx, 10);
              break;
            }
          }
        }
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        chips.forEach(c => c.classList.remove('drag-over'));
        chip.classList.remove('dragging');
        if (ghost) { ghost.remove(); ghost = null; }

        if (dragging && currentOver !== null && currentOver !== fromIdx) {
          const [moved] = this.selections.splice(fromIdx, 1);
          this.selections.splice(currentOver, 0, moved);
          this._renderSelections();
        }
      };

      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    }

    addSelection(start, end) {
      if (start > end) [start, end] = [end, start];
      start = Math.max(0, start);
      end = Math.min(this.duration, end);
      if (end - start < 0.1) return; // Too small
      
      this.selections.push({ start, end });
      this._renderSelections();
    }

    removeSelection(idx) {
      this.selections.splice(idx, 1);
      this._renderSelections();
    }

    // Edit a selection's start or end timecode (seconds). Clamps to bounds and keeps a minimum 0.1s gap.
    editSelectionTime(idx, field, newTime) {
      const sel = this.selections[idx];
      if (!sel) return;
      newTime = Math.max(0, Math.min(this.duration, newTime));
      if (field === 'start') sel.start = Math.min(newTime, sel.end - 0.1);
      else sel.end = Math.max(newTime, sel.start + 0.1);
      this._renderSelections();
    }

    // Convert clientX to time using trackContent as reference
    _xToTime(clientX) {
      const rect = this.trackContent.getBoundingClientRect();
      const x = clientX - rect.left;
      return Math.max(0, Math.min(this.duration, x / this.pixelsPerSecond));
    }

    // Convert time to px offset within trackContent
    _timeToPx(t) {
      return t * this.pixelsPerSecond;
    }

    _attach() {
      let dragStart = null;
      let dragStartX = null;
      let tempSelection = null;
      let isDragging = false;

      // Create new selection by dragging on empty track area
      const onDown = (e) => {
        if (e.target.closest('.concat-selection')) return;
        e.preventDefault();

        dragStart = this._xToTime(e.clientX);
        dragStartX = e.clientX;
        isDragging = false;

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };

      const onMove = (e) => {
        if (dragStart === null) return;

        if (!isDragging && Math.abs(e.clientX - dragStartX) > 5) {
          isDragging = true;
          tempSelection = document.createElement('div');
          tempSelection.className = 'concat-selection';
          tempSelection.style.opacity = '0.7';
          this.trackContent.appendChild(tempSelection);
        }

        if (isDragging && tempSelection) {
          const time = this._xToTime(e.clientX);
          const left = Math.min(dragStart, time);
          const width = Math.abs(time - dragStart);
          tempSelection.style.left = this._timeToPx(left) + 'px';
          tempSelection.style.width = this._timeToPx(width) + 'px';
        }
      };

      const onUp = (e) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);

        if (tempSelection) {
          tempSelection.remove();
          tempSelection = null;
        }

        if (dragStart !== null) {
          if (isDragging) {
            const time = this._xToTime(e.clientX);
            this.addSelection(dragStart, time);
          } else {
            this.previewVideo.currentTime = dragStart;
            this.updatePlayhead(dragStart);
          }
          dragStart = null;
          dragStartX = null;
          isDragging = false;
        }
      };

      this.trackContent.addEventListener('mousedown', onDown);

      // Drag existing selections to reposition on timeline
      this.trackContent.addEventListener('mousedown', (e) => {
        const selEl = e.target.closest('.concat-selection');
        if (!selEl || e.target.closest('.remove-btn')) return;
        e.preventDefault();
        e.stopPropagation();

        const selEls = [...this.trackContent.querySelectorAll('.concat-selection')];
        const idx = selEls.indexOf(selEl);
        if (idx < 0) return;
        const sel = this.selections[idx];
        const duration = sel.end - sel.start;

        // Where within the selection did the user grab?
        const grabTime = this._xToTime(e.clientX);
        const grabOffset = grabTime - sel.start;

        selEl.style.opacity = '0.5';
        selEl.style.cursor = 'grabbing';

        const onSelMove = (ev) => {
          const t = this._xToTime(ev.clientX);
          let newStart = t - grabOffset;
          // Clamp to timeline bounds
          newStart = Math.max(0, Math.min(this.duration - duration, newStart));
          sel.start = newStart;
          sel.end = newStart + duration;
          selEl.style.left = this._timeToPx(sel.start) + 'px';

          // Update the matching chip timecode live
          const chip = selectionListEl.children[idx];
          if (chip) {
            const spanEl = chip.querySelector('span:nth-child(2)');
            if (spanEl) spanEl.textContent = `${idx + 1}. ${formatTime(sel.start)} – ${formatTime(sel.end)}`;
          }
          this._renderTimecodeBar();
        };

        const onSelUp = () => {
          document.removeEventListener('mousemove', onSelMove, true);
          document.removeEventListener('mouseup', onSelUp, true);
          selEl.style.opacity = '';
          selEl.style.cursor = '';
          this._renderSelections();
        };

        document.addEventListener('mousemove', onSelMove, true);
        document.addEventListener('mouseup', onSelUp, true);
      });
    }

    _attachResize() {
      const ro = new ResizeObserver(() => {
        if (this.duration > 0) {
          this._render();
          this._renderSelections();
        }
      });
      ro.observe(this.container);
    }

    _attachPlayhead() {
      this.previewVideo.addEventListener('timeupdate', () => {
        if (!this.duration) return;
        this.updatePlayhead(this.previewVideo.currentTime);
      });
    }

    updatePlayhead(time) {
      const trackContentRect = this.trackContent.getBoundingClientRect();
      const containerRect = this.container.getBoundingClientRect();
      const trackContentLeft = trackContentRect.left - containerRect.left;
      
      const pxPos = trackContentLeft + (time * this.pixelsPerSecond);
      this.playhead.style.left = pxPos + 'px';
    }

    getSelections() {
      return this.selections.slice().sort((a, b) => a.start - b.start);
    }
  }

  concatPlayPauseBtn.addEventListener('click', () => {
    if (concatPreviewVideo.paused) {
      concatPreviewVideo.play().then(() => {
        concatPlayPauseBtn.textContent = 'Pause';
      }).catch(() => {});
    } else {
      concatPreviewVideo.pause();
      concatPlayPauseBtn.textContent = 'Play';
    }
  });

  concatPreviewVideo.addEventListener('play', () => {
    concatPlayPauseBtn.textContent = 'Pause';
  });

  concatPreviewVideo.addEventListener('pause', () => {
    concatPlayPauseBtn.textContent = 'Play';
  });

  concatExportBtn.addEventListener('click', async () => {
    if (!concatTimeline || !concatLocalPath) return;
    const selections = concatTimeline.getSelections();
    if (selections.length === 0) {
      alert('Please create at least one selection on the timeline');
      return;
    }

    const form = new FormData();
    form.append('filePath', concatLocalPath);
    form.append('selections', JSON.stringify(selections));
    form.append('filename', sanitizeFilename('concatenated.mp4'));
    form.append('faststart', document.getElementById('concatFaststart').checked ? '1' : '0');

    concatExportBtn.disabled = true;
    concatExportBtn.textContent = 'Export 0%';

    try {
      const resp = await fetch('/api/concat', { method: 'POST', body: form });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'progress') {
              concatExportBtn.textContent = `Export ${data.percent}%`;
            } else if (data.type === 'complete') {
              if (data.downloadUrl) {
                const a = document.createElement('a');
                a.href = data.downloadUrl;
                a.download = data.filename || 'concatenated.mp4';
                document.body.appendChild(a);
                a.click();
                a.remove();
              } else {
                const binary = atob(data.data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                  bytes[i] = binary.charCodeAt(i);
                }
                const blob = new Blob([bytes], { type: 'video/mp4' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = data.filename || 'concatenated.mp4';
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              }
            } else if (data.type === 'error') {
              throw new Error(data.error + (data.details ? ': ' + data.details : ''));
            }
          } catch (e) {
            if (e.message && !e.message.includes('JSON')) throw e;
          }
        }
      }
    } catch (err) {
      console.error('Export error:', err);
      alert(err.message || String(err));
    } finally {
      concatExportBtn.disabled = false;
      concatExportBtn.textContent = 'Concatenate Selected';
    }
  });

  // ========== BUTT-JOINER ==========
  {
    const joinerBrowseBtn = document.getElementById('joinerBrowseBtn');
    const joinerFileInfo = document.getElementById('joinerFileInfo');
    const joinerSection = document.getElementById('joinerSection');
    const joinerList = document.getElementById('joinerList');
    const joinerExportBtn = document.getElementById('joinerExportBtn');
    const joinerProgress = document.getElementById('joinerProgress');
    const joinerProgressFill = document.getElementById('joinerProgressFill');
    const joinerProgressLabel = document.getElementById('joinerProgressLabel');

    let joinerClips = []; // [{path, name}]

    function renderJoinerList() {
      joinerList.innerHTML = '';
      joinerClips.forEach((clip, idx) => {
        const li = document.createElement('li');
        li.className = 'joiner-item';
        li.innerHTML = `
          <span class="joiner-item-num">${idx + 1}</span>
          <span class="joiner-item-name" title="${clip.path}">${clip.name}</span>
          <div class="joiner-item-btns">
            <button class="joiner-move" data-dir="-1" ${idx === 0 ? 'disabled' : ''}>↑</button>
            <button class="joiner-move" data-dir="1" ${idx === joinerClips.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="joiner-remove">✕</button>
          </div>
        `;
        li.querySelector('.joiner-remove').addEventListener('click', () => {
          joinerClips.splice(idx, 1);
          renderJoinerList();
          updateJoinerInfo();
        });
        li.querySelectorAll('.joiner-move').forEach(btn => {
          btn.addEventListener('click', () => {
            const dir = parseInt(btn.dataset.dir);
            const newIdx = idx + dir;
            if (newIdx < 0 || newIdx >= joinerClips.length) return;
            [joinerClips[idx], joinerClips[newIdx]] = [joinerClips[newIdx], joinerClips[idx]];
            renderJoinerList();
          });
        });
        joinerList.appendChild(li);
      });
      joinerExportBtn.disabled = joinerClips.length < 2;
    }

    function updateJoinerInfo() {
      if (joinerClips.length === 0) {
        setHidden(joinerSection, true);
        setHidden(joinerFileInfo, true);
        return;
      }
      joinerFileInfo.textContent = `${joinerClips.length} clip${joinerClips.length > 1 ? 's' : ''} selected`;
      setHidden(joinerFileInfo, false);
      setHidden(joinerSection, false);
    }

    joinerBrowseBtn.addEventListener('click', async () => {
      try {
        const paths = await browseFiles('mov,mp4', true);
        if (!paths.length) return;
        for (const p of paths) {
          if (!joinerClips.find(c => c.path === p)) {
            joinerClips.push({ path: p, name: p.split('/').pop() });
          }
        }
        renderJoinerList();
        updateJoinerInfo();
      } catch (err) { alert('Browse error: ' + err.message); }
    });

    joinerExportBtn.addEventListener('click', async () => {
      if (joinerClips.length < 2) return;
      joinerExportBtn.disabled = true;
      setHidden(joinerProgress, false);
      joinerProgressFill.style.width = '0%';
      joinerProgressLabel.textContent = '0%';

      const firstName = joinerClips[0].name.replace(/\.[^.]+$/, '');
      const outName = `${firstName}_joined.mp4`;

      try {
        const formData = new URLSearchParams();
        formData.set('filePaths', JSON.stringify(joinerClips.map(c => c.path)));
        formData.set('filename', outName);
        formData.set('faststart', document.getElementById('joinFaststart').checked ? '1' : '0');

        const resp = await fetch('/api/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData.toString()
        });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) {
            const line = part.replace(/^data: /, '').trim();
            if (!line) continue;
            try {
              const msg = JSON.parse(line);
              if (msg.type === 'progress') {
                joinerProgressFill.style.width = msg.percent + '%';
                joinerProgressLabel.textContent = msg.percent + '%';
              } else if (msg.type === 'complete') {
                joinerProgressFill.style.width = '100%';
                joinerProgressLabel.textContent = 'Done!';
                const a = document.createElement('a');
                a.href = msg.downloadUrl;
                a.download = msg.filename;
                a.click();
                joinerExportBtn.disabled = false;
              } else if (msg.type === 'error') {
                alert('Join failed: ' + msg.details);
                joinerExportBtn.disabled = false;
                setHidden(joinerProgress, true);
              }
            } catch {}
          }
        }
      } catch (err) {
        alert('Join error: ' + err.message);
        joinerExportBtn.disabled = false;
        setHidden(joinerProgress, true);
      }
    });
  }

  // ========== SPEEDER-UPPER ==========
  const speederFileInfo = document.getElementById('speederFileInfo');
  const speederSection = document.getElementById('speederSection');
  const speederPreviewVideo = document.getElementById('speederPreviewVideo');
  const speederPreviewWrap = speederPreviewVideo.closest('.preview-wrap');
  const speedFactorInput = document.getElementById('speedFactor');
  const lockFpsCheckbox = document.getElementById('lockFps');
  const origDurationEl = document.getElementById('origDuration');
  const newDurationEl = document.getElementById('newDuration');
  const speedInfoEl = document.getElementById('speedInfo');
  const speederExportBtn = document.getElementById('speederExportBtn');
  const speederBatchMode = document.getElementById('speederBatchMode');
  const speederBatchList = document.getElementById('speederBatchList');

  let speederLocalPath = null;
  let speederOrigDuration = 0;
  let speederBatchFiles = []; // [{ path, filename, size, duration }]

  function renderSpeederBatchList() {
    const factor = parseFloat(speedFactorInput.value) || 1.0;
    speederBatchList.innerHTML = '';
    speederBatchFiles.forEach((f, idx) => {
      const newDur = factor > 0 ? f.duration / factor : f.duration;
      const li = document.createElement('li');
      li.className = 'joiner-item';
      li.innerHTML = `
        <span class="joiner-item-num">${idx + 1}</span>
        <span class="joiner-item-name">${f.filename} • ${(f.size/1e6).toFixed(1)} MB</span>
        <span class="joiner-item-dur">${formatTime(f.duration)} → ${formatTime(newDur)}</span>
        <div class="joiner-item-btns"><button data-remove="${idx}">✕</button></div>
      `;
      speederBatchList.appendChild(li);
    });
    speederBatchList.querySelectorAll('button[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = parseInt(btn.getAttribute('data-remove'), 10);
        speederBatchFiles.splice(i, 1);
        renderSpeederBatchList();
        updateSpeederVisibility();
      });
    });
  }

  function updateSpeederVisibility() {
    const batch = speederBatchMode.checked;
    setHidden(speederBatchList, !batch || speederBatchFiles.length === 0);
    setHidden(speederPreviewWrap, batch);
    setHidden(speedInfoEl, batch);
    if (batch) {
      setHidden(speederFileInfo, true);
      setHidden(speederSection, speederBatchFiles.length === 0);
    } else {
      setHidden(speederFileInfo, !speederLocalPath);
      setHidden(speederSection, !speederLocalPath);
    }
  }

  speederBatchMode.addEventListener('change', () => {
    if (speederBatchMode.checked) {
      speederLocalPath = null;
      speederPreviewVideo.removeAttribute('src');
      speederPreviewVideo.load();
    } else {
      speederBatchFiles = [];
      renderSpeederBatchList();
    }
    updateSpeederVisibility();
  });

  document.getElementById('speederBrowseBtn').addEventListener('click', async () => {
    const batch = speederBatchMode.checked;
    const paths = await browseFiles('mov,mp4', batch);
    if (!paths.length) return;
    try {
      if (batch) {
        for (const p of paths) {
          if (speederBatchFiles.find(f => f.path === p)) continue;
          const info = await probeLocalPath(p);
          speederBatchFiles.push({ path: p, filename: info.filename, size: info.size, duration: info.duration });
        }
        renderSpeederBatchList();
        updateSpeederVisibility();
      } else {
        const p = paths[0];
        const info = await probeLocalPath(p);
        speederLocalPath = p;
        speederFileInfo.textContent = `${info.filename} • ${(info.size/1e6).toFixed(1)} MB`;
        speederPreviewVideo.src = `/api/localfile?path=${encodeURIComponent(p)}`;
        speederOrigDuration = info.duration;
        origDurationEl.textContent = formatTime(speederOrigDuration);
        updateNewDuration();
        updateSpeederVisibility();
      }
    } catch (err) { alert('Path error: ' + err.message); }
  });

  function updateNewDuration() {
    const factor = parseFloat(speedFactorInput.value) || 1.0;
    if (factor <= 0) return;
    const newDur = speederOrigDuration / factor;
    newDurationEl.textContent = formatTime(newDur);
  }

  speedFactorInput.addEventListener('input', () => {
    updateNewDuration();
    if (speederBatchMode.checked) renderSpeederBatchList();
  });

  async function runSpeedupJob({ filePath, duration, factor, lockFps, outputFilename, progressLabel }) {
    const form = new FormData();
    form.append('filePath', filePath);
    form.append('speedFactor', String(factor));
    form.append('lockFps', String(lockFps));
    form.append('duration', String(duration));
    form.append('filename', sanitizeFilename(outputFilename));

    const resp = await fetch('/api/speedup', { method: 'POST', body: form });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    let fatalError = null;

    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch { continue; }
          if (data.type === 'progress') {
            speederExportBtn.textContent = `${progressLabel} ${data.percent}%`;
          } else if (data.type === 'complete') {
            if (data.downloadUrl) {
              const a = document.createElement('a');
              a.href = data.downloadUrl;
              a.download = data.filename || outputFilename;
              document.body.appendChild(a);
              a.click();
              a.remove();
            } else if (data.data) {
              const binary = atob(data.data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
              const blob = new Blob([bytes], { type: 'video/mp4' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = data.filename || outputFilename;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            }
            finished = true;
            break;
          } else if (data.type === 'error') {
            fatalError = new Error(data.error + (data.details ? ': ' + data.details : ''));
            finished = true;
            break;
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    if (fatalError) throw fatalError;
  }

  function spedFilenameFor(originalFilename) {
    const base = originalFilename.replace(/\.[^.]+$/, '');
    return `${base}_sped.mp4`;
  }

  speederExportBtn.addEventListener('click', async () => {
    const batch = speederBatchMode.checked;
    if (batch && speederBatchFiles.length === 0) return;
    if (!batch && !speederLocalPath) return;

    const factor = parseFloat(speedFactorInput.value) || 1.0;
    const lockFps = lockFpsCheckbox.checked;

    speederExportBtn.disabled = true;

    try {
      if (batch) {
        for (let i = 0; i < speederBatchFiles.length; i++) {
          const f = speederBatchFiles[i];
          const label = `File ${i + 1}/${speederBatchFiles.length}`;
          speederExportBtn.textContent = `${label} 0%`;
          await runSpeedupJob({
            filePath: f.path,
            duration: f.duration,
            factor,
            lockFps,
            outputFilename: spedFilenameFor(f.filename),
            progressLabel: label
          });
        }
        speederExportBtn.textContent = `Done — ${speederBatchFiles.length} files`;
      } else {
        speederExportBtn.textContent = 'Exporting 0%';
        await runSpeedupJob({
          filePath: speederLocalPath,
          duration: speederOrigDuration,
          factor,
          lockFps,
          outputFilename: 'sped_up.mp4',
          progressLabel: 'Exporting'
        });
      }
    } catch (err) {
      console.error('Speeder export error:', err);
      alert(err.message || String(err));
    } finally {
      speederExportBtn.disabled = false;
      setTimeout(() => { speederExportBtn.textContent = 'Speed Up & Export'; }, 1500);
    }
  });

  // ========== REEL/LINKEDIN TIMELAPSER ==========
  const timelapseTopList = document.getElementById('timelapseTopList');
  const timelapseBottomList = document.getElementById('timelapseBottomList');
  const timelapserSection = document.getElementById('timelapserSection');
  const timelapseOrigDurationEl = document.getElementById('timelapseOrigDuration');
  const timelapseNewDurationEl = document.getElementById('timelapseNewDuration');
  const timelapseDoubleResCheckbox = document.getElementById('timelapseDoubleRes');
  const timelapseExportBtn = document.getElementById('timelapseExportBtn');
  const timelapseLog = document.getElementById('timelapseLog');

  let timelapseTopFiles = []; // Array of { duration, speedFactor, localPath, filename, size }
  let timelapseBottomFiles = [];
  let timelapsePanes = {};
  document.getElementById('timelapseTopBrowseBtn').addEventListener('click', async () => {
    const paths = await browseFiles('mov,mp4', true);
    if (!paths.length) return;
    try {
      timelapseTopFiles = [];
      for (const p of paths) {
        const info = await probeLocalPath(p);
        timelapseTopFiles.push({ duration: info.duration, speedFactor: 1.0, localPath: p, filename: info.filename, size: info.size });
      }
      renderTimelapseList('top');
      updateTimelapseTotals();
    } catch (err) { alert('Path error: ' + err.message); }
  });

  document.getElementById('timelapseBottomBrowseBtn').addEventListener('click', async () => {
    const paths = await browseFiles('mov,mp4', true);
    if (!paths.length) return;
    try {
      timelapseBottomFiles = [];
      for (const p of paths) {
        const info = await probeLocalPath(p);
        timelapseBottomFiles.push({ duration: info.duration, speedFactor: 1.0, localPath: p, filename: info.filename, size: info.size });
      }
      renderTimelapseList('bottom');
      updateTimelapseTotals();
    } catch (err) { alert('Path error: ' + err.message); }
  });

  function renderTimelapseList(position) {
    const list = position === 'top' ? timelapseTopFiles : timelapseBottomFiles;
    const listEl = position === 'top' ? timelapseTopList : timelapseBottomList;

    listEl.innerHTML = '';
    list.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'timelapse-item';
      li.innerHTML = `
        <div class="timelapse-item-header">
          <span class="timelapse-item-name" title="${item.filename}">${item.filename}</span>
          <button class="timelapse-item-remove" data-idx="${idx}">×</button>
        </div>
        <div class="timelapse-item-controls">
          <span>Orig: ${formatTime(item.duration)}</span>
          <label>Speed: <input type="number" step="0.1" min="0.1" value="${item.speedFactor}" class="small-input speed-input" data-idx="${idx}"></label>
          <span class="new-dur">New: ${formatTime(item.duration / item.speedFactor)}</span>
        </div>
      `;
      
      li.querySelector('.timelapse-item-remove').addEventListener('click', () => {
        list.splice(idx, 1);
        renderTimelapseList(position);
        updateTimelapseTotals();
      });
      
      li.querySelector('.speed-input').addEventListener('input', (e) => {
        const factor = parseFloat(e.target.value) || 1.0;
        item.speedFactor = factor;
        li.querySelector('.new-dur').textContent = `New: ${formatTime(item.duration / factor)}`;
        updateTimelapseTotals();
      });
      
      listEl.appendChild(li);
    });
  }

  function updateTimelapseTotals() {
    if (timelapseTopFiles.length > 0 && timelapseBottomFiles.length > 0) {
      setHidden(timelapserSection, false);

      const topOrig = timelapseTopFiles.reduce((sum, item) => sum + item.duration, 0);
      const bottomOrig = timelapseBottomFiles.reduce((sum, item) => sum + item.duration, 0);
      const maxOrig = Math.max(topOrig, bottomOrig);
      timelapseOrigDurationEl.textContent = formatTime(maxOrig);

      const topNew = timelapseTopFiles.reduce((sum, item) => sum + (item.duration / item.speedFactor), 0);
      const bottomNew = timelapseBottomFiles.reduce((sum, item) => sum + (item.duration / item.speedFactor), 0);
      const maxNew = Math.max(topNew, bottomNew);
      timelapseNewDurationEl.textContent = formatTime(maxNew);

      timelapseExportBtn.disabled = false;
      buildTimelapsePreview();
    } else {
      setHidden(timelapserSection, true);
      setHidden(document.getElementById('timelapsePreview'), true);
      timelapseExportBtn.disabled = true;
    }
  }

  async function buildTimelapsePreview() {
    const previewEl = document.getElementById('timelapsePreview');
    if (timelapseTopFiles.length === 0 || timelapseBottomFiles.length === 0) {
      setHidden(previewEl, true);
      return;
    }
    try {
      const topSrc = `/api/localfile?path=${encodeURIComponent(timelapseTopFiles[0].localPath)}`;
      const bottomSrc = `/api/localfile?path=${encodeURIComponent(timelapseBottomFiles[0].localPath)}`;
      const topFrame = await extractFirstFrame(topSrc);
      const bottomFrame = await extractFirstFrame(bottomSrc);

      const doubleRes = timelapseDoubleResCheckbox.checked;
      const baseWidth = doubleRes ? 2160 : 1080;
      const sqHalfH = doubleRes ? 1080 : 540;
      const reelsHalfH = doubleRes ? 1920 : 960;

      ['sqTopPane', 'sqBottomPane', 'reelsTopPane', 'reelsBottomPane'].forEach(id => {
        document.getElementById(id).innerHTML = '';
      });

      const sqTop = new PaneController(document.getElementById('sqTopPane'), topFrame.canvas, baseWidth, sqHalfH);
      sqTop.setScaleMode('width');
      const sqBottom = new PaneController(document.getElementById('sqBottomPane'), bottomFrame.canvas, baseWidth, sqHalfH);
      sqBottom.setScaleMode('width');

      const reelsTop = new PaneController(document.getElementById('reelsTopPane'), topFrame.canvas, baseWidth, reelsHalfH);
      reelsTop.setScaleMode('height');
      const reelsBottom = new PaneController(document.getElementById('reelsBottomPane'), bottomFrame.canvas, baseWidth, reelsHalfH);
      reelsBottom.setScaleMode('height');

      timelapsePanes = { sqTop, sqBottom, reelsTop, reelsBottom };
      setHidden(previewEl, false);
    } catch (err) {
      console.error('Preview build failed:', err);
    }
  }

  timelapseDoubleResCheckbox.addEventListener('change', () => {
    buildTimelapsePreview();
  });

  timelapseExportBtn.addEventListener('click', async () => {
    if (timelapseTopFiles.length === 0 || timelapseBottomFiles.length === 0) return;

    const form = new FormData();
    form.append('topFilePaths', JSON.stringify(timelapseTopFiles.map(i => i.localPath)));
    timelapseTopFiles.forEach(item => form.append('topFactors', String(item.speedFactor)));
    form.append('bottomFilePaths', JSON.stringify(timelapseBottomFiles.map(i => i.localPath)));
    timelapseBottomFiles.forEach(item => form.append('bottomFactors', String(item.speedFactor)));

    form.append('doubleRes', String(timelapseDoubleResCheckbox.checked));
    const topNew = timelapseTopFiles.reduce((sum, item) => sum + (item.duration / item.speedFactor), 0);
    const bottomNew = timelapseBottomFiles.reduce((sum, item) => sum + (item.duration / item.speedFactor), 0);
    form.append('duration', String(Math.max(topNew, bottomNew)));
    form.append('filename', sanitizeFilename('timelapse.mp4'));

    if (timelapsePanes.sqTop) {
      form.append('sqTopCropX', String(timelapsePanes.sqTop.getCropX()));
      form.append('sqTopCropY', String(timelapsePanes.sqTop.getCropY()));
      form.append('sqTopZoom', String(timelapsePanes.sqTop.getZoom()));
      form.append('sqBottomCropX', String(timelapsePanes.sqBottom.getCropX()));
      form.append('sqBottomCropY', String(timelapsePanes.sqBottom.getCropY()));
      form.append('sqBottomZoom', String(timelapsePanes.sqBottom.getZoom()));
      form.append('reelsTopCropX', String(timelapsePanes.reelsTop.getCropX()));
      form.append('reelsTopCropY', String(timelapsePanes.reelsTop.getCropY()));
      form.append('reelsTopZoom', String(timelapsePanes.reelsTop.getZoom()));
      form.append('reelsBottomCropX', String(timelapsePanes.reelsBottom.getCropX()));
      form.append('reelsBottomCropY', String(timelapsePanes.reelsBottom.getCropY()));
      form.append('reelsBottomZoom', String(timelapsePanes.reelsBottom.getZoom()));
    }

    timelapseExportBtn.disabled = true;
    timelapseExportBtn.textContent = 'Exporting 0%';
    timelapseLog.innerHTML = '';
    setHidden(timelapseLog, false);

    const appendLog = (msg) => {
      const div = document.createElement('div');
      div.textContent = msg;
      timelapseLog.appendChild(div);
      timelapseLog.scrollTop = timelapseLog.scrollHeight;
    };

    try {
      const resp = await fetch('/api/timelapse', { method: 'POST', body: form });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'progress') {
              timelapseExportBtn.textContent = `Exporting ${data.percent}%`;
            } else if (data.type === 'log') {
              appendLog(data.message);
            } else if (data.type === 'complete') {
              const binary = atob(data.data);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: 'video/mp4' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = data.filename;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
            } else if (data.type === 'error') {
              throw new Error(data.error + (data.details ? ': ' + data.details : ''));
            }
          } catch (e) {
            if (e.message && !e.message.includes('JSON')) throw e;
          }
        }
      }
    } catch (err) {
      console.error('Timelapse export error:', err);
      alert(err.message || String(err));
    } finally {
      timelapseExportBtn.disabled = false;
      timelapseExportBtn.textContent = 'Export Timelapses';
    }
  });
})();

// ========== SHRINKER ==========
(function() {
  const shrinkerFileInfo = document.getElementById('shrinkerFileInfo');
  const shrinkerSection = document.getElementById('shrinkerSection');
  const shrinkerPreviewVideo = document.getElementById('shrinkerPreviewVideo');
  const shrinkerExportBtn = document.getElementById('shrinkerExportBtn');
  const shrinkerInfo = document.getElementById('shrinkerInfo');

  let shrinkerLocalPath = null;
  let shrinkerOrigSize = 0;
  let shrinkerOrigW = 0;
  let shrinkerOrigH = 0;

  function setHidden(el, hidden) {
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function updateInfo() {
    const newH = Math.round(shrinkerOrigH * (1920 / shrinkerOrigW));
    shrinkerInfo.textContent = `${shrinkerOrigW}x${shrinkerOrigH} → 1920x${newH} • ${(shrinkerOrigSize / 1e6).toFixed(1)} MB original`;
  }

  document.getElementById('shrinkerBrowseBtn').addEventListener('click', async () => {
    const resp = await fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: 'mov,mp4', multiple: false })
    });
    const data = await resp.json();
    if (data.canceled || !data.paths || !data.paths.length) return;
    const p = data.paths[0];
    try {
      const probeResp = await fetch('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: p })
      });
      if (!probeResp.ok) throw new Error('Probe failed');
      const info = await probeResp.json();
      shrinkerLocalPath = p;
      shrinkerOrigSize = info.size;
      shrinkerOrigW = info.width;
      shrinkerOrigH = info.height;
      shrinkerFileInfo.textContent = `${info.filename} • ${(info.size / 1e6).toFixed(1)} MB`;
      setHidden(shrinkerFileInfo, false);
      setHidden(shrinkerSection, false);
      shrinkerPreviewVideo.src = `/api/localfile?path=${encodeURIComponent(p)}`;
      updateInfo();
    } catch (err) { alert('Path error: ' + err.message); }
  });

  shrinkerExportBtn.addEventListener('click', async () => {
    if (!shrinkerLocalPath) return;

    const form = new FormData();
    form.append('filePath', shrinkerLocalPath);
    const baseName = shrinkerLocalPath.split('/').pop().replace(/\.[^.]+$/, '');
    form.append('filename', `${baseName}_1920.mp4`);

    shrinkerExportBtn.disabled = true;
    shrinkerExportBtn.textContent = 'Shrinking 0%';

    try {
      const resp = await fetch('/api/shrink', { method: 'POST', body: form });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.type === 'progress') {
              shrinkerExportBtn.textContent = `Shrinking ${d.percent}%`;
            } else if (d.type === 'complete') {
              if (d.downloadUrl) {
                const a = document.createElement('a');
                a.href = d.downloadUrl;
                a.download = d.filename || 'shrunk.mp4';
                document.body.appendChild(a);
                a.click();
                a.remove();
              }
            } else if (d.type === 'error') {
              throw new Error(d.error + (d.details ? ': ' + d.details : ''));
            }
          } catch (e) {
            if (e.message && !e.message.includes('JSON')) throw e;
          }
        }
      }
    } catch (err) {
      console.error('Shrinker error:', err);
      alert(err.message || String(err));
    } finally {
      shrinkerExportBtn.disabled = false;
      shrinkerExportBtn.textContent = 'Shrink & Export';
    }
  });
})();

// ========== IMAGE PADDER ==========
(function() {
  const padderFileInfo = document.getElementById('padderFileInfo');
  const padderSection = document.getElementById('padderSection');
  const previewBox = document.getElementById('padderPreviewBox');
  const previewImg = document.getElementById('padderPreviewImg');
  const padSlider = document.getElementById('padPct');
  const padPctLabel = document.getElementById('padPctLabel');
  const padderInfo = document.getElementById('padderInfo');
  const padderExportBtn = document.getElementById('padderExportBtn');
  const padForceSquare = document.getElementById('padForceSquare');

  let padderLocalPath = null;
  let padderW = 0;
  let padderH = 0;
  let padderColor = '#ffffff';

  function setHidden(el, hidden) {
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function updatePreview() {
    const pct = parseInt(padSlider.value, 10);
    padPctLabel.textContent = pct + '%';
    if (!padderW) return;
    let outW = Math.ceil(padderW * pct / 100);
    let outH = Math.ceil(padderH * pct / 100);
    if (padForceSquare.checked) outW = outH = Math.max(outW, outH);
    padderInfo.textContent = `${padderW}x${padderH} → ${outW}x${outH} • edge ${padderColor}`;
    previewBox.style.background = padderColor;
    previewBox.style.aspectRatio = `${outW} / ${outH}`;
    previewImg.style.width = (padderW / outW * 100) + '%';
  }

  document.getElementById('padderBrowseBtn').addEventListener('click', async () => {
    const resp = await fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: 'jpg,jpeg,png,gif', multiple: false })
    });
    const data = await resp.json();
    if (data.canceled || !data.paths || !data.paths.length) return;
    const p = data.paths[0];
    try {
      const infoResp = await fetch('/api/pad-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: p })
      });
      if (!infoResp.ok) throw new Error((await infoResp.json()).error || 'Probe failed');
      const info = await infoResp.json();
      padderLocalPath = p;
      padderW = info.width;
      padderH = info.height;
      padderColor = info.color;
      padderFileInfo.textContent = `${info.filename} • ${(info.size / 1e6).toFixed(1)} MB`;
      setHidden(padderFileInfo, false);
      setHidden(padderSection, false);
      previewImg.src = `/api/localfile?path=${encodeURIComponent(p)}`;
      updatePreview();
    } catch (err) { alert('Path error: ' + err.message); }
  });

  padSlider.addEventListener('input', updatePreview);
  padForceSquare.addEventListener('change', updatePreview);

  padderExportBtn.addEventListener('click', async () => {
    if (!padderLocalPath) return;

    const form = new FormData();
    form.append('filePath', padderLocalPath);
    form.append('pct', padSlider.value);
    form.append('color', padderColor);
    form.append('forceSquare', padForceSquare.checked ? '1' : '0');
    const baseName = padderLocalPath.split('/').pop().replace(/\.[^.]+$/, '');
    form.append('filename', `${baseName}_padded`);

    padderExportBtn.disabled = true;
    padderExportBtn.textContent = 'Padding...';

    try {
      const resp = await fetch('/api/pad', { method: 'POST', body: form });
      const d = await resp.json();
      if (!resp.ok) throw new Error(d.error + (d.details ? ': ' + d.details : ''));
      const a = document.createElement('a');
      a.href = d.downloadUrl;
      a.download = d.filename || 'padded';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      console.error('Padder error:', err);
      alert(err.message || String(err));
    } finally {
      padderExportBtn.disabled = false;
      padderExportBtn.textContent = 'Pad & Export';
    }
  });
})();

// ========== VIDEO FLIPPER ==========
(function() {
  const flipFileInfo = document.getElementById('flipFileInfo');
  const flipSection = document.getElementById('flipSection');
  const flipPreviewVideo = document.getElementById('flipPreviewVideo');
  const flipH = document.getElementById('flipH');
  const flipV = document.getElementById('flipV');
  const flipExportBtn = document.getElementById('flipExportBtn');

  let flipLocalPath = null;

  function setHidden(el, hidden) {
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function updatePreviewTransform() {
    const transforms = [];
    if (flipH.checked) transforms.push('scaleX(-1)');
    if (flipV.checked) transforms.push('scaleY(-1)');
    flipPreviewVideo.style.transform = transforms.join(' ');
  }

  document.getElementById('flipBrowseBtn').addEventListener('click', async () => {
    const resp = await fetch('/api/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: 'mov,mp4', multiple: false })
    });
    const data = await resp.json();
    if (data.canceled || !data.paths || !data.paths.length) return;
    const p = data.paths[0];
    try {
      const probeResp = await fetch('/api/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: p })
      });
      if (!probeResp.ok) throw new Error('Probe failed');
      const info = await probeResp.json();
      flipLocalPath = p;
      flipFileInfo.textContent = `${info.filename} • ${(info.size / 1e6).toFixed(1)} MB`;
      setHidden(flipFileInfo, false);
      setHidden(flipSection, false);
      flipPreviewVideo.src = `/api/localfile?path=${encodeURIComponent(p)}`;
      updatePreviewTransform();
    } catch (err) { alert('Path error: ' + err.message); }
  });

  flipH.addEventListener('change', updatePreviewTransform);
  flipV.addEventListener('change', updatePreviewTransform);

  flipExportBtn.addEventListener('click', async () => {
    if (!flipLocalPath) return;
    if (!flipH.checked && !flipV.checked) {
      alert('Select at least one flip direction');
      return;
    }

    const form = new FormData();
    form.append('filePath', flipLocalPath);
    form.append('hflip', flipH.checked ? '1' : '0');
    form.append('vflip', flipV.checked ? '1' : '0');
    const baseName = flipLocalPath.split('/').pop().replace(/\.[^.]+$/, '');
    form.append('filename', `${baseName}_flipped.mp4`);

    flipExportBtn.disabled = true;
    flipExportBtn.textContent = 'Flipping 0%';

    try {
      const resp = await fetch('/api/flip', { method: 'POST', body: form });
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const d = JSON.parse(line.slice(6));
            if (d.type === 'progress') {
              flipExportBtn.textContent = `Flipping ${d.percent}%`;
            } else if (d.type === 'complete') {
              if (d.downloadUrl) {
                const a = document.createElement('a');
                a.href = d.downloadUrl;
                a.download = d.filename || 'flipped.mp4';
                document.body.appendChild(a);
                a.click();
                a.remove();
              }
            } else if (d.type === 'error') {
              throw new Error(d.error + (d.details ? ': ' + d.details : ''));
            }
          } catch (e) {
            if (e.message && !e.message.includes('JSON')) throw e;
          }
        }
      }
    } catch (err) {
      console.error('Flipper error:', err);
      alert(err.message || String(err));
    } finally {
      flipExportBtn.disabled = false;
      flipExportBtn.textContent = 'Flip & Export';
    }
  });

})();

// ========== FAST-CUT MUSIC VIDDER ==========
(function() {
  const $ = (id) => document.getElementById(id);

  function setHidden(el, hidden) {
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  async function postJson(url, payload) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  const addBtn = $('vidderAddBtn');
  const loadBtn = $('vidderLoadBtn');
  const saveBtn = $('vidderSaveBtn');
  const clearBtn = $('vidderClearBtn');
  const fileInfoEl = $('vidderFileInfo');
  const section = $('vidderSection');
  const clipDurInput = $('vidderClipDur');
  const vertOnly = $('vidderVertOnly');
  const musicBtn = $('vidderMusicBtn');
  const musicWrap = $('vidderMusic');
  const musicNameEl = $('vidderMusicName');
  const musicRangeEl = $('vidderMusicRange');
  const musicTrack = $('vidderMusicTrack');
  const musicBox = $('vidderMusicBox');
  const waveEl = $('vidderWave');
  const list = $('vidderList');
  const vids = [$('vidderPreviewA'), $('vidderPreviewB')];
  const playBtn = $('vidderPlayBtn');
  const infoEl = $('vidderInfo');
  const renderBtn = $('vidderRenderBtn');
  const progress = $('vidderProgress');
  const progressFill = $('vidderProgressFill');
  const progressLabel = $('vidderProgressLabel');

  let clips = [];   // [{path, name, duration, width, height, start, dur, strip}]
  let tossed = [];  // non-vertical clips set aside by "Vert vids only"
  let music = null; // {path, name, duration, start, audio}
  let mode = null;  // null | 'loop' | 'seq'
  let modeToken = 0;
  let raf = 0;

  const fileUrl = (p) => `/api/localfile?path=${encodeURIComponent(p)}`;
  const MIN_DUR = 0.1;
  const clipDur = () => Math.max(MIN_DUR, parseFloat(clipDurInput.value) || 2);
  // Server snaps each slice to whole 30fps frames; mirror that so preview timing matches
  const segOf = (c) => Math.max(1, Math.round(Math.min(c.dur, c.duration) * 30)) / 30;
  const totalDur = () => clips.reduce((sum, c) => sum + segOf(c), 0);
  const isVert = (c) => c.height > c.width;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const maxStart = (c) => Math.max(0, c.duration - segOf(c));
  const fmtT = (s) => {
    const ds = Math.round(s * 10);
    const m = Math.floor(ds / 600);
    return `${m}:${((ds - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
  };
  const dirOf = (p) => p.replace(/\/[^/]*$/, '');
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  // Output/order file base name: folder of the first clip
  const baseName = () => {
    const first = clips[0] || tossed[0];
    return (first && dirOf(first.path).split('/').pop()) || 'vidder';
  };

  function clampAll() {
    clips.forEach(c => {
      c.dur = clamp(c.dur, MIN_DUR, c.duration);
      c.start = clamp(c.start, 0, maxStart(c));
    });
    if (music) music.start = clamp(music.start, 0, music.duration - totalDur());
  }

  function updateStatus(msg) {
    const any = clips.length + tossed.length > 0;
    let text = `${clips.length} clip${clips.length === 1 ? '' : 's'}`;
    if (tossed.length) text += ` (${tossed.length} non-vertical tossed)`;
    if (msg) text += ` • ${msg}`;
    fileInfoEl.textContent = text;
    setHidden(fileInfoEl, !any);
    setHidden(section, !any);
    saveBtn.disabled = !any;
    clearBtn.disabled = !any && !music;
  }

  // Non-vertical clips go straight to `tossed` while "Vert vids only" is on
  function appendClips(newClips) {
    newClips.forEach(c => (vertOnly.checked && !isVert(c) ? tossed : clips).push(c));
  }

  function updateInfo() {
    const n = clips.length;
    const total = totalDur();
    let html = `${n} clip${n === 1 ? '' : 's'} = <strong>${fmtT(total)}</strong>`;
    if (music) {
      html += `<br>Music ${fmtT(music.start)} – ${fmtT(music.start + Math.min(total, music.duration))}`;
      if (music.duration < total) {
        html += `<br><span class="warn">Music is ${(total - music.duration).toFixed(1)}s shorter than the cut</span>`;
      }
    } else {
      html += '<br>No music (renders silent)';
    }
    infoEl.innerHTML = html;
    renderBtn.disabled = !n;
    playBtn.disabled = !n;
  }

  // ---- Preview ----

  function showSlot(i) {
    vids.forEach((v, k) => v.classList.toggle('hidden', k !== i));
  }

  function highlight(clip) {
    const idx = clip ? clips.indexOf(clip) : -1;
    [...list.children].forEach((row, i) => row.classList.toggle('playing', i === idx));
  }

  function stopPreview() {
    modeToken++;
    mode = null;
    cancelAnimationFrame(raf);
    vids[0]._want = null;
    vids.forEach(v => v.pause());
    if (music) music.audio.pause();
    highlight(null);
    playBtn.textContent = 'Play Sequence';
  }

  // Point a preview <video> at a clip time; resolves once that frame is ready
  // (or once a newer cue on the same element supersedes this one)
  function cue(v, clip, t) {
    const id = (v._cueId = (v._cueId || 0) + 1);
    return new Promise((resolve) => {
      const finish = () => {
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('error', finish);
        resolve();
      };
      const onSeeked = () => finish();
      const seek = () => {
        if (v._cueId !== id) return finish();
        v.addEventListener('seeked', onSeeked);
        v.currentTime = t;
      };
      v.addEventListener('error', finish);
      if (v.dataset.path !== clip.path) {
        v.dataset.path = clip.path;
        v.src = fileUrl(clip.path);
        v.addEventListener('loadedmetadata', seek, { once: true });
      } else if (v.readyState >= 1) {
        seek();
      } else {
        v.addEventListener('loadedmetadata', seek, { once: true });
      }
    });
  }

  // While dragging a box: show the frame at time t, coalescing seeks
  function scrubTo(clip, t) {
    const v = vids[0];
    showSlot(0);
    v.pause();
    v._want = t;
    if (v.dataset.path !== clip.path) cue(v, clip, t);
    else if (!v.seeking && v.readyState >= 1) v.currentTime = t;
  }
  vids[0].addEventListener('seeked', () => {
    const v = vids[0];
    if (mode === null && v._want != null && Math.abs(v.currentTime - v._want) > 0.02) v.currentTime = v._want;
  });

  async function loopClip(clip) {
    stopPreview();
    const token = modeToken;
    mode = 'loop';
    const v = vids[0];
    const end = clip.start + segOf(clip);
    showSlot(0);
    highlight(clip);
    await cue(v, clip, clip.start);
    if (token !== modeToken) return;
    v.play().catch(() => {});
    const tick = () => {
      if (token !== modeToken) return;
      if (v.currentTime >= end || v.ended) {
        v.currentTime = clip.start;
        v.play().catch(() => {});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  // Plays every slice in order against the music window. Two <video>s
  // alternate so the next clip is already seeked while the current one plays.
  async function playSequence() {
    stopPreview();
    if (!clips.length) return;
    const token = modeToken;
    mode = 'seq';
    playBtn.textContent = 'Stop';
    const order = clips.slice();
    // Cumulative cut times: clip i plays from ends[i - 1] to ends[i]
    const ends = [];
    order.reduce((t, c) => { ends.push(t + segOf(c)); return t + segOf(c); }, 0);
    await cue(vids[0], order[0], order[0].start);
    if (token !== modeToken) return;
    if (music) {
      music.audio.currentTime = music.start;
      await music.audio.play().catch(() => {});
      if (token !== modeToken) return;
    }
    const t0 = performance.now();
    let cur = -1;
    const tick = () => {
      if (token !== modeToken) return;
      const elapsed = (performance.now() - t0) / 1000;
      let i = Math.max(cur, 0);
      while (i < order.length && elapsed >= ends[i]) i++;
      if (i >= order.length) { stopPreview(); return; }
      if (i !== cur) {
        cur = i;
        const v = vids[i % 2];
        const other = vids[(i + 1) % 2];
        showSlot(i % 2);
        if (v.dataset.path === order[i].path) v.play().catch(() => {});
        else cue(v, order[i], order[i].start).then(() => { if (token === modeToken) v.play().catch(() => {}); });
        other.pause();
        if (i + 1 < order.length) cue(other, order[i + 1], order[i + 1].start);
        highlight(order[i]);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  playBtn.addEventListener('click', () => {
    if (mode === 'seq') stopPreview();
    else playSequence();
  });

  // ---- Clip rows ----

  function positionClipBox(row, clip) {
    const box = row.querySelector('.vidder-box');
    box.style.left = (clip.start / clip.duration * 100) + '%';
    box.style.width = (Math.min(1, segOf(clip) / clip.duration) * 100) + '%';
    row.querySelector('.vidder-time').textContent = `${segOf(clip).toFixed(2)}s @ ${fmtT(clip.start)}`;
  }

  function moveClip(from, to) {
    if (to < 0 || to >= clips.length || to === from) return;
    if (mode === 'seq') stopPreview();
    const [c] = clips.splice(from, 1);
    clips.splice(to, 0, c);
    renderList();
  }

  function startRowDrag(row, fromIdx, startEvent) {
    const rows = [...list.children];
    const others = rows.filter(r => r !== row);
    const startY = startEvent.clientY;
    let dragging = false;
    let slot = fromIdx;
    const clearMarks = () => rows.forEach(r => r.classList.remove('drop-before', 'drop-after'));

    const onMove = (e) => {
      const dy = e.clientY - startY;
      if (!dragging && Math.abs(dy) < 4) return;
      dragging = true;
      row.classList.add('dragging');
      row.style.transform = `translateY(${dy}px)`;
      // Insertion slot among the other rows, by row midpoint
      slot = others.findIndex(r => {
        const b = r.getBoundingClientRect();
        return e.clientY < b.top + b.height / 2;
      });
      if (slot === -1) slot = others.length;
      clearMarks();
      if (slot < others.length) others[slot].classList.add('drop-before');
      else if (others.length) others[others.length - 1].classList.add('drop-after');
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      clearMarks();
      row.classList.remove('dragging');
      row.style.transform = '';
      if (!dragging) loopClip(clips[fromIdx]); // plain click previews the clip
      else moveClip(fromIdx, slot);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Middle of the box moves the slice; its edges set the slice's start/end (its length)
  function attachBoxDrag(row, track, clip) {
    track.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      stopPreview();
      const rect = track.getBoundingClientRect();
      const toTime = (x) => (x - rect.left) / rect.width * clip.duration;
      const edge = e.target.dataset.edge;
      const win = segOf(clip);
      const t0 = toTime(e.clientX);
      const end0 = clip.start + win;
      // Grabbing inside the box keeps the offset; elsewhere centers the box on the pointer
      const grab = (t0 >= clip.start && t0 <= end0) ? t0 - clip.start : win / 2;
      const apply = (ev) => {
        const t = toTime(ev.clientX);
        if (edge === 'r') {
          clip.dur = clamp(t, clip.start + MIN_DUR, clip.duration) - clip.start;
        } else if (edge === 'l') {
          clip.start = clamp(t, 0, end0 - MIN_DUR);
          clip.dur = end0 - clip.start;
        } else {
          clip.start = clamp(t - grab, 0, maxStart(clip));
        }
        positionClipBox(row, clip);
        // Show the frame at whichever edge is being set
        scrubTo(clip, edge === 'r' ? Math.max(clip.start, clip.start + segOf(clip) - 1 / 30) : clip.start);
        if (edge) {
          if (music) music.start = clamp(music.start, 0, music.duration - totalDur());
          renderMusic();
          updateInfo();
        }
      };
      apply(e);
      const onUp = () => {
        window.removeEventListener('mousemove', apply);
        window.removeEventListener('mouseup', onUp);
        loopClip(clip);
      };
      window.addEventListener('mousemove', apply);
      window.addEventListener('mouseup', onUp);
    });
  }

  function renderList() {
    list.innerHTML = '';
    clips.forEach((clip, idx) => {
      const li = document.createElement('li');
      li.className = 'vidder-row';
      li.innerHTML = `
        <div class="vidder-handle">
          <span class="vidder-grip">⠿</span>
          <span class="vidder-num">${idx + 1}</span>
          <span class="vidder-name"></span>
        </div>
        <div class="vidder-track"><div class="vidder-box"><div class="vidder-edge l" data-edge="l"></div><div class="vidder-edge r" data-edge="r"></div></div></div>
        <span class="vidder-time"></span>
        <div class="joiner-item-btns">
          <button data-dir="-1" ${idx === 0 ? 'disabled' : ''}>↑</button>
          <button data-dir="1" ${idx === clips.length - 1 ? 'disabled' : ''}>↓</button>
          <button data-remove>✕</button>
        </div>
      `;
      const handle = li.querySelector('.vidder-handle');
      const track = li.querySelector('.vidder-track');
      li.querySelector('.vidder-name').textContent = clip.name;
      handle.title = `${clip.name} • ${clip.width}×${clip.height} • ${fmtT(clip.duration)}`;
      list.appendChild(li);

      // Filmstrip sized so thumbs keep roughly their aspect at this track width
      if (!clip.strip) {
        const thumbW = track.clientHeight * (clip.width / clip.height) || 16;
        const n = Math.min(80, Math.max(1, Math.round((track.clientWidth || 600) / thumbW)));
        clip.strip = `/api/vidder/strip?path=${encodeURIComponent(clip.path)}&n=${n}&h=56&d=${clip.duration}`;
      }
      track.style.backgroundImage = `url("${clip.strip}")`;
      positionClipBox(li, clip);

      handle.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        startRowDrag(li, idx, e);
      });
      attachBoxDrag(li, track, clip);
      li.querySelectorAll('[data-dir]').forEach(btn => {
        btn.addEventListener('click', () => moveClip(idx, idx + parseInt(btn.dataset.dir, 10)));
      });
      li.querySelector('[data-remove]').addEventListener('click', () => {
        stopPreview();
        clips.splice(idx, 1);
        clampAll();
        updateStatus();
        renderList();
      });
    });
    renderMusic();
    updateInfo();
  }

  // ---- Music track ----

  function renderMusic() {
    if (!music) return;
    const total = totalDur();
    musicBox.style.left = (music.start / music.duration * 100) + '%';
    musicBox.style.width = (Math.min(1, total / music.duration) * 100) + '%';
    // A tick at every cut, positioned by cumulative clip length
    musicBox.querySelectorAll('.vidder-cut').forEach(el => el.remove());
    let t = 0;
    clips.slice(0, -1).forEach(c => {
      t += segOf(c);
      const tick = document.createElement('div');
      tick.className = 'vidder-cut';
      tick.style.left = (t / total * 100) + '%';
      musicBox.appendChild(tick);
    });
    musicRangeEl.textContent = `${fmtT(music.start)} – ${fmtT(music.start + Math.min(total, music.duration))}`;
  }

  musicTrack.addEventListener('mousedown', (e) => {
    if (!music || e.button !== 0) return;
    e.preventDefault();
    stopPreview();
    const rect = musicTrack.getBoundingClientRect();
    const toTime = (x) => (x - rect.left) / rect.width * music.duration;
    const win = Math.min(totalDur(), music.duration);
    const t0 = toTime(e.clientX);
    const grab = (t0 >= music.start && t0 <= music.start + win) ? t0 - music.start : win / 2;
    const apply = (ev) => {
      music.start = clamp(toTime(ev.clientX) - grab, 0, music.duration - win);
      renderMusic();
      updateInfo();
    };
    apply(e);
    const onUp = () => {
      window.removeEventListener('mousemove', apply);
      window.removeEventListener('mouseup', onUp);
      if (clips.length) playSequence();
    };
    window.addEventListener('mousemove', apply);
    window.addEventListener('mouseup', onUp);
  });

  function clearMusic() {
    if (music) { music.audio.removeAttribute('src'); music.audio.load(); }
    music = null;
    setHidden(musicWrap, true);
    musicBtn.textContent = 'Add Music (MP4/M4A)...';
  }

  async function setMusic(filePath, start) {
    const info = await postJson('/api/probe', { filePath });
    if (!info.duration) throw new Error('Could not read duration');
    stopPreview();
    clearMusic();
    const audio = new Audio(fileUrl(filePath));
    audio.preload = 'auto';
    music = { path: filePath, name: info.filename, duration: info.duration, start, audio };
    musicNameEl.textContent = music.name;
    const mask = `url("/api/vidder/wave?path=${encodeURIComponent(music.path)}")`;
    waveEl.style.webkitMaskImage = mask;
    waveEl.style.maskImage = mask;
    musicBtn.textContent = 'Change Music...';
    setHidden(musicWrap, false);
    clampAll();
    renderMusic();
    updateInfo();
  }

  musicBtn.addEventListener('click', async () => {
    try {
      const picked = await postJson('/api/browse', { accept: 'mp4,m4a,mp3,wav,mov' });
      if (picked.canceled || !picked.paths || !picked.paths.length) return;
      await setMusic(picked.paths[0], 0);
      updateStatus();
    } catch (err) { alert('Music error: ' + err.message); }
  });

  // ---- Add, save/load order, clear ----

  addBtn.addEventListener('click', async () => {
    try {
      const picked = await postJson('/api/browse', { accept: 'mov,mp4,m4v', multiple: true });
      if (picked.canceled || !picked.paths || !picked.paths.length) return;
      const have = new Set(clips.concat(tossed).map(c => c.path));
      const fresh = picked.paths.filter(p => !have.has(p)).sort(byName);
      if (!fresh.length) return;
      addBtn.disabled = true;
      addBtn.textContent = 'Loading...';
      const result = await postJson('/api/vidder/probe', { paths: fresh });
      if (mode === 'seq') stopPreview();
      appendClips(result.clips.map(c => ({ ...c, start: 0, dur: clipDur(), strip: null })));
      clampAll();
      updateStatus();
      renderList();
      if (result.missing.length) {
        alert(`Skipped ${result.missing.length} unreadable file(s):\n` + result.missing.map(p => p.split('/').pop()).join('\n'));
      }
    } catch (err) {
      alert('Add error: ' + err.message);
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = 'Add Vids...';
    }
  });

  saveBtn.addEventListener('click', async () => {
    try {
      const slim = (c) => ({ path: c.path, start: c.start, dur: c.dur });
      const first = clips[0] || tossed[0];
      const result = await postJson('/api/vidder/save', {
        data: {
          app: 'fast-cut-music-vidder',
          version: 2,
          clipDur: clipDur(),
          vertOnly: vertOnly.checked,
          clips: clips.map(slim),
          tossed: tossed.map(slim),
          music: music ? { path: music.path, start: music.start } : null
        },
        defaultName: `${baseName()}_order.json`,
        defaultDir: first ? dirOf(first.path) : null
      });
      if (!result.canceled) updateStatus(`saved ${result.path.split('/').pop()}`);
    } catch (err) { alert('Save error: ' + err.message); }
  });

  loadBtn.addEventListener('click', async () => {
    try {
      // Finder's picker wants the UTI for JSON; the bare extension leaves files greyed out
      const picked = await postJson('/api/browse', { accept: 'json,public.json' });
      if (picked.canceled || !picked.paths || !picked.paths.length) return;
      const data = await postJson('/api/vidder/read', { path: picked.paths[0] });
      if (!Array.isArray(data.clips)) throw new Error('Not a vidder order file');
      loadBtn.disabled = true;
      loadBtn.textContent = 'Loading...';
      const saved = data.clips.concat(Array.isArray(data.tossed) ? data.tossed : []);
      const result = await postJson('/api/vidder/probe', { paths: saved.map(c => c.path) });
      const byPath = new Map(result.clips.map(c => [c.path, c]));
      const revive = (arr) => (Array.isArray(arr) ? arr : [])
        .filter(c => byPath.has(c.path))
        .map(c => ({ ...byPath.get(c.path), start: Number(c.start) || 0, dur: Number(c.dur) || Number(data.clipDur) || 2, strip: null }));
      const missing = result.missing.slice();

      stopPreview();
      clipDurInput.value = data.clipDur || 2;
      vertOnly.checked = !!data.vertOnly;
      clips = revive(data.clips);
      tossed = revive(data.tossed);
      clearMusic();
      if (data.music && data.music.path) {
        try { await setMusic(data.music.path, Number(data.music.start) || 0); }
        catch (_) { missing.push(data.music.path); }
      }
      clampAll();
      updateStatus(`loaded ${picked.paths[0].split('/').pop()}`);
      renderList();
      if (missing.length) {
        alert(`Couldn't find ${missing.length} file(s) from the order:\n` + missing.map(p => p.split('/').pop()).join('\n'));
      }
    } catch (err) {
      alert('Load error: ' + err.message);
    } finally {
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load Order...';
    }
  });

  clearBtn.addEventListener('click', () => {
    stopPreview();
    clips = [];
    tossed = [];
    clearMusic();
    updateStatus();
    renderList();
  });

  vertOnly.addEventListener('change', () => {
    stopPreview();
    if (vertOnly.checked) {
      tossed = tossed.concat(clips.filter(c => !isVert(c)));
      clips = clips.filter(isVert);
    } else {
      clips = clips.concat(tossed);
      tossed = [];
    }
    clampAll();
    updateStatus();
    renderList();
  });

  // The default only applies to clips added from now on; "Apply to all" resets every clip
  $('vidderApplyAllBtn').addEventListener('click', () => {
    if (mode) stopPreview();
    clips.concat(tossed).forEach(c => { c.dur = clipDur(); });
    clampAll();
    renderList();
  });

  // ---- Render ----

  renderBtn.addEventListener('click', async () => {
    if (!clips.length) return;
    stopPreview();
    renderBtn.disabled = true;
    renderBtn.textContent = 'Rendering...';
    setHidden(progress, false);
    progressFill.style.width = '0%';
    progressLabel.textContent = '0%';
    const base = baseName();

    try {
      const resp = await fetch('/api/vidder/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clips: clips.map(c => ({ path: c.path, start: c.start, dur: segOf(c) })),
          clipDur: clipDur(),
          music: music ? { path: music.path, start: music.start } : null,
          filename: `${base}_vidder.mp4`
        })
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const msg = JSON.parse(part.slice(6));
          if (msg.type === 'progress') {
            progressFill.style.width = msg.percent + '%';
            progressLabel.textContent = msg.percent + '%';
          } else if (msg.type === 'complete') {
            progressFill.style.width = '100%';
            progressLabel.textContent = 'Done!';
            const a = document.createElement('a');
            a.href = msg.downloadUrl;
            a.download = msg.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
          } else if (msg.type === 'error') {
            throw new Error(msg.error + (msg.details ? ': ' + msg.details : ''));
          }
        }
      }
    } catch (err) {
      alert('Render failed: ' + err.message);
      setHidden(progress, true);
    } finally {
      renderBtn.disabled = !clips.length;
      renderBtn.textContent = 'Render';
    }
  });

  showSlot(0);
  updateStatus();
})();

// ========== TEXT EFFECTS ==========
(function() {
  const $ = (id) => document.getElementById(id);

  function setHidden(el, hidden) {
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  async function postJson(url, payload) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  }

  const browseBtn = $('textfxBrowseBtn');
  const fileInfoEl = $('textfxFileInfo');
  const section = $('textfxSection');
  const stage = $('textfxStage');
  const video = $('textfxVideo');
  const playBtn = $('textfxPlayBtn');
  const scrub = $('textfxScrub');
  const timeEl = $('textfxTime');
  const addBtn = $('textfxAddBtn');
  const boxListEl = $('textfxBoxList');
  const propsEl = $('textfxProps');
  const exportBtn = $('textfxExportBtn');
  const progress = $('textfxProgress');
  const progressFill = $('textfxProgressFill');
  const progressLabel = $('textfxProgressLabel');
  const ctl = {
    text: $('textfxText'),
    font: $('textfxFont'),
    weight: $('textfxWeight'),
    italic: $('textfxItalic'),
    size: $('textfxSize'),
    lineHeight: $('textfxLineHeight'),
    tracking: $('textfxTracking'),
    opacity: $('textfxOpacity'),
    blend: $('textfxBlend'),
    color: $('textfxColor'),
    futureSec: $('textfxFutureSec'),
    futureLabel: $('textfxFutureLabel'),
    align: $('textfxAlign'),
  };

  const DEFAULT_FONTS = [
    'Helvetica Neue', 'Helvetica', 'Arial', 'Arial Black', 'Avenir Next', 'Avenir Next Condensed',
    'Futura', 'Gill Sans', 'Optima', 'Didot', 'Bodoni 72', 'Baskerville', 'Georgia', 'Times New Roman',
    'Palatino', 'American Typewriter', 'Courier New', 'Menlo', 'Impact', 'Copperplate', 'Rockwell', 'system-ui'
  ];
  const GENERIC = /^(system-ui|serif|sans-serif|monospace|cursive|fantasy)$/;

  let srcPath = null;
  let W = 0, H = 0;      // video pixel size (display orientation)
  let boxes = [];
  let selected = null;
  let nextId = 1;
  let raf = 0;

  const fileUrl = (p) => `/api/localfile?path=${encodeURIComponent(p)}`;
  const fmtT = (s) => {
    const ds = Math.round((s || 0) * 10);
    const m = Math.floor(ds / 600);
    return `${m}:${((ds - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
  };

  function setFontOptions(families) {
    const current = ctl.font.value;
    ctl.font.innerHTML = '';
    families.forEach(f => {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f;
      ctl.font.appendChild(o);
    });
    if (current && families.includes(current)) ctl.font.value = current;
  }
  setFontOptions(DEFAULT_FONTS);
  const WEIGHT_OPTIONS = [...ctl.weight.options].map(o => [o.value, o.textContent]);

  // ---- Real font faces ----
  // With local font access we know every installed face, so the style list and
  // italics map to actual font files and the browser never synthesizes them.
  let faceData = null;          // family -> [{ ps, style, italic, rank, key }]
  const faceLoads = new Map();  // postscript name -> { status, promise }

  const WEIGHT_WORDS = [
    [/hairline|thin/i, 100], [/(ultra|extra)\s*light/i, 200], [/(semi|demi)\s*light/i, 350], [/light/i, 300],
    [/medium/i, 500], [/(semi|demi)\s*bold/i, 600], [/(extra|ultra)\s*bold|heavy/i, 800], [/black|ultra/i, 900], [/bold/i, 700],
  ];
  const styleRank = (style) => {
    for (const [re, w] of WEIGHT_WORDS) if (re.test(style)) return w;
    return 400;
  };
  const isItalicStyle = (style) => /italic|oblique/i.test(style);
  // Upright and italic versions of a face share a key ("Bold" / "Bold Italic" -> "bold")
  const styleKey = (style) => style.replace(/\b(italic|oblique|regular|roman|normal)\b/gi, '').replace(/\s+/g, ' ').trim().toLowerCase();

  function uprightFaces(family) {
    const faces = (faceData && faceData.get(family)) || [];
    const up = faces.filter(f => !f.italic);
    return up.length ? up : faces;
  }

  function italicTwin(family, style) {
    if (!style) return null;
    const faces = (faceData && faceData.get(family)) || [];
    const k = styleKey(style);
    return faces.find(f => f.italic && f.key === k) || null;
  }

  // The exact face a box draws with (null when face data isn't available)
  function resolveFace(b) {
    if (!faceData || !faceData.has(b.family)) return null;
    const up = uprightFaces(b.family).find(f => f.style === b.style) || null;
    return (b.italic && italicTwin(b.family, b.style)) || up;
  }

  // Snap a box's style/italic onto faces its family really has
  function reconcileFace(b) {
    if (!faceData || !faceData.has(b.family)) { b.italic = false; return; }
    const ups = uprightFaces(b.family);
    if (!ups.some(f => f.style === b.style)) {
      const want = b.style ? styleRank(b.style) : b.weight;
      b.style = ups.slice().sort((p, q) => Math.abs(p.rank - want) - Math.abs(q.rank - want) || p.style.length - q.style.length)[0].style;
    }
    b.weight = styleRank(b.style);
    if (b.italic && !italicTwin(b.family, b.style)) b.italic = false;
  }

  // Register a single face under its own family name via local(), so drawing
  // with it can't fall back to a synthesized bold or slant
  const faceFamily = (ps) => `tfx-${ps}`;
  function ensureFace(ps) {
    if (faceLoads.has(ps)) return faceLoads.get(ps).promise;
    const entry = { status: 'loading' };
    entry.promise = new FontFace(faceFamily(ps), `local("${ps}")`).load()
      .then(f => { document.fonts.add(f); entry.status = 'ok'; }, () => { entry.status = 'failed'; })
      .then(() => boxes.forEach(update));
    faceLoads.set(ps, entry);
    return entry.promise;
  }

  async function loadFaces(prompt) {
    if (faceData) return true;
    if (!window.queryLocalFonts) return false;
    try {
      if (!prompt) {
        const perm = await navigator.permissions.query({ name: 'local-fonts' });
        if (perm.state !== 'granted') return false;
      }
      const fonts = await window.queryLocalFonts();
      const map = new Map();
      fonts.forEach(f => {
        if (f.family.startsWith('.')) return;
        if (!map.has(f.family)) map.set(f.family, []);
        map.get(f.family).push({ ps: f.postscriptName, style: f.style, italic: isItalicStyle(f.style), rank: styleRank(f.style), key: styleKey(f.style) });
      });
      if (!map.size) return false;
      map.forEach(list => list.sort((p, q) => p.rank - q.rank || p.style.localeCompare(q.style)));
      faceData = map;
      setFontOptions([...map.keys()].sort((a, b) => a.localeCompare(b)));
      setHidden($('textfxFontsBtn'), true);
      boxes.forEach(b => { reconcileFace(b); update(b); });
      syncPanel();
      return true;
    } catch (_) {
      return false;
    }
  }
  loadFaces(false);

  // ---- Text layout + drawing (shared by preview layers and export masks) ----
  // All box geometry is in video pixels; callers scale the context.

  const measureCtx = document.createElement('canvas').getContext('2d');

  function fontStr(b) {
    const face = resolveFace(b);
    if (face) {
      const entry = faceLoads.get(face.ps);
      if (!entry) ensureFace(face.ps);
      else if (entry.status === 'ok') return `${b.size}px "${faceFamily(face.ps)}"`;
    }
    // Until the face loads, or without font access: family + weight, never italic
    const fam = GENERIC.test(b.family) ? b.family : `"${b.family.replace(/"/g, '')}"`;
    return `${b.weight} ${b.size}px ${fam}`;
  }

  function layout(b) {
    measureCtx.font = fontStr(b);
    measureCtx.letterSpacing = `${b.tracking}px`;
    const lines = [];
    for (const para of b.text.split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const test = line ? `${line} ${word}` : word;
        if (line && measureCtx.measureText(test).width > b.w) {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      lines.push(line);
    }
    const lineH = b.size * b.lineHeight;
    return { lines, lineH, h: Math.max(lineH, lines.length * lineH) };
  }

  function drawText(ctx, b, L) {
    ctx.font = fontStr(b);
    ctx.letterSpacing = `${b.tracking}px`;
    ctx.textAlign = b.align;
    ctx.textBaseline = 'middle';
    const x = b.align === 'left' ? b.x : b.align === 'right' ? b.x + b.w : b.x + b.w / 2;
    L.lines.forEach((line, i) => ctx.fillText(line, x, b.y + (i + 0.5) * L.lineH));
  }

  // ---- Preview layers ----

  function paintLayer(b) {
    const cw = video.clientWidth, ch = video.clientHeight;
    if (!cw || !W) return;
    const dpr = window.devicePixelRatio || 1;
    const c = b.canvas;
    const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
      c.style.width = cw + 'px';
      c.style.height = ch + 'px';
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, pw, ph);
    const s = pw / W;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.globalAlpha = b.opacity;
    ctx.fillStyle = b.fill === 'future' ? '#ffffff' : b.color;
    drawText(ctx, b, b.L);
    // Future fill: keep the text's alpha, take color from the shifted video
    if (b.fill === 'future' && b.futureVid && b.futureVid.readyState >= 2) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-in';
      ctx.drawImage(b.futureVid, 0, 0, W, H);
    }
    b.paintedAt = b.futureVid ? b.futureVid.currentTime : null;
    b.dirty = false;
  }

  function positionFrame(b) {
    if (!W) return;
    const s = video.clientWidth / W;
    Object.assign(b.frame.style, {
      left: b.x * s + 'px',
      top: b.y * s + 'px',
      width: b.w * s + 'px',
      height: b.L.h * s + 'px',
    });
  }

  function update(b) {
    b.L = layout(b);
    b.canvas.style.mixBlendMode = b.blend;
    ensureFutureVid(b);
    paintLayer(b);
    positionFrame(b);
  }

  function ensureFutureVid(b) {
    if (b.fill !== 'future' || !srcPath) return;
    if (!b.futureVid) {
      const fv = document.createElement('video');
      fv.className = 'textfx-future';
      fv.muted = true;
      fv.playsInline = true;
      fv.preload = 'auto';
      fv.addEventListener('seeked', () => { b.dirty = true; });
      fv.addEventListener('loadeddata', () => { b.dirty = true; });
      stage.appendChild(fv);
      b.futureVid = fv;
    }
    if (b.futureVid.dataset.path !== srcPath) {
      b.futureVid.dataset.path = srcPath;
      b.futureVid.src = fileUrl(srcPath);
    }
  }

  // Keep each future video N sec ahead of the main one (holding the last frame
  // at the end, like the render) and repaint its layer when its frame changes
  function tick() {
    raf = requestAnimationFrame(tick);
    if (!W) return;
    const t = video.currentTime;
    const dur = video.duration || 0;
    for (const b of boxes) {
      if (b.fill !== 'future' || !b.futureVid) continue;
      const fv = b.futureVid;
      if (fv.readyState < 1) continue;
      const target = Math.min(t + b.futureSec, Math.max(0, dur - 0.05));
      const hold = video.paused || target < t + b.futureSec;
      if (hold) {
        if (!fv.paused) fv.pause();
        if (!fv.seeking && Math.abs(fv.currentTime - target) > 0.03) fv.currentTime = target;
      } else if (fv.paused) {
        if (!fv.seeking) {
          fv.currentTime = target;
          fv.play().catch(() => {});
        }
      } else if (!fv.seeking && Math.abs(fv.currentTime - target) > 0.25) {
        fv.currentTime = target;
      }
      if (!video.paused || b.dirty || fv.currentTime !== b.paintedAt) paintLayer(b);
    }
  }

  // ---- Boxes ----

  function attachFrameDrag(b) {
    b.frame.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      select(b);
      const mode = e.target.dataset.handle || 'move';
      const s = video.clientWidth / W;
      const start = { mx: e.clientX, my: e.clientY, x: b.x, y: b.y, w: b.w, size: b.size, tracking: b.tracking, h: b.L.h };
      const onMove = (ev) => {
        const dx = (ev.clientX - start.mx) / s;
        const dy = (ev.clientY - start.my) / s;
        if (mode === 'move') {
          b.x = start.x + dx;
          b.y = start.y + dy;
        } else if (mode === 'e') {
          b.w = Math.max(20, start.w + dx);
        } else if (mode === 'w') {
          b.w = Math.max(20, start.w - dx);
          b.x = start.x + start.w - b.w;
        } else {
          // Corners scale the whole block, anchored at the opposite corner
          const left = mode.includes('w');
          const k = Math.max(20, left ? start.w - dx : start.w + dx) / start.w;
          b.w = start.w * k;
          b.size = Math.max(4, start.size * k);
          b.tracking = start.tracking * k;
          if (left) b.x = start.x + start.w - b.w;
          if (mode.includes('n')) b.y = start.y + start.h - start.h * k;
        }
        update(b);
        if (mode !== 'move' && mode !== 'e' && mode !== 'w') syncPanel();
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
    b.frame.addEventListener('dblclick', () => { ctl.text.focus(); ctl.text.select(); });
  }

  function addBox() {
    if (!W) return;
    const template = selected || null;
    const b = {
      id: nextId++,
      text: template ? template.text : 'Your text',
      family: template ? template.family : 'Helvetica Neue',
      weight: template ? template.weight : 700,
      italic: template ? template.italic : false,
      style: template ? template.style : null,
      size: template ? template.size : Math.round(H * 0.08),
      color: template ? template.color : '#ffffff',
      align: template ? template.align : 'center',
      lineHeight: template ? template.lineHeight : 1.1,
      tracking: template ? template.tracking : 0,
      opacity: template ? template.opacity : 1,
      blend: template ? template.blend : 'normal',
      fill: template ? template.fill : 'color',
      futureSec: template ? template.futureSec : 3,
      w: template ? template.w : W * 0.8,
      x: 0,
      y: 0,
    };
    b.x = (W - b.w) / 2;
    b.y = template ? Math.min(H - 20, template.y + template.L.h + b.size * 0.3) : H * 0.4;
    reconcileFace(b);
    b.canvas = document.createElement('canvas');
    b.canvas.className = 'textfx-layer';
    b.frame = document.createElement('div');
    b.frame.className = 'textfx-frame';
    ['nw', 'ne', 'sw', 'se', 'e', 'w'].forEach(h => {
      const el = document.createElement('div');
      el.className = 'handle ' + h;
      el.dataset.handle = h;
      b.frame.appendChild(el);
    });
    stage.appendChild(b.canvas);
    stage.appendChild(b.frame);
    attachFrameDrag(b);
    boxes.push(b);
    update(b);
    select(b);
  }

  function removeBox(b) {
    b.canvas.remove();
    b.frame.remove();
    if (b.futureVid) { b.futureVid.removeAttribute('src'); b.futureVid.load(); b.futureVid.remove(); }
    boxes = boxes.filter(x => x !== b);
    if (selected === b) selected = null;
    // Keep DOM stacking in list order (later boxes blend over earlier ones)
    select(selected || boxes[boxes.length - 1] || null);
  }

  function select(b) {
    selected = b;
    boxes.forEach(x => x.frame.classList.toggle('selected', x === b));
    renderBoxList();
    setHidden(propsEl, !b);
    if (b) syncPanel();
    exportBtn.disabled = !boxes.length || !srcPath;
  }

  function renderBoxList() {
    boxListEl.innerHTML = '';
    boxes.forEach((b, i) => {
      const chip = document.createElement('div');
      chip.className = 'textfx-chip' + (b === selected ? ' selected' : '');
      const label = document.createElement('span');
      label.textContent = `${i + 1}. ${b.text.replace(/\n/g, ' ') || '(empty)'}`;
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Delete';
      del.addEventListener('click', (e) => { e.stopPropagation(); removeBox(b); });
      chip.append(label, del);
      chip.addEventListener('click', () => select(b));
      boxListEl.appendChild(chip);
    });
  }

  function syncPanel() {
    const b = selected;
    if (!b) return;
    if (document.activeElement !== ctl.text) ctl.text.value = b.text;
    if (![...ctl.font.options].some(o => o.value === b.family)) {
      const o = document.createElement('option');
      o.value = o.textContent = b.family;
      ctl.font.appendChild(o);
    }
    ctl.font.value = b.family;
    // Style list: the family's real upright faces when known, else plain weights
    const ups = faceData && faceData.has(b.family) ? uprightFaces(b.family) : null;
    const opts = ups ? ups.map(f => [f.style, f.style]) : WEIGHT_OPTIONS;
    const sig = opts.map(o => o[0]).join('|');
    if (ctl.weight.dataset.sig !== sig) {
      ctl.weight.innerHTML = '';
      opts.forEach(([value, label]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        ctl.weight.appendChild(o);
      });
      ctl.weight.dataset.sig = sig;
    }
    ctl.weight.value = ups ? b.style : String(b.weight);
    const twin = ups ? italicTwin(b.family, b.style) : null;
    ctl.italic.disabled = !twin;
    ctl.italic.title = twin ? `Italic (${twin.style})`
      : faceData ? `${b.family} ${b.style || ''} has no italic`
      : 'Allow font access (Installed fonts) to use real italics';
    ctl.italic.classList.toggle('active', !!twin && b.italic);
    ctl.size.value = Math.round(b.size);
    ctl.lineHeight.value = b.lineHeight;
    ctl.tracking.value = Math.round(b.tracking);
    ctl.opacity.value = Math.round(b.opacity * 100);
    ctl.blend.value = b.blend;
    ctl.color.value = b.color;
    ctl.futureSec.value = b.futureSec;
    ctl.futureLabel.textContent = b.futureSec.toFixed(1);
    document.querySelectorAll('input[name="textfxFill"]').forEach(r => { r.checked = r.value === b.fill; });
    [...ctl.align.children].forEach(btn => btn.classList.toggle('active', btn.dataset.align === b.align));
  }

  // Panel -> selected box
  const bind = (el, evt, apply) => el.addEventListener(evt, () => {
    if (!selected) return;
    apply(selected);
    update(selected);
  });
  bind(ctl.text, 'input', (b) => { b.text = ctl.text.value; renderBoxList(); });
  bind(ctl.font, 'change', (b) => {
    b.family = ctl.font.value;
    reconcileFace(b);
    syncPanel();
  });
  bind(ctl.weight, 'change', (b) => {
    if (faceData && faceData.has(b.family)) {
      b.style = ctl.weight.value;
      reconcileFace(b);
    } else {
      b.weight = parseInt(ctl.weight.value, 10) || b.weight;
    }
    syncPanel();
  });
  bind(ctl.italic, 'click', (b) => {
    if (!italicTwin(b.family, b.style)) return;
    b.italic = !b.italic;
    syncPanel();
  });
  bind(ctl.size, 'input', (b) => { b.size = Math.max(4, parseFloat(ctl.size.value) || b.size); });
  bind(ctl.lineHeight, 'input', (b) => { b.lineHeight = Math.max(0.5, parseFloat(ctl.lineHeight.value) || b.lineHeight); });
  bind(ctl.tracking, 'input', (b) => { b.tracking = parseFloat(ctl.tracking.value) || 0; });
  bind(ctl.opacity, 'input', (b) => { b.opacity = parseInt(ctl.opacity.value, 10) / 100; });
  bind(ctl.blend, 'change', (b) => { b.blend = ctl.blend.value; });
  bind(ctl.color, 'input', (b) => {
    b.color = ctl.color.value;
    b.fill = 'color';
    syncPanel();
  });
  bind(ctl.futureSec, 'input', (b) => {
    b.futureSec = parseFloat(ctl.futureSec.value);
    b.fill = 'future';
    syncPanel();
  });
  document.querySelectorAll('input[name="textfxFill"]').forEach(r => bind(r, 'change', (b) => { b.fill = r.value; }));
  [...ctl.align.children].forEach(btn => bind(btn, 'click', (b) => {
    b.align = btn.dataset.align;
    syncPanel();
  }));
  bind($('textfxCenterH'), 'click', (b) => { b.x = (W - b.w) / 2; });
  bind($('textfxCenterV'), 'click', (b) => { b.y = (H - b.L.h) / 2; });
  $('textfxDeleteBtn').addEventListener('click', () => { if (selected) removeBox(selected); });

  $('textfxFontsBtn').addEventListener('click', async () => {
    if (!window.queryLocalFonts) return alert('This browser cannot list installed fonts (needs Chrome).');
    if (!(await loadFaces(true))) alert('Font access was not granted. Allow it for this site in Chrome settings.');
  });
  // Ask for font access on the first click in the editor (one-time Chrome prompt)
  let askedFonts = false;
  section.addEventListener('mousedown', () => {
    if (faceData || askedFonts) return;
    askedFonts = true;
    loadFaces(true);
  });

  addBtn.addEventListener('click', addBox);

  // Delete / arrow-nudge the selected box, only while working in this section and not typing
  let keysActive = false;
  document.addEventListener('mousedown', (e) => { keysActive = !!e.target.closest('#textfx'); }, true);
  document.addEventListener('keydown', (e) => {
    if (!selected || !keysActive || section.hidden) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const step = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) {
      e.preventDefault();
      selected.x += moves[e.key][0];
      selected.y += moves[e.key][1];
      update(selected);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeBox(selected);
    }
  });

  stage.addEventListener('mousedown', (e) => {
    if (e.target === video) select(null);
  });

  // ---- Video + transport ----

  browseBtn.addEventListener('click', async () => {
    try {
      const picked = await postJson('/api/browse', { accept: 'mov,mp4,m4v' });
      if (picked.canceled || !picked.paths || !picked.paths.length) return;
      const info = await postJson('/api/probe', { filePath: picked.paths[0] });
      srcPath = picked.paths[0];
      fileInfoEl.textContent = `${info.filename} • ${(info.size / 1e6).toFixed(1)} MB`;
      setHidden(fileInfoEl, false);
      setHidden(section, false);
      video.src = fileUrl(srcPath);
    } catch (err) { alert('Path error: ' + err.message); }
  });

  video.addEventListener('loadedmetadata', () => {
    const oldW = W;
    W = video.videoWidth;
    H = video.videoHeight;
    // Carry boxes over to a new clip, scaled to its width
    if (oldW && oldW !== W) {
      const k = W / oldW;
      boxes.forEach(b => { b.x *= k; b.y *= k; b.w *= k; b.size *= k; b.tracking *= k; });
    }
    scrub.max = String(video.duration || 1);
    requestAnimationFrame(() => {
      if (!boxes.length) addBox();
      else boxes.forEach(update);
      select(selected || boxes[0]);
    });
    if (!raf) raf = requestAnimationFrame(tick);
  });

  new ResizeObserver(() => boxes.forEach(b => { paintLayer(b); positionFrame(b); })).observe(video);

  playBtn.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener('play', () => { playBtn.textContent = 'Pause'; });
  video.addEventListener('pause', () => { playBtn.textContent = 'Play'; });
  video.addEventListener('ended', () => { playBtn.textContent = 'Play'; });
  video.addEventListener('timeupdate', () => {
    scrub.value = String(video.currentTime);
    timeEl.textContent = fmtT(video.currentTime);
  });
  scrub.addEventListener('input', () => {
    video.currentTime = parseFloat(scrub.value);
    timeEl.textContent = fmtT(video.currentTime);
  });

  // ---- Export ----

  function maskBlob(b) {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.globalAlpha = b.opacity;
    ctx.fillStyle = '#ffffff';
    drawText(ctx, b, layout(b));
    return new Promise(resolve => c.toBlob(resolve, 'image/png'));
  }

  exportBtn.addEventListener('click', async () => {
    if (!srcPath || !boxes.length) return;
    video.pause();
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting...';
    setHidden(progress, false);
    progressFill.style.width = '0%';
    progressLabel.textContent = '0%';

    try {
      const form = new FormData();
      form.append('filePath', srcPath);
      form.append('boxes', JSON.stringify(boxes.map(b => ({
        fill: b.fill, color: b.color, futureSec: b.futureSec, blend: b.blend
      }))));
      // Masks must be drawn with the exact faces, so wait for any still loading
      await Promise.all(boxes.map(b => { const f = resolveFace(b); return f ? ensureFace(f.ps) : null; }));
      for (const b of boxes) form.append('masks', await maskBlob(b), `mask_${b.id}.png`);
      const base = srcPath.split('/').pop().replace(/\.[^.]+$/, '');
      form.append('filename', `${base}_text.mp4`);

      const resp = await fetch('/api/textfx/render', { method: 'POST', body: form });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const msg = JSON.parse(part.slice(6));
          if (msg.type === 'progress') {
            progressFill.style.width = msg.percent + '%';
            progressLabel.textContent = msg.percent + '%';
          } else if (msg.type === 'complete') {
            progressFill.style.width = '100%';
            progressLabel.textContent = 'Done!';
            const a = document.createElement('a');
            a.href = msg.downloadUrl;
            a.download = msg.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
          } else if (msg.type === 'error') {
            throw new Error(msg.error + (msg.details ? ': ' + msg.details : ''));
          }
        }
      }
    } catch (err) {
      alert('Export failed: ' + err.message);
      setHidden(progress, true);
    } finally {
      exportBtn.disabled = !boxes.length;
      exportBtn.textContent = 'Export MP4';
    }
  });
})();

// Kill & restart server
(function() {
  const btn = document.getElementById('restartBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm('Kill all processes and restart the server?')) return;
    btn.disabled = true;
    btn.textContent = 'Restarting...';
    try {
      await fetch('/api/restart', { method: 'POST' });
    } catch (e) {}
    setTimeout(() => { location.reload(); }, 2500);
  });
})();

// Theme toggle
(function() {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  const saved = localStorage.getItem('theme');
  if (saved === 'light') { document.body.classList.add('light'); btn.textContent = 'Dark Mode'; }
  btn.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light');
    btn.textContent = isLight ? 'Dark Mode' : 'Light Mode';
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
  });
})();

// Global server log panel
(function() {
  const panel = document.getElementById('logPanel');
  const toggle = document.getElementById('logToggle');
  const content = document.getElementById('logContent');
  const clearBtn = document.getElementById('logClearBtn');
  if (!panel || !content) return;

  toggle.addEventListener('click', (e) => {
    if (e.target === clearBtn) return;
    panel.classList.toggle('collapsed');
  });
  clearBtn.addEventListener('click', () => { content.textContent = ''; });

  const es = new EventSource('/api/logs');
  es.onmessage = (e) => {
    const line = JSON.parse(e.data);
    content.textContent += line + '\n';
    content.scrollTop = content.scrollHeight;
  };
})();
