const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
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
// Prioritizes the useful status line (frame= fps= speed=) over noise like progress=continue
function makeStderrLogger(prefix, intervalMs = 500) {
  let last = 0;
  let pending = '';
  return (chunk) => {
    pending += chunk.toString();
    const now = Date.now();
    if (now - last >= intervalMs) {
      const lines = pending.trimEnd().split('\n').filter(l => l.trim());
      // Prefer the line with frame/fps/speed info
      const statusLine = lines.reverse().find(l => /frame=|speed=|size=/.test(l));
      const useful = statusLine || lines.find(l => !/^progress=/.test(l) && !/^(out_time|dup_|drop_|total_size|bitrate)/.test(l));
      if (useful) log(`${prefix}`, useful.trim());
      pending = '';
      last = now;
    }
  };
}

const upload = multer({ dest: TMP_DIR });

// Source frame rate as an ffmpeg-friendly ratio string (e.g. "30000/1001").
// Used to force CFR output on re-encodes: VFR sources (screen recordings,
// iPhone captures) otherwise carry variable timestamps into the output, which
// QuickTime plays with slow-motion stretches. Prefers avg_frame_rate (true
// frames/duration), falls back to r_frame_rate, then 30.
function probeFps(filePath, fallback = '30') {
  for (const entry of ['avg_frame_rate', 'r_frame_rate']) {
    const ff = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
      '-show_entries', `stream=${entry}`, '-of', 'csv=p=0', filePath],
      { encoding: 'utf8', timeout: 10000 });
    const raw = ((ff.stdout || '').trim().split('\n')[0] || '').trim();
    if (!raw) continue;
    const [num, den] = raw.split('/').map(Number);
    const v = den ? num / den : num;
    if (Number.isFinite(v) && v >= 1 && v <= 240) return raw;
  }
  return fallback;
}

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Kill all processes and restart the server (dev convenience)
app.post('/api/restart', (req, res) => {
  log('RESTART requested — killing all processes and restarting server');
  res.json({ ok: true });
  const root = path.join(__dirname, '..');
  const script = `
    sleep 1
    pkill -f "node server/index.js" 2>/dev/null || true
    pkill -f "ffmpeg" 2>/dev/null || true
    pkill -f "ffprobe" 2>/dev/null || true
    sleep 1
    cd "${root}" && nohup node server/index.js > /dev/null 2>&1 &
  `;
  const helper = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
  helper.unref();
});

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

// Native file picker via macOS Finder dialog
app.post('/api/browse', (req, res) => {
  const accept = req.body.accept || 'mov,mp4';  // comma-separated extensions
  const multiple = req.body.multiple || false;
  const exts = accept.split(',').map(e => e.trim().replace(/^\./, '')).filter(Boolean);
  const typeList = exts.map(e => `"${e}"`).join(', ');
  const multipleClause = multiple ? 'with multiple selections allowed' : '';

  const script = `
    set theFiles to choose file of type {${typeList}} ${multipleClause} with prompt "Choose file(s)"
    if class of theFiles is list then
      set output to ""
      repeat with f in theFiles
        set output to output & POSIX path of f & linefeed
      end repeat
      return output
    else
      return POSIX path of theFiles
    end if
  `;

  log('BROWSE opening Finder dialog...');
  const proc = spawn('osascript', ['-e', script]);
  let stdout = '', stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.on('close', code => {
    if (code !== 0) {
      // code -128 or "User canceled" is normal
      if (stderr.includes('User canceled') || code === 1) {
        return res.json({ canceled: true, paths: [] });
      }
      log('BROWSE error', stderr);
      return res.status(500).json({ error: 'File dialog failed', details: stderr });
    }
    const paths = stdout.trim().split('\n').map(p => p.trim()).filter(Boolean);
    log('BROWSE selected:', paths);
    res.json({ canceled: false, paths });
  });
});

