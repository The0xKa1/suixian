"""Conservative six-line tablature OCR; see docs/research/omr.md for scope.

Pitch order comes from recognised frets. Beat fields are ordinal placeholders;
the uploaded audio determines timing. No durations are claimed to be read here.
"""
import csv
import io
from pathlib import Path
import re
import shutil
import statistics
import struct
import subprocess

from musicxml_reference import RecognitionError
from local_process import check_cancelled, run_local


def read_bitmap(path: Path, output: Path):
    bitmap = output / "tab-detection.bmp"
    result = run_local(["/usr/bin/sips", "-s", "format", "bmp", str(path), "--out", str(bitmap)], capture_output=True, timeout=20)
    if result.returncode:
        raise RecognitionError("无法读取谱面像素。")
    data = bitmap.read_bytes()
    offset = struct.unpack_from("<I", data, 10)[0]
    width, height = struct.unpack_from("<ii", data, 18)
    depth, compression = struct.unpack_from("<HI", data, 28)
    if width <= 0 or not height or depth not in (24, 32) or compression != 0:
        return None
    stride = ((width * depth + 31) // 32) * 4
    step = depth // 8
    rows = []
    for index in range(abs(height)):
        y = index if height < 0 else height - 1 - index
        row = data[offset + y * stride:offset + y * stride + width * step]
        rows.append(bytearray(value < 140 for value in row[2::step]))
    return width, rows


def staff_groups(rows, width):
    candidates = [y for y, row in enumerate(rows) if sum(row) > width * .48]
    bands = []
    for y in candidates:
        if bands and y == bands[-1][-1] + 1:
            bands[-1].append(y)
        else:
            bands.append([y])
    centers = [statistics.mean(band) for band in bands]
    groups = []
    index = 0
    while index < len(centers):
        matched = False
        for count in (6, 5):
            subset = centers[index:index + count]
            if len(subset) != count:
                continue
            gaps = [b - a for a, b in zip(subset, subset[1:])]
            spacing = statistics.mean(gaps)
            if not 7 <= spacing <= 100 or max(abs(gap - spacing) for gap in gaps) > spacing * .13:
                continue
            # A seventh equally spaced line indicates a table, not six strings.
            if index + count < len(centers) and abs(centers[index + count] - subset[-1] - spacing) < spacing * .15:
                continue
            groups.append((bands[index:index + count], spacing))
            index += count
            matched = True
            break
        if not matched:
            index += 1
    return groups


def pgm(path: Path, rows):
    width = len(rows[0])
    pixels = bytes(0 if value else 255 for row in rows for value in row)
    path.write_bytes(f"P5\n{width} {len(rows)}\n255\n".encode() + pixels)


def recognize_tab(path: Path, output: Path, page_index: int, beat_offset: float):
    raster = read_bitmap(path, output)
    if raster is None:
        return None
    width, rows = raster
    groups = staff_groups(rows, width)
    six = [group for group in groups if len(group[0]) == 6]
    if not six:
        return None
    if any(len(group[0]) == 5 for group in groups):
        raise RecognitionError("暂不支持五线谱与 TAB 混排的图片，请上传 MusicXML。")
    tesseract = shutil.which("tesseract")
    if not tesseract:
        raise RecognitionError("六线谱识别需要本机 Tesseract，请运行 brew install tesseract。")
    # Refuse tuning/technique instructions instead of assigning misleading pitches.
    text = run_local([tesseract, str(path), "stdout", "--psm", "11"], capture_output=True, text=True, timeout=30).stdout
    if re.search(r"(?:\b(?:capo|tuning|drop\s*d)\b|\bD\s*\.\s*[CS]\s*\.)", text, re.I):
        raise RecognitionError("图片 TAB 暂仅支持标准定弦、无变调夹与无跳转；此谱请改用 MusicXML。")
    events = []
    tuning = [64, 59, 55, 50, 45, 40]  # high E through low E, standard six-string guitar
    for system_index, (bands, spacing) in enumerate(six):
        notes = []
        for string_index, band in enumerate(bands):
            check_cancelled()
            center = statistics.mean(band)
            top = max(0, round(center - spacing * .47))
            bottom = min(len(rows), round(center + spacing * .47))
            strip = [bytearray(row) for row in rows[top:bottom]]
            for y in range(max(0, band[0] - top - 1), min(len(strip), band[-1] - top + 2)):
                row = strip[y]
                start = None
                for x in range(width + 1):
                    if x < width and row[x]:
                        if start is None:
                            start = x
                    elif start is not None:
                        if x - start > spacing * 1.8:
                            row[start:x] = b"\0" * (x - start)
                        start = None
            # Remove bar lines extending through the full row crop.
            vertical_region = rows[max(0, round(center - spacing * .8)):min(len(rows), round(center + spacing * .8))]
            for x in range(width):
                if sum(row[x] for row in vertical_region) >= len(vertical_region) * .9:
                    for row in strip:
                        row[x] = 0
            # Padding helps Tesseract separate digits from the image border.
            padded = [bytearray(width) for _ in range(12)] + strip + [bytearray(width) for _ in range(12)]
            crop = output / f"tab-{system_index}-{string_index}.pgm"
            pgm(crop, padded)
            result = run_local([tesseract, str(crop), "stdout", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789", "tsv"], capture_output=True, text=True, timeout=15)
            if result.returncode:
                raise RecognitionError("六线谱数字识别失败。")
            recognized_regions = []
            for box in csv.DictReader(io.StringIO(result.stdout), delimiter="\t"):
                digit = box.get("text", "").strip()
                if not digit:
                    continue
                x, box_width = int(box["left"]), int(box["width"])
                # Header lettering is outside the playing region.
                if x < width * .04 or x > width * .98:
                    continue
                if not digit.isdigit() or len(digit) > 2 or int(digit) > 24 or float(box["conf"]) < 65:
                    raise RecognitionError("六线谱有无法可靠识别的品位，请换用更清晰的谱面或 MusicXML。")
                notes.append((x + box_width / 2, tuning[string_index] + int(digit)))
                recognized_regions.append((x - 3, x + box_width + 3))
            # OCR may silently omit an unreadable glyph. Fail closed when ink in
            # the playing region is not covered by a recognised fret box.
            unclaimed = 0
            for x in range(round(width * .04), round(width * .98)):
                if not any(left <= x <= right for left, right in recognized_regions):
                    unclaimed += sum(row[x] for row in strip)
            if unclaimed > max(8, spacing * .4):
                raise RecognitionError("六线谱仍有未识别记号；图片识别仅支持清晰的品位数字，请改用 MusicXML。")
        if not notes:
            raise RecognitionError("六线谱未识别到品位数字，请使用清晰的印刷 TAB 或 MusicXML。")
        chords = []
        for x, midi in sorted(notes):
            if chords and abs(x - chords[-1]["x"]) <= spacing * .55:
                chords[-1]["midi"].append(midi)
            else:
                chords.append({"x": x, "midi": [midi]})
        if len(chords) < 3:
            raise RecognitionError("此行六线谱的可识别音符太少，未建立时间轴。")
        for chord in chords:
            top = max(0, statistics.mean(bands[0]) - spacing * .7)
            bottom = min(len(rows), statistics.mean(bands[-1]) + spacing * .7)
            events.append({"midi": sorted(set(chord["midi"])), "beat": beat_offset + len(events), "durationBeats": 1,
                           "position": page_index + min(.999, (system_index + chord["x"] / width) / len(six)),
                           "cursor": {"x": chord["x"] / width, "y": top / len(rows),
                                      "height": (bottom - top) / len(rows), "system": system_index}})
    return {"events": events}, float(len(events))
