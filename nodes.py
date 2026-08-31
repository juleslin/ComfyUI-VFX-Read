import io
import json
import re
from pathlib import Path

import av
import imageio.v3 as iio
import numpy as np
import torch
from PIL import Image

# ---------------------------------------------------------------------------
# VideoFromFile import
# ---------------------------------------------------------------------------
# ComfyUI moves this class between releases. Confirmed location on
# ComfyUI 0.31.0 (in-tree, not pip-installed):
#     comfy_api\latest\_input_impl\video_types.py  -> class VideoFromFile
#
# Candidates are tried shortest/most-public first. The failure reason is
# recorded instead of being silently swallowed, so a broken import produces a
# clear error at the Read node rather than a NoneType crash several nodes
# downstream.
VideoFromFile = None
_VIDEO_IMPORT_ERROR = None
_VIDEO_IMPORT_PATH = None

_VIDEO_IMPORT_CANDIDATES = (
    ("comfy_api.input_impl.video_types", "VideoFromFile"),
    ("comfy_api.latest._input_impl.video_types", "VideoFromFile"),
    ("comfy_api.input_impl", "VideoFromFile"),
    ("comfy_api.latest._input_impl", "VideoFromFile"),
)

_video_import_attempts = []

for _module_name, _class_name in _VIDEO_IMPORT_CANDIDATES:
    try:
        _module = __import__(_module_name, fromlist=[_class_name])
        VideoFromFile = getattr(_module, _class_name)
        _VIDEO_IMPORT_PATH = f"{_module_name}.{_class_name}"
        break
    except Exception as _error:
        _video_import_attempts.append(f"  {_module_name}: {_error}")

if VideoFromFile is None:
    _VIDEO_IMPORT_ERROR = (
        "VFXRead could not import VideoFromFile. The 'video' output will "
        "not work until this is fixed.\n"
        "Attempted:\n" + "\n".join(_video_import_attempts) + "\n"
        "Locate the class with:\n"
        '  findstr /s /n /c:"class VideoFromFile" '
        '"<your ComfyUI install>\\comfy_api\\*.py"'
    )
    print(f"[VFXRead] WARNING: {_VIDEO_IMPORT_ERROR}")
else:
    print(f"[VFXRead] VideoFromFile imported from {_VIDEO_IMPORT_PATH}")


MOVIE_EXTENSIONS = {
    ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".gif"
}

FRAME_PATTERN = re.compile(r"^(.*?)(\d+)(\.[^.]+)$")


def _resolve_source(value):
    source = Path(value.strip().strip('"')).expanduser()

    if not source.is_file():
        raise ValueError(
            "Source file was not found:\n"
            f"{source}\n\n"
            "Use a full Windows path."
        )

    return source


def _is_movie(path):
    return Path(path).suffix.lower() in MOVIE_EXTENSIONS


def _movie_info(path):
    # PyAV links FFmpeg's libraries directly into this already-running
    # Python process instead of spawning ffprobe.exe as a separate
    # executable (the previous implementation). Confirmed live: a fresh,
    # large (200MB+) executable gets real-time-scanned by Windows Defender
    # on its first launch per process, which was the actual cause of a
    # ~65s one-time lag switching to a movie source — not fixable in
    # Python and not something to rely on an AV exclusion for on a
    # colleague's machine we don't control. PyAV is already a hard
    # dependency of ComfyUI core's own "Load Video" node, which uses this
    # exact approach (comfy_api/latest/_input_impl/video_types.py).
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]

            width = stream.width
            height = stream.height

            rate = stream.average_rate or stream.guessed_rate
            fps = float(rate) if rate else 0.0

            frame_count = stream.frames or 0

            if frame_count <= 0:
                duration = None
                if stream.duration and stream.time_base:
                    duration = float(stream.duration * stream.time_base)
                elif container.duration:
                    duration = float(container.duration / av.time_base)

                if duration and fps > 0:
                    frame_count = max(1, round(duration * fps))
                else:
                    frame_count = 1
    except Exception as error:
        raise RuntimeError(
            f"Could not read movie info:\n{path}\n\n{error}"
        ) from error

    return {
        "width": width,
        "height": height,
        "first": 1,
        "last": frame_count,
        "fps": fps,
    }


