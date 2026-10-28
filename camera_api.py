"""
camera_api.py
-------------
Receives the dashboard's live-camera recording (sent in small chunks while it is
being recorded) and saves it as an MP4 in  recordings/ .

Separate Blueprint: it does not touch api.py, the telemetry store, serial links or
the existing /api/predict/terrain endpoint (which the camera feed also uses).

Endpoints (all under /api/camera):
    POST /recording/start    form: ext = mp4 | webm      -> {id, ffmpeg}
    POST /recording/chunk    form: id, seq, chunk(file)  -> {success}
    POST /recording/finish   form: id                    -> {success, filename, path, format, note}
    GET  /status                                         -> {ffmpeg}
"""
import re
import shutil
import subprocess
import threading
import uuid
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request

camera_api = Blueprint("camera_api", __name__)

RECORDINGS_DIR = Path("recordings")
RECORDINGS_DIR.mkdir(exist_ok=True)

_lock = threading.Lock()
_sessions = {}                       # id -> {"path": Path, "ext": str, "next_seq": int, "stamp": str}
_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def _find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:                                             # optional: pip install imageio-ffmpeg
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def _run_ffmpeg(args):
    try:
        r = subprocess.run(args, capture_output=True, timeout=600)
        return r.returncode == 0
    except Exception:
        return False


def _err(msg, code=400):
    return jsonify({"success": False, "error": msg}), code


@camera_api.route("/status", methods=["GET"])
def status():
    return jsonify({"success": True, "ffmpeg": _find_ffmpeg() is not None})


@camera_api.route("/recording/start", methods=["POST"])
def recording_start():
    ext = (request.form.get("ext") or "webm").lower()
    if ext not in ("mp4", "webm"):
        ext = "webm"
    base = datetime.now().strftime("%Y%m%d_%H%M%S")
    stamp, n = base, 1
    with _lock:                                      # never reuse a name (two recordings in one second)
        taken = {x["stamp"] for x in _sessions.values()}
        while stamp in taken or any(RECORDINGS_DIR.glob(f"camera_{stamp}.*")) or any(RECORDINGS_DIR.glob(f"camera_{stamp}_partial.*")):
            n += 1
            stamp = f"{base}_{n}"
    rid = uuid.uuid4().hex
    path = RECORDINGS_DIR / f"camera_{stamp}_partial.{ext}"
    path.write_bytes(b"")
    with _lock:
        _sessions[rid] = {"path": path, "ext": ext, "next_seq": 0, "stamp": stamp}
    return jsonify({"success": True, "id": rid, "ffmpeg": _find_ffmpeg() is not None})


@camera_api.route("/recording/chunk", methods=["POST"])
def recording_chunk():
    rid = request.form.get("id", "")
    if not _ID_RE.match(rid):
        return _err("Bad recording id.")
    try:
        seq = int(request.form.get("seq", "-1"))
    except ValueError:
        return _err("Bad sequence number.")
    f = request.files.get("chunk")
    if f is None:
        return _err("No chunk data.")
    data = f.read()

    with _lock:
        s = _sessions.get(rid)
        if s is None:
            return _err("Unknown recording.", 404)
        if seq < s["next_seq"]:                     # retry of a chunk already stored
            return jsonify({"success": True, "duplicate": True})
        if seq > s["next_seq"]:
            return _err(f"Expected chunk {s['next_seq']}, got {seq}.", 409)
        with open(s["path"], "ab") as out:
            out.write(data)
        s["next_seq"] += 1
    return jsonify({"success": True})


@camera_api.route("/recording/finish", methods=["POST"])
def recording_finish():
    rid = request.form.get("id", "")
    if not _ID_RE.match(rid):
        return _err("Bad recording id.")
    with _lock:
        s = _sessions.pop(rid, None)
    if s is None:
        return _err("Unknown recording.", 404)

    part, ext, stamp = s["path"], s["ext"], s["stamp"]
    if not part.exists() or part.stat().st_size == 0:
        return _err("Recording is empty.")

    final_mp4 = RECORDINGS_DIR / f"camera_{stamp}.mp4"
    ffmpeg = _find_ffmpeg()
    note = ""
    final = None

    if ffmpeg and ext == "mp4":
        # Browser MP4 is "fragmented" (no duration index); a lossless remux makes it a normal MP4.
        if _run_ffmpeg([ffmpeg, "-y", "-i", str(part), "-c", "copy", "-movflags", "+faststart", str(final_mp4)]):
            part.unlink(missing_ok=True)
            final = final_mp4
    elif ffmpeg and ext == "webm":
        if _run_ffmpeg([ffmpeg, "-y", "-i", str(part), "-c:v", "libx264", "-preset", "veryfast",
                        "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(final_mp4)]):
            part.unlink(missing_ok=True)
            final = final_mp4
        else:
            note = "ffmpeg conversion failed; kept the original WebM."

    if final is None:
        if ext == "mp4":
            final = final_mp4
            part.rename(final)
        else:
            final = RECORDINGS_DIR / f"camera_{stamp}.webm"
            part.rename(final)
            if not note:
                note = ("This browser records WebM. Install ffmpeg (or use a recent Chrome/Edge, "
                        "which records MP4 directly) to get an .mp4 file.")

    return jsonify({
        "success": True,
        "filename": final.name,
        "path": str(final.resolve()),
        "format": final.suffix.lstrip("."),
        "note": note,
    })
