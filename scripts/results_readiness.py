"""Read-only scheduling evidence; unknown timing never suppresses missing results."""
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.request import Request, urlopen
HKT = timezone(timedelta(hours=8))

def pending_until(meeting, day, now):
    if meeting.get('date') != day or meeting.get('venue') not in ('ST', 'HV'):
        return None
    rows = meeting.get('races', [])
    count = meeting.get('totalRaces')
    if not rows or not isinstance(count, int) or len(rows) != count:
        return None
    numbers, starts = set(), []
    for row in rows:
        n = row.get('raceNumber')
        if not isinstance(n, int) or n in numbers or row.get('id') != f"race_{day}_{meeting['venue']}_{n}":
            return None
        text = row.get('startTime', '')
        if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', str(text)):
            return None
        numbers.add(n)
        starts.append(datetime.fromisoformat(day + 'T' + text).replace(tzinfo=HKT))
    if numbers != set(range(1, count + 1)):
        return None
    deadline = max(starts) + timedelta(minutes=30)
    return deadline if now.astimezone(HKT).date().isoformat() == day and now < deadline else None

def read_pending(day, now):
    try:
        with urlopen(Request('https://tianxi-backend.tianxi-entertainment.workers.dev/api/meetings/' + day, headers={'User-Agent': 'Mozilla/5.0 TianxiResultsReadiness/1.0'}), timeout=10) as response:
            return pending_until(json.load(response), day, now)
    except Exception:
        return None

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--day', required=True)
    args = parser.parse_args()
    now = datetime.now(HKT)
    deadline = read_pending(args.day, now)
    print('true' if deadline else 'false')
