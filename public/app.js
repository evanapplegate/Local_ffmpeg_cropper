(function() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileList = document.getElementById('fileList');
  const editor = document.getElementById('editor');
  const video = document.getElementById('video');
  const videoWrap = document.getElementById('videoWrap');
  const outName = document.getElementById('outName');
  const exportBtn = document.getElementById('exportBtn');
  const playPauseBtn = document.getElementById('playPauseBtn');

  let files = [];
  let currentFile = null;
  let currentIdx = -1;
  let objectUrl = null;
  let cropper = null;

  function setHidden(el, hidden) {
    if (hidden) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }

  function pickFile() { fileInput.click(); }

  dropzone.addEventListener('click', pickFile);
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') pickFile();
  });

  ;['dragenter','dragover'].forEach(evt => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.add('hover');
  }));
  ;['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove('hover');
  }));
  const isSupportedVideo = (file) => {
    if (!file) return false;
    const { type = '', name = '' } = file;
    return /video\/mp4/.test(type) || /video\/quicktime/.test(type) || /\.(mp4|mov)$/i.test(name);
  };

  dropzone.addEventListener('drop', (e) => {
    const dropped = [...(e.dataTransfer.files || [])].filter(isSupportedVideo);
    if (dropped.length) loadFiles(dropped);
  });
  fileInput.addEventListener('change', () => {
    const picked = [...(fileInput.files || [])].filter(isSupportedVideo);
    if (picked.length) loadFiles(picked);
  });

  function loadFiles(newFiles) {
    files = newFiles;
    if (!files.length) return;
    setHidden(fileList, false);
    setHidden(fileInfo, false);
    renderFileList();
    selectFile(0);
  }

  function renderFileList() {
    fileList.innerHTML = '';
    files.forEach((f, i) => {
      const li = document.createElement('li');
      li.textContent = `${f.name} — ${(f.size/1e6).toFixed(2)} MB`;
      if (i === currentIdx) li.classList.add('active');
      li.addEventListener('click', () => selectFile(i));
      fileList.appendChild(li);
    });
  }

  function selectFile(index) {
    if (index < 0 || index >= files.length) return;
    currentIdx = index;
    currentFile = files[index];
    cleanupObjectUrl();
    objectUrl = URL.createObjectURL(currentFile);
    video.src = objectUrl;
    video.load();
    fileInfo.textContent = `${currentFile.name} • ${(currentFile.size/1e6).toFixed(2)} MB`;
    setHidden(editor, false);
    renderFileList();
    setTimeout(() => video.play().catch(() => {}), 50);
  }

  function cleanupObjectUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  video.addEventListener('loadedmetadata', () => {
    if (!cropper) cropper = new Cropper(videoWrap, video);
    waitForLayout(video).then(() => {
      cropper.resetToDefault();
      const base = (currentFile && currentFile.name) ? currentFile.name.replace(/\.[^.]+$/, '') : 'output';
      outName.value = `${base}_crop.mp4`;
    });
  });

  document.querySelectorAll('input[name="aspect"]').forEach(r => {
    r.addEventListener('change', () => {
      const val = document.querySelector('input[name="aspect"]:checked').value;
      cropper && cropper.setAspect(val);
    });
  });

  exportBtn.addEventListener('click', async () => {
    if (!currentFile || !cropper) return;
    const rect = cropper.getCropInSourcePixels();
    if (!rect) return;
    try {
      const form = new FormData();
      form.append('video', currentFile, currentFile.name);
      form.append('x', String(rect.x));
      form.append('y', String(rect.y));
      form.append('w', String(rect.w));
      form.append('h', String(rect.h));
      form.append('filename', sanitizeFilename(outName.value || currentFile.name));

      exportBtn.disabled = true;
      exportBtn.textContent = 'Exporting…';

      const resp = await fetch('/api/crop', { method: 'POST', body: form });
      if (!resp.ok) throw new Error(`Export failed (${resp.status})`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outName.value || `${currentFile.name.replace(/\.[^.]+$/, '')}_crop.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
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
  const videoDropzone = document.getElementById('videoDropzone');
  const audioDropzone = document.getElementById('audioDropzone');
  const videoFileInput = document.getElementById('videoFileInput');
  const audioFileInput = document.getElementById('audioFileInput');
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

  let combinerVideoFile = null;
  let combinerAudioFile = null;
  let combinerTimeline = null;
  let previewVideoUrl = null;
  let previewAudioUrl = null;
  let previewAudioEl = null;

  function isVideoFile(file) {
    const { type = '', name = '' } = file;
    return /video\/(mp4|quicktime)/.test(type) || /\.(mp4|mov)$/i.test(name);
  }

  function isAudioFile(file) {
    const { type = '', name = '' } = file;
    return /audio\//.test(type) || /\.(mp3|wav)$/i.test(name) || isVideoFile(file);
  }

  videoDropzone.addEventListener('click', () => videoFileInput.click());
  audioDropzone.addEventListener('click', () => audioFileInput.click());

  ['dragenter', 'dragover'].forEach(evt => {
    videoDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      videoDropzone.classList.add('hover');
    });
    audioDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      audioDropzone.classList.add('hover');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    videoDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      videoDropzone.classList.remove('hover');
    });
    audioDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      audioDropzone.classList.remove('hover');
    });
  });

  videoDropzone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer.files || [])].filter(isVideoFile);
    if (files.length) {
      combinerVideoFile = files[0];
      videoFileInfo.textContent = `${combinerVideoFile.name} • ${(combinerVideoFile.size/1e6).toFixed(2)} MB`;
      setHidden(videoFileInfo, false);
      initTimeline();
    }
  });

  audioDropzone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer.files || [])].filter(isAudioFile);
    if (files.length) {
      combinerAudioFile = files[0];
      audioFileInfo.textContent = `${combinerAudioFile.name} • ${(combinerAudioFile.size/1e6).toFixed(2)} MB`;
      setHidden(audioFileInfo, false);
      initTimeline();
    }
  });

  videoFileInput.addEventListener('change', () => {
    const files = [...(videoFileInput.files || [])].filter(isVideoFile);
    if (files.length) {
      combinerVideoFile = files[0];
      videoFileInfo.textContent = `${combinerVideoFile.name} • ${(combinerVideoFile.size/1e6).toFixed(2)} MB`;
      setHidden(videoFileInfo, false);
      initTimeline();
    }
  });

  audioFileInput.addEventListener('change', () => {
    const files = [...(audioFileInput.files || [])].filter(isAudioFile);
    if (files.length) {
      combinerAudioFile = files[0];
      audioFileInfo.textContent = `${combinerAudioFile.name} • ${(combinerAudioFile.size/1e6).toFixed(2)} MB`;
      setHidden(audioFileInfo, false);
      initTimeline();
    }
  });

  function initTimeline() {
    if (!combinerVideoFile || !combinerAudioFile) return;
    if (!combinerTimeline) {
      combinerTimeline = new Timeline(timelineContainer, videoBlock, audioBlock, selectionBox, timelineRuler);
    }
    setHidden(timelineSection, false);
    
    // Explicitly show controls section
    const controls = document.querySelector('.combiner-controls');
    if(controls) controls.style.display = 'flex';
    
    Promise.all([
      getMediaDuration(combinerVideoFile),
      getMediaDuration(combinerAudioFile)
    ]).then(([videoDur, audioDur]) => {
      combinerTimeline.setFiles(combinerVideoFile, combinerAudioFile, videoDur, audioDur);
      combineExportBtn.disabled = true; // Wait for selection
      combinerTimeline._playPreview();
    }).catch(err => {
      console.error('Failed to get media durations:', err);
    });
  }

  function getMediaDuration(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
      media.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        resolve(media.duration);
      };
      media.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load media'));
      };
      media.src = url;
    });
  }

  function extractFirstFrame(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.muted = true;
      vid.preload = 'auto';
      vid.onloadeddata = () => { vid.currentTime = 0.01; };
      vid.onseeked = () => {
        const c = document.createElement('canvas');
        c.width = vid.videoWidth;
        c.height = vid.videoHeight;
        c.getContext('2d').drawImage(vid, 0, 0);
        URL.revokeObjectURL(url);
        resolve({ canvas: c, naturalWidth: vid.videoWidth, naturalHeight: vid.videoHeight });
      };
      vid.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Frame extraction failed')); };
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

    setFiles(videoFile, audioFile, videoDur, audioDur) {
      console.log('Timeline setFiles:', { videoDur, audioDur });
      this.videoFile = videoFile;
      this.audioFile = audioFile;
      this.videoDuration = videoDur || 1; // Prevent 0 duration
      this.audioDuration = audioDur || 1;
      this.videoOffset = 0;
      this.audioOffset = 0;
      this.selectionStart = null;
      this.selectionEnd = null;
      this._offsetShift = 0;
      this._render();
      // Initialize playhead at start of video (t=0)
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
      if (!this.videoFile || !this.audioFile) return;
      cleanupPreview();
      
      previewVideoUrl = URL.createObjectURL(this.videoFile);
      previewAudioUrl = URL.createObjectURL(this.audioFile);
      
      previewAudioEl = document.createElement('audio');
      previewAudioEl.src = previewAudioUrl;
      previewAudioEl.volume = 0.8;
      
      previewVideo.src = previewVideoUrl;
      previewVideo.muted = true; // Strip video audio, use separate audio track only
      
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

  function cleanupPreview() {
    if (previewAudioEl) {
      previewAudioEl.pause();
      previewAudioEl.src = '';
      previewAudioEl = null;
    }
    if (previewVideoUrl) {
      URL.revokeObjectURL(previewVideoUrl);
      previewVideoUrl = null;
    }
    if (previewAudioUrl) {
      URL.revokeObjectURL(previewAudioUrl);
      previewAudioUrl = null;
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
    if (!combinerTimeline || !combinerVideoFile || !combinerAudioFile) return;
    const selection = combinerTimeline.getSelection();
    if (!selection) {
      alert('Please select a time range on the timeline');
      return;
    }

    const form = new FormData();
    form.append('video', combinerVideoFile, combinerVideoFile.name);
    form.append('audio', combinerAudioFile, combinerAudioFile.name);
    form.append('videoOffset', String(combinerTimeline.videoOffset));
    form.append('audioOffset', String(combinerTimeline.audioOffset));
    form.append('startTime', String(selection.start));
    form.append('endTime', String(selection.end));
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
  const concatDropzone = document.getElementById('concatDropzone');
  const concatFileInput = document.getElementById('concatFileInput');
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

  let concatFile = null;
  let concatTimeline = null;
  let concatPreviewUrl = null;

  concatDropzone.addEventListener('click', () => concatFileInput.click());
  
  ['dragenter', 'dragover'].forEach(evt => {
    concatDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      concatDropzone.classList.add('hover');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    concatDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      concatDropzone.classList.remove('hover');
    });
  });

  concatDropzone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer.files || [])].filter(isVideoFile);
    if (files.length) {
      concatFile = files[0];
      concatFileInfo.textContent = `${concatFile.name} • ${(concatFile.size/1e6).toFixed(2)} MB`;
      setHidden(concatFileInfo, false);
      initConcatTimeline();
    }
  });

  concatFileInput.addEventListener('change', () => {
    const files = [...(concatFileInput.files || [])].filter(isVideoFile);
    if (files.length) {
      concatFile = files[0];
      concatFileInfo.textContent = `${concatFile.name} • ${(concatFile.size/1e6).toFixed(2)} MB`;
      setHidden(concatFileInfo, false);
      initConcatTimeline();
    }
  });

  function initConcatTimeline() {
    if (!concatFile) return;
    if (!concatTimeline) {
      concatTimeline = new ConcatTimeline(
        concatTimelineContainer,
        concatTrackContent,
        concatVideoBlock,
        concatSelectionsContainer,
        concatTimelineRuler,
        concatPlayhead,
        concatPreviewVideo
      );
    }
    setHidden(concatTimelineSection, false);
    
    getMediaDuration(concatFile).then(dur => {
      concatTimeline.setFile(concatFile, dur);
      concatPlayPauseBtn.disabled = false;
    }).catch(err => {
      console.error('Failed to get video duration:', err);
    });
  }

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
      this.duration = duration;
      this.selections = [];
      this._render();
      this._renderSelections();
      this._loadPreview();
    }

    _loadPreview() {
      if (concatPreviewUrl) {
        URL.revokeObjectURL(concatPreviewUrl);
      }
      concatPreviewUrl = URL.createObjectURL(this.file);
      this.previewVideo.src = concatPreviewUrl;
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
      this.selectionsContainer.innerHTML = '';
      selectionListEl.innerHTML = '';

      this.selections.forEach((sel, idx) => {
        // Timeline visual
        const el = document.createElement('div');
        el.className = 'concat-selection';
        el.style.left = (sel.start * this.pixelsPerSecond) + 'px';
        el.style.width = ((sel.end - sel.start) * this.pixelsPerSecond) + 'px';
        
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
        
        this.selectionsContainer.appendChild(el);

        // Chip list
        const chip = document.createElement('div');
        chip.className = 'selection-chip';
        chip.innerHTML = `<span>${idx + 1}. ${formatTime(sel.start)} - ${formatTime(sel.end)}</span>`;
        const chipRemove = document.createElement('button');
        chipRemove.className = 'chip-remove';
        chipRemove.textContent = '×';
        chipRemove.onclick = () => this.removeSelection(idx);
        chip.appendChild(chipRemove);
        selectionListEl.appendChild(chip);
      });

      concatExportBtn.disabled = this.selections.length === 0;
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

    _attach() {
      let dragStart = null;
      let dragStartX = null;
      let tempSelection = null;
      let isDragging = false;

      const onDown = (e) => {
        if (e.target.closest('.concat-selection')) return;
        e.preventDefault();
        
        const rect = this.trackContent.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const time = Math.max(0, Math.min(this.duration, x / this.pixelsPerSecond));
        
        dragStart = time;
        dragStartX = e.clientX;
        isDragging = false;
        
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };

      const onMove = (e) => {
        if (dragStart === null) return;
        
        // Check if we've moved enough to start dragging (5px threshold)
        if (!isDragging && Math.abs(e.clientX - dragStartX) > 5) {
          isDragging = true;
          // Create temp selection element now that we're dragging
          tempSelection = document.createElement('div');
          tempSelection.className = 'concat-selection';
          tempSelection.style.left = (dragStart * this.pixelsPerSecond) + 'px';
          tempSelection.style.width = '0px';
          tempSelection.style.opacity = '0.7';
          this.selectionsContainer.appendChild(tempSelection);
        }
        
        if (isDragging && tempSelection) {
          const rect = this.trackContent.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const time = Math.max(0, Math.min(this.duration, x / this.pixelsPerSecond));
          
          const left = Math.min(dragStart, time);
          const width = Math.abs(time - dragStart);
          
          tempSelection.style.left = (left * this.pixelsPerSecond) + 'px';
          tempSelection.style.width = (width * this.pixelsPerSecond) + 'px';
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
            // Was dragging - create selection
            const rect = this.trackContent.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const time = Math.max(0, Math.min(this.duration, x / this.pixelsPerSecond));
            this.addSelection(dragStart, time);
          } else {
            // Was just a click - seek to position
            this.previewVideo.currentTime = dragStart;
            this.updatePlayhead(dragStart);
          }
          dragStart = null;
          dragStartX = null;
          isDragging = false;
        }
      };

      this.trackContent.addEventListener('mousedown', onDown);
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
    if (!concatTimeline || !concatFile) return;
    const selections = concatTimeline.getSelections();
    if (selections.length === 0) {
      alert('Please create at least one selection on the timeline');
      return;
    }

    const form = new FormData();
    form.append('video', concatFile, concatFile.name);
    form.append('selections', JSON.stringify(selections));
    form.append('filename', sanitizeFilename('concatenated.mp4'));

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

  // ========== SPEEDER-UPPER ==========
  const speederDropzone = document.getElementById('speederDropzone');
  const speederFileInput = document.getElementById('speederFileInput');
  const speederFileInfo = document.getElementById('speederFileInfo');
  const speederSection = document.getElementById('speederSection');
  const speederPreviewVideo = document.getElementById('speederPreviewVideo');
  const speedFactorInput = document.getElementById('speedFactor');
  const lockFpsCheckbox = document.getElementById('lockFps');
  const origDurationEl = document.getElementById('origDuration');
  const newDurationEl = document.getElementById('newDuration');
  const speederExportBtn = document.getElementById('speederExportBtn');

  let speederFile = null;
  let speederOrigDuration = 0;
  let speederPreviewUrl = null;

  speederDropzone.addEventListener('click', () => speederFileInput.click());

  ['dragenter', 'dragover'].forEach(evt => {
    speederDropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      speederDropzone.classList.add('hover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    speederDropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      speederDropzone.classList.remove('hover');
    });
  });

  speederDropzone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer.files || [])].filter(isVideoFile);
    if (files.length) handleSpeederFile(files[0]);
  });

  speederFileInput.addEventListener('change', () => {
    const files = [...(speederFileInput.files || [])].filter(isVideoFile);
    if (files.length) handleSpeederFile(files[0]);
  });

  async function handleSpeederFile(file) {
    speederFile = file;
    speederFileInfo.textContent = `${file.name} • ${(file.size/1e6).toFixed(2)} MB`;
    setHidden(speederFileInfo, false);
    setHidden(speederSection, false);

    if (speederPreviewUrl) URL.revokeObjectURL(speederPreviewUrl);
    speederPreviewUrl = URL.createObjectURL(file);
    speederPreviewVideo.src = speederPreviewUrl;

    speederOrigDuration = await getMediaDuration(file);
    origDurationEl.textContent = formatTime(speederOrigDuration);
    updateNewDuration();
  }

  function updateNewDuration() {
    const factor = parseFloat(speedFactorInput.value) || 1.0;
    if (factor <= 0) return;
    const newDur = speederOrigDuration / factor;
    newDurationEl.textContent = formatTime(newDur);
  }

  speedFactorInput.addEventListener('input', updateNewDuration);

  speederExportBtn.addEventListener('click', async () => {
    if (!speederFile) return;
    const factor = parseFloat(speedFactorInput.value) || 1.0;
    const lockFps = lockFpsCheckbox.checked;

    const form = new FormData();
    form.append('video', speederFile, speederFile.name);
    form.append('speedFactor', String(factor));
    form.append('lockFps', String(lockFps));
    form.append('duration', String(speederOrigDuration));
    form.append('filename', sanitizeFilename('sped_up.mp4'));

    speederExportBtn.disabled = true;
    speederExportBtn.textContent = 'Exporting 0%';

    try {
      const resp = await fetch('/api/speedup', { method: 'POST', body: form });
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
              speederExportBtn.textContent = `Exporting ${data.percent}%`;
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
              a.download = data.filename || 'sped_up.mp4';
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
      console.error('Speeder export error:', err);
      alert(err.message || String(err));
    } finally {
      speederExportBtn.disabled = false;
      speederExportBtn.textContent = 'Speed Up & Export';
    }
  });

  // ========== REEL/LINKEDIN TIMELAPSER ==========
  const timelapseTopDropzone = document.getElementById('timelapseTopDropzone');
  const timelapseBottomDropzone = document.getElementById('timelapseBottomDropzone');
  const timelapseTopFileInput = document.getElementById('timelapseTopFileInput');
  const timelapseBottomFileInput = document.getElementById('timelapseBottomFileInput');
  const timelapseTopList = document.getElementById('timelapseTopList');
  const timelapseBottomList = document.getElementById('timelapseBottomList');
  const timelapserSection = document.getElementById('timelapserSection');
  const timelapseOrigDurationEl = document.getElementById('timelapseOrigDuration');
  const timelapseNewDurationEl = document.getElementById('timelapseNewDuration');
  const timelapseDoubleResCheckbox = document.getElementById('timelapseDoubleRes');
  const timelapseExportBtn = document.getElementById('timelapseExportBtn');
  const timelapseLog = document.getElementById('timelapseLog');

  let timelapseTopFiles = []; // Array of { file, duration, speedFactor }
  let timelapseBottomFiles = [];
  let timelapsePanes = {}; // PaneController instances for preview

  timelapseTopDropzone.addEventListener('click', () => timelapseTopFileInput.click());
  timelapseBottomDropzone.addEventListener('click', () => timelapseBottomFileInput.click());

  ['dragenter', 'dragover'].forEach(evt => {
    timelapseTopDropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      timelapseTopDropzone.classList.add('hover');
    });
    timelapseBottomDropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      timelapseBottomDropzone.classList.add('hover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    timelapseTopDropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      timelapseTopDropzone.classList.remove('hover');
    });
    timelapseBottomDropzone.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      timelapseBottomDropzone.classList.remove('hover');
    });
  });

  timelapseTopDropzone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer.files || [])].filter(isVideoFile);
    if (files.length) handleTimelapseFiles(files, 'top');
  });
  timelapseBottomDropzone.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer.files || [])].filter(isVideoFile);
    if (files.length) handleTimelapseFiles(files, 'bottom');
  });

  timelapseTopFileInput.addEventListener('change', () => {
    const files = [...(timelapseTopFileInput.files || [])].filter(isVideoFile);
    if (files.length) handleTimelapseFiles(files, 'top');
  });
  timelapseBottomFileInput.addEventListener('change', () => {
    const files = [...(timelapseBottomFileInput.files || [])].filter(isVideoFile);
    if (files.length) handleTimelapseFiles(files, 'bottom');
  });

  async function handleTimelapseFiles(files, position) {
    const list = position === 'top' ? timelapseTopFiles : timelapseBottomFiles;
    
    for (const file of files) {
      const duration = await getMediaDuration(file);
      list.push({ file, duration, speedFactor: 1.0 });
    }

    renderTimelapseList(position);
    updateTimelapseTotals();
  }

  function renderTimelapseList(position) {
    const list = position === 'top' ? timelapseTopFiles : timelapseBottomFiles;
    const listEl = position === 'top' ? timelapseTopList : timelapseBottomList;
    
    listEl.innerHTML = '';
    list.forEach((item, idx) => {
      const li = document.createElement('li');
      li.className = 'timelapse-item';
      li.innerHTML = `
        <div class="timelapse-item-header">
          <span class="timelapse-item-name" title="${item.file.name}">${item.file.name}</span>
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
      const topFrame = await extractFirstFrame(timelapseTopFiles[0].file);
      const bottomFrame = await extractFirstFrame(timelapseBottomFiles[0].file);

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
    timelapseTopFiles.forEach((item, i) => {
      form.append(`top`, item.file, item.file.name);
      form.append(`topFactors`, String(item.speedFactor));
    });
    timelapseBottomFiles.forEach((item, i) => {
      form.append(`bottom`, item.file, item.file.name);
      form.append(`bottomFactors`, String(item.speedFactor));
    });

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
