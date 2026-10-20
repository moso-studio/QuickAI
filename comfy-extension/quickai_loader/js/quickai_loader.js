import { app } from "../../../scripts/app.js";

// Default filename used when no recently-uploaded Photoshop snapshot is known.
const FALLBACK_SNAPSHOT_FILE = "quickai_ps_latest.png";
// localStorage key for the most recent filename pushed from the Photoshop plugin.
const LAST_UPLOAD_KEY = "quickai_last_uploaded_name";
// Cursor used to poll transfer-event logs incrementally.
let lastTransferEventId = 0;
// Per-tab client identifier used by bridge backend to isolate state across multiple Comfy tabs.
const BRIDGE_CLIENT_ID = (() => {
  const KEY = "quickai_bridge_client_id";
  const existing = (sessionStorage.getItem(KEY) || "").trim();
  if (existing) return existing;
  const generated = (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : `quickai_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem(KEY, generated);
  return generated;
})();

// Build a lookup order: most recent uploaded filename first, then fallback.
function getCandidateFilenames() {
  const last = (localStorage.getItem(LAST_UPLOAD_KEY) || "").trim();
  return last ? [last, FALLBACK_SNAPSHOT_FILE] : [FALLBACK_SNAPSHOT_FILE];
}

// Find the first candidate image that currently exists in Comfy input storage.
async function resolveExistingSnapshotFilename() {
  const candidates = getCandidateFilenames();

  for (const filename of candidates) {
    const res = await fetch(`/view?filename=${encodeURIComponent(filename)}&type=input`);
    if (res.ok) return filename;
  }

  throw new Error(`No snapshot found. Tried: ${candidates.join(", ")}`);
}

// LoadImage and LoadImageMask nodes both expose the selected file through an "image" widget.
function getLoadImageWidget(node) {
  if (!node) return null;
  return (node.widgets || []).find((w) => w && w.name === "image") || null;
}

// Set the widget value and force graph/canvas redraw so UI updates immediately.
function applyImageToNode(node, filename) {
  const widget = getLoadImageWidget(node);
  if (!widget) return false;

  widget.value = filename;
  if (typeof widget.callback === "function") widget.callback(filename);

  if (typeof node.setDirtyCanvas === "function") node.setDirtyCanvas(true, true);
  if (app.graph?.setDirtyCanvas) app.graph.setDirtyCanvas(true, true);
  return true;
}

// Generic helper: resolve snapshot file and apply to a specific node.
async function applySnapshotToNode(node) {
  const filename = await resolveExistingSnapshotFilename();
  const ok = applyImageToNode(node, filename);
  if (!ok) throw new Error("Selected node has no image widget.");
  return filename;
}

// Preferred source for output selection: Comfy sidebar's currently selected image.
function getSelectedOutputImageInfo() {
  const selected = app.extensionManager?.sidebarTab?.activeSidebarTab?.selectedImage;
  if (!selected) return null;

  const filename = selected.filename || selected.name || selected.file || "";
  const subfolder = selected.subfolder || "";
  const type = selected.type || "output";

  if (!filename) return null;
  return { filename, subfolder, type };
}

// Parse `/view?...` style URLs into the `{filename, subfolder, type}` object we send to Photoshop.
function parseImageUrlToOutputInfo(src) {
  try {
    const u = new URL(src, window.location.origin);
    const filename = u.searchParams.get("filename") || "";
    const subfolder = u.searchParams.get("subfolder") || "";
    const type = u.searchParams.get("type") || "output";
    if (!filename) return null;
    return { filename, subfolder, type };
  } catch (_e) {
    return null;
  }
}

// Normalize similarly-shaped objects coming from different Comfy internals.
function coerceOutputInfo(raw) {
  if (!raw) return null;

  const filename = (raw.filename || raw.name || raw.file || "").trim();
  if (!filename) return null;

  return {
    filename,
    subfolder: (raw.subfolder || "").trim(),
    type: (raw.type || "output").trim() || "output"
  };
}

// Walk image entries and return the first parsable output reference.
function getOutputInfoFromImageEntries(entries) {
  if (!Array.isArray(entries)) return null;

  for (const entry of entries) {
    if (!entry) continue;

    if (typeof entry === "string") {
      const fromUrl = parseImageUrlToOutputInfo(entry);
      if (fromUrl) return fromUrl;
      continue;
    }

    const fromObject = coerceOutputInfo(entry);
    if (fromObject) return fromObject;

    const src = entry.src || entry.currentSrc || "";
    if (!src) continue;
    const fromSrc = parseImageUrlToOutputInfo(src);
    if (fromSrc) return fromSrc;
  }

  return null;
}

// Fallback source for output selection: inspect selected node previews/outputs.
function getNodeOutputImageInfo(node) {
  if (!node) return null;

  // "videos" covers Comfy's native SaveVideo node output, which some Comfy versions
  // surface separately from the "images"/"imgs" preview arrays.
  const direct = getOutputInfoFromImageEntries(node.images)
    || getOutputInfoFromImageEntries(node.imgs)
    || getOutputInfoFromImageEntries(node.videos);
  if (direct) return direct;

  const outputs = Array.isArray(node.outputs) ? node.outputs : [];
  for (const output of outputs) {
    const nested = getOutputInfoFromImageEntries(output?.images)
      || getOutputInfoFromImageEntries(output?.imgs)
      || getOutputInfoFromImageEntries(output?.videos);
    if (nested) return nested;
  }

  return null;
}

// Iterate all selected nodes and take the first output image reference found.
function getSelectedNodeOutputImageInfo() {
  const selectedNodes = collectSelectedNodes();
  for (const node of selectedNodes) {
    const info = getNodeOutputImageInfo(node);
    if (info) return info;
  }
  return null;
}

// Send selected output metadata back to the Photoshop plugin host.
function sendOutputInfoToPlugin(info) {
  if (!info?.filename) throw new Error("Missing output filename.");
  const payload = {
    type: "quickai:selected-output",
    filename: info.filename,
    subfolder: info.subfolder || "",
    imageType: info.type || "output"
  };

  if (window.uxpHost && typeof window.uxpHost.postMessage === "function") {
    window.uxpHost.postMessage(payload);
    return;
  }

  window.parent.postMessage(payload, "*");
}

// Main "send selected output to Photoshop" action used by menu/button hooks.
function sendSelectedOutputToPlugin() {
  const info = getSelectedOutputImageInfo() || getSelectedNodeOutputImageInfo();
  if (!info) throw new Error("No selected output image/node output found.");
  postSelectionState().catch(() => {});
  sendOutputInfoToPlugin(info);
  return info;
}

// Unified toast helper so all status messages follow the same style and lifetime.
function showToast(severity, detail, options = {}) {
  const life = typeof options.life === "number"
    ? options.life
    : (severity === "error" ? 9000 : 4500);
  app.extensionManager.toast.add({
    severity,
    summary: "QuickAI",
    detail,
    life,
    sticky: false
  });
}

// Returns the live Comfy graph nodes in a stable order for export.
function getWorkflowNodes() {
  const graph = app.graph;
  if (!graph) return [];

  if (Array.isArray(graph._nodes) && graph._nodes.length > 0) {
    return [...graph._nodes].sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
  }

  const byId = graph._nodes_by_id;
  if (byId && typeof byId === "object") {
    return Object.values(byId)
      .filter(Boolean)
      .sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
  }

  return [];
}

// Picks the best available graph serialization method for the current Comfy version.
async function serializeCurrentGraph() {
  const graph = app.graph;
  if (!graph) return null;

  if (typeof graph.serialize === "function") {
    return await graph.serialize();
  }

  if (typeof app.graphToPrompt === "function") {
    const result = await app.graphToPrompt();
    if (result && typeof result === "object" && result.workflow) {
      return result.workflow;
    }
    return result;
  }

  return null;
}

// Extracts the API prompt payload from whichever Comfy serialization shape is available.
async function serializeApiPromptFromGraph() {
  const graph = app.graph;
  if (!graph) return null;

  if (typeof app.graphToPrompt === "function") {
    const result = await app.graphToPrompt();
    if (!result) return null;

    if (typeof result !== "object") return result;
    return result.output || result.prompt || result.workflow_api_json || result.workflow || result;
  }

  if (typeof graph.serializePrompt === "function") {
    return await graph.serializePrompt();
  }

  return await serializeCurrentGraph();
}

// Returns a concise, filesystem-safe workflow stem for exported files.
function buildWorkflowExportStem() {
  const title = String(document.title || "workflow").trim();
  const cleaned = title
    .replace(/\s*[-|]\s*ComfyUI.*$/i, "")
    .replace(/[^a-zA-Z0-9. _-]+/g, "_")
    .replace(/_+/g, "_")
    .trim();
  return cleaned || "workflow";
}

// Formats a widget value in a compact, human-readable way for the node-info text export.
function formatWidgetValue(widget) {
  if (!widget) return "";

  const value = widget.value;
  if (value === null || value === undefined || value === "") return "";

  if (Array.isArray(value)) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }

  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (_e) {
      return String(value);
    }
  }

  return String(value);
}

// Builds a short widget descriptor that includes the range/options metadata shown in the Info panel.
function describeWidget(widget) {
  if (!widget) return "unknown widget";

  const label = String(widget.label || widget.name || "unnamed").trim();
  const type = String(widget.type || widget.inputType || "value").trim();
  const value = formatWidgetValue(widget);
  const details = [];
  const options = widget.options && typeof widget.options === "object" ? widget.options : {};

  const min = Number.isFinite(Number(options.min)) ? Number(options.min) : Number.isFinite(Number(widget.min)) ? Number(widget.min) : null;
  const max = Number.isFinite(Number(options.max)) ? Number(options.max) : Number.isFinite(Number(widget.max)) ? Number(widget.max) : null;
  const step = Number.isFinite(Number(options.step)) ? Number(options.step) : Number.isFinite(Number(widget.step)) ? Number(widget.step) : null;

  if (min !== null || max !== null || step !== null) {
    const rangeBits = [];
    if (min !== null) rangeBits.push(`min=${min}`);
    if (max !== null) rangeBits.push(`max=${max}`);
    if (step !== null) rangeBits.push(`step=${step}`);
    details.push(rangeBits.join(", "));
  }

  const optionList = Array.isArray(options.values)
    ? options.values
    : Array.isArray(options.options)
      ? options.options
      : Array.isArray(widget.options)
        ? widget.options
        : null;
  if (optionList && optionList.length > 0) {
    const preview = optionList.slice(0, 20).map((item) => String(item)).join(", ");
    details.push(`options=[${preview}${optionList.length > 20 ? ", ..." : ""}]`);
  }

  if (options.default !== undefined) {
    details.push(`default=${JSON.stringify(options.default)}`);
  } else if (widget.defaultValue !== undefined) {
    details.push(`default=${JSON.stringify(widget.defaultValue)}`);
  }

  if (value) {
    details.unshift(`value=${JSON.stringify(value)}`);
  }

  return `${label} (${type}${details.length > 0 ? `, ${details.join(", ")}` : ""})`;
}

// Builds a readable per-node export that mirrors the workflow info panel content as closely as possible.
function buildWorkflowNodeInfoText() {
  const nodes = getWorkflowNodes();
  const lines = [];
  lines.push(`# QuickAI node export`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Workflow title: ${String(document.title || "workflow").trim() || "workflow"}`);
  lines.push(`Node count: ${nodes.length}`);

  for (const node of nodes) {
    const nodeId = node?.id !== undefined && node?.id !== null ? String(node.id) : "?";
    const nodeName = String(node?.title || node?.comfyClass || node?.type || `Node ${nodeId}`).trim();
    const nodeType = String(node?.comfyClass || node?.type || node?.constructor?.name || "Unknown").trim();
    lines.push("");
    lines.push(`- ${nodeId}: ${nodeName} [${nodeType}]`);

    const inputs = Array.isArray(node?.inputs) ? node.inputs : [];
    if (inputs.length > 0) {
      lines.push("  Inputs:");
      for (const input of inputs) {
        const inputName = String(input?.name || input?.label || "unnamed").trim();
        const inputType = String(input?.type || "unknown").trim();
        const linked = input && input.link !== undefined && input.link !== null ? "linked" : "unlinked";
        lines.push(`  - ${inputName} (${inputType}, ${linked})`);
      }
    }

    const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
    if (widgets.length > 0) {
      lines.push("  Widgets:");
      for (const widget of widgets) {
        lines.push(`  - ${describeWidget(widget)}`);
      }
    }

    const properties = node?.properties && typeof node.properties === "object" ? node.properties : null;
    if (properties && Object.keys(properties).length > 0) {
      lines.push("  Properties:");
      for (const [key, value] of Object.entries(properties)) {
        if (value === undefined) continue;
        lines.push(`  - ${key}: ${JSON.stringify(value)}`);
      }
    }
  }

  if (nodes.length < 1) {
    lines.push("");
    lines.push("No nodes were found in the active graph.");
  }

  return lines.join("\n");
}

// Triggers a browser download of a Blob.
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// --- Minimal ZIP builder (STORE, no compression) ---

// CRC-32 lookup table.
const _CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function _crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = _CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _u16(view, off, v) { view.setUint16(off, v, true); }
function _u32(view, off, v) { view.setUint32(off, v, true); }

function _localHeader(nameBytes, size, crc) {
  const b = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(b.buffer);
  _u32(v, 0, 0x04034b50); _u16(v, 4, 20); _u16(v, 6, 0); _u16(v, 8, 0);
  _u16(v, 10, 0); _u16(v, 12, 0); _u32(v, 14, crc);
  _u32(v, 18, size); _u32(v, 22, size);
  _u16(v, 26, nameBytes.length); _u16(v, 28, 0);
  b.set(nameBytes, 30);
  return b;
}

function _centralHeader(nameBytes, size, crc, localOffset) {
  const b = new Uint8Array(46 + nameBytes.length);
  const v = new DataView(b.buffer);
  _u32(v, 0, 0x02014b50); _u16(v, 4, 20); _u16(v, 6, 20); _u16(v, 8, 0); _u16(v, 10, 0);
  _u16(v, 12, 0); _u16(v, 14, 0); _u32(v, 16, crc);
  _u32(v, 20, size); _u32(v, 24, size);
  _u16(v, 28, nameBytes.length); _u16(v, 30, 0); _u16(v, 32, 0);
  _u16(v, 34, 0); _u16(v, 36, 0); _u32(v, 38, 0); _u32(v, 42, localOffset);
  b.set(nameBytes, 46);
  return b;
}

function _eocd(count, cdSize, cdOffset) {
  const b = new Uint8Array(22);
  const v = new DataView(b.buffer);
  _u32(v, 0, 0x06054b50); _u16(v, 4, 0); _u16(v, 6, 0);
  _u16(v, 8, count); _u16(v, 10, count);
  _u32(v, 12, cdSize); _u32(v, 16, cdOffset); _u16(v, 20, 0);
  return b;
}

// Builds a ZIP Blob containing files inside a named folder.
// files: [{name: string, text: string}]
function buildZipBlob(folderName, files) {
  const enc = new TextEncoder();
  const entries = files.map(f => {
    const data = enc.encode(f.text);
    const path = folderName ? `${folderName}/${f.name}` : f.name;
    return { path: enc.encode(path), data, crc: _crc32(data) };
  });

  const locals = [];
  const offsets = [];
  let offset = 0;
  for (const e of entries) {
    const header = _localHeader(e.path, e.data.length, e.crc);
    offsets.push(offset);
    locals.push(header, e.data);
    offset += header.length + e.data.length;
  }

  const cdOffset = offset;
  const centrals = entries.map((e, i) => _centralHeader(e.path, e.data.length, e.crc, offsets[i]));
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = _eocd(entries.length, cdSize, cdOffset);

  const parts = [...locals, ...centrals, eocd];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return new Blob([out], { type: "application/zip" });
}

// --- End ZIP builder ---

// Saves the current workflow as a ZIP archive containing a named folder with all export files.
async function exportWorkflowBundle(baseName) {
  const normalWorkflow = await serializeCurrentGraph();
  const apiWorkflow = await serializeApiPromptFromGraph();
  if (!normalWorkflow && !apiWorkflow) {
    throw new Error("No active workflow graph found.");
  }

  const safeBaseName = sanitizeWorkflowExportBaseName(baseName) || buildWorkflowExportStem();
  const apiJson = JSON.stringify(apiWorkflow || normalWorkflow, null, 2);
  const uiJson = JSON.stringify(normalWorkflow || apiWorkflow, null, 2);
  const infoText = buildWorkflowNodeInfoText();

  const zip = buildZipBlob("", [
    { name: `${safeBaseName}.json`, text: apiJson },
    { name: `${safeBaseName}_UI.json`, text: uiJson },
    { name: `${safeBaseName}_metadata.txt`, text: infoText }
  ]);
  downloadBlob(`${safeBaseName}.quickai`, zip);
  return { mode: "directory", baseName: safeBaseName, folderName: safeBaseName };
}

// Builds the visible export button used to launch the workflow export.
function createExportButton() {
  const button = document.createElement("button");
  button.id = "quickaiWorkflowExportButton";
  button.type = "button";
  button.textContent = "QuickAI Export";
  button.title = "Save the current workflow as normal JSON, API JSON, and a node-info text file.\nNames of nodes should start with '@' to show up in the Import Workflow panel.";
  button.style.display = "block";
  button.style.width = "100%";
  button.style.boxSizing = "border-box";
  button.style.padding = "6px 10px";
  button.style.border = "0";
  button.style.borderRadius = "0";
  button.style.background = "transparent";
  button.style.color = "inherit";
  button.style.font = "inherit";
  button.style.textAlign = "left";
  button.style.cursor = "pointer";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await runExportWorkflowAction(button);
  });
  return button;
}

