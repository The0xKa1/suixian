#!/usr/bin/env python3
"""Loopback-only score recognition. Uploads and engine output are short-lived."""
from __future__ import annotations

import base64
import binascii
import json
import os
from pathlib import Path
import re
import shutil
import select
import signal
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from musicxml_reference import RecognitionError, notation_xml, parse_reference
from omr_geometry import read_cursor_geometry
from local_process import REQUEST, RecognitionCancelled, check_cancelled, run_local, stop_children

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / ".tools/audiveris/Audiveris.app/Contents"
JAVA = APP / "runtime/Contents/Home/bin/java"
ENGINE = "Audiveris 5.11.0"
MAX_BODY = 80 * 1024 * 1024
MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_NOTATION_JSON_BYTES = 15_000_000
ALLOWED_ORIGINS = {f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in (5173, 4173, 5174)}
JOB_LOCK = threading.Lock()


def engine_environment() -> dict:
    env = dict(os.environ)
    for candidate in (ROOT / ".tools/audiveris/tessdata", Path("/opt/homebrew/share/tessdata"), Path("/usr/local/share/tessdata")):
        if (candidate / "eng.traineddata").is_file():
            env["TESSDATA_PREFIX"] = str(candidate)
            break
    return env


def ready() -> bool:
    return JAVA.is_file() and (APP / "app/audiveris.jar").is_file()


def image_dimensions(path: Path) -> tuple[int, int]:
    result = run_local(["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", str(path)], capture_output=True, text=True, timeout=20)
    width = re.search(r"pixelWidth:\s*(\d+)", result.stdout)
    height = re.search(r"pixelHeight:\s*(\d+)", result.stdout)
    if result.returncode or not width or not height:
        raise RecognitionError("无法解码此页图像。")
    return int(width[1]), int(height[1])


def decode_page(page: dict, target: Path) -> Path:
    if not isinstance(page, dict) or not isinstance(page.get("src"), str):
        raise RecognitionError("谱页数据无效。")
    match = re.fullmatch(r"data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)", page["src"])
    if not match:
        raise RecognitionError("识谱仅接受本地 PNG、JPG 或 WebP 页面。")
    try:
        data = base64.b64decode(match.group(2), validate=True)
    except (ValueError, binascii.Error) as exc:
        raise RecognitionError("谱页图像数据损坏。") from exc
    if not 50 <= len(data) <= MAX_IMAGE_BYTES:
        raise RecognitionError("单页图像须小于 30 MB。")
    kind = match.group(1)
    valid_signature = (kind == "png" and data.startswith(b"\x89PNG\r\n\x1a\n")) or (kind in {"jpeg", "jpg"} and data.startswith(b"\xff\xd8")) or (kind == "webp" and data[:4] == b"RIFF" and data[8:12] == b"WEBP")
    if not valid_signature:
        raise RecognitionError("谱页图像格式与内容不一致。")
    path = target.with_suffix("." + kind)
    path.write_bytes(data)
    # macOS image decoding also checks actual dimensions, not the client metadata.
    width, height = image_dimensions(path)
    if width * height > 40_000_000 or min(width, height) < 80:
        raise RecognitionError("谱页尺寸不适合识别（最短边至少 80 像素，总像素不超过 4000 万）。")
    if kind == "webp":
        converted = target.with_suffix(".png")
        result = run_local(["/usr/bin/sips", "-s", "format", "png", str(path), "--out", str(converted)], capture_output=True, timeout=20)
        if result.returncode:
            raise RecognitionError("无法转换 WebP 谱页。")
        path = converted
    return path


