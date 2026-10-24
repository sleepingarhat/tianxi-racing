#!/usr/bin/env python3
"""Versioned post-race research evidence; never a production model input."""
import argparse
import csv
from datetime import datetime, timedelta, timezone
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

SOURCE = 'https://racing.hkjc.com/zh-hk/local/information/racereportfull'
COLUMNS = ['race_date', 'venue', 'race_no', 'horse_no', 'horse_id', 'horse_code',
           'horse_name', 'placing_raw', 'jockey_raw', 'incident_text', 'penalty',
           'veterinary_note', 'scraped_at', 'source_url', 'source_sha256', 'research_only']
EXTRA_COLUMNS = ['race_date', 'venue', 'section_title', 'report_text', 'horse_id',
                 'identity_status', 'scraped_at', 'source_url', 'source_sha256']

class ReportUnavailable(ValueError):
    pass

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def text(node):
    return node.get_text(' ', strip=True) if node else ''

def csv_bytes(rows, columns):
    stream = io.StringIO(newline='')
    writer = csv.DictWriter(stream, fieldnames=columns, lineterminator='\n')
    writer.writeheader()
    writer.writerows(rows)
    return ('\ufeff' + stream.getvalue()).encode()

def quoted_sentences(narrative, keywords):
    # Literal source quotes only; no inferred diagnosis, penalty target or outcome.
    sentences = re.findall(r'[^。！？]+[。！？]?', narrative)
    return ' '.join(s.strip() for s in sentences if any(k in s for k in keywords))

def parse_report(raw, date, venue, captured, expected_races=None):
    datetime.strptime(date, '%Y-%m-%d')
    if venue not in ('ST', 'HV'):
        raise ValueError('invalid requested venue')
    soup = BeautifulSoup(raw, 'html.parser')
    selected = soup.select('#selects option[selected]')
    if not selected and not soup.select('table.rirr') and '沒有相關資料。' in soup.get_text():
        raise ReportUnavailable('official explicitly has no report; pending/unavailable, not no-event evidence')
    if len(selected) != 1 or selected[0].get('value') != date.replace('-', '/'):
        offered = {o.get('value') for o in soup.select('#selects option')}
        if date.replace('-', '/') not in offered and selected:
            raise ReportUnavailable('requested official report not published/available; fallback rejected')
        raise ValueError('selected report date mismatch')
    explicit = soup.find(string=re.compile(r'賽事日期\s*:'))
    expected_display = datetime.strptime(date, '%Y-%m-%d').strftime('%d/%m/%Y')
    if not explicit or expected_display not in str(explicit):
        raise ValueError('report heading date mismatch')
    course_links = soup.select('a[href$="/page/racing-course"]')
    courses = {text(a).split('-')[0].strip() for a in course_links if re.match(r'^(沙田|跑馬地)\s*-', text(a))}
    label = '沙田' if venue == 'ST' else '跑馬地'
    if courses != {label}:
        raise ValueError('report venue mismatch')
    tables = soup.select('table.rirr')
    if not tables:
        raise ValueError('missing incident tables; cannot infer no incidents')
    rows, race_numbers, identities = [], set(), set()
    url = SOURCE + '?' + urlencode({'Date': date.replace('-', '/')})
    digest = sha(raw)
    for table in tables:
        heading = table.find_previous_sibling('p')
        match = re.search(r'第\s*(\d+)\s*場', text(heading))
        if not match:
            raise ValueError('missing adjacent official race heading')
        race = int(match[1])
        if race in race_numbers or not 1 <= race <= 14:
            raise ValueError('duplicate/invalid race heading')
        race_numbers.add(race)
        header = [text(c) for c in table.select('thead tr td')]
        if header != ['名次', '馬號', '綵衣', '馬名', '檔位', '騎師', '競賽事件']:
            raise ValueError('unexpected report columns')
        horse_rows = table.select('tbody > tr')
        if not horse_rows:
            raise ValueError('empty race report')
        for tr in horse_rows:
            cells = tr.find_all('td', recursive=False)
            if len(cells) != 7:
                raise ValueError('unexpected horse row shape')
            links = cells[3].select('a[href]')
            if len(links) != 1:
                raise ValueError('missing unique official horse link')
            ids = parse_qs(urlparse(links[0]['href']).query).get('horseid', [])
            if len(ids) != 1 or not re.fullmatch(r'HK_\d{4}_[A-Z]\d{3}', ids[0]):
                raise ValueError('unverified horse identity')
            hid = ids[0]
            code = hid.rsplit('_', 1)[-1]
            suffix = re.search(r'\(([A-Z]\d{3})\)', text(cells[3]))
            if not suffix or suffix[1] != code:
                raise ValueError('horse link/name code mismatch')
            number = text(cells[1])
            if number and (not number.isdigit() or not 1 <= int(number) <= 30):
                raise ValueError('invalid horse number')
            # Unnumbered withdrawn originals remain linked by real horse ID, never slot.
            identity = (race, hid)
            if identity in identities:
                raise ValueError('duplicate horse row')
            identities.add(identity)
            narrative = text(cells[6])
            if not narrative:
                raise ValueError('empty incident is not evidence of no report')
            row = dict(zip(COLUMNS, [date, venue, race, number, hid, code, text(links[0]),
                         text(cells[0]), text(cells[5]), narrative,
                         quoted_sentences(narrative, ['停賽', '罰款', '譴責', '判罰']),
                         quoted_sentences(narrative, ['獸醫', '流鼻血', '心律', '不良於行', '試閘及格']),
                         captured, url, digest, 'true']))
            rows.append(row)
    if expected_races is not None and race_numbers != set(expected_races):
        raise ValueError('report race coverage differs from stored official results')
    if race_numbers != set(range(1, max(race_numbers) + 1)):
        raise ValueError('incomplete report race sequence')
    extras = []
    # General includes additions about EARLIER meetings, laboratory results and
    # later veterinary notes. Report date/venue here identify publication page,
    # NOT the referred race; no name-only linkage or invented publication time.
    for section in soup.select('.other > div'):
        parts = section.find_all('p', recursive=False)
        if len(parts) < 2:
            raise ValueError('unreadable general/additional report section')
        extras.append(dict(zip(EXTRA_COLUMNS, [date, venue, text(parts[0]),
                           '\n'.join(p.get_text('\n', strip=True) for p in parts[1:]), '',
                           'unassigned_source_section', captured, url, digest])))
    # Save labelled additional sections without guessing horse/race from narrative names.
    for title in soup.find_all(['p', 'h2', 'h3', 'h4', 'div']):
        label_text = text(title)
        if not re.fullmatch(r'(?:補充|額外|附加).{0,12}獸醫報告[:：]?', label_text):
            continue
        pieces = []
        for sibling in title.next_siblings:
            if getattr(sibling, 'name', None) in ('h2', 'h3', 'h4'):
                break
            if hasattr(sibling, 'get_text'):
                value = text(sibling)
                if value:
                    pieces.append(value)
        extras.append(dict(zip(EXTRA_COLUMNS, [date, venue, label_text, '\n'.join(pieces), '',
                           'unassigned_source_section', captured, url, digest])))
    return sorted(rows, key=lambda r: (int(r['race_no']), r['horse_id'])), extras

