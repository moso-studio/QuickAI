/*
Developed by Juan Motaban at MOSO Studio. 2026
https://moso-studio.com/
https://www.motaban.com/
*/
const { app, core, action, constants, imaging } = require("photoshop");
const { storage, shell } = require("uxp");
const { BlendMode } = constants;
const SETTINGS_FILE_NAME = "quickai_settings.json";
const AUTO_RUN_JOBS_FILE_NAME = "quickai_auto_run_jobs.json";
const AUTO_RUN_JOB_SNAPSHOTS_FOLDER_NAME = "auto_run_job_snapshots";
// Caps how many finished/failed/stopped jobs stay in the Jobs dialog and on disk — without a
// limit this list (and its durably-copied snapshot files) would grow without bound the longer
// the plugin stays installed.
const AUTO_RUN_MAX_FINISHED_JOBS = 50;
// Jobs dialog paginates its list so at most this many rows are rendered (and preview-hydrated) at once.
const AUTO_RUN_JOBS_PER_PAGE = 10;
const SECURE_COMFY_API_KEY_NAME = "quickai_comfy_api_key";
const SECURE_RUNCOMFY_TOKEN_NAME = "quickai_runcomfy_token";
const SECURE_RUNPOD_TOKEN_NAME = "quickai_runpod_token";
const WORKFLOW_SETTINGS_FILE_PREFIX = "workflow_settings_";
const WORKFLOW_SETTINGS_FILE_EXT = ".ini";
const WORKFLOWS_FOLDER_NAME = "default_workflows";
// Internal toggle: when false, hide workflows whose folder name starts with "Debug_".
const SHOW_DEBUG_WORKFLOWS = false;
const DEFAULT_CROP_SELECTION_EXPAND_LEVEL = 0.2;
const DEFAULT_CROP_SO_MASK_FEATHER_LEVEL = 0.03;
const DEFAULT_CROP_MERGE_THRESHOLD_LEVEL = 0.01;
const DEFAULT_CROP_IGNORE_WIDTH_LEVEL = 0.005;
const MAX_RECENT_SERVERS = 8;
const MAX_RECENT_PORTS = 8;
const LEGACY_LEVEL_REFERENCE_AVG_PX = 1000;
const MAX_SELECTION_COMPONENT_SCAN_PIXELS = 50000000;
const PHOTOSHOP_SELECTION_CONTRACT_MIN_PX = 1;
const PHOTOSHOP_SELECTION_CONTRACT_MAX_PX = 500;
const REFERENCE_THUMB_MAX_SIZE_PX = 56;
// Extra reference images (not the main edit image) are semantic/style conditioning for
// the AI model, not pixel-level edit targets — Gemini's own docs recommend low/medium
// resolution tiers for "simpler contextual images" since it tiles/token-budgets image
// input rather than using it at native resolution. Capping the long edge here trades
// away resolution the model wouldn't use anyway for faster export + upload.
const REFERENCE_EXPORT_MAX_DIMENSION_PX = 1536;
// "Main Input" mode dropdown (rendered above the Inputs box) — governs how the workflow's main
// input slot (slot 0) gets its content. See parseNanoBananaYaml (param definition),
// createNanoBananaInput/renderNanoBananaForm (dropdown <-> Inputs box wiring), and
// prepareAutoRunSelectedWorkflowJob/executePreparedAutoRunJob (export/upload behavior per mode).
const MAIN_INPUT_MODE_PARAM_NAME = "main_input_mode";
const MAIN_INPUT_MODE_CANVAS = "Current Canvas";
const MAIN_INPUT_MODE_SELECTED_LAYER = "Selected Layer And Below";
// Only the selected layer itself (every other layer hidden), same isolation as the Bridge's
// "Send Selected Layer" — see isolateSelectedLayerOnly.
const MAIN_INPUT_MODE_SELECTED_LAYER_ONLY = "Selected Layer";
const MAIN_INPUT_MODE_MANUAL = "Set Manually";
const RUNCOMFY_MAX_BINARY_BYTES = 6 * 1024 * 1024;
const RUNCOMFY_MAX_TOTAL_BINARY_BYTES = 4 * 1024 * 1024;
const RUNCOMFY_MIN_BINARY_BYTES_PER_ASSET = 512 * 1024;
// RunPod's documented request-body ceiling for POST .../run (async) is 10 MB — see
// https://docs.runpod.io/serverless/workers/handler-functions ("Payload limits"). Base64
// inflates raw bytes by ~33%, so a 5 MB raw budget becomes ~6.7 MB encoded, leaving ~3 MB of
// margin under the 10 MB limit for the surrounding workflow JSON/auth fields. (/runsync, unused
// here, allows 20 MB.) Previously set far more conservatively (2 MB raw) before this was verified.
const RUNPOD_MAX_BINARY_BYTES = 5 * 1024 * 1024;
const RUNPOD_MAX_TOTAL_BINARY_BYTES = 5 * 1024 * 1024;
const RUNPOD_MIN_BINARY_BYTES_PER_ASSET = 256 * 1024;
// A self-hosted local ComfyUI server has no meaningful upload ceiling of its own (plain
// Node/Python HTTP server — the practical limit is disk/memory), so 90 MB here is purely a
// plugin-side sanity cap (kept a margin under 100 MB) to fail fast with a clear message instead
// of hanging on a huge upload.
const LOCAL_MAX_UPLOAD_BYTES = 90 * 1024 * 1024;
// Comfy Cloud's documented image-upload limits (https://docs.comfy.org/api-reference/cloud/
// file/upload-an-image-file): 50 MB max file size, 16384 px max edge, 64 MP max total pixels.
// Uploads over any of these get a hard HTTP 400 from Comfy Cloud itself. Set under the
// documented 50 MB so the plugin's own JPEG-quality fallback kicks in first, with a clear
// message, instead of relying on Comfy Cloud's rejection.
const CLOUD_MAX_UPLOAD_BYTES = 45 * 1024 * 1024;
const CLOUD_MAX_DIMENSION_PX = 16384;
const CLOUD_MAX_TOTAL_PIXELS = 64 * 1024 * 1024;
let timestampedFileNameCounter = 0;

// Contracts active selection by total pixels, chunking into Photoshop-supported 1..500 calls.
async function contractSelectionByPx(selection, totalPx) {
    const amount = Math.max(0, Math.round(Number(totalPx) || 0));
    if (amount < PHOTOSHOP_SELECTION_CONTRACT_MIN_PX) return;
    let remaining = amount;
    while (remaining >= PHOTOSHOP_SELECTION_CONTRACT_MIN_PX) {
        const step = Math.min(PHOTOSHOP_SELECTION_CONTRACT_MAX_PX, remaining);
        await selection.contract(step);
        remaining -= step;
    }
}

// Expands active selection by total pixels, chunking into Photoshop-supported 1..500 calls.
async function expandSelectionByPx(selection, totalPx) {
    const amount = Math.max(0, Math.round(Number(totalPx) || 0));
    if (amount < PHOTOSHOP_SELECTION_CONTRACT_MIN_PX) return;
    let remaining = amount;
    while (remaining >= PHOTOSHOP_SELECTION_CONTRACT_MIN_PX) {
        const step = Math.min(PHOTOSHOP_SELECTION_CONTRACT_MAX_PX, remaining);
        await selection.expand(step);
        remaining -= step;
    }
}
const settingsState = {
    comfyApiKey: "",
    runcomfyToken: "",
    runcomfyDeploymentId: "",
    runcomfyMaxInstances: 1,
    runcomfyQueueSize: 0,
    runcomfyKeepWarmSec: 0,
    runpodToken: "",
    runpodEndpointId: "",
    customApiWorkflowsPath: "",
    customApiWorkflowsToken: "",
    customApiWorkflowsPath2: "",
    customApiWorkflowsToken2: "",
    environment: "local",
    useComfyCloud: false,
    server: "127.0.0.1",
    recentServers: [],
    port: "8188",
    recentPorts: [],
    fitCanvasWholeImageImports: true,
    importJobResultAutomatically: true,
    // Settings > Update: show the "Update available" line above the footer credits.
    showUpdateNoticeInPanel: true,
    cropSelectionExpandLevel: DEFAULT_CROP_SELECTION_EXPAND_LEVEL,
    cropSoMaskFeatherLevel: DEFAULT_CROP_SO_MASK_FEATHER_LEVEL,
    cropMergeThresholdLevel: DEFAULT_CROP_MERGE_THRESHOLD_LEVEL,
    cropIgnoreWidthLevel: DEFAULT_CROP_IGNORE_WIDTH_LEVEL
};

// Builds a timestamped PNG filename for full-image snapshot exports.
function buildSnapshotFileName() {
    return buildTimestampedFileName("quickai");
}

// Builds a UTC timestamped filename with millisecond/counter entropy so rapid crop segments cannot overwrite each other.
function buildTimestampedFileName(prefix) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
    timestampedFileNameCounter = (timestampedFileNameCounter + 1) % 10000;
    const counter = String(timestampedFileNameCounter).padStart(4, "0");
    const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${ms}`;
    return `${prefix}_${ts}_${counter}.png`;
}

// Normalizes user-entered workflow names into filesystem-safe filenames.
function sanitizeTimestampedFileNameInput(rawValue) {
    return String(rawValue || "")
        .trim()
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
}

// Bridge Send: one mode dropdown (Current Canvas / Selected Layer / Selected Layer & Below) and
// one Send button, mirroring Auto Run's Main Input row.
const bridgeSendModeSelect = document.getElementById("bridgeSendModeSelect");
const bridgeSendBtn = document.getElementById("bridgeSendBtn");
// Remembers the last Bridge send mode for this user (per-panel convenience only).
const BRIDGE_SEND_MODE_STORAGE_KEY = "quickai_bridge_send_mode";
// Bridge Get: one target dropdown (New Layer / Selected Smart Object) and one Get button,
// mirroring the Send section.
const bridgeGetModeSelect = document.getElementById("bridgeGetModeSelect");
const bridgeGetBtn = document.getElementById("bridgeGetBtn");
const BRIDGE_GET_MODE_STORAGE_KEY = "quickai_bridge_get_mode";
const nanoBananaForm = document.getElementById("nanoBananaForm");
const environmentSelect = document.getElementById("environmentSelect");
const deploymentRow = document.getElementById("deploymentRow");
const deploymentFieldLabel = document.getElementById("deploymentFieldLabel");
const deploymentSelect = document.getElementById("deploymentSelect");
const deploymentStatusMetaLabel = document.getElementById("deploymentStatusMetaLabel");
const deploymentStatusLabel = document.getElementById("deploymentStatusLabel");
const deploymentWarmupBtn = document.getElementById("deploymentWarmupBtn");
const deploymentEndpointSettingsBtn = document.getElementById("deploymentEndpointSettingsBtn");
const deploymentComfySettingsBtn = document.getElementById("deploymentComfySettingsBtn");
const connectionRow = document.getElementById("connectionRow");
const autoRunCard = document.getElementById("autoRunCard");
const bridgeCard = document.getElementById("bridgeCard");
const serverField = document.getElementById("serverField");
const serverSecurityLabel = document.getElementById("serverSecurityLabel");
const portField = document.getElementById("portField");
const localServerStatusLabel = document.getElementById("localServerStatusLabel");
const localServerQueueLabel = document.getElementById("localServerQueueLabel");
const cloudStatusLabel = document.getElementById("cloudStatusLabel");
const cloudQueueLabel = document.getElementById("cloudQueueLabel");
const importJobResultAutomaticallyCheckbox = document.getElementById("importJobResultAutomaticallyCheckbox");
const fitCanvasWholeImageCheckbox = document.getElementById("fitCanvasWholeImageCheckbox");
const settingsShowUpdateNoticeCheckbox = document.getElementById("settingsShowUpdateNoticeCheckbox");
const serverRecentList = document.getElementById("serverRecentList");
const portRecentList = document.getElementById("portRecentList");
const logWebview = document.getElementById("logWebview");
const logContainer = document.getElementById("logContainer");
const pluginVersionLabel = document.getElementById("pluginVersionLabel");
const terminalToggle = document.getElementById("terminalToggle");
const clearLogsBtn = document.getElementById("clearLogsBtn");
const saveLogsBtn = document.getElementById("saveLogsBtn");
const importWorkflowsBtn = document.getElementById("importWorkflowsBtn");
const settingsToggle = document.getElementById("settingsToggle");
const openComfyUiBtn = document.getElementById("openComfyUiBtn");
const autoRunJobsView = document.getElementById("autoRunJobsView");
const autoRunJobsList = document.getElementById("autoRunJobsList");
const autoRunJobsPager = document.getElementById("autoRunJobsPager");
// Zero-based page index currently shown in the Jobs dialog; clamped on every render.
let autoRunJobsPageIndex = 0;
const autoRunJobsCloseBtn = document.getElementById("autoRunJobsCloseBtn");
const autoRunJobsClearBtn = document.getElementById("autoRunJobsClearBtn");
const autoRunJobLogView = document.getElementById("autoRunJobLogView");
const autoRunJobLogSubtitle = document.getElementById("autoRunJobLogSubtitle");
const autoRunJobLogText = document.getElementById("autoRunJobLogText");
const autoRunJobLogCloseBtn = document.getElementById("autoRunJobLogCloseBtn");
const autoRunJobLogSaveBtn = document.getElementById("autoRunJobLogSaveBtn");
const settingsView = document.getElementById("settingsView");
const settingsCancelBtn = document.getElementById("settingsCancelBtn");
const settingsSaveBtn = document.getElementById("settingsSaveBtn");
const settingsComfyApiKeyField = document.getElementById("settingsComfyApiKeyField");
const settingsRunComfyTokenField = document.getElementById("settingsRunComfyTokenField");
const settingsRunPodTokenField = document.getElementById("settingsRunPodTokenField");
const settingsCustomApiWorkflowsField = document.getElementById("settingsCustomApiWorkflowsField");
const settingsCustomApiWorkflowsClearBtn = document.getElementById("settingsCustomApiWorkflowsClearBtn");
const settingsCustomApiWorkflowsBrowseBtn = document.getElementById("settingsCustomApiWorkflowsBrowseBtn");
const settingsCustomApiWorkflowsField2 = document.getElementById("settingsCustomApiWorkflowsField2");
const settingsCustomApiWorkflowsClearBtn2 = document.getElementById("settingsCustomApiWorkflowsClearBtn2");
const settingsCustomApiWorkflowsBrowseBtn2 = document.getElementById("settingsCustomApiWorkflowsBrowseBtn2");
const settingsCropExpandField = document.getElementById("settingsCropExpandField");
const settingsCropFeatherField = document.getElementById("settingsCropFeatherField");
const settingsCropMergeThresholdField = document.getElementById("settingsCropMergeThresholdField");
const settingsCropIgnoreField = document.getElementById("settingsCropIgnoreField");
const runPodEndpointSettingsView = document.getElementById("runPodEndpointSettingsView");
const runPodEndpointSettingsViewTitle = document.getElementById("runPodEndpointSettingsViewTitle");
const runPodIdleTimeoutField = document.getElementById("runPodIdleTimeoutField");
const runPodWorkersMaxField = document.getElementById("runPodWorkersMaxField");
const runPodEndpointSettingsCancelBtn = document.getElementById("runPodEndpointSettingsCancelBtn");
const runPodEndpointSettingsSaveBtn = document.getElementById("runPodEndpointSettingsSaveBtn");
const runComfyDeploymentSettingsView = document.getElementById("runComfyDeploymentSettingsView");
const runComfyDeploymentSettingsViewTitle = document.getElementById("runComfyDeploymentSettingsViewTitle");
const runComfyMaxInstancesField = document.getElementById("runComfyMaxInstancesField");
const runComfyQueueSizeField = document.getElementById("runComfyQueueSizeField");
const runComfyKeepWarmField = document.getElementById("runComfyKeepWarmField");
const runComfyDeploymentSettingsCancelBtn = document.getElementById("runComfyDeploymentSettingsCancelBtn");
const runComfyDeploymentSettingsSaveBtn = document.getElementById("runComfyDeploymentSettingsSaveBtn");
let logResizeRaf = 0;
let runComfyDeploymentStatusPollTimer = 0;
let localServerStatusPollTimer = 0;
// Settles the open confirmation box (showPanelConfirm) with true/false; null when none is open.
// Declared up here because dismissPanelConfirm() can run from view-closing code during load.
let panelConfirmResolve = null;
// Auto-fade timer of the toast (showPanelToast). Declared up here because hidePanelToast() runs
// from view-switching code (dismissFloatingBoxes), which can happen during load.
let panelToastTimer = null;
// Pending update of the space reserved for floating boxes after the toast fades out.
let floatingBoxReserveTimer = 0;
// Local server protocol detection (see detectLocalServerScheme). For an address typed without
// http:// or https://, the plugin tries HTTPS first and falls back to HTTP, like a browser's
// HTTPS-First mode; the result is cached per address+port. `scheme` is "https", "http" or null
// (nothing answered; retried after LOCAL_SERVER_SCHEME_RETRY_MS).
let localServerSchemeProbe = { key: "", scheme: null, checkedAtMs: 0, inFlight: null };
// Result of the latest server status check, for the security label: whether the server at `key`
// answered. null = not checked yet for the current address.
let localServerConnectionState = { key: "", reachable: null };
// How long to wait for one protocol test before treating it as "no answer". Declared up here
// (not next to the detection code) because the first server check can run during script load.
const LOCAL_SERVER_SCHEME_PROBE_TIMEOUT_MS = 4000;
// When neither protocol answered, how long before testing the same address again.
const LOCAL_SERVER_SCHEME_RETRY_MS = 15000;
let cloudQueueStatusPollTimer = 0;
const runPodEndpointMetadataById = new Map();
let runComfyDeploymentSettingsSnapshot = null;

function createDefaultWorkflowNodeTargets() {
    return {
        inputs: [],
        exportNodeId: "",
        exportNodeIds: [],
        exportMaskNodeId: "",
        exportMaskNodeIds: [],
        exportMaskResultNodeIds: [],
        bypassGroups: []
    };
}

const autoRunState = {
    workflowConfigs: [],
    selectedWorkflow: "",
    parameterDefs: [],
    workflowClassTypes: [],
    workflowNodeTargets: createDefaultWorkflowNodeTargets(),
    isRunning: false,
    stopRequested: false,
    activePromptIds: [],
    activeJob: null,
    activeJobs: [],
    queuedJobs: [],
    finishedJobs: [],
    nextJobId: 1,
    queueProcessorRunning: false,
    importQueuePromise: Promise.resolve(),
    jobsDialogVisible: false,
    jobsDialogCount: 0,
    progressVisible: true,
    progressPercent: 0,
    progressText: "Ready"
};

// Deep-clones plain workflow/job data so queued runs keep the exact state captured at enqueue time.
function cloneAutoRunData(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
}

// Locks the log viewport height to the panel space to prevent layout jumps while logs stream in.
function lockLogHeight() {
    // Terminal height is fixed in CSS (200px).
    return;
}

// Schedules log height locking on the next animation frame to avoid repeated sync layout work.
function scheduleLockLogHeight() {
    if (logResizeRaf) return;
    logResizeRaf = requestAnimationFrame(() => {
        logResizeRaf = 0;
        lockLogHeight();
    });
}

// Resets .wrapper's internal scroll position after it's restored from display:none.
// Root cause of the recent-server/port popup appearing off-screen ("displaced up" /
// "not showing") after closing Import Workflow: .wrapper has overflow-y:auto, and its
// scrollTop can be left at a large stale value while it's hidden. The Server/Port
// fields sit near the top of .wrapper's content, so a stale scrollTop pushes their
// getBoundingClientRect() far above the viewport (confirmed via logging: rect.top was
// -411px), and the popup — positioned relative to those fields — ends up off-screen
// too, even though its own DOM/CSS state is otherwise completely correct.
function resetPanelScroll(el) {
    if (!el) return;
    el.scrollTop = 0;
}

// Shows or hides the in-panel log terminal and updates the toggle label state.
function setTerminalVisible(isVisible) {
    if (!logContainer) return;
    const nextVisible = Boolean(isVisible);
    logContainer.classList.toggle("isHidden", !nextVisible);
    if (terminalToggle) terminalToggle.setAttribute("aria-pressed", nextVisible ? "true" : "false");
    if (nextVisible) scheduleLockLogHeight();
}

// Scrolls the main panel to its bottom so a just-opened terminal is fully in view. Waits two
// animation frames: the first lets layout apply the un-hidden log, and scheduleLockLogHeight's
// own frame sizes the log, so the second frame reads the final scrollHeight.
function scrollMainPanelToBottom() {
    const mainWrapper = document.querySelector(".wrapper");
    if (!mainWrapper) return;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            mainWrapper.scrollTop = mainWrapper.scrollHeight;
        });
    });
}

// Builds a filesystem-safe default filename for exported terminal logs.
function buildLogExportFileName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `quickai_logs_${stamp}.txt`;
}

// Footer credit links. Each entry renders as one clickable segment of the footer line; the
// version segment's text is filled in from the manifest (see loadPluginVersionLabel).
const PLUGIN_FOOTER_LINKS = [
    { key: "product", url: "https://github.com/moso-studio/QuickAI" },
    { key: "studio", text: "MOSO Studio", url: "https://moso-studio.com/" },
    { key: "author", text: "Juan Motaban", url: "https://www.motaban.com/" }
];
// Last known plugin version; updated from manifest.json once it loads.
let pluginFooterVersion = "2.0.0";

// Rebuilds one footer label as "QuickAI vX • MOSO Studio • Juan Motaban", each part a link.
// Clicks are handled by a single delegated listener (wirePluginFooterLinks), so labels can be
// re-rendered freely, including the one rebuilt with the Import Workflow view.
function renderPluginFooterLabel(labelEl) {
    if (!labelEl) return;
    while (labelEl.firstChild) labelEl.removeChild(labelEl.firstChild);
    PLUGIN_FOOTER_LINKS.forEach((link, index) => {
        if (index > 0) {
            const sep = document.createElement("span");
            sep.className = "pluginFooterSep";
            sep.textContent = " \u2022 ";
            labelEl.appendChild(sep);
        }
        // Plain span (an <a> gets UXP's forced blue link color and still no hand cursor);
        // clicks are routed through wirePluginFooterLinks to the external browser.
        const linkEl = document.createElement("span");
        linkEl.className = "pluginFooterLink";
        linkEl.dataset.url = link.url;
        linkEl.textContent = link.key === "product" ? `QuickAI v${pluginFooterVersion}` : link.text;
        linkEl.setAttribute("title", link.url);
        labelEl.appendChild(linkEl);
    });
}

// Opens a URL in the user's default browser. Uses UXP shell.openExternal (allowed by the
// manifest's launchProcess http/https schemes), falling back to window.open.
async function openPluginExternalUrl(url) {
    if (shell && typeof shell.openExternal === "function") {
        try {
            await shell.openExternal(url);
            return;
        } catch (_e) {}
    }
    try { window.open(url, "_blank"); } catch (_e) {}
}

// One document-level click listener serves every footer link in every view.
function wirePluginFooterLinks() {
    document.addEventListener("click", (event) => {
        const target = event.target;
        const linkEl = target && typeof target.closest === "function" ? target.closest(".pluginFooterLink") : null;
        const url = linkEl?.dataset?.url;
        if (!url) return;
        event.preventDefault();
        openPluginExternalUrl(url).catch(() => {});
    });
}

// Loads the plugin version from the manifest so the footer stays in sync with releases.
// Renders the footer links immediately with the default version, then again once loaded.
async function loadPluginVersionLabel() {
    const renderAll = () => {
        document.querySelectorAll(".pluginVersionLabel").forEach(renderPluginFooterLabel);
        // Settings > Update "Version:" line.
        const settingsVersionEl = document.getElementById("settingsVersionLabel");
        if (settingsVersionEl) settingsVersionEl.textContent = `Version: v${pluginFooterVersion}`;
    };
    renderAll();
    try {
        const response = await fetch("manifest.json", { cache: "no-store" });
        if (!response.ok) return;
        const manifest = await response.json();
        const version = String(manifest?.version || "").trim();
        if (version) {
            pluginFooterVersion = version;
            renderAll();
        }
    } catch (_e) {}
}

// --- Update check: on startup, ask GitHub for the latest published release and, if it is newer
// than this plugin's manifest version, show a clickable notice above the footer credits. ---

// GitHub repository ("owner/name") checked for new releases. Its latest release's tag (e.g.
// "v2.0.1") is compared with manifest.json's version.
const PLUGIN_UPDATE_REPO = "moso-studio/QuickAI";
// Give up quickly when offline or GitHub is slow; the check is best-effort and silent on failure.
const PLUGIN_UPDATE_CHECK_TIMEOUT_MS = 8000;
// Set when a newer release is found: { version: "2.0.1", url: "<release page>" }.
let pluginUpdateInfo = null;
// Outcome of the latest check, shown in Settings > Update: "checking" | "upToDate" | "available"
// | "error". Starts as "checking" because the first check runs at plugin start.
let pluginUpdateCheckState = "checking";
// The check in progress, if any, so overlapping requests share one GitHub call.
let pluginUpdateCheckPromise = null;

// Extracts numeric version parts from a tag or version string, tolerating prefixes and
// separators: "v2.0.1", "V2.0.1", "v.2.0.1" and "2.0.1" all give [2, 0, 1]. [] if none found.
function parsePluginVersionParts(value) {
    const match = /(\d+(?:\.\d+)*)/.exec(String(value || ""));
    return match ? match[1].split(".").map((part) => Number.parseInt(part, 10) || 0) : [];
}

// True when `candidate` is a strictly newer version than `current` (missing parts count as 0).
function isNewerPluginVersion(candidate, current) {
    const a = parsePluginVersionParts(candidate);
    const b = parsePluginVersionParts(current);
    if (a.length < 1 || b.length < 1) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const diff = (a[i] || 0) - (b[i] || 0);
        if (diff !== 0) return diff > 0;
    }
    return false;
}

// Shows/hides the update notice in every footer (one per view). The notice sits above the credit
// label inside the footer bar; while it is visible, body.hasPluginUpdate makes the bar taller
// (and every view correspondingly shorter, via --qc-footer-h) so nothing overlaps.
// Also hidden when the user turned off Settings > Update > "Show update message in the footer"
// (Settings > Update still reports the update either way).
function renderPluginUpdateNotices() {
    const visible = Boolean(pluginUpdateInfo) && settingsState.showUpdateNoticeInPanel !== false;
    document.body.classList.toggle("hasPluginUpdate", visible);
    document.querySelectorAll(".pluginVersionRow").forEach((row) => {
        let notice = row.querySelector(".pluginUpdateNotice");
        if (!notice) {
            notice = document.createElement("span");
            // Shares .pluginFooterLink so the delegated footer click handler opens its URL.
            notice.className = "pluginFooterLink pluginUpdateNotice";
            row.insertBefore(notice, row.firstChild);
        }
        notice.classList.toggle("isVisible", visible);
        if (visible) {
            notice.textContent = `Update available: v${pluginUpdateInfo.version}`;
            notice.dataset.url = pluginUpdateInfo.url;
            notice.setAttribute("title", pluginUpdateInfo.url);
        }
    });
}

// Shows the latest check outcome in Settings > Update. When an update exists, the line becomes a
// link to the release page: it gets .pluginFooterLink, so the shared delegated footer click handler
// (wirePluginFooterLinks) opens its data-url; the class and URL are cleared in every other state.
function renderPluginUpdateStatus() {
    const statusEl = document.getElementById("settingsUpdateStatus");
    if (!statusEl) return;
    const state = pluginUpdateCheckState;
    const isAvailable = state === "available" && Boolean(pluginUpdateInfo);
    let text = "Couldn't check for updates.";
    if (isAvailable) text = `Update available: v${pluginUpdateInfo.version}`;
    else if (state === "upToDate") text = "Up to date.";
    else if (state === "checking") text = "Checking for updates…";
    statusEl.textContent = text;
    statusEl.classList.toggle("isUpToDate", state === "upToDate");
    statusEl.classList.toggle("isAvailable", isAvailable);
    statusEl.classList.toggle("pluginFooterLink", isAvailable);
    statusEl.dataset.url = isAvailable ? pluginUpdateInfo.url : "";
    statusEl.setAttribute("title", isAvailable ? pluginUpdateInfo.url : "");
}

// Asks GitHub for the latest published release (drafts and pre-releases are excluded by this
// endpoint) and compares its tag with the manifest version. Runs at plugin start, and again when
// Settings is opened after a failed check; unauthenticated GitHub API calls allow 60 per hour per
// network, far above this. A failure (offline, no releases yet, private repo, rate limit) is
// logged and shown as "Couldn't check for updates." in Settings, and is otherwise ignored.
function checkForPluginUpdate() {
    if (pluginUpdateCheckPromise) return pluginUpdateCheckPromise;
    pluginUpdateCheckState = "checking";
    renderPluginUpdateStatus();
    pluginUpdateCheckPromise = runPluginUpdateCheck()
        .then((state) => { pluginUpdateCheckState = state; })
        .finally(() => {
            pluginUpdateCheckPromise = null;
            renderPluginUpdateStatus();
        });
    return pluginUpdateCheckPromise;
}

// Performs one GitHub release lookup and returns the resulting check state (never throws).
async function runPluginUpdateCheck() {
    const url = `https://api.github.com/repos/${PLUGIN_UPDATE_REPO}/releases/latest`;
    try {
        const response = await Promise.race([
            fetch(url, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), PLUGIN_UPDATE_CHECK_TIMEOUT_MS))
        ]);
        if (!response.ok) {
            log(`Update check: GitHub returned ${response.status} for ${PLUGIN_UPDATE_REPO}.`);
            return "error";
        }
        const release = await response.json();
        const tag = String(release?.tag_name || "").trim();
        const pageUrl = String(release?.html_url || "").trim();
        const latestParts = parsePluginVersionParts(tag);
        if (latestParts.length < 1 || !/^https:\/\/github\.com\//i.test(pageUrl)) {
            log(`Update check: latest release tag "${tag}" has no version number.`);
            return "error";
        }
        const latestVersion = latestParts.join(".");
        if (isNewerPluginVersion(latestVersion, pluginFooterVersion)) {
            pluginUpdateInfo = { version: latestVersion, url: pageUrl };
            renderPluginUpdateNotices();
            log(`Update check: v${latestVersion} is available (this is v${pluginFooterVersion}).`);
            return "available";
        }
        log(`Update check: up to date (v${pluginFooterVersion}; latest release ${tag}).`);
        return "upToDate";
    } catch (error) {
        log(`Update check skipped: ${describeError(error)}`);
        return "error";
    }
}

// Opens the native save dialog and writes the current terminal contents to the selected text file.
async function saveLogsToFile() {
    if (!saveLogsBtn) return;
    const logText = String(logWebview?.textContent || "");
    if (!logText.trim()) {
        log("Save Logs: no terminal text available to save.");
        return;
    }

    saveLogsBtn.disabled = true;
    try {
        const file = await storage.localFileSystem.getFileForSaving(buildLogExportFileName(), { types: ["txt"] });
        if (!file) {
            log("Save Logs: save dialog canceled.");
            return;
        }
        await file.write(logText);
        log(`Save Logs: saved ${logText.length} characters to ${file.name || "selected file"}.`);
    } catch (error) {
        log(`Save Logs error: ${describeError(error)}`);
    } finally {
        saveLogsBtn.disabled = false;
    }
}

// Clears the terminal content panel.
function clearTerminalLogs() {
    if (!logWebview) return;
    logWebview.textContent = "";
}

// Updates Auto Run progress UI state and synchronizes the status label rendering.
function setAutoRunProgressState({ visible, percent, text } = {}) {
    if (typeof visible === "boolean") autoRunState.progressVisible = visible;
    if (Number.isFinite(Number(percent))) {
        autoRunState.progressPercent = Math.max(0, Math.min(100, Number(percent)));
    }
    if (typeof text === "string") autoRunState.progressText = text;

    const wrap = document.getElementById("autoRunProgressWrap");
    const label = document.getElementById("autoRunProgressLabel");
    if (!wrap || !label) return;

    wrap.classList.toggle("isHidden", !autoRunState.progressVisible);
    label.textContent = formatAutoRunProgressDisplayText(autoRunState.progressText || `${Math.round(autoRunState.progressPercent)}%`);
}

// Returns a compact human-readable count label.
function formatAutoRunCountLabel(count, singular, plural = `${singular}s`) {
    const safeCount = Math.max(0, Number(count) || 0);
    return `${safeCount} ${safeCount === 1 ? singular : plural}`;
}

// Formats compact running/queued count labels for the shared progress summary.
function formatAutoRunStatusCountLabel(count, word) {
    const safeCount = Math.max(0, Number(count) || 0);
    return `${safeCount} ${word}`;
}

// Maps backend flags to a stable user-facing label for job rows.
function getAutoRunJobBackendLabel(job) {
    if (job?.useRunComfy || job?.backendOptions?.useRunComfy) return "RunComfy";
    if (job?.useRunPod || job?.backendOptions?.useRunPod) return "RunPod";
    if (job?.useCloud || job?.backendOptions?.useCloud) return "Comfy Cloud";
    return "Comfy Server";
}

// Returns a concise backend target label so queued/running jobs show the exact server/deployment in use.
function getAutoRunJobBackendTargetLabel(job) {
    const backend = job?.backendOptions || {};
    if (backend.useRunComfy || job?.useRunComfy) {
        const deploymentLabel = String(
            backend.runComfyDeploymentLabel
            || job?.runComfyDeploymentLabel
            || backend.runComfyDeploymentId
            || job?.runComfyDeploymentId
            || ""
        ).trim();
        return deploymentLabel || "Unknown Deployment";
    }
    if (backend.useRunPod || job?.useRunPod) {
        const endpointLabel = String(
            backend.runPodEndpointLabel
            || job?.runPodEndpointLabel
            || backend.runPodEndpointId
            || job?.runPodEndpointId
            || ""
        ).trim();
        return endpointLabel || "Unknown Endpoint";
    }
    if (backend.useCloud || job?.useCloud) return "";
    const localServer = normalizeServerSettingValue(backend.localServer || job?.localServer || "");
    const localPort = normalizePort(backend.localPort || job?.localPort || "");
    return localPort ? `${localServer}:${localPort}` : localServer;
}

// Formats a user-facing phase label for one job, using crops language for multi-region sends.
function formatAutoRunJobPhaseLabel(phase, options = {}) {
    const phaseText = String(phase || "").trim() || "Running";
    const totalSegments = Math.max(1, Number(options.totalSegments) || 1);
    const indexValue = options.completedSegments ?? options.segmentIndex;
    const hasIndex = Number.isFinite(Number(indexValue)) && totalSegments > 1;
    if (phaseText === "Completed" && totalSegments > 1) {
        const completed = hasIndex
            ? Math.min(totalSegments, Math.max(0, Math.round(Number(indexValue))))
            : totalSegments;
        return `Completed ${completed}/${totalSegments} crops`;
    }
    if (totalSegments > 1) {
        const current = hasIndex
            ? Math.min(totalSegments, Math.max(1, Math.round(Number(indexValue))))
            : 1;
        return `${phaseText} crops ${current}/${totalSegments}`;
    }
    return phaseText;
}

// Tracks whether an already-dispatched job is still waiting in a backend queue or is actively running.
function getAutoRunJobActivityState(job) {
    if (!job || typeof job !== "object") return "queued";
    const rawPhase = String(job.activityState || job.progressState || "").trim().toLowerCase();
    if (rawPhase === "running") return "running";
    if (rawPhase === "queued") return "queued";
    if (job.state === "completed") return "completed";
    if (job.state === "stopped" || job.state === "error") return "idle";
    return "queued";
}

// Normalizes backend progress-state tokens into the UI's queued/running/importing/completed states.
function normalizeAutoRunProgressState(rawState) {
    const state = String(rawState || "").trim().toLowerCase();
    if (!state) return "running";
    if (
        state === "queued"
        || state === "pending"
        || state === "created"
        || state === "initializing"
        || state === "waiting"
        || state === "queued_for_worker"
        || state.includes("queue")
        || state.includes("pending")
        || state.includes("initializ")
        || state.includes("wait")
        || state.includes("create")
        || state.includes("enqueue")
    ) {
        return "queued";
    }
    if (
        state === "running"
        || state === "in_progress"
        || state === "processing"
        || state === "started"
        || state === "executing"
        || state.includes("running")
        || state.includes("progress")
        || state.includes("process")
        || state.includes("start")
        || state.includes("execut")
    ) {
        return "running";
    }
    if (["completed", "succeeded", "success"].includes(state)) return "completed";
    if (["failed", "error", "cancelled", "canceled", "stopped", "idle"].includes(state)) return "idle";
    return "running";
}

// Returns true only when at least one active Auto Run job is actually running.
function hasVisibleAutoRunActivity() {
    const activeJobs = Array.isArray(autoRunState.activeJobs) ? autoRunState.activeJobs : [];
    return activeJobs.some((job) => getAutoRunJobActivityState(job) === "running");
}

// Builds a concise aggregate label for the shared progress row without pretending multiple jobs are one job.
function formatAutoRunProgressDisplayText(baseText) {
    const totalJobs = getAutoRunActiveOrQueuedJobCount();
    if (totalJobs < 1) return String(baseText || "Ready");
    const safeBaseText = String(baseText || "").trim() || "Running";
    const activeJobs = Array.isArray(autoRunState.activeJobs) ? autoRunState.activeJobs : [];
    const queuedJobs = Array.isArray(autoRunState.queuedJobs) ? autoRunState.queuedJobs : [];
    const runningCount = activeJobs.filter((job) => getAutoRunJobActivityState(job) === "running").length;
    const dispatchedQueuedCount = activeJobs.filter((job) => getAutoRunJobActivityState(job) === "queued").length;
    const queuedCount = queuedJobs.length + dispatchedQueuedCount;

    if (runningCount < 1) {
        return queuedCount > 0 ? `${formatAutoRunCountLabel(queuedCount, "job")} queued` : safeBaseText;
    }
    if (queuedCount > 0) {
        const runningLabel = formatAutoRunStatusCountLabel(runningCount, "running");
        return `${runningLabel}, ${queuedCount} queued`;
    }
    if (runningCount > 1) {
        return formatAutoRunStatusCountLabel(runningCount, "running");
    }
    return safeBaseText;
}

// Builds the normalized backend snapshot that a queued job must keep using even if the panel
// server/deployment selection changes before the job actually starts running.
function buildAutoRunBackendOptions(options = {}) {
    const useRunComfy = Boolean(options.useRunComfy);
    const useRunPod = Boolean(options.useRunPod);
    const useCloud = Boolean(options.useCloud);
    if (useRunComfy) {
        return {
            useRunComfy: true,
            useRunPod: false,
            useCloud: false,
            runComfyDeploymentId: String(options.runComfyDeploymentId || "").trim(),
            runComfyDeploymentLabel: String(options.runComfyDeploymentLabel || "").trim()
        };
    }
    if (useRunPod) {
        return {
            useRunComfy: false,
            useRunPod: true,
            useCloud: false,
            runPodEndpointId: String(options.runPodEndpointId || "").trim(),
            runPodEndpointLabel: String(options.runPodEndpointLabel || "").trim()
        };
    }
    if (useCloud) {
        return {
            useRunComfy: false,
            useRunPod: false,
            useCloud: true
        };
    }
    return {
        useRunComfy: false,
        useRunPod: false,
        useCloud: false,
        localServer: normalizeServerSettingValue(options.localServer),
        localPort: normalizePort(options.localPort)
    };
}

// Returns the scheduling lane key so jobs only serialize when they target the same backend.
function getAutoRunJobBackendKey(job) {
    const backend = job?.backendOptions || {};
    if (backend.useRunComfy) {
        return `runcomfy:${String(backend.runComfyDeploymentId || "").trim() || "default"}`;
    }
    if (backend.useRunPod) {
        return `runpod:${String(backend.runPodEndpointId || "").trim() || "default"}`;
    }
    if (backend.useCloud) return "cloud";
    const server = normalizeServerSettingValue(backend.localServer);
    const port = normalizePort(backend.localPort);
    return `local:${server.toLowerCase()}:${port || "default"}`;
}

// Keeps the legacy single-job state in sync for code paths that still read a single active job.
function syncAutoRunRuntimeStateFromActiveJobs() {
    const activeJobs = Array.isArray(autoRunState.activeJobs) ? autoRunState.activeJobs : [];
    autoRunState.activeJob = activeJobs.length > 0 ? activeJobs[0] : null;
    autoRunState.isRunning = activeJobs.length > 0;
    autoRunState.stopRequested = activeJobs.some((job) => Boolean(job?.stopRequested));
    autoRunState.activePromptIds = activeJobs.flatMap((job) => Array.isArray(job?.promptIds) ? job.promptIds : []);
}

// Returns whether another job is already executing against the same backend lane.
function isAutoRunBackendActive(backendKey) {
    if (!backendKey) return false;
    return Array.isArray(autoRunState.activeJobs)
        && autoRunState.activeJobs.some((job) => getAutoRunJobBackendKey(job) === backendKey);
}

// Serializes Photoshop-side imports so backend concurrency never overlaps modal placement/import work.
async function withAutoRunImportLock(work) {
    const previous = autoRunState.importQueuePromise || Promise.resolve();
    let releaseLock = null;
    autoRunState.importQueuePromise = new Promise((resolve) => {
        releaseLock = resolve;
    });
    await previous.catch(() => {});
    try {
        return await work();
    } finally {
        if (typeof releaseLock === "function") releaseLock();
    }
}

// Returns only the jobs still doing work (active + queued) — excludes finished/failed jobs that
// persist in the UI after completion. Used anywhere "is there still work in flight" matters, such
// as resetting the progress row back to "Ready".
function getAutoRunActiveOrQueuedJobs() {
    const jobs = [];
    if (Array.isArray(autoRunState.activeJobs) && autoRunState.activeJobs.length > 0) {
        jobs.push(...autoRunState.activeJobs);
    } else if (autoRunState.activeJob) {
        jobs.push(autoRunState.activeJob);
    }
    if (Array.isArray(autoRunState.queuedJobs) && autoRunState.queuedJobs.length > 0) {
        jobs.push(...autoRunState.queuedJobs);
    }
    return jobs;
}

// Returns current count of active + queued jobs (excludes finished/failed).
function getAutoRunActiveOrQueuedJobCount() {
    return getAutoRunActiveOrQueuedJobs().length;
}

// Returns every Auto Run job that should still show in the Jobs dialog: active + queued jobs plus
// finished/failed jobs, which now persist until the user removes them.
function getAutoRunTrackedJobs() {
    const jobs = getAutoRunActiveOrQueuedJobs();
    if (Array.isArray(autoRunState.finishedJobs) && autoRunState.finishedJobs.length > 0) {
        jobs.push(...autoRunState.finishedJobs);
    }
    return jobs;
}

// Returns current count of active + queued + finished/failed jobs.
function getAutoRunTrackedJobCount() {
    return getAutoRunTrackedJobs().length;
}

// Builds Auto Run progress label and appends crop counter (n/N) for multi-crop jobs.
function formatAutoRunProgressLabel(phase, options = {}) {
    return formatAutoRunJobPhaseLabel(phase, options);
}

// Normalizes level setting.
function normalizeLevelSetting(value, fallback) {
    const raw = value === null || value === undefined ? "" : String(value).trim();
    if (!raw) return fallback;
    const num = Number.parseFloat(raw);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, num);
}

// Returns crop selection expand level.
function getCropSelectionExpandLevel() {
    return normalizeLevelSetting(settingsState.cropSelectionExpandLevel, DEFAULT_CROP_SELECTION_EXPAND_LEVEL);
}

// Returns crop mask feather level.
function getCropMaskFeatherLevel() {
    return normalizeLevelSetting(settingsState.cropSoMaskFeatherLevel, DEFAULT_CROP_SO_MASK_FEATHER_LEVEL);
}

// Normalizes a non-negative integer setting.
function normalizeNonNegativeIntegerSetting(value, fallback) {
    const raw = value === null || value === undefined ? "" : String(value).trim();
    if (!raw) return fallback;
    const num = Number.parseInt(raw, 10);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(0, num);
}

// Returns Auto Run component merge threshold as a width ratio.
function getCropMergeThresholdLevel() {
    return normalizeLevelSetting(settingsState.cropMergeThresholdLevel, DEFAULT_CROP_MERGE_THRESHOLD_LEVEL);
}

// Returns Auto Run minimum width ratio used to ignore tiny selection regions.
function getCropIgnoreWidthLevel() {
    return normalizeLevelSetting(settingsState.cropIgnoreWidthLevel, DEFAULT_CROP_IGNORE_WIDTH_LEVEL);
}

// Returns average selection size in px.
function getAverageBoundsSizePx(bounds) {
    if (!bounds) return 0;
    const w = Number(bounds.right) - Number(bounds.left);
    const h = Number(bounds.bottom) - Number(bounds.top);
    if (!(w > 0 && h > 0)) return 0;
    return (w + h) / 2;
}

// Returns expand px computed from current selection size and configured level.
function getCropExpandPxForBounds(bounds) {
    const avg = getAverageBoundsSizePx(bounds);
    if (!(avg > 0)) return 0;
    return Math.max(0, Math.round(avg * getCropSelectionExpandLevel()));
}

// Returns auto-contract px (always half of expand px).
function getCropMaskContractPxForBounds(bounds) {
    return Math.max(0, Math.round(getCropExpandPxForBounds(bounds) / 2));
}

// Returns contract px as exactly half of the provided expand px.
function getContractPxFromExpandPx(expandPx) {
    const expand = Number(expandPx);
    if (!Number.isFinite(expand) || expand <= 0) return 0;
    return Math.max(0, Math.round(expand / 2));
}

// Returns feather px computed from current selection size and configured level.
function getCropMaskFeatherPxForBounds(bounds) {
    const avg = getAverageBoundsSizePx(bounds);
    if (!(avg > 0)) return 0;
    return Math.max(0, Math.round(avg * getCropMaskFeatherLevel()));
}

// Maps legacy px-based values to new level-based values using a reference average crop size.
function legacyPxToLevel(pxValue, fallbackLevel) {
    const px = Number.parseFloat(String(pxValue ?? "").trim());
    if (!Number.isFinite(px) || px < 0) return fallbackLevel;
    const level = px / LEGACY_LEVEL_REFERENCE_AVG_PX;
    return Math.max(0, level);
}

// Normalizes server setting value.
function normalizeServerSettingValue(value) {
    const server = String(value || "").trim();
    return server || "127.0.0.1";
}

// Normalizes and deduplicates recent server list entries.
function normalizeRecentServersList(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < values.length; i += 1) {
        const normalized = normalizeServerSettingValue(values[i]);
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(normalized);
        if (out.length >= MAX_RECENT_SERVERS) break;
    }
    return out;
}

// Normalizes and deduplicates recent port list entries.
function normalizeRecentPortsList(values) {
    if (!Array.isArray(values)) return [];
    const out = [];
    const seen = new Set();
    for (let i = 0; i < values.length; i += 1) {
        const normalized = normalizePort(values[i]);
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
        if (out.length >= MAX_RECENT_PORTS) break;
    }
    return out;
}

// Stores one server entry at the top of the recent list.
function rememberRecentServer(server) {
    const normalized = normalizeServerSettingValue(server);
    const next = [normalized, ...(settingsState.recentServers || [])];
    settingsState.recentServers = normalizeRecentServersList(next);
}

// Stores one port entry at the top of the recent list.
function rememberRecentPort(port) {
    const normalized = normalizePort(port);
    if (!normalized) return;
    const next = [normalized, ...(settingsState.recentPorts || [])];
    settingsState.recentPorts = normalizeRecentPortsList(next);
}

// Hides recent-server popup. Also clears its rendered rows so a stale/duplicated
// list can't linger and reappear misplaced after a native OS dialog (e.g. the
// Import Workflow file picker) interrupts the panel's normal render cycle —
// showServerRecentList() always rebuilds the rows fresh on next open anyway.
function hideServerRecentList() {
    if (!serverRecentList) return;
    serverRecentList.classList.add("isHidden");
    serverRecentList.setAttribute("aria-hidden", "true");
    serverRecentList.textContent = "";
}

// Hides recent-port popup. See hideServerRecentList() for why rows are cleared here too.
function hidePortRecentList() {
    if (!portRecentList) return;
    portRecentList.classList.add("isHidden");
    portRecentList.setAttribute("aria-hidden", "true");
    portRecentList.textContent = "";
}

// Repositions recent-server popup below server field.
function positionServerRecentList() {
    if (!serverField || !serverRecentList) return;
    // serverField lives in .wrapper, which gets display:none whenever any full-panel view
    // (Settings, Jobs, Job Log, etc.) is open. getBoundingClientRect() on a hidden element
    // returns an all-zero rect, which used to pin this popup to the top-left corner (0, 4) —
    // invisible while .wrapper stays hidden, but then snapping into view at that wrong spot the
    // moment .wrapper reappears, since nothing repositioned it in between. The Jobs dialog in
    // particular re-renders on every progress-poll tick while open, which can trigger a window
    // resize callback (see the "resize" listener below) and hit this exact path — Settings has
    // no such repeating update, which is why this only ever showed up after visiting Jobs.
    if (serverField.offsetParent === null) {
        hideServerRecentList();
        return;
    }
    const rect = serverField.getBoundingClientRect();
    serverRecentList.style.left = `${Math.round(rect.left)}px`;
    serverRecentList.style.top = `${Math.round(rect.bottom + 4)}px`;
    serverRecentList.style.width = `${Math.round(rect.width)}px`;
}

// Repositions recent-port popup below port field. See positionServerRecentList for why the
// visibility guard below matters.
function positionPortRecentList() {
    if (!portField || !portRecentList) return;
    if (portField.offsetParent === null) {
        hidePortRecentList();
        return;
    }
    const rect = portField.getBoundingClientRect();
    portRecentList.style.left = `${Math.round(rect.left)}px`;
    portRecentList.style.top = `${Math.round(rect.bottom + 4)}px`;
    portRecentList.style.width = `${Math.round(rect.width)}px`;
}

// Renders and shows recent server popup.
function showServerRecentList() {
    if (!serverField || !serverRecentList || isComfyCloudEnabled()) return;
    const entries = normalizeRecentServersList(settingsState.recentServers || []);
    if (entries.length < 1) {
        hideServerRecentList();
        return;
    }
    serverRecentList.textContent = "";
    for (let i = 0; i < entries.length; i += 1) {
        const value = entries[i];
        const row = document.createElement("div");
        row.className = "recentItemRow";

        const item = document.createElement("button");
        item.type = "button";
        item.className = "serverRecentItem";
        item.textContent = value;
        item.addEventListener("click", async () => {
            if (!serverField) return;
            serverField.value = value;
            updateServerSecurityLabel();
            rememberRecentServer(value);
            applyConnectionFieldsToState();
            if (normalizeEnvironmentMode(settingsState.environment) === "local") {
                refreshLocalServerStatus({ showChecking: true }).catch(() => {});
                refreshAutoRunWorkflowList({ preserveSelection: true }).catch((error) => {
                    log(`Generate workflow refresh error: ${describeError(error)}`);
                });
            }
            hideServerRecentList();
            await persistSettings().catch((error) => {
                log(`Connection settings save error: ${describeError(error)}`);
            });
        });

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "recentItemRemoveBtn";
        removeBtn.textContent = "X";
        removeBtn.setAttribute("aria-label", `Remove recent server ${value}`);
        removeBtn.title = "Remove";
        removeBtn.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            settingsState.recentServers = normalizeRecentServersList(
                (settingsState.recentServers || []).filter((entry) => String(entry || "").toLowerCase() !== String(value || "").toLowerCase())
            );
            await persistSettings().catch((error) => {
                log(`Connection settings save error: ${describeError(error)}`);
            });
            showServerRecentList();
        });

        row.appendChild(item);
        row.appendChild(removeBtn);
        serverRecentList.appendChild(row);
    }
    positionServerRecentList();
    serverRecentList.classList.remove("isHidden");
    serverRecentList.setAttribute("aria-hidden", "false");
}

// Renders and shows recent port popup.
function showPortRecentList() {
    if (!portField || !portRecentList || isComfyCloudEnabled()) return;
    const entries = normalizeRecentPortsList(settingsState.recentPorts || []);
    if (entries.length < 1) {
        hidePortRecentList();
        return;
    }
    portRecentList.textContent = "";
    for (let i = 0; i < entries.length; i += 1) {
        const value = entries[i];
        const row = document.createElement("div");
        row.className = "recentItemRow";

        const item = document.createElement("button");
        item.type = "button";
        item.className = "portRecentItem";
        item.textContent = value;
        item.addEventListener("click", async () => {
            if (!portField) return;
            portField.value = value;
            rememberRecentPort(value);
            applyConnectionFieldsToState();
            if (normalizeEnvironmentMode(settingsState.environment) === "local") {
                refreshLocalServerStatus({ showChecking: true }).catch(() => {});
                refreshAutoRunWorkflowList({ preserveSelection: true }).catch((error) => {
                    log(`Generate workflow refresh error: ${describeError(error)}`);
                });
            }
            hidePortRecentList();
            await persistSettings().catch((error) => {
                log(`Connection settings save error: ${describeError(error)}`);
            });
        });

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "recentItemRemoveBtn";
        removeBtn.textContent = "X";
        removeBtn.setAttribute("aria-label", `Remove recent port ${value}`);
        removeBtn.title = "Remove";
        removeBtn.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            settingsState.recentPorts = normalizeRecentPortsList(
                (settingsState.recentPorts || []).filter((entry) => String(entry || "") !== String(value || ""))
            );
            await persistSettings().catch((error) => {
                log(`Connection settings save error: ${describeError(error)}`);
            });
            showPortRecentList();
        });

        row.appendChild(item);
        row.appendChild(removeBtn);
        portRecentList.appendChild(row);
    }
    positionPortRecentList();
    portRecentList.classList.remove("isHidden");
    portRecentList.setAttribute("aria-hidden", "false");
}

// Encodes UTF-8 text into bytes without relying on host-specific storage coercion.
function utf8Encode(text) {
    const safe = String(text || "");
    if (typeof TextEncoder !== "undefined") {
        return new TextEncoder().encode(safe);
    }
    // ASCII fallback for environments without TextEncoder.
    const out = new Uint8Array(safe.length);
    for (let i = 0; i < safe.length; i += 1) out[i] = safe.charCodeAt(i) & 0xff;
    return out;
}

// Decodes UTF-8 bytes from secure storage.
function utf8Decode(bytesLike) {
    if (!bytesLike) return "";
    let bytes = null;
    if (bytesLike instanceof Uint8Array) {
        bytes = bytesLike;
    } else if (bytesLike instanceof ArrayBuffer) {
        bytes = new Uint8Array(bytesLike);
    } else if (ArrayBuffer.isView(bytesLike)) {
        bytes = new Uint8Array(bytesLike.buffer, bytesLike.byteOffset, bytesLike.byteLength);
    } else if (typeof bytesLike === "string") {
        return bytesLike;
    } else {
        return String(bytesLike || "");
    }
    if (typeof TextDecoder !== "undefined") {
        return new TextDecoder().decode(bytes);
    }
    // ASCII fallback for environments without TextDecoder.
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
}

// Reads Comfy API key from UXP secure storage.
async function readSecureComfyApiKey() {
    const secure = storage && storage.secureStorage;
    if (!secure || typeof secure.getItem !== "function") return "";
    try {
        const value = await secure.getItem(SECURE_COMFY_API_KEY_NAME);
        if (value === null || value === undefined) return "";
        return utf8Decode(value).trim();
    } catch (_e) {
        return "";
    }
}

// Persists Comfy API key in UXP secure storage and clears it when empty.
async function persistSecureComfyApiKey(apiKey) {
    const secure = storage && storage.secureStorage;
    if (!secure || typeof secure.setItem !== "function") return;
    const normalized = String(apiKey || "").trim();
    if (!normalized) {
        if (typeof secure.removeItem === "function") {
            try {
                await secure.removeItem(SECURE_COMFY_API_KEY_NAME);
            } catch (_e) {}
        } else {
            try {
                await secure.setItem(SECURE_COMFY_API_KEY_NAME, "");
            } catch (_e) {}
        }
        return;
    }
    await secure.setItem(SECURE_COMFY_API_KEY_NAME, utf8Encode(normalized));
}

// Reads RunComfy token from UXP secure storage.
async function readSecureRunComfyToken() {
    const secure = storage && storage.secureStorage;
    if (!secure || typeof secure.getItem !== "function") return "";
    try {
        const value = await secure.getItem(SECURE_RUNCOMFY_TOKEN_NAME);
        if (value === null || value === undefined) return "";
        return utf8Decode(value).trim();
    } catch (_e) {
        return "";
    }
}

// Persists RunComfy token in UXP secure storage and clears it when empty.
async function persistSecureRunComfyToken(token) {
    const secure = storage && storage.secureStorage;
    if (!secure || typeof secure.setItem !== "function") return;
    const normalized = String(token || "").trim();
    if (!normalized) {
        if (typeof secure.removeItem === "function") {
            try {
                await secure.removeItem(SECURE_RUNCOMFY_TOKEN_NAME);
            } catch (_e) {}
        } else {
            try {
                await secure.setItem(SECURE_RUNCOMFY_TOKEN_NAME, "");
            } catch (_e) {}
        }
        return;
    }
    await secure.setItem(SECURE_RUNCOMFY_TOKEN_NAME, utf8Encode(normalized));
}

// Reads RunPod token from UXP secure storage.
async function readSecureRunPodToken() {
    const secure = storage && storage.secureStorage;
    if (!secure || typeof secure.getItem !== "function") return "";
    try {
        const value = await secure.getItem(SECURE_RUNPOD_TOKEN_NAME);
        if (value === null || value === undefined) return "";
        return utf8Decode(value).trim();
    } catch (_e) {
        return "";
    }
}

// Persists RunPod token in UXP secure storage and clears it when empty.
async function persistSecureRunPodToken(token) {
    const secure = storage && storage.secureStorage;
    if (!secure || typeof secure.setItem !== "function") return;
    const normalized = String(token || "").trim();
    if (!normalized) {
        if (typeof secure.removeItem === "function") {
            try {
                await secure.removeItem(SECURE_RUNPOD_TOKEN_NAME);
            } catch (_e) {}
        } else {
            try {
                await secure.setItem(SECURE_RUNPOD_TOKEN_NAME, "");
            } catch (_e) {}
        }
        return;
    }
    await secure.setItem(SECURE_RUNPOD_TOKEN_NAME, utf8Encode(normalized));
}

// Builds the canonical settings object before writing plugin settings to disk.
function buildPersistedSettingsPayload() {
    settingsState.server = normalizeServerSettingValue(settingsState.server);
    settingsState.port = normalizePort(settingsState.port);
    settingsState.environment = normalizeEnvironmentMode(settingsState.environment);
    return {
        customApiWorkflowsPath: String(settingsState.customApiWorkflowsPath || ""),
        customApiWorkflowsToken: String(settingsState.customApiWorkflowsToken || ""),
        customApiWorkflowsPath2: String(settingsState.customApiWorkflowsPath2 || ""),
        customApiWorkflowsToken2: String(settingsState.customApiWorkflowsToken2 || ""),
        environment: settingsState.environment,
        runcomfyDeploymentId: String(settingsState.runcomfyDeploymentId || "").trim(),
        runcomfyMaxInstances: normalizeRunComfyDeploymentIntegerSetting(settingsState.runcomfyMaxInstances, 1, { min: 1, max: 20 }),
        runcomfyQueueSize: normalizeRunComfyDeploymentIntegerSetting(settingsState.runcomfyQueueSize, 0, { min: 0 }),
        runcomfyKeepWarmSec: normalizeRunComfyDeploymentIntegerSetting(settingsState.runcomfyKeepWarmSec, 0, { min: 0 }),
        runpodEndpointId: String(settingsState.runpodEndpointId || "").trim(),
        useComfyCloud: settingsState.environment !== "local",
        server: settingsState.server,
        recentServers: normalizeRecentServersList(settingsState.recentServers),
        port: settingsState.port,
        recentPorts: normalizeRecentPortsList(settingsState.recentPorts),
        fitCanvasWholeImageImports: Boolean(settingsState.fitCanvasWholeImageImports),
        importJobResultAutomatically: Boolean(settingsState.importJobResultAutomatically),
        showUpdateNoticeInPanel: settingsState.showUpdateNoticeInPanel !== false,
        selectedWorkflow: String(autoRunState.selectedWorkflow || "").trim(),
        cropSelectionExpandLevel: getCropSelectionExpandLevel(),
        cropSoMaskFeatherLevel: getCropMaskFeatherLevel(),
        cropMergeThresholdLevel: getCropMergeThresholdLevel(),
        cropIgnoreWidthLevel: getCropIgnoreWidthLevel()
    };
}

// Applies persisted settings into runtime state with validation/default fallbacks.
function applySettingsPatch(rawSettings) {
    if (!rawSettings || typeof rawSettings !== "object") return;
    if (Object.prototype.hasOwnProperty.call(rawSettings, "comfyApiKey")) {
        settingsState.comfyApiKey = String(rawSettings.comfyApiKey || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "runcomfyToken")) {
        settingsState.runcomfyToken = String(rawSettings.runcomfyToken || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "runcomfyDeploymentId")) {
        settingsState.runcomfyDeploymentId = String(rawSettings.runcomfyDeploymentId || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "runcomfyMaxInstances")) {
        settingsState.runcomfyMaxInstances = normalizeRunComfyDeploymentIntegerSetting(rawSettings.runcomfyMaxInstances, 1, { min: 1, max: 20 });
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "runcomfyQueueSize")) {
        settingsState.runcomfyQueueSize = normalizeRunComfyDeploymentIntegerSetting(rawSettings.runcomfyQueueSize, 0, { min: 0 });
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "runcomfyKeepWarmSec")) {
        settingsState.runcomfyKeepWarmSec = normalizeRunComfyDeploymentIntegerSetting(rawSettings.runcomfyKeepWarmSec, 0, { min: 0 });
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "runpodToken")) {
        settingsState.runpodToken = String(rawSettings.runpodToken || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "runpodEndpointId")) {
        settingsState.runpodEndpointId = String(rawSettings.runpodEndpointId || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "customApiWorkflowsPath")) {
        settingsState.customApiWorkflowsPath = String(rawSettings.customApiWorkflowsPath || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "customApiWorkflowsToken")) {
        settingsState.customApiWorkflowsToken = String(rawSettings.customApiWorkflowsToken || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "customApiWorkflowsPath2")) {
        settingsState.customApiWorkflowsPath2 = String(rawSettings.customApiWorkflowsPath2 || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "customApiWorkflowsToken2")) {
        settingsState.customApiWorkflowsToken2 = String(rawSettings.customApiWorkflowsToken2 || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "environment")) {
        settingsState.environment = normalizeEnvironmentMode(rawSettings.environment);
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "useComfyCloud")) {
        settingsState.useComfyCloud = Boolean(rawSettings.useComfyCloud);
        // Backward compatibility: older settings only persisted a cloud/local boolean.
        if (!Object.prototype.hasOwnProperty.call(rawSettings, "environment")) {
            settingsState.environment = settingsState.useComfyCloud ? "cloud" : "local";
        }
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "server")) {
        settingsState.server = normalizeServerSettingValue(rawSettings.server);
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "recentServers")) {
        settingsState.recentServers = normalizeRecentServersList(rawSettings.recentServers);
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "port")) {
        settingsState.port = normalizePort(rawSettings.port);
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "recentPorts")) {
        settingsState.recentPorts = normalizeRecentPortsList(rawSettings.recentPorts);
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "fitCanvasWholeImageImports")) {
        settingsState.fitCanvasWholeImageImports = Boolean(rawSettings.fitCanvasWholeImageImports);
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "importJobResultAutomatically")) {
        settingsState.importJobResultAutomatically = Boolean(rawSettings.importJobResultAutomatically);
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "showUpdateNoticeInPanel")) {
        settingsState.showUpdateNoticeInPanel = rawSettings.showUpdateNoticeInPanel !== false;
        renderPluginUpdateNotices();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "selectedWorkflow")) {
        autoRunState.selectedWorkflow = String(rawSettings.selectedWorkflow || "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "cropSelectionExpandLevel")) {
        settingsState.cropSelectionExpandLevel = normalizeLevelSetting(rawSettings.cropSelectionExpandLevel, getCropSelectionExpandLevel());
    } else if (Object.prototype.hasOwnProperty.call(rawSettings, "cropSelectionExpandPx")) {
        settingsState.cropSelectionExpandLevel = legacyPxToLevel(rawSettings.cropSelectionExpandPx, getCropSelectionExpandLevel());
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "cropSoMaskFeatherLevel")) {
        settingsState.cropSoMaskFeatherLevel = normalizeLevelSetting(rawSettings.cropSoMaskFeatherLevel, getCropMaskFeatherLevel());
    } else if (Object.prototype.hasOwnProperty.call(rawSettings, "cropSoMaskFeatherPx")) {
        settingsState.cropSoMaskFeatherLevel = legacyPxToLevel(rawSettings.cropSoMaskFeatherPx, getCropMaskFeatherLevel());
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "cropMergeThresholdLevel")) {
        settingsState.cropMergeThresholdLevel = normalizeLevelSetting(rawSettings.cropMergeThresholdLevel, getCropMergeThresholdLevel());
    } else if (Object.prototype.hasOwnProperty.call(rawSettings, "cropMergeThresholdPx")) {
        settingsState.cropMergeThresholdLevel = legacyPxToLevel(rawSettings.cropMergeThresholdPx, getCropMergeThresholdLevel());
    }
    if (Object.prototype.hasOwnProperty.call(rawSettings, "cropIgnoreWidthLevel")) {
        settingsState.cropIgnoreWidthLevel = normalizeLevelSetting(rawSettings.cropIgnoreWidthLevel, getCropIgnoreWidthLevel());
    }
}

// Reads plugin settings JSON from plugin storage and applies it to runtime state.
async function readPersistedSettings() {
    const dataFolder = await storage.localFileSystem.getDataFolder();
    let settingsFile = null;
    try {
        settingsFile = await dataFolder.getEntry(SETTINGS_FILE_NAME);
    } catch (_e) {
        return null;
    }
    if (!settingsFile) return null;
    const text = await settingsFile.read();
    if (!text) return null;
    return JSON.parse(text);
}

// Writes current plugin settings to plugin storage as JSON.
async function persistSettings() {
    applyConnectionFieldsToState();
    const dataFolder = await storage.localFileSystem.getDataFolder();
    const settingsFile = await dataFolder.createFile(SETTINGS_FILE_NAME, { overwrite: true });
    const payload = buildPersistedSettingsPayload();
    await settingsFile.write(JSON.stringify(payload, null, 2));
}

// --- Auto Run job history persistence (retains Finished/Failed jobs, and resumes tracking a
// job that was still Running, across Photoshop restarts/crashes) ---

// Long edge, in pixels, of the Jobs-list thumbnail saved for each job.
const AUTO_RUN_JOB_THUMBNAIL_MAX_PX = 256;

// Builds a small JPEG (base64, no data: prefix) of a document's current composite, optionally
// limited to `sourceBounds` (a crop segment). Photoshop scales the pixels down itself via
// imaging.getPixels' targetSize, so this stays fast even for very large canvases. Returns "" on
// any failure (e.g. a color mode the encoder can't handle); callers then show no thumbnail.
async function buildDocumentThumbnailJpegBase64(docId, sourceBounds = null) {
    if (!imaging || typeof imaging.getPixels !== "function" || typeof imaging.encodeImageData !== "function") return "";
    const doc = getOpenDocumentById(docId);
    if (!doc) return "";
    try {
        // Crop areas can be expanded past the canvas edge; clamp so getPixels only reads pixels
        // that exist.
        const rawBounds = sourceBounds ? normalizeBoundsToIntegerRect(sourceBounds) : null;
        const bounds = rawBounds ? normalizeBoundsToIntegerRect({
            left: Math.max(0, rawBounds.left),
            top: Math.max(0, rawBounds.top),
            right: Math.min(Number(doc.width), rawBounds.right),
            bottom: Math.min(Number(doc.height), rawBounds.bottom)
        }) : null;
        const sourceW = bounds ? bounds.right - bounds.left : Number(doc.width);
        const sourceH = bounds ? bounds.bottom - bounds.top : Number(doc.height);
        if (!(sourceW > 0) || !(sourceH > 0)) return "";
        // Never upscale: small sources keep their size.
        const scale = Math.min(1, AUTO_RUN_JOB_THUMBNAIL_MAX_PX / Math.max(sourceW, sourceH));
        const targetSize = {
            width: Math.max(1, Math.round(sourceW * scale)),
            height: Math.max(1, Math.round(sourceH * scale))
        };
        let base64 = "";
        await core.executeAsModal(async () => {
            const pixelsResult = await imaging.getPixels({
                documentID: doc.id,
                ...(bounds ? { sourceBounds: bounds } : {}),
                targetSize,
                componentSize: 8
            });
            const imageData = pixelsResult && pixelsResult.imageData;
            if (!imageData) return;
            let rgbImageData = null;
            try {
                let encodable = imageData;
                // JPEG has no alpha, and encodeImageData rejects RGBA ("Image data with alpha
                // cannot be encoded as jpeg") for canvases with transparency. Flatten the small
                // thumbnail onto white and rebuild it as 3-component RGB before encoding.
                if (Number(imageData.components) === 4) {
                    if (typeof imaging.createImageDataFromBuffer !== "function") return;
                    const rgba = await imageData.getData({ chunky: true });
                    const pixelCount = Number(imageData.width) * Number(imageData.height);
                    const rgb = new Uint8Array(pixelCount * 3);
                    for (let i = 0; i < pixelCount; i += 1) {
                        const alpha = rgba[(i * 4) + 3] / 255;
                        for (let c = 0; c < 3; c += 1) {
                            rgb[(i * 3) + c] = Math.round((rgba[(i * 4) + c] * alpha) + (255 * (1 - alpha)));
                        }
                    }
                    rgbImageData = await imaging.createImageDataFromBuffer(rgb, {
                        width: Number(imageData.width),
                        height: Number(imageData.height),
                        components: 3,
                        chunky: true,
                        colorSpace: "RGB",
                        colorProfile: "sRGB IEC61966-2.1"
                    });
                    encodable = rgbImageData;
                }
                const encoded = await imaging.encodeImageData({ imageData: encodable, base64: true });
                base64 = typeof encoded === "string" ? encoded : "";
            } finally {
                if (typeof imageData.dispose === "function") imageData.dispose();
                if (rgbImageData && typeof rgbImageData.dispose === "function") rgbImageData.dispose();
            }
        }, { commandName: "QuickAI Job Thumbnail" });
        return base64;
    } catch (error) {
        log(`Generate thumbnail warning: ${describeError(error)}`);
        return "";
    }
}

// Saves a job thumbnail (base64 JPEG) into the snapshots folder so the Jobs list can still show
// it after a Photoshop restart. Returns the stored file name, or "" if it could not be written.
async function writeAutoRunThumbnailForPersistence(jobId, runIndex, jpegBase64) {
    if (!jpegBase64) return "";
    try {
        const dataFolder = await storage.localFileSystem.getDataFolder();
        let snapshotsFolder;
        try {
            snapshotsFolder = await dataFolder.getEntry(AUTO_RUN_JOB_SNAPSHOTS_FOLDER_NAME);
        } catch (_e) {
            snapshotsFolder = await dataFolder.createFolder(AUTO_RUN_JOB_SNAPSHOTS_FOLDER_NAME);
        }
        const fileName = `${jobId}_${runIndex}_thumb.jpg`;
        const file = await snapshotsFolder.createFile(fileName, { overwrite: true });
        await file.write(decodeBase64ImagePayloadToBytes(jpegBase64), { format: storage.formats.binary });
        return fileName;
    } catch (error) {
        log(`Generate thumbnail persistence warning: ${describeError(error)}`);
        return "";
    }
}

// Re-opens a file saved in the snapshots folder (a job thumbnail, or a full snapshot saved by
// older versions) as a fresh file entry after a restart.
async function openPersistedAutoRunSnapshot(snapshotPath) {
    if (!snapshotPath) return null;
    try {
        const dataFolder = await storage.localFileSystem.getDataFolder();
        const snapshotsFolder = await dataFolder.getEntry(AUTO_RUN_JOB_SNAPSHOTS_FOLDER_NAME);
        return await snapshotsFolder.getEntry(snapshotPath);
    } catch (_e) {
        return null;
    }
}

// Deletes a job's durably-copied snapshots once it has been imported or removed, so disk usage
// stays bounded.
// Batch jobs share one saved snapshot/thumbnail, so a file is only deleted once no other job
// still listed (finished, running or queued) refers to it. Every caller removes `job` from those
// lists before calling this, so it never counts as its own reference.
async function deleteAutoRunJobSnapshots(job) {
    const segments = Array.isArray(job?.segments) ? job.segments : [];
    const paths = new Set();
    for (const segment of segments) {
        if (segment?.snapshotPath) paths.add(segment.snapshotPath);
        if (segment?.thumbnailPath) paths.add(segment.thumbnailPath);
    }
    if (paths.size < 1) return;
    const stillReferenced = new Set();
    for (const otherJob of [...autoRunState.finishedJobs, ...autoRunState.activeJobs, ...autoRunState.queuedJobs]) {
        if (!otherJob || otherJob === job) continue;
        for (const segment of (Array.isArray(otherJob.segments) ? otherJob.segments : [])) {
            if (segment?.snapshotPath) stillReferenced.add(segment.snapshotPath);
            if (segment?.thumbnailPath) stillReferenced.add(segment.thumbnailPath);
        }
    }
    try {
        const dataFolder = await storage.localFileSystem.getDataFolder();
        const snapshotsFolder = await dataFolder.getEntry(AUTO_RUN_JOB_SNAPSHOTS_FOLDER_NAME);
        for (const path of paths) {
            if (stillReferenced.has(path)) continue;
            try {
                const entry = await snapshotsFolder.getEntry(path);
                if (entry && typeof entry.delete === "function") await entry.delete();
            } catch (_e) {}
        }
    } catch (_e) {}
}

// Keeps autoRunState.finishedJobs from growing without bound — finishedJobs is always
// newest-first (unshift on completion, and restoreAutoRunJobsFromDisk preserves that order), so
// trimming from the end drops the oldest entries first. Also cleans up their durably-copied
// snapshot files so evicted jobs don't leave orphaned disk usage behind.
function capFinishedAutoRunJobs() {
    const overflow = autoRunState.finishedJobs.length - AUTO_RUN_MAX_FINISHED_JOBS;
    if (overflow <= 0) return;
    const evicted = autoRunState.finishedJobs.splice(AUTO_RUN_MAX_FINISHED_JOBS, overflow);
    for (const job of evicted) {
        deleteAutoRunJobSnapshots(job).catch((error) => {
            log(`Generate job snapshot cleanup warning: ${describeError(error)}`);
        });
    }
}

// Builds a plain, JSON-serializable snapshot of one job's persisted-relevant fields — no live
// UXP file/document references, only data needed to redisplay the job or (for a job resumed
// after a restart) resume tracking/import it.
function serializeAutoRunJobForPersistence(job) {
    return {
        id: job.id,
        state: job.state,
        // Persisted so a restart doesn't have to guess a resumed job's queued/running/importing
        // sub-state — see restoreAutoRunJobsFromDisk, which previously forced every resumed job
        // to "running" regardless of its real last-known state, misreporting e.g. "2 running"
        // when only one actually was.
        activityState: job.activityState || "",
        progressState: job.progressState || "",
        workflowDisplayName: job.workflowDisplayName,
        documentName: job.documentName,
        useRunComfy: Boolean(job.useRunComfy),
        useRunPod: Boolean(job.useRunPod),
        useCloud: Boolean(job.useCloud),
        backendOptions: job.backendOptions || null,
        runComfyDeploymentId: job.runComfyDeploymentId || "",
        runComfyDeploymentLabel: job.runComfyDeploymentLabel || "",
        runPodEndpointId: job.runPodEndpointId || "",
        runPodEndpointLabel: job.runPodEndpointLabel || "",
        workflowNodeTargets: job.workflowNodeTargets || null,
        selectionDocId: job.selectionDocId ?? null,
        totalRuns: job.totalRuns,
        promptIds: Array.isArray(job.promptIds) ? job.promptIds : [],
        segments: Array.isArray(job.segments) ? job.segments.map((segment) => ({
            runIndex: segment.runIndex,
            segmentLabel: segment.segmentLabel,
            target: segment.target,
            snapshotPath: segment.snapshotPath || "",
            thumbnailPath: segment.thumbnailPath || "",
            cropSmartObjectRef: segment.cropSmartObjectRef || null,
            promptId: segment.promptId || "",
            exrOutputPrefixes: segment.exrOutputPrefixes || [],
            queuedAtMs: segment.queuedAtMs || 0,
            completedEntry: segment.completedEntry || null
        })) : [],
        createdAtMs: job.createdAtMs,
        completedAtMs: job.completedAtMs || 0,
        errorDetail: job.errorDetail || "",
        logText: job.logText || "",
        resumedAfterRestart: Boolean(job.resumedAfterRestart)
    };
}

// Serializes every persistAutoRunJobsToDisk() write onto a single chain so disk writes always
// land in call order. Every call site fires this fire-and-forget (no await, just .catch(log)),
// and without this queue two overlapping writes can finish out of order — e.g. the write
// triggered right as a job completes can finish *before* an earlier, now-stale write from a
// moment prior (when that job still showed "running"), letting the stale write clobber the
// correct one on disk. That was the actual cause of a job that had already completed still
// showing up as active/running after a Photoshop restart: the on-disk file was reverted to an
// older snapshot by a slower, earlier-issued write finishing last.
let autoRunJobsPersistQueue = Promise.resolve();

// Writes the current job history (finished/failed jobs, plus any still active/queued so an
// in-progress job survives a crash) to the plugin's data folder as JSON.
function persistAutoRunJobsToDisk() {
    // Snapshot the records synchronously now, at call time, so the write reflects state as of
    // this call even though the actual write may be queued behind an earlier one.
    const records = [
        ...autoRunState.finishedJobs,
        ...autoRunState.activeJobs,
        ...autoRunState.queuedJobs
    ].map(serializeAutoRunJobForPersistence);
    const writePromise = autoRunJobsPersistQueue.then(async () => {
        const dataFolder = await storage.localFileSystem.getDataFolder();
        const file = await dataFolder.createFile(AUTO_RUN_JOBS_FILE_NAME, { overwrite: true });
        await file.write(JSON.stringify(records, null, 2));
    });
    // Keep the queue alive even if this write fails, so later calls still get their turn.
    autoRunJobsPersistQueue = writePromise.catch(() => {});
    return writePromise;
}

// Reads persisted job history from disk. Returns [] if nothing was ever written.
async function readPersistedAutoRunJobs() {
    const dataFolder = await storage.localFileSystem.getDataFolder();
    let file = null;
    try {
        file = await dataFolder.getEntry(AUTO_RUN_JOBS_FILE_NAME);
    } catch (_e) {
        return [];
    }
    if (!file) return [];
    const text = await file.read();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
        return [];
    }
}

// Restores finished/failed jobs into the Jobs dialog, and resumes tracking any job that was
// still "running" (or "queued" but never dispatched) when Photoshop last closed/crashed.
async function restoreAutoRunJobsFromDisk() {
    let records = [];
    try {
        records = await readPersistedAutoRunJobs();
    } catch (error) {
        log(`Generate job restore warning: ${describeError(error)}`);
        return;
    }
    if (records.length < 1) return;

    // Guard against duplicate/conflicting records sharing the same job id ever surfacing two
    // rows for the same job (one showing stale "running" and another showing its real terminal
    // state). When the same id appears more than once, prefer whichever record reports a
    // settled/terminal state (completed/error/stopped) over one still saying running/queued, and
    // log it — a duplicate id here would mean a job's disk record briefly disagreed with itself
    // across separate persist calls, which is exactly the kind of corruption that made an
    // already-completed job still count as "running" after a restart.
    log(`Generate job restore: loaded ${records.length} persisted record(s), states=[${records.map((r) => `${r?.id}:${r?.state}`).join(", ")}].`);
    const statePriority = { completed: 3, error: 3, stopped: 3, running: 1, queued: 0 };
    const recordsById = new Map();
    const idlessRecords = [];
    for (const record of records) {
        if (!record || typeof record !== "object") continue;
        if (record.id === undefined || record.id === null) {
            idlessRecords.push(record);
            continue;
        }
        const key = String(record.id);
        const existing = recordsById.get(key);
        if (!existing) {
            recordsById.set(key, record);
            continue;
        }
        const existingPriority = statePriority[existing.state] ?? 0;
        const candidatePriority = statePriority[record.state] ?? 0;
        log(`Generate job restore: duplicate persisted record for job ${key} (states: "${existing.state}" vs "${record.state}") — keeping the settled one.`);
        if (candidatePriority > existingPriority) recordsById.set(key, record);
    }
    records = [...idlessRecords, ...Array.from(recordsById.values())];

    const resumedJobs = [];
    for (const record of records) {
        if (!record || typeof record !== "object") continue;
        const segments = Array.isArray(record.segments) ? record.segments : [];
        for (const segment of segments) {
            segment.snapshotFile = segment.snapshotPath
                ? await openPersistedAutoRunSnapshot(segment.snapshotPath)
                : null;
            segment.thumbnailFile = segment.thumbnailPath
                ? await openPersistedAutoRunSnapshot(segment.thumbnailPath)
                : null;
        }
        const job = {
            ...record,
            segments,
            stopRequested: false,
            completedRuns: Number(record.completedRuns) || 0,
            queuedRuns: Number(record.queuedRuns) || 0,
            lastImportedOutput: record.lastImportedOutput || null
        };
        if (job.state === "completed" || job.state === "error" || job.state === "stopped") {
            autoRunState.finishedJobs.push(job);
        } else if (job.state === "running") {
            job.resumedAfterRestart = true;
            // Trust the persisted last-known sub-state (queued/running/importing) rather than
            // assuming every resumed job is actively "running" — a job that was still waiting on
            // the backend queue before the restart should keep reading "Queued" until the very
            // first status poll below (resumeTrackingAutoRunJob) says otherwise, not jump straight
            // to "Running".
            if (!job.activityState) job.activityState = "queued";
            if (!job.progressState) job.progressState = job.activityState;
            autoRunState.activeJobs.push(job);
            resumedJobs.push(job);
        } else {
            // "queued" jobs were never actually dispatched before the crash — re-running the
            // whole upload/queue flow blind isn't safe, so surface it as a failed job instead
            // of silently losing it.
            job.state = "error";
            job.errorDetail = "Interrupted before starting (Photoshop restarted).";
            job.logText = `${job.logText || ""}[${new Date().toISOString()}] Generate: interrupted before starting (Photoshop restarted).\n`;
            autoRunState.finishedJobs.push(job);
        }
    }

    const maxId = records.reduce((max, record) => Math.max(max, Number(record?.id) || 0), 0);
    if (maxId >= autoRunState.nextJobId) autoRunState.nextJobId = maxId + 1;

    const finishedCountBeforeCap = autoRunState.finishedJobs.length;
    capFinishedAutoRunJobs();
    if (autoRunState.finishedJobs.length < finishedCountBeforeCap) {
        persistAutoRunJobsToDisk().catch((error) => {
            log(`Generate job persistence warning: ${describeError(error)}`);
        });
    }

    syncAutoRunRuntimeStateFromActiveJobs();
    renderAutoRunJobsDialog();
    syncAutoRunButtonState();
    // The main panel's shared progress label is built once when the Auto Run button row is
    // created, before this restore runs — without refreshing it here it would keep reading
    // "Ready" even though a resumed job is actually running/queued underneath it.
    if (resumedJobs.length > 0) {
        setAutoRunProgressState({ visible: true, percent: autoRunState.progressPercent || 50, text: "Running" });
    }

    if (resumedJobs.length > 0) {
        processResumedAutoRunJobs(resumedJobs);
    }
}

// Kicks off background completion-tracking for every job that was still running when Photoshop
// last closed/crashed. Each resumed job never auto-imports on completion (see
// executePreparedAutoRunJob's resumedAfterRestart guard) — it always needs a manual
// Download & Import click, since the document open now may not be the one the job targeted.
function processResumedAutoRunJobs(resumedJobs) {
    for (const job of resumedJobs) {
        resumeTrackingAutoRunJob(job)
            .catch((error) => {
                logForJob(job, `Generate resume error: ${describeError(error)}`);
            })
            .finally(() => {
                autoRunState.activeJobs = autoRunState.activeJobs.filter((activeJob) => activeJob !== job);
                finalizeAutoRunJob(job);
                syncAutoRunRuntimeStateFromActiveJobs();
                renderAutoRunJobsDialog();
                syncAutoRunButtonState();
                if (getAutoRunActiveOrQueuedJobCount() < 1) {
                    setAutoRunProgressState({ visible: true, percent: 0, text: "Ready" });
                } else {
                    // Other resumed/queued jobs are still active — the live (non-restart) job
                    // path recomputes the shared aggregate label at the exact moment a job
                    // completes (see executePreparedAutoRunJob), but this resume path had no
                    // equivalent call, so the label kept showing whatever running/queued counts
                    // were true right after the restart and never accounted for a resumed job
                    // finishing while others were still in flight. Recompute it now the same way.
                    setAutoRunProgressState({
                        visible: autoRunState.progressVisible,
                        percent: autoRunState.progressPercent,
                        text: autoRunState.progressText
                    });
                }
            });
    }
}

// Re-establishes tracking for a job that was still "running" when Photoshop last closed/crashed.
// Skips upload/dispatch entirely (the backend already has these prompts queued/running from the
// prior session) and just waits for each already-dispatched segment to finish, reusing the same
// waitForAutoRunPromptResult() polling helper the live job-execution path uses.
async function resumeTrackingAutoRunJob(job) {
    const useRunComfy = Boolean(job.useRunComfy);
    const useRunPod = Boolean(job.useRunPod);
    const useCloud = Boolean(job.useCloud);
    const backendOptions = job.backendOptions || buildAutoRunBackendOptions({
        useRunComfy,
        useRunPod,
        useCloud,
        runComfyDeploymentId: job.runComfyDeploymentId,
        runPodEndpointId: job.runPodEndpointId
    });
    const segments = Array.isArray(job.segments) ? job.segments : [];
    logForJob(job, `Generate: resuming tracking for ${describeAutoRunJob(job)} after Photoshop restart.`);
    try {
        for (let i = 0; i < segments.length; i += 1) {
            const segment = segments[i];
            if (segment.completedEntry) continue;
            if (!segment.promptId) {
                throw new Error(`Generate: ${segment.segmentLabel || "a segment"} was never dispatched before Photoshop closed and cannot be resumed.`);
            }
            logForJob(job, `Generate: waiting for completion (${segment.promptId}) ...`);
            const completedEntry = await waitForAutoRunPromptResult(segment.promptId, {
                useCloud,
                useRunComfy,
                useRunPod,
                ...backendOptions,
                timeoutMs: 86400000, // 24 hours
                pollMs: 3000,
                shouldStop: () => Boolean(job.stopRequested),
                // Keeps the Jobs-dialog row's status label (Running/Queued) accurate for the
                // whole resume wait, instead of it being stuck on whatever it showed right after
                // the restart — same idea as the live job-execution path's onProgress handling.
                onProgress: (progress) => {
                    const nextActivityState = normalizeAutoRunProgressState(progress?.state) === "queued" ? "queued" : "running";
                    const didActivityStateChange = job.activityState !== nextActivityState;
                    job.activityState = nextActivityState;
                    job.progressState = job.activityState;
                    if (didActivityStateChange) {
                        renderAutoRunJobsDialog();
                        // Also refresh the shared main-panel progress label — it aggregates
                        // running/queued counts across every tracked job, so a change to just
                        // this one resumed job's sub-state can change that aggregate text too.
                        setAutoRunProgressState({
                            visible: autoRunState.progressVisible,
                            percent: autoRunState.progressPercent,
                            text: autoRunState.progressText
                        });
                    }
                }
            });
            if (!completedEntry) {
                throw new Error(`Generate: ${segment.segmentLabel || "a segment"} did not report completion.`);
            }
            segment.completedEntry = completedEntry;
            job.completedRuns += 1;
            logForJob(job, `Generate: completed (${segment.promptId}).`);
        }
        job.activityState = "idle";
        job.progressState = "idle";
        job.state = "completed";
        job.completedAtMs = Date.now();
    } catch (error) {
        const rawDetail = describeError(error);
        const stoppedByUser = String(rawDetail || "").includes("stopped by user");
        job.activityState = "idle";
        job.progressState = "idle";
        if (stoppedByUser) {
            job.state = "stopped";
            logForJob(job, "Generation stopped by user.");
        } else {
            job.state = "error";
            const detail = normalizePluginError(rawDetail);
            job.errorDetail = detail;
            logForJob(job, `Generate error: ${detail}`);
        }
    } finally {
        job.stopRequested = false;
    }
}

// Handles sync connection fields from state.
function syncConnectionFieldsFromState() {
    if (serverField) serverField.value = normalizeServerSettingValue(settingsState.server);
    updateServerSecurityLabel();
    if (portField) portField.value = normalizePort(settingsState.port);
    if (environmentSelect) environmentSelect.value = normalizeEnvironmentMode(settingsState.environment);
    if (deploymentSelect) {
        deploymentSelect.value = normalizeEnvironmentMode(settingsState.environment) === "runpod"
            ? String(settingsState.runpodEndpointId || "")
            : String(settingsState.runcomfyDeploymentId || "");
    }
    if (fitCanvasWholeImageCheckbox) fitCanvasWholeImageCheckbox.checked = Boolean(settingsState.fitCanvasWholeImageImports);
    if (importJobResultAutomaticallyCheckbox) {
        importJobResultAutomaticallyCheckbox.checked = Boolean(settingsState.importJobResultAutomatically);
    }
    updateConnectionModeUi();
}

// Applies connection fields to state.
function applyConnectionFieldsToState() {
    if (serverField) settingsState.server = normalizeServerSettingValue(serverField.value);
    if (portField) settingsState.port = normalizePort(portField.value);
    if (environmentSelect) settingsState.environment = normalizeEnvironmentMode(environmentSelect.value || "local");
    if (deploymentSelect) {
        const deploymentValue = String(deploymentSelect.value || "").trim();
        if (normalizeEnvironmentMode(settingsState.environment) === "runpod") {
            settingsState.runpodEndpointId = deploymentValue;
        } else {
            settingsState.runcomfyDeploymentId = deploymentValue;
        }
    }
    settingsState.useComfyCloud = settingsState.environment !== "local";
    if (fitCanvasWholeImageCheckbox) settingsState.fitCanvasWholeImageImports = Boolean(fitCanvasWholeImageCheckbox.checked);
    if (importJobResultAutomaticallyCheckbox) {
        settingsState.importJobResultAutomatically = Boolean(importJobResultAutomaticallyCheckbox.checked);
    }
}

// Applies enabled/disabled state for local connection fields based on active transport mode.
function updateConnectionModeUi() {
    const environmentMode = normalizeEnvironmentMode(settingsState.environment);
    const useCloud = environmentMode !== "local";
    const useRunComfy = environmentMode === "runcomfy";
    const useRunPod = environmentMode === "runpod";
    const useServerless = useRunComfy || useRunPod;
    const useLocal = environmentMode === "local";
    if (openComfyUiBtn) {
        const openLabel = useRunComfy ? "Open RunComfy" : (useRunPod ? "Open RunPod" : "Open ComfyUI");
        openComfyUiBtn.textContent = openLabel;
        openComfyUiBtn.setAttribute("aria-label", openLabel);
    }
    if (deploymentFieldLabel) deploymentFieldLabel.textContent = useRunPod ? "Endpoint" : "Deployment";
    if (deploymentRow) {
        deploymentRow.style.display = useServerless ? "" : "none";
        deploymentRow.classList.toggle("isHidden", !useServerless);
    }
    if (deploymentSelect) deploymentSelect.disabled = !useServerless;
    if (deploymentStatusLabel) {
        deploymentStatusLabel.style.display = useServerless ? "" : "none";
    }
    if (deploymentStatusMetaLabel) {
        deploymentStatusMetaLabel.style.display = useRunPod ? "" : "none";
    }
    if (localServerStatusLabel) {
        localServerStatusLabel.style.display = useLocal ? "" : "none";
    }
    if (localServerQueueLabel) {
        localServerQueueLabel.style.display = useLocal ? "" : "none";
    }
    if (cloudStatusLabel) {
        cloudStatusLabel.style.display = environmentMode === "cloud" ? "" : "none";
    }
    if (cloudQueueLabel) {
        cloudQueueLabel.style.display = environmentMode === "cloud" ? "" : "none";
    }
    if (deploymentWarmupBtn) {
        deploymentWarmupBtn.style.display = useRunComfy ? "" : "none";
        deploymentWarmupBtn.disabled = !useRunComfy;
    }
    if (deploymentEndpointSettingsBtn) {
        deploymentEndpointSettingsBtn.style.display = useRunPod ? "" : "none";
        // Pressable whenever shown: with no endpoint selected (or no token), the click handler
        // shows the reason as an error toast instead of the button silently greying out.
        deploymentEndpointSettingsBtn.disabled = !useRunPod;
    }
    if (deploymentComfySettingsBtn) {
        deploymentComfySettingsBtn.style.display = useRunComfy ? "" : "none";
        // Pressable whenever shown; missing deployment/token is reported as an error toast on click.
        deploymentComfySettingsBtn.disabled = !useRunComfy;
    }
    if (connectionRow) {
        connectionRow.style.display = useCloud ? "none" : "";
        connectionRow.classList.toggle("isHidden", useCloud);
    }
    if (autoRunCard) {
        autoRunCard.style.display = "";
        autoRunCard.classList.remove("isHidden");
    }
    if (bridgeCard) {
        bridgeCard.style.display = useCloud ? "none" : "";
        bridgeCard.classList.toggle("isHidden", useCloud);
    }
    if (serverField) serverField.disabled = useCloud;
    if (portField) portField.disabled = useCloud;
    if (useCloud) {
        hideServerRecentList();
        hidePortRecentList();
    }
}

// Renders deployment status label with semantic coloring.
function renderRunComfyDeploymentStatusLabel(stateText, tone = "unknown", options = {}) {
    if (!deploymentStatusLabel) return;
    const rawLabel = String(stateText || "Unknown").trim() || "Unknown";
    const label = Boolean(options.preserveCase)
        ? rawLabel
        : rawLabel
            .split(/[\s_-]+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
            .join(" ");
    deploymentStatusLabel.textContent = label;
    applyDeploymentStatusTone(deploymentStatusLabel, tone);
    if (deploymentStatusMetaLabel) {
        const metaLabel = isRunPodEnvironment()
            ? String(options.metaStatusText || label || "Unknown").trim() || "Unknown"
            : "";
        const metaTone = String(options.metaTone || tone || "unknown").trim();
        deploymentStatusMetaLabel.textContent = metaLabel || "Unknown";
        applyDeploymentStatusTone(deploymentStatusMetaLabel, metaTone);
    }
}

// Applies the shared deployment status tones to both the summary and status labels.
function applyDeploymentStatusTone(element, tone = "unknown") {
    if (!element) return;
    element.classList.remove("isRunning", "isOff", "isUnknown", "isError");
    if (tone === "running") element.classList.add("isRunning");
    else if (tone === "off") element.classList.add("isOff");
    else if (tone === "error") element.classList.add("isError");
    else element.classList.add("isUnknown");
}

// Renders local server status label with semantic coloring.
function renderLocalServerStatusLabel(stateText, tone = "unknown") {
    if (!localServerStatusLabel) return;
    const label = String(stateText || "Unknown").trim() || "Unknown";
    localServerStatusLabel.textContent = label;
    applyDeploymentStatusTone(localServerStatusLabel, tone);
}

// Maps raw RunComfy deployment status to UI tone.
function mapRunComfyDeploymentStatusTone(statusValue) {
    const status = String(statusValue || "").trim().toLowerCase();
    if (!status) return { label: "Unknown", tone: "unknown" };
    if (status.includes("running") || status.includes("active") || status.includes("busy")) {
        return { label: statusValue, tone: "running" };
    }
    if (status.includes("standby") || status.includes("off") || status.includes("idle") || status.includes("stopped")) {
        return { label: statusValue, tone: "off" };
    }
    return { label: statusValue, tone: "unknown" };
}

// Reads the max-workers setting from a RunPod endpoint record while tolerating field-name variants.
function getRunPodEndpointMaxWorkers(endpoint) {
    const candidates = [
        endpoint?.workersMax,
        endpoint?.workers_max,
        endpoint?.maxWorkers,
        endpoint?.max_workers
    ];
    for (let i = 0; i < candidates.length; i += 1) {
        const value = Number(candidates[i]);
        if (Number.isFinite(value)) return value;
    }
    return 0;
}

// Returns true when a RunPod endpoint should appear in the picker.
function isRunPodEndpointListable(endpoint) {
    if (!endpoint || typeof endpoint !== "object") return false;
    if (getRunPodEndpointMaxWorkers(endpoint) < 1) return false;
    if (Object.prototype.hasOwnProperty.call(endpoint, "enabled")) return Boolean(endpoint.enabled);
    if (Object.prototype.hasOwnProperty.call(endpoint, "disabled")) return !Boolean(endpoint.disabled);
    return true;
}

// Pulls one numeric count from flexible health payload shapes and preserves whether the field existed.
function getRunPodHealthOptionalCount(payload, candidatePaths = []) {
    for (let i = 0; i < candidatePaths.length; i += 1) {
        const path = candidatePaths[i];
        let cursor = payload;
        for (let partIndex = 0; partIndex < path.length; partIndex += 1) {
            if (!cursor || typeof cursor !== "object") {
                cursor = undefined;
                break;
            }
            cursor = cursor[path[partIndex]];
        }
        const value = Number(cursor);
        if (Number.isFinite(value)) return Math.max(0, Math.round(value));
    }
    return null;
}

// Pulls a numeric count from flexible health payload shapes without depending on one exact schema.
function getRunPodHealthCount(payload, candidatePaths = []) {
    const value = getRunPodHealthOptionalCount(payload, candidatePaths);
    return value === null ? 0 : value;
}

// Reads one numeric value from flexible endpoint metadata paths.
function getRunPodEndpointNumericValue(endpoint, candidatePaths = []) {
    for (let i = 0; i < candidatePaths.length; i += 1) {
        const path = candidatePaths[i];
        let cursor = endpoint;
        for (let partIndex = 0; partIndex < path.length; partIndex += 1) {
            if (!cursor || typeof cursor !== "object") {
                cursor = undefined;
                break;
            }
            cursor = cursor[path[partIndex]];
        }
        const value = Number(cursor);
        if (Number.isFinite(value)) return value;
    }
    return null;
}

// Returns the selected RunPod endpoint record cached from the latest list response.
function getSelectedRunPodEndpointMetadata() {
    const endpointId = String(getRunPodEndpointId() || "").trim();
    if (!endpointId) return null;
    return runPodEndpointMetadataById.get(endpointId) || null;
}

// Maps RunPod state/health signals to the short status word shown in the deployment row.
function mapRunPodEndpointStateLabel(rawState, healthPayload = null) {
    const idleWorkers = getRunPodHealthOptionalCount(healthPayload, [
        ["workers", "idle"],
        ["idleWorkers"],
        ["idle_workers"]
    ]);
    const runningWorkers = getRunPodHealthOptionalCount(healthPayload, [
        ["workers", "running"],
        ["workers", "active"],
        ["runningWorkers"],
        ["running_workers"]
    ]);
    const jobsInProgress = getRunPodHealthCount(healthPayload, [
        ["jobs", "inProgress"],
        ["jobs", "in_progress"],
        ["jobs", "processing"],
        ["inProgress"],
        ["in_progress"]
    ]);
    if (idleWorkers !== null) {
        if (idleWorkers > 0) return { label: "Ready", tone: "running" };
        const effectiveRunningWorkers = runningWorkers === null ? 0 : runningWorkers;
        if (effectiveRunningWorkers > jobsInProgress) return { label: "Ready", tone: "running" };
        return effectiveRunningWorkers > 0
            ? { label: "All workers busy", tone: "unknown" }
            : { label: "No workers available", tone: "unknown" };
    }

    const normalized = String(rawState || "").trim().toLowerCase();
    if (normalized.includes("ready") || normalized.includes("healthy")) return { label: "Ready", tone: "running" };
    if (normalized.includes("running") || normalized.includes("processing") || normalized.includes("in_progress")) {
        return { label: "Running", tone: "running" };
    }
    if (normalized.includes("queue") || normalized.includes("pending") || normalized.includes("starting") || normalized.includes("warm")) {
        return { label: "Starting", tone: "unknown" };
    }
    if (normalized.includes("offline") || normalized.includes("error") || normalized.includes("failed")) {
        return { label: "Offline", tone: "error" };
    }

    const jobsWaiting = getRunPodHealthCount(healthPayload, [
        ["jobs", "inQueue"],
        ["jobs", "queued"],
        ["jobs", "waiting"],
        ["inQueue"],
        ["queue"],
        ["queued"]
    ]);
    if (jobsInProgress > 0) return { label: "Running", tone: "running" };
    if (jobsWaiting > 0) return { label: "Queued", tone: "unknown" };
    return { label: "Ready", tone: "running" };
}

// Returns the normalized RunPod state label without adding numeric worker counts.
function formatRunPodEndpointStateMetaLabel(stateLabel, healthPayload = null) {
    const safeStateLabel = String(stateLabel || "Unknown").trim() || "Unknown";
    return safeStateLabel;
}

// Formats the RunPod health summary required by the panel status label.
function formatRunPodEndpointHealthLabel(healthPayload) {
    const runningWorkers = getRunPodHealthCount(healthPayload, [
        ["workers", "running"],
        ["workers", "active"],
        ["runningWorkers"],
        ["running_workers"]
    ]);
    const jobsInProgress = getRunPodHealthCount(healthPayload, [
        ["jobs", "inProgress"],
        ["jobs", "in_progress"],
        ["jobs", "processing"],
        ["inProgress"],
        ["in_progress"]
    ]);
    const jobsWaiting = getRunPodHealthCount(healthPayload, [
        ["jobs", "inQueue"],
        ["jobs", "queued"],
        ["jobs", "waiting"],
        ["inQueue"],
        ["queue"],
        ["queued"]
    ]);
    const idleWorkers = getRunPodHealthCount(healthPayload, [
        ["workers", "idle"],
        ["idleWorkers"],
        ["idle_workers"]
    ]);
    const pl = (n, singular, plural) => `${n} ${n === 1 ? singular : plural}`;
    return {
        label: [
            pl(idleWorkers,    "idle worker",    "idle workers"),
            pl(runningWorkers, "running worker",  "running workers"),
            pl(jobsInProgress, "job in progress", "jobs in progress"),
            pl(jobsWaiting,    "job in queue",    "jobs in queue"),
        ].join(" • "),
        tone: "off"
    };
}

// Returns true when a RunComfy deployment record should appear in the picker.
// The API can expose availability through either enabled or disabled-style flags,
// so this normalizes the common variants before the list is rendered.
function isRunComfyDeploymentListable(deployment) {
    if (!deployment || typeof deployment !== "object") return false;

    if (Object.prototype.hasOwnProperty.call(deployment, "enabled")) {
        return Boolean(deployment.enabled);
    }
    if (Object.prototype.hasOwnProperty.call(deployment, "is_enabled")) {
        return Boolean(deployment.is_enabled);
    }
    if (Object.prototype.hasOwnProperty.call(deployment, "disabled")) {
        return !Boolean(deployment.disabled);
    }
    if (Object.prototype.hasOwnProperty.call(deployment, "is_disabled")) {
        return !Boolean(deployment.is_disabled);
    }

    const status = String(deployment.status || deployment.state || "").trim().toLowerCase();
    if (status === "disabled") return false;
    return true;
}

// Fetches selected deployment status from RunComfy Deployment API and updates UI.
async function refreshRunComfyDeploymentStatus(options = {}) {
    const showChecking = options.showChecking !== false;
    if (!isRunComfyEnvironment() && !isRunPodEnvironment()) return;
    const isRunPod = isRunPodEnvironment();
    const emptyRunPodHealth = formatRunPodEndpointHealthLabel(null);
    const deploymentId = String(
        isRunPod
            ? (options.runPodEndpointId || getRunPodEndpointId() || "")
            : (options.runComfyDeploymentId || getRunComfyDeploymentId() || "")
    ).trim();
    const token = isRunPod ? getRunPodApiToken() : getRunComfyApiToken();
    if (!deploymentId) {
        renderRunComfyDeploymentStatusLabel(
            isRunPod ? "No endpoint selected" : "No deployment selected",
            "unknown",
            isRunPod
                ? {
                    metaStatusText: emptyRunPodHealth.label,
                    metaTone: "off"
                }
                : {}
        );
        return;
    }
    if (!token) {
        renderRunComfyDeploymentStatusLabel(
            "Missing API token",
            "unknown",
            isRunPod
                ? {
                    metaStatusText: emptyRunPodHealth.label,
                    metaTone: "off"
                }
                : {}
        );
        return;
    }
    if (showChecking) {
        renderRunComfyDeploymentStatusLabel(
            isRunPod ? emptyRunPodHealth.label : "Checking...",
            "off",
            isRunPod
                ? {
                    metaStatusText: "Checking...",
                    metaTone: "unknown"
                }
                : {}
        );
    }
    try {
        const response = await fetch(
            isRunPod
                ? runPodEndpointApiUrl(deploymentId, "/health")
                : runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}`),
            { headers: isRunPod ? buildRunPodRequestHeaders() : buildRunComfyRequestHeaders() }
        );
        if (!response.ok) {
            renderRunComfyDeploymentStatusLabel(
                `Error ${response.status}`,
                "error",
                isRunPod
                    ? {
                        metaStatusText: emptyRunPodHealth.label,
                        metaTone: "off"
                    }
                    : {
                        metaStatusText: `Error ${response.status}`,
                        metaTone: "error"
                    }
            );
            return;
        }
        const data = await response.json();
        if (isRunPod) {
            const formatted = formatRunPodEndpointHealthLabel(data);
            const selectedEndpoint = getSelectedRunPodEndpointMetadata();
            const stateSummary = mapRunPodEndpointStateLabel(
                data?.status || data?.state || selectedEndpoint?.status || selectedEndpoint?.state || "",
                data
            );
            renderRunComfyDeploymentStatusLabel(formatted.label, formatted.tone, {
                preserveCase: true,
                metaStatusText: formatRunPodEndpointStateMetaLabel(stateSummary.label, data),
                metaTone: stateSummary.tone
            });
            return;
        }
        const rawStatus = String(data?.status || "").trim() || "Unknown";
        const mapped = mapRunComfyDeploymentStatusTone(rawStatus);
        renderRunComfyDeploymentStatusLabel(mapped.label, mapped.tone, {
            metaStatusText: mapped.label,
            metaTone: mapped.tone
        });
    } catch (_e) {
        renderRunComfyDeploymentStatusLabel(
            "Offline",
            "error",
            isRunPod
                ? {
                    metaStatusText: emptyRunPodHealth.label,
                    metaTone: "off"
                }
                : {
                    metaStatusText: "Offline",
                    metaTone: "error"
                }
        );
    }
}

// Starts/stops RunComfy deployment status polling based on active environment.
function syncRunComfyDeploymentStatusPolling() {
    if (runComfyDeploymentStatusPollTimer) {
        clearInterval(runComfyDeploymentStatusPollTimer);
        runComfyDeploymentStatusPollTimer = 0;
    }
    if (!isRunComfyEnvironment() && !isRunPodEnvironment()) return;
    refreshRunComfyDeploymentStatus({ showChecking: true }).catch(() => {});
    runComfyDeploymentStatusPollTimer = setInterval(() => {
        refreshRunComfyDeploymentStatus({ showChecking: false }).catch(() => {});
    }, 2500);
}

// Queue line under the server/cloud status ("1 job running • 2 jobs in queue"). It is always
// shown: real counts once known, 0/0 when the server is off or unreachable, and while a check is
// in flight the last counts are kept (see keepQueueLabelWhileChecking).
function renderQueueCountsLabel(label, runningCount, pendingCount) {
    if (!label) return;
    const pl = (n, s, p) => `${n} ${n === 1 ? s : p}`;
    label.textContent = `${pl(runningCount, "job running", "jobs running")} • ${pl(pendingCount, "job in queue", "jobs in queue")}`;
}

// While a status check is in flight: keep the queue line as it is, or show 0/0 if it has never
// been filled, so it never disappears.
function keepQueueLabelWhileChecking(label) {
    if (label && !String(label.textContent || "").trim()) renderQueueCountsLabel(label, 0, 0);
}

// Checks local ComfyUI server availability and updates the status label with queue info.
async function refreshLocalServerStatus(options = {}) {
    const showChecking = options.showChecking !== false;
    if (normalizeEnvironmentMode(settingsState.environment) !== "local") return;
    if (showChecking) {
        // The orange "Checking..." is shown on the security label above; this line reads "Off"
        // until the server answers.
        renderLocalServerStatusLabel("Off", "off");
        keepQueueLabelWhileChecking(localServerQueueLabel);
    }
    // The address this check is for, read once so the label is only updated for it.
    const checkedServer = serverField ? serverField.value : "";
    const checkedPort = portField ? portField.value : "";
    const checkedKey = getLocalServerProbeKey(checkedServer, checkedPort);
    const setReachable = (reachable) => {
        localServerConnectionState = { key: checkedKey, reachable };
        if (!reachable && isBareLocalServerAddress(checkedServer)) forgetLocalServerScheme(checkedServer, checkedPort);
        updateServerSecurityLabel();
    };
    try {
        // Work out HTTPS vs HTTP first (no-op once known, or for an address typed with a scheme),
        // so this check and every later request use the protocol the server actually speaks.
        await detectLocalServerScheme(checkedServer, checkedPort);
        const response = await fetch(comfyApiUrl("/queue", { localServer: checkedServer, localPort: checkedPort }));
        // Any HTTP response means the server answered at this address and protocol.
        setReachable(true);
        if (!response.ok) {
            renderLocalServerStatusLabel("Off", "off");
            renderQueueCountsLabel(localServerQueueLabel, 0, 0);
            return;
        }
        // Parse queue counts to show richer status in the gray sub-label.
        let runningCount = 0;
        let pendingCount = 0;
        try {
            const queueData = await response.json();
            runningCount = Array.isArray(queueData.queue_running) ? queueData.queue_running.length : 0;
            pendingCount = Array.isArray(queueData.queue_pending) ? queueData.queue_pending.length : 0;
        } catch (_parseErr) {
            renderLocalServerStatusLabel("Running", "running");
            renderQueueCountsLabel(localServerQueueLabel, 0, 0);
            return;
        }
        const stateLabel = runningCount > 0 ? "Running" : "Idle";
        renderLocalServerStatusLabel(stateLabel, "running");
        renderQueueCountsLabel(localServerQueueLabel, runningCount, pendingCount);
    } catch (_e) {
        setReachable(false);
        renderLocalServerStatusLabel("Off", "off");
        renderQueueCountsLabel(localServerQueueLabel, 0, 0);
    }
}

// Starts/stops local server status polling based on active environment.
function syncLocalServerStatusPolling() {
    if (localServerStatusPollTimer) {
        clearInterval(localServerStatusPollTimer);
        localServerStatusPollTimer = 0;
    }
    if (normalizeEnvironmentMode(settingsState.environment) !== "local") return;
    refreshLocalServerStatus({ showChecking: true }).catch(() => {});
    localServerStatusPollTimer = setInterval(() => {
        refreshLocalServerStatus({ showChecking: false }).catch(() => {});
    }, 2500);
}

// Polls GET /api/queue on Comfy Cloud and renders state + queue counts in the cloud labels.
async function refreshCloudQueueStatus() {
    if (!isComfyCloudEnabled()) return;
    try {
        const response = await fetch(comfyApiUrl("/api/queue", { useCloud: true }), {
            headers: buildComfyRequestHeaders({ useCloud: true }),
        });
        if (!response.ok) {
            if (cloudStatusLabel) {
                cloudStatusLabel.textContent = "Unknown";
                applyDeploymentStatusTone(cloudStatusLabel, "unknown");
            }
            renderQueueCountsLabel(cloudQueueLabel, 0, 0);
            return;
        }
        const data = await response.json();
        const runningCount = Array.isArray(data.queue_running) ? data.queue_running.length : 0;
        const pendingCount = Array.isArray(data.queue_pending) ? data.queue_pending.length : 0;
        if (cloudStatusLabel) {
            cloudStatusLabel.textContent = runningCount > 0 ? "Running" : "Idle";
            applyDeploymentStatusTone(cloudStatusLabel, "running");
        }
        renderQueueCountsLabel(cloudQueueLabel, runningCount, pendingCount);
    } catch (_e) {
        if (cloudStatusLabel) {
            cloudStatusLabel.textContent = "Unknown";
            applyDeploymentStatusTone(cloudStatusLabel, "unknown");
        }
        renderQueueCountsLabel(cloudQueueLabel, 0, 0);
    }
}

// Starts/stops Comfy Cloud queue label polling based on active environment.
function syncCloudQueuePolling() {
    if (cloudQueueStatusPollTimer) {
        clearInterval(cloudQueueStatusPollTimer);
        cloudQueueStatusPollTimer = 0;
    }
    if (!isComfyCloudEnabled()) return;
    // Same "Checking..." (orange/unknown tone) placeholder Local and RunComfy show while the first
    // status request is in flight; the 2.5s polls after it update the label silently.
    if (cloudStatusLabel) {
        cloudStatusLabel.textContent = "Checking...";
        applyDeploymentStatusTone(cloudStatusLabel, "unknown");
    }
    keepQueueLabelWhileChecking(cloudQueueLabel);
    refreshCloudQueueStatus().catch(() => {});
    cloudQueueStatusPollTimer = setInterval(() => {
        refreshCloudQueueStatus().catch(() => {});
    }, 2500);
}

// Sends a lightweight RunComfy request to warm up the selected deployment.
async function warmupRunComfyDeployment() {
    if (!isRunComfyEnvironment()) return;
    const deploymentId = getRunComfyDeploymentId();
    const token = getRunComfyApiToken();
    if (!deploymentId) throw new Error("Select a RunComfy deployment first.");
    if (!token) throw new Error("RunComfy API token is missing.");
    renderRunComfyDeploymentStatusLabel("Starting...", "unknown");
    const warmupPayload = {
        overrides: {}
    };
    const comfyApiKey = getComfyApiKey();
    if (comfyApiKey) {
        warmupPayload.extra_data = { api_key_comfy_org: comfyApiKey };
    }
    const response = await fetch(
        runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}/inference`),
        {
            method: "POST",
            headers: buildRunComfyRequestHeaders({ includeJsonContentType: true }),
            body: JSON.stringify(warmupPayload)
        }
    );
    if (!response.ok) {
        const text = await response.text();
        renderRunComfyDeploymentStatusLabel("Failed", "unknown");
        if (text) log(`RunComfy warm up failure detail: ${text}`);
        throw new Error(`RunComfy warm up failed ${response.status}: ${text}`);
    }
    let requestId = "";
    try {
        const data = await response.json();
        requestId = String(data?.request_id || data?.requestId || "").trim();
    } catch (_e) {}
    log(`RunComfy warm up requested${requestId ? ` (request_id: ${requestId})` : ""}.`);
    if (!requestId) {
        // If request id is missing, at least show immediate acknowledgment.
        renderRunComfyDeploymentStatusLabel("Requested", "unknown");
        await refreshRunComfyDeploymentStatus();
        return;
    }

    // Poll request status briefly so the UI clearly reflects warm-up activity.
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        let statusResponse;
        try {
            statusResponse = await fetch(
                runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}/requests/${encodeURIComponent(requestId)}/status`),
                { headers: buildRunComfyRequestHeaders() }
            );
        } catch (_e) {
            await sleep(800);
            continue;
        }
        if (!statusResponse.ok) {
            await sleep(800);
            continue;
        }
        let statusData = null;
        try {
            statusData = await statusResponse.json();
        } catch (_e) {
            await sleep(800);
            continue;
        }
        const rawStatus = String(statusData?.status || statusData?.state || "").trim();
        const normalized = rawStatus.toLowerCase();
        if (!rawStatus) {
            await sleep(800);
            continue;
        }
        if (normalized === "in_progress" || normalized === "running" || normalized === "completed" || normalized === "succeeded" || normalized === "success") {
            renderRunComfyDeploymentStatusLabel("Running", "running");
            await refreshRunComfyDeploymentStatus();
            return;
        }
        if (normalized === "failed" || normalized === "error" || normalized === "cancelled" || normalized === "canceled") {
            renderRunComfyDeploymentStatusLabel("Failed", "unknown");
            throw new Error(`RunComfy warm up request failed (${rawStatus}).`);
        }
        const mapped = mapRunComfyDeploymentStatusTone(rawStatus);
        renderRunComfyDeploymentStatusLabel(mapped.label, mapped.tone);
        await sleep(800);
    }
    await refreshRunComfyDeploymentStatus();
}

// Returns RunComfy API token from settings.
function getRunComfyApiToken() {
    return String(settingsState.runcomfyToken || "").trim();
}

// Returns RunPod API token from settings.
function getRunPodApiToken() {
    return String(settingsState.runpodToken || "").trim();
}

// Populates RunComfy deployment dropdown from API list endpoint.
async function refreshRunComfyDeploymentList({ preserveSelection = true } = {}) {
    if (!deploymentSelect) return;
    const environmentMode = normalizeEnvironmentMode(settingsState.environment);
    if (environmentMode !== "runcomfy" && environmentMode !== "runpod") return;
    const isRunPod = environmentMode === "runpod";

    const previousSelection = preserveSelection
        ? String(
            deploymentSelect.value
            || (isRunPod ? settingsState.runpodEndpointId : settingsState.runcomfyDeploymentId)
            || ""
        ).trim()
        : "";

    deploymentSelect.innerHTML = "";
    const loadingOption = document.createElement("option");
    loadingOption.value = "";
    loadingOption.textContent = isRunPod ? "Loading RunPod endpoints..." : "Loading RunComfy deployments...";
    deploymentSelect.appendChild(loadingOption);
    deploymentSelect.value = "";

    const token = isRunPod ? getRunPodApiToken() : getRunComfyApiToken();
    if (!token) {
        loadingOption.textContent = isRunPod
            ? "Add RunPod API Token in Settings first."
            : "Add RunComfy API Token in Settings first.";
        return;
    }

    let response;
    try {
        response = await fetch(isRunPod ? runPodRestUrl("/v1/endpoints") : "https://api.runcomfy.net/prod/v2/deployments", {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
    } catch (_e) {
        loadingOption.textContent = isRunPod ? "Could not reach RunPod API." : "Could not reach RunComfy API.";
        return;
    }
    if (!response.ok) {
        loadingOption.textContent = isRunPod
            ? `RunPod endpoints failed (${response.status}).`
            : `RunComfy deployments failed (${response.status}).`;
        return;
    }

    let deployments = [];
    try {
        const data = await response.json();
        deployments = Array.isArray(data)
            ? data
            : (
                Array.isArray(data?.deployments) ? data.deployments
                    : (Array.isArray(data?.endpoints) ? data.endpoints
                        : (Array.isArray(data?.items) ? data.items : []))
            );
    } catch (_e) {
        loadingOption.textContent = isRunPod
            ? "Invalid RunPod endpoints response."
            : "Invalid RunComfy deployments response.";
        return;
    }

    deployments = deployments.filter((deployment) => (
        isRunPod ? isRunPodEndpointListable(deployment) : isRunComfyDeploymentListable(deployment)
    ));
    if (isRunPod) {
        runPodEndpointMetadataById.clear();
        for (let i = 0; i < deployments.length; i += 1) {
            const item = deployments[i];
            const id = String(item?.id || item?.endpointId || item?.endpoint_id || "").trim();
            if (!id) continue;
            runPodEndpointMetadataById.set(id, item);
        }
    }

    // Keep deployment choices stable and easy to scan regardless of API return order.
    deployments.sort((a, b) => {
        const aLabel = String(a?.name || a?.id || "").trim();
        const bLabel = String(b?.name || b?.id || "").trim();
        return aLabel.localeCompare(bLabel, undefined, { sensitivity: "base" });
    });

    deploymentSelect.innerHTML = "";
    if (!deployments.length) {
        const emptyOption = document.createElement("option");
        emptyOption.value = "";
        emptyOption.textContent = isRunPod
            ? "No RunPod endpoints with max workers found."
            : "No enabled RunComfy deployments found.";
        deploymentSelect.appendChild(emptyOption);
    }

    for (let i = 0; i < deployments.length; i += 1) {
        const item = deployments[i];
        if (!item || typeof item !== "object") continue;
        const id = String(item.id || item.endpointId || item.endpoint_id || "").trim();
        if (!id) continue;
        const name = String(item.name || item.endpointName || item.endpoint_name || "").trim();
        const option = document.createElement("option");
        option.value = id;
        option.textContent = name || id;
        deploymentSelect.appendChild(option);
    }

    const hasPreviousSelection = previousSelection
        && Array.from(deploymentSelect.options).some((opt) => String(opt.value || "") === previousSelection);
    if (hasPreviousSelection) {
        deploymentSelect.value = previousSelection;
    } else if (deploymentSelect.options.length > 0 && String(deploymentSelect.options[0].value || "").trim()) {
        deploymentSelect.value = String(deploymentSelect.options[0].value || "").trim();
    } else {
        deploymentSelect.value = "";
    }
    if (isRunPod) settingsState.runpodEndpointId = String(deploymentSelect.value || "").trim();
    else settingsState.runcomfyDeploymentId = String(deploymentSelect.value || "").trim();
    updateConnectionModeUi();
    await refreshRunComfyDeploymentStatus();
}

let persistConnectionSettingsTimer = 0;
// Handles schedule persist connection settings.
function schedulePersistConnectionSettings() {
    applyConnectionFieldsToState();
    if (persistConnectionSettingsTimer) clearTimeout(persistConnectionSettingsTimer);
    persistConnectionSettingsTimer = setTimeout(() => {
        persistConnectionSettingsTimer = 0;
        persistSettings().catch((error) => {
            log(`Connection settings save error: ${describeError(error)}`);
        });
    }, 250);
}

// Wires server/port input listeners so connection settings are normalized and persisted.
function wireConnectionSettingsEvents() {
    if (serverField) {
        serverField.addEventListener("input", schedulePersistConnectionSettings);
        // Live connection security hint while typing (and on commit, below).
        serverField.addEventListener("input", updateServerSecurityLabel);
        serverField.addEventListener("change", updateServerSecurityLabel);
        updateServerSecurityLabel();
        serverField.addEventListener("change", () => {
            rememberRecentServer(serverField.value);
            if (normalizeEnvironmentMode(settingsState.environment) === "local") {
                refreshLocalServerStatus().catch(() => {});
                refreshAutoRunWorkflowList({ preserveSelection: true }).catch((error) => {
                    log(`Generate workflow refresh error: ${describeError(error)}`);
                });
            }
            schedulePersistConnectionSettings();
        });
        serverField.addEventListener("focus", showServerRecentList);
        serverField.addEventListener("click", showServerRecentList);
    }
    if (portField) {
        portField.addEventListener("input", schedulePersistConnectionSettings);
        portField.addEventListener("change", () => {
            rememberRecentPort(portField.value);
            if (normalizeEnvironmentMode(settingsState.environment) === "local") {
                refreshLocalServerStatus().catch(() => {});
                refreshAutoRunWorkflowList({ preserveSelection: true }).catch((error) => {
                    log(`Generate workflow refresh error: ${describeError(error)}`);
                });
            }
            schedulePersistConnectionSettings();
        });
        portField.addEventListener("focus", showPortRecentList);
        portField.addEventListener("click", showPortRecentList);
    }
    if (environmentSelect) {
        environmentSelect.addEventListener("change", () => {
            // UXP's native dropdown fires "change" even when the same option is re-picked; skip the
            // whole reload (polling resets, deployment + workflow refresh) unless the mode changed.
            const nextEnvironment = normalizeEnvironmentMode(environmentSelect.value || "local");
            if (nextEnvironment === normalizeEnvironmentMode(settingsState.environment)) return;
            settingsState.environment = nextEnvironment;
            settingsState.useComfyCloud = settingsState.environment !== "local";
            updateConnectionModeUi();
            syncRunComfyDeploymentStatusPolling();
            syncLocalServerStatusPolling();
            syncCloudQueuePolling();
            if (settingsState.environment === "runcomfy" || settingsState.environment === "runpod") {
                refreshRunComfyDeploymentList({ preserveSelection: true }).catch((error) => {
                    log(`${isRunPodEnvironment() ? "RunPod endpoints" : "RunComfy deployments"} refresh error: ${describeError(error)}`);
                });
            }
            hideServerRecentList();
            hidePortRecentList();
            refreshAutoRunWorkflowList({ preserveSelection: true }).catch((error) => {
                log(`Generate workflow refresh error: ${describeError(error)}`);
            });
            schedulePersistConnectionSettings();
        });
    }
    if (deploymentSelect) {
        deploymentSelect.addEventListener("change", () => {
            // Same guard as the environment dropdown: ignore re-picking the current deployment.
            const nextDeploymentId = String(deploymentSelect.value || "").trim();
            const currentDeploymentId = normalizeEnvironmentMode(settingsState.environment) === "runpod"
                ? getRunPodEndpointId()
                : getRunComfyDeploymentId();
            if (nextDeploymentId === currentDeploymentId) return;
            if (normalizeEnvironmentMode(settingsState.environment) === "runpod") {
                settingsState.runpodEndpointId = String(deploymentSelect.value || "").trim();
            } else {
                settingsState.runcomfyDeploymentId = String(deploymentSelect.value || "").trim();
            }
            updateConnectionModeUi();
            refreshRunComfyDeploymentStatus().catch(() => {});
            if (normalizeEnvironmentMode(settingsState.environment) === "runcomfy"
                || normalizeEnvironmentMode(settingsState.environment) === "runpod") {
                refreshAutoRunWorkflowList({ preserveSelection: true }).catch((error) => {
                    log(`Generate workflow refresh error: ${describeError(error)}`);
                });
            }
            schedulePersistConnectionSettings();
        });
    }
    if (deploymentWarmupBtn) {
        deploymentWarmupBtn.addEventListener("click", async () => {
            try {
                deploymentWarmupBtn.disabled = true;
                await warmupRunComfyDeployment();
            } catch (error) {
                log(`RunComfy warm up error: ${describeError(error)}`);
            } finally {
                updateConnectionModeUi();
            }
        });
    }
    if (fitCanvasWholeImageCheckbox) {
        fitCanvasWholeImageCheckbox.addEventListener("change", () => {
            settingsState.fitCanvasWholeImageImports = Boolean(fitCanvasWholeImageCheckbox.checked);
            schedulePersistConnectionSettings();
        });
    }
    if (importJobResultAutomaticallyCheckbox) {
        importJobResultAutomaticallyCheckbox.addEventListener("change", () => {
            settingsState.importJobResultAutomatically = Boolean(importJobResultAutomaticallyCheckbox.checked);
            schedulePersistConnectionSettings();
        });
    }
    if (typeof window !== "undefined") {
        window.addEventListener("resize", () => {
            if (serverRecentList && !serverRecentList.classList.contains("isHidden")) {
                positionServerRecentList();
            }
            if (portRecentList && !portRecentList.classList.contains("isHidden")) {
                positionPortRecentList();
            }
        });
    }
    if (typeof document !== "undefined") {
        document.addEventListener("click", (event) => {
            const target = event?.target;
            if (!target) return;
            if (serverField && (target === serverField || serverField.contains?.(target))) return;
            if (serverRecentList && (target === serverRecentList || serverRecentList.contains?.(target))) return;
            if (portField && (target === portField || portField.contains?.(target))) return;
            if (portRecentList && (target === portRecentList || portRecentList.contains?.(target))) return;
            hideServerRecentList();
            hidePortRecentList();
        });
    }
}

// Handles sanitize workflow settings file stem.
function sanitizeWorkflowSettingsFileStem(folderName) {
    const raw = String(folderName || "").trim();
    if (!raw) return "workflow";
    let normalized = raw;
    if (typeof normalized.normalize === "function") {
        normalized = normalized.normalize("NFKD").replace(/[^\x00-\x7F]/g, "");
    }
    const sanitized = normalized
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 120);
    return sanitized || "workflow";
}

// Returns workflow settings file name.
function getWorkflowSettingsFileName(folderName) {
    const stem = sanitizeWorkflowSettingsFileStem(folderName);
    return `${WORKFLOW_SETTINGS_FILE_PREFIX}${stem}${WORKFLOW_SETTINGS_FILE_EXT}`;
}

// Handles encode ini value.
function encodeIniValue(rawValue) {
    const normalized = String(rawValue ?? "").replace(/\r\n?/g, "\n");
    return normalized.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

// Handles decode ini value.
function decodeIniValue(rawValue) {
    const text = String(rawValue ?? "");
    let out = "";
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch !== "\\") {
            out += ch;
            continue;
        }
        const next = text[i + 1];
        if (next === "n") {
            out += "\n";
            i += 1;
            continue;
        }
        if (next === "\\") {
            out += "\\";
            i += 1;
            continue;
        }
        out += ch;
    }
    return out;
}

// Parses a minimal key=value INI payload used for per-workflow sticky form values.
function parseIniTextToObject(iniText) {
    const out = {};
    const lines = String(iniText || "").replace(/\r\n?/g, "\n").split("\n");
    for (const rawLine of lines) {
        const line = String(rawLine || "");
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
        const eqIndex = line.indexOf("=");
        if (eqIndex <= 0) continue;
        const key = line.slice(0, eqIndex).trim();
        if (!key) continue;
        const value = line.slice(eqIndex + 1);
        out[key] = decodeIniValue(value);
    }
    return out;
}

// Serializes key/value workflow settings into INI text for plugin-local persistence.
function buildIniTextFromObject(values) {
    const keys = Object.keys(values || {}).sort((a, b) => a.localeCompare(b));
    const lines = keys.map((key) => `${key}=${encodeIniValue(values[key])}`);
    return lines.join("\n");
}

// Reads per-workflow sticky form values from the plugin folder.
async function readWorkflowIniSettings(folderName) {
    if (!folderName) return {};
    const dataFolder = await storage.localFileSystem.getDataFolder();
    const fileName = getWorkflowSettingsFileName(folderName);
    let iniFile = null;
    try {
        iniFile = await dataFolder.getEntry(fileName);
    } catch (_e) {
        return {};
    }
    if (!iniFile) return {};
    const text = await iniFile.read();
    if (!text) return {};
    return parseIniTextToObject(text);
}

// Persists per-workflow sticky form values to the plugin folder.
async function persistWorkflowIniSettings(folderName, values) {
    if (!folderName) return;
    const dataFolder = await storage.localFileSystem.getDataFolder();
    const fileName = getWorkflowSettingsFileName(folderName);
    const text = buildIniTextFromObject(values);
    if (!text) {
        // Workflows with no YAML parameters should not emit empty INI writes.
        try {
            const existing = await dataFolder.getEntry(fileName);
            if (existing && typeof existing.delete === "function") {
                await existing.delete();
            }
        } catch (_e) {}
        return;
    }
    const iniFile = await dataFolder.createFile(fileName, { overwrite: true });
    await iniFile.write(`${text}\n`);
}

// Handles sync settings dialog fields from state.
function syncSettingsDialogFieldsFromState() {
    if (settingsComfyApiKeyField) settingsComfyApiKeyField.value = String(settingsState.comfyApiKey || "");
    if (settingsRunComfyTokenField) settingsRunComfyTokenField.value = String(settingsState.runcomfyToken || "");
    if (settingsRunPodTokenField) settingsRunPodTokenField.value = String(settingsState.runpodToken || "");
    if (settingsCustomApiWorkflowsField) {
        settingsCustomApiWorkflowsField.value = String(settingsState.customApiWorkflowsPath || "");
        settingsCustomApiWorkflowsField.setAttribute("data-folder-token", String(settingsState.customApiWorkflowsToken || ""));
    }
    if (settingsCustomApiWorkflowsField2) {
        settingsCustomApiWorkflowsField2.value = String(settingsState.customApiWorkflowsPath2 || "");
        settingsCustomApiWorkflowsField2.setAttribute("data-folder-token", String(settingsState.customApiWorkflowsToken2 || ""));
    }
    if (settingsCropExpandField) settingsCropExpandField.value = String(getCropSelectionExpandLevel());
    if (settingsCropFeatherField) settingsCropFeatherField.value = String(getCropMaskFeatherLevel());
    if (settingsCropMergeThresholdField) settingsCropMergeThresholdField.value = String(getCropMergeThresholdLevel());
    if (settingsCropIgnoreField) settingsCropIgnoreField.value = String(getCropIgnoreWidthLevel());
    if (settingsShowUpdateNoticeCheckbox) settingsShowUpdateNoticeCheckbox.checked = settingsState.showUpdateNoticeInPanel !== false;
}

// Applies settings dialog fields to state.
function applySettingsDialogFieldsToState() {
    settingsState.comfyApiKey = String(settingsComfyApiKeyField?.value || "").trim();
    settingsState.runcomfyToken = String(settingsRunComfyTokenField?.value || "").trim();
    settingsState.runpodToken = String(settingsRunPodTokenField?.value || "").trim();
    settingsState.customApiWorkflowsPath = String(settingsCustomApiWorkflowsField?.value || "").trim();
    settingsState.customApiWorkflowsToken = String(settingsCustomApiWorkflowsField?.getAttribute("data-folder-token") || "").trim();
    settingsState.customApiWorkflowsPath2 = String(settingsCustomApiWorkflowsField2?.value || "").trim();
    settingsState.customApiWorkflowsToken2 = String(settingsCustomApiWorkflowsField2?.getAttribute("data-folder-token") || "").trim();
    settingsState.cropSelectionExpandLevel = normalizeLevelSetting(settingsCropExpandField?.value, getCropSelectionExpandLevel());
    settingsState.cropSoMaskFeatherLevel = normalizeLevelSetting(settingsCropFeatherField?.value, getCropMaskFeatherLevel());
    settingsState.cropMergeThresholdLevel = normalizeLevelSetting(settingsCropMergeThresholdField?.value, getCropMergeThresholdLevel());
    settingsState.cropIgnoreWidthLevel = normalizeLevelSetting(settingsCropIgnoreField?.value, getCropIgnoreWidthLevel());
    if (settingsShowUpdateNoticeCheckbox) settingsState.showUpdateNoticeInPanel = Boolean(settingsShowUpdateNoticeCheckbox.checked);
    renderPluginUpdateNotices();
}

// Closes settings view and restores the main panel without a full reload —
// a reload used to be needed here to work around the server/port recent-list
// popups getting stuck in a stale position after switching views, but that
// also wiped in-memory Auto Run job tracking. Explicitly closing the popups
// fixes the real issue without losing job state.
function closeSettingsDialog() {
    dismissFloatingBoxes();
    if (!settingsView) return;
    settingsView.style.display = "none";
    // Re-mask every secret field so a key revealed via the "S" eye button
    // doesn't stay visible the next time Settings is opened.
    document.querySelectorAll(".settingsTokenEyeBtn").forEach((btn) => {
        const targetId = btn.getAttribute("data-target");
        const input = targetId ? document.getElementById(targetId) : null;
        if (input) input.type = "password";
    });
    const mainWrapper = document.querySelector(".wrapper");
    if (mainWrapper) {
        mainWrapper.style.display = "";
        resetPanelScroll(mainWrapper);
    }
    if (settingsToggle) settingsToggle.setAttribute("aria-pressed", "false");
    hideServerRecentList();
    hidePortRecentList();
}

// Opens settings view: syncs fields then swaps the main wrapper for the settings panel.
function openSettingsDialog() {
    dismissFloatingBoxes();
    if (!settingsView) return;
    syncSettingsDialogFieldsFromState();
    if (settingsToggle) settingsToggle.setAttribute("aria-pressed", "true");
    const mainWrapper = document.querySelector(".wrapper");
    if (mainWrapper) mainWrapper.style.display = "none";
    settingsView.style.display = "block";
    // Retry a failed update check (e.g. Photoshop was started offline) so Settings > Update
    // shows a real result; successful results are kept for the session.
    if (pluginUpdateCheckState === "error") checkForPluginUpdate().catch(() => {});
}

// Saves settings from dialog.
async function saveSettingsFromDialog() {
    applySettingsDialogFieldsToState();
    syncSettingsDialogFieldsFromState();
    await persistSecureComfyApiKey(settingsState.comfyApiKey);
    await persistSecureRunComfyToken(settingsState.runcomfyToken);
    await persistSecureRunPodToken(settingsState.runpodToken);
    await persistSettings();
    log(
        `Settings saved: custom workflows=${settingsState.customApiWorkflowsPath || "(default)"}, `
        + `expand level=${getCropSelectionExpandLevel().toFixed(3)}, `
        + `contract=auto(0.5x expand), feather level=${getCropMaskFeatherLevel().toFixed(3)}, `
        + `merge level=${getCropMergeThresholdLevel().toFixed(3)}, `
        + `ignore level=${getCropIgnoreWidthLevel().toFixed(3)}.`
    );
    await initializeNanoBananaForm();
    closeSettingsDialog();
}

// Wires settings dialog events.
function wireSettingsDialogEvents() {
    if (openComfyUiBtn) {
        openComfyUiBtn.addEventListener("click", async () => {
            try {
                applyConnectionFieldsToState();
                const targetUrl = isRunComfyEnvironment()
                    ? "https://www.runcomfy.com/comfyui-api/deployments"
                    : (isRunPodEnvironment()
                        ? "https://www.runpod.io/console/serverless"
                        : (isComfyCloudEnabled() ? "https://cloud.comfy.org" : comfyBaseUrl()));
                let opened = false;

                // Primary path: UXP external browser integration.
                if (!opened && shell && typeof shell.openExternal === "function") {
                    try {
                        await shell.openExternal(targetUrl);
                        opened = true;
                    } catch (_e) {}
                }

                // Fallback path: host web runtime popup.
                if (!opened && typeof window !== "undefined" && typeof window.open === "function") {
                    try {
                        const w = window.open(targetUrl, "_blank");
                        opened = Boolean(w);
                    } catch (_e) {}
                }

                // Last-resort fallback: synthetic anchor click.
                if (!opened && typeof document !== "undefined" && document.body) {
                    try {
                        const link = document.createElement("a");
                        link.href = targetUrl;
                        link.target = "_blank";
                        link.rel = "noopener noreferrer";
                        link.style.display = "none";
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        opened = true;
                    } catch (_e) {}
                }

                if (!opened) {
                    throw new Error(`Could not launch browser for ${targetUrl}.`);
                }
                log(`Opened ${isRunComfyEnvironment() ? "RunComfy" : (isRunPodEnvironment() ? "RunPod" : "ComfyUI")}: ${targetUrl}`);
            } catch (error) {
                log(`Open ${isRunComfyEnvironment() ? "RunComfy" : (isRunPodEnvironment() ? "RunPod" : "ComfyUI")} error: ${describeError(error)}`);
            }
        });
    }
    if (settingsToggle) {
        settingsToggle.addEventListener("click", () => {
            if (settingsView && settingsView.style.display === "block") {
                closeSettingsDialog();
            } else {
                openSettingsDialog();
            }
        });
    }
    if (settingsCancelBtn) settingsCancelBtn.addEventListener("click", closeSettingsDialog);
    if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener("click", async () => {
            try {
                await saveSettingsFromDialog();
            } catch (error) {
                log(`Settings save error: ${describeError(error)}`);
            }
        });
    }
    if (settingsCustomApiWorkflowsClearBtn) {
        settingsCustomApiWorkflowsClearBtn.addEventListener("click", () => {
            if (settingsCustomApiWorkflowsField) {
                settingsCustomApiWorkflowsField.value = "";
                settingsCustomApiWorkflowsField.setAttribute("data-folder-token", "");
            }
        });
    }
    if (settingsCustomApiWorkflowsClearBtn2) {
        settingsCustomApiWorkflowsClearBtn2.addEventListener("click", () => {
            if (settingsCustomApiWorkflowsField2) {
                settingsCustomApiWorkflowsField2.value = "";
                settingsCustomApiWorkflowsField2.setAttribute("data-folder-token", "");
            }
        });
    }
    // Eye buttons toggle the API key/token fields between password and text.
    document.querySelectorAll(".settingsTokenEyeBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const targetId = btn.getAttribute("data-target");
            const input = targetId ? document.getElementById(targetId) : null;
            if (!input) return;
            const showing = input.type !== "password";
            // Switching type keeps the native field's horizontal scroll: after a paste the caret
            // (and so the view) sits at the END of the key, so the revealed text looks scrolled
            // right. Reset the caret to the start once UXP has applied the new type (deferred a
            // tick — doing it synchronously had no visible effect). Focus is needed for the caret
            // move to apply. Each step is best-effort so the toggle itself always works.
            const value = input.value;
            input.type = showing ? "password" : "text";
            input.value = value;
            setTimeout(() => {
                try {
                    input.focus();
                } catch (_e) {}
                try {
                    input.setSelectionRange(0, 0);
                } catch (_e) {}
                try {
                    input.scrollLeft = 0;
                } catch (_e) {}
            }, 0);
        });
    });
    if (settingsCustomApiWorkflowsBrowseBtn) {
        settingsCustomApiWorkflowsBrowseBtn.addEventListener("click", async () => {
            try {
                const pickedFolder = await storage.localFileSystem.getFolder();
                if (!pickedFolder || !pickedFolder.isFolder) return;
                const token = await storage.localFileSystem.createPersistentToken(pickedFolder);
                if (settingsCustomApiWorkflowsField) {
                    settingsCustomApiWorkflowsField.value = getEntryDisplayPath(pickedFolder);
                    settingsCustomApiWorkflowsField.setAttribute("data-folder-token", String(token || "").trim());
                }
            } catch (error) {
                log(`Custom workflows folder selection error: ${describeError(error)}`);
            }
        });
    }
    if (settingsCustomApiWorkflowsBrowseBtn2) {
        settingsCustomApiWorkflowsBrowseBtn2.addEventListener("click", async () => {
            try {
                const pickedFolder = await storage.localFileSystem.getFolder();
                if (!pickedFolder || !pickedFolder.isFolder) return;
                const token = await storage.localFileSystem.createPersistentToken(pickedFolder);
                if (settingsCustomApiWorkflowsField2) {
                    settingsCustomApiWorkflowsField2.value = getEntryDisplayPath(pickedFolder);
                    settingsCustomApiWorkflowsField2.setAttribute("data-folder-token", String(token || "").trim());
                }
            } catch (error) {
                log(`Custom workflows folder 2 selection error: ${describeError(error)}`);
            }
        });
    }
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && settingsView && settingsView.style.display === "block") {
            closeSettingsDialog();
        }
    });
}

// Wires the Auto Run jobs dialog so queued/running jobs can be selectively canceled.
function wireAutoRunJobsDialogEvents() {
    if (autoRunJobsCloseBtn) {
        autoRunJobsCloseBtn.addEventListener("click", () => {
            closeAutoRunJobsDialog();
        });
    }
    if (autoRunJobLogCloseBtn) {
        autoRunJobLogCloseBtn.addEventListener("click", () => {
            closeAutoRunJobLogView();
        });
    }
    if (autoRunJobLogSaveBtn) {
        autoRunJobLogSaveBtn.addEventListener("click", () => {
            saveAutoRunJobLogToFile().catch((error) => {
                log(`Save Job Log error: ${describeError(error)}`);
            });
        });
    }
    if (autoRunJobsClearBtn) {
        // Asks with the same small confirmation box as Bridge's Get, lined up with the job list,
        // instead of replacing the whole Jobs view.
        autoRunJobsClearBtn.addEventListener("click", async () => {
            if (autoRunState.finishedJobs.length < 1) return;
            const accepted = await showPanelConfirm("Clear job list? This cannot be undone.", {
                alignTo: autoRunJobsList
            });
            if (accepted) clearFinishedAutoRunJobs();
        });
    }
    if (autoRunJobsPager) {
        // Delegated handler for the numbered page buttons rendered by renderAutoRunJobsPager().
        autoRunJobsPager.addEventListener("click", (event) => {
            const btn = event.target && event.target.closest ? event.target.closest("[data-page]") : null;
            if (!btn) return;
            const page = Number(btn.dataset.page);
            if (!Number.isFinite(page) || page === autoRunJobsPageIndex) return;
            autoRunJobsPageIndex = page;
            renderAutoRunJobsDialog();
        });
    }
    if (autoRunJobsList) {
        autoRunJobsList.addEventListener("click", (event) => {
            const target = event.target;
            if (!target || typeof target.closest !== "function") return;
            const button = target.closest("button[data-job-id]");
            if (!button) return;
            const jobId = Number(button.dataset.jobId);
            const actionName = String(button.dataset.jobAction || "").trim();
            if (!Number.isFinite(jobId)) return;
            if (actionName === "remove") {
                // A job's row can come from either the queued list or the persisted finished/failed
                // list — try queued first (no-op if the job isn't there) and fall back to finished.
                if (!removeQueuedAutoRunJob(jobId)) {
                    removeFinishedAutoRunJob(jobId);
                }
                return;
            }
            if (actionName === "stop") {
                const runningJob = getAutoRunTrackedJobs().find((job) => Number(job?.id) === jobId && job.state === "running");
                if (!runningJob) return;
                requestActiveAutoRunJobStop(runningJob).catch((error) => {
                    log(`Generate stop request error: ${describeError(error)}`);
                });
                return;
            }
            if (actionName === "import") {
                const finishedJob = autoRunState.finishedJobs.find((job) => Number(job?.id) === jobId);
                if (!finishedJob) return;
                button.disabled = true;
                performAutoRunJobImport(finishedJob, { useActiveDocument: true })
                    // Snapshot copies are kept after import (not deleted) so the preview
                    // thumbnail keeps working and Import can be clicked again later — only
                    // removed once the user removes the job from the list.
                    .then(() => persistAutoRunJobsToDisk())
                    .catch((error) => {
                        logForJob(finishedJob, `Generate import error: ${describeError(error)}`);
                    })
                    .finally(() => {
                        renderAutoRunJobsDialog();
                        // A manual import isn't tracked as an active/queued job, so nothing else
                        // resets the shared progress row afterward — without this it would stay
                        // stuck reading "Importing".
                        if (getAutoRunActiveOrQueuedJobCount() < 1) {
                            setAutoRunProgressState({ visible: true, percent: 0, text: "Ready" });
                        }
                    });
                return;
            }
            if (actionName === "view-log") {
                const failedJob = autoRunState.finishedJobs.find((job) => Number(job?.id) === jobId);
                if (!failedJob) return;
                openAutoRunJobLogView(failedJob);
            }
        });
    }
    if (deploymentEndpointSettingsBtn) {
        deploymentEndpointSettingsBtn.addEventListener("click", () => {
            openRunPodEndpointSettingsDialog().catch((error) => {
                log(`RunPod endpoint settings error: ${describeError(error)}`);
                showPanelToast(describeError(error), "error");
            });
        });
    }
    if (deploymentComfySettingsBtn) {
        deploymentComfySettingsBtn.addEventListener("click", () => {
            openRunComfyDeploymentSettingsDialog().catch((error) => {
                log(`RunComfy deployment settings error: ${describeError(error)}`);
                showPanelToast(describeError(error), "error");
            });
        });
    }
}

// Normalizes an integer endpoint setting and keeps it within the documented RunPod API bounds.
function normalizeRunPodEndpointIntegerSetting(value, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
    const parsed = Number.parseInt(String(value ?? "").trim(), 10);
    const baseValue = Number.isFinite(parsed) ? parsed : Number.parseInt(String(fallback ?? "").trim(), 10);
    if (!Number.isFinite(baseValue)) return min;
    return Math.max(min, Math.min(max, baseValue));
}

// Normalizes a RunComfy deployment field and keeps it within the requested UI bounds.
function normalizeRunComfyDeploymentIntegerSetting(value, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
    const parsed = Number.parseInt(String(value ?? "").trim(), 10);
    const baseValue = Number.isFinite(parsed) ? parsed : Number.parseInt(String(fallback ?? "").trim(), 10);
    if (!Number.isFinite(baseValue)) return min;
    return Math.max(min, Math.min(max, baseValue));
}

// Copies the selected RunPod endpoint settings into the dialog inputs.
function syncRunPodEndpointSettingsDialogFields(endpoint) {
    if (runPodIdleTimeoutField) {
        runPodIdleTimeoutField.value = String(normalizeRunPodEndpointIntegerSetting(endpoint?.idleTimeout, 5, { min: 1, max: 3600 }));
    }
    if (runPodWorkersMaxField) {
        runPodWorkersMaxField.value = String(normalizeRunPodEndpointIntegerSetting(
            getRunPodEndpointNumericValue(endpoint, [["workersMax"], ["workers_max"], ["maxWorkers"], ["max_workers"]]),
            0,
            { min: 0 }
        ));
    }
}

// Closes the RunPod endpoint settings view and restores the main panel.
function closeRunPodEndpointSettingsDialog() {
    dismissFloatingBoxes();
    if (!runPodEndpointSettingsView) return;
    runPodEndpointSettingsView.style.display = "none";
    const mainWrapper = document.querySelector(".wrapper");
    if (mainWrapper) {
        mainWrapper.style.display = "";
        resetPanelScroll(mainWrapper);
    }
    hideServerRecentList();
    hidePortRecentList();
}

// Copies the selected RunComfy deployment settings into the dialog inputs.
function syncRunComfyDeploymentSettingsDialogFields(deployment) {
    if (runComfyMaxInstancesField) {
        runComfyMaxInstancesField.value = String(normalizeRunComfyDeploymentIntegerSetting(
            deployment?.max_instances,
            settingsState.runcomfyMaxInstances || 1,
            { min: 1, max: 20 }
        ));
    }
    if (runComfyQueueSizeField) {
        runComfyQueueSizeField.value = String(normalizeRunComfyDeploymentIntegerSetting(
            deployment?.queue_size,
            settingsState.runcomfyQueueSize || 0,
            { min: 0 }
        ));
    }
    if (runComfyKeepWarmField) {
        runComfyKeepWarmField.value = String(normalizeRunComfyDeploymentIntegerSetting(
            deployment?.keep_warm_duration_in_seconds,
            settingsState.runcomfyKeepWarmSec || 0,
            { min: 0 }
        ));
    }
}

// Closes the RunComfy deployment settings view and restores the main panel.
function closeRunComfyDeploymentSettingsDialog() {
    dismissFloatingBoxes();
    if (!runComfyDeploymentSettingsView) return;
    runComfyDeploymentSettingsView.style.display = "none";
    const mainWrapper = document.querySelector(".wrapper");
    if (mainWrapper) {
        mainWrapper.style.display = "";
        resetPanelScroll(mainWrapper);
    }
    hideServerRecentList();
    hidePortRecentList();
}

// Opens the RunPod endpoint settings view after fetching the latest endpoint configuration.
async function openRunPodEndpointSettingsDialog() {
    dismissFloatingBoxes();
    if (!runPodEndpointSettingsView || !isRunPodEnvironment()) return;
    const endpointId = String(getRunPodEndpointId() || "").trim();
    const token = getRunPodApiToken();
    // Token first: without one no endpoints can load, so "select an endpoint" would mislead.
    if (!token) throw new Error("Add a RunPod API token in Settings first.");
    if (!endpointId) throw new Error("Select a RunPod endpoint first.");

    if (deploymentEndpointSettingsBtn) deploymentEndpointSettingsBtn.disabled = true;
    try {
        const response = await fetch(
            runPodRestUrl(`/v1/endpoints/${encodeURIComponent(endpointId)}`),
            { headers: buildRunPodRequestHeaders() }
        );
        if (!response.ok) throw new Error(`RunPod endpoint settings failed (${response.status}).`);
        const endpoint = await response.json();
        runPodEndpointMetadataById.set(endpointId, endpoint);
        syncRunPodEndpointSettingsDialogFields(endpoint);
        if (runPodEndpointSettingsViewTitle) {
            const selectedOption = deploymentSelect?.options?.[deploymentSelect.selectedIndex];
            const endpointName = String(selectedOption?.textContent || endpoint?.name || "").trim();
            runPodEndpointSettingsViewTitle.textContent = endpointName ? `${endpointName} Settings` : "Endpoint Settings";
        }
        const mainWrapper = document.querySelector(".wrapper");
        if (mainWrapper) mainWrapper.style.display = "none";
        runPodEndpointSettingsView.style.display = "block";
        try {
            if (runPodIdleTimeoutField) runPodIdleTimeoutField.focus();
        } catch (_e) {}
    } finally {
        if (deploymentEndpointSettingsBtn) deploymentEndpointSettingsBtn.disabled = !isRunPodEnvironment();
    }
}

// Opens the RunComfy deployment settings view for the selected deployment.
async function openRunComfyDeploymentSettingsDialog() {
    dismissFloatingBoxes();
    if (!runComfyDeploymentSettingsView || !isRunComfyEnvironment()) return;
    const deploymentId = String(getRunComfyDeploymentId() || "").trim();
    const token = getRunComfyApiToken();
    // Token first: without one no deployments can load, so "select a deployment" would mislead.
    if (!token) throw new Error("Add a RunComfy API token in Settings first.");
    if (!deploymentId) throw new Error("Select a RunComfy deployment first.");

    if (deploymentComfySettingsBtn) deploymentComfySettingsBtn.disabled = true;
    try {
        const response = await fetch(
            runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}`),
            { headers: buildRunComfyRequestHeaders(), cache: "no-store" }
        );
        if (!response.ok) throw new Error(`RunComfy deployment settings failed (${response.status}).`);
        const deployment = await response.json();
        runComfyDeploymentSettingsSnapshot = deployment && typeof deployment === "object" ? deployment : null;
        syncRunComfyDeploymentSettingsDialogFields(deployment);
        if (runComfyDeploymentSettingsViewTitle) {
            const selectedOption = deploymentSelect?.options?.[deploymentSelect.selectedIndex];
            const deploymentName = String(selectedOption?.textContent || deployment?.name || "").trim();
            runComfyDeploymentSettingsViewTitle.textContent = deploymentName ? `${deploymentName} Settings` : "Deployment Settings";
        }
        const mainWrapper = document.querySelector(".wrapper");
        if (mainWrapper) mainWrapper.style.display = "none";
        runComfyDeploymentSettingsView.style.display = "block";
        try {
            if (runComfyMaxInstancesField) runComfyMaxInstancesField.focus();
        } catch (_e) {}
    } finally {
        if (deploymentComfySettingsBtn) deploymentComfySettingsBtn.disabled = !isRunComfyEnvironment();
    }
}

// Saves the selected RunPod endpoint settings through the management REST API and refreshes cached status.
async function saveRunPodEndpointSettingsFromDialog() {
    const endpointId = String(getRunPodEndpointId() || "").trim();
    if (!endpointId) throw new Error("Select a RunPod endpoint first.");
    const idleTimeout = normalizeRunPodEndpointIntegerSetting(runPodIdleTimeoutField?.value, 5, { min: 1, max: 3600 });
    const workersMax = normalizeRunPodEndpointIntegerSetting(runPodWorkersMaxField?.value, 0, { min: 0 });

    if (runPodIdleTimeoutField) runPodIdleTimeoutField.value = String(idleTimeout);
    if (runPodWorkersMaxField) runPodWorkersMaxField.value = String(workersMax);
    if (runPodEndpointSettingsSaveBtn) {
        runPodEndpointSettingsSaveBtn.disabled = true;
    }
    try {
        const response = await fetch(
            runPodRestUrl(`/v1/endpoints/${encodeURIComponent(endpointId)}`),
            {
                method: "PATCH",
                headers: buildRunPodRequestHeaders({ includeJsonContentType: true }),
                body: JSON.stringify({ idleTimeout, workersMax })
            }
        );
        if (!response.ok) {
            let detail = "";
            try { detail = await response.text(); } catch (_e) {}
            throw new Error(`RunPod endpoint update failed (${response.status})${detail ? `: ${detail}` : "."}`);
        }
        const endpoint = await response.json();
        runPodEndpointMetadataById.set(endpointId, endpoint);
        syncRunPodEndpointSettingsDialogFields(endpoint);
        log(`RunPod endpoint settings saved: idleTimeout=${idleTimeout}, workersMax=${workersMax}.`);
        await refreshRunComfyDeploymentStatus({ showChecking: false });
        closeRunPodEndpointSettingsDialog();
    } finally {
        if (runPodEndpointSettingsSaveBtn) {
            runPodEndpointSettingsSaveBtn.disabled = false;
        }
    }
}

// Saves the RunComfy deployment settings locally so the dialog restores the chosen values.
async function saveRunComfyDeploymentSettingsFromDialog() {
    const deploymentId = String(getRunComfyDeploymentId() || "").trim();
    if (!deploymentId) throw new Error("Select a RunComfy deployment first.");
    const maxInstances = normalizeRunComfyDeploymentIntegerSetting(runComfyMaxInstancesField?.value, 1, { min: 1, max: 20 });
    const queueSize = normalizeRunComfyDeploymentIntegerSetting(runComfyQueueSizeField?.value, 0, { min: 0 });
    const keepWarmSec = normalizeRunComfyDeploymentIntegerSetting(runComfyKeepWarmField?.value, 0, { min: 0 });
    const deploymentSnapshot = runComfyDeploymentSettingsSnapshot && typeof runComfyDeploymentSettingsSnapshot === "object"
        ? runComfyDeploymentSettingsSnapshot
        : {};
    const deploymentName = String(deploymentSnapshot.name || getRunComfyDeploymentLabel() || "").trim();
    const minInstances = normalizeRunComfyDeploymentIntegerSetting(deploymentSnapshot.min_instances, 0, { min: 0, max: 30 });

    if (runComfyMaxInstancesField) runComfyMaxInstancesField.value = String(maxInstances);
    if (runComfyQueueSizeField) runComfyQueueSizeField.value = String(queueSize);
    if (runComfyKeepWarmField) runComfyKeepWarmField.value = String(keepWarmSec);
    if (runComfyDeploymentSettingsSaveBtn) {
        runComfyDeploymentSettingsSaveBtn.disabled = true;
    }
    try {
        const response = await fetch(
            runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}`),
            {
                method: "PATCH",
                headers: buildRunComfyRequestHeaders({ includeJsonContentType: true }),
                cache: "no-store",
                body: JSON.stringify({
                    name: deploymentName,
                    min_instances: minInstances,
                    max_instances: maxInstances,
                    queue_size: queueSize,
                    keep_warm_duration_in_seconds: keepWarmSec
                })
            }
        );
        if (!response.ok) {
            let detail = "";
            try { detail = await response.text(); } catch (_e) {}
            throw new Error(`RunComfy deployment update failed (${response.status})${detail ? `: ${detail}` : "."}`);
        }
        const deployment = await response.json();
        settingsState.runcomfyMaxInstances = normalizeRunComfyDeploymentIntegerSetting(deployment?.max_instances, maxInstances, { min: 1, max: 20 });
        settingsState.runcomfyQueueSize = normalizeRunComfyDeploymentIntegerSetting(deployment?.queue_size, queueSize, { min: 0 });
        settingsState.runcomfyKeepWarmSec = normalizeRunComfyDeploymentIntegerSetting(
            deployment?.keep_warm_duration_in_seconds,
            keepWarmSec,
            { min: 0 }
        );
        let confirmation = deployment;
        try {
            const verifyResponse = await fetch(
                runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}`),
                { headers: buildRunComfyRequestHeaders(), cache: "no-store" }
            );
            if (verifyResponse.ok) {
                confirmation = await verifyResponse.json();
            }
        } catch (_e) {}
        runComfyDeploymentSettingsSnapshot = confirmation && typeof confirmation === "object" ? confirmation : null;
        syncRunComfyDeploymentSettingsDialogFields(confirmation);
        await persistSettings();
        log(
            `RunComfy deployment settings saved for ${deploymentId}: `
            + `requested maxInstances=${maxInstances}, queueSize=${queueSize}, keepWarmSec=${keepWarmSec}; `
            + `server maxInstances=${confirmation?.max_instances ?? "(missing)"}, `
            + `queueSize=${confirmation?.queue_size ?? "(missing)"}, `
            + `keepWarmSec=${confirmation?.keep_warm_duration_in_seconds ?? "(missing)"}`
        );
        await refreshRunComfyDeploymentList({ preserveSelection: true });
        await refreshRunComfyDeploymentStatus({ showChecking: false });
        closeRunComfyDeploymentSettingsDialog();
    } finally {
        runComfyDeploymentSettingsSnapshot = null;
        if (runComfyDeploymentSettingsSaveBtn) {
            runComfyDeploymentSettingsSaveBtn.disabled = false;
        }
    }
}

// Wires RunPod endpoint settings dialog events.
function wireRunPodEndpointSettingsDialogEvents() {
    if (runPodEndpointSettingsCancelBtn) {
        runPodEndpointSettingsCancelBtn.addEventListener("click", closeRunPodEndpointSettingsDialog);
    }
    if (runPodEndpointSettingsSaveBtn) {
        runPodEndpointSettingsSaveBtn.addEventListener("click", async () => {
            try {
                await saveRunPodEndpointSettingsFromDialog();
            } catch (error) {
                log(`RunPod endpoint settings save error: ${describeError(error)}`);
            }
        });
    }
}

// Wires RunComfy deployment settings dialog events.
function wireRunComfyDeploymentSettingsDialogEvents() {
    if (runComfyDeploymentSettingsCancelBtn) {
        runComfyDeploymentSettingsCancelBtn.addEventListener("click", closeRunComfyDeploymentSettingsDialog);
    }
    if (runComfyDeploymentSettingsSaveBtn) {
        runComfyDeploymentSettingsSaveBtn.addEventListener("click", async () => {
            try {
                await saveRunComfyDeploymentSettingsFromDialog();
            } catch (error) {
                log(`RunComfy deployment settings save error: ${describeError(error)}`);
            }
        });
    }
}

// Initializes plugin settings at startup and synchronizes connection fields/UI state.
async function initializePluginSettings() {
    try {
        const loaded = await readPersistedSettings();
        if (loaded) applySettingsPatch(loaded);
        const secureComfyApiKey = await readSecureComfyApiKey();
        if (secureComfyApiKey) {
            settingsState.comfyApiKey = secureComfyApiKey;
        } else if (settingsState.comfyApiKey) {
            // One-time migration path for previously plain-text settings JSON.
            await persistSecureComfyApiKey(settingsState.comfyApiKey);
            await persistSettings();
            log("Settings migrated: Comfy API key moved to secure storage.");
        }
        const secureRunComfyToken = await readSecureRunComfyToken();
        if (secureRunComfyToken) {
            settingsState.runcomfyToken = secureRunComfyToken;
        } else if (settingsState.runcomfyToken) {
            // One-time migration path for previously plain-text settings JSON.
            await persistSecureRunComfyToken(settingsState.runcomfyToken);
            await persistSettings();
            log("Settings migrated: RunComfy token moved to secure storage.");
        }
        const secureRunPodToken = await readSecureRunPodToken();
        if (secureRunPodToken) {
            settingsState.runpodToken = secureRunPodToken;
        } else if (settingsState.runpodToken) {
            await persistSecureRunPodToken(settingsState.runpodToken);
            await persistSettings();
            log("Settings migrated: RunPod token moved to secure storage.");
        }
    } catch (error) {
        log(`Settings load warning: ${describeError(error)}`);
    }
    rememberRecentServer(settingsState.server);
    rememberRecentPort(settingsState.port);
    syncConnectionFieldsFromState();
    syncSettingsDialogFieldsFromState();
    syncRunComfyDeploymentStatusPolling();
    syncLocalServerStatusPolling();
    syncCloudQueuePolling();
    if (normalizeEnvironmentMode(settingsState.environment) === "runcomfy"
        || normalizeEnvironmentMode(settingsState.environment) === "runpod") {
        try {
            await refreshRunComfyDeploymentList({ preserveSelection: true });
        } catch (error) {
            log(`${isRunPodEnvironment() ? "RunPod endpoints" : "RunComfy deployments"} refresh error: ${describeError(error)}`);
        }
    }
}

// Applies textfield styles.
function applyTextfieldStyles() {
    const fields = document.querySelectorAll("sp-textfield");
    fields.forEach((field) => {
        field.style.borderRadius = "8px";
        try {
            const input = field.shadowRoot && field.shadowRoot.querySelector("input");
            if (!input) return;
            input.style.borderRadius = "8px";
        } catch (_e) {}
    });
}

// Applies action button styles.
function applyActionButtonStyles() {
    const buttons = document.querySelectorAll("sp-action-button");
    buttons.forEach((btn) => {
        btn.style.borderRadius = "8px";
        btn.style.backgroundColor = "rgb(50, 50, 50)";
        btn.style.color = "rgb(255, 255, 255)";
        btn.style.boxShadow = "none";
        btn.style.outline = "none";
        btn.style.border = "0";

        try {
            const inner = btn.shadowRoot && btn.shadowRoot.querySelector("button");
            if (!inner) return;
            inner.style.borderRadius = "8px";
            inner.style.display = "flex";
            inner.style.alignItems = "center";
            inner.style.justifyContent = "center";
            inner.style.textAlign = "center";
            inner.style.paddingLeft = "0";
            inner.style.paddingRight = "0";
            inner.style.backgroundColor = "rgb(50, 50, 50)";
            inner.style.color = "rgb(255, 255, 255)";
            inner.style.boxShadow = "none";
            inner.style.outline = "none";
            inner.style.border = "0";

            const label = btn.shadowRoot.querySelector('[part="label"], .spectrum-Button-label');
            if (label) {
                label.style.width = "100%";
                label.style.marginLeft = "0";
                label.style.marginRight = "0";
                label.style.textAlign = "center";
                label.style.display = "block";
                label.style.justifySelf = "center";
            }

            const style = btn.shadowRoot.querySelector("style[data-quickai-center]");
            if (!style) {
                const forced = document.createElement("style");
                forced.setAttribute("data-quickai-center", "1");
                forced.textContent = `
                    button { justify-content: center !important; text-align: center !important; padding-left: 0 !important; padding-right: 0 !important; }
                    [part="label"], .spectrum-Button-label { width: 100% !important; text-align: center !important; margin-left: 0 !important; margin-right: 0 !important; }
                `;
                btn.shadowRoot.appendChild(forced);
            }
        } catch (_e) {}
    });
}

applyTextfieldStyles();
setTimeout(applyTextfieldStyles, 0);
applyActionButtonStyles();
setTimeout(applyActionButtonStyles, 0);

// Parses yaml scalar.
function parseYamlScalar(rawValue) {
    const trimmed = String(rawValue || "").trim();
    if (!trimmed) return "";
    if (
        (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        if (trimmed.startsWith("\"")) {
            try {
                return JSON.parse(trimmed);
            } catch (_e) {}
        }
        return trimmed.slice(1, -1);
    }
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
    if (trimmed.toLowerCase() === "true") return true;
    if (trimmed.toLowerCase() === "false") return false;
    return trimmed;
}

// Parses the "input:" token's tuple-list value into an ordered array of input slots.
// Syntax: input: ("nodeId"), ("nodeId", "Custom Label"), ("nodeId", "Custom Label", required)
// The bare (unquoted) "required" keyword marks a slot mandatory — Auto Run refuses to send the
// job if a required slot has no attached content (see validateAutoRunRequiredInputs). It can
// also appear with no label: ("nodeId", required).
// The upload-target field name (image/video/audio) is never stored in the YAML — it's
// resolved from the node's actual class_type in the workflow JSON at load time (see
// inferLoaderInputFieldName and its call site in loadSelectedWorkflowParameters), since
// it's fully derivable and doesn't need to be duplicated here.
function parseWorkflowInputTuplesToken(rawValue) {
    const text = String(rawValue || "");
    const tuples = [];
    const tupleRe = /\(\s*"([^"]*)"\s*(?:,\s*"([^"]*)"\s*)?(?:,\s*(required)\s*)?\)/gi;
    let match;
    while ((match = tupleRe.exec(text)) !== null) {
        const nodeId = normalizeWorkflowNodeId(match[1]);
        const label = String(match[2] || "").trim();
        const required = Boolean(match[3]);
        if (nodeId) tuples.push({ nodeId, label, required });
    }
    return tuples;
}

// Canonical upload-target field name per loader node class — used as the tuple's "inputName"
// when the Import Workflow UI writes out a selected loader node. LoadVideo/LoadAudio are
// declarable here but carry no upload plumbing in this Photoshop plugin (see
// hidden-from-Auto-Run handling elsewhere). LoadVideo's real API input key is
// "file", not "video" — confirmed against an actual exported LoadVideo node's inputs object
// (ComfyUI's built-in LoadVideo widget binds to "file"). Getting this wrong meant clearImageField
// below was blanking a key that didn't exist on the node, leaving the real stale filename intact.
function inferLoaderInputFieldName(classType) {
    const t = String(classType || "").trim().toLowerCase().replace(/\s+/g, "");
    if (t === "loadvideo") return "file";
    if (t === "loadaudio") return "audio";
    return "image";
}

// Extra read-only/derived fields some loader node classes carry alongside their real upload
// field — e.g. LoadVideo's "video-preview" and LoadAudio's "audioUI" (a URL that embeds the
// same filename via a query param). These aren't the field Auto Run writes an upload into, but
// they still leak the last-loaded filename into the saved template unless also blanked — see
// cleanWorkflowImportApiText.
function getWorkflowLoaderPreviewFieldNames(classType) {
    const t = String(classType || "").trim().toLowerCase().replace(/\s+/g, "");
    if (t === "loadvideo") return ["video-preview"];
    if (t === "loadaudio") return ["audioUI"];
    return [];
}

// Node classes recognized as valid Auto Run input loaders — matches the Import Workflow
// dialog's own node picker (see inputAllowedClassTypes there). Used to cross-check each
// declared "input:" tuple's node id against the workflow JSON at load time (see
// loadSelectedWorkflowParameters) so a stale/mistyped node id — one that no longer resolves to
// an actual loader node in the current workflow JSON — gets hidden from the Inputs box instead
// of rendering a slot that can never actually receive an upload.
function isInputLoaderClassType(classType) {
    const t = String(classType || "").trim().toLowerCase().replace(/\s+/g, "");
    return t === "loadimage" || t === "loadmask" || t === "loadvideo" || t === "loadaudio";
}

// Parses serialized reference list state into normalized layer reference objects.
// Normalizes one reference-list entry. An entry with no layerId is a valid "empty slot"
// placeholder (see the fixed-length slot model in syncReferenceListControlState) — it is
// NOT filtered out here, since doing so would collapse the array and desync slot positions
// from the declared input order.
function normalizeReferenceListItem(item) {
    return {
        docId: item && item.docId !== undefined && item.docId !== null ? String(item.docId) : "",
        layerId: item && item.layerId !== undefined && item.layerId !== null ? String(item.layerId) : "",
        name: String(item?.name || "").trim()
    };
}

function parseReferenceListValue(rawValue) {
    if (Array.isArray(rawValue)) {
        return rawValue.map(normalizeReferenceListItem);
    }

    const text = String(rawValue || "").trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(normalizeReferenceListItem);
    } catch (_e) {
        return [];
    }
}

// Normalizes visible reference label base by removing any prior "Image N:" prefix.
function normalizeReferenceBaseName(name) {
    const text = String(name || "").trim();
    const withoutPrefix = text.replace(/^Image\s+\d+\s*:\s*/i, "").trim() || text;
    // Raster reference layers are duplicated internally (then converted to a Smart Object and
    // deleted) to export their pixel content — see exportRasterLayerSnapshotToTempFolder.
    // Photoshop's default duplicate naming appends " copy" / " copy 2" etc.; that's an
    // implementation artifact and should never leak into the displayed reference name.
    return withoutPrefix.replace(/\s+copy(\s+\d+)?$/i, "").trim() || withoutPrefix;
}

// In-memory thumbnail cache for reference-list rows keyed by docId/layerId.
const referenceThumbnailDataUrlByKey = new Map();
let referenceThumbnailHeavyQueue = Promise.resolve();
const referenceThumbnailInflightByKey = new Map();
// Caches the exported snapshot FILE (not just the thumbnail preview) from the same
// heavy export, keyed identically, so a job send can reuse it instead of opening the
// Smart Object a second time for a reference that was already exported once when added.
const referenceSnapshotFileByKey = new Map();

// Serializes only expensive fallback thumbnail jobs that mutate document state.
function enqueueReferenceThumbnailHeavyJob(job) {
    const run = referenceThumbnailHeavyQueue.then(() => job(), () => job());
    referenceThumbnailHeavyQueue = run.catch(() => {});
    return run;
}

// Converts binary bytes to base64 text for data URL image previews.
function bytesToBase64(bytesLike) {
    if (!bytesLike) return "";
    let bytes = null;
    if (bytesLike instanceof Uint8Array) {
        bytes = bytesLike;
    } else if (bytesLike instanceof ArrayBuffer) {
        bytes = new Uint8Array(bytesLike);
    } else if (ArrayBuffer.isView(bytesLike)) {
        bytes = new Uint8Array(bytesLike.buffer, bytesLike.byteOffset, bytesLike.byteLength);
    } else {
        return "";
    }
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

// Returns a stable thumbnail cache key for one reference-list layer item.
function getReferenceThumbnailKey(item) {
    const docId = String(item?.docId || "").trim();
    const layerId = String(item?.layerId || "").trim();
    if (!layerId) return "";
    const boundsToken = String(item?.thumbBoundsToken || "").trim();
    return `${docId}::${layerId}::${boundsToken}`;
}

// Creates a compact bounds fingerprint used for thumbnail cache invalidation.
function buildBoundsToken(bounds) {
    if (!hasValidBounds(bounds)) return "";
    return [
        Math.round(bounds.left),
        Math.round(bounds.top),
        Math.round(bounds.right),
        Math.round(bounds.bottom)
    ].join(",");
}

// Encodes RGBA8 pixels as a PNG data URL using an offscreen canvas.
function rgbaToPngDataUrl(rgba, width, height) {
    const w = Math.max(1, Math.floor(Number(width) || 0));
    const h = Math.max(1, Math.floor(Number(height) || 0));
    if (!rgba || rgba.length < (w * h * 4)) return "";
    try {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return "";
        const imageData = ctx.createImageData(w, h);
        imageData.data.set(rgba);
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL("image/png");
    } catch (_e) {
        return "";
    }
}

// Downscales chunky RGBA pixels with nearest-neighbor sampling.
function downscaleRgbaNearest(src, srcWidth, srcHeight, dstWidth, dstHeight) {
    const sw = Math.max(1, Math.floor(Number(srcWidth) || 0));
    const sh = Math.max(1, Math.floor(Number(srcHeight) || 0));
    const dw = Math.max(1, Math.floor(Number(dstWidth) || 0));
    const dh = Math.max(1, Math.floor(Number(dstHeight) || 0));
    if (!src || src.length < (sw * sh * 4)) return null;
    if (sw === dw && sh === dh) return src;

    const out = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y += 1) {
        const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
        for (let x = 0; x < dw; x += 1) {
            const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
            const s = ((sy * sw) + sx) * 4;
            const d = ((y * dw) + x) * 4;
            out[d] = src[s];
            out[d + 1] = src[s + 1];
            out[d + 2] = src[s + 2];
            out[d + 3] = src[s + 3];
        }
    }
    return out;
}

// Builds a fast in-memory thumbnail for one layer using imaging.getPixels.
async function tryBuildReferenceThumbnailDataUrlWithImaging(item, bounds) {
    if (!imaging || typeof imaging.getPixels !== "function") return "";
    const docId = toActionTargetIdNumber(item?.docId, "reference docId");
    const layerId = toActionTargetIdNumber(item?.layerId, "reference layerId");
    const normalizedBounds = normalizeBoundsToIntegerRect(bounds);
    if (!normalizedBounds) return "";

    let rawPixels = null;
    let meta = null;
    const sourceW = Math.max(1, normalizedBounds.right - normalizedBounds.left);
    const sourceH = Math.max(1, normalizedBounds.bottom - normalizedBounds.top);
    const aspect = sourceW / Math.max(1, sourceH);
    const targetW = aspect >= 1 ? REFERENCE_THUMB_MAX_SIZE_PX : Math.max(1, Math.round(REFERENCE_THUMB_MAX_SIZE_PX * aspect));
    const targetH = aspect >= 1 ? Math.max(1, Math.round(REFERENCE_THUMB_MAX_SIZE_PX / Math.max(0.0001, aspect))) : REFERENCE_THUMB_MAX_SIZE_PX;
    const pixelsResult = await imaging.getPixels({
        documentID: docId,
        layerID: layerId,
        sourceBounds: normalizedBounds,
        targetSize: {
            width: targetW,
            height: targetH
        }
    });
    const imageData = pixelsResult && pixelsResult.imageData;
    if (!imageData || typeof imageData.getData !== "function") return "";
    rawPixels = await imageData.getData({ chunky: true });
    meta = {
        width: Number(imageData.width),
        height: Number(imageData.height),
        components: Number(imageData.components)
    };
    if (typeof imageData.dispose === "function") imageData.dispose();

    if (!rawPixels || !meta || meta.components < 3 || !(meta.width > 0) || !(meta.height > 0)) return "";
    const pixelCount = meta.width * meta.height;
    const rgba = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i += 1) {
        const si = i * meta.components;
        const di = i * 4;
        rgba[di] = rawPixels[si];
        rgba[di + 1] = rawPixels[si + 1];
        rgba[di + 2] = rawPixels[si + 2];
        rgba[di + 3] = meta.components >= 4 ? rawPixels[si + 3] : 255;
    }

    return rgbaToPngDataUrl(rgba, meta.width, meta.height);
}

// Resolves (or builds and caches) one reference thumbnail data URL from Smart Object layer contents.
async function getReferenceThumbnailDataUrl(item) {
    const key = getReferenceThumbnailKey(item);
    if (!key) return "";
    if (referenceThumbnailDataUrlByKey.has(key)) {
        return referenceThumbnailDataUrlByKey.get(key) || "";
    }
    const allowHeavyFallback = item?.allowHeavyThumbnailFallback === true;
    const inflightKey = `${key}::heavy:${allowHeavyFallback ? "1" : "0"}`;
    if (referenceThumbnailInflightByKey.has(inflightKey)) {
        return await referenceThumbnailInflightByKey.get(inflightKey);
    }
    const inflight = enqueueReferenceThumbnailHeavyJob(async () => {
        try {
            const file = await exportReferenceLayerSnapshotToTempFolder(item);
            // Cache the exported file itself (same key) so a later job send can reuse it
            // instead of opening the Smart Object again for a reference already exported
            // once here.
            referenceSnapshotFileByKey.set(key, file);
            const bytes = await file.read({ format: storage.formats.binary });
            const base64 = bytesToBase64(bytes);
            const dataUrl = base64 ? `data:image/png;base64,${base64}` : "";
            // Cache only resolved thumbnails (or terminal heavy-fallback misses). This allows
            // a fast-path miss to be retried later with heavy fallback for visible rows.
            referenceThumbnailDataUrlByKey.set(key, dataUrl);
            return dataUrl;
        } catch (_e) {
            referenceThumbnailDataUrlByKey.set(key, "");
            return "";
        } finally {
            referenceThumbnailInflightByKey.delete(inflightKey);
        }
    });
    referenceThumbnailInflightByKey.set(inflightKey, inflight);
    return await inflight;
}

// Asynchronously updates one rendered reference-list row with its thumbnail preview image.
async function hydrateReferenceThumbnailRow(row, item, options = {}) {
    if (!row || !item) return;
    const docIdText = String(item?.docId || "").trim();
    const layerIdText = String(item?.layerId || "").trim();
    const existingDoc = getOpenDocumentById(docIdText);
    const existingLayer = existingDoc ? getLayerById(existingDoc, layerIdText) : null;
    if (!existingDoc || !existingLayer) return;
    let liveBounds = item?.thumbBounds || null;
    let boundsToken = String(item?.thumbBoundsToken || "").trim();
    if (!boundsToken) {
        try {
            const itemDocId = toActionTargetIdNumber(item?.docId, "reference docId");
            const itemLayerId = toActionTargetIdNumber(item?.layerId, "reference layerId");
            liveBounds = await getLayerBoundsPixelsById(itemDocId, itemLayerId);
            boundsToken = buildBoundsToken(liveBounds);
        } catch (_e) {}
    }
    const key = getReferenceThumbnailKey({ ...item, thumbBoundsToken: boundsToken });
    if (!key) return;
    row.setAttribute("data-thumb-key", key);
    const keyedItem = {
        ...item,
        thumbBoundsToken: boundsToken,
        thumbBounds: liveBounds,
        allowHeavyThumbnailFallback: options.allowHeavyFallback === true
    };
    const imgEl = row.querySelector(".dynamicReferenceListThumb");
    const fallbackEl = row.querySelector(".dynamicReferenceListThumbPlaceholder");
    if (!imgEl || !fallbackEl) return;
    const dataUrl = await getReferenceThumbnailDataUrl(keyedItem);
    // If row was recycled by a re-render, skip stale async updates.
    if (String(row.getAttribute("data-thumb-key") || "") !== key) return;
    if (dataUrl) {
        imgEl.src = dataUrl;
        imgEl.classList.add("isReady");
        fallbackEl.classList.add("isHidden");
    } else {
        imgEl.removeAttribute("src");
        imgEl.classList.remove("isReady");
        fallbackEl.classList.remove("isHidden");
    }
}

// Hydrates rendered reference rows using one modal batched bounds read to reduce UI churn.
async function hydrateReferenceRowsWithBatchedBounds(listEl, items) {
    if (!listEl || !Array.isArray(items) || items.length === 0) return;
    const rowsByLayerId = new Map();
    const rows = Array.from(listEl.querySelectorAll(".dynamicReferenceListItem"));
    for (let i = 0; i < rows.length; i += 1) {
        const layerId = String(rows[i].getAttribute("data-layer-id") || "").trim();
        if (!layerId) continue;
        rowsByLayerId.set(layerId, rows[i]);
    }

    let boundsByLayerId = new Map();
    try {
        boundsByLayerId = await core.executeAsModal(async () => {
            const req = [];
            const order = [];
            for (let i = 0; i < items.length; i += 1) {
                const item = items[i];
                try {
                    const docId = toActionTargetIdNumber(item?.docId, "reference docId");
                    const layerId = toActionTargetIdNumber(item?.layerId, "reference layerId");
                    const existingDoc = getOpenDocumentById(docId);
                    const existingLayer = existingDoc ? getLayerById(existingDoc, layerId) : null;
                    if (!existingDoc || !existingLayer) continue;
                    req.push({
                        _obj: "get",
                        _target: [
                            { _property: "bounds" },
                            { _ref: "layer", _id: layerId },
                            { _ref: "document", _id: docId }
                        ],
                        _options: { dialogOptions: "dontDisplay" }
                    });
                    order.push(String(layerId));
                } catch (_e) {}
            }
            const out = new Map();
            if (req.length === 0) return out;
            const result = await action.batchPlay(req, {});
            for (let i = 0; i < order.length; i += 1) {
                const layerId = order[i];
                const bounds = result && result[i] ? result[i].bounds : null;
                if (!bounds) continue;
                const left = toPixels(bounds.left);
                const top = toPixels(bounds.top);
                const right = toPixels(bounds.right);
                const bottom = toPixels(bounds.bottom);
                if ([left, top, right, bottom].some((v) => typeof v !== "number")) continue;
                out.set(layerId, { left, top, right, bottom });
            }
            return out;
        }, { commandName: "QuickAI Read Reference Bounds" });
    } catch (_e) {}

    for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const layerId = String(item?.layerId || "").trim();
        if (!layerId) continue;
        const row = rowsByLayerId.get(layerId);
        if (!row) continue;
        const liveBounds = boundsByLayerId.get(layerId) || null;
        const boundsToken = buildBoundsToken(liveBounds);
        await hydrateReferenceThumbnailRow(
            row,
            {
                ...item,
                thumbBounds: liveBounds,
                thumbBoundsToken: boundsToken
            },
            { allowHeavyFallback: false }
        );
    }
}

// Runs expensive fallback thumbnail generation only for rows currently visible in list viewport.
async function hydrateVisibleReferenceRowsWithFallback(listEl) {
    if (!listEl) return;
    const rows = Array.from(listEl.querySelectorAll(".dynamicReferenceListItem"));
    const top = Number(listEl.scrollTop) || 0;
    const bottom = top + (Number(listEl.clientHeight) || 0);
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const rowTop = Number(row.offsetTop) || 0;
        const rowBottom = rowTop + (Number(row.offsetHeight) || 0);
        if (rowBottom < top || rowTop > bottom) continue;
        const imgEl = row.querySelector(".dynamicReferenceListThumb");
        if (imgEl && imgEl.classList.contains("isReady")) continue;
        const item = {
            docId: String(row.getAttribute("data-doc-id") || ""),
            layerId: String(row.getAttribute("data-layer-id") || ""),
            name: ""
        };
        await hydrateReferenceThumbnailRow(row, item, { allowHeavyFallback: true });
    }
}

// Hydrates all reference rows in background so off-screen entries eventually get full thumbnails too.
async function hydrateAllReferenceRowsWithFallback(listEl) {
    if (!listEl) return;
    const rows = Array.from(listEl.querySelectorAll(".dynamicReferenceListItem"));
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const imgEl = row.querySelector(".dynamicReferenceListThumb");
        if (imgEl && imgEl.classList.contains("isReady")) continue;
        const item = {
            docId: String(row.getAttribute("data-doc-id") || ""),
            layerId: String(row.getAttribute("data-layer-id") || ""),
            name: ""
        };
        try {
            await hydrateReferenceThumbnailRow(row, item, { allowHeavyFallback: true });
        } catch (_e) {}
    }
}


// Builds the small "send this input" checkbox shown next to the main input row, but only for
// Current Canvas / Selected Layer And Below modes (renderMainInputRow) — never for Set Manually,
// where the trailing slot's own attach/detach already controls whether anything gets sent — and
// only when the workflow's YAML doesn't mark the main input required. Checked (sending enabled)
// by default, matching prior behavior. State lives on the reference-list wrapper's
// "data-main-input-disabled" attribute so it survives the full re-render every sync (see
// syncReferenceListControlState) and is readable at send time by prepareAutoRunSelectedWorkflowJob.
// Click/mousedown are stopped from bubbling so toggling it doesn't also trigger the row's own
// selection handling.
function createMainInputSendCheckbox(wrapper) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "dynamicReferenceListDisableCheckbox";
    checkbox.title = "Send this input";
    checkbox.checked = wrapper.getAttribute("data-main-input-disabled") !== "true";
    checkbox.addEventListener("mousedown", (event) => event.stopPropagation());
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
        wrapper.setAttribute("data-main-input-disabled", checkbox.checked ? "false" : "true");
        wrapper.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return checkbox;
}

// Renders custom list rows and syncs serialized reference-list data on the control wrapper.
// Renders the additional-inputs list as one fixed row PER DECLARED SLOT (always referenceLimit
// rows, in the workflow's declared order), whether or not a layer is currently attached to it.
// This lets the user see every possible input up front and pick exactly which slot the currently
// selected Photoshop layer(s) should go into — instead of always filling slots front-to-back in
// attach order — so the user, not attach sequence, decides the order. Rows are identified by
// fixed slot index (not layerId, since multiple empty rows would otherwise collide on "").
function syncReferenceListControlState(wrapper, listEl, items) {
    const referenceLimit = Math.max(0, Number.parseInt(String(wrapper?.getAttribute("data-reference-limit") || "0"), 10) || 0);
    // MAIN_INPUT_MODE_MANUAL adds one extra trailing slot (index === referenceLimit) so the
    // main input can be attached here exactly like an additional input, instead of being
    // auto-captured from the canvas.
    const isManualMainSlotEnabled = String(wrapper?.getAttribute("data-main-input-mode") || "") === MAIN_INPUT_MODE_MANUAL;
    const effectiveSlotCount = referenceLimit + (isManualMainSlotEnabled ? 1 : 0);
    const rawItems = parseReferenceListValue(items);
    // Fixed-length, slot-index-aligned: pad with empty placeholders, truncate any excess.
    const normalizedItems = [];
    for (let i = 0; i < effectiveSlotCount; i += 1) {
        normalizedItems.push(normalizeReferenceListItem(rawItems[i]));
    }

    const configuredReferenceStart = Number.parseInt(String(wrapper?.getAttribute("data-reference-start") || "1"), 10);
    const referenceStart = configuredReferenceStart === 2 ? 2 : 1;
    let referenceTargetLabels = [];
    try {
        const parsedLabels = JSON.parse(wrapper?.getAttribute("data-reference-target-labels") || "[]");
        if (Array.isArray(parsedLabels)) referenceTargetLabels = parsedLabels;
    } catch (_e) {}
    let referenceTargetRequired = [];
    try {
        const parsedRequired = JSON.parse(wrapper?.getAttribute("data-reference-target-required") || "[]");
        if (Array.isArray(parsedRequired)) referenceTargetRequired = parsedRequired;
    } catch (_e) {}
    // Slots backed by a LoadVideo/LoadAudio node ("file"/"audio") have no Photoshop layer type
    // that can fill them, so their rows are hidden in the UI (see renderRowAt below) — the slot
    // itself still exists in nodeTargets.inputs/normalizedItems so send-time index alignment is
    // untouched, it's just never rendered or interactable.
    let referenceTargetInputNames = [];
    try {
        const parsedInputNames = JSON.parse(wrapper?.getAttribute("data-reference-target-input-names") || "[]");
        if (Array.isArray(parsedInputNames)) referenceTargetInputNames = parsedInputNames;
    } catch (_e) {}
    const mainInputLabel = String(wrapper?.getAttribute("data-main-input-label") || "").trim();
    const mainInputRequired = wrapper?.getAttribute("data-main-input-required") === "true";
    const priorSelectedSlotIndices = new Set(
        String(wrapper.getAttribute("data-reference-selected-slot-indices") || "")
            .split(",")
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((n) => Number.isFinite(n) && n >= 0)
    );
    const selectedSlotIndices = new Set();

    const getRows = () => Array.from(listEl.querySelectorAll(".dynamicReferenceListItem"));
    const setRowSelected = (row, selected) => {
        const next = Boolean(selected);
        const slotIndex = Number.parseInt(String(row.getAttribute("data-slot-index") || "-1"), 10);
        row.setAttribute("data-selected", next ? "true" : "false");
        row.classList.toggle("isSelected", next);
        if (next) selectedSlotIndices.add(slotIndex);
        else selectedSlotIndices.delete(slotIndex);
    };
    const renderSelectionSnapshot = () => {
        const indices = Array.from(selectedSlotIndices.values()).filter((n) => n >= 0);
        wrapper.setAttribute("data-reference-selected-slot-indices", indices.join(","));
    };
    const clearSelection = () => {
        const rows = getRows();
        for (let i = 0; i < rows.length; i += 1) setRowSelected(rows[i], false);
    };
    // The anchor and clicked row are identified by SLOT INDEX everywhere outside this range
    // walk (auto-select-next-empty, default selection, mode-switch selection all write slot
    // indices into data-reference-anchor-slot-index) — slot index is a slot's stable identity
    // across re-renders, unlike DOM position. But the actual range a shift-click should select
    // is a VISUAL one (what's contiguous on screen), and in MAIN_INPUT_MODE_MANUAL the main slot
    // renders first in the DOM even though its slot index is last (referenceLimit) — so slot
    // index and DOM position only coincide in non-manual modes. selectRange resolves each slot
    // index to its current DOM position, then walks the DOM range between them.
    const findDomPositionBySlotIndex = (slotIndex) => {
        const rows = getRows();
        for (let r = 0; r < rows.length; r += 1) {
            if (Number.parseInt(String(rows[r].getAttribute("data-slot-index") || "-1"), 10) === slotIndex) return r;
        }
        return -1;
    };
    const getFirstSelectedIndex = () => {
        const rows = getRows();
        for (let i = 0; i < rows.length; i += 1) {
            if (rows[i].getAttribute("data-selected") === "true") {
                return Number.parseInt(String(rows[i].getAttribute("data-slot-index") || "-1"), 10);
            }
        }
        return -1;
    };
    const selectRange = (startSlotIndex, endSlotIndex, append = false) => {
        const rows = getRows();
        if (!append) clearSelection();
        const startDom = findDomPositionBySlotIndex(startSlotIndex);
        const endDom = findDomPositionBySlotIndex(endSlotIndex);
        if (startDom < 0 || endDom < 0) return;
        const start = Math.min(startDom, endDom);
        const end = Math.max(startDom, endDom);
        for (let r = start; r <= end; r += 1) setRowSelected(rows[r], true);
    };

    // Non-interactive first row previewing the main Photoshop input for Current Canvas /
    // Selected Layer And Below modes (the active canvas or a layer-limited composite, not an
    // uploaded reference). It carries no layer id, isn't selectable/removable, doesn't count
    // against the reference limit, and is excluded from the serialized reference-list value
    // since it uses a distinct row class from ".dynamicReferenceListItem" (which all the
    // selection/serialization logic queries on). Skipped entirely in MAIN_INPUT_MODE_MANUAL —
    // the manual trailing slot (rendered by renderRowAt) takes its place instead.
    const renderMainInputRow = () => {
        const row = document.createElement("div");
        row.className = "dynamicReferenceListMainRow";

        // Left slot: the optional "send this input" checkbox occupies the same 28px footprint
        // the thumbnail takes on every other row, so the label that follows still lines up.
        // Only offered when the workflow's YAML doesn't mark the main input required — lets the
        // user skip capturing/sending the canvas for workflows where it's optional, without
        // touching the "input:" tuple itself. Never shown in Set Manually mode (this row isn't
        // rendered there at all — the trailing manual slot's attach/detach state already controls
        // whether anything gets sent). When required, an invisible spacer fills the slot instead
        // so the label still lines up with every other row's label.
        if (!mainInputRequired) {
            const checkboxWrap = document.createElement("div");
            checkboxWrap.className = "dynamicReferenceListThumbSpacer dynamicReferenceListMainCheckboxWrap";
            checkboxWrap.appendChild(createMainInputSendCheckbox(wrapper));
            row.appendChild(checkboxWrap);
        } else {
            const thumbSpacer = document.createElement("div");
            thumbSpacer.className = "dynamicReferenceListThumbSpacer";
            row.appendChild(thumbSpacer);
        }

        // No thumbnail — this row represents a live Photoshop composite, not an uploaded
        // reference image, so there's nothing to render a preview of. Label is just the
        // YAML-declared name for the main input (falls back to "Main Input") — the mode (Current
        // Canvas / Selected Layer And Below / Set Manually) already has its own dropdown directly
        // above this box, so repeating it here was redundant.
        const label = document.createElement("span");
        label.className = "dynamicReferenceListLabel";
        label.textContent = mainInputLabel || "Main Input";
        row.appendChild(label);

        listEl.appendChild(row);
    };

    const renderRowAt = (item, i) => {
        const isManualMainSlot = isManualMainSlotEnabled && i === referenceLimit;
        // Slots backed by a LoadVideo/LoadAudio node have no Photoshop layer type that could ever
        // fill them, so they're skipped entirely here (UI-only — the slot index itself is left
        // alone everywhere else, so send-time alignment against nodeTargets.inputs is untouched).
        if (!isManualMainSlot && String(referenceTargetInputNames[i] || "image") !== "image") return;
        const row = document.createElement("div");
        row.className = "dynamicReferenceListItem";
        const isEmpty = !item.layerId;
        const thumbWrap = document.createElement("div");
        thumbWrap.className = "dynamicReferenceListThumbWrap";
        const thumbImg = document.createElement("img");
        thumbImg.className = "dynamicReferenceListThumb";
        thumbImg.alt = "";
        const thumbPlaceholder = document.createElement("div");
        thumbPlaceholder.className = "dynamicReferenceListThumbPlaceholder";
        thumbPlaceholder.textContent = " ";
        thumbWrap.appendChild(thumbImg);
        thumbWrap.appendChild(thumbPlaceholder);

        const label = document.createElement("span");
        label.className = "dynamicReferenceListLabel";
        const isRequired = isManualMainSlot ? mainInputRequired : Boolean(referenceTargetRequired[i]);
        const customSlotLabel = String(referenceTargetLabels[i] || "").trim();
        const baseSlotLabel = isManualMainSlot ? (mainInputLabel || "Main Input") : (customSlotLabel || `Image ${referenceStart + i}`);
        const slotLabel = `${baseSlotLabel}${isRequired ? "*" : ""}`;
        label.textContent = isEmpty ? slotLabel : `${slotLabel}: ${normalizeReferenceBaseName(item.name)}`;
        if (isManualMainSlot) row.classList.add("isMainSlot");
        row.classList.toggle("isRequired", isRequired);

        row.appendChild(thumbWrap);
        row.appendChild(label);
        // No send/skip checkbox here — Set Manually already controls whether the main input gets
        // sent via this slot's own attach/detach state, so the extra toggle isn't offered.
        row.tabIndex = -1;
        row.setAttribute("data-slot-index", String(i));
        row.setAttribute("data-layer-id", item.layerId);
        row.setAttribute("data-doc-id", item.docId || "");
        row.setAttribute("data-selected", "false");
        row.classList.toggle("isEmpty", isEmpty);
        if (priorSelectedSlotIndices.has(i)) {
            setRowSelected(row, true);
        }

        const handleRowSelection = (event, modifiers = {}) => {
            const rowIndex = i;
            const hasCtrlToggle = Boolean(modifiers.ctrlKey || modifiers.metaKey || event.ctrlKey || event.metaKey);
            const hasShiftRange = Boolean(modifiers.shiftKey || event.shiftKey);
            const anchorIndex = Number.parseInt(String(wrapper.getAttribute("data-reference-anchor-slot-index") || "-1"), 10);
            const firstSelectedIndex = getFirstSelectedIndex();
            const resolvedAnchor = Number.isFinite(anchorIndex) && anchorIndex >= 0
                ? anchorIndex
                : (firstSelectedIndex >= 0 ? firstSelectedIndex : rowIndex);

            if (hasShiftRange) {
                // Anchor stays put on shift-click — it should only move on a plain or
                // ctrl-click, so repeated shift-clicks keep extending/shrinking the range from
                // the same original starting point instead of the last-clicked row.
                selectRange(resolvedAnchor, rowIndex, hasCtrlToggle);
            } else if (hasCtrlToggle) {
                const nextSelected = row.getAttribute("data-selected") !== "true";
                setRowSelected(row, nextSelected);
                wrapper.setAttribute("data-reference-anchor-slot-index", String(rowIndex));
            } else {
                clearSelection();
                setRowSelected(row, true);
                wrapper.setAttribute("data-reference-anchor-slot-index", String(rowIndex));
            }

            renderSelectionSnapshot();
            wrapper.dispatchEvent(new Event("change", { bubbles: true }));
            if (!isEmpty) hydrateReferenceThumbnailRow(row, item, { allowHeavyFallback: true }).catch((_e) => {});
        };
        row.addEventListener("mousedown", (event) => {
            event.preventDefault();
            const shiftDown = wrapper.getAttribute("data-reference-shift-down") === "true";
            const ctrlDown = wrapper.getAttribute("data-reference-ctrl-down") === "true";
            const metaDown = wrapper.getAttribute("data-reference-meta-down") === "true";
            handleRowSelection(event, {
                shiftKey: shiftDown,
                ctrlKey: ctrlDown,
                metaKey: metaDown
            });
        });
        row.addEventListener("click", (event) => {
            event.preventDefault();
        });
        if (!isEmpty) {
            row.addEventListener("mouseenter", () => {
                hydrateReferenceThumbnailRow(row, item, { allowHeavyFallback: true }).catch((_e) => {});
            });
        }
        listEl.appendChild(row);
    };

    // Row count is fixed per workflow (== effectiveSlotCount), so a full rebuild every sync is
    // cheap — thumbnails are cache-backed (referenceThumbnailDataUrlByKey), so redrawing is not
    // a re-fetch. The main input row always renders first regardless of mode — in manual mode
    // that's the trailing array slot (index === referenceLimit) drawn out of array order so it
    // still appears at the top of the list, matching where the main input preview row sits in
    // every other mode.
    listEl.textContent = "";
    if (isManualMainSlotEnabled) {
        renderRowAt(normalizedItems[referenceLimit], referenceLimit);
        for (let i = 0; i < referenceLimit; i += 1) {
            renderRowAt(normalizedItems[i], i);
        }
    } else {
        renderMainInputRow();
        for (let i = 0; i < normalizedItems.length; i += 1) {
            renderRowAt(normalizedItems[i], i);
        }
    }
    renderSelectionSnapshot();
    const serialized = JSON.stringify(normalizedItems);
    wrapper.setAttribute("data-reference-items", serialized);
    wrapper.value = serialized;
    (async () => {
        try {
            await hydrateReferenceRowsWithBatchedBounds(listEl, normalizedItems);
        } catch (_e) {}
        try {
            await hydrateAllReferenceRowsWithFallback(listEl);
        } catch (_e) {}
    })();
}

// Returns true when target layer is a Smart Object (embedded or linked).
async function isSmartObjectLayerById(docId, layerId) {
    if (docId === null || docId === undefined || layerId === null || layerId === undefined) return false;
    try {
        const result = await action.batchPlay([
            {
                _obj: "get",
                _target: [
                    { _property: "smartObject" },
                    { _ref: "layer", _id: Number(layerId) },
                    { _ref: "document", _id: Number(docId) }
                ],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        const info = result && result[0] && result[0].smartObject;
        return Boolean(info);
    } catch (_e) {
        return false;
    }
}

// Reads selected Smart Object / raster (pixel) layers for reference-list insertions in one
// modal operation. This minimizes UI churn by avoiding per-layer action calls outside a modal
// context. Adjustment, fill, text, and group layers are intentionally excluded — they have no
// directly exportable pixel content of their own (see exportReferenceLayerSnapshotToTempFolder).
async function getActivePhotoshopLayersForReferences() {
    return await core.executeAsModal(async () => {
        const doc = app.activeDocument;
        if (!doc) return [];
        const activeLayers = Array.isArray(doc.activeLayers) ? doc.activeLayers : [];
        if (activeLayers.length === 0) return [];
        const docId = toActionTargetIdNumber(doc.id, "reference docId");
        const layerOrderIndexById = getLayerPanelOrderIndexMap(doc);

        // Batch-get smartObject metadata for all currently selected layers in one call.
        // Plain raster layers are detected synchronously via layer.kind (no batchPlay needed).
        const layerChecks = [];
        const selectedLayerMeta = [];
        for (let i = 0; i < activeLayers.length; i += 1) {
            const layer = activeLayers[i];
            if (!layer || layer.id === undefined || layer.id === null) continue;
            const layerId = toActionTargetIdNumber(layer.id, "reference layerId");
            selectedLayerMeta.push({
                layerId: String(layerId),
                name: String(layer.name || `Layer ${layerId}`).trim(),
                isRaster: layer.kind === constants.LayerKind.NORMAL
            });
            layerChecks.push({
                _obj: "get",
                _target: [
                    { _property: "smartObject" },
                    { _ref: "layer", _id: layerId },
                    { _ref: "document", _id: docId }
                ],
                _options: { dialogOptions: "dontDisplay" }
            });
        }
        if (layerChecks.length === 0) return [];
        const results = await action.batchPlay(layerChecks, {});
        const out = [];
        for (let i = 0; i < selectedLayerMeta.length; i += 1) {
            const result = results && results[i] ? results[i] : null;
            const meta = selectedLayerMeta[i];
            const isSmartObject = Boolean(result && result.smartObject);
            if (!isSmartObject && !meta.isRaster) continue;
            out.push({
                docId: String(docId),
                layerId: meta.layerId,
                name: meta.name
            });
        }

        // Keep inserted references in Photoshop Layers panel visual order (top-to-bottom).
        out.sort((a, b) => {
            const ai = layerOrderIndexById.get(String(a.layerId));
            const bi = layerOrderIndexById.get(String(b.layerId));
            const aIndex = Number.isFinite(ai) ? ai : Number.MAX_SAFE_INTEGER;
            const bIndex = Number.isFinite(bi) ? bi : Number.MAX_SAFE_INTEGER;
            if (aIndex !== bIndex) return aIndex - bIndex;
            return String(a.name || "").localeCompare(String(b.name || ""));
        });
        return out;
    }, { commandName: "QuickAI Read Reference Layers" });
}

// Builds a stable storage key so duplicate param names can coexist across node-id/class blocks.
function buildWorkflowParamKey(scopeKey, paramName) {
    const namePart = String(paramName || "").trim();
    const scopePart = String(scopeKey || "").trim();
    return scopePart ? `${scopePart}::${namePart}` : namePart;
}

// Normalizes workflow node id token values from YAML into a trimmed string.
function normalizeWorkflowNodeId(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

// Parses one "nodeId.inputName" token used by image_add reference targets.
function parseReferenceTargetToken(value) {
    const raw = normalizeWorkflowNodeId(value);
    if (!raw) return null;
    // Split on the first dot so input names can safely contain nested dots
    // (e.g. "2.model.images.image_2" -> nodeId "2", inputName "model.images.image_2").
    const dotIndex = raw.indexOf(".");
    if (dotIndex <= 0 || dotIndex >= raw.length - 1) return null;
    const nodeId = raw.slice(0, dotIndex).trim();
    const inputName = raw.slice(dotIndex + 1).trim();
    if (!nodeId || !inputName) return null;
    return { nodeId, inputName };
}

// Parses one or more workflow node ids from a YAML scalar/list token.
function parseWorkflowNodeIdListToken(rawValue) {
    const text = String(rawValue || "").trim();
    if (!text) return [];
    const fromArrayLiteral = text.match(/^\[(.*)\]$/);
    const payload = fromArrayLiteral ? fromArrayLiteral[1] : text;
    const parts = payload.split(",");
    const out = [];
    for (let i = 0; i < parts.length; i += 1) {
        const parsed = normalizeWorkflowNodeId(parseYamlScalar(parts[i]));
        if (parsed) out.push(parsed);
    }
    return Array.from(new Set(out));
}

// Coerces Photoshop action-target ids to numbers and validates them.
function toActionTargetIdNumber(value, label = "id") {
    const parsed = Number.parseInt(String(value ?? "").trim(), 10);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid ${label}: expected numeric id, got "${value}".`);
    }
    return parsed;
}

// Parses a top-level YAML boolean token.
function parseYamlBooleanToken(rawValue, fallback = false) {
    const text = rawValue === null || rawValue === undefined
        ? ""
        : String(rawValue).trim().toLowerCase();
    if (!text) return Boolean(fallback);
    if (text === "true" || text === "yes" || text === "on" || text === "1") return true;
    if (text === "false" || text === "no" || text === "off" || text === "0") return false;
    return Boolean(fallback);
}

// Reads top-level environment token from workflow YAML.
// Supported:
// environment: #cloud
// environment: #local
// environment: #runcomfy
// environment: #runpod
// environment: #cloud, #local
// environment: #runcomfy, #local
// environment: #runpod, #local
function parseEnvironmentFromYamlText(yamlText) {
    const out = { supportsLocal: true, supportsCloud: false, supportsRunComfy: false, supportsRunPod: false };
    const lines = String(yamlText || "").replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].replace(/\t/g, "  ");
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const lineIndent = (line.match(/^ */) || [""])[0].length;
        if (lineIndent !== 0) continue;
        const tokenMatch = line.match(/^environment:\s*(.+)\s*$/i);
        if (!tokenMatch) continue;
        // Split by comma, strip quotes and legacy '#' prefix from each token.
        const tokens = tokenMatch[1].split(",").map((t) =>
            t.trim().replace(/^["']+|["']+$/g, "").replace(/^#/, "").trim().toLowerCase()
        );
        const hasCloud = tokens.includes("cloud");
        const hasLocal = tokens.includes("local");
        const hasRunComfy = tokens.includes("runcomfy");
        const hasRunPod = tokens.includes("runpod");
        if (hasCloud || hasLocal || hasRunComfy || hasRunPod) {
            out.supportsCloud = hasCloud;
            out.supportsLocal = hasLocal;
            out.supportsRunComfy = hasRunComfy;
            // RunPod only includes workflows that explicitly opt in with #runpod.
            out.supportsRunPod = hasRunPod;
        }
        return out;
    }
    return out;
}

// Reads a top-level YAML scalar token by key name.
function parseTopLevelYamlScalarToken(yamlText, keyName) {
    const lines = String(yamlText || "").replace(/\r\n?/g, "\n").split("\n");
    const keyPattern = new RegExp(`^${String(keyName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(.+)\\s*$`, "i");
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].replace(/\t/g, "  ");
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const lineIndent = (line.match(/^ */) || [""])[0].length;
        if (lineIndent !== 0) continue;
        const tokenMatch = line.match(keyPattern);
        if (!tokenMatch) continue;
        // parseYamlScalar can legitimately return boolean false or number 0 for tokens like
        // "scaled_down_additional_inputs_default: false" — using `|| ""` here would silently
        // clobber those falsy-but-valid values back to an empty string, making callers fall
        // back to their default instead of honoring the real "false" in the YAML.
        const parsedValue = parseYamlScalar(tokenMatch[1]);
        return parsedValue === null || parsedValue === undefined ? "" : String(parsedValue).trim();
    }
    return "";
}

// Parses one comma-delimited top-level YAML token into a normalized string list.
function parseTopLevelYamlListToken(yamlText, tokenName) {
    const raw = parseTopLevelYamlScalarToken(yamlText, tokenName);
    if (!raw) return [];
    return raw
        .split(",")
        .map((part) => String(part || "").trim())
        .filter(Boolean);
}

// Parses deployment token list from top-level YAML "deployment:".
function parseDeploymentTokenListFromYamlText(yamlText) {
    return parseTopLevelYamlListToken(yamlText, "deployment");
}

// Parses endpoint token list from top-level YAML "endpoint:".
function parseEndpointTokenListFromYamlText(yamlText) {
    return parseTopLevelYamlListToken(yamlText, "endpoint");
}

// Parses local_machine token list from top-level YAML "local_machine:".
function parseLocalMachineTokenListFromYamlText(yamlText) {
    return parseTopLevelYamlListToken(yamlText, "local_machine");
}

// Builds workflow selector option label with stable marker order.
function buildWorkflowOptionLabel(config) {
    return String(config?.displayName || config?.folderName || "").trim();
}

// Removes numeric ordering prefixes from one folder segment (e.g., "1_Foo" -> "Foo").
function stripWorkflowFolderOrderPrefix(segment) {
    const raw = String(segment || "").trim();
    const stripped = raw.replace(/^(?:\d+|N)_+/i, "").trim();
    return stripped || raw;
}

// Returns display/sort path with numeric folder prefixes removed segment-by-segment.
function getWorkflowGroupDisplayPath(groupPath) {
    return String(groupPath || "")
        .split("/")
        .map((segment) => stripWorkflowFolderOrderPrefix(segment))
        .join("/")
        .trim();
}

// Parses explicit folder order token from one segment prefix (e.g., "2_Foo" -> 2, "N_Foo" -> Infinity).
function getWorkflowFolderOrderToken(segment) {
    const raw = String(segment || "").trim();
    const match = raw.match(/^(\d+|N)_+/i);
    if (!match) return Number.POSITIVE_INFINITY;
    const token = String(match[1] || "").trim();
    if (/^N$/i.test(token)) return Number.POSITIVE_INFINITY;
    const parsed = Number.parseInt(token, 10);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

// Compares group paths by explicit prefix order first, then by cleaned display path.
function compareWorkflowGroupPaths(aPath, bPath) {
    const aSegments = String(aPath || "").split("/").map((s) => String(s || "").trim()).filter(Boolean);
    const bSegments = String(bPath || "").split("/").map((s) => String(s || "").trim()).filter(Boolean);
    const max = Math.max(aSegments.length, bSegments.length);
    for (let i = 0; i < max; i += 1) {
        const aSeg = aSegments[i] || "";
        const bSeg = bSegments[i] || "";
        if (!aSeg && bSeg) return -1;
        if (aSeg && !bSeg) return 1;
        const byOrder = getWorkflowFolderOrderToken(aSeg) - getWorkflowFolderOrderToken(bSeg);
        if (byOrder !== 0) return byOrder;
        const byName = stripWorkflowFolderOrderPrefix(aSeg).localeCompare(stripWorkflowFolderOrderPrefix(bSeg));
        if (byName !== 0) return byName;
    }
    return getWorkflowGroupDisplayPath(aPath).localeCompare(getWorkflowGroupDisplayPath(bPath));
}

// Parses workflow YAML node/class blocks and their indented parameters into UI field descriptors.
function parseNanoBananaYaml(yamlText) {
    const lines = String(yamlText || "").replace(/\r\n?/g, "\n").split("\n");
    const parameters = [];
    const classTypes = [];
    const nodeIds = [];
    const nodeTargets = createDefaultWorkflowNodeTargets();
    let currentClassType = "";
    let currentNodeId = "";
    let currentClassIndent = null;
    let inParametersSection = false;
    let parametersIndent = null;
    let currentParam = null;
    let parameterIndent = null;
    let optionsIndent = null;
    let activeTopLevelList = null;
    let activeTopLevelListIndent = null;
    let activeTopLevelGroup = null;
    let activeTopLevelGroupIndent = null;
    let activeNestedList = null;
    let activeNestedListIndent = null;
    let bypassParamInsertIndex = null;

    const bypassGroups = [];

    const createBypassGroup = () => ({
        name: "",
        default: false,
        trueMeansBypass: true,
        nodes: []
    });
    const toNodeIdList = (value) => {
        if (Array.isArray(value)) {
            return value.map((item) => normalizeWorkflowNodeId(item)).filter(Boolean);
        }
        const raw = normalizeWorkflowNodeId(value);
        return raw ? [raw] : [];
    };
    const finalizeBypassGroups = () => {
        const bypassParams = [];
        nodeTargets.bypassGroups = bypassGroups.map((group, index) => {
            const uniqueNodes = Array.from(new Set(toNodeIdList(group.nodes)));
            const parsedGroup = {
                key: `bypass_group_${index + 1}`,
                name: String(group.name || "").trim(),
                default: parseYamlBooleanToken(String(group.default), false),
                trueMeansBypass: parseYamlBooleanToken(String(group.trueMeansBypass), true),
                nodes: uniqueNodes
            };
            parsedGroup.label = parsedGroup.name || `Bypass Group ${index + 1}`;
            const scopeKey = `bypass:${parsedGroup.key}`;
            bypassParams.push({
                name: parsedGroup.key,
                key: buildWorkflowParamKey(scopeKey, "enabled"),
                class_type: "",
                node_id: "",
                type: "checkbox",
                data_type: "boolean",
                checkbox_label: parsedGroup.label,
                label: parsedGroup.label,
                default: parsedGroup.default
            });
            return parsedGroup;
        });
        if (bypassParams.length < 1) return;
        const insertAt = Number.isFinite(Number(bypassParamInsertIndex))
            ? Math.max(0, Math.min(parameters.length, Number(bypassParamInsertIndex)))
            : parameters.length;
        parameters.splice(insertAt, 0, ...bypassParams);
    };
    const leadingSpaces = (line) => {
        const match = String(line || "").match(/^ */);
        return match ? match[0].length : 0;
    };

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].replace(/\t/g, "  ");
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const lineIndent = leadingSpaces(line);
        if (activeTopLevelList && lineIndent <= Number(activeTopLevelListIndent ?? 0)) {
            activeTopLevelList = null;
            activeTopLevelListIndent = null;
            activeTopLevelGroup = null;
            activeTopLevelGroupIndent = null;
            activeNestedList = null;
            activeNestedListIndent = null;
        }
        if (activeTopLevelGroup && lineIndent <= Number(activeTopLevelGroupIndent ?? 0)) {
            activeTopLevelGroup = null;
            activeTopLevelGroupIndent = null;
            activeNestedList = null;
            activeNestedListIndent = null;
        }
        if (activeNestedList && lineIndent <= Number(activeNestedListIndent ?? 0)) {
            activeNestedList = null;
            activeNestedListIndent = null;
        }

        if (activeTopLevelList === "bypass") {
            const groupStart = line.match(/^(\s*)-\s*$/);
            const inlineGroupStart = line.match(/^(\s*)-\s*([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)\s*$/);
            if (groupStart && lineIndent > Number(activeTopLevelListIndent ?? -1)) {
                activeTopLevelGroup = createBypassGroup();
                bypassGroups.push(activeTopLevelGroup);
                activeTopLevelGroupIndent = lineIndent;
                activeNestedList = null;
                activeNestedListIndent = null;
                continue;
            }
            if (inlineGroupStart && lineIndent > Number(activeTopLevelListIndent ?? -1)) {
                activeTopLevelGroup = createBypassGroup();
                bypassGroups.push(activeTopLevelGroup);
                activeTopLevelGroupIndent = lineIndent;
                activeNestedList = null;
                activeNestedListIndent = null;
                const inlineKey = String(inlineGroupStart[2] || "").trim();
                const inlineValue = parseYamlScalar(inlineGroupStart[3]);
                if (inlineKey === "name") activeTopLevelGroup.name = String(inlineValue || "").trim();
                if (inlineKey === "default") activeTopLevelGroup.default = parseYamlBooleanToken(inlineValue, false);
                if (inlineKey === "true_means_bypass") activeTopLevelGroup.trueMeansBypass = parseYamlBooleanToken(inlineValue, true);
                continue;
            }

            if (activeTopLevelGroup) {
                const nestedListStart = line.match(/^(\s*)(nodes):\s*$/);
                if (nestedListStart && lineIndent > Number(activeTopLevelGroupIndent ?? -1)) {
                    activeNestedList = String(nestedListStart[2] || "").trim();
                    activeNestedListIndent = lineIndent;
                    continue;
                }
                const nestedListValue = line.match(/^(\s*)-\s*(.+)\s*$/);
                if (nestedListValue && activeNestedList && lineIndent > Number(activeNestedListIndent ?? -1)) {
                    if (activeNestedList === "nodes") {
                        const nodeId = normalizeWorkflowNodeId(parseYamlScalar(nestedListValue[2]));
                        if (nodeId) activeTopLevelGroup.nodes.push(nodeId);
                    }
                    continue;
                }
                const fieldLine = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)\s*$/);
                if (fieldLine && lineIndent > Number(activeTopLevelGroupIndent ?? -1)) {
                    const fieldName = String(fieldLine[2] || "").trim();
                    const fieldValue = parseYamlScalar(fieldLine[3]);
                    if (fieldName === "name") activeTopLevelGroup.name = String(fieldValue || "").trim();
                    if (fieldName === "default") activeTopLevelGroup.default = parseYamlBooleanToken(fieldValue, false);
                    if (fieldName === "true_means_bypass") activeTopLevelGroup.trueMeansBypass = parseYamlBooleanToken(fieldValue, true);
                    continue;
                }
            }
        }

        // Only parse top-level routing/reference tokens when we are not inside a parameter block.
        // This preserves YAML field order because dedent handling can flush the active parameter first.
        if (lineIndent === 0 && !inParametersSection) {
            const inputMatch = line.match(/^input:\s*(.+)\s*$/);
            if (inputMatch) {
                nodeTargets.inputs = parseWorkflowInputTuplesToken(inputMatch[1]);
                continue;
            }
            const outputMatch = line.match(/^output:\s*(.+)\s*$/);
            if (outputMatch) {
                const outputIds = parseWorkflowNodeIdListToken(outputMatch[1]);
                nodeTargets.exportNodeId = outputIds[0] || "";
                nodeTargets.exportNodeIds = outputIds;
                continue;
            }
            const outputMaskMatch = line.match(/^output_mask:\s*(.+)\s*$/);
            if (outputMaskMatch) {
                const outputMaskIds = parseWorkflowNodeIdListToken(outputMaskMatch[1]);
                nodeTargets.exportMaskNodeId = outputMaskIds[0] || "";
                nodeTargets.exportMaskNodeIds = outputMaskIds;
                continue;
            }
            const legacyBypassDefaultMatch = line.match(/^bypass_default:\s*(.+)\s*$/i);
            if (legacyBypassDefaultMatch) {
                if (!bypassGroups[0]) bypassGroups.push(createBypassGroup());
                bypassGroups[0].default = parseYamlBooleanToken(parseYamlScalar(legacyBypassDefaultMatch[1]), false);
                continue;
            }
            if (/^bypass_list:\s*$/.test(trimmed) || /^bypass:\s*$/.test(trimmed)) {
                if (bypassParamInsertIndex === null) bypassParamInsertIndex = parameters.length;
                activeTopLevelList = "bypass";
                activeTopLevelListIndent = lineIndent;
                activeTopLevelGroup = null;
                activeTopLevelGroupIndent = null;
                activeNestedList = null;
                activeNestedListIndent = null;
                continue;
            }
        }

        const classMatch = line.match(/^(\s*)class_type:\s*(.+)\s*$/);
        if (classMatch) {
            if (currentParam) {
                parameters.push(currentParam);
                currentParam = null;
            }
            currentClassType = String(parseYamlScalar(classMatch[2]) || "").trim();
            currentClassIndent = leadingSpaces(classMatch[1]);
            inParametersSection = false;
            parametersIndent = null;
            parameterIndent = null;
            optionsIndent = null;
            if (currentClassType && !classTypes.includes(currentClassType)) classTypes.push(currentClassType);
            continue;
        }
        const nodeIdMatch = line.match(/^(\s*)node_id:\s*(.+)\s*$/);
        const listNodeIdMatch = line.match(/^(\s*)-\s*node_id:\s*(.+)\s*$/);
        const matchedNodeId = nodeIdMatch || listNodeIdMatch;
        if (matchedNodeId) {
            if (currentParam) {
                parameters.push(currentParam);
                currentParam = null;
            }
            currentNodeId = String(parseYamlScalar(matchedNodeId[2]) || "").trim();
            currentClassIndent = leadingSpaces(matchedNodeId[1]);
            inParametersSection = false;
            parametersIndent = null;
            parameterIndent = null;
            optionsIndent = null;
            if (currentNodeId && !nodeIds.includes(currentNodeId)) nodeIds.push(currentNodeId);
            continue;
        }

        if (!inParametersSection) {
            const topLevelTitleLine = line.match(/^(\s*)@title:\s*(.+)\s*$/);
            if (topLevelTitleLine) {
                if (currentParam) {
                    parameters.push(currentParam);
                    currentParam = null;
                }
                const titleText = String(parseYamlScalar(topLevelTitleLine[2]) || "").trim();
                if (titleText) {
                    parameters.push({
                        type: "section_title",
                        title: titleText
                    });
                }
                continue;
            }
            const topLevelDividerLine = line.match(/^(\s*)@divider(?:\s*:\s*(?:.*)?)?\s*$/);
            if (topLevelDividerLine) {
                if (currentParam) {
                    parameters.push(currentParam);
                    currentParam = null;
                }
                parameters.push({
                    type: "section_divider"
                });
                continue;
            }
            if (/^parameters:\s*$/.test(trimmed)) {
                // Support both new syntax (parameters nested under class_type) and legacy top-level parameters.
                inParametersSection = true;
                parametersIndent = lineIndent;
                parameterIndent = null;
                optionsIndent = null;
                continue;
            }
            // Also support implicit syntax where parameter blocks are directly nested under class_type:
            // class_type: "SomeNode"
            //   prompt:
            //     type: bigtextbox
            // This keeps backward compatibility with existing YAML while accepting the simplified format.
            const implicitParamStart = line.match(/^(\s+)(?:@title(?:\s*:.*)?|@divider(?:\s*:.*)?|[a-zA-Z0-9_.-]+:\s*(?:.*)?)$/);
            if (
                implicitParamStart
                && currentClassIndent !== null
                && lineIndent > Number(currentClassIndent)
            ) {
                inParametersSection = true;
                parametersIndent = Number(currentClassIndent);
                parameterIndent = null;
                optionsIndent = null;
                i -= 1;
            }
            continue;
        }

        if (lineIndent <= Number(parametersIndent ?? 0)) {
            if (currentParam) {
                parameters.push(currentParam);
                currentParam = null;
            }
            inParametersSection = false;
            parametersIndent = null;
            parameterIndent = null;
            optionsIndent = null;
            if (lineIndent <= Number(currentClassIndent ?? -1)) {
                currentClassType = "";
                currentNodeId = "";
                currentClassIndent = null;
            }
            i -= 1;
            continue;
        }

        const paramStart = line.match(/^(\s+)([a-zA-Z0-9_.-]+):\s*$/);
        if (paramStart) {
            const indent = leadingSpaces(paramStart[1]);
            if (parameterIndent === null) parameterIndent = indent;
            if (indent === parameterIndent) {
                if (currentParam) parameters.push(currentParam);
                const scopeKey = currentNodeId ? `id:${currentNodeId}` : (currentClassType ? `class:${currentClassType}` : "");
                currentParam = {
                    name: paramStart[2],
                    key: buildWorkflowParamKey(scopeKey, paramStart[2]),
                    class_type: currentClassType || "",
                    node_id: currentNodeId || "",
                    type: "textbox",
                    data_type: "string",
                    label: paramStart[2],
                    default: "",
                    options: [],
                    // Numeric range — populated by the generic field-line catch-all below when
                    // the YAML has min:/max: lines under this parameter (see
                    // buildWorkflowImportYaml's appendFieldBlock for the writer side).
                    min: "",
                    max: ""
                };
                optionsIndent = null;
                continue;
            }
        }

        const titleLine = line.match(/^(\s+)@title:\s*(.+)\s*$/);
        if (titleLine) {
            const indent = leadingSpaces(titleLine[1]);
            if (parameterIndent === null) parameterIndent = indent;
            if (indent === parameterIndent) {
                if (currentParam) {
                    parameters.push(currentParam);
                    currentParam = null;
                }
                const titleText = String(parseYamlScalar(titleLine[2]) || "").trim();
                if (titleText) {
                    parameters.push({
                        type: "section_title",
                        title: titleText
                    });
                }
                optionsIndent = null;
                continue;
            }
        }

        const dividerLine = line.match(/^(\s+)@divider(?:\s*:\s*(?:.*)?)?\s*$/);
        if (dividerLine) {
            const indent = leadingSpaces(dividerLine[1]);
            if (parameterIndent === null) parameterIndent = indent;
            if (indent === parameterIndent) {
                if (currentParam) {
                    parameters.push(currentParam);
                    currentParam = null;
                }
                parameters.push({
                    type: "section_divider"
                });
                optionsIndent = null;
                continue;
            }
        }

        if (!currentParam || parameterIndent === null) continue;

        const optionsStart = line.match(/^(\s+)options:\s*$/);
        if (optionsStart) {
            const indent = leadingSpaces(optionsStart[1]);
            if (indent > parameterIndent) {
                optionsIndent = indent;
                currentParam.options = [];
            }
            continue;
        }

        const optionLine = line.match(/^(\s+)-\s*(.+)\s*$/);
        if (optionLine && optionsIndent !== null) {
            const indent = leadingSpaces(optionLine[1]);
            if (indent > optionsIndent) {
                currentParam.options.push(parseYamlScalar(optionLine[2]));
                continue;
            }
        }

        const fieldLine = line.match(/^(\s+)([a-zA-Z0-9_.-]+):\s*(.+)\s*$/);
        if (fieldLine) {
            const indent = leadingSpaces(fieldLine[1]);
            if (indent > parameterIndent) {
                optionsIndent = null;
                currentParam[fieldLine[2]] = parseYamlScalar(fieldLine[3]);
            }
        }
    }

    if (currentParam) parameters.push(currentParam);
    finalizeBypassGroups();

    // Every workflow gets an "Inputs" reference-list control in the Auto Run form — slot 0
    // stays the automatic main Photoshop snapshot; slots 1+ are attached here as extra
    // Photoshop layers, in order, up to the declared count (0 for workflows that only
    // declare a main input or no input at all, which disables adding — see the reference_list
    // widget's add-button handler).
    const declaredInputs = Array.isArray(nodeTargets.inputs) ? nodeTargets.inputs : [];
    const additionalSlots = declaredInputs.slice(1);

    // "Main Input" mode dropdown, shown directly above the Inputs box — governs how slot 0
    // gets its content: the live canvas, the canvas limited to the selected layer and
    // everything below it, or a manually-attached layer picked in the Inputs box itself (see
    // MAIN_INPUT_MODE_PARAM_NAME and its consumers in the reference-list control and
    // prepareAutoRunSelectedWorkflowJob/executePreparedAutoRunJob). Only meaningful when the
    // workflow actually declares a main input.
    if (declaredInputs.length > 0) {
        parameters.push({
            name: MAIN_INPUT_MODE_PARAM_NAME,
            key: buildWorkflowParamKey("ref:main_input_mode", "value"),
            class_type: "",
            node_id: "",
            type: "dropdown",
            data_type: "string",
            // Falls back to "Main Input" when the YAML's "input:" tuple didn't supply a custom
            // label for the main slot (see parseWorkflowInputTuplesToken).
            label: String(declaredInputs[0]?.label || "").trim() || "Main Input",
            default: MAIN_INPUT_MODE_CANVAS,
            // "value|Label" keeps the stored/compared value as MAIN_INPUT_MODE_SELECTED_LAYER
            // (so previously-saved workflow settings still match) while only changing the
            // displayed dropdown text to use "&" instead of "And". "&&" escapes to a literal "&"
            // — a single "&" gets swallowed as a mnemonic/accelerator marker by this native
            // control, the same issue fixed on the Bridge send button.
            options: [
                MAIN_INPUT_MODE_CANVAS,
                MAIN_INPUT_MODE_SELECTED_LAYER_ONLY,
                `${MAIN_INPUT_MODE_SELECTED_LAYER}|Selected Layer && Below`,
                MAIN_INPUT_MODE_MANUAL
            ]
        });
    }

    // Workflows with no declared inputs at all (no "input:" token in the YAML, e.g. pure
    // text-to-video/text-to-image nodes) take no Photoshop image of any kind — showing an empty
    // Inputs box for them would be misleading, so skip it entirely.
    if (declaredInputs.length > 0) {
        parameters.push({
            name: "additional_inputs",
            key: buildWorkflowParamKey("ref:additional_inputs", "items"),
            class_type: "",
            node_id: "",
            type: "reference_list",
            data_type: "json",
            label: "Inputs",
            default: [],
            referenceStart: 1,
            referenceLimit: additionalSlots.length,
            referenceTargetLabels: additionalSlots.map((slot) => String(slot?.label || "").trim()),
            referenceTargetRequired: additionalSlots.map((slot) => Boolean(slot?.required)),
            mainInputLabel: String(declaredInputs[0]?.label || "").trim(),
            mainInputRequired: Boolean(declaredInputs[0]?.required)
        });

        // Governs exportReferenceLayerSnapshotToTempFolder's downscale cap (REFERENCE_EXPORT_MAX_DIMENSION_PX)
        // for anything exported through the Inputs box pipeline — additional slots and, when
        // Main Input is set to MAIN_INPUT_MODE_MANUAL, the manually-attached main input too,
        // since both go through the exact same export function. See shouldScaleDownAdditionalInputs().
        // scaled_down_additional_inputs_default: true/false — top-level YAML token controlling
        // this checkbox's default checked state (defaults to true when the token is absent).
        const scaleDownAdditionalInputsDefault = parseYamlBooleanToken(
            parseTopLevelYamlScalarToken(yamlText, "scaled_down_additional_inputs_default"),
            true
        );
        parameters.push({
            name: "scale_down_additional_inputs",
            key: buildWorkflowParamKey("ref:scale_down_additional_inputs", "value"),
            class_type: "",
            node_id: "",
            type: "checkbox",
            data_type: "boolean",
            label: "Scale Down Additional Inputs (Faster)",
            default: scaleDownAdditionalInputsDefault
        });
    }

    return { parameters, classTypes, nodeIds, nodeTargets };
}

// Builds a UI input control for one parsed workflow parameter definition.
function createNanoBananaInput(param) {
    const type = String(param?.type || "textbox").toLowerCase();
    const isReferenceListParam = (type === "reference_list");
    const dataType = String(param?.data_type || "string").trim().toLowerCase();
    const defaultValue = param?.default ?? "";
    const isFloatLikeType = (
        dataType === "number"
        || dataType === "float"
        || dataType === "double"
        || dataType === "decimal"
    );
    let resolvedDefault = "";
    if (defaultValue !== null && defaultValue !== undefined) {
        if (isFloatLikeType) {
            if (typeof defaultValue === "number" && Number.isFinite(defaultValue)) {
                resolvedDefault = Number.isInteger(defaultValue) ? `${defaultValue}.0` : String(defaultValue);
            } else {
                const asText = String(defaultValue).trim();
                resolvedDefault = /^-?\d+$/.test(asText) ? `${asText}.0` : asText;
            }
        } else {
            resolvedDefault = String(defaultValue);
        }
    }

    if (type === "bigtextbox") {
        // UXP native <textarea> hard-caps input at 256 characters in some host builds
        // regardless of the DOM maxLength property. sp-textarea (Spectrum Web Component)
        // does not hit that cap and supports full multiline prompt entry.
        const textarea = document.createElement("sp-textarea");
        textarea.className = "dynamicInput dynamicBigInput";
        textarea.setAttribute("rows", "5");
        textarea.setAttribute("maxlength", "65536");
        textarea.maxLength = 65536;
        textarea.setAttribute("data-param-name", String(param?.name || ""));
        textarea.setAttribute("data-param-type", type);
        textarea.setAttribute("data-param-data-type", dataType);
        textarea.value = resolvedDefault;
        return textarea;
    }

    if (type === "dropdown") {
        // Allow YAML options to define a submitted value different from display label
        // using "value|Label" (e.g. "1024x1024|1024×1024").
        const normalizeDropdownOption = (rawOption) => {
            const text = String(rawOption ?? "");
            const separatorIndex = text.indexOf("|");
            if (separatorIndex < 0) {
                const plain = text;
                return { label: plain, value: plain };
            }
            const value = text.slice(0, separatorIndex).trim();
            const label = text.slice(separatorIndex + 1).trim();
            return {
                label: label || value || text,
                value: value || label || text
            };
        };
        const select = document.createElement("select");
        select.className = "dynamicInput";
        select.setAttribute("data-param-name", String(param?.name || ""));
        select.setAttribute("data-param-type", type);
        select.setAttribute("data-param-data-type", dataType);

        const options = Array.isArray(param?.options) ? param.options : [];
        const normalizedOptions = options.map((opt) => normalizeDropdownOption(opt));
        for (let i = 0; i < normalizedOptions.length; i += 1) {
            const optionDef = normalizedOptions[i];
            const optionEl = document.createElement("option");
            optionEl.value = String(optionDef.value);
            optionEl.textContent = String(optionDef.label);
            select.appendChild(optionEl);
        }

        const defaultAsString = String(defaultValue);
        const defaultOption = normalizedOptions.find((opt) => opt.value === defaultAsString || opt.label === defaultAsString) || null;
        const resolvedDefaultValue = defaultOption ? String(defaultOption.value) : defaultAsString;
        if (resolvedDefaultValue && !normalizedOptions.some((opt) => String(opt.value) === resolvedDefaultValue)) {
            const extra = document.createElement("option");
            extra.value = resolvedDefaultValue;
            extra.textContent = defaultAsString || resolvedDefaultValue;
            select.appendChild(extra);
        }
        select.value = resolvedDefaultValue;
        return select;
    }

    if (type === "checkbox") {
        const wrapper = document.createElement("label");
        wrapper.className = "connectionModeRow dynamicCheckboxInputRow";
        wrapper.setAttribute("data-param-name", String(param?.name || ""));
        wrapper.setAttribute("data-param-type", type);
        wrapper.setAttribute("data-param-data-type", dataType || "boolean");

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(defaultValue === true || String(defaultValue).toLowerCase() === "true" || String(defaultValue) === "1");
        checkbox.setAttribute("data-param-checkbox", "true");

        const caption = document.createElement("span");
        caption.className = "connectionModeLabel";
        caption.textContent = String(param?.checkbox_label || param?.label || param?.name || "").trim();

        wrapper.appendChild(checkbox);
        wrapper.appendChild(caption);
        return wrapper;
    }

    if (type === "seed") {
        // Seed control behaves like a textbox while adding quick +/-/random actions.
        const wrapper = document.createElement("div");
        // Reuse the reference-list control container because its vertical layout is stable in UXP.
        wrapper.className = "dynamicReferenceListControl dynamicSeedControl";
        wrapper.setAttribute("data-param-name", String(param?.name || ""));
        wrapper.setAttribute("data-param-type", type);
        wrapper.setAttribute("data-param-data-type", dataType || "integer");

        const input = document.createElement("input");
        input.className = "dynamicInput";
        input.type = "text";
        input.inputMode = "numeric";
        input.value = resolvedDefault;

        const buttonsRow = document.createElement("div");
        // Reuse the reference-list button row class so spacing and button sizing match exactly.
        buttonsRow.className = "dynamicReferenceListButtonsRow";

        const incrementBtn = document.createElement("button");
        incrementBtn.type = "button";
        incrementBtn.className = "qc-btn dynamicReferenceListBtn";
        incrementBtn.textContent = "+";
        incrementBtn.setAttribute("aria-label", "Increase seed by 1");

        const decrementBtn = document.createElement("button");
        decrementBtn.type = "button";
        decrementBtn.className = "qc-btn dynamicReferenceListBtn";
        decrementBtn.textContent = "-";
        decrementBtn.setAttribute("aria-label", "Decrease seed by 1");

        const randomBtn = document.createElement("button");
        randomBtn.type = "button";
        randomBtn.className = "qc-btn dynamicReferenceListBtn";
        randomBtn.textContent = "⭯";
        randomBtn.setAttribute("aria-label", "Set random seed");

        const parseSeedValue = () => {
            const parsed = Number.parseInt(String(input.value || "").trim(), 10);
            return Number.isFinite(parsed) ? parsed : 0;
        };
        const emitSeedChange = () => {
            wrapper.dispatchEvent(new Event("input", { bubbles: true }));
            wrapper.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const applySeedValue = (nextValue) => {
            input.value = String(nextValue);
            emitSeedChange();
        };
        // Default seed ceiling matches ComfyUI's own INT widget max (2^31); an imported workflow's
        // declared max: (e.g. "seed (number, ..., max=2147483647)") narrows this when present.
        const declaredSeedMax = Number.parseInt(String(param?.max ?? "").trim(), 10);
        const seedMaxExclusive = Number.isFinite(declaredSeedMax) && declaredSeedMax > 0
            ? declaredSeedMax + 1
            : 2147483648;
        const buildRandomSeed = () => Math.floor(Math.random() * seedMaxExclusive);

        incrementBtn.addEventListener("click", () => applySeedValue(parseSeedValue() + 1));
        decrementBtn.addEventListener("click", () => applySeedValue(parseSeedValue() - 1));
        randomBtn.addEventListener("click", () => applySeedValue(buildRandomSeed()));

        input.addEventListener("input", () => {
            wrapper.dispatchEvent(new Event("input", { bubbles: true }));
        });
        input.addEventListener("change", () => {
            wrapper.dispatchEvent(new Event("change", { bubbles: true }));
        });

        Object.defineProperty(wrapper, "value", {
            configurable: true,
            get() {
                return String(input.value ?? "");
            },
            set(nextValue) {
                input.value = String(nextValue ?? "");
            }
        });

        buttonsRow.appendChild(incrementBtn);
        buttonsRow.appendChild(decrementBtn);
        buttonsRow.appendChild(randomBtn);
        wrapper.appendChild(input);
        wrapper.appendChild(buttonsRow);
        return wrapper;
    }

    if (isReferenceListParam) {
        // Reference list control: users curate selected Photoshop layers through +/- actions.
        const wrapper = document.createElement("div");
        wrapper.className = "dynamicReferenceListControl";
        wrapper.setAttribute("data-param-name", String(param?.name || ""));
        wrapper.setAttribute("data-param-type", "reference_list");
        wrapper.setAttribute("data-param-data-type", "json");
        wrapper.setAttribute("data-reference-shift-down", "false");
        wrapper.setAttribute("data-reference-ctrl-down", "false");
        wrapper.setAttribute("data-reference-meta-down", "false");
        wrapper.setAttribute("data-reference-start", Number.parseInt(String(param?.referenceStart || "1"), 10) === 2 ? "2" : "1");
        // Optional per-slot custom display labels (index-aligned with reference_targets),
        // author-supplied via the sidecar's second comma-separated quoted value. Empty
        // entries fall back to the auto-generated "Image N" label at render time.
        wrapper.setAttribute(
            "data-reference-target-labels",
            JSON.stringify(Array.isArray(param?.referenceTargetLabels) ? param.referenceTargetLabels : [])
        );
        // Index-aligned with the labels above — marks which additional slots are mandatory
        // (declared with the bare "required" keyword in the input: tuple). See
        // validateAutoRunRequiredInputs for the send-time enforcement.
        wrapper.setAttribute(
            "data-reference-target-required",
            JSON.stringify(Array.isArray(param?.referenceTargetRequired) ? param.referenceTargetRequired.map(Boolean) : [])
        );
        // Index-aligned with the labels above — "image" (LoadImage/LoadMask), "file" (LoadVideo),
        // or "audio" (LoadAudio). Only "image" slots get a row rendered (see renderRowAt): a
        // Photoshop layer can never fill a video/audio input node.
        wrapper.setAttribute(
            "data-reference-target-input-names",
            JSON.stringify(Array.isArray(param?.referenceTargetInputNames) ? param.referenceTargetInputNames : [])
        );
        // Custom label for the always-present "Main" row (falls back to "Main" when empty).
        wrapper.setAttribute("data-main-input-label", String(param?.mainInputLabel || "").trim());
        wrapper.setAttribute("data-main-input-required", param?.mainInputRequired ? "true" : "false");
        // User-controlled: when the main input isn't required by the workflow's YAML, the user
        // can opt out of sending it at all (see the checkbox rendered next to the main input row
        // in renderMainInputRow/renderRowAt below). Read at send time by
        // prepareAutoRunSelectedWorkflowJob/executePreparedAutoRunJob to skip canvas capture and
        // upload entirely. Never offered when mainInputRequired is true.
        wrapper.setAttribute("data-main-input-disabled", "false");
        // Caps how many extra Photoshop layers can be attached — matches the number of
        // additional input slots (beyond the main one) declared in this workflow's "input:" token.
        wrapper.setAttribute("data-reference-limit", String(Math.max(0, Number.parseInt(String(param?.referenceLimit || "0"), 10) || 0)));
        // Mirrors the "Main Input" dropdown's current value (kept in sync by renderNanoBananaForm).
        // When it's MAIN_INPUT_MODE_MANUAL, an extra trailing slot (index === referenceLimit)
        // is rendered so the user can attach a layer to the main input the same way as any
        // additional input — see syncReferenceListControlState's effectiveSlotCount.
        wrapper.setAttribute("data-main-input-mode", MAIN_INPUT_MODE_CANVAS);

        const updateModifierState = (event, isDown) => {
            const key = String(event?.key || "").toLowerCase();
            if (key === "shift") wrapper.setAttribute("data-reference-shift-down", isDown ? "true" : "false");
            if (key === "control") wrapper.setAttribute("data-reference-ctrl-down", isDown ? "true" : "false");
            if (key === "meta" || key === "command") wrapper.setAttribute("data-reference-meta-down", isDown ? "true" : "false");
        };
        wrapper.addEventListener("keydown", (event) => updateModifierState(event, true), true);
        wrapper.addEventListener("keyup", (event) => updateModifierState(event, false), true);
        wrapper.addEventListener("focusout", () => {
            wrapper.setAttribute("data-reference-shift-down", "false");
            wrapper.setAttribute("data-reference-ctrl-down", "false");
            wrapper.setAttribute("data-reference-meta-down", "false");
        });

        const listEl = document.createElement("div");
        listEl.className = "dynamicReferenceListInput";

        const buttonsRow = document.createElement("div");
        buttonsRow.className = "dynamicReferenceListButtonsRow";

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "qc-btn dynamicReferenceListBtn";
        addBtn.textContent = "+";
        addBtn.setAttribute("aria-label", "Assign selected Photoshop layer(s) to the selected slot(s), or the next free slot(s) if none selected");

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "qc-btn dynamicReferenceListBtn";
        removeBtn.textContent = "-";
        removeBtn.setAttribute("aria-label", "Clear selected slot(s)");

        const emitReferenceListChange = () => {
            wrapper.dispatchEvent(new Event("input", { bubbles: true }));
            wrapper.dispatchEvent(new Event("change", { bubbles: true }));
        };

        addBtn.addEventListener("click", async () => {
            try {
                const currentItems = parseReferenceListValue(wrapper.getAttribute("data-reference-items"));
                const limitRaw = Number.parseInt(String(wrapper.getAttribute("data-reference-limit") || "0"), 10);
                // 0 genuinely means "no additional slots declared" now (not "unlimited") —
                // the limit always reflects a real declared count in this workflow model.
                const referenceLimit = Number.isFinite(limitRaw) ? Math.max(0, limitRaw) : 0;
                // MAIN_INPUT_MODE_MANUAL adds one extra trailing slot for the main input itself.
                const isManualMainSlotEnabled = String(wrapper.getAttribute("data-main-input-mode") || "") === MAIN_INPUT_MODE_MANUAL;
                const effectiveSlotCount = referenceLimit + (isManualMainSlotEnabled ? 1 : 0);
                if (effectiveSlotCount < 1) {
                    log("References: this workflow has no additional input slots.");
                    return;
                }
                const selectedLayers = await getActivePhotoshopLayersForReferences();
                if (!selectedLayers.length) {
                    log("References: select Smart Object or raster (pixel) layer(s) to add — adjustment, fill, text, and group layers aren't supported.");
                    return;
                }
                // Slots backed by a LoadVideo/LoadAudio node have no rendered row (see
                // renderRowAt) since a Photoshop layer can never fill them — exclude them here
                // too, or the "auto-fill next empty slot" fallback below would silently assign a
                // layer into one of them with no visible row to show it happened.
                let referenceTargetInputNames = [];
                try {
                    const parsedInputNames = JSON.parse(wrapper.getAttribute("data-reference-target-input-names") || "[]");
                    if (Array.isArray(parsedInputNames)) referenceTargetInputNames = parsedInputNames;
                } catch (_e) {}
                const isFillableSlot = (i) => isManualMainSlotEnabled && i === referenceLimit
                    ? true
                    : String(referenceTargetInputNames[i] || "image") === "image";
                // If the user explicitly selected slot rows first, assign into exactly those
                // slots (in row order) — this is how the user decides which slot each layer
                // lands in, rather than always filling front-to-back in attach order.
                const explicitSlotIndices = Array.from(
                    listEl.querySelectorAll('.dynamicReferenceListItem[data-selected="true"]')
                )
                    .map((row) => Number.parseInt(String(row.getAttribute("data-slot-index") || "-1"), 10))
                    .filter((n) => Number.isFinite(n) && n >= 0 && n < effectiveSlotCount);

                const targetIndices = explicitSlotIndices.length === 1 && selectedLayers.length > 1
                    ? (() => {
                        // One slot selected but several layers selected: start at that slot and
                        // continue into the following slots in VISUAL order — the top selected
                        // layer goes into the chosen slot, the next layer goes into the row
                        // below it on screen, and so on. This walks DOM position, not raw slot
                        // index — those diverge for the manual main slot, which renders first
                        // in the list (see syncReferenceListControlState) despite having the
                        // highest slot index (referenceLimit), so an index++ walk would never
                        // reach any row after it.
                        const startIndex = explicitSlotIndices[0];
                        const domSlotOrder = Array.from(listEl.querySelectorAll(".dynamicReferenceListItem"))
                            .map((r) => Number.parseInt(String(r.getAttribute("data-slot-index") || "-1"), 10));
                        const startDomPos = domSlotOrder.indexOf(startIndex);
                        const consecutiveIndices = [];
                        if (startDomPos >= 0) {
                            for (let p = startDomPos; p < domSlotOrder.length && consecutiveIndices.length < selectedLayers.length; p += 1) {
                                consecutiveIndices.push(domSlotOrder[p]);
                            }
                        } else {
                            consecutiveIndices.push(startIndex);
                        }
                        return consecutiveIndices;
                    })()
                    : (explicitSlotIndices.length > 0
                        ? explicitSlotIndices
                        : (() => {
                            // No explicit target chosen — fall back to auto-filling the next empty
                            // slots in declared order, same as the original append behavior.
                            const autoIndices = [];
                            for (let i = 0; i < effectiveSlotCount && autoIndices.length < selectedLayers.length; i += 1) {
                                if (!currentItems[i]?.layerId && isFillableSlot(i)) autoIndices.push(i);
                            }
                            return autoIndices;
                        })());

                if (targetIndices.length === 0) {
                    log("References: no free slots — select a slot to overwrite, or remove one first.");
                    return;
                }

                const nextItems = currentItems.slice();
                for (let i = 0; i < effectiveSlotCount; i += 1) {
                    if (!nextItems[i]) nextItems[i] = normalizeReferenceListItem(null);
                }
                // One selected layer with multiple target slots broadcasts to all of them
                // (e.g. 2 slots selected + 1 layer selected -> both slots get that layer).
                // Multiple layers with multiple slots still pair up index-to-index.
                if (selectedLayers.length === 1) {
                    for (let i = 0; i < targetIndices.length; i += 1) {
                        nextItems[targetIndices[i]] = selectedLayers[0];
                    }
                } else {
                    for (let i = 0; i < targetIndices.length && i < selectedLayers.length; i += 1) {
                        nextItems[targetIndices[i]] = selectedLayers[i];
                    }
                }
                // After assigning, auto-select the next unfilled slot so the user can keep
                // adding layers in sequence without re-picking a row each time.
                let nextEmptyIndex = -1;
                for (let i = 0; i < effectiveSlotCount; i += 1) {
                    if (!nextItems[i]?.layerId && isFillableSlot(i)) { nextEmptyIndex = i; break; }
                }
                if (nextEmptyIndex >= 0) {
                    wrapper.setAttribute("data-reference-selected-slot-indices", String(nextEmptyIndex));
                    wrapper.setAttribute("data-reference-anchor-slot-index", String(nextEmptyIndex));
                } else {
                    wrapper.setAttribute("data-reference-selected-slot-indices", "");
                }
                syncReferenceListControlState(wrapper, listEl, nextItems);
                emitReferenceListChange();
            } catch (error) {
                log(`References add error: ${describeError(error)}`);
            }
        });

        removeBtn.addEventListener("click", () => {
            const selectedSlotIndices = new Set();
            listEl.querySelectorAll('.dynamicReferenceListItem[data-selected="true"]').forEach((row) => {
                const slotIndex = Number.parseInt(String(row.getAttribute("data-slot-index") || "-1"), 10);
                if (Number.isFinite(slotIndex) && slotIndex >= 0) selectedSlotIndices.add(slotIndex);
            });
            if (selectedSlotIndices.size === 0) return;
            const currentItems = parseReferenceListValue(wrapper.getAttribute("data-reference-items"));
            const nextItems = currentItems.map((item, i) => (selectedSlotIndices.has(i) ? normalizeReferenceListItem(null) : item));
            syncReferenceListControlState(wrapper, listEl, nextItems);
            emitReferenceListChange();
        });

        buttonsRow.appendChild(addBtn);
        buttonsRow.appendChild(removeBtn);
        wrapper.appendChild(listEl);
        wrapper.appendChild(buttonsRow);

        // Exposed so the "Main Input" dropdown (a separate control) can trigger a re-sync
        // when its mode changes — see renderNanoBananaForm's wiring for MAIN_INPUT_MODE_PARAM_NAME.
        wrapper.__quickaiListEl = listEl;

        // Default-select the first slot so the user can assign straight away without
        // having to click a row first.
        const initialReferenceLimit = Math.max(0, Number.parseInt(String(wrapper.getAttribute("data-reference-limit") || "0"), 10) || 0);
        if (initialReferenceLimit > 0) {
            wrapper.setAttribute("data-reference-selected-slot-indices", "0");
            wrapper.setAttribute("data-reference-anchor-slot-index", "0");
        }
        syncReferenceListControlState(wrapper, listEl, defaultValue);
        return wrapper;
    }

    const input = document.createElement("input");
    input.className = "dynamicInput";
    input.tabIndex = 0;
    input.setAttribute("data-param-name", String(param?.name || ""));
    input.setAttribute("data-param-type", type);
    input.setAttribute("data-param-data-type", dataType);

    if (dataType === "integer" || dataType === "int") {
        // UXP number fields can clamp large values; keep textbox semantics and parse as integer later.
        input.type = "text";
        input.inputMode = "numeric";
    } else if (isFloatLikeType) {
        // UXP number fields can clamp large values; keep textbox semantics and parse as float later.
        input.type = "text";
        input.inputMode = "decimal";
    } else {
        input.type = "text";
    }

    // Numeric range from the imported workflow YAML (min:/max: — see buildWorkflowImportParam /
    // parseNanoBananaYaml). Stored as data attributes rather than native min/max — this input is
    // intentionally type="text" (see comments above), so enforcement happens on blur in JS instead
    // of via native number-input clamping.
    const isNumericRangeType = dataType === "integer" || dataType === "int" || isFloatLikeType;
    if (isNumericRangeType && param?.min !== undefined && param?.min !== null && param.min !== "") {
        input.setAttribute("data-param-min", String(param.min));
    }
    if (isNumericRangeType && param?.max !== undefined && param?.max !== null && param.max !== "") {
        input.setAttribute("data-param-max", String(param.max));
    }
    if (isNumericRangeType) {
        input.addEventListener("blur", () => clampNumericInputToDeclaredRange(input));
    }

    input.value = resolvedDefault;
    return input;
}

// Clamps a numeric dynamic-input's value to its declared data-param-min/data-param-max on blur,
// so values imported with a min/max range (e.g. ComfyUI's "duration" slider, 4-15) can't be sent
// to the workflow out of range. No-ops if the field has no declared range or isn't a valid number.
function clampNumericInputToDeclaredRange(input) {
    const raw = String(input?.value ?? "").trim();
    if (!raw) return;
    const numericValue = Number(raw);
    if (!Number.isFinite(numericValue)) return;
    const minAttr = input.getAttribute("data-param-min");
    const maxAttr = input.getAttribute("data-param-max");
    let clamped = numericValue;
    if (minAttr !== null && minAttr !== "") clamped = Math.max(clamped, Number(minAttr));
    if (maxAttr !== null && maxAttr !== "") clamped = Math.min(clamped, Number(maxAttr));
    if (clamped !== numericValue) {
        input.value = String(clamped);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }
}

// Splits a comma-delimited YAML-ish list while respecting brackets and quoted strings.
function splitYamlImportList(text) {
    const out = [];
    let current = "";
    let quote = "";
    let depth = 0;
    const raw = String(text || "");
    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        const prev = i > 0 ? raw[i - 1] : "";
        if (quote) {
            current += ch;
            if (ch === quote && prev !== "\\") quote = "";
            continue;
        }
        if (ch === "\"" || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === "[" || ch === "(" || ch === "{") depth += 1;
        if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
        if (ch === "," && depth === 0) {
            if (current.trim()) out.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out;
}

// Normalizes one widget or input name into a YAML-safe key.
function buildWorkflowImportYamlKey(label, fallbackIndex) {
    const safe = String(label || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return safe || `param_${Math.max(1, Number(fallbackIndex) || 1)}`;
}

// Formats a scalar as a YAML-safe token that the existing workflow parser can read back.
function formatWorkflowImportYamlScalar(value) {
    if (value === null || value === undefined) return '""';
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return formatWorkflowImportYamlScalar(JSON.stringify(value));
    if (value && typeof value === "object") {
        try {
            return formatWorkflowImportYamlScalar(JSON.stringify(value));
        } catch (_e) {
            return JSON.stringify(String(value));
        }
    }
    const text = String(value);
    return JSON.stringify(text);
}

// Formats workflow identifiers as quoted YAML strings so node IDs stay stable across parsers.
function formatWorkflowImportYamlIdentifier(value) {
    return JSON.stringify(String(value ?? ""));
}

// Formats the selected import-environment toggles into the workflow YAML token list.
function buildWorkflowImportEnvironmentToken(selection) {
    const environmentSelection = selection?.environmentSelection || {};
    const hasExplicitSelection = ["supportsLocal", "supportsCloud", "supportsRunComfy", "supportsRunPod"]
        .some((key) => Object.prototype.hasOwnProperty.call(environmentSelection, key));
    if (!hasExplicitSelection) return '"local", "cloud", "runcomfy", "runpod"';
    const orderedTokens = [
        environmentSelection.supportsLocal ? "local" : "",
        environmentSelection.supportsCloud ? "cloud" : "",
        environmentSelection.supportsRunComfy ? "runcomfy" : "",
        environmentSelection.supportsRunPod ? "runpod" : ""
    ].filter(Boolean);
    return orderedTokens.length > 0 ? orderedTokens.map((t) => `"${t}"`).join(", ") : '"local"';
}

// Normalizes widget option payloads from metadata into a flat array of option tokens.
function parseWorkflowImportOptions(rawOptions) {
    if (Array.isArray(rawOptions)) {
        return rawOptions
            .map((opt) => String(opt ?? "").trim())
            .filter(Boolean);
    }

    const text = String(rawOptions || "").trim();
    if (!text) return [];

    // Metadata stores dropdown options as bracketed lists, e.g. options=[a, b, c].
    const optionsMatch = text.match(/options\s*=\s*\[(.*)\]\s*$/s);
    const bracketMatch = optionsMatch || text.match(/^\[(.*)\]$/s);
    const inner = bracketMatch ? bracketMatch[1] : text;
    return splitYamlImportList(inner)
        .map((opt) => String(parseYamlScalar(opt) ?? "").trim())
        .filter(Boolean);
}

// Parses one metadata widget line into a compact object the import dialog can edit.
function parseWorkflowImportWidgetLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed.startsWith("- ")) return null;
    const body = trimmed.slice(2).trim();
    const openIndex = body.indexOf("(");
    const closeIndex = body.lastIndexOf(")");
    if (openIndex < 0 || closeIndex <= openIndex) return null;
    const label = body.slice(0, openIndex).trim();
    const rawInside = body.slice(openIndex + 1, closeIndex).trim();
    const parts = splitYamlImportList(rawInside);
    const widgetType = String(parts.shift() || "").trim();
    const meta = { label, widgetType, rawInside };
    for (const part of parts) {
        const eqIndex = part.indexOf("=");
        if (eqIndex < 0) continue;
        const key = String(part.slice(0, eqIndex) || "").trim();
        const rawValue = String(part.slice(eqIndex + 1) || "").trim();
        if (key) meta[key] = rawValue;
    }
    return meta;
}

// Infers the editable control type from a metadata widget descriptor.
function inferWorkflowImportParamType(widget, widgetKey, widgetValue) {
    const widgetType = String(widget?.widgetType || "").trim().toLowerCase();
    const label = String(widget?.label || widgetKey || "").trim().toLowerCase();
    const valueText = String(widgetValue ?? "").trim();
    const options = Array.isArray(widget?.options) ? widget.options : [];

    if (options.length > 0 || widgetType === "combo" || widgetType === "dropdown") return "dropdown";
    if (widgetType === "customtext" || widgetType === "textarea" || valueText.includes("\n") || /(prompt|system_prompt|instruction|description|text)/i.test(label)) {
        return "bigtextbox";
    }
    if (widgetType === "boolean" || widgetType === "checkbox" || widgetType === "toggle" || typeof widgetValue === "boolean") return "checkbox";
    if (widgetType === "seed" || /seed/i.test(label)) return "seed";
    if (widgetType === "number" || widgetType === "float" || widgetType === "int" || widgetType === "integer") return "textbox";
    return "textbox";
}

// Builds a single editable field descriptor from metadata widget details.
// nodeInputs is the node's Inputs array (from the metadata parser) used to resolve data_type.
// proxyTarget, when set ({nodeId, field}), means this widget is actually a proxy exposed by a
// subgraph container node (see proxyWidgets parsing in parseWorkflowImportMetadataText) — the
// emitted key/node_id must target the real inner node/field, since the outer node id never
// exists in the workflow API JSON.
function buildWorkflowImportParam(widget, index, nodeInputs, proxyTarget) {
    // Try to find a matching input entry by label so we can use its inputType as a hint.
    const widgetLabel = String(widget?.label || widget?.name || "").trim().toLowerCase();
    const inputsArr = Array.isArray(nodeInputs) ? nodeInputs : [];
    const matchedInput = inputsArr.find((inp) => {
        const inputName = String(inp?.name || "").trim().toLowerCase();
        return inputName === widgetLabel || inputName.endsWith(`.${widgetLabel}`);
    });
    const matchedInputType = String(matchedInput?.inputType || "").trim().toUpperCase();

    // The matched Inputs entry carries the node's real (possibly dotted, e.g. "model.prompt")
    // parameter id for nested/dynamic-combo sub-fields. Prefer it over the bare widget label so
    // the emitted YAML key actually matches the id the workflow JSON expects.
    const widgetKey = buildWorkflowImportYamlKey(matchedInput?.name || widget?.label || widget?.name || `param_${index}`, index);
    const options = parseWorkflowImportOptions(widget?.options);
    const parsedDefault = Object.prototype.hasOwnProperty.call(widget || {}, "default")
        ? parseYamlScalar(widget.default)
        : (Object.prototype.hasOwnProperty.call(widget || {}, "value") ? parseYamlScalar(widget.value) : "");

    let paramType = inferWorkflowImportParamType(widget, widgetKey, parsedDefault);
    // If the widget type didn't signal boolean but the matched input says BOOLEAN, treat it as a checkbox.
    if (paramType !== "checkbox" && (matchedInputType === "BOOLEAN" || matchedInputType === "BOOL")) {
        paramType = "checkbox";
    }
    // The metadata exporter JSON-stringifies every widget value (comfy_extension/quickai_loader.js),
    // so a boolean widget arrives as the quoted text "true"/"false" and parseYamlScalar's quoted-string
    // branch returns it as a plain JS string rather than coercing it to a real boolean. Force real
    // boolean typing here so the emitted YAML gets an unquoted `true`/`false`, not a quoted string.
    let normalizedDefault = parsedDefault;
    if (paramType === "checkbox" && typeof normalizedDefault !== "boolean") {
        normalizedDefault = String(normalizedDefault).trim().toLowerCase() === "true";
    }

    // Look up the data_type from the Inputs section by matching the widget label.
    const dataType = (() => {
        // Always override for these param types regardless of input type.
        if (paramType === "checkbox") return "boolean";
        if (paramType === "seed") return "integer";
        if (paramType === "dropdown") return "string";

        // The matched Inputs entry carries the authoritative ComfyUI type (INT/FLOAT).
        // Prefer it over heuristics — widget default values are stored as quoted strings
        // by the node exporter, so Number.isInteger checks on them are unreliable.
        if (matchedInputType === "INT" || matchedInputType === "INTEGER") return "integer";
        if (matchedInputType === "FLOAT" || matchedInputType === "NUMBER") return "float";

        // No matched input — fall back to inferring from the parsed default value.
        if (typeof parsedDefault === "number") return Number.isInteger(parsedDefault) ? "integer" : "float";
        if (String(widget?.widgetType || "").toLowerCase() === "number") return "float";
        return "string";
    })();

    // Same JSON-stringify-everything exporter quirk as the boolean case above, but for numeric
    // widgets: a value like duration=7 arrives as the quoted text "7", so parseYamlScalar's
    // quoted-string branch returns the JS string "7" instead of the number 7. Coerce it here (only
    // for genuinely numeric data types — never for node ids/labels/text) so the emitted YAML gets
    // a bare `default: 7`, not a quoted `default: "7"`.
    if ((dataType === "integer" || dataType === "float") && typeof normalizedDefault !== "number") {
        const coercedDefault = Number(normalizedDefault);
        if (Number.isFinite(coercedDefault)) normalizedDefault = coercedDefault;
    }

    // A proxy target overrides both the key and the node this field belongs to — the outer
    // subgraph node id (e.g. "627") never resolves in the workflow API JSON, only the real
    // inner node/field pair does (e.g. node "627:625", field "value").
    const effectiveKey = proxyTarget?.field ? proxyTarget.field : widgetKey;

    // Numeric widgets (number/slider/int/seed) carry min/max in the metadata, e.g.
    // "duration (slider, value=\"7\", min=4, max=15, step=10)" — parseWorkflowImportWidgetLine
    // already captures these as raw strings on the widget object; only numeric-typed params
    // (not dropdown/checkbox/text) get them carried through to the emitted YAML.
    const isNumericParamType = paramType === "seed" || dataType === "integer" || dataType === "float";
    const min = isNumericParamType && Object.prototype.hasOwnProperty.call(widget || {}, "min")
        ? parseYamlScalar(widget.min) : "";
    const max = isNumericParamType && Object.prototype.hasOwnProperty.call(widget || {}, "max")
        ? parseYamlScalar(widget.max) : "";

    return {
        name: effectiveKey,
        key: effectiveKey,
        node_id: proxyTarget?.nodeId || "",
        type: paramType,
        data_type: dataType,
        label: String(widget?.label || widget?.name || widgetKey || `Field ${index}`).trim(),
        default: normalizedDefault,
        options,
        min,
        max
    };
}

// Builds a compact dropdown so the user can override the YAML parameter type before export.
function createWorkflowImportTypeSelect(defaultType) {
    const select = document.createElement("select");
    select.className = "dynamicInput";
    select.style.minWidth = "150px";
    const types = ["textbox", "bigtextbox", "dropdown", "checkbox", "seed"];
    for (const type of types) {
        const option = document.createElement("option");
        option.value = type;
        option.textContent = type;
        select.appendChild(option);
    }
    select.value = types.includes(String(defaultType || "").toLowerCase()) ? String(defaultType).toLowerCase() : "textbox";
    return select;
}

// Parses the workflow export metadata text into editable nodes and fields.
function parseWorkflowImportMetadataText(metadataText) {
    const lines = String(metadataText || "").replace(/\r\n?/g, "\n").split("\n");
    const nodes = [];
    let currentNode = null;
    let currentSection = "";

    const flushNode = () => {
        if (currentNode) nodes.push(currentNode);
        currentNode = null;
        currentSection = "";
    };

    for (let i = 0; i < lines.length; i += 1) {
        const rawLine = lines[i];
        const trimmed = String(rawLine || "").trim();
        if (!trimmed) continue;

        const nodeMatch = trimmed.match(/^-\s+(\d+):\s+(.+?)\s+\[(.+?)\]\s*$/);
        if (nodeMatch) {
            flushNode();
            currentNode = {
                id: String(nodeMatch[1] || "").trim(),
                title: String(nodeMatch[2] || "").trim(),
                classType: String(nodeMatch[3] || "").trim(),
                inputs: [],
                widgets: [],
                properties: [],
                proxyWidgets: []
            };
            continue;
        }

        if (!currentNode) continue;
        if (/^\s+Inputs:\s*$/.test(rawLine)) {
            currentSection = "inputs";
            continue;
        }
        if (/^\s+Widgets:\s*$/.test(rawLine)) {
            currentSection = "widgets";
            continue;
        }
        if (/^\s+Properties:\s*$/.test(rawLine)) {
            currentSection = "properties";
            continue;
        }

        if (currentSection === "inputs") {
            const inputMatch = rawLine.match(/^\s+-\s+(.+?)\s+\((.+?),\s*(linked|unlinked)\)\s*$/);
            if (inputMatch) {
                currentNode.inputs.push({
                    name: String(inputMatch[1] || "").trim(),
                    inputType: String(inputMatch[2] || "").trim(),
                    linked: String(inputMatch[3] || "").trim() === "linked"
                });
            }
            continue;
        }

        if (currentSection === "widgets") {
            const widget = parseWorkflowImportWidgetLine(rawLine);
            if (widget) currentNode.widgets.push(widget);
            continue;
        }

        if (currentSection === "properties") {
            const propertyMatch = rawLine.match(/^\s+-\s+(.+?):\s*(.+)\s*$/);
            if (propertyMatch) {
                const propName = String(propertyMatch[1] || "").trim();
                const rawPropValue = propertyMatch[2];
                // Subgraph container nodes (e.g. "@Image Edit (Qwen 2509)") expose their inner
                // nodes' widgets as their own, via a "proxyWidgets" property listing
                // [innerNodeId, innerFieldName] pairs in the same order as the Widgets: list.
                // The outer node id (e.g. "627") never exists in the actual workflow API JSON —
                // only the namespaced inner ids (e.g. "627:613") do — so this mapping is required
                // to emit YAML that targets real, resolvable nodes/fields.
                if (propName === "proxyWidgets") {
                    try {
                        const parsed = JSON.parse(rawPropValue);
                        if (Array.isArray(parsed)) {
                            currentNode.proxyWidgets = parsed.map((pair) => ({
                                nodeId: String(pair?.[0] ?? "").trim(),
                                field: String(pair?.[1] ?? "").trim()
                            }));
                        }
                    } catch (_e) {}
                    continue;
                }
                currentNode.properties.push({
                    name: propName,
                    value: parseYamlScalar(rawPropValue)
                });
            }
        }
    }

    flushNode();
    return nodes;
}

// Builds a YAML file from the user's chosen nodes and defaults.
function buildWorkflowImportYaml(model, selection) {
    const appendFieldBlock = (lines, field) => {
        lines.push(`    ${field.key}:`);
        lines.push(`        type: ${field.type}`);
        lines.push(`        data_type: ${field.data_type}`);
        lines.push(`        label: ${formatWorkflowImportYamlScalar(field.label)}`);
        lines.push(`        default: ${formatWorkflowImportYamlScalar(field.value)}`);
        // Numeric range, captured from the source widget's min/max metadata (see
        // buildWorkflowImportParam) — omitted entirely when absent so non-numeric fields
        // (dropdown/checkbox/text) don't get stray empty tokens in the YAML.
        if (field.min !== undefined && field.min !== null && field.min !== "") {
            lines.push(`        min: ${formatWorkflowImportYamlScalar(field.min)}`);
        }
        if (field.max !== undefined && field.max !== null && field.max !== "") {
            lines.push(`        max: ${formatWorkflowImportYamlScalar(field.max)}`);
        }
        if (field.type === "dropdown" && Array.isArray(field.options) && field.options.length > 0) {
            lines.push("        options:");
            for (const option of field.options) {
                lines.push(`            - ${formatWorkflowImportYamlScalar(option)}`);
            }
        }
    };

    const lines = [];
    lines.push(`environment: ${buildWorkflowImportEnvironmentToken(selection)}`);
    const inputSlots = Array.isArray(selection?.inputs) ? selection.inputs.filter((s) => s?.nodeId) : [];
    if (inputSlots.length > 0) {
        const tuples = inputSlots.map((slot) => {
            const nodeIdPart = formatWorkflowImportYamlScalar(String(slot.nodeId));
            const label = String(slot.label || "").trim();
            const parts = [nodeIdPart];
            if (label) parts.push(formatWorkflowImportYamlScalar(label));
            if (slot.required) parts.push("required");
            return `(${parts.join(", ")})`;
        });
        lines.push(`input: ${tuples.join(", ")}`);
        // Only meaningful alongside a declared input (matches the "Scale Down Additional
        // Inputs" checkbox's own gating in parseNanoBananaYaml).
        lines.push(`scaled_down_additional_inputs_default: ${selection?.scaleDownAdditionalInputsDefault === false ? "false" : "true"}`);
    }
    const outputIds = Array.isArray(selection?.outputNodeIds) ? selection.outputNodeIds.filter(Boolean) : (selection?.outputNodeId ? [selection.outputNodeId] : []);
    if (outputIds.length > 0) lines.push(`output: ${outputIds.map(formatWorkflowImportYamlIdentifier).join(", ")}`);
    if (selection?.outputMaskNodeId && selection.outputMaskNodeId !== "__none__") lines.push(`output_mask: ${formatWorkflowImportYamlIdentifier(selection.outputMaskNodeId)}`);
    if (String(selection?.deploymentText || "").trim()) lines.push(`deployment: ${formatWorkflowImportYamlScalar(String(selection.deploymentText).trim())}`);
    if (String(selection?.endpointText || "").trim()) lines.push(`endpoint: ${formatWorkflowImportYamlScalar(String(selection.endpointText).trim())}`);
    if (String(selection?.localMachineText || "").trim()) lines.push(`local_machine: ${formatWorkflowImportYamlScalar(String(selection.localMachineText).trim())}`);

    lines.push("");

    // Iterate selection.nodes directly (not model.nodes) — subgraph-proxied fields target real
    // inner node ids (e.g. "627:613") that never appear in model.nodes, which only lists the
    // outer nodes from the metadata's top-level node listing.
    const selectionNodes = Array.isArray(selection?.nodes) ? selection.nodes : [];

    for (let i = 0; i < selectionNodes.length; i += 1) {
        const node = selectionNodes[i];
        const nodeId = String(node?.id || "").trim();
        if (!nodeId) continue;
        lines.push(`node_id: ${formatWorkflowImportYamlIdentifier(nodeId)}`);

        const selectedFields = Array.isArray(selection?.fieldsByNodeId?.[nodeId]) ? selection.fieldsByNodeId[nodeId] : [];
        const inputFieldsByKey = new Map();
        const widgetFieldsByKey = new Map();
        const inputFieldOrder = [];
        const widgetFieldOrder = [];
        for (const field of selectedFields) {
            const key = String(field?.key || "").trim();
            if (!key) continue;
            const sourceKind = String(field?.sourceKind || "").trim().toLowerCase();
            if (sourceKind === "input") {
                if (!inputFieldsByKey.has(key)) inputFieldOrder.push(key);
                inputFieldsByKey.set(key, field);
                continue;
            }
            if (!widgetFieldsByKey.has(key)) widgetFieldOrder.push(key);
            widgetFieldsByKey.set(key, field);
        }

        for (const key of inputFieldOrder) {
            if (widgetFieldsByKey.has(key)) continue;
            appendFieldBlock(lines, inputFieldsByKey.get(key));
        }
        for (const key of widgetFieldOrder) {
            appendFieldBlock(lines, widgetFieldsByKey.get(key));
        }
        lines.push("");
    }

    return `${lines.join("\n").trim()}\n`;
}

// Builds the import form into the main plugin panel (#importWorkflowsView) using real CSS classes.
function buildWorkflowImportPanelView(model, preferredSaveFolderEntry) {
    const view = document.getElementById("importWorkflowsView");
    while (view.firstChild) view.removeChild(view.firstChild);

    const importTitle = document.createElement("div");
    importTitle.style.cssText = "font-size:15px;font-weight:600;color:#cfcfcf;text-align:center;margin-bottom:4px;";
    importTitle.textContent = "Import Workflow";
    view.appendChild(importTitle);

    // Status element — starts hidden, shown near footer when save/error feedback is needed
    const status = document.createElement("div");
    status.style.cssText = "font-size:12px;color:#9f9f9f;min-height:0;display:none;";

    // Top form uses the same stacked field-group pattern as the main panel selectors.
    const topForm = document.createElement("div");
    topForm.style.cssText = "display:flex;flex-direction:column;width:100%;box-sizing:border-box;margin:0 0 14px 0;padding:0;";

    const createTopFieldRow = (labelText, control) => {
        const row = document.createElement("div");
        row.className = "connectionRow importWorkflowTopFieldRow";

        const group = document.createElement("div");
        group.className = "fieldGroup server importWorkflowTopFieldGroup";

        const label = document.createElement("div");
        label.className = "fieldLabel";
        label.textContent = labelText;

        group.appendChild(label);
        group.appendChild(control);
        row.appendChild(group);
        return row;
    };
    const createCheckboxRow = (labelText, checked = false) => {
        const checkboxLabel = document.createElement("label");
        checkboxLabel.className = "connectionModeRow";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(checked);

        const text = document.createElement("span");
        text.className = "connectionModeLabel";
        text.textContent = labelText;

        checkboxLabel.appendChild(checkbox);
        checkboxLabel.appendChild(text);
        return { row: createTopFieldRow(labelText, checkboxLabel), checkbox };
    };

    const styleNodeSelect = (sel) => {
        sel.className = "dynamicInput";
        sel.style.height = "24px";
        sel.style.minHeight = "24px";
    };
    const normalizeImportNodeClassType = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, "");
    const inputAllowedClassTypes = new Set(["loadimage", "loadmask", "loadvideo", "loadaudio"]);
    const outputAllowedClassTypes = new Set(["saveimage", "saveimageadvanced", "previewimage", "previewmask", "savevideo"]);
    const populateNodeSelect = (selectEl, { allowNone = false, allowedClassTypes = null, defaultToLast = false, sortAlphabetically = false } = {}) => {
        while (selectEl.firstChild) selectEl.removeChild(selectEl.firstChild);
        if (allowNone) {
            const noneOption = document.createElement("option");
            noneOption.value = "__none__";
            noneOption.textContent = "None";
            selectEl.appendChild(noneOption);
        }
        const matchingNodes = (Array.isArray(model.nodes) ? model.nodes : []).filter((node) => {
            if (!allowedClassTypes || allowedClassTypes.size < 1) return true;
            return allowedClassTypes.has(normalizeImportNodeClassType(node?.classType));
        });
        if (sortAlphabetically) {
            matchingNodes.sort((a, b) => String(a?.title || "").localeCompare(String(b?.title || ""), undefined, { sensitivity: "base" }));
        }
        for (const node of matchingNodes) {
            const option = document.createElement("option");
            option.value = String(node.id);
            option.textContent = `${node.id}: ${node.title}`;
            option.dataset.classType = String(node.classType || "");
            option.dataset.nodeTitle = String(node.title || "");
            selectEl.appendChild(option);
        }
        if (selectEl.options.length > 0) {
            if (allowNone) {
                selectEl.selectedIndex = 0;
            } else if (defaultToLast) {
                selectEl.selectedIndex = Math.max(0, selectEl.options.length - 1);
            } else {
                selectEl.selectedIndex = 0;
            }
        }
    };
    // Generic "+/-" multi-row node-picker builder shared by Input and Output. Both start
    // empty — pressing "+" adds the first row, and every row (including the first) can be
    // removed. Returns { container, addBtn, rows } where rows is a live array of row models.
    const createMultiNodeSelectControl = (options) => {
        const { allowedClassTypes, removeAriaLabel, addAriaLabel, withLabelInput, defaultLabelFor, sortAlphabetically = false, firstRowDefaultToLast = true } = options;
        const rows = [];
        const container = document.createElement("div");
        container.style.cssText = "display:flex;flex-direction:column;width:100%;";

        const createRow = () => {
            const row = document.createElement("div");
            row.style.cssText = "display:flex;flex-direction:column;width:100%;margin:0;" + (rows.length > 0 ? "margin-top:8px;" : "");

            // Top line: node dropdown + remove button.
            const topLine = document.createElement("div");
            topLine.style.cssText = "display:flex;flex-direction:row;align-items:center;width:100%;margin:0;";

            const sel = document.createElement("select");
            styleNodeSelect(sel);
            sel.style.cssText = "flex:1 1 auto;min-width:0;width:auto;height:24px;min-height:24px;margin:0;box-sizing:border-box;";
            populateNodeSelect(sel, { allowNone: false, allowedClassTypes, defaultToLast: rows.length === 0 && firstRowDefaultToLast, sortAlphabetically });
            topLine.appendChild(sel);

            const removeSpacer = document.createElement("div");
            removeSpacer.style.cssText = "width:8px;min-width:8px;flex-shrink:0;";
            topLine.appendChild(removeSpacer);
            const removeBtn = document.createElement("button");
            removeBtn.type = "button";
            removeBtn.className = "qc-btn dynamicReferenceListBtn";
            removeBtn.textContent = "−";
            removeBtn.setAttribute("aria-label", removeAriaLabel);
            removeBtn.addEventListener("click", () => {
                const idx = rows.findIndex((r) => r.row === row);
                if (idx !== -1) rows.splice(idx, 1);
                container.removeChild(row);
            });
            topLine.appendChild(removeBtn);

            row.appendChild(topLine);

            // Bottom line (optional): custom input-name field, below the node dropdown,
            // sized to match the other top-form sp-textfield rows (e.g. Local Machine).
            let labelInput = null;
            if (withLabelInput) {
                labelInput = document.createElement("input");
                labelInput.type = "text";
                labelInput.className = "dynamicInput";
                // No inline height override — the shared .dynamicInput class already sizes
                // (24px tall) and pads this the same way as every other single-line
                // .dynamicInput, matching the size="s" sp-textfield rows like Local Machine.
                labelInput.style.cssText = "width:100%;margin:8px 0 0 0;box-sizing:border-box;";
                // Dirty flag so switching the node dropdown only auto-fills the label while the
                // user hasn't typed their own value yet — once they type, node changes stop
                // overwriting it. The saved label itself is always written regardless of this
                // flag (see collectWorkflowImportDialogSelection) since node titles aren't
                // available anymore once this is persisted to YAML.
                labelInput.dataset.userEdited = "false";
                labelInput.addEventListener("input", () => {
                    labelInput.dataset.userEdited = "true";
                });
                const applyDefaultValue = () => {
                    if (labelInput.dataset.userEdited === "true") return;
                    const nextDefault = defaultLabelFor ? String(defaultLabelFor(sel.value) || "") : "";
                    labelInput.value = nextDefault;
                };
                applyDefaultValue();
                sel.addEventListener("change", applyDefaultValue);
                row.appendChild(labelInput);
            }

            // Marks this input mandatory — emitted as the bare "required" keyword in the
            // generated input: tuple (see buildWorkflowImportYaml). Only input rows get this
            // (gated on withLabelInput, same as the label field above, since outputs don't use
            // it). Defaults on for the first input (conventionally the main one) and off for
            // every additional input added after it.
            let requiredCheckbox = null;
            if (withLabelInput) {
                const requiredRow = document.createElement("label");
                requiredRow.className = "connectionModeRow";
                requiredRow.style.cssText = "margin-top:6px;";
                requiredCheckbox = document.createElement("input");
                requiredCheckbox.type = "checkbox";
                requiredCheckbox.checked = rows.length === 0;
                const requiredText = document.createElement("span");
                requiredText.className = "connectionModeLabel";
                requiredText.textContent = "Required";
                requiredRow.appendChild(requiredCheckbox);
                requiredRow.appendChild(requiredText);
                row.appendChild(requiredRow);
            }

            const rowModel = { row, select: sel, labelInput, requiredCheckbox };
            rows.push(rowModel);
            return rowModel;
        };

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "qc-btn dynamicReferenceListBtn";
        addBtn.textContent = "+";
        addBtn.setAttribute("aria-label", addAriaLabel);
        addBtn.style.cssText = "width:24px;";
        const availableNodeCount = (Array.isArray(model.nodes) ? model.nodes : [])
            .filter((n) => allowedClassTypes.has(normalizeImportNodeClassType(n?.classType))).length;
        if (availableNodeCount < 1) addBtn.style.display = "none";

        addBtn.addEventListener("click", () => {
            container.appendChild(createRow().row);
        });

        // Spacer div bypasses margin:0!important on .dynamicReferenceListBtn for the + button top gap.
        const addBtnSpacer = document.createElement("div");
        addBtnSpacer.style.cssText = "height:8px;";

        const control = document.createElement("div");
        control.style.cssText = "display:flex;flex-direction:column;width:100%;";
        control.appendChild(container);
        control.appendChild(addBtnSpacer);
        // Left-aligned row for "+", flush with the dropdowns' left edge. A bare button in the
        // column flex parent gets centered by UXP; a flex-start row pins it left.
        const addBtnRow = document.createElement("div");
        addBtnRow.style.cssText = "display:flex;flex-direction:row;justify-content:flex-start;width:100%;margin:0;";
        addBtnRow.appendChild(addBtn);
        control.appendChild(addBtnRow);

        return { control, container, addBtn, rows };
    };

    const inputControl = createMultiNodeSelectControl({
        allowedClassTypes: inputAllowedClassTypes,
        removeAriaLabel: "Remove input",
        addAriaLabel: "Add input",
        withLabelInput: true,
        sortAlphabetically: true,
        firstRowDefaultToLast: false,
        defaultLabelFor: (nodeId) => {
            const node = (Array.isArray(model.nodes) ? model.nodes : []).find((n) => String(n.id) === String(nodeId));
            return node ? String(node.title || "") : "";
        }
    });
    const inputRows = inputControl.rows;

    const outputControl0 = createMultiNodeSelectControl({
        allowedClassTypes: outputAllowedClassTypes,
        removeAriaLabel: "Remove output",
        addAriaLabel: "Add output",
        withLabelInput: false
    });
    // outputControl0.rows is live (rows are added/removed in place), so read it lazily via
    // this getter at save-time rather than trying to keep a separate array mirrored.
    const getOutputNodeSelects = () => outputControl0.rows.map((r) => r.select);

    const outputMaskNodeSelect = document.createElement("select");
    styleNodeSelect(outputMaskNodeSelect);
    populateNodeSelect(outputMaskNodeSelect, { allowNone: true, allowedClassTypes: outputAllowedClassTypes, defaultToLast: false });

    const folderNameInput = document.createElement("sp-textfield");
    folderNameInput.setAttribute("size", "s"); // Spectrum small = 24px, matching buttons/inputs
    folderNameInput.setAttribute("value", sanitizeTimestampedFileNameInput(model.baseName || "workflow"));
    folderNameInput.setAttribute("placeholder", "Workflow name");
    folderNameInput.style.flex = "1 1 auto";
    folderNameInput.style.minWidth = "0";
    const deploymentInput = document.createElement("sp-textfield");
    deploymentInput.setAttribute("size", "s"); // Spectrum small = 24px, matching buttons/inputs
    deploymentInput.setAttribute("value", "");
    deploymentInput.setAttribute("placeholder", "Deployment A, Deployment B");
    deploymentInput.style.flex = "1 1 auto";
    deploymentInput.style.minWidth = "0";
    const endpointInput = document.createElement("sp-textfield");
    endpointInput.setAttribute("size", "s"); // Spectrum small = 24px, matching buttons/inputs
    endpointInput.setAttribute("value", "");
    endpointInput.setAttribute("placeholder", "Endpoint A, Endpoint B");
    endpointInput.style.flex = "1 1 auto";
    endpointInput.style.minWidth = "0";
    const localMachineInput = document.createElement("sp-textfield");
    localMachineInput.setAttribute("size", "s"); // Spectrum small = 24px, matching buttons/inputs
    localMachineInput.setAttribute("value", "");
    // Example mixes this computer and a network machine: the list can name any Comfy server.
    localMachineInput.setAttribute("placeholder", "127.0.0.1:8188, 192.168.1.20:8188");
    localMachineInput.style.flex = "1 1 auto";
    localMachineInput.style.minWidth = "0";
    topForm.appendChild(createTopFieldRow("Workflow Name", folderNameInput));

    // Environment compatibility is exported into the generated YAML so Auto Run filtering
    // can treat imported workflows the same way as built-in workflow bundles.
    const environmentSelection = {
        supportsLocal: true,
        supportsCloud: true,
        supportsRunComfy: true,
        supportsRunPod: true
    };
    const environmentWrap = document.createElement("div");
    environmentWrap.className = "fieldGroup server";
    environmentWrap.style.width = "100%";

    const environmentLabel = document.createElement("div");
    environmentLabel.className = "fieldLabel";
    environmentLabel.textContent = "Environments";
    environmentWrap.appendChild(environmentLabel);

    const environmentRows = document.createElement("div");
    environmentRows.className = "importWorkflowEnvironmentOptions";

    const createEnvironmentToggle = (labelText, key) => {
        const row = document.createElement("label");
        row.className = "connectionModeRow";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = Boolean(environmentSelection[key]);
        checkbox.addEventListener("change", () => {
            environmentSelection[key] = Boolean(checkbox.checked);
        });

        const text = document.createElement("span");
        text.className = "connectionModeLabel";
        text.textContent = labelText;

        row.appendChild(checkbox);
        row.appendChild(text);
        environmentRows.appendChild(row);
    };

    createEnvironmentToggle("Comfy Server", "supportsLocal");
    createEnvironmentToggle("Comfy Cloud", "supportsCloud");
    createEnvironmentToggle("RunComfy", "supportsRunComfy");
    createEnvironmentToggle("RunPod", "supportsRunPod");
    environmentWrap.appendChild(environmentRows);

    const environmentRow = document.createElement("div");
    environmentRow.className = "connectionRow importWorkflowTopFieldRow";
    environmentRow.appendChild(environmentWrap);
    topForm.appendChild(environmentRow);
    topForm.appendChild(createTopFieldRow("Inputs", inputControl.control));
    // Sets the "Scale Down Additional Inputs (Faster)" checkbox's default checked state in the
    // generated YAML (scaled_down_additional_inputs_default: true/false — see parseNanoBananaYaml).
    // Bare checkbox row (no outer field label) — createCheckboxRow's own inline caption already
    // carries the text, so wrapping it in createTopFieldRow would show the label twice.
    const scaleDownAdditionalInputsDefaultCheckbox = document.createElement("input");
    scaleDownAdditionalInputsDefaultCheckbox.type = "checkbox";
    scaleDownAdditionalInputsDefaultCheckbox.checked = false;
    const scaleDownAdditionalInputsDefaultLabel = document.createElement("label");
    scaleDownAdditionalInputsDefaultLabel.className = "connectionModeRow importWorkflowTopFieldRow";
    const scaleDownAdditionalInputsDefaultText = document.createElement("span");
    scaleDownAdditionalInputsDefaultText.className = "connectionModeLabel";
    scaleDownAdditionalInputsDefaultText.textContent = "Scale Down Additional Inputs By Default";
    scaleDownAdditionalInputsDefaultLabel.appendChild(scaleDownAdditionalInputsDefaultCheckbox);
    scaleDownAdditionalInputsDefaultLabel.appendChild(scaleDownAdditionalInputsDefaultText);
    topForm.appendChild(scaleDownAdditionalInputsDefaultLabel);
    topForm.appendChild(createTopFieldRow("Outputs", outputControl0.control));
    topForm.appendChild(createTopFieldRow("Output Mask", outputMaskNodeSelect));

    topForm.appendChild(createTopFieldRow("Comfy Servers", localMachineInput));
    topForm.appendChild(createTopFieldRow("RunComfy Deployments", deploymentInput));
    topForm.appendChild(createTopFieldRow("RunPod Endpoints", endpointInput));

    const generalSettingsSubtitle = document.createElement("div");
    generalSettingsSubtitle.className = "settingsSectionTitle";
    generalSettingsSubtitle.textContent = "General Settings";
    generalSettingsSubtitle.style.cssText = "margin-bottom:10px;";
    view.appendChild(generalSettingsSubtitle);

    view.appendChild(topForm);

    // Build select templates once and clone per field.
    const typeSelectTemplate = createWorkflowImportTypeSelect("textbox");
    typeSelectTemplate.style.cssText = "flex:1 1 auto;min-width:0;align-self:flex-start;margin-top:8px;";

    const dataTypeSelectTemplate = document.createElement("select");
    dataTypeSelectTemplate.className = "dynamicInput";
    dataTypeSelectTemplate.style.cssText = "flex:1 1 auto;min-width:0;align-self:flex-start;margin-top:8px;margin-left:4px;";
    for (const dt of ["string", "integer", "float", "boolean"]) {
        const opt = document.createElement("option");
        opt.value = dt;
        opt.textContent = dt;
        dataTypeSelectTemplate.appendChild(opt);
    }

    // Node cards — built into a fragment so only one DOM mutation hits the live view.
    const cards = [];
    const cardsFragment = document.createDocumentFragment();
    for (const node of (Array.isArray(model.nodes) ? model.nodes : [])) {
        if (!String(node.title || "").startsWith("@")) continue;
        const card = document.createElement("div");
        card.className = "actionCard workflowImportCard";
        card.style.cssText = "padding:8px 4px;";
        card.dataset.nodeId = String(node.id);

        const cardTitle = document.createElement("div");
        cardTitle.className = "actionCardTitle";
        cardTitle.textContent = `${node.id}: ${node.title} [${node.classType}]`;
        card.appendChild(cardTitle);

        const fieldsForm = document.createElement("div");
        fieldsForm.style.cssText = "display:flex;flex-direction:column;width:100%;box-sizing:border-box;margin:0;padding:0;";

        const fieldModels = [];
        for (let j = 0; j < (Array.isArray(node.widgets) ? node.widgets.length : 0); j += 1) {
            const widget = node.widgets[j];
            // Subgraph container nodes list their proxied widgets in the same order as their
            // inner-node proxyWidgets property, so position j maps directly to proxyWidgets[j].
            const proxyEntry = Array.isArray(node.proxyWidgets) ? node.proxyWidgets[j] : null;
            const proxyTarget = proxyEntry && proxyEntry.nodeId
                ? { nodeId: `${node.id}:${proxyEntry.nodeId}`, field: proxyEntry.field }
                : null;
            let param;
            try {
                param = buildWorkflowImportParam(widget, j + 1, node.inputs, proxyTarget);
            } catch (error) {
                throw new Error(`Import panel field build failed for node ${String(node?.id || "")} widget ${String(widget?.label || widget?.name || j + 1)}: ${describeError(error)}`);
            }

            const paramTypeLower = String(param.type || "textbox").toLowerCase();
            const extraClass = paramTypeLower === "bigtextbox" ? " dynamicBigTextField"
                : paramTypeLower === "seed" ? " dynamicSeedField"
                : (paramTypeLower === "checkbox" || paramTypeLower === "boolean") ? " dynamicCheckboxField"
                : "";

            const field = document.createElement("div");
            field.className = `dynamicField${extraClass}`;
            field.style.cssText = "display:flex;flex-direction:column;align-items:stretch;width:100%;margin:0;";
            if (j > 0) field.style.marginTop = "8px";

            // Row 1: checkbox + label + custom label textbox
            const useCheckbox = document.createElement("input");
            useCheckbox.type = "checkbox";
            useCheckbox.checked = false;
            useCheckbox.style.cssText = "flex:0 0 auto;align-self:center;margin:0;";
            useCheckbox.dataset.importUseField = "true";

            const labelEl = document.createElement("div");
            labelEl.style.cssText = "flex:1 1 0;min-width:0;align-self:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-left:8px;font-size:11px;color:#cfcfcf;font-weight:600;letter-spacing:0.2px;line-height:1;";
            labelEl.textContent = param.label;
            labelEl.title = param.label;

            // Wrap checkbox + label so they occupy exactly flex:1 — same as typeSelect below
            const checkboxLabelGroup = document.createElement("div");
            checkboxLabelGroup.style.cssText = "flex:1 1 0;width:0;min-width:0;display:flex;flex-direction:row;align-items:center;";
            checkboxLabelGroup.appendChild(useCheckbox);
            checkboxLabelGroup.appendChild(labelEl);

            const customLabelInput = document.createElement("input");
            customLabelInput.type = "text";
            customLabelInput.className = "dynamicInput";
            customLabelInput.placeholder = param.label;
            customLabelInput.value = param.label;
            // flex:1 1 0 matches dataTypeSelect so it sits directly above it
            customLabelInput.style.cssText = "flex:1 1 0;width:0;min-width:0;box-sizing:border-box;margin:0;";

            const headerLeftSpacer = document.createElement("div");
            headerLeftSpacer.style.cssText = "width:4px;min-width:4px;flex-shrink:0;";
            const headerRightSpacer = document.createElement("div");
            headerRightSpacer.style.cssText = "width:4px;min-width:4px;flex-shrink:0;";

            const headerRow = document.createElement("div");
            headerRow.style.cssText = "display:flex;flex-direction:row;align-items:center;width:100%;";
            headerRow.appendChild(headerLeftSpacer);
            headerRow.appendChild(checkboxLabelGroup);
            headerRow.appendChild(customLabelInput);
            headerRow.appendChild(headerRightSpacer);

            // Row 2: type dropdown + data type dropdown, full width, with 8px top margin and between them
            const typeSelect = typeSelectTemplate.cloneNode(true);
            const normalizedType = String(param.type || "textbox").toLowerCase();
            typeSelect.value = typeSelect.querySelector(`option[value="${normalizedType}"]`) ? normalizedType : "textbox";
            typeSelect.style.cssText = "flex:1 1 0;width:0;min-width:0;height:24px;min-height:24px;margin:0;";

            const dataTypeSelect = dataTypeSelectTemplate.cloneNode(true);
            const normalizedDataType = String(param.data_type || "string").toLowerCase();
            dataTypeSelect.value = dataTypeSelect.querySelector(`option[value="${normalizedDataType}"]`) ? normalizedDataType : "string";
            dataTypeSelect.style.cssText = "flex:1 1 0;width:0;min-width:0;height:24px;min-height:24px;margin:0;";

            const controlLeftSpacer = document.createElement("div");
            controlLeftSpacer.style.cssText = "width:4px;min-width:4px;flex-shrink:0;";
            const controlRightSpacer = document.createElement("div");
            controlRightSpacer.style.cssText = "width:4px;min-width:4px;flex-shrink:0;";

            const controlRow = document.createElement("div");
            controlRow.style.cssText = "display:flex;flex-direction:row;align-items:center;width:100%;margin-top:4px;";
            controlRow.appendChild(controlLeftSpacer);
            controlRow.appendChild(typeSelect);
            controlRow.appendChild(dataTypeSelect);
            controlRow.appendChild(controlRightSpacer);

            field.appendChild(headerRow);
            field.appendChild(controlRow);
            fieldsForm.appendChild(field);

            fieldModels.push({ param, useCheckbox, customLabelInput, fieldRow: field, typeSelect, dataTypeSelect });
        }

        card.__quickaiFieldModels = fieldModels;
        card.appendChild(fieldsForm);
        cardsFragment.appendChild(card);
        cards.push(card);
    }

    const nodesSubtitle = document.createElement("div");
    nodesSubtitle.className = "settingsSectionTitle";
    nodesSubtitle.textContent = "Nodes";
    nodesSubtitle.style.cssText = "margin-bottom:6px;";
    view.appendChild(nodesSubtitle);

    const nodesHint = document.createElement("div");
    nodesHint.style.cssText = "font-size:11px;color:#9f9f9f;margin-bottom:10px;";
    nodesHint.textContent = "Only nodes starting with '@' are shown.";
    view.appendChild(nodesHint);

    view.appendChild(cardsFragment);

    // Status sits just above the footer — only visible when there is content
    status.style.marginTop = "12px";
    view.appendChild(status);

    // Footer — same flex-row pattern as Settings / Open ComfyUI button row. Spaced like the main
    // panel's bottom buttons (Terminal): 8px below the last card and 8px above the footer bar
    // (the view's 8px bottom padding, see #importWorkflowsView, so no bottom margin here).
    const footer = document.createElement("div");
    footer.style.marginTop = "8px";
    footer.style.marginBottom = "0";
    footer.style.display = "flex";
    footer.style.flexDirection = "row";
    footer.style.gap = "0";
    footer.style.alignItems = "flex-start";

    const cancelCol = document.createElement("div");
    cancelCol.style.flex = "1 1 0";
    cancelCol.style.minWidth = "0";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "qc-btn";
    cancelBtn.style.width = "100%";
    cancelBtn.style.margin = "0";
    cancelBtn.textContent = "Cancel";
    cancelCol.appendChild(cancelBtn);

    const saveCol = document.createElement("div");
    saveCol.style.flex = "1 1 0";
    saveCol.style.minWidth = "0";
    saveCol.style.marginLeft = "8px";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "qc-btn";
    saveBtn.style.width = "100%";
    saveBtn.style.margin = "0";
    saveBtn.textContent = "Save";
    saveCol.appendChild(saveBtn);

    footer.appendChild(cancelCol);
    footer.appendChild(saveCol);
    view.appendChild(footer);

    // Version label — mirrors the main panel footer version display
    const importVersionRow = document.createElement("div");
    importVersionRow.className = "pluginVersionRow";
    const importVersionLabel = document.createElement("span");
    importVersionLabel.className = "pluginVersionLabel";
    renderPluginFooterLabel(importVersionLabel);
    importVersionRow.appendChild(importVersionLabel);
    view.appendChild(importVersionRow);
    // This footer is created on demand, after the startup update check may have already run.
    renderPluginUpdateNotices();

    view.__quickaiImportState = {
        preferredSaveFolderEntry,
        saveFolderEntry: preferredSaveFolderEntry || null,
        inputRows,
        scaleDownAdditionalInputsDefaultCheckbox,
        getOutputNodeSelects,
        outputMaskNodeSelect,
        folderNameInput,
        deploymentInput,
        endpointInput,
        localMachineInput,
        environmentSelection,
        saveBtn,
        cancelBtn,
        cards,
        status
    };
    return view;
}

// Reads the current dialog selections into a save-ready payload.
function collectWorkflowImportDialogSelection(dialog) {
    const state = dialog?.__quickaiImportState || null;
    if (!state) return null;
    const nodes = [];
    const fieldsByNodeId = {};
    const cards = Array.from(dialog.querySelectorAll(".workflowImportCard"));
    const seenNodeIds = new Set();
    for (const card of cards) {
        const cardNodeId = String(card.getAttribute("data-node-id") || "").trim();
        const fieldModels = []
            .concat(Array.isArray(card.__quickaiInputModels) ? card.__quickaiInputModels : [])
            .concat(Array.isArray(card.__quickaiFieldModels) ? card.__quickaiFieldModels : []);
        for (const fieldModel of fieldModels) {
            if (!fieldModel?.useCheckbox?.checked) continue;
            const param = fieldModel.param || {};
            // Subgraph-proxied fields carry their own real node_id (e.g. "627:625") — the card's
            // own node_id (e.g. "627") never resolves in the workflow API JSON for those fields.
            const effectiveNodeId = String(param.node_id || "").trim() || cardNodeId;
            if (!effectiveNodeId) continue;
            // Default value comes from the parsed metadata (API workflow), not a user-editable control.
            const value = param.default ?? "";
            const field = {
                key: param.key,
                type: String(fieldModel?.typeSelect?.value || param.type || "textbox").trim().toLowerCase(),
                data_type: String(fieldModel?.dataTypeSelect?.value || param.data_type || "string").trim().toLowerCase(),
                label: String(fieldModel?.customLabelInput?.value || param.label || "").trim() || param.label,
                value,
                options: Array.isArray(param.options) ? param.options.slice() : [],
                sourceKind: String(fieldModel?.param?.sourceKind || "").trim().toLowerCase(),
                min: param.min ?? "",
                max: param.max ?? ""
            };
            if (!seenNodeIds.has(effectiveNodeId)) {
                seenNodeIds.add(effectiveNodeId);
                nodes.push({ id: effectiveNodeId });
                fieldsByNodeId[effectiveNodeId] = [];
            }
            fieldsByNodeId[effectiveNodeId].push(field);
        }
    }

    return {
        workflowName: String(state.workflowNameField?.value || state.folderNameInput?.value || "").trim(),
        saveFolderEntry: state.saveFolderEntry || null,
        inputs: (Array.isArray(state.inputRows) ? state.inputRows : [])
            .map((row) => {
                const nodeId = String(row?.select?.value || "").trim();
                if (!nodeId) return null;
                const selectedOption = row.select.selectedOptions ? row.select.selectedOptions[0] : row.select.options[row.select.selectedIndex];
                const nodeTitle = String(selectedOption?.dataset?.nodeTitle || "").trim();
                const customLabel = String(row?.labelInput?.value || "").trim();
                return {
                    nodeId,
                    // Always persist a label (default-filled node title or user-typed value) —
                    // the node's title isn't available anymore once this is saved to YAML, so
                    // the runtime attach UI needs this to have any display name at all.
                    label: customLabel || nodeTitle,
                    required: Boolean(row?.requiredCheckbox?.checked)
                };
            })
            .filter(Boolean),
        scaleDownAdditionalInputsDefault: state.scaleDownAdditionalInputsDefaultCheckbox
            ? Boolean(state.scaleDownAdditionalInputsDefaultCheckbox.checked)
            : true,
        outputNodeIds: (typeof state.getOutputNodeSelects === "function" ? state.getOutputNodeSelects() : [])
            .map((s) => String(s?.value || "").trim()).filter(Boolean),
        outputMaskNodeId: String(state.outputMaskNodeSelect?.value || "").trim(),
        deploymentText: String(state.deploymentInput?.value || "").trim(),
        endpointText: String(state.endpointInput?.value || "").trim(),
        localMachineText: String(state.localMachineInput?.value || "").trim(),
        environmentSelection: {
            supportsLocal: Boolean(state.environmentSelection?.supportsLocal),
            supportsCloud: Boolean(state.environmentSelection?.supportsCloud),
            supportsRunComfy: Boolean(state.environmentSelection?.supportsRunComfy),
            supportsRunPod: Boolean(state.environmentSelection?.supportsRunPod)
        },
        nodes,
        fieldsByNodeId
    };
}

// Resolves the parent folder of a UXP file entry.
// UXP's "request" permission only grants access to the picked file, not its parent,
// so getParent() and getEntryWithUrl() both fail. We try them anyway for future
// UXP versions that may lift this restriction, then return null so the caller can fall back.
async function getParentFolderOfEntry(fileEntry) {
    if (!fileEntry) return null;
    if (typeof fileEntry.getParent === "function") {
        try {
            const parent = await fileEntry.getParent();
            if (parent && parent.isFolder) return parent;
        } catch (_e) {}
    }
    const nativePath = String(fileEntry.nativePath || "").trim();
    if (!nativePath) return null;
    const lastSep = Math.max(nativePath.lastIndexOf("/"), nativePath.lastIndexOf("\\"));
    if (lastSep <= 0) return null;
    const dirPath = nativePath.substring(0, lastSep);
    if (typeof storage.localFileSystem.getEntryWithUrl === "function") {
        const urlCandidates = [];
        if (dirPath.startsWith("\\\\") || dirPath.startsWith("//")) {
            // Windows UNC / WSL path: \\server\share\path → file://server/share/path
            urlCandidates.push("file://" + dirPath.replace(/\\/g, "/").replace(/^\/+/, ""));
        } else if (/^[A-Za-z]:/.test(dirPath)) {
            // Windows drive path: C:\path → file:///C:/path
            urlCandidates.push("file:///" + dirPath.replace(/\\/g, "/"));
        } else {
            urlCandidates.push("file://" + dirPath);
        }
        for (const url of urlCandidates) {
            try {
                const entry = await storage.localFileSystem.getEntryWithUrl(url);
                if (entry && entry.isFolder) return entry;
            } catch (_e) {}
        }
    }
    return null;
}

// Opens a folder picker rooted at the preferred workflow path when possible.
async function pickWorkflowImportSaveFolder(preferredFolderEntry = null) {
    const options = preferredFolderEntry ? { initialLocation: preferredFolderEntry } : {};
    try {
        return await storage.localFileSystem.getFolder(options);
    } catch (_e) {
        return await storage.localFileSystem.getFolder();
    }
}

// Bundle extensions accepted when importing: the current .quickai plus the legacy .quickcomfy
// (bundles exported before the QuickComfy -> QuickAI rename are the same ZIP format).
const QUICKAI_BUNDLE_TYPES = ["quickai", "quickcomfy"];

// Prompts the user to pick a .quickai (or legacy .quickcomfy) bundle file.
async function pickQuickAIFile(preferredFolderEntry = null) {
    const options = preferredFolderEntry
        ? { types: QUICKAI_BUNDLE_TYPES, initialLocation: preferredFolderEntry }
        : { types: QUICKAI_BUNDLE_TYPES };
    try {
        return await storage.localFileSystem.getFileForOpening(options);
    } catch (_e) {
        return await storage.localFileSystem.getFileForOpening({ types: QUICKAI_BUNDLE_TYPES });
    }
}

// Reads a uint16 little-endian from a DataView.
function _zipU16(view, offset) { return view.getUint16(offset, true); }
// Reads a uint32 little-endian from a DataView.
function _zipU32(view, offset) { return view.getUint32(offset, true); }

// Decodes a UTF-8 byte slice into a JS string without relying on TextDecoder (unavailable in UXP).
function _decodeUtf8(bytes, start, end) {
    let str = "";
    let i = start;
    const limit = (end !== undefined) ? end : bytes.length;
    while (i < limit) {
        const b = bytes[i];
        if (b < 0x80) { str += String.fromCharCode(b); i++; }
        else if ((b & 0xE0) === 0xC0) { str += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F)); i += 2; }
        else if ((b & 0xF0) === 0xE0) { str += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F)); i += 3; }
        else { const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F); const adj = cp - 0x10000; str += String.fromCharCode(0xD800 + (adj >> 10), 0xDC00 + (adj & 0x3FF)); i += 4; }
    }
    return str;
}

// Bit reader over a byte array, LSB-first — the bit order DEFLATE (RFC 1951) uses.
function _InflateBitReader(bytes) {
    this.bytes = bytes;
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCount = 0;
}
_InflateBitReader.prototype.readBits = function (count) {
    while (this.bitCount < count) {
        this.bitBuf |= (this.bytes[this.pos++] || 0) << this.bitCount;
        this.bitCount += 8;
    }
    const value = this.bitBuf & ((1 << count) - 1);
    this.bitBuf >>>= count;
    this.bitCount -= count;
    return value;
};
_InflateBitReader.prototype.alignToByte = function () {
    this.bitBuf = 0;
    this.bitCount = 0;
};

// Builds a canonical Huffman decode table from an array of per-symbol code lengths.
// Returns { counts, symbols } used by _inflateDecodeSymbol (the standard puff.c-style layout).
function _inflateBuildHuffman(lengths) {
    const maxBits = 15;
    const counts = new Array(maxBits + 1).fill(0);
    for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
    counts[0] = 0;
    const offsets = new Array(maxBits + 1).fill(0);
    for (let i = 1; i <= maxBits; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
    const symbols = new Array(lengths.length).fill(0);
    for (let i = 0; i < lengths.length; i++) {
        if (lengths[i] !== 0) symbols[offsets[lengths[i]]++] = i;
    }
    return { counts, symbols };
}

function _inflateDecodeSymbol(reader, table) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 15; len++) {
        code |= reader.readBits(1);
        const count = table.counts[len];
        if (code - first < count) return table.symbols[index + (code - first)];
        index += count;
        first += count;
        first <<= 1;
        code <<= 1;
    }
    throw new Error("Invalid DEFLATE stream (Huffman code not found).");
}

const _INFLATE_LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const _INFLATE_LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const _INFLATE_DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const _INFLATE_DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const _INFLATE_CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Decompresses one raw DEFLATE block stream (RFC 1951, no zlib/gzip header — ZIP method 8
// stores entries this way) into a Uint8Array. Handles stored, fixed-Huffman, and
// dynamic-Huffman blocks. Written from scratch (no TextDecoder/DecompressionStream
// dependency) to match this file's existing policy of not assuming host Web APIs beyond
// what's already verified available.
function _inflateRaw(compressedBytes) {
    const reader = new _InflateBitReader(compressedBytes);
    const out = [];
    let fixedLiteralTable = null;
    let fixedDistanceTable = null;
    const buildFixedTables = () => {
        if (fixedLiteralTable) return;
        const litLengths = new Array(288);
        for (let i = 0; i < 144; i++) litLengths[i] = 8;
        for (let i = 144; i < 256; i++) litLengths[i] = 9;
        for (let i = 256; i < 280; i++) litLengths[i] = 7;
        for (let i = 280; i < 288; i++) litLengths[i] = 8;
        fixedLiteralTable = _inflateBuildHuffman(litLengths);
        fixedDistanceTable = _inflateBuildHuffman(new Array(30).fill(5));
    };

    let isFinal = 0;
    do {
        isFinal = reader.readBits(1);
        const blockType = reader.readBits(2);

        if (blockType === 0) {
            // Stored (uncompressed) block.
            reader.alignToByte();
            const len = (reader.bytes[reader.pos] | (reader.bytes[reader.pos + 1] << 8)) & 0xFFFF;
            reader.pos += 4; // skip LEN + NLEN (one's complement, unused here)
            for (let i = 0; i < len; i++) out.push(reader.bytes[reader.pos++]);
            continue;
        }

        let literalTable, distanceTable;
        if (blockType === 1) {
            buildFixedTables();
            literalTable = fixedLiteralTable;
            distanceTable = fixedDistanceTable;
        } else if (blockType === 2) {
            const hlit = reader.readBits(5) + 257;
            const hdist = reader.readBits(5) + 1;
            const hclen = reader.readBits(4) + 4;
            const codeLengthLengths = new Array(19).fill(0);
            for (let i = 0; i < hclen; i++) codeLengthLengths[_INFLATE_CODE_LENGTH_ORDER[i]] = reader.readBits(3);
            const codeLengthTable = _inflateBuildHuffman(codeLengthLengths);

            const allLengths = new Array(hlit + hdist).fill(0);
            let i = 0;
            while (i < allLengths.length) {
                const sym = _inflateDecodeSymbol(reader, codeLengthTable);
                if (sym < 16) {
                    allLengths[i++] = sym;
                } else if (sym === 16) {
                    const repeat = reader.readBits(2) + 3;
                    const prev = i > 0 ? allLengths[i - 1] : 0;
                    for (let r = 0; r < repeat; r++) allLengths[i++] = prev;
                } else if (sym === 17) {
                    const repeat = reader.readBits(3) + 3;
                    for (let r = 0; r < repeat; r++) allLengths[i++] = 0;
                } else {
                    const repeat = reader.readBits(7) + 11;
                    for (let r = 0; r < repeat; r++) allLengths[i++] = 0;
                }
            }
            literalTable = _inflateBuildHuffman(allLengths.slice(0, hlit));
            distanceTable = _inflateBuildHuffman(allLengths.slice(hlit));
        } else {
            throw new Error("Invalid DEFLATE block type.");
        }

        for (;;) {
            const sym = _inflateDecodeSymbol(reader, literalTable);
            if (sym < 256) {
                out.push(sym);
            } else if (sym === 256) {
                break;
            } else {
                const lenIndex = sym - 257;
                const length = _INFLATE_LENGTH_BASE[lenIndex] + reader.readBits(_INFLATE_LENGTH_EXTRA[lenIndex]);
                const distSym = _inflateDecodeSymbol(reader, distanceTable);
                const distance = _INFLATE_DIST_BASE[distSym] + reader.readBits(_INFLATE_DIST_EXTRA[distSym]);
                const start = out.length - distance;
                for (let k = 0; k < length; k++) out.push(out[start + k]);
            }
        }
    } while (!isFinal);

    return new Uint8Array(out);
}

// Parses a .quickai (ZIP) ArrayBuffer and returns a Map of { filename -> string }.
// Supports both STORE (method 0) and DEFLATE (method 8) entries — larger entries (like a
// workflow's _UI.json, which carries full node/layout data) are commonly DEFLATE-compressed
// by whatever tool produced the .quickai bundle even when smaller entries are stored raw.
function parseQuickAIZip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const view = new DataView(arrayBuffer);
    const files = new Map();

    // Locate the End of Central Directory record by scanning backwards for its signature.
    const EOCD_SIG = 0x06054b50;
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
        if (_zipU32(view, i) === EOCD_SIG) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error("Not a valid .quickai file (no EOCD signature found).");

    const entryCount = _zipU16(view, eocdOffset + 8);
    let cdOffset = _zipU32(view, eocdOffset + 16);

    // Walk the Central Directory to collect file names and their local header offsets.
    const CD_SIG = 0x02014b50;
    for (let i = 0; i < entryCount; i++) {
        if (_zipU32(view, cdOffset) !== CD_SIG) break;
        const nameLen = _zipU16(view, cdOffset + 28);
        const extraLen = _zipU16(view, cdOffset + 30);
        const commentLen = _zipU16(view, cdOffset + 32);
        const localOffset = _zipU32(view, cdOffset + 42);
        const name = _decodeUtf8(bytes, cdOffset + 46, cdOffset + 46 + nameLen);
        cdOffset += 46 + nameLen + extraLen + commentLen;

        // Read the actual file data from the local file header.
        const LFH_SIG = 0x04034b50;
        if (_zipU32(view, localOffset) !== LFH_SIG) continue;
        const lNameLen = _zipU16(view, localOffset + 26);
        const lExtraLen = _zipU16(view, localOffset + 28);
        const dataOffset = localOffset + 30 + lNameLen + lExtraLen;
        const compressedSize = _zipU32(view, localOffset + 18);
        const method = _zipU16(view, localOffset + 8);
        if (method === 0) {
            const text = _decodeUtf8(bytes, dataOffset, dataOffset + compressedSize);
            files.set(name, text);
        } else if (method === 8) {
            const compressedSlice = bytes.subarray(dataOffset, dataOffset + compressedSize);
            const inflated = _inflateRaw(compressedSlice);
            files.set(name, _decodeUtf8(inflated, 0, inflated.length));
        }
        // Other compression methods (BZIP2, LZMA, etc.) aren't produced by standard zip
        // writers for this use case — skip rather than fail the whole bundle.
    }
    return files;
}

// Reads a .quickai file entry and returns the bundle model { baseName, metadataText, apiText, uiText }.
async function readQuickAIBundle(fileEntry) {
    const arrayBuffer = await fileEntry.read({ format: storage.formats.binary });
    const files = parseQuickAIZip(arrayBuffer);

    // Discover the actual base name from the zip contents rather than the zip filename —
    // the zip may have been renamed (e.g. "a(1).quickai" containing "a.json").
    // Look for the metadata file first since its suffix is unambiguous.
    let baseName = null;
    for (const name of files.keys()) {
        const m = name.match(/^(.+)_metadata\.txt$/i);
        if (m) { baseName = m[1]; break; }
    }
    // Fall back to the first .json that isn't a _UI.json.
    if (!baseName) {
        for (const name of files.keys()) {
            if (/\.json$/i.test(name) && !/_UI\.json$/i.test(name)) {
                baseName = name.replace(/\.json$/i, "");
                break;
            }
        }
    }
    // Last resort: strip extension from the zip filename.
    if (!baseName) {
        baseName = String(fileEntry.name || "workflow").replace(/\.(quickai|quickcomfy)$/i, "").trim() || "workflow";
    }

    const apiFileName = `${baseName}.json`;
    const uiFileName = `${baseName}_UI.json`;
    const metadataFileName = `${baseName}_metadata.txt`;

    const apiText = files.get(apiFileName) || "";
    const uiText = files.get(uiFileName) || "";
    const metadataText = files.get(metadataFileName) || "";

    if (!apiText && !uiText) throw new Error(`Missing workflow JSON files inside "${fileEntry.name}". Expected ${apiFileName} and ${uiFileName}.`);
    if (!metadataText) throw new Error(`Missing metadata file inside "${fileEntry.name}". Expected ${metadataFileName}.`);

    return { baseName, apiFileName, uiFileName, metadataFileName, apiText, uiText, metadataText };
}

// Blanks the leftover test/example filename on the designated Input/Input Mask LoadImage
// nodes before saving the workflow bundle. Auto Run always overwrites these nodes' "image"
// field with the uploaded Photoshop snapshot at runtime (see buildAutoRunPrompt), so keeping
// whatever test image happened to be loaded in Comfy when the workflow was exported only
// leaves a stale, unintentional filename sitting in the saved template.
function cleanWorkflowImportApiText(apiText, selection) {
    const rawText = String(apiText || "");
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch (_e) {
        return rawText;
    }
    if (!parsed || typeof parsed !== "object") return rawText;

    const clearImageField = (nodeId) => {
        const normalizedId = String(nodeId || "").trim();
        if (!normalizedId) return;
        const node = parsed[normalizedId];
        const inputs = node && typeof node === "object" ? node.inputs : null;
        if (!inputs || typeof inputs !== "object") return;
        // inputName isn't stored in the YAML — resolve it from the node's own class_type,
        // same as everywhere else this is needed (see inferLoaderInputFieldName).
        const inputName = inferLoaderInputFieldName(node.class_type);
        if (Object.prototype.hasOwnProperty.call(inputs, inputName)) inputs[inputName] = "";
        // Some loader classes also carry a read-only preview/derived field that embeds the same
        // stale filename (LoadVideo's "video-preview", LoadAudio's "audioUI") — blank those too.
        for (const previewFieldName of getWorkflowLoaderPreviewFieldNames(node.class_type)) {
            if (Object.prototype.hasOwnProperty.call(inputs, previewFieldName)) inputs[previewFieldName] = "";
        }
    };
    const inputSlots = Array.isArray(selection?.inputs) ? selection.inputs : [];
    for (const slot of inputSlots) clearImageField(slot?.nodeId);

    try {
        return JSON.stringify(parsed, null, 2);
    } catch (_e) {
        return rawText;
    }
}

// Mirrors cleanWorkflowImportApiText for the companion _UI.json — the graph-view file ComfyUI
// itself reads to draw each node's widgets. The API json's upload field is the one Auto Run
// actually overwrites at runtime, but this file's widgets_values still shows whatever filename
// was loaded in Comfy at export time (e.g. "01_Lounge.jpg"), so without this the graph visually
// looks like it still has an image/video/audio attached even after the API side was cleared.
// Every recognized loader node type (see isInputLoaderClassType) stores its filename as the
// first widget value, so blanking widgets_values[0] is sufficient across LoadImage/LoadVideo/
// LoadAudio/LoadMask.
function cleanWorkflowImportUiText(uiText, selection) {
    const rawText = String(uiText || "");
    if (!rawText) return rawText;
    let parsed = null;
    try {
        parsed = JSON.parse(rawText);
    } catch (_e) {
        return rawText;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.nodes)) return rawText;

    const inputSlots = Array.isArray(selection?.inputs) ? selection.inputs : [];
    const targetNodeIds = new Set(inputSlots.map((slot) => String(slot?.nodeId || "").trim()).filter(Boolean));
    if (targetNodeIds.size === 0) return rawText;

    for (const node of parsed.nodes) {
        const nodeId = String(node?.id ?? "").trim();
        if (!targetNodeIds.has(nodeId)) continue;
        if (!isInputLoaderClassType(node?.type)) continue;
        if (Array.isArray(node.widgets_values) && typeof node.widgets_values[0] === "string") {
            node.widgets_values[0] = "";
        }
    }

    try {
        return JSON.stringify(parsed, null, 2);
    } catch (_e) {
        return rawText;
    }
}

// Returns the subfolder `name` inside `parentFolder` if it already exists, otherwise null.
// (getEntry throws when the entry does not exist.)
async function getExistingSubfolder(parentFolder, name) {
    try {
        const entry = await parentFolder.getEntry(name);
        return entry && entry.isFolder ? entry : null;
    } catch (_e) {
        return null;
    }
}

// Lists which of a workflow bundle's files (<name>.json, <name>_UI.json, <name>.yaml — the names
// saveWorkflowImportBundle writes) already exist in `folder`.
async function findExistingWorkflowBundleFiles(folder, workflowName) {
    const baseName = sanitizeTimestampedFileNameInput(workflowName || "workflow");
    const existing = [];
    for (const fileName of [`${baseName}.json`, `${baseName}_UI.json`, `${baseName}.yaml`]) {
        try {
            const entry = await folder.getEntry(fileName);
            if (entry && entry.isFile) existing.push(fileName);
        } catch (_e) {
            // Not there.
        }
    }
    return existing;
}

// Saves the imported workflow assets into the selected destination folder.
async function saveWorkflowImportBundle(model, selection) {
    if (!selection?.saveFolderEntry) {
        throw new Error("Choose a save folder before exporting the imported workflow.");
    }
    const safeBaseName = sanitizeTimestampedFileNameInput(selection.workflowName || model.baseName || "workflow");
    log(`Import Workflows: saving bundle as ${safeBaseName}.json / ${safeBaseName}_UI.json / ${safeBaseName}.yaml.`);

    const apiFile = await selection.saveFolderEntry.createFile(`${safeBaseName}.json`, { overwrite: true });
    const apiOut = String(cleanWorkflowImportApiText(model.apiText, selection) ?? "");
    log(`Import Workflows: writing ${safeBaseName}.json (${apiOut.length} chars).`);
    await apiFile.write(apiOut);

    // UXP's entry.write() throws "data cannot be null" for an empty string, and some source
    // bundles genuinely have no UI JSON content — skip creating this optional file rather
    // than writing an empty one. Nothing downstream requires _UI.json to exist.
    const uiOut = String(cleanWorkflowImportUiText(model.uiText, selection) ?? "");
    if (uiOut) {
        const uiFile = await selection.saveFolderEntry.createFile(`${safeBaseName}_UI.json`, { overwrite: true });
        log(`Import Workflows: writing ${safeBaseName}_UI.json (${uiOut.length} chars).`);
        await uiFile.write(uiOut);
    } else {
        log(`Import Workflows: skipping ${safeBaseName}_UI.json (no UI JSON content in source bundle).`);
    }

    const yamlFile = await selection.saveFolderEntry.createFile(`${safeBaseName}.yaml`, { overwrite: true });
    const yamlOut = String(buildWorkflowImportYaml(model, selection) ?? "");
    log(`Import Workflows: writing ${safeBaseName}.yaml (${yamlOut.length} chars).`);
    await yamlFile.write(yamlOut);

    return { baseName: safeBaseName, folderName: getEntryDisplayPath(selection.saveFolderEntry) || "" };
}

// Strips a metadata suffix from an imported filename so the workflow base name is reusable.
function deriveWorkflowImportBaseName(fileName) {
    const text = String(fileName || "").trim();
    if (!text) return "";
    return text
        .replace(/_metadata(?:\s*\(\d+\))?\.txt$/i, "")
        .replace(/\.txt$/i, "")
        .trim();
}

// Opens the import editor, then saves json/yaml outputs after the user confirms selections.
async function runWorkflowImportAction() {
    try {
        // Defensively close the recent-server/port popups before the native OS file
        // picker opens below — that picker is the one thing this flow does that no
        // other panel does, and it can leave those popups in a stale/misplaced state
        // once the panel regains focus.
        hideServerRecentList();
        hidePortRecentList();
        const preferredRoot = await getCustomWorkflowsFolderEntry().catch(() => null);
        const sourceFile = await pickQuickAIFile(preferredRoot || null);
        if (!sourceFile) return;
        log(`Import Workflows: selected file ${String(sourceFile.name || "(unknown)")}.`);

        const bundle = await readQuickAIBundle(sourceFile);
        log(`Import Workflows: read ${bundle.apiFileName}, ${bundle.uiFileName}, ${bundle.metadataFileName}.`);

        const { baseName, apiFileName, uiFileName, metadataFileName, apiText, uiText, metadataText } = bundle;

        const nodes = parseWorkflowImportMetadataText(metadataText);
        if (nodes.length < 1) {
            throw new Error("The selected file does not contain any nodes.");
        }
        log(`Import Workflows: parsed ${nodes.length} node(s) from metadata.`);

        const model = {
            sourcePath: String(sourceFile.name || ""),
            baseName,
            metadataFileName,
            apiFileName,
            uiFileName,
            metadataText,
            apiText,
            uiText,
            nodes
        };

        let view;
        try {
            view = buildWorkflowImportPanelView(model, preferredRoot || null);
        } catch (error) {
            throw new Error(`Import view build failed: ${describeError(error)}${error?.stack ? `\n${error.stack}` : ""}`);
        }

        dismissFloatingBoxes();
        const mainWrapper = document.querySelector(".wrapper");
        if (mainWrapper) mainWrapper.style.display = "none";
        view.style.display = "block";
        view.style.height = "";
        view.style.minHeight = "";
        view.style.overflow = "";
        log("Import Workflows: panel view shown.");
        await yieldToUiTurn();

        await new Promise((resolve) => {
            let settled = false;
            const closeView = (result) => {
                if (settled) return;
                settled = true;
                dismissFloatingBoxes();
                // Explicitly collapse dimensions so UXP doesn't let min-height push .wrapper down.
                view.style.display = "none";
                view.style.height = "0";
                view.style.minHeight = "0";
                view.style.overflow = "hidden";
                const mainWrapper = document.querySelector(".wrapper");
                if (mainWrapper) {
                    mainWrapper.style.display = "";
                    resetPanelScroll(mainWrapper);
                }
                hideServerRecentList();
                hidePortRecentList();
                // A reload isn't needed to pick up a newly-saved workflow — just
                // refresh the dropdown so it appears without losing in-memory
                // Auto Run job tracking the way a full reload would.
                if (result) {
                    refreshAutoRunWorkflowList({ preserveSelection: true }).catch((error) => {
                        log(`Generate workflow refresh error: ${describeError(error)}`);
                    });
                }
                resolve(result);
            };

            const state = view.__quickaiImportState;
            const saveBtn = state?.saveBtn;
            const cancelBtn = state?.cancelBtn;
            const status = state?.status;

            const setStatus = (message, isError = false) => {
                if (!status) return;
                status.textContent = message;
                status.style.color = isError ? "#ef7d7d" : "#9f9f9f";
                status.style.display = message ? "block" : "none";
            };

            if (cancelBtn) {
                cancelBtn.addEventListener("click", () => closeView(null));
            }
            if (saveBtn) {
                saveBtn.addEventListener("click", async () => {
                    try {
                        saveBtn.disabled = true;
                        setStatus("");

                        const rawFolderName = String(state?.folderNameInput?.value || "").trim();
                        const folderName = sanitizeTimestampedFileNameInput(rawFolderName || model.baseName || "workflow");
                        if (!folderName) {
                            saveBtn.disabled = false;
                            setStatus("Enter a folder name before saving.", true);
                            return;
                        }

                        // User picks the parent location; the plugin creates the named subfolder inside it.
                        const parentFolder = await pickWorkflowImportSaveFolder(state.preferredSaveFolderEntry || preferredRoot || null);
                        if (!parentFolder || !parentFolder.isFolder) {
                            saveBtn.disabled = false;
                            return;
                        }

                        // A folder with this name may already hold a workflow saved earlier. Its
                        // files would be silently overwritten (they are written with overwrite:
                        // true), so ask first; an existing folder without those files is reused.
                        let destFolder = null;
                        const existingFolder = await getExistingSubfolder(parentFolder, folderName);
                        if (existingFolder) {
                            const existingFiles = await findExistingWorkflowBundleFiles(existingFolder, folderName);
                            if (existingFiles.length > 0) {
                                const replace = await showPanelConfirm(
                                    `A workflow named "${folderName}" already exists in this folder. Replace it?`
                                );
                                if (!replace) {
                                    saveBtn.disabled = false;
                                    setStatus("Save cancelled; the existing workflow was kept.");
                                    return;
                                }
                                log(`Import Workflows: replacing ${existingFiles.join(", ")} in "${folderName}".`);
                            }
                            destFolder = existingFolder;
                        } else {
                            destFolder = await parentFolder.createFolder(folderName);
                        }
                        state.saveFolderEntry = destFolder;

                        const selection = collectWorkflowImportDialogSelection(view);
                        if (!selection) throw new Error("Import selection could not be read.");
                        selection.workflowName = folderName;
                        log(`Import Workflows: saving ${selection.nodes.length} node(s) into folder "${folderName}".`);
                        const result = await saveWorkflowImportBundle(model, selection);
                        log(`Import Workflows: saved ${result.baseName} into ${result.folderName || folderName}.`);
                        setStatus(`Saved into "${folderName}".`);
                        closeView(result);
                    } catch (error) {
                        const message = describeError(error);
                        log(`Import Workflows error: ${message}`);
                        setStatus(`Save failed: ${message}`, true);
                        saveBtn.disabled = false;
                    }
                });
            }
        });
    } catch (error) {
        const message = describeError(error);
        try {
            setTerminalVisible(true);
        } catch (_e) {}
        if (message && typeof alert === "function") {
            alert(message);
        }
        log(`Import Workflows error: ${message}`);
        if (error && error.stack) {
            log(`Import Workflows stack: ${String(error.stack)}`);
        }
    }
}

// Resolves a human-readable path for a UXP folder entry when available.
function getEntryDisplayPath(entry) {
    if (!entry || typeof entry !== "object") return "";
    if (typeof entry.nativePath === "string" && entry.nativePath.trim()) return entry.nativePath.trim();
    if (typeof entry.name === "string" && entry.name.trim()) return entry.name.trim();
    return "";
}

// Yields one UI turn so modal dialogs are not opened in the same stack frame as the file picker.
async function yieldToUiTurn() {
    await new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => resolve());
        } else {
            setTimeout(resolve, 0);
        }
    });
}

// Normalizes filenames so metadata, API, and UI exports can be matched even if the host adds copy suffixes.
function normalizeWorkflowImportFileStem(fileName) {
    return String(fileName || "")
        .replace(/\.[^.]+$/, "")
        .replace(/\s*\(\d+\)$/i, "")
        .trim()
        .toLowerCase();
}

// Finds a sibling file in a folder entry using exact or copy-suffixed matching.
async function findWorkflowImportSiblingEntry(folderEntry, siblingFileName) {
    const siblingName = String(siblingFileName || "").trim();
    if (!folderEntry || typeof folderEntry.getEntries !== "function") return null;
    if (!siblingName) return null;

    const entries = await folderEntry.getEntries();
    const exactMatch = entries.find((entry) => entry && entry.isFile && String(entry.name || "") === siblingName) || null;
    if (exactMatch) return exactMatch;

    const targetStem = normalizeWorkflowImportFileStem(siblingName);
    const targetExt = siblingName.replace(/^.*(?=\.[^.]+$)/, "").toLowerCase();
    return entries.find((entry) => {
        if (!entry || !entry.isFile) return false;
        const entryName = String(entry.name || "").trim();
        if (!entryName.toLowerCase().endsWith(targetExt)) return false;
        return normalizeWorkflowImportFileStem(entryName) === targetStem;
    }) || null;
}

// Reads a sibling file from a known folder entry using UXP file APIs only.
async function readWorkflowImportSiblingText(folderEntry, siblingFileName) {
    const siblingEntry = await findWorkflowImportSiblingEntry(folderEntry, siblingFileName);
    if (siblingEntry && typeof siblingEntry.read === "function") {
        return await siblingEntry.read();
    }
    throw new Error(`Could not find "${String(siblingFileName || "").trim()}" next to the selected metadata file.`);
}

// Returns configured custom workflows folder entry from persistent token, or null when not configured/invalid.
async function getCustomWorkflowsFolderEntry() {
    const token = String(settingsState.customApiWorkflowsToken || "").trim();
    if (!token) return null;
    try {
        const entry = await storage.localFileSystem.getEntryForPersistentToken(token);
        if (!entry || !entry.isFolder) return null;
        return entry;
    } catch (_e) {
        return null;
    }
}

// Returns default plugin workflows folder and label.
async function getDefaultWorkflowSource() {
    const pluginFolder = await storage.localFileSystem.getPluginFolder();
    const workflowsFolder = await pluginFolder.getEntry(WORKFLOWS_FOLDER_NAME);
    return { workflowsFolder, sourceLabel: WORKFLOWS_FOLDER_NAME, sourceType: "default" };
}

// Returns custom workflows folder and label, or null when unavailable.
async function getCustomWorkflowSource() {
    const customFolder = await getCustomWorkflowsFolderEntry();
    if (!customFolder) return null;
    const sourceLabel = settingsState.customApiWorkflowsPath || getEntryDisplayPath(customFolder) || "custom workflows";
    return { workflowsFolder: customFolder, sourceLabel, sourceType: "custom" };
}

// Returns the second custom workflows folder entry from persistent token, or null when not configured/invalid.
async function getCustomWorkflowsFolderEntry2() {
    const token = String(settingsState.customApiWorkflowsToken2 || "").trim();
    if (!token) return null;
    try {
        const entry = await storage.localFileSystem.getEntryForPersistentToken(token);
        if (!entry || !entry.isFolder) return null;
        return entry;
    } catch (_e) {
        return null;
    }
}

// Returns second custom workflows folder and label, or null when unavailable.
async function getCustomWorkflowSource2() {
    const customFolder = await getCustomWorkflowsFolderEntry2();
    if (!customFolder) return null;
    const sourceLabel = settingsState.customApiWorkflowsPath2 || getEntryDisplayPath(customFolder) || "custom workflows 2";
    return { workflowsFolder: customFolder, sourceLabel, sourceType: "custom2" };
}

// Builds stable workflow option id that is unique across source folders.
function buildWorkflowId(sourceType, folderName) {
    return `${String(sourceType || "default")}::${String(folderName || "")}`;
}

// Returns workflow path key used for source lookups and sticky-settings persistence.
function getWorkflowPathKey(config) {
    return String(config?.workflowPath || config?.folderName || "").trim();
}

// Resolves a workflow folder entry from a source workflows root and relative path.
async function resolveWorkflowFolderByPath(workflowsRoot, workflowPath) {
    if (!workflowsRoot) throw new Error("Workflow source folder is unavailable.");
    const pathValue = String(workflowPath || "").trim();
    if (!pathValue) throw new Error("Workflow path is missing.");
    const segments = pathValue.split("/").map((part) => String(part || "").trim()).filter(Boolean);
    if (segments.length < 1) throw new Error("Workflow path is invalid.");
    let current = workflowsRoot;
    for (const segment of segments) {
        current = await current.getEntry(segment);
    }
    return current;
}

// Enumerates workflow folders recursively and resolves YAML/JSON assets for each runnable folder.
async function collectWorkflowConfigsFromRoot(source, rootFolder) {
    const configs = [];
    async function walk(folderEntry, parentSegments = []) {
        const entries = await folderEntry.getEntries();
        const yamlFile = entries.find((e) => e && e.isFile && /\.ya?ml$/i.test(e.name));
        // Prefer the API prompt template over companion *_UI.json exports so Auto Run always queues
        // the runnable workflow JSON instead of the editor graph document.
        const jsonFiles = entries.filter((e) => e && e.isFile && /\.json$/i.test(e.name));
        const jsonFile = jsonFiles.find((e) => !/_UI\.json$/i.test(String(e.name || ""))) || jsonFiles[0] || null;
        if (yamlFile || jsonFile) {
            const displayName = parentSegments.length > 0
                ? String(parentSegments[parentSegments.length - 1] || "").trim()
                : String(folderEntry.name || "").trim();
            const groupPath = parentSegments.length > 1 ? parentSegments.slice(0, -1).join("/") : "";
            let supportsLocal = true;
            let supportsCloud = false;
            let supportsRunComfy = false;
            let supportsRunPod = false;
            let deploymentConstraints = [];
            let endpointConstraints = [];
            let localMachineConstraints = [];
            let yamlFileName = yamlFile ? yamlFile.name : "";
            const jsonFileName = jsonFile ? jsonFile.name : "";
            if (yamlFile) {
                try {
                    const yamlText = await yamlFile.read();
                    const environment = parseEnvironmentFromYamlText(yamlText);
                    supportsLocal = Boolean(environment?.supportsLocal);
                    supportsCloud = Boolean(environment?.supportsCloud);
                    supportsRunComfy = Boolean(environment?.supportsRunComfy);
                    supportsRunPod = Boolean(environment?.supportsRunPod);
                    deploymentConstraints = parseDeploymentTokenListFromYamlText(yamlText);
                    endpointConstraints = parseEndpointTokenListFromYamlText(yamlText);
                    localMachineConstraints = parseLocalMachineTokenListFromYamlText(yamlText);
                } catch (_e) {}
            }
            const workflowPath = parentSegments.join("/");
            configs.push({
                id: buildWorkflowId(source.sourceType, workflowPath),
                folderName: workflowPath,
                displayName,
                workflowPath,
                groupPath,
                yamlFileName,
                jsonFileName,
                supportsLocal,
                supportsCloud,
                supportsRunComfy,
                supportsRunPod,
                deploymentConstraints,
                endpointConstraints,
                localMachineConstraints,
                sourceType: source.sourceType,
                sourceFolderLabel: source.sourceLabel
            });
        }

        for (const childEntry of entries) {
            if (!childEntry || !childEntry.isFolder) continue;
            if (!shouldIncludeWorkflowFolder(childEntry.name)) continue;
            await walk(childEntry, [...parentSegments, String(childEntry.name || "").trim()]);
        }
    }
    const rootEntries = await rootFolder.getEntries();
    // If workflow files sit directly in the root (user pointed path at the workflow folder itself),
    // treat the root as a single workflow entry in addition to any subfolders.
    const rootHasYaml = rootEntries.some((e) => e && e.isFile && /\.ya?ml$/i.test(e.name));
    const rootHasJson = rootEntries.some((e) => e && e.isFile && /\.json$/i.test(e.name));
    if (rootHasYaml || rootHasJson) {
        await walk(rootFolder, [String(rootFolder.name || "").trim()]);
    }
    for (const entry of rootEntries) {
        if (!entry || !entry.isFolder) continue;
        if (!shouldIncludeWorkflowFolder(entry.name)) continue;
        await walk(entry, [String(entry.name || "").trim()]);
    }
    return configs;
}

// Returns whether a workflow folder should be listed in Auto Run selector.
function shouldIncludeWorkflowFolder(folderName) {
    const name = String(folderName || "").trim();
    if (!name) return false;
    if (SHOW_DEBUG_WORKFLOWS) return true;
    return !name.startsWith("Debug_");
}

// Returns workflow config by source-aware id.
function getWorkflowConfigById(workflowId) {
    return autoRunState.workflowConfigs.find((cfg) => cfg.id === workflowId) || null;
}

// Returns true when current environment is RunComfy.
function isRunComfyEnvironment() {
    return normalizeEnvironmentMode(settingsState.environment) === "runcomfy";
}

// Returns true when current environment is RunPod.
function isRunPodEnvironment() {
    return normalizeEnvironmentMode(settingsState.environment) === "runpod";
}

// Returns true when a workflow supports the currently selected environment.
function isWorkflowCompatibleWithCurrentEnvironment(config) {
    const environmentMode = normalizeEnvironmentMode(settingsState.environment);
    if (environmentMode === "runcomfy") {
        if (!Boolean(config?.supportsRunComfy)) return false;
        const deploymentConstraints = Array.isArray(config?.deploymentConstraints) ? config.deploymentConstraints : [];
        if (deploymentConstraints.length < 1) return true;
        if (!deploymentSelect) return false;
        const selectedOption = deploymentSelect.options && deploymentSelect.selectedIndex >= 0
            ? deploymentSelect.options[deploymentSelect.selectedIndex]
            : null;
        const selectedDeploymentName = String(
            selectedOption?.textContent || selectedOption?.innerText || settingsState.runcomfyDeploymentId || ""
        ).trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
        if (!selectedDeploymentName) return false;
        const selectedLower = selectedDeploymentName.toLowerCase();
        return deploymentConstraints.some((constraint) => String(constraint || "").trim().toLowerCase() === selectedLower);
    }
    if (environmentMode === "runpod") {
        if (!Boolean(config?.supportsRunPod)) return false;
        // Prefer the dedicated RunPod endpoint token, but keep deployment token support
        // as a compatibility fallback for existing workflow YAML files.
        const endpointConstraints = Array.isArray(config?.endpointConstraints) ? config.endpointConstraints : [];
        const runPodConstraints = endpointConstraints.length > 0
            ? endpointConstraints
            : (Array.isArray(config?.deploymentConstraints) ? config.deploymentConstraints : []);
        if (runPodConstraints.length < 1) return true;
        if (!deploymentSelect) return false;
        const selectedOption = deploymentSelect.options && deploymentSelect.selectedIndex >= 0
            ? deploymentSelect.options[deploymentSelect.selectedIndex]
            : null;
        const selectedEndpointName = String(
            selectedOption?.textContent || selectedOption?.innerText || settingsState.runpodEndpointId || ""
        ).trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
        if (!selectedEndpointName) return false;
        const selectedLower = selectedEndpointName.toLowerCase();
        return runPodConstraints.some((constraint) => String(constraint || "").trim().toLowerCase() === selectedLower);
    }
    if (environmentMode === "cloud") return Boolean(config?.supportsCloud);

    if (!Boolean(config?.supportsLocal)) return false;
    const localMachineConstraints = Array.isArray(config?.localMachineConstraints) ? config.localMachineConstraints : [];
    if (localMachineConstraints.length < 1) return true;
    const currentServer = normalizeServerSettingValue(settingsState.server || serverField?.value || "127.0.0.1");
    const currentPort = normalizePort(settingsState.port || portField?.value || "");
    let currentHost = "";
    try {
        const url = new URL(currentServer.startsWith("http://") || currentServer.startsWith("https://") ? currentServer : `http://${currentServer}`);
        currentHost = String(url.hostname || "").trim().toLowerCase();
    } catch (_e) {
        currentHost = String(currentServer || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim().toLowerCase();
    }
    const currentHostPort = `${currentHost}${currentPort ? `:${currentPort}` : ""}`;
    const currentIsLocalAlias = currentHost === "localhost" || currentHost === "127.0.0.1";
    return localMachineConstraints.some((constraintRaw) => {
        const normalizedConstraint = String(constraintRaw || "")
            .trim()
            .replace(/^https?:\/\//i, "")
            .replace(/\/.*$/, "")
            .toLowerCase();
        if (!normalizedConstraint) return false;
        if (normalizedConstraint === currentHostPort) return true;
        if (normalizedConstraint === currentHost) return true;
        if (currentIsLocalAlias) {
            if (normalizedConstraint === `localhost${currentPort ? `:${currentPort}` : ""}`) return true;
            if (normalizedConstraint === `127.0.0.1${currentPort ? `:${currentPort}` : ""}`) return true;
            if (normalizedConstraint === "localhost" || normalizedConstraint === "127.0.0.1") return true;
        }
        return false;
    });
}

// Reloads workflow configs from default/custom sources and re-renders Auto Run with preserved selection when possible.
async function refreshAutoRunWorkflowList({ preserveSelection = true } = {}) {
    const previousSelection = preserveSelection ? String(autoRunState.selectedWorkflow || "") : "";
    autoRunState.workflowConfigs = (await listWorkflowConfigs()).filter(isWorkflowCompatibleWithCurrentEnvironment);
    autoRunState.parameterDefs = [];
    autoRunState.workflowClassTypes = [];
    autoRunState.workflowNodeTargets = createDefaultWorkflowNodeTargets();

    if (autoRunState.workflowConfigs.length === 0) {
        autoRunState.selectedWorkflow = "";
        const defaultSource = await getDefaultWorkflowSource();
        const customSource = await getCustomWorkflowSource();
        const customSource2 = await getCustomWorkflowSource2();
        const labels = [defaultSource.sourceLabel];
        if (customSource?.sourceLabel) labels.push(customSource.sourceLabel);
        if (customSource2?.sourceLabel) labels.push(customSource2.sourceLabel);
        renderNanoBananaForm([], `No workflow folders found under ${labels.join(" and ")}.`);
        log(`Generate: no workflow folders found under ${labels.join(" and ")}.`);
        return;
    }

    const matched = previousSelection
        ? autoRunState.workflowConfigs.find((cfg) => cfg.id === previousSelection)
        : null;
    const preferred = autoRunState.workflowConfigs.find(
        (cfg) => cfg.sourceType === "default" && cfg.folderName === "Nano Banana Pro"
    );
    autoRunState.selectedWorkflow = String((matched || preferred || autoRunState.workflowConfigs[0]).id || "");
    await loadSelectedWorkflowParameters();
}

// Enumerates workflow folders and resolves each folder's YAML/JSON assets for Auto Run.
async function listWorkflowConfigs() {
    const sources = [];
    sources.push(await getDefaultWorkflowSource());
    const customSource = await getCustomWorkflowSource();
    if (customSource) sources.push(customSource);
    const customSource2 = await getCustomWorkflowSource2();
    if (customSource2) sources.push(customSource2);
    const configs = [];
    for (const source of sources) {
        const sourceConfigs = await collectWorkflowConfigsFromRoot(source, source.workflowsFolder);
        log(`[DEBUG] source=${source.sourceType} found ${sourceConfigs.length} configs`);
        configs.push(...sourceConfigs);
    }

    configs.sort((a, b) => {
        // Keep built-in workflows first, then custom workflows; sort each group by name.
        const sourceRank = (sourceType) => (String(sourceType || "").toLowerCase() === "default" ? 0 : 1);
        const bySource = sourceRank(a.sourceType) - sourceRank(b.sourceType);
        if (bySource !== 0) return bySource;
        const byGroup = compareWorkflowGroupPaths(a.groupPath, b.groupPath);
        if (byGroup !== 0) return byGroup;
        const byName = String(a.displayName || a.folderName || "").localeCompare(String(b.displayName || b.folderName || ""));
        if (byName !== 0) return byName;
        return String(a.sourceType || "").localeCompare(String(b.sourceType || ""));
    });
    return configs;
}

// Reads the selected workflow YAML configuration from the workflow folder.
async function readWorkflowYamlText(config) {
    if (!config || !config.folderName) throw new Error("Missing workflow selection.");
    if (!config.yamlFileName) {
        throw new Error(`No YAML file found in ${config.sourceFolderLabel || WORKFLOWS_FOLDER_NAME}/${config.folderName}.`);
    }

    const workflowsFolder = config.sourceType === "custom2"
        ? (await getCustomWorkflowSource2())?.workflowsFolder
        : config.sourceType === "custom"
            ? (await getCustomWorkflowSource())?.workflowsFolder
            : (await getDefaultWorkflowSource()).workflowsFolder;
    if (!workflowsFolder) {
        throw new Error(`Workflow source unavailable for ${config.folderName}.`);
    }
    const workflowFolder = await resolveWorkflowFolderByPath(workflowsFolder, getWorkflowPathKey(config));
    const yamlFile = await workflowFolder.getEntry(config.yamlFileName);
    return await yamlFile.read();
}

// Reads the selected workflow JSON prompt template from the workflow folder.
async function readWorkflowJsonText(config) {
    if (!config || !config.folderName) throw new Error("Missing workflow selection.");
    if (!config.jsonFileName) {
        throw new Error(`No JSON file found in ${config.sourceFolderLabel || WORKFLOWS_FOLDER_NAME}/${config.folderName}.`);
    }

    const workflowsFolder = config.sourceType === "custom2"
        ? (await getCustomWorkflowSource2())?.workflowsFolder
        : config.sourceType === "custom"
            ? (await getCustomWorkflowSource())?.workflowsFolder
            : (await getDefaultWorkflowSource()).workflowsFolder;
    if (!workflowsFolder) {
        throw new Error(`Workflow source unavailable for ${config.folderName}.`);
    }
    const workflowFolder = await resolveWorkflowFolderByPath(workflowsFolder, getWorkflowPathKey(config));
    let jsonFileName = String(config.jsonFileName || "").trim();
    if (/_UI\.json$/i.test(jsonFileName)) {
        const preferredJsonFileName = jsonFileName.replace(/_UI\.json$/i, ".json");
        try {
            await workflowFolder.getEntry(preferredJsonFileName);
            jsonFileName = preferredJsonFileName;
        } catch (_e) {}
    }
    const jsonFile = await workflowFolder.getEntry(jsonFileName);
    return await jsonFile.read();
}

// Reads the selected workflow UI JSON when a sibling *_UI.json file exists in the workflow folder or examples folder.
async function readWorkflowUiJsonText(config) {
    if (!config || !config.folderName) throw new Error("Missing workflow selection.");
    const workflowPath = getWorkflowPathKey(config);
    const workflowLeafName = String(workflowPath.split("/").pop() || config.displayName || "workflow").trim();
    const uiFileName = `${workflowLeafName}_UI.json`;
    const candidateRoots = [];
    const activeSource = config.sourceType === "custom2"
        ? (await getCustomWorkflowSource2())?.workflowsFolder
        : config.sourceType === "custom"
            ? (await getCustomWorkflowSource())?.workflowsFolder
            : (await getDefaultWorkflowSource()).workflowsFolder;
    if (activeSource) candidateRoots.push(activeSource);
    try {
        const pluginFolder = await storage.localFileSystem.getPluginFolder();
        const exampleRoot = await pluginFolder.getEntry("example workflows");
        if (exampleRoot && exampleRoot.isFolder) candidateRoots.push(exampleRoot);
    } catch (_e) {}

    for (const rootFolder of candidateRoots) {
        try {
            const workflowFolder = await resolveWorkflowFolderByPath(rootFolder, workflowPath);
            const uiFile = await workflowFolder.getEntry(uiFileName);
            if (uiFile && uiFile.isFile) return await uiFile.read();
        } catch (_e) {}
    }
    throw new Error(`No UI workflow JSON found for ${config.displayName || config.folderName}.`);
}

// Copies text to the system clipboard with a DOM fallback for UXP hosts without navigator.clipboard support.
async function copyTextToClipboard(text) {
    const payload = String(text || "");
    if (!payload) throw new Error("Nothing to copy.");
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(payload);
        return;
    }
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.setContent === "function") {
        await navigator.clipboard.setContent({ "text/plain": payload });
        return;
    }
    let uxpClipboard = null;
    try {
        uxpClipboard = require("clipboard");
    } catch (_e) {
        uxpClipboard = null;
    }
    if (uxpClipboard && typeof uxpClipboard.copyText === "function") {
        uxpClipboard.copyText(payload);
        return;
    }
    if (typeof document === "undefined" || !document.body) {
        throw new Error("Clipboard is unavailable in this host.");
    }
    const textarea = document.createElement("textarea");
    textarea.value = payload;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    let copied = false;
    try {
        copied = Boolean(document.execCommand && document.execCommand("copy"));
    } catch (_e) {
        copied = false;
    } finally {
        document.body.removeChild(textarea);
    }
    if (!copied) throw new Error("Clipboard copy failed.");
}

// Builds the workflow selector field and wires selection changes to parameter reload.
function createWorkflowSelectorField() {
    const field = document.createElement("div");
    field.className = "dynamicField workflowSelectorField";

    const label = document.createElement("div");
    label.className = "fieldLabel";
    label.textContent = "Workflow";

    const select = document.createElement("select");
    select.className = "dynamicInput";

    // Resolves the workflow currently selected in the dropdown so the row buttons stay in sync
    // even after the form is rebuilt from persisted settings.
    const getSelectedWorkflowConfig = () => {
        const selectedId = String(select.value || autoRunState.selectedWorkflow || "").trim();
        if (!selectedId) return null;
        return getWorkflowConfigById(selectedId);
    };

    if (autoRunState.workflowConfigs.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "No workflows";
        select.appendChild(opt);
        select.disabled = true;
    } else {
        const defaultConfigs = autoRunState.workflowConfigs.filter((cfg) => String(cfg.sourceType || "").toLowerCase() === "default");
        const customConfigs = autoRunState.workflowConfigs.filter((cfg) => String(cfg.sourceType || "").toLowerCase() !== "default");

        const workflowIndentPrefix = "";
        let separatorCounter = 0;

        const appendDropdownSeparator = () => {
            const lastOption = select.options && select.options.length > 0
                ? select.options[select.options.length - 1]
                : null;
            if (lastOption && String(lastOption.value || "").startsWith("__quickai_separator__")) return;
            const separator = document.createElement("option");
            separator.value = `__quickai_separator__${separatorCounter++}`;
            separator.textContent = "────────────────────";
            separator.disabled = true;
            select.appendChild(separator);
        };

        const appendSourceConfigs = (subtitleText, subtitleValue, sourceConfigs) => {
            if (!Array.isArray(sourceConfigs) || sourceConfigs.length < 1) return;

            if (select.options.length > 0) appendDropdownSeparator();
            const sourceSubtitle = document.createElement("option");
            sourceSubtitle.value = subtitleValue;
            sourceSubtitle.textContent = `[ ${String(subtitleText || "").toUpperCase()} ]`;
            sourceSubtitle.disabled = true;
            select.appendChild(sourceSubtitle);
            appendDropdownSeparator();

            const grouped = new Map();
            const ungrouped = [];
            for (const cfg of sourceConfigs) {
                const groupPath = String(cfg.groupPath || "").trim();
                if (!groupPath) {
                    ungrouped.push(cfg);
                    continue;
                }
                if (!grouped.has(groupPath)) grouped.set(groupPath, []);
                grouped.get(groupPath).push(cfg);
            }

            for (const cfg of ungrouped) {
                const opt = document.createElement("option");
                opt.value = cfg.id;
                opt.textContent = `${workflowIndentPrefix}${buildWorkflowOptionLabel(cfg)}`;
                select.appendChild(opt);
            }

            const groupKeys = Array.from(grouped.keys()).sort((a, b) => {
                return compareWorkflowGroupPaths(a, b);
            });
            for (const groupPath of groupKeys) {
                appendDropdownSeparator();
                const folderSubtitle = document.createElement("option");
                folderSubtitle.value = `__quickai_folder_subtitle__${subtitleValue}__${groupPath}`;
                folderSubtitle.textContent = `< ${getWorkflowGroupDisplayPath(groupPath)} >`;
                folderSubtitle.disabled = true;
                select.appendChild(folderSubtitle);
                appendDropdownSeparator();

                const workflows = grouped.get(groupPath) || [];
                for (const cfg of workflows) {
                    const opt = document.createElement("option");
                    opt.value = cfg.id;
                    opt.textContent = `${workflowIndentPrefix}${buildWorkflowOptionLabel(cfg)}`;
                    select.appendChild(opt);
                }
            }
        };

        appendSourceConfigs("Default Workflows", "__quickai_default_subtitle__", defaultConfigs);
        appendSourceConfigs("Custom Workflows", "__quickai_custom_subtitle__", customConfigs);
        if (autoRunState.selectedWorkflow) {
            select.value = autoRunState.selectedWorkflow;
        }
    }

    select.addEventListener("change", () => {
        const selectedOption = select.options[select.selectedIndex];
        const nextValue = String(select.value || "");
        if (
            !nextValue
            || nextValue === "__quickai_custom_separator__"
            || nextValue.startsWith("__quickai_separator__")
            || nextValue === "__quickai_default_subtitle__"
            || nextValue === "__quickai_custom_subtitle__"
            || (selectedOption && selectedOption.disabled)
        ) {
            // Defensive fallback for environments that allow temporary focus on non-selectable entries.
            select.value = autoRunState.selectedWorkflow || "";
            return;
        }
        autoRunState.selectedWorkflow = nextValue;
        persistSettings().catch((error) => {
            log(`Generate workflow selection save error: ${describeError(error)}`);
        });
        loadSelectedWorkflowParameters().catch((error) => {
            log(`Generate workflow load error: ${describeError(error)}`);
        });
    });

    const controlsRow = document.createElement("div");
    controlsRow.className = "workflowSelectorControlRow";

    const refreshBtn = document.createElement("button");
    refreshBtn.id = "autoRunWorkflowRefreshBtn";
    refreshBtn.type = "button";
    refreshBtn.className = "qc-btn";
    refreshBtn.textContent = "R";
    refreshBtn.setAttribute("aria-label", "Refresh workflow list");
    refreshBtn.title = "Refresh workflows";
    refreshBtn.disabled = autoRunState.isRunning;
    refreshBtn.addEventListener("click", async () => {
        refreshBtn.disabled = true;
        try {
            await refreshAutoRunWorkflowList({ preserveSelection: true });
            log("Generate workflow list refreshed.");
        } catch (error) {
            log(`Generate workflow refresh error: ${describeError(error)}`);
        } finally {
            const latestBtn = document.getElementById("autoRunWorkflowRefreshBtn");
            if (latestBtn) latestBtn.disabled = autoRunState.isRunning;
        }
    });

    const defaultsRow = document.createElement("div");
    defaultsRow.className = "workflowSelectorDefaultsRow";

    const defaultsColumn = document.createElement("div");
    defaultsColumn.className = "workflowSelectorDefaultsColumn";

    const defaultsBtn = document.createElement("button");
    defaultsBtn.id = "autoRunWorkflowDefaultsBtn";
    defaultsBtn.type = "button";
    defaultsBtn.className = "qc-btn";
    defaultsBtn.textContent = "Default Settings";
    defaultsBtn.setAttribute("aria-label", "Reset selected workflow parameters to defaults");
    defaultsBtn.title = "Reset parameters to defaults";
    const clipboardColumn = document.createElement("div");
    clipboardColumn.className = "workflowSelectorDefaultsColumn";

    const clipboardBtn = document.createElement("button");
    clipboardBtn.id = "autoRunWorkflowClipboardBtn";
    clipboardBtn.type = "button";
    clipboardBtn.className = "qc-btn";
    clipboardBtn.textContent = "Copy To Clipboard";
    clipboardBtn.setAttribute("aria-label", "Copy selected workflow UI JSON to clipboard when available");
    clipboardBtn.title = "Copy selected workflow UI JSON";

    // Keeps the Restore and Clipboard buttons aligned with the current workflow selection and run state.
    // This stays intentionally simple because this form is rebuilt often and UXP can be picky about
    // button state updates during dynamic panel redraws.
    const syncWorkflowSelectorButtons = async () => {
        const selectedConfig = getSelectedWorkflowConfig();
        const hasSelectedWorkflow = Boolean(selectedConfig && selectedConfig.id);
        let hasUiWorkflow = false;
        if (hasSelectedWorkflow) {
            try {
                await readWorkflowUiJsonText(selectedConfig);
                hasUiWorkflow = true;
            } catch (_e) {
                hasUiWorkflow = false;
            }
        }
        defaultsBtn.disabled = autoRunState.isRunning || !hasSelectedWorkflow;
        clipboardBtn.disabled = autoRunState.isRunning || !hasUiWorkflow;
    };

    defaultsBtn.addEventListener("click", async () => {
        defaultsBtn.disabled = true;
        try {
            // Resetting discards every current parameter value of the workflow, with no undo.
            const accepted = await showPanelConfirm(
                "Restore this workflow's default settings? Your current values will be lost.",
                { alignTo: autoRunCard }
            );
            if (!accepted) return;
            await resetSelectedWorkflowParametersToDefaults();
            // Confirmation as a green (success) panel toast, same style as the Bridge result messages.
            showPanelToast("Default workflow settings restored.", "success");
        } catch (error) {
            log(`Generate defaults reset error: ${describeError(error)}`);
        } finally {
            syncWorkflowSelectorButtons().catch(() => {});
        }
    });

    clipboardBtn.addEventListener("click", async () => {
        clipboardBtn.disabled = true;
        try {
            const activeConfig = getSelectedWorkflowConfig();
            if (!activeConfig) throw new Error("No workflow selected.");
            const uiJsonText = await readWorkflowUiJsonText(activeConfig);
            JSON.parse(uiJsonText);
            await copyTextToClipboard(uiJsonText);
            showPanelToast("Workflow copied to clipboard!", "success");
            log(`Workflow UI JSON copied to clipboard for ${activeConfig.displayName || activeConfig.folderName}.`);
        } catch (error) {
            log(`Workflow UI clipboard error: ${describeError(error)}`);
        } finally {
            syncWorkflowSelectorButtons().catch(() => {});
        }
    });

    syncWorkflowSelectorButtons().catch(() => {});

    controlsRow.appendChild(select);
    controlsRow.appendChild(refreshBtn);
    defaultsColumn.appendChild(defaultsBtn);
    clipboardColumn.appendChild(clipboardBtn);
    defaultsRow.appendChild(defaultsColumn);
    defaultsRow.appendChild(clipboardColumn);

    select.addEventListener("change", () => {
        syncWorkflowSelectorButtons().catch(() => {});
    });

    field.appendChild(label);
    field.appendChild(controlsRow);
    field.appendChild(defaultsRow);
    return field;
}

// Builds a minimal selector field when the richer workflow-row UI hits a host-specific render error.
function createWorkflowSelectorFieldFallback(error) {
    const field = document.createElement("div");
    field.className = "dynamicField workflowSelectorField";

    const label = document.createElement("div");
    label.className = "fieldLabel";
    label.textContent = "Workflow";

    const message = document.createElement("div");
    message.className = "dynamicError";
    message.textContent = `Workflow controls failed to render: ${describeError(error)}`;

    field.appendChild(label);
    field.appendChild(message);
    return field;
}

// Creates auto run button field.
function createAutoRunButtonField(disabled = false) {
    const field = document.createElement("div");
    field.className = "dynamicField autoRunButtonField";

    const buttonRow = document.createElement("div");
    buttonRow.className = "autoRunButtonRow";

    const runColumn = document.createElement("div");
    runColumn.className = "autoRunButtonColumn";

    const runBtn = document.createElement("button");
    runBtn.id = "autoRunRunBtn";
    runBtn.type = "button";
    runBtn.className = "qc-btn";
    runBtn.textContent = "Run";
    runBtn.addEventListener("click", () => {
        if (runBtn.disabled || runBtn.getAttribute("aria-disabled") === "true") return;
        runAutoRunSelectedWorkflow().catch((error) => {
            const detail = normalizePluginError(describeError(error));
            log(`Generate execution error: ${detail}`);
            // Run failed before the job was queued (missing input, no document, ...).
            showPanelToast(`Run failed: ${detail}`, "error", 6000);
        });
    });
    runColumn.appendChild(runBtn);

    const stopColumn = document.createElement("div");
    stopColumn.className = "autoRunButtonColumn";

    const stopBtn = document.createElement("button");
    stopBtn.id = "autoRunStopBtn";
    stopBtn.type = "button";
    stopBtn.className = "qc-btn";
    stopBtn.textContent = "Jobs";
    stopBtn.addEventListener("click", () => {
        if (stopBtn.disabled || stopBtn.getAttribute("aria-disabled") === "true") return;
        openAutoRunJobsDialog();
    });
    stopBtn.setAttribute("aria-label", "Open Generate jobs");
    stopColumn.appendChild(stopBtn);

    buttonRow.appendChild(runColumn);
    buttonRow.appendChild(stopColumn);

    const progressWrap = document.createElement("div");
    progressWrap.id = "autoRunProgressWrap";
    progressWrap.className = "autoRunProgress";
    if (!autoRunState.progressVisible) progressWrap.classList.add("isHidden");

    const progressLabel = document.createElement("div");
    progressLabel.id = "autoRunProgressLabel";
    progressLabel.className = "autoRunProgressLabel";
    progressLabel.textContent = formatAutoRunProgressDisplayText(autoRunState.progressText || `${Math.round(autoRunState.progressPercent)}%`);

    progressWrap.appendChild(progressLabel);

    field.appendChild(buttonRow);
    field.appendChild(progressWrap);
    syncAutoRunButtonState({
        disabled,
        runButton: runBtn,
        stopButton: stopBtn
    });
    return field;
}

// Keeps Auto Run button enabled states in sync with execution state without replacing the button row.
function syncAutoRunButtonState(options = {}) {
    const runBtn = options.runButton || document.getElementById("autoRunRunBtn");
    const stopBtn = options.stopButton || document.getElementById("autoRunStopBtn");
    const baseDisabled = Boolean(options.disabled);
    const trackedJobCount = getAutoRunTrackedJobCount();
    const hasTrackedJobs = trackedJobCount > 0;
    const setDisabledState = (button, shouldDisable) => {
        if (!button) return;
        const disabledState = Boolean(shouldDisable);
        button.disabled = disabledState;
        button.classList.toggle("isDisabled", disabledState);
        button.setAttribute("aria-disabled", disabledState ? "true" : "false");
        if (disabledState) {
            button.setAttribute("disabled", "");
            button.style.pointerEvents = "none";
            button.style.cursor = "default";
            button.style.opacity = "0.42";
        } else {
            button.removeAttribute("disabled");
            button.style.pointerEvents = "";
            button.style.cursor = "";
            button.style.opacity = "";
        }
    };
    setDisabledState(runBtn, baseDisabled);
    setDisabledState(stopBtn, baseDisabled);
}

// Returns a short user-facing label for the job list and terminal logs.
function describeAutoRunJob(job) {
    const workflowLabel = String(job?.workflowDisplayName || job?.config?.displayName || job?.config?.folderName || "Workflow").trim();
    const docLabel = String(job?.documentName || "").trim();
    return docLabel ? `${workflowLabel} - ${docLabel}` : workflowLabel;
}

// Maps the current queued/running state to a compact status string for the cancel dialog.
function getAutoRunJobStatusLabel(job) {
    if (!job) return "Unknown";
    const cropCount = Math.max(1, Number(job?.totalRuns) || 1);
    const cropSuffix = cropCount > 1 ? ` | ${cropCount} crops` : "";
    const activityState = getAutoRunJobActivityState(job);
    if (job.stopRequested && (job.state === "running" || activityState === "running" || activityState === "queued")) return "Stopping";
    if (job.state === "queued" || activityState === "queued") return `Queued${cropSuffix}`;
    if (job.state === "running" || activityState === "running") return `Running${cropSuffix}`;
    if (job.state === "stopped") return "Stopped";
    if (job.state === "error") return "Error";
    if (job.state === "completed") return cropCount > 1 ? `Completed ${cropCount}/${cropCount} crops` : "Completed";
    return "Queued";
}

// Returns the file the Jobs dialog previews for a job, plus its MIME type: the small saved
// thumbnail when there is one, otherwise (jobs saved before thumbnails existed) the full input
// snapshot.
function getAutoRunJobPreviewSourceFile(job) {
    if (!job || !Array.isArray(job.segments) || job.segments.length < 1) return null;
    for (let i = 0; i < job.segments.length; i += 1) {
        const thumbnailFile = job.segments[i] && job.segments[i].thumbnailFile;
        if (thumbnailFile) return { file: thumbnailFile, mimeType: "image/jpeg" };
    }
    for (let i = 0; i < job.segments.length; i += 1) {
        const snapshotFile = job.segments[i] && job.segments[i].snapshotFile;
        if (snapshotFile) return { file: snapshotFile, mimeType: "image/png" };
    }
    return null;
}

// Loads and caches a compact data-URL preview for one job from its already-exported snapshot file.
async function getAutoRunJobPreviewDataUrl(job) {
    if (!job) return "";
    if (typeof job.previewDataUrl === "string" && job.previewDataUrl) return job.previewDataUrl;
    if (job.previewDataUrlPromise) return await job.previewDataUrlPromise;
    // Same-session jobs already hold their thumbnail in memory (built while preparing the job).
    const inMemoryThumbnail = Array.isArray(job.segments)
        ? job.segments.map((segment) => segment && segment.thumbnailDataUrl).find(Boolean)
        : "";
    if (inMemoryThumbnail) {
        job.previewDataUrl = inMemoryThumbnail;
        return inMemoryThumbnail;
    }
    const source = getAutoRunJobPreviewSourceFile(job);
    const sourceFile = source && source.file;
    if (!sourceFile || typeof sourceFile.read !== "function") return "";

    job.previewDataUrlPromise = (async () => {
        try {
            const bytes = await sourceFile.read({ format: storage.formats.binary });
            const base64 = bytesToBase64(bytes);
            const dataUrl = base64 ? `data:${source.mimeType};base64,${base64}` : "";
            job.previewDataUrl = dataUrl;
            return dataUrl;
        } catch (_e) {
            job.previewDataUrl = "";
            return "";
        } finally {
            job.previewDataUrlPromise = null;
        }
    })();
    return await job.previewDataUrlPromise;
}

// Updates one job row preview in-place after the snapshot thumbnail finishes loading.
async function hydrateAutoRunJobPreview(row, job) {
    if (!row || !job) return;
    const imageEl = row.querySelector(".autoRunJobPreviewImage");
    const fallbackEl = row.querySelector(".autoRunJobPreviewFallback");
    if (!imageEl || !fallbackEl) return;
    const dataUrl = await getAutoRunJobPreviewDataUrl(job);
    if (!row.isConnected) return;
    if (dataUrl) {
        imageEl.src = dataUrl;
        imageEl.classList.add("isVisible");
        fallbackEl.classList.remove("isVisible");
    } else {
        imageEl.removeAttribute("src");
        imageEl.classList.remove("isVisible");
        fallbackEl.classList.add("isVisible");
    }
}

// Tracks job-id -> row element between renders so renderAutoRunJobsDialog() can patch
// rows in place instead of tearing down and rebuilding the whole list every call — it's
// invoked on every progress-poll tick while the dialog is open, and full DOM rebuilds
// there caused visible flicker/jank during active jobs.
const autoRunJobRowElementsById = new Map();

// Builds a fresh Jobs-dialog row for one job. Element references needed for later
// in-place updates are cached on the row (row.__qc) so updateAutoRunJobRow() doesn't
// need repeated querySelector() calls.
function buildAutoRunJobRow(job) {
    const row = document.createElement("div");
    row.className = "autoRunJobItem";

    const previewWrap = document.createElement("div");
    previewWrap.className = "autoRunJobPreview";

    const previewImage = document.createElement("img");
    previewImage.className = "autoRunJobPreviewImage";
    previewImage.loading = "lazy";
    previewWrap.appendChild(previewImage);

    const previewFallback = document.createElement("div");
    previewFallback.className = "autoRunJobPreviewFallback isVisible";
    previewFallback.textContent = "No Preview";
    previewWrap.appendChild(previewFallback);

    const meta = document.createElement("div");
    meta.className = "autoRunJobMeta";

    const title = document.createElement("div");
    title.className = "autoRunJobTitle";
    meta.appendChild(title);

    // Job id shown on its own line above the env/machine info, so each row can be identified
    // unambiguously (e.g. when several jobs share the same workflow/document name).
    const jobIdLine = document.createElement("div");
    jobIdLine.className = "autoRunJobId";
    meta.appendChild(jobIdLine);

    const subtitle = document.createElement("div");
    subtitle.className = "autoRunJobSubtitle";
    meta.appendChild(subtitle);

    // Status (Running/Queued/Completed/Error/...) shown on its own line below the env/machine
    // info, instead of crammed onto the same line separated by "|".
    const statusLine = document.createElement("div");
    statusLine.className = "autoRunJobStatus";
    meta.appendChild(statusLine);

    // Up to two per-job actions: a primary action (Stop while running, Download & Import once
    // completed, View Log once failed) plus a Remove action for anything not currently running.
    const actions = document.createElement("div");
    actions.className = "autoRunJobActions";

    const primaryBtn = document.createElement("button");
    primaryBtn.type = "button";
    primaryBtn.className = "qc-btn autoRunJobAction";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "qc-btn autoRunJobAction isDanger";
    removeBtn.textContent = "Remove";
    removeBtn.dataset.jobAction = "remove";

    // primaryBtn is appended first so it's the top button when both are visible (stacked column) —
    // Remove sits below it, per the layout below.
    actions.appendChild(primaryBtn);
    actions.appendChild(removeBtn);

    row.appendChild(previewWrap);
    row.appendChild(meta);
    row.appendChild(actions);

    row.__qc = { previewWrap, previewImage, title, jobIdLine, subtitle, statusLine, primaryBtn, removeBtn, badge: null };
    updateAutoRunJobRow(row, job);
    return row;
}

// Updates an existing Jobs-dialog row's dynamic fields to match the job's current state.
function updateAutoRunJobRow(row, job) {
    const refs = row.__qc;
    if (!refs) return;

    const cropCount = Math.max(1, Number(job?.totalRuns) || 1);
    if (cropCount > 1) {
        if (!refs.badge) {
            refs.badge = document.createElement("div");
            refs.badge.className = "autoRunJobPreviewBadge";
            refs.previewWrap.appendChild(refs.badge);
        }
        refs.badge.textContent = `+${cropCount - 1}`;
    } else if (refs.badge) {
        refs.badge.remove();
        refs.badge = null;
    }

    const label = describeAutoRunJob(job);
    if (refs.title.textContent !== label) refs.title.textContent = label;
    refs.previewImage.alt = `${label} preview`;

    const promptIds = Array.isArray(job.promptIds) ? job.promptIds.filter(Boolean) : [];
    const jobIdText = promptIds.length > 0 ? promptIds.join(", ") : `Job #${job.id}`;
    if (refs.jobIdLine.textContent !== jobIdText) refs.jobIdLine.textContent = jobIdText;

    const subtitleText = [
        getAutoRunJobBackendLabel(job),
        getAutoRunJobBackendTargetLabel(job)
    ].filter(Boolean).join(" | ");
    if (refs.subtitle.textContent !== subtitleText) refs.subtitle.textContent = subtitleText;

    const statusText = getAutoRunJobStatusLabel(job);
    if (refs.statusLine.textContent !== statusText) refs.statusLine.textContent = statusText;

    const jobId = String(job.id);
    const { primaryBtn, removeBtn } = refs;

    if (job.state === "running") {
        // Only one button visible — same alignment/spacing as a lone Remove button (no gap needed).
        primaryBtn.style.display = "";
        primaryBtn.style.marginTop = "0";
        primaryBtn.classList.add("isDanger");
        primaryBtn.dataset.jobId = jobId;
        primaryBtn.dataset.jobAction = "stop";
        primaryBtn.textContent = job.stopRequested ? "Stopping" : "Stop";
        primaryBtn.disabled = Boolean(job.stopRequested);
        removeBtn.style.display = "none";
    } else if (job.state === "completed") {
        // Import sits on top (appended first); Remove sits directly below it, no gap.
        removeBtn.style.display = "";
        removeBtn.style.marginTop = "0px";
        removeBtn.dataset.jobId = jobId;
        removeBtn.disabled = false;
        primaryBtn.style.display = "";
        primaryBtn.classList.remove("isDanger");
        primaryBtn.dataset.jobId = jobId;
        primaryBtn.dataset.jobAction = "import";
        primaryBtn.textContent = "Import";
        primaryBtn.disabled = false;
    } else if (job.state === "error") {
        // View Log sits on top (appended first); Remove sits directly below it, no gap.
        removeBtn.style.display = "";
        removeBtn.style.marginTop = "0px";
        removeBtn.dataset.jobId = jobId;
        removeBtn.disabled = false;
        primaryBtn.style.display = "";
        primaryBtn.classList.remove("isDanger");
        primaryBtn.dataset.jobId = jobId;
        primaryBtn.dataset.jobAction = "view-log";
        primaryBtn.textContent = "View Log";
        primaryBtn.disabled = false;
    } else {
        // Queued (not yet dispatched) or stopped — only Remove applies, as before.
        primaryBtn.style.display = "none";
        removeBtn.style.display = "";
        removeBtn.dataset.jobId = jobId;
        removeBtn.disabled = false;
    }
}

// Re-renders the Auto Run jobs dialog with active/queued jobs and per-job cancel/remove actions.
function renderAutoRunJobsDialog() {
    if (!autoRunJobsList) return;
    const trackedJobs = getAutoRunTrackedJobs();
    autoRunState.jobsDialogCount = trackedJobs.length;
    if (autoRunJobsClearBtn) {
        autoRunJobsClearBtn.disabled = autoRunState.finishedJobs.length < 1;
    }

    // Clamp the current page (jobs may have been removed) and slice out only that page's jobs.
    const pageCount = Math.max(1, Math.ceil(trackedJobs.length / AUTO_RUN_JOBS_PER_PAGE));
    autoRunJobsPageIndex = Math.min(Math.max(0, autoRunJobsPageIndex), pageCount - 1);
    renderAutoRunJobsPager(pageCount);
    const pageStart = autoRunJobsPageIndex * AUTO_RUN_JOBS_PER_PAGE;
    const pageJobs = trackedJobs.slice(pageStart, pageStart + AUTO_RUN_JOBS_PER_PAGE);

    if (trackedJobs.length < 1) {
        autoRunJobRowElementsById.clear();
        autoRunJobsList.textContent = "";
        const empty = document.createElement("div");
        empty.className = "autoRunJobsEmpty";
        empty.textContent = "No active or queued jobs.";
        autoRunJobsList.appendChild(empty);
        return;
    }

    // Drop rows for jobs no longer tracked or not on the current page.
    const trackedJobIds = new Set(pageJobs.map((job) => String(job.id)));
    for (const [jobId, row] of autoRunJobRowElementsById) {
        if (!trackedJobIds.has(jobId)) {
            row.remove();
            autoRunJobRowElementsById.delete(jobId);
        }
    }
    // Clear a leftover empty-state placeholder from a prior render now that real rows exist.
    if (autoRunJobRowElementsById.size < 1 && autoRunJobsList.querySelector(".autoRunJobsEmpty")) {
        autoRunJobsList.textContent = "";
    }

    let previousRow = null;
    for (let i = 0; i < pageJobs.length; i += 1) {
        const job = pageJobs[i];
        const jobId = String(job.id);
        let row = autoRunJobRowElementsById.get(jobId);
        let isNewRow = false;
        if (!row) {
            row = buildAutoRunJobRow(job);
            autoRunJobRowElementsById.set(jobId, row);
            isNewRow = true;
        } else {
            updateAutoRunJobRow(row, job);
        }
        // Keep DOM order in sync with trackedJobs order.
        const expectedNext = previousRow ? previousRow.nextSibling : autoRunJobsList.firstChild;
        if (expectedNext !== row) autoRunJobsList.insertBefore(row, expectedNext);
        previousRow = row;

        if (isNewRow || !row.__qc.previewImage.classList.contains("isVisible")) {
            hydrateAutoRunJobPreview(row, job).catch(() => {});
        }
    }
}

// Rebuilds the numbered page buttons under the Jobs list. Hidden when everything fits on one page.
// Buttons carry data-page so a single delegated click listener (wired at init) handles navigation.
function renderAutoRunJobsPager(pageCount) {
    if (!autoRunJobsPager) return;
    autoRunJobsPager.textContent = "";
    if (pageCount <= 1) {
        autoRunJobsPager.style.display = "none";
        return;
    }
    autoRunJobsPager.style.display = "flex";
    for (let i = 0; i < pageCount; i += 1) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "qc-btn autoRunJobsPageBtn";
        if (i === autoRunJobsPageIndex) btn.classList.add("isActive");
        btn.dataset.page = String(i);
        btn.textContent = String(i + 1);
        autoRunJobsPager.appendChild(btn);
    }
}

// Opens the Auto Run jobs view so the user can selectively stop/remove work.
function openAutoRunJobsDialog() {
    dismissFloatingBoxes();
    if (!autoRunJobsView) return;
    autoRunJobsPageIndex = 0;
    renderAutoRunJobsDialog();
    autoRunState.jobsDialogVisible = true;
    autoRunState.jobsDialogCount = getAutoRunTrackedJobCount();
    const mainWrapper = document.querySelector(".wrapper");
    if (mainWrapper) mainWrapper.style.display = "none";
    autoRunJobsView.style.display = "block";
}

// Closes the Auto Run jobs view and restores the main panel.
function closeAutoRunJobsDialog(options = {}) {
    if (!autoRunJobsView) return;
    // A toast or "Clear job list?" confirmation belongs to this view; leaving it closes them
    // (the confirmation is answered with Cancel) so they do not stay over the main panel.
    dismissFloatingBoxes();
    const preserveVisibility = Boolean(options.preserveVisibility);
    autoRunJobsView.style.display = "none";
    const mainWrapper = document.querySelector(".wrapper");
    if (mainWrapper) {
        mainWrapper.style.display = "";
        resetPanelScroll(mainWrapper);
    }
    if (!preserveVisibility) autoRunState.jobsDialogVisible = false;
    // Every other dialog's close function (Settings, RunPod/RunComfy Endpoint Settings) already
    // does this — it was missing here, which is exactly why a server/port popup left open before
    // switching to the Jobs dialog would still be marked "open" and snap back into view at its
    // stale position once this dialog closed and .wrapper reappeared.
    hideServerRecentList();
    hidePortRecentList();
}

// Opens the small Job Log view in place of the Jobs dialog, showing one failed job's captured
// transcript. Swaps with #autoRunJobsView (rather than stacking on top of it) since both are
// full-height sibling panels toggled the same way every other settings view is.
// Tracks which job's log is currently open, so the Save button (added alongside Close) knows
// what to write without needing the job passed back in on every click.
let autoRunJobLogViewJob = null;

function openAutoRunJobLogView(job) {
    dismissFloatingBoxes();
    if (!autoRunJobLogView) return;
    autoRunJobLogViewJob = job || null;
    // Scoped strictly to this one job's own captured transcript (job.logText, built by
    // logForJob() during that job's own execution/resume-tracking) — never the shared terminal
    // or another job's log — so only this job's relevant debug info shows here.
    if (autoRunJobLogSubtitle) {
        autoRunJobLogSubtitle.textContent = describeAutoRunJob(job);
    }
    if (autoRunJobLogText) {
        const text = String(job?.logText || "").trim();
        autoRunJobLogText.textContent = text || String(job?.errorDetail || "").trim() || "No log captured.";
    }
    if (autoRunJobsView) autoRunJobsView.style.display = "none";
    autoRunJobLogView.style.display = "block";
}

// Closes the Job Log view and returns to the Jobs dialog underneath it.
function closeAutoRunJobLogView() {
    dismissFloatingBoxes();
    if (!autoRunJobLogView) return;
    autoRunJobLogViewJob = null;
    autoRunJobLogView.style.display = "none";
    if (autoRunJobsView) autoRunJobsView.style.display = "block";
}

// Saves the currently-open job's log text to a file, mirroring the terminal's Save Logs button
// (saveLogsToFile) but scoped to just this one job's transcript.
async function saveAutoRunJobLogToFile() {
    if (!autoRunJobLogSaveBtn) return;
    const logText = String(autoRunJobLogText?.textContent || "");
    if (!logText.trim()) {
        log("Save Job Log: no log text available to save.");
        return;
    }

    autoRunJobLogSaveBtn.disabled = true;
    try {
        const file = await storage.localFileSystem.getFileForSaving(buildJobLogExportFileName(autoRunJobLogViewJob), { types: ["txt"] });
        if (!file) {
            log("Save Job Log: save dialog canceled.");
            return;
        }
        await file.write(logText);
        log(`Save Job Log: saved ${logText.length} characters to ${file.name || "selected file"}.`);
    } catch (error) {
        log(`Save Job Log error: ${describeError(error)}`);
    } finally {
        autoRunJobLogSaveBtn.disabled = false;
    }
}

// Builds a timestamped filename for a single job's exported log, e.g. quickai_job_12_log_...txt.
function buildJobLogExportFileName(job) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const jobIdPart = Number.isFinite(Number(job?.id)) ? `job_${Number(job.id)}_` : "job_";
    return `quickai_${jobIdPart}log_${stamp}.txt`;
}

// Clears every finished/failed job from the Jobs dialog (after user confirmation), deletes their
// durably-persisted snapshot copies, and re-persists the (now-shorter) job history to disk.
// Active/queued jobs are untouched.
function clearFinishedAutoRunJobs() {
    const jobsToClear = autoRunState.finishedJobs;
    if (jobsToClear.length < 1) return;
    autoRunState.finishedJobs = [];
    renderAutoRunJobsDialog();
    syncAutoRunButtonState();
    log(`Generate queue: cleared ${jobsToClear.length} finished/failed job${jobsToClear.length === 1 ? "" : "s"}.`);
    Promise.all(jobsToClear.map((job) => deleteAutoRunJobSnapshots(job).catch(() => {})))
        .then(() => persistAutoRunJobsToDisk())
        .catch((error) => {
            log(`Generate job persistence warning: ${describeError(error)}`);
        });
}

// Removes a queued job that has not started yet.
function removeQueuedAutoRunJob(jobId) {
    const targetJobId = Number(jobId);
    if (!Number.isFinite(targetJobId)) return false;
    const nextQueue = [];
    let removedJob = null;
    for (let i = 0; i < autoRunState.queuedJobs.length; i += 1) {
        const job = autoRunState.queuedJobs[i];
        if (!removedJob && Number(job?.id) === targetJobId) {
            removedJob = job;
            continue;
        }
        nextQueue.push(job);
    }
    if (!removedJob) return false;
    autoRunState.queuedJobs = nextQueue;
    renderAutoRunJobsDialog();
    syncAutoRunButtonState();
    log(`Generate queue: removed ${describeAutoRunJob(removedJob)}.`);
    deleteAutoRunJobSnapshots(removedJob).catch((error) => {
        log(`Generate job snapshot cleanup warning: ${describeError(error)}`);
    });
    persistAutoRunJobsToDisk().catch((error) => {
        log(`Generate job persistence warning: ${describeError(error)}`);
    });
    if (getAutoRunActiveOrQueuedJobCount() < 1) {
        setAutoRunProgressState({ visible: true, percent: 0, text: "Ready" });
    } else {
        setAutoRunProgressState({
            visible: autoRunState.progressVisible,
            percent: autoRunState.progressPercent,
            text: autoRunState.progressText
        });
    }
    return true;
}

// Removes a finished/failed job that the user dismissed from the Jobs dialog, along with its
// durably-persisted snapshot copies, and re-persists the remaining job history to disk.
function removeFinishedAutoRunJob(jobId) {
    const targetJobId = Number(jobId);
    if (!Number.isFinite(targetJobId)) return false;
    const nextFinished = [];
    let removedJob = null;
    for (let i = 0; i < autoRunState.finishedJobs.length; i += 1) {
        const job = autoRunState.finishedJobs[i];
        if (!removedJob && Number(job?.id) === targetJobId) {
            removedJob = job;
            continue;
        }
        nextFinished.push(job);
    }
    if (!removedJob) return false;
    autoRunState.finishedJobs = nextFinished;
    renderAutoRunJobsDialog();
    syncAutoRunButtonState();
    log(`Generate queue: removed ${describeAutoRunJob(removedJob)}.`);
    deleteAutoRunJobSnapshots(removedJob).catch((error) => {
        log(`Generate job snapshot cleanup warning: ${describeError(error)}`);
    });
    persistAutoRunJobsToDisk().catch((error) => {
        log(`Generate job persistence warning: ${describeError(error)}`);
    });
    return true;
}

// Sends best-effort cancel requests for the currently active job only.
async function requestActiveAutoRunJobStop(job = null) {
    const targetJob = job || autoRunState.activeJob;
    if (!targetJob || targetJob.state !== "running") return;
    targetJob.stopRequested = true;
    syncAutoRunRuntimeStateFromActiveJobs();
    setAutoRunProgressState({ visible: true, text: formatAutoRunProgressLabel("Stopping", { detail: "requested" }) });
    syncAutoRunButtonState();
    renderAutoRunJobsDialog();

    // Keep the dialog open showing "Stopping" for the duration of the cancel
    // requests below, rather than closing immediately and hiding whether the
    // stop actually succeeded — closing early made cancellation feel like it
    // hung, since the requests were still in flight with nothing shown. The
    // dialog also stays open once the stop completes, even if this was the last
    // tracked job — the user opened the Jobs dialog on purpose and shouldn't be
    // kicked back to the main panel just because nothing is left to show.
    try {
        await requestActiveAutoRunJobStopNetworkCalls(targetJob);
    } finally {
        renderAutoRunJobsDialog();
        syncAutoRunButtonState();
    }
}

// Performs the actual backend cancel/interrupt network calls for a stop request.
async function requestActiveAutoRunJobStopNetworkCalls(targetJob) {
    const promptIds = Array.isArray(targetJob.promptIds) ? [...targetJob.promptIds] : [];
    if (targetJob.useRunComfy) {
        const deploymentId = String(
            targetJob.backendOptions?.runComfyDeploymentId
            || targetJob.runComfyDeploymentId
            || getRunComfyDeploymentId()
            || ""
        ).trim();
        const targetPromptIds = promptIds.map((id) => String(id || "").trim()).filter(Boolean);
        if (!deploymentId || targetPromptIds.length < 1) return;
        for (const promptId of targetPromptIds) {
            try {
                const cancelResponse = await fetch(
                    runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}/requests/${encodeURIComponent(promptId)}/cancel`),
                    {
                        method: "POST",
                        headers: buildRunComfyRequestHeaders({ includeJsonContentType: true }),
                        body: JSON.stringify({})
                    }
                );
                if (!cancelResponse.ok) {
                    let detail = "";
                    try { detail = await cancelResponse.text(); } catch (_e) {}
                    log(`Generate stop: RunComfy cancel failed ${cancelResponse.status}${detail ? `: ${detail}` : ""}.`);
                } else {
                    log(`Generate stop: requested RunComfy cancel for ${promptId}.`);
                }
            } catch (error) {
                log(`Generate stop: RunComfy cancel request failed: ${describeError(error)}`);
            }
        }
        return;
    }
    if (targetJob.useRunPod) {
        const endpointId = String(
            targetJob.backendOptions?.runPodEndpointId
            || targetJob.runPodEndpointId
            || getRunPodEndpointId()
            || ""
        ).trim();
        const targetPromptIds = promptIds.map((id) => String(id || "").trim()).filter(Boolean);
        if (!endpointId || targetPromptIds.length < 1) return;
        for (const promptId of targetPromptIds) {
            try {
                const cancelResponse = await fetch(
                    runPodEndpointApiUrl(endpointId, `/cancel/${encodeURIComponent(promptId)}`),
                    {
                        method: "POST",
                        headers: buildRunPodRequestHeaders()
                    }
                );
                if (!cancelResponse.ok) {
                    let detail = "";
                    try { detail = await cancelResponse.text(); } catch (_e) {}
                    log(`Generate stop: RunPod cancel failed ${cancelResponse.status}${detail ? `: ${detail}` : ""}.`);
                } else {
                    log(`Generate stop: requested RunPod cancel for ${promptId}.`);
                }
            } catch (error) {
                log(`Generate stop: RunPod cancel request failed: ${describeError(error)}`);
            }
        }
        return;
    }

    if (!targetJob.useCloud) {
        const targetPromptIds = promptIds.map((id) => String(id || "").trim()).filter(Boolean);
        const targetPromptIdSet = new Set(targetPromptIds);
        const localBackendOptions = targetJob.backendOptions || {};
        if (targetPromptIdSet.size > 0) {
            let queueData = null;
            try {
                const queueResponse = await fetch(comfyApiUrl("/queue", localBackendOptions));
                if (queueResponse.ok) queueData = await queueResponse.json();
            } catch (_e) {}

            const getPromptIdFromQueueItem = (item) => {
                if (Array.isArray(item) && item.length > 1) return String(item[1] || "").trim();
                if (item && typeof item === "object") {
                    if (item.prompt_id !== undefined && item.prompt_id !== null) return String(item.prompt_id).trim();
                    if (item.promptId !== undefined && item.promptId !== null) return String(item.promptId).trim();
                    if (item.id !== undefined && item.id !== null) return String(item.id).trim();
                }
                return "";
            };
            const runningItems = Array.isArray(queueData?.queue_running) ? queueData.queue_running : [];
            const pendingItems = Array.isArray(queueData?.queue_pending) ? queueData.queue_pending : [];

            let shouldInterruptRunningPrompt = false;
            const pendingPromptIdsToDelete = [];
            for (let i = 0; i < runningItems.length; i += 1) {
                const runningPromptId = getPromptIdFromQueueItem(runningItems[i]);
                if (runningPromptId && targetPromptIdSet.has(runningPromptId)) {
                    shouldInterruptRunningPrompt = true;
                    break;
                }
            }
            for (let i = 0; i < pendingItems.length; i += 1) {
                const pendingPromptId = getPromptIdFromQueueItem(pendingItems[i]);
                if (pendingPromptId && targetPromptIdSet.has(pendingPromptId)) {
                    pendingPromptIdsToDelete.push(pendingPromptId);
                }
            }
            if (pendingPromptIdsToDelete.length > 0) {
                try {
                    await fetch(comfyApiUrl("/queue", localBackendOptions), {
                        method: "POST",
                        headers: buildComfyRequestHeaders({
                            useCloud: false,
                            includeJsonContentType: true
                        }),
                        body: JSON.stringify({ delete: pendingPromptIdsToDelete })
                    });
                } catch (_e) {}
            }
            if (shouldInterruptRunningPrompt) {
                try {
                    await fetch(comfyApiUrl("/interrupt", localBackendOptions), {
                        method: "POST",
                        headers: buildComfyRequestHeaders({
                            useCloud: false,
                            includeJsonContentType: true
                        }),
                        body: JSON.stringify({})
                    });
                } catch (_e) {}
            }
        }
        return;
    }

    const targetPromptIds = promptIds.map((id) => String(id || "").trim()).filter(Boolean);
    if (targetPromptIds.length < 1) {
        log("Generate stop: no queued Comfy Cloud prompt id is available yet.");
        return;
    }

    const cloudStatusByPromptId = new Map();
    for (const promptId of targetPromptIds) {
        try {
            const statusResponse = await fetch(
                comfyApiUrl(`/api/job/${encodeURIComponent(String(promptId))}/status`, targetJob.backendOptions || { useCloud: true }),
                { headers: buildComfyRequestHeaders({ useCloud: true }) }
            );
            if (!statusResponse.ok) continue;
            const statusData = await statusResponse.json();
            const status = String(statusData?.status || "").toLowerCase().trim() || "unknown";
            cloudStatusByPromptId.set(promptId, status);
        } catch (_e) {}
    }
    const hasPluginRunningPrompt = targetPromptIds.some((promptId) => {
        const status = cloudStatusByPromptId.get(promptId) || "";
        return status === "running" || status === "in_progress";
    });

    try {
        const queueCancelResponse = await fetch(
            comfyApiUrl("/api/queue", targetJob.backendOptions || { useCloud: true }),
            {
                method: "POST",
                headers: buildComfyRequestHeaders({
                    useCloud: true,
                    includeJsonContentType: true
                }),
                body: JSON.stringify({ delete: targetPromptIds })
            }
        );
        if (queueCancelResponse.ok) {
            log(`Generate stop: requested Comfy Cloud pending-job cancel for ${targetPromptIds.length} prompt(s).`);
        } else {
            let detail = "";
            try { detail = await queueCancelResponse.text(); } catch (_e) {}
            log(`Generate stop: Comfy Cloud pending cancel failed ${queueCancelResponse.status}${detail ? `: ${detail}` : ""}.`);
        }
    } catch (error) {
        log(`Generate stop: Comfy Cloud pending cancel request failed: ${describeError(error)}`);
    }

    if (hasPluginRunningPrompt) {
        try {
            const interruptResponse = await fetch(
                comfyApiUrl("/api/interrupt", targetJob.backendOptions || { useCloud: true }),
                {
                    method: "POST",
                    headers: buildComfyRequestHeaders({
                        useCloud: true,
                        includeJsonContentType: true
                    }),
                    body: JSON.stringify({})
                }
            );
            if (interruptResponse.ok) {
                log("Generate stop: requested Comfy Cloud running-job interrupt.");
            } else {
                let detail = "";
                try { detail = await interruptResponse.text(); } catch (_e) {}
                log(`Generate stop: Comfy Cloud interrupt failed ${interruptResponse.status}${detail ? `: ${detail}` : ""}.`);
            }
        } catch (error) {
            log(`Generate stop: Comfy Cloud interrupt request failed: ${describeError(error)}`);
        }
    } else {
        log("Generate stop: skipped Comfy Cloud interrupt because plugin prompt is not currently running.");
    }
}

// Opens the queue-management dialog when at least one Auto Run job exists.
async function requestAutoRunStop() {
    if (getAutoRunTrackedJobCount() < 1) return;
    openAutoRunJobsDialog();
}

// Handles coerce auto run value.
function coerceAutoRunValue(rawValue, dataTypeRaw) {
    const dataType = String(dataTypeRaw || "string").trim().toLowerCase();
    const text = String(rawValue ?? "").trim();
    if (!text) return "";

    if (dataType === "integer" || dataType === "int") {
        const n = Number.parseInt(text, 10);
        return Number.isFinite(n) ? n : text;
    }
    if (
        dataType === "number"
        || dataType === "float"
        || dataType === "double"
        || dataType === "decimal"
    ) {
        const n = Number.parseFloat(text);
        return Number.isFinite(n) ? n : text;
    }
    if (dataType === "boolean" || dataType === "bool") {
        if (/^(true|1|yes|on)$/i.test(text)) return true;
        if (/^(false|0|no|off)$/i.test(text)) return false;
    }
    return text;
}

// Collects and type-coerces workflow parameter values from the Auto Run form.
function collectAutoRunParameterValues() {
    const out = {};
    if (!nanoBananaForm) return out;

    const controls = nanoBananaForm.querySelectorAll("[data-param-name]");
    controls.forEach((el) => {
        const name = String(el.getAttribute("data-param-name") || "").trim();
        const key = String(el.getAttribute("data-param-key") || name).trim();
        if (!name) return;
        const dataType = String(el.getAttribute("data-param-data-type") || "string");
        const isCheckboxWrapper = String(el.getAttribute("data-param-type") || "").toLowerCase() === "checkbox";
        const isReferenceListControl = String(el.getAttribute("data-param-type") || "").toLowerCase() === "reference_list";
        if (isCheckboxWrapper) {
            const checkbox = el.querySelector('input[type="checkbox"][data-param-checkbox="true"]');
            out[key] = Boolean(checkbox && checkbox.checked);
            return;
        }
        if (isReferenceListControl) {
            out[key] = parseReferenceListValue(el.getAttribute("data-reference-items"));
            return;
        }
        const rawValue = "value" in el ? el.value : "";
        out[key] = coerceAutoRunValue(rawValue, dataType);
    });
    return out;
}

// Reads a checkbox parameter wrapper value directly from the live Auto Run form by param key.
function getAutoRunCheckboxValueByParamKey(paramKey) {
    if (!nanoBananaForm) return null;
    const key = String(paramKey || "").trim();
    if (!key) return null;
    const control = nanoBananaForm.querySelector(`[data-param-key="${key}"][data-param-type="checkbox"]`);
    if (!control) return null;
    const checkbox = control.querySelector('input[type="checkbox"][data-param-checkbox="true"]');
    if (!checkbox) return null;
    return Boolean(checkbox.checked);
}

// Reads the "Scale Down Additional Inputs (Faster)" checkbox's live value from the Auto Run
// form (see its synthesis in parseNanoBananaYaml). Defaults to true when the control isn't
// rendered (e.g. the selected workflow declares no inputs at all), matching the checkbox's own
// default, so callers never need to special-case its absence.
function shouldScaleDownAdditionalInputs() {
    if (!nanoBananaForm) return true;
    const control = nanoBananaForm.querySelector('[data-param-name="scale_down_additional_inputs"][data-param-type="checkbox"]');
    if (!control) return true;
    // For single-input workflows the checkbox's own field is hidden (see
    // syncMainInputModeToReferenceList) since there's nothing "additional" to scale — but a
    // single declared input can still route through this same export pipeline when Main Input
    // is set to MAIN_INPUT_MODE_MANUAL. With no visible/reachable checkbox to say otherwise,
    // that manually-attached main input should behave like every other main-input mode and
    // never be scaled down, rather than silently inheriting the checkbox's hidden default.
    const field = control.closest(".dynamicField");
    if (field && field.classList.contains("isHidden")) return false;
    const checkbox = control.querySelector('input[type="checkbox"][data-param-checkbox="true"]');
    if (!checkbox) return true;
    return Boolean(checkbox.checked);
}

// Parses persisted checkbox-like values explicitly, avoiding truthy string coercion bugs.
function parseAutoRunBooleanValue(rawValue, fallback = false) {
    if (rawValue === null || rawValue === undefined) return fallback;
    if (typeof rawValue === "boolean") return rawValue;
    if (typeof rawValue === "number") return rawValue !== 0;
    const normalized = String(rawValue).trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
    return fallback;
}

// Collects raw string form values for sticky-setting persistence without coercion.
function collectAutoRunParameterRawValues() {
    const out = {};
    if (!nanoBananaForm) return out;
    const controls = nanoBananaForm.querySelectorAll("[data-param-name]");
    controls.forEach((el) => {
        const name = String(el.getAttribute("data-param-name") || "").trim();
        const key = String(el.getAttribute("data-param-key") || name).trim();
        if (!name) return;
        const isCheckboxWrapper = String(el.getAttribute("data-param-type") || "").toLowerCase() === "checkbox";
        const isReferenceListControl = String(el.getAttribute("data-param-type") || "").toLowerCase() === "reference_list";
        if (isCheckboxWrapper) {
            const checkbox = el.querySelector('input[type="checkbox"][data-param-checkbox="true"]');
            out[key] = checkbox && checkbox.checked ? "true" : "false";
            return;
        }
        if (isReferenceListControl) {
            // References list is intentionally non-sticky: skip persistence so reload resets it.
            return;
        }
        const rawValue = "value" in el ? el.value : "";
        out[key] = String(rawValue ?? "");
    });
    return out;
}

// Applies persisted per-workflow values back into rendered parameter inputs.
function applyWorkflowStickyValuesToForm(stickyValues) {
    if (!nanoBananaForm || !stickyValues || typeof stickyValues !== "object") return;
    const controls = nanoBananaForm.querySelectorAll("[data-param-name]");
    controls.forEach((el) => {
        const name = String(el.getAttribute("data-param-name") || "").trim();
        const key = String(el.getAttribute("data-param-key") || name).trim();
        if (!name || !Object.prototype.hasOwnProperty.call(stickyValues, key)) return;
        const nextValue = String(stickyValues[key] ?? "");
        const isCheckboxWrapper = String(el.getAttribute("data-param-type") || "").toLowerCase() === "checkbox";
        const isReferenceListControl = String(el.getAttribute("data-param-type") || "").toLowerCase() === "reference_list";
        if (isCheckboxWrapper) {
            const checkbox = el.querySelector('input[type="checkbox"][data-param-checkbox="true"]');
            if (checkbox) checkbox.checked = /^(true|1|yes|on)$/i.test(nextValue);
            return;
        }
        if (isReferenceListControl) {
            // References list is intentionally non-sticky: ignore saved values on load.
            return;
        }
        if (el.tagName === "SELECT") {
            const select = el;
            let hasOption = false;
            let matchedValue = nextValue;
            for (let i = 0; i < select.options.length; i += 1) {
                const opt = select.options[i];
                if (opt.value === nextValue || opt.textContent === nextValue) {
                    hasOption = true;
                    matchedValue = opt.value;
                    break;
                }
            }
            if (!hasOption) {
                const optionEl = document.createElement("option");
                optionEl.value = nextValue;
                optionEl.textContent = nextValue;
                select.appendChild(optionEl);
            }
            el.value = matchedValue;
            return;
        }
        el.value = nextValue;
    });
}

// Applies YAML defaults to currently selected workflow controls and persists those values.
async function resetSelectedWorkflowParametersToDefaults() {
    if (!nanoBananaForm) return;
    const selectedConfig = getWorkflowConfigById(autoRunState.selectedWorkflow);
    if (!selectedConfig) return;

    const defaultValues = {};
    for (const def of autoRunState.parameterDefs) {
        if (!def || typeof def !== "object") continue;
        const type = String(def.type || "").trim().toLowerCase();
        if (type === "section_title" || type === "section_divider") continue;
        const key = String(def.key || def.name || "").trim();
        if (!key) continue;
        const defaultValue = def.default;
        defaultValues[key] = defaultValue === null || defaultValue === undefined
            ? ""
            : String(defaultValue);
    }

    applyWorkflowStickyValuesToForm(defaultValues);
    // applyWorkflowStickyValuesToForm sets the Main Input dropdown's .value directly without
    // dispatching "change", so the Inputs box needs an explicit nudge to reflect a reset mode —
    // same reason loadSelectedWorkflowParameters needs this call after restoring sticky values.
    syncMainInputModeToReferenceList();
    await persistWorkflowIniSettings(getWorkflowPathKey(selectedConfig), collectAutoRunParameterRawValues());
    log(`Generate defaults: restored ${Object.keys(defaultValues).length} value(s) for ${selectedConfig.displayName || selectedConfig.folderName}.`);
}

// Attaches input listeners that persist sticky values as users edit parameters.
function wireWorkflowStickySaveListeners(folderName) {
    if (!nanoBananaForm || !folderName) return;
    const controls = nanoBananaForm.querySelectorAll("[data-param-name]");
    controls.forEach((el) => {
        const saveNow = () => {
            const rawValues = collectAutoRunParameterRawValues();
            persistWorkflowIniSettings(folderName, rawValues).catch((error) => {
                log(`Generate workflow settings save error (${folderName}): ${describeError(error)}`);
            });
        };
        el.addEventListener("input", saveNow);
        el.addEventListener("change", saveNow);
    });
}

// Validates auto run parameter values.
function validateAutoRunParameterValues(parameterValues) {
    // Intentionally allow empty prompt values for promptless workflows.
    return parameterValues;
}

// Blocks sending the job when a slot declared "required" in the "input:" tuple (see
// parseWorkflowInputTuplesToken) has no content attached. The main slot (index 0) is only
// checkable here when Main Input is set to MAIN_INPUT_MODE_MANUAL — in Current Canvas / Selected
// Layer And Below it always produces something as long as a document is open, so a required
// main slot in those modes is a no-op by design, not something this needs to enforce.
// Workflows that combine every declared slot through a single downstream node (e.g. Nano Banana
// Pro's ImpactMakeImageBatch) don't need a "must send at least one image" check here — an empty
// combine node is stripped from the prompt entirely at send time instead, see
// removeEmptyImpactMakeImageBatchNodes.
function validateAutoRunRequiredInputs(workflowNodeTargets, parameterDefs, parameterValues, mainInputMode) {
    const declaredInputs = Array.isArray(workflowNodeTargets?.inputs) ? workflowNodeTargets.inputs : [];
    if (declaredInputs.length === 0) return;

    const additionalInputsParamDef = parameterDefs.find((p) => String(p?.type || "").toLowerCase() === "reference_list");
    const referenceLimit = additionalInputsParamDef
        ? Math.max(0, Number.parseInt(String(additionalInputsParamDef.referenceLimit || "0"), 10) || 0)
        : 0;
    const rawItems = additionalInputsParamDef && Array.isArray(parameterValues[additionalInputsParamDef.key])
        ? parameterValues[additionalInputsParamDef.key]
        : [];

    const missing = [];
    if (mainInputMode === MAIN_INPUT_MODE_MANUAL && Boolean(declaredInputs[0]?.required)) {
        const mainItem = rawItems[referenceLimit];
        if (!mainItem || !mainItem.layerId) {
            missing.push(String(declaredInputs[0]?.label || "").trim() || "Main Input");
        }
    }
    for (let i = 0; i < referenceLimit; i += 1) {
        const slot = declaredInputs[i + 1];
        if (!slot?.required) continue;
        const item = rawItems[i];
        if (!item || !item.layerId) {
            missing.push(String(slot?.label || "").trim() || `Image ${i + 1}`);
        }
    }

    if (missing.length > 0) {
        throw new Error(`Missing required input${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
    }
}

// Applies one parameter value into matching workflow JSON node input fields.
function applyValueToWorkflowNodes(workflowPrompt, paramName, value, options = {}) {
    const classTypeFilter = String(options.classTypeFilter || "").trim();
    const nodeIdFilter = String(options.nodeIdFilter || "").trim();
    let count = 0;
    for (const [nodeId, node] of Object.entries(workflowPrompt || {})) {
        if (!node || typeof node !== "object") continue;
        if (nodeIdFilter && String(nodeId) !== nodeIdFilter) continue;
        if (!nodeIdFilter && classTypeFilter && node.class_type !== classTypeFilter) continue;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        if (!Object.prototype.hasOwnProperty.call(inputs, paramName)) continue;
        inputs[paramName] = value;
        count += 1;
    }
    return count;
}

// Finds a likely passthrough link source for a node by preferring image-like inputs first.
function resolvePreferredInputLink(node) {
    const inputs = node && typeof node === "object" ? node.inputs : null;
    if (!inputs || typeof inputs !== "object") return null;
    const preferredKeys = ["image", "samples", "latent", "value", "pixels", "model", "conditioning", "clip"];
    for (let i = 0; i < preferredKeys.length; i += 1) {
        const key = preferredKeys[i];
        const value = inputs[key];
        if (Array.isArray(value) && value.length >= 2) return [String(value[0]), Number(value[1]) || 0];
    }
    for (const value of Object.values(inputs)) {
        if (Array.isArray(value) && value.length >= 2) return [String(value[0]), Number(value[1]) || 0];
    }
    return null;
}

// Returns ordered upstream node ids for a workflow node by favoring mask/image-like inputs first.
function getWorkflowNodeInputSourceIds(node, preferredKeys = []) {
    const inputs = node && typeof node === "object" ? node.inputs : null;
    if (!inputs || typeof inputs !== "object") return [];
    const orderedKeys = [];
    const seenKeys = new Set();
    const pushKey = (key) => {
        const normalizedKey = String(key || "").trim();
        if (!normalizedKey || seenKeys.has(normalizedKey)) return;
        seenKeys.add(normalizedKey);
        orderedKeys.push(normalizedKey);
    };
    for (let i = 0; i < preferredKeys.length; i += 1) pushKey(preferredKeys[i]);
    for (const key of Object.keys(inputs)) pushKey(key);

    const sourceIds = [];
    const seenSourceIds = new Set();
    for (let i = 0; i < orderedKeys.length; i += 1) {
        const value = inputs[orderedKeys[i]];
        if (!Array.isArray(value) || value.length < 2) continue;
        const sourceNodeId = normalizeWorkflowNodeId(value[0]);
        if (!sourceNodeId || seenSourceIds.has(sourceNodeId)) continue;
        seenSourceIds.add(sourceNodeId);
        sourceIds.push(sourceNodeId);
    }
    return sourceIds;
}

// Resolves fallback result node ids for output_mask by walking upstream from preview/passthrough nodes.
function resolveWorkflowOutputMaskResultNodeIds(workflowPrompt, exportMaskNodeIds, options = {}) {
    if (!workflowPrompt || typeof workflowPrompt !== "object") return [];
    const startNodeIds = Array.from(new Set(
        (Array.isArray(exportMaskNodeIds) ? exportMaskNodeIds : [exportMaskNodeIds])
            .map((id) => normalizeWorkflowNodeId(id))
            .filter(Boolean)
    ));
    if (startNodeIds.length < 1) return [];

    const preferredKeys = Array.isArray(options.preferredKeys) && options.preferredKeys.length > 0
        ? options.preferredKeys
        : ["mask", "alpha", "image", "samples", "latent", "value", "pixels"];
    const maxDepth = Math.max(1, Number.parseInt(String(options.maxDepth || "4"), 10) || 4);
    const resolved = [];
    const seenResolved = new Set();
    const visited = new Set();
    const queue = startNodeIds.map((nodeId) => ({ nodeId, depth: 0 }));

    while (queue.length > 0) {
        const current = queue.shift();
        const nodeId = normalizeWorkflowNodeId(current?.nodeId);
        const depth = Number(current?.depth) || 0;
        if (!nodeId || visited.has(nodeId)) continue;
        visited.add(nodeId);

        if (!seenResolved.has(nodeId)) {
            seenResolved.add(nodeId);
            resolved.push(nodeId);
        }

        if (depth >= maxDepth) continue;
        const node = workflowPrompt[nodeId];
        const upstreamNodeIds = getWorkflowNodeInputSourceIds(node, preferredKeys);
        for (let i = 0; i < upstreamNodeIds.length; i += 1) {
            const upstreamNodeId = upstreamNodeIds[i];
            if (!upstreamNodeId || visited.has(upstreamNodeId)) continue;
            queue.push({ nodeId: upstreamNodeId, depth: depth + 1 });
        }
    }

    return resolved;
}

// Rewrites downstream prompt links from one node id to a replacement link tuple.
function rewriteWorkflowPromptNodeLinks(workflowPrompt, fromNodeId, replacementLink) {
    let rewired = 0;
    for (const node of Object.values(workflowPrompt || {})) {
        if (!node || typeof node !== "object") continue;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        for (const [inputKey, inputValue] of Object.entries(inputs)) {
            if (!Array.isArray(inputValue) || inputValue.length < 2) continue;
            if (String(inputValue[0]) !== String(fromNodeId)) continue;
            const replacementSlot = Number(replacementLink[1]) || 0;
            inputs[inputKey] = [String(replacementLink[0]), replacementSlot];
            rewired += 1;
        }
    }
    return rewired;
}

// Counts how many input links still reference the given source node id.
// Optionally ignores references that originate from nodes scheduled for deletion.
function countWorkflowPromptInputReferences(workflowPrompt, sourceNodeId, ignoreReferencingNodeIds = null) {
    const ignoreSet = ignoreReferencingNodeIds instanceof Set
        ? ignoreReferencingNodeIds
        : new Set(Array.isArray(ignoreReferencingNodeIds) ? ignoreReferencingNodeIds.map((id) => String(id)) : []);
    let count = 0;
    for (const [nodeId, node] of Object.entries(workflowPrompt || {})) {
        if (ignoreSet.has(String(nodeId))) continue;
        if (!node || typeof node !== "object") continue;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        for (const inputValue of Object.values(inputs)) {
            if (!Array.isArray(inputValue) || inputValue.length < 2) continue;
            if (String(inputValue[0]) === String(sourceNodeId)) count += 1;
        }
    }
    return count;
}

// Finds first(group entry) and last(group exit) nodes for a bypass group and the external source link.
function resolveBypassGroupEndpoints(workflowPrompt, groupNodeIds) {
    const groupSet = new Set(groupNodeIds.map((id) => String(id)));
    const incoming = new Map();
    const outgoing = new Map();
    for (const id of groupSet.values()) {
        incoming.set(id, []);
        outgoing.set(id, []);
    }
    for (const [nodeId, node] of Object.entries(workflowPrompt || {})) {
        if (!node || typeof node !== "object") continue;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        for (const [inputName, inputValue] of Object.entries(inputs)) {
            if (!Array.isArray(inputValue) || inputValue.length < 2) continue;
            const srcId = String(inputValue[0]);
            const edge = { from: srcId, to: String(nodeId), inputName, slot: Number(inputValue[1]) || 0 };
            if (groupSet.has(String(nodeId))) incoming.get(String(nodeId)).push(edge);
            if (groupSet.has(srcId)) outgoing.get(srcId).push(edge);
        }
    }

    const entryCandidates = [];
    const exitCandidates = [];
    for (const id of groupSet.values()) {
        const inEdges = incoming.get(id) || [];
        const outEdges = outgoing.get(id) || [];
        const hasExternalIn = inEdges.some((e) => !groupSet.has(e.from));
        const hasExternalOut = outEdges.some((e) => !groupSet.has(e.to));
        if (hasExternalIn) entryCandidates.push(id);
        if (hasExternalOut) exitCandidates.push(id);
    }
    if (entryCandidates.length < 1 || exitCandidates.length < 1) return null;

    const firstNodeId = entryCandidates[0];
    const lastNodeId = exitCandidates[0];
    const firstNode = workflowPrompt[firstNodeId];
    const sourceLink = resolvePreferredInputLink(firstNode);
    if (!sourceLink) return null;
    return { firstNodeId, lastNodeId, sourceLink };
}

// Removes a node from the workflow prompt and scrubs any other node's input that linked to
// its output, so deleting an unused optional loader never leaves a dangling ["nodeId", n] link.
function deleteWorkflowNodeAndReferences(workflowPrompt, nodeId) {
    const targetId = String(nodeId || "").trim();
    if (!targetId || !workflowPrompt || typeof workflowPrompt !== "object") return;
    delete workflowPrompt[targetId];
    for (const node of Object.values(workflowPrompt)) {
        const inputs = node && typeof node === "object" ? node.inputs : null;
        if (!inputs || typeof inputs !== "object") continue;
        for (const [inputName, value] of Object.entries(inputs)) {
            if (Array.isArray(value) && String(value[0]) === targetId) {
                delete inputs[inputName];
            }
        }
    }
}

// Some workflows (e.g. Nano Banana Pro) combine every declared image slot through a single
// ImpactMakeImageBatch node before feeding it onward. That node's implementation indexes into
// the combined batch unconditionally, so it crashes deep in ComfyUI ("list index out of range")
// if every one of its image-link inputs got scrubbed by deleteWorkflowNodeAndReferences (i.e.
// none of that node's declared slots — main or additional — had anything attached this run).
// Rather than block sending in that case, treat the batch node itself the same way an unfilled
// loader is treated: remove it too, cascading to scrub its own output link from whatever
// consumes it, so the prompt stays structurally valid and simply runs without any of those
// images (e.g. Nano Banana Pro falls back to pure text-to-image).
function removeEmptyImpactMakeImageBatchNodes(workflowPrompt) {
    if (!workflowPrompt || typeof workflowPrompt !== "object") return;
    for (const [nodeId, node] of Object.entries(workflowPrompt)) {
        if (!node || typeof node !== "object") continue;
        if (String(node.class_type || "") !== "ImpactMakeImageBatch") continue;
        const inputs = node.inputs && typeof node.inputs === "object" ? node.inputs : {};
        const hasAnyImageLink = Object.values(inputs).some((value) => Array.isArray(value));
        if (!hasAnyImageLink) {
            deleteWorkflowNodeAndReferences(workflowPrompt, nodeId);
        }
    }
}

// Builds the final workflow prompt JSON by injecting uploaded image and parameter values.
async function buildAutoRunPrompt(config, uploadedImageName, parameterValues, workflowNodeTargets = {}, options = {}) {
    const parameterDefs = Array.isArray(options.parameterDefs) ? options.parameterDefs : autoRunState.parameterDefs;
    // 1) Load and parse workflow JSON template from the selected workflow folder.
    const workflowText = await readWorkflowJsonText(config);
    let workflowPrompt = null;
    try {
        workflowPrompt = JSON.parse(workflowText);
    } catch (error) {
        throw new Error(`Invalid workflow JSON (${config.jsonFileName}): ${describeError(error)}`);
    }
    if (!workflowPrompt || typeof workflowPrompt !== "object") {
        throw new Error(`Workflow JSON ${config.jsonFileName} is empty or invalid.`);
    }

    // 2) Replace each declared input slot's upload field so the workflow consumes the
    // uploaded Photoshop asset. No declared input slots (no "input:" token in the YAML)
    // means this workflow takes no image — skip scanning the graph entirely and send it
    // with only the user's parameters.
    //
    // The first declared slot is the "main" input and always receives the automatic
    // Photoshop view/selection snapshot (uploadedImageName) — this is the same behavior
    // the old single "input:" node had. Any further declared slots are optional: they only
    // receive an asset if the caller supplied one for that slot this run
    // (options.uploadedAdditionalInputs, keyed by slot index starting at 1). A slot left
    // undefined for this run has its loader node deleted from the prompt entirely, along
    // with any dangling link on whatever downstream node consumed its output, so the
    // queued prompt stays structurally valid.
    const inputSlots = Array.isArray(workflowNodeTargets.inputs) ? workflowNodeTargets.inputs : [];
    const uploadedAdditionalInputs = (options.uploadedAdditionalInputs && typeof options.uploadedAdditionalInputs === "object")
        ? options.uploadedAdditionalInputs
        : {};
    for (let slotIndex = 0; slotIndex < inputSlots.length; slotIndex += 1) {
        const slot = inputSlots[slotIndex];
        const nodeId = normalizeWorkflowNodeId(slot?.nodeId);
        const inputName = String(slot?.inputName || "image").trim();
        if (!nodeId) continue;
        const isMainSlot = slotIndex === 0;
        const uploadedValue = isMainSlot ? String(uploadedImageName || "").trim() : String(uploadedAdditionalInputs[slotIndex] || "").trim();

        if (uploadedValue) {
            const node = workflowPrompt[nodeId];
            const inputs = node && typeof node === "object" ? node.inputs : null;
            if (!node || typeof node !== "object" || !inputs || typeof inputs !== "object" || !Object.prototype.hasOwnProperty.call(inputs, inputName)) {
                throw new Error(`Workflow ${config.jsonFileName} input node ${nodeId} was not found or has no "${inputName}" input.`);
            }
            inputs[inputName] = uploadedValue;
        } else {
            // Previously the main slot (index 0) was left untouched here even when empty, since
            // it always received an automatic canvas capture in practice. MAIN_INPUT_MODE_MANUAL
            // can now legitimately leave it empty too (no layer attached) — treat it the same as
            // any other unfilled slot and remove its loader, rather than sending a stale/blank
            // upload value.
            deleteWorkflowNodeAndReferences(workflowPrompt, nodeId);
        }
    }
    removeEmptyImpactMakeImageBatchNodes(workflowPrompt);

    // 4) Apply UI parameter values into workflow node inputs using each parameter's owning node_id/class_type block.
    for (const def of parameterDefs) {
        const name = String(def?.name || "").trim();
        const key = String(def?.key || name).trim();
        const nodeIdFilter = String(def?.node_id || def?.nodeId || "").trim();
        const classTypeFilter = String(def?.class_type || "").trim();
        if (!name) continue;
        if (!Object.prototype.hasOwnProperty.call(parameterValues, key)) continue;
        const value = parameterValues[key];
        const isPromptParam = name.toLowerCase() === "prompt";
        if (typeof value === "string" && value === "" && !isPromptParam) continue;

        let applied = applyValueToWorkflowNodes(workflowPrompt, name, value, {
            nodeIdFilter,
            classTypeFilter
        });
        if (applied === 0 && nodeIdFilter) {
            applied = applyValueToWorkflowNodes(workflowPrompt, name, value, {
                classTypeFilter
            });
        }
        if (applied === 0 && classTypeFilter) {
            applied = applyValueToWorkflowNodes(workflowPrompt, name, value, {});
        }
    }

    // 6) Apply bypass groups chosen in the Auto Run form (first->last group rewiring strategy).
    const bypassGroups = Array.isArray(workflowNodeTargets.bypassGroups) ? workflowNodeTargets.bypassGroups : [];
    const bypassToggleValues = (options.bypassToggleValues && typeof options.bypassToggleValues === "object")
        ? options.bypassToggleValues
        : {};
    const bypassedNodeIds = [];
    const removedNodeIds = [];
    const bypassRewireStats = [];
    const bypassGroupDecisions = [];
    for (let i = 0; i < bypassGroups.length; i += 1) {
        const group = bypassGroups[i] || {};
        const groupKey = String(group.key || `bypass_group_${i + 1}`).trim();
        const groupLabel = String(group.label || `Bypass Group ${i + 1}`).trim();
        const groupDefault = parseAutoRunBooleanValue(group.default, false);
        const enabled = Object.prototype.hasOwnProperty.call(bypassToggleValues, groupKey)
            ? Boolean(bypassToggleValues[groupKey])
            : groupDefault;
        const trueMeansBypass = parseAutoRunBooleanValue(group.trueMeansBypass, true);
        const shouldBypass = trueMeansBypass ? enabled : !enabled;
        bypassGroupDecisions.push({
            groupKey,
            groupLabel,
            enabled,
            groupDefault,
            trueMeansBypass,
            shouldBypass
        });
        if (!shouldBypass) continue;
        const nodeIds = Array.from(new Set((Array.isArray(group.nodes) ? group.nodes : [])
            .map((nodeId) => normalizeWorkflowNodeId(nodeId))
            .filter(Boolean)));
        if (nodeIds.length < 1) continue;
        const endpoints = resolveBypassGroupEndpoints(workflowPrompt, nodeIds);
        if (!endpoints) {
            throw new Error(
                `Workflow ${config.jsonFileName} bypass group "${groupLabel}" could not resolve first/last nodes for rewiring.`
            );
        }
        const { firstNodeId, lastNodeId, sourceLink } = endpoints;
        const rewiredCount = rewriteWorkflowPromptNodeLinks(workflowPrompt, lastNodeId, sourceLink);
        bypassRewireStats.push({
            group: groupLabel,
            firstNodeId,
            lastNodeId,
            from: lastNodeId,
            to: String(sourceLink[0]),
            rewiredCount
        });
        for (let nodeIndex = 0; nodeIndex < nodeIds.length; nodeIndex += 1) {
            const nodeId = nodeIds[nodeIndex];
            const node = workflowPrompt[nodeId];
            if (!node || typeof node !== "object") {
                throw new Error(`Workflow ${config.jsonFileName} bypass group "${groupLabel}" node ${nodeId} was not found.`);
            }
            bypassedNodeIds.push(nodeId);
        }
    }

    // Remove bypassed nodes from the prompt after rewiring so they no longer appear in the queued graph.
    const bypassedNodeIdSet = new Set(Array.from(new Set(bypassedNodeIds)).map((id) => String(id)));
    for (const nodeId of bypassedNodeIdSet.values()) {
        const remainingRefs = countWorkflowPromptInputReferences(workflowPrompt, nodeId, bypassedNodeIdSet);
        if (remainingRefs > 0) {
            throw new Error(
                `Workflow ${config.jsonFileName} bypass node ${nodeId} still has ${remainingRefs} downstream reference(s) after rewiring.`
            );
        }
        if (Object.prototype.hasOwnProperty.call(workflowPrompt, nodeId)) {
            delete workflowPrompt[nodeId];
            removedNodeIds.push(String(nodeId));
        }
    }

    return {
        workflowPrompt,
        debugBypassMapping: {
            bypassedNodeIds: Array.from(new Set(bypassedNodeIds)),
            removedNodeIds,
            decisions: bypassGroupDecisions,
            rewired: bypassRewireStats
        }
    };
}

// Closes one document by id without saving.
async function closeDocumentByIdNoSave(docId) {
    if (docId === null || docId === undefined) return;
    await core.executeAsModal(async () => {
        await action.batchPlay([
            {
                _obj: "close",
                _target: [{ _ref: "document", _id: Number(docId) }],
                saving: { _enum: "yesNo", _value: "no" },
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
    }, { commandName: "QuickAI Close Reference Smart Object" });
}

// Exports a plain raster (pixel) reference layer's own content as a PNG snapshot. Two earlier
// approaches were tried and dropped: reusing exportSnapshotToTempFolder's selection/copyToLayer/
// crop action path (intermittently failed with Photoshop's native "the selected area is empty"
// depending on document/layer state), and reading pixels directly via imaging.getPixels (also
// unreliable here). This instead duplicates the raster layer, converts the duplicate to a Smart
// Object (Layer > Smart Objects > Convert to Smart Object, i.e. the "newPlacedLayer" action —
// same conversion Auto Run already relies on elsewhere for imported outputs), then hands off to
// the already-proven Smart Object export path, and finally deletes the temporary duplicate so
// nothing is left behind in the user's document. Adjustment/fill/text/group layers are excluded
// by the caller (layer.kind !== NORMAL) since converting them to a Smart Object wouldn't capture
// their actual rendered pixel content the way it does for a plain raster layer.
async function exportRasterLayerSnapshotToTempFolder(refDocId, refLayerId, options = {}) {
    const targetDoc = getOpenDocumentById(refDocId);
    if (!targetDoc) throw new Error(`Reference document ${refDocId} is not open.`);
    const targetLayer = getLayerById(targetDoc, refLayerId);
    if (!targetLayer) throw new Error(`Reference layer ${refLayerId} not found.`);

    const previousDoc = app.activeDocument || null;
    const previousLayers = previousDoc && Array.isArray(previousDoc.activeLayers)
        ? [...previousDoc.activeLayers]
        : [];
    let tempSmartLayerId = null;

    try {
        await core.executeAsModal(async () => {
            app.activeDocument = targetDoc;
            const duplicated = await targetLayer.duplicate();
            try { duplicated.visible = true; } catch (_e) {}
            targetDoc.activeLayers = [duplicated];

            const convertResult = await action.batchPlay([
                { _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }
            ], {});
            if (convertResult && convertResult[0] && convertResult[0]._obj === "error") {
                throw new Error(convertResult[0].message || "Could not convert raster layer to Smart Object.");
            }
            const converted = targetDoc.activeLayers && targetDoc.activeLayers[0];
            if (!converted) throw new Error("Raster-to-Smart-Object conversion failed to produce a layer.");
            tempSmartLayerId = converted.id;
        }, { commandName: "QuickAI Convert Raster Reference to Smart Object" });

        if (tempSmartLayerId === null || tempSmartLayerId === undefined) {
            throw new Error(`Reference layer ${refLayerId}: Smart Object conversion failed.`);
        }

        // Reuse the existing, already-reliable Smart Object export path on the duplicate.
        return await exportReferenceLayerSnapshotToTempFolder({ docId: refDocId, layerId: String(tempSmartLayerId) }, options);
    } finally {
        try {
            await core.executeAsModal(async () => {
                const latestDoc = getOpenDocumentById(refDocId);
                if (latestDoc) {
                    try { app.activeDocument = latestDoc; } catch (_e) {}
                    if (tempSmartLayerId !== null && tempSmartLayerId !== undefined) {
                        const tempLayer = getLayerById(latestDoc, tempSmartLayerId);
                        if (tempLayer) {
                            try { await tempLayer.delete(); } catch (_e) {}
                        }
                    }
                }
                if (!previousDoc) return;
                try { app.activeDocument = previousDoc; } catch (_e) {}
                if (previousLayers.length > 0) {
                    try { previousDoc.activeLayers = previousLayers; } catch (_e) {}
                }
            }, { commandName: "QuickAI Cleanup Raster Reference Duplicate" });
        } catch (_e) {}
    }
}

// Exports a specific reference layer's contents as a PNG snapshot — Smart Objects export their
// internal document; plain raster (pixel) layers export their own bounds via
// exportRasterLayerSnapshotToTempFolder. Adjustment/fill/text/group layers are not supported
// since they have no directly exportable pixel content of their own.
async function exportReferenceLayerSnapshotToTempFolder(referenceLayer, options = {}) {
    const neverScaleDown = options?.neverScaleDown === true;
    const refDocId = toActionTargetIdNumber(referenceLayer?.docId, "reference docId");
    const refLayerId = toActionTargetIdNumber(referenceLayer?.layerId, "reference layerId");

    const targetDoc = getOpenDocumentById(refDocId);
    if (!targetDoc) throw new Error(`Reference document ${refDocId} is not open.`);
    const targetLayer = getLayerById(targetDoc, refLayerId);
    if (!targetLayer) throw new Error(`Reference layer ${refLayerId} not found.`);
    const isSmartObject = await isSmartObjectLayerById(refDocId, refLayerId);
    if (!isSmartObject) {
        if (targetLayer.kind !== constants.LayerKind.NORMAL) {
            throw new Error(`Reference layer ${refLayerId} is not a Smart Object or raster layer (kind: ${String(targetLayer.kind || "unknown")}).`);
        }
        return await exportRasterLayerSnapshotToTempFolder(refDocId, refLayerId, options);
    }

    const previousDoc = app.activeDocument || null;
    const previousLayers = previousDoc && Array.isArray(previousDoc.activeLayers)
        ? [...previousDoc.activeLayers]
        : [];
    const originalVisibilityById = new Map();
    const targetDocLayers = collectAllLayers(targetDoc);
    for (let i = 0; i < targetDocLayers.length; i += 1) {
        const layer = targetDocLayers[i];
        if (!layer) continue;
        originalVisibilityById.set(layer.id, Boolean(layer.visible));
    }
    let openedSmartObjectDocId = null;

    try {
        await openSmartObjectLayerForEdit(refDocId, refLayerId);
        const soDoc = app.activeDocument;
        if (!soDoc) throw new Error("Could not open reference Smart Object.");
        openedSmartObjectDocId = soDoc.id;
        // pngCompression 1 (vs the default 6): lossless either way, just faster to encode —
        // worthwhile here since this file is a short-lived reference upload, not something
        // where a smaller file size matters. maxDimensionPx caps resolution to what these
        // models actually use for context/reference images (see REFERENCE_EXPORT_MAX_DIMENSION_PX)
        // — governed by the "Scale Down Additional Inputs" checkbox, except the main input
        // (neverScaleDown, set when this call is exporting the MAIN_INPUT_MODE_MANUAL main
        // slot) which is never scaled down regardless of that checkbox — the main input is
        // never downscaled in any mode, matching Current Canvas/Selected Layer And Below.
        const snapshot = await exportSnapshotToTempFolder({
            respectSelection: false,
            cropToSelection: false,
            pngCompression: 1,
            maxDimensionPx: (!neverScaleDown && shouldScaleDownAdditionalInputs()) ? REFERENCE_EXPORT_MAX_DIMENSION_PX : 0
        });
        await closeDocumentByIdNoSave(openedSmartObjectDocId);
        openedSmartObjectDocId = null;
        return snapshot;
    } finally {
        if (openedSmartObjectDocId !== null && openedSmartObjectDocId !== undefined) {
            try {
                await closeDocumentByIdNoSave(openedSmartObjectDocId);
            } catch (_e) {}
        }
        try {
            await core.executeAsModal(async () => {
                // Restore parent doc visibility because opening Smart Object contents can unhide
                // the selected reference layer and its ancestor groups.
                const latestTargetDoc = getOpenDocumentById(refDocId);
                if (latestTargetDoc) {
                    try {
                        app.activeDocument = latestTargetDoc;
                    } catch (_e) {}
                    try {
                        restoreLayerVisibility(latestTargetDoc, originalVisibilityById);
                    } catch (_e) {}
                }
                if (!previousDoc) return;
                app.activeDocument = previousDoc;
                if (previousLayers.length > 0) previousDoc.activeLayers = previousLayers;
                // Re-selecting previously active layers can re-open hidden parent groups in some PS states.
                // Apply one final visibility restore to force exact pre-run visibility.
                if (latestTargetDoc) {
                    try {
                        restoreLayerVisibility(latestTargetDoc, originalVisibilityById);
                    } catch (_e) {}
                }
            }, { commandName: "QuickAI Restore Active Selection" });
        } catch (_e) {}
    }
}

// Returns a temp-folder snapshot file for one reference layer, reusing a cached export
// from thumbnail generation when the layer's bounds haven't changed since it was
// captured. This avoids opening the Smart Object a second time at job-send for a
// reference that was already exported once when it was added to the list — the same
// exportReferenceLayerSnapshotToTempFolder() call backs both the thumbnail preview and
// the actual reference upload, so there's no reason to redo it if nothing moved.
// Bounds-token invalidation only catches layer move/resize, not in-place pixel edits to
// the Smart Object's contents — same tradeoff the thumbnail cache already accepts.
async function getOrExportReferenceLayerSnapshotFile(referenceLayer, options = {}) {
    const neverScaleDown = options?.neverScaleDown === true;
    const docId = toActionTargetIdNumber(referenceLayer?.docId, "reference docId");
    const layerId = toActionTargetIdNumber(referenceLayer?.layerId, "reference layerId");
    let boundsToken = "";
    try {
        const liveBounds = await getLayerBoundsPixelsById(docId, layerId);
        boundsToken = buildBoundsToken(liveBounds);
    } catch (_e) {}
    // A neverScaleDown export (the main input, when Main Input is set to "Set Manually") must
    // never reuse — or be reused by — a possibly-downscaled thumbnail/additional-input export
    // of the same layer, so it gets its own cache key.
    const baseKey = getReferenceThumbnailKey({ ...referenceLayer, thumbBoundsToken: boundsToken });
    const key = baseKey && neverScaleDown ? `${baseKey}::fullres` : baseKey;
    if (key && referenceSnapshotFileByKey.has(key)) {
        const cachedFile = referenceSnapshotFileByKey.get(key);
        if (cachedFile) {
            log(`Generate: reusing cached reference snapshot for layer ${layerId} (already exported when added).`);
            return cachedFile;
        }
    }
    const file = await exportReferenceLayerSnapshotToTempFolder(referenceLayer, { neverScaleDown });
    if (key) referenceSnapshotFileByKey.set(key, file);
    return file;
}

// Exports a preview PNG for one reference layer from the parent document without opening Smart Object contents.
async function exportReferenceLayerPreviewToTempFolder(referenceLayer) {
    const refDocId = toActionTargetIdNumber(referenceLayer?.docId, "reference docId");
    const refLayerId = toActionTargetIdNumber(referenceLayer?.layerId, "reference layerId");
    const targetDoc = getOpenDocumentById(refDocId);
    if (!targetDoc) throw new Error(`Reference document ${refDocId} is not open.`);
    const targetLayer = getLayerById(targetDoc, refLayerId);
    if (!targetLayer) throw new Error(`Reference layer ${refLayerId} not found.`);
    const layerBounds = getLayerBoundsPixels(targetLayer);
    if (!hasValidBounds(layerBounds)) {
        throw new Error(`Reference layer ${refLayerId} has no visible pixel bounds.`);
    }

    const targetFolder = await getQuickAITempFolder();
    const outFile = await targetFolder.createFile(`quickai_reference_thumb_${Date.now()}_${refLayerId}.png`, { overwrite: true });

    await core.executeAsModal(async () => {
        const previousDoc = app.activeDocument || null;
        app.activeDocument = targetDoc;
        const originalState = targetDoc.activeHistoryState;
        const originalVisibilityById = new Map();
        let visibilitySnapshotCaptured = false;
        try {
            const allLayers = collectAllLayers(targetDoc);
            // True when `layer` is inside the reference layer (only possible when it is a group).
            const isInsideReferenceLayer = (layer) => {
                let ancestor = layer ? layer.parent : null;
                while (ancestor && ancestor !== targetDoc) {
                    if (ancestor.id === refLayerId) return true;
                    ancestor = ancestor.parent;
                }
                return false;
            };
            for (let i = 0; i < allLayers.length; i += 1) {
                const layer = allLayers[i];
                originalVisibilityById.set(layer.id, layer.visible);
                // Layers inside a reference group keep their own visibility; hiding them would
                // leave the group empty and export a blank reference.
                if (isInsideReferenceLayer(layer)) continue;
                try {
                    layer.visible = layer.id === refLayerId;
                } catch (_e) {}
            }
            visibilitySnapshotCaptured = true;
            // Ensure ancestor groups are visible so nested reference layers remain renderable.
            let parent = targetLayer.parent;
            while (parent && parent !== targetDoc) {
                try {
                    parent.visible = true;
                } catch (_e) {}
                parent = parent.parent;
            }
            targetDoc.activeLayers = [targetLayer];
            // Crop to the visible layer bounds so thumbnails are content-relative, not full-canvas.
            await targetDoc.selection.selectRectangle({
                top: layerBounds.top,
                left: layerBounds.left,
                bottom: layerBounds.bottom,
                right: layerBounds.right
            });
            const cropResult = await action.batchPlay([
                { _obj: "crop", _options: { dialogOptions: "dontDisplay" } }
            ], {});
            if (cropResult && cropResult[0] && cropResult[0]._obj === "error") {
                throw new Error(cropResult[0].message || "Could not crop reference thumbnail to layer bounds.");
            }
            await convertDocumentToEightBitIfNeeded(targetDoc);
            await targetDoc.saveAs.png(outFile, { compression: 6 }, true);
        } finally {
            try { if (originalState) targetDoc.activeHistoryState = originalState; } catch (_e) {}
            // History restore can occasionally fail in some Photoshop states; always force visibility map restore.
            if (visibilitySnapshotCaptured) {
                try {
                    restoreLayerVisibility(targetDoc, originalVisibilityById);
                } catch (_e) {}
            }
            if (previousDoc) {
                try {
                    app.activeDocument = previousDoc;
                } catch (_e) {}
            }
        }
    }, { commandName: "QuickAI Export Reference Thumbnail" });

    return outFile;
}

// Submits the built prompt to Comfy's queue endpoint and validates enqueue success.
async function queueAutoRunPrompt(workflowPrompt, options = {}) {
    const backendOptions = options.backendOptions || {};
    const useRunComfy = Boolean(backendOptions.useRunComfy);
    const useRunPod = Boolean(backendOptions.useRunPod);
    const useCloud = Boolean(backendOptions.useCloud);
    if (useRunPod) {
        const endpointId = String(backendOptions.runPodEndpointId || getRunPodEndpointId() || "").trim();
        const runPodToken = getRunPodApiToken();
        if (!runPodToken) {
            throw new Error("RunPod mode requires RunPod API Token in Settings.");
        }
        if (!endpointId) {
            throw new Error("RunPod mode requires selecting an Endpoint.");
        }
        const runPodPrepared = rewriteRunPodInlineImageInputs(workflowPrompt);
        const runPodWorkflowPrompt = runPodPrepared.workflowPrompt;
        const runPodAssets = Array.isArray(runPodPrepared.assets) ? runPodPrepared.assets : [];
        const payload = { input: {} };
        if (runPodWorkflowPrompt && typeof runPodWorkflowPrompt === "object") {
            // RunPod Comfy workers commonly expect the workflow under "workflow".
            payload.input.workflow = runPodWorkflowPrompt;
            payload.input.workflow_api_json = runPodWorkflowPrompt;
            // Keep a top-level compatibility copy for worker variants that unwrap input differently.
            payload.workflow = runPodWorkflowPrompt;
        }
        if (runPodAssets.length > 0) {
            // Keep the RunPod body minimal so Base64 expansion stays below the platform's 10 MiB cap.
            // The worker only needs one asset manifest alongside the rewritten workflow filenames.
            payload.input.images = runPodAssets;
        }
        const comfyApiKey = getComfyApiKey();
        if (comfyApiKey) {
            // RunPod workers vary in how they forward prompt metadata into Comfy execution.
            // Mirror the auth payload across the common locations used by serverless wrappers so
            // partner/API nodes like GeminiImage2Node receive the Comfy API key consistently.
            // Official worker-comfyui docs specify `input.comfy_org_api_key` for per-request auth.
            payload.input.comfy_org_api_key = comfyApiKey;
            payload.input.extra_data = { api_key_comfy_org: comfyApiKey };
            payload.input.api_key_comfy_org = comfyApiKey;
            payload.extra_data = { api_key_comfy_org: comfyApiKey };
            payload.api_key_comfy_org = comfyApiKey;
        }
        const response = await fetch(
            runPodEndpointApiUrl(endpointId, "/run"),
            {
                method: "POST",
                headers: buildRunPodRequestHeaders({ includeJsonContentType: true }),
                body: JSON.stringify(payload)
            }
        );
        if (!response.ok) {
            const text = await response.text();
            if (response.status === 413) {
                throw new Error(
                    "RunPod queue failed 413 (Request Entity Too Large). "
                    + "Use a smaller crop/selection or reduce image size."
                );
            }
            throw new Error(`RunPod queue failed ${response.status}: ${text}`);
        }
        return await response.json();
    }
    if (useRunComfy) {
        const deploymentId = String(backendOptions.runComfyDeploymentId || getRunComfyDeploymentId() || "").trim();
        const runComfyToken = getRunComfyApiToken();
        if (!runComfyToken) {
            throw new Error("RunComfy mode requires RunComfy API Token in Settings.");
        }
        if (!deploymentId) {
            throw new Error("RunComfy mode requires selecting a Deployment.");
        }
        const payload = {};
        if (workflowPrompt && typeof workflowPrompt === "object") {
            payload.workflow_api_json = workflowPrompt;
        }
        const comfyApiKey = getComfyApiKey();
        if (comfyApiKey) {
            payload.extra_data = { api_key_comfy_org: comfyApiKey };
        }
        const response = await fetch(
            runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}/inference`),
            {
                method: "POST",
                headers: buildRunComfyRequestHeaders({ includeJsonContentType: true }),
                body: JSON.stringify(payload)
            }
        );
        if (!response.ok) {
            const text = await response.text();
            if (response.status === 413) {
                throw new Error(
                    "RunComfy queue failed 413 (Request Entity Too Large). "
                    + "Use a smaller crop/selection or reduce image size."
                );
            }
            throw new Error(`RunComfy queue failed ${response.status}: ${text}`);
        }
        return await response.json();
    }

    const comfyApiKey = getComfyApiKey();
    if (useCloud && !comfyApiKey) {
        throw new Error("Comfy Cloud mode requires a Comfy API key in Settings.");
    }
    const payload = {
        prompt: workflowPrompt,
        client_id: `quickai_${Date.now()}`
    };
    if (comfyApiKey) {
        // API-node workflows expect this key in prompt extra_data in both local and cloud modes.
        payload.extra_data = {
            api_key_comfy_org: comfyApiKey
        };
    }
    const response = await fetch(comfyApiUrl(useCloud ? "/api/prompt" : "/prompt", backendOptions), {
        method: "POST",
        headers: buildComfyRequestHeaders({
            useCloud,
            includeJsonContentType: true
        }),
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Comfy queue failed ${response.status}: ${text}`);
    }
    return await response.json();
}

// Removes invalid "empty link" placeholders from prompt node inputs before queueing.
// Some workflows serialize optional links as ["", 0], which Comfy validates as a link
// and then crashes with KeyError on node id "". We strip those placeholders so optional
// inputs remain unset instead of invalidly linked.
function sanitizeWorkflowPromptInputsForQueue(workflowPrompt) {
    if (!workflowPrompt || typeof workflowPrompt !== "object") return workflowPrompt;
    for (const node of Object.values(workflowPrompt)) {
        if (!node || typeof node !== "object") continue;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        for (const inputName of Object.keys(inputs)) {
            const value = inputs[inputName];
            const looksLikeLink = Array.isArray(value) && value.length >= 2;
            if (!looksLikeLink) continue;
            const linkedNodeId = String(value[0] ?? "").trim();
            if (!linkedNodeId) {
                delete inputs[inputName];
            }
        }
    }
    return workflowPrompt;
}

// Converts inline image data URIs into file-style names plus a manifest for RunPod workers
// that validate workflow image fields as filenames before they hydrate inputs.
function rewriteRunPodInlineImageInputs(workflowPrompt) {
    if (!workflowPrompt || typeof workflowPrompt !== "object") {
        return { workflowPrompt, assets: [], assetsByName: {} };
    }

    const assets = [];
    const assetsByName = {};
    const assetNameByDataUri = new Map();
    let assetIndex = 0;

    const getExtensionForMimeType = (mimeType) => {
        const normalized = String(mimeType || "").trim().toLowerCase();
        if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
        if (normalized === "image/webp") return "webp";
        if (normalized === "image/gif") return "gif";
        if (normalized === "image/bmp") return "bmp";
        if (normalized === "image/tiff") return "tiff";
        return "png";
    };

    const ensureAssetForDataUri = (dataUri) => {
        const value = String(dataUri || "").trim();
        if (assetNameByDataUri.has(value)) return assetNameByDataUri.get(value) || "";
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(value);
        if (!match) return "";
        const mimeType = String(match[1] || "image/png").trim().toLowerCase();
        const base64 = String(match[2] || "").replace(/\s+/g, "");
        if (!base64) return "";

        assetIndex += 1;
        const fileName = `quickai_runpod_input_${assetIndex}.${getExtensionForMimeType(mimeType)}`;
        const asset = {
            name: fileName,
            image: value
        };
        assets.push(asset);
        assetsByName[fileName] = asset;
        assetNameByDataUri.set(value, fileName);
        return fileName;
    };

    for (const node of Object.values(workflowPrompt)) {
        if (!node || typeof node !== "object") continue;
        const inputs = node.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        for (const [inputName, inputValue] of Object.entries(inputs)) {
            if (typeof inputValue !== "string" || !/^data:image\//i.test(inputValue)) continue;
            const fileName = ensureAssetForDataUri(inputValue);
            if (fileName) inputs[inputName] = fileName;
        }
    }

    return { workflowPrompt, assets, assetsByName };
}

// Handles sleep.
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns comfy server host.
function getComfyServerHost() {
    try {
        const url = new URL(normalizeServer(serverField?.value || "127.0.0.1"));
        return String(url.hostname || "").toLowerCase();
    } catch (_e) {
        return "";
    }
}

// Checks whether local comfy host.
function isLocalComfyHost() {
    const host = getComfyServerHost();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Checks whether unauthorized partner node error.
function isUnauthorizedPartnerNodeError(detail) {
    const lower = String(detail || "").toLowerCase();
    return lower.includes("unauthorized: please login first to use this node")
        || (lower.includes("unauthorized") && lower.includes("login") && lower.includes("use this node"));
}

// Checks whether insufficient credits error.
function isInsufficientCreditsError(detail) {
    const lower = String(detail || "").toLowerCase();
    return lower.includes("insufficientfundserror")
        || (lower.includes("insufficient") && (lower.includes("credit") || lower.includes("fund")));
}

// Handles with partner node auth help.
function withPartnerNodeAuthHelp(detail) {
    const base = String(detail || "").trim();
    const steps = [];
    if (base) steps.push(base);
    steps.push("Partner/API node auth required.");
    steps.push("In ComfyUI open Settings -> User and log in.");
    if (isLocalComfyHost()) {
        steps.push("If normal login does not stick, use Settings -> User -> Comfy API Key.");
    } else {
        steps.push("This Comfy server is not localhost/127.0.0.1; use Settings -> User -> Comfy API Key.");
    }
    steps.push("Verify Settings -> Credits has balance.");
    return steps.join(" ");
}

// Normalizes raw errors into user-facing messages with guidance for known failure cases.
function normalizePluginError(detail) {
    const text = String(detail || "").trim();
    if (!text) return "Unknown error";
    if (isUnauthorizedPartnerNodeError(text)) return withPartnerNodeAuthHelp(text);
    if (isInsufficientCreditsError(text)) return `${text} Verify Comfy credits in Settings -> Credits.`;
    return text;
}

// Extracts the most relevant execution error from Comfy history payloads.
function extractExecutionErrorFromHistoryEntry(promptId, entry) {
    const status = entry && typeof entry === "object" ? (entry.status || {}) : {};
    const messages = Array.isArray(status?.messages) ? status.messages : [];

    for (const item of messages) {
        let eventType = "";
        let payload = null;

        if (Array.isArray(item)) {
            eventType = String(item[0] || "");
            payload = item.length > 1 ? item[1] : null;
        } else if (item && typeof item === "object") {
            eventType = String(item.event || item.type || "");
            payload = item;
        }

        if (eventType !== "execution_error") continue;

        const exceptionMessage = String(
            payload?.exception_message
            || payload?.message
            || payload?.error
            || ""
        ).trim();
        const nodeType = String(payload?.node_type || "").trim();

        if (exceptionMessage && nodeType) return `${exceptionMessage} (node: ${nodeType})`;
        if (exceptionMessage) return exceptionMessage;
        if (nodeType) return `Execution error from node: ${nodeType}`;
        return `Execution error for prompt ${promptId}.`;
    }

    const statusStr = String(status?.status_str || status?.status || "").toLowerCase().trim();
    if (statusStr === "error" || statusStr === "failed") {
        return `Execution failed for prompt ${promptId}.`;
    }

    return "";
}

// Finds the matching prompt entry from Comfy history responses.
function getHistoryEntryForPrompt(historyData, promptId) {
    if (!historyData || typeof historyData !== "object") return null;

    const promptKey = String(promptId);
    if (historyData[promptKey]) return historyData[promptKey];
    if (historyData.prompt_id && String(historyData.prompt_id) === promptKey) return historyData;

    const historyList = Array.isArray(historyData.history) ? historyData.history : [];
    for (const item of historyList) {
        const itemId = item?.prompt_id || item?.id;
        if (itemId !== undefined && String(itemId) === promptKey) return item;
    }

    return null;
}

// Extracts the prompt node map from a history entry so output-node metadata can be inspected.
function getPromptNodeMapFromHistoryEntry(historyEntry) {
    if (!historyEntry || typeof historyEntry !== "object") return null;
    const promptPayload = historyEntry.prompt;
    const promptCandidates = [];
    if (promptPayload && typeof promptPayload === "object") {
        if (Array.isArray(promptPayload)) {
            for (let i = 0; i < promptPayload.length; i += 1) {
                const item = promptPayload[i];
                if (item && typeof item === "object" && !Array.isArray(item)) promptCandidates.push(item);
            }
        } else {
            promptCandidates.push(promptPayload);
        }
    }
    const looksLikeNodeMap = (obj) => Object.values(obj || {}).some((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        return typeof value.class_type === "string" || (value.inputs && typeof value.inputs === "object");
    });
    for (let i = 0; i < promptCandidates.length; i += 1) {
        const candidate = promptCandidates[i];
        if (looksLikeNodeMap(candidate)) return candidate;
    }
    return null;
}

// Returns one prompt node entry by id from history prompt metadata.
function getPromptNodeByIdFromHistoryEntry(historyEntry, nodeId) {
    const normalizedNodeId = normalizeWorkflowNodeId(nodeId);
    if (!normalizedNodeId) return null;
    const nodeMap = getPromptNodeMapFromHistoryEntry(historyEntry);
    const node = nodeMap && nodeMap[normalizedNodeId] && typeof nodeMap[normalizedNodeId] === "object"
        ? nodeMap[normalizedNodeId]
        : null;
    return node || null;
}

// File extensions produced by Comfy's native SaveVideo node (and common video-saver variants).
const VIDEO_OUTPUT_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "m4v", "avi"]);

// True when a result filename is a video container rather than a still image.
function isVideoOutputFilename(filename) {
    const ext = String(filename || "").trim().toLowerCase().split(".").pop() || "";
    return VIDEO_OUTPUT_EXTENSIONS.has(ext);
}

// Extracts one or more likely output asset descriptors (image, mask, or video) from a history entry.
function getImageOutputsFromHistoryEntry(historyEntry, options = {}) {
    const outputs = historyEntry && typeof historyEntry === "object"
        ? (
            historyEntry.outputs
            || historyEntry?.result?.outputs
            || historyEntry?.data?.outputs
            || historyEntry?.job?.outputs
        )
        : null;
    if (!outputs || typeof outputs !== "object") return null;

    // Comfy can include multiple image-producing nodes. Prefer explicit YAML-selected
    // output node ids when provided; otherwise fallback to the highest numeric node id.
    const preferredNodeIds = Array.from(new Set(
        (Array.isArray(options.preferredNodeIds) ? options.preferredNodeIds : [options.preferredNodeId])
            .map((id) => normalizeWorkflowNodeId(id))
            .filter(Boolean)
    ));
    const collected = [];
    for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
        if (!nodeOutput || typeof nodeOutput !== "object") continue;
        const outputGroups = [
            { key: "images", items: Array.isArray(nodeOutput.images) ? nodeOutput.images : [] },
            { key: "masks", items: Array.isArray(nodeOutput.masks) ? nodeOutput.masks : [] },
            // Comfy's native SaveVideo node (and video-saver variants) surface results under
            // "videos"/"gifs" instead of "images" depending on Comfy version.
            { key: "videos", items: Array.isArray(nodeOutput.videos) ? nodeOutput.videos : [] },
            { key: "gifs", items: Array.isArray(nodeOutput.gifs) ? nodeOutput.gifs : [] }
        ];
        for (const group of outputGroups) {
            for (let imageIndex = 0; imageIndex < group.items.length; imageIndex += 1) {
                const imageInfo = group.items[imageIndex];
                const filename = String(imageInfo?.filename || "").trim();
                if (!filename) continue;
                const subfolder = String(imageInfo?.subfolder || "").trim();
                const type = String(imageInfo?.type || "output").trim() || "output";
                const numericNodeId = Number.parseInt(String(nodeId), 10);
                collected.push({
                    nodeId: String(nodeId),
                    numericNodeId: Number.isFinite(numericNodeId) ? numericNodeId : Number.NEGATIVE_INFINITY,
                    imageIndex,
                    filename,
                    subfolder,
                    type
                });
            }
        }
    }
    if (!collected.length) return [];
    const toOutputDescriptor = (item) => ({
        filename: item.filename,
        subfolder: item.subfolder,
        type: item.type,
        nodeId: item.nodeId
    });
    if (preferredNodeIds.length > 0) {
        const preferredResults = [];
        for (let i = 0; i < preferredNodeIds.length; i += 1) {
            const preferredNodeId = preferredNodeIds[i];
            const filtered = collected
                .filter((item) => String(item.nodeId) === preferredNodeId)
                .sort((a, b) => a.imageIndex - b.imageIndex);
            if (filtered.length > 0) {
                for (let j = 0; j < filtered.length; j += 1) preferredResults.push(toOutputDescriptor(filtered[j]));
            }
        }
        if (preferredResults.length > 0) return preferredResults;
    }

    collected.sort((a, b) => {
        if (a.numericNodeId !== b.numericNodeId) return a.numericNodeId - b.numericNodeId;
        return a.imageIndex - b.imageIndex;
    });
    return [toOutputDescriptor(collected[collected.length - 1])];
}

// Resolves a non-default SaveImage filename prefix from a Comfy history node entry.
function getSaveImagePrefixFromHistoryEntry(historyEntry, nodeId) {
    const normalizedNodeId = normalizeWorkflowNodeId(nodeId);
    if (!historyEntry || typeof historyEntry !== "object" || !normalizedNodeId) return "";
    const node = getPromptNodeByIdFromHistoryEntry(historyEntry, normalizedNodeId);
    const classType = String(node?.class_type || "").trim().toLowerCase();
    if (classType !== "saveimage") return "";
    const rawPrefix = String(node?.inputs?.filename_prefix || "").trim();
    if (!rawPrefix || /^comfyui$/i.test(rawPrefix)) return "";
    return rawPrefix;
}

// Determines whether a class_type belongs to HQ-Image-Save EXR saver variants.
function isHqExrOutputClassType(classType) {
    const normalized = String(classType || "").trim().toLowerCase();
    return normalized === "saveexr" || normalized === "saveexrframes" || normalized === "savelatentexr";
}

// Returns true when any preferred output node is an EXR saver node in the queued workflow metadata.
function hasDeclaredExrOutputNode(historyEntry, preferredNodeIds) {
    const nodeIds = Array.isArray(preferredNodeIds) ? preferredNodeIds : [preferredNodeIds];
    for (let i = 0; i < nodeIds.length; i += 1) {
        const nodeId = normalizeWorkflowNodeId(nodeIds[i]);
        if (!nodeId) continue;
        const node = getPromptNodeByIdFromHistoryEntry(historyEntry, nodeId);
        const classType = String(node?.class_type || "").trim();
        if (isHqExrOutputClassType(classType)) return true;
    }
    return false;
}

// Returns candidate EXR prefixes to try in priority order.
// Some EXR saver variants can ignore rewritten suffixes, so we retry with the base prefix.
function getExrPrefixCandidates(prefix) {
    const raw = String(prefix || "").trim();
    if (!raw) return [];
    const out = [raw];
    const suffixMarkerIndex = raw.indexOf("__qc");
    if (suffixMarkerIndex > 0) {
        const base = raw.slice(0, suffixMarkerIndex).trim();
        if (base && !out.includes(base)) out.push(base);
    }
    return out;
}

// Extracts rewritten EXR saver prefixes from the queued workflow so imports can recover server-side files later.
function getDeclaredExrOutputPrefixesFromPrompt(workflowPrompt, preferredNodeIds) {
    if (!workflowPrompt || typeof workflowPrompt !== "object") return [];
    const nodeIds = Array.from(new Set(
        (Array.isArray(preferredNodeIds) ? preferredNodeIds : [preferredNodeIds])
            .map((id) => normalizeWorkflowNodeId(id))
            .filter(Boolean)
    ));
    const prefixes = [];
    const seen = new Set();
    for (let i = 0; i < nodeIds.length; i += 1) {
        const nodeId = nodeIds[i];
        const node = workflowPrompt[nodeId];
        if (!node || typeof node !== "object") continue;
        const classType = String(node.class_type || "").trim();
        if (!isHqExrOutputClassType(classType)) continue;
        const prefix = String(node?.inputs?.filename_prefix || "").trim();
        if (!prefix || seen.has(prefix)) continue;
        seen.add(prefix);
        prefixes.push(prefix);
    }
    return prefixes;
}

// Ensures EXR saver nodes write unique files per Auto Run segment so imports cannot resolve stale outputs.
function applyExrOutputPrefixSuffix(workflowPrompt, preferredNodeIds, suffixToken) {
    if (!workflowPrompt || typeof workflowPrompt !== "object") return 0;
    const normalizedSuffix = String(suffixToken || "").trim();
    if (!normalizedSuffix) return 0;
    const nodeIds = Array.from(new Set(
        (Array.isArray(preferredNodeIds) ? preferredNodeIds : [preferredNodeIds])
            .map((id) => normalizeWorkflowNodeId(id))
            .filter(Boolean)
    ));
    if (nodeIds.length < 1) return 0;

    let changed = 0;
    for (let i = 0; i < nodeIds.length; i += 1) {
        const nodeId = nodeIds[i];
        const node = workflowPrompt[nodeId];
        if (!node || typeof node !== "object") continue;
        const classType = String(node.class_type || "").trim();
        if (!isHqExrOutputClassType(classType)) continue;
        if (!node.inputs || typeof node.inputs !== "object") node.inputs = {};
        const basePrefix = String(node.inputs.filename_prefix || "").trim() || "quickai_exr";
        node.inputs.filename_prefix = `${basePrefix}__${normalizedSuffix}`;
        changed += 1;
    }
    return changed;
}

// Queries bridge extension endpoint to resolve newest Comfy output file by filename prefix.
async function findLatestComfyOutputByPrefix(prefix, options = {}) {
    const cleanedPrefix = String(prefix || "").trim();
    if (!cleanedPrefix) return null;
    const useCloud = Boolean(options.useCloud);
    const useRunComfy = Boolean(options.useRunComfy);
    const useRunPod = Boolean(options.useRunPod);
    const extension = String(options.extension || "").trim().replace(/^\./, "").toLowerCase();
    const minModifiedMs = Number(options.minModifiedMs);
    if (useRunComfy || useRunPod) {
        if (useRunPod) return null;
        const deploymentId = getRunComfyDeploymentId();
        const instanceId = String(options.runComfyInstanceId || "").trim();
        if (!deploymentId || !instanceId) return null;
        const body = { prefix: cleanedPrefix };
        if (extension) body.extension = extension;
        if (Number.isFinite(minModifiedMs) && minModifiedMs > 0) body.min_modified_ms = Math.round(minModifiedMs);
        const response = await fetch(
            runComfyInstanceProxyUrl(deploymentId, instanceId, "quickai/latest-output-by-prefix"),
            {
                method: "POST",
                headers: buildRunComfyRequestHeaders({ includeJsonContentType: true }),
                body: JSON.stringify(body)
            }
        );
        if (!response.ok) return null;
        const data = await response.json();
        const match = data?.match || null;
        const filename = String(match?.filename || "").trim();
        if (!filename) return null;
        return {
            filename,
            subfolder: String(match?.subfolder || "").trim(),
            type: String(match?.type || "output").trim() || "output"
        };
    }
    const query = new URLSearchParams({ prefix: cleanedPrefix });
    if (extension) query.set("extension", extension);
    if (Number.isFinite(minModifiedMs) && minModifiedMs > 0) query.set("min_modified_ms", String(Math.round(minModifiedMs)));
    const response = await fetch(comfyApiUrl(`/quickai/latest-output-by-prefix?${query.toString()}`, { useCloud }));
    if (!response.ok) return null;
    const data = await response.json();
    const match = data?.match || null;
    const filename = String(match?.filename || "").trim();
    if (!filename) return null;
    return {
        filename,
        subfolder: String(match?.subfolder || "").trim(),
        type: String(match?.type || "output").trim() || "output"
    };
}

// Resolves additional EXR outputs for declared nodes when history does not include image metadata.
async function getDeclaredExrFallbackOutputs(historyEntry, preferredNodeIds, options = {}) {
    const resolved = [];
    const seenFiles = new Set();
    const nodeIds = Array.isArray(preferredNodeIds) ? preferredNodeIds : [];
    const optionPrefixes = Array.isArray(options.exrOutputPrefixes)
        ? options.exrOutputPrefixes.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
    for (let i = 0; i < nodeIds.length; i += 1) {
        const nodeId = normalizeWorkflowNodeId(nodeIds[i]);
        if (!nodeId) continue;
        const node = getPromptNodeByIdFromHistoryEntry(historyEntry, nodeId);
        const classType = String(node?.class_type || "").trim();
        const prefix = String(node?.inputs?.filename_prefix || "").trim();
        const prefixCandidates = optionPrefixes.length > 0
            ? Array.from(new Set(optionPrefixes.flatMap((candidate) => getExrPrefixCandidates(candidate))))
            : (node && isHqExrOutputClassType(classType) && prefix
                ? getExrPrefixCandidates(prefix)
                : []);
        if (prefixCandidates.length < 1) {
            log(`Generate: EXR fallback skipped for node ${nodeId} (${classType}) because filename_prefix is empty.`);
            continue;
        }
        try {
            let latest = null;
            for (let candidateIndex = 0; candidateIndex < prefixCandidates.length; candidateIndex += 1) {
                const candidatePrefix = prefixCandidates[candidateIndex];
                latest = await findLatestComfyOutputByPrefix(candidatePrefix, {
                    useCloud: Boolean(options.useCloud),
                    useRunComfy: Boolean(options.useRunComfy),
                    useRunPod: Boolean(options.useRunPod),
                    runComfyInstanceId: options.runComfyInstanceId,
                    extension: "exr",
                    minModifiedMs: options.minModifiedMs
                });
                if (latest) break;
            }
            if (!latest) {
                // Last-resort lookup without timestamp guard for backends that preserve old mtimes.
                for (let candidateIndex = 0; candidateIndex < prefixCandidates.length; candidateIndex += 1) {
                    const candidatePrefix = prefixCandidates[candidateIndex];
                    latest = await findLatestComfyOutputByPrefix(candidatePrefix, {
                        useCloud: Boolean(options.useCloud),
                        useRunComfy: Boolean(options.useRunComfy),
                        useRunPod: Boolean(options.useRunPod),
                        runComfyInstanceId: options.runComfyInstanceId,
                        extension: "exr"
                    });
                    if (latest) {
                        log(`Generate: EXR fallback used relaxed timestamp match for prefix "${candidatePrefix}".`);
                        break;
                    }
                }
            }
            if (!latest) {
                log(`Generate: EXR fallback found no output for node ${nodeId} prefix "${prefix}".`);
                continue;
            }
            const dedupeKey = `${latest.type}|${latest.subfolder}|${latest.filename}`;
            if (seenFiles.has(dedupeKey)) continue;
            seenFiles.add(dedupeKey);
            resolved.push({ ...latest, nodeId });
            log(`Generate: EXR fallback resolved ${latest.filename} for node ${nodeId} prefix "${prefixCandidates[0]}".`);
        } catch (error) {
            log(`Generate: EXR fallback failed for node ${nodeId} prefix "${prefixCandidates[0] || ""}": ${describeError(error)}`);
        }
    }
    return resolved;
}

// Heuristic fallback: extract SaveImage-like prefix from filename (e.g., ZImage_00001_.png).
function getSaveImagePrefixFromFilename(filename) {
    const text = String(filename || "").trim();
    if (!text) return "";
    const match = text.match(/^(.+?)_\d{3,}_/);
    if (!match) return "";
    const prefix = String(match[1] || "").trim();
    if (!prefix || /^comfyui$/i.test(prefix)) return "";
    return prefix;
}

// Uses the generated output filename as the Photoshop layer/Smart Object name without adding plugin prefixes/suffixes.
function buildOutputLayerNameFromFilename(filename) {
    const rawName = String(filename || "").trim().split(/[\\/]/).pop() || "";
    return rawName || "ComfyUI_Export";
}

// Renames one layer by id under modal execution.
async function renameLayerById(docId, layerId, nextName) {
    const targetDoc = getOpenDocumentById(docId);
    if (!targetDoc) return;
    const safeName = String(nextName || "").trim();
    if (!safeName) return;
    await core.executeAsModal(async () => {
        const doc = getOpenDocumentById(docId);
        if (!doc) return;
        const layer = getLayerById(doc, layerId);
        if (!layer) return;
        try {
            app.activeDocument = doc;
        } catch (_e) {}
        try { layer.name = safeName; } catch (_e) {}
    }, { commandName: "QuickAI Rename Crop Smart Object" });
}

// Downloads and imports a completed Auto Run image output back into Photoshop.
async function importAutoRunOutputFromHistory(promptId, historyEntry, options = {}) {
    // 1) Resolve target image and optional mask outputs from completed history.
    const exportNodeId = normalizeWorkflowNodeId(options.exportNodeId);
    const exportNodeIds = Array.from(new Set(
        (Array.isArray(options.exportNodeIds) ? options.exportNodeIds : [exportNodeId])
            .map((id) => normalizeWorkflowNodeId(id))
            .filter(Boolean)
    ));
    const exportMaskNodeId = normalizeWorkflowNodeId(options.exportMaskNodeId);
    const exportMaskNodeIds = Array.from(new Set(
        (Array.isArray(options.exportMaskNodeIds) ? options.exportMaskNodeIds : [exportMaskNodeId])
            .map((id) => normalizeWorkflowNodeId(id))
            .filter(Boolean)
    ));
    const exportMaskResultNodeIds = Array.from(new Set(
        (Array.isArray(options.exportMaskResultNodeIds) ? options.exportMaskResultNodeIds : exportMaskNodeIds)
            .map((id) => normalizeWorkflowNodeId(id))
            .filter(Boolean)
    ));
    const useRunComfy = Boolean(options.useRunComfy);
    const useRunPod = Boolean(options.useRunPod);
    const useCloud = Boolean(options.useCloud);
    let outputs = [];
    let output = null;
    let maskOutput = null;
    if (useRunComfy || useRunPod) {
        const providerLabel = useRunPod ? "RunPod" : "RunComfy";
        const serverlessResultPayload = useRunPod ? getRunPodResultPayload(historyEntry) : historyEntry;
        const resultStatus = String(historyEntry?.status || "").trim().toLowerCase();
        if (resultStatus === "failed" || resultStatus === "error" || resultStatus === "cancelled" || resultStatus === "canceled") {
            let detail = "";
            try {
                if (typeof historyEntry?.output?.message === "string" && historyEntry.output.message.trim()) {
                    detail = historyEntry.output.message.trim();
                } else if (Array.isArray(historyEntry?.output?.details) && historyEntry.output.details.length > 0) {
                    detail = historyEntry.output.details.map((item) => String(item || "").trim()).filter(Boolean).join(" ");
                }
                if (detail) detail = normalizePluginError(detail);
                const errorPayload = historyEntry?.error;
                if (!detail && typeof errorPayload === "string") detail = normalizePluginError(errorPayload);
                else if (!detail && Array.isArray(errorPayload) && errorPayload.length > 0) detail = normalizePluginError(JSON.stringify(errorPayload[0]));
                else if (!detail && errorPayload && typeof errorPayload === "object") detail = normalizePluginError(JSON.stringify(errorPayload));
            } catch (_e) {}
            throw new Error(`${providerLabel} request ${promptId} failed: ${detail || resultStatus}`);
        }
        const runComfyOutputs = getRunComfyImageOutputsFromResult(serverlessResultPayload, {
            preferredNodeIds: exportNodeIds
        });
        const runComfyMaskOutputs = exportMaskNodeIds.length > 0
            ? getRunComfyImageOutputsFromResult(serverlessResultPayload, {
                preferredNodeIds: exportMaskResultNodeIds,
                requirePreferredNodeMatch: true
            })
            : [];
        const runComfyOutputSummary = describeRunComfyOutputGroups(serverlessResultPayload);
        let runComfyResolvedOutputs = Array.isArray(runComfyOutputs) ? runComfyOutputs.slice() : [];
        let resolvedRunPodInlineMaskOutput = null;
        if (useRunPod && runComfyResolvedOutputs.length < 1) {
            const runPodInlineResolution = splitRunPodInlineOutputsForImport(serverlessResultPayload, {
                expectMaskOutput: exportMaskNodeIds.length > 0
            });
            runComfyResolvedOutputs = Array.isArray(runPodInlineResolution.outputs)
                ? runPodInlineResolution.outputs
                : [];
            resolvedRunPodInlineMaskOutput = runPodInlineResolution.maskOutput || null;
        }
        if (!useRunPod && runComfyResolvedOutputs.length < 1 && exportNodeIds.length > 0) {
            const runComfyExrFallbackOutputs = await getDeclaredExrFallbackOutputs(historyEntry, exportNodeIds, {
                useRunComfy: true,
                runComfyInstanceId: historyEntry?.instance_id,
                exrOutputPrefixes: options.exrOutputPrefixes,
                minModifiedMs: options.exrMinModifiedMs
            });
            if (runComfyExrFallbackOutputs.length > 0) runComfyResolvedOutputs = runComfyResolvedOutputs.concat(runComfyExrFallbackOutputs);
        }
        if (!Array.isArray(runComfyResolvedOutputs) || runComfyResolvedOutputs.length < 1) {
            const topLevelKeys = historyEntry && typeof historyEntry === "object"
                ? Object.keys(historyEntry).slice(0, 40).join(", ")
                : "";
            let preview = "";
            try {
                // Redact before truncating so a URL cut at the 1200-char boundary is still covered.
                preview = redactUrlQueryStrings(JSON.stringify(historyEntry)).slice(0, 1200);
            } catch (_e) {}
            if (topLevelKeys) log(`${providerLabel} result debug keys: ${topLevelKeys}`);
            log(`${providerLabel} result debug outputs: ${runComfyOutputSummary}`);
            if (preview) log(`${providerLabel} result debug preview: ${preview}`);
            if (hasDeclaredExrOutputNode(historyEntry, exportNodeIds)) {
                throw new Error(
                    `${providerLabel} request ${promptId} completed, but the declared EXR output node returned no downloadable asset. `
                    + `${providerLabel} currently returned ${runComfyOutputSummary} for this EXR workflow.`
                );
            }
            throw new Error(`${providerLabel} request ${promptId} completed but no image/video URL output was found.`);
        }
        if (exportNodeIds.length > 0) {
            const matchedAnyPreferred = runComfyResolvedOutputs.some((item) => exportNodeIds.includes(String(item.nodeId || "")));
            if (!matchedAnyPreferred) {
                log(`Generate: ${providerLabel} preferred output node(s) ${exportNodeIds.join(", ")} not found in result outputs. Falling back to available outputs.`);
            }
        }
        outputs = Array.isArray(runComfyResolvedOutputs) ? runComfyResolvedOutputs.slice() : [];
        output = outputs.length > 0 ? outputs[0] : null;
        maskOutput = Array.isArray(runComfyMaskOutputs) && runComfyMaskOutputs.length > 0
            ? runComfyMaskOutputs[0]
            : resolvedRunPodInlineMaskOutput;
        if (exportMaskNodeIds.length > 0) {
            if (maskOutput) {
                log(
                    `Generate: ${providerLabel} output_mask resolved from node(s) ${exportMaskNodeIds.join(", ")} `
                    + `using result node(s) ${exportMaskResultNodeIds.join(", ")} `
                    + `with ${(Array.isArray(runComfyMaskOutputs) ? runComfyMaskOutputs.length : 0) + (resolvedRunPodInlineMaskOutput ? 1 : 0)} downloadable asset(s).`
                );
            } else {
                log(
                    `Generate: ${providerLabel} output_mask node(s) ${exportMaskNodeIds.join(", ")} returned no downloadable mask asset. `
                    + `Checked result node(s): ${exportMaskResultNodeIds.join(", ")}. `
                    + `Result outputs: ${runComfyOutputSummary}.`
                );
                log(
                    `${providerLabel} mask debug: `
                    + `${describeRunComfyImageUrlRecovery(serverlessResultPayload, exportMaskResultNodeIds)}`
                );
            }
        }
    } else {
        outputs = getImageOutputsFromHistoryEntry(historyEntry, {
            preferredNodeIds: exportNodeIds
        });
        if (!Array.isArray(outputs)) outputs = [];
        if (exportNodeIds.length > 0) {
            const existingByNode = new Set(outputs.map((item) => normalizeWorkflowNodeId(item?.nodeId)).filter(Boolean));
            const exrFallbackCandidates = exportNodeIds.filter((id) => !existingByNode.has(normalizeWorkflowNodeId(id)));
            if (exrFallbackCandidates.length > 0) {
                const exrFallbackOutputs = await getDeclaredExrFallbackOutputs(historyEntry, exrFallbackCandidates, {
                    useCloud,
                    minModifiedMs: options.exrMinModifiedMs
                });
                if (exrFallbackOutputs.length > 0) outputs = outputs.concat(exrFallbackOutputs);
            }
        }
        output = Array.isArray(outputs) && outputs.length > 0 ? outputs[0] : null;
        maskOutput = exportMaskNodeIds.length > 0
            ? (getImageOutputsFromHistoryEntry(historyEntry, { preferredNodeIds: exportMaskNodeIds })[0] || null)
            : null;
    }
    if (!useRunComfy && !output && useCloud && promptId) {
        // Cloud job detail may lag or use alternate wrappers; retry through compatibility history route.
        try {
            const historyResponse = await fetch(
                comfyApiUrl(`/history/${encodeURIComponent(String(promptId))}`, { useCloud: true }),
                { headers: buildComfyRequestHeaders({ useCloud: true }) }
            );
            if (historyResponse.ok) {
                const historyData = await historyResponse.json();
                const fallbackEntry = getHistoryEntryForPrompt(historyData, promptId) || historyData;
                outputs = getImageOutputsFromHistoryEntry(fallbackEntry, { preferredNodeIds: exportNodeIds });
                if (!Array.isArray(outputs)) outputs = [];
                if (exportNodeIds.length > 0) {
                    const existingByNode = new Set(outputs.map((item) => normalizeWorkflowNodeId(item?.nodeId)).filter(Boolean));
                    const exrFallbackCandidates = exportNodeIds.filter((id) => !existingByNode.has(normalizeWorkflowNodeId(id)));
                    if (exrFallbackCandidates.length > 0) {
                        const exrFallbackOutputs = await getDeclaredExrFallbackOutputs(fallbackEntry, exrFallbackCandidates, {
                            useCloud,
                            minModifiedMs: options.exrMinModifiedMs
                        });
                        if (exrFallbackOutputs.length > 0) outputs = outputs.concat(exrFallbackOutputs);
                    }
                }
                output = Array.isArray(outputs) && outputs.length > 0 ? outputs[0] : null;
                if (exportMaskNodeIds.length > 0) {
                    maskOutput = getImageOutputsFromHistoryEntry(fallbackEntry, { preferredNodeIds: exportMaskNodeIds })[0] || null;
                }
            }
        } catch (_e) {
            // Preserve original error behavior below if fallback lookup fails.
        }
    }
    if (!output) {
        throw new Error(`Generation finished but no output image/video was found in history for prompt ${promptId}. Add/keep a SaveImage or SaveVideo output node in the workflow.`);
    }
    const primaryOutputLayerName = buildOutputLayerNameFromFilename(output.filename);

    log(`Generate: selected output ${output.filename}${output.nodeId ? ` (node ${output.nodeId})` : ""} for import.`);
    if (exportMaskNodeIds.length > 0) {
        if (maskOutput) log(`Generate: selected mask ${maskOutput.filename}${maskOutput.nodeId ? ` (node ${maskOutput.nodeId})` : ""} for import.`);
        else log(`Generate: export_mask node(s) ${exportMaskNodeIds.join(", ")} not found in outputs. Mask import skipped.`);
    }
    if (Array.isArray(outputs) && outputs.length > 1) {
        log(`Generate: selected ${outputs.length} outputs for import from node(s) ${Array.from(new Set(outputs.map((item) => item.nodeId).filter(Boolean))).join(", ")}.`);
    }
    // 2) Download the generated image bytes from backend result source.
    const downloadOutputBinary = async (outputItem) => {
        if (!outputItem) throw new Error("Missing output item.");
        if (typeof outputItem.inlineData === "string" && outputItem.inlineData.trim()) {
            return decodeBase64ImagePayloadToBytes(outputItem.inlineData);
        }
        // Use the background download started when this segment finished, if there is one.
        const prefetched = takePrefetchedAutoRunOutput(getAutoRunOutputDownloadKey(outputItem, options));
        if (prefetched) {
            const prefetchedBinary = await prefetched;
            if (prefetchedBinary) {
                log(`Generate: using background-downloaded ${outputItem.filename || "output"}.`);
                return prefetchedBinary;
            }
        }
        // Logged here (not before choosing) so it only appears when a download really happens.
        if (useRunComfy || useRunPod) {
            log(`Generate: downloading output ${outputItem.filename} from ${useRunPod ? "RunPod" : "RunComfy"} result URL ...`);
        } else {
            log(`Generate: downloading output ${outputItem.filename} from ${comfyBaseUrl(options)} ...`);
        }
        if (useRunComfy || useRunPod) {
            const outputUrl = String(outputItem.url || "").trim();
            if (!outputUrl) throw new Error(`${useRunPod ? "RunPod" : "RunComfy"} output ${outputItem.filename || "<unnamed>"} is missing URL.`);
            // Provider decides token handling: RunPod results must never carry the RunComfy token.
            return await downloadServerlessOutputByUrl(outputUrl, { provider: useRunPod ? "runpod" : "runcomfy" });
        }
        return await downloadComfyOutput(outputItem.filename, outputItem.subfolder, outputItem.type, options);
    };
    const binary = await downloadOutputBinary(output);
    const maskBinary = maskOutput ? await downloadOutputBinary(maskOutput) : null;

    const selectionBounds = options.selectionBounds || null;
    const targetDocId = options.targetDocId || null;
    const hasSelectionPlacement = Boolean(
        selectionBounds
        && typeof selectionBounds.left === "number"
        && typeof selectionBounds.top === "number"
        && typeof selectionBounds.right === "number"
        && typeof selectionBounds.bottom === "number"
        && (selectionBounds.right - selectionBounds.left) > 0
        && (selectionBounds.bottom - selectionBounds.top) > 0
    );
    const targetSmartObject = options.targetSmartObject || null;
    const hasTargetSmartObject = Boolean(
        targetSmartObject
        && targetSmartObject.docId !== null
        && targetSmartObject.docId !== undefined
        && targetSmartObject.layerId !== null
        && targetSmartObject.layerId !== undefined
    );

    // 3) Import strategy priority:
    //    a) replace content inside stored crop Smart Object,
    //    b) place directly into stored selection bounds,
    //    c) fallback to generic import as a new layer.
    if (hasTargetSmartObject) {
        await renameLayerById(targetSmartObject.docId, targetSmartObject.layerId, primaryOutputLayerName);
        const preCreatedExtraSmartObjectRefs = [];
        if (Array.isArray(outputs) && outputs.length > 1) {
            // Create duplicates before importing primary output so extras do not inherit heavy embedded result #1.
            for (let extraIndex = 1; extraIndex < outputs.length; extraIndex += 1) {
                const extraOutput = outputs[extraIndex];
                if (!extraOutput) continue;
                const extraSmartObjectRef = await duplicateSmartObjectLayerAsCopy(targetSmartObject.docId, targetSmartObject.layerId);
                await renameLayerById(
                    extraSmartObjectRef.docId,
                    extraSmartObjectRef.layerId,
                    buildOutputLayerNameFromFilename(extraOutput.filename)
                );
                preCreatedExtraSmartObjectRefs.push({ index: extraIndex, ref: extraSmartObjectRef });
            }
        }
        if (maskBinary && maskOutput) {
            // Crop mode with export_mask: duplicate target SO via copy, load image in first, mask in second.
            const maskSmartObjectRef = await duplicateSmartObjectLayerAsCopy(targetSmartObject.docId, targetSmartObject.layerId);

            log("Generate: opening primary crop Smart Object...");
            await openSmartObjectLayerForEdit(targetSmartObject.docId, targetSmartObject.layerId);
            log("Generate: importing output into primary crop Smart Object...");
            const importDebug = await importOutputIntoActiveDocumentWithoutScaling(binary, output.filename);
            if (importDebug) {
                log(
                    `Generate SO import debug: src=${Math.round(importDebug.srcW)}x${Math.round(importDebug.srcH)} ` +
                    `canvas=${Math.round(importDebug.canvasW)}x${Math.round(importDebug.canvasH)} ` +
                    `fit=${importDebug.fitMode || "none"} ` +
                    `scale=${Number(importDebug.appliedWidthScale || 1).toFixed(4)}x${Number(importDebug.appliedHeightScale || 1).toFixed(4)} ` +
                    `final=${Math.round(importDebug.finalLayerW)}x${Math.round(importDebug.finalLayerH)}`
                );
            }
            await saveAndCloseActiveDocument();

            log("Generate: opening duplicated crop Smart Object for mask...");
            await openSmartObjectLayerForEdit(maskSmartObjectRef.docId, maskSmartObjectRef.layerId);
            log("Generate: importing mask into duplicated crop Smart Object...");
            await importOutputIntoActiveDocumentWithoutScaling(maskBinary, maskOutput.filename);
            await saveAndCloseActiveDocument();
            try {
                await applySourceRGBToTargetMaskInDocument(
                    targetSmartObject.docId,
                    targetSmartObject.layerId,
                    maskSmartObjectRef.layerId
                );
                log("Generate: applied export_mask to crop output.");
            } finally {
                await deleteLayerById(targetSmartObject.docId, maskSmartObjectRef.layerId);
                log("Generate: deleted temporary export_mask Smart Object layer.");
            }
        } else {
            log("Generate: opening stored crop Smart Object...");
            await openSmartObjectLayerForEdit(targetSmartObject.docId, targetSmartObject.layerId);
            log("Generate: importing output into stored crop Smart Object...");
            const importDebug = await importOutputIntoActiveDocumentWithoutScaling(binary, output.filename);
            if (importDebug) {
                log(
                    `Generate SO import debug: src=${Math.round(importDebug.srcW)}x${Math.round(importDebug.srcH)} ` +
                    `canvas=${Math.round(importDebug.canvasW)}x${Math.round(importDebug.canvasH)} ` +
                    `fit=${importDebug.fitMode || "none"} ` +
                    `scale=${Number(importDebug.appliedWidthScale || 1).toFixed(4)}x${Number(importDebug.appliedHeightScale || 1).toFixed(4)} ` +
                    `final=${Math.round(importDebug.finalLayerW)}x${Math.round(importDebug.finalLayerH)}`
                );
            }
            log("Generate: saving and closing crop Smart Object...");
            await saveAndCloseActiveDocument();
        }
        if (Array.isArray(outputs) && outputs.length > 1) {
            for (let i = 0; i < preCreatedExtraSmartObjectRefs.length; i += 1) {
                const item = preCreatedExtraSmartObjectRefs[i];
                const extraIndex = item.index;
                const extraOutput = outputs[extraIndex];
                if (!extraOutput) continue;
                log(`Generate: importing additional crop output ${extraIndex + 1}/${outputs.length} (${extraOutput.filename})...`);
                const extraBinary = await downloadOutputBinary(extraOutput);
                const extraSmartObjectRef = item.ref;
                await openSmartObjectLayerForEdit(extraSmartObjectRef.docId, extraSmartObjectRef.layerId);
                await importOutputIntoActiveDocumentWithoutScaling(extraBinary, extraOutput.filename);
                await saveAndCloseActiveDocument();
            }
            log("Generate: imported all declared outputs into duplicated crop Smart Objects.");
        }
        // Re-focus and re-show the host layer so users can immediately see the updated result in the main document.
        try {
            const hostDoc = getOpenDocumentById(targetSmartObject.docId);
            const hostLayer = hostDoc ? getLayerById(hostDoc, targetSmartObject.layerId) : null;
            if (hostDoc && hostLayer) {
                app.activeDocument = hostDoc;
                hostDoc.activeLayers = [hostLayer];
                hostLayer.visible = true;
            }
        } catch (_e) {}
        log(`Generate: imported output by replacing contents inside ${primaryOutputLayerName}.`);
    } else if (hasSelectionPlacement) {
        // Crop jobs: the result is placed as its own Smart Object over the crop area (no copy of
        // the original crop inside it), then masked: with the workflow's export_mask when it
        // provides one (as before, that mask is what the result ends up with), otherwise with the
        // soft edge mask.
        const isCropResult = Boolean(options.cropResult);
        log("Generate: importing output into stored selection bounds...");
        const placedResult = await importOutputIntoSelectionBounds(binary, output.filename, {
            selectionBounds,
            targetDocId: options.targetDocId || null,
            targetDocName: options.targetDocName || ""
        });
        log("Generate: imported output and aligned it to the original selection bounds.");
        if (isCropResult) {
            const hasWorkflowMask = Boolean(maskBinary && maskOutput && placedResult);
            await finishCropResultLayer(placedResult, selectionBounds, { applySoftMask: !hasWorkflowMask });
            if (hasWorkflowMask) {
                log("Generate: importing export_mask into the crop area...");
                const placedMask = await importOutputIntoSelectionBounds(maskBinary, maskOutput.filename, {
                    selectionBounds,
                    targetDocId: options.targetDocId || null,
                    targetDocName: options.targetDocName || ""
                });
                if (placedMask) {
                    try {
                        await applySourceRGBToTargetMaskInDocument(placedResult.docId, placedResult.layerId, placedMask.layerId);
                        log("Generate: applied export_mask to crop output.");
                    } finally {
                        await deleteLayerById(placedMask.docId, placedMask.layerId);
                        log("Generate: deleted temporary export_mask layer.");
                    }
                }
            }
        }
        if (Array.isArray(outputs) && outputs.length > 1) {
            // Keep selection-placement behavior consistent with other Auto Run import modes:
            // every declared SaveImage result is imported, each aligned to the same stored bounds.
            for (let extraIndex = 1; extraIndex < outputs.length; extraIndex += 1) {
                const extraOutput = outputs[extraIndex];
                if (!extraOutput) continue;
                log(`Generate: importing additional selection output ${extraIndex + 1}/${outputs.length} (${extraOutput.filename})...`);
                const extraBinary = await downloadOutputBinary(extraOutput);
                const placedExtra = await importOutputIntoSelectionBounds(extraBinary, extraOutput.filename, {
                    selectionBounds,
                    targetDocId: options.targetDocId || null,
                    targetDocName: options.targetDocName || ""
                });
                if (isCropResult) await finishCropResultLayer(placedExtra, selectionBounds);
            }
            log("Generate: imported all declared outputs into the stored selection bounds.");
        }
    } else {
        log("Generate: importing output into Photoshop...");
        const imported = await importOutputIntoPhotoshop(binary, output.filename, {
            targetDocId,
            targetDocName: options.targetDocName || "",
            layerName: primaryOutputLayerName
        });
        log("Generate: imported output as a new layer.");
        if (maskBinary && maskOutput && imported) {
            log("Generate: importing export_mask into Photoshop...");
            const importedMask = await importOutputIntoPhotoshop(maskBinary, maskOutput.filename, {
                targetDocId,
                targetDocName: options.targetDocName || "",
                layerName: buildOutputLayerNameFromFilename(maskOutput.filename)
            });
            if (importedMask) {
                try {
                    await applySourceRGBToTargetMaskInDocument(imported.docId, imported.layerId, importedMask.layerId);
                    log("Generate: applied export_mask to output.");
                } finally {
                    await deleteLayerById(importedMask.docId, importedMask.layerId);
                    log("Generate: deleted temporary export_mask layer.");
                }
            }
        }
        if (Array.isArray(outputs) && outputs.length > 1) {
            for (let extraIndex = 1; extraIndex < outputs.length; extraIndex += 1) {
                const extraOutput = outputs[extraIndex];
                if (!extraOutput) continue;
                log(`Generate: importing additional output ${extraIndex + 1}/${outputs.length} (${extraOutput.filename})...`);
                const extraBinary = await downloadOutputBinary(extraOutput);
                await importOutputIntoPhotoshop(extraBinary, extraOutput.filename, {
                    targetDocId,
                    targetDocName: options.targetDocName || "",
                    layerName: buildOutputLayerNameFromFilename(extraOutput.filename)
                });
            }
            log("Generate: imported all declared outputs as layers.");
        }
    }

    return output;
}

// Returns open document by id, falling back to a name match (docName) if given. A persisted
// job's targetDocId comes from a prior Photoshop session — Photoshop assigns a fresh document.id
// every time a file is (re)opened, even for the very same file, so that id is guaranteed stale
// after a restart/crash. Without this fallback, resuming/manually-importing such a job would
// always throw "No active Photoshop document." — this was the root cause of multi-crop jobs
// failing to import via the Import button after a Photoshop restart (every crop segment always
// has a targetDocId, unlike a plain single-image job, which often has none and so already fell
// back to the active document).
function getOpenDocumentById(docId, docName) {
    if (docId === null || docId === undefined) return null;
    const docs = app.documents || [];
    for (let i = 0; i < docs.length; i += 1) {
        const doc = docs[i];
        if (!doc) continue;
        if (String(doc.id) === String(docId)) return doc;
    }
    if (docName) {
        for (let i = 0; i < docs.length; i += 1) {
            const doc = docs[i];
            if (doc && doc.name === docName) return doc;
        }
    }
    return null;
}

// Finishes a crop job's result layer (placed by importOutputIntoSelectionBounds): moves it to the
// top of the document and, unless the workflow supplies its own mask, adds the same soft edge mask
// the crop Smart Object used to get, so the result blends into the surrounding image.
// Crop results contain only the generated image; the original pixels stay underneath in the
// document, so no copy of the crop needs to be stored or embedded.
async function finishCropResultLayer(resultRef, cropBounds, options = {}) {
    if (!resultRef) return;
    const applySoftMask = options.applySoftMask !== false;
    await core.executeAsModal(async () => {
        const doc = getOpenDocumentById(resultRef.docId);
        let layer = doc ? getLayerById(doc, resultRef.layerId) : null;
        if (!doc || !layer) return;
        app.activeDocument = doc;
        layer = moveLayerToDocumentTop(layer, doc);
        if (!applySoftMask || !cropBounds) return;
        try {
            const expandPx = getCropExpandPxForBounds(cropBounds);
            const contractPx = getContractPxFromExpandPx(expandPx);
            const featherPx = getCropMaskFeatherPxForBounds(cropBounds);
            const masked = await applySoftSelectionMaskToLayer(doc, layer, {
                selectionBounds: cropBounds,
                contractBeforeMaskPx: contractPx,
                maskFeatherPx: featherPx,
                replaceActiveSelection: true
            });
            log(masked
                ? `Applied soft selection mask to crop result (contract=${Number(contractPx).toFixed(1)}px, feather=${Number(featherPx).toFixed(1)}px).`
                : "Crop result mask skipped: no active selection available.");
        } catch (error) {
            log(`Crop result mask warning: ${describeError(error)}`);
        }
    }, { commandName: "QuickAI Finish Crop Result" });
}

// Places imported output into a bounded region and preserves non-destructive placement behavior.
// Returns { docId, layerId } of the placed Smart Object (null if it could not be resolved), so
// callers can post-process it (e.g. crop results get a soft edge mask or the workflow's mask).
async function importOutputIntoSelectionBounds(binary, filename, options = {}) {
    const selectionBounds = options.selectionBounds || null;
    if (
        !selectionBounds
        || typeof selectionBounds.left !== "number"
        || typeof selectionBounds.top !== "number"
        || typeof selectionBounds.right !== "number"
        || typeof selectionBounds.bottom !== "number"
    ) {
        throw new Error("Missing valid selection bounds for Generate placement.");
    }

    const targetBoundsW = selectionBounds.right - selectionBounds.left;
    const targetBoundsH = selectionBounds.bottom - selectionBounds.top;
    if (!(targetBoundsW > 0 && targetBoundsH > 0)) {
        throw new Error("Invalid selection bounds size for Generate placement.");
    }
    log(
        `Generate selection stored bounds: top-left=(${Math.round(selectionBounds.left)},${Math.round(selectionBounds.top)}) ` +
        `size=${Math.round(targetBoundsW)}x${Math.round(targetBoundsH)}`
    );

    // 1) Persist downloaded bytes to a temporary local file so Photoshop can open it.
    const file = await writeBinaryToTempImportFile(binary, filename);
    const targetDocId = options.targetDocId || null;
    const isVideoImport = isVideoOutputFilename(filename);
    let debugInfo = null;
    let placedRef = null;

    await core.executeAsModal(async () => {
        // 2) Resolve target doc and normalize source resolution before duplicate-to-target.
        const targetDoc = targetDocId ? getOpenDocumentById(targetDocId, options.targetDocName) : app.activeDocument;
        if (!targetDoc) {
            throw new Error("Target Photoshop document for Generate selection placement is no longer available.");
        }
        const targetResolution = Number(targetDoc.resolution) || 72;
        let sourceDoc = null;

        try {
            if (isVideoImport) {
                // Video outputs are placed directly as a Smart Object (no source doc to open/resize),
                // then scaled to fill the stored selection bounds below like any other output.
                app.activeDocument = targetDoc;
                const placedLayer = await placeOutputFileAsSmartObject(file, targetDoc);
                if (!placedLayer) throw new Error("Could not place downloaded video as Smart Object.");
                targetDoc.activeLayers = [placedLayer];

                let fitMode = "none";
                let appliedWidthScale = 1;
                let appliedHeightScale = 1;
                const initialBounds = getLayerBoundsPixels(placedLayer);
                let expectedW = initialBounds ? (initialBounds.right - initialBounds.left) : 0;
                let expectedH = initialBounds ? (initialBounds.bottom - initialBounds.top) : 0;
                if (expectedW > 0 && expectedH > 0) {
                    fitMode = "stretch_to_selection";
                    appliedWidthScale = targetBoundsW / expectedW;
                    appliedHeightScale = targetBoundsH / expectedH;
                    const scaleXPercent = appliedWidthScale * 100;
                    const scaleYPercent = appliedHeightScale * 100;
                    if (
                        Number.isFinite(scaleXPercent) &&
                        Number.isFinite(scaleYPercent) &&
                        (Math.abs(scaleXPercent - 100) >= 0.01 || Math.abs(scaleYPercent - 100) >= 0.01)
                    ) {
                        await placedLayer.scale(scaleXPercent, scaleYPercent);
                    }
                }

                let importedSmartLayer = targetDoc.activeLayers && targetDoc.activeLayers[0];
                if (!importedSmartLayer) {
                    throw new Error("Generate output import failed to create a Smart Object layer.");
                }
                try { importedSmartLayer.name = buildOutputLayerNameFromFilename(filename); } catch (_e) {}
                placedRef = { docId: targetDoc.id, layerId: importedSmartLayer.id };

                const b = getLayerBoundsPixels(importedSmartLayer)
                    || await getLayerBoundsPixelsById(targetDoc.id, importedSmartLayer.id);
                if (b) {
                    const dx = selectionBounds.left - b.left;
                    const dy = selectionBounds.top - b.top;
                    if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
                        await importedSmartLayer.translate(dx, dy);
                    }
                    const finalBounds = getLayerBoundsPixels(importedSmartLayer)
                        || await getLayerBoundsPixelsById(targetDoc.id, importedSmartLayer.id)
                        || b;
                    debugInfo = {
                        srcW: expectedW,
                        srcH: expectedH,
                        targetW: targetBoundsW,
                        targetH: targetBoundsH,
                        fitMode,
                        appliedWidthScale,
                        appliedHeightScale,
                        finalLayerW: finalBounds.right - finalBounds.left,
                        finalLayerH: finalBounds.bottom - finalBounds.top
                    };
                }
                return;
            }
            sourceDoc = await app.open(file);
            if (!sourceDoc) throw new Error("Could not open downloaded image for import.");
            const sourceResolution = Number(sourceDoc.resolution) || 72;
            if (Math.abs(sourceResolution - targetResolution) > 0.001) {
                await sourceDoc.resizeImage(sourceDoc.width, sourceDoc.height, targetResolution);
            }

            let expectedW = Number(sourceDoc.width);
            let expectedH = Number(sourceDoc.height);
            let fitMode = "none";
            let appliedWidthScale = 1;
            let appliedHeightScale = 1;

            // 3) Work out the fit to the stored selection rectangle. The output's pixels are NOT
            // resampled here: it goes into the Smart Object at its original resolution and the
            // Smart Object layer is scaled to fit below, so the full output (e.g. an upscaler's
            // 2x/4x result) stays inside and the fit stays editable and non-destructive.
            // "Contain" fit (the original crop-placement rule): one uniform scale, so the output
            // keeps its own aspect ratio and is never stretched, chosen so it fits entirely inside
            // the crop rectangle. The side whose proportion matches the crop fills it exactly; on
            // the other side the leftover crop area stays empty (transparent), split evenly by the
            // centering step below. When the aspect ratios match it fills the crop exactly.
            // The scale comes from the image's own pixel size (not its layer bounds), so
            // transparent borders in an output cannot skew it.
            if (expectedW > 0 && expectedH > 0) {
                fitMode = "contain_selection";
                const containScale = Math.min(targetBoundsW / expectedW, targetBoundsH / expectedH);
                appliedWidthScale = containScale;
                appliedHeightScale = containScale;
            }

            const sourceLayer = sourceDoc.activeLayers && sourceDoc.activeLayers[0];
            if (!sourceLayer) throw new Error("Downloaded image has no layer to import.");

            const duplicated = await sourceLayer.duplicate(targetDoc);
            try { duplicated.visible = true; } catch (_e) {}
            app.activeDocument = targetDoc;
            targetDoc.activeLayers = [duplicated];

            // Match bridge import behavior: convert imported raster to a regular Smart Object.
            const convertResult = await action.batchPlay([
                { _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }
            ], {});
            if (convertResult && convertResult[0] && convertResult[0]._obj === "error") {
                throw new Error(convertResult[0].message || "Could not convert Generate output to Smart Object.");
            }

            let importedSmartLayer = targetDoc.activeLayers && targetDoc.activeLayers[0];
            if (!importedSmartLayer) {
                throw new Error("Generate output import failed to create a Smart Object layer.");
            }

            try { importedSmartLayer.name = buildOutputLayerNameFromFilename(filename); } catch (_e) {}

            // Apply the uniform contain scale to the Smart Object layer (a transform outside it),
            // so the full-resolution output stays inside. Position is set by the centering step.
            const containScalePercent = appliedWidthScale * 100;
            if (fitMode === "contain_selection" && Number.isFinite(containScalePercent) && Math.abs(containScalePercent - 100) >= 0.01) {
                try {
                    app.activeDocument = targetDoc;
                    targetDoc.activeLayers = [importedSmartLayer];
                } catch (_e) {}
                await importedSmartLayer.scale(containScalePercent, containScalePercent);
            }

            const translateImportedLayerBy = async (offsetX, offsetY) => {
                if (Math.abs(offsetX) < 0.01 && Math.abs(offsetY) < 0.01) return;
                try {
                    app.activeDocument = targetDoc;
                    targetDoc.activeLayers = [importedSmartLayer];
                } catch (_e) {}
                const layerToMove = (targetDoc.activeLayers && targetDoc.activeLayers[0]) || importedSmartLayer;
                await layerToMove.translate(offsetX, offsetY);
                importedSmartLayer = layerToMove;
            };

            const b = getLayerBoundsPixels(importedSmartLayer)
                || await getLayerBoundsPixelsById(targetDoc.id, importedSmartLayer.id);
            if (b) {
                // 4) Translate the imported Smart Object so its center sits on the stored selection's
                // center (with a contain fit the layer can be narrower than the crop on one side, so
                // centering, not top-left anchoring, splits the empty border evenly on both sides).
                const selectionCenterX = (selectionBounds.left + selectionBounds.right) / 2;
                const selectionCenterY = (selectionBounds.top + selectionBounds.bottom) / 2;
                const centerOffset = (bounds) => ({
                    dx: selectionCenterX - ((bounds.left + bounds.right) / 2),
                    dy: selectionCenterY - ((bounds.top + bounds.bottom) / 2)
                });
                const { dx, dy } = centerOffset(b);
                log(
                    `Generate selection placement pre: selectionCenter=(${selectionCenterX.toFixed(1)},${selectionCenterY.toFixed(1)}) ` +
                    `layer=(${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.right - b.left)}x${Math.round(b.bottom - b.top)}) ` +
                    `delta=(${dx.toFixed(2)},${dy.toFixed(2)})`
                );
                await translateImportedLayerBy(dx, dy);
                let finalBounds = getLayerBoundsPixels(importedSmartLayer)
                    || await getLayerBoundsPixelsById(targetDoc.id, importedSmartLayer.id)
                    || b;
                const residual = centerOffset(finalBounds);
                log(
                    `Generate selection placement post-1: layerTL=(${Math.round(finalBounds.left)},${Math.round(finalBounds.top)}) ` +
                    `residual=(${residual.dx.toFixed(2)},${residual.dy.toFixed(2)})`
                );
                // A residual under half a pixel is just the even/odd split of the border and
                // cannot be moved away (layers move in whole pixels); only correct real drift.
                if (Math.abs(residual.dx) >= 0.5 || Math.abs(residual.dy) >= 0.5) {
                    // Perform a second corrective move to absorb rounding drift.
                    await translateImportedLayerBy(residual.dx, residual.dy);
                    finalBounds = getLayerBoundsPixels(importedSmartLayer)
                        || await getLayerBoundsPixelsById(targetDoc.id, importedSmartLayer.id)
                        || finalBounds;
                    log(
                        `Generate selection placement post-2: layerTL=(${Math.round(finalBounds.left)},${Math.round(finalBounds.top)})`
                    );
                }
                const layerW = finalBounds.right - finalBounds.left;
                const layerH = finalBounds.bottom - finalBounds.top;
                placedRef = { docId: targetDoc.id, layerId: importedSmartLayer.id };
                debugInfo = {
                    srcW: expectedW,
                    srcH: expectedH,
                    targetW: targetBoundsW,
                    targetH: targetBoundsH,
                    fitMode,
                    appliedWidthScale,
                    appliedHeightScale,
                    finalLayerW: layerW,
                    finalLayerH: layerH
                };
            } else {
                log("Generate selection import warning: could not read layer bounds for final placement.");
                placedRef = { docId: targetDoc.id, layerId: importedSmartLayer.id };
            }
        } finally {
            // 5) Always close temp source doc without saving and restore focus to target doc.
            if (sourceDoc) {
                try {
                    app.activeDocument = sourceDoc;
                    await action.batchPlay([
                        {
                            _obj: "close",
                            saving: { _enum: "yesNo", _value: "no" },
                            _options: { dialogOptions: "dontDisplay" }
                        }
                    ], {});
                } catch (_e) {}
            }
            try {
                app.activeDocument = targetDoc;
            } catch (_e) {}
        }
    }, { commandName: "QuickAI Import Output To Selection Bounds" });

    if (debugInfo) {
        log(
            `Generate selection import debug: src=${Math.round(debugInfo.srcW)}x${Math.round(debugInfo.srcH)} ` +
            `target=${Math.round(debugInfo.targetW)}x${Math.round(debugInfo.targetH)} ` +
            `fit=${debugInfo.fitMode || "none"} ` +
            `scale=${Number(debugInfo.appliedWidthScale || 1).toFixed(4)}x${Number(debugInfo.appliedHeightScale || 1).toFixed(4)} ` +
            `final=${Math.round(debugInfo.finalLayerW)}x${Math.round(debugInfo.finalLayerH)}`
        );
    }
    return placedRef;
}

// Queries Comfy queue/history APIs to infer run progress for one prompt id.
async function fetchComfyProgressForPrompt(promptId, options = {}) {
    let response;
    try {
        response = await fetch(comfyApiUrl("/progress", options));
    } catch (_e) {
        return null;
    }
    if (!response.ok) return null;

    let data = null;
    try {
        data = await response.json();
    } catch (_e) {
        return null;
    }

    const payload = (data && typeof data === "object" && data.data && typeof data.data === "object")
        ? data.data
        : data;
    if (!payload || typeof payload !== "object") return null;

    const payloadPromptId = payload.prompt_id;
    if (promptId && payloadPromptId && String(payloadPromptId) !== String(promptId)) return null;

    const value = Number(payload.value);
    const max = Number(payload.max);
    if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;

    const percent = Math.max(0, Math.min(100, (value / max) * 100));
    let queueRemaining = null;
    try {
        const queueResponse = await fetch(comfyApiUrl("/prompt", options));
        if (queueResponse.ok) {
            const queueData = await queueResponse.json();
            const queueCount = Number(queueData?.exec_info?.queue_remaining);
            if (Number.isFinite(queueCount) && queueCount >= 0) queueRemaining = Math.trunc(queueCount);
        }
    } catch (_e) {}
    return {
        percent,
        label: `${Math.round(percent)}%`,
        state: "running",
        queueRemaining
    };
}

// Returns queue state for one prompt id using /queue.
async function fetchComfyQueueStateForPrompt(promptId, options = {}) {
    const targetPromptId = String(promptId || "").trim();
    if (!targetPromptId) return null;
    let response;
    try {
        response = await fetch(comfyApiUrl("/queue", options));
    } catch (_e) {
        return null;
    }
    if (!response.ok) return null;
    let data = null;
    try {
        data = await response.json();
    } catch (_e) {
        return null;
    }

    const getPromptIdFromItem = (item) => {
        if (Array.isArray(item) && item.length > 1) return String(item[1] || "").trim();
        if (item && typeof item === "object") {
            if (item.prompt_id !== undefined && item.prompt_id !== null) return String(item.prompt_id).trim();
            if (item.promptId !== undefined && item.promptId !== null) return String(item.promptId).trim();
            if (item.id !== undefined && item.id !== null) return String(item.id).trim();
        }
        return "";
    };
    const includesPromptId = (items) => {
        if (!Array.isArray(items)) return false;
        for (let i = 0; i < items.length; i += 1) {
            if (getPromptIdFromItem(items[i]) === targetPromptId) return true;
        }
        return false;
    };

    const runningItems = Array.isArray(data?.queue_running) ? data.queue_running : [];
    const pendingItems = Array.isArray(data?.queue_pending) ? data.queue_pending : [];
    const isRunning = includesPromptId(runningItems);
    const isQueued = !isRunning && includesPromptId(pendingItems);
    const queueRemaining = pendingItems.length;

    if (!isRunning && !isQueued) return null;
    return {
        state: isRunning ? "running" : "queued",
        queueRemaining
    };
}

// Polls Comfy Cloud job endpoint until completion/failure/cancel/timeout.
async function waitForAutoRunCloudPromptResult(promptId, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 300000;
    const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 1000;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : () => false;
    const deadline = Date.now() + timeoutMs;
    let lastLoggedStatus = "";

    while (Date.now() < deadline) {
        if (shouldStop()) throw new Error("Generation stopped by user.");
        let response;
        try {
            response = await fetch(
                comfyApiUrl(`/api/job/${encodeURIComponent(String(promptId))}/status`, { useCloud: true }),
                { headers: buildComfyRequestHeaders({ useCloud: true }) }
            );
        } catch (_e) {
            if (shouldStop()) throw new Error("Generation stopped by user.");
            await sleep(pollMs);
            continue;
        }
        if (!response.ok) {
            if (shouldStop()) throw new Error("Generation stopped by user.");
            await sleep(pollMs);
            continue;
        }
        let statusData = null;
        try {
            statusData = await response.json();
        } catch (_e) {
            if (shouldStop()) throw new Error("Generation stopped by user.");
            await sleep(pollMs);
            continue;
        }
        const status = String(statusData?.status || "").toLowerCase().trim();
        const statusMessage = String(statusData?.error || statusData?.message || "").trim();
        const normalizedStatus = status === "success"
            ? "completed"
            : status === "running"
                ? "in_progress"
                : status;
        if (normalizedStatus && normalizedStatus !== lastLoggedStatus) {
            log(
                `Generate: cloud status for ${promptId}: ${normalizedStatus}`
                + `${statusMessage ? ` (${statusMessage})` : ""}.`
            );
            lastLoggedStatus = normalizedStatus;
        }
        if (onProgress) {
            const progressState = normalizeAutoRunProgressState(normalizedStatus || "pending");
            const pct = progressState === "completed" ? 100 : progressState === "running" ? 50 : 10;
            const label = (normalizedStatus === "error" || normalizedStatus === "failed" || normalizedStatus === "cancelled")
                ? (statusMessage ? `${normalizedStatus}: ${statusMessage}` : (normalizedStatus || "pending"))
                : (normalizedStatus || "pending");
            onProgress({ percent: pct, label, state: progressState });
        }
        if (normalizedStatus === "completed") {
            // Job status can flip to completed slightly before outputs are queryable in /api/jobs.
            const detailDeadline = Math.min(deadline, Date.now() + 30000);
            let lastDetailError = "";
            while (Date.now() < detailDeadline) {
                if (shouldStop()) throw new Error("Generation stopped by user.");
                let detailResponse;
                try {
                    detailResponse = await fetch(
                        comfyApiUrl(`/api/jobs/${encodeURIComponent(String(promptId))}`, { useCloud: true }),
                        { headers: buildComfyRequestHeaders({ useCloud: true }) }
                    );
                } catch (_e) {
                    if (shouldStop()) throw new Error("Generation stopped by user.");
                    await sleep(Math.min(1000, pollMs));
                    continue;
                }
                if (!detailResponse.ok) {
                    try {
                        const text = await detailResponse.text();
                        lastDetailError = `Comfy Cloud job detail failed ${detailResponse.status}: ${text}`;
                    } catch (_e) {
                        lastDetailError = `Comfy Cloud job detail failed ${detailResponse.status}.`;
                    }
                    await sleep(Math.min(1000, pollMs));
                    continue;
                }
                const detail = await detailResponse.json();
                if (getImageOutputsFromHistoryEntry(detail).length > 0) {
                    return detail;
                }
                lastDetailError = "Comfy Cloud job completed but output metadata is not ready yet.";
                await sleep(Math.min(1000, pollMs));
            }
            throw new Error(lastDetailError || "Comfy Cloud job completed but output metadata could not be retrieved.");
        }
        if (normalizedStatus === "failed" || normalizedStatus === "cancelled" || normalizedStatus === "error") {
            const detail = statusMessage || normalizedStatus || "job failed";
            throw new Error(`Comfy Cloud job ${normalizedStatus}: ${detail}`);
        }
        if (shouldStop()) throw new Error("Generation stopped by user.");
        await sleep(pollMs);
    }
    return null;
}

// Polls RunComfy request status/result until completion/failure/cancel/timeout.
async function waitForAutoRunRunComfyPromptResult(promptId, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 300000;
    const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 1000;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : () => false;
    const deadline = Date.now() + timeoutMs;
    const deploymentId = getRunComfyDeploymentId();
    const token = getRunComfyApiToken();
    if (!token) throw new Error("RunComfy mode requires RunComfy API Token in Settings.");
    if (!deploymentId) throw new Error("RunComfy mode requires selecting a Deployment.");
    let lastLoggedStatus = "";

    while (Date.now() < deadline) {
        if (shouldStop()) throw new Error("Generation stopped by user.");
        let response;
        try {
            response = await fetch(
                runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}/requests/${encodeURIComponent(String(promptId))}/status`),
                { headers: buildRunComfyRequestHeaders() }
            );
        } catch (_e) {
            await sleep(pollMs);
            continue;
        }
        if (!response.ok) {
            await sleep(pollMs);
            continue;
        }

        let statusData = null;
        try {
            statusData = await response.json();
        } catch (_e) {
            await sleep(pollMs);
            continue;
        }

        const normalizedStatus = String(
            statusData?.status
            || statusData?.request_status
            || statusData?.state
            || ""
        ).toLowerCase().trim();
        const statusMessage = String(statusData?.error || statusData?.message || "").trim();
        if (normalizedStatus && normalizedStatus !== lastLoggedStatus) {
            log(`Generate: runcomfy status for ${promptId}: ${normalizedStatus}${statusMessage ? ` (${statusMessage})` : ""}.`);
            lastLoggedStatus = normalizedStatus;
        }
        if (onProgress) {
            const progressState = (
                normalizedStatus === "running"
                || normalizedStatus === "in_progress"
                || normalizedStatus === "processing"
                || normalizedStatus === "started"
            )
                ? "running"
                : (
                    normalizedStatus === "queued"
                    || normalizedStatus === "pending"
                    || normalizedStatus === "created"
                    || normalizedStatus === "waiting"
                )
                    ? "queued"
                    : normalizedStatus === "completed"
                        ? "completed"
                        : normalizedStatus || "pending";
            const pct = progressState === "completed" ? 100 : progressState === "running" ? 50 : 10;
            onProgress({
                percent: pct,
                label: normalizedStatus || "pending",
                state: progressState
            });
        }
        if (normalizedStatus === "completed" || normalizedStatus === "succeeded" || normalizedStatus === "success") {
            const resultResponse = await fetch(
                runComfyApiUrl(`/prod/v2/deployments/${encodeURIComponent(deploymentId)}/requests/${encodeURIComponent(String(promptId))}/result`),
                { headers: buildRunComfyRequestHeaders() }
            );
            if (!resultResponse.ok) {
                const text = await resultResponse.text();
                throw new Error(`RunComfy result failed ${resultResponse.status}: ${text}`);
            }
            return await resultResponse.json();
        }
        if (normalizedStatus === "failed" || normalizedStatus === "error" || normalizedStatus === "cancelled" || normalizedStatus === "canceled") {
            throw new Error(`RunComfy job ${normalizedStatus}: ${statusMessage || normalizedStatus}`);
        }
        await sleep(pollMs);
    }
    return null;
}

// Polls RunPod request status until completion/failure/cancel/timeout.
async function waitForAutoRunRunPodPromptResult(promptId, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 300000;
    const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 1000;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : () => false;
    const deadline = Date.now() + timeoutMs;
    const endpointId = String(options.runPodEndpointId || getRunPodEndpointId() || "").trim();
    const token = getRunPodApiToken();
    if (!token) throw new Error("RunPod mode requires RunPod API Token in Settings.");
    if (!endpointId) throw new Error("RunPod mode requires selecting an Endpoint.");
    let lastLoggedStatus = "";

    while (Date.now() < deadline) {
        if (shouldStop()) throw new Error("Generation stopped by user.");
        let response;
        try {
            response = await fetch(
                runPodEndpointApiUrl(endpointId, `/status/${encodeURIComponent(String(promptId))}`),
                { headers: buildRunPodRequestHeaders() }
            );
        } catch (_e) {
            await sleep(pollMs);
            continue;
        }
        if (!response.ok) {
            await sleep(pollMs);
            continue;
        }

        let statusData = null;
        try {
            statusData = await response.json();
        } catch (_e) {
            await sleep(pollMs);
            continue;
        }

        const normalizedStatus = String(
            statusData?.status
            || statusData?.request_status
            || statusData?.state
            || ""
        ).toLowerCase().trim();
        const statusMessage = String(
            statusData?.error
            || statusData?.message
            || statusData?.output?.message
            || ""
        ).trim();
        if (normalizedStatus && normalizedStatus !== lastLoggedStatus) {
            log(`Generate: runpod status for ${promptId}: ${normalizedStatus}${statusMessage ? ` (${statusMessage})` : ""}.`);
            lastLoggedStatus = normalizedStatus;
        }
        if (onProgress) {
            const progressState = normalizeAutoRunProgressState(normalizedStatus || "pending");
            const pct = progressState === "completed" ? 100 : progressState === "running" ? 50 : 10;
            onProgress({
                percent: pct,
                label: normalizedStatus || "pending",
                state: progressState
            });
        }
        if (normalizedStatus === "completed" || normalizedStatus === "succeeded" || normalizedStatus === "success") {
            return statusData;
        }
        if (normalizedStatus === "failed" || normalizedStatus === "error" || normalizedStatus === "cancelled" || normalizedStatus === "canceled" || normalizedStatus === "timed_out") {
            throw new Error(`RunPod job ${normalizedStatus}: ${statusMessage || normalizedStatus}`);
        }
        await sleep(pollMs);
    }
    return null;
}

// Polls Comfy until a prompt completes/fails/times out while reporting progress callbacks.
async function waitForAutoRunPromptResult(promptId, options = {}) {
    if (options.useRunPod) {
        return await waitForAutoRunRunPodPromptResult(promptId, options);
    }
    if (options.useRunComfy) {
        return await waitForAutoRunRunComfyPromptResult(promptId, options);
    }
    if (options.useCloud) {
        return await waitForAutoRunCloudPromptResult(promptId, options);
    }
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 120000;
    const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 1000;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : () => false;
    const deadline = Date.now() + timeoutMs;

    // Poll until completion/failure/timeout. Progress is opportunistic via /progress endpoint.
    while (Date.now() < deadline) {
        if (shouldStop()) throw new Error("Generation stopped by user.");
        if (onProgress) {
            const progress = await fetchComfyProgressForPrompt(promptId, options);
            if (progress) {
                onProgress(progress);
            } else {
                const queueState = await fetchComfyQueueStateForPrompt(promptId, options);
                if (queueState) {
                    onProgress({
                        percent: queueState.state === "running" ? 50 : 10,
                        label: queueState.state,
                        state: queueState.state,
                        queueRemaining: queueState.queueRemaining
                    });
                }
            }
        }

        let response;
        try {
            response = await fetch(comfyApiUrl(`/history/${encodeURIComponent(String(promptId))}`, options));
        } catch (_e) {
            if (shouldStop()) throw new Error("Generation stopped by user.");
            await sleep(pollMs);
            continue;
        }

        if (!response.ok) {
            if (shouldStop()) throw new Error("Generation stopped by user.");
            await sleep(pollMs);
            continue;
        }

        let historyData = null;
        try {
            historyData = await response.json();
        } catch (_e) {
            if (shouldStop()) throw new Error("Generation stopped by user.");
            await sleep(pollMs);
            continue;
        }

        const entry = getHistoryEntryForPrompt(historyData, promptId);
        if (!entry) {
            if (shouldStop()) throw new Error("Generation stopped by user.");
            await sleep(pollMs);
            continue;
        }

        const errorDetail = extractExecutionErrorFromHistoryEntry(promptId, entry);
        if (errorDetail) {
            // Surface node-level workflow execution failures immediately.
            throw new Error(errorDetail);
        }

        const status = entry?.status || {};
        const statusStr = String(status?.status_str || status?.status || "").toLowerCase().trim();
        const isCompleted = Boolean(status?.completed)
            || statusStr === "success"
            || statusStr === "completed";
        if (isCompleted) return entry;
        if (shouldStop()) throw new Error("Generation stopped by user.");
        await sleep(pollMs);
    }

    return null;
}

// Captures a runnable Auto Run job immediately so queued jobs preserve their document/workflow context.
// reusableSnapshotFiles: optional array of already-exported main-canvas snapshot files, indexed
// by runIndex, supplied by runAutoRunSelectedWorkflow's batch loop when batch > 1. The canvas
// doesn't change between batch iterations (only seed parameters are randomized), so the same
// export can be reused for every batch job instead of re-exporting per iteration.
// options.targetDocId: when set (batch items 2..N), the job targets that document by id instead
// of whatever Photoshop reports as active right now, so every job in a batch lands in the same
// document even if an import (or the user) switched documents between items.
async function prepareAutoRunSelectedWorkflowJob(reusableSnapshotFiles = null, options = {}) {
    const config = getWorkflowConfigById(autoRunState.selectedWorkflow);
    if (!config) throw new Error("No workflow selected.");
    if (!config.jsonFileName) {
        throw new Error(`No JSON file found in ${config.sourceFolderLabel || WORKFLOWS_FOLDER_NAME}/${config.folderName}.`);
    }

    // Reserved up front (rather than at job-object construction time below) so files saved for
    // this job (its thumbnail, see writeAutoRunThumbnailForPersistence) can be named after it.
    const reservedJobId = autoRunState.nextJobId++;
    const parameterValues = collectAutoRunParameterValues();
    validateAutoRunParameterValues(parameterValues);
    const parameterDefs = cloneAutoRunData(autoRunState.parameterDefs);
    const workflowNodeTargets = cloneAutoRunData(autoRunState.workflowNodeTargets);
    // Workflows with no declared input node (no "input:" token in the YAML, e.g. pure
    // text-to-video/text-to-image nodes) never receive a Photoshop image — skip selection
    // scanning, cropping, and snapshot export entirely for them.
    // Only an image-typed main input slot (inputName "image", i.e. a LoadImage/LoadMask loader)
    // triggers the Photoshop snapshot export/upload pipeline. LoadVideo/LoadAudio slots are
    // declarable but have no Photoshop-side plumbing — see
    // inferLoaderInputFieldName and buildAutoRunPrompt's per-slot injection.
    const hasImportNode = Array.isArray(workflowNodeTargets.inputs)
        && workflowNodeTargets.inputs.length > 0
        && String(workflowNodeTargets.inputs[0]?.inputName || "") === "image";
    // "Main Input" mode — see MAIN_INPUT_MODE_* constants. Current Canvas is the default and
    // matches all prior behavior; Selected Layer And Below hides layers above the selection
    // before capturing; Set Manually skips canvas capture and instead uses whatever layer the
    // user attached to the Inputs box's trailing manual slot (see additionalInputsParamDef below).
    const mainInputModeParamDef = parameterDefs.find((p) => String(p?.name || "") === MAIN_INPUT_MODE_PARAM_NAME);
    const mainInputMode = mainInputModeParamDef
        ? String(parameterValues[mainInputModeParamDef.key] || MAIN_INPUT_MODE_CANVAS)
        : MAIN_INPUT_MODE_CANVAS;
    // User opt-out via the checkbox next to the main input row (see createMainInputSendCheckbox) —
    // only ever offered/settable outside Set Manually mode (and only when the YAML doesn't mark
    // the main input required), so it's ignored here in Set Manually even if a stale value carried
    // over from a prior mode switch — that mode's own trailing-slot attach/detach state is what
    // controls whether anything gets sent.
    const mainInputReferenceListWrapper = nanoBananaForm?.querySelector('[data-param-type="reference_list"]') || null;
    const mainInputDisabled = mainInputMode !== MAIN_INPUT_MODE_MANUAL
        && mainInputReferenceListWrapper?.getAttribute("data-main-input-disabled") === "true";
    const shouldCaptureCanvasForMainSlot = hasImportNode && mainInputMode !== MAIN_INPUT_MODE_MANUAL && !mainInputDisabled;
    // Fail fast, before any Photoshop export work starts, if a "required" slot has nothing
    // attached — see parseWorkflowInputTuplesToken for the "required" YAML keyword.
    validateAutoRunRequiredInputs(workflowNodeTargets, parameterDefs, parameterValues, mainInputMode);
    const workflowId = String(autoRunState.selectedWorkflow || "").trim();
    const useRunComfy = isRunComfyEnvironment();
    const useRunPod = isRunPodEnvironment();
    const useCloud = isComfyCloudEnabled();
    const runComfyDeploymentId = String(getRunComfyDeploymentId() || "").trim();
    const runComfyDeploymentLabel = String(getRunComfyDeploymentLabel() || "").trim();
    const runPodEndpointId = String(getRunPodEndpointId() || "").trim();
    const runPodEndpointLabel = String(getRunPodEndpointLabel() || "").trim();
    const localServerSnapshot = normalizeServerSettingValue(settingsState.server || serverField?.value || "127.0.0.1");
    const localPortSnapshot = normalizePort(settingsState.port || portField?.value || "");
    const backendOptions = buildAutoRunBackendOptions({
        useRunComfy,
        useRunPod,
        useCloud,
        runComfyDeploymentId,
        runComfyDeploymentLabel,
        runPodEndpointId,
        runPodEndpointLabel,
        localServer: localServerSnapshot,
        localPort: localPortSnapshot
    });
    const exrRunToken = `qc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let activeDoc = app.activeDocument;
    const lockedTargetDocId = options.targetDocId;
    if (lockedTargetDocId !== null && lockedTargetDocId !== undefined) {
        const lockedDoc = getOpenDocumentById(lockedTargetDocId);
        if (!lockedDoc) {
            throw new Error("The batch's document was closed before all batch jobs were queued.");
        }
        // Make it the active document too: later steps (exports, selection reads) act on the
        // active document, so it must match the job's target before anything else runs.
        if (!activeDoc || String(activeDoc.id) !== String(lockedDoc.id)) {
            await core.executeAsModal(async () => {
                app.activeDocument = lockedDoc;
            }, { commandName: "QuickAI Activate Batch Document" });
        }
        activeDoc = lockedDoc;
    }
    let selectionDocId = activeDoc ? activeDoc.id : null;
    let originalSelectionSnapshot = null;
    let originalSelectionRestored = false;
    let autoRunCropBaseSnapshotFile = null;
    // Set by hideLayersAboveSelectedLayer() (MAIN_INPUT_MODE_SELECTED_LAYER) or
    // isolateSelectedLayerOnly() (MAIN_INPUT_MODE_SELECTED_LAYER_ONLY);
    // undoes the temporary visibility change once every snapshot for this job has been captured.
    let restoreMainInputLayerVisibility = null;

    // Batch items 2..N reuse item 1's run targets: their snapshots are item 1's files, so the
    // targets must be item 1's too (re-reading the selection mid-batch could mismatch them), and
    // skipping the re-read avoids a Photoshop round trip per item.
    const reusableRunTargets = (Array.isArray(options.reusableRunTargets) && options.reusableRunTargets.length > 0
        && Array.isArray(reusableSnapshotFiles))
        ? options.reusableRunTargets
        : null;

    // Workflow settings are saved once per Run; batch items 2..N differ only by seed.
    if (workflowId && !reusableRunTargets) {
        try {
            const selectedConfig = getWorkflowConfigById(workflowId);
            if (selectedConfig?.folderName) {
                await persistWorkflowIniSettings(getWorkflowPathKey(selectedConfig), collectAutoRunParameterRawValues());
            }
        } catch (error) {
            log(`Generate workflow settings save warning (${workflowId}): ${describeError(error)}`);
        }
    }

    let runTargets = [{
        useSelectionCrop: false,
        selectionBounds: null,
        cropPlacementBounds: null,
        targetDocId: selectionDocId
    }];
    let activeSelection = null;

    try {
        if (shouldCaptureCanvasForMainSlot && activeDoc && reusableRunTargets) {
            runTargets = reusableRunTargets.map((target) => ({ ...target }));
        } else if (shouldCaptureCanvasForMainSlot && activeDoc) {
            activeSelection = await getActiveSelectionBounds(activeDoc.id);
            log(
                `Generate crop debug: active document id=${activeDoc.id} `
                + `size=${formatDocumentSizeForLog(activeDoc)} `
                + `selection=${formatBoundsForLog(activeSelection)}`
            );
            if (activeSelection) {
                const componentBounds = await resolveSelectionComponentBounds(activeDoc.id, activeSelection);
                log(`Generate crop debug: component bounds before merge [${componentBounds.map(formatBoundsForLog).join(" | ") || "none"}]`);
                if (componentBounds.length > 0) {
                    const docWidthPx = Number(toPixels(activeDoc.width)) || 0;
                    const mergeThresholdPx = docWidthPx * getCropMergeThresholdLevel();
                    let mergedComponentBounds = mergeNearbySelectionBounds(componentBounds, mergeThresholdPx);
                    log(`Generate crop debug: merge threshold=${Math.round(mergeThresholdPx)}px after merge=[${mergedComponentBounds.map(formatBoundsForLog).join(" | ") || "none"}]`);
                    if (mergedComponentBounds.length < componentBounds.length) {
                        log(`Generate: merged ${componentBounds.length} nearby selection region(s) into ${mergedComponentBounds.length} target(s) using ${mergeThresholdPx}px proximity.`);
                    }
                    const minSelectionWidthPx = docWidthPx * getCropIgnoreWidthLevel();
                    mergedComponentBounds = filterSelectionBoundsByMinimumWidth(mergedComponentBounds, minSelectionWidthPx);
                    log(`Generate crop debug: min width=${Math.round(minSelectionWidthPx)}px after filter=[${mergedComponentBounds.map(formatBoundsForLog).join(" | ") || "none"}]`);
                    if (mergedComponentBounds.length > 0) {
                        runTargets = mergedComponentBounds.map((bounds) => ({
                            useSelectionCrop: true,
                            selectionBounds: bounds,
                            cropPlacementBounds: getExpandedSelectionBoundsForCrop(
                                bounds,
                                activeDoc,
                                getCropExpandPxForBounds(bounds)
                            ),
                            targetDocId: activeDoc.id
                        }));
                        runTargets.forEach((target, index) => {
                            log(
                                `Generate crop debug: target ${index + 1}/${runTargets.length} `
                                + `selection=${formatBoundsForLog(target.selectionBounds)} `
                                + `expand=${Math.round(getCropExpandPxForBounds(target.selectionBounds))}px `
                                + `cropPlacement=${formatBoundsForLog(target.cropPlacementBounds)}`
                            );
                        });
                    } else {
                        log(`Generate: all selection regions were ignored by minimum width (${Math.round(minSelectionWidthPx)}px). Running without cropped selection.`);
                    }
                }
            }
        }

        if (!runTargets[0].useSelectionCrop) {
            runTargets = [{
                useSelectionCrop: false,
                selectionBounds: null,
                cropPlacementBounds: null,
                targetDocId: selectionDocId
            }];
        }

        // Every run target already has a cached snapshot from an earlier batch iteration — no
        // canvas export work (or the layer-isolation it requires) is needed for this call at all.
        const hasReusableSnapshotsForAllTargets = Array.isArray(reusableSnapshotFiles)
            && runTargets.every((_, targetIndex) => Boolean(reusableSnapshotFiles[targetIndex]));

        // Selected Layer And Below: hide everything above the selected layer (or its top-level
        // group) before any snapshot below gets captured, so every export in this job — base
        // snapshot and per-segment fallback alike — sees the layer-limited composite. Restored
        // in this function's finally block once capturing is done.
        if (shouldCaptureCanvasForMainSlot && mainInputMode === MAIN_INPUT_MODE_SELECTED_LAYER && activeDoc
            && !hasReusableSnapshotsForAllTargets) {
            await core.executeAsModal(async () => {
                restoreMainInputLayerVisibility = hideLayersAboveSelectedLayer(activeDoc);
            }, { commandName: "QuickAI Isolate Selected Layer And Below" });
        }
        // Selected Layer: same idea, but only the selected layer stays visible (the Bridge's
        // single-layer isolation), so the main input is that layer alone.
        if (shouldCaptureCanvasForMainSlot && mainInputMode === MAIN_INPUT_MODE_SELECTED_LAYER_ONLY && activeDoc
            && !hasReusableSnapshotsForAllTargets) {
            await core.executeAsModal(async () => {
                restoreMainInputLayerVisibility = isolateSelectedLayerOnly(activeDoc);
            }, { commandName: "QuickAI Isolate Selected Layer" });
        }

        const totalRuns = Math.max(1, runTargets.length);
        const hasCroppedRuns = runTargets.some((target) => target.useSelectionCrop);
        if (hasCroppedRuns && !hasReusableSnapshotsForAllTargets && selectionDocId !== null && selectionDocId !== undefined) {
            originalSelectionSnapshot = await captureSelectionSnapshotInDocument(selectionDocId);
        }
        if (hasCroppedRuns && !hasReusableSnapshotsForAllTargets) {
            const cropBaseStartMs = Date.now();
            log("Generate: preparing base snapshot for crop segment acceleration...");
            autoRunCropBaseSnapshotFile = await exportSnapshotToTempFolder({
                respectSelection: false,
                cropToSelection: false
            });
            log(`Generate: base snapshot prepared in ${Date.now() - cropBaseStartMs}ms.`);
        }

        // Cut every crop that still needs exporting from the base snapshot in one pass, so the
        // full-canvas snapshot is opened once for the whole job rather than once per crop.
        const batchCropFilesByIndex = new Map();
        if (shouldCaptureCanvasForMainSlot && autoRunCropBaseSnapshotFile) {
            const pendingIndexes = runTargets
                .map((target, index) => (
                    (target.useSelectionCrop && !(Array.isArray(reusableSnapshotFiles) && reusableSnapshotFiles[index]))
                        ? index
                        : -1
                ))
                .filter((index) => index >= 0);
            if (pendingIndexes.length > 0) {
                const batchStartMs = Date.now();
                const batchFiles = await exportAutoRunCropSegmentsFromBaseSnapshot(
                    autoRunCropBaseSnapshotFile,
                    pendingIndexes.map((index) => runTargets[index].cropPlacementBounds || runTargets[index].selectionBounds),
                    {
                        onSegmentStart: (batchIndex) => {
                            const runIndex = pendingIndexes[batchIndex];
                            setAutoRunProgressState({
                                visible: true,
                                percent: Math.max(0, Math.min(49, Math.round((runIndex / totalRuns) * 50))),
                                text: formatAutoRunProgressLabel("Preparing", {
                                    segmentIndex: runIndex + 1,
                                    totalSegments: totalRuns
                                })
                            });
                        }
                    }
                );
                pendingIndexes.forEach((runIndex, batchIndex) => batchCropFilesByIndex.set(runIndex, batchFiles[batchIndex]));
                log(`Generate: exported ${batchFiles.length} crop(s) from the base snapshot in ${Date.now() - batchStartMs}ms.`);
            }
        }

        const segments = [];
        for (let runIndex = 0; runIndex < runTargets.length; runIndex += 1) {
            const target = runTargets[runIndex];
            const segmentLabel = runTargets.length > 1 ? `segment ${runIndex + 1}/${runTargets.length}` : "single segment";
            if (target.useSelectionCrop) {
                log(
                    `Generate crop debug: ${segmentLabel} export request `
                    + `selection=${formatBoundsForLog(target.selectionBounds)} `
                    + `cropBounds=${formatBoundsForLog(target.cropPlacementBounds || target.selectionBounds)} `
                    + `targetDocId=${target.targetDocId === null || target.targetDocId === undefined ? "none" : target.targetDocId}`
                );
            }
            setAutoRunProgressState({
                visible: true,
                percent: Math.max(0, Math.min(49, Math.round((runIndex / totalRuns) * 50))),
                text: formatAutoRunProgressLabel("Preparing", {
                    segmentIndex: runIndex + 1,
                    totalSegments: totalRuns
                })
            });
            // No declared input node — this workflow (e.g. text-to-video) takes no image,
            // so skip the Photoshop snapshot export entirely and queue with snapshotFile: null.
            let snapshotFile = null;
            let snapshotReusedFromBatch = false;
            if (shouldCaptureCanvasForMainSlot) {
                const cachedSnapshotFile = Array.isArray(reusableSnapshotFiles) ? reusableSnapshotFiles[runIndex] : null;
                if (cachedSnapshotFile) {
                    snapshotFile = cachedSnapshotFile;
                    snapshotReusedFromBatch = true;
                    log(`Generate: reusing main input snapshot from this batch's first run for ${segmentLabel} (canvas unchanged) ...`);
                } else if (batchCropFilesByIndex.has(runIndex)) {
                    // Already cut above together with the job's other crops.
                    snapshotFile = batchCropFilesByIndex.get(runIndex);
                    log(`Generate: saved local image ${snapshotFile.name}${runTargets.length > 1 ? ` (${segmentLabel})` : ""}`);
                } else {
                    log(`Generate: exporting current view for ${config.folderName}${runTargets.length > 1 ? ` (${segmentLabel})` : ""} ...`);
                    const exportStartMs = Date.now();
                    snapshotFile = (target.useSelectionCrop && autoRunCropBaseSnapshotFile)
                        ? await exportAutoRunCropSegmentFromBaseSnapshot(
                            autoRunCropBaseSnapshotFile,
                            target.cropPlacementBounds || target.selectionBounds
                        )
                        : await exportSnapshotToTempFolder({
                            respectSelection: false,
                            cropToSelection: target.useSelectionCrop
                        });
                    log(`Generate: export for ${segmentLabel} took ${Date.now() - exportStartMs}ms.`);
                    log(`Generate: saved local image ${snapshotFile.name}${runTargets.length > 1 ? ` (${segmentLabel})` : ""}`);
                }
            }
            // What gets saved to the data folder so it survives a Photoshop restart: only a small
            // JPEG thumbnail for the Jobs list. The full input image is never needed again once
            // uploaded (the temp file is what gets sent), and crop results are now placed straight
            // into the crop area without embedding the original crop, so no full-size copy is
            // kept for any job. snapshotPath stays "" for new jobs; older jobs may still have one,
            // which is deleted with the job. Batch items reuse the first item's thumbnail.
            const reusedPersisted = (snapshotReusedFromBatch && Array.isArray(options.reusablePersistedSegments))
                ? options.reusablePersistedSegments[runIndex]
                : null;
            let snapshotPath = "";
            let thumbnailPath = "";
            let thumbnailDataUrl = "";
            if (reusedPersisted) {
                snapshotPath = reusedPersisted.snapshotPath || "";
                thumbnailPath = reusedPersisted.thumbnailPath || "";
                thumbnailDataUrl = reusedPersisted.thumbnailDataUrl || "";
            } else if (snapshotFile) {
                // Built from the live document (same view that was just exported), not by
                // decoding the exported file, so it costs a fraction of a second.
                const thumbnailBase64 = await buildDocumentThumbnailJpegBase64(
                    activeDoc ? activeDoc.id : null,
                    target.useSelectionCrop ? (target.cropPlacementBounds || target.selectionBounds) : null
                );
                if (thumbnailBase64) {
                    thumbnailDataUrl = `data:image/jpeg;base64,${thumbnailBase64}`;
                    thumbnailPath = await writeAutoRunThumbnailForPersistence(reservedJobId, runIndex, thumbnailBase64);
                }
            }
            segments.push({
                runIndex,
                segmentLabel,
                target,
                snapshotFile,
                snapshotPath,
                thumbnailPath,
                thumbnailDataUrl,
                cropSmartObjectRef: null,
                promptId: "",
                exrOutputPrefixes: [],
                queuedAtMs: 0,
                completedEntry: null
            });
        }

        const bypassToggleValues = {};
        const bypassGroups = Array.isArray(workflowNodeTargets.bypassGroups) ? workflowNodeTargets.bypassGroups : [];
        for (let groupIndex = 0; groupIndex < bypassGroups.length; groupIndex += 1) {
            const group = bypassGroups[groupIndex];
            const groupKey = String(group?.key || `bypass_group_${groupIndex + 1}`).trim();
            if (!groupKey) continue;
            const valueKey = buildWorkflowParamKey(`bypass:${groupKey}`, "enabled");
            const liveValue = getAutoRunCheckboxValueByParamKey(valueKey);
            const persistedRaw = parameterValues[valueKey];
            const fallbackDefault = parseAutoRunBooleanValue(group?.default, false);
            const persistedParsed = parseAutoRunBooleanValue(persistedRaw, fallbackDefault);
            bypassToggleValues[groupKey] = liveValue === null ? persistedParsed : Boolean(liveValue);
        }

        // Export attached Photoshop layers for the "additional inputs" reference-list control
        // (declared input slots 1+, beyond the main slot). The list is now a fixed-length,
        // slot-index-aligned array the user assigns explicitly (see syncReferenceListControlState) —
        // slot N in workflowNodeTargets.inputs (1-based here since index 0 is the main slot) gets
        // additionalInputFiles[N-1], which is null for any slot the user left unassigned.
        const additionalInputsParamDef = parameterDefs.find((p) => String(p?.type || "").toLowerCase() === "reference_list");
        const additionalInputFiles = [];
        // MAIN_INPUT_MODE_MANUAL: the main slot's asset comes from the Inputs box's trailing
        // slot (index === referenceLimit — see syncReferenceListControlState's effectiveSlotCount)
        // instead of a canvas capture. null when that mode isn't active or nothing was attached —
        // executePreparedAutoRunJob then leaves the main slot's loader unfilled (deleted), same as
        // any other unfilled slot.
        let mainManualInputFile = null;
        if (additionalInputsParamDef) {
            const referenceLimit = Math.max(0, Number.parseInt(String(additionalInputsParamDef.referenceLimit || "0"), 10) || 0);
            const rawItems = Array.isArray(parameterValues[additionalInputsParamDef.key]) ? parameterValues[additionalInputsParamDef.key] : [];
            for (let i = 0; i < referenceLimit; i += 1) {
                const item = rawItems[i];
                if (!item || !item.layerId) {
                    additionalInputFiles.push(null);
                    continue;
                }
                const file = await getOrExportReferenceLayerSnapshotFile(item);
                additionalInputFiles.push(file);
                log(`Generate: captured additional input ${i + 1} for queued job.`);
            }
            if (mainInputMode === MAIN_INPUT_MODE_MANUAL) {
                const manualMainItem = rawItems[referenceLimit];
                if (manualMainItem && manualMainItem.layerId) {
                    mainManualInputFile = await getOrExportReferenceLayerSnapshotFile(manualMainItem, { neverScaleDown: true });
                    log("Generate: captured manually-set main input for queued job.");
                } else {
                    log("Generate: Main Input is set to \"Set Manually\" but no layer was attached — its loader will be removed from the prompt.");
                }
            }
        }

        if (originalSelectionSnapshot && selectionDocId !== null && selectionDocId !== undefined) {
            await restoreSelectionSnapshotInDocument(selectionDocId, originalSelectionSnapshot);
            originalSelectionRestored = true;
            originalSelectionSnapshot = null;
        }

        return {
            id: reservedJobId,
            state: "queued",
            activityState: "queued",
            progressState: "queued",
            workflowId,
            workflowDisplayName: String(config.displayName || config.folderName || "Generate").trim(),
            config: cloneAutoRunData(config),
            parameterDefs,
            workflowNodeTargets,
            parameterValues: cloneAutoRunData(parameterValues),
            bypassToggleValues: cloneAutoRunData(bypassToggleValues),
            selectionDocId,
            documentName: activeDoc ? String(activeDoc.name || "").trim() : "",
            useRunComfy,
            useRunPod,
            useCloud,
            runComfyDeploymentId,
            runComfyDeploymentLabel,
            runPodEndpointId,
            runPodEndpointLabel,
            backendOptions,
            exrRunToken,
            totalRuns,
            segments,
            // Indexed by runIndex, mirrors segments[].snapshotFile — handed back to
            // runAutoRunSelectedWorkflow so it can reuse these across the rest of a batch run.
            segmentSnapshotFiles: segments.map((segment) => segment.snapshotFile),
            // Saved files per segment, handed to the next batch items so they share them.
            segmentPersisted: segments.map((segment) => ({
                snapshotPath: segment.snapshotPath,
                thumbnailPath: segment.thumbnailPath,
                thumbnailDataUrl: segment.thumbnailDataUrl
            })),
            additionalInputFiles,
            mainInputMode,
            mainManualInputFile,
            promptIds: [],
            createdAtMs: Date.now(),
            lastImportedOutput: null,
            completedRuns: 0,
            queuedRuns: 0,
            stopRequested: false,
            logText: "",
            errorDetail: ""
        };
    } finally {
        if (!originalSelectionRestored && originalSelectionSnapshot && selectionDocId !== null && selectionDocId !== undefined) {
            try {
                await restoreSelectionSnapshotInDocument(selectionDocId, originalSelectionSnapshot);
            } catch (error) {
                log(`Generate selection restore warning: ${describeError(error)}`);
            }
        }
        if (restoreMainInputLayerVisibility) {
            try {
                await core.executeAsModal(async () => {
                    restoreMainInputLayerVisibility();
                }, { commandName: "QuickAI Restore Layer Visibility" });
            } catch (error) {
                log(`Generate layer visibility restore warning: ${describeError(error)}`);
            }
        }
    }
}

// Adds a prepared job to the plugin-side queue and starts the background processor if needed.
function enqueuePreparedAutoRunJob(job) {
    if (!job) return;
    autoRunState.queuedJobs.push(job);
    renderAutoRunJobsDialog();
    syncAutoRunButtonState();
    log(`Generate queue: added ${describeAutoRunJob(job)} (${Math.max(1, Number(job.totalRuns) || 1)} crop${Math.max(1, Number(job.totalRuns) || 1) === 1 ? "" : "s"}).`);
    persistAutoRunJobsToDisk().catch((error) => {
        log(`Generate job persistence warning: ${describeError(error)}`);
    });
    if (!autoRunState.activeJob) {
        setAutoRunProgressState({ visible: true, percent: 0, text: "Queued" });
    } else {
        setAutoRunProgressState({
            visible: autoRunState.progressVisible,
            percent: autoRunState.progressPercent,
            text: autoRunState.progressText
        });
    }
    processAutoRunJobQueue().catch((error) => {
        log(`Generate queue processor error: ${describeError(error)}`);
    });
}

// Moves a finished/failed/stopped job into persisted history and writes updated job history to
// disk. Shared by the live queue processor and by resumeTrackingAutoRunJob() so a job's outcome
// is recorded identically whichever path produced it.
function finalizeAutoRunJob(job) {
    if (!job) return;
    if (job.state === "completed" || job.state === "error" || job.state === "stopped") {
        autoRunState.finishedJobs.unshift(job);
        capFinishedAutoRunJobs();
    }
    // Live and resumed jobs both finalize here, so a failure toast fires once per failed job.
    // (User stops are "stopped", not "error", and stay silent.)
    if (job.state === "error") {
        showPanelToast(`Job ${job.id} failed: ${job.errorDetail || "unknown error"}`, "error", 6000);
    }
    // Persist unconditionally: the last write to disk for this job was made while it was still
    // "running" (or queued), and without a fresh write here that stale record would still say
    // "running" — so restoreAutoRunJobsFromDisk would wrongly resume-track it after a restart
    // even though the user already stopped it.
    persistAutoRunJobsToDisk().catch((error) => {
        log(`Generate job persistence warning: ${describeError(error)}`);
    });
}

// Dispatches every queued Auto Run job immediately and lets the selected backend own queue/concurrency.
// Photoshop-side imports remain serialized separately through withAutoRunImportLock so concurrent backend
// execution never overlaps modal placement/import work in the host app.
async function processAutoRunJobQueue() {
    if (autoRunState.queueProcessorRunning) return;
    autoRunState.queueProcessorRunning = true;
    try {
        while (autoRunState.queuedJobs.length > 0) {
            const job = autoRunState.queuedJobs.shift();
            if (!job) continue;
            autoRunState.activeJobs.push(job);
            job.state = "running";
            syncAutoRunRuntimeStateFromActiveJobs();
            renderAutoRunJobsDialog();
            syncAutoRunButtonState();
            logForJob(job, `Generate queue: starting ${describeAutoRunJob(job)}.`);
            persistAutoRunJobsToDisk().catch((error) => {
                log(`Generate job persistence warning: ${describeError(error)}`);
            });

            executePreparedAutoRunJob(job)
                .catch((error) => {
                    log(`Generate queue processor error: ${describeError(error)}`);
                })
                .finally(() => {
                    autoRunState.activeJobs = autoRunState.activeJobs.filter((activeJob) => activeJob !== job);
                    finalizeAutoRunJob(job);
                    syncAutoRunRuntimeStateFromActiveJobs();
                    renderAutoRunJobsDialog();
                    syncAutoRunButtonState();
                    if (getAutoRunActiveOrQueuedJobCount() < 1) {
                        setAutoRunProgressState({ visible: true, percent: 0, text: "Ready" });
                    } else {
                        // Belt-and-suspenders: executePreparedAutoRunJob already recomputes the
                        // aggregate label right when it completes, but if it rejected before
                        // reaching that point (e.g. an error thrown earlier), make sure the
                        // label still reflects any other jobs still active/queued.
                        setAutoRunProgressState({
                            visible: autoRunState.progressVisible,
                            percent: autoRunState.progressPercent,
                            text: autoRunState.progressText
                        });
                    }
                    processAutoRunJobQueue().catch((queueError) => {
                        log(`Generate queue processor error: ${describeError(queueError)}`);
                    });
                });
        }
    } finally {
        autoRunState.queueProcessorRunning = false;
        syncAutoRunRuntimeStateFromActiveJobs();
        renderAutoRunJobsDialog();
        syncAutoRunButtonState();
    }
}

// Runs one prepared Auto Run job end-to-end using the captured files and document metadata from enqueue time.
async function executePreparedAutoRunJob(job) {
    let autoRunHadError = false;
    const config = job.config;
    const workflowNodeTargets = job.workflowNodeTargets || createDefaultWorkflowNodeTargets();
    const totalRuns = Math.max(1, Number(job.totalRuns) || 1);
    const useRunComfy = Boolean(job.useRunComfy);
    const useRunPod = Boolean(job.useRunPod);
    const useCloud = Boolean(job.useCloud);
    const backendOptions = job.backendOptions || buildAutoRunBackendOptions({
        useRunComfy,
        useRunPod,
        useCloud,
        runComfyDeploymentId: job.runComfyDeploymentId,
        runPodEndpointId: job.runPodEndpointId
    });
    const queuedSegments = Array.isArray(job.segments) ? job.segments : [];

    try {
        setAutoRunProgressState({ visible: true, percent: 0, text: formatAutoRunProgressLabel("Starting", { detail: "init" }) });
        if (getComfyApiKey() && !useCloud && !useRunComfy && !useRunPod) {
            logForJob(job, "Generate: using Comfy API key integration for Partner/API nodes.");
        } else if (useRunComfy) {
            logForJob(job, "Generate: RunComfy mode enabled.");
        } else if (useRunPod) {
            logForJob(job, "Generate: RunPod mode enabled.");
        } else if (useCloud) {
            logForJob(job, "Generate: Comfy Cloud mode enabled.");
        }

        const additionalInputFiles = Array.isArray(job.additionalInputFiles) ? job.additionalInputFiles : [];
        // Uploads (or, for RunComfy/RunPod, encodes) one segment's main input image and returns
        // the name/payload the prompt references plus the per-asset size budget used for it.
        const prepareSegmentMainInput = async (segment) => {
            if (job.stopRequested) throw new Error("Generation stopped by user.");
            // MAIN_INPUT_MODE_MANUAL uses the single layer attached in the Inputs box (constant
            // across every segment in this job) instead of a per-segment canvas capture.
            const mainInputFileForUpload = job.mainInputMode === MAIN_INPUT_MODE_MANUAL
                ? job.mainManualInputFile
                : segment.snapshotFile;
            // Unassigned slots are represented as null (see prepareAutoRunSelectedWorkflowJob) —
            // they aren't uploaded, so they shouldn't count toward the per-asset payload budget.
            const additionalInputFileCount = additionalInputFiles.filter(Boolean).length;
            const runComfyAssetCount = (useRunComfy || useRunPod)
                ? (mainInputFileForUpload ? 1 : 0) + additionalInputFileCount
                : 0;
            const maxBinaryBytesPerAsset = useRunPod
                ? Math.max(
                    RUNPOD_MIN_BINARY_BYTES_PER_ASSET,
                    Math.min(
                        RUNPOD_MAX_BINARY_BYTES,
                        Math.floor(RUNPOD_MAX_TOTAL_BINARY_BYTES / Math.max(1, runComfyAssetCount))
                    )
                )
                : (useRunComfy
                    ? Math.max(
                        RUNCOMFY_MIN_BINARY_BYTES_PER_ASSET,
                        Math.min(
                            RUNCOMFY_MAX_BINARY_BYTES,
                            Math.floor(RUNCOMFY_MAX_TOTAL_BINARY_BYTES / Math.max(1, runComfyAssetCount))
                        )
                    )
                    : RUNCOMFY_MAX_BINARY_BYTES);
            if (useRunComfy || useRunPod) {
                logForJob(job, 
                    `Generate: ${useRunPod ? "RunPod" : "RunComfy"} payload budget ${Math.round(maxBinaryBytesPerAsset / 1024)} KB per asset `
                    + `across ${runComfyAssetCount} asset${runComfyAssetCount === 1 ? "" : "s"}.`
                );
            }
            // No file means either the workflow declared no input node, or Main Input is set to
            // "Set Manually" with nothing attached — skip upload entirely in both cases.
            let uploadedName = "";
            if (mainInputFileForUpload) {
                if (useRunComfy || useRunPod) {
                    const payloadKey = `datauri|${useRunPod ? "runpod" : "runcomfy"}|${maxBinaryBytesPerAsset}`;
                    const reused = hasCachedAutoRunUpload(mainInputFileForUpload, payloadKey);
                    uploadedName = await getCachedAutoRunUpload(mainInputFileForUpload, payloadKey, () => buildRunComfyDataUriFromFile(mainInputFileForUpload, {
                        maxBytes: maxBinaryBytesPerAsset
                    }));
                    logForJob(job, `Generate: ${reused ? "reused" : "prepared"} ${useRunPod ? "RunPod" : "RunComfy"} input image payload${queuedSegments.length > 1 ? ` (${segment.segmentLabel})` : ""}.`);
                } else {
                    const uploadKey = `upload|${comfyBaseUrl(backendOptions)}`;
                    const reused = hasCachedAutoRunUpload(mainInputFileForUpload, uploadKey);
                    if (!reused) logForJob(job, `Generate: uploading to ${comfyBaseUrl(backendOptions)}${useCloud ? "/api/upload/image" : "/upload/image"} ...`);
                    uploadedName = await getCachedAutoRunUpload(mainInputFileForUpload, uploadKey, () => uploadImageToComfy(mainInputFileForUpload, backendOptions));
                    logForJob(job, `Generate: ${reused ? "reusing already uploaded image" : "uploaded image as"} ${uploadedName}${queuedSegments.length > 1 ? ` (${segment.segmentLabel})` : ""}`);
                }
            }

            return { uploadedName, maxBinaryBytesPerAsset };
        };
        // Every segment's main input starts uploading right away, a few at a time, instead of
        // one after another between queue calls: uploads are the slow part of sending a
        // multi-crop job to a remote server. Each prompt is queued below as soon as its own
        // upload is done.
        const mainInputUploads = runWithConcurrencyLimit(
            queuedSegments.map((segment) => () => prepareSegmentMainInput(segment)),
            AUTO_RUN_UPLOAD_CONCURRENCY
        );

        // Each segment is queued as soon as its own upload is done, without waiting for the
        // previous segment's queue request (each takes about a second against a remote server).
        // Results are tracked per segment by prompt_id, so the order the server receives them in
        // does not affect where any result is placed.
        let queuedSegmentCount = 0;
        const queueSegment = async (runIndex) => {
            if (job.stopRequested) throw new Error("Generation stopped by user.");
            const segment = queuedSegments[runIndex];
            const { uploadedName, maxBinaryBytesPerAsset } = await mainInputUploads[runIndex];
            if (job.stopRequested) throw new Error("Generation stopped by user.");

            // Upload each attached additional-input file and map it to its declared slot
            // index (1-based — slot 0 is the main input, handled by uploadedName above).
            // A null entry means the user left that slot unassigned — skip it entirely, which
            // leaves uploadedAdditionalInputs[slotIndex] unset so buildAutoRunPrompt deletes
            // that slot's loader node instead of trying to feed it an upload.
            const uploadedAdditionalInputs = {};
            for (let i = 0; i < additionalInputFiles.length; i += 1) {
                const file = additionalInputFiles[i];
                if (!file) continue;
                const slotIndex = i + 1;
                let uploadedAdditionalName = "";
                if (useRunComfy || useRunPod) {
                    uploadedAdditionalName = await getCachedAutoRunUpload(
                        file,
                        `datauri|${useRunPod ? "runpod" : "runcomfy"}|${maxBinaryBytesPerAsset}`,
                        () => buildRunComfyDataUriFromFile(file, { maxBytes: maxBinaryBytesPerAsset })
                    );
                    logForJob(job, `Generate: prepared ${useRunPod ? "RunPod" : "RunComfy"} additional input ${slotIndex} payload.`);
                } else {
                    uploadedAdditionalName = await getCachedAutoRunUpload(
                        file,
                        `upload|${comfyBaseUrl(backendOptions)}`,
                        () => uploadImageToComfy(file, backendOptions)
                    );
                    logForJob(job, `Generate: uploaded additional input ${slotIndex} as ${uploadedAdditionalName}.`);
                }
                uploadedAdditionalInputs[slotIndex] = uploadedAdditionalName;
            }

            const builtPrompt = await buildAutoRunPrompt(
                config,
                uploadedName,
                job.parameterValues,
                workflowNodeTargets,
                {
                    uploadedAdditionalInputs,
                    bypassToggleValues: job.bypassToggleValues,
                    parameterDefs: job.parameterDefs
                }
            );
            const workflowPrompt = sanitizeWorkflowPromptInputsForQueue(
                builtPrompt && builtPrompt.workflowPrompt ? builtPrompt.workflowPrompt : builtPrompt
            );
            const exportNodeIds = Array.from(new Set(
                []
                    .concat(Array.isArray(workflowNodeTargets.exportNodeIds) ? workflowNodeTargets.exportNodeIds : [])
                    .concat(workflowNodeTargets.exportNodeId ? [workflowNodeTargets.exportNodeId] : [])
            ));
            const exrSegmentSuffix = `${job.exrRunToken}_s${runIndex + 1}`;
            const rewrittenExrPrefixes = applyExrOutputPrefixSuffix(workflowPrompt, exportNodeIds, exrSegmentSuffix);
            if (rewrittenExrPrefixes > 0) {
                logForJob(job, `Generate: applied EXR output suffix "${exrSegmentSuffix}" to ${rewrittenExrPrefixes} node(s).`);
            }
            segment.exrOutputPrefixes = getDeclaredExrOutputPrefixesFromPrompt(workflowPrompt, exportNodeIds);

            logForJob(job, `Generate: queueing ${config.displayName || config.jsonFileName}${queuedSegments.length > 1 ? ` (${segment.segmentLabel})` : ""} ...`);
            segment.queuedAtMs = Date.now();
            const queued = await queueAutoRunPrompt(workflowPrompt, { config, backendOptions });
            job.queuedRuns += 1;
            job.activityState = "queued";
            job.progressState = "queued";
            segment.promptId = queued?.prompt_id || queued?.promptId || queued?.request_id || queued?.requestId || queued?.id || "";
            // Rebuilt from the segments (not appended) so the list stays in crop order even
            // though segments can finish queueing in any order.
            job.promptIds = queuedSegments.map((item) => String(item.promptId || "")).filter(Boolean);
            autoRunState.activePromptIds = job.promptIds;
            logForJob(job, `Generate: queued successfully${segment.promptId ? ` (${(useRunComfy || useRunPod) ? "request_id" : "prompt_id"}: ${segment.promptId})` : ""}.`);
            // The job was already persisted as "running" before this segment had a prompt_id —
            // without re-persisting here, a Photoshop restart between now and job completion would
            // see stale segments with no prompt_id and wrongly conclude they were never dispatched
            // (see resumeTrackingAutoRunJob), marking a job that actually succeeded as an error.
            persistAutoRunJobsToDisk().catch((error) => {
                log(`Generate job persistence warning: ${describeError(error)}`);
            });
            queuedSegmentCount += 1;
            setAutoRunProgressState({
                visible: true,
                percent: Math.max(1, Math.min(55, Math.round((queuedSegmentCount / totalRuns) * 50))),
                text: formatAutoRunProgressLabel("Queued", {
                    segmentIndex: queuedSegmentCount,
                    totalSegments: totalRuns
                })
            });
        };
        // Wait for every queue attempt to settle before reporting a failure, so a segment that
        // was still being queued is not abandoned mid-request; then surface the first failure in
        // segment order, which fails the job as before.
        const queueOutcomes = await Promise.all(queuedSegments.map((_, runIndex) => queueSegment(runIndex)
            .then(() => null, (error) => error)));
        const firstQueueError = queueOutcomes.find(Boolean);
        if (firstQueueError) throw firstQueueError;

        for (let queuedIndex = 0; queuedIndex < queuedSegments.length; queuedIndex += 1) {
            if (job.stopRequested) throw new Error("Generation stopped by user.");
            const segment = queuedSegments[queuedIndex];
            if (!segment.promptId) {
                logForJob(job, `Generate: ${segment.segmentLabel} has no prompt_id; completion tracking skipped.`);
                continue;
            }

            logForJob(job, `Generate: waiting for completion (${segment.promptId}) ...`);
            const completedEntry = await waitForAutoRunPromptResult(segment.promptId, {
                useCloud,
                useRunComfy,
                useRunPod,
                ...backendOptions,
                timeoutMs: 86400000, // 24 hours
                pollMs: 1000,
                shouldStop: () => Boolean(job.stopRequested),
                onProgress: (progress) => {
                    const progressPercent = Number(progress?.percent);
                    const clampedProgress = Number.isFinite(progressPercent) ? Math.max(0, Math.min(100, progressPercent)) : 0;
                    const runFraction = (queuedIndex + (clampedProgress / 100)) / totalRuns;
                    const overallPercent = Math.max(50, Math.min(99, 50 + Math.round(runFraction * 49)));
                    const state = normalizeAutoRunProgressState(progress?.state);
                    const phase = state === "queued" ? "Queued" : "Running";
                    const nextActivityState = state === "queued" ? "queued" : "running";
                    const didActivityStateChange = job.activityState !== nextActivityState;
                    job.activityState = nextActivityState;
                    job.progressState = job.activityState;
                    if (didActivityStateChange) renderAutoRunJobsDialog();
                    setAutoRunProgressState({
                        visible: true,
                        percent: overallPercent,
                        text: formatAutoRunProgressLabel(phase, {
                            segmentIndex: queuedIndex + 1,
                            totalSegments: totalRuns
                        })
                    });
                }
            });

            if (completedEntry) {
                if (job.stopRequested) throw new Error("Generation stopped by user.");
                job.completedRuns += 1;
                segment.completedEntry = completedEntry;
                logForJob(job, `Generate: completed (${segment.promptId}).`);
                // Only worth downloading early when the result will be imported automatically
                // right after the last segment; a manual import fetches it when clicked.
                if (queuedSegments.length > 1 && !job.resumedAfterRestart && Boolean(settingsState.importJobResultAutomatically)) {
                    prefetchAutoRunSegmentOutputs(job, segment, backendOptions);
                }
                persistAutoRunJobsToDisk().catch((error) => {
                    log(`Generate job persistence warning: ${describeError(error)}`);
                });
            } else {
                logForJob(job, `Generate: still running after wait window (${segment.promptId}). Cloud jobs can complete later; import is skipped until completion metadata is available.`);
                logForJob(job, `Generate: check ${useRunComfy
                    ? "/prod/v2/deployments/{deployment_id}/requests/{request_id}/status and /result"
                    : (useRunPod
                        ? "/v2/{endpoint_id}/status/{request_id}"
                        : (useCloud ? "/api/job/{prompt_id}/status and /api/jobs/{prompt_id}" : "queue/history"))} for final outputs.`);
                job.activityState = "running";
                job.progressState = "running";
                setAutoRunProgressState({
                    visible: true,
                    text: formatAutoRunProgressLabel("Running", {
                        segmentIndex: queuedIndex + 1,
                        totalSegments: totalRuns
                    })
                });
            }
        }

        const completedSegments = queuedSegments.filter((segment) => Boolean(segment && segment.completedEntry));
        // A job resumed after a Photoshop restart/crash never auto-imports: the document that was
        // active when the job was created may no longer be open (or something else may be active
        // now), so blindly placing the output could inject it into the wrong document. Those jobs
        // instead surface a manual "Download & Import" button once marked completed below. The
        // "Import job result automatically" setting gives the same manual-only behavior to every
        // other job too, for users who never want auto-placement into the active document.
        if (!job.resumedAfterRestart && Boolean(settingsState.importJobResultAutomatically)) {
            await performAutoRunJobImport(job);
            // The durable snapshot copy is kept (not deleted here) even after a successful
            // import: it's what lets the Jobs-dialog preview thumbnail keep showing after a
            // Photoshop restart, and it's what a re-click of Import would need for crop
            // placement. It's only cleaned up once the user removes the job from the list.
        }

        job.activityState = "idle";
        job.progressState = "idle";
        job.state = "completed";
        job.completedAtMs = Date.now();
        renderAutoRunJobsDialog();
        setAutoRunProgressState({
            visible: true,
            percent: 100,
            text: formatAutoRunJobPhaseLabel("Completed", {
                completedSegments: completedSegments.length,
                totalSegments: totalRuns
            })
        });
    } catch (error) {
        const rawDetail = describeError(error);
        const stoppedByUser = String(rawDetail || "").includes("stopped by user");
        if (stoppedByUser) {
            autoRunHadError = false;
            job.activityState = "idle";
            job.progressState = "idle";
            job.state = "stopped";
            logForJob(job, "Generation stopped by user.");
            setAutoRunProgressState({ visible: true, text: "Stopped by user." });
        } else {
            autoRunHadError = true;
            job.activityState = "idle";
            job.progressState = "idle";
            job.state = "error";
            const detail = normalizePluginError(rawDetail);
            job.errorDetail = detail;
            logForJob(job, `Generate error: ${detail}`);
            setAutoRunProgressState({ visible: true, text: `Error: ${detail}` });
        }
    } finally {
        job.stopRequested = false;
        releaseAutoRunOutputPrefetches(job);
        syncAutoRunRuntimeStateFromActiveJobs();
        renderAutoRunJobsDialog();
        const hasOtherTrackedJobs = getAutoRunActiveOrQueuedJobs().some((trackedJob) => trackedJob !== job);
        if (!autoRunHadError && !hasOtherTrackedJobs) {
            setAutoRunProgressState({ visible: true, percent: 0, text: "Ready" });
        }
    }
}

// Downloads a finished job's generated output(s) and places them into the target Photoshop
// document as Smart Object(s). Extracted from the old inline auto-import step so both the
// automatic post-generation import (jobs finished in the same live session) and the manual
// "Download & Import" button (jobs resumed after a Photoshop restart/crash, or re-clicked to
// import again) share one code path.
async function performAutoRunJobImport(job, options = {}) {
    if (!job) return;
    const workflowNodeTargets = job.workflowNodeTargets || createDefaultWorkflowNodeTargets();
    const totalRuns = Math.max(1, Number(job.totalRuns) || 1);
    const useRunComfy = Boolean(job.useRunComfy);
    const useRunPod = Boolean(job.useRunPod);
    const useCloud = Boolean(job.useCloud);
    const backendOptions = job.backendOptions || buildAutoRunBackendOptions({
        useRunComfy,
        useRunPod,
        useCloud,
        runComfyDeploymentId: job.runComfyDeploymentId,
        runPodEndpointId: job.runPodEndpointId
    });
    const queuedSegments = Array.isArray(job.segments) ? job.segments : [];
    const completedSegments = queuedSegments.filter((segment) => Boolean(segment && segment.completedEntry));
    // A manual "Import" click should place into whatever document the user has active right now
    // (they clicked it deliberately, possibly after switching documents or restarting Photoshop),
    // not the job's original source document — which may no longer be open, or may no longer be
    // the one the user actually wants. The automatic same-session import path doesn't pass this,
    // so it keeps targeting the job's original document as before.
    const activeDocOverride = options.useActiveDocument ? (app.activeDocument || null) : null;
    const resolvedTargetDocId = activeDocOverride ? activeDocOverride.id : null;
    const resolvedTargetDocName = activeDocOverride ? String(activeDocOverride.name || "") : "";
    if (activeDocOverride) {
        const layersBefore = collectAllLayers(activeDocOverride).map((l) => `${l.id}:"${l.name}"`).join(", ");
        log(`Generate import debug: host doc="${resolvedTargetDocName || "<unnamed>"}" id=${resolvedTargetDocId} layers(before)=[${layersBefore}].`);
    }

    await withAutoRunImportLock(async () => {
        // Placing a Smart Object / importing history output uses core.executeAsModal and
        // batchPlay, which operate on the Photoshop document directly — they don't depend on
        // which view is currently shown inside this UXP panel, so the Jobs dialog does not need
        // to be closed for this to work. Keeping it open avoids the main-panel flash a manual
        // "Import" click from inside the dialog used to cause.
        // A selection left active in the target document while jobs run interferes with every
        // crop import step (placing/moving the result and building its soft mask all react to the
        // live selection), which misplaced and mis-masked crop results. Save the user's selection,
        // clear it for the whole import, and put it back once every output is placed.
        const importDocId = resolvedTargetDocId
            || (completedSegments[0] && completedSegments[0].target && completedSegments[0].target.targetDocId)
            || job.selectionDocId;
        let userSelectionSnapshot = null;
        try {
            userSelectionSnapshot = await captureSelectionSnapshotInDocument(importDocId);
            if (userSelectionSnapshot) await clearSelectionInDocument(importDocId);
        } catch (error) {
            log(`Generate import: could not set aside the current selection (${describeError(error)}).`);
        }
        try {
            for (let importIndex = 0; importIndex < completedSegments.length; importIndex += 1) {
                const segment = completedSegments[importIndex];
                // Crop segments import the result straight into the crop area as its own Smart Object
                // (importOutputIntoSelectionBounds + finishCropResultLayer). The original crop is no
                // longer placed first and embedded inside the result: those pixels are already in the
                // document underneath, and dropping the copy keeps PSDs smaller and means no crop
                // file has to be kept for imports after a Photoshop restart.
                const cropBounds = segment.target.useSelectionCrop
                    ? (segment.target.cropPlacementBounds || segment.target.selectionBounds || null)
                    : null;
                const exrMinModifiedMs = Number(segment.queuedAtMs) > 0 ? Math.max(0, Number(segment.queuedAtMs) - 5000) : 0;
                job.lastImportedOutput = await importAutoRunOutputFromHistory(segment.promptId, segment.completedEntry, {
                    useCloud,
                    useRunComfy,
                    useRunPod,
                    ...backendOptions,
                    exrMinModifiedMs,
                    exrOutputPrefixes: segment.exrOutputPrefixes,
                    // The crop area that was actually sent (selection plus expansion), so the result
                    // lands exactly where its input came from.
                    selectionBounds: cropBounds,
                    cropResult: Boolean(cropBounds),
                    targetDocId: resolvedTargetDocId || segment.target.targetDocId || job.selectionDocId,
                    targetDocName: resolvedTargetDocName || job.documentName || "",
                    targetSmartObject: null,
                    exportNodeId: workflowNodeTargets.exportNodeId,
                    exportNodeIds: workflowNodeTargets.exportNodeIds,
                    exportMaskNodeId: workflowNodeTargets.exportMaskNodeId,
                    exportMaskNodeIds: workflowNodeTargets.exportMaskNodeIds,
                    exportMaskResultNodeIds: workflowNodeTargets.exportMaskResultNodeIds
                });
            }
        } finally {
            if (userSelectionSnapshot) {
                try {
                    await restoreSelectionSnapshotInDocument(importDocId, userSelectionSnapshot);
                } catch (error) {
                    log(`Generate import: could not restore the previous selection (${describeError(error)}).`);
                }
            }
        }
    });
    if (activeDocOverride) {
        const hostDocAfter = getOpenDocumentById(resolvedTargetDocId, resolvedTargetDocName);
        const layersAfter = hostDocAfter ? collectAllLayers(hostDocAfter).map((l) => `${l.id}:"${l.name}"`).join(", ") : "doc not found";
        log(`Generate import debug: host doc="${resolvedTargetDocName || "<unnamed>"}" id=${resolvedTargetDocId} layers(after)=[${layersAfter}].`);
    }
    logForJob(job, `Generate: imported ${completedSegments.length} output${completedSegments.length === 1 ? "" : "s"} for ${describeAutoRunJob(job)}.`);
}

// Wraps a single-line <input class="dynamicInput"> so it renders at its 24px CSS height.
// Measured in the panel: an input placed directly in a .dynamicField flex row (or inside a
// plain block div) rendered 27px tall, while the same input inside the seed control's
// container (.dynamicReferenceListControl: a flex column with align-items:flex-start)
// rendered 24px. So every single-line Auto Run text box is hosted in that container.
// Rows have no gap between them (the form's flex `gap` doesn't apply in UXP), so vertical
// spacing comes from each control's own margin: 6px above and below (36px row = 6 + 24 + 6),
// the same as dropdown, seed and big-prompt rows.
function wrapSingleLineTextInput(input) {
    const control = document.createElement("div");
    control.className = "dynamicReferenceListControl dynamicSeedControl";
    control.style.cssText = "flex:1 1 auto;min-width:0;width:100%;margin:6px 0;";
    control.appendChild(input);
    return control;
}

// "Batch" control — how many times the selected workflow gets sent when Run is pressed. Shown
// for every workflow, directly below the Default Settings/Copy To Clipboard row. Not tied to
// any workflow's YAML (unlike the dynamic parameter controls below it), so it isn't rebuilt or
// reset when the workflow selection changes.
function createAutoRunBatchField() {
    const field = document.createElement("div");
    field.className = "dynamicField";

    const label = document.createElement("div");
    label.className = "fieldLabel";
    label.textContent = "Batch";

    const input = document.createElement("input");
    input.id = "autoRunBatchCountField";
    input.className = "dynamicInput";
    // Plain text + numeric keypad (like the other integer fields): UXP renders type="number"
    // as a taller native spinner control that ignores the shared 24px text-box sizing.
    // The change handler below enforces a whole number >= 1.
    input.type = "text";
    input.inputMode = "numeric";
    input.value = "1";
    input.addEventListener("change", () => {
        const parsed = Number.parseInt(String(input.value || "").trim(), 10);
        input.value = String(Number.isFinite(parsed) && parsed >= 1 ? parsed : 1);
    });

    field.appendChild(label);
    field.appendChild(wrapSingleLineTextInput(input));
    return field;
}

// Reads the Batch field's current value, clamped to a minimum of 1.
function getAutoRunBatchCount() {
    const input = document.getElementById("autoRunBatchCountField");
    const parsed = Number.parseInt(String(input?.value || "1").trim(), 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

// Sets a fresh random value on every "seed"-type parameter control in the Auto Run form —
// used between Batch runs so each queued job gets its own seed(s), the same range the seed
// control's own "Set random seed" button uses.
function randomizeAllAutoRunSeedParameters() {
    if (!nanoBananaForm) return;
    const seedInputs = nanoBananaForm.querySelectorAll('[data-param-type="seed"] input');
    seedInputs.forEach((input) => {
        input.value = String(Math.floor(Math.random() * 2147483648));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    });
}

// Entry point for the Run button: snapshot the current request and queue it even if another job is already running.
// Batch > 1 repeats this "prepare, then randomize every seed parameter" cycle, so each queued
// job gets a distinct seed while every other parameter stays exactly as configured.
async function runAutoRunSelectedWorkflow() {
    const batchCount = getAutoRunBatchCount();
    // The main canvas/layer snapshot doesn't change across a batch run — only seed parameters
    // are randomized between iterations — so export it once on the first iteration and hand the
    // same file(s) to every subsequent iteration instead of re-exporting per batch job.
    let reusableSnapshotFiles = null;
    // Saved thumbnail/crop-snapshot files from the first item, shared by the rest of the batch.
    let reusablePersistedSegments = null;
    // Selection/crop targets from the first item, shared by the rest of the batch.
    let reusableRunTargets = null;
    // Document the whole batch targets, taken from the first item and passed to the rest.
    let batchTargetDocId = null;
    // The whole batch is prepared under ONE hold of the import lock:
    // - correctness: an import opens its result as a temporary document, which is Photoshop's
    //   active document until the import finishes. Preparing during that window made batch jobs
    //   target the temporary document, and their results then failed to import ("No active
    //   Photoshop document."). No import can run while the lock is held.
    // - speed: locking per item made every item wait for the import in progress (~3-4 s each for
    //   large canvases). Holding it once lets all items queue back to back; results that come
    //   back meanwhile simply import right after the batch is queued.
    // Jobs are dispatched as soon as they are enqueued (that doesn't need the lock), so the
    // backend starts working on item 1 while later items are still being prepared.
    await withAutoRunImportLock(async () => {
        for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
            if (batchIndex > 0) randomizeAllAutoRunSeedParameters();
            const prepareStartMs = Date.now();
            const preparedJob = await prepareAutoRunSelectedWorkflowJob(
                reusableSnapshotFiles,
                { targetDocId: batchTargetDocId, reusablePersistedSegments, reusableRunTargets }
            );
            if (batchCount > 1) {
                log(`Generate batch: prepared item ${batchIndex + 1}/${batchCount} in ${Date.now() - prepareStartMs}ms.`);
            }
            if (!reusableSnapshotFiles) reusableSnapshotFiles = preparedJob.segmentSnapshotFiles;
            if (!reusablePersistedSegments) reusablePersistedSegments = preparedJob.segmentPersisted;
            if (!reusableRunTargets && Array.isArray(preparedJob.segments)) {
                reusableRunTargets = preparedJob.segments.map((segment) => segment.target);
            }
            if (batchTargetDocId === null && preparedJob.selectionDocId !== null && preparedJob.selectionDocId !== undefined) {
                batchTargetDocId = preparedJob.selectionDocId;
            }
            enqueuePreparedAutoRunJob(preparedJob);
        }
    });
}

// Captures full active selection into a temporary alpha channel for exact restoration later.
async function captureSelectionSnapshotInDocument(docId) {
    if (docId === null || docId === undefined) return null;
    const targetDoc = getOpenDocumentById(docId);
    if (!targetDoc) return null;
    const hasSelection = await hasActiveSelection(docId);
    if (!hasSelection) return null;
    const channelName = `QuickAI_AutoRunSel_${Date.now()}`;
    await core.executeAsModal(async () => {
        try {
            app.activeDocument = targetDoc;
        } catch (_e) {}
        const duplicateResult = await action.batchPlay([
            {
                _obj: "duplicate",
                _target: [{ _ref: "channel", _property: "selection" }],
                name: channelName,
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        const descriptorError = Array.isArray(duplicateResult)
            ? duplicateResult.find((item) => item && item._obj === "error")
            : null;
        if (descriptorError) {
            throw new Error(descriptorError.message || "Could not snapshot active selection.");
        }
    }, { commandName: "QuickAI Capture Generate Selection" });
    return { channelName };
}

// Restores a previously captured full selection and removes temporary snapshot channel.
async function restoreSelectionSnapshotInDocument(docId, snapshot) {
    if (docId === null || docId === undefined) return;
    const channelName = String(snapshot?.channelName || "").trim();
    if (!channelName) return;
    const targetDoc = getOpenDocumentById(docId);
    if (!targetDoc) return;
    await core.executeAsModal(async () => {
        try {
            app.activeDocument = targetDoc;
        } catch (_e) {}
        const setResult = await action.batchPlay([
            {
                _obj: "set",
                _target: [{ _ref: "channel", _property: "selection" }],
                to: { _ref: "channel", _name: channelName },
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        const setError = Array.isArray(setResult)
            ? setResult.find((item) => item && item._obj === "error")
            : null;
        if (setError) {
            throw new Error(setError.message || "Could not restore selection from snapshot.");
        }
        await action.batchPlay([
            {
                _obj: "delete",
                _target: [{ _ref: "channel", _name: channelName }],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
    }, { commandName: "QuickAI Restore Generate Selection" });
}

// Keeps the reference-list control's "data-main-input-mode" attribute in sync with the "Main
// Input" dropdown's current value, and re-syncs the Inputs box so its manual main slot
// (MAIN_INPUT_MODE_MANUAL only) appears or disappears immediately. Called from the dropdown's
// own change listener for live edits, and once after sticky values are restored on workflow
// load (which sets .value directly without dispatching a change event).
function syncMainInputModeToReferenceList() {
    if (!nanoBananaForm) return;
    const modeSelect = nanoBananaForm.querySelector(`[data-param-name="${MAIN_INPUT_MODE_PARAM_NAME}"]`);
    const wrapper = nanoBananaForm.querySelector('[data-param-type="reference_list"]');
    if (!wrapper) return;
    const mode = modeSelect ? String(modeSelect.value || MAIN_INPUT_MODE_CANVAS) : MAIN_INPUT_MODE_CANVAS;

    // A workflow with only the main input (no additional slots declared) has nothing for the
    // Inputs box to offer unless the user picks Set Manually — in that one case the box is
    // needed to attach that single input. The scale-down checkbox stays hidden either way since
    // there's nothing "additional" to scale.
    const referenceLimit = Math.max(0, Number.parseInt(String(wrapper.getAttribute("data-reference-limit") || "0"), 10) || 0);
    const singleInputOnly = referenceLimit === 0;
    const inputsBoxField = wrapper.closest(".dynamicField");
    if (inputsBoxField) {
        inputsBoxField.classList.toggle("isHidden", singleInputOnly && mode !== MAIN_INPUT_MODE_MANUAL);
    }
    const scaleDownControl = nanoBananaForm.querySelector('[data-param-name="scale_down_additional_inputs"]');
    const scaleDownField = scaleDownControl ? scaleDownControl.closest(".dynamicField") : null;
    if (scaleDownField) {
        scaleDownField.classList.toggle("isHidden", singleInputOnly);
    }

    if (wrapper.getAttribute("data-main-input-mode") === mode) return;
    wrapper.setAttribute("data-main-input-mode", mode);
    const listEl = wrapper.__quickaiListEl;
    if (!listEl) return;
    if (mode === MAIN_INPUT_MODE_MANUAL) {
        // The manual main slot renders first (top of the list) even though its underlying
        // array index is last (referenceLimit) — default selection should follow the visual
        // order, not the array order, so it lands on that same top row.
        const referenceLimit = Math.max(0, Number.parseInt(String(wrapper.getAttribute("data-reference-limit") || "0"), 10) || 0);
        wrapper.setAttribute("data-reference-selected-slot-indices", String(referenceLimit));
        wrapper.setAttribute("data-reference-anchor-slot-index", String(referenceLimit));
    }
    const currentItems = parseReferenceListValue(wrapper.getAttribute("data-reference-items"));
    syncReferenceListControlState(wrapper, listEl, currentItems);
}

// Renders dynamic workflow parameter UI and run controls for the selected workflow.
function renderNanoBananaForm(parameters, errorMessage = "") {
    if (!nanoBananaForm) return;
    nanoBananaForm.textContent = "";
    try {
        nanoBananaForm.appendChild(createWorkflowSelectorField());
    } catch (error) {
        log(`Generate workflow selector render error: ${describeError(error)}`);
        nanoBananaForm.appendChild(createWorkflowSelectorFieldFallback(error));
    }
    nanoBananaForm.appendChild(createAutoRunBatchField());

    const selectedConfig = getWorkflowConfigById(autoRunState.selectedWorkflow);
    const hasRunnableWorkflow = Boolean(selectedConfig && selectedConfig.jsonFileName);

    if (errorMessage) {
        const err = document.createElement("div");
        err.className = "dynamicError";
        err.textContent = errorMessage;
        nanoBananaForm.appendChild(err);
        nanoBananaForm.appendChild(createAutoRunButtonField(true));
        return;
    }

    if (!Array.isArray(parameters) || parameters.length === 0) {
        nanoBananaForm.appendChild(createAutoRunButtonField(!hasRunnableWorkflow));
        return;
    }

    for (let i = 0; i < parameters.length; i += 1) {
        const param = parameters[i];
        if (String(param?.type || "").toLowerCase() === "section_title") {
            const section = document.createElement("div");
            section.className = "dynamicSectionTitle";

            const sectionLabel = document.createElement("div");
            sectionLabel.className = "dynamicSectionTitleLabel";
            sectionLabel.textContent = String(param?.title || "");
            section.appendChild(sectionLabel);

            const sectionDivider = document.createElement("div");
            sectionDivider.className = "dynamicSectionTitleDivider";
            section.appendChild(sectionDivider);

            nanoBananaForm.appendChild(section);
            continue;
        }
        if (String(param?.type || "").toLowerCase() === "section_divider") {
            const section = document.createElement("div");
            section.className = "dynamicSectionTitle";

            const sectionDivider = document.createElement("div");
            sectionDivider.className = "dynamicSectionTitleDivider";
            sectionDivider.style.marginTop = "0";
            section.appendChild(sectionDivider);

            nanoBananaForm.appendChild(section);
            continue;
        }
        const field = document.createElement("div");
        field.className = "dynamicField";
        const paramType = String(param?.type || "").trim().toLowerCase();
        if (paramType === "seed") field.classList.add("dynamicSeedField");
        if (paramType === "bigtextbox") field.classList.add("dynamicBigTextField");

        const input = createNanoBananaInput(param);
        input.setAttribute("data-param-key", String(param?.key || param?.name || ""));
        if (String(param?.name || "") === MAIN_INPUT_MODE_PARAM_NAME) {
            input.addEventListener("change", syncMainInputModeToReferenceList);
        }
        if (String(param?.type || "").toLowerCase() === "checkbox") {
            field.classList.add("dynamicCheckboxField");
            field.appendChild(input);
        } else {
            const label = document.createElement("div");
            label.className = "fieldLabel";
            label.textContent = String(param?.label || param?.name || `Parameter ${i + 1}`);
            field.appendChild(label);
            // Single-line text inputs (text/int/float params) need the 24px wrapper; selects,
            // seed controls and big textareas already size correctly and are appended as-is.
            const isSingleLineTextInput = input.tagName === "INPUT" && input.classList.contains("dynamicInput");
            field.appendChild(isSingleLineTextInput ? wrapSingleLineTextInput(input) : input);
        }
        nanoBananaForm.appendChild(field);
    }

    // Ensure the Inputs box's manual main slot matches the dropdown's current (possibly
    // default, pre-sticky-restore) value as soon as both controls exist.
    syncMainInputModeToReferenceList();

    nanoBananaForm.appendChild(createAutoRunButtonField(!hasRunnableWorkflow));
}

// Loads selected workflow YAML, renders inputs, and restores sticky values.
async function loadSelectedWorkflowParameters() {
    const selected = autoRunState.selectedWorkflow;
    if (!selected) {
        renderNanoBananaForm([], "No workflow selected.");
        return;
    }

    const config = getWorkflowConfigById(selected);
    if (!config) {
        renderNanoBananaForm([], `Workflow "${selected}" was not found.`);
        return;
    }
    try {
        const yamlText = await readWorkflowYamlText(config);
        const parsed = parseNanoBananaYaml(yamlText);
        const parameters = Array.isArray(parsed?.parameters) ? parsed.parameters : [];
        const nodeTargets = parsed?.nodeTargets || createDefaultWorkflowNodeTargets();
        try {
            const workflowText = await readWorkflowJsonText(config);
            const workflowPrompt = JSON.parse(workflowText);
            nodeTargets.exportMaskResultNodeIds = resolveWorkflowOutputMaskResultNodeIds(
                workflowPrompt,
                nodeTargets.exportMaskNodeIds
            );
            // inputName (image/video/audio) isn't stored in the YAML — resolve it here from
            // each declared input node's actual class_type, the one place this is computed.
            // A slot whose node id no longer resolves to an actual loader node in this workflow
            // JSON (deleted, renamed, or just a mistyped id in the YAML) is dropped here rather
            // than rendered as a dead Inputs box slot that could never receive an upload — see
            // isInputLoaderClassType.
            if (Array.isArray(nodeTargets.inputs)) {
                const validInputs = [];
                for (const slot of nodeTargets.inputs) {
                    const node = workflowPrompt?.[String(slot?.nodeId || "").trim()];
                    if (!isInputLoaderClassType(node?.class_type)) {
                        log(
                            `Generate: input node ${slot?.nodeId} does not resolve to a LoadImage-type `
                            + `node (class_type="${node?.class_type || "missing"}") — hiding it from the Inputs box.`
                        );
                        continue;
                    }
                    slot.inputName = inferLoaderInputFieldName(node.class_type);
                    validInputs.push(slot);
                }
                nodeTargets.inputs = validInputs;
            }
            // Re-sync the "Main Input" dropdown and "Inputs" reference-list parameter defs
            // (built from the raw, unfiltered YAML tuples in parseNanoBananaYaml) against the
            // now-filtered nodeTargets.inputs, so a dropped slot doesn't leave a stale/mismatched
            // control behind.
            const declaredInputs = Array.isArray(nodeTargets.inputs) ? nodeTargets.inputs : [];
            const mainModeParamIndex = parameters.findIndex((p) => String(p?.name || "") === MAIN_INPUT_MODE_PARAM_NAME);
            const additionalInputsParamIndex = parameters.findIndex((p) => String(p?.type || "").toLowerCase() === "reference_list");
            if (declaredInputs.length === 0) {
                if (additionalInputsParamIndex >= 0) parameters.splice(additionalInputsParamIndex, 1);
                const reindexedMainModeIndex = parameters.findIndex((p) => String(p?.name || "") === MAIN_INPUT_MODE_PARAM_NAME);
                if (reindexedMainModeIndex >= 0) parameters.splice(reindexedMainModeIndex, 1);
            } else {
                const additionalSlots = declaredInputs.slice(1);
                if (mainModeParamIndex >= 0) {
                    parameters[mainModeParamIndex].label = String(declaredInputs[0]?.label || "").trim() || "Main Input";
                }
                if (additionalInputsParamIndex >= 0) {
                    const additionalInputsParam = parameters[additionalInputsParamIndex];
                    additionalInputsParam.referenceLimit = additionalSlots.length;
                    additionalInputsParam.referenceTargetLabels = additionalSlots.map((slot) => String(slot?.label || "").trim());
                    additionalInputsParam.referenceTargetRequired = additionalSlots.map((slot) => Boolean(slot?.required));
                    // Photoshop has no layer type that can fill a LoadVideo/LoadAudio node, so
                    // those slots (inputName "file"/"audio") stay hidden in the Inputs box even
                    // though they're still real, load-bearing entries in nodeTargets.inputs — the
                    // array position/length here must stay untouched so send-time code (which
                    // matches additionalInputFiles to nodeTargets.inputs by index) keeps working.
                    additionalInputsParam.referenceTargetInputNames = additionalSlots.map((slot) => String(slot?.inputName || "image"));
                    additionalInputsParam.mainInputLabel = String(declaredInputs[0]?.label || "").trim();
                    additionalInputsParam.mainInputRequired = Boolean(declaredInputs[0]?.required);
                }
            }
        } catch (_e) {
            nodeTargets.exportMaskResultNodeIds = Array.isArray(nodeTargets.exportMaskNodeIds)
                ? nodeTargets.exportMaskNodeIds.slice()
                : [];
        }
        autoRunState.workflowClassTypes = Array.isArray(parsed?.classTypes) ? parsed.classTypes : [];
        autoRunState.workflowNodeTargets = nodeTargets;
        autoRunState.parameterDefs = parameters;
        renderNanoBananaForm(parameters);
        const stickyValues = await readWorkflowIniSettings(getWorkflowPathKey(config));
        applyWorkflowStickyValuesToForm(stickyValues);
        // applyWorkflowStickyValuesToForm sets .value directly without dispatching "change",
        // so the Inputs box needs an explicit nudge to reflect a restored Main Input mode.
        syncMainInputModeToReferenceList();
        await persistWorkflowIniSettings(getWorkflowPathKey(config), collectAutoRunParameterRawValues());
        wireWorkflowStickySaveListeners(getWorkflowPathKey(config));
        const classTypeSuffix = autoRunState.workflowClassTypes.length > 0
            ? ` across ${autoRunState.workflowClassTypes.length} class_type block(s)`
            : "";
        const targetSuffix = [
            (Array.isArray(autoRunState.workflowNodeTargets.inputs) && autoRunState.workflowNodeTargets.inputs.length > 0)
                ? `inputs=${autoRunState.workflowNodeTargets.inputs.length}`
                : "",
            autoRunState.workflowNodeTargets.exportNodeId ? `output=${autoRunState.workflowNodeTargets.exportNodeId}` : "",
            autoRunState.workflowNodeTargets.exportMaskNodeId ? `output_mask=${autoRunState.workflowNodeTargets.exportMaskNodeId}` : "",
            (Array.isArray(autoRunState.workflowNodeTargets.exportMaskResultNodeIds) && autoRunState.workflowNodeTargets.exportMaskResultNodeIds.length > 0)
                ? `output_mask_result=${autoRunState.workflowNodeTargets.exportMaskResultNodeIds.join("|")}`
                : "",
            (Array.isArray(autoRunState.workflowNodeTargets.bypassGroups) && autoRunState.workflowNodeTargets.bypassGroups.length > 0)
                ? `bypass_groups=${autoRunState.workflowNodeTargets.bypassGroups.length}`
                : ""
        ].filter(Boolean).join(", ");
        log(
            `Generate: loaded ${parameters.length} parameter(s)${classTypeSuffix} from `
            + `${config.sourceFolderLabel || WORKFLOWS_FOLDER_NAME}/${getWorkflowPathKey(config)}/${config.yamlFileName}`
            + `${targetSuffix ? ` [${targetSuffix}]` : ""}.`
        );
    } catch (error) {
        const message = describeError(error);
        autoRunState.parameterDefs = [];
        autoRunState.workflowClassTypes = [];
        autoRunState.workflowNodeTargets = createDefaultWorkflowNodeTargets();
        renderNanoBananaForm([], message);
        log(`Generate UI load error: ${message}`);
    }
}

// Initializes Auto Run workflow discovery and selects default workflow on startup.
async function initializeNanoBananaForm() {
    if (!nanoBananaForm) return;
    nanoBananaForm.textContent = "";
    try {
        await refreshAutoRunWorkflowList({ preserveSelection: true });
    } catch (error) {
        const message = describeError(error);
        renderNanoBananaForm([], message);
        log(`Generate initialization error: ${message}`);
    }
}

// Handles log.
function log(message) {
    const t = new Date().toISOString();
    const previous = String(logWebview?.textContent || "");
    logWebview.textContent = `[${t}] ${message}\n${previous}`;
    scheduleLockLogHeight();
}

// Logs to the global terminal as usual, and also appends the line to the job's own transcript
// so a failed job's "View Log" button can show what happened to that job specifically.
function logForJob(job, message) {
    log(message);
    if (job && typeof job === "object") {
        const t = new Date().toISOString();
        job.logText = `${String(job.logText || "")}[${t}] ${message}\n`;
    }
}

// Handles describe error.
function describeError(error) {
    if (!error) return "Unknown error";
    if (error.message) return error.message;
    try { return JSON.stringify(error); } catch (_e) {}
    return String(error);
}

if (terminalToggle && logContainer) {
    terminalToggle.addEventListener("click", () => {
        const nextVisible = logContainer.classList.contains("isHidden");
        setTerminalVisible(nextVisible);
        // Only on a user-initiated open, so programmatic hides/shows never move the panel.
        if (nextVisible) scrollMainPanelToBottom();
    });
    setTerminalVisible(false);
}
if (saveLogsBtn) {
    saveLogsBtn.addEventListener("click", () => {
        saveLogsToFile().catch((error) => {
            log(`Save Logs error: ${describeError(error)}`);
        });
    });
}
if (clearLogsBtn) {
    // The on-screen log cannot be brought back once cleared, so ask first.
    clearLogsBtn.addEventListener("click", async () => {
        if (await showPanelConfirm("Clear the log? This cannot be undone.")) clearTerminalLogs();
    });
}
if (importWorkflowsBtn) {
    importWorkflowsBtn.addEventListener("click", () => {
        runWorkflowImportAction().catch((error) => {
            log(`Import Workflows error: ${describeError(error)}`);
        });
    });
}
wireSettingsDialogEvents();
wireRunPodEndpointSettingsDialogEvents();
wireRunComfyDeploymentSettingsDialogEvents();
wireAutoRunJobsDialogEvents();
wireConnectionSettingsEvents();
wirePluginFooterLinks();
// The update check needs the manifest version, so it runs after the footer version has loaded.
loadPluginVersionLabel()
    .catch(() => {})
    .then(() => checkForPluginUpdate())
    .catch(() => {});

log("QuickAI started.");
scheduleLockLogHeight();
(async () => {
    await initializePluginSettings();
    await initializeNanoBananaForm();
    await restoreAutoRunJobsFromDisk();
})().catch((error) => {
    log(`Initialization error: ${describeError(error)}`);
});

if (typeof ResizeObserver !== "undefined" && logContainer) {
    const logResizeObserver = new ResizeObserver(() => scheduleLockLogHeight());
    logResizeObserver.observe(logContainer);
}
window.addEventListener("resize", scheduleLockLogHeight);

// Normalizes server. An address typed with http:// or https:// is kept as typed; a bare address
// gets `defaultScheme` (the detected protocol, see getDetectedLocalServerScheme; "http" if unknown).
function normalizeServer(value, defaultScheme = "http") {
    const server = (value || "").trim() || "127.0.0.1";
    if (server.startsWith("http://") || server.startsWith("https://")) {
        return server.replace(/\/$/, "");
    }
    return `${defaultScheme === "https" ? "https" : "http"}://${server}`;
}


// Cache key for one Local server address (as typed, without a scheme) and port.
function getLocalServerProbeKey(rawServer, rawPort) {
    const server = String(rawServer || "").trim().toLowerCase() || "127.0.0.1";
    return `${server}|${normalizePort(rawPort)}`;
}

// True when the address was typed without http:// or https://, so the protocol is detected.
function isBareLocalServerAddress(rawServer) {
    return !/^https?:\/\//i.test(String(rawServer || "").trim());
}

// The detected protocol for a bare address, or "http" when it has not been detected (yet).
function getDetectedLocalServerScheme(rawServer, rawPort) {
    if (!isBareLocalServerAddress(rawServer)) return "http";
    const key = getLocalServerProbeKey(rawServer, rawPort);
    return localServerSchemeProbe.key === key && localServerSchemeProbe.scheme === "https" ? "https" : "http";
}

// Rejects after `ms` so a protocol test cannot hang on an address that never answers.
function fetchWithTimeout(url, ms) {
    return Promise.race([
        fetch(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
    ]);
}

// Detects which protocol a bare Local server address speaks by connecting to it: HTTPS first,
// then HTTP. Any HTTP response at all (whatever its status) proves the protocol, because a
// ComfyUI port serves either TLS or plain HTTP, never both: an HTTPS request to a plain-HTTP port
// (or the reverse) fails at the connection level. A server whose certificate Photoshop does not
// trust (e.g. self-signed) fails the HTTPS test, which matches how the plugin could connect.
// Cached per address+port; concurrent callers share one test. No-op for addresses typed with a
// scheme. Returns the detected scheme or null.
async function detectLocalServerScheme(rawServer, rawPort) {
    if (!isBareLocalServerAddress(rawServer)) return null;
    const key = getLocalServerProbeKey(rawServer, rawPort);
    const cached = localServerSchemeProbe;
    if (cached.key === key) {
        if (cached.inFlight) return cached.inFlight;
        if (cached.scheme) return cached.scheme;
        if (Date.now() - cached.checkedAtMs < LOCAL_SERVER_SCHEME_RETRY_MS) return null;
    }
    const server = String(rawServer || "").trim() || "127.0.0.1";
    const port = normalizePort(rawPort);
    const probe = (async () => {
        for (const scheme of ["https", "http"]) {
            try {
                await fetchWithTimeout(`${scheme}://${server}${port ? `:${port}` : ""}/queue`, LOCAL_SERVER_SCHEME_PROBE_TIMEOUT_MS);
                return scheme;
            } catch (_e) {
                // No answer over this protocol; try the next one.
            }
        }
        return null;
    })();
    localServerSchemeProbe = { key, scheme: null, checkedAtMs: Date.now(), inFlight: probe };
    const scheme = await probe;
    // Only store the result if the address was not changed while the test ran.
    if (localServerSchemeProbe.key === key) {
        localServerSchemeProbe = { key, scheme, checkedAtMs: Date.now(), inFlight: null };
        if (scheme) {
            log(`Server check: ${server}${port ? `:${port}` : ""} answers over ${scheme.toUpperCase()}; using ${scheme}://.`);
        }
    }
    return scheme;
}

// Forgets the detected protocol for an address (e.g. after it stopped answering), so the next
// status check tests it again — the server may have been restarted with or without TLS.
function forgetLocalServerScheme(rawServer, rawPort) {
    const key = getLocalServerProbeKey(rawServer, rawPort);
    if (localServerSchemeProbe.key === key && !localServerSchemeProbe.inFlight) {
        localServerSchemeProbe = { key: "", scheme: null, checkedAtMs: 0, inFlight: null };
    }
}

// True for hosts that resolve to this computer, where plain http never leaves the machine.
function isLoopbackHost(host) {
    const h = String(host || "").trim().toLowerCase();
    return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

// Classifies the Local server's connection security the same way requests are actually built
// (normalizeServer with the detected protocol, as in comfyBaseUrl, so the label never disagrees
// with what is sent): "https" = encrypted, "local" = http to this computer,
// "http" = unencrypted to another machine.
function classifyLocalServerSecurity(rawServer, rawPort) {
    const base = normalizeServer(rawServer, getDetectedLocalServerScheme(rawServer, rawPort));
    if (/^https:\/\//i.test(base)) return "https";
    // Authority: text after the scheme up to the first path/query/fragment, minus any user info.
    const authority = base.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0].replace(/^.*@/, "");
    let host;
    const bracketed = /^\[([^\]]+)\]/.exec(authority);
    if (bracketed) host = bracketed[1]; // "[::1]:8188"
    else if ((authority.match(/:/g) || []).length > 1) host = authority; // bare IPv6, e.g. "::1"
    else host = authority.split(":")[0]; // "host" or "host:port"
    return isLoopbackHost(host) ? "local" : "http";
}

// Refreshes the security hint under the Server field. It only states how the connection is
// secured once the server at the current address has actually answered (see
// refreshLocalServerStatus); before that it shows an orange "Checking..." (the status line below
// shows "Off" meanwhile), and it shows "Not connected" when nothing answered. Called on typing, when a recent server is picked, when fields are synced from saved
// settings, and after every server status check.
// The label table lives inside the function (not a top-level const) because this runs during
// script load via wireConnectionSettingsEvents(), before a const declared down here would exist.
function updateServerSecurityLabel() {
    if (!serverSecurityLabel || !serverField) return;
    // Text and tooltip for each connection security state (all states share the gray CSS colour).
    const labels = {
        https: {
            text: "HTTPS \u00b7 Encrypted",
            title: "The connection to this server is encrypted."
        },
        local: {
            text: "Local \u00b7 This computer",
            title: "This server runs on this computer; nothing leaves the machine."
        },
        http: {
            text: "HTTP \u00b7 Not encrypted",
            title: "This server only answers over plain HTTP: images, workflows and your Comfy API key (if set) are sent unencrypted to it."
        },
        // Shown in orange (.isChecking) while the address is being tested; meanwhile the status
        // line below shows "Off", so neither line is ever blank.
        checking: {
            text: "Checking...",
            title: "Testing the connection to this server."
        },
        offline: {
            text: "Not connected",
            title: "Nothing answered at this address over HTTPS or HTTP."
        }
    };
    const key = getLocalServerProbeKey(serverField.value, portField ? portField.value : "");
    let state;
    if (localServerConnectionState.key !== key || localServerConnectionState.reachable === null) state = "checking";
    else if (!localServerConnectionState.reachable) state = "offline";
    else state = classifyLocalServerSecurity(serverField.value, portField ? portField.value : "");
    const info = labels[state];
    serverSecurityLabel.classList.toggle("isChecking", state === "checking");
    serverSecurityLabel.textContent = info.text;
    if (info.title) serverSecurityLabel.setAttribute("title", info.title);
    else serverSecurityLabel.removeAttribute("title");
}

// Normalizes port.
function normalizePort(value) {
    const port = String(value || "").trim();
    if (!port) return "";
    const digits = port.replace(/[^0-9]/g, "");
    return digits;
}

// Returns whether Comfy Cloud mode is active.
function isComfyCloudEnabled() {
    return normalizeEnvironmentMode(settingsState.environment) === "cloud";
}

// Normalizes persisted/runtime environment mode to one of local/cloud/runcomfy/runpod.
function normalizeEnvironmentMode(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "cloud" || normalized === "runcomfy" || normalized === "runpod") return normalized;
    return "local";
}

// Returns selected RunComfy deployment id.
function getRunComfyDeploymentId() {
    return String(settingsState.runcomfyDeploymentId || "").trim();
}

// Returns selected RunComfy deployment display name from the dropdown when available.
function getRunComfyDeploymentLabel() {
    if (!deploymentSelect) return "";
    const selectedOption = deploymentSelect.options && deploymentSelect.selectedIndex >= 0
        ? deploymentSelect.options[deploymentSelect.selectedIndex]
        : null;
    const label = selectedOption ? String(selectedOption.textContent || "").trim() : "";
    return label;
}

// Returns selected RunPod endpoint id.
function getRunPodEndpointId() {
    return String(settingsState.runpodEndpointId || "").trim();
}

// Returns selected RunPod endpoint display name from the dropdown when available.
function getRunPodEndpointLabel() {
    if (!deploymentSelect) return "";
    const selectedOption = deploymentSelect.options && deploymentSelect.selectedIndex >= 0
        ? deploymentSelect.options[deploymentSelect.selectedIndex]
        : null;
    return selectedOption ? String(selectedOption.textContent || "").trim() : "";
}

// Builds RunComfy serverless API URL.
function runComfyApiUrl(path) {
    return `https://api.runcomfy.net${path}`;
}

// Builds RunPod management REST API URL.
function runPodRestUrl(path) {
    return `https://rest.runpod.io${path}`;
}

// Builds RunPod endpoint invocation API URL.
function runPodEndpointApiUrl(endpointId, path = "") {
    const normalizedEndpointId = encodeURIComponent(String(endpointId || "").trim());
    const normalizedPath = String(path || "").trim();
    return `https://api.runpod.ai/v2/${normalizedEndpointId}${normalizedPath}`;
}

// Builds a RunComfy instance-proxy URL for calling native Comfy backend routes on the live instance.
function runComfyInstanceProxyUrl(deploymentId, instanceId, comfyBackendPath) {
    const pathText = String(comfyBackendPath || "").trim().replace(/^\/+/, "");
    const encodedPath = pathText
        .split("/")
        .map((segment) => encodeURIComponent(String(segment || "").trim()))
        .filter(Boolean)
        .join("/");
    return runComfyApiUrl(
        `/prod/v2/deployments/${encodeURIComponent(String(deploymentId || "").trim())}`
        + `/instances/${encodeURIComponent(String(instanceId || "").trim())}/proxy/${encodedPath}`
    );
}

// Handles comfy base url.
function comfyBaseUrl(options = {}) {
    const useCloud = Boolean(options.useCloud);
    if (useCloud) return "https://cloud.comfy.org";
    const rawServer = options.localServer || serverField.value;
    const rawPort = options.localPort || portField.value;
    const server = normalizeServer(rawServer, getDetectedLocalServerScheme(rawServer, rawPort));
    const port = normalizePort(rawPort);
    return port ? `${server}:${port}` : server;
}

// Builds headers for RunComfy serverless API calls.
function buildRunComfyRequestHeaders(options = {}) {
    const includeJsonContentType = Boolean(options.includeJsonContentType);
    const headers = {};
    if (includeJsonContentType) headers["Content-Type"] = "application/json";
    const token = getRunComfyApiToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

// Builds headers for RunPod REST/invocation API calls.
function buildRunPodRequestHeaders(options = {}) {
    const includeJsonContentType = Boolean(options.includeJsonContentType);
    const headers = {};
    if (includeJsonContentType) headers["Content-Type"] = "application/json";
    const token = getRunPodApiToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

// Handles comfy api url.
function comfyApiUrl(path, options = {}) {
    return `${comfyBaseUrl(options)}${path}`;
}

// Builds headers for requests against local Comfy or Comfy Cloud.
function buildComfyRequestHeaders(options = {}) {
    const useCloud = Boolean(options.useCloud);
    const includeJsonContentType = Boolean(options.includeJsonContentType);
    const headers = {};
    if (includeJsonContentType) headers["Content-Type"] = "application/json";
    if (useCloud) {
        const apiKey = getComfyApiKey();
        if (apiKey) {
            // Send both header styles for compatibility across Comfy Cloud gateway/runtime paths.
            headers["X-API-Key"] = apiKey;
            headers.Authorization = `Bearer ${apiKey}`;
        }
    }
    return headers;
}

// Returns comfy api key.
function getComfyApiKey() {
    return String(settingsState.comfyApiKey || "").trim();
}

// Sends transfer status events to the Comfy loader bridge when available.
async function notifyComfyTransferEvent(event) {
    try {
        await fetch(comfyApiUrl("/quickai/transfer-event"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                direction: event?.direction || "",
                status: event?.status || "info",
                message: event?.message || "",
                filename: event?.filename || ""
            })
        });
    } catch (_e) {
        // Best-effort notification only.
    }
}

// Returns (and creates if needed) the shared QuickAI temp folder in local temp storage.
async function getQuickAITempFolder() {
    const tempRoot = await storage.localFileSystem.getTemporaryFolder();
    try {
        return await tempRoot.getEntry("QuickAI");
    } catch (_error) {
        return await tempRoot.createFolder("QuickAI");
    }
}

// Checks whether active selection.
async function getSelectionState(docId) {
    if (docId === null || docId === undefined) return { hasSelection: false, bounds: null };
    try {
        const result = await action.batchPlay([
            {
                _obj: "get",
                _target: [
                    { _property: "selection" },
                    { _ref: "document", _id: docId }
                ],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        const selection = result && result[0] && result[0].selection;
        if (!selection || selection._obj === "none") return { hasSelection: false, bounds: null };
        const left = toPixels(selection.left);
        const top = toPixels(selection.top);
        const right = toPixels(selection.right);
        const bottom = toPixels(selection.bottom);
        if ([left, top, right, bottom].some((v) => typeof v !== "number")) {
            return { hasSelection: true, bounds: null };
        }
        return { hasSelection: true, bounds: { left, top, right, bottom } };
    } catch (_error) {
        return { hasSelection: false, bounds: null };
    }
}

async function hasActiveSelection(docId) {
    const state = await getSelectionState(docId);
    return Boolean(state.hasSelection);
}

// Handles to pixels.
function toPixels(value) {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
        const n = Number.parseFloat(value);
        return Number.isFinite(n) ? n : null;
    }
    if (!value) return null;
    if (typeof value._value === "number") return value._value;
    if (typeof value._value === "string") {
        const n = Number.parseFloat(value._value);
        return Number.isFinite(n) ? n : null;
    }
    if (typeof value.value === "number") return value.value;
    if (typeof value.value === "string") {
        const n = Number.parseFloat(value.value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

// Reads active Photoshop selection bounds in pixels via batchPlay.
async function getActiveSelectionBounds(docId) {
    const state = await getSelectionState(docId);
    return state.bounds || null;
}

// Normalizes float bounds into integer pixel rectangles used by selection/crop APIs.
function normalizeBoundsToIntegerRect(bounds) {
    if (!bounds) return null;
    const left = Math.floor(Number(bounds.left));
    const top = Math.floor(Number(bounds.top));
    const right = Math.ceil(Number(bounds.right));
    const bottom = Math.ceil(Number(bounds.bottom));
    if ([left, top, right, bottom].some((v) => !Number.isFinite(v))) return null;
    if (!(right > left && bottom > top)) return null;
    return { left, top, right, bottom };
}

// Returns connected component bounds from a grayscale selection mask (non-zero = selected).
function extractConnectedBoundsFromSelectionMask(maskData, width, height, threshold = 1) {
    if (!maskData || !(width > 0) || !(height > 0)) return [];
    const total = width * height;
    if (maskData.length < total) return [];

    const visited = new Uint8Array(total);
    const stack = [];
    const components = [];

    const visitIfSelected = (index) => {
        if (index < 0 || index >= total) return;
        if (visited[index]) return;
        visited[index] = 1;
        if (maskData[index] >= threshold) {
            stack.push(index);
        }
    };

    for (let start = 0; start < total; start += 1) {
        if (visited[start]) continue;
        visited[start] = 1;
        if (maskData[start] < threshold) continue;

        stack.push(start);
        let minX = start % width;
        let maxX = minX;
        let minY = Math.floor(start / width);
        let maxY = minY;
        let pixelCount = 0;

        while (stack.length > 0) {
            const current = stack.pop();
            const y = Math.floor(current / width);
            const x = current - (y * width);
            pixelCount += 1;

            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;

            if (x > 0) visitIfSelected(current - 1);
            if (x + 1 < width) visitIfSelected(current + 1);
            if (y > 0) visitIfSelected(current - width);
            if (y + 1 < height) visitIfSelected(current + width);
        }

        if (pixelCount > 0) {
            components.push({
                left: minX,
                top: minY,
                right: maxX + 1,
                bottom: maxY + 1,
                pixelCount
            });
        }
    }

    components.sort((a, b) => {
        if (a.top !== b.top) return a.top - b.top;
        if (a.left !== b.left) return a.left - b.left;
        return b.pixelCount - a.pixelCount;
    });
    return components;
}

// Normalizes a selection-mask sample to a 0..255-ish scale across 8/16/32-bit docs.
function normalizeSelectionMaskSample(value, componentSize) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    let scaled = n;
    if (componentSize === 32) scaled = n * 255;
    if (componentSize === 16) scaled = (n / 32768) * 255;
    return Math.max(0, Math.min(255, Math.round(scaled)));
}

// Extracts a single mask channel from chunky selection data (grayscale or alpha-preferring).
function extractSelectionMaskChannel(rawPixels, pixelCount, imageData) {
    if (!rawPixels || !(pixelCount > 0)) return null;

    const components = Math.max(1, Number(imageData?.components) || 1);
    const hasAlpha = Boolean(imageData?.hasAlpha);
    const componentSize = Number(imageData?.componentSize) || 8;
    const expectedLength = pixelCount * components;
    if (rawPixels.length < expectedLength) return null;

    const mask = new Uint8Array(pixelCount);
    if (components === 1) {
        for (let i = 0; i < pixelCount; i += 1) {
            mask[i] = normalizeSelectionMaskSample(rawPixels[i], componentSize);
        }
        return mask;
    }

    // Prefer alpha when present; otherwise use the first component.
    const channelIndex = hasAlpha ? (components - 1) : 0;
    for (let i = 0; i < pixelCount; i += 1) {
        const sourceIndex = (i * components) + channelIndex;
        mask[i] = normalizeSelectionMaskSample(rawPixels[sourceIndex], componentSize);
    }
    return mask;
}

// Maps component bounds from scan-space coordinates back to document coordinates.
function mapSelectionComponentBoundsToDocument(components, sourceBounds) {
    if (!Array.isArray(components) || !sourceBounds) return [];
    const mapped = [];
    for (let i = 0; i < components.length; i += 1) {
        const component = components[i];
        if (!component) continue;
        const mappedBounds = normalizeBoundsToIntegerRect({
            left: sourceBounds.left + component.left,
            top: sourceBounds.top + component.top,
            right: sourceBounds.left + component.right,
            bottom: sourceBounds.top + component.bottom
        });
        if (mappedBounds) mapped.push(mappedBounds);
    }
    return mapped;
}

// Returns total area covered by component rectangles (used for polarity disambiguation).
function getSelectionComponentCoverageArea(components) {
    if (!Array.isArray(components) || components.length === 0) return 0;
    let area = 0;
    for (let i = 0; i < components.length; i += 1) {
        const b = components[i];
        if (!b) continue;
        const w = Number(b.right) - Number(b.left);
        const h = Number(b.bottom) - Number(b.top);
        if (w > 0 && h > 0) area += (w * h);
    }
    return area;
}

// Returns shortest pixel distance between two axis-aligned bounds (0 when overlapping/touching).
function getBoundsGapDistancePx(a, b) {
    if (!a || !b) return Number.POSITIVE_INFINITY;
    const horizontalGap = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
    const verticalGap = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
    return Math.hypot(horizontalGap, verticalGap);
}

// Returns one rectangle that fully contains both input bounds.
function mergeTwoBounds(a, b) {
    return normalizeBoundsToIntegerRect({
        left: Math.min(Number(a.left), Number(b.left)),
        top: Math.min(Number(a.top), Number(b.top)),
        right: Math.max(Number(a.right), Number(b.right)),
        bottom: Math.max(Number(a.bottom), Number(b.bottom))
    });
}

// Merges nearby selection rectangles into larger targets when the gap is within thresholdPx.
function mergeNearbySelectionBounds(boundsList, thresholdPx = 0) {
    if (!Array.isArray(boundsList) || boundsList.length <= 1) return Array.isArray(boundsList) ? boundsList : [];
    const safeThreshold = Number.isFinite(Number(thresholdPx)) ? Math.max(0, Number(thresholdPx)) : 0;
    if (safeThreshold <= 0) return boundsList;

    const pending = boundsList.map((b) => normalizeBoundsToIntegerRect(b)).filter(Boolean);
    const merged = [];

    while (pending.length > 0) {
        let current = pending.shift();
        let changed = true;

        // Transitive clustering: if A is close to B and B to C, all are merged into one rectangle.
        while (changed) {
            changed = false;
            for (let i = pending.length - 1; i >= 0; i -= 1) {
                const candidate = pending[i];
                if (getBoundsGapDistancePx(current, candidate) <= safeThreshold) {
                    current = mergeTwoBounds(current, candidate);
                    pending.splice(i, 1);
                    changed = true;
                }
            }
        }

        if (current) merged.push(current);
    }

    merged.sort((a, b) => {
        if (a.top !== b.top) return a.top - b.top;
        return a.left - b.left;
    });
    return merged;
}

// Filters component bounds by minimum width.
function filterSelectionBoundsByMinimumWidth(boundsList, minimumWidthPx) {
    if (!Array.isArray(boundsList) || boundsList.length === 0) return [];
    const minWidth = Number(minimumWidthPx);
    if (!Number.isFinite(minWidth) || minWidth <= 0) return boundsList;
    return boundsList.filter((bounds) => {
        const width = Number(bounds?.right) - Number(bounds?.left);
        return Number.isFinite(width) && width >= minWidth;
    });
}

// Chooses best segmentation candidate between normal and inverted mask polarity.
function chooseSelectionSegmentationCandidate(normalComponents, invertedComponents) {
    const normalCount = normalComponents.length;
    const invertedCount = invertedComponents.length;

    // Strong preference: any candidate that yields multiple components beats a single merged region.
    if (normalCount > 1 && invertedCount <= 1) return normalComponents;
    if (invertedCount > 1 && normalCount <= 1) return invertedComponents;
    if (normalCount === 0 && invertedCount > 0) return invertedComponents;
    if (invertedCount === 0 && normalCount > 0) return normalComponents;

    // If both produce candidates, prefer the one with smaller coverage (usually true selection vs complement).
    const normalArea = getSelectionComponentCoverageArea(normalComponents);
    const invertedArea = getSelectionComponentCoverageArea(invertedComponents);
    if (invertedArea > 0 && (normalArea <= 0 || invertedArea < normalArea)) return invertedComponents;
    return normalComponents;
}

// Resolves disjoint active-selection components as absolute document-space bounds.
async function resolveSelectionComponentBounds(docId, selectionBounds) {
    const normalizedSelection = normalizeBoundsToIntegerRect(selectionBounds);
    if (!normalizedSelection) return [];

    const width = normalizedSelection.right - normalizedSelection.left;
    const height = normalizedSelection.bottom - normalizedSelection.top;
    if (!(width > 0 && height > 0)) return [];

    const sourcePixelCount = width * height;
    if (sourcePixelCount > MAX_SELECTION_COMPONENT_SCAN_PIXELS) {
        log(
            `Generate: selection imaging scan skipped for large region (${Math.round(width)}x${Math.round(height)}). ` +
            "Falling back to one crop region."
        );
        return [normalizedSelection];
    }
    if (!imaging || typeof imaging.getSelection !== "function") {
        return [normalizedSelection];
    }

    try {
        let selectionPixels = null;
        let selectionMeta = null;
        await core.executeAsModal(async () => {
            const selectionImage = await imaging.getSelection({
                documentID: docId,
                sourceBounds: normalizedSelection
            });
            const selectionImageData = selectionImage && selectionImage.imageData;
            if (!selectionImageData || typeof selectionImageData.getData !== "function") return;

            selectionPixels = await selectionImageData.getData({ chunky: true });
            selectionMeta = {
                sourceBounds: normalizeBoundsToIntegerRect(selectionImage?.sourceBounds || normalizedSelection) || normalizedSelection,
                width: Number(selectionImageData.width),
                height: Number(selectionImageData.height),
                components: Number(selectionImageData.components),
                hasAlpha: Boolean(selectionImageData.hasAlpha),
                componentSize: Number(selectionImageData.componentSize)
            };

            if (typeof selectionImageData.dispose === "function") {
                selectionImageData.dispose();
            }
        }, { commandName: "QuickAI Read Selection Components" });

        if (!selectionPixels || !selectionPixels.length) {
            return [normalizedSelection];
        }
        if (!selectionMeta || !selectionMeta.sourceBounds) {
            return [normalizedSelection];
        }

        const sourceBounds = selectionMeta.sourceBounds;
        const scanW = Number(selectionMeta.width) || (sourceBounds.right - sourceBounds.left);
        const scanH = Number(selectionMeta.height) || (sourceBounds.bottom - sourceBounds.top);
        if (!(scanW > 0 && scanH > 0)) return [normalizedSelection];

        const scanPixelCount = scanW * scanH;
        const mask = extractSelectionMaskChannel(selectionPixels, scanPixelCount, selectionMeta);
        if (!mask) return [normalizedSelection];

        const normalMaskComponents = extractConnectedBoundsFromSelectionMask(mask, scanW, scanH, 1);
        const mappedNormal = mapSelectionComponentBoundsToDocument(normalMaskComponents, sourceBounds);
        if (mappedNormal.length > 1) {
            log(`Generate: split selection into ${mappedNormal.length} region(s) via imaging scan.`);
            return mappedNormal;
        }

        // Some Photoshop setups expose inverse quick-mask polarity; evaluate inversion only when needed.
        const invertedMask = new Uint8Array(scanPixelCount);
        for (let i = 0; i < scanPixelCount; i += 1) {
            invertedMask[i] = 255 - mask[i];
        }
        const invertedMaskComponents = extractConnectedBoundsFromSelectionMask(invertedMask, scanW, scanH, 1);
        const mappedInverted = mapSelectionComponentBoundsToDocument(invertedMaskComponents, sourceBounds);
        if (mappedInverted.length > 1) {
            log(`Generate: split selection into ${mappedInverted.length} region(s) via imaging scan (inverted polarity).`);
            return mappedInverted;
        }

        const mappedBounds = chooseSelectionSegmentationCandidate(mappedNormal, mappedInverted);
        return mappedBounds.length > 0 ? mappedBounds : [normalizedSelection];
    } catch (error) {
        log(`Generate: selection component detection fallback (${describeError(error)}).`);
        return [normalizedSelection];
    }
}

// Activates a document and applies a rectangular selection for one Auto Run segment.
async function selectRectangleSelectionInDocument(docId, bounds) {
    const normalizedBounds = normalizeBoundsToIntegerRect(bounds);
    if (!normalizedBounds) return false;
    const targetDoc = getOpenDocumentById(docId);
    if (!targetDoc) return false;

    await core.executeAsModal(async () => {
        try {
            app.activeDocument = targetDoc;
        } catch (_e) {}
        await action.batchPlay([
            {
                _obj: "set",
                _target: [{ _ref: "channel", _property: "selection" }],
                to: {
                    _obj: "rectangle",
                    top: { _unit: "pixelsUnit", _value: normalizedBounds.top },
                    left: { _unit: "pixelsUnit", _value: normalizedBounds.left },
                    bottom: { _unit: "pixelsUnit", _value: normalizedBounds.bottom },
                    right: { _unit: "pixelsUnit", _value: normalizedBounds.right }
                },
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
    }, { commandName: "QuickAI Select Generate Segment" });

    return true;
}

// Clears active selection in a document through batchPlay when needed.
async function clearSelectionInDocument(docId) {
    if (docId === null || docId === undefined) return false;
    const targetDoc = getOpenDocumentById(docId);
    if (!targetDoc) return false;
    const hasSelectionBefore = await hasActiveSelection(targetDoc.id);
    if (!hasSelectionBefore) return false;

    await core.executeAsModal(async () => {
        try {
            app.activeDocument = targetDoc;
        } catch (_e) {}
        await targetDoc.selection.deselect();
    }, { commandName: "QuickAI Clear Selection" });

    const hasSelectionAfter = await hasActiveSelection(targetDoc.id);
    return !hasSelectionAfter;
}

// Returns layer bounds pixels.
function getLayerBoundsPixels(layer) {
    if (!layer) return null;
    const b = layer.boundsNoEffects || layer.bounds;
    if (!b) return null;
    const left = toPixels(b.left);
    const top = toPixels(b.top);
    const right = toPixels(b.right);
    const bottom = toPixels(b.bottom);
    if ([left, top, right, bottom].some((v) => typeof v !== "number")) return null;
    return { left, top, right, bottom };
}

// Returns layer bounds pixels by id.
async function getLayerBoundsPixelsById(docId, layerId) {
    if (docId === null || docId === undefined || layerId === null || layerId === undefined) return null;
    try {
        const result = await action.batchPlay([
            {
                _obj: "get",
                _target: [
                    { _property: "bounds" },
                    { _ref: "layer", _id: layerId },
                    { _ref: "document", _id: docId }
                ],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        const bounds = result && result[0] && result[0].bounds;
        if (!bounds) return null;
        const left = toPixels(bounds.left);
        const top = toPixels(bounds.top);
        const right = toPixels(bounds.right);
        const bottom = toPixels(bounds.bottom);
        if ([left, top, right, bottom].some((v) => typeof v !== "number")) return null;
        return { left, top, right, bottom };
    } catch (_e) {
        return null;
    }
}

// Checks whether valid bounds.
function hasValidBounds(bounds) {
    return Boolean(
        bounds
        && typeof bounds.left === "number"
        && typeof bounds.top === "number"
        && typeof bounds.right === "number"
        && typeof bounds.bottom === "number"
        && bounds.right > bounds.left
        && bounds.bottom > bounds.top
    );
}

// Formats bounds for crop debug logs without changing the underlying float precision.
function formatBoundsForLog(bounds) {
    if (!bounds) return "none";
    const left = Number(bounds.left);
    const top = Number(bounds.top);
    const right = Number(bounds.right);
    const bottom = Number(bounds.bottom);
    if (![left, top, right, bottom].every(Number.isFinite)) return "invalid";
    const width = right - left;
    const height = bottom - top;
    return `L=${Math.round(left)} T=${Math.round(top)} R=${Math.round(right)} B=${Math.round(bottom)} W=${Math.round(width)} H=${Math.round(height)}`;
}

// Formats a Photoshop document size for crop debug logs.
function formatDocumentSizeForLog(doc) {
    if (!doc) return "none";
    const width = toPixels(doc.width);
    const height = toPixels(doc.height);
    if (![width, height].every(Number.isFinite)) return "unknown";
    return `${Math.round(width)}x${Math.round(height)}`;
}

// Returns expanded selection bounds for crop.
function getExpandedSelectionBoundsForCrop(selectionBounds, doc, expandByPx = 0) {
    if (!hasValidBounds(selectionBounds)) return null;
    const expand = Number(expandByPx);
    if (!Number.isFinite(expand) || expand <= 0) {
        return {
            left: selectionBounds.left,
            top: selectionBounds.top,
            right: selectionBounds.right,
            bottom: selectionBounds.bottom
        };
    }

    let left = selectionBounds.left - expand;
    let top = selectionBounds.top - expand;
    let right = selectionBounds.right + expand;
    let bottom = selectionBounds.bottom + expand;

    const docW = doc ? Number(doc.width) : NaN;
    const docH = doc ? Number(doc.height) : NaN;
    if (Number.isFinite(docW) && docW > 0) {
        left = Math.max(0, left);
        right = Math.min(docW, right);
    }
    if (Number.isFinite(docH) && docH > 0) {
        top = Math.max(0, top);
        bottom = Math.min(docH, bottom);
    }
    if (!(right > left && bottom > top)) {
        return {
            left: selectionBounds.left,
            top: selectionBounds.top,
            right: selectionBounds.right,
            bottom: selectionBounds.bottom
        };
    }
    return { left, top, right, bottom };
}

// Handles move layer to document top.
function moveLayerToDocumentTop(layer, doc) {
    if (!layer || !doc) return layer;
    const topLevelLayer = doc.layers && doc.layers[0];

    // If insertion happened inside a group, pull this layer to document root/top.
    if (topLevelLayer && topLevelLayer.id !== layer.id) {
        try {
            layer.moveAbove(topLevelLayer);
        } catch (_e) {}
    }

    try {
        layer.bringToFront();
    } catch (_e) {}

    return (doc.activeLayers && doc.activeLayers[0]) || layer;
}

// Returns layer by id.
function getLayerById(doc, layerId) {
    if (!doc || layerId === null || layerId === undefined) return null;
    const allLayers = collectAllLayers(doc);
    for (let i = 0; i < allLayers.length; i += 1) {
        const layer = allLayers[i];
        if (!layer) continue;
        if (String(layer.id) === String(layerId)) return layer;
    }
    return null;
}

// Collects all layers.
function collectAllLayers(doc) {
    if (!doc) return [];
    const allLayers = [];
    const stack = [...(doc.layers || [])];
    while (stack.length > 0) {
        const layer = stack.shift();
        if (!layer) continue;
        allLayers.push(layer);
        const children = layer.layers;
        if (children && children.length) {
            for (let i = 0; i < children.length; i += 1) {
                stack.push(children[i]);
            }
        }
    }
    return allLayers;
}

// Builds layer-id -> index map following Photoshop Layers panel visual order (depth-first).
function getLayerPanelOrderIndexMap(doc) {
    const indexMap = new Map();
    if (!doc) return indexMap;
    let index = 0;
    const visit = (layers) => {
        if (!layers || !layers.length) return;
        for (let i = 0; i < layers.length; i += 1) {
            const layer = layers[i];
            if (!layer || layer.id === null || layer.id === undefined) continue;
            const layerId = String(layer.id);
            if (!indexMap.has(layerId)) {
                indexMap.set(layerId, index);
                index += 1;
            }
            visit(layer.layers);
        }
    };
    visit(doc.layers || []);
    return indexMap;
}

// Handles restore layer visibility.
function restoreLayerVisibility(doc, visibilityById) {
    const allLayers = collectAllLayers(doc);
    for (let i = 0; i < allLayers.length; i += 1) {
        const layer = allLayers[i];
        if (!visibilityById.has(layer.id)) continue;
        try {
            layer.visible = visibilityById.get(layer.id);
        } catch (_e) {}
    }
}

// Implements MAIN_INPUT_MODE_SELECTED_LAYER: temporarily hides every top-level layer stacked
// above the currently selected layer (or, if the selection is nested inside a group, above that
// group as a whole — groups are treated as one stacking unit rather than descending into them,
// matching how the rest of this file treats layer order elsewhere). Any adjustment/fill layer
// above the selection gets hidden along with everything else, so it no longer affects the
// composite — Photoshop adjustment layers only affect layers stacked below them, so hiding one
// is equivalent to excluding it. Returns a restore() function that undoes exactly what this
// changed; call it in a finally block even if the export in between throws.
function hideLayersAboveSelectedLayer(doc) {
    const noopRestore = () => {};
    if (!doc) return noopRestore;
    const activeLayers = Array.isArray(doc.activeLayers) ? doc.activeLayers : [];
    const selectedLayer = activeLayers[0];
    if (!selectedLayer) return noopRestore;

    const topLevelLayers = doc.layers || [];
    const findTopLevelAncestor = () => {
        for (let i = 0; i < topLevelLayers.length; i += 1) {
            const layer = topLevelLayers[i];
            if (!layer) continue;
            if (String(layer.id) === String(selectedLayer.id)) return layer;
            const stack = Array.isArray(layer.layers) ? [...layer.layers] : [];
            while (stack.length > 0) {
                const child = stack.shift();
                if (!child) continue;
                if (String(child.id) === String(selectedLayer.id)) return layer;
                if (Array.isArray(child.layers) && child.layers.length) stack.push(...child.layers);
            }
        }
        return null;
    };
    const ancestor = findTopLevelAncestor();
    if (!ancestor) return noopRestore;
    const ancestorIndex = topLevelLayers.findIndex((l) => l && String(l.id) === String(ancestor.id));
    if (ancestorIndex <= 0) return noopRestore;

    const originalVisibilityById = new Map();
    for (let i = 0; i < ancestorIndex; i += 1) {
        const layer = topLevelLayers[i];
        if (!layer) continue;
        originalVisibilityById.set(layer.id, Boolean(layer.visible));
        try { layer.visible = false; } catch (_e) {}
    }

    return () => restoreLayerVisibility(doc, originalVisibilityById);
}

// Implements MAIN_INPUT_MODE_SELECTED_LAYER_ONLY and the Bridge's "Send Selected Layer":
// temporarily makes the selected layer the only visible layer (its ancestor groups are forced
// visible so a layer nested in a hidden group still renders; if it is a group, the layers inside
// it keep their own visibility so the group renders as it looks) and sets its blend mode to Normal
// so the exported pixels aren't altered by mode-specific compositing. Returns a restore()
// function that puts visibility and blend mode back; call it in a finally block.
function isolateSelectedLayerOnly(doc) {
    const noopRestore = () => {};
    if (!doc) return noopRestore;
    const sourceLayer = Array.isArray(doc.activeLayers) ? doc.activeLayers[0] : null;
    if (!sourceLayer) return noopRestore;

    const allLayers = collectAllLayers(doc);
    const originalVisibilityById = new Map();
    for (let i = 0; i < allLayers.length; i += 1) {
        try {
            originalVisibilityById.set(allLayers[i].id, Boolean(allLayers[i].visible));
        } catch (_e) {}
    }

    // True when `layer` is inside the selected layer (only possible when it is a group).
    const isInsideSourceLayer = (layer) => {
        let ancestor = layer ? layer.parent : null;
        while (ancestor && ancestor !== doc) {
            if (ancestor.id === sourceLayer.id) return true;
            ancestor = ancestor.parent;
        }
        return false;
    };
    for (let i = 0; i < allLayers.length; i += 1) {
        try {
            // The layers inside a selected group keep their own visibility: hiding them too
            // would leave the group empty and export a blank image.
            if (isInsideSourceLayer(allLayers[i])) continue;
            allLayers[i].visible = allLayers[i].id === sourceLayer.id;
        } catch (_e) {}
    }
    let parent = sourceLayer.parent;
    while (parent && parent !== doc) {
        try {
            parent.visible = true;
        } catch (_e) {}
        parent = parent.parent;
    }

    let originalBlendMode = null;
    try {
        originalBlendMode = sourceLayer.blendMode;
        sourceLayer.blendMode = BlendMode.NORMAL;
    } catch (_e) {}

    return () => {
        if (originalBlendMode !== null && originalBlendMode !== undefined) {
            try {
                sourceLayer.blendMode = originalBlendMode;
            } catch (_e) {}
        }
        restoreLayerVisibility(doc, originalVisibilityById);
    };
}

// Creates/updates a soft mask around selection bounds for cropped Smart Object workflows.
async function applySoftSelectionMaskToLayer(doc, layer, options = {}) {
    if (!doc || !layer) return false;

    const selectionBounds = options.selectionBounds || null;
    const configuredContract = Number(options.contractBeforeMaskPx);
    const contractBeforeMaskPx = Number.isFinite(configuredContract) && configuredContract >= 0
        ? configuredContract
        : getCropMaskContractPxForBounds(selectionBounds);
    const configuredFeather = Number(options.maskFeatherPx);
    const maskFeatherPx = Number.isFinite(configuredFeather) && configuredFeather >= 0
        ? configuredFeather
        : getCropMaskFeatherPxForBounds(selectionBounds);

    // replaceActiveSelection: build the mask from `selectionBounds` even when a selection is
    // already active. Used for Generate crop results, which are masked long after the job was
    // sent, so whatever is selected then has nothing to do with this crop.
    const replaceActiveSelection = options.replaceActiveSelection === true;
    let hasSelection = replaceActiveSelection ? false : await hasActiveSelection(doc.id);
    if (
        !hasSelection
        && selectionBounds
        && typeof selectionBounds.left === "number"
        && typeof selectionBounds.top === "number"
        && typeof selectionBounds.right === "number"
        && typeof selectionBounds.bottom === "number"
        && selectionBounds.right > selectionBounds.left
        && selectionBounds.bottom > selectionBounds.top
    ) {
        await doc.selection.selectRectangle(
            {
                top: selectionBounds.top,
                left: selectionBounds.left,
                bottom: selectionBounds.bottom,
                right: selectionBounds.right
            },
            constants.SelectionType.REPLACE
        );
        hasSelection = await hasActiveSelection(doc.id);
    }
    if (!hasSelection) return false;

    try {
        app.activeDocument = doc;
        doc.activeLayers = [layer];
    } catch (_e) {}

    const roundedContract = Math.max(0, Math.round(contractBeforeMaskPx));
    if (roundedContract > 0) {
        await contractSelectionByPx(doc.selection, roundedContract);
        hasSelection = await hasActiveSelection(doc.id);
        if (!hasSelection) return false;
    }

    const maskResult = await action.batchPlay([
        {
            _obj: "make",
            _target: [
                { _ref: "layer", _id: layer.id },
                { _ref: "document", _id: doc.id }
            ],
            at: { _ref: "channel", _enum: "channel", _value: "mask" },
            new: { _class: "channel" },
            using: { _enum: "userMaskEnabled", _value: "revealSelection" },
            _options: { dialogOptions: "dontDisplay" }
        }
    ], {});
    if (maskResult && maskResult[0] && maskResult[0]._obj === "error") {
        throw new Error(maskResult[0].message || "Could not create layer mask from selection.");
    }

    if (maskFeatherPx > 0) {
        const featherResult = await action.batchPlay([
            {
                _obj: "set",
                _target: [
                    { _ref: "layer", _id: layer.id },
                    { _ref: "document", _id: doc.id }
                ],
                to: {
                    _obj: "layer",
                    userMaskFeather: { _unit: "pixelsUnit", _value: maskFeatherPx }
                },
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        if (featherResult && featherResult[0] && featherResult[0]._obj === "error") {
            throw new Error(featherResult[0].message || "Could not feather the crop Smart Object mask.");
        }
    }

    return true;
}

// Places a temp image as Smart Object, aligns it, and optionally applies a soft selection mask.
async function placeSnapshotAsSmartObject(uxpFile, options = {}) {
    if (!uxpFile) throw new Error("Missing snapshot file to place.");
    const targetDocId = options.targetDocId || null;
    const targetDoc = targetDocId ? getOpenDocumentById(targetDocId, options.targetDocName) : app.activeDocument;
    if (!targetDoc) throw new Error("No active Photoshop document.");
    const selectionBounds = options.selectionBounds || null;
    const maskSelectionBounds = options.maskSelectionBounds || selectionBounds;
    const layerName = options.layerName || "QuickAI Crop Snapshot";
    const token = await storage.localFileSystem.createSessionToken(uxpFile);
    let placedLayerRef = null;

    await core.executeAsModal(async () => {
        app.activeDocument = targetDoc;
        // Photoshop's placeEvent can place new content directly INTO the currently active layer
        // instead of adding a new layer above it, when that active layer is blank/empty — exactly
        // what a brand-new document's default layer is. That silently consumed the user's own
        // layer in a fresh document. Explicitly creating a new empty layer first and making it
        // active guarantees placeEvent always has a layer of its own to place into.
        await action.batchPlay([
            { _obj: "make", _target: [{ _ref: "layer" }], using: { _obj: "layer" }, _options: { dialogOptions: "dontDisplay" } }
        ], {});
        const placeholderLayer = app.activeDocument.activeLayers && app.activeDocument.activeLayers[0];
        const placeholderLayerId = placeholderLayer ? placeholderLayer.id : null;
        await action.batchPlay([
            {
                _obj: "placeEvent",
                null: {
                    _path: token,
                    _kind: "local"
                },
                freeTransformCenterState: {
                    _enum: "quadCenterState",
                    _value: "QCSAverage"
                },
                offset: {
                    _obj: "offset",
                    horizontal: { _unit: "pixelsUnit", _value: 0 },
                    vertical: { _unit: "pixelsUnit", _value: 0 }
                },
                _options: { dialogOptions: "dontDisplay" }
            }
            ,
            { _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }
        ], {});

        let placedLayer = app.activeDocument.activeLayers && app.activeDocument.activeLayers[0];
        if (!placedLayer) return;

        // If placeEvent added a genuinely new layer instead of consuming the placeholder (the
        // normal case for any document that already has real content), the placeholder is left
        // behind as an empty, unused layer — clean it up rather than leaving stray blank layers
        // in the user's document.
        if (placeholderLayerId !== null && placeholderLayerId !== undefined && placedLayer.id !== placeholderLayerId) {
            const stillThere = getLayerById(app.activeDocument, placeholderLayerId);
            if (stillThere) {
                try { await stillThere.delete(); } catch (_e) {}
            }
        }

        try {
            placedLayer.name = layerName;
        } catch (_e) {}

        placedLayer = moveLayerToDocumentTop(placedLayer, app.activeDocument);

        if (selectionBounds) {
            const currentBounds = getLayerBoundsPixels(placedLayer);
            if (currentBounds) {
                const dx = selectionBounds.left - currentBounds.left;
                const dy = selectionBounds.top - currentBounds.top;
                if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
                    try {
                        await placedLayer.translate(dx, dy);
                    } catch (_e) {}
                }
            }
        }
        if (selectionBounds) {
            try {
                const expandPx = getCropExpandPxForBounds(maskSelectionBounds);
                const contractPx = getContractPxFromExpandPx(expandPx);
                const featherPx = getCropMaskFeatherPxForBounds(maskSelectionBounds);
                const masked = await applySoftSelectionMaskToLayer(targetDoc, placedLayer, {
                    selectionBounds: maskSelectionBounds,
                    contractBeforeMaskPx: contractPx,
                    maskFeatherPx: featherPx
                });
                if (masked) {
                    log(
                        `Applied soft selection mask to crop Smart Object `
                        + `(contract=${Number(contractPx).toFixed(1)}px, `
                        + `feather=${Number(featherPx).toFixed(1)}px).`
                    );
                } else {
                    log("Crop Smart Object mask skipped: no active selection available.");
                }
            } catch (error) {
                log(`Crop Smart Object mask warning: ${describeError(error)}`);
            }
        }
        if (targetDoc && placedLayer) {
            placedLayerRef = {
                docId: targetDoc.id,
                layerId: placedLayer.id
            };
        }

    }, { commandName: "QuickAI Place Crop Snapshot" });
    if (placedLayerRef) {
        try {
            await normalizeCropSmartObjectContents(placedLayerRef.docId, placedLayerRef.layerId);
        } catch (error) {
            log(`Crop Smart Object content normalize warning: ${describeError(error)}`);
        }
    }
    return placedLayerRef;
}

// Keeps the outer crop Smart Object wrapper, but converts any nested Smart Objects inside it into regular layers.
async function normalizeCropSmartObjectContents(docId, layerId) {
    const docIdNumber = toActionTargetIdNumber(docId, "docId");
    const layerIdNumber = toActionTargetIdNumber(layerId, "layerId");
    await openSmartObjectLayerForEdit(docIdNumber, layerIdNumber);

    // openSmartObjectLayerForEdit is supposed to switch Photoshop's active document into an
    // isolated "edit contents" document distinct from the host document that owns the crop
    // Smart Object. If that switch silently didn't happen, app.activeDocument here would still
    // be the HOST document — iterating its layers below and running placedLayerConvertToLayers
    // on any Smart Object found would rasterize/replace layers that have nothing to do with this
    // crop, which would make an unrelated layer vanish from the Layers panel with no error
    // logged anywhere. Detect that mismatch up front and bail out before touching anything.
    const activeDocIdAfterOpen = toActionTargetIdNumber(app.activeDocument && app.activeDocument.id, "docId");
    if (activeDocIdAfterOpen === docIdNumber) {
        throw new Error("Crop Smart Object did not open its own contents document — skipping normalize to avoid touching the host document's layers.");
    }

    try {
        await core.executeAsModal(async () => {
            const soDoc = app.activeDocument;
            if (!soDoc) throw new Error("Could not access crop Smart Object contents document.");
            const soDocId = toActionTargetIdNumber(soDoc.id, "docId");
            const layers = collectAllLayers(soDoc).map((layer) => layer && layer.id).filter((id) => id !== null && id !== undefined);
            log(`Generate SO normalize debug: contents doc="${soDoc.name || "<unnamed>"}" id=${soDocId} layerCount=${layers.length}.`);
            let convertedCount = 0;
            for (let i = 0; i < layers.length; i += 1) {
                const currentLayerId = toActionTargetIdNumber(layers[i], "layerId");
                const smartObjectInfo = await action.batchPlay([
                    {
                        _obj: "get",
                        _target: [
                            { _property: "smartObject" },
                            { _ref: "layer", _id: currentLayerId },
                            { _ref: "document", _id: soDocId }
                        ],
                        _options: { dialogOptions: "dontDisplay" }
                    }
                ], { continueOnError: true });
                const hasSmartObject = Boolean(smartObjectInfo && smartObjectInfo[0] && smartObjectInfo[0].smartObject);
                if (!hasSmartObject) continue;
                await action.batchPlay([
                    {
                        _obj: "select",
                        _target: [{ _ref: "layer", _id: currentLayerId }, { _ref: "document", _id: soDocId }],
                        makeVisible: false,
                        _options: { dialogOptions: "dontDisplay" }
                    },
                    {
                        _obj: "placedLayerConvertToLayers",
                        _options: { dialogOptions: "dontDisplay" }
                    }
                ], {});
                convertedCount += 1;
            }
            log(`Generate SO normalize debug: converted ${convertedCount} nested Smart Object layer(s) in "${soDoc.name || "<unnamed>"}".`);
        }, { commandName: "QuickAI Normalize Crop Smart Object Contents" });
    } finally {
        await saveAndCloseActiveDocument();
    }
}

// Downscales a document in place (within an already-open modal scope) if its long edge
// exceeds maxDimensionPx, preserving aspect ratio. No-op when maxDimensionPx is
// falsy/0 or the document already fits. Only safe to use on documents whose changes
// won't be saved back to their source — e.g. a temp-opened Smart Object that gets
// discarded (closeDocumentByIdNoSave) right after export.
async function capDocumentDimensionIfNeeded(doc, maxDimensionPx) {
    if (!doc || !maxDimensionPx) return;
    const w = Number(doc.width);
    const h = Number(doc.height);
    if (!(w > 0) || !(h > 0)) return;
    const longEdge = Math.max(w, h);
    if (longEdge <= maxDimensionPx) return;
    const scale = maxDimensionPx / longEdge;
    const newW = Math.max(1, Math.round(w * scale));
    const newH = Math.max(1, Math.round(h * scale));
    await doc.resizeImage(newW, newH);
}

// Converts an in-modal document to 8 bits/channel if it currently is 16- or 32-bit, so PNG/JPEG
// files exported for ComfyUI upload stay small. A 16-bit document otherwise round-trips as a
// 16-bit PNG (roughly double the file size) even though ComfyUI's loaders only need 8-bit data.
// Returns true if a conversion was actually performed, so callers that operate on the user's
// live document (rather than a disposable temp doc) know whether they must roll the change back.
async function convertDocumentToEightBitIfNeeded(doc) {
    if (!doc) return false;
    try {
        if (doc.bitsPerChannel === constants.BitsPerChannelType.EIGHT) return false;
        const result = await action.batchPlay(
            [{ _obj: "convertMode", depth: 8, _options: { dialogOptions: "dontDisplay" } }],
            {}
        );
        if (result && result[0] && result[0]._obj === "error") {
            throw new Error(result[0].message || "convertMode to 8-bit failed.");
        }
        return true;
    } catch (e) {
        log(`QuickAI: could not convert document to 8-bit before export (${e && e.message ? e.message : e}). Exporting at original bit depth.`);
        return false;
    }
}

// Exports the active document composite as PNG, with optional crop-to-selection flow.
async function exportSnapshotToTempFolder(options = {}) {
    if (!app.activeDocument) throw new Error("No active Photoshop document.");
    const respectSelection = options.respectSelection !== false;
    const cropToSelection = options.cropToSelection === true;
    const fileName = options.fileName || buildSnapshotFileName();
    // PNG is lossless at every level — a lower compression level only trades a bigger
    // temp file for a faster encode, which is a good trade for short-lived files (e.g.
    // reference snapshots) that get uploaded once and then discarded.
    const pngCompression = Number.isFinite(options.pngCompression) ? options.pngCompression : 6;
    const maxDimensionPx = Number.isFinite(options.maxDimensionPx) && options.maxDimensionPx > 0
        ? options.maxDimensionPx
        : 0;

    const targetFolder = await getQuickAITempFolder();
    const outFile = await targetFolder.createFile(fileName, { overwrite: true });

    await core.executeAsModal(async () => {
        // Preserve history state so temporary isolation/crop operations are rolled back cleanly.
        const originalDoc = app.activeDocument;
        const originalState = originalDoc.activeHistoryState;
        try {
            // Only query the current selection when it actually affects which export path
            // runs below — skips a needless batchPlay round trip when the caller wants a
            // plain composite export regardless of selection (e.g. reference snapshots).
            let selectionIsActive = false;
            let currentSelectionBounds = null;
            if (cropToSelection || respectSelection) {
                const selectionState = await getSelectionState(originalDoc.id);
                selectionIsActive = Boolean(selectionState.hasSelection);
                if (cropToSelection && !selectionIsActive) {
                    throw new Error("No active selection found. Use any cropped send only when a selection exists.");
                }
                currentSelectionBounds = cropToSelection ? selectionState.bounds : null;
            }
            const expandPx = getCropExpandPxForBounds(currentSelectionBounds);
            if (cropToSelection && expandPx > 0) {
                await expandSelectionByPx(originalDoc.selection, expandPx);
            }

            if (!selectionIsActive || !respectSelection) {
                // Direct composite export path.
                if (cropToSelection) {
                    const cropResult = await action.batchPlay([
                        { _obj: "crop", _options: { dialogOptions: "dontDisplay" } }
                    ], {});
                    if (cropResult && cropResult[0] && cropResult[0]._obj === "error") {
                        throw new Error(cropResult[0].message || "Crop to selection failed.");
                    }
                }
                await capDocumentDimensionIfNeeded(originalDoc, maxDimensionPx);
                await convertDocumentToEightBitIfNeeded(originalDoc);
                await originalDoc.saveAs.png(outFile, { compression: pngCompression }, true);
                return;
            }

            const sourceLayer = originalDoc.activeLayers && originalDoc.activeLayers[0];
            if (!sourceLayer) {
                await capDocumentDimensionIfNeeded(originalDoc, maxDimensionPx);
                await convertDocumentToEightBitIfNeeded(originalDoc);
                await originalDoc.saveAs.png(outFile, { compression: pngCompression }, true);
                return;
            }

            // Selection-respecting export path:
            // isolate selected pixels to a temporary layer, hide others, optional crop, then export.
            const tempLayer = await sourceLayer.duplicate();
            originalDoc.activeLayers = [tempLayer];

            const copyResult = await action.batchPlay([
                {
                    _obj: "copyToLayer",
                    _options: { dialogOptions: "dontDisplay" }
                }
            ], {});
            if (copyResult && copyResult[0] && copyResult[0]._obj === "error") {
                throw new Error(copyResult[0].message || "copyToLayer failed");
            }

            const keptLayer = (originalDoc.activeLayers && originalDoc.activeLayers[0]) || tempLayer;
            const allLayers = originalDoc.layers || [];
            for (let i = 0; i < allLayers.length; i += 1) {
                const layer = allLayers[i];
                try {
                    layer.visible = layer.id === keptLayer.id;
                } catch (_e) {}
            }

            if (cropToSelection) {
                const cropResult = await action.batchPlay([
                    { _obj: "crop", _options: { dialogOptions: "dontDisplay" } }
                ], {});
                if (cropResult && cropResult[0] && cropResult[0]._obj === "error") {
                    throw new Error(cropResult[0].message || "Crop to selection failed.");
                }
            }
            await capDocumentDimensionIfNeeded(originalDoc, maxDimensionPx);
            await convertDocumentToEightBitIfNeeded(originalDoc);
            await originalDoc.saveAs.png(outFile, { compression: pngCompression }, true);
        } finally {
            try {
                if (originalState) originalDoc.activeHistoryState = originalState;
            } catch (_e) {}
        }
    }, { commandName: "QuickAI Save Snapshot" });

    return outFile;
}

// Exports one Auto Run crop segment from a pre-rendered full snapshot.
// Using a lightweight snapshot avoids repeated expensive crop/export operations on layered PSDs.
async function exportAutoRunCropSegmentFromBaseSnapshot(baseSnapshotFile, bounds, options = {}) {
    const files = await exportAutoRunCropSegmentsFromBaseSnapshot(baseSnapshotFile, [bounds], {
        fileNames: options.fileName ? [options.fileName] : undefined
    });
    return files[0];
}

// Exports several crop segments from one pre-rendered full snapshot, opening it only once.
// Each crop is cut by selecting its rectangle, cropping and saving, then stepping the document's
// history back to the uncropped state for the next one, instead of reopening (and re-decoding)
// the full-canvas PNG per crop. If stepping back ever fails to restore the full canvas, the
// snapshot is closed and reopened so the next crop is still cut from the right pixels.
// options.fileNames: optional per-crop output names. options.onSegmentStart(index): called before
// each crop (progress UI). Returns the saved files in the same order as boundsList.
async function exportAutoRunCropSegmentsFromBaseSnapshot(baseSnapshotFile, boundsList, options = {}) {
    if (!baseSnapshotFile) throw new Error("Missing Generate base snapshot file.");
    const normalizedList = (Array.isArray(boundsList) ? boundsList : []).map((bounds) => normalizeBoundsToIntegerRect(bounds));
    if (normalizedList.length === 0) return [];
    if (normalizedList.some((bounds) => !bounds)) throw new Error("Invalid Generate crop bounds.");
    const fileNames = Array.isArray(options.fileNames) ? options.fileNames : [];

    const targetFolder = await getQuickAITempFolder();
    const outFiles = [];
    for (let i = 0; i < normalizedList.length; i += 1) {
        outFiles.push(await targetFolder.createFile(fileNames[i] || buildSnapshotFileName(), { overwrite: true }));
    }

    await core.executeAsModal(async () => {
        let sourceDoc = null;
        let uncroppedState = null;
        let fullWidth = 0;
        let fullHeight = 0;
        // Opens the snapshot and records the full-canvas state each crop starts from. The PNG is
        // converted to 8-bit once here, so every crop cut from it is already 8-bit.
        const openSnapshot = async () => {
            sourceDoc = await app.open(baseSnapshotFile);
            if (!sourceDoc) throw new Error("Could not open Generate base snapshot.");
            try { app.activeDocument = sourceDoc; } catch (_e) {}
            await convertDocumentToEightBitIfNeeded(sourceDoc);
            uncroppedState = sourceDoc.activeHistoryState;
            fullWidth = Number(sourceDoc.width);
            fullHeight = Number(sourceDoc.height);
            log(
                `Generate crop debug: opened base snapshot doc id=${sourceDoc.id} `
                + `size=${formatDocumentSizeForLog(sourceDoc)}`
            );
        };
        const closeSnapshot = async () => {
            if (!sourceDoc) return;
            try {
                app.activeDocument = sourceDoc;
                if (typeof sourceDoc.closeWithoutSaving === "function") {
                    await sourceDoc.closeWithoutSaving();
                } else {
                    await action.batchPlay([
                        {
                            _obj: "close",
                            saving: { _enum: "yesNo", _value: "no" },
                            _options: { dialogOptions: "dontDisplay" }
                        }
                    ], {});
                }
            } catch (_e) {}
            sourceDoc = null;
        };

        try {
            await openSnapshot();
            for (let index = 0; index < normalizedList.length; index += 1) {
                const normalizedBounds = normalizedList[index];
                if (typeof options.onSegmentStart === "function") options.onSegmentStart(index);
                log(`Generate crop debug: cropping base snapshot ${baseSnapshotFile.name || "<unnamed>"} with ${formatBoundsForLog(normalizedBounds)}.`);

                if (index > 0) {
                    // Step back to the full canvas for this crop; reopen if that did not work.
                    try {
                        sourceDoc.activeHistoryState = uncroppedState;
                    } catch (_e) {}
                    if (Number(sourceDoc.width) !== fullWidth || Number(sourceDoc.height) !== fullHeight) {
                        log("Generate crop debug: history restore did not return the full snapshot; reopening it.");
                        await closeSnapshot();
                        await openSnapshot();
                    }
                }

                await action.batchPlay([
                    {
                        _obj: "set",
                        _target: [{ _ref: "channel", _property: "selection" }],
                        to: {
                            _obj: "rectangle",
                            top: { _unit: "pixelsUnit", _value: normalizedBounds.top },
                            left: { _unit: "pixelsUnit", _value: normalizedBounds.left },
                            bottom: { _unit: "pixelsUnit", _value: normalizedBounds.bottom },
                            right: { _unit: "pixelsUnit", _value: normalizedBounds.right }
                        },
                        _options: { dialogOptions: "dontDisplay" }
                    },
                    { _obj: "crop", _options: { dialogOptions: "dontDisplay" } }
                ], {});
                log(
                    `Generate crop debug: cropped snapshot doc id=${sourceDoc.id} `
                    + `size=${formatDocumentSizeForLog(sourceDoc)} expected=${formatBoundsForLog(normalizedBounds)}`
                );

                await sourceDoc.saveAs.png(outFiles[index], { compression: 6 }, true);
                log(`Generate crop debug: saved cropped snapshot ${outFiles[index].name || "<unnamed>"}.`);
            }
        } finally {
            await closeSnapshot();
        }
    }, { commandName: "QuickAI Export Generate Crop Segment" });

    return outFiles;
}

// Exports only the selected layer as PNG, with optional crop-to-selection flow.
async function exportSelectedLayerSnapshotToTempFolder(options = {}) {
    if (!app.activeDocument) throw new Error("No active Photoshop document.");
    const cropToSelection = options.cropToSelection === true;

    const targetFolder = await getQuickAITempFolder();
    const outFile = await targetFolder.createFile(buildSnapshotFileName(), { overwrite: true });

    await core.executeAsModal(async () => {
        const originalDoc = app.activeDocument;
        const originalState = originalDoc.activeHistoryState;
        const selectionState = await getSelectionState(originalDoc.id);
        const selectionIsActive = Boolean(selectionState.hasSelection);
        if (cropToSelection && !selectionIsActive) {
            throw new Error("No active selection found. Use any cropped send only when a selection exists.");
        }
        const currentSelectionBounds = cropToSelection ? selectionState.bounds : null;
        const expandPx = getCropExpandPxForBounds(currentSelectionBounds);
        if (cropToSelection && expandPx > 0) {
            await expandSelectionByPx(originalDoc.selection, expandPx);
        }
        if (!originalDoc.activeLayers || !originalDoc.activeLayers[0]) {
            throw new Error("No selected layer in Photoshop.");
        }
        let bitDepthConverted = false;
        // Only the selected layer visible, Normal blend mode — shared with Auto Run's
        // "Selected Layer" main input mode.
        const restoreIsolation = isolateSelectedLayerOnly(originalDoc);

        try {
            if (cropToSelection) {
                const cropResult = await action.batchPlay([
                    { _obj: "crop", _options: { dialogOptions: "dontDisplay" } }
                ], {});
                if (cropResult && cropResult[0] && cropResult[0]._obj === "error") {
                    throw new Error(cropResult[0].message || "Crop to selection failed.");
                }
            }
            bitDepthConverted = await convertDocumentToEightBitIfNeeded(originalDoc);
            await originalDoc.saveAs.png(outFile, { compression: 6 }, true);
        } finally {
            restoreIsolation();
            // A bit-depth conversion must always be rolled back (not just on the crop path) —
            // otherwise a non-crop export would permanently downconvert the user's real document.
            if (cropToSelection || bitDepthConverted) {
                try {
                    if (originalState) originalDoc.activeHistoryState = originalState;
                } catch (_e) {}
                // History restore can overwrite visibility in some Photoshop setups.
                restoreIsolation();
            }
        }
    }, { commandName: "QuickAI Save Selected Layer Snapshot" });

    return outFile;
}

// Exports the active document composite limited to the selected layer and everything stacked
// below it (top-level layers above the selection's ancestor hidden — see
// hideLayersAboveSelectedLayer, the same technique Auto Run's "Selected Layer & Below" main
// input mode uses), with optional crop-to-selection flow.
async function exportSelectedLayerAndBelowSnapshotToTempFolder(options = {}) {
    if (!app.activeDocument) throw new Error("No active Photoshop document.");
    const cropToSelection = options.cropToSelection === true;

    const targetFolder = await getQuickAITempFolder();
    const outFile = await targetFolder.createFile(buildSnapshotFileName(), { overwrite: true });

    await core.executeAsModal(async () => {
        const originalDoc = app.activeDocument;
        const originalState = originalDoc.activeHistoryState;
        const selectionState = await getSelectionState(originalDoc.id);
        const selectionIsActive = Boolean(selectionState.hasSelection);
        if (cropToSelection && !selectionIsActive) {
            throw new Error("No active selection found. Use any cropped send only when a selection exists.");
        }
        const currentSelectionBounds = cropToSelection ? selectionState.bounds : null;
        const expandPx = getCropExpandPxForBounds(currentSelectionBounds);
        if (cropToSelection && expandPx > 0) {
            await expandSelectionByPx(originalDoc.selection, expandPx);
        }
        if (!originalDoc.activeLayers || !originalDoc.activeLayers[0]) {
            throw new Error("No selected layer in Photoshop.");
        }
        let bitDepthConverted = false;
        const restoreVisibility = hideLayersAboveSelectedLayer(originalDoc);

        try {
            if (cropToSelection) {
                const cropResult = await action.batchPlay([
                    { _obj: "crop", _options: { dialogOptions: "dontDisplay" } }
                ], {});
                if (cropResult && cropResult[0] && cropResult[0]._obj === "error") {
                    throw new Error(cropResult[0].message || "Crop to selection failed.");
                }
            }
            bitDepthConverted = await convertDocumentToEightBitIfNeeded(originalDoc);
            await originalDoc.saveAs.png(outFile, { compression: 6 }, true);
        } finally {
            restoreVisibility();
            // A bit-depth conversion must always be rolled back (not just on the crop path) —
            // otherwise a non-crop export would permanently downconvert the user's real document.
            if (cropToSelection || bitDepthConverted) {
                try {
                    if (originalState) originalDoc.activeHistoryState = originalState;
                } catch (_e) {}
                // History restore can overwrite visibility in some Photoshop setups.
                restoreVisibility();
            }
        }
    }, { commandName: "QuickAI Save Selected Layer And Below Snapshot" });

    return outFile;
}

// Returns MIME type by filename extension for RunComfy data URI uploads.
function getMimeTypeFromFileName(fileName) {
    const ext = String(fileName || "").trim().toLowerCase().split(".").pop() || "";
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "webp") return "image/webp";
    if (ext === "bmp") return "image/bmp";
    if (ext === "gif") return "image/gif";
    if (ext === "exr") return "image/x-exr";
    return "application/octet-stream";
}

// Encodes binary bytes to Base64 text without relying on Node Buffer.
function encodeBytesToBase64(bytes) {
    const byteArray = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < byteArray.length; i += chunkSize) {
        const slice = byteArray.subarray(i, Math.min(byteArray.length, i + chunkSize));
        let part = "";
        for (let j = 0; j < slice.length; j += 1) part += String.fromCharCode(slice[j]);
        binary += part;
    }
    if (typeof btoa !== "function") throw new Error("Base64 encoder is unavailable in this host.");
    return btoa(binary);
}

// Decodes either raw Base64 or a data URI payload into binary bytes.
function decodeBase64ImagePayloadToBytes(payload) {
    const text = String(payload || "").trim();
    if (!text) throw new Error("Missing Base64 image payload.");
    const normalizedBase64 = text.startsWith("data:")
        ? String(text.split(",", 2)[1] || "").trim()
        : text;
    if (!normalizedBase64) throw new Error("Base64 image payload is empty.");
    if (typeof atob !== "function") throw new Error("Base64 decoder is unavailable in this host.");
    const binary = atob(normalizedBase64.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// Re-encodes an image file as JPEG with the requested quality for RunComfy payload size control.
async function reencodeImageFileAsJpeg(sourceFile, quality) {
    const targetFolder = await getQuickAITempFolder();
    const outFile = await targetFolder.createFile(`quickai_runcomfy_q${quality}_${Date.now()}.jpg`, { overwrite: true });
    await core.executeAsModal(async () => {
        let doc = null;
        try {
            doc = await app.open(sourceFile);
            if (!doc) throw new Error("Could not open source image for RunComfy JPEG re-encode.");
            await convertDocumentToEightBitIfNeeded(doc);
            await doc.saveAs.jpg(outFile, { quality }, true);
        } finally {
            if (doc) {
                try {
                    if (typeof doc.closeWithoutSaving === "function") {
                        await doc.closeWithoutSaving();
                    } else {
                        await action.batchPlay([
                            {
                                _obj: "close",
                                saving: { _enum: "yesNo", _value: "no" },
                                _options: { dialogOptions: "dontDisplay" }
                            }
                        ], {});
                    }
                } catch (_e) {}
            }
        }
    }, { commandName: "QuickAI RunComfy JPEG Re-encode" });
    return outFile;
}

// Returns optimized binary bytes for RunComfy input payloads; re-encodes to JPEG when raw payload is too large.
async function getRunComfyOptimizedBinaryAndMime(uxpFile, options = {}) {
    const requestedMaxBytes = Math.floor(Number(options.maxBytes) || 0);
    const maxBytes = Math.max(
        64 * 1024,
        Math.min(
            RUNCOMFY_MAX_BINARY_BYTES,
            requestedMaxBytes > 0 ? requestedMaxBytes : RUNCOMFY_MAX_BINARY_BYTES
        )
    );
    const originalBinary = await uxpFile.read({ format: storage.formats.binary });
    const originalBytes = originalBinary instanceof Uint8Array ? originalBinary : new Uint8Array(originalBinary || []);
    if (originalBytes.length <= maxBytes) {
        return {
            bytes: originalBytes,
            mimeType: getMimeTypeFromFileName(uxpFile.name || "")
        };
    }

    const jpegQualities = [8, 6, 4, 2];
    for (let i = 0; i < jpegQualities.length; i += 1) {
        const quality = jpegQualities[i];
        try {
            const jpegFile = await reencodeImageFileAsJpeg(uxpFile, quality);
            const jpegBinary = await jpegFile.read({ format: storage.formats.binary });
            const jpegBytes = jpegBinary instanceof Uint8Array ? jpegBinary : new Uint8Array(jpegBinary || []);
            if (jpegBytes.length <= maxBytes) {
                log(
                    `Generate: RunComfy payload optimized via JPEG q=${quality} `
                    + `(${Math.round(jpegBytes.length / 1024)} KB, target ${Math.round(maxBytes / 1024)} KB).`
                );
                return { bytes: jpegBytes, mimeType: "image/jpeg" };
            }
        } catch (_e) {
            // Continue trying lower quality levels.
        }
    }
    throw new Error(
        `RunComfy input image is too large (${Math.round(originalBytes.length / (1024 * 1024))} MB raw, `
        + `target ${Math.round(maxBytes / 1024)} KB). `
        + "Use a smaller/cropped selection or lower image size before running."
    );
}

// Builds a Base64 data URI for RunComfy media inputs.
async function buildRunComfyDataUriFromFile(uxpFile, options = {}) {
    if (!uxpFile) throw new Error("Missing file for RunComfy data URI.");
    const optimized = await getRunComfyOptimizedBinaryAndMime(uxpFile, options);
    const bytes = optimized.bytes;
    const mimeType = optimized.mimeType;
    const base64 = encodeBytesToBase64(bytes);
    return `data:${mimeType};base64,${base64}`;
}

// Downscales an exported image file if it exceeds Comfy Cloud's documented per-edge (16384px)
// or total-pixel-count (64MP) limits. These are separate from the byte-size limit — JPEG
// re-encoding alone can't satisfy a rejection caused by dimensions, since Comfy Cloud validates
// pixel dimensions independently and returns HTTP 400 regardless of file size.
async function ensureCloudDimensionsWithinLimit(uxpFile) {
    const targetFolder = await getQuickAITempFolder();
    let resizedFile = null;
    await core.executeAsModal(async () => {
        let doc = null;
        try {
            doc = await app.open(uxpFile);
            if (!doc) throw new Error("Could not open image to check Comfy Cloud dimension limits.");
            const w = Number(doc.width);
            const h = Number(doc.height);
            if (!(w > 0) || !(h > 0)) return;
            const longEdge = Math.max(w, h);
            const totalPixels = w * h;
            const edgeScale = longEdge > CLOUD_MAX_DIMENSION_PX ? CLOUD_MAX_DIMENSION_PX / longEdge : 1;
            const pixelScale = totalPixels > CLOUD_MAX_TOTAL_PIXELS ? Math.sqrt(CLOUD_MAX_TOTAL_PIXELS / totalPixels) : 1;
            const scale = Math.min(edgeScale, pixelScale);
            if (scale >= 1) return;
            const newW = Math.max(1, Math.round(w * scale));
            const newH = Math.max(1, Math.round(h * scale));
            await doc.resizeImage(newW, newH);
            await convertDocumentToEightBitIfNeeded(doc);
            resizedFile = await targetFolder.createFile(`quickai_cloud_dim_${Date.now()}.png`, { overwrite: true });
            await doc.saveAs.png(resizedFile, { compression: 6 }, true);
            log(`Comfy Cloud upload: downscaled ${w}x${h} to ${newW}x${newH} to satisfy the 16384px edge / 64MP limits.`);
        } finally {
            if (doc) {
                try {
                    if (typeof doc.closeWithoutSaving === "function") {
                        await doc.closeWithoutSaving();
                    } else {
                        await action.batchPlay([
                            {
                                _obj: "close",
                                saving: { _enum: "yesNo", _value: "no" },
                                _options: { dialogOptions: "dontDisplay" }
                            }
                        ], {});
                    }
                } catch (_e) {}
            }
        }
    }, { commandName: "QuickAI Check Comfy Cloud Image Dimensions" });
    return resizedFile || uxpFile;
}

// Returns a file that fits within maxBytes for upload, re-encoding to JPEG at decreasing
// quality if the source file is over the limit. Throws with a clear message if even the
// lowest-quality JPEG can't fit — mirrors getRunComfyOptimizedBinaryAndMime's fallback ladder.
async function ensureUploadFileWithinLimit(uxpFile, maxBytes, label) {
    const originalBinary = await uxpFile.read({ format: storage.formats.binary });
    const originalBytes = originalBinary instanceof Uint8Array ? originalBinary : new Uint8Array(originalBinary || []);
    if (originalBytes.length <= maxBytes) return uxpFile;

    const jpegQualities = [10, 8, 6, 4, 2];
    for (let i = 0; i < jpegQualities.length; i += 1) {
        const quality = jpegQualities[i];
        try {
            const jpegFile = await reencodeImageFileAsJpeg(uxpFile, quality);
            const jpegBinary = await jpegFile.read({ format: storage.formats.binary });
            const jpegBytes = jpegBinary instanceof Uint8Array ? jpegBinary : new Uint8Array(jpegBinary || []);
            if (jpegBytes.length <= maxBytes) {
                log(
                    `${label} upload optimized via JPEG q=${quality} `
                    + `(${Math.round(jpegBytes.length / (1024 * 1024))} MB, limit ${Math.round(maxBytes / (1024 * 1024))} MB).`
                );
                return jpegFile;
            }
        } catch (_e) {
            // Continue trying lower quality levels.
        }
    }
    throw new Error(
        `Image is too large for ${label} upload (${Math.round(originalBytes.length / (1024 * 1024))} MB, `
        + `limit ${Math.round(maxBytes / (1024 * 1024))} MB). Use a smaller/cropped selection before sending.`
    );
}

// Upload / payload cache for batch runs. Every job in a batch shares the same input file object,
// so the first job uploads it (or builds the RunComfy/RunPod payload) and the others reuse the
// result instead of re-sending identical bytes. Keyed by the file object itself, then by
// destination (server URL or provider + size budget). A WeakMap is used so entries disappear
// with the file object: a new Run exports a new file and therefore always uploads fresh.
const autoRunUploadCacheByFile = new WeakMap();

// True when an upload/payload for this file and destination already exists or is in flight.
function hasCachedAutoRunUpload(file, destinationKey) {
    if (!file || typeof file !== "object") return false;
    const byDestination = autoRunUploadCacheByFile.get(file);
    return Boolean(byDestination && byDestination.has(destinationKey));
}

// Returns the cached upload result promise for (file, destination), starting `produce()` the
// first time. Concurrent callers share the same in-flight promise. A failed attempt is dropped
// from the cache so a later job can retry instead of inheriting the failure forever.
function getCachedAutoRunUpload(file, destinationKey, produce) {
    if (!file || typeof file !== "object") return produce();
    let byDestination = autoRunUploadCacheByFile.get(file);
    if (!byDestination) {
        byDestination = new Map();
        autoRunUploadCacheByFile.set(file, byDestination);
    }
    const existing = byDestination.get(destinationKey);
    if (existing) return existing;
    const pending = Promise.resolve()
        .then(produce)
        .catch((error) => {
            byDestination.delete(destinationKey);
            throw error;
        });
    byDestination.set(destinationKey, pending);
    return pending;
}

// Main-input uploads started at once for a multi-crop job (see executePreparedAutoRunJob). Three
// keeps several transfers in flight to a remote server without flooding it or Photoshop's network
// stack with one request per crop on jobs with many crops.
const AUTO_RUN_UPLOAD_CONCURRENCY = 3;

// Runs async `tasks` (functions returning promises) with at most `limit` running at a time, in
// array order. Returns one promise per task, so callers can await results individually and in any
// order. Each returned promise also has a no-op rejection handler attached, so a task that fails
// before the caller gets to awaiting it is not reported as an unhandled rejection; awaiting it
// still throws the original error.
function runWithConcurrencyLimit(tasks, limit) {
    const settlers = [];
    const promises = tasks.map(() => new Promise((resolve, reject) => settlers.push({ resolve, reject })));
    promises.forEach((promise) => promise.catch(() => {}));
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < tasks.length) {
            const index = nextIndex;
            nextIndex += 1;
            try {
                settlers[index].resolve(await tasks[index]());
            } catch (error) {
                settlers[index].reject(error);
            }
        }
    };
    const workerCount = Math.max(1, Math.min(Number(limit) || 1, tasks.length));
    for (let i = 0; i < workerCount; i += 1) worker();
    return promises;
}

// Uploads a local temp PNG file to Comfy's upload endpoint using multipart form data.
async function uploadImageToComfy(uxpFile, options = {}) {
    const useCloud = Boolean(options.useCloud);
    if (useCloud && !getComfyApiKey()) {
        throw new Error("Comfy Cloud mode requires a Comfy API key in Settings.");
    }
    const maxUploadBytes = useCloud ? CLOUD_MAX_UPLOAD_BYTES : LOCAL_MAX_UPLOAD_BYTES;
    // Cloud has its own pixel-dimension caps (16384px edge / 64MP) on top of the byte-size cap;
    // resolve those first since JPEG re-encoding below only addresses file size, not dimensions.
    const dimensionCheckedFile = useCloud ? await ensureCloudDimensionsWithinLimit(uxpFile) : uxpFile;
    const uploadFile = await ensureUploadFileWithinLimit(dimensionCheckedFile, maxUploadBytes, useCloud ? "Comfy Cloud" : "Comfy server");
    const buffer = await uploadFile.read({ format: storage.formats.binary });
    const uploadMimeType = getMimeTypeFromFileName(uploadFile.name || "");
    const boundary = `----quickai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const crlf = "\r\n";
    const body = new Blob([
        `--${boundary}${crlf}`,
        `Content-Disposition: form-data; name="image"; filename="${uploadFile.name}"${crlf}`,
        `Content-Type: ${uploadMimeType}${crlf}${crlf}`,
        buffer,
        crlf,
        `--${boundary}${crlf}`,
        `Content-Disposition: form-data; name="type"${crlf}${crlf}`,
        `input${crlf}`,
        `--${boundary}${crlf}`,
        `Content-Disposition: form-data; name="overwrite"${crlf}${crlf}`,
        `true${crlf}`,
        `--${boundary}--${crlf}`
    ]);

    const response = await fetch(comfyApiUrl(useCloud ? "/api/upload/image" : "/upload/image", options), {
        method: "POST",
        headers: {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            ...buildComfyRequestHeaders({ useCloud })
        },
        body
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Upload failed ${response.status}: ${text}`);
    }

    const result = await response.json();
    return result?.name || uploadFile.name;
}

// Positions a floating box host (toast or confirmation) in the full-width strip above the footer:
// it starts at the same left gap as the panel content (the left edge of `alignTo`, or of the
// first visible card while the main panel shows; cards share the same horizontal extent) and
// keeps that same gap on the right, so it is centered in the strip. (The content itself is not
// centered on the panel: its scrollbar takes room on the right, but the strip has no scrollbar.)
// With nothing to measure (e.g. the Jobs view covers the main panel and no `alignTo` is given)
// the inline style is cleared and the CSS default — --qc-float-gap from both sides — applies.
// Measured each time a box opens, so it follows panel resizes between messages.
function alignFloatingBoxHost(host, alignTo = null) {
    if (!host) return;
    host.style.left = "";
    host.style.width = "";
    let anchor = alignTo || null;
    if (!anchor) {
        const mainWrapper = document.querySelector(".wrapper");
        if (mainWrapper && mainWrapper.style.display !== "none") {
            anchor = Array.from(mainWrapper.querySelectorAll(".actionCard"))
                .find((card) => card.getBoundingClientRect().width > 0) || null;
        }
    }
    if (!anchor || typeof anchor.getBoundingClientRect !== "function") return;
    const rect = anchor.getBoundingClientRect();
    const panelWidth = document.body ? document.body.getBoundingClientRect().width : 0;
    const sideGap = Math.round(rect.left);
    const width = Math.round(panelWidth - (sideGap * 2));
    if (!(rect.width > 0) || !(sideGap >= 0) || !(width > 0)) return;
    host.style.left = `${sideGap}px`;
    host.style.width = `${width}px`;
}

// UXP draws native form controls (dropdowns, text fields, ...) above the plugin's HTML
// regardless of z-index, so a floating box can never cover them. Instead, while a toast or
// confirmation is shown, the views are shortened (CSS --qc-float-reserve, subtracted from every
// view's height like the footer) so their scrolling content ends above the box: nothing is ever
// underneath it. The reserve is the tallest visible box plus one --qc-float-gap below it (above
// the footer) and one above it. It is written into the static <style id="qcFloatReserveStyle">
// in index.html (a <style> created at runtime was not applied on its first update). Measured one
// frame after showing and again shortly after, in case the first layout pass was not finished.
const FLOATING_BOX_GAP_PX = 12; // keep in sync with --qc-float-gap in index.html
function updateFloatingBoxReserve() {
    const measure = () => {
        let tallest = 0;
        const toast = document.getElementById("qcToast");
        if (toast && toast.classList.contains("isVisible")) {
            tallest = Math.max(tallest, toast.getBoundingClientRect().height || 0);
        }
        const confirmHost = document.getElementById("qcConfirmHost");
        if (confirmHost && confirmHost.classList.contains("isVisible")) {
            const box = confirmHost.firstElementChild || confirmHost;
            tallest = Math.max(tallest, box.getBoundingClientRect().height || 0);
        }
        const reserve = tallest > 0 ? Math.ceil(tallest) + (FLOATING_BOX_GAP_PX * 2) : 0;
        const reserveStyle = document.getElementById("qcFloatReserveStyle");
        // The divider line above the reserved area is shown only while space is reserved.
        const css = `:root { --qc-float-reserve: ${reserve}px; }`
            + (reserve > 0 ? " .qcFloatReserveLine { display: block; }" : "");
        if (reserveStyle && reserveStyle.textContent !== css) reserveStyle.textContent = css;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(measure);
    else setTimeout(measure, 0);
    setTimeout(measure, 60);
}

// Shows a short message at the bottom of the panel, then fades it out. Its x button closes it
// right away (see hidePanelToast).
// kind: "success" | "error" | "info" (controls the border color).
function showPanelToast(message, kind = "info", durationMs = 4500) {
    const toast = document.getElementById("qcToast");
    if (!toast) return;
    alignFloatingBoxHost(toast.parentElement);
    // Only the text span changes, so the close button inside the toast is kept.
    const text = document.getElementById("qcToastText");
    if (text) text.textContent = String(message || "");
    else toast.textContent = String(message || "");
    // The kind (success/error) colors the strip's divider line, the toast's only frame.
    setFloatReserveLineKind(kind);
    toast.classList.add("isVisible");
    // Make room for this message (its height can differ from the previous one).
    if (floatingBoxReserveTimer) clearTimeout(floatingBoxReserveTimer);
    floatingBoxReserveTimer = 0;
    updateFloatingBoxReserve();
    if (panelToastTimer) clearTimeout(panelToastTimer);
    panelToastTimer = setTimeout(hidePanelToast, durationMs);
}

// Colors the divider line above the toast/confirmation strip: green for "success", red for
// "error", the neutral footer color otherwise (confirmations and info toasts).
function setFloatReserveLineKind(kind) {
    const line = document.querySelector(".qcFloatReserveLine");
    if (!line) return;
    line.classList.toggle("isSuccess", kind === "success");
    line.classList.toggle("isError", kind === "error");
}

// Hides the toast now (the x button, or its auto-fade timer) and cancels any pending fade.
function hidePanelToast() {
    if (panelToastTimer) clearTimeout(panelToastTimer);
    panelToastTimer = null;
    const toast = document.getElementById("qcToast");
    if (toast) toast.classList.remove("isVisible");
    setFloatReserveLineKind("info");
    // Give the space back once the 200ms fade-out has finished, so content does not slide under
    // the toast while it is still visible.
    if (floatingBoxReserveTimer) clearTimeout(floatingBoxReserveTimer);
    floatingBoxReserveTimer = setTimeout(() => {
        floatingBoxReserveTimer = 0;
        updateFloatingBoxReserve();
    }, 220);
}

// Wire the toast's X once at load (the toast element is static markup). It is a plain element
// with role="button" (see the .qcToastClose CSS), so Enter/Space are handled here to keep it
// usable from the keyboard like a real button.
const panelToastCloseBtn = document.getElementById("qcToastCloseBtn");
if (panelToastCloseBtn) {
    panelToastCloseBtn.addEventListener("click", hidePanelToast);
    panelToastCloseBtn.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            hidePanelToast();
        }
    });
}

// Shows a small confirmation box with Cancel / Accept in the toast's spot at the bottom of the
// panel and resolves true (Accept) or false (Cancel). Unlike the toast it stays until answered.
// Only one confirmation is shown at a time: opening another one answers the previous with false.
// options.alignTo: an element whose left/right edges the box should match (e.g. the card the
// action came from); see alignFloatingBoxHost for the default.
function showPanelConfirm(message, options = {}) {
    const host = document.getElementById("qcConfirmHost");
    const text = document.getElementById("qcConfirmText");
    const acceptBtn = document.getElementById("qcConfirmAcceptBtn");
    const cancelBtn = document.getElementById("qcConfirmCancelBtn");
    // Missing markup (should not happen): do not block the action.
    if (!host || !acceptBtn || !cancelBtn) return Promise.resolve(true);
    if (panelConfirmResolve) panelConfirmResolve(false);
    if (text) text.textContent = String(message || "");
    acceptBtn.textContent = options.acceptLabel || "Accept";
    cancelBtn.textContent = options.cancelLabel || "Cancel";
    alignFloatingBoxHost(host, options.alignTo || null);
    host.classList.add("isVisible");
    setFloatReserveLineKind("info");
    updateFloatingBoxReserve();
    return new Promise((resolve) => {
        const finish = (accepted) => {
            acceptBtn.removeEventListener("click", onAccept);
            cancelBtn.removeEventListener("click", onCancel);
            host.classList.remove("isVisible");
            updateFloatingBoxReserve();
            if (panelConfirmResolve === settle) panelConfirmResolve = null;
            resolve(accepted);
        };
        const onAccept = () => finish(true);
        const onCancel = () => finish(false);
        const settle = (accepted) => finish(accepted);
        panelConfirmResolve = settle;
        acceptBtn.addEventListener("click", onAccept);
        cancelBtn.addEventListener("click", onCancel);
    });
}

// Clears the floating boxes when the panel switches screens (main panel <-> Settings, Jobs, Job
// Log, endpoint/deployment settings, Import Workflows): a toast or confirmation belongs to the
// screen it was shown on. The toast is hidden; an open confirmation is answered with Cancel.
function dismissFloatingBoxes() {
    hidePanelToast();
    dismissPanelConfirm();
}

// Closes an open confirmation box as if Cancel was pressed (no-op when none is open). Used when
// the view the confirmation belongs to is closed.
function dismissPanelConfirm() {
    if (panelConfirmResolve) panelConfirmResolve(false);
}

// "server:port" of the local Comfy the bridge talks to, for user-facing messages.
function comfyServerLabel() {
    return comfyBaseUrl().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

// Requests Comfy-side auto-application of uploaded files to selected LoadImage nodes.
// Returns the request id; pass it to waitForComfyApplyResult() to learn the outcome.
async function requestApplyToSelectedLoadImage(filename, maskFilename) {
    const requestId = `ps_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const payload = { filename, request_id: requestId };
    if (maskFilename) payload.mask_filename = maskFilename;

    const response = await fetch(comfyApiUrl("/quickai/apply-upload"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Apply request failed ${response.status}: ${text}`);
    }
    return requestId;
}

// Polls the bridge until the ComfyUI browser tab reports what happened to an apply request.
// Resolves { status: "applied" | "no_node" | "error" | "timeout", node_ids, message }.
// "timeout" means no ComfyUI tab picked the request up (tab closed, or an old extension).
async function waitForComfyApplyResult(requestId, timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        // The browser extension polls every 700ms, so 400ms keeps the wait short without spamming.
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
            const response = await fetch(comfyApiUrl(`/quickai/apply-result?request_id=${encodeURIComponent(requestId)}`));
            if (!response.ok) continue;
            const data = await response.json();
            if (data && data.status && data.status !== "pending") return data;
        } catch (_e) {
            // Transient network hiccup; keep polling until the deadline.
        }
    }
    return { status: "timeout", node_ids: [], message: "" };
}

// Pre-send check: asks the bridge whether the ComfyUI tab has a Load Image (or Load Image Mask)
// node selected, so Send can stop before exporting/uploading anything. The QuickAI extension in
// the ComfyUI tab reports its selection to the server every ~0.7s, so this is current.
// Returns "selected", "none" (tab connected, nothing selected), "no_tab" (no ComfyUI tab with the
// extension connected) or "unknown" (bridge unreachable or an older extension that does not
// report it) — callers should let "unknown" proceed and rely on the apply result instead.
async function checkComfyLoadImageSelection() {
    try {
        const response = await fetch(comfyApiUrl("/quickai/selection"));
        if (!response.ok) return "unknown";
        const data = await response.json();
        if (!data || typeof data !== "object") return "unknown";
        // The server falls back to this placeholder id only when no ComfyUI tab is connected.
        if (data.client_id === "__legacy__") return "no_tab";
        if (!Object.prototype.hasOwnProperty.call(data, "selected_loadimage_node_id")) return "unknown";
        const hasNode = (value) => value !== null && value !== undefined && value !== "";
        return (hasNode(data.selected_loadimage_node_id) || hasNode(data.selected_loadimagemask_node_id))
            ? "selected"
            : "none";
    } catch (_e) {
        return "unknown";
    }
}

// Gets currently selected Comfy output metadata through the loader bridge endpoint.
async function getSelectedOutputFromComfyBridge() {
    const response = await fetch(comfyApiUrl("/quickai/selection"));
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Selection request failed ${response.status}: ${text}`);
    }

    const data = await response.json();
    const info = data?.selected_output || {};
    const filename = (info.filename || "").trim();
    const subfolder = (info.subfolder || "").trim();
    const type = (info.type || "output").trim() || "output";

    if (!filename) {
        const error = new Error("No selected output found in Comfy. Select an output image in Comfy first.");
        // Lets the Get handlers show the "select a Save Image node" toast for this case only.
        error.qcNoSelectedOutput = true;
        throw error;
    }

    return { filename, subfolder, type };
}

// Extracts image-like URLs from RunComfy result payload recursively.
function getRunComfyImageOutputsFromResult(resultPayload, options = {}) {
    const preferredNodeIds = Array.from(new Set(
        (Array.isArray(options.preferredNodeIds) ? options.preferredNodeIds : [])
            .map((id) => normalizeWorkflowNodeId(id))
            .filter(Boolean)
    ));
    const requirePreferredNodeMatch = Boolean(options.requirePreferredNodeMatch);
    const buildFilenameFromUrl = (url) => {
        let filename = "runcomfy_output.png";
        try {
            const parsed = new URL(url);
            const tail = String(parsed.pathname || "").split("/").pop() || "";
            if (tail) filename = tail;
        } catch (_e) {}
        return filename;
    };
    const getPreferredFilenamePrefixEntries = () => {
        const entries = [];
        const seen = new Set();
        for (let i = 0; i < preferredNodeIds.length; i += 1) {
            const nodeId = preferredNodeIds[i];
            const prefix = String(getSaveImagePrefixFromHistoryEntry(resultPayload, nodeId) || "").trim();
            if (!prefix) continue;
            const key = `${nodeId}|${prefix.toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push({ nodeId, prefix, prefixLower: prefix.toLowerCase() });
        }
        return entries;
    };
    // Primary path: documented RunComfy result schema:
    // { outputs: { "<node_id>": { images: [{ url, filename, subfolder, type }] } } }
    const outputsRoot = resultPayload && typeof resultPayload === "object" ? resultPayload.outputs : null;
    if (outputsRoot && typeof outputsRoot === "object") {
        const strictCollected = [];
        const strictCollectedByNode = [];
        const seenStrict = new Set();
        for (const [rawNodeId, nodeEntry] of Object.entries(outputsRoot)) {
            const normalizedNodeId = normalizeWorkflowNodeId(rawNodeId);
            // RunComfy can surface mask/video artifacts alongside normal image outputs under the same node map.
            const outputGroups = [
                Array.isArray(nodeEntry?.images) ? nodeEntry.images : [],
                Array.isArray(nodeEntry?.masks) ? nodeEntry.masks : [],
                Array.isArray(nodeEntry?.videos) ? nodeEntry.videos : [],
                Array.isArray(nodeEntry?.gifs) ? nodeEntry.gifs : []
            ];
            for (let groupIndex = 0; groupIndex < outputGroups.length; groupIndex += 1) {
                const outputItems = outputGroups[groupIndex];
                for (let i = 0; i < outputItems.length; i += 1) {
                    const image = outputItems[i] || {};
                    const url = String(image.url || "").trim();
                    if (!/^https?:\/\//i.test(url)) continue;
                    const dedupeKey = `${normalizedNodeId}|${url.toLowerCase()}`;
                    if (seenStrict.has(dedupeKey)) continue;
                    seenStrict.add(dedupeKey);
                    const filenameFromPayload = String(image.filename || "").trim();
                    const filename = filenameFromPayload || buildFilenameFromUrl(url);
                    strictCollected.push({ url, filename, nodeId: normalizedNodeId });
                    strictCollectedByNode.push({ url, filename, nodeId: normalizedNodeId });
                }
            }
        }
        if (strictCollected.length > 0) {
            if (preferredNodeIds.length > 0) {
                const filtered = strictCollectedByNode.filter((item) => preferredNodeIds.includes(String(item.nodeId || "")));
                if (filtered.length > 0) return filtered;
                if (!requirePreferredNodeMatch) return strictCollected;
            }
            else return strictCollected;
        }
    }

    // Fallback path: recurse for less-structured payload variants.
    const collected = [];
    const seen = new Set();
    const maybePush = (value, keyPath = "") => {
        const text = String(value || "").trim();
        if (!/^https?:\/\//i.test(text)) return;
        const pathText = String(keyPath || "").toLowerCase();
        const pathLooksLikeImage = (
            pathText.includes("image")
            || pathText.includes("output")
            || pathText.includes("file")
            || pathText.includes("artifact")
            || pathText.includes("media")
            || pathText.includes("url")
        );
        const pathLooksLikeStatus = (
            pathText.includes("status")
            || pathText.includes("request")
            || pathText.includes("cancel")
            || pathText.includes("health")
        );
        const dedupeKey = text.toLowerCase();
        if (seen.has(dedupeKey)) return;
        const lowered = dedupeKey.split("?")[0];
        const hasImageExtension =
            lowered.includes(".png")
            || lowered.includes(".jpg")
            || lowered.includes(".jpeg")
            || lowered.includes(".webp")
            || lowered.includes(".bmp")
            || lowered.includes(".gif")
            || lowered.includes(".exr")
            || lowered.includes(".mp4")
            || lowered.includes(".webm")
            || lowered.includes(".mov")
            || lowered.includes(".mkv")
            || lowered.includes(".m4v");
        const hasTextExtension =
            lowered.includes(".txt")
            || lowered.includes(".json")
            || lowered.includes(".csv")
            || lowered.includes(".log")
            || lowered.includes(".md");
        if (hasTextExtension) return;
        if (!hasImageExtension && (!pathLooksLikeImage || pathLooksLikeStatus)) return;
        seen.add(dedupeKey);
        collected.push(text);
    };
    const walk = (node, keyPath = "") => {
        if (!node) return;
        if (typeof node === "string") {
            maybePush(node, keyPath);
            return;
        }
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i += 1) walk(node[i], `${keyPath}[${i}]`);
            return;
        }
        if (typeof node === "object") {
            const urlCandidateKeys = ["url", "image_url", "download_url", "file_url", "src", "href"];
            for (let i = 0; i < urlCandidateKeys.length; i += 1) {
                const key = urlCandidateKeys[i];
                if (Object.prototype.hasOwnProperty.call(node, key)) maybePush(node[key], keyPath ? `${keyPath}.${key}` : key);
            }
            for (const [key, value] of Object.entries(node)) walk(value, keyPath ? `${keyPath}.${key}` : key);
        }
    };
    walk(resultPayload, "result");
    const fallbackOutputs = collected.map((url) => ({ url, filename: buildFilenameFromUrl(url), nodeId: "" }));
    if (preferredNodeIds.length > 0) {
        const prefixEntries = getPreferredFilenamePrefixEntries();
        if (prefixEntries.length > 0) {
            const matchedByPrefix = [];
            const seenMatches = new Set();
            for (let i = 0; i < fallbackOutputs.length; i += 1) {
                const item = fallbackOutputs[i];
                const filenameLower = String(item.filename || "").trim().toLowerCase();
                for (let j = 0; j < prefixEntries.length; j += 1) {
                    const prefixEntry = prefixEntries[j];
                    if (!filenameLower.startsWith(prefixEntry.prefixLower.toLowerCase())) continue;
                    const matchKey = `${prefixEntry.nodeId}|${item.url.toLowerCase()}`;
                    if (seenMatches.has(matchKey)) continue;
                    seenMatches.add(matchKey);
                    matchedByPrefix.push({ url: item.url, filename: item.filename, nodeId: prefixEntry.nodeId });
                }
            }
            if (matchedByPrefix.length > 0) return matchedByPrefix;
        }
        if (requirePreferredNodeMatch) return [];
    }
    return fallbackOutputs;
}

// Unwraps RunPod's completed-job envelope so the existing serverless output parser can inspect the real result payload.
function getRunPodResultPayload(resultPayload) {
    if (!resultPayload || typeof resultPayload !== "object") return resultPayload;
    if (Object.prototype.hasOwnProperty.call(resultPayload, "output")) return resultPayload.output;
    if (resultPayload.result && typeof resultPayload.result === "object") {
        if (Object.prototype.hasOwnProperty.call(resultPayload.result, "output")) return resultPayload.result.output;
        return resultPayload.result;
    }
    return resultPayload;
}

// Extracts inline Base64 image outputs from RunPod result payloads when no downloadable URLs exist.
function getRunPodInlineImageOutputsFromResult(resultPayload) {
    const images = [
        ...(Array.isArray(resultPayload?.images) ? resultPayload.images : []),
        // RunPod video-saving workflows (e.g. SaveVideo) can return results under "videos" instead.
        ...(Array.isArray(resultPayload?.videos) ? resultPayload.videos : [])
    ];
    const outputs = [];
    for (let i = 0; i < images.length; i += 1) {
        const image = images[i] || {};
        const rawData = typeof image?.data === "string"
            ? image.data
            : (typeof image?.image === "string" ? image.image : "");
        const trimmedData = String(rawData || "").trim();
        if (!trimmedData) continue;
        const rawName = String(image?.filename || image?.name || "").trim();
        let filename = rawName || `runpod_output_${i + 1}.png`;
        const dataUriMatch = /^data:(image\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);base64,/i.exec(trimmedData);
        if (!rawName && dataUriMatch) {
            const mimeType = String(dataUriMatch[1] || "").trim().toLowerCase();
            if (mimeType === "image/jpeg" || mimeType === "image/jpg") filename = `runpod_output_${i + 1}.jpg`;
            else if (mimeType === "image/webp") filename = `runpod_output_${i + 1}.webp`;
            else if (mimeType === "image/gif") filename = `runpod_output_${i + 1}.gif`;
            else if (mimeType === "image/bmp") filename = `runpod_output_${i + 1}.bmp`;
            else if (mimeType === "video/mp4") filename = `runpod_output_${i + 1}.mp4`;
            else if (mimeType === "video/webm") filename = `runpod_output_${i + 1}.webm`;
            else if (mimeType === "video/quicktime") filename = `runpod_output_${i + 1}.mov`;
        }
        outputs.push({
            filename,
            inlineData: trimmedData,
            nodeId: ""
        });
    }
    return outputs;
}

// Splits RunPod inline image results into normal outputs and optional export_mask output.
// RunPod's simple image-list payload does not expose per-node ids, so when output_mask is
// configured we mirror the other backends by treating the last inline image as mask output
// and the preceding entries as regular outputs.
function splitRunPodInlineOutputsForImport(resultPayload, options = {}) {
    const allOutputs = getRunPodInlineImageOutputsFromResult(resultPayload);
    const expectMaskOutput = Boolean(options.expectMaskOutput);
    if (!expectMaskOutput || allOutputs.length < 2) {
        return {
            outputs: allOutputs,
            maskOutput: null
        };
    }

    const outputItems = allOutputs.slice(0, -1);
    const maskOutput = allOutputs[allOutputs.length - 1] || null;
    return {
        outputs: outputItems.length > 0 ? outputItems : allOutputs.slice(0, 1),
        maskOutput
    };
}

// Summarizes recursive RunComfy image URLs and prefix matches for debugging missing mask outputs.
function describeRunComfyImageUrlRecovery(resultPayload, preferredNodeIds = []) {
    const recursiveOutputs = getRunComfyImageOutputsFromResult(resultPayload, {});
    const normalizedPreferredNodeIds = Array.from(new Set(
        (Array.isArray(preferredNodeIds) ? preferredNodeIds : [preferredNodeIds])
            .map((id) => normalizeWorkflowNodeId(id))
            .filter(Boolean)
    ));
    const preferredOutputs = normalizedPreferredNodeIds.length > 0
        ? getRunComfyImageOutputsFromResult(resultPayload, {
            preferredNodeIds: normalizedPreferredNodeIds,
            requirePreferredNodeMatch: true
        })
        : [];
    const recursiveSummary = recursiveOutputs.length > 0
        ? recursiveOutputs.slice(0, 8).map((item) => String(item?.filename || "").trim() || "<unnamed>").join(", ")
        : "none";
    const preferredSummary = preferredOutputs.length > 0
        ? preferredOutputs.slice(0, 8).map((item) => `${item.nodeId || "?"}:${String(item?.filename || "").trim() || "<unnamed>"}`).join(", ")
        : "none";
    return `recursive_urls=${recursiveOutputs.length} [${recursiveSummary}] preferred_matches=${preferredOutputs.length} [${preferredSummary}]`;
}

// Summarizes per-node RunComfy outputs so mask-result failures are visible in the panel log.
function describeRunComfyOutputGroups(resultPayload) {
    const outputsRoot = resultPayload && typeof resultPayload === "object" ? resultPayload.outputs : null;
    if (!outputsRoot || typeof outputsRoot !== "object") return "outputs=<missing>";
    const parts = [];
    for (const [rawNodeId, nodeEntry] of Object.entries(outputsRoot)) {
        const normalizedNodeId = normalizeWorkflowNodeId(rawNodeId) || String(rawNodeId || "").trim() || "?";
        const imageCount = Array.isArray(nodeEntry?.images) ? nodeEntry.images.length : 0;
        const maskCount = Array.isArray(nodeEntry?.masks) ? nodeEntry.masks.length : 0;
        const entryKeys = nodeEntry && typeof nodeEntry === "object"
            ? Object.keys(nodeEntry).slice(0, 8).join("/")
            : "";
        parts.push(`${normalizedNodeId}[images=${imageCount}, masks=${maskCount}${entryKeys ? `, keys=${entryKeys}` : ""}]`);
    }
    return parts.length > 0 ? parts.join("; ") : "outputs=<empty>";
}

// Domains allowed to receive the RunComfy API token when downloading result files. Output URLs
// come from the job's result payload (and a recursive fallback that collects any image-looking
// URL in it), so they can point at third-party storage; the token must never follow them there.
const RUNCOMFY_TOKEN_TRUSTED_DOMAINS = ["runcomfy.net", "runcomfy.com"];

// Returns the lowercase hostname of an https:// URL, or "" for anything else. Deliberately strict:
// the host must be plain [a-z0-9.-] directly after "https://", so URLs with credentials
// ("https://a@b/") or unusual authority syntax are treated as untrusted instead of being parsed.
function getHttpsUrlHostname(url) {
    const match = /^https:\/\/([a-z0-9.-]+)(?::\d+)?(?:[/?#]|$)/i.exec(String(url || "").trim());
    return match ? match[1].toLowerCase() : "";
}

// True when `url` is https and its host is a RunComfy domain or one of its subdomains.
function isRunComfyTokenTrustedUrl(url) {
    const host = getHttpsUrlHostname(url);
    if (!host) return false;
    return RUNCOMFY_TOKEN_TRUSTED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// Strips the query string and fragment from every http(s) URL in `text`, leaving a marker.
// Cloud result payloads often use pre-signed links whose access code lives after "?"
// (e.g. ?X-Amz-Signature=…&Expires=…); anyone holding the full link can open the file until it
// expires. Logs keep the host and path, which is enough to debug, but never the code.
function redactUrlQueryStrings(text) {
    return String(text || "").replace(/(https?:\/\/[^\s"'<>\\?#]+)[?#][^\s"'<>\\]*/gi, "$1?[removed]");
}

// Returns just the host of a URL for logging (never the path/query, which can hold signed-URL
// credentials or file names).
function describeUrlHostForLog(url) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(url || "").trim());
    return match ? match[1].replace(/^.*@/, "").toLowerCase() : "<unknown host>";
}

// Downloads a RunComfy/RunPod result file (image or video) from the URL in the job result.
// The RunComfy token is attached only for provider "runcomfy" AND an https RunComfy-domain URL;
// RunPod results never get it (RunPod's own token isn't needed either: worker storage links are
// public or pre-signed). Everything else is fetched anonymously, so a result URL pointing at
// external storage can't receive credentials.
async function downloadServerlessOutputByUrl(url, options = {}) {
    const provider = options.provider === "runpod" ? "runpod" : "runcomfy";
    const providerLabel = provider === "runpod" ? "RunPod" : "RunComfy";
    const sendToken = provider === "runcomfy" && isRunComfyTokenTrustedUrl(url);
    const host = describeUrlHostForLog(url);
    log(`Generate: downloading ${providerLabel} output from ${host} (token: ${sendToken ? "sent" : "not sent"}).`);

    const response = await fetch(url, sendToken ? { headers: buildRunComfyRequestHeaders() } : {});
    if (!response.ok) {
        const text = await response.text();
        // A refusal on an anonymous download most likely means this host expects the RunComfy
        // token; name the host so it can be reviewed and, if legitimate, added to the trusted list.
        if (!sendToken && (response.status === 401 || response.status === 403)) {
            throw new Error(
                `${providerLabel} output download from ${host} was refused (${response.status}). `
                + `No API token is sent to this host for security; if it is a legitimate ${providerLabel} host, it must be added to the trusted list.`
            );
        }
        throw new Error(`${providerLabel} output download failed ${response.status}: ${text}`);
    }
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase().trim();
    if (
        contentType
        && !contentType.startsWith("image/")
        && !contentType.includes("application/octet-stream")
    ) {
        throw new Error(`${providerLabel} output is not an image (content-type: ${contentType || "unknown"}).`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
}

// Builds the /view (Comfy Cloud: /api/view) URL a Comfy output file is downloaded from. Shared by
// downloadComfyOutput and the output prefetch key so both always agree on the same URL.
function buildComfyOutputViewUrl(filename, subfolder, type, options = {}) {
    const useCloud = Boolean(options.useCloud);
    const query = new URLSearchParams({ filename, type: type || "output" });
    if (subfolder) query.set("subfolder", subfolder);
    const path = useCloud ? `/api/view?${query.toString()}` : `/view?${query.toString()}`;
    return comfyApiUrl(path, options);
}

// Downloads a selected Comfy output image as binary data.
async function downloadComfyOutput(filename, subfolder, type, options = {}) {
    const useCloud = Boolean(options.useCloud);
    const url = buildComfyOutputViewUrl(filename, subfolder, type, options);

    const response = await fetch(url, { headers: buildComfyRequestHeaders({ useCloud }) });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Output download failed ${response.status}: ${text}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
}

// Output prefetch: as soon as one crop of a multi-crop job finishes, its result starts downloading
// in the background while the other crops are still generating, so the import step finds the
// bytes already on hand instead of downloading every result one after another at the end.
// Key -> Promise<Uint8Array|null>. A failed prefetch resolves to null (never rejects), and the
// import then simply downloads that file normally. Entries are removed when the import uses them,
// and any leftovers are released when the job finishes (releaseAutoRunOutputPrefetches).
const autoRunOutputPrefetchByKey = new Map();

// Identifies one downloadable output: its exact /view URL for Comfy (local/Cloud) outputs, or its
// result URL for RunComfy/RunPod. Returns "" for outputs with nothing to fetch (inline data).
function getAutoRunOutputDownloadKey(outputItem, options = {}) {
    if (!outputItem) return "";
    if (typeof outputItem.inlineData === "string" && outputItem.inlineData.trim()) return "";
    if (options.useRunComfy || options.useRunPod) {
        const url = String(outputItem.url || "").trim();
        return url ? `url|${options.useRunPod ? "runpod" : "runcomfy"}|${url}` : "";
    }
    const filename = String(outputItem.filename || "").trim();
    if (!filename) return "";
    return `view|${buildComfyOutputViewUrl(filename, outputItem.subfolder, outputItem.type, options)}`;
}

// Removes and returns the prefetched download for `key` (null when none was started).
function takePrefetchedAutoRunOutput(key) {
    if (!key || !autoRunOutputPrefetchByKey.has(key)) return null;
    const pending = autoRunOutputPrefetchByKey.get(key);
    autoRunOutputPrefetchByKey.delete(key);
    return pending;
}

// Starts background downloads for one finished segment's outputs: the same image outputs (and
// export_mask, for Comfy local/Cloud) the import will pick from its history entry. Anything the
// import resolves differently (EXR fallbacks, history retries) just misses the prefetch and is
// downloaded as before. Keys are recorded on the job so unused downloads can be released.
function prefetchAutoRunSegmentOutputs(job, segment, backendOptions) {
    if (!job || !segment || !segment.completedEntry) return;
    const useRunComfy = Boolean(job.useRunComfy);
    const useRunPod = Boolean(job.useRunPod);
    const useCloud = Boolean(job.useCloud);
    const downloadOptions = { useCloud, useRunComfy, useRunPod, ...backendOptions };
    const targets = job.workflowNodeTargets || {};
    const normalizeIds = (ids) => Array.from(new Set((Array.isArray(ids) ? ids : [])
        .map((id) => normalizeWorkflowNodeId(id))
        .filter(Boolean)));
    const exportNodeIds = normalizeIds([].concat(targets.exportNodeIds || [], targets.exportNodeId ? [targets.exportNodeId] : []));
    const exportMaskNodeIds = normalizeIds([].concat(targets.exportMaskNodeIds || [], targets.exportMaskNodeId ? [targets.exportMaskNodeId] : []));

    let candidates = [];
    try {
        if (useRunComfy || useRunPod) {
            const payload = useRunPod ? getRunPodResultPayload(segment.completedEntry) : segment.completedEntry;
            candidates = getRunComfyImageOutputsFromResult(payload, { preferredNodeIds: exportNodeIds }) || [];
        } else {
            candidates = (getImageOutputsFromHistoryEntry(segment.completedEntry, { preferredNodeIds: exportNodeIds }) || []).slice();
            if (exportMaskNodeIds.length > 0) {
                const mask = (getImageOutputsFromHistoryEntry(segment.completedEntry, { preferredNodeIds: exportMaskNodeIds }) || [])[0];
                if (mask) candidates.push(mask);
            }
        }
    } catch (error) {
        log(`Generate: output prefetch skipped for ${segment.segmentLabel || "segment"} (${describeError(error)}).`);
        return;
    }

    if (!Array.isArray(job.outputPrefetchKeys)) job.outputPrefetchKeys = [];
    for (const item of candidates) {
        const key = getAutoRunOutputDownloadKey(item, downloadOptions);
        if (!key || autoRunOutputPrefetchByKey.has(key)) continue;
        const pending = ((useRunComfy || useRunPod)
            ? downloadServerlessOutputByUrl(String(item.url).trim(), { provider: useRunPod ? "runpod" : "runcomfy" })
            : downloadComfyOutput(item.filename, item.subfolder, item.type, downloadOptions))
            .catch((error) => {
                log(`Generate: background download of ${item.filename || "output"} failed; it will be retried on import (${describeError(error)}).`);
                return null;
            });
        autoRunOutputPrefetchByKey.set(key, pending);
        job.outputPrefetchKeys.push(key);
    }
    if (candidates.length > 0) {
        logForJob(job, `Generate: started background download of ${segment.segmentLabel || "segment"} result.`);
    }
}

// Drops any prefetched downloads the job's import did not use, so their bytes can be freed.
function releaseAutoRunOutputPrefetches(job) {
    if (!job || !Array.isArray(job.outputPrefetchKeys)) return;
    for (const key of job.outputPrefetchKeys) autoRunOutputPrefetchByKey.delete(key);
    job.outputPrefetchKeys = [];
}

// Writes downloaded binary output into a temp file for Photoshop placement.
async function writeBinaryToTempImportFile(binary, filename) {
    const tempFolder = await getQuickAITempFolder();
    const safeName = (filename || "comfy_output.png").replace(/[^a-zA-Z0-9._-]/g, "_");
    const file = await tempFolder.createFile(`quickai_import_${Date.now()}_${safeName}`, { overwrite: true });
    await file.write(binary, { format: storage.formats.binary });
    return file;
}

// Places a downloaded output file directly into targetDoc as a Smart Object via Place Embedded.
// Video outputs (e.g. Comfy's SaveVideo node) cannot be opened as a normal raster document the way
// images can, but Photoshop's Place Embedded command supports video files natively and creates a
// playable video Smart Object layer, so this path is used for video results instead of the
// open-then-duplicate flow used for images. Caller must set app.activeDocument = targetDoc first.
async function placeOutputFileAsSmartObject(file, targetDoc) {
    const token = await storage.localFileSystem.createSessionToken(file);
    // Unlike images, Place Embedded already wraps a video file in exactly one Smart
    // Object (video content can only exist inside a Smart Object layer in Photoshop),
    // so no follow-up "newPlacedLayer" conversion is needed — doing so would just
    // nest a second, redundant Smart Object shell around the video Smart Object.
    await action.batchPlay([
        {
            _obj: "placeEvent",
            null: { _path: token, _kind: "local" },
            freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
            offset: {
                _obj: "offset",
                horizontal: { _unit: "pixelsUnit", _value: 0 },
                vertical: { _unit: "pixelsUnit", _value: 0 }
            },
            _options: { dialogOptions: "dontDisplay" }
        }
    ], {});
    return targetDoc.activeLayers && targetDoc.activeLayers[0];
}

// Imports downloaded output into Photoshop as a new layer with safe scaling/alignment.
async function importOutputIntoPhotoshop(binary, filename, options = {}) {
    // 1) Save downloaded bytes to temp file and open inside a transient source document.
    const file = await writeBinaryToTempImportFile(binary, filename);
    const targetDocId = options.targetDocId || null;
    const fileExt = String(filename || "").trim().toLowerCase().split(".").pop() || "";
    const isExrImport = fileExt === "exr";
    const isVideoImport = isVideoOutputFilename(filename);

    let importedRef = null;
    await core.executeAsModal(async () => {
        const targetDoc = targetDocId ? getOpenDocumentById(targetDocId, options.targetDocName) : app.activeDocument;
        if (!targetDoc) throw new Error("No active Photoshop document.");
        log(`Generate: importing into document ${targetDoc.name || "<unnamed>"} (id=${targetDoc.id}).`);
        const targetCanvasW = Number(targetDoc.width);
        const targetCanvasH = Number(targetDoc.height);

        let sourceDoc = null;
        try {
            if (isVideoImport) {
                // Video outputs are placed directly as a Smart Object; there is no separate
                // source document to open/duplicate/close the way image outputs use.
                app.activeDocument = targetDoc;
                const placedLayer = await placeOutputFileAsSmartObject(file, targetDoc);
                if (!placedLayer) throw new Error("Could not place downloaded video as Smart Object.");
                targetDoc.activeLayers = [placedLayer];
            } else if (isExrImport) {
                // EXR path: convert EXR layer to Smart Object in source document first,
                // then duplicate that Smart Object into target document to keep it editable.
                sourceDoc = await app.open(file);
                if (!sourceDoc) throw new Error("Could not open downloaded EXR for import.");
                const exrSourceLayer = sourceDoc.activeLayers && sourceDoc.activeLayers[0];
                if (!exrSourceLayer) throw new Error("Downloaded EXR has no layer to import.");

                sourceDoc.activeLayers = [exrSourceLayer];
                await action.batchPlay([
                    { _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }
                ], {});

                const exrSmartLayer = sourceDoc.activeLayers && sourceDoc.activeLayers[0];
                if (!exrSmartLayer) throw new Error("Could not convert EXR to Smart Object before import.");

                const duplicatedSmartLayer = await exrSmartLayer.duplicate(targetDoc);
                app.activeDocument = targetDoc;
                targetDoc.activeLayers = [duplicatedSmartLayer];
            } else {
                sourceDoc = await app.open(file);
                if (!sourceDoc) throw new Error("Could not open downloaded image for import.");

                const sourceLayer = sourceDoc.activeLayers && sourceDoc.activeLayers[0];
                if (!sourceLayer) throw new Error("Downloaded image has no layer to import.");

                sourceDoc.activeLayers = [sourceLayer];
                await action.batchPlay([
                    { _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }
                ], {});

                const sourceSmartLayer = sourceDoc.activeLayers && sourceDoc.activeLayers[0];
                if (!sourceSmartLayer) throw new Error("Could not convert source image to Smart Object before import.");

                const importedSmartLayerFromSource = await sourceSmartLayer.duplicate(targetDoc);
                app.activeDocument = targetDoc;
                targetDoc.activeLayers = [importedSmartLayerFromSource];
            }

            let importedSmartLayer = targetDoc.activeLayers && targetDoc.activeLayers[0];
            if (importedSmartLayer) {
                const shouldFitCanvas = Boolean(settingsState.fitCanvasWholeImageImports);
                if (shouldFitCanvas) {
                    // 2) Fit imported output into current canvas while preserving aspect ratio.
                    const initialBounds = getLayerBoundsPixels(importedSmartLayer);
                    if (
                        initialBounds &&
                        typeof targetCanvasW === "number" &&
                        targetCanvasW > 0 &&
                        typeof targetCanvasH === "number" &&
                        targetCanvasH > 0
                    ) {
                        const layerW = initialBounds.right - initialBounds.left;
                        const layerH = initialBounds.bottom - initialBounds.top;
                        if (layerW > 0 && layerH > 0) {
                            const outputAspect = layerW / layerH;
                            const canvasAspect = targetCanvasW / targetCanvasH;
                            let targetW = layerW;
                            let targetH = layerH;
                            if (outputAspect >= canvasAspect) {
                                targetW = targetCanvasW;
                                targetH = targetW / outputAspect;
                            } else {
                                targetH = targetCanvasH;
                                targetW = targetH * outputAspect;
                            }

                            const scaleX = targetW / layerW;
                            const scaleY = targetH / layerH;
                            const scaleXPercent = scaleX * 100;
                            const scaleYPercent = scaleY * 100;
                            if (
                                Number.isFinite(scaleXPercent) &&
                                Number.isFinite(scaleYPercent) &&
                                (Math.abs(scaleXPercent - 100) >= 0.01 || Math.abs(scaleYPercent - 100) >= 0.01)
                            ) {
                                await importedSmartLayer.scale(scaleXPercent, scaleYPercent);
                            }
                        }
                    }

                    const centeredBounds = getLayerBoundsPixels(importedSmartLayer);
                    if (
                        centeredBounds &&
                        typeof targetCanvasW === "number" &&
                        typeof targetCanvasH === "number"
                    ) {
                        // 3) Center final layer after fit.
                        const finalLayerW = centeredBounds.right - centeredBounds.left;
                        const finalLayerH = centeredBounds.bottom - centeredBounds.top;
                        const dx = ((targetCanvasW - finalLayerW) / 2) - centeredBounds.left;
                        const dy = ((targetCanvasH - finalLayerH) / 2) - centeredBounds.top;
                        if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
                            await importedSmartLayer.translate(dx, dy);
                        }
                    }
                }

                try {
                    importedSmartLayer.name = String(options.layerName || "ComfyUI_Export");
                } catch (_e) {}

                importedSmartLayer = moveLayerToDocumentTop(importedSmartLayer, targetDoc);
                importedRef = { docId: targetDoc.id, layerId: importedSmartLayer.id };
            }
        } finally {
            // 4) Always close transient source doc without save and refocus original target doc.
            if (sourceDoc) {
                try {
                    app.activeDocument = sourceDoc;
                    if (typeof sourceDoc.closeWithoutSaving === "function") {
                        await sourceDoc.closeWithoutSaving();
                    } else {
                        await action.batchPlay([
                            {
                                _obj: "close",
                                saving: { _enum: "yesNo", _value: "no" },
                                _options: { dialogOptions: "dontDisplay" }
                            }
                        ], {});
                    }
                } catch (_e) {}
            }
            try {
                app.activeDocument = targetDoc;
            } catch (_e) {}
        }
    }, { commandName: "QuickAI Import Output" });
    return importedRef;
}

// Duplicates one Smart Object layer as "New Smart Object via Copy" to avoid linked instances.
async function duplicateSmartObjectLayerAsCopy(docId, layerId) {
    let duplicatedLayerId = null;
    await core.executeAsModal(async () => {
        const targetDoc = getOpenDocumentById(docId);
        if (!targetDoc) throw new Error("Target document is not open for Smart Object duplication.");
        const targetLayer = getLayerById(targetDoc, layerId);
        if (!targetLayer) throw new Error("Target Smart Object layer no longer exists for duplication.");
        app.activeDocument = targetDoc;
        targetDoc.activeLayers = [targetLayer];
        const result = await action.batchPlay([
            { _obj: "placedLayerMakeCopy", _options: { dialogOptions: "dontDisplay" } }
        ], {});
        if (result && result[0] && result[0]._obj === "error") {
            throw new Error(result[0].message || "Could not duplicate Smart Object via copy.");
        }
        const duplicatedLayer = targetDoc.activeLayers && targetDoc.activeLayers[0];
        if (!duplicatedLayer) throw new Error("Could not resolve duplicated Smart Object layer.");
        duplicatedLayerId = duplicatedLayer.id;
    }, { commandName: "QuickAI Duplicate Smart Object Mask Host" });
    return { docId, layerId: duplicatedLayerId };
}

// Applies source layer RGB to the target layer mask, mirroring applyMask.jsx behavior in UXP batchPlay.
async function applySourceRGBToTargetMaskInDocument(docId, targetLayerId, sourceLayerId) {
    await core.executeAsModal(async () => {
        const targetDoc = getOpenDocumentById(docId);
        if (!targetDoc) throw new Error("Target document is no longer open.");
        app.activeDocument = targetDoc;
        // 1) Select target layer first.
        const selectLayerResult = await action.batchPlay([
            {
                _obj: "select",
                _target: [{ _ref: "layer", _id: targetLayerId }],
                makeVisible: false,
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        const selectLayerError = Array.isArray(selectLayerResult)
            ? selectLayerResult.find((item) => item && item._obj === "error")
            : null;
        if (selectLayerError) throw new Error(selectLayerError.message || "Could not select target layer for mask apply.");

        // 2) Ensure target has a mask. Avoid channel select commands, since those can
        // trigger "Select is not currently available" dialogs in some host states.
        const hasMaskResult = await action.batchPlay([
            {
                _obj: "get",
                _target: [
                    { _property: "hasUserMask" },
                    { _ref: "layer", _id: targetLayerId },
                    { _ref: "document", _id: docId }
                ],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], { continueOnError: true });
        const hasMask = Boolean(hasMaskResult && hasMaskResult[0] && hasMaskResult[0].hasUserMask);
        if (!hasMask) {
            const makeMaskResult = await action.batchPlay([
                {
                    _obj: "make",
                    new: { _class: "channel" },
                    at: { _ref: "channel", _enum: "channel", _value: "mask" },
                    using: { _enum: "userMaskEnabled", _value: "revealAll" },
                    _options: { dialogOptions: "dontDisplay" }
                }
            ], {});
            const makeMaskError = Array.isArray(makeMaskResult)
                ? makeMaskResult.find((item) => item && item._obj === "error")
                : null;
            if (makeMaskError) throw new Error(makeMaskError.message || "Could not create target layer mask.");
        }

        // 3) Select the target mask channel and apply source RGB, matching JSX behavior.
        const selectMaskTargetResult = await action.batchPlay([
            {
                _obj: "select",
                _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }],
                makeVisible: false,
                _options: { dialogOptions: "dontDisplay" }
            }
        ], { continueOnError: true });
        const selectMaskTargetError = Array.isArray(selectMaskTargetResult)
            ? selectMaskTargetResult.find((item) => item && item._obj === "error")
            : null;
        if (selectMaskTargetError) throw new Error(selectMaskTargetError.message || "Could not target layer mask channel.");

        const applyResult = await action.batchPlay([
            {
                _obj: "applyImageEvent",
                with: {
                    _obj: "calculation",
                    to: {
                        _ref: [
                            { _ref: "channel", _enum: "channel", _value: "RGB" },
                            { _ref: "layer", _id: sourceLayerId }
                        ]
                    },
                    calculation: { _enum: "calculationType", _value: "normal" },
                    opacity: { _unit: "percentUnit", _value: 100 }
                },
                _options: { dialogOptions: "dontDisplay" }
            },
            // 4) Force output mask feather to 0 px as requested.
            {
                _obj: "set",
                _target: [
                    { _ref: "layer", _id: targetLayerId },
                    { _ref: "document", _id: docId }
                ],
                to: {
                    _obj: "layer",
                    userMaskFeather: { _unit: "pixelsUnit", _value: 0 }
                },
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        const descriptorError = Array.isArray(applyResult)
            ? applyResult.find((item) => item && item._obj === "error")
            : null;
        if (descriptorError) throw new Error(descriptorError.message || "Could not apply source RGB to target mask.");
    }, { commandName: "QuickAI Apply RGB Mask" });
}

// Deletes one layer by id from a document; used to remove temporary export_mask layers.
async function deleteLayerById(docId, layerId) {
    await core.executeAsModal(async () => {
        const targetDoc = getOpenDocumentById(docId);
        if (!targetDoc) return;
        const targetLayer = getLayerById(targetDoc, layerId);
        if (!targetLayer) return;
        app.activeDocument = targetDoc;
        targetDoc.activeLayers = [targetLayer];
        await action.batchPlay([
            {
                _obj: "delete",
                _target: [{ _ref: "layer", _id: layerId }],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
    }, { commandName: "QuickAI Delete Temporary Mask Layer" });
}

// Imports output into the active Smart Object document at 1:1 scale.
// options.growCanvasToKeepResolution: when the output is larger than the Smart Object canvas,
// enlarge the canvas (and the hidden layers already in it) instead of shrinking the output, so
// the output is kept at full resolution. The fit and centering rules stay the same. The caller
// must then scale the Smart Object layer back to its original size in the parent document
// (see restoreSmartObjectPlacement); debugInfo.canvasGrown reports when this happened.
async function importOutputIntoActiveDocumentWithoutScaling(binary, filename, options = {}) {
    const targetDoc = app.activeDocument;
    if (!targetDoc) throw new Error("No active Photoshop document.");
    const file = await writeBinaryToTempImportFile(binary, filename);
    const fileExt = String(filename || "").trim().toLowerCase().split(".").pop() || "";
    const isExrImport = fileExt === "exr";
    const isVideoImport = isVideoOutputFilename(filename);
    const targetResolution = Number(targetDoc.resolution) || 72;
    const targetCanvasW = Number(targetDoc.width);
    const targetCanvasH = Number(targetDoc.height);
    let debugInfo = null;
    let canvasGrown = null;

    await core.executeAsModal(async () => {
        let sourceDoc = null;
        try {
            // Hide existing Smart Object content before inserting Comfy output.
            const existingLayers = collectAllLayers(targetDoc);
            for (let i = 0; i < existingLayers.length; i += 1) {
                const layer = existingLayers[i];
                try {
                    layer.visible = false;
                } catch (_e) {}
            }

            if (isVideoImport) {
                // Video outputs are placed directly as a Smart Object (no source doc to open/resize),
                // then fit and centered in the current Smart Object canvas like any other output.
                app.activeDocument = targetDoc;
                const placedLayer = await placeOutputFileAsSmartObject(file, targetDoc);
                if (!placedLayer) throw new Error("Could not place downloaded video as Smart Object.");
                targetDoc.activeLayers = [placedLayer];
                try { placedLayer.visible = true; } catch (_e) {}

                let fitMode = "none";
                let appliedWidthScale = 1;
                let appliedHeightScale = 1;
                const initialBounds = getLayerBoundsPixels(placedLayer);
                let expectedW = initialBounds ? (initialBounds.right - initialBounds.left) : 0;
                let expectedH = initialBounds ? (initialBounds.bottom - initialBounds.top) : 0;
                if (
                    expectedW > 0 && expectedH > 0 &&
                    typeof targetCanvasW === "number" && targetCanvasW > 0 &&
                    typeof targetCanvasH === "number" && targetCanvasH > 0
                ) {
                    const outputAspect = expectedW / expectedH;
                    const canvasAspect = targetCanvasW / targetCanvasH;
                    let newW; let newH;
                    if (outputAspect >= canvasAspect) {
                        fitMode = "fit_width";
                        newW = targetCanvasW;
                        newH = newW / outputAspect;
                    } else {
                        fitMode = "fit_height";
                        newH = targetCanvasH;
                        newW = newH * outputAspect;
                    }
                    appliedWidthScale = newW / expectedW;
                    appliedHeightScale = newH / expectedH;
                    const scaleXPercent = appliedWidthScale * 100;
                    const scaleYPercent = appliedHeightScale * 100;
                    if (
                        Number.isFinite(scaleXPercent) &&
                        Number.isFinite(scaleYPercent) &&
                        (Math.abs(scaleXPercent - 100) >= 0.01 || Math.abs(scaleYPercent - 100) >= 0.01)
                    ) {
                        await placedLayer.scale(scaleXPercent, scaleYPercent);
                    }
                }

                const docW = Number(targetDoc.width);
                const docH = Number(targetDoc.height);
                const b = getLayerBoundsPixels(placedLayer);
                if (typeof docW === "number" && typeof docH === "number" && b) {
                    const layerW = b.right - b.left;
                    const layerH = b.bottom - b.top;
                    const dx = ((docW - layerW) / 2) - b.left;
                    const dy = ((docH - layerH) / 2) - b.top;
                    if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
                        await placedLayer.translate(dx, dy);
                    }
                    debugInfo = {
                        srcW: expectedW,
                        srcH: expectedH,
                        canvasW: docW,
                        canvasH: docH,
                        fitMode,
                        appliedWidthScale,
                        appliedHeightScale,
                        finalLayerW: layerW,
                        finalLayerH: layerH
                    };
                }
                return;
            }

            sourceDoc = await app.open(file);
            if (!sourceDoc) throw new Error("Could not open downloaded image for import.");
            const sourceResolution = Number(sourceDoc.resolution) || 72;
            if (Math.abs(sourceResolution - targetResolution) > 0.001) {
                // Normalize resolution metadata first so duplicate-to-doc does not preserve physical size.
                await sourceDoc.resizeImage(sourceDoc.width, sourceDoc.height, targetResolution);
            }
            let expectedW = Number(sourceDoc.width);
            let expectedH = Number(sourceDoc.height);

            let appliedWidthScale = 1;
            let appliedHeightScale = 1;
            let fitMode = "none";
            if (
                typeof expectedW === "number" &&
                expectedW > 0 &&
                typeof expectedH === "number" &&
                expectedH > 0 &&
                typeof targetCanvasW === "number" &&
                targetCanvasW > 0 &&
                typeof targetCanvasH === "number" &&
                targetCanvasH > 0
            ) {
                // Fit result into Smart Object canvas while preserving aspect ratio.
                const outputAspect = expectedW / expectedH;
                const canvasAspect = targetCanvasW / targetCanvasH;

                let newW;
                let newH;
                if (outputAspect >= canvasAspect) {
                    // Output aspect is wider/same: match width to Smart Object width.
                    fitMode = "fit_width";
                    newW = targetCanvasW;
                    newH = newW / outputAspect;
                } else {
                    // Output aspect is taller: match height to Smart Object height.
                    fitMode = "fit_height";
                    newH = targetCanvasH;
                    newW = newH * outputAspect;
                }
                appliedWidthScale = newW / expectedW;
                appliedHeightScale = newH / expectedH;

                if (options.growCanvasToKeepResolution && appliedWidthScale < 1) {
                    // Keep the output at full resolution: instead of shrinking it to the canvas,
                    // enlarge the canvas by the inverse of the fit scale, so the output fits the
                    // grown canvas exactly the way its shrunk copy fit the old one (same fit side,
                    // same centered transparent border). Never smaller than the output itself.
                    const grownW = Math.max(expectedW, Math.round(targetCanvasW / appliedWidthScale));
                    const grownH = Math.max(expectedH, Math.round(targetCanvasH / appliedWidthScale));
                    app.activeDocument = targetDoc;
                    await targetDoc.resizeImage(grownW, grownH);
                    app.activeDocument = sourceDoc;
                    canvasGrown = { fromW: targetCanvasW, fromH: targetCanvasH, toW: grownW, toH: grownH };
                    fitMode = `${fitMode}_full_resolution`;
                    appliedWidthScale = 1;
                    appliedHeightScale = 1;
                } else {
                    await sourceDoc.resizeImage(newW, newH);
                }

                expectedW = Number(sourceDoc.width);
                expectedH = Number(sourceDoc.height);
            }

            const sourceLayer = sourceDoc.activeLayers && sourceDoc.activeLayers[0];
            if (!sourceLayer) throw new Error("Downloaded image has no layer to import.");

            let duplicated = null;
            if (isExrImport) {
                // EXR-only crop path: convert to Smart Object in source doc first to preserve EXR precision.
                sourceDoc.activeLayers = [sourceLayer];
                await action.batchPlay([
                    { _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }
                ], {});
                const sourceSmartLayer = sourceDoc.activeLayers && sourceDoc.activeLayers[0];
                if (!sourceSmartLayer) throw new Error("Could not convert EXR crop source to Smart Object.");
                duplicated = await sourceSmartLayer.duplicate(targetDoc);
            } else {
                // Keep existing non-EXR behavior unchanged.
                duplicated = await sourceLayer.duplicate(targetDoc);
            }
            try {
                duplicated.visible = true;
            } catch (_e) {}
            app.activeDocument = targetDoc;
            targetDoc.activeLayers = [duplicated];

            // Keep pixel dimensions exactly as generated by Comfy, only move to canvas center.
            const docW = Number(targetDoc.width);
            const docH = Number(targetDoc.height);
            const b = getLayerBoundsPixels(duplicated);
            if (typeof docW === "number" && typeof docH === "number" && b) {
                // Keep pixel size and only center imported layer in current Smart Object canvas.
                const layerW = b.right - b.left;
                const layerH = b.bottom - b.top;
                const dx = ((docW - layerW) / 2) - b.left;
                const dy = ((docH - layerH) / 2) - b.top;
                if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
                    await duplicated.translate(dx, dy);
                }
                debugInfo = {
                    srcW: expectedW,
                    srcH: expectedH,
                    canvasW: docW,
                    canvasH: docH,
                    fitMode,
                    appliedWidthScale,
                    appliedHeightScale,
                    finalLayerW: layerW,
                    finalLayerH: layerH,
                    canvasGrown
                };
            }
        } finally {
            if (sourceDoc) {
                try {
                    app.activeDocument = sourceDoc;
                    await action.batchPlay([
                        {
                            _obj: "close",
                            saving: { _enum: "yesNo", _value: "no" },
                            _options: { dialogOptions: "dontDisplay" }
                        }
                    ], {});
                } catch (_e) {}
            }
            try {
                app.activeDocument = targetDoc;
            } catch (_e) {}
        }
    }, { commandName: "QuickAI Import Output 1:1" });

    // Report canvas growth even if the layer bounds could not be read for the debug details,
    // because the caller must restore the Smart Object's placement whenever the canvas grew.
    if (!debugInfo && canvasGrown) return { canvasGrown };
    return debugInfo;
}

// Reads where a Smart Object layer's content is placed in its document, from the placed layer's
// own transform (smartObjectMore.transform: the four content corners, clockwise from top-left).
// Unlike layer bounds this ignores masks and transparency, so it is the true placement box.
// Returns { left, top, right, bottom, axisAligned } or null when it cannot be read.
async function getSmartObjectPlacementBox(docId, layerId) {
    try {
        const result = await action.batchPlay([
            {
                _obj: "get",
                _target: [
                    { _property: "smartObjectMore" },
                    { _ref: "layer", _id: layerId },
                    { _ref: "document", _id: docId }
                ],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        const quad = result && result[0] && result[0].smartObjectMore && result[0].smartObjectMore.transform;
        if (!Array.isArray(quad) || quad.length < 8 || quad.some((v) => !Number.isFinite(Number(v)))) return null;
        const [x1, y1, x2, y2, x3, y3, x4, y4] = quad.map(Number);
        // Axis-aligned (only moved/scaled, not rotated, skewed or warped): top edge horizontal,
        // left edge vertical, opposite corners matching.
        const tolerance = 0.01;
        const axisAligned = Math.abs(y1 - y2) < tolerance && Math.abs(x2 - x3) < tolerance
            && Math.abs(y3 - y4) < tolerance && Math.abs(x4 - x1) < tolerance;
        return {
            left: Math.min(x1, x2, x3, x4),
            top: Math.min(y1, y2, y3, y4),
            right: Math.max(x1, x2, x3, x4),
            bottom: Math.max(y1, y2, y3, y4),
            axisAligned
        };
    } catch (_e) {
        return null;
    }
}

// Scales and moves a Smart Object layer so its placement box matches `targetBox` again, after its
// contents changed size (Photoshop keeps the layer's scale percentage when contents grow, so the
// layer gets bigger on the canvas). The layer mask is temporarily unlinked so the transform moves
// only the content and the mask stays exactly where it was. Any active selection in the document
// is set aside for the transform (with a selection active, scale/move act on the selection rather
// than the whole layer) and restored afterwards. Returns true when it ends within half a pixel of
// `targetBox`.
async function restoreSmartObjectPlacement(docId, layerId, targetBox) {
    if (!targetBox) return false;
    let userSelectionSnapshot = null;
    try {
        userSelectionSnapshot = await captureSelectionSnapshotInDocument(docId);
        if (userSelectionSnapshot) await clearSelectionInDocument(docId);
    } catch (error) {
        log(`Get: could not set aside the current selection (${describeError(error)}).`);
    }
    try {
        return await transformSmartObjectToPlacement(docId, layerId, targetBox);
    } finally {
        if (userSelectionSnapshot) {
            try {
                await restoreSelectionSnapshotInDocument(docId, userSelectionSnapshot);
            } catch (error) {
                log(`Get: could not restore the previous selection (${describeError(error)}).`);
            }
        }
    }
}

// The transform part of restoreSmartObjectPlacement; expects no active selection.
async function transformSmartObjectToPlacement(docId, layerId, targetBox) {
    const targetW = targetBox.right - targetBox.left;
    const targetH = targetBox.bottom - targetBox.top;
    if (!(targetW > 0 && targetH > 0)) return false;
    let restored = false;
    await core.executeAsModal(async () => {
        const doc = getOpenDocumentById(docId);
        const layer = doc ? getLayerById(doc, layerId) : null;
        if (!doc || !layer) throw new Error("Smart Object layer to restore is no longer available.");
        app.activeDocument = doc;
        doc.activeLayers = [layer];

        // Unlink the mask (if there is one and it is linked) for the duration of the transform.
        let relinkMask = false;
        try {
            const maskInfo = await action.batchPlay([
                {
                    _obj: "get",
                    _target: [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }],
                    _options: { dialogOptions: "dontDisplay" }
                }
            ], {});
            const descriptor = maskInfo && maskInfo[0];
            if (descriptor && descriptor.hasUserMask && descriptor.userMaskLinked !== false) {
                await action.batchPlay([
                    {
                        _obj: "set",
                        _target: [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }],
                        to: { _obj: "layer", userMaskLinked: false },
                        _options: { dialogOptions: "dontDisplay" }
                    }
                ], {});
                relinkMask = true;
            }
        } catch (error) {
            log(`Get: could not unlink the Smart Object mask before resizing (${describeError(error)}).`);
        }

        try {
            // Target the layer's content, not its mask. With the mask unlinked, Photoshop applies
            // scale/move to whichever part of the layer is targeted; if the mask is targeted
            // (it is right after it was created or edited), only the mask would be transformed.
            // Selecting the composite channel targets the content. The composite channel's name
            // depends on the color mode, so try each until one is accepted.
            let contentTargeted = false;
            for (const compositeChannel of ["RGB", "CMYK", "lab", "gray"]) {
                const selectResult = await action.batchPlay([
                    {
                        _obj: "select",
                        _target: [{ _ref: "channel", _enum: "channel", _value: compositeChannel }],
                        makeVisible: false,
                        _options: { dialogOptions: "dontDisplay" }
                    }
                ], { continueOnError: true });
                if (!(selectResult && selectResult[0] && selectResult[0]._obj === "error")) {
                    contentTargeted = true;
                    break;
                }
            }
            if (!contentTargeted) {
                throw new Error("Could not target the Smart Object's content (only its mask would have been resized).");
            }

            const current = await getSmartObjectPlacementBox(docId, layerId);
            if (!current) throw new Error("Could not read the Smart Object placement after updating it.");
            const currentW = current.right - current.left;
            const currentH = current.bottom - current.top;
            const scaleX = (targetW / currentW) * 100;
            const scaleY = (targetH / currentH) * 100;
            if (Math.abs(scaleX - 100) >= 0.01 || Math.abs(scaleY - 100) >= 0.01) {
                await layer.scale(scaleX, scaleY, constants.AnchorPosition.TOPLEFT);
            }
            // Move the top-left corner back; a second pass absorbs any rounding drift.
            for (let pass = 0; pass < 2; pass += 1) {
                const placed = await getSmartObjectPlacementBox(docId, layerId);
                if (!placed) break;
                const dx = targetBox.left - placed.left;
                const dy = targetBox.top - placed.top;
                if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) break;
                await layer.translate(dx, dy);
            }
            const finalBox = await getSmartObjectPlacementBox(docId, layerId);
            if (finalBox) {
                restored = Math.abs(finalBox.left - targetBox.left) < 0.5 && Math.abs(finalBox.top - targetBox.top) < 0.5
                    && Math.abs(finalBox.right - targetBox.right) < 0.5 && Math.abs(finalBox.bottom - targetBox.bottom) < 0.5;
                log(
                    `Get: Smart Object placement restored to (${finalBox.left.toFixed(1)},${finalBox.top.toFixed(1)}) `
                    + `${(finalBox.right - finalBox.left).toFixed(1)}x${(finalBox.bottom - finalBox.top).toFixed(1)} `
                    + `(target ${targetBox.left.toFixed(1)},${targetBox.top.toFixed(1)} ${targetW.toFixed(1)}x${targetH.toFixed(1)}).`
                );
            }
        } finally {
            if (relinkMask) {
                try {
                    await action.batchPlay([
                        {
                            _obj: "set",
                            _target: [{ _ref: "layer", _id: layerId }, { _ref: "document", _id: docId }],
                            to: { _obj: "layer", userMaskLinked: true },
                            _options: { dialogOptions: "dontDisplay" }
                        }
                    ], {});
                } catch (error) {
                    log(`Get: could not relink the Smart Object mask (${describeError(error)}).`);
                }
            }
        }
    }, { commandName: "QuickAI Restore Smart Object Size" });
    return restored;
}

// Opens the currently selected Smart Object layer for edit-in-place.
async function openSelectedSmartObjectForEdit() {
    if (!app.activeDocument) throw new Error("No active Photoshop document.");
    const activeLayer = app.activeDocument.activeLayers && app.activeDocument.activeLayers[0];
    if (!activeLayer) throw new Error("No selected layer in Photoshop.");

    await core.executeAsModal(async () => {
        const checkResult = await action.batchPlay([
            {
                _obj: "get",
                _target: [
                    { _property: "smartObject" },
                    { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                    { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
                ],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], { continueOnError: true });
        const smartObjectInfo = checkResult && checkResult[0] && checkResult[0].smartObject;
        if (!smartObjectInfo) {
            throw new Error("Selected layer is not a Smart Object.");
        }

        const openResult = await action.batchPlay([
            {
                _obj: "placedLayerEditContents",
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        if (openResult && openResult[0] && openResult[0]._obj === "error") {
            throw new Error(openResult[0].message || "Could not open selected Smart Object.");
        }
    }, { commandName: "QuickAI Open Smart Object" });
}

// Opens a specific Smart Object layer by doc/layer ids through batchPlay.
async function openSmartObjectLayerForEdit(docId, layerId) {
    const docIdNumber = toActionTargetIdNumber(docId, "docId");
    const layerIdNumber = toActionTargetIdNumber(layerId, "layerId");
    const targetDoc = getOpenDocumentById(docIdNumber);
    if (!targetDoc) throw new Error("Stored crop Smart Object document is no longer available.");
    const targetLayer = getLayerById(targetDoc, layerIdNumber);
    if (!targetLayer) throw new Error("Stored crop Smart Object layer is no longer available.");
    await core.executeAsModal(async () => {
        // Force target doc/layer selection through Action Manager so we do not depend on UI selection state.
        await action.batchPlay([
            {
                _obj: "select",
                _target: [{ _ref: "layer", _id: layerIdNumber }, { _ref: "document", _id: docIdNumber }],
                makeVisible: false,
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});

        // Verify selected target is a Smart Object before opening.
        const getResult = await action.batchPlay([
            {
                _obj: "get",
                _target: [
                    { _property: "smartObject" },
                    { _ref: "layer", _id: layerIdNumber },
                    { _ref: "document", _id: docIdNumber }
                ],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        const smartObjectInfo = getResult && getResult[0] && getResult[0].smartObject;
        if (!smartObjectInfo) {
            throw new Error("Stored crop target layer is not a Smart Object.");
        }

        const openResult = await action.batchPlay([
            {
                _obj: "placedLayerEditContents",
                _target: [{ _ref: "layer", _id: layerIdNumber }, { _ref: "document", _id: docIdNumber }],
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        if (openResult && openResult[0] && openResult[0]._obj === "error") {
            throw new Error(openResult[0].message || "Could not open stored crop Smart Object.");
        }
    }, { commandName: "QuickAI Open Stored Crop Smart Object" });
}

// Commits Smart Object edits by saving and closing the active document.
async function saveAndCloseActiveDocument() {
    await core.executeAsModal(async () => {
        const result = await action.batchPlay([
            { _obj: "save", _options: { dialogOptions: "dontDisplay" } },
            {
                _obj: "close",
                saving: { _enum: "yesNo", _value: "no" },
                _options: { dialogOptions: "dontDisplay" }
            }
        ], {});
        if (result && result[0] && result[0]._obj === "error") {
            throw new Error(result[0].message || "Could not save Smart Object document.");
        }
        if (result && result[1] && result[1]._obj === "error") {
            throw new Error(result[1].message || "Could not close Smart Object document.");
        }
    }, { commandName: "QuickAI Save and Close Smart Object" });
}

// Updates send buttons disabled.
function setSendButtonsDisabled(disabled) {
    if (bridgeSendBtn) bridgeSendBtn.disabled = disabled;
    if (bridgeSendModeSelect) bridgeSendModeSelect.disabled = disabled;
}

// Updates get buttons disabled.
function setGetButtonsDisabled(disabled) {
    if (bridgeGetBtn) bridgeGetBtn.disabled = disabled;
    if (bridgeGetModeSelect) bridgeGetModeSelect.disabled = disabled;
}

// Primary send pipeline: export image, upload to Comfy, optional crop-SO prep, and bridge apply request.
// croppedToSelection requests a crop-to-selection send, but falls back to sending the whole
// canvas/layer when no selection is active rather than failing — see effectiveCropped below.
async function sendToComfy({ selectedLayerOnly = false, layerAndBelow = false, croppedToSelection = false } = {}) {
    setSendButtonsDisabled(true);
    // Timing breakdown to diagnose where a slow send is actually spending time (export vs.
    // upload vs. apply), since these have very different fixes.
    const sendStartMs = Date.now();
    let exportDoneMs = null;
    let uploadDoneMs = null;
    let uploadedName = "";
    let cropSelectionBounds = null;
    let cropPlacementBounds = null;
    let initialSelectionDocId = null;
    let initialSelectionBounds = null;
    let initialSelectionSnapshot = null;
    let effectiveCropped = false;
    try {
        // 0) Check the Comfy side first: without a selected Load Image node the upload would
        // land nowhere, so stop before exporting, uploading or placing the crop placeholder.
        const loadImageSelection = await checkComfyLoadImageSelection();
        if (loadImageSelection === "none") {
            showPanelToast(`Please select a Load Image node on Comfy (${comfyServerLabel()})`, "error");
            log("Send stopped: no LoadImage/LoadImageMask node is selected in Comfy. Nothing was uploaded.");
            return;
        }
        if (loadImageSelection === "no_tab") {
            showPanelToast(`No ComfyUI tab connected (${comfyServerLabel()}). Is the ComfyUI tab open?`, "error");
            log("Send stopped: no ComfyUI browser tab with the QuickAI extension is connected. Nothing was uploaded.");
            return;
        }
        const startingDoc = app.activeDocument;
        if (startingDoc) {
            initialSelectionDocId = startingDoc.id;
            initialSelectionBounds = await getActiveSelectionBounds(startingDoc.id);
            if (initialSelectionBounds) {
                try {
                    initialSelectionSnapshot = await captureSelectionSnapshotInDocument(startingDoc.id);
                } catch (_e) {
                    // Keep bounds fallback if channel snapshot fails in current host state.
                }
            }
        }
        // 1) Resolve crop bounds up front. If a cropped send was requested but no selection is
        // active, fall back to sending the whole canvas/layer instead of failing.
        if (croppedToSelection) {
            const activeDoc = app.activeDocument;
            if (!activeDoc) throw new Error("No active Photoshop document.");
            cropSelectionBounds = initialSelectionDocId === activeDoc.id
                ? initialSelectionBounds
                : await getActiveSelectionBounds(activeDoc.id);
            if (cropSelectionBounds) {
                effectiveCropped = true;
                cropPlacementBounds = getExpandedSelectionBoundsForCrop(cropSelectionBounds, activeDoc, getCropExpandPxForBounds(cropSelectionBounds));
            } else {
                const wholeLabel = layerAndBelow ? "selected layer and below" : (selectedLayerOnly ? "layer" : "canvas");
                log(`No active selection found — sending the whole ${wholeLabel} instead.`);
            }
        }

        // 2) Export source image from Photoshop according to selected mode.
        const exportBaseSnapshot = () => {
            if (layerAndBelow) return exportSelectedLayerAndBelowSnapshotToTempFolder({ cropToSelection: false });
            if (selectedLayerOnly) return exportSelectedLayerSnapshotToTempFolder({ cropToSelection: false });
            return exportSnapshotToTempFolder({ respectSelection: false, cropToSelection: false });
        };
        if (effectiveCropped) {
            if (layerAndBelow) {
                log("Saving cropped selected layer and below from active selection to temp folder (%TEMP%/QuickAI)...");
            } else if (selectedLayerOnly) {
                log("Saving cropped selected layer from active selection to temp folder (%TEMP%/QuickAI)...");
            } else {
                log("Saving cropped current view from active selection to temp folder (%TEMP%/QuickAI)...");
            }
        } else if (layerAndBelow) {
            log("Saving selected layer and below to temp folder (%TEMP%/QuickAI)...");
        } else if (selectedLayerOnly) {
            log("Saving selected Photoshop layer to temp folder (%TEMP%/QuickAI)...");
        } else {
            log("Saving full Photoshop image to temp folder (%TEMP%/QuickAI)...");
        }
        let file;
        if (effectiveCropped) {
            // Crop optimization: export once, then crop from a flattened temp snapshot
            // to avoid repeated heavy crop/history operations on the live PSD.
            const cropBoundsForExport = cropPlacementBounds || cropSelectionBounds;
            if (!cropBoundsForExport) {
                throw new Error("No crop bounds available for cropped send.");
            }
            const baseSnapshotFile = await exportBaseSnapshot();
            file = await exportAutoRunCropSegmentFromBaseSnapshot(baseSnapshotFile, cropBoundsForExport, {
                fileName: buildSnapshotFileName()
            });
        } else {
            file = await exportBaseSnapshot();
        }
        exportDoneMs = Date.now();
        log(`Saved local image: ${file.name} (export took ${((exportDoneMs - sendStartMs) / 1000).toFixed(1)}s)`);

        // 3) Upload image to Comfy input storage.
        log(`Uploading to ${comfyBaseUrl()}/upload/image ...`);
        uploadedName = await uploadImageToComfy(file);
        uploadDoneMs = Date.now();
        log(`Uploaded image as: ${uploadedName} (upload took ${((uploadDoneMs - exportDoneMs) / 1000).toFixed(1)}s)`);

        if (effectiveCropped) {
            // 4) In cropped mode, place crop Smart Object placeholder for later output replacement.
            await placeSnapshotAsSmartObject(file, {
                selectionBounds: cropPlacementBounds || cropSelectionBounds,
                maskSelectionBounds: cropPlacementBounds || cropSelectionBounds,
                layerName: "QuickAI_Crop"
            });
            log("Placed cropped snapshot as Smart Object in Photoshop for later replacement.");
        }

        // 5) Ask quickai bridge to apply the uploaded filename to selected Comfy nodes.
        const applyRequestId = await requestApplyToSelectedLoadImage(uploadedName);
        log("Requested apply to selected LoadImage node(s) in Comfy.");
        // Wait for the ComfyUI tab to confirm, so the user knows whether the image landed.
        const applyResult = await waitForComfyApplyResult(applyRequestId);
        if (applyResult.status === "applied") {
            const nodes = (applyResult.node_ids || []).join(", ");
            showPanelToast(`Applied to node ${nodes}`, "success");
            log(`Comfy applied ${uploadedName} to node ${nodes}.`);
        } else if (applyResult.status === "no_node") {
            showPanelToast(`Please select a Load Image node on Comfy (${comfyServerLabel()})`, "error");
            log("Comfy received the image but no LoadImage/LoadImageMask node was selected.");
        } else if (applyResult.status === "error") {
            showPanelToast(`Failed to apply image on Comfy (${comfyServerLabel()}): ${applyResult.message || "unknown error"}`, "error");
            log(`Comfy failed to apply ${uploadedName}: ${applyResult.message || "unknown error"}`);
        } else {
            showPanelToast(`No response from Comfy (${comfyServerLabel()}). Is the ComfyUI tab open?`, "error");
            log("No apply confirmation from Comfy (is the ComfyUI browser tab open with the QuickAI extension loaded?).");
        }
        await notifyComfyTransferEvent({
            direction: "send",
            status: "success",
            message: effectiveCropped
                ? `${layerAndBelow ? "Cropped selected layer and below" : (selectedLayerOnly ? "Cropped selected layer" : "Cropped current view")} sent from Photoshop and queued for LoadImage apply.`
                : `${layerAndBelow ? "Selected layer and below" : (selectedLayerOnly ? "Selected layer" : "Image")} sent from Photoshop and queued for LoadImage apply.`,
            filename: uploadedName
        });
        const totalSec = ((Date.now() - sendStartMs) / 1000).toFixed(1);
        const applySec = uploadDoneMs !== null ? ((Date.now() - uploadDoneMs) / 1000).toFixed(1) : "?";
        log(`Send timing: export ${((exportDoneMs - sendStartMs) / 1000).toFixed(1)}s, upload ${((uploadDoneMs - exportDoneMs) / 1000).toFixed(1)}s, apply ${applySec}s, total ${totalSec}s.`);
    } catch (error) {
        const detail = normalizePluginError(describeError(error));
        log(`Error: ${detail}`);
        showPanelToast(`Send to Comfy (${comfyServerLabel()}) failed: ${detail}`, "error");
        await notifyComfyTransferEvent({
            direction: "send",
            status: "error",
            message: detail,
            filename: uploadedName
        });
    } finally {
        // Preserve user selection after bridge sends; some Photoshop operations can implicitly clear it.
        if (initialSelectionDocId !== null && initialSelectionDocId !== undefined) {
            try {
                if (initialSelectionSnapshot) {
                    await restoreSelectionSnapshotInDocument(initialSelectionDocId, initialSelectionSnapshot);
                } else if (initialSelectionBounds) {
                    const hasSelectionNow = await getActiveSelectionBounds(initialSelectionDocId);
                    if (!hasSelectionNow) {
                        await selectRectangleSelectionInDocument(initialSelectionDocId, initialSelectionBounds);
                    }
                }
            } catch (_e) {}
        }
        setSendButtonsDisabled(false);
    }
}

// Maps the Bridge Send dropdown value to sendToComfy() options. Every Bridge send is cropped to
// the active selection when one exists, same as the three buttons this replaced.
const BRIDGE_SEND_MODE_OPTIONS = {
    canvas: { selectedLayerOnly: false, croppedToSelection: true },
    layer: { selectedLayerOnly: true, croppedToSelection: true },
    layerAndBelow: { layerAndBelow: true, croppedToSelection: true }
};

if (bridgeSendModeSelect) {
    try {
        const savedMode = localStorage.getItem(BRIDGE_SEND_MODE_STORAGE_KEY);
        if (savedMode && BRIDGE_SEND_MODE_OPTIONS[savedMode]) bridgeSendModeSelect.value = savedMode;
    } catch (_e) {
        // Storage unavailable; keep the default (Current Canvas).
    }
    bridgeSendModeSelect.addEventListener("change", () => {
        try {
            localStorage.setItem(BRIDGE_SEND_MODE_STORAGE_KEY, String(bridgeSendModeSelect.value || "canvas"));
        } catch (_e) {}
    });
}

if (bridgeSendBtn) {
    bridgeSendBtn.onclick = async () => {
        const mode = String(bridgeSendModeSelect?.value || "canvas");
        await sendToComfy(BRIDGE_SEND_MODE_OPTIONS[mode] || BRIDGE_SEND_MODE_OPTIONS.canvas);
    };
}

// Get: downloads the selected Comfy output and imports it as a new layer.
async function getFromComfyAsNewLayer() {
    setGetButtonsDisabled(true);
    let selectedFilename = "";
    try {
        log("Reading selected output from Comfy bridge...");
        const info = await getSelectedOutputFromComfyBridge();
        selectedFilename = info.filename;

        log(`Downloading output ${info.filename} from ${comfyBaseUrl()} ...`);
        const binary = await downloadComfyOutput(info.filename, info.subfolder, info.type);

        log("Importing output into Photoshop...");
        await importOutputIntoPhotoshop(binary, info.filename, {
            layerName: buildOutputLayerNameFromFilename(info.filename)
        });
        log("Imported output as a new layer.");
        await notifyComfyTransferEvent({
            direction: "download",
            status: "success",
            message: "Selected output was downloaded and imported in Photoshop.",
            filename: info.filename
        });
    } catch (error) {
        const detail = normalizePluginError(describeError(error));
        log(`Error: ${detail}`);
        if (error && error.qcNoSelectedOutput) {
            showPanelToast(`Please select a Save Image node (${comfyServerLabel()})`, "error");
        } else {
            showPanelToast(`Get from Comfy failed: ${detail}`, "error", 6000);
        }
        await notifyComfyTransferEvent({
            direction: "download",
            status: "error",
            message: detail,
            filename: selectedFilename
        });
    } finally {
        setGetButtonsDisabled(false);
    }
}

// Pre-check for Get: throws a clear error unless the active document's selected layer is a Smart
// Object. Runs before anything is downloaded, so a wrong selection fails immediately instead of
// after downloading a possibly large output. (openSelectedSmartObjectForEdit checks again later,
// in case the selection changes while the output downloads.)
async function assertSelectedLayerIsSmartObject() {
    const doc = app.activeDocument;
    if (!doc) throw new Error("No open Photoshop document. Select the Smart Object to update first.");
    const layer = doc.activeLayers && doc.activeLayers[0];
    if (!layer) throw new Error("No layer selected. Select the Smart Object to update first.");
    const result = await action.batchPlay([
        {
            _obj: "get",
            _target: [
                { _property: "smartObject" },
                { _ref: "layer", _id: layer.id },
                { _ref: "document", _id: doc.id }
            ],
            _options: { dialogOptions: "dontDisplay" }
        }
    ], { continueOnError: true });
    if (!(result && result[0] && result[0].smartObject)) {
        throw new Error(`The selected layer "${layer.name}" is not a Smart Object. Select the Smart Object to update first.`);
    }
    return layer;
}

// Asks the user to confirm before Get edits the selected Smart Object, so it is clear that its
// contents are about to change. Resolves true on Accept, false on Cancel.
function confirmBridgeGetIntoSmartObject(layerName) {
    // Lined up with the Bridge card the Get button lives in.
    return showPanelConfirm(`Update Smart Object "${layerName}" with the Comfy output?`, { alignTo: bridgeCard });
}

// Get: downloads the selected Comfy output into the selected Smart Object and commits it.
async function getFromComfyIntoSelectedSmartObject() {
    setGetButtonsDisabled(true);
    let selectedFilename = "";
    let targetSmartObjectRef = null;
    try {
        // Check the Photoshop side first; it is instant, while the download below can take a while.
        const selectedSmartObjectLayer = await assertSelectedLayerIsSmartObject();
        // Then make sure the user knows this Smart Object is about to be edited.
        if (!(await confirmBridgeGetIntoSmartObject(selectedSmartObjectLayer.name))) {
            log("Get to Smart Object cancelled; nothing was changed.");
            return;
        }

        log("Reading selected output from Comfy bridge...");
        const info = await getSelectedOutputFromComfyBridge();
        selectedFilename = info.filename;

        log(`Downloading output ${info.filename} from ${comfyBaseUrl()} ...`);
        const binary = await downloadComfyOutput(info.filename, info.subfolder, info.type);

        const selectedDoc = app.activeDocument;
        const selectedLayer = selectedDoc && selectedDoc.activeLayers && selectedDoc.activeLayers[0];
        if (selectedDoc && selectedLayer && selectedDoc.id !== null && selectedDoc.id !== undefined && selectedLayer.id !== null && selectedLayer.id !== undefined) {
            targetSmartObjectRef = { docId: selectedDoc.id, layerId: selectedLayer.id };
        }

        // Where the Smart Object sits now, so it can be put back exactly if its canvas has to grow
        // to keep the output at full resolution. Growth is only allowed when this placement is
        // known and plain (not rotated/skewed/warped); otherwise the output is shrunk to fit
        // the existing canvas as before.
        const originalPlacement = targetSmartObjectRef
            ? await getSmartObjectPlacementBox(targetSmartObjectRef.docId, targetSmartObjectRef.layerId)
            : null;
        const canGrowCanvas = Boolean(originalPlacement && originalPlacement.axisAligned);
        if (targetSmartObjectRef && !canGrowCanvas) {
            log("Get: Smart Object is transformed (rotated/skewed) or its placement is unreadable; the output will be resized to fit it.");
        }

        log("Opening selected Smart Object...");
        await openSelectedSmartObjectForEdit();

        log("Importing output into Smart Object...");
        const importDebug = await importOutputIntoActiveDocumentWithoutScaling(binary, info.filename, {
            growCanvasToKeepResolution: canGrowCanvas
        });
        if (importDebug && Number.isFinite(importDebug.srcW)) {
            log(
                `SO import debug: src=${Math.round(importDebug.srcW)}x${Math.round(importDebug.srcH)} ` +
                `canvas=${Math.round(importDebug.canvasW)}x${Math.round(importDebug.canvasH)} ` +
                `fit=${importDebug.fitMode || "none"} ` +
                `scale=${Number(importDebug.appliedWidthScale || 1).toFixed(4)}x${Number(importDebug.appliedHeightScale || 1).toFixed(4)} ` +
                `final=${Math.round(importDebug.finalLayerW)}x${Math.round(importDebug.finalLayerH)}`
            );
        }

        log("Saving and closing Smart Object...");
        await saveAndCloseActiveDocument();
        if (importDebug && importDebug.canvasGrown && targetSmartObjectRef) {
            const grown = importDebug.canvasGrown;
            log(`Get: Smart Object canvas grew ${grown.fromW}x${grown.fromH} -> ${grown.toW}x${grown.toH} to keep the output at full resolution; restoring its size in the document...`);
            const restored = await restoreSmartObjectPlacement(targetSmartObjectRef.docId, targetSmartObjectRef.layerId, originalPlacement);
            if (!restored) log("Get warning: the Smart Object could not be put back exactly at its original size/position; please check it.");
        }
        if (targetSmartObjectRef) {
            const nextLayerName = buildOutputLayerNameFromFilename(info.filename);
            await renameLayerById(targetSmartObjectRef.docId, targetSmartObjectRef.layerId, nextLayerName);
            log(`Renamed selected Smart Object to ${nextLayerName}.`);
        }

        log("Selected output imported into Smart Object and committed.");
        await notifyComfyTransferEvent({
            direction: "download",
            status: "success",
            message: "Selected output was imported into the selected Smart Object and saved.",
            filename: info.filename
        });
    } catch (error) {
        const detail = normalizePluginError(describeError(error));
        log(`Error: ${detail}`);
        if (error && error.qcNoSelectedOutput) {
            showPanelToast(`Please select a Save Image node (${comfyServerLabel()})`, "error");
        } else {
            showPanelToast(`Get from Comfy failed: ${detail}`, "error", 6000);
        }
        await notifyComfyTransferEvent({
            direction: "download",
            status: "error",
            message: detail,
            filename: selectedFilename
        });
    } finally {
        setGetButtonsDisabled(false);
    }
}

// Maps the Bridge Get dropdown value to its import handler.
const BRIDGE_GET_MODE_HANDLERS = {
    newLayer: getFromComfyAsNewLayer,
    smartObject: getFromComfyIntoSelectedSmartObject
};

if (bridgeGetModeSelect) {
    try {
        const savedMode = localStorage.getItem(BRIDGE_GET_MODE_STORAGE_KEY);
        if (savedMode && BRIDGE_GET_MODE_HANDLERS[savedMode]) bridgeGetModeSelect.value = savedMode;
    } catch (_e) {
        // Storage unavailable; keep the default (New Layer).
    }
    bridgeGetModeSelect.addEventListener("change", () => {
        try {
            localStorage.setItem(BRIDGE_GET_MODE_STORAGE_KEY, String(bridgeGetModeSelect.value || "newLayer"));
        } catch (_e) {}
    });
}

if (bridgeGetBtn) {
    bridgeGetBtn.onclick = async () => {
        const mode = String(bridgeGetModeSelect?.value || "newLayer");
        await (BRIDGE_GET_MODE_HANDLERS[mode] || getFromComfyAsNewLayer)();
    };
}

// Native dropdowns keep focus after a pick, and a focused dropdown steps through its options on
// mouse-wheel (OS combobox behavior) — so scrolling the panel afterwards silently changed the
// workflow/environment/etc. Drop focus right after any dropdown change so later wheel scrolls
// go to the panel. Delegated at the document (capture phase) so dropdowns built later, like the
// Auto Run parameter dropdowns, are covered too. Deferred a tick so the plugin's own change
// handlers run first with the dropdown still focused.
document.addEventListener("change", (event) => {
    const target = event?.target;
    if (!target || String(target.tagName || "").toUpperCase() !== "SELECT") return;
    setTimeout(() => {
        try {
            target.blur();
        } catch (_e) {}
    }, 0);
}, true);
