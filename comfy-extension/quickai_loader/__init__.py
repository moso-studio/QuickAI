import json
import os
import time
from aiohttp import web
import folder_paths
from server import PromptServer

WEB_DIRECTORY = "./js"
__all__ = ["WEB_DIRECTORY"]

STATE = {
    "clients": {},
    "pending_apply_by_client": {},
    "pending_apply_legacy": {"filename": "", "mask_filename": ""},
    "active_client_id": None,
    "active_client_seen_ms": 0,
    "transfer_events": [],
    "last_transfer_event_id": 0,
    # Outcome of each Photoshop "send" apply request, keyed by the plugin-generated request_id,
    # so the plugin can tell the user whether the image actually landed on a node.
    "apply_results": {}
}

# Cap on remembered apply results; old entries are dropped first (dicts keep insertion order).
APPLY_RESULTS_MAX = 50


def _now_ms():
    return int(time.time() * 1000)


def _normalize_client_id(value):
    client_id = (value or "").strip()
    return client_id or "__legacy__"


def _coerce_bool(value, default=True):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ("1", "true", "yes", "on"):
            return True
        if normalized in ("0", "false", "no", "off"):
            return False
    return bool(value)


def _cleanup_stale_clients(max_age_ms=120000):
    now = _now_ms()
    stale_ids = []
    for client_id, data in STATE["clients"].items():
        last_seen = int(data.get("last_seen_ms") or 0)
        if now - last_seen > max_age_ms:
            stale_ids.append(client_id)
    for client_id in stale_ids:
        STATE["clients"].pop(client_id, None)
        STATE["pending_apply_by_client"].pop(client_id, None)


def _pick_active_client_id():
    _cleanup_stale_clients()
    now = _now_ms()
    pinned_active = STATE.get("active_client_id")
    pinned_seen = int(STATE.get("active_client_seen_ms") or 0)
    if pinned_active and (now - pinned_seen) <= 20000 and pinned_active in STATE["clients"]:
        return pinned_active

    if not STATE["clients"]:
        return None

    focused_clients = [
        (client_id, data)
        for client_id, data in STATE["clients"].items()
        if bool(data.get("has_focus", False))
    ]
    if focused_clients:
        focused_clients.sort(key=lambda item: int(item[1].get("last_seen_ms") or 0), reverse=True)
        return focused_clients[0][0]

    visible_clients = [
        (client_id, data)
        for client_id, data in STATE["clients"].items()
        if bool(data.get("is_visible", True))
    ]
    pool = visible_clients if visible_clients else list(STATE["clients"].items())
    pool.sort(key=lambda item: int(item[1].get("last_seen_ms") or 0), reverse=True)
    return pool[0][0] if pool else None


def _get_client_state(client_id):
    current = STATE["clients"].get(client_id)
    if current:
        return current
    current = {
        "selected_output": {"filename": "", "subfolder": "", "type": "output"},
        "selected_loadimage_node_id": None,
        "selected_loadimagemask_node_id": None,
        "is_visible": True,
        "has_focus": False,
        "last_seen_ms": 0
    }
    STATE["clients"][client_id] = current
    return current


@PromptServer.instance.routes.get("/quickai/selection")
async def quickai_get_selection(request):
    requested_client_id = _normalize_client_id(request.query.get("client_id"))
    active_client_id = requested_client_id if requested_client_id in STATE["clients"] else _pick_active_client_id()
    client_state = _get_client_state(active_client_id or "__legacy__")

    return web.json_response({
        "ok": True,
        "client_id": active_client_id or "__legacy__",
        "selected_output": client_state["selected_output"],
        "selected_loadimage_node_id": client_state["selected_loadimage_node_id"],
        "selected_loadimagemask_node_id": client_state["selected_loadimagemask_node_id"]
    })


@PromptServer.instance.routes.post("/quickai/selection")
async def quickai_set_selection(request):
    try:
        data = await request.json()
    except json.JSONDecodeError:
        data = {}

    client_id = _normalize_client_id(data.get("client_id"))
    is_visible = _coerce_bool(data.get("is_visible"), default=True)
    has_focus = _coerce_bool(data.get("has_focus"), default=False)
    client_state = _get_client_state(client_id)

    out = data.get("selected_output") or {}
    client_state["selected_output"] = {
        "filename": (out.get("filename") or "").strip(),
        "subfolder": (out.get("subfolder") or "").strip(),
        "type": (out.get("type") or "output").strip() or "output"
    }
    node_id = data.get("selected_loadimage_node_id")
    client_state["selected_loadimage_node_id"] = node_id if node_id is not None else None
    mask_node_id = data.get("selected_loadimagemask_node_id")
    client_state["selected_loadimagemask_node_id"] = mask_node_id if mask_node_id is not None else None
    client_state["is_visible"] = is_visible
    client_state["has_focus"] = has_focus
    client_state["last_seen_ms"] = _now_ms()
    if has_focus:
        STATE["active_client_id"] = client_id
        STATE["active_client_seen_ms"] = client_state["last_seen_ms"]

    return web.json_response({"ok": True, "client_id": client_id})