def read_manifest(base):
    p = base / 'manifest.jsonl'
    entries = [json.loads(line) for line in p.read_text().splitlines() if line] if p.exists() else []
    for entry in entries:
        for item in entry['files']:
            path = Path(item['path'])
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('unsafe archive path')
            if sha((base / path).read_bytes()) != item['sha256']:
                raise ValueError('source/archive SHA mismatch')
    return entries

def archive(base, raw, date, venue, captured, expected_races=None):
    # Parse and identity-check BEFORE creating files: fallback pages never become certified evidence.
    rows, extras = parse_report(raw, date, venue, captured, expected_races)
    base.mkdir(parents=True, exist_ok=True)
    entries = read_manifest(base)
    digest = sha(raw)
    content = sha(json.dumps([{k: v for k, v in r.items() if k not in ('scraped_at', 'source_sha256')} for r in rows] +
                            [{k: v for k, v in r.items() if k not in ('scraped_at', 'source_sha256')} for r in extras],
                            sort_keys=True, ensure_ascii=False).encode())
    prior = [e for e in entries if (e['race_date'], e['venue']) == (date, venue)]
    if prior and prior[-1]['source_sha256'] == digest:
        return {'saved': 0, 'skipped': 'unchanged', 'rows': len(rows)}
    folder = Path('snapshots') / (date + '_' + venue) / (re.sub(r'[^0-9]', '', captured) + '_' + digest[:16])
    (base / folder).mkdir(parents=True, exist_ok=True)
    files = []
    for name, data in [('official.html', raw), ('incidents.csv', csv_bytes(rows, COLUMNS)),
                       ('additional_sections.csv', csv_bytes(extras, EXTRA_COLUMNS))]:
        path = folder / name
        with (base / path).open('xb') as f:
            f.write(data)
        files.append({'path': path.as_posix(), 'sha256': sha(data)})
    entry = {'race_date': date, 'venue': venue, 'scraped_at': captured, 'source_url': rows[0]['source_url'],
             'source_sha256': digest, 'content_sha256': content, 'files': files, 'rows': len(rows),
             'races': len({r['race_no'] for r in rows}), 'additional_sections': len(extras),
             'research_only': True, 'post_race': True, 'official_published_at': None,
             'narrative_changed': bool(prior and prior[-1]['content_sha256'] != content)}
    with (base / 'manifest.jsonl').open('a') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    return {'saved': len(rows), 'races': entry['races'], 'veterinary_quotes': sum(bool(r['veterinary_note']) for r in rows),
            'additional_sections': len(extras), 'narrative_changed': entry['narrative_changed']}

