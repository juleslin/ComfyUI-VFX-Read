import asyncio
import io
from pathlib import Path

import numpy as np
from aiohttp import web
from PIL import Image

import folder_paths
from server import PromptServer

from .nodes import (
    FRAME_PATTERN,
    _is_movie,
    _tensor_to_png_bytes,
    full_image_png,
    inspect_source,
    is_web_displayable_image,
    list_versions,
    resolve_still_source,
    resolve_still_tensor,
)


routes = PromptServer.instance.routes


# /vfx-read/thumbnail and /vfx-read/image both decode images (and, for
# movies, spawn a blocking ffmpeg subprocess via _read_movie_frame) — real
# CPU/IO work with no async equivalent. Doing that directly inside an
# async def handler blocks aiohttp's single-threaded event loop for the
# whole ComfyUI server, not just this request; a burst of prefetch calls
# (the frame cache can fire up to PREFETCH_AHEAD + PREFETCH_BEHIND = 32 at
# once) serializes into a real, server-wide stall. Confirmed as the actual
# cause of a reported "the node freezes when picking a file" — the caching
# logic itself is fully async/bounded on the JS side. Routing the
# synchronous work through the default thread pool executor instead keeps
# the event loop free.
async def run_in_executor(fn, *args):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, fn, *args)


def _existing_path(value):
    path = Path(value).expanduser()

    if not path.exists():
        raise web.HTTPNotFound(
            text=f"Path does not exist: {path}"
        )

    return path


def _parse_frame(request):
    """Frame query param, defaulting to 1 for anything that isn't a valid
    positive integer — including "NaN", which int() rejects outright.
    Confirmed live: the frame widget can transiently read as NaN on the
    JS side while a source is still loading, and that NaN was getting
    stringified straight into the request URL, crashing this route with
    an unhandled ValueError instead of just showing frame 1."""
    raw = request.query.get("frame", "1")

    try:
        return max(1, int(float(raw)))
    except (TypeError, ValueError):
        return 1


def _group_files(folder):
    physical_files = sorted(
        [
            path
            for path in folder.iterdir()
            if path.is_file()
        ],
        key=lambda item: item.name.lower(),
    )

    # Single pass: bucket files that look like real sequence frames (the
    # same padding>=3 rule _sequence_info uses elsewhere in this project)
    # by (prefix, padding, suffix). The old version called a per-file
    # sequence lookup that itself re-scanned the WHOLE folder again for
    # matching siblings — O(n^2) on a big folder, and confirmed live as
    # the actual cause of "the browse dialog takes a long time to open a
    # movie's folder" — this builds the same groups in one O(n) pass.
    buckets = {}
    standalone = []

    for item in physical_files:
        if _is_movie(item):
            standalone.append(item)
            continue

        match = FRAME_PATTERN.match(item.name)

        if not match:
            standalone.append(item)
            continue

        prefix, digits, suffix = match.groups()
        padding = len(digits)

        # Mirrors _sequence_info's own version-vs-sequence cutoff — a
        # 1-2 digit trailing number is a version token (v01, v02...), not
        # a frame number.
        if padding < 3:
            standalone.append(item)
            continue

        buckets.setdefault((prefix, padding, suffix), {})[int(digits)] = item

    groups = []

    for (prefix, padding, suffix), frames in buckets.items():
        if len(frames) < 2:
            standalone.extend(frames.values())
            continue

        first = min(frames)
        last = max(frames)

        groups.append(
            {
                "kind": "sequence",
                "path": str(frames[first]),
                "label": f"{prefix}%0{padding}d{suffix}  {first}-{last}",
                "first": first,
                "last": last,
            }
        )

    for item in standalone:
        groups.append(
            {
                "kind": "file",
                "path": str(item),
                "label": item.name,
                "first": 1,
                "last": 1,
            }
        )

    groups.sort(key=lambda g: g["label"].lower())
    return groups


def _list_folder_sync(folder, grouped):
    directories = sorted(
        [
            {
                "name": item.name,
                "path": str(item),
            }
            for item in folder.iterdir()
            if item.is_dir()
        ],
        key=lambda item: item["name"].lower(),
    )

    if grouped:
        files = _group_files(folder)
    else:
        files = sorted(
            [
                {
                    "kind": "file",
                    "path": str(item),
                    "label": item.name,
                    "first": 1,
                    "last": 1,
                }
                for item in folder.iterdir()
                if item.is_file()
            ],
            key=lambda item: item["label"].lower(),
        )

    return directories, files