// Probe a local file path — returns duration, dimensions, size
app.post('/api/probe', (req, res) => {
  const filePath = req.body.filePath;
  if (!filePath) return res.status(400).json({ error: 'No filePath provided' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  log('PROBE', filePath);
  const ff = spawnSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
  ], { encoding: 'utf8', timeout: 10000 });
  if (ff.error || ff.status !== 0) {
    return res.status(500).json({ error: 'ffprobe failed', details: (ff.stderr || '').slice(-500) });
  }
  try {
    const info = JSON.parse(ff.stdout);
    const vStream = (info.streams || []).find(s => s.codec_type === 'video');
    const duration = parseFloat((info.format || {}).duration) || 0;
    const stat = fs.statSync(filePath);
    res.json({
      duration,
      width: vStream ? parseInt(vStream.width, 10) : 0,
      height: vStream ? parseInt(vStream.height, 10) : 0,
      size: stat.size,
      filename: path.basename(filePath)
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to parse ffprobe output' });
  }
});

// Serve a local file for browser preview (video element src)
app.get('/api/localfile', (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// Crop endpoint: multipart form-data with fields: x, y, w, h, filename and file field: video
app.post('/api/crop', upload.single('video'), (req, res) => {
  const localPath = req.body.filePath;
  const uploadedPath = localPath || (req.file && req.file.path);
  const isLocal = !!localPath;
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
  const outputPath = path.join(TMP_DIR, `crop_${Date.now()}.mp4`);
  const cropFps = probeFps(uploadedPath);
  const args = [
    '-hide_banner', '-progress', 'pipe:2',
    '-i', uploadedPath,
    '-vf', `${cropExpr},fps=${cropFps}`,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-y', outputPath
  ];
  log('CROP spawning ffmpeg:', 'ffmpeg', args.join(' '));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = (pct) => res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);

  const cleanup = () => {
    if (!isLocal && uploadedPath) {
      fs.unlink(uploadedPath, () => {});
    }
  };

  // Get duration for progress
  const probe = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', uploadedPath], { encoding: 'utf8' });
  const totalDuration = parseFloat(probe.stdout) || 0;

  const ff = spawn('ffmpeg', args);
  let stderrBuf = '';
  const cropStderr = makeStderrLogger('CROP');

  ff.stderr.on('data', (d) => {
    const chunk = d.toString();
    stderrBuf += chunk;
    cropStderr(d);
    if (totalDuration > 0) {
      const match = chunk.match(/out_time_ms=(\d+)/);
      if (match) {
        const pct = Math.min(95, Math.round((parseInt(match[1]) / 1000000 / totalDuration) * 100));
        sendProgress(pct);
      }
    }
  });

  ff.on('close', (code) => {
    cleanup();
    if (code === 0 && fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      log('CROP done,', (stat.size / 1024 / 1024).toFixed(1) + 'MB');
      sendProgress(100);
      const dlId = path.basename(outputPath);
      pendingDownloads.set(dlId, { filePath: outputPath, filename: outName, cleanup: () => fs.unlink(outputPath, () => {}) });
      res.write(`data: ${JSON.stringify({ type: 'complete', downloadUrl: `/api/download/${dlId}`, filename: outName })}\n\n`);
    } else {
      log('CROP failed, code=' + code, tail(stderrBuf));
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Crop failed', details: tail(stderrBuf) })}\n\n`);
      if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
    }
    res.end();
  });

  ff.on('error', (err) => {
    cleanup();
    log('ERROR failed to start ffmpeg', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to start ffmpeg', details: err.message })}\n\n`);
    res.end();
  });
});

// Combine endpoint: multipart form-data with fields: video, audio, videoOffset, audioOffset, startTime, endTime, filename
app.post('/api/combine', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), (req, res) => {
  const videoFile = req.files && req.files.video && req.files.video[0];
  const audioFile = req.files && req.files.audio && req.files.audio[0];
  const videoLocalPath = req.body.videoFilePath;
  const audioLocalPath = req.body.audioFilePath;
  const videoPath = videoLocalPath || (videoFile && videoFile.path);
  const audioPath = audioLocalPath || (audioFile && audioFile.path);

  if (!videoPath || !audioPath) {
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
  // Always output the full video — start at frame 0, end at last frame
  const vProbe = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { encoding: 'utf8' });
  const videoDuration = parseFloat(vProbe.stdout) || duration;
  const videoStart = 0;
  const clampedDuration = videoDuration;
  // Speed up the video input (1 = no change). Audio stays at normal speed and is
  // trimmed to match the sped-up video length.
  const videoSpeed = Math.max(0.1, parseFloatSafe(req.body.videoSpeed, 1));
  const outDuration = clampedDuration / videoSpeed;
  // Audio start = where in the audio file corresponds to video frame 0
  const audioStart = Math.max(0, videoOffset - audioOffset);

  log('COMBINE start', {
    video: videoLocalPath || (videoFile && videoFile.originalname),
    audio: audioLocalPath || (audioFile && audioFile.originalname),
    videoOffset,
    audioOffset,
    startTime,
    endTime,
    duration,
    videoSpeed,
    outDuration,
    videoStart,
    audioStart
  });
  log('COMBINE video:', videoPath, '| audio:', audioPath);

  const outputPath = path.join(TMP_DIR, `combine_${Date.now()}.mp4`);
  log('COMBINE output will be:', outputPath);

  const args = [
    '-hide_banner',
    '-progress', 'pipe:2',
    '-i', videoPath,
    '-i', audioPath,
    '-filter_complex',
    `[0:v]trim=start=${videoStart}:duration=${clampedDuration},setpts=(PTS-STARTPTS)/${videoSpeed},fps=${probeFps(videoPath)}[v];` +
    `[1:a]atrim=start=${audioStart}:duration=${outDuration},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.5[a]`,
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
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
    if (!videoLocalPath && videoFile && videoFile.path) fs.unlink(videoFile.path, () => {});
    if (!audioLocalPath && audioFile && audioFile.path) fs.unlink(audioFile.path, () => {});
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
      const pct = Math.min(99, Math.round((ms / 1000 / outDuration) * 100));
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
  const concatLocalPath = req.body.filePath;
  const videoSrcPath = concatLocalPath || (videoFile && videoFile.path);

  if (!videoSrcPath) {
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
    if (!concatLocalPath && videoFile) fs.unlink(videoFile.path, () => {});
    return res.status(400).json({ error: 'No selections provided' });
  }

  const clientFilename = (req.body.filename || 'concatenated').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}.mp4`;
  const outputPath = path.join(TMP_DIR, `concat_${Date.now()}.mp4`);
  const concatListPath = path.join(TMP_DIR, `concat_list_${Date.now()}.txt`);
  const wantFaststart = req.body.faststart === '1';
  const clipPaths = [];

  log('CONCAT start', {
    video: concatLocalPath || (videoFile && videoFile.originalname),
    numSelections: selections.length,
    selections,
    outputPath
  });
  log('CONCAT video src:', videoSrcPath);

  // SSE for progress
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = (pct) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);
  };

  const rawOutputPath = outputPath + '.tmp.mp4';
  const cleanup = () => {
    log('CONCAT cleanup: removing temp files');
    if (!concatLocalPath && videoFile && videoFile.path) fs.unlink(videoFile.path, () => {});
    clipPaths.forEach(p => fs.unlink(p, () => {}));
    fs.unlink(concatListPath, () => {});
    fs.unlink(rawOutputPath, () => {});
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
        '-i', videoSrcPath,
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

    // Step 3: Concatenate clips (stream copy — no re-encode)
    const concatDest = wantFaststart ? rawOutputPath : outputPath;
    const concatArgs = [
      '-hide_banner',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-y',
      concatDest
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

    // Free disk space: delete temp clips before faststart pass
    clipPaths.forEach(p => fs.unlink(p, () => {}));
    clipPaths.length = 0;
    fs.unlink(concatListPath, () => {});

    if (wantFaststart) {
      sendProgress(75);

      // Faststart pass (moves moov atom; needs ~2x file size in free space)
      const fastArgs = [
        '-hide_banner',
        '-i', rawOutputPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y',
        outputPath
      ];

      log('CONCAT faststart pass:', fastArgs.join(' '));

      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', fastArgs);
        let stderr = '';
        const fsStderr = makeStderrLogger('CONCAT faststart');
        ff.stderr.on('data', d => { stderr += d.toString(); fsStderr(d); });
        ff.on('close', code => {
          fs.unlink(rawOutputPath, () => {});
          log('CONCAT faststart ffmpeg exited code=' + code);
          if (code === 0) resolve();
          else reject(new Error(`Faststart failed: ${tail(stderr)}`));
        });
        ff.on('error', reject);
      });
    }

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

// Shrinker endpoint: re-encode at reduced resolution
app.post('/api/shrink', upload.none(), async (req, res) => {
  const filePath = req.body.filePath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'File not found' });

  const clientFilename = (req.body.filename || 'shrunk').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}.mp4`;
  const outputPath = path.join(TMP_DIR, `shrink_${Date.now()}.mp4`);

  log('SHRINK start', { file: path.basename(filePath), outName });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = (pct) => res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);

  try {
    sendProgress(5);
    const args = [
      '-hide_banner', '-progress', 'pipe:2',
      '-i', filePath,
      '-vf', `scale=1920:-2:flags=lanczos,fps=${probeFps(filePath)}`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outputPath
    ];

    log('SHRINK ffmpeg:', args.join(' '));

    // Get duration for progress
    const probe = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8' });
    const totalDuration = parseFloat(probe.stdout) || 0;

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      let stderr = '';
      const shrinkStderr = makeStderrLogger('SHRINK');
      ff.stderr.on('data', d => {
        const chunk = d.toString();
        stderr += chunk;
        shrinkStderr(d);
        if (totalDuration > 0) {
          const match = chunk.match(/out_time_ms=(\d+)/);
          if (match) {
            const pct = Math.min(95, Math.round((parseInt(match[1]) / 1000000 / totalDuration) * 100));
            sendProgress(pct);
          }
        }
      });
      ff.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(tail(stderr)));
      });
      ff.on('error', reject);
    });

    sendProgress(100);
    const stat = fs.statSync(outputPath);
    log('SHRINK done,', (stat.size / 1024 / 1024).toFixed(1) + 'MB');
    const dlId = path.basename(outputPath);
    pendingDownloads.set(dlId, { filePath: outputPath, filename: outName, cleanup: () => fs.unlink(outputPath, () => {}) });
    res.write(`data: ${JSON.stringify({ type: 'complete', downloadUrl: `/api/download/${dlId}`, filename: outName })}\n\n`);
    res.end();
  } catch (err) {
    log('SHRINK failed', err.message);
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Shrink failed', details: err.message })}\n\n`);
    res.end();
  }
});

