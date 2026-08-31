// ComfyUI-VFX-Read / web/read_stage1.js
//
// Node type: VFXRead   Extension: vfx.read.stage1
// Routes:    /vfx-read/list  /vfx-read/inspect  /vfx-read/thumbnail
//
// ---------------------------------------------------------------------------
// Value persistence design (read this before changing onConfigure)
// ---------------------------------------------------------------------------
// LiteGraph serializes widget values POSITIONALLY into widgets_values[].
// reorderWidgets() permutes node.widgets in place, so the save-time array and
// the load-time array disagree and values land in the wrong slots. Fix:
// onSerialize writes a NAME-KEYED map into o.vfx_read_values, and onConfigure
// restores from that map after reorderWidgets() has run.
//
// Second problem, fixed here: inspectAndApply() used to unconditionally
// overwrite frame/first/last with the file's own range from /vfx-read/inspect.
// On reload that destroyed the restored values. It now takes an applyRange
// flag:
//
//   pick()        -> applyRange: true   (new source, adopt the file's range)
//   onConfigure() -> applyRange: false  (reload, saved values win)
//
// On reload the saved range is CLAMPED to the file's real range (option 2), so
// a re-rendered or shortened source cannot leave first/last/frame pointing at
// frames that no longer exist. `frame` is remembered exactly as left off, then
// clamped into the active range.
//
// Third problem, fixed here: the source_path watcher also calls
// inspectAndApply(), and it fires while onConfigure is restoring values. That
// was a second path to the same overwrite. node.__vfxRestoring suppresses it.

import { app } from "../../scripts/app.js";

const NODE_TYPE = "VFXRead";

const PREVIEW_WIDGET = "$$vfx-read-preview";
const TRANSPORT_WIDGET = "vfx_read_transport";
const VIDEO_WIDGET = "$$vfx-read-video";
const SCRUB_WIDGET = "$$vfx-read-scrub";

// Paired-row DOM widgets — see buildFileRow/buildParamsRow. Each houses
// several controls sharing one row; the real value-holding widgets they
// drive (source_path, frame, first, last, before_range, after_range)
// become invisible DOM-backed carriers of the same name
// (buildHiddenValue/replaceWithHiddenCarrier), not separate native rows of
// their own — there's no native "Choose source" button or "Version" combo
// any more, folded into these instead.
const FILE_ROW_WIDGET = "$$vfx-read-file-row";
const PARAMS_ROW_WIDGET = "$$vfx-read-params-row";

const VALUE_WIDGETS = [
  "source_path",
  "frame",
  "first",
  "last",
  "before_range",
  "after_range",
  "missing_frames",
];

// Preview/video/scrub/transport last: matches ComfyUI-VFX-Write's layout,
// and keeps them clear of the opaque-background DOM rows Node 2.0 renders
// for every other (native) widget above them — see the design note above
// buildPreviewWidget for why that ordering matters even with the preview
// now being a real DOM widget. VIDEO_WIDGET sits before TRANSPORT_WIDGET so
// the shared button row renders under the canvas for both modes — it used
// to come after, which put it above the video specifically. missing_frames
// isn't listed — it's a fully invisible carrier with no row of its own, so
// its position doesn't matter.
const WIDGET_ORDER = [
  FILE_ROW_WIDGET,
  PARAMS_ROW_WIDGET,
  PREVIEW_WIDGET,
  VIDEO_WIDGET,
  SCRUB_WIDGET,
  TRANSPORT_WIDGET,
];

const PREVIEW_MIN_H = 120;
// Empty-state canvas height for a freshly-created node with no source
// loaded yet — was 260, cut down to match the compact, no-wasted-space
// look requested live. If this doesn't quite match, it's a one-line
// number to retune.
const PREVIEW_DEFAULT_H = 190;
const TRANSPORT_H = 24;
const SCRUB_H = 20;
// Wide enough for the six-control params row (version/frame/first/before/
// last/after) to sit comfortably without crowding — matches the width the
// row's own control min-widths add up to (~380px) plus margin. Retune
// directly if it doesn't match your own resized node.
const MIN_NODE_W = 440;

const PREFETCH_AHEAD = 24;
const PREFETCH_BEHIND = 8;
const MAX_CONCURRENT = 4;
const MAX_CACHE = 240;
const DEFAULT_FPS = 24;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function el(tag, style, props) {
  const n = document.createElement(tag);
  if (style) Object.assign(n.style, style);
  if (props) Object.assign(n, props);
  return n;
}

// Shared small dark-themed icon/label button — originally local to
// buildTransportWidget, promoted to file scope so buildBrowserDialog can
// use the same styling for its own icon buttons.
function smallBtn(label, title) {
  return el(
    "button",
    {
      background: "#2c2c2c",
      color: "#ddd",
      border: "1px solid #4a4a4a",
      borderRadius: "3px",
      padding: "3px 8px",
      font: "11px sans-serif",
      cursor: "pointer",
      minWidth: "28px",
    },
    { textContent: label, title: title || "" }
  );
}

// Small shared building blocks for the paired-row widgets (buildFileRow,
// buildParamsRow) — same dark theme as every other control in this file,
// just sized to sit several-per-row instead of taking the full width a
// native widget would. No text labels — each control's .title tooltip
// covers that instead, to keep a six-control row legible.

function rowTextInput(type) {
  return el(
    "input",
    {
      flex: "1 1 auto",
      minWidth: "0",
      background: "#1a1a1a",
      border: "1px solid #444",
      color: "#ddd",
      padding: "4px 6px",
      borderRadius: "3px",
      font: "11px monospace",
    },
    { type: type || "text" }
  );
}

function rowSelect(options) {
  const s = el("select", {
    flex: "1 1 auto",
    minWidth: "0",
    background: "#1a1a1a",
    border: "1px solid #444",
    color: "#ddd",
    padding: "4px 6px",
    borderRadius: "3px",
    font: "11px sans-serif",
  });
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    s.appendChild(o);
  }
  return s;
}

// Commits a text/number field's value on Enter or on losing focus, rather
// than on every keystroke — matches the browse dialog's own path input,
// and avoids firing a full inspectAndApply mid-edit.
function commitOnEnterOrBlur(input, commit) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit();
      input.blur();
    }
  });
  input.addEventListener("blur", commit);
}

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name) || null;
}

// Node 2.0 renders each widget's visible DOM control (text/number/combo
// input) from a separate Vue-reactive mirror on widget._state, NOT from
// widget.value directly. Confirmed live this session: after a page reload,
// widget.value correctly held the restored source_path, but the actual
// <input> box on screen showed empty — because onConfigure's applyValues()
// only ever wrote widget.value, and _state.value (what the DOM control
// actually reads) was left at its construction-time default and never
// updated. Writing widget._state.value directly does trigger Vue's
// reactivity and fixes the display; classic-mode widgets (no _state, e.g.
// the canvas-drawn ones) are unaffected by the extra check. Every
// programmatic widget-value write in this file should go through this
// function (or applyValues, which now does) rather than assigning
// widget.value directly, or the same "restored but invisible" bug recurs.
function setWidget(node, name, value) {
  const w = getWidget(node, name);
  if (!w) return;
  const changed = w.value !== value;
  if (changed) w.value = value;
  if (w._state && w._state.value !== value) w._state.value = value;

  // frame/source_path/first/last drive real side effects (preview
  // updates, video seeking, inspecting a newly-typed path, range
  // re-clamping) whenever their value changes, regardless of what changed
  // it — typing into a widget, "Use Frame", playback, restore, etc. This
  // used to be handled by watchWidgetValue's property-interception trick
  // (wrapping the widget's own "value" accessor), but that fails outright
  // ("Cannot redefine property: value") on the DOM-backed carrier widgets
  // these four became this round — confirmed live. Centralizing dispatch
  // here instead, in the one function every value-changing call site in
  // this file already goes through, gets the same "react to any change"
  // behavior without needing to redefine anything.
  if (changed) {
    refreshRowDisplays(node);
    if (name === "frame") onFrameChanged(node, value);
    else if (name === "source_path") onSourcePathChanged(node, value);
    else if (name === "first" || name === "last") onRangeChanged(node);
  }
}

// Keeps each paired-row control's displayed value following its
// underlying carrier widget, regardless of what changed it — called from
// setWidget() on every real value change, including during restore (the
// visible sync should happen even while onFrameChanged/etc.'s heavier
// side effects are suppressed by __vfxRestoring).
function refreshRowDisplays(node) {
  const state = node.__vfxPreview;
  if (!state) return;

  if (state.fileRowInput) {
    const v = getWidget(node, "source_path")?.value ?? "";
    if (state.fileRowInput.value !== v) state.fileRowInput.value = v;
  }
  if (state.frameRowInput) {
    const v = getWidget(node, "frame")?.value;
    if (v !== undefined && String(state.frameRowInput.value) !== String(v)) {
      state.frameRowInput.value = v;
    }
  }
  if (state.firstInput) {
    const v = getWidget(node, "first")?.value;
    if (v !== undefined && String(state.firstInput.value) !== String(v)) {
      state.firstInput.value = v;
    }
  }
  if (state.lastInput) {
    const v = getWidget(node, "last")?.value;
    if (v !== undefined && String(state.lastInput.value) !== String(v)) {
      state.lastInput.value = v;
    }
  }
  if (state.beforeRangeSelect) {
    const v = getWidget(node, "before_range")?.value;
    if (v !== undefined && state.beforeRangeSelect.value !== v) {
      state.beforeRangeSelect.value = v;
    }
  }
  if (state.afterRangeSelect) {
    const v = getWidget(node, "after_range")?.value;
    if (v !== undefined && state.afterRangeSelect.value !== v) {
      state.afterRangeSelect.value = v;
    }
  }
}