// Builds a compact button matching ComfyUI's native "comfyui-button" styling (see
// scripts/ui/menu/menu.css), used when attaching to app.menu rather than the floating
// top-right fallback — that button is styled for a full-width dropdown/menu-item look
// instead, which doesn't fit a horizontal button-group row.
function createMenuGroupExportButton() {
  const button = document.createElement("button");
  button.id = "quickaiWorkflowExportButton";
  button.type = "button";
  button.className = "comfyui-button";
  button.textContent = "QuickAI Export";
  button.title = "Save the current workflow as normal JSON, API JSON, and a node-info text file.\nNames of nodes should start with '@' to show up in the Import Workflow panel.";
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await runExportWorkflowAction(button);
  });
  return button;
}

// Attaches the export button to app.menu.actionsGroup — ComfyUI's own officially
// maintained extension point for legacy custom-script topbar UI. TopMenuSection.vue
// mounts app.menu.element into a dedicated container in the topbar unconditionally at
// page load, regardless of whether other topbar buttons (Extensions, the properties
// panel toggle, etc.) exist or are visible, so this doesn't need DOM searching, cloning
// another button's styles, polling, or a MutationObserver to survive Vue re-renders.
// Returns true if the button was (or already is) installed this way.
function installLegacyMenuExportButton() {
  if (document.getElementById("quickaiWorkflowExportButton")) return true;
  const actionsGroup = app?.menu?.actionsGroup;
  if (!actionsGroup || typeof actionsGroup.append !== "function") return false;
  actionsGroup.append(createMenuGroupExportButton());
  return true;
}