// Flip endpoint: fields filePath, hflip ('1'/'0'), vflip ('1'/'0'), filename
app.post('/api/flip', upload.none(), async (req, res) => {
  const filePath = req.body.filePath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'File not found' });

  const hflip = req.body.hflip === '1';
  const vflip = req.body.vflip === '1';
  if (!hflip && !vflip) return res.status(400).json({ error: 'Select at least one flip direction' });

  const filters = [];
  if (hflip) filters.push('hflip');
  if (vflip) filters.push('vflip');
  filters.push(`fps=${probeFps(filePath)}`);

  const clientFilename = (req.body.filename || 'flipped').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}.mp4`;
  const outputPath = path.join(TMP_DIR, `flip_${Date.now()}.mp4`);

  log('FLIP start', { file: path.basename(filePath), filters, outName });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = (pct) => res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);

  try {
    sendProgress(5);
    const args = [
      '-hide_banner', '-progress', 'pipe:2',
      '-i', filePath,
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y', outputPath
    ];

    log('FLIP ffmpeg:', args.join(' '));

    const probe = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8' });
    const totalDuration = parseFloat(probe.stdout) || 0;

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      let stderr = '';
      const flipStderr = makeStderrLogger('FLIP');
      ff.stderr.on('data', d => {
        const chunk = d.toString();
        stderr += chunk;
        flipStderr(d);
        if (totalDuration > 0) {
          const match = chunk.match(/out_time_ms=(\d+)/);
          if (match) {
            const pct = Math.min(95, Math.round((parseInt(match[1]) / 1000000 / totalDuration) * 100));
            sendProgress(pct);
          }
        }
      });
      ff.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(tail(stderr)));
      });
      ff.on('error', reject);
    });

    sendProgress(100);
    const stat = fs.statSync(outputPath);
    log('FLIP done,', (stat.size / 1024 / 1024).toFixed(1) + 'MB');
    const dlId = path.basename(outputPath);
    pendingDownloads.set(dlId, { filePath: outputPath, filename: outName, cleanup: () => fs.unlink(outputPath, () => {}) });
    res.write(`data: ${JSON.stringify({ type: 'complete', downloadUrl: `/api/download/${dlId}`, filename: outName })}\n\n`);
    res.end();
  } catch (err) {
    log('FLIP failed', err.message);
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Flip failed', details: err.message })}\n\n`);
    res.end();
  }
});

// Image padder: decode first frame to raw RGB, find the most common color on the
// 1px perimeter — that's the fill color for padding
function sampleImageEdge(filePath) {
  const pr = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath], { encoding: 'utf8', timeout: 10000 });
  const [w, h] = ((pr.stdout || '').trim().split('\n')[0] || '').split(',').map(Number);
  if (!w || !h) return null;
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-v', 'quiet', '-i', filePath,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 512 * 1024 * 1024, timeout: 30000 });
  const buf = ff.stdout;
  if (!buf || buf.length < w * h * 3) return null;
  const counts = new Map();
  const add = (x, y) => {
    const i = (y * w + x) * 3;
    const c = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
    counts.set(c, (counts.get(c) || 0) + 1);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  let bestCount = 0, bestColor = 0xffffff;
  for (const [c, n] of counts) if (n > bestCount) { bestCount = n; bestColor = c; }
  return {
    width: w,
    height: h,
    color: '#' + bestColor.toString(16).padStart(6, '0'),
    edgeCoverage: bestCount / (2 * w + 2 * h)
  };
}

// Probe an image: dims, size, sampled edge color
app.post('/api/pad-info', (req, res) => {
  const filePath = req.body.filePath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  log('PAD-INFO', filePath);
  const info = sampleImageEdge(filePath);
  if (!info) return res.status(500).json({ error: 'Could not decode image' });
  const stat = fs.statSync(filePath);
  log('PAD-INFO', `${info.width}x${info.height}`, 'edge', info.color,
    `(${Math.round(info.edgeCoverage * 100)}% of perimeter)`);
  res.json({ ...info, size: stat.size, filename: path.basename(filePath) });
});

// Pad endpoint: fields filePath, pct (100-500), color (#rrggbb), filename
app.post('/api/pad', upload.none(), (req, res) => {
  const filePath = req.body.filePath;
  if (!filePath || !fs.existsSync(filePath)) return res.status(400).json({ error: 'File not found' });

  const pct = Math.min(500, Math.max(100, parseFloat(req.body.pct) || 100));
  let color = String(req.body.color || '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    const sampled = sampleImageEdge(filePath);
    color = sampled ? sampled.color : '#ffffff';
  }

  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const outExt = ext === 'jpeg' ? 'jpg' : (ext || 'png');
  const clientFilename = (req.body.filename || 'padded').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.toLowerCase().endsWith('.' + outExt) ? clientFilename : `${clientFilename}.${outExt}`;
  const outputPath = path.join(TMP_DIR, `pad_${Date.now()}.${outExt}`);

  const factor = pct / 100;
  const forceSquare = req.body.forceSquare === '1';
  const pr = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', filePath], { encoding: 'utf8', timeout: 10000 });
  const [srcW, srcH] = ((pr.stdout || '').trim().split('\n')[0] || '').split(',').map(Number);
  if (!srcW || !srcH) return res.status(500).json({ error: 'Could not probe image dimensions' });
  let outW = Math.ceil(srcW * factor);
  let outH = Math.ceil(srcH * factor);
  if (forceSquare) outW = outH = Math.max(outW, outH);
  const padExpr = `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:color=${color.replace('#', '0x')}`;

  let args;
  if (outExt === 'gif') {
    // Re-generate the palette so the fill color stays exact across all frames
    args = ['-hide_banner', '-i', filePath,
      '-filter_complex', `${padExpr},split[s0][s1];[s0]palettegen=reserve_transparent=0[p];[s1][p]paletteuse`,
      '-y', outputPath];
  } else {
    args = ['-hide_banner', '-i', filePath, '-vf', padExpr, '-frames:v', '1', '-update', '1'];
    if (outExt === 'jpg') args.push('-q:v', '2');
    args.push('-y', outputPath);
  }

  log('PAD start', { file: path.basename(filePath), pct, color, forceSquare, out: `${outW}x${outH}`, outName });
  log('PAD ffmpeg:', args.join(' '));

  const ff = spawn('ffmpeg', args);
  let stderr = '';
  ff.stderr.on('data', d => { stderr += d.toString(); });
  ff.on('close', code => {
    if (code === 0 && fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      log('PAD done,', (stat.size / 1024).toFixed(0) + 'KB');
      const dlId = path.basename(outputPath);
      pendingDownloads.set(dlId, { filePath: outputPath, filename: outName, cleanup: () => fs.unlink(outputPath, () => {}) });
      res.json({ downloadUrl: `/api/download/${dlId}`, filename: outName });
    } else {
      log('PAD failed code=' + code, tail(stderr));
      if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
      res.status(500).json({ error: 'Pad failed', details: tail(stderr) });
    }
  });
  ff.on('error', err => {
    log('ERROR failed to start ffmpeg pad', err.message);
    res.status(500).json({ error: 'Failed to start ffmpeg', details: err.message });
  });
});

