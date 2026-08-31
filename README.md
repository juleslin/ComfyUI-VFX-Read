# ComfyUI VFX Read

A Nuke-inspired local Read node for ComfyUI. Loads one exact still,
image-sequence, or movie frame from a path on disk — no upload step, no
copying files into ComfyUI's own `input` folder (unless you paste an image
from the clipboard, which does go through ComfyUI's normal upload path).

## Features

- **Stills, image sequences, and movies** from a single `source_path` —
  automatically detected from the filename (`plate.1001.exr` style, 3+
  digit padding) or file extension (`.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`,
  `.m4v`, `.gif`).
- **File browser** ("Choose source") with folder navigation, back/forward
  history, and automatic sequence grouping.
- **Version picker** — detects `v01`/`v02`-style version tokens (2-digit
  padding or less) anywhere in the filename, or in the parent folder's name
  for sequences split across per-version folders, and lets you switch
  between sibling versions.
- **Scrub bar + transport controls** (play, previous/next frame, loop,
  fullscreen) that work the same way for both image sequences and movies.
  Scrubbing/playback only moves a preview "playhead" — nothing is
  committed to the actual `frame` output until you click **Use Frame**.
- **Fullscreen review** with the real Fullscreen API, wheel-zoom, and
  drag-to-pan for stills/sequences; the video path reparents the real
  `<video>` element into the same fullscreen overlay.
- **Paste an image from the clipboard**: select the node, `Ctrl+V` — it
  uploads through ComfyUI's own image-upload endpoint (same one
  `LoadImage` uses) and loads it as the source.
- **Embedded generation metadata**: if the loaded file was saved by
  ComfyUI's own `SaveImage`/`SaveVideo`/`SaveWEBM` (or by this pack's own
  `Write` node, once it embeds metadata), a best-effort `seed` and
  `prompt` are read back out from whichever node fed directly into the
  save node — see `embedded_seed`/`embedded_prompt` below.
- Custom `first`/`last` range, `before_range`/`after_range` hold-or-error
  policy, and a `missing_frames` hold-or-error policy for gaps in a
  sequence.

## Outputs

| Output | Type | Description |
|---|---|---|
| `image` | IMAGE | The single requested frame. |
| `sequence` | IMAGE | The full active-range batch (for a movie, the same single frame as `image`). |
| `sequence_folder` | STRING | The source file's parent folder. |
| `video` | VIDEO | Populated for movie sources when ComfyUI's `VideoFromFile` is available; `None` otherwise. |
| `width` / `height` | INT | Resolved from the actual frame. |
| `embedded_seed` | INT | Best-effort, `-1` if not found. |
| `embedded_prompt` | STRING | Best-effort, empty string if not found. |

## Installation

From the ComfyUI root:

```bat
call venv\Scripts\activate.bat
python -m pip install -r custom_nodes\ComfyUI-VFX-Read\requirements.txt
```

Restart ComfyUI. Add **Read** from the **VFX / IO** category.

## Notes

- Uses full local filesystem paths — type one in directly, or use the
  folder-icon browse button.
- Movie decoding uses [PyAV](https://pyav.org/) (already a dependency of
  ComfyUI core itself, since core's own "Load Video" node uses it too) —
  no `ffmpeg`/`ffprobe` executables are spawned.