function numValue(node, name, fallback) {
  const v = getWidget(node, name)?.value;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function reorderWidgets(node) {
  if (!Array.isArray(node.widgets) || !node.widgets.length) return;

  const rank = (w) => {
    const i = WIDGET_ORDER.indexOf(w?.name);
    return i === -1 ? WIDGET_ORDER.length : i;
  };

  const decorated = node.widgets.map((w, i) => ({ w, i, r: rank(w) }));
  decorated.sort((a, b) => (a.r - b.r) || (a.i - b.i));

  const next = decorated.map((d) => d.w);
  if (!next.some((w, i) => w !== node.widgets[i])) return;

  node.widgets.length = 0;
  node.widgets.push(...next);
  node.setDirtyCanvas?.(true, true);
}

// ---------------------------------------------------------------------------
// preview sizing — chrome = everything on the node that ISN'T the preview
// (title, sockets, every other widget), measured exactly once and cached.
//
// This used to be a hardcoded guess (NODE_CHROME_H = 250) combined with a
// computeSize() that returned state.height, which draw() set from the LIVE
// node.size every frame — self-referential (computeSize() reporting a
// value derived from the node's own current size), so the node grew every
// redraw with nothing to stop it. Ported the fix already proven in
// ComfyUI-VFX-Write's write_stage1.js: computeSize() must be a genuine
// constant with zero dependency on node.size, and the ONLY safe place to
// read node.size live is inside draw() (it doesn't feed back into
// LiteGraph's own layout bookkeeping the way computeSize() does). Chrome
// itself is measured by asking LiteGraph's own node.computeSize() rather
// than re-deriving it by hand — the preview widget's computeSize() is a
// fixed PREVIEW_MIN_H at that moment, so node.computeSize()'s total is
// always exactly chrome + PREVIEW_MIN_H.
function chromeOf(node) {
  if (node.__vfxReadChrome !== undefined) return node.__vfxReadChrome;
  node.__vfxReadChrome = node.computeSize()[1] - PREVIEW_MIN_H;
  return node.__vfxReadChrome;
}

// ---------------------------------------------------------------------------
// name-keyed value persistence
// ---------------------------------------------------------------------------

function collectValues(node) {
  const out = {};
  for (const name of VALUE_WIDGETS) {
    const w = getWidget(node, name);
    if (w) out[name] = w.value;
  }
  return out;
}

// Defaults mirror Python INPUT_TYPES so a missing or corrupt entry yields a
// usable node instead of null / NaN.
function sanitizeValues(saved) {
  const out = {};
  const src = saved && typeof saved === "object" ? saved : {};

  const path = src.source_path;
  out.source_path = typeof path === "string" ? path : "";

  for (const [name, fallback] of [["frame", 1], ["first", 1], ["last", 1]]) {
    const n = Number(src[name]);
    out[name] = Number.isFinite(n) ? n : fallback;
  }

  out.before_range = src.before_range === "error" ? "error" : "hold";
  out.after_range = src.after_range === "error" ? "error" : "hold";
  out.missing_frames =
    src.missing_frames === "hold_previous" ? "hold_previous" : "error";

  return out;
}

function applyValues(node, values) {
  const clean = sanitizeValues(values);
  for (const name of VALUE_WIDGETS) {
    setWidget(node, name, clean[name]);
  }
  return clean;
}

// Option 2: keep the user's saved range, but clip it to what the file
// actually contains so nothing points past the end of a shortened source.
function clampRangeToSource(node, sourceFirst, sourceLast) {
  if (!Number.isFinite(sourceFirst) || !Number.isFinite(sourceLast)) return;
  if (sourceFirst > sourceLast) return;

  let first = numValue(node, "first", sourceFirst);
  let last = numValue(node, "last", sourceLast);

  first = Math.min(Math.max(first, sourceFirst), sourceLast);
  last = Math.min(Math.max(last, sourceFirst), sourceLast);

  if (first > last) {
    // Saved range is inverted or fully outside the file. Fall back to the
    // file's own range rather than leaving an unusable window.
    first = sourceFirst;
    last = sourceLast;
  }

  setWidget(node, "first", first);
  setWidget(node, "last", last);

  // Remembered playhead, clamped into the active window.
  const frame = numValue(node, "frame", first);
  setWidget(node, "frame", Math.min(Math.max(frame, first), last));
}

async function apiGet(path, params) {
  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return await r.json();
}

function thumbnailUrl(sourcePath, frame) {
  const url = new URL("/vfx-read/thumbnail", window.location.origin);
  url.searchParams.set("path", sourcePath || "");
  if (frame !== undefined && frame !== null) {
    url.searchParams.set("frame", String(frame));
  }
  return url.toString();
}

// Full-resolution — used by the fullscreen viewer, never the small
// preview (which stays on the deliberately-capped thumbnail route above).
function fullImageUrl(sourcePath, frame) {
  const url = new URL("/vfx-read/image", window.location.origin);
  url.searchParams.set("path", sourcePath || "");
  if (frame !== undefined && frame !== null) {
    url.searchParams.set("frame", String(frame));
  }
  return url.toString();
}

function videoUrl(sourcePath) {
  const url = new URL("/vfx-read/video", window.location.origin);
  url.searchParams.set("path", sourcePath || "");
  return url.toString();
}

// ---------------------------------------------------------------------------
// frame cache
// ---------------------------------------------------------------------------

function createCache() {
  return { map: new Map(), order: [], inflight: 0, queue: [] };
}

function cacheKey(path, frame) {
  return `${path}|${frame}`;
}

function cacheTrim(cache) {
  while (cache.order.length > MAX_CACHE) {
    cache.map.delete(cache.order.shift());
  }
}

function cacheGet(cache, path, frame) {
  return cache.map.get(cacheKey(path, frame)) || null;
}

function cacheRequest(cache, path, frame, onReady) {
  const key = cacheKey(path, frame);
  const existing = cache.map.get(key);
  if (existing) return existing;

  const entry = { img: null, ready: false, failed: false };
  cache.map.set(key, entry);
  cache.order.push(key);
  cacheTrim(cache);

  cache.queue.push({ key, path, frame, entry, onReady });
  cachePump(cache);
  return entry;
}

function cachePump(cache) {
  while (cache.inflight < MAX_CONCURRENT && cache.queue.length) {
    const job = cache.queue.shift();
    if (!cache.map.has(job.key)) continue;

    cache.inflight++;
    const img = new Image();
    img.decoding = "async";

    const done = (ok) => {
      cache.inflight--;
      job.entry.ready = ok;
      job.entry.failed = !ok;
      job.entry.img = ok ? img : null;
      if (ok) job.onReady?.(job.frame);
      cachePump(cache);
    };

    img.addEventListener("load", () => done(true), { once: true });
    img.addEventListener("error", () => done(false), { once: true });
    img.src = thumbnailUrl(job.path, job.frame);
  }
}

function cacheClear(cache) {
  cache.map.clear();
  cache.order.length = 0;
  cache.queue.length = 0;
}

// ---------------------------------------------------------------------------
// hidden value carriers + paired rows
// ---------------------------------------------------------------------------
// Neither `widget.hidden = true` nor `widget.type = "hidden"` actually stop
// Node 2.0 from rendering a native widget's row — confirmed live, both
// leave it fully visible at full size. The only proven-reliable hide
// mechanism in this project is a real DOM widget with an explicit
// display:none container, already used for the preview/video/scrub
// containers above. For source_path/frame/first/last/before_range/
// after_range/missing_frames — real execution parameters, not decorative
// UI — that also has to keep working as a genuine value for ComfyUI's own
// prompt-queuing. Confirmed live via app.graphToPrompt() on a throwaway
// probe widget: addDOMWidget's getValue/setValue callbacks ARE what
// prompt-queuing reads through (keyed by widget.name, same as a native
// widget), and this project's own setWidget() helper (direct
// `widget.value = x` assignment) correctly routes through setValue too —
// so no other call site needs to change to keep writing to these by name.
//
// One real incompatibility found in the same round of testing: this
// project's old watchWidgetValue() reacted to ANY value change by
// redefining the widget's own "value" accessor via Object.defineProperty —
// that throws ("Cannot redefine property: value") on these DOM-backed
// carriers, since their "value" isn't a plain, redefinable data property.
// Fixed by removing that mechanism entirely and dispatching explicitly
// from inside setWidget() instead (see onFrameChanged/onSourcePathChanged/
// onRangeChanged and the dispatch block in setWidget, above) — every value
// change already goes through setWidget, so nothing is lost, it just isn't
// discovered via property interception anymore.
function buildHiddenValue(node, name, initialValue) {
  let backing = initialValue;
  const container = el("div", { display: "none" });
  const widget = node.addDOMWidget(name, "hidden", container, {
    getValue: () => backing,
    setValue: (v) => { backing = v; },
    // The REAL "don't render this row at all" signal, found by reading
    // the frontend bundle's own NodeWidgets/useProcessedWidgets source:
    // `isWidgetVisible()` checks `widget.options.hidden` (NOT a top-level
    // `widget.hidden` property — confirmed that's exactly why the earlier
    // `w.hidden = true` attempt on a native widget silently did nothing).
    // When this is true the Vue template skips the widget's grid row
    // entirely (`t.visible ? render : nothing`), rather than rendering a
    // zero-size one — which matters because a *rendered* zero-size row
    // still consumed real grid space here: with seven of these carriers
    // each contributing a fixed ~28px row (a floor applied per rendered
    // row regardless of computeSize), that added up to a real, constant
    // ~196px gap between the last real widget and the node's bottom edge,
    // on every single node regardless of size. computeSize=[0,0] below is
    // kept as a defensive fallback but this is the fix that actually
    // matters.
    hidden: true,
  });
  widget.computeSize = () => [0, 0];
  return widget;
}

// Removes the native widget ComfyUI auto-created from INPUT_TYPES for
// `name` and replaces it with an invisible carrier of the same name,
// seeded with whatever value it currently held. Runs in onNodeCreated,
// which always fires before onConfigure's own restore — so this seeds
// from the INPUT_TYPES default on a fresh node, and onConfigure's later
// setWidget() call finds this carrier by name and applies the real
// restored value to it exactly as it would a native widget.
function replaceWithHiddenCarrier(node, name) {
  const existing = getWidget(node, name);
  const initialValue = existing ? existing.value : undefined;
  if (existing) {
    const idx = node.widgets.indexOf(existing);
    if (idx !== -1) node.widgets.splice(idx, 1);
  }
  return buildHiddenValue(node, name, initialValue);
}

function pairedRowContainer() {
  return el("div", {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  });
}

// Grey outline-folder SVG (currentColor) instead of the emoji — an emoji
// glyph carries its own fixed color that can't be recolored via CSS; an
// inline SVG can.
function folderIconButton() {
  const btn = el(
    "button",
    {
      background: "#2c2c2c",
      border: "1px solid #4a4a4a",
      borderRadius: "3px",
      padding: "0 8px",
      cursor: "pointer",
      color: "#9a9a9a",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
    { title: "Choose source" }
  );
  btn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
    '<path d="M10 4H2v16h20V6H12l-2-2z"/></svg>';
  return btn;
}

// "File" text field + folder-icon browse button, replacing the old
// separate "source_path" native row and standalone "Choose source" button.
// A little top margin gives it breathing room under the node's title bar.
function buildFileRow(node) {
  const state = node.__vfxPreview;
  const container = pairedRowContainer();
  container.style.marginTop = "6px";

  const input = rowTextInput("text");
  input.placeholder = "Choose a file...";
  input.value = getWidget(node, "source_path")?.value || "";
  commitOnEnterOrBlur(input, () => setWidget(node, "source_path", input.value));

  const browseBtn = folderIconButton();
  browseBtn.addEventListener("click", () => buildBrowserDialog(node));

  container.appendChild(input);
  container.appendChild(browseBtn);

  const widget = node.addDOMWidget(FILE_ROW_WIDGET, "file-row", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, TRANSPORT_H];

  state.fileRowInput = input;
  return widget;
}

// One compact row for everything else: version + frame on the left,
// first/before/last/after on the right, separated by a flex spacer (same
// pattern as the transport row's own left/right split). No text labels —
// each control's .title tooltip covers that instead, keeping six controls
// legible on one line. Bottom margin separates it from the preview canvas
// below.
function buildParamsRow(node) {
  const state = node.__vfxPreview;
  const container = pairedRowContainer();
  container.style.marginBottom = "8px";

  const versionSelect = rowSelect([]);
  versionSelect.title = "Version";
  versionSelect.style.flex = "0 1 56px";
  versionSelect.addEventListener("change", () => {
    if (node.__vfxRestoring) return;
    const versions = node.__vfxReadVersions || [];
    const match = versions.find(
      (v) => `v${String(v.version).padStart(2, "0")}` === versionSelect.value
    );
    if (match) setWidget(node, "source_path", match.path);
  });

  const frameInput = rowTextInput("number");
  frameInput.title = "Frame";
  frameInput.min = "1";
  frameInput.step = "1";
  frameInput.style.flex = "0 1 64px";
  frameInput.value = getWidget(node, "frame")?.value ?? 1;
  commitOnEnterOrBlur(frameInput, () => {
    const v = Number(frameInput.value);
    setWidget(node, "frame", Number.isFinite(v) ? v : 1);
  });

  const spacer = el("div", { flex: "1" });

  const firstInput = rowTextInput("number");
  firstInput.title = "First frame";
  firstInput.step = "1";
  firstInput.style.flex = "0 1 52px";
  firstInput.value = getWidget(node, "first")?.value ?? 1;
  commitOnEnterOrBlur(firstInput, () => {
    const v = Number(firstInput.value);
    setWidget(node, "first", Number.isFinite(v) ? v : 1);
  });

  const beforeSelect = rowSelect(["hold", "error"]);
  beforeSelect.title = "Before range";
  beforeSelect.style.flex = "0 1 58px";
  beforeSelect.value = getWidget(node, "before_range")?.value || "hold";
  beforeSelect.addEventListener("change", () => {
    setWidget(node, "before_range", beforeSelect.value);
  });

  const lastInput = rowTextInput("number");
  lastInput.title = "Last frame";
  lastInput.step = "1";
  lastInput.style.flex = "0 1 52px";
  lastInput.value = getWidget(node, "last")?.value ?? 1;
  commitOnEnterOrBlur(lastInput, () => {
    const v = Number(lastInput.value);
    setWidget(node, "last", Number.isFinite(v) ? v : 1);
  });

  const afterSelect = rowSelect(["hold", "error"]);
  afterSelect.title = "After range";
  afterSelect.style.flex = "0 1 58px";
  afterSelect.value = getWidget(node, "after_range")?.value || "hold";
  afterSelect.addEventListener("change", () => {
    setWidget(node, "after_range", afterSelect.value);
  });

  container.appendChild(versionSelect);
  container.appendChild(frameInput);
  container.appendChild(spacer);
  container.appendChild(firstInput);
  container.appendChild(beforeSelect);
  container.appendChild(lastInput);
  container.appendChild(afterSelect);

  const widget = node.addDOMWidget(PARAMS_ROW_WIDGET, "params-row", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, TRANSPORT_H];

  state.versionSelect = versionSelect;
  state.frameRowInput = frameInput;
  state.firstInput = firstInput;
  state.lastInput = lastInput;
  state.beforeRangeSelect = beforeSelect;
  state.afterRangeSelect = afterSelect;
  return widget;
}

// ---------------------------------------------------------------------------
// preview - a DOM widget (real <img>)
// ---------------------------------------------------------------------------

// Node 2.0 gives a canvas type:"custom" widget a HARD grid cell matching
// exactly what its computeSize() reports — confirmed live this session by
// inspecting the real DOM: the old canvas-drawn preview widget's row was
// exactly PREVIEW_MIN_H (120px) tall, no more, with the NEXT widget's own
// (opaque-background) row starting immediately after it. Classic LiteGraph
// let draw() paint taller than the widget's own declared box harmlessly
// (nothing clipped it); Node 2.0's real CSS grid does not allow that —
// content painted below the 120px cell is simply covered by the next
// row's opaque background, which is exactly the "part of the canvas is
// cropped" bug reported live. A DOM widget doesn't have this problem: its
// wrapper element visibly stretches to fill whatever space is actually
// available (confirmed for ComfyUI-VFX-Write's video widget), so this is
// now a real <img>, not a canvas draw().
function buildPreviewWidget(node) {
  const state = {
    mode: "image", // "image" | "video" — video uses buildVideoWidget's
    // real <video> element instead; this widget's DOM wrapper collapses
    // to zero height while that's active. See setupVideo/teardownVideo.
    // playhead is the "what's currently previewed/scrubbed" position —
    // deliberately decoupled from the `frame` widget (the actual export
    // value). Only typing into `frame` directly, or clicking "Use Frame",
    // moves `frame`; scrubbing/playback only ever moves playhead (or, for
    // video, the <video> element's own currentTime).
    playhead: 1,
    movieFps: DEFAULT_FPS,
    // Only true when there's an actual range to scrub through (a real
    // sequence, first < last, in image mode) — a single still frame or
    // video (which has its own native seek bar) has nothing to show here.
    scrubVisible: false,
    directFetchBusy: false,
    directFetchQueuedFrame: null,
    img: null,
    shownFrame: null,
    lastRequestedFrame: null,
    naturalW: 0,
    naturalH: 0,
    srcW: 0,
    srcH: 0,
    cache: createCache(),
    cacheEnabled: false,
    playing: false,
    loop: false,
    fps: DEFAULT_FPS,
    rafId: 0,
    lastTick: 0,
    acc: 0,
  };

  const container = el("div", {
    width: "100%",
    height: "100%",
    // A <video> element has a real intrinsic size even with no content
    // loaded (300x150 per the HTML spec, or its own aspect ratio once
    // metadata loads), which is why the video widget's wrapper correctly
    // stretches to fill available space. This container's own content —
    // the "No source" placeholder text, or an <img> with no src yet — has
    // NO intrinsic size at all, so without an explicit minHeight the
    // wrapper collapses to fit that tiny text instead of stretching.
    // Confirmed live: this squished the empty-state preview down to
    // ~14px (the placeholder text's own line height) instead of the
    // ~120-190px it should occupy. Targets PREVIEW_DEFAULT_H, not just
    // PREVIEW_MIN_H — confirmed this is a hard floor, not a stretch
    // trigger (a minHeight of 120 rendered at exactly 120, nothing more),
    // so it needs to directly target the intended empty-state size. Once
    // a real image/video loads, the existing (already-working) stretch
    // behavior takes back over on its own — real <img>/<video> content is
    // a CSS "replaced element" with genuine intrinsic sizing, unlike this
    // placeholder text, which is what's actually driving that difference.
    minHeight: `${PREVIEW_DEFAULT_H}px`,
    background: "#181818",
    border: "1px solid #333",
    borderRadius: "4px",
    overflow: "hidden",
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  const imgEl = document.createElement("img");
  // width/height:100% (not max-width/max-height) — the thumbnail route
  // deliberately caps images at 640x420 (see thumbnailUrl), so the <img>'s
  // own intrinsic size is small; max-width/max-height alone only stops it
  // growing PAST the container, it doesn't stretch a smaller image UP to
  // fill one that's bigger. Confirmed live: resizing the node taller left
  // the image "stuck" at its capped natural size instead of filling the
  // extra room. Same fix already used in the fullscreen viewer (below) —
  // just never applied here too. object-fit:contain still preserves
  // aspect ratio either way.
  Object.assign(imgEl.style, {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    display: "none",
  });
  imgEl.draggable = false;

  const placeholder = el(
    "div",
    { color: "#777", font: "11px sans-serif" },
    { textContent: "No source" }
  );

  const info = el(
    "div",
    {
      position: "absolute",
      left: "6px",
      bottom: "6px",
      maxWidth: "calc(100% - 12px)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      background: "rgba(0,0,0,0.55)",
      color: "#c8c8c8",
      font: "10px monospace",
      padding: "2px 4px",
      borderRadius: "2px",
      pointerEvents: "none",
      display: "none",
    }
  );

  container.appendChild(placeholder);
  container.appendChild(imgEl);
  container.appendChild(info);

  const widget = node.addDOMWidget(PREVIEW_WIDGET, "image", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, state.mode === "video" ? 0 : PREVIEW_MIN_H];

  state.imgEl = imgEl;
  state.placeholderEl = placeholder;
  state.infoEl = info;
  state.previewContainer = container;
  node.__vfxPreview = state;
  node.__vfxPreviewWidget = widget;
  return widget;
}

// Real <video controls loop> DOM widget — the mirror image of the still
// preview above; the two trade off which one is actually visible via
// state.mode, exactly like ComfyUI-VFX-Write's own preview/video pair.
// Replaces the old approach of showing movies as a flipbook of
// individually-fetched, 640x420-capped thumbnail frames — real playback,
// scrubbing, volume, and fullscreen all come from the browser now.
function buildVideoWidget(node) {
  const state = node.__vfxPreview;

  const container = el("div", {
    width: "100%",
    height: "100%",
    background: "#000",
    borderRadius: "4px",
    overflow: "hidden",
    display: "none",
  });

  const videoEl = document.createElement("video");
  videoEl.controls = true;
  videoEl.playsInline = true;
  Object.assign(videoEl.style, {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "contain",
    background: "#000",
  });

  container.appendChild(videoEl);

  const widget = node.addDOMWidget(VIDEO_WIDGET, "video", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, state.mode === "video" ? PREVIEW_MIN_H : 0];

  // Native controls stay on for fast drag-to-seek scanning (see the design
  // note above buildTransportWidget), so the video can also be played/
  // paused from there, not just our own row — keep our button's icon in
  // sync either way.
  videoEl.addEventListener("play", () => state.refreshTransportUI?.());
  videoEl.addEventListener("pause", () => state.refreshTransportUI?.());

  state.videoEl = videoEl;
  state.videoContainer = container;
  return widget;
}

// Drag-able scrub bar — sequences/stills have no native player, so this is
// their equivalent of video's own built-in seek bar. Dragging only moves
// the playhead (via showFrame), the same as every other scrub path in this
// file: never writes into the `frame` widget directly — only "Use Frame"
// does. Hidden in video mode (the native <video> already has one) AND for
// a single still frame (first === last — nothing to scrub). min/max and
// visibility both track first/last/mode via refreshScrub; its value is
// kept in sync with state.playhead from inside showFrame itself, so it
// follows playback, prev/next, and typing into `frame`, not just its own
// dragging.
function buildScrubWidget(node) {
  const state = node.__vfxPreview;

  const container = el("div", {
    width: "100%",
    display: "none",
    alignItems: "center",
  });

  const rangeEl = document.createElement("input");
  rangeEl.type = "range";
  rangeEl.min = "1";
  rangeEl.max = "1";
  rangeEl.step = "1";
  rangeEl.value = "1";
  Object.assign(rangeEl.style, {
    width: "100%",
    accentColor: "#8a8a8a",
    cursor: "pointer",
  });

  rangeEl.addEventListener("input", () => {
    const value = Number(rangeEl.value);
    if (!Number.isFinite(value)) return;
    state.playhead = value;
    showFrame(node, value);
  });

  container.appendChild(rangeEl);

  const widget = node.addDOMWidget(SCRUB_WIDGET, "scrub", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, state.scrubVisible ? SCRUB_H : 0];

  state.scrubEl = rangeEl;
  state.scrubContainer = container;
  return widget;
}

// Recomputes both the scrub bar's min/max (from first/last) and whether it
// should show at all (image mode, and an actual range to move through —
// see the design note on buildScrubWidget). Called wherever first/last or
// state.mode can change.
function refreshScrub(node) {
  const state = node.__vfxPreview;
  if (!state || !state.scrubEl) return;

  const first = numValue(node, "first", 1);
  const last = numValue(node, "last", first);
  state.scrubEl.min = String(Math.min(first, last));
  state.scrubEl.max = String(Math.max(first, last));

  const visible = state.mode !== "video" && first < last;
  state.scrubVisible = visible;
  if (state.scrubContainer) {
    state.scrubContainer.style.display = visible ? "flex" : "none";
  }
}

// state.videoEl/state.videoContainer are built ONCE by buildVideoWidget
// and persist for the node's lifetime — teardown/setup just hide/show and
// change the source, they don't create or destroy the element itself.
function teardownVideo(node, state) {
  state.mode = "image";
  if (state.videoEl) {
    state.videoEl.pause();
    state.videoEl.removeAttribute("src");
    state.videoEl.load();
  }
  if (state.videoContainer) state.videoContainer.style.display = "none";
  // computeSize()'s [width, 0] does NOT actually collapse a DOM widget's
  // wrapper under Node 2.0 (confirmed live this project — computeSize is
  // not respected for hiding). Explicit display toggling is required
  // either way; without it the image container would sit there as an
  // empty box above the video. The transport row itself no longer needs
  // this treatment — it stays visible in both modes now. The scrub bar's
  // own visibility is handled by refreshScrub (called right after this at
  // every call site) rather than unconditionally shown here — it should
  // only actually appear if there's a real range to scrub.
  if (state.previewContainer) state.previewContainer.style.display = "flex";
  state.refreshTransportUI?.();
}

function setupVideo(node, state, path) {
  if (!state.videoEl) return;
  state.mode = "video";
  if (state.previewContainer) state.previewContainer.style.display = "none";
  if (state.scrubContainer) state.scrubContainer.style.display = "none";
  // The transport row (play/prev/next/select/loop/fullscreen) now stays
  // visible for video too — see the design note above buildTransportWidget.
  state.videoEl.loop = state.loop;
  state.videoEl.src = videoUrl(path);
  state.videoEl.load();
  if (state.videoContainer) state.videoContainer.style.display = "block";
  state.refreshTransportUI?.();
}

// Rebuilds the small "1920x1080 - f42 - cache 6" info line and pushes the
// current frame into the visible <img>/placeholder. Called whenever what
// it displays could have changed (a new frame shown, cache toggled) since
// there's no per-frame draw() anymore to recompute it for free the way the
// old canvas version did.
function refreshPreviewInfo(node) {
  const state = node.__vfxPreview;
  if (!state) return;

  const img = state.img;

  if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
    state.imgEl.src = img.src;
    state.imgEl.style.display = "block";
    state.placeholderEl.style.display = "none";
  } else {
    state.imgEl.style.display = "none";
    state.placeholderEl.style.display = "block";
    state.placeholderEl.textContent = getWidget(node, "source_path")?.value
      ? "Loading preview..."
      : "No source";
  }

  const parts = [];
  if (state.srcW && state.srcH) parts.push(`${state.srcW}x${state.srcH}`);
  else if (state.naturalW && state.naturalH) {
    parts.push(`${state.naturalW}x${state.naturalH}`);
  }

  // Shows the playhead (what's actually on screen), not the `frame`
  // widget — the two are deliberately decoupled; see the design note on
  // buildPreviewWidget.
  if (getWidget(node, "source_path")?.value && state.playhead !== undefined && state.playhead !== null) {
    parts.push(`f${state.playhead}`);
  }

  if (state.cacheEnabled) {
    const cached = state.cache.map.size;
    if (cached) parts.push(`cache ${cached}`);
  } else {
    parts.push("cache off");
  }

  if (parts.length) {
    state.infoEl.textContent = parts.join(" - ");
    state.infoEl.style.display = "block";
  } else {
    state.infoEl.style.display = "none";
  }
}

// ---------------------------------------------------------------------------
// transport - real DOM buttons (play/prev/next/select/loop/cache/fps/
// fullscreen). Used to be a canvas type:"custom" widget with hand-rolled
// hit-testing; converted for two reasons: (1) canvas hit-testing through
// LiteGraph's own dispatch has already proven unreliable elsewhere in this
// project (ComfyUI-VFX-Write's old video/fullscreen buttons), and (2) live
// testing found Node 2.0 crashes this node's ENTIRE widgets section ("Node
// Widgets Error") when a canvas type:"custom" widget sits in the list
// alongside a DOM widget (buildPreviewWidget, above) \u2014 removing it
// was the fix. Write and Seq2Video have no canvas-drawn widgets left
// either, for the same reason.
//
// This row is now shared by both preview modes (it used to hide entirely
// in video mode, deferring to the native <video controls>). Native
// controls stay ON for video too, deliberately: dragging its own seek bar
// is still the fastest way to scan a long clip, and cross-browser there's
// no way to keep just that bar while hiding its built-in play/pause, so
// video ends up with two play/pause affordances (native + ours). Every
// button below branches on state.mode for what it actually does; Cache/FPS
// have no video equivalent (no per-frame fetch cache, no adjustable
// playback rate concept) and are hidden rather than shown-but-inert there.
// ---------------------------------------------------------------------------

function stepFrame(node, delta) {
  const state = node.__vfxPreview;
  if (!state) return;

  if (state.mode === "video") {
    const videoEl = state.videoEl;
    if (!videoEl) return;
    videoEl.pause();
    const fps = state.movieFps || DEFAULT_FPS;
    const duration = Number.isFinite(videoEl.duration) ? videoEl.duration : Infinity;
    videoEl.currentTime = Math.max(0, Math.min(duration, videoEl.currentTime + delta / fps));
    state.refreshTransportUI?.();
    return;
  }

  const first = numValue(node, "first", 1);
  const last = numValue(node, "last", first);
  const next = Math.min(Math.max((state.playhead ?? first) + delta, first), last);
  state.playhead = next;
  showFrame(node, next);
}

// The one and only place scrubbing/preview position gets committed to the
// actual `frame` input - see the playhead design note on buildPreviewWidget.
function selectCurrentFrame(node) {
  const state = node.__vfxPreview;
  if (!state) return;

  const first = numValue(node, "first", 1);
  const last = numValue(node, "last", first);

  if (state.mode === "video") {
    const videoEl = state.videoEl;
    if (!videoEl) return;
    const fps = state.movieFps || DEFAULT_FPS;
    const frame = Math.min(Math.max(first + Math.round(videoEl.currentTime * fps), first), last);
    setWidget(node, "frame", frame);
    return;
  }

  const frame = Math.min(Math.max(state.playhead ?? first, first), last);
  setWidget(node, "frame", frame);
}

function buildTransportWidget(node) {
  const state = node.__vfxPreview;
  const btn = smallBtn;

  function setActive(b, active) {
    b.style.background = active ? "#3a5a8a" : "#2c2c2c";
    b.style.borderColor = active ? "#6f9ad0" : "#4a4a4a";
  }

  const container = el("div", {
    width: "100%",
    display: "flex",
    gap: "4px",
    alignItems: "center",
  });

  const playBtn = btn("\u25B6", "Play/Pause");
  const prevBtn = btn("\u23EE", "Previous frame");
  const nextBtn = btn("\u23ED", "Next frame");
  const selectBtn = btn("Use Frame", "Set the frame parameter to whatever's currently shown");
  const loopBtn = btn("\u21BB", "Loop");
  const cacheBtn = btn("C", "Cache prefetch");
  const fpsBtn = btn(String(state.fps), "Playback FPS");
  const spacer = el("div", { flex: "1" });
  const fsBtn = btn("\u26F6", "Fullscreen");

  function refreshTransportUI() {
    const isPlaying = state.mode === "video" ? !!state.videoEl && !state.videoEl.paused : state.playing;
    playBtn.textContent = isPlaying ? "\u23F8" : "\u25B6";

    const loopActive = state.mode === "video" ? !!state.videoEl?.loop : state.loop;
    setActive(loopBtn, loopActive);
    setActive(cacheBtn, state.cacheEnabled);
    fpsBtn.textContent = String(state.fps);

    const seqOnly = state.mode !== "video";
    cacheBtn.style.display = seqOnly ? "" : "none";
    fpsBtn.style.display = seqOnly ? "" : "none";
  }

  playBtn.addEventListener("click", () => {
    if (state.mode === "video") {
      if (!state.videoEl) return;
      if (state.videoEl.paused) state.videoEl.play();
      else state.videoEl.pause();
    } else {
      togglePlay(node);
    }
    refreshTransportUI();
  });

  prevBtn.addEventListener("click", () => stepFrame(node, -1));
  nextBtn.addEventListener("click", () => stepFrame(node, 1));
  selectBtn.addEventListener("click", () => selectCurrentFrame(node));

  loopBtn.addEventListener("click", () => {
    state.loop = !state.loop;
    if (state.mode === "video" && state.videoEl) state.videoEl.loop = state.loop;
    refreshTransportUI();
  });

  cacheBtn.addEventListener("click", () => {
    state.cacheEnabled = !state.cacheEnabled;
    if (!state.cacheEnabled) cacheClear(state.cache);
    refreshTransportUI();
    refreshPreviewInfo(node);
  });

  fpsBtn.addEventListener("click", () => {
    const v = prompt("Playback FPS (1-120):", String(state.fps));
    if (v !== null) {
      state.fps = Math.max(1, Math.min(120, Number(v) || DEFAULT_FPS));
      refreshTransportUI();
    }
  });

  // Guarded so clicking Fullscreen a second time while already fullscreen
  // (the button is reparented into the video overlay too - see
  // openVideoFullscreen) closes it instead of trying to open a nested one.
  fsBtn.addEventListener("click", () => {
    if (state.fsOpen && state.closeFullscreen) {
      state.closeFullscreen();
      return;
    }
    openFullscreen(node);
  });

  refreshTransportUI();

  container.appendChild(playBtn);
  container.appendChild(prevBtn);
  container.appendChild(nextBtn);
  container.appendChild(selectBtn);
  container.appendChild(loopBtn);
  container.appendChild(cacheBtn);
  container.appendChild(fpsBtn);
  container.appendChild(spacer);
  container.appendChild(fsBtn);

  const widget = node.addDOMWidget(TRANSPORT_WIDGET, "transport", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, TRANSPORT_H];

  state.transportWidget = widget;
  state.transportContainer = container;
  state.refreshTransportUI = refreshTransportUI;
  return widget;
}

// ---------------------------------------------------------------------------
// display + prefetch
// ---------------------------------------------------------------------------

function showFrame(node, frame) {
  const state = node.__vfxPreview;
  if (!state) return;
  // Video mode has its own real element (buildVideoWidget) — nothing in
  // the small preview to fetch/update.
  if (state.mode === "video") return;

  // Keeps the drag-able scrub bar's thumb following whatever's actually
  // shown, regardless of what moved it (dragging it directly, prev/next,
  // playback, or typing into `frame`) — showFrame is the one place all of
  // those funnel through for sequence mode.
  if (state.scrubEl) state.scrubEl.value = String(frame);

  const src = getWidget(node, "source_path")?.value || "";
  if (!src) {
    state.img = null;
    state.naturalW = 0;
    state.naturalH = 0;
    refreshPreviewInfo(node);
    return;
  }

  if (state.cacheEnabled) {
    const entry = cacheRequest(state.cache, src, frame, (f) => {
      // Compare against the playhead, not the `frame` widget — the two
      // are deliberately decoupled now (see the design note above), and
      // this callback fires asynchronously after cacheRequest, by which
      // point playback/scrubbing may already be several frames further
      // along.
      if ((state.playhead ?? f) === f) applyEntry(node, state, src, f);
    });
    if (entry.ready) applyEntry(node, state, src, frame);
    prefetchAround(node, state, src, frame);
  } else {
    directFetch(node, state, src, frame);
  }

  node.setDirtyCanvas?.(true, true);
}

function directFetch(node, state, src, frame) {
  state.lastRequestedFrame = frame;

  // Only ever one request in flight at a time — a fast scrub/play burst
  // fires showFrame far faster than a round trip completes, and without
  // this every tick spawned its own Image() + request. The browser's
  // per-origin connection cap (6 for HTTP/1.1) then queued the backlog
  // behind whatever was already sent, so the preview kept "catching up"
  // through stale frames for a while after you stopped moving — confirmed
  // live: that's exactly why dragging felt instant only after leaving the
  // node idle long enough for that backlog to drain. Coalescing to the
  // single latest-wanted frame (instead of queuing every intermediate one)
  // keeps the preview's lag bounded to one round trip, continuously.
  if (state.directFetchBusy) {
    state.directFetchQueuedFrame = frame;
    return;
  }

  state.directFetchBusy = true;

  const img = new Image();
  img.decoding = "async";

  const finish = () => {
    state.directFetchBusy = false;
    const queued = state.directFetchQueuedFrame;
    state.directFetchQueuedFrame = null;
    if (queued !== null && queued !== frame) {
      directFetch(node, state, src, queued);
    }
  };

  img.addEventListener("load", () => {
    if (state.lastRequestedFrame === frame) {
      state.img = img;
      state.shownFrame = frame;
      state.naturalW = img.naturalWidth || 0;
      state.naturalH = img.naturalHeight || 0;
      refreshPreviewInfo(node);
    }
    finish();
  }, { once: true });
  img.addEventListener("error", () => {
    // keep last-shown frame visible
    finish();
  }, { once: true });
  img.src = thumbnailUrl(src, frame);
}

function applyEntry(node, state, src, frame) {
  const entry = cacheGet(state.cache, src, frame);
  if (!entry?.ready || !entry.img) return;

  state.img = entry.img;
  state.shownFrame = frame;
  state.naturalW = entry.img.naturalWidth || 0;
  state.naturalH = entry.img.naturalHeight || 0;
  refreshPreviewInfo(node);
}

function prefetchAround(node, state, src, frame) {
  const first = numValue(node, "first", frame);
  const last = numValue(node, "last", frame);

  for (let i = 1; i <= PREFETCH_AHEAD; i++) {
    const f = frame + i;
    if (f > last) break;
    cacheRequest(state.cache, src, f, null);
  }

  for (let i = 1; i <= PREFETCH_BEHIND; i++) {
    const f = frame - i;
    if (f < first) break;
    cacheRequest(state.cache, src, f, null);
  }
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------
// applyRange === true  : adopt the file's range (new source picked)
// applyRange === false : keep saved range, clamp it to the file (reload)

async function inspectAndApply(node, path, applyRange = true, forceStill = false) {
  const state = node.__vfxPreview;
  let info;
  try {
    info = await apiGet("/vfx-read/inspect", { path, force_still: forceStill ? 1 : undefined });
  } catch (e) {
    console.warn("VFX Read inspect failed", e);
    return;
  }

  const first = Number(info.source_first);
  const last = Number(info.source_last);

  if (applyRange) {
    if (Number.isFinite(first)) setWidget(node, "first", first);
    if (Number.isFinite(last)) setWidget(node, "last", last);
    if (Number.isFinite(first)) setWidget(node, "frame", first);
  } else {
    clampRangeToSource(node, first, last);
  }

  if (state) {
    const w = Number(info.width);
    const h = Number(info.height);
    if (w > 0 && h > 0) {
      state.srcW = w;
      state.srcH = h;
    }
  }

  if (state && info.source_type === "movie") {
    stopPlay(node);
    state.movieFps = Number(info.fps) > 0 ? Number(info.fps) : DEFAULT_FPS;
    setupVideo(node, state, info.source_path || path);
  } else {
    if (state) {
      teardownVideo(node, state);
      state.playhead = numValue(node, "frame", 1);
    }
    showFrame(node, numValue(node, "frame", 1));
  }

  // After the mode branch above, not before — visibility depends on the
  // now-current state.mode, not whatever it was before this inspect.
  refreshScrub(node);

  node.setDirtyCanvas?.(true, true);
  refreshVersionList(node);
}

// ---------------------------------------------------------------------------
// version picker
// ---------------------------------------------------------------------------

function setVersionSelectOptions(selectEl, labels) {
  selectEl.replaceChildren();
  for (const label of labels) {
    const o = document.createElement("option");
    o.value = label;
    o.textContent = label;
    selectEl.appendChild(o);
  }
}

async function refreshVersionList(node) {
  const state = node.__vfxPreview;
  const versionSelect = state?.versionSelect;
  if (!versionSelect) return;

  const path = getWidget(node, "source_path")?.value || "";

  if (!path) {
    setVersionSelectOptions(versionSelect, []);
    return;
  }

  let data;
  try {
    data = await apiGet("/vfx-read/versions", { path });
  } catch (_) {
    data = { versions: [] };
  }

  const versions = data.versions || [];
  node.__vfxReadVersions = versions;

  if (!versions.length) {
    setVersionSelectOptions(versionSelect, []);
    return;
  }

  const labels = versions.map((v) => `v${String(v.version).padStart(2, "0")}`);
  setVersionSelectOptions(versionSelect, labels);

  // Reflects whichever version source_path actually points at right now —
  // deliberately never jumps to "latest" on its own. Silently swapping
  // what's loaded is exactly the bug this feature exists to avoid (see the
  // design note on _version_info in nodes.py).
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const current = versions.find(
    (v) => v.path.replace(/\\/g, "/").toLowerCase() === normalized
  );

  versionSelect.value = current ? `v${String(current.version).padStart(2, "0")}` : "";
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------

function togglePlay(node) {
  const state = node.__vfxPreview;
  if (!state) return;
  state.playing ? stopPlay(node) : startPlay(node);
}

// Sequence mode only — video playback is the real <video> element's own
// play()/pause() (see the playBtn handler in buildTransportWidget). This
// advances state.playhead, never the `frame` widget — see the design note
// on buildPreviewWidget for why the two are deliberately decoupled.
function startPlay(node) {
  const state = node.__vfxPreview;
  if (!state || state.playing || state.mode === "video") return;
  if (!getWidget(node, "source_path")?.value) return;

  state.playing = true;
  state.lastTick = performance.now();
  state.acc = 0;
  node.setDirtyCanvas?.(true, true);

  const tick = (now) => {
    if (!state.playing) return;

    const fps = Math.max(1, Math.min(120, Number(state.fps) || DEFAULT_FPS));
    const step = 1000 / fps;
    state.acc += now - state.lastTick;
    state.lastTick = now;

    if (state.acc >= step) {
      const advance = Math.floor(state.acc / step);
      state.acc -= advance * step;

      const first = numValue(node, "first", 1);
      const last = numValue(node, "last", 1);
      let next = (state.playhead ?? first) + advance;

      if (next > last) {
        if (state.loop) {
          const span = Math.max(1, last - first + 1);
          next = first + ((next - first) % span);
        } else {
          state.playhead = last;
          showFrame(node, last);
          stopPlay(node);
          return;
        }
      }

      state.playhead = next;
      showFrame(node, next);
    }

    state.rafId = requestAnimationFrame(tick);
  };

  state.rafId = requestAnimationFrame(tick);
}

function stopPlay(node) {
  const state = node.__vfxPreview;
  if (!state) return;
  state.playing = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = 0;
  // Covers auto-stop at the end of range (not looping), which calls this
  // directly rather than through the play button's own click handler.
  state.refreshTransportUI?.();
}

// ---------------------------------------------------------------------------
// fullscreen review
// ---------------------------------------------------------------------------

function requestRealFullscreen(element) {
  const req = element.requestFullscreen || element.webkitRequestFullscreen;
  if (!req) return;
  try {
    const p = req.call(element);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

function exitRealFullscreen() {
  const inFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (!inFullscreen) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return;
  try {
    const p = exit.call(document);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

// Single entry point for the shared Fullscreen button — dispatches to
// whichever mode is actually active. See openImageFullscreen/
// openVideoFullscreen below.
function openFullscreen(node) {
  const state = node.__vfxPreview;
  if (!state) return;
  if (state.mode === "video") openVideoFullscreen(node, state);
  else openImageFullscreen(node, state);
}

// Direct port of ComfyUI-VFX-Write's own openFullscreen (real Fullscreen
// API, full-resolution source via /vfx-read/image, wheel-zoom, drag-pan) —
// see that file for the original design notes on why width/height:100%
// (not max-width/max-height) is required to let a small source scale UP
// to fill the screen, not just cap a large one.
function openImageFullscreen(node, state) {
  if (!state.img) return;

  const sourcePath = getWidget(node, "source_path")?.value;
  if (!sourcePath) return;

  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    background: "#000",
    zIndex: "10001",
    overflow: "hidden",
  });

  const viewport = el("div", {
    width: "100%",
    height: "100%",
    overflow: "hidden",
    cursor: "grab",
  });

  const img = el("img", {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    userSelect: "none",
    transformOrigin: "center center",
  });
  img.draggable = false;

  let lastFrame = state.playhead ?? numValue(node, "frame", 1);
  img.src = fullImageUrl(sourcePath, lastFrame);

  viewport.appendChild(img);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const MIN_SCALE = 1;
  const MAX_SCALE = 12;

  function applyTransform() {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    viewport.style.cursor = scale > 1 ? "grab" : "default";
  }

  function resetView() {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
  }

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      if (next === scale) return;
      scale = next;
      if (scale === MIN_SCALE) {
        tx = 0;
        ty = 0;
      }
      applyTransform();
    },
    { passive: false }
  );

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  viewport.addEventListener("mousedown", (e) => {
    if (scale <= MIN_SCALE) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = tx;
    panStartY = ty;
    viewport.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    tx = panStartX + (e.clientX - dragStartX);
    ty = panStartY + (e.clientY - dragStartY);
    applyTransform();
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    viewport.style.cursor = scale > 1 ? "grab" : "default";
  });

  viewport.addEventListener("dblclick", resetView);

  function sync() {
    // Keep showing whichever frame is currently previewed if it changes
    // (e.g. scrubbing/playing a sequence) while fullscreen is open — the
    // playhead, not the `frame` widget (deliberately decoupled; see the
    // design note on buildPreviewWidget).
    const current = state.playhead ?? lastFrame;
    if (current !== lastFrame) {
      lastFrame = current;
      img.src = fullImageUrl(sourcePath, lastFrame);
    }
  }

  const iv = setInterval(sync, 200);

  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(iv);
    exitRealFullscreen();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("webkitfullscreenchange", onFsChange);
    state.fsOpen = false;
    state.closeFullscreen = null;
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function onFsChange() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) close();
  }

  document.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  const closeBtn = el(
    "button",
    {
      position: "absolute",
      top: "12px",
      right: "12px",
      zIndex: "10002",
      background: "rgba(0,0,0,0.55)",
      color: "#eee",
      border: "1px solid #666",
      borderRadius: "4px",
      padding: "6px 10px",
      font: "12px sans-serif",
      cursor: "pointer",
    },
    { textContent: "✕ Close" }
  );
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });

  const hint = el("div", {
    position: "absolute",
    bottom: "12px",
    left: "12px",
    zIndex: "10002",
    background: "rgba(0,0,0,0.55)",
    color: "#ccc",
    borderRadius: "4px",
    padding: "4px 8px",
    font: "10px sans-serif",
    pointerEvents: "none",
  });
  hint.textContent = "Scroll to zoom · drag to pan · double-click to reset · Esc to close";

  overlay.appendChild(viewport);
  overlay.appendChild(closeBtn);
  overlay.appendChild(hint);
  document.body.appendChild(overlay);
  state.fsOpen = true;
  state.closeFullscreen = close;
  requestRealFullscreen(overlay);
}

// Video fullscreen: reparents the *existing* <video> element (and the
// shared transport row) into the overlay rather than creating a second
// video/second set of buttons — appendChild-ing an element elsewhere in
// the DOM preserves its playback position/state (no reload), and reusing
// the same transportContainer means every button (Play/Prev/Next/Select/
// Loop) keeps working fullscreen with zero duplicated logic. Both get
// moved back to their normal spot in the node on close.
function openVideoFullscreen(node, state) {
  const videoEl = state.videoEl;
  const transportEl = state.transportContainer;
  if (!videoEl || !transportEl) return;

  const videoOriginalParent = videoEl.parentElement;
  const videoOriginalNext = videoEl.nextSibling;
  const videoOriginalStyle = videoEl.getAttribute("style");

  const transportOriginalParent = transportEl.parentElement;
  const transportOriginalNext = transportEl.nextSibling;

  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    background: "#000",
    zIndex: "10001",
    display: "flex",
    flexDirection: "column",
  });

  const stage = el("div", {
    flex: "1 1 auto",
    minHeight: "0",
    position: "relative",
    overflow: "hidden",
    display: "flex",
  });

  Object.assign(videoEl.style, {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "contain",
    background: "#000",
  });
  stage.appendChild(videoEl);

  const barRow = el("div", {
    flex: "0 0 auto",
    padding: "6px 8px",
    background: "#181818",
    borderTop: "1px solid #333",
  });
  barRow.appendChild(transportEl);

  let closed = false;

  function restore() {
    if (videoOriginalStyle === null) videoEl.removeAttribute("style");
    else videoEl.setAttribute("style", videoOriginalStyle);
    videoOriginalParent.insertBefore(videoEl, videoOriginalNext);
    transportOriginalParent.insertBefore(transportEl, transportOriginalNext);
  }

  function close() {
    if (closed) return;
    closed = true;
    exitRealFullscreen();
    restore();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("webkitfullscreenchange", onFsChange);
    state.fsOpen = false;
    state.closeFullscreen = null;
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function onFsChange() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) close();
  }

  document.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  const closeBtn = el(
    "button",
    {
      position: "absolute",
      top: "12px",
      right: "12px",
      zIndex: "10002",
      background: "rgba(0,0,0,0.55)",
      color: "#eee",
      border: "1px solid #666",
      borderRadius: "4px",
      padding: "6px 10px",
      font: "12px sans-serif",
      cursor: "pointer",
    },
    { textContent: "✕ Close" }
  );
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });
  stage.appendChild(closeBtn);

  overlay.appendChild(stage);
  overlay.appendChild(barRow);
  document.body.appendChild(overlay);
  state.fsOpen = true;
  state.closeFullscreen = close;
  requestRealFullscreen(overlay);
}

