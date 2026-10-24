#!/usr/bin/env python3
"""Research-only HKJC going evidence. No D1/model/freeze writes."""
import argparse
import csv
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import re
from urllib.request import Request, urlopen
from datetime import datetime, timezone

SOURCE = 'https://info.cld.hkjc.com/graphql/base/'
COLUMNS = ['race_date', 'venue', 'going', 'penetrometer_reading', 'penetrometer_time',
           'clegg_hammer_reading', 'clegg_hammer_time', 'rail_note', 'scraped_at']

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def decoded_response(raw, encoding=''):
    if encoding == 'gzip' or raw.startswith(b'\x1f\x8b'):
        return gzip.decompress(raw)
    if encoding not in ('', 'identity'):
        raise ValueError('unsupported official content encoding')
    return raw

def reading(values):
    if not isinstance(values, list):
        raise ValueError('missing official readings array')
    # Preserve every official sequence/time, never guess a latest/average reading.
    numbers, times = [], []
    for v in values:
        if not isinstance(v, dict):
            raise ValueError('invalid reading')
        value = v.get('reading')
        time = v.get('readingTime')
        if value is None or str(value).strip() == '':
            continue
        numbers.append(str(value))
        times.append('' if time is None else str(time))
    return ' | '.join(numbers), ' | '.join(times)

