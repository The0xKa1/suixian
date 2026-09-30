"""Read Audiveris MusicXML without network requests or third-party XML parsers."""
from __future__ import annotations

import io
import math
import re
import xml.etree.ElementTree as ET
import zipfile

MAX_XML_BYTES = 15_000_000


class RecognitionError(ValueError):
    pass


def finite(value: str | None, default: float = 0) -> float:
    try:
        result = default if value is None else float(value)
    except (TypeError, ValueError) as exc:
        raise RecognitionError("识谱结果包含无效数值。") from exc
    if not math.isfinite(result) or abs(result) > 1_000_000:
        raise RecognitionError("识谱结果的音高或时值超出范围。")
    return result


def read_xml(data: bytes) -> ET.Element:
    if len(data) > MAX_XML_BYTES:
        raise RecognitionError("识谱输出超过 15 MB。")
    if data.startswith(b"PK"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                candidates = [item for item in entries
                              if item.filename.endswith((".xml", ".musicxml"))
                              and not item.filename.startswith("META-INF/")]
                if len(entries) > 100 or len(candidates) != 1 or candidates[0].file_size > MAX_XML_BYTES:
                    raise RecognitionError("识谱输出不是单首 MusicXML。")
                data = archive.read(candidates[0])
        except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
            raise RecognitionError("无法读取压缩识谱结果。") from exc
    # Also catch declarations in UTF-16/32 input before the XML parser can expand
    # them. ElementTree never fetches the normal external MusicXML DTD.
    if b"<!ENTITY" in data.replace(b"\x00", b"").upper() or len(data) > MAX_XML_BYTES:
        raise RecognitionError("识谱输出包含不支持的 XML 内容。")
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise RecognitionError("无法读取识谱结果。") from exc
    nodes = [(root, 0)]
    count = 0
    while nodes:
        element, depth = nodes.pop()
        count += 1
        if depth > 256 or count > 200_000:
            raise RecognitionError("识谱 XML 结构过于复杂。")
        element.tag = element.tag.rsplit("}", 1)[-1]
        nodes.extend((child, depth + 1) for child in element)
    if root.tag != "score-partwise":
        raise RecognitionError("识谱结果不是逐声部 MusicXML。")
    return root


def notation_xml(data: bytes) -> str:
    """Return all recognised MusicXML elements, never rebuild from pitch events.

    Parsing and serialising removes the original DTD and processing instructions
    before the document reaches the browser renderer. Notes, rests, voices,
    lyrics, articulations, layout hints and other musical content remain intact.
    """
    result = ET.tostring(read_xml(data), encoding="unicode")
    if len(result.encode("utf-8")) > MAX_XML_BYTES:
        raise RecognitionError("识谱输出超过 15 MB。")
    return result


def parse_reference(data: bytes, page_index: int = 0, beat_offset: float = 0,
                    cursor_geometry: list[dict] | None = None) -> tuple[dict, float]:
    """Merge simultaneous voices/parts; return events plus actual page duration.

    Each image is processed independently. Its page index is never inferred from
    MusicXML's reflow pagination. Position is a within-page musical-order fraction.
    """
    root = read_xml(data)
    prohibited = {"repeat", "ending", "segno", "coda", "measure-repeat"}
    jump_attributes = {"dacapo", "dalsegno", "tocoda", "fine", "forward-repeat"}
    for element in root.iter():
        if element.tag in prohibited or (element.tag == "sound" and jump_attributes & element.attrib.keys()):
            raise RecognitionError("谱面包含反复或跳转，暂不能自动对齐；请上传已展开的演奏顺序。")
        if element.tag == "words" and re.search(r"(?:\bD\s*\.\s*[CS]\s*\.|\b(?:da capo|dal segno|al coda)\b)", element.text or "", re.I):
            raise RecognitionError("谱面包含 D.C. / D.S. 跳转，暂不能自动对齐。")
        if element.tag in {"unpitched", "transpose"}:
            raise RecognitionError("暂不支持无固定音高或移调乐器的图片识谱，请使用实音 MusicXML。")
    parts = root.findall("part")
    if not parts or len(parts) > 12:
        raise RecognitionError("未识别到可用声部。")
    measure_counts = {len(part.findall("measure")) for part in parts}
    if len(measure_counts) != 1 or max(measure_counts) > 800:
        raise RecognitionError("识别到的声部小节不一致，请换用更清晰的谱面。")
    all_measures: list[list[dict]] = []
    tempo = None
    for part in parts:
        measures = []
        divisions, meter = 1.0, 4.0
        pending_ties = {}
        for measure in part.findall("measure"):
            cursor, extent, previous_onset = 0.0, 0.0, 0.0
            notes = []
            for element in measure:
                if element.tag == "attributes":
                    divisions = finite(element.findtext("divisions"), divisions)
                    if divisions <= 0:
                        raise RecognitionError("识谱结果的节拍单位无效。")
                    time = element.find("time")
                    if time is not None:
                        beats = time.findtext("beats", "4")
                        if not re.fullmatch(r"\d+(?:\+\d+)*", beats):
                            raise RecognitionError("暂不支持此复合拍号。")
                        unit = finite(time.findtext("beat-type"), 4)
                        if unit <= 0:
                            raise RecognitionError("识谱结果的拍号无效。")
                        meter = sum(map(int, beats.split("+"))) * 4 / unit
                elif element.tag == "direction":
                    for sound in element.findall("sound"):
                        if tempo is None and sound.get("tempo"):
                            value = finite(sound.get("tempo"))
                            if 20 <= value <= 400:
                                tempo = value
                elif element.tag in {"backup", "forward"}:
                    duration = finite(element.findtext("duration")) / divisions
                    if duration < 0:
                        raise RecognitionError("识谱结果包含无效时值。")
                    cursor += duration * (-1 if element.tag == "backup" else 1)
                    if cursor < -0.01:
                        raise RecognitionError("识谱结果的声部时序不完整。")
                    cursor = max(0, cursor)
                    extent = max(extent, cursor)
                elif element.tag == "note":
                    if element.find("grace") is not None:
                        continue  # Ornamental grace notes do not advance the measured timeline.
                    duration = finite(element.findtext("duration")) / divisions
                    if duration <= 0 or duration > 128:
                        raise RecognitionError("有音符缺失时值，请换用更清晰的谱面。")
                    chord = element.find("chord") is not None
                    onset = previous_onset if chord else cursor
                    if not chord:
                        previous_onset = onset
                        cursor += duration
                    extent = max(extent, onset + duration)
                    pitch = element.find("pitch")
                    if pitch is not None:
                        step = pitch.findtext("step", "")
                        if step not in "CDEFGAB" or len(step) != 1:
                            raise RecognitionError("识谱结果包含无效音名。")
                        midi = (finite(pitch.findtext("octave")) + 1) * 12
                        midi += {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[step]
                        midi += finite(pitch.findtext("alter"))
                        if not midi.is_integer() or not 0 <= midi <= 127:
                            raise RecognitionError("暂不支持此音高。")
                        tie_types = {tie.get("type") for tie in element.findall("tie")}
                        tie_key = (element.findtext("voice", "1"), element.findtext("staff", "1"), int(midi))
                        if "stop" in tie_types:
                            original = pending_ties.get(tie_key)
                            if original is None:
                                raise RecognitionError("图片包含跨页或不完整的延音线；请改用完整 MusicXML。")
                            original["duration"] += duration
                            if "start" not in tie_types:
                                pending_ties.pop(tie_key)
                        else:
                            note = {"midi": int(midi), "onset": onset, "duration": duration}
                            notes.append(note)
                            if "start" in tie_types:
                                if tie_key in pending_ties:
                                    raise RecognitionError("识谱结果的延音线不完整。")
                                pending_ties[tie_key] = note
            length = extent if measure.get("implicit") == "yes" else max(extent, meter)
            if length <= 0 or length > 128:
                raise RecognitionError("识谱结果的小节时值异常。")
            measures.append({"length": length, "notes": notes})
        if pending_ties:
            raise RecognitionError("图片包含跨页或不完整的延音线；请改用完整 MusicXML。")
        all_measures.append(measures)
    # Geometry is optional and must agree with the actual exported measures.
    # A native archive from another layout must never produce a plausible cursor.
    measure_lengths = [max(measures[i]["length"] for measures in all_measures)
                       for i in range(next(iter(measure_counts)))]
    if cursor_geometry is not None and (len(cursor_geometry) != len(measure_lengths) or any(
            min(abs(length - item["duration"]), abs(length - max(item["duration"], item["expected"]))) > .00001
            for length, item in zip(measure_lengths, cursor_geometry))):
        cursor_geometry = None
    events_by_beat: dict[float, dict] = {}
    page_duration = 0.0
    for index in range(next(iter(measure_counts))):
        for measures in all_measures:
            for note in measures[index]["notes"]:
                beat = round(page_duration + note["onset"], 6)
                event = events_by_beat.setdefault(beat, {"midi": [], "beat": beat + beat_offset, "durationBeats": 0})
                if note["midi"] not in event["midi"]:
                    event["midi"].append(note["midi"])
                event["durationBeats"] = max(event["durationBeats"], note["duration"])
                if cursor_geometry is not None:
                    cursor = cursor_geometry[index]["cursors"].get(round(note["onset"], 6))
                    if cursor is not None:
                        event["cursor"] = cursor
        page_duration += measure_lengths[index]
    if len(events_by_beat) < 3:
        raise RecognitionError("此页没有识别到足够音符；请使用清晰的印刷五线谱或 MusicXML。")
    events = []
    for beat, event in sorted(events_by_beat.items()):
        event["midi"].sort()
        event["position"] = page_index + min(0.999, beat / page_duration)
        events.append(event)
    result = {"events": events}
    if tempo is not None:
        result["initialTempo"] = tempo
    return result, page_duration