// Prompts once for the workflow base name used across all export files.
function promptForWorkflowExportBaseName() {
  const fallback = buildWorkflowExportStem();
  const raw = window.prompt("Workflow name", fallback);
  if (raw === null) return "";
  return sanitizeWorkflowExportBaseName(raw);
}

// Normalizes user-entered file names into something safe for filesystem use.
function sanitizeWorkflowExportBaseName(raw) {
  return String(raw || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Runs the export action and updates the menu item label while it is busy.
async function runExportWorkflowAction(button) {
  const originalText = button?.textContent || "QuickAI Export";
  if (button) {
    button.disabled = true;
    button.textContent = "Exporting...";
  }
  try {
    const baseName = promptForWorkflowExportBaseName();
    if (!baseName) {
      if (button) button.textContent = originalText;
      return;
    }
    const result = await exportWorkflowBundle(baseName);
    if (button) {
      button.textContent = "Exported";
    }
    if (result.mode !== "cancelled") {
      showToast("success", `Workflow export ${result.mode === "directory" ? "saved to folder" : "downloaded"}.`);
    }
  } catch (error) {
    if (button) {
      button.textContent = "Export Failed";
    }
    showToast("error", `Workflow export failed: ${String(error?.message || error)}`);
  } finally {
    setTimeout(() => {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }, 1400);
  }
}

// Finds the visible Extensions control so the export button can sit beside a stable top-bar action.
function findExtensionsButton() {
  const candidates = Array.from(document.querySelectorAll("button, [role='button']"));
  return candidates.find((button) => {
    const text = String(button.textContent || "").trim().toLowerCase();
    const label = String(button.getAttribute("aria-label") || button.getAttribute("title") || "").trim().toLowerCase();
    return text === "extensions" || label === "extensions" || label.includes("extensions");
  }) || null;
}

// Places the export button in a cloned menu-item container beside Extensions when possible,
// with a fixed top-right fallback when the top bar structure is not found.
function installMainMenuExportButton() {
  if (!document.body) return;

  // The wrapper mirrors the Extensions button's own parent container so it blends in
  // as a native-looking top-bar menu item regardless of ComfyUI version styling.
  let wrapper = document.getElementById("quickaiWorkflowExportAnchor");
  if (!(wrapper instanceof HTMLElement)) {
    const button = createExportButton();
    // Match the Extensions button's computed appearance so our button blends in.
    const extBtn = findExtensionsButton();
    if (extBtn instanceof HTMLElement) {
      const cs = window.getComputedStyle(extBtn);
      button.style.background = cs.backgroundColor || cs.background || "";
      button.style.color = cs.color || "";
      button.style.fontSize = cs.fontSize || "";
      button.style.fontWeight = cs.fontWeight || "";
      button.style.height = cs.height || "";
      button.style.padding = cs.padding || "";
      button.style.borderRadius = cs.borderRadius || "";
      button.style.border = cs.border || "";
      button.style.boxShadow = cs.boxShadow || "";
    } else {
      // Fallback if Extensions button not found yet.
      button.style.borderRadius = "6px";
      button.style.background = "rgba(255,255,255,0.1)";
      button.style.color = "inherit";
      button.style.fontSize = "12px";
      button.style.fontWeight = "500";
      button.style.height = "30px";
      button.style.padding = "0 12px";
      button.style.boxShadow = "none";
    }
    button.style.textAlign = "center";
    button.style.minWidth = "120px";

    wrapper = document.createElement("div");
    wrapper.id = "quickaiWorkflowExportAnchor";
    wrapper.style.pointerEvents = "auto";
    wrapper.style.display = "block";
    wrapper.style.position = "fixed";
    wrapper.style.zIndex = "100000";
    wrapper.appendChild(button);
    document.body.appendChild(wrapper);
  }

  const extensionsButton = findExtensionsButton();
  if (extensionsButton instanceof HTMLElement && extensionsButton.parentElement instanceof HTMLElement) {
    const extensionsItem = extensionsButton.parentElement;
    const menuBar = extensionsItem.parentElement;

    if (menuBar instanceof HTMLElement) {
      // Clone the Extensions item's container so our entry inherits the same
      // tag, classes, and inline styles used for every native top-bar item.
      let menuItem = document.getElementById("quickaiWorkflowExportMenuItem");
      if (!(menuItem instanceof HTMLElement)) {
        menuItem = extensionsItem.cloneNode(false);
        menuItem.id = "quickaiWorkflowExportMenuItem";
        // Remove any children that cloneNode(false) may not copy but ensure cleanliness.
        while (menuItem.firstChild) menuItem.removeChild(menuItem.firstChild);
        menuItem.appendChild(wrapper);
      }

      if (menuItem.parentElement !== menuBar || menuItem.previousElementSibling !== extensionsItem) {
        extensionsItem.insertAdjacentElement("afterend", menuItem);
      }

      // Switch wrapper to inline flow inside the cloned menu item.
      wrapper.style.position = "relative";
      wrapper.style.top = "auto";
      wrapper.style.left = "auto";
      wrapper.style.right = "auto";
      wrapper.style.zIndex = "auto";
      wrapper.style.display = "inline-flex";
      wrapper.style.alignItems = "center";
      wrapper.style.padding = "0";
      wrapper.style.border = "0";
      wrapper.style.borderRadius = "0";
      wrapper.style.background = "transparent";
      wrapper.style.boxShadow = "none";
      wrapper.style.visibility = "visible";
      return;
    }
  }

  // Fallback: floating panel in the top-right corner.
  if (wrapper.parentElement !== document.body) {
    document.body.appendChild(wrapper);
  }
  wrapper.style.top = "12px";
  wrapper.style.right = "12px";
  wrapper.style.left = "auto";
  wrapper.style.position = "fixed";
  wrapper.style.zIndex = "100000";
  wrapper.style.display = "block";
  wrapper.style.padding = "6px";
  wrapper.style.border = "1px solid rgba(255,255,255,0.16)";
  wrapper.style.borderRadius = "8px";
  wrapper.style.background = "rgba(16,18,24,0.9)";
  wrapper.style.boxShadow = "0 10px 24px rgba(0,0,0,0.28)";
  wrapper.style.visibility = "visible";
}

// Node type checks used when we auto-apply incoming images/masks.
function isLoadImageNode(node) {
  return !!node && (node.comfyClass === "LoadImage" || node.type === "LoadImage");
}

// Check whether node is a LoadImageMask node.
function isLoadImageMaskNode(node) {
  return !!node && (node.comfyClass === "LoadImageMask" || node.type === "LoadImageMask");
}

// Collect selected nodes from several Comfy selection surfaces and dedupe by id.
function collectSelectedNodes() {
  const out = [];
  const seen = new Set();
  const push = (node) => {
    if (!node || seen.has(node.id)) return;
    seen.add(node.id);
    out.push(node);
  };

  const canvasSel = app.canvas?.selected_nodes;
  if (Array.isArray(canvasSel)) {
    for (const n of canvasSel) push(n);
  } else if (canvasSel && typeof canvasSel === "object") {
    for (const n of Object.values(canvasSel)) push(n);
  }

  const graphById = app.graph?._nodes_by_id;
  if (graphById && typeof graphById === "object") {
    for (const n of Object.values(graphById)) {
      if (n?.flags?.selected) push(n);
    }
  }

  push(app.canvas?.selected_node);
  push(app.canvas?.node_over);

  return out;
}

// First selected LoadImage node is the target for regular image apply.
function getSelectedLoadImageNode() {
  const selected = collectSelectedNodes();
  for (const node of selected) {
    if (isLoadImageNode(node)) return node;
  }
  return null;
}

// First selected LoadImageMask node is the target for mask apply.
function getSelectedLoadImageMaskNode() {
  const selected = collectSelectedNodes();
  for (const node of selected) {
    if (isLoadImageMaskNode(node)) return node;
  }
  return null;
}

// Push current UI selection state to backend so Photoshop-side actions can target the right nodes/images.
async function postSelectionState() {
  const output = getSelectedOutputImageInfo() || getSelectedNodeOutputImageInfo() || {
    filename: "",
    subfolder: "",
    type: "output"
  };
  const loadNode = getSelectedLoadImageNode();
  const loadMaskNode = getSelectedLoadImageMaskNode();

  await fetch("/quickai/selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: BRIDGE_CLIENT_ID,
      is_visible: document.visibilityState !== "hidden",
      has_focus: typeof document.hasFocus === "function" ? document.hasFocus() : false,
      selected_output: output,
      selected_loadimage_node_id: loadNode ? loadNode.id : null,
      selected_loadimagemask_node_id: loadMaskNode ? loadMaskNode.id : null
    })
  });
}