def build_rows(body, captured, race_date='', venue=''):
    if body.get('errors') or not isinstance(body.get('data', {}).get('commonMeetings'), list):
        raise ValueError('official response incomplete')
    rows, keys = [], set()
    for m in body['data']['commonMeetings']:
        d, v = m.get('date'), m.get('venueCode')
        if not isinstance(d, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', d) or v not in ('ST', 'HV'):
            raise ValueError('unverified local meeting identity')
        datetime.strptime(d, '%Y-%m-%d')
        if (race_date and race_date != d) or (venue and venue != v):
            continue
        if (d, v) in keys:
            raise ValueError('duplicate meeting identity')
        keys.add((d, v))
        races = m.get('races')
        if not isinstance(races, list) or not races:
            raise ValueError('missing official races')
        # Grass readings do not describe all-weather races in a mixed meeting.
        grass = [r for r in races if r.get('raceTrack', {}).get('code') == 'TURF']
        going = list(dict.fromkeys(r['go_ch'] for r in grass if r.get('go_ch')))
        p, pt = reading(m.get('penetrometerReadings'))
        h, ht = reading(m.get('hammerReadings'))
        if not grass:
            p = pt = h = ht = ''
        rows.append(dict(zip(COLUMNS, [d, v, ' / '.join(going), p, pt, h, ht,
                    (m.get('course') or {}).get('chinese') or '', captured])))
    if (race_date or venue) and not rows:
        raise ValueError('requested meeting absent; no historical fallback')
    return rows

def csv_bytes(rows):
    out = io.StringIO(newline='')
    w = csv.DictWriter(out, fieldnames=COLUMNS, lineterminator='\n')
    w.writeheader()
    w.writerows(sorted(rows, key=lambda r: (r['race_date'], r['venue'])))
    return ('\ufeff' + out.getvalue()).encode('utf-8')

def records(base):
    manifest = base / 'manifest.jsonl'
    entries = [json.loads(l) for l in manifest.read_text().splitlines() if l] if manifest.exists() else []
    for e in entries:
        for field, digest in [('raw_file', 'raw_sha256'), ('csv_file', 'csv_sha256')]:
            path = Path(e[field])
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('unsafe manifest path')
            if sha((base / path).read_bytes()) != e[digest]:
                raise ValueError('archive SHA mismatch')
    return entries

def project(base, entries):
    latest = {}
    # Manifest is append-only chronological captures, not an original lock record.
    for e in entries:
        for row in csv.DictReader(io.StringIO((base / e['csv_file']).read_text(encoding='utf-8-sig'))):
            latest[(row['race_date'], row['venue'])] = row
    target = base / 'track_conditions.csv'
    tmp = base / '.projection.tmp'
    tmp.write_bytes(csv_bytes(list(latest.values())))
    os.replace(tmp, target)

def archive(base, raw, captured, race_date='', venue=''):
    rows = build_rows(json.loads(raw), captured, race_date, venue)
    base.mkdir(parents=True, exist_ok=True)
    entries = records(base)
    digest = sha(raw)
    content = sha(json.dumps([{k: v for k, v in r.items() if k != 'scraped_at'} for r in rows], sort_keys=True).encode())
    if entries and entries[-1]['raw_sha256'] == digest and entries[-1]['content_sha256'] == content:
        project(base, entries)
        return {'saved': 0, 'skipped': 'unchanged'}
    if not rows:
        return {'saved': 0, 'skipped': 'official empty meeting list'}
    stamp = re.sub(r'[^0-9]', '', captured)
    folder = Path('snapshots') / (stamp + '_' + digest[:16])
    (base / folder).mkdir(parents=True, exist_ok=True)
    raw_file, csv_file = folder / 'official.json', folder / 'readings.csv'
    data = csv_bytes(rows)
    for path, value in [(raw_file, raw), (csv_file, data)]:
        with (base / path).open('xb') as f:
            f.write(value)
    entry = {'raw_file': raw_file.as_posix(), 'csv_file': csv_file.as_posix(),
             'raw_sha256': digest, 'csv_sha256': sha(data), 'content_sha256': content,
             'scraped_at': captured, 'rows': len(rows), 'source': SOURCE, 'research_only': True}
    with (base / 'manifest.jsonl').open('a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    project(base, entries + [entry])
    return {'saved': len(rows), 'readings_pending': sum(not r['penetrometer_reading'] and not r['clegg_hammer_reading'] for r in rows)}

def rows_as_of(base, race_date, venue, cutoff):
    """Research readers must use capture AND official reading time before cutoff."""
    limit = datetime.fromisoformat(cutoff.replace('Z', '+00:00'))
    found = None
    for e in records(base):
        if datetime.fromisoformat(e['scraped_at'].replace('Z', '+00:00')) > limit:
            continue
        for row in csv.DictReader(io.StringIO((base / e['csv_file']).read_text(encoding='utf-8-sig'))):
            if row['race_date'] == race_date and row['venue'] == venue:
                found = row
    if found is None:
        return None
    # Unknown/undated timestamps cannot certify a pre-race numeric feature.
    for value, time in [('penetrometer_reading', 'penetrometer_time'), ('clegg_hammer_reading', 'clegg_hammer_time')]:
        valid = bool(found[time])
        for t in found[time].split(' | '):
            try:
                official = datetime.fromisoformat(t.replace('Z', '+00:00'))
                valid = valid and official.tzinfo is not None and official <= limit
            except ValueError:
                valid = False
        if not valid:
            found[value] = found[time] = ''
    return found

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', default='.')
    p.add_argument('--date', default='')
    p.add_argument('--venue', default='', choices=['', 'ST', 'HV'])
    args = p.parse_args()
    if args.date:
        datetime.strptime(args.date, '%Y-%m-%d')
    query = Path(__file__).with_name('hkjc-track-condition-query.graphql').read_text()
    payload = json.dumps({'query': query, 'variables': {'localSim': 'LOCAL', 'status':
                        ['DECLARED', 'DEFINED', 'STARTED', 'CLOSED', 'ABANDON_PARTIAL', 'ABANDON']}}).encode()
    req = Request(SOURCE, data=payload, headers={'Content-Type': 'application/json',
                  'Origin': 'https://racing.hkjc.com', 'Referer': 'https://racing.hkjc.com/'})
    with urlopen(req, timeout=30) as response:
        raw = decoded_response(response.read(), response.headers.get('Content-Encoding', ''))
    captured = datetime.now(timezone.utc).isoformat()
    print(json.dumps(archive(Path(args.root) / 'data/track_conditions', raw, captured, args.date, args.venue)))

if __name__ == '__main__':
    main()