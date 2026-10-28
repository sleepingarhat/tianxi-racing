"""Validate every daily candidate independently, retaining yesterday when today is pending."""
import csv, subprocess, sys
from datetime import datetime, timedelta
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fixture_guard import is_race_day
from results_readiness import HKT, read_pending

def candidate_days(explicit, now):
    if explicit:
        return [datetime.strptime(d.strip(),'%Y-%m-%d').date() for d in explicit.split(',')]
    today = now.astimezone(HKT).date()
    return [d for d in (today,today-timedelta(days=1)) if is_race_day(d)]

def main(explicit):
    now = datetime.now(HKT)
    for day in candidate_days(explicit,now):
        deadline = read_pending(day.isoformat(),now)
        if deadline:
            print(f'Results pending: {day} until {deadline.isoformat()}')
            continue
        base = Path('data')/str(day.year)
        files = sorted(set(base.glob(f'results_{day}.csv')) | set(base.glob(f'results_{day}_*.csv')))
        if not files:
            raise RuntimeError(f'No results CSV for {day}')
        rows = 0
        for file in files:
            subprocess.run([sys.executable,'scripts/ci/assert_csv_schema.py','--csv',str(file),'--kind','results','--min-rows','40','--min-races','1'],check=True)
            with file.open(encoding='utf-8-sig') as handle: rows += sum(1 for _ in csv.DictReader(handle))
        subprocess.run(['bash','scripts/ci/assert_collected_rows.sh',str(rows),str(day)],check=True)
        for file in sorted(set(base.glob(f'dividends_{day}.csv')) | set(base.glob(f'dividends_{day}_*.csv'))):
            result = subprocess.run([sys.executable,'scripts/ci/assert_csv_schema.py','--csv',str(file),'--kind','dividends','--min-rows','20','--min-races','1'])
            if result.returncode: print(f'::warning::Dividends schema not verified: {file}')
        subprocess.run([sys.executable,'scripts/ci/job_ticks.py','record','--job','capy_race_daily','--status','ok','--meta',f'date={day}','--meta',f'rows={rows}'],check=True)
if __name__=='__main__': main(sys.argv[1] if len(sys.argv)>1 else '')