// Report the outcome of an apply request back to the server so the Photoshop plugin can tell
// the user whether the image landed. No-op for requests without an id (older plugin builds).
async function postApplyResult(requestId, result) {
  if (!requestId) return;
  try {
    await fetch("/quickai/apply-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request_id: requestId, ...result })
    });
  } catch (_e) {
    // Best-effort; the plugin times out and reports "no response" on its own.
  }
}

// Pull one-shot "apply this image now" requests created by the Photoshop side.
async function pullPendingApplyRequest() {
  try {
    const res = await fetch(`/quickai/pending-apply?client_id=${encodeURIComponent(BRIDGE_CLIENT_ID)}`);
    if (!res.ok) return;
    const data = await res.json();
    const filename = (data?.filename || "").trim();
    const maskFilename = (data?.mask_filename || "").trim();
    const requestId = (data?.request_id || "").trim();
    if (!filename && !maskFilename) return;

    const loadNode = getSelectedLoadImageNode();
    const loadMaskNode = getSelectedLoadImageMaskNode();
    // Node ids the image/mask was actually applied to, and the first failure (if any).
    const appliedNodeIds = [];
    let errorMessage = "";

    if (filename && loadNode) {
      try {
        const applied = await applySnapshotToSelectedLoadImage(filename);
        appliedNodeIds.push(applied.nodeId);
      } catch (e) {
        errorMessage = errorMessage || String(e?.message || e);
        showToast("error", `PS -> Comfy: Failed to apply image ${filename}. ${String(e?.message || e)}`);
      }
    }
    const filenameForMaskNode = maskFilename || filename;
    if (filenameForMaskNode && loadMaskNode) {
      try {
        const applied = await applySnapshotToSelectedLoadImageMask(filenameForMaskNode);
        appliedNodeIds.push(applied.nodeId);
      } catch (e) {
        errorMessage = errorMessage || String(e?.message || e);
        if (maskFilename) {
          showToast("error", `PS -> Comfy: Failed to apply mask ${filenameForMaskNode}. ${String(e?.message || e)}`);
        } else {
          showToast("error", `PS -> Comfy: Failed to apply image ${filenameForMaskNode} to LoadImageMask. ${String(e?.message || e)}`);
        }
      }
    }
    await fetch(`/quickai/pending-apply/ack?client_id=${encodeURIComponent(BRIDGE_CLIENT_ID)}`, { method: "POST" });

    if (appliedNodeIds.length > 0) {
      await postApplyResult(requestId, { status: "applied", node_ids: appliedNodeIds });
    } else if (!loadNode && !loadMaskNode) {
      await postApplyResult(requestId, { status: "no_node" });
    } else {
      await postApplyResult(requestId, { status: "error", message: errorMessage });
    }
  } catch (e) {
    // Comfy restarts can briefly break this polling request; keep it silent to avoid toast spam.
  }
}