def _sequence_info(path):
    # Movies are never image sequences. Without this guard a filename like
    # "gettyimages-81856236-640_adpp.mp4" matches FRAME_PATTERN on its
    # trailing digits and gets treated as a sequence, which produced a flood
    # of "No earlier source frame exists to hold for missing frame N" errors
    # from the thumbnail route.
    if _is_movie(path):
        return None

    match = FRAME_PATTERN.match(path.name)

    if not match:
        return None

    prefix, digits, suffix = match.groups()
    padding = len(digits)

    # A 2-digit trailing number is a version token (v01, v02, ... — this
    # project's own Write node writes exactly that convention), not a
    # frame number. Real frame sequences use 3+ digit padding (001/0001,
    # matching Write's own frame_start default of 1001). Without this
    # guard, a folder holding shot_v01.jpg..shot_v11.jpg from 11 separate
    # Write runs got misread as one 11-frame sequence — so typing the
    # literal path to v10 still resolved and read back v11 (whatever the
    # frame widget's range happened to clamp to), never the file actually
    # named on disk. Confirmed live: this was the exact reported bug.
    #
    # An upper bound too: real frame numbers essentially never exceed 7-8
    # digits (a 24fps shot would need to run for over a century to reach
    # 9). The paste-from-clipboard feature names uploads
    # "pasted_<Date.now()>.png" — a 13-digit millisecond timestamp — so
    # two pastes made moments apart share the exact (prefix, padding,
    # suffix) shape this matches by. Confirmed live as a real bug this
    # cutoff alone fixes (independent of and more fundamental than the
    # force_still flag inspect_source already has for this same feature —
    # this one also covers the thumbnail/full-image routes, which resolve
    # frames through this function directly and were NOT covered by
    # force_still): a second paste got its thumbnail silently resolved to
    # an unrelated, much larger file that happened to be "frame 1" of the
    # bogus timestamp-shaped "sequence".
    if padding < 3 or padding > 8:
        return None

    matcher = re.compile(
        "^"
        + re.escape(prefix)
        + r"(\d{"
        + str(padding)
        + r"})"
        + re.escape(suffix)
        + "$"
    )

    frames = {}

    for candidate in path.parent.iterdir():
        if not candidate.is_file():
            continue

        found = matcher.match(candidate.name)

        if found:
            frames[int(found.group(1))] = candidate

    if len(frames) < 2:
        return None

    first = min(frames)
    last = max(frames)

    return {
        "prefix": prefix,
        "suffix": suffix,
        "padding": padding,
        "frames": frames,
        "first": first,
        "last": last,
        "pattern": f"{prefix}%0{padding}d{suffix}",
    }


# Anchors version detection to a literal "v"/"V" immediately followed by
# 1-2 digits (v01, v9, V12...) not immediately followed by a further digit
# — searched for ANYWHERE in a name, not just trailing the extension.
# Confirmed live: a real naming convention embeds the version in the
# MIDDLE of the filename with a genuine frame number still trailing it
# (e.g. "..._v01.0001.jpg") — the old trailing-digit-only check only ever
# looked at "0001" (padding 4, read as a frame number) and never saw "v01"
# at all. Anchoring to the literal "v" is also a deliberate tightening: the
# old check treated ANY short trailing number as a version (e.g. a plain
# "shot01.jpg" with no "v"), which this project's own naming convention
# never actually relies on. Picking the RIGHTMOST match handles the rarer
# case of an earlier "v" elsewhere in the name.
_VERSION_TOKEN = re.compile(r"[vV](\d{1,2})(?!\d)")


def _find_version_token(name):
    matches = list(_VERSION_TOKEN.finditer(name))
    return matches[-1] if matches else None


