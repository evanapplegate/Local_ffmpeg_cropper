# Local FFmpeg Tools

Browser frontend for simple ffmpeg operations: crop, concatenate, timelapse, and make vertical- and square-cropped two-stack videos. Uses a small Node.js server to run ffmpeg and serve the browser UI.

## Requirements

- **macOS** — uses native Finder dialogs via `osascript` (OSX only)
- **Node.js 16+** — [nodejs.org](https://nodejs.org)
- **ffmpeg** — install via Homebrew:

```bash
brew install ffmpeg
```

Verify both are installed:
```bash
node -v
ffmpeg -version
```

## Setup

```bash
git clone https://github.com/evanapplegate/Local_ffmpeg_cropper.git
cd Local_ffmpeg_cropper
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

> **Tip:** Double-click `start.command` to launch without a terminal (make it executable first: `chmod +x start.command`).

---

## Tools

### Video Cropper
Browse an MP4 or MOV, drag the crop box, choose an aspect ratio (Free / 1:1 / 9:16 / 16:9), and export.

### Video-Audio Combiner
Browse a video file and a separate audio file (MOV, MP4, MP3, WAV, M4A). Drag the blocks on the timeline to sync them up, select an output range, and export a merged MP4.

### Video Clip Concatenator
Browse a video, then drag on the timeline to mark one or more segments. Export them joined together in order.

### Clip Butt-Joiner
Browse multiple clips (you can select several at once in Finder), reorder them with the ↑/↓ buttons, and join into one file. Uses lossless stream copy when all clips have matching frame rates; otherwise re-encodes to 30fps automatically.

### Video Speeder-Upper
Browse a video, enter a speed multiplier (e.g. `4` for 4x, `0.5` for half speed), and export. Uses parallel seek-based frame extraction so even 70-minute files process in under 2 minutes.

### Reel/LinkedIn Timelapser
Browse a set of "top" videos and a set of "bottom" videos. Set per-clip speed factors, then preview the stacked layout in Square (1:1 for LinkedIn) and Reels (9:16) mockups. Drag within each pane to reposition the crop, scroll wheel zooms in and out. Export both formats at once. Optional 4K (2160px wide) output.

### Fast-Cut Music Vidder
Click **Add Vids** and shift-click to pick several clips; click again to append more. Each loads as a row with a filmstrip. Set the clip duration (default 2s), then drag the box on each row to pick that clip's slice. The preview scrubs while you drag and loops the slice on release. Reorder by dragging rows or with the ↑/↓ buttons. Add music (MP4/M4A) and slide its frame along the waveform to pick the section; tick marks show where the cuts land, and **Play Sequence** previews the whole cut against the music. "Vert vids only" sets aside square and landscape clips. **Save Order** / **Load Order** write and read a JSON file with the clip order, each clip's slice, the music and its position, clip duration, and the vert-only setting. **Render** outputs a 2160×3840, 30fps MP4. Clip audio is dropped, so the music is the only soundtrack, and non-vertical clips are center-cropped to fill the frame.

---

## Tips

- The **Server Log** panel at the bottom shows live ffmpeg output so you can see progress.
- Use the **Light/Dark mode** toggle in the header.
- All files are accessed by path — works great with large files (10GB+) since nothing is uploaded.
- Exports download automatically when done.

## License

MIT