// Poll transfer history to advance cursor; intentionally no toasts to avoid UI noise.
async function pullTransferEvents() {
  try {
    const res = await fetch(`/quickai/transfer-events?since_id=${encodeURIComponent(String(lastTransferEventId))}`);
    if (!res.ok) return;
    const data = await res.json();
    const events = Array.isArray(data?.events) ? data.events : [];

    for (const evt of events) {
      if (!evt || typeof evt.id !== "number") continue;
      if (evt.id > lastTransferEventId) lastTransferEventId = evt.id;
    }

    if (typeof data?.last_id === "number" && data.last_id > lastTransferEventId) {
      lastTransferEventId = data.last_id;
    }
  } catch (_e) {}
}

// Apply a resolved/forced filename to currently selected LoadImage node.
async function applySnapshotToSelectedLoadImage(forcedFilename) {
  const node = getSelectedLoadImageNode();
  if (!node) throw new Error("No selected LoadImage node in Comfy.");

  const filename = forcedFilename || await resolveExistingSnapshotFilename();
  const ok = applyImageToNode(node, filename);
  if (!ok) throw new Error("Selected LoadImage node has no image widget.");
  return { filename, nodeId: node.id };
}

// Apply filename to selected LoadImageMask node and default mask channel to red.
async function applySnapshotToSelectedLoadImageMask(forcedFilename) {
  const node = getSelectedLoadImageMaskNode();
  if (!node) throw new Error("No selected LoadImageMask node in Comfy.");

  const filename = forcedFilename || await resolveExistingSnapshotFilename();
  const ok = applyImageToNode(node, filename);
  if (!ok) throw new Error("Selected LoadImageMask node has no image widget.");

  const channelWidget = (node.widgets || []).find((w) => w && w.name === "channel");
  if (channelWidget) {
    channelWidget.value = "red";
    if (typeof channelWidget.callback === "function") channelWidget.callback("red");
  }

  return { filename, nodeId: node.id };
}