def _version_info(path):
    """Finds a version token (see _find_version_token) anywhere in the
    filename and scans the same folder for siblings matching the exact
    same shape — same prefix and suffix, same digit padding — differing
    only in that token's digits. Everything else in the name (including
    any real trailing frame number) is a fixed, must-match part of the
    shape, so e.g. "..._v01.0001.jpg" only matches other "..._vNN.0001.jpg"
    siblings, not a differently-numbered frame of the same version."""
    match = _find_version_token(path.name)

    if not match:
        return None

    digits = match.group(1)
    padding = len(digits)
    start, end = match.span(1)

    prefix = path.name[:start]
    suffix = path.name[end:]

    matcher = re.compile(
        "^"
        + re.escape(prefix)
        + r"(\d{"
        + str(padding)
        + r"})"
        + re.escape(suffix)
        + "$"
    )

    versions = {}

    for candidate in path.parent.iterdir():
        if not candidate.is_file():
            continue

        found = matcher.match(candidate.name)

        if found:
            versions[int(found.group(1))] = candidate

    if not versions:
        return None

    return {
        "prefix": prefix,
        "suffix": suffix,
        "padding": padding,
        "versions": versions,
    }


def _sequence_folder_versions(path):
    """For a file that's part of a detected image sequence (_sequence_info)
    living inside its OWN per-version folder — e.g.
    ".../shot_010_comp_v13/shot_010_comp_v13.0001.jpg" — every
    file-level sibling shares the same version, so _version_info finds
    nothing to compare against. The version lives in the FOLDER name
    instead: finds a version token there, requires the file's own name to
    repeat that exact same token (confirming this convention actually
    applies), then looks in the folder's PARENT for sibling folders of the
    identical shape with a different version number — and for each one,
    the equivalent frame file (same filename, version token swapped)."""
    folder = path.parent
    folder_match = _find_version_token(folder.name)

    if not folder_match:
        return {}

    digits = folder_match.group(1)
    padding = len(digits)
    fstart, fend = folder_match.span(1)
    folder_prefix = folder.name[:fstart]
    folder_suffix = folder.name[fend:]

    file_match = _find_version_token(path.name)

    if not file_match or file_match.group(1) != digits:
        return {}

    nstart, nend = file_match.span(1)
    file_prefix = path.name[:nstart]
    file_suffix = path.name[nend:]

    folder_matcher = re.compile(
        "^"
        + re.escape(folder_prefix)
        + r"(\d{"
        + str(padding)
        + r"})"
        + re.escape(folder_suffix)
        + "$"
    )

    versions = {}

    for candidate in folder.parent.iterdir():
        if not candidate.is_dir():
            continue

        found = folder_matcher.match(candidate.name)

        if not found:
            continue

        candidate_file = candidate / f"{file_prefix}{found.group(1)}{file_suffix}"

        if candidate_file.is_file():
            versions[int(found.group(1))] = candidate_file

    return versions


def _to_comfy_image(array):
    if array.ndim == 2:
        array = np.stack([array, array, array], axis=-1)

    if array.ndim == 3 and array.shape[-1] == 4:
        array = array[..., :3]

    if array.ndim != 3 or array.shape[-1] < 3:
        raise ValueError(f"Unsupported image shape: {array.shape}")

    array = array[..., :3]

    if np.issubdtype(array.dtype, np.integer):
        maximum = np.iinfo(array.dtype).max
        array = array.astype(np.float32) / maximum
    else:
        array = array.astype(np.float32)

    return torch.from_numpy(
        np.ascontiguousarray(array)
    ).unsqueeze(0)


def _read_image(path):
    try:
        image = iio.imread(path)
        return _to_comfy_image(image)
    except Exception as error:
        raise RuntimeError(
            f"Could not read image:\n{path}\n\n{error}"
        ) from error


