const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');
const { spawn, spawnSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const TMP_DIR = path.join(os.tmpdir(), 'local-ffmpeg-cropper');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logClients = new Set();
const pendingDownloads = new Map();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
  for (const client of logClients) {
    client.write(`data: ${JSON.stringify(line)}\n\n`);
  }
}

// Throttled ffmpeg stderr logger – emits at most once per interval
function makeStderrLogger(prefix, intervalMs = 500) {
  let last = 0;
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    const now = Date.now();
    if (now - last >= intervalMs) {
      // grab last meaningful line (skip empty)
      const lines = pending.trimEnd().split('\n').filter(l => l.trim());
      if (lines.length) log(`${prefix} ffmpeg:`, lines[lines.length - 1].trim());
      pending = '';
      last = now;
    }
  };
}

const upload = multer({ dest: TMP_DIR });

// ffmpeg sanity check
try {
  const check = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (check.error) {
    log('WARN ffmpeg not found on PATH. Install ffmpeg to enable export.');
  } else if (check.status !== 0) {
    log('WARN ffmpeg non-zero status', String(check.status));
  } else {
    const firstLine = (check.stdout || '').split('\n')[0];
    log('ffmpeg using', firstLine);
  }
} catch (err) {
  log('WARN ffmpeg check failed', err.message);
}

// Static frontend
app.use((req, _res, next) => { log(`${req.method} ${req.url}`); next(); });
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Live log stream
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

app.get('/api/download/:id', (req, res) => {
  const entry = pendingDownloads.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Download not found or expired' });
  pendingDownloads.delete(req.params.id);
  res.download(entry.filePath, entry.filename, (err) => {
    if (err) log('ERROR download stream', err.message);
    entry.cleanup();
  });
});

// Placeholder root (index.html served statically)