// Receive runtime messages from plugin host/UI and execute requested actions.
window.addEventListener("message", (event) => {
  const data = event?.data;
  if (!data) return;

  if (data.type === "quickai:uploaded-image") {
    const filename = (data.filename || "").trim();
    if (filename) localStorage.setItem(LAST_UPLOAD_KEY, filename);
    return;
  }

  if (data.type === "quickai:apply-to-selected-loadimage") {
    const filename = (data.filename || "").trim();
    applySnapshotToSelectedLoadImage(filename)
      .then(() => {})
      .catch((err) => {
        showToast("error", String(err?.message || err));
      });
    return;
  }

  if (data.type === "quickai:request-selected-output") {
    try {
      const info = getSelectedOutputImageInfo() || getSelectedNodeOutputImageInfo();
      if (!info) throw new Error("No selected output image/node output found.");
      sendOutputInfoToPlugin(info);
    } catch (err) {
      showToast("error", String(err?.message || err));
    }
  }
});

function startMainMenuExportButtonPolling() {
  installMainMenuExportButton();
  // Attach the re-insert observer immediately, regardless of whether the Extensions
  // button exists yet. Previously this was only attached once findExtensionsButton()
  // succeeded below, which meant that when the Extensions toolbar is absent (disabled,
  // or not present in this ComfyUI theme/version), nothing ever watched for Vue
  // re-renders wiping out the floating top-right fallback button installed just above —
  // it would appear once at load and then silently vanish on the next re-render.
  attachBodyObserver();
  if (window.__quickaiMainMenuHookPoll) return;

  // Fallback interval for the initial mount — keeps trying until the Extensions
  // button exists so installMainMenuExportButton can anchor to it.
  window.__quickaiMainMenuHookPoll = window.setInterval(() => {
    if (findExtensionsButton()) {
      installMainMenuExportButton();
      window.clearInterval(window.__quickaiMainMenuHookPoll);
      window.__quickaiMainMenuHookPoll = 0;
    }
  }, 500);
}