def _read_movie_frame(path, frame_number):
    # Seek to the nearest keyframe at/before the target presentation time,
    # then decode forward to the first frame at/after it — the same
    # seek-then-decode approach ffmpeg's own -ss + frame-select uses
    # internally. Browser/HTML <video> seeking is separately known to be
    # approximate to the nearest keyframe rather than frame-exact; the
    # frontend's "Select current frame" action exists precisely so a
    # scrubbed preview position is only committed to the `frame` input
    # explicitly, rather than assumed to already be exact.
    frame_number = max(1, int(frame_number))

    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]

            rate = stream.average_rate or stream.guessed_rate
            fps = float(rate) if rate else 24.0
            target_time = (frame_number - 1) / fps if fps > 0 else 0.0

            try:
                target_pts = int(target_time / stream.time_base)
                container.seek(
                    target_pts, stream=stream, backward=True, any_frame=False
                )
            except av.AVError:
                container.seek(0)

            chosen = None
            tolerance = (0.5 / fps) if fps > 0 else 0.0

            for frame in container.decode(stream):
                if frame.time is None:
                    continue
                chosen = frame
                if frame.time >= target_time - tolerance:
                    break

            if chosen is None:
                raise RuntimeError("no decodable frame found")

            array = chosen.to_ndarray(format="rgb24")
    except Exception as error:
        raise RuntimeError(
            f"Could not decode movie frame {frame_number}:\n{path}\n\n{error}"
        ) from error

    return _to_comfy_image(array)


def _make_video(source):
    if VideoFromFile is None:
        raise RuntimeError(_VIDEO_IMPORT_ERROR)

    return VideoFromFile(str(source))


def _apply_range(
    requested,
    first,
    last,
    before_range,
    after_range,
):
    if first > last:
        raise ValueError(
            f"Active first frame ({first}) cannot exceed "
            f"active last frame ({last})."
        )

    if requested < first:
        if before_range == "error":
            raise ValueError(
                f"Frame {requested} is before active range "
                f"{first}-{last}."
            )

        return first

    if requested > last:
        if after_range == "error":
            raise ValueError(
                f"Frame {requested} is after active range "
                f"{first}-{last}."
            )

        return last

    return requested


def _resolve_sequence_frame(
    sequence,
    requested,
    missing_frames,
):
    frames = sequence["frames"]

    if requested in frames:
        return requested, frames[requested]

    if missing_frames == "error":
        raise ValueError(
            f"Sequence frame {requested} is missing."
        )

    previous = [
        number
        for number in frames.keys()
        if number <= requested
    ]

    if not previous:
        # Nothing at or before the request. Fall forward to the earliest
        # available frame instead of raising, so out-of-range preview
        # requests degrade gracefully rather than erroring per frame.
        following = [
            number
            for number in frames.keys()
            if number > requested
        ]

        if not following:
            raise ValueError(
                f"Sequence contains no usable frame for {requested}."
            )

        chosen = min(following)

        return chosen, frames[chosen]

    chosen = max(previous)

    return chosen, frames[chosen]


def inspect_source(source_path, force_still=False):
    source = _resolve_source(source_path)

    if _is_movie(source):
        info = _movie_info(source)

        return {
            "source_type": "movie",
            "source_path": str(source),
            "source_first": info["first"],
            "source_last": info["last"],
            "width": info["width"],
            "height": info["height"],
            "pattern": source.name,
            "fps": info["fps"],
        }

    # force_still skips sequence auto-detection entirely — used when
    # loading a pasted-from-clipboard image (see the paste feature in
    # read_stage1.js). Pasted uploads all land in ComfyUI's shared input/
    # folder with a timestamp-based filename (pasted_<13 digits>.png), so
    # two unrelated pastes made moments apart share the exact same
    # (prefix, padding, suffix) shape that _sequence_info groups by —
    # confirmed live: pasting a second image got the first one treated as
    # "frame 1 of 2" of a sequence instead of two separate stills. A
    # clipboard paste is always a one-off still; there's no sequence
    # convention that could ever legitimately apply to it.
    sequence = None if force_still else _sequence_info(source)

    if sequence:
        preview = _read_image(sequence["frames"][sequence["first"]])

        return {
            "source_type": "sequence",
            "source_path": str(source),
            "source_first": sequence["first"],
            "source_last": sequence["last"],
            "width": int(preview.shape[2]),
            "height": int(preview.shape[1]),
            "pattern": sequence["pattern"],
        }

    preview = _read_image(source)

    return {
        "source_type": "still",
        "source_path": str(source),
        "source_first": 1,
        "source_last": 1,
        "width": int(preview.shape[2]),
        "height": int(preview.shape[1]),
        "pattern": source.name,
    }


