"""Lossless MusicXML transport and conservative notation availability tests."""
import base64
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
import zipfile
from unittest.mock import patch

from local_process import REQUEST, RecognitionCancelled
from musicxml_reference import RecognitionError, notation_xml, parse_reference
from omr_service import ready, recognize


def source_xml(beats=4):
    return f'''<?xml version="1.0"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>Original title</work-title></work>
  <part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
  <part id="P1"><measure number="1" implicit="yes">
    <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>{beats}</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
    <direction><direction-type><dynamics><mp/></dynamics></direction-type><sound tempo="92"/></direction>
    <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type>
      <notations><slur number="1" type="start"/><articulations><accent/></articulations><technical><string>2</string><fret>1</fret></technical></notations>
      <lyric number="1"><syllabic>single</syllabic><text>la</text></lyric></note>
    <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type></note>
    <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><notations><slur number="1" type="stop"/></notations></note>
    {'<note><rest/><duration>1</duration><type>quarter</type></note>' if beats == 4 else ''}
  </measure></part>
</score-partwise>'''.encode()


def mxl(data):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("META-INF/container.xml", '<container/>')
        archive.writestr("score.musicxml", data)
    return output.getvalue()


class NotationXMLTests(unittest.TestCase):
    def test_mxl_keeps_musical_semantics_and_removes_external_dtd(self):
        exported = notation_xml(mxl(source_xml()))
        self.assertNotIn("<!DOCTYPE", exported)
        root = ET.fromstring(exported)
        for path in (".//rest", ".//voice", ".//time", ".//key", ".//clef", ".//slur", ".//accent", ".//mp", ".//string", ".//fret", ".//lyric"):
            self.assertIsNotNone(root.find(path), path)
        self.assertEqual(root.findtext(".//work-title"), "Original title")
        self.assertEqual(root.findtext(".//lyric/text"), "la")
        self.assertEqual(root.find(".//slur").attrib, {"number": "1", "type": "start"})
        self.assertEqual(parse_reference(source_xml()), parse_reference(exported.encode()))

    def test_unsafe_or_ambiguous_archives_rejected(self):
        entity = '<!DOCTYPE score-partwise [<!ENTITY x "expanded">]><score-partwise>&x;</score-partwise>'
        for data in (entity.encode(), entity.encode("utf-16"), b"PKbad zip", b"<score-timewise/>"):
            with self.subTest(data=data[:20]), self.assertRaises(RecognitionError):
                notation_xml(data)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("one.xml", source_xml())
            archive.writestr("two.xml", source_xml())
        with self.assertRaises(RecognitionError):
            notation_xml(output.getvalue())

    def test_limits_deep_xml_before_serializing(self):
        xml = b"<score-partwise>" + b"<a>" * 258 + b"</a>" * 258 + b"</score-partwise>"
        with self.assertRaisesRegex(RecognitionError, "复杂"):
            notation_xml(xml)