// Crop endpoint: multipart form-data with fields: x, y, w, h, filename and file field: video
app.post('/api/crop', upload.single('video'), (req, res) => {
  const uploadedPath = req.file && req.file.path;
  if (!uploadedPath) {
    log('ERROR no video uploaded');
    return res.status(400).json({ error: 'No video uploaded' });
  }

  const parseIntSafe = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : fallback;
  };

  const toEven = (n) => (n % 2 === 0 ? n : n - 1);

  let x = parseIntSafe(req.body.x, 0);
  let y = parseIntSafe(req.body.y, 0);
  let w = parseIntSafe(req.body.w, 0);
  let h = parseIntSafe(req.body.h, 0);

  // ffmpeg h264 prefers even dimensions
  w = Math.max(2, toEven(Math.abs(w)));
  h = Math.max(2, toEven(Math.abs(h)));
  x = Math.max(0, x);
  y = Math.max(0, y);

  const clientFilename = (req.body.filename || 'output').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}_crop.mp4`;

  log('CROP start', {
    file: { name: req.file && req.file.originalname, size: req.file && req.file.size },
    rect: { x, y, w, h },
  });
  log('CROP uploading temp file at', uploadedPath);

  const evenWExpr = `max(2,floor(min(${w},iw-${x})/2)*2)`;
  const evenHExpr = `max(2,floor(min(${h},ih-${y})/2)*2)`;
  const esc = (s) => String(s).replace(/,/g, '\\,');
  const cropExpr = `crop=${esc(evenWExpr)}:${esc(evenHExpr)}:${x}:${y}`;
  const args = [
    '-hide_banner',
    '-i', uploadedPath,
    '-vf', cropExpr,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'copy',
    '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4',
    'pipe:1'
  ];
  log('CROP spawning ffmpeg:', 'ffmpeg', args.join(' '));

  const ff = spawn('ffmpeg', args);
  let wroteVideo = false;
  let stderrBuf = '';

  const cleanup = () => {
    if (uploadedPath) {
      fs.unlink(uploadedPath, () => {});
    }
  };

  ff.stdout.on('data', (chunk) => {
    if (!wroteVideo) {
      log('CROP first video chunk received, streaming response...');
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
      wroteVideo = true;
    }
    res.write(chunk);
  });
  const cropStderr = makeStderrLogger('CROP');
  ff.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    cropStderr(d);
  });

  ff.on('close', (code) => {
    cleanup();
    log('CROP ffmpeg exited code=' + code, 'wroteVideo=' + wroteVideo, 'stderrTail=', tail(stderrBuf));
    if (!wroteVideo) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'ffmpeg failed before producing output', details: tail(stderrBuf) });
      } else {
        res.end();
      }
      return;
    }
    res.end();
  });

  ff.on('error', (err) => {
    cleanup();
    log('ERROR failed to start ffmpeg', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to start ffmpeg', details: err.message });
    } else {
      res.end();
    }
  });

  // Abort handling
  res.on('close', () => {
    try { ff.kill('SIGKILL'); } catch (_) {}
    cleanup();
  });
});

// Combine endpoint: multipart form-data with fields: video, audio, videoOffset, audioOffset, startTime, endTime, filename
app.post('/api/combine', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), (req, res) => {
  const videoFile = req.files && req.files.video && req.files.video[0];
  const audioFile = req.files && req.files.audio && req.files.audio[0];
  
  if (!videoFile || !audioFile) {
    log('ERROR missing video or audio file');
    return res.status(400).json({ error: 'Both video and audio files required' });
  }

  const parseFloatSafe = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const videoOffset = parseFloatSafe(req.body.videoOffset, 0);
  const audioOffset = parseFloatSafe(req.body.audioOffset, 0); // Can be negative
  const startTime = parseFloatSafe(req.body.startTime, 0);
  const endTime = Math.max(startTime + 0.1, parseFloatSafe(req.body.endTime, startTime + 1));
  const duration = endTime - startTime;

  const clientFilename = (req.body.filename || 'combined').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}.mp4`;

  // Calculate file positions from timeline positions
  // Timeline position T -> Video file time = T - videoOffset
  // Timeline position T -> Audio file time = T - audioOffset
  const videoStart = Math.max(0, startTime - videoOffset);
  const audioStart = Math.max(0, startTime - audioOffset);

  log('COMBINE start', {
    video: { name: videoFile.originalname, size: videoFile.size },
    audio: { name: audioFile.originalname, size: audioFile.size },
    videoOffset,
    audioOffset,
    startTime,
    endTime,
    duration,
    videoStart,
    audioStart
  });
  log('COMBINE video temp:', videoFile.path, '| audio temp:', audioFile.path);

  const outputPath = path.join(TMP_DIR, `combine_${Date.now()}.mp4`);
  log('COMBINE output will be:', outputPath);

  const args = [
    '-hide_banner',
    '-progress', 'pipe:2',
    '-ss', String(videoStart),
    '-t', String(duration),
    '-i', videoFile.path,
    '-ss', String(audioStart),
    '-t', String(duration),
    '-i', audioFile.path,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-af', 'afade=t=in:st=0:d=1.5',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-movflags', '+faststart',
    '-y',
    outputPath
  ];

  log('COMBINE spawning ffmpeg:', args.join(' '));

  // SSE for progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const ff = spawn('ffmpeg', args);
  let stderrBuf = '';
  const combineStderr = makeStderrLogger('COMBINE');

  const cleanup = () => {
    if (videoFile && videoFile.path) fs.unlink(videoFile.path, () => {});
    if (audioFile && audioFile.path) fs.unlink(audioFile.path, () => {});
  };

  const sendProgress = (pct) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);
  };

  ff.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    combineStderr(d);
    // Parse progress: "out_time_ms=1234567" or "out_time=00:00:01.234"
    const timeMatch = stderrBuf.match(/out_time_ms=(\d+)/g);
    if (timeMatch) {
      const lastMatch = timeMatch[timeMatch.length - 1];
      const ms = parseInt(lastMatch.split('=')[1], 10);
      const pct = Math.min(99, Math.round((ms / 1000 / duration) * 100));
      sendProgress(pct);
    }
  });

  ff.on('close', (code) => {
    log('COMBINE ffmpeg exited code=' + code, 'stderrTail=', tail(stderrBuf));

    if (code !== 0 || !fs.existsSync(outputPath)) {
      log('COMBINE failed — no output or non-zero exit');
      cleanup();
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'ffmpeg failed', details: tail(stderrBuf) })}\n\n`);
      res.end();
      return;
    }

    sendProgress(100);

    // Read and send the file
    const fileBuffer = fs.readFileSync(outputPath);
    log('COMBINE done, sending', (fileBuffer.length / 1024 / 1024).toFixed(1) + 'MB as base64');
    const base64 = fileBuffer.toString('base64');
    res.write(`data: ${JSON.stringify({ type: 'complete', filename: outName, data: base64 })}\n\n`);
    res.end();

    // Cleanup
    cleanup();
    fs.unlink(outputPath, () => {});
  });

  ff.on('error', (err) => {
    cleanup();
    log('ERROR failed to start ffmpeg combine', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to start ffmpeg', details: err.message })}\n\n`);
    res.end();
  });

  // Abort handling
  res.on('close', () => {
    try { ff.kill('SIGKILL'); } catch (_) {}
    cleanup();
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
  });
});