// Butt-joiner endpoint: joins multiple local file paths together in order
app.post('/api/join', async (req, res) => {
  let filePaths;
  try {
    filePaths = JSON.parse(req.body.filePaths || '[]');
  } catch (e) {
    return res.status(400).json({ error: 'Invalid filePaths JSON' });
  }
  if (!filePaths.length) return res.status(400).json({ error: 'No files provided' });

  for (const p of filePaths) {
    if (!fs.existsSync(p)) return res.status(400).json({ error: `File not found: ${p}` });
  }

  const clientFilename = (req.body.filename || 'joined').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}.mp4`;
  const outputPath = path.join(TMP_DIR, `join_${Date.now()}.mp4`);
  const listPath = path.join(TMP_DIR, `join_list_${Date.now()}.txt`);
  const wantFaststart = req.body.faststart === '1';

  log('JOIN start', { files: filePaths.map(p => path.basename(p)), outName, faststart: wantFaststart });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendProgress = (pct) => res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);

  const cleanedTemp = [];
  try {
    // Pre-clean clips whose edit lists hide packets (e.g. QuickTime trims keep
    // pre-roll/trailing frames flagged discard). The concat demuxer ignores edit
    // lists, so those hidden frames flash at the joins — re-encode such clips
    // first, which drops them.
    const hasHiddenPackets = (p) => {
      const ff = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', p], { encoding: 'utf8' });
      return (ff.stdout || '').trim().split('\n').some(line => {
        const [pts, flags] = line.split(',');
        return (flags || '').includes('D') || parseFloat(pts) < 0;
      });
    };
    const srcPaths = [];
    for (let i = 0; i < filePaths.length; i++) {
      const p = filePaths[i];
      if (!hasHiddenPackets(p)) { srcPaths.push(p); continue; }
      const cleanPath = path.join(TMP_DIR, `join_clean_${Date.now()}_${i}.mp4`);
      log(`JOIN ${path.basename(p)} has hidden edit-list packets — re-encoding clean copy`);
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', ['-hide_banner', '-i', p,
          '-vf', `fps=${probeFps(p)}`,
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
          '-c:a', 'aac', '-b:a', '192k', '-y', cleanPath]);
        let stderr = '';
        const cleanStderr = makeStderrLogger(`JOIN clean${i + 1}`);
        ff.stderr.on('data', d => { stderr += d.toString(); cleanStderr(d); });
        ff.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`Clean re-encode failed: ${tail(stderr)}`));
        });
        ff.on('error', reject);
      });
      cleanedTemp.push(cleanPath);
      srcPaths.push(cleanPath);
      sendProgress(Math.round(((i + 1) / filePaths.length) * 40));
    }

    // Probe fps of each file
    const fpsValues = srcPaths.map(p => {
      const ff = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
        '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', p], { encoding: 'utf8' });
      const raw = (ff.stdout || '').trim(); // e.g. "30000/1001" or "30/1"
      if (!raw) return null;
      const [num, den] = raw.split('/').map(Number);
      return den ? num / den : num;
    });
    const allMatch = fpsValues.every(f => f !== null && Math.abs(f - fpsValues[0]) < 0.01);
    log('JOIN fps values:', fpsValues.map(f => f ? f.toFixed(3) : 'unknown').join(', '),
        allMatch ? '→ stream copy' : '→ re-encode to 30fps');

    // Drop the last 2 frames of every clip except the final one — kills flash
    // frames at the joins. concat's outpoint filters on DTS, and B-frame reorder
    // shifts DTS earlier than PTS, so probe the tail packets and cut at the min
    // DTS of the 2 highest-PTS frames.
    const tailOutpoint = (p) => {
      const dur = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', p], { encoding: 'utf8' });
      const d = parseFloat((dur.stdout || '').trim());
      if (!Number.isFinite(d)) return null;
      const tailStart = Math.max(0, d - 1);
      const pk = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time,dts_time', '-of', 'csv=p=0',
        '-read_intervals', `${tailStart}%`, p], { encoding: 'utf8' });
      const packets = (pk.stdout || '').trim().split('\n')
        .map(line => line.split(',').map(Number))
        .filter(([pts, dts]) => Number.isFinite(pts) && Number.isFinite(dts));
      if (packets.length < 3) return null;
      packets.sort((a, b) => a[0] - b[0]);
      const last2 = packets.slice(-2);
      const cut = Math.min(last2[0][1], last2[1][1]);
      return cut > 0 ? cut : null;
    };
    const listLines = srcPaths.map((p, i) => {
      if (i === srcPaths.length - 1) return `file '${p}'`;
      const cut = tailOutpoint(p);
      if (cut === null) {
        log(`JOIN could not probe tail of ${path.basename(p)} — joining untrimmed`);
        return `file '${p}'`;
      }
      log(`JOIN trimming last 2 frames of ${path.basename(p)}: outpoint=${cut.toFixed(6)}`);
      return `file '${p}'\noutpoint ${cut.toFixed(6)}`;
    });

    fs.writeFileSync(listPath, listLines.join('\n'));
    sendProgress(10);

    const encodeArgs = allMatch
      ? ['-c', 'copy']
      : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-r', '30', '-c:a', 'aac', '-b:a', '192k'];

    const rawOutputPath = outputPath + '.tmp.mp4';
    const concatDest = wantFaststart ? rawOutputPath : outputPath;
    const args = [
      '-hide_banner', '-f', 'concat', '-safe', '0',
      '-i', listPath,
      ...encodeArgs,
      '-y', concatDest
    ];

    log('JOIN ffmpeg:', args.join(' '));

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      let stderr = '';
      const joinStderr = makeStderrLogger('JOIN');
      ff.stderr.on('data', d => { stderr += d.toString(); joinStderr(d); });
      ff.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(tail(stderr)));
      });
      ff.on('error', reject);
    });

    fs.unlink(listPath, () => {});
    cleanedTemp.forEach(p => fs.unlink(p, () => {}));
    cleanedTemp.length = 0;

    if (wantFaststart) {
      sendProgress(80);

      const fastArgs = ['-hide_banner', '-i', rawOutputPath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath];
      log('JOIN faststart pass:', fastArgs.join(' '));

      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', fastArgs);
        let stderr = '';
        const fsStderr = makeStderrLogger('JOIN faststart');
        ff.stderr.on('data', d => { stderr += d.toString(); fsStderr(d); });
        ff.on('close', code => {
          fs.unlink(rawOutputPath, () => {});
          if (code === 0) resolve();
          else reject(new Error(`Faststart failed: ${tail(stderr)}`));
        });
        ff.on('error', reject);
      });
    }

    sendProgress(100);
    const stat = fs.statSync(outputPath);
    log('JOIN done,', (stat.size / 1024 / 1024).toFixed(1) + 'MB');
    const dlId = path.basename(outputPath);
    pendingDownloads.set(dlId, { filePath: outputPath, filename: outName, cleanup: () => fs.unlink(outputPath, () => {}) });
    res.write(`data: ${JSON.stringify({ type: 'complete', downloadUrl: `/api/download/${dlId}`, filename: outName })}\n\n`);
    res.end();
  } catch (err) {
    log('JOIN failed', err.message);
    fs.unlink(listPath, () => {});
    cleanedTemp.forEach(p => fs.unlink(p, () => {}));
    if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
    const rawPath = outputPath + '.tmp.mp4';
    if (fs.existsSync(rawPath)) fs.unlink(rawPath, () => {});
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Join failed', details: err.message })}\n\n`);
    res.end();
  }
});