def research_as_of(base, horse_id, target_date, cutoff):
    limit = datetime.fromisoformat(cutoff.replace('Z', '+00:00'))
    if limit.tzinfo is None:
        raise ValueError('research cutoff requires timezone')
    latest = {}
    for entry in read_manifest(base):
        # A later collection of an old report is not proof it was available earlier.
        if entry['race_date'] >= target_date or datetime.fromisoformat(entry['scraped_at']) > limit:
            continue
        file = next(f for f in entry['files'] if f['path'].endswith('/incidents.csv'))
        for row in csv.DictReader(io.StringIO((base / file['path']).read_text(encoding='utf-8-sig'))):
            if row['horse_id'] == horse_id:
                latest[(row['race_date'], row['venue'], row['race_no'], horse_id)] = row
    return list(latest.values())

def targets(root, explicit='', days=30, now=None):
    now = now or datetime.now(timezone(timedelta(hours=8))).date()
    fixture = root / 'data/fixtures/fixtures.csv'
    if not fixture.exists():
        raise ValueError('fixture cache unavailable')
    with fixture.open(encoding='utf-8-sig') as f:
        dates = {r['date'] for r in csv.DictReader(f)}
    if explicit:
        datetime.strptime(explicit, '%Y-%m-%d')
        if explicit not in dates:
            raise ValueError('requested date not in official fixture cache')
        selected = [explicit]
    else:
        selected = sorted(d for d in dates if (now - timedelta(days=days)).isoformat() <= d <= now.isoformat())
    result = []
    for date in selected:
        path = root / 'data' / date[:4] / ('results_' + date + '.csv')
        if not path.exists():
            if explicit:
                raise ReportUnavailable('official results not collected yet; report pending')
            continue
        with path.open(encoding='utf-8-sig') as f:
            rows = list(csv.DictReader(f))
        labels = {r['venue'] for r in rows}
        if not rows or labels not in ({'沙田'}, {'跑馬地'}) or {r['date'] for r in rows} != {date}:
            raise ValueError('stored results identity incomplete')
        races = {int(r['race_no']) for r in rows}
        result.append((date, 'ST' if labels == {'沙田'} else 'HV', races))
    return result

def fetch_report(date):
    url = SOURCE + '?' + urlencode({'Date': date.replace('-', '/')})
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-HK'})
    with urlopen(request, timeout=35) as response:
        raw = response.read()
        encoding = response.headers.get('Content-Encoding', '')
        if encoding == 'gzip' or raw.startswith(b'\x1f\x8b'):
            raw = gzip.decompress(raw)
        elif encoding not in ('', 'identity'):
            raise ValueError('unsupported source encoding')
        return raw

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--root', default='.')
    p.add_argument('--date', default='')
    p.add_argument('--days', type=int, default=30)
    args = p.parse_args()
    if not 1 <= args.days <= 90:
        raise ValueError('research refresh days must be 1..90')
    root = Path(args.root)
    jobs = targets(root, args.date, args.days)
    failed = []
    if not jobs:
        print(json.dumps({'skipped': 'no collected fixture results in refresh window'}))
    for date, venue, races in jobs:
        try:
            output = archive(root / 'data/incidents', fetch_report(date), date, venue,
                             datetime.now(timezone.utc).isoformat(), races)
            print(json.dumps({'date': date, 'venue': venue, **output}))
        except ReportUnavailable as error:
            # Pending is not successful no-event evidence. Retry on every refresh.
            print(json.dumps({'date': date, 'venue': venue, 'pending': str(error)}))
        except Exception as error:
            failed.append((date, venue, str(error)))
    if failed:
        raise RuntimeError('research collection failed: ' + json.dumps(failed))

if __name__ == '__main__':
    main()