// ---------------------------------------------------------------------------
// source browser
// ---------------------------------------------------------------------------

function buildBrowserDialog(node) {
  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.55)",
    zIndex: "10000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  const panel = el("div", {
    width: "min(760px, 90vw)",
    height: "min(560px, 85vh)",
    background: "#232323",
    border: "1px solid #444",
    borderRadius: "6px",
    display: "flex",
    flexDirection: "column",
    font: "12px sans-serif",
    color: "#ddd",
    overflow: "hidden",
  });

  const head = el("div", {
    flex: "0 0 auto",
    display: "flex",
    gap: "6px",
    padding: "8px",
    borderBottom: "1px solid #3a3a3a",
  });

  const pathInput = el("input", {
    flex: "1 1 auto",
    background: "#1a1a1a",
    border: "1px solid #444",
    color: "#ddd",
    padding: "4px 6px",
    borderRadius: "3px",
    font: "11px monospace",
  });

  // Enter already submits the typed path (see the keydown handler below),
  // so a separate "Go" button was pure duplication — removed. Back/
  // Forward/Up replace the old lone "Up" button; Up now reuses the
  // `parent` field the most recent load() already fetched instead of
  // re-requesting the current folder a second time just to read it.
  const backBtn = smallBtn("←", "Back");
  const forwardBtn = smallBtn("→", "Forward");
  const upBtn = smallBtn("↑", "Up one level");

  head.appendChild(pathInput);
  head.appendChild(backBtn);
  head.appendChild(forwardBtn);
  head.appendChild(upBtn);

  const list = el("div", { flex: "1 1 auto", overflowY: "auto", padding: "4px 0" });

  const foot = el("div", {
    flex: "0 0 auto",
    display: "flex",
    justifyContent: "flex-end",
    gap: "6px",
    padding: "8px",
    borderTop: "1px solid #3a3a3a",
  });

  const cancelBtn = el("button", null, { textContent: "Cancel" });
  foot.appendChild(cancelBtn);

  panel.appendChild(head);
  panel.appendChild(list);
  panel.appendChild(foot);
  overlay.appendChild(panel);

  let currentFolder = "";
  let currentParent = "";

  // Browser-style history: every successful navigation pushes (truncating
  // any forward entries first), except when the navigation IS a Back/
  // Forward action itself. requestGen guards against races when the user
  // clicks around faster than /vfx-read/list responds — a stale response
  // landing after a newer request has already started no longer touches
  // the DOM.
  let history = [];
  let historyIndex = -1;
  let requestGen = 0;

  function setNavEnabled(btn, enabled) {
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : "0.4";
    btn.style.cursor = enabled ? "pointer" : "default";
  }

  function updateNavButtons() {
    setNavEnabled(backBtn, historyIndex > 0);
    setNavEnabled(forwardBtn, historyIndex < history.length - 1);
    setNavEnabled(upBtn, !!currentParent && currentParent !== currentFolder);
  }

  function close() {
    overlay.remove();
  }

  function row(label, sub, onClick) {
    const r = el("div", {
      display: "flex",
      justifyContent: "space-between",
      gap: "10px",
      padding: "4px 10px",
      cursor: onClick ? "pointer" : "default",
      whiteSpace: "nowrap",
    });
    const a = el("div", { overflow: "hidden", textOverflow: "ellipsis" });
    a.textContent = label;
    const b = el("div", { color: "#8a8a8a", flex: "0 0 auto" });
    b.textContent = sub || "";
    r.appendChild(a);
    r.appendChild(b);
    if (onClick) {
      r.addEventListener("mouseenter", () => (r.style.background = "#2e2e2e"));
      r.addEventListener("mouseleave", () => (r.style.background = "transparent"));
      r.addEventListener("click", onClick);
    }
    list.appendChild(r);
    return r;
  }

  // Picking a NEW source adopts that file's full range.
  function pick(entry) {
    const state = node.__vfxPreview;
    stopPlay(node);
    if (state) {
      cacheClear(state.cache);
      state.srcW = 0;
      state.srcH = 0;
    }
    setWidget(node, "source_path", entry.path);
    close();
    inspectAndApply(node, entry.path, true);
  }

  async function load(dir, opts = {}) {
    const gen = ++requestGen;

    list.replaceChildren();
    row("Loading…", "", null);

    let data;
    try {
      data = await apiGet("/vfx-read/list", { path: dir || "" });
    } catch (e) {
      if (gen !== requestGen) return;
      list.replaceChildren();
      row(`Error: ${e.message}`, "", null);
      return;
    }

    if (gen !== requestGen) return;

    currentFolder = data.folder || "";
    currentParent = data.parent || "";
    pathInput.value = currentFolder;

    if (!opts.fromHistory) {
      history = history.slice(0, historyIndex + 1);
      history.push(currentFolder);
      historyIndex = history.length - 1;
    }
    updateNavButtons();

    list.replaceChildren();

    if (data.parent && data.parent !== currentFolder) {
      row(".. (parent)", "dir", () => load(data.parent));
    }

    for (const d of data.directories || []) {
      row(d.name, "dir", () => load(d.path));
    }

    for (const f of data.files || []) {
      const sub =
        f.kind === "sequence" ? `seq ${f.first}-${f.last}` : f.kind || "file";
      row(f.label || f.path, sub, () => pick(f));
    }

    if (!list.children.length) row("(empty)", "", null);
  }

  backBtn.addEventListener("click", () => {
    if (historyIndex <= 0) return;
    historyIndex--;
    load(history[historyIndex], { fromHistory: true });
  });
  forwardBtn.addEventListener("click", () => {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    load(history[historyIndex], { fromHistory: true });
  });
  upBtn.addEventListener("click", () => {
    if (currentParent && currentParent !== currentFolder) load(currentParent);
  });
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") load(pathInput.value);
  });
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Shields the dialog's own inputs from any document/window-level
  // keyboard shortcut handling (e.g. LiteGraph's own canvas copy/paste)
  // that would otherwise intercept keys like Ctrl+V before the browser's
  // native paste ever reaches pathInput. Runs on the bubble phase, so it
  // fires AFTER pathInput's own Enter-to-submit handler above (attached
  // directly to the input, so it always sees the event first) — this only
  // stops the event from propagating further OUT, past the dialog.
  overlay.addEventListener("keydown", (e) => e.stopPropagation());
  overlay.addEventListener("paste", (e) => e.stopPropagation());

  document.body.appendChild(overlay);
  load(getWidget(node, "source_path")?.value || "");
}

