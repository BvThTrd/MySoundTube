from os import environ
from re import search, sub
from uuid import uuid4
from subprocess import run, CompletedProcess, TimeoutExpired
from json import loads
from secrets import token_hex
from shutil import rmtree, copyfile
from shlex import join as shell_join
from traceback import format_exc
from datetime import date, datetime, timezone
from functools import wraps
from pathlib import Path
from typing import Callable, NamedTuple
from urllib.parse import urlparse, quote
import logging
import threading
from flask import Flask, request, jsonify, render_template, session, redirect, url_for, Response, stream_with_context
from bcrypt import checkpw
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from mutagen.id3 import APIC, COMM, TALB, TCON, TDRC, TIT2, TPE1, TRCK
from mutagen.aiff import AIFF
from mutagen.wave import WAVE

app = Flask(__name__)
app.secret_key = token_hex(32)

_raw_pw = environ.get("APP_PASSWORD", "")
PASSWORD_HASH = _raw_pw.encode() if _raw_pw.startswith("$2") else None

app.config["MAX_CONTENT_LENGTH"] = 1 * 1024

DOWNLOAD_DIR = Path("/tmp/mysoundtube-dl")
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

TOKEN_TTL_SECONDS = 3600

VALID_FORMATS = frozenset(("mp3", "m4a", "flac", "wav", "aiff", "mp4"))
PCM_FORMATS = ("wav", "aiff")
MIME_MAP = {
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "flac": "audio/flac",
    "wav": "audio/wav", "aiff": "audio/aiff", "mp4": "video/mp4",
}
FFMPEG_PATH = "/usr/bin/ffmpeg"
ALLOWED_SCHEMES = {"http", "https"}
ALLOWED_HOSTS_SC = {"soundcloud.com", "www.soundcloud.com", "on.soundcloud.com", "m.soundcloud.com"}
ALLOWED_HOSTS_YT = {"youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com", "music.youtube.com"}
ALLOWED_HOSTS = ALLOWED_HOSTS_SC | ALLOWED_HOSTS_YT

YTDLP_PROXY = environ.get("YTDLP_PROXY", "").strip()
YTDLP_COOKIES = Path(environ["YTDLP_COOKIES"]) if environ.get("YTDLP_COOKIES") else None
if YTDLP_COOKIES and not YTDLP_COOKIES.is_file():
    raise SystemExit(f"YTDLP_COOKIES points to {YTDLP_COOKIES}, which is not a file.")

# YouTube thumbnails are 16:9 with the square album art centered; a center square crop recovers the cover.
# The converter skips files already in the target format, so jpg maps to png to make sure the crop always runs.
SQUARE_COVER_ARGS = [
    "--convert-thumbnails", "webp>jpg/png>jpg/jpg>png",
    "--ppa", "ThumbnailsConvertor+FFmpeg_o:-qscale:v 2 -vf crop=\"'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'\"",
]

# SoundCloud Go+ tracks only expose 30 s "preview" formats to free accounts; never deliver one as the track
NO_PREVIEW = "[format_id!*=preview]"

# YouTube's auto-generated artist channels are named "<Artist> - Topic"
TOPIC_SUFFIX = " - Topic"
STRIP_TOPIC_ARGS = ["--replace-in-metadata", "uploader,artist", f"{TOPIC_SUFFIX}$", ""]

# Debug output for the TRACES panel; without a TTY every progress update is a new line, so throttle them
TRACE_ARGS = ["--verbose", "--progress-delta", "2"]

# yt-dlp silently drops the YouTube streams it cannot unlock, then only reports "Requested format is not
# available". The reasons sit in its WARNING and --verbose [debug] lines; these exact phrases only appear
# when the matching problem happened (generic lines like "PO Token Providers: none" print on every run).
_YOUTUBE_STREAM_SIGNALS = (
    (("js runtimes: none", "no supported javascript runtime"), "no JavaScript runtime (Deno) was found"),
    (("challenge solving failed",), "YouTube's JavaScript challenge could not be solved"),
    (("formats require a gvs po token",), "YouTube asked for a PO token"),
    (("forcing sabr streaming",), "YouTube withheld direct stream links (SABR)"),
)

_ERROR_HINTS = (
    (("requested format is not available",),
     "This track is probably Go+ only: SoundCloud serves free accounts just a 30-second preview."),
    (("drm",), "The full stream is DRM-encrypted and cannot be downloaded."),
    (("country", "location", "geo"), "Geo-restricted: set YTDLP_PROXY to a proxy in an allowed country."),
    (("sign in", "private", "members-only", "join this channel"),
     "Needs a logged-in account: set YTDLP_COOKIES to a cookies.txt export "
     "(for SoundCloud, use the private share link ending in /s-XXXX instead)."),
)

