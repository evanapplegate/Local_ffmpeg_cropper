# Local FFmpeg Cropper

Drag & drop MP4s, crop visually with optional aspect locks (free, 1:1, 9:16 portrait), export to a cropped MP4. Runs ffmpeg locally via a Node server.

## Prerequisites
- Node.js 16+
- ffmpeg available on PATH (`ffmpeg -version`)

macOS (Homebrew):
```bash
brew install ffmpeg
```

## Install & Run
```bash
npm install
npm run dev
# open http://localhost:3000
```

## Usage
1. Drop one or more MP4 files onto the drop zone (or click to select).
2. Adjust the crop rectangle; optionally choose an aspect lock.
3. Click Export — the server runs ffmpeg and downloads the result.

## Notes
- Video: H.264 (`libx264`), `-crf 20`, `-preset veryfast`, audio copied.
- Output is streamed; no file persists on the server.
- Crop width/height are even to satisfy H.264 requirements.

## License
MIT