@PromptServer.instance.routes.post("/quickai/apply-upload")
async def quickai_apply_upload(request):
    try:
        data = await request.json()
    except json.JSONDecodeError:
        data = {}

    filename = (data.get("filename") or "").strip()
    mask_filename = (data.get("mask_filename") or "").strip()
    if not filename and not mask_filename:
        return web.json_response({"ok": False, "error": "Missing filename"}, status=400)

    # Optional id from the Photoshop plugin; echoed to the browser and back via /apply-result.
    request_id = (data.get("request_id") or "").strip()

    requested_client_id = _normalize_client_id(data.get("client_id"))
    target_client_id = None
    if requested_client_id in STATE["clients"]:
        target_client_id = requested_client_id
    else:
        target_client_id = _pick_active_client_id()

    if target_client_id:
        STATE["pending_apply_by_client"][target_client_id] = {
            "filename": filename,
            "mask_filename": mask_filename,
            "request_id": request_id
        }
    else:
        # Compatibility fallback: if no client is registered yet, keep one global pending payload.
        STATE["pending_apply_legacy"] = {
            "filename": filename,
            "mask_filename": mask_filename,
            "request_id": request_id
        }

    return web.json_response({
        "ok": True,
        "client_id": target_client_id or "__legacy__",
        "filename": filename,
        "mask_filename": mask_filename
    })


@PromptServer.instance.routes.get("/quickai/pending-apply")
async def quickai_get_pending_apply(request):
    client_id = _normalize_client_id(request.query.get("client_id"))
    pending = (
        STATE["pending_apply_by_client"].get(client_id)
        or STATE["pending_apply_legacy"]
        or {"filename": "", "mask_filename": ""}
    )
    return web.json_response({
        "ok": True,
        "client_id": client_id,
        "filename": pending.get("filename") or "",
        "mask_filename": pending.get("mask_filename") or "",
        "request_id": pending.get("request_id") or ""
    })


@PromptServer.instance.routes.post("/quickai/pending-apply/ack")
async def quickai_ack_pending_apply(request):
    client_id = _normalize_client_id(request.query.get("client_id"))
    STATE["pending_apply_by_client"].pop(client_id, None)
    STATE["pending_apply_legacy"] = {"filename": "", "mask_filename": ""}
    return web.json_response({"ok": True, "client_id": client_id})


# Browser extension reports what happened to a pending apply request:
# status "applied" (node_ids lists the nodes), "no_node" (no LoadImage/LoadImageMask selected)
# or "error" (message explains).
@PromptServer.instance.routes.post("/quickai/apply-result")
async def quickai_post_apply_result(request):
    try:
        data = await request.json()
    except json.JSONDecodeError:
        data = {}

    request_id = (data.get("request_id") or "").strip()
    status = (data.get("status") or "").strip().lower()
    if not request_id:
        return web.json_response({"ok": False, "error": "Missing request_id"}, status=400)
    if status not in ("applied", "no_node", "error"):
        return web.json_response({"ok": False, "error": "Invalid status"}, status=400)

    node_ids = data.get("node_ids") if isinstance(data.get("node_ids"), list) else []
    STATE["apply_results"][request_id] = {
        "status": status,
        "node_ids": [str(n) for n in node_ids],
        "message": (data.get("message") or "").strip(),
        "ts": _now_ms()
    }
    while len(STATE["apply_results"]) > APPLY_RESULTS_MAX:
        STATE["apply_results"].pop(next(iter(STATE["apply_results"])))

    return web.json_response({"ok": True})


# Photoshop plugin polls this after a send; status "pending" until the browser reports back.
@PromptServer.instance.routes.get("/quickai/apply-result")
async def quickai_get_apply_result(request):
    request_id = (request.query.get("request_id") or "").strip()
    result = STATE["apply_results"].get(request_id)
    if not result:
        return web.json_response({"ok": True, "status": "pending"})
    return web.json_response({"ok": True, **result})