def recognize(payload: dict) -> dict:
    if not ready():
        raise RecognitionError("本地识谱引擎尚未安装，请运行 npm run setup:omr。")
    pages = payload.get("pages") if isinstance(payload, dict) else None
    if not isinstance(pages, list) or not 1 <= len(pages) <= 20:
        raise RecognitionError("每次识谱须包含 1–20 页。")
    home = ROOT / ".tools/audiveris/home"
    home.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    reference, beat_offset = {"events": []}, 0.0
    notation_sources, notation_bytes = [], 0
    notation_unavailable = None
    engines = set()
    with tempfile.TemporaryDirectory(prefix="suixian-omr-") as directory:
        workspace = Path(directory)
        paths = [decode_page(page, workspace / f"page-{index + 1:02}") for index, page in enumerate(pages)]
        if sum(path.stat().st_size for path in paths) > 45 * 1024 * 1024:
            raise RecognitionError("解码后的谱页合计不能超过 45 MB。")
        for index, path in enumerate(paths):
            check_cancelled()
            if time.monotonic() - started > 600:
                raise RecognitionError("识谱超过 10 分钟，请减少页数后重试。")
            output = workspace / f"output-{index}"
            output.mkdir()
            try:
                from tab_ocr import recognize_tab
                tab_result = recognize_tab(path, output, index, beat_offset)
                if tab_result is not None:
                    parsed, duration = tab_result
                    engines.add("Tesseract TAB (standard tuning)")
                    # TAB OCR detects fret attacks, not measured rhythm/rests or
                    # bars. Its ordinal beat placeholders cannot become notation.
                    notation_unavailable = "六线谱识别尚未提取节奏与小节，暂不能重新排版。"
                    notation_sources.clear()
                else:
                    command = [str(JAVA), "-Djava.awt.headless=true", f"-Duser.home={home}", f"-Djava.io.tmpdir={workspace}", "-Xmx2G", "-cp", str(APP / "app/*"), "Audiveris", "-batch", "-transcribe", "-export", "-output", str(output), "--", str(path)]
                    with (output / "engine.log").open("wb") as log:
                        result = run_local(command, stdout=log, stderr=subprocess.STDOUT, env=engine_environment(), timeout=min(150, max(1, 600 - (time.monotonic() - started))))
                    scores = sorted(output.glob("*.mxl"))
                    if result.returncode or len(scores) != 1:
                        raise RecognitionError("未识别到连续的五线谱；请检查清晰度，或改用 MusicXML。")
                    archives = sorted(output.glob("*.omr"))
                    geometry = read_cursor_geometry(archives[0].read_bytes(), image_dimensions(path)) if len(archives) == 1 else None
                    score_data = scores[0].read_bytes()
                    parsed, duration = parse_reference(score_data, index, beat_offset, geometry)
                    check_cancelled()
                    if notation_unavailable is None:
                        source = {"id": f"source-{index + 1}", "xml": notation_xml(score_data),
                                  "originalPage": index, "startBeat": beat_offset, "durationBeats": duration}
                        notation_bytes += len(json.dumps(source, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                        if notation_bytes > MAX_NOTATION_JSON_BYTES:
                            notation_unavailable = "结构化谱面超过 15 MB，请分段导入后重新排版。"
                            notation_sources.clear()
                        else:
                            notation_sources.append(source)
                    engines.add(ENGINE)
            except subprocess.TimeoutExpired as exc:
                raise RecognitionError(f"第 {index + 1} 页识别超时，请减少图像尺寸或使用 MusicXML。") from exc
            except RecognitionCancelled:
                raise
            except RecognitionError as exc:
                raise RecognitionError(f"第 {index + 1} 页：{exc}") from exc
            reference["events"].extend(parsed["events"])
            if "initialTempo" in parsed and "initialTempo" not in reference:
                reference["initialTempo"] = parsed["initialTempo"]
            beat_offset += duration
            if len(reference["events"]) > 10000:
                raise RecognitionError("谱面音符过多，请分段导入。")
    check_cancelled()
    result = {"reference": reference, "engine": " + ".join(sorted(engines)), "notationSources": notation_sources}
    if notation_unavailable is not None:
        result["notationUnavailable"] = notation_unavailable
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "SuixianOMR/1"

    def disconnected(self):
        try:
            if select.select([self.connection], [], [], 0)[0]:
                return not self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT)
        except (OSError, ValueError):
            return True
        return False

    def allowed(self) -> bool:
        host = self.headers.get("Host", "").lower()
        hostname = urlparse("http://" + host).hostname
        origin = self.headers.get("Origin")
        return hostname in {"127.0.0.1", "localhost"} and (origin is None or origin in ALLOWED_ORIGINS)

    def respond(self, status: int, body: dict):
        data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if not self.allowed():
            return self.respond(403, {"error": "仅允许本机随弦页面访问。"})
        if self.path != "/api/health":
            return self.respond(404, {"error": "接口不存在。"})
        self.respond(200, {"service": "suixian-omr", "ready": ready(), "engine": ENGINE, "busy": JOB_LOCK.locked()})

    def do_OPTIONS(self):
        if not self.allowed():
            return self.respond(403, {"error": "不允许此来源。"})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "http://127.0.0.1:5173"))
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if not self.allowed():
            return self.respond(403, {"error": "仅允许本机随弦页面访问。"})
        if self.path != "/api/recognize":
            return self.respond(404, {"error": "接口不存在。"})
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
            return self.respond(415, {"error": "请求须使用 application/json。"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BODY:
            return self.respond(413, {"error": "识谱请求为空或超过 80 MB。"})
        if not JOB_LOCK.acquire(blocking=False):
            return self.respond(409, {"error": "本地引擎正在识别另一份谱子，请稍后再试。"})
        try:
            self.connection.settimeout(30)
            data = self.rfile.read(length)
            if len(data) != length:
                raise RecognitionError("谱页上传不完整。")
            payload = json.loads(data)
            REQUEST.disconnected = self.disconnected
            self.respond(200, recognize(payload))
        except RecognitionCancelled:
            pass
        except (ValueError, RecognitionError) as exc:
            self.respond(422, {"error": str(exc) if isinstance(exc, RecognitionError) else "请求数据无效。"})
        except (OSError, subprocess.SubprocessError) as exc:
            self.log_error("local engine error: %s", type(exc).__name__)
            self.respond(503, {"error": "本地识谱引擎暂时不可用，请检查服务日志。"})
        except Exception as exc:
            self.log_error("recognition error: %s", type(exc).__name__)
            self.respond(500, {"error": "本地识谱失败，未保存识谱文件。"})
        finally:
            REQUEST.disconnected = None
            JOB_LOCK.release()

    def log_message(self, fmt, *args):
        # Do not log uploaded data, note contents, or original user filenames.
        print(f"[suixian-omr] {fmt % args}", flush=True)


if __name__ == "__main__":
    print(f"随弦本地识谱 http://127.0.0.1:5174 · {ENGINE} · ready={ready()}", flush=True)
    def stop_service(_signal, _frame):
        stop_children()
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_service)
    signal.signal(signal.SIGINT, stop_service)
    server = ThreadingHTTPServer(("127.0.0.1", 5174), Handler)
    server.daemon_threads = False
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        stop_children()
    finally:
        server.server_close()