// Concat endpoint: multipart form-data with fields: video, selections (JSON array), filename
app.post('/api/concat', upload.single('video'), async (req, res) => {
  const videoFile = req.file;
  
  if (!videoFile) {
    log('ERROR no video uploaded for concat');
    return res.status(400).json({ error: 'No video uploaded' });
  }

  let selections;
  try {
    selections = JSON.parse(req.body.selections || '[]');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid selections JSON' });
  }

  if (!selections.length) {
    fs.unlink(videoFile.path, () => {});
    return res.status(400).json({ error: 'No selections provided' });
  }

  const clientFilename = (req.body.filename || 'concatenated').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}.mp4`;
  const outputPath = path.join(TMP_DIR, `concat_${Date.now()}.mp4`);
  const concatListPath = path.join(TMP_DIR, `concat_list_${Date.now()}.txt`);
  const clipPaths = [];

  log('CONCAT start', {
    video: { name: videoFile.originalname, size: videoFile.size },
    numSelections: selections.length,
    selections,
    outputPath
  });
  log('CONCAT video temp:', videoFile.path);

  // SSE for progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = (pct) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);
  };

  const cleanup = () => {
    if (videoFile && videoFile.path) fs.unlink(videoFile.path, () => {});
    clipPaths.forEach(p => fs.unlink(p, () => {}));
    fs.unlink(concatListPath, () => {});
    fs.unlink(outputPath, () => {});
  };

  try {
    // Step 1: Extract each clip
    const totalClips = selections.length;
    for (let i = 0; i < selections.length; i++) {
      const sel = selections[i];
      const clipPath = path.join(TMP_DIR, `clip_${Date.now()}_${i}.mp4`);
      clipPaths.push(clipPath);

      const duration = sel.end - sel.start;
      // Fast seek (-ss before -i) + stream copy = no re-encode
      const args = [
        '-hide_banner',
        '-ss', String(sel.start),
        '-i', videoFile.path,
        '-t', String(duration),
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-y',
        clipPath
      ];

      log(`CONCAT extracting clip ${i + 1}/${totalClips}: start=${sel.start} duration=${duration} -> ${clipPath}`);
      log(`CONCAT clip ffmpeg:`, args.join(' '));

      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', args);
        let stderr = '';
        const clipStderr = makeStderrLogger(`CONCAT clip${i + 1}`);
        ff.stderr.on('data', d => { stderr += d.toString(); clipStderr(d); });
        ff.on('close', code => {
          log(`CONCAT clip ${i + 1}/${totalClips} ffmpeg exited code=${code}`);
          if (code === 0) resolve();
          else reject(new Error(`Clip extraction failed: ${tail(stderr)}`));
        });
        ff.on('error', reject);
      });

      sendProgress(Math.round(((i + 1) / totalClips) * 50));
    }

    // Step 2: Create concat list file
    log('CONCAT all clips extracted, writing concat list:', concatListPath);
    const concatList = clipPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatListPath, concatList);

    // Step 3: Concatenate clips (stream copy — same source, no re-encode needed)
    const concatArgs = [
      '-hide_banner',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y',
      outputPath
    ];

    log('CONCAT joining clips, spawning ffmpeg:', concatArgs.join(' '));

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', concatArgs);
      let stderr = '';
      const joinStderr = makeStderrLogger('CONCAT join');
      ff.stderr.on('data', d => { stderr += d.toString(); joinStderr(d); });
      ff.on('close', code => {
        log('CONCAT join ffmpeg exited code=' + code);
        if (code === 0) resolve();
        else reject(new Error(`Concat failed: ${tail(stderr)}`));
      });
      ff.on('error', reject);
    });

    sendProgress(100);

    // Send download URL instead of base64 (handles large files)
    const stat = fs.statSync(outputPath);
    log('CONCAT done,', (stat.size / 1024 / 1024).toFixed(1) + 'MB — sending download link');
    const dlId = path.basename(outputPath);
    pendingDownloads.set(dlId, { filePath: outputPath, filename: outName, cleanup });
    res.write(`data: ${JSON.stringify({ type: 'complete', downloadUrl: `/api/download/${dlId}`, filename: outName })}\n\n`);
    res.end();

  } catch (err) {
    log('ERROR concat failed', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Concatenation failed', details: err.message })}\n\n`);
    res.end();
    cleanup();
  }
});

