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
  dropzone.addEventListener('drop', (e) => {
    const dropped = [...(e.dataTransfer.files || [])].filter(f => /video\/mp4/.test(f.type) || /\.mp4$/i.test(f.name));
    if (dropped.length) loadFiles(dropped);
  });
  fileInput.addEventListener('change', () => {
    const picked = [...(fileInput.files || [])].filter(f => /video\/mp4/.test(f.type) || /\.mp4$/i.test(f.name));
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
      video.loop = true;
      cropper.resetToDefault();
      const base = (currentFile && currentFile.name) ? currentFile.name.replace(/\.[^.]+$/, '') : 'output';
      outName.value = `${base}_crop.mp4`;
    });
  });

  // Fallback: also respond to canplay in case layout happens later
  video.addEventListener('canplay', () => {
    if (cropper) waitForLayout(video).then(() => cropper.resetToDefault());
  });

  // Resize: recenter crop box (simple approach)
  window.addEventListener('resize', () => {
    if (cropper) cropper.resetToDefault();
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
        this.videoEl.loop = true; this.videoEl.play().catch(() => {});
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
            const ratio = this.aspect === '1:1' ? 1 : (9/16);
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
      const h = this.aspect === '9:16' ? Math.round(w * 16 / 9) : w;
      const ww = Math.min(w, vr.width - 10);
      const hh = Math.min(h, vr.height - 10);
      const left = Math.round(vr.left + (vr.width - ww) / 2);
      const top = Math.round(vr.top + (vr.height - hh) / 2);
      this._apply({ left, top, width: ww, height: hh });
    }

    setAspect(val) {
      this.aspect = val; // 'free' | '1:1' | '9:16'
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
})();