@routes.get("/vfx-read/list")
async def list_folder(request):
    raw_path = request.query.get("path", "").strip()

    if raw_path:
        folder = _existing_path(raw_path)

        if folder.is_file():
            folder = folder.parent
    else:
        folder = Path.home()

    grouped = request.query.get("sequences", "1") != "0"

    # folder.iterdir() itself is cheap, but _group_files' regex matching
    # over every file in a large folder is real CPU work — offload the
    # whole listing, same reasoning as the thumbnail/image routes above.
    directories, files = await run_in_executor(_list_folder_sync, folder, grouped)

    return web.json_response(
        {
            "folder": str(folder),
            "parent": str(folder.parent),
            "directories": directories,
            "files": files,
        }
    )


@routes.get("/vfx-read/inspect")
async def inspect(request):
    source = request.query.get("path", "").strip()

    # inspect_source() spawns a blocking ffprobe subprocess for movies
    # (_movie_info) — the exact same event-loop-blocking problem as the
    # thumbnail/image/list routes above, just missed in that first pass.
    # This one is called on every single file pick, before any thumbnail
    # is even fetched — confirmed as the still-remaining freeze source.
    result = await run_in_executor(inspect_source, source)

    return web.json_response(result)


@routes.get("/vfx-read/versions")
async def versions(request):
    raw_path = request.query.get("path", "").strip()

    if not raw_path:
        return web.json_response({"versions": []})

    try:
        found = await run_in_executor(list_versions, raw_path)
    except ValueError as error:
        return web.json_response({"versions": [], "error": str(error)})

    return web.json_response({"versions": found})


def _make_thumbnail_png(source, frame_number):
    tensor = resolve_still_tensor(source, frame_number)

    pixels = tensor[0].detach().cpu().numpy()
    pixels = np.clip(pixels, 0.0, 1.0)

    image = Image.fromarray(
        (pixels * 255).astype(np.uint8),
        "RGB",
    )

    image.thumbnail((640, 420))

    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


@routes.get("/vfx-read/thumbnail")
async def thumbnail(request):
    raw_path = request.query.get("path", "").strip()
    requested = _parse_frame(request)

    source = _existing_path(raw_path)

    png_bytes = await run_in_executor(_make_thumbnail_png, source, requested)

    return web.Response(
        body=png_bytes,
        content_type="image/png",
    )


@routes.get("/vfx-read/image")
async def image(request):
    """Full-resolution still — used by the fullscreen viewer. Same path +
    frame contract as /vfx-read/thumbnail (movie/sequence/still resolution
    is identical), just without the 640x420 downscale."""
    raw_path = request.query.get("path", "").strip()
    requested = _parse_frame(request)

    source = _existing_path(raw_path)

    kind, payload = await run_in_executor(resolve_still_source, source, requested)

    if kind == "file":
        if is_web_displayable_image(payload):
            # Raw passthrough — faster, and exact original quality.
            return web.FileResponse(payload)

        png_bytes = await run_in_executor(full_image_png, payload)
        return web.Response(body=png_bytes, content_type="image/png")

    png_bytes = await run_in_executor(_tensor_to_png_bytes, payload)
    return web.Response(body=png_bytes, content_type="image/png")


@routes.get("/vfx-read/video")
async def video(request):
    raw_path = request.query.get("path", "").strip()

    if not raw_path:
        raise web.HTTPBadRequest(text="Missing 'path' query parameter.")

    source = _existing_path(raw_path)

    # FileResponse supports HTTP Range requests, which <video> needs for
    # seeking/scrubbing.
    return web.FileResponse(source)


_UPLOAD_DIR_GETTERS = {
    "input": folder_paths.get_input_directory,
    "temp": folder_paths.get_temp_directory,
    "output": folder_paths.get_output_directory,
}


@routes.get("/vfx-read/resolve-upload")
async def resolve_upload(request):
    """Turns a {name, subfolder, type} upload result — the response shape
    ComfyUI's own core /upload/image route returns — into the absolute
    filesystem path Read actually needs for source_path. Used by the
    paste-image-from-clipboard feature: pasting reuses that same core
    upload route (no reason to duplicate it), then calls this to resolve
    the saved file's real path without hardcoding ComfyUI's input
    directory on the frontend."""
    name = request.query.get("name", "").strip()
    subfolder = request.query.get("subfolder", "").strip()
    upload_type = request.query.get("type", "input").strip()

    if not name:
        raise web.HTTPBadRequest(text="Missing 'name' query parameter.")

    get_dir = _UPLOAD_DIR_GETTERS.get(upload_type)

    if get_dir is None:
        raise web.HTTPBadRequest(text=f"Unknown upload type: {upload_type}")

    base = Path(get_dir())
    resolved = (base / subfolder / name) if subfolder else (base / name)

    if not resolved.is_file():
        raise web.HTTPNotFound(text=f"Uploaded file not found:\n{resolved}")

    return web.json_response({"path": str(resolved)})
