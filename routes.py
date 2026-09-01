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
    resolve_hash_pattern,
    resolve_still_source,
    resolve_still_tensor,
)


routes = PromptServer.instance.routes

# Applied to every route that serves image/video bytes by path. Without
# this, the browser's own HTTP cache can serve stale bytes for a path
# whose on-disk content has since changed (e.g. the same source_path
# overwritten by an external re-render) — same fix applied to
# ComfyUI-VFX-Write's equivalent routes after a real reported bug: the
# path/version UI updated correctly, but the canvas kept showing the old
# image. The app already does its own smarter, path+frame-keyed in-memory
# caching (see cacheRequest in the frontend) for scrub performance, so
# disabling the browser's own opportunistic caching here has no real cost.
_NO_STORE_HEADERS = {"Cache-Control": "no-store"}


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
        # a frame number; more than 8 digits is a paste-from-clipboard
        # upload's Date.now() timestamp (pasted_<13 digits>.png), not a
        # real frame number either — see the design note on _sequence_info
        # for the live-confirmed bug this excludes.
        if padding < 3 or padding > 8:
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
    force_still = request.query.get("force_still", "").strip() not in ("", "0")

    # inspect_source() spawns a blocking ffprobe subprocess for movies
    # (_movie_info) — the exact same event-loop-blocking problem as the
    # thumbnail/image/list routes above, just missed in that first pass.
    # This one is called on every single file pick, before any thumbnail
    # is even fetched — confirmed as the still-remaining freeze source.
    result = await run_in_executor(inspect_source, source, force_still)

    return web.json_response(result)


@routes.get("/vfx-read/resolve-hash-pattern")
async def resolve_hash_pattern_route(request):
    """Nuke-style '####' frame placeholder support: typing/pasting
    name.####.jpg into the file row resolves it to a real frame's path
    here first, then loads exactly as if that concrete path had been
    typed directly — see resolve_hash_pattern's own docstring."""
    raw_path = request.query.get("path", "").strip()

    if not raw_path:
        raise web.HTTPBadRequest(text="Missing 'path' query parameter.")

    try:
        resolved = await run_in_executor(resolve_hash_pattern, raw_path)
    except ValueError as error:
        raise web.HTTPNotFound(text=str(error))

    if resolved is None:
        return web.json_response({"isPattern": False})

    return web.json_response({"isPattern": True, "path": resolved})


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
        headers=_NO_STORE_HEADERS,
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
            return web.FileResponse(payload, headers=_NO_STORE_HEADERS)

        png_bytes = await run_in_executor(full_image_png, payload)
        return web.Response(body=png_bytes, content_type="image/png", headers=_NO_STORE_HEADERS)

    png_bytes = await run_in_executor(_tensor_to_png_bytes, payload)
    return web.Response(body=png_bytes, content_type="image/png", headers=_NO_STORE_HEADERS)


@routes.get("/vfx-read/video")
async def video(request):
    raw_path = request.query.get("path", "").strip()

    if not raw_path:
        raise web.HTTPBadRequest(text="Missing 'path' query parameter.")

    source = _existing_path(raw_path)

    # FileResponse supports HTTP Range requests, which <video> needs for
    # seeking/scrubbing.
    return web.FileResponse(source, headers=_NO_STORE_HEADERS)


@routes.post("/vfx-read/paste-save")
async def paste_save(request):
    """Saves a pasted clipboard image directly to a user-chosen destination
    (path + file_name), instead of ComfyUI's own managed input/ folder —
    the "save pasted screenshots to a real folder" feature. Refuses to
    overwrite an existing file unless the caller explicitly confirms via
    `overwrite=1` (the frontend re-POSTs with that after the user
    confirms a collision dialog), so a same-named second paste can never
    silently clobber the first."""
    reader = await request.multipart()

    image_bytes = None
    raw_path = ""
    raw_name = ""
    overwrite = False

    async for field in reader:
        if field.name == "image":
            image_bytes = await field.read(decode=False)
        elif field.name == "path":
            raw_path = (await field.text()).strip()
        elif field.name == "file_name":
            raw_name = (await field.text()).strip()
        elif field.name == "overwrite":
            overwrite = (await field.text()).strip().lower() in ("1", "true")

    if not raw_path or not raw_name:
        raise web.HTTPBadRequest(text="Missing 'path' or 'file_name'.")

    if image_bytes is None:
        raise web.HTTPBadRequest(text="Missing 'image' field.")

    # file_name is a single path segment, never a nested path — otherwise
    # "../../something" could escape the chosen destination folder
    # entirely (Path's own '/' operator doesn't collapse '..' until
    # resolved, so this has to be rejected explicitly up front).
    if "/" in raw_name or "\\" in raw_name or raw_name in ("..", "."):
        raise web.HTTPBadRequest(text="File name must not contain a path separator.")

    folder = Path(raw_path)

    try:
        folder.mkdir(parents=True, exist_ok=True)
    except Exception as error:
        raise web.HTTPBadRequest(text=f"Could not create destination folder:\n{folder}\n\n{error}")

    destination = folder / raw_name

    if destination.exists() and not overwrite:
        return web.json_response({"conflict": True, "path": str(destination)}, status=409)

    try:
        destination.write_bytes(image_bytes)
    except Exception as error:
        raise web.HTTPInternalServerError(
            text=f"Could not save pasted image:\n{destination}\n\n{error}"
        )

    return web.json_response({"path": str(destination)})


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
