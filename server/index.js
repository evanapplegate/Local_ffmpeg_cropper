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

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
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

  log('CROP', {
    file: { name: req.file && req.file.originalname, size: req.file && req.file.size },
    rect: { x, y, w, h },
  });

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
  log('FFMPEG cropExpr', cropExpr);

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
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
      wroteVideo = true;
    }
    res.write(chunk);
  });
  ff.stderr.on('data', (d) => {
    stderrBuf += d.toString();
  });

  ff.on('close', (code) => {
    cleanup();
    log('FFMPEG close', String(code), 'wroteVideo=', String(wroteVideo), 'stderrTail=', tail(stderrBuf));
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

app.listen(PORT, () => {
  log(`[cropper] listening on http://localhost:${PORT}`, 'tmp=', TMP_DIR, 'log=', LOG_FILE);
});

function tail(s, max = 500) {
  if (!s) return '';
  return s.length <= max ? s : s.slice(-max);
}