// Speedup endpoint: multipart form-data with fields: video, speedFactor, lockFps, filename
app.post('/api/speedup', upload.single('video'), async (req, res) => {
  const videoFile = req.file;
  const speedLocalPath = req.body.filePath;
  const speedSrcPath = speedLocalPath || (videoFile && videoFile.path);
  if (!speedSrcPath) return res.status(400).json({ error: 'No video uploaded' });

  const speedFactor = parseFloat(req.body.speedFactor) || 1.0;
  const lockFps = req.body.lockFps === 'true';
  const duration = parseFloat(req.body.duration) || 0;
  const clientFilename = (req.body.filename || 'sped_up').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}.mp4`;
  const outputPath = path.join(TMP_DIR, `speedup_${Date.now()}.mp4`);

  log('SPEEDUP start', { video: speedLocalPath || (videoFile && videoFile.originalname), speedFactor, lockFps, duration });
  log('SPEEDUP video src:', speedSrcPath, '| output:', outputPath);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const sendProgress = (pct) => res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);

  const useSeekMethod = speedFactor >= 4;
  const speedCleanup = () => {
    if (!speedLocalPath && videoFile && videoFile.path) fs.unlink(videoFile.path, () => {});
  };

  if (useSeekMethod) {
    // FAST PATH: For high speed factors, extract individual frames by seeking to each timestamp.
    // -ss before -i uses demuxer-level seeking (jumps to nearest keyframe) — near-instant per frame.
    // Then stitch the frames into a video.
    const interval = speedFactor / 30;  // seconds between frames in source (200x → 6.67s)
    const totalFrames = Math.ceil(duration / interval);
    const framesDir = path.join(TMP_DIR, `frames_${Date.now()}`);
    fs.mkdirSync(framesDir, { recursive: true });

    log('SPEEDUP seek method: extracting', totalFrames, 'frames, one every', interval.toFixed(2), 'sec');

    // Extract frames in parallel batches
    const batchSize = 16;
    let extracted = 0, failed = 0, processed = 0;
    for (let i = 0; i < totalFrames; i += batchSize) {
      const batch = [];
      for (let j = i; j < Math.min(i + batchSize, totalFrames); j++) {
        // Clamp seek just inside EOF so the final frames still decode
        const ts = Math.min(j * interval, Math.max(0, duration - 0.05));
        const framePath = path.join(framesDir, `frame_${String(j).padStart(6, '0')}.jpg`);
        batch.push(new Promise((resolve) => {
          const ff = spawn('ffmpeg', [
            '-hide_banner', '-ss', String(ts), '-i', speedSrcPath,
            '-frames:v', '1', '-q:v', '1', '-y', framePath
          ]);
          // Tolerate undecodable frames (e.g. at/near EOF) — skip rather than fail the whole render
          ff.on('close', code => { if (code === 0 && fs.existsSync(framePath)) extracted++; else failed++; resolve(); });
          ff.on('error', () => { failed++; resolve(); });
        }));
      }
      await Promise.all(batch);
      processed += batch.length;
      const pct = Math.min(90, Math.round((processed / totalFrames) * 90));
      log(`SPEEDUP extracting frames: ${processed}/${totalFrames} (${pct}%)`);
      sendProgress(pct);
    }

    if (failed > 0) log(`SPEEDUP skipped ${failed} undecodable frame(s)`);
    if (extracted === 0) {
      fs.rm(framesDir, { recursive: true, force: true }, () => {});
      log('SPEEDUP no frames extracted');
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'No frames could be extracted' })}\n\n`);
      speedCleanup();
      return res.end();
    }
    log('SPEEDUP extracted', extracted, 'frames, now encoding to video...');

    // Stitch frames into video at 30fps. Glob so skipped frames don't break the sequence.
    const stitchArgs = [
      '-hide_banner', '-framerate', '30',
      '-pattern_type', 'glob', '-i', path.join(framesDir, 'frame_*.jpg'),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-an', '-y', outputPath
    ];

    log('SPEEDUP stitching:', stitchArgs.join(' '));
    const stitchFf = spawn('ffmpeg', stitchArgs);
    let stitchStderr = '';
    stitchFf.stderr.on('data', d => { stitchStderr += d.toString(); });

    stitchFf.on('close', (code) => {
      // Clean up frame images
      fs.rm(framesDir, { recursive: true, force: true }, () => {});

      if (code === 0 && fs.existsSync(outputPath)) {
        sendProgress(100);
        const stat = fs.statSync(outputPath);
        log('SPEEDUP done,', (stat.size / 1024 / 1024).toFixed(1) + 'MB');
        const dlId = path.basename(outputPath);
        pendingDownloads.set(dlId, { filePath: outputPath, filename: outName, cleanup: () => { speedCleanup(); fs.unlink(outputPath, () => {}); } });
        res.write(`data: ${JSON.stringify({ type: 'complete', downloadUrl: `/api/download/${dlId}`, filename: outName })}\n\n`);
      } else {
        log('SPEEDUP stitch failed:', tail(stitchStderr));
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Stitch failed', details: tail(stitchStderr) })}\n\n`);
        speedCleanup();
        if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
      }
      res.end();
    });

  } else {
    // NORMAL PATH: For low speed factors (<4x), use setpts filter.
    // Always force CFR: without an fps filter, VFR source timestamps pass
    // through and QuickTime plays stretches in slow motion.
    let videoFilter = `setpts=${1/speedFactor}*PTS`;
    videoFilter += lockFps ? ',fps=30' : `,fps=${probeFps(speedSrcPath)}`;

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

    log('SPEEDUP videoFilter:', videoFilter, '| audioFilter:', audioFilter || '(none, -an)');

    const args = [
      '-hide_banner', '-progress', 'pipe:2',
      '-i', speedSrcPath,
      '-vf', videoFilter,
    ];
    if (!audioFilter) args.push('-an');
    else { args.push('-af', audioFilter, '-c:a', 'aac', '-b:a', '192k'); }
    args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-movflags', '+faststart', '-y', outputPath);

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
        const inputTimeMs = (ms / 1000) * speedFactor;
        const pct = Math.min(99, Math.round((inputTimeMs / duration) * 100));
        sendProgress(pct);
      }
    });

    ff.on('close', (code) => {
      log('SPEEDUP ffmpeg exited code=' + code);
      if (code === 0 && fs.existsSync(outputPath)) {
        sendProgress(100);
        const stat = fs.statSync(outputPath);
        log('SPEEDUP done,', (stat.size / 1024 / 1024).toFixed(1) + 'MB');
        const dlId = path.basename(outputPath);
        pendingDownloads.set(dlId, { filePath: outputPath, filename: outName, cleanup: () => { speedCleanup(); fs.unlink(outputPath, () => {}); } });
        res.write(`data: ${JSON.stringify({ type: 'complete', downloadUrl: `/api/download/${dlId}`, filename: outName })}\n\n`);
      } else {
        log('SPEEDUP failed, stderrTail=', tail(stderrBuf));
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'ffmpeg failed', details: tail(stderrBuf) })}\n\n`);
        speedCleanup();
        if (fs.existsSync(outputPath)) fs.unlink(outputPath, () => {});
      }
      res.end();
    });
  }
});

// Timelapse endpoint: multipart form-data with fields: top, bottom, topFactors, bottomFactors, duration, filename
app.post('/api/timelapse', upload.fields([{ name: 'top' }, { name: 'bottom' }]), async (req, res) => {
  let topFiles = req.files && req.files.top;
  let bottomFiles = req.files && req.files.bottom;

  log('TIMELAPSE body keys:', Object.keys(req.body || {}));

  // Support local path arrays (new preferred path)
  try {
    const topPaths = req.body.topFilePaths ? JSON.parse(req.body.topFilePaths) : null;
    const bottomPaths = req.body.bottomFilePaths ? JSON.parse(req.body.bottomFilePaths) : null;
    log('TIMELAPSE parsed paths:', { topPaths, bottomPaths });
    if (topPaths && !topFiles) topFiles = topPaths.map(p => ({ path: p, originalname: path.basename(p), size: 0 }));
    if (bottomPaths && !bottomFiles) bottomFiles = bottomPaths.map(p => ({ path: p, originalname: path.basename(p), size: 0 }));
  } catch (e) { log('TIMELAPSE path parse error:', e.message); }

  // Legacy single-path support
  const topLocalPath = req.body.topFilePath;
  const bottomLocalPath = req.body.bottomFilePath;
  if (topLocalPath && !topFiles) topFiles = [{ path: topLocalPath, originalname: path.basename(topLocalPath), size: 0 }];
  if (bottomLocalPath && !bottomFiles) bottomFiles = [{ path: bottomLocalPath, originalname: path.basename(bottomLocalPath), size: 0 }];

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

  const hasAudioStream = (filePath) => {
    const pr = spawnSync('ffprobe', ['-v', 'quiet', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath], { encoding: 'utf8' });
    return (pr.stdout || '').trim().length > 0;
  };

  const processPane = async (files, factors, name) => {
    const spedUpClips = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const factor = factors[i];
      const clipPath = path.join(TMP_DIR, `${name}_clip_${i}_${Date.now()}.mp4`);

      // Build atempo audio filter chain for this factor
      let audioFilter = '';
      let tempFactor = factor;
      while (tempFactor > 2.0) { audioFilter += (audioFilter ? ',' : '') + 'atempo=2.0'; tempFactor /= 2.0; }
      while (tempFactor < 0.5) { audioFilter += (audioFilter ? ',' : '') + 'atempo=0.5'; tempFactor /= 0.5; }
      if (tempFactor !== 1.0) audioFilter += (audioFilter ? ',' : '') + `atempo=${tempFactor}`;

      const srcHasAudio = hasAudioStream(file.path);

      if (factor >= 4) {
        // FAST PATH: seek to each timestamp and extract one frame, then stitch
        const fileDuration = await new Promise((resolve) => {
          const probe = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file.path], { encoding: 'utf8' });
          resolve(parseFloat(probe.stdout) || 0);
        });
        const interval = factor / 30;
        const totalFrames = Math.ceil(fileDuration / interval);
        const framesDir = path.join(TMP_DIR, `${name}_frames_${i}_${Date.now()}`);
        fs.mkdirSync(framesDir, { recursive: true });
        sendLog(`${name}[${i}]: extracting ${totalFrames} frames (seek method, 1 every ${interval.toFixed(1)}s)`);

        const batchSize = 16;
        let extracted = 0, failed = 0, processed = 0;
        const startMs = Date.now();
        for (let fi = 0; fi < totalFrames; fi += batchSize) {
          const batch = [];
          for (let fj = fi; fj < Math.min(fi + batchSize, totalFrames); fj++) {
            // Clamp seek just inside EOF so the final frames still decode
            const ts = Math.min(fj * interval, Math.max(0, fileDuration - 0.05));
            const framePath = path.join(framesDir, `frame_${String(fj).padStart(6, '0')}.png`);
            batch.push(new Promise((resolve) => {
              const ff = spawn('ffmpeg', [
                '-hide_banner', '-ss', String(ts), '-i', file.path,
                '-frames:v', '1', '-compression_level', '1', '-y', framePath
              ]);
              // Tolerate a frame that can't be decoded (e.g. at/near EOF) — skip it rather than failing the whole render
              ff.on('close', code => { if (code === 0 && fs.existsSync(framePath)) extracted++; else failed++; resolve(); });
              ff.on('error', () => { failed++; resolve(); });
            }));
          }
          await Promise.all(batch);
          processed += batch.length;
          const elapsed = (Date.now() - startMs) / 1000;
          const rate = elapsed > 0 ? (processed / elapsed).toFixed(1) : '0.0';
          const pct = Math.round((processed / totalFrames) * 100);
          const progressLine = `TIMELAPSE ${name}[${i}]: frame=${processed}/${totalFrames} (${pct}%) ${rate} fps`;
          log(progressLine);   // -> stdout + global log panel
          sendLog(progressLine);  // -> timelapse tool's in-page progress
        }
        if (failed > 0) sendLog(`${name}[${i}]: skipped ${failed} undecodable frame(s), kept ${extracted}`);
        if (extracted === 0) throw new Error(`${name}[${i}]: no frames could be extracted`);

        // Stitch frames into clip, carrying audio (sped with atempo) when the source has it.
        // Glob the files so gaps (skipped frames) don't break the sequence.
        const stitchArgs = [
          '-hide_banner', '-framerate', '30',
          '-pattern_type', 'glob', '-i', path.join(framesDir, 'frame_*.png'),
          '-i', file.path,
          '-map', '0:v:0',
        ];
        if (srcHasAudio) {
          if (audioFilter) {
            stitchArgs.push('-filter_complex', `[1:a]${audioFilter}[a]`, '-map', '[a]', '-c:a', 'aac', '-b:a', '192k');
          } else {
            stitchArgs.push('-map', '1:a?', '-c:a', 'copy');
          }
        }
        stitchArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', '-y', clipPath);
        await runFfmpeg(stitchArgs, 0, 0);

        fs.rm(framesDir, { recursive: true, force: true }, () => {});
      } else {
        // NORMAL PATH: setpts filter for low speed factors
        const ffArgs = [
          '-hide_banner', '-i', file.path,
          '-vf', `setpts=1/${factor}*PTS,fps=30`,
        ];
        if (srcHasAudio) {
          if (audioFilter) ffArgs.push('-af', audioFilter, '-c:a', 'aac', '-b:a', '192k');
          else ffArgs.push('-c:a', 'copy');
        }
        ffArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p', '-y', clipPath);
        await runFfmpeg(ffArgs, 0, 0);
      }
      
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

    // Keep audio in the outputs: use whichever pane has an audio stream
    // (top preferred, else bottom). If neither has audio, no audio map.
    const topHasAudio = hasAudioStream(topPanePath);
    const bottomHasAudio = hasAudioStream(bottomPanePath);
    const audioMap = topHasAudio ? ['-map', '0:a?'] : (bottomHasAudio ? ['-map', '1:a?'] : []);
    const audioCodec = audioMap.length ? ['-c:a', 'aac', '-b:a', '192k'] : [];

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
      [0:v]fps=30,scale=${sqTopScaleW}:-2:flags=lanczos,crop=${baseWidth}:${halfHeight}:${sqTX}:${sqTY}[v1];
      [1:v]fps=30,scale=${sqBotScaleW}:-2:flags=lanczos,crop=${baseWidth}:${halfHeight}:${sqBX}:${sqBY}[v2];
      [v1][v2]vstack=inputs=2
    `.replace(/\s+/g, '');
    
    await runFfmpeg([
      '-hide_banner', '-progress', 'pipe:2',
      '-i', topPanePath, '-i', bottomPanePath,
      '-filter_complex', liFilter,
      ...audioMap,
      '-r', '30', '-c:v', 'libx264', '-crf', '10', '-preset', 'slow', '-pix_fmt', 'yuv420p',
      '-profile:v', 'high', '-level', '4.2',
      ...audioCodec,
      '-movflags', '+faststart', '-y', liPath
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
      [0:v]fps=30,scale=-2:${reelsTopScaleH}:flags=lanczos,crop=${baseWidth}:${reelsHalfHeight}:${rTX}:${rTY}[v1];
      [1:v]fps=30,scale=-2:${reelsBotScaleH}:flags=lanczos,crop=${baseWidth}:${reelsHalfHeight}:${rBX}:${rBY}[v2];
      [v1][v2]vstack=inputs=2
    `.replace(/\s+/g, '');

    await runFfmpeg([
      '-hide_banner', '-progress', 'pipe:2',
      '-i', topPanePath, '-i', bottomPanePath,
      '-filter_complex', reelsFilter,
      ...audioMap,
      '-r', '30', '-c:v', 'libx264', '-crf', '10', '-preset', 'slow', '-pix_fmt', 'yuv420p',
      '-profile:v', 'high', '-level', '4.2',
      ...audioCodec,
      '-movflags', '+faststart', '-y', reelsPath
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

// ========== FAST-CUT MUSIC VIDDER ==========
const VIDDER_CACHE = path.join(TMP_DIR, 'vidder_cache');
if (!fs.existsSync(VIDDER_CACHE)) fs.mkdirSync(VIDDER_CACHE, { recursive: true });

function runCapture(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr = tail(stderr + d.toString(), 2000); });
    p.on('close', code => resolve({ code, stdout, stderr }));
    p.on('error', err => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

// Display dimensions (rotation-aware) + duration for one clip
async function vidderProbe(filePath) {
  const r = await runCapture('ffprobe', ['-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', filePath]);
  if (r.code !== 0) return null;
  try {
    const info = JSON.parse(r.stdout);
    const v = (info.streams || []).find(s => s.codec_type === 'video');
    if (!v) return null;
    const rotTag = v.tags && v.tags.rotate;
    const rotSide = (v.side_data_list || []).find(sd => sd.rotation !== undefined);
    const rot = Math.abs(Number(rotSide ? rotSide.rotation : rotTag) || 0) % 180;
    let width = parseInt(v.width, 10), height = parseInt(v.height, 10);
    if (rot === 90) [width, height] = [height, width];
    const duration = parseFloat((info.format || {}).duration) || parseFloat(v.duration) || 0;
    if (!duration || !width || !height) return null;
    return { path: filePath, name: path.basename(filePath), duration, width, height };
  } catch (_) { return null; }
}

// Probe a list of clip paths (input order kept); unreadable ones come back in `missing`
app.post('/api/vidder/probe', async (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths.map(String) : [];
  const results = new Array(paths.length);
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const i = next++;
      results[i] = fs.existsSync(paths[i]) ? await vidderProbe(paths[i]) : null;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const missing = paths.filter((_, i) => !results[i]);
  log('VIDDER probe', `${paths.length - missing.length}/${paths.length} readable`);
  res.json({ clips: results.filter(Boolean), missing });
});

// Save an order file via the native Save dialog
app.post('/api/vidder/save', (req, res) => {
  const data = req.body.data;
  if (!data || typeof data !== 'object') return res.status(400).json({ error: 'No data' });
  const asStr = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const name = String(req.body.defaultName || 'vidder_order.json');
  const dir = req.body.defaultDir && fs.existsSync(req.body.defaultDir) ? req.body.defaultDir : null;
  const script = `POSIX path of (choose file name with prompt "Save clip order" default name ${asStr(name)}` +
    (dir ? ` default location (POSIX file ${asStr(dir)})` : '') + ')';
  const proc = spawn('osascript', ['-e', script]);
  let stdout = '', stderr = '';
  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });
  proc.on('close', code => {
    if (code !== 0) {
      if (stderr.includes('User canceled') || code === 1) return res.json({ canceled: true });
      log('VIDDER save dialog error', stderr);
      return res.status(500).json({ error: 'Save dialog failed', details: stderr });
    }
    let out = stdout.trim();
    if (!/\.json$/i.test(out)) out += '.json';
    try {
      fs.writeFileSync(out, JSON.stringify(data, null, 2));
    } catch (err) {
      return res.status(500).json({ error: 'Write failed: ' + err.message });
    }
    log('VIDDER saved order', out);
    res.json({ canceled: false, path: out });
  });
});

// Read an order file
app.post('/api/vidder/read', (req, res) => {
  const filePath = req.body.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  try {
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (_) {
    res.status(400).json({ error: 'Not a valid order file' });
  }
});

function vidderCachePath(filePath, extra, ext) {
  const stat = fs.statSync(filePath);
  const key = crypto.createHash('sha1').update(`${filePath}|${stat.mtimeMs}|${stat.size}|${extra}`).digest('hex');
  return path.join(VIDDER_CACHE, key + ext);
}

// Filmstrip of n keyframe thumbs, h px tall, tiled horizontally
app.get('/api/vidder/strip', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const n = Math.min(80, Math.max(1, parseInt(req.query.n, 10) || 10));
  const h = Math.min(120, Math.max(16, parseInt(req.query.h, 10) || 56));
  const d = parseFloat(req.query.d) || 0;
  if (!(d > 0)) return res.status(400).send('Missing duration');
  const out = vidderCachePath(filePath, `strip|${n}|${h}`, '.jpg');
  if (!fs.existsSync(out)) {
    // Keyframes only (fast), cloned past the last keyframe so fps can always fill n slots
    const r = await runCapture('ffmpeg', ['-hide_banner', '-v', 'error', '-skip_frame', 'nokey',
      '-i', filePath,
      '-vf', `scale=-2:${h},tpad=stop_mode=clone:stop_duration=${d.toFixed(3)},fps=${(n / d).toFixed(6)},tile=${n}x1`,
      '-frames:v', '1', '-q:v', '5', '-y', out]);
    if (r.code !== 0 || !fs.existsSync(out)) {
      log('VIDDER strip failed', path.basename(filePath), r.stderr);
      return res.status(500).send('Strip failed');
    }
  }
  res.sendFile(out);
});

// Waveform PNG (white on transparent; the client tints it via CSS mask)
app.get('/api/vidder/wave', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Not found');
  const out = vidderCachePath(filePath, 'wave', '.png');
  if (!fs.existsSync(out)) {
    const r = await runCapture('ffmpeg', ['-hide_banner', '-v', 'error', '-i', filePath,
      '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=2000x120:colors=white:scale=sqrt',
      '-frames:v', '1', '-y', out]);
    if (r.code !== 0 || !fs.existsSync(out)) {
      log('VIDDER wave failed', path.basename(filePath), r.stderr);
      return res.status(500).send('Waveform failed');
    }
  }
  res.sendFile(out);
});

// Render: JSON { clips: [{path, start, dur}], clipDur (default when a clip has no dur), music: {path, start} | null, filename }
// Each slice is encoded to an identical 2160x3840 30fps segment (clip audio dropped),
// then segments are stream-copied together and the music window is muxed on top.
app.post('/api/vidder/render', async (req, res) => {
  const clips = Array.isArray(req.body.clips) ? req.body.clips : [];
  if (!clips.length) return res.status(400).json({ error: 'No clips provided' });
  for (const c of clips) {
    if (!c || !c.path || !fs.existsSync(c.path)) return res.status(400).json({ error: `File not found: ${c && c.path}` });
  }
  const music = req.body.music && req.body.music.path ? req.body.music : null;
  if (music && !fs.existsSync(music.path)) return res.status(400).json({ error: `Music not found: ${music.path}` });

  const OUT_W = 2160, OUT_H = 3840, FPS = 30;
  const clipDur = Math.min(600, Math.max(0.1, parseFloat(req.body.clipDur) || 2));
  // Each clip's slice as a whole number of frames
  const segFrames = clips.map(c => Math.max(1, Math.round(Math.min(600, parseFloat(c.dur) || clipDur) * FPS)));
  const segDurs = segFrames.map(f => f / FPS);
  const total = segDurs.reduce((a, b) => a + b, 0);
  const musicStart = music ? Math.max(0, parseFloat(music.start) || 0) : 0;

  const clientFilename = (req.body.filename || 'vidder').replace(/[^A-Za-z0-9_.-]/g, '_');
  const outName = clientFilename.endsWith('.mp4') ? clientFilename : `${clientFilename}.mp4`;
  const stamp = Date.now();
  const workDir = path.join(TMP_DIR, `vidder_${stamp}`);
  const outputPath = path.join(TMP_DIR, `vidder_${stamp}.mp4`);
  fs.mkdirSync(workDir, { recursive: true });

  log('VIDDER render start', { clips: clips.length, segDurs, total, music: music && path.basename(music.path), musicStart });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const sendProgress = (pct) => res.write(`data: ${JSON.stringify({ type: 'progress', percent: pct })}\n\n`);

  const procs = new Set();
  let finished = false;
  let aborted = false;
  res.on('close', () => {
    if (finished) return;
    aborted = true;
    log('VIDDER client disconnected, killing ffmpeg');
    procs.forEach(p => { try { p.kill('SIGKILL'); } catch (_) {} });
  });

  const run = (args, label) => new Promise((resolve, reject) => {
    if (aborted) return reject(new Error('Aborted'));
    const ff = spawn('ffmpeg', args);
    procs.add(ff);
    let stderr = '';
    const logger = makeStderrLogger(label);
    ff.stderr.on('data', d => { stderr = tail(stderr + d.toString(), 2000); logger(d); });
    ff.on('close', code => {
      procs.delete(ff);
      if (code === 0) resolve();
      else reject(new Error(aborted ? 'Aborted' : `${label} failed: ${tail(stderr)}`));
    });
    ff.on('error', err => { procs.delete(ff); reject(err); });
  });

  const segPaths = clips.map((_, i) => path.join(workDir, `seg_${String(i).padStart(4, '0')}.mp4`));
  try {
    // Fill/crop to 9:16, force CFR, pad short clips by holding the last frame,
    // and cap at an exact frame count so every cut lands on the frame grid
    const vfFor = (segDur) => [
      `fps=${FPS}`,
      `scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${OUT_W}:${OUT_H}`,
      'setsar=1',
      `tpad=stop_mode=clone:stop_duration=${segDur.toFixed(3)}`,
      'format=yuv420p',
    ].join(',');

    let done = 0, nextIdx = 0, segErr = null;
    const worker = async () => {
      while (nextIdx < clips.length && !segErr) {
        const i = nextIdx++;
        const start = Math.max(0, parseFloat(clips[i].start) || 0);
        try {
          await run(['-hide_banner', '-ss', start.toFixed(3), '-t', (segDurs[i] + 1).toFixed(3),
            '-i', clips[i].path, '-vf', vfFor(segDurs[i]), '-frames:v', String(segFrames[i]), '-an',
            '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',
            '-profile:v', 'high', '-level', '5.1', '-pix_fmt', 'yuv420p',
            '-y', segPaths[i]], `VIDDER seg${i + 1}`);
        } catch (err) {
          // First failure wins; stop the other worker too
          if (!segErr) segErr = new Error(`${path.basename(clips[i].path)}: ${err.message}`);
          procs.forEach(p => { try { p.kill('SIGKILL'); } catch (_) {} });
          return;
        }
        done++;
        sendProgress(Math.round((done / clips.length) * 90));
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, clips.length) }, worker));
    if (segErr) throw segErr;

    const listPath = path.join(workDir, 'list.txt');
    fs.writeFileSync(listPath, segPaths.map(p => `file '${p}'`).join('\n'));

    const muxArgs = ['-hide_banner', '-f', 'concat', '-safe', '0', '-i', listPath];
    if (music) {
      // 1s fade in and out (halved on very short cuts so they don't overlap)
      const fadeDur = Math.min(1, total / 2);
      muxArgs.push('-ss', musicStart.toFixed(3), '-t', total.toFixed(3), '-i', music.path,
        '-map', '0:v', '-map', '1:a:0', '-c:v', 'copy',
        '-af', `afade=t=in:st=0:d=${fadeDur.toFixed(3)},afade=t=out:st=${(total - fadeDur).toFixed(3)}:d=${fadeDur.toFixed(3)}`,
        '-c:a', 'aac', '-b:a', '256k');
    } else {
      muxArgs.push('-map', '0:v', '-c:v', 'copy', '-an');
    }
    muxArgs.push('-movflags', '+faststart', '-y', outputPath);
    log('VIDDER mux:', muxArgs.join(' '));
    await run(muxArgs, 'VIDDER mux');

    fs.rm(workDir, { recursive: true, force: true }, () => {});
    finished = true;
    sendProgress(100);
    const stat = fs.statSync(outputPath);
    log('VIDDER done,', (stat.size / 1024 / 1024).toFixed(1) + 'MB');
    const dlId = path.basename(outputPath);
    pendingDownloads.set(dlId, { filePath: outputPath, filename: outName, cleanup: () => fs.unlink(outputPath, () => {}) });
    res.write(`data: ${JSON.stringify({ type: 'complete', downloadUrl: `/api/download/${dlId}`, filename: outName })}\n\n`);
    res.end();
  } catch (err) {
    finished = true;
    log('VIDDER failed', err.message);
    aborted = true;
    procs.forEach(p => { try { p.kill('SIGKILL'); } catch (_) {} });
    fs.rm(workDir, { recursive: true, force: true }, () => {});
    fs.unlink(outputPath, () => {});
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Render failed', details: err.message })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  log(`[cropper] listening on http://localhost:${PORT}`, 'tmp=', TMP_DIR, 'log=', LOG_FILE);
});

function tail(s, max = 500) {
  if (!s) return '';
  return s.length <= max ? s : s.slice(-max);
}


