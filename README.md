# Local FFmpeg Tools

Some localhost ffmpeg-mediated video editing tools, gentle optima type, might be something for your agent to scaffold atop. –Evan

Runs as a browser UI backed by a small local Node server. Files are read in place by path, so nothing is uploaded and 10GB+ files are fine.

## Requirements

- macOS (uses Finder dialogs via `osascript`)
- Node.js 16+
- ffmpeg: `brew install ffmpeg`
- Chrome recommended (Text Effects uses its local font access)

## Run

```bash
git clone https://github.com/evanapplegate/Local_ffmpeg_cropper.git
cd Local_ffmpeg_cropper
npm install
npm start
```

Open http://localhost:3000. Or double-click `start.command` (`chmod +x start.command` first).

## Tools

- **Image Padder**: pads a JPG/PNG/GIF with its own edge color, optionally to a square.
- **Video Cropper**: drag a crop box (Free, 1:1, 9:16, 16:9) and export.
- **Video-Audio Combiner**: sync a separate audio track to a video on a timeline and merge.
- **Video Clip Concatenator**: mark segments of one video and join them in order.
- **Clip Butt-Joiner**: join multiple clips; lossless when frame rates match, else re-encodes to 30fps.
- **Video Speeder-Upper**: speed a video up or down; fast even on long files. Batch mode included.
- **Reel/LinkedIn Timelapser**: stack top/bottom clip sets into Square and Reels timelapses with draggable crops.
- **Video Shrinker**: re-encode to 1920px wide for smaller files.
- **Video Flipper**: flip horizontally and/or vertically.
- **Fast-Cut Music Vidder**: add clips (multi-select, appends), drag each row's box to pick a slice and its edges to set its length, reorder rows, slide a frame along the music waveform, preview the whole cut, and render a 2160×3840 30fps MP4 with the music as the only audio. Save/Load Order keeps a project as JSON.
- **Text Effects**: draggable, scalable text boxes with real installed font faces (no faked bold/italic), alignment, line height, tracking, opacity and blend modes matching the preview. "Next N sec fill" fills the letters with the video N seconds ahead. Exports at source resolution with original audio.

## Tips

- The Server Log panel at the bottom streams ffmpeg progress.
- Exports download automatically when done.
- Light/Dark toggle is in the header; ⟳ Kill & Restart resets the server.

## License

MIT