# Formats a browser can display natively via a plain <img src>. Anything
# else (e.g. EXR, TIFF) needs converting first — mirrors ComfyUI-VFX-
# Write's own WEB_IMAGE_EXTENSIONS/is_web_displayable_image (kept as a
# separate copy here rather than a shared import — Read and Write are
# independent installed packages under custom_nodes/, not a shared
# library).
WEB_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def is_web_displayable_image(path):
    return Path(path).suffix.lower() in WEB_IMAGE_EXTENSIONS


def _tensor_to_png_bytes(tensor):
    pixels = tensor[0].detach().cpu().numpy()
    pixels = np.clip(pixels, 0.0, 1.0)
    image = Image.fromarray((pixels * 255).astype(np.uint8), "RGB")

    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def full_image_png(path):
    """Full-resolution PNG bytes for a non-web-native still image format.

    Only called for a format a browser can't display directly — the
    caller serves web-native formats (png/jpg/...) as a raw file instead,
    which is both faster and avoids a redundant re-encode.
    """
    source = Path(path)

    if not source.is_file():
        raise ValueError(f"File does not exist:\n{source}")

    return _tensor_to_png_bytes(_read_image(source))


def resolve_still_source(path, frame_number):
    """Resolves a source path + frame number to whatever the preview
    (thumbnail or full-resolution) should actually show — the exact same
    still/sequence/movie rules used everywhere else in this file, shared
    here so both preview routes stay consistent with each other and with
    read()'s own frame selection.

    Returns ("file", Path) for a still or one frame of an image sequence
    (a real file on disk — callers can serve it directly, e.g. raw
    passthrough for web-native formats), or ("tensor", torch.Tensor) for
    one decoded frame of a movie (ffmpeg decodes it in memory; there is no
    file of its own to point at).
    """
    source = Path(path)

    if _is_movie(source):
        return ("tensor", _read_movie_frame(source, frame_number))

    sequence = _sequence_info(source)

    if sequence:
        _, selected = _resolve_sequence_frame(
            sequence,
            frame_number,
            "hold_previous",
        )
        return ("file", selected)

    return ("file", source)


def resolve_still_tensor(path, frame_number):
    """Same resolution as resolve_still_source, but always returns a
    decoded IMAGE tensor — for callers (like the thumbnail route) that
    always need pixels, not a passthrough-able file path."""
    kind, payload = resolve_still_source(path, frame_number)

    if kind == "tensor":
        return payload

    return _read_image(payload)


def list_versions(source_path):
    """Sibling versions (v01, v02, ...) of source_path, for the version
    picker widget. Tries a file-level version token first (_version_info);
    if that finds nothing meaningful and source_path is part of an image
    sequence, falls back to a folder-level version token instead
    (_sequence_folder_versions) — see the design notes on each for when
    each convention applies. Returns [] if neither finds anything."""
    source = _resolve_source(source_path)
    info = _version_info(source)
    is_sequence = _sequence_info(source) is not None

    # A file-level match of exactly one entry (itself, no other sibling
    # sharing that exact shape) is ambiguous for a sequence frame: every
    # frame trivially "matches itself" under this pattern regardless of
    # whether a real file-level version convention applies, which would
    # otherwise mask the folder-level convention that actually applies
    # when a sequence is split across per-version folders (confirmed live
    # — this exact trap). Only trust a single-entry file-level match for a
    # non-sequence file (a genuinely standalone still).
    if info and (len(info["versions"]) >= 2 or not is_sequence):
        return [
            {"version": number, "path": str(path)}
            for number, path in sorted(info["versions"].items())
        ]

    if is_sequence:
        folder_versions = _sequence_folder_versions(source)

        if folder_versions:
            return [
                {"version": number, "path": str(path)}
                for number, path in sorted(folder_versions.items())
            ]

    return []


