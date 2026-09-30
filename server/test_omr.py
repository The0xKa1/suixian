"""Focused parser, privacy boundary, lifecycle, and opt-in real-engine tests."""
import base64
import http.client
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import zipfile
from unittest.mock import patch

from local_process import CHILDREN, REQUEST, RecognitionCancelled, run_local
from musicxml_reference import RecognitionError, parse_reference
from omr_service import Handler, ThreadingHTTPServer, decode_page, ready, recognize
from omr_geometry import read_cursor_geometry
from tab_ocr import recognize_tab

FIXTURES = Path(__file__).parent / "fixtures"


def score(measures, second_part=""):
    return f'<score-partwise><part id="P1">{measures}</part>{second_part}</score-partwise>'.encode()


def note(step="C", duration=1, extra="", voice="1"):
    return f'<note>{extra}<pitch><step>{step}</step><octave>4</octave></pitch><duration>{duration}</duration><voice>{voice}</voice></note>'


class ParserTests(unittest.TestCase):
    def test_native_geometry_must_match_measure_count_and_duration(self):
        body = '<measure>' + note() + note('D') + note('E') + '</measure>'
        cursor = {"x": .25, "y": .2, "height": .15, "system": 0}
        geometry = [{"duration": 4, "expected": 4, "cursors": {0: cursor}}]
        result, _ = parse_reference(score(body), cursor_geometry=geometry)
        self.assertEqual(result['events'][0]['cursor'], cursor)
        self.assertNotIn('cursor', result['events'][1])
        for bad in (geometry * 2, [{"duration": 2, "expected": 2, "cursors": {0: cursor}}]):
            result, _ = parse_reference(score(body), cursor_geometry=bad)
            self.assertTrue(all('cursor' not in event for event in result['events']))

    def test_voices_chords_rests_and_original_page_index(self):
        body = '<measure><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>'
        body += note("C") + note("E", extra="<chord/>") + '<note><rest/><duration>1</duration></note>' + note("D") + note("F")
        body += '<backup><duration>4</duration></backup>' + note("G", 4, voice="2") + '</measure>'
        reference, duration = parse_reference(score(body), page_index=3, beat_offset=12)
        self.assertEqual(duration, 4)
        self.assertEqual(reference["events"][0]["midi"], [60, 64, 67])
        self.assertEqual([event["beat"] for event in reference["events"]], [12, 14, 15])
        self.assertEqual([event["position"] for event in reference["events"]], [3, 3.5, 3.75])

    def test_complete_tie_merges_without_second_attack(self):
        body = '<measure>' + note("C", 4, '<tie type="start"/>') + '</measure>'
        body += '<measure>' + note("C", 1, '<tie type="stop"/>') + note("D") + note("E") + note("F") + '</measure>'
        reference, duration = parse_reference(score(body))
        self.assertEqual(reference["events"][0]["durationBeats"], 5)
        self.assertEqual([event["beat"] for event in reference["events"]], [0, 5, 6, 7])
        self.assertEqual(duration, 8)

    def test_partial_page_tie_rejected(self):
        for kind in ("start", "stop"):
            with self.assertRaisesRegex(RecognitionError, "跨页"):
                parse_reference(score('<measure>' + note("C", 1, f'<tie type="{kind}"/>') + note("D") + note("E") + '</measure>'))

    def test_repeat_jump_empty_and_corrupt_timing_rejected(self):
        for content in ('<barline><repeat direction="backward"/></barline>', '<direction><sound dacapo="yes"/></direction>', '<direction><direction-type><segno/></direction-type></direction>'):
            with self.assertRaisesRegex(RecognitionError, "反复|跳转"):
                parse_reference(score('<measure>' + content + note() + note("D") + note("E") + '</measure>'))
        with self.assertRaises(RecognitionError):
            parse_reference(score('<measure><note><rest/><duration>4</duration></note></measure>'))
        with self.assertRaises(RecognitionError):
            parse_reference(score('<measure><attributes><divisions>0</divisions></attributes>' + note() + '</measure>'))

    def test_external_entities_and_nan_rejected(self):
        with self.assertRaises(RecognitionError):
            parse_reference(b'<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><score-partwise/>')
        with self.assertRaises(RecognitionError):
            parse_reference(score('<measure>' + note(duration="NaN") + '</measure>'))


class RequestBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        conn.request(method, path, body, headers or {})
        result = conn.getresponse()
        response = result.status, json.loads(result.read())
        conn.close()
        return response

    def test_health_and_foreign_origin(self):
        status, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["service"], "suixian-omr")
        self.assertEqual(self.request("POST", "/api/recognize", "{}", {"Content-Type": "application/json", "Origin": "https://foreign.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/health", headers={"Host": "foreign.example"})[0], 403)

    def test_content_type_and_bad_json(self):
        self.assertEqual(self.request("POST", "/api/recognize", "{}", {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/api/recognize", "bad", {"Content-Type": "application/json"})[0], 422)

    def test_image_signature_and_url_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for src in ("https://foreign.example/score.png", "data:image/png;base64," + base64.b64encode(b"invalid image" * 8).decode()):
                with self.assertRaises(RecognitionError):
                    decode_page({"src": src}, Path(directory) / "page")

    def test_cancel_terminates_child_and_releases_process_registry(self):
        started = time.monotonic()
        REQUEST.disconnected = lambda: time.monotonic() - started > .25
        try:
            with self.assertRaises(RecognitionCancelled):
                run_local([sys.executable, "-c", "import time;time.sleep(30)"], timeout=10)
        finally:
            REQUEST.disconnected = None
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse(CHILDREN)


@unittest.skipUnless(shutil.which("tesseract") and sys.platform == "darwin", "local macOS Tesseract required")
class TabTests(unittest.TestCase):
    def test_real_tab_ocr_matches_independent_expected_pitches(self):
        with tempfile.TemporaryDirectory() as directory:
            reference, duration = recognize_tab(FIXTURES / "standard-tab.png", Path(directory), 2, 16)
        actual = [event["midi"][0] for event in reference["events"]]
        expected = json.loads((FIXTURES / "standard-tab-expected.json").read_text())["midi"]
        self.assertEqual(actual, expected)
        self.assertEqual(duration, 16)
        self.assertTrue(all(2 <= event["position"] < 3 for event in reference["events"]))
        # Independently specified source layout: two systems, eight columns at
        # 160 + 180 * column px, staff lines at 120..260 and 420..560 px.
        for index, event in enumerate(reference["events"]):
            cursor = event['cursor']
            self.assertEqual(cursor['system'], index // 8)
            self.assertAlmostEqual(cursor['x'] * 1600, 160 + 180 * (index % 8), delta=5)
            self.assertLess(cursor['y'] * 700, 120 + 300 * (index // 8))
            self.assertGreater((cursor['y'] + cursor['height']) * 700, 260 + 300 * (index // 8))


class NativeGeometryTests(unittest.TestCase):
    def archive(self, source):
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr('sheet#1/sheet#1.xml', source)
        return output.getvalue()

    def native_system(self, system, top, x):
        lines = ''.join(f'<line><point x="10" y="{top + i * 10}"/><point x="900" y="{top + i * 10}"/></line>' for i in range(5))
        return f'''<system id="{system}">
          <stack id="{system}" duration="1" expected="1"><slot id="1" time-offset="1/4"/></stack>
          <part><staff><lines>{lines}</lines></staff><measure id="{system}">
            <voice><slots><entry><key>1</key><value chord="10" status="BEGIN"/></entry></slots></voice>
          </measure></part><sig><inters><head id="20"><bounds x="{x - 5}" y="{top + 12}" w="10" h="8"/></head></inters>
          <relations><relation source="10" target="20"><containment/></relation></relations></sig>
        </system>'''

    def test_original_bounds_and_systems_with_rational_slot_times(self):
        source = '<sheet><picture width="1000" height="800"/><scale><interline main="10"/></scale><page>'
        source += self.native_system(1, 100, 250) + self.native_system(2, 400, 600) + '</page></sheet>'
        result = read_cursor_geometry(self.archive(source), (1000, 800))
        self.assertEqual(len(result), 2)
        for index, x in enumerate((.25, .6)):
            cursor = result[index]['cursors'][1]
            self.assertEqual(cursor['x'], x)
            self.assertEqual(cursor['system'], index)
            self.assertAlmostEqual(cursor['height'] * 800, 54)
        self.assertIsNone(read_cursor_geometry(self.archive(source), (800, 1000)))
        self.assertIsNone(read_cursor_geometry(b'invalid archive', (1000, 800)))

    def test_missing_native_note_associations_omit_cursor(self):
        source = '<sheet><picture width="1000" height="800"/><scale><interline main="10"/></scale><page>'
        source += self.native_system(1, 100, 250).replace('<containment/>', '') + '</page></sheet>'
        self.assertEqual(read_cursor_geometry(self.archive(source), (1000, 800))[0]['cursors'], {})


@unittest.skipUnless(os.getenv("SUIXIAN_OMR_INTEGRATION") == "1" and ready(), "set SUIXIAN_OMR_INTEGRATION=1 for actual Audiveris")
class AudiverisIntegrationTests(unittest.TestCase):
    def test_full_scan_cursor_moves_to_original_three_systems(self):
        data = base64.b64encode((FIXTURES / 'cucaracha.png').read_bytes()).decode()
        events = recognize({"pages": [{"src": "data:image/png;base64," + data}]})['reference']['events']
        self.assertTrue(all('cursor' in event for event in events))
        self.assertEqual(sorted({event['cursor']['system'] for event in events}), [0, 1, 2])
        # The original printed page has five bars in system 1, six in system 2.
        # Its following first attacks are visibly around x=280, y=922/1510 px.
        for beat, system, top in ((0, 0, 320), (15, 1, 908), (33, 2, 1493)):
            cursor = next(event['cursor'] for event in events if event['beat'] == beat)
            self.assertEqual(cursor['system'], system)
            self.assertAlmostEqual(cursor['y'] * 1984, top, delta=20)
            if system:
                self.assertAlmostEqual(cursor['x'] * 2520, 280, delta=20)

    def test_public_printed_scan_matches_manually_transcribed_notes(self):
        data = base64.b64encode((FIXTURES / "cucaracha-first-system.png").read_bytes()).decode()
        result = recognize({"pages": [{"src": "data:image/png;base64," + data}]})
        expected = json.loads((FIXTURES / "cucaracha-expected.json").read_text())
        by_beat = {}
        for note_event in expected["notes"]:
            by_beat.setdefault(note_event["beat"], set()).update(note_event["midi"])
        actual = result["reference"]["events"]
        self.assertEqual(len(actual), len(by_beat))
        for event in actual:
            self.assertEqual(set(event["midi"]), by_beat[event["beat"]])
            self.assertEqual(event['cursor']['system'], 0)
            self.assertTrue(.36 < event['cursor']['y'] < .40)
            self.assertGreater(event['cursor']['y'] + event['cursor']['height'], .9)
        # Pixel anchors independently checked on the original scan, not MXL.
        for beat, expected_x in ((0, 438), (.5, 502), (3, 870), (12, 2021), (14.5, 2332)):
            event = next(event for event in actual if event['beat'] == beat)
            self.assertAlmostEqual(event['cursor']['x'] * 2520, expected_x, delta=15)
        self.assertEqual(result["engine"], "Audiveris 5.11.0")


if __name__ == "__main__":
    unittest.main()