// ---------------------------------------------------------------------------
// watchers
// ---------------------------------------------------------------------------

function clampFrame(node) {
  const w = getWidget(node, "frame");
  if (!w) return;
  const first = numValue(node, "first", null);
  const last = numValue(node, "last", null);
  if (first === null || last === null) return;
  if (first > last) return;
  const cur = Number(w.value);
  if (!Number.isFinite(cur)) return;
  let next = cur;
  if (next < first) next = first;
  else if (next > last) next = last;
  if (next !== cur) setWidget(node, "frame", next);
}

// The frame widget can transiently read as non-numeric (e.g. mid-edit in
// Node 2.0's own input, or momentarily empty) — confirmed live: this used
// to call showFrame(node, NaN) unconditionally, which sent a literal
// "frame=NaN" to the backend and crashed the thumbnail route instead of
// just showing frame 1.
function onFrameChanged(node, v) {
  if (node.__vfxRestoring) return;
  const state = node.__vfxPreview;
  const first = numValue(node, "first", null);
  const last = numValue(node, "last", null);
  const num = Number(v);
  if (
    Number.isFinite(num) &&
    first !== null && last !== null && first <= last
  ) {
    if (num < first) { setWidget(node, "frame", first); return; }
    if (num > last) { setWidget(node, "frame", last); return; }
  }
  const target = Number.isFinite(num) ? num : 1;

  // Typing directly into `frame` (or clicking "Use Frame") moves the
  // preview to match — the one direction that stays linked. Scrubbing/
  // playback never writes back into `frame` on its own; see the design
  // note on buildPreviewWidget.
  if (state && state.mode === "video") {
    if (state.videoEl) {
      const fps = state.movieFps || DEFAULT_FPS;
      const baseFirst = first !== null ? first : 1;
      state.videoEl.currentTime = Math.max(0, (target - baseFirst) / fps);
    }
  } else {
    if (state) state.playhead = target;
    showFrame(node, target);
  }
}