# ---------------------------------------------------------------------------
# embedded generation metadata (seed + prompt)
# ---------------------------------------------------------------------------
# ComfyUI core's own SaveImage/SaveVideo/SaveWEBM (and, once added, this
# project's own Write node) embed the full API-format execution graph as
# file metadata — PNG text chunks for images, container-level tags for
# video (confirmed by reading ComfyUI's own source: nodes.py's SaveImage
# uses PIL's PngInfo; comfy_extras/nodes_video.py's SaveVideo/SaveWEBM write
# the same JSON into the video container via PyAV). This reads that graph
# back and pulls a best-effort seed + prompt from whichever single node
# feeds directly into the save node's image/video input — deliberately not
# a deeper graph walk. Real workflows observed in this project use one-hop
# API generation nodes (e.g. "Nano Banana", "Seedance") that already carry
# seed/prompt as their own widgets; a classic KSampler->VAEDecode chain
# would land on VAEDecode (no seed/prompt there) and simply come back
# empty — anything deeper is left to reading the raw embedded JSON by hand.
_META_SAVE_CLASS_TYPES = {
    "SaveImage",
    "SaveVideo",
    "SaveWEBM",
    "SaveAnimatedWEBP",
    "VFXWrite",
}

_META_SEED_KEYS = ("seed", "noise_seed")
_META_PROMPT_KEYS = ("prompt", "text", "positive_prompt", "positive")


def _extract_generation_meta(path):
    """Best-effort (seed, prompt) for whatever generated `path`. Never
    raises and never blocks reading the file itself — returns (None, None)
    for anything unreadable, metadata-less, or unrecognized."""
    try:
        if _is_movie(path):
            with av.open(str(path)) as container:
                raw = container.metadata.get("prompt")
        else:
            with Image.open(path) as img:
                raw = img.info.get("prompt")

        if not raw:
            return None, None

        graph = json.loads(raw)

        if not isinstance(graph, dict):
            return None, None
    except Exception:
        return None, None

    save_node = None

    for node in graph.values():
        if isinstance(node, dict) and node.get("class_type") in _META_SAVE_CLASS_TYPES:
            save_node = node
            break

    if save_node is None:
        return None, None

    inputs = save_node.get("inputs", {})
    link = inputs.get("images") or inputs.get("video") or inputs.get("image")

    if not (isinstance(link, list) and len(link) == 2):
        return None, None

    source_node = graph.get(str(link[0]))

    if not isinstance(source_node, dict):
        return None, None

    source_inputs = source_node.get("inputs", {})

    seed = None
    for key in _META_SEED_KEYS:
        value = source_inputs.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            seed = int(value)
            break

    prompt = None
    for key in _META_PROMPT_KEYS:
        value = source_inputs.get(key)
        if isinstance(value, str) and value:
            prompt = value
            break

    return seed, prompt


