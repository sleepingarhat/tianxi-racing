import importlib.util
import json
import gzip
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('track', Path(__file__).with_name('TrackCondition_Scraper.py'))
track = importlib.util.module_from_spec(spec)
spec.loader.exec_module(track)

def payload(p=None, h=None, grass=True):
    return {'data': {'commonMeetings': [{'date': '2026-10-25', 'venueCode': 'ST',
        'races': [{'go_ch': '好地', 'raceTrack': {'code': 'TURF' if grass else 'AWT'}}],
        'penetrometerReadings': p or [], 'hammerReadings': h or [], 'course': {'chinese': 'A'}}]}}

class TrackTests(unittest.TestCase):
    def test_gzip_official_response(self):
        raw = json.dumps(payload()).encode()
        self.assertEqual(track.decoded_response(gzip.compress(raw), 'gzip'), raw)

    def test_pending_not_zero(self):
        row = track.build_rows(payload(), '2026-10-25T00:00:00Z')[0]
        self.assertEqual(row['penetrometer_reading'], '')
        self.assertEqual(row['clegg_hammer_reading'], '')

    def test_preserve_all_readings(self):
        row = track.build_rows(payload([{'reading': 2.7, 'readingTime': '09:00'}, {'reading': 2.8, 'readingTime': '10:00'}], [{'reading': 9.1, 'readingTime': '09:00'}]), 'x')[0]
        self.assertEqual(row['penetrometer_reading'], '2.7 | 2.8')
        self.assertEqual(row['penetrometer_time'], '09:00 | 10:00')
        self.assertEqual(row['clegg_hammer_reading'], '9.1')

    def test_all_weather_not_grass_reading(self):
        row = track.build_rows(payload([{'reading': 2.7}], grass=False), 'x')[0]
        self.assertEqual(row['penetrometer_reading'], '')
        self.assertEqual(row['going'], '')

    def test_error_is_failure(self):
        with self.assertRaises(ValueError):
            track.build_rows({'errors': [{'message': 'WHITELIST_ERROR'}]}, 'x')

    def test_requested_date_no_fallback(self):
        with self.assertRaises(ValueError):
            track.build_rows(payload(), 'x', '2026-10-21')

    def test_duplicate_identity_rejected(self):
        body = payload()
        body['data']['commonMeetings'] *= 2
        with self.assertRaises(ValueError):
            track.build_rows(body, 'x')

    def test_append_and_one_day_projection(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            raw = json.dumps(payload()).encode()
            track.archive(base, raw, '2026-10-25T00:00:00Z')
            original = (base / 'manifest.jsonl').read_bytes()
            self.assertEqual(track.archive(base, raw, '2026-10-25T00:01:00Z')['saved'], 0)
            track.archive(base, json.dumps(payload([{'reading': 2.7}])).encode(), '2026-10-25T00:02:00Z')
            self.assertTrue((base / 'manifest.jsonl').read_bytes().startswith(original))
            self.assertEqual(len((base / 'track_conditions.csv').read_text().splitlines()), 2)
            self.assertEqual(len(track.records(base)), 2)

    def test_corruption_blocks_projection(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            track.archive(base, json.dumps(payload()).encode(), '2026-10-25T00:00:00Z')
            entry = track.records(base)[0]
            (base / entry['raw_file']).write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                track.archive(base, json.dumps(payload()).encode(), '2026-10-25T00:01:00Z')

    def test_no_later_capture_as_pre_race(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            track.archive(base, json.dumps(payload([{'reading': 2.7, 'readingTime': '2026-10-25T09:00:00+08:00'}])).encode(), '2026-10-25T02:00:00Z')
            self.assertIsNone(track.rows_as_of(base, '2026-10-25', 'ST', '2026-10-25T01:00:00Z'))
            self.assertEqual(track.rows_as_of(base, '2026-10-25', 'ST', '2026-10-25T03:00:00Z')['penetrometer_reading'], '2.7')

    def test_unknown_official_time_not_pre_race(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            track.archive(base, json.dumps(payload([{'reading': 2.7, 'readingTime': '09:00'}])).encode(), '2026-10-25T00:00:00Z')
            self.assertEqual(track.rows_as_of(base, '2026-10-25', 'ST', '2026-10-25T03:00:00Z')['penetrometer_reading'], '')

if __name__ == '__main__':
    unittest.main()