@PromptServer.instance.routes.post("/quickai/transfer-event")
async def quickai_post_transfer_event(request):
    try:
        data = await request.json()
    except json.JSONDecodeError:
        data = {}

    direction = (data.get("direction") or "").strip().lower()
    status = (data.get("status") or "").strip().lower()
    message = (data.get("message") or "").strip()
    filename = (data.get("filename") or "").strip()

    if direction not in ("send", "download"):
        return web.json_response({"ok": False, "error": "Invalid direction"}, status=400)
    if status not in ("success", "error", "info", "warn"):
        return web.json_response({"ok": False, "error": "Invalid status"}, status=400)

    STATE["last_transfer_event_id"] += 1
    event = {
        "id": STATE["last_transfer_event_id"],
        "direction": direction,
        "status": status,
        "message": message,
        "filename": filename,
        "ts": int(time.time() * 1000)
    }
    STATE["transfer_events"].append(event)
    STATE["transfer_events"] = STATE["transfer_events"][-100:]

    return web.json_response({"ok": True, "event": event})


@PromptServer.instance.routes.get("/quickai/transfer-events")
async def quickai_get_transfer_events(request):
    since_id_raw = (request.query.get("since_id") or "0").strip()
    try:
        since_id = int(since_id_raw)
    except ValueError:
        since_id = 0

    events = [evt for evt in STATE["transfer_events"] if evt["id"] > since_id]
    return web.json_response({
        "ok": True,
        "events": events,
        "last_id": STATE["last_transfer_event_id"]
    })


# Returns the newest Comfy output file that matches the provided filename prefix.
# This allows bridge consumers to resolve EXR-only saver outputs that do not appear in history.
@PromptServer.instance.routes.get("/quickai/latest-output-by-prefix")
@PromptServer.instance.routes.post("/quickai/latest-output-by-prefix")
async def quickai_latest_output_by_prefix(request):
    payload = {}
    if request.method == "POST":
        try:
            payload = await request.json()
        except Exception:
            payload = {}
    prefix = (request.query.get("prefix") or payload.get("prefix") or "").strip()
    extension = (request.query.get("extension") or payload.get("extension") or "").strip().lower().lstrip(".")
    limit_raw = str(request.query.get("limit") or payload.get("limit") or "100").strip()
    min_modified_ms_raw = str(request.query.get("min_modified_ms") or payload.get("min_modified_ms") or "").strip()
    try:
        limit = int(limit_raw)
    except ValueError:
        limit = 100
    limit = max(1, min(1000, limit))
    try:
        min_modified_ms = int(min_modified_ms_raw) if min_modified_ms_raw else None
    except ValueError:
        min_modified_ms = None
    if not prefix:
        return web.json_response({"ok": False, "error": "Missing prefix"}, status=400)

    output_root = folder_paths.get_output_directory()
    if not output_root or not os.path.isdir(output_root):
        return web.json_response({"ok": False, "error": "Comfy output directory is unavailable"}, status=500)

    matches = []
    for dirpath, _dirnames, filenames in os.walk(output_root):
        for name in filenames:
            if not name.startswith(prefix):
                continue
            if extension and not name.lower().endswith(f".{extension}"):
                continue
            full_path = os.path.join(dirpath, name)
            try:
                mtime = float(os.path.getmtime(full_path))
            except OSError:
                continue
            rel_subfolder = os.path.relpath(dirpath, output_root)
            rel_subfolder = "" if rel_subfolder in (".", "") else rel_subfolder.replace("\\", "/")
            rel_key = f"{rel_subfolder}/{name}" if rel_subfolder else name
            matches.append({
                "filename": name,
                "subfolder": rel_subfolder,
                "type": "output",
                "modified_ms": int(mtime * 1000),
                "_sort_rel": rel_key
            })

    if min_modified_ms is not None:
        matches = [item for item in matches if int(item.get("modified_ms") or 0) >= min_modified_ms]

    if not matches:
        return web.json_response({
            "ok": False,
            "error": "No matching output file found",
            "prefix": prefix,
            "extension": extension,
            "min_modified_ms": min_modified_ms
        }, status=404)

    matches.sort(key=lambda item: (int(item.get("modified_ms") or 0), str(item.get("_sort_rel") or "")), reverse=True)
    trimmed = matches[:limit]
    for item in trimmed:
        item.pop("_sort_rel", None)
    return web.json_response({
        "ok": True,
        "match": trimmed[0],
        "matches": trimmed
    })