// Speedup endpoint: multipart form-data with fields: video, speedFactor, lockFps, filename
app.post('/api/speedup', upload.single('video'), async (req, res) => {
  const videoFile = req.file;
  if (!videoFile) return res.status(400).json({ error: 'No video uploaded' });

  const speedFactor = parseFloat(req.body.speedFactor) || 1.0;
  const lockFps = req.body.lockFps === 'true';
  const duration = parseFloat(req.body.duration) || 0;
  const clientFilename = (req.body.filename || 'sped_up').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}.mp4`;
  const outputPath = path.join(TMP_DIR, `speedup_${Date.now()}.mp4`);

  log('SPEEDUP start', { video: videoFile.originalname, size: videoFile.size, speedFactor, lockFps, duration });
  log('SPEEDUP video temp:', videoFile.path, '| output:', outputPath);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const sendProgress = (pct) => res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);

  // setpts=1/factor for video, atempo=factor for audio (atempo limited to 0.5-2.0, so we might need multiple atempo filters)
  let videoFilter = `setpts=${1/speedFactor}*PTS`;
  if (lockFps) videoFilter += `,fps=30`;

  // Audio speedup: atempo only supports 0.5 to 2.0. Chain them if outside range.
  let audioFilter = '';
  let tempFactor = speedFactor;
  while (tempFactor > 2.0) {
    audioFilter += (audioFilter ? ',' : '') + 'atempo=2.0';
    tempFactor /= 2.0;
  }
  while (tempFactor < 0.5) {
    audioFilter += (audioFilter ? ',' : '') + 'atempo=0.5';
    tempFactor /= 0.5;
  }
  if (tempFactor !== 1.0) {
    audioFilter += (audioFilter ? ',' : '') + `atempo=${tempFactor}`;
  }

  log('SPEEDUP videoFilter:', videoFilter, '| audioFilter:', audioFilter);

  const args = [
    '-hide_banner',
    '-progress', 'pipe:2',
    '-i', videoFile.path,
    '-vf', videoFilter,
    '-af', audioFilter,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-y', outputPath
  ];

  log('SPEEDUP spawning ffmpeg:', args.join(' '));
  const ff = spawn('ffmpeg', args);
  let stderrBuf = '';
  const speedStderr = makeStderrLogger('SPEEDUP');

  ff.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    speedStderr(d);
    const timeMatch = stderrBuf.match(/out_time_ms=(\d+)/g);
    if (timeMatch && duration > 0) {
      const lastMatch = timeMatch[timeMatch.length - 1];
      const ms = parseInt(lastMatch.split('=')[1], 10);
      // Progress is based on input time processed. 
      // ffmpeg's out_time_ms for speedup will be (input_time / speedFactor)
      // So input_time = out_time_ms * speedFactor
      const inputTimeMs = (ms / 1000) * speedFactor;
      const pct = Math.min(99, Math.round((inputTimeMs / duration) * 100));
      sendProgress(pct);
    }
  });

  ff.on('close', (code) => {
    log('SPEEDUP ffmpeg exited code=' + code);
    if (code === 0 && fs.existsSync(outputPath)) {
      sendProgress(100);
      const data = fs.readFileSync(outputPath).toString('base64');
      log('SPEEDUP done, sending', (Buffer.byteLength(data, 'base64') / 1024 / 1024).toFixed(1) + 'MB');
      res.write(`data: ${JSON.stringify({ type: 'complete', filename: outName, data })}\n\n`);
    } else {
      log('SPEEDUP failed, stderrTail=', tail(stderrBuf));
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'ffmpeg failed', details: tail(stderrBuf) })}\n\n`);
    }
    res.end();
    fs.unlink(videoFile.path, () => {});
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
  });
});