class VFXRead:
    CATEGORY = "VFX / IO"
    DESCRIPTION = (
        "Nuke-inspired local Read node. "
        "Loads one exact still, image-sequence, or movie frame."
    )

    RETURN_TYPES = ("IMAGE", "IMAGE", "STRING", "VIDEO", "INT", "INT", "INT", "STRING")
    RETURN_NAMES = (
        "image",
        "sequence",
        "sequence_folder",
        "video",
        "width",
        "height",
        "embedded_seed",
        "embedded_prompt",
    )

    FUNCTION = "read"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source_path": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "placeholder": r"F:\shots\plate.1001.exr",
                    },
                ),

                "frame": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
                        "max": 10000000,
                        "step": 1,
                    },
                ),

                "first": (
                    "INT",
                    {
                        "default": 1,
                        "min": -10000000,
                        "max": 10000000,
                        "step": 1,
                    },
                ),

                "last": (
                    "INT",
                    {
                        "default": 1,
                        "min": -10000000,
                        "max": 10000000,
                        "step": 1,
                    },
                ),

                "before_range": (
                    ["hold", "error"],
                ),

                "after_range": (
                    ["hold", "error"],
                ),

                "missing_frames": (
                    ["error", "hold_previous"],
                ),
            }
        }

    def read(
        self,
        source_path,
        frame,
        first,
        last,
        before_range,
        after_range,
        missing_frames,
    ):
        source = _resolve_source(source_path)

        if _is_movie(source):
            info = _movie_info(source)

            active_first = max(info["first"], int(first))
            active_last = min(info["last"], int(last))

            requested = _apply_range(
                int(frame),
                active_first,
                active_last,
                before_range,
                after_range,
            )

            image = _read_movie_frame(source, requested)

            video = _make_video(source)
            seed, prompt = _extract_generation_meta(source)

            # Not a real image sequence — expose the single decoded frame
            # as a 1-length batch so the "sequence" slot is still a valid
            # IMAGE rather than erroring for anything connected to it.
            return (
                image,
                image,
                str(source.parent),
                video,
                info["width"],
                info["height"],
                seed if seed is not None else -1,
                prompt or "",
            )

        sequence = _sequence_info(source)

        if sequence:
            active_first = max(
                sequence["first"],
                int(first),
            )

            active_last = min(
                sequence["last"],
                int(last),
            )

            requested = _apply_range(
                int(frame),
                active_first,
                active_last,
                before_range,
                after_range,
            )

            # One pass over the active range, building both the full-batch
            # "sequence" output and the single requested "frame" output
            # from the same reads — a path is only ever decoded once even
            # if missing_frames="hold_previous" repeats it across several
            # frame numbers.
            image_cache = {}
            batch = []
            first_shape = None
            first_frame_path = None
            requested_frame_path = None

            for frame_number in range(active_first, active_last + 1):
                _, frame_path = _resolve_sequence_frame(
                    sequence,
                    frame_number,
                    missing_frames,
                )

                if frame_number == requested:
                    requested_frame_path = frame_path

                if frame_path not in image_cache:
                    image_cache[frame_path] = _read_image(frame_path)

                tensor = image_cache[frame_path]

                if first_shape is None:
                    first_shape = tensor.shape[1:]
                    first_frame_path = frame_path
                elif tensor.shape[1:] != first_shape:
                    raise RuntimeError(
                        "Sequence frames are not all the same resolution — "
                        "can't combine them into one batch.\n\n"
                        f"Frame {active_first} ({first_frame_path.name}): "
                        f"{first_shape[1]}x{first_shape[0]}\n"
                        f"Frame {frame_number} ({frame_path.name}): "
                        f"{tensor.shape[2]}x{tensor.shape[1]}\n\n"
                        "Re-render the mismatched frame at the same "
                        "resolution, or narrow first/last to a range that "
                        "excludes it."
                    )

                batch.append(tensor)

            image_sequence = torch.cat(batch, dim=0)
            image = batch[requested - active_first]
            seed, prompt = _extract_generation_meta(requested_frame_path or source)

            return (
                image,
                image_sequence,
                str(source.parent),
                None,
                int(image.shape[2]),
                int(image.shape[1]),
                seed if seed is not None else -1,
                prompt or "",
            )

        image = _read_image(source)
        seed, prompt = _extract_generation_meta(source)

        return (
            image,
            image,
            str(source.parent),
            None,
            int(image.shape[2]),
            int(image.shape[1]),
            seed if seed is not None else -1,
            prompt or "",
        )


NODE_CLASS_MAPPINGS = {
    "VFXRead": VFXRead,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VFXRead": "Read",
}
