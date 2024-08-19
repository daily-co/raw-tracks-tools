# raw-tracks-tools

Scripts to process raw-tracks recordings made on Daily.

## Installation

Requires:
  * Node.js 18+
  * ffmpeg in path

No other dependencies. Npm install is not needed.

## normalize.js

Takes one or two webm files from raw-tracks recordings and processes them into a normalized format:

  * Pauses in the video track are rendered as black
  * Small drops in frame rate are padded with repeated frames (so that fps is even across the file)
  * Any low-resolution samples within the video track are upscaled to the maximum resolution detected
  * Audio and video tracks are padded so they start at the same time

If you pass both a video and an audio file, a combined MPEG-4 file is written.

Example usage:

```
node normalize.js -i example-cam-video.webm -i example-cam-audio.webm
```

You can also provide an output path using the -o option.

## analyze.js

Prints a JSON describing a raw-tracks recording.

```
node analyze.js -i example-cam-video.webm
```
