# raw-tracks-tools

A suite of CLI scripts for processing video/audio recordings made in "raw-tracks" mode on [Daily](https://daily.co).

This recording type saves video and audio streams from a WebRTC session in individual files. The streams are recorded without any transcoding or processing, and they may start at different times. Samples received over the WebRTC connection may vary greatly: they may come in with delays, they may include varying resolutions within a single track (if a participant is sending multiple quality layers), and some packets may have been lost so there can be gaps. This kind of raw media data is incompatible with most video editing programs that expect a media track to have a stable sampling rate and a fixed resolution. Editing and compositing these raw-tracks files therefore requires normalizing the raw data into an editing-compatible format, and audio/video synchronization also requires aligning their start times. The normalize tool included here will do both operations.

You can find more information about creating these recordings in [Daily's documentation for raw-tracks](https://docs.daily.co/guides/products/live-streaming-recording/recording-calls-with-the-daily-api#raw-tracks).

This repo includes tools for:

- Analyzing and converting individual participant tracks;
- Aligning audio and video tracks so they are in sync;
- Compositing all the participant tracks from a recording into a single MP4 file.

Compositing is done with Daily's open source [VCS](https://github.com/daily-co/daily-vcs) engine.
To control the output video's layout and overlay graphics, you can pass in composition params that work
the same way as with Daily's realtime cloud recording and streaming. See below for more details.

## Installation

Basic requirements:

- Node.js 18+
- ffmpeg in path

Run once in the repo root:

`npm install`

### Installation: compositing only

For compositing, you also need VCS:

- Clone the VCS SDK repo: https://github.com/daily-co/daily-vcs

In the VCS SDK repo, perform the following install operations once:

- Install the base SDK:
  `cd js; yarn install`

- Build the VCSRender tool:
  `cd server-render/vcsrender`

  First, initialize submodules (run once from the VCS SDK repo root):
  `git submodule init && git submodule update`

  Then build:
  `meson setup build; ninja -C build`

Note that these tools have their individual dependencies:

- The base SDK needs just the `yarn` JavaScript package manager.
- VCSRender is a C++ program. At minimum it requires the Meson build tool.
  There are also some additional small dependencies on macOS.
  Before building VCSRender, please first check out `server-render/vcsrender/README.md` (in the VCS SDK repo).

## Compositing

There are two compositing tools. The recommended approach is `composite-from-events`, which uses an event JSON file produced by the recording system. A legacy tool `composite-from-manifest` is available as a fallback for recordings that don't have an event JSON.

### composite-from-events (recommended)

This is the primary compositing tool. It uses an event JSON file that the raw-tracks recording system produces alongside the webm media files. The event JSON contains authoritative metadata about participants, track timing, pause/resume events, display names, and chat messages. This enables:

- Accurate participant display names in the grid layout
- Precise pause/resume handling (no slow frame scanning required)
- Dynamic grid management (participants appear/disappear with smooth animations)
- Chat message toasts overlaid on the video
- Paused video placeholder graphics
- Faster processing (lightweight stream probe instead of full frame analysis)

**Enabling event JSON in recordings:** When starting a raw-tracks recording via the Daily API, enable the event JSON output in your recording configuration. This is the recommended setup for all new raw-tracks recordings.

**Required VCS SDK version:** This tool requires a VCS SDK version newer than 2026-03-19, which includes support for layout animations, standard source messages, and video layer opacity.

**Basic usage:**

```
npm run composite-from-events -- \
  -i $PATH_TO_EVENT_JSON \
  --vcs-sdk-path $PATH_TO_VCS_SDK
```

**Rendering a time window** (e.g. first 20 minutes):

```
npm run composite-from-events -- \
  -i $PATH_TO_EVENT_JSON \
  --vcs-sdk-path $PATH_TO_VCS_SDK \
  --start 0 --duration 1200
```

**All options:**

| Option | Description | Default |
|--------|-------------|---------|
| `-i` | Path to event JSON file | (required) |
| `--vcs-sdk-path` | Path to VCS SDK repo root | (required) |
| `--vcsrender-path` | Override vcsrender directory | `$vcs-sdk-path/server-render/vcsrender` |
| `--start` | Render window start offset (seconds) | `0` |
| `--duration` | Render window length (seconds) | full session |
| `-o` | Output file path | next to event JSON |
| `--fps` | Output frame rate | `30` |
| `-w` | Output width | `1280` |
| `-h` | Output height | `720` |
| `-p` | Composition params JSON file | grid mode with labels |

**Features:**

- Progress reporting during normalization and rendering with ETA
- Storage usage monitoring during rendering
- Hardware-accelerated encoding (VideoToolbox on macOS)
- Normalized track caching across runs (different `--start`/`--duration` reuse the same cache)
- Support for gapless transcoded audio (WAV/AAC files skip normalization)

### composite-from-manifest (legacy)

This is the original compositing tool. Use it when you don't have an event JSON file for the recording. It works from a manifest JSON generated by the `gen-manifest` tool.

Compared to `composite-from-events`, this tool:

- Does not support display names (uses participant UUIDs)
- Does not support pause/resume placeholder graphics
- Does not support chat message overlays or layout animations
- Requires a slow full-frame analysis of each track
- Does not support `--start`/`--duration` windowed rendering

```
npm run composite-from-manifest -- \
  --vcs-sdk-path $PATH_TO_VCS_SDK \
  -i $INPUT_PATH_TO_RAW_TRACKS_MANIFEST_FILE
```

You must pass in a raw-tracks manifest. This is a JSON file that describes which tracks belong to the same recording timeline.

If you have raw-tracks files without a manifest, you can generate one using the `gen-manifest` tool described below.

In the above CLI example, `$PATH_TO_VCS_SDK` should point to the VCS SDK repo root (see install instructions above).

By default, the tool tries to locate the VCSRender binary using the SDK path you pass in on the CLI, as follows:
`$PATH_TO_VCS_SDK/server-render/vcsrender/build/vcsrender`

You can also override the VCSRender program's location using the `--vcsrender-path` CLI argument.

### Specifying the output location

By default, both compositing tools write an mp4 in the same location as the input file (event JSON or manifest).

You can override this using the `-o` argument:

```
    -o /var/foo/example_output.mp4
```

### Specifying the output size and rate

The default output size for rendering the composite is 1280x720.

You can override this using the `-w` and `-h` arguments:

```
    -w 1920 -h 1080
```

The default output frame rate is 30. You can override with `--fps`.

### Specifying layout and graphics options using composition params

The VCS render engine supports a wealth of composition options. They are the same as available for cloud recordings on Daily.

You can find them listed on Daily's documentation site for recording/streaming: [composition_params](https://docs.daily.co/reference/rest-api/rooms/recordings/start#composition-params)

The default layout mode is `grid`. You can find the other default param values behind the above link.

You can specify a custom `composition_params` object by providing it as a JSON file using the `--params` argument (or its shorthand `-p`):

```
    --params my_composition_params.json
```

## Individual track tools

### analyze-track

Prints a JSON describing a track from a raw-tracks recording, e.g. its data format and any gaps detected.

```
npm run analyze-track -- -i example-cam-video.webm
```

### normalize-track

Takes one or two webm files from raw-tracks recordings and processes them into a normalized format:

- Pauses in the video track are rendered as black
- Small drops in frame rate are padded with repeated frames (so that fps is even across the file)
- Any low-resolution samples within the video track are upscaled to the maximum resolution detected
- Video track's color space is converted to BT.709 standard if required
- Audio and video tracks are padded so they start at the same time

If you pass both a video and an audio file, a combined MPEG-4 file is written.

Example usage:

```
npm run normalize-track -- -i example-cam-video.webm -i example-cam-audio.webm
```

You can also provide an output path using the -o option.

By default, audio tracks are re-encoded to AAC. Pass `--audio-codec wav` to emit a mono 48 kHz PCM WAV instead. (MP4 muxing is only performed when an AAC track is produced, since MP4 does not accept PCM audio.)

### gen-manifest

Generates a raw-tracks manifest file by inspecting filenames in a directory containing raw-tracks recordings made on Daily. This is used with the legacy `composite-from-manifest` tool.

If an event JSON file is present in the directory, `gen-manifest` will suggest using `composite-from-events` instead.

```
npm run gen-manifest -- -i $PATH_TO_RAW_TRACKS_DIR
```
