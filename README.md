# raw-tracks-tools

Scripts to process raw-tracks recordings made on [Daily](https://daily.co).

## Installation

Requires:

- Node.js 18+
- ffmpeg in path

No other dependencies. Npm install is not needed.

## normalize-track.js

Takes one or two webm files from raw-tracks recordings and processes them into a normalized format:

- Pauses in the video track are rendered as black
- Small drops in frame rate are padded with repeated frames (so that fps is even across the file)
- Any low-resolution samples within the video track are upscaled to the maximum resolution detected
- Audio and video tracks are padded so they start at the same time

If you pass both a video and an audio file, a combined MPEG-4 file is written.

Example usage:

```
node normalize-track.js -i example-cam-video.webm -i example-cam-audio.webm
```

You can also provide an output path using the -o option.

## analyze-track.js

Prints a JSON describing a track from a raw-tracks recording.

```
node analyze-track.js -i example-cam-video.webm
```