logger = logging.getLogger(__name__)
limiter = Limiter(key_func=get_remote_address, app=app, default_limits=[])

_pending_lock = threading.Lock()


class _DownloadEntry(NamedTuple):
    filepath: Path
    safe_name: str
    mimetype: str
    cleanup: Callable
    created_at: datetime


_pending_downloads: dict[str, _DownloadEntry] = {}


def _validate_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        return (
            parsed.scheme in ALLOWED_SCHEMES
            and parsed.hostname in ALLOWED_HOSTS
            and bool(parsed.path)
        )
    except Exception:
        return False


def _purge_expired_tokens():
    now = datetime.now(timezone.utc)
    expired = [
        t for t, e in _pending_downloads.items()
        if (now - e.created_at).total_seconds() > TOKEN_TTL_SECONDS
    ]
    for t in expired:
        entry = _pending_downloads.pop(t, None)
        if entry:
            try:
                entry.cleanup()
            except Exception:
                pass


def _add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "img-src 'self' https://*.sndcdn.com https://*.ytimg.com data:; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self';"
    )
    return response


app.after_request(_add_security_headers)


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("authenticated"):
            if request.is_json:
                return jsonify({"error": "Not authenticated"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated


def sanitize_filename(name: str) -> str:
    name = sub(r'[\\/*?:"<>|\r\n]', "", name)
    name = sub(r"\s+", " ", name).strip()
    return name[:180]


def _parse_download_request() -> tuple[str, str, int | None]:
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    fmt = (data.get("format") or "mp3").strip().lower()
    if fmt not in VALID_FORMATS:
        fmt = "mp3"
    playlist_index = data.get("playlist_index")
    if not (isinstance(playlist_index, int) and playlist_index >= 1):
        playlist_index = None
    return url, fmt, playlist_index


def _is_youtube_url(url: str) -> bool:
    try:
        return urlparse(url).hostname in ALLOWED_HOSTS_YT
    except Exception:
        return False


def _run_ytdlp(args: list[str], timeout: int) -> CompletedProcess:
    cmd = ["yt-dlp"]
    if YTDLP_PROXY:
        cmd += ["--proxy", YTDLP_PROXY]
    if not YTDLP_COOKIES:
        return run(cmd + args, capture_output=True, text=True, timeout=timeout)
    # yt-dlp rewrites the cookie file on exit: give each concurrent run its own writable copy
    cookie_copy = DOWNLOAD_DIR / f"cookies-{uuid4().hex}.txt"
    copyfile(YTDLP_COOKIES, cookie_copy)
    try:
        return run(cmd + ["--cookies", str(cookie_copy)] + args, capture_output=True, text=True, timeout=timeout)
    finally:
        cookie_copy.unlink(missing_ok=True)


def _ytdlp_error(result: CompletedProcess, fallback: str, url: str) -> str:
    errors = [line.removeprefix("ERROR: ") for line in result.stderr.splitlines() if line.startswith("ERROR:")]
    if not errors:
        return fallback
    message = errors[-1][:300]
    lowered = message.lower()
    if _is_youtube_url(url) and "requested format is not available" in lowered:
        return f"{message} -- {_youtube_no_stream_hint(result.stderr)}"
    for keywords, hint in _ERROR_HINTS:
        if any(k in lowered for k in keywords):
            return f"{message} -- {hint}"
    return message


def _youtube_no_stream_hint(stderr: str) -> str:
    lowered = stderr.lower()
    signals = [label for phrases, label in _YOUTUBE_STREAM_SIGNALS if any(p in lowered for p in phrases)]
    hint = "YouTube hid this video's streams" + (": " + "; ".join(signals) if signals else "")
    version = search(r"yt-dlp version (\S+)", stderr)
    hint += ". Rebuild the image to update yt-dlp" + (f" (running {version.group(1)})" if version else "")
    if YTDLP_COOKIES:
        hint += ". YTDLP_COOKIES is set: logged-in requests use other YouTube clients, try without it"
    return hint + "."


def _format_trace(attempts: list[CompletedProcess], footer: str = "") -> str:
    blocks = [
        f"=== Attempt {i}/{len(attempts)} - exit code {r.returncode} ===\n"
        f"$ {shell_join(r.args)}\n\n--- stdout ---\n{r.stdout}\n--- stderr ---\n{r.stderr}"
        for i, r in enumerate(attempts, 1)
    ]
    if footer:
        blocks.append(footer)
    # --verbose echoes the command line and the proxy map: hide the user:pass@ of any URL
    return sub(r"(\w+://)[^\s/@]+@", r"\1<redacted>@", "\n\n".join(blocks))


def _playlist_args(playlist_index: int | None) -> list[str]:
    if playlist_index is None:
        return ["--no-playlist"]
    return ["--playlist-items", str(playlist_index)]


def _build_ytdlp_video_cmd(output_template: str, playlist_index: int | None = None) -> list[str]:
    cmd = [*TRACE_ARGS, *_playlist_args(playlist_index)]
    cmd += [
        "-f", "bv*+ba/b",
        *STRIP_TOPIC_ARGS,
        "--merge-output-format", "mp4",
        "--embed-metadata",
        "--embed-thumbnail",
        "--output", output_template,
        "--ffmpeg-location", FFMPEG_PATH,
    ]
    return cmd


def _build_ytdlp_cmd(fmt: str, output_template: str, playlist_index: int | None = None,
                     square_cover: bool = False) -> list[str]:
    today = date.today().strftime("%Y%m%d")
    cmd = [*TRACE_ARGS, *_playlist_args(playlist_index)]
    cmd += [
        "--extract-audio",
        # yt-dlp has no AIFF output: download WAV, _finalize_pcm_files converts it
        "--audio-format", "wav" if fmt == "aiff" else fmt,
        "-f", f"ba{NO_PREVIEW}",
        "--audio-quality", "0",
        "--embed-metadata",
        "--parse-metadata", "%(uploader)s:%(artist)s",
        *STRIP_TOPIC_ARGS,
        "--parse-metadata", f"{today}:%(album)s",
        "--output", output_template,
        "--ffmpeg-location", FFMPEG_PATH,
    ]
    if fmt in PCM_FORMATS:
        # yt-dlp cannot embed into WAV/AIFF: keep the cover and metadata as side files for _finalize_pcm_files
        cmd += ["--write-thumbnail", "--write-info-json"]
        if not square_cover:
            cmd += ["--convert-thumbnails", "jpg"]
    else:
        cmd.append("--embed-thumbnail")
    if square_cover:
        cmd += SQUARE_COVER_ARGS
    return cmd


def _first_value(info: dict, *keys: str) -> str:
    for key in keys:
        value = info.get(key)
        if value not in (None, "", []):
            return ", ".join(map(str, value)) if isinstance(value, list) else str(value)
    return ""


def _finalize_pcm_files(session_dir: Path, fmt: str):
    # The ID3 tag mirrors every field ffmpeg wrote to RIFF INFO (same yt-dlp fallbacks) plus the cover.
    # Rekordbox never shows artwork embedded in WAV, whatever the chunk layout; it does for AIFF.
    for wav_path in session_dir.glob("*.wav"):
        info = loads(wav_path.with_suffix(".info.json").read_text(encoding="utf-8"))
        cover = next((c for c in (wav_path.with_suffix(".jpg"), wav_path.with_suffix(".png")) if c.exists()), None)
        upload_date = info.get("upload_date") or ""
        text_frames = (
            (TIT2, _first_value(info, "track", "title")),
            (TPE1, _first_value(info, "artist", "artists", "creator", "uploader")),
            (TALB, _first_value(info, "album")),
            (TCON, _first_value(info, "genre", "genres", "categories", "tags")),
            (TDRC, f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:]}" if len(upload_date) == 8 else ""),
            (TRCK, _first_value(info, "track_number")),
        )
        if fmt == "aiff":
            aiff_path = wav_path.with_suffix(".aiff")
            run([FFMPEG_PATH, "-loglevel", "error", "-i", str(wav_path), "-map", "0:a", "-c:a", "pcm_s16be", str(aiff_path)],
                capture_output=True, check=True)
            wav_path.unlink()
            audio = AIFF(aiff_path)
        else:
            audio = WAVE(wav_path)
        if audio.tags is None:
            audio.add_tags()
        for frame_cls, value in text_frames:
            if value:
                audio.tags.add(frame_cls(encoding=3, text=value))
        if info.get("webpage_url"):
            audio.tags.add(COMM(encoding=3, lang="eng", desc="", text=info["webpage_url"]))
        if cover:
            mime = "image/png" if cover.suffix == ".png" else "image/jpeg"
            audio.tags.add(APIC(encoding=0, mime=mime, type=3, desc="Cover", data=cover.read_bytes()))
        # Rekordbox is reliable with ID3v2.3; frames like TDRC must be converted, not just the header version
        audio.tags.update_to_v23()
        audio.save(v2_version=3)
    for side_file in session_dir.iterdir():
        if side_file.suffix != f".{fmt}":
            side_file.unlink()


def _run_with_fallback(cmd: list[str], fmt: str, timeout: int, attempts: list[CompletedProcess]) -> CompletedProcess:
    # attempts is filled in place so the caller keeps the runs for the trace even if a later one times out
    def attempt(args: list[str]) -> CompletedProcess:
        result = _run_ytdlp(args, timeout)
        attempts.append(result)
        return result

    result = attempt(cmd)
    if result.returncode == 0:
        return result
    # Retry with any best format instead of audio-only (e.g. SoundCloud HLS 404), still excluding previews
    if "-f" in cmd:
        idx = cmd.index("-f")
        if cmd[idx + 1] == f"ba{NO_PREVIEW}":
            any_format = cmd[:idx + 1] + [f"b{NO_PREVIEW}"] + cmd[idx + 2:]
            result = attempt(any_format)
            if result.returncode == 0:
                return result
            cmd = any_format
    # Last resort: strip embed-thumbnail / embed-metadata
    strip_flag = "--embed-thumbnail" if fmt in ("mp3", "m4a", "flac", "mp4") else "--embed-metadata"
    return attempt([c for c in cmd if c != strip_flag])


def _register_token(filepath: Path, safe_name: str, mimetype: str, cleanup_fn: Callable) -> str:
    token = token_hex(32)
    with _pending_lock:
        _purge_expired_tokens()
        _pending_downloads[token] = _DownloadEntry(
            filepath, safe_name, mimetype, cleanup_fn, datetime.now(timezone.utc)
        )
    return token


@app.route("/login", methods=["GET", "POST"])
@limiter.limit("10 per minute")
def login():
    error = None
    if request.method == "POST":
        pwd = (request.form.get("password") or "").strip()
        if PASSWORD_HASH and len(pwd.encode()) <= 72 and checkpw(pwd.encode(), PASSWORD_HASH):
            session["authenticated"] = True
            return redirect(url_for("index"))
        error = "Wrong password."
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def index():
    return render_template("index.html")


@app.route("/info", methods=["POST"])
@login_required
@limiter.limit("60 per minute")
def get_info():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400
    if not _validate_url(url):
        return jsonify({"error": "Invalid URL. Only SoundCloud and YouTube URLs are supported."}), 400

    try:
        result = _run_ytdlp(["--dump-json", "--no-playlist", url], 30)
        if result.returncode != 0:
            return jsonify({"error": _ytdlp_error(result, "Could not fetch track info. Check the URL.", url)}), 400

        info = loads(result.stdout)
        return jsonify({
            "title": info.get("title", "Unknown"),
            "uploader": (info.get("uploader") or info.get("artist") or "Unknown").removesuffix(TOPIC_SUFFIX),
            "duration": info.get("duration", 0),
            "thumbnail": info.get("thumbnail", ""),
            "description": (info.get("description") or "")[:300],
        })
    except TimeoutExpired:
        return jsonify({"error": "Request timed out. Try again."}), 408
    except Exception:
        logger.exception("Unexpected error in /info")
        return jsonify({"error": "An internal error occurred."}), 500


@app.route("/download", methods=["POST"])
@login_required
@limiter.limit("60 per minute")
def download():
    url, fmt, playlist_index = _parse_download_request()
    if not url:
        return jsonify({"error": "No URL provided"}), 400
    if not _validate_url(url):
        return jsonify({"error": "Invalid URL. Only SoundCloud and YouTube URLs are supported."}), 400
    if fmt == "mp4" and not _is_youtube_url(url):
        return jsonify({"error": "MP4 video download is only available for YouTube URLs."}), 400

    session_dir = DOWNLOAD_DIR / uuid4().hex
    session_dir.mkdir(parents=True, exist_ok=True)
    name_template = "%(uploader,artist)s - %(title)s.%(ext)s"
    if playlist_index is not None:
        name_template = "%(playlist_index)02d - " + name_template
    output_template = str(session_dir / name_template)
    if fmt == "mp4":
        dl_timeout = 600
        cmd = _build_ytdlp_video_cmd(output_template, playlist_index) + [url]
    else:
        dl_timeout = 300 if fmt in ("flac", *PCM_FORMATS) else 120
        cmd = _build_ytdlp_cmd(fmt, output_template, playlist_index, square_cover=_is_youtube_url(url)) + [url]

    attempts: list[CompletedProcess] = []

    def fail(message: str, status: int, footer: str = ""):
        rmtree(session_dir, ignore_errors=True)
        return jsonify({"error": message, "trace": _format_trace(attempts, footer)}), status

    try:
        result = _run_with_fallback(cmd, fmt, dl_timeout, attempts)
        if result.returncode != 0:
            return fail(_ytdlp_error(result, "Download failed.", url), 400)
        if fmt in PCM_FORMATS:
            _finalize_pcm_files(session_dir, fmt)

        all_files = list(session_dir.glob("*.*"))
        logger.debug("Files in session dir: %s", [(f.name, f.stat().st_size) for f in all_files])
        files = [f for f in all_files if f.suffix.lower() == f".{fmt}"]
        if not files:
            files = [f for f in all_files if f.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp", ".part")]
        if not files:
            return fail("Download produced no file.", 500)

        filepath = max(files, key=lambda f: f.stat().st_size)
        if filepath.stat().st_size == 0:
            return fail("Conversion produced an empty file.", 500)

        safe_name = sanitize_filename(filepath.stem) + filepath.suffix
        token = _register_token(
            filepath, safe_name, MIME_MAP.get(fmt, "application/octet-stream"),
            lambda: rmtree(session_dir, ignore_errors=True)
        )
        return jsonify({"token": token, "filename": safe_name, "trace": _format_trace(attempts)})

    except TimeoutExpired as exc:
        return fail("Download timed out. Track may be too long or connection is slow.", 408,
                    f"=== Timed out after {exc.timeout}s ===\n$ {shell_join(exc.cmd)}")
    except Exception:
        logger.exception("Unexpected error in /download")
        return fail("An internal error occurred.", 500, f"=== Python exception ===\n{format_exc()}")


@app.route("/playlist-info", methods=["POST"])
@login_required
@limiter.limit("30 per minute")
def playlist_info():
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "No URL provided"}), 400
    if not _validate_url(url):
        return jsonify({"error": "Invalid URL. Only SoundCloud and YouTube URLs are supported."}), 400

    try:
        result = _run_ytdlp(["--flat-playlist", "--dump-single-json", url], 60)
        if result.returncode != 0:
            return jsonify({"error": _ytdlp_error(result, "Could not fetch playlist info.", url)}), 400

        info = loads(result.stdout)
        entries = info.get("entries") or []
        return jsonify({
            "title": info.get("title", "Playlist"),
            "track_count": len(entries),
            "uploader": info.get("uploader", info.get("channel", "")),
            # SoundCloud flat entries carry only a URL, so title and the rest may be empty
            "entries": [
                {
                    "title": e.get("title") or "",
                    "uploader": (e.get("uploader") or e.get("channel") or "").removesuffix(TOPIC_SUFFIX),
                    "duration": e.get("duration") or 0,
                    "thumbnail": (e.get("thumbnails") or [{}])[-1].get("url", ""),
                }
                for e in entries
            ],
        })
    except TimeoutExpired:
        return jsonify({"error": "Request timed out."}), 408
    except Exception:
        logger.exception("Unexpected error in /playlist-info")
        return jsonify({"error": "An internal error occurred."}), 500