// Observe document.body for any DOM mutations and immediately re-insert our menu
// item if ComfyUI's Vue re-render removed it. Fires in the same microtask as the
// removal so there is no visible gap from the user's perspective.
function attachBodyObserver() {
  if (window.__quickaiBodyObserver) return;

  let scheduled = false;
  const observer = new MutationObserver(() => {
    // Debounce to one reinstall per animation frame — avoids hammering during
    // large Vue patch cycles that fire many mutations in rapid succession.
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const menuItem = document.getElementById("quickaiWorkflowExportMenuItem");
      const extBtn = findExtensionsButton();
      const menuBar = extBtn?.parentElement?.parentElement;
      if (!menuItem || (menuBar && menuItem.parentElement !== menuBar)) {
        installMainMenuExportButton();
      }
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
  window.__quickaiBodyObserver = observer;
}

// Push immediate focus/visibility heartbeat so backend can target the truly active Comfy instance.
function pushClientPresenceHeartbeat() {
  postSelectionState().catch(() => {});
}
window.addEventListener("focus", pushClientPresenceHeartbeat);
window.addEventListener("blur", pushClientPresenceHeartbeat);
document.addEventListener("visibilitychange", pushClientPresenceHeartbeat);

// Fast polling loop: keep selection sync, consume pending apply jobs, and surface transfer events.
setInterval(() => {
  postSelectionState().catch(() => {});
  pullPendingApplyRequest().catch(() => {});
  pullTransferEvents().catch(() => {});
}, 700);

// Register extension so Comfy loads this script.
app.registerExtension({
  name: "quickai.loader",
  setup() {
    // Prefer ComfyUI's own maintained legacy-topbar extension point (app.menu) — it's
    // always present regardless of which other topbar buttons exist, so this doesn't
    // depend on finding/cloning another button or watching for it to be removed.
    // Only fall back to DOM-hunting + polling for older ComfyUI versions without it.
    if (!installLegacyMenuExportButton()) {
      startMainMenuExportButtonPolling();
    }
  }
});