// Typing a path by hand adopts that file's range. Suppressed during
// onConfigure restore so it cannot overwrite saved values.
function onSourcePathChanged(node, v) {
  if (node.__vfxRestoring) return;
  const state = node.__vfxPreview;
  stopPlay(node);
  if (state) {
    cacheClear(state.cache);
    state.srcW = 0;
    state.srcH = 0;
    state.img = null;
  }
  if (v) {
    // Consumed here rather than passed as a direct argument: source_path
    // changes funnel through this single dispatch point (typing, browse
    // pick, paste, restore) via setWidget's own change detection, so a
    // transient per-node flag is how the paste path — the only caller
    // that wants force_still — signals its intent without a second,
    // racing inspectAndApply call. See registerPasteListener.
    const forceStill = !!node.__vfxForceStillNextInspect;
    node.__vfxForceStillNextInspect = false;
    inspectAndApply(node, String(v), true, forceStill);
  } else {
    if (state) {
      teardownVideo(node, state);
      state.playhead = numValue(node, "frame", 1);
    }
    showFrame(node, numValue(node, "frame", 1));
    refreshScrub(node);
  }
}

function onRangeChanged(node) {
  if (node.__vfxRestoring) return;
  clampFrame(node);
  refreshScrub(node);
  node.setDirtyCanvas?.(true, true);
}