// Timelapse endpoint: multipart form-data with fields: top, bottom, topFactors, bottomFactors, duration, filename
app.post('/api/timelapse', upload.fields([{ name: 'top' }, { name: 'bottom' }]), async (req, res) => {
  const topFiles = req.files && req.files.top;
  const bottomFiles = req.files && req.files.bottom;
  
  if (!topFiles || !bottomFiles) return res.status(400).json({ error: 'Both top and bottom videos required' });

  const topFactors = [].concat(req.body.topFactors || []).map(f => parseFloat(f) || 1.0);
  const bottomFactors = [].concat(req.body.bottomFactors || []).map(f => parseFloat(f) || 1.0);
  const doubleRes = req.body.doubleRes === 'true';
  const duration = parseFloat(req.body.duration) || 0;
  const clientFilename = (req.body.filename || 'timelapse').replace(/[^A-Za-z0-9_.-]/g, '_');

  const safeInt = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : -1; };
  const safeFloat = (v, def) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 1 ? n : def; };
  const sqTopCropX = safeInt(req.body.sqTopCropX);
  const sqTopCropY = safeInt(req.body.sqTopCropY);
  const sqTopZoom = safeFloat(req.body.sqTopZoom, 1.0);
  const sqBottomCropX = safeInt(req.body.sqBottomCropX);
  const sqBottomCropY = safeInt(req.body.sqBottomCropY);
  const sqBottomZoom = safeFloat(req.body.sqBottomZoom, 1.0);
  const reelsTopCropX = safeInt(req.body.reelsTopCropX);
  const reelsTopCropY = safeInt(req.body.reelsTopCropY);
  const reelsTopZoom = safeFloat(req.body.reelsTopZoom, 1.0);
  const reelsBottomCropX = safeInt(req.body.reelsBottomCropX);
  const reelsBottomCropY = safeInt(req.body.reelsBottomCropY);
  const reelsBottomZoom = safeFloat(req.body.reelsBottomZoom, 1.0);

  log('TIMELAPSE start', {
    top: topFiles.map(f => ({ name: f.originalname, size: f.size })),
    bottom: bottomFiles.map(f => ({ name: f.originalname, size: f.size })),
    topFactors, bottomFactors, doubleRes, duration,
    cropOffsets: { sqTopCropX, sqTopCropY, sqTopZoom, sqBottomCropX, sqBottomCropY, sqBottomZoom,
                   reelsTopCropX, reelsTopCropY, reelsTopZoom, reelsBottomCropX, reelsBottomCropY, reelsBottomZoom }
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = (pct) => res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);
  const sendLog = (message) => res.write(`data: ${JSON.stringify({ type: 'log', message })}\n\n`);
  const sendComplete = (filename, data) => res.write(`data: ${JSON.stringify({ type: 'complete', filename, data })}\n\n`);
  const sendError = (error, details) => res.write(`data: ${JSON.stringify({ type: 'error', error, details })}\n\n`);

  const intermediateFiles = [];
  const cleanup = () => {
    [...topFiles, ...bottomFiles].forEach(f => fs.unlink(f.path, () => {}));
    intermediateFiles.forEach(f => fs.unlink(f, () => {}));
  };

  const runFfmpeg = (args, progressOffset, progressWeight = 1) => {
    sendLog(`Running: ffmpeg ${args.join(' ')}`);
    return new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      let stderr = '';
      const tlStderr = makeStderrLogger('TIMELAPSE');
      ff.stderr.on('data', (d) => {
        const line = d.toString();
        stderr += line;
        tlStderr(d);
        sendLog(line.trim());
        const timeMatch = line.match(/out_time_ms=(\d+)/);
        if (timeMatch && duration > 0) {
          const ms = parseInt(timeMatch[1], 10);
          // This is a rough estimate for progress when multiple ffmpeg commands run
          const pct = Math.min(99, Math.round((ms / 1000 / duration) * 100 * progressWeight));
          sendProgress(Math.min(99, progressOffset + pct));
        }
      });
      ff.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg failed: ${tail(stderr)}`));
      });
      ff.on('error', reject);
    });
  };

  const processPane = async (files, factors, name) => {
    const spedUpClips = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const factor = factors[i];
      const clipPath = path.join(TMP_DIR, `${name}_clip_${i}_${Date.now()}.mp4`);
      
      let audioFilter = '';
      let tempFactor = factor;
      while (tempFactor > 2.0) { audioFilter += (audioFilter ? ',' : '') + 'atempo=2.0'; tempFactor /= 2.0; }
      while (tempFactor < 0.5) { audioFilter += (audioFilter ? ',' : '') + 'atempo=0.5'; tempFactor /= 0.5; }
      if (tempFactor !== 1.0) audioFilter += (audioFilter ? ',' : '') + `atempo=${tempFactor}`;

      const ffArgs = [
        '-hide_banner', '-i', file.path,
        '-vf', `setpts=1/${factor}*PTS,fps=30`,
      ];
      if (audioFilter) ffArgs.push('-af', audioFilter);
      else ffArgs.push('-an');
      ffArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-y', clipPath);

      await runFfmpeg(ffArgs, 0, 0);
      
      spedUpClips.push(clipPath);
      intermediateFiles.push(clipPath);
    }

    const panePath = path.join(TMP_DIR, `${name}_pane_${Date.now()}.mp4`);
    if (spedUpClips.length === 1) {
      return spedUpClips[0];
    } else {
      const listPath = path.join(TMP_DIR, `${name}_list_${Date.now()}.txt`);
      fs.writeFileSync(listPath, spedUpClips.map(p => `file '${p}'`).join('\n'));
      intermediateFiles.push(listPath);
      
      await runFfmpeg([
        '-hide_banner', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-c', 'copy', '-y', panePath
      ], 0, 0);
      intermediateFiles.push(panePath);
      return panePath;
    }
  };

  try {
    sendProgress(5);
    log('TIMELAPSE processing top pane...');
    const topPanePath = await processPane(topFiles, topFactors, 'top');
    log('TIMELAPSE top pane done:', topPanePath);
    sendProgress(20);
    log('TIMELAPSE processing bottom pane...');
    const bottomPanePath = await processPane(bottomFiles, bottomFactors, 'bottom');
    log('TIMELAPSE bottom pane done:', bottomPanePath);
    sendProgress(40);

    const baseWidth = doubleRes ? 2160 : 1080;
    const halfHeight = doubleRes ? 1080 : 540;
    const fullHeight = doubleRes ? 2160 : 1080;
    const reelsHalfHeight = doubleRes ? 1920 : 960;

    // 1. LinkedIn (Square)
    log('TIMELAPSE rendering square (LinkedIn) output...');
    const liPath = path.join(TMP_DIR, `li_${Date.now()}.mp4`);
    intermediateFiles.push(liPath);
    const sqTopScaleW = Math.round(baseWidth * sqTopZoom);
    const sqBotScaleW = Math.round(baseWidth * sqBottomZoom);
    const sqTX = sqTopCropX >= 0 ? sqTopCropX : `(iw-${baseWidth})/2`;
    const sqTY = sqTopCropY >= 0 ? sqTopCropY : `(ih-${halfHeight})/2`;
    const sqBX = sqBottomCropX >= 0 ? sqBottomCropX : `(iw-${baseWidth})/2`;
    const sqBY = sqBottomCropY >= 0 ? sqBottomCropY : `(ih-${halfHeight})/2`;
    const liFilter = `
      [0:v]fps=30,scale=${sqTopScaleW}:-2,crop=${baseWidth}:${halfHeight}:${sqTX}:${sqTY}[v1];
      [1:v]fps=30,scale=${sqBotScaleW}:-2,crop=${baseWidth}:${halfHeight}:${sqBX}:${sqBY}[v2];
      [v1][v2]vstack=inputs=2,scale=${baseWidth}:${fullHeight}
    `.replace(/\s+/g, '');
    
    await runFfmpeg([
      '-hide_banner', '-progress', 'pipe:2',
      '-i', topPanePath, '-i', bottomPanePath,
      '-filter_complex', liFilter,
      '-r', '30', '-c:v', 'libx264', '-crf', '10', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-an', '-movflags', '+faststart', '-y', liPath
    ], 40, 0.3);
    
    sendProgress(70);
    const liData = fs.readFileSync(liPath).toString('base64');
    log('TIMELAPSE square done, sending', (Buffer.byteLength(liData, 'base64') / 1024 / 1024).toFixed(1) + 'MB');
    sendComplete(`${clientFilename}_square.mp4`, liData);

    // 2. Reels (Tall)
    log('TIMELAPSE rendering reels (tall) output...');
    const reelsPath = path.join(TMP_DIR, `reels_${Date.now()}.mp4`);
    intermediateFiles.push(reelsPath);
    const reelsTopScaleH = Math.round(reelsHalfHeight * reelsTopZoom);
    const reelsBotScaleH = Math.round(reelsHalfHeight * reelsBottomZoom);
    const rTX = reelsTopCropX >= 0 ? reelsTopCropX : `(iw-${baseWidth})/2`;
    const rTY = reelsTopCropY >= 0 ? reelsTopCropY : '0';
    const rBX = reelsBottomCropX >= 0 ? reelsBottomCropX : `(iw-${baseWidth})/2`;
    const rBY = reelsBottomCropY >= 0 ? reelsBottomCropY : '0';
    const reelsFilter = `
      [0:v]fps=30,scale=-2:${reelsTopScaleH},crop=${baseWidth}:${reelsHalfHeight}:${rTX}:${rTY}[v1];
      [1:v]fps=30,scale=-2:${reelsBotScaleH},crop=${baseWidth}:${reelsHalfHeight}:${rBX}:${rBY}[v2];
      [v1][v2]vstack=inputs=2
    `.replace(/\s+/g, '');

    await runFfmpeg([
      '-hide_banner', '-progress', 'pipe:2',
      '-i', topPanePath, '-i', bottomPanePath,
      '-filter_complex', reelsFilter,
      '-r', '30', '-c:v', 'libx264', '-crf', '10', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-an', '-movflags', '+faststart', '-y', reelsPath
    ], 70, 0.3);

    sendProgress(100);
    const reelsData = fs.readFileSync(reelsPath).toString('base64');
    log('TIMELAPSE reels done, sending', (Buffer.byteLength(reelsData, 'base64') / 1024 / 1024).toFixed(1) + 'MB');
    sendComplete(`${clientFilename}_reels.mp4`, reelsData);

    log('TIMELAPSE complete, cleaning up');
    cleanup();
    res.end();

  } catch (err) {
    log('ERROR timelapse failed', err.message);
    sendError('Timelapse failed', err.message);
    res.end();
    cleanup();
  }
});

app.listen(PORT, () => {
  log(`[cropper] listening on http://localhost:${PORT}`, 'tmp=', TMP_DIR, 'log=', LOG_FILE);
});

function tail(s, max = 500) {
  if (!s) return '';
  return s.length <= max ? s : s.slice(-max);
}