@app.route("/get-file/<token>")
@login_required
def get_file(token):
    with _pending_lock:
        _purge_expired_tokens()
        entry = _pending_downloads.pop(token, None)

    if not entry:
        return jsonify({"error": "Invalid or expired download token"}), 404

    if not entry.filepath.exists():
        entry.cleanup()
        return jsonify({"error": "File no longer available"}), 404

    # Path traversal guard
    try:
        entry.filepath.resolve().relative_to(DOWNLOAD_DIR.resolve())
    except ValueError:
        entry.cleanup()
        return jsonify({"error": "Invalid file path"}), 400

    file_size = entry.filepath.stat().st_size

    def generate():
        try:
            with open(entry.filepath, "rb") as f:
                while chunk := f.read(65536):
                    yield chunk
        finally:
            threading.Timer(1.0, entry.cleanup).start()

    # Header values must be latin-1: a raw en dash or emoji in the title made the server drop the connection.
    # RFC 6266: percent-encoded UTF-8 in filename*, plus an ASCII-only filename for old clients.
    # sanitize_filename already stripped the quote and backslash that could break out of filename="".
    ascii_name = entry.safe_name.encode("ascii", "ignore").decode()
    return Response(
        stream_with_context(generate()),
        mimetype=entry.mimetype,
        headers={
            "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(entry.safe_name)}",
            "Content-Length": str(file_size),
            "Cache-Control": "no-cache, no-store, must-revalidate",
        },
    )


if __name__ == "__main__":
    port = int(environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
