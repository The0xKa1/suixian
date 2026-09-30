"""Original image coordinates from Audiveris 5.11's native OMR archive.

Never infer image coordinates from MusicXML engraving or proportional beat
spacing. Native rhythm slots link to chord/head pixel bounds and staff lines.
Unknown/ambiguous native layouts return no geometry; audio alignment can remain.
"""
from __future__ import annotations

from fractions import Fraction
import io
import math
import statistics
import xml.etree.ElementTree as ET
import zipfile


def number(value):
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("non-finite geometry")
    return result


def beats(value):
    result = float(Fraction(value)) * 4
    if not 0 <= result <= 128:
        raise ValueError("invalid native rhythm")
    return result


def line_y(line, x):
    points = sorted((number(p.get("x")), number(p.get("y"))) for p in line.findall("point"))
    if len(points) < 2 or x < points[0][0] or x > points[-1][0]:
        raise ValueError("missing staff geometry")
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        if ax <= x <= bx and bx > ax:
            return ay + (by - ay) * (x - ax) / (bx - ax)
    raise ValueError("invalid staff geometry")


def read_cursor_geometry(data: bytes, image_size: tuple[int, int]) -> list[dict] | None:
    """Return measure-local onset -> image cursor, or None for unsafe geometry.

    OMR units are original raster pixels. The caller supplies decoded source
    dimensions to reject transformed/resized engine output. MusicXML measure
    lengths are checked separately before any coordinates reach the client.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            sheets = [f for f in archive.infolist() if f.filename.startswith("sheet#") and f.filename.endswith(".xml")]
            if len(sheets) != 1 or sheets[0].file_size > 20_000_000:
                return None
            xml = archive.read(sheets[0])
        if b"<!ENTITY" in xml.upper():
            return None
        root = ET.fromstring(xml)
        picture = root.find("picture")
        width, height = number(picture.get("width")), number(picture.get("height"))
        if (width, height) != image_size or min(width, height) <= 0:
            return None
        result = []
        for system_index, system in enumerate(root.findall("page/system")):
            staves = system.findall("part/staff")
            if not staves or any(len(staff.findall("lines/line")) != 5 for staff in staves):
                return None
            heads, head_tops, head_bottoms = {}, [], []
            for head in system.findall("sig/inters/head"):
                box = head.find("bounds")
                if box is not None:
                    heads[head.get("id")] = number(box.get("x")) + number(box.get("w")) / 2
                    head_tops.append(number(box.get("y")))
                    head_bottoms.append(number(box.get("y")) + number(box.get("h")))
            chord_heads = {}
            for relation in system.findall("sig/relations/relation"):
                if relation.find("containment") is not None and relation.get("target") in heads:
                    chord_heads.setdefault(relation.get("source"), []).append(heads[relation.get("target")])
            for stack in system.findall("stack"):
                if stack.get("abnormal") == "true" or stack.get("repeat"):
                    return None
                duration, expected = beats(stack.get("duration")), beats(stack.get("expected"))
                # The native stack and each part's measure share an identifier.
                measures = [m for m in system.findall("part/measure") if m.get("id") == stack.get("id")]
                if not measures or any(m.get("abnormal") == "true" for m in measures):
                    return None
                attacks = {}
                for measure in measures:
                    for entry in measure.findall("voice/slots/entry"):
                        value = entry.find("value")
                        if value is not None and value.get("status") == "BEGIN":
                            attacks.setdefault(entry.findtext("key"), set()).add(value.get("chord"))
                cursors = {}
                for slot in stack.findall("slot"):
                    onset = beats(slot.get("time-offset"))
                    xs = [x for chord in attacks.get(slot.get("id"), ()) for x in chord_heads.get(chord, ())]
                    if not xs:
                        continue  # Rest-only slots have no playback attack marker.
                    x = statistics.median(xs)
                    # Cross-staff chords can have offset heads, but widely spread
                    # attacks suggest a bad slot association and are omitted.
                    spacing = number(root.find("scale/interline").get("main"))
                    if max(xs) - min(xs) > spacing * 2:
                        continue
                    try:
                        top = min([line_y(staff.findall("lines/line")[0], x) for staff in staves] + head_tops) - spacing * .7
                        bottom = max([line_y(staff.findall("lines/line")[-1], x) for staff in staves] + head_bottoms) + spacing * .7
                    except ValueError:
                        continue
                    top, bottom = max(0, top), min(height, bottom)
                    if not 0 <= x <= width or not top < bottom:
                        continue
                    cursors[round(onset, 6)] = {"x": x / width, "y": top / height,
                                              "height": (bottom - top) / height, "system": system_index}
                result.append({"duration": duration, "expected": expected, "cursors": cursors})
        return result or None
    except (AttributeError, TypeError, ValueError, KeyError, ZeroDivisionError, ET.ParseError, zipfile.BadZipFile):
        return None
