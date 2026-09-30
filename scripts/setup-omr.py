#!/usr/bin/env python3
"""Install the pinned official engine into .tools, without a global app install."""
from pathlib import Path
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".tools/audiveris"
VERSION = "5.11.0"
URL = f"https://github.com/Audiveris/audiveris/releases/download/{VERSION}/Audiveris-{VERSION}-macosx-arm64.dmg"
SHA256 = "17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6"


def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        sys.exit("当前安装脚本支持 Apple Silicon macOS；其他平台需另行配置官方 Audiveris 5.11.0。")
    TOOLS.mkdir(parents=True, exist_ok=True)
    app = TOOLS / "Audiveris.app"
    if not (app / "Contents/app/audiveris.jar").is_file():
        archive = TOOLS / f"Audiveris-{VERSION}-macosx-arm64.dmg"
        if not archive.is_file():
            print("下载官方 Audiveris 5.11.0（约 85 MB，含 Java）…", flush=True)
            temporary = archive.with_suffix(".download")
            try:
                with urllib.request.urlopen(URL, timeout=60) as response, temporary.open("wb") as target:
                    shutil.copyfileobj(response, target)
                temporary.replace(archive)
            finally:
                temporary.unlink(missing_ok=True)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
            sys.exit("下载包 SHA-256 与官方发行版不符；请删除 .tools/audiveris 中的 DMG 后重新安装。")
        mount = TOOLS / "mount"
        mount.mkdir(exist_ok=True)
        result = subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mount), str(archive)], input="Y\n", text=True, capture_output=True)
        if result.returncode:
            sys.exit("无法挂载官方 Audiveris 安装包：" + result.stderr[-400:])
        try:
            subprocess.run(["ditto", str(mount / "Audiveris.app"), str(app)], check=True)
        finally:
            subprocess.run(["hdiutil", "detach", str(mount)], check=True, capture_output=True)
    tessdata = TOOLS / "tessdata"
    tessdata.mkdir(exist_ok=True)
    if not (tessdata / "eng.traineddata").is_file():
        available = [Path("/opt/homebrew/share/tessdata/eng.traineddata"), Path("/usr/local/share/tessdata/eng.traineddata")]
        local = next((path for path in available if path.is_file()), None)
        if local:
            shutil.copy2(local, tessdata / "eng.traineddata")
        else:
            print("下载 Tesseract 官方英文识别数据…", flush=True)
            url = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata"
            with urllib.request.urlopen(url, timeout=60) as response, (tessdata / "eng.traineddata").open("wb") as target:
                shutil.copyfileobj(response, target)
    (TOOLS / "source.json").write_text(json.dumps({"engine": "Audiveris", "version": VERSION, "source": URL, "sha256": SHA256, "license": "AGPL-3.0", "upstream": "https://github.com/Audiveris/audiveris"}, indent=2) + "\n")
    java = app / "Contents/runtime/Contents/Home/bin/java"
    subprocess.run([str(java), "-version"], check=True)
    print("五线谱识谱引擎已就绪；运行 npm run dev 可启动本地服务。")
    if not shutil.which("tesseract"):
        print("如需简单六线谱图片 OCR，再运行 brew install tesseract。")


if __name__ == "__main__":
    main()