// ---------------------------------------------------------------------------
// paste image from clipboard
// ---------------------------------------------------------------------------
// Select a Read node, Ctrl+V a copied image, and it loads straight in —
// the same UX ComfyUI core's own LoadImage node has. Reuses core's own
// /upload/image route (the exact one LoadImage posts to — no reason to
// duplicate it) to save the pasted blob into ComfyUI's real input
// directory, then resolves the saved file's absolute path via this
// project's own /vfx-read/resolve-upload route (Read needs a real
// filesystem path for source_path, not the name+subfolder+type shape
// /upload/image returns), and sets that as source_path exactly like any
// other pick. Registered once, globally — there's nothing per-node about
// listening for paste; at paste time it just checks which Read node (if
// any) is currently selected.

function findSelectedReadNode() {
  const selected = app.canvas?.selected_nodes;
  if (!selected) return null;
  for (const n of Object.values(selected)) {
    if (n?.type === NODE_TYPE) return n;
  }
  return null;
}

async function uploadPastedImage(blob) {
  const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
  const form = new FormData();
  form.append("image", blob, `pasted_${Date.now()}.${ext}`);
  form.append("type", "input");

  const uploadRes = await fetch("/upload/image", { method: "POST", body: form });
  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${uploadRes.status} ${uploadRes.statusText}`);
  }
  const uploaded = await uploadRes.json();

  const resolved = await apiGet("/vfx-read/resolve-upload", {
    name: uploaded.name,
    subfolder: uploaded.subfolder || "",
    type: uploaded.type || "input",
  });
  return resolved.path;
}

let vfxReadPasteListenerRegistered = false;

function registerPasteListener() {
  if (vfxReadPasteListenerRegistered) return;
  vfxReadPasteListenerRegistered = true;

  // Capture phase, not bubble: ComfyUI core has its own paste handler
  // that creates a "Load Image" node from clipboard image data (attached
  // somewhere in the canvas/app layer, not necessarily document itself).
  // A bubble-phase listener on document fires AFTER any listener lower in
  // the tree has already run — confirmed live, this was exactly why a
  // stray LoadImage node kept appearing alongside the intended paste into
  // Read: preventDefault() alone was always too late. The capture phase
  // fires top-down, before any bubble-phase listener anywhere below,
  // guaranteeing this one sees the event first regardless of where
  // core's own listener lives — stopImmediatePropagation() (called
  // synchronously, before the async upload starts) then reliably stops
  // it from ever running.
  document.addEventListener(
    "paste",
    (e) => {
      // Don't hijack normal text paste — typing/pasting into the file
      // path field itself (or any other input on the page) should
      // behave normally. Only an image paste while a Read node is
      // selected (and no text field has focus) gets intercepted.
      const active = document.activeElement;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
        return;
      }

      const node = findSelectedReadNode();
      if (!node) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      let imageItem = null;
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          imageItem = item;
          break;
        }
      }
      if (!imageItem) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      const blob = imageItem.getAsFile();
      if (!blob) return;

      uploadPastedImage(blob)
        .then((path) => {
          // Pasted uploads all land in ComfyUI's shared input/ folder as
          // pasted_<timestamp>.png — two pastes made moments apart share
          // the exact filename shape sequence auto-detection groups by,
          // so without this a second paste got the first treated as
          // "frame 1 of 2" instead of two separate stills. See
          // onSourcePathChanged/inspectAndApply's force_still plumbing.
          node.__vfxForceStillNextInspect = true;
          setWidget(node, "source_path", path);
        })
        .catch((err) => console.error("VFX Read: paste-image upload failed", err));
    },
    true
  );
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "vfx.read.stage1",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    registerPasteListener();

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);

      // Establishes node.__vfxPreview (the shared state object every
      // build*/on*Changed function below reads/writes) before anything
      // else touches it.
      buildPreviewWidget(this);

      // Convert the execution-critical native widgets that get folded
      // into paired rows below into invisible DOM-backed carriers of the
      // same name FIRST, so the row builders can immediately read their
      // current (INPUT_TYPES-default) value. See the design note above
      // buildHiddenValue/replaceWithHiddenCarrier.
      for (const name of [
        "source_path", "frame", "first", "last",
        "before_range", "after_range", "missing_frames",
      ]) {
        replaceWithHiddenCarrier(this, name);
      }

      buildFileRow(this);
      buildParamsRow(this);

      buildVideoWidget(this);
      buildScrubWidget(this);
      buildTransportWidget(this);

      if (this.size[0] < MIN_NODE_W) this.size[0] = MIN_NODE_W;

      reorderWidgets(this);

      // Deterministic initial size — chrome + PREVIEW_DEFAULT_H — computed
      // directly rather than via a second this.computeSize() call (which
      // would read the still-stale this.size at this point). Previously
      // there was no explicit height here at all, leaving it to whatever
      // LiteGraph's own default-size settling happened to produce, which is
      // exactly what let the old self-referential computeSize() compound.
      const chrome = chromeOf(this);
      this.setSize([this.size[0], chrome + PREVIEW_DEFAULT_H]);

      setTimeout(() => {
        const initial = numValue(this, "frame", 1);
        if (this.__vfxPreview) this.__vfxPreview.playhead = initial;
        showFrame(this, initial);
        refreshScrub(this);
      }, 0);
      return r;
    };

    const onSerialize = nodeType.prototype.onSerialize;
    nodeType.prototype.onSerialize = function (o) {
      const r = onSerialize?.apply(this, arguments);
      try {
        o.vfx_read_values = collectValues(this);
      } catch (e) {
        console.error("VFX Read serialize failed", e);
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (o) {
      const r = onConfigure?.apply(this, arguments);

      reorderWidgets(this);

      // Just prime the chrome cache on this (freshly constructed) node
      // instance — deliberately NOT resizing here. The saved this.size
      // (the user's own prior resize, if any) is already correct as
      // restored; chromeOf only reads widgets' own computeSize(), never
      // this.size, so it can't disturb it.
      chromeOf(this);

      // Suppress watchers while assigning restored values, so the
      // source_path watcher cannot trigger a range-adopting inspect.
      this.__vfxRestoring = true;
      let clean;
      try {
        clean = applyValues(this, o?.vfx_read_values);
      } finally {
        this.__vfxRestoring = false;
      }

      // LiteGraph's own native onConfigure (called above, before this
      // block) already did its own classic positional widgets_values
      // restore on these DOM-backed carriers — direct .value assignment
      // works fine on them (same mechanism setWidget uses), so the values
      // land correctly, but that assignment happens outside setWidget(),
      // so refreshRowDisplays never ran for it. applyValues()'s own
      // setWidget() calls above then see "no change" (the value's already
      // there) and skip their own refreshRowDisplays call too — leaving
      // the row controls showing stale defaults despite the carriers
      // already holding the correct restored values. Confirmed live: this
      // is exactly why a reloaded node showed "1" in the first/last boxes
      // while the actual queued prompt already correctly had the restored
      // numbers. One unconditional catch-up call here covers both paths.
      refreshRowDisplays(this);

      setTimeout(() => {
        if (clean.source_path) {
          // applyRange false: saved frame/first/last win, clamped to file.
          inspectAndApply(this, clean.source_path, false);
        } else {
          if (this.__vfxPreview) this.__vfxPreview.playhead = clean.frame;
          showFrame(this, clean.frame);
          refreshScrub(this);
        }
      }, 0);

      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      stopPlay(this);
      if (this.__vfxPreview) {
        cacheClear(this.__vfxPreview.cache);
        this.__vfxPreview.videoEl?.pause();
      }
      this.__vfxPreview = null;
      this.__vfxPreviewWidget = null;
      return onRemoved?.apply(this, arguments);
    };

    // Manual escape hatch for a node that's ended up taller than its
    // content needs — whether from dragging it that way, or from restoring
    // an old saved size from before a layout fix. Keeps the current width
    // (a deliberate choice, e.g. to fit the six-control params row) and
    // only resets the height back to natural chrome + PREVIEW_DEFAULT_H.
    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = getExtraMenuOptions?.apply(this, arguments);
      const node = this;
      options.push({
        content: "Reset Size",
        callback: () => {
          node.__vfxReadChrome = undefined;
          const chrome = chromeOf(node);
          node.setSize([node.size[0], chrome + PREVIEW_DEFAULT_H]);
          node.setDirtyCanvas?.(true, true);
        },
      });
      return r;
    };
  },
});