class NotationServiceTests(unittest.TestCase):
    def recognize_mock_pages(self, data, tab_results=None, cancel_after_engine=False):
        workspaces = []

        def decode(_page, target):
            target.write_bytes(b"test input")
            workspaces.append(target.parent)
            return target

        def run(command, **_kwargs):
            output = Path(command[command.index("-output") + 1])
            index = int(output.name.split("-")[1])
            (output / "score.mxl").write_bytes(mxl(data[index]))
            if cancel_after_engine:
                REQUEST.disconnected = lambda: True
            return subprocess.CompletedProcess(command, 0)

        try:
            with patch("omr_service.ready", return_value=True), patch("omr_service.decode_page", side_effect=decode), patch("omr_service.run_local", side_effect=run), patch("tab_ocr.recognize_tab", side_effect=tab_results or [None] * len(data)):
                return recognize({"pages": [{}] * len(data)})
        finally:
            REQUEST.disconnected = None
            self.assertTrue(workspaces)
            self.assertTrue(all(not path.exists() for path in workspaces), "engine temporary files survive request")

    def test_original_page_and_beat_offsets_are_kept_across_sources(self):
        result = self.recognize_mock_pages([source_xml(4), source_xml(3)])
        sources = result["notationSources"]
        self.assertEqual([(s["id"], s["originalPage"], s["startBeat"], s["durationBeats"]) for s in sources], [("source-1", 0, 0, 4), ("source-2", 1, 4, 3)])
        self.assertEqual([event["beat"] for event in result["reference"]["events"]], [0, 1, 2, 4, 5, 6])
        self.assertEqual(result["reference"]["initialTempo"], 92)
        self.assertNotIn("notationUnavailable", result)
        for source in sources:
            reference, duration = parse_reference(source["xml"].encode(), source["originalPage"], source["startBeat"])
            self.assertEqual(duration, source["durationBeats"])
            self.assertTrue(all(event in result["reference"]["events"] for event in reference["events"]))

    def test_tab_ordinal_reference_is_never_presented_as_measured_notation(self):
        reference = {"events": [{"midi": [64], "beat": 4, "durationBeats": 1, "position": 1}]}
        result = self.recognize_mock_pages([source_xml(), source_xml()], [None, (reference, 1)])
        self.assertEqual(result["notationSources"], [])
        self.assertIn("节奏与小节", result["notationUnavailable"])
        self.assertEqual(result["reference"]["events"][-1], reference["events"][0])

    def test_oversize_notation_keeps_compatible_reference_without_partial_pages(self):
        with patch("omr_service.MAX_NOTATION_JSON_BYTES", 1):
            result = self.recognize_mock_pages([source_xml(), source_xml()])
        self.assertEqual(result["notationSources"], [])
        self.assertIn("分段导入", result["notationUnavailable"])
        self.assertEqual(len(result["reference"]["events"]), 6)

    def test_cancellation_after_engine_preserves_no_output(self):
        with self.assertRaises(RecognitionCancelled):
            self.recognize_mock_pages([source_xml()], cancel_after_engine=True)


@unittest.skipUnless(shutil.which("tesseract") and sys.platform == "darwin" and ready(), "local macOS Tesseract required")
class TabNotationIntegrationTests(unittest.TestCase):
    def test_real_tab_keeps_pitch_reference_and_explicitly_declines_reflow(self):
        fixtures = Path(__file__).parent / "fixtures"
        data = base64.b64encode((fixtures / "standard-tab.png").read_bytes()).decode()
        result = recognize({"pages": [{"src": "data:image/png;base64," + data}]})
        expected = json.loads((fixtures / "standard-tab-expected.json").read_text())["midi"]
        self.assertEqual([e["midi"][0] for e in result["reference"]["events"]], expected)
        self.assertEqual(result["notationSources"], [])
        self.assertIn("节奏与小节", result["notationUnavailable"])


@unittest.skipUnless(os.getenv("SUIXIAN_OMR_INTEGRATION") == "1" and ready(), "set SUIXIAN_OMR_INTEGRATION=1 for actual Audiveris")
class AudiverisNotationIntegrationTests(unittest.TestCase):
    def test_actual_engine_exports_full_musicxml_with_reference_consistency(self):
        fixture = Path(__file__).parent / "fixtures/cucaracha-first-system.png"
        data = base64.b64encode(fixture.read_bytes()).decode()
        result = recognize({"pages": [{"src": "data:image/png;base64," + data}]})
        source = result["notationSources"][0]
        root = ET.fromstring(source["xml"])
        self.assertIsNotNone(root.find(".//clef"))
        self.assertIsNotNone(root.find(".//time"))
        reference, duration = parse_reference(source["xml"].encode())
        self.assertEqual(duration, source["durationBeats"])
        actual = result["reference"]["events"]
        self.assertEqual([dict(e, cursor=None) for e in actual], [dict(e, cursor=None) for e in reference["events"]])


if __name__ == "__main__":
    unittest.main()
