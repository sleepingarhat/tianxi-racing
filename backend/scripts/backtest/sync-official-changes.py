"""Read the authoritative data-repo change manifest, validate every raw SHA, no prediction writes."""
import hashlib,json,os,urllib.request
from pathlib import Path

def download(path):
    req=urllib.request.Request('https://api.github.com/repos/sleepingarhat/tianxi-database/contents/'+path,
        headers={'Authorization':'Bearer '+os.environ['GITHUB_TOKEN'],'Accept':'application/vnd.github.raw+json'})
    with urllib.request.urlopen(req,timeout=30) as r:return r.read()

def main():
    manifest=json.loads(download('data/racing-changes/manifest.json'))
    snapshots=[]
    for row in manifest['snapshots']:
        p=row['path']
        if not p.startswith('data/racing-changes/') or '..' in p:raise ValueError('invalid event path')
        raw=download(p).decode('utf-8')
        if hashlib.sha256(raw.encode()).hexdigest()!=row['sha256']:raise ValueError('official event SHA mismatch')
        snapshots.append({**row,'rawHtml':raw})
    Path('official-changes-manifest.json').write_text(json.dumps({'snapshots':snapshots},ensure_ascii=False))
if __name__=='__main__':main()
