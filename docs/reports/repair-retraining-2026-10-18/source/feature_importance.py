"""Read-only production-tree reporting; never a dependency of inference."""
import hashlib
import json
import math
from pathlib import Path


def build_report(booster, cols, version, hashes):
    names = booster.feature_name()
    if len(cols) != len(set(cols)) or len(cols) != booster.num_feature():
        raise ValueError('duplicate names or feature count mismatch')
    if names != cols and names != [f'Column_{i}' for i in range(len(cols))]:
        raise ValueError('feature order mismatch')
    gain = list(booster.feature_importance(importance_type='gain', iteration=-1))
    split = list(booster.feature_importance(importance_type='split', iteration=-1))
    if len(gain) != len(cols) or len(split) != len(cols):
        raise ValueError('importance length mismatch')
    if any(not math.isfinite(float(v)) or v < 0 for v in gain + split):
        raise ValueError('nonfinite or negative importance')
    if any(float(v) != int(v) for v in split):
        raise ValueError('fractional split count')
    total_gain, total_split = math.fsum(gain), sum(int(v) for v in split)
    return {
        'schema': 1, 'modelVersion': version, 'featCols': list(cols),
        'scope': 'serialized-production-lgb-only', 'importanceIteration': -1,
        'numTrees': booster.num_trees(), 'sha256': hashes,
        'bundleFingerprint': hashlib.sha256((hashes['model.txt'] + hashes['meta.json']).encode()).hexdigest()[:24],
        'totals': {'gain': total_gain, 'split': total_split},
        'features': [{'index': i, 'name': name, 'gain': float(gain[i]), 'split': int(split[i]),
                      'gainPct': 100 * float(gain[i]) / total_gain if total_gain else 0.0,
                      'splitPct': 100 * int(split[i]) / total_split if total_split else 0.0}
                     for i, name in enumerate(cols)],
    }


def report_for_bundle(directory):
    import lightgbm as lgb
    d = Path(directory)
    meta = json.loads((d / 'meta.json').read_text())
    hashes = {f: hashlib.sha256((d / f).read_bytes()).hexdigest() for f in ['model.txt', 'meta.json']}
    booster = lgb.Booster(model_file=str(d / 'model.txt'))
    return build_report(booster, meta['featCols'], meta['modelVersion'], hashes)


def write_report(directory):
    d = Path(directory)
    report = report_for_bundle(d)
    tmp = d / 'feature-importance.json.tmp'
    try:
        tmp.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False))
        tmp.replace(d / 'feature-importance.json')
    finally:
        tmp.unlink(missing_ok=True)


def verify_report(directory):
    d = Path(directory)
    actual = json.loads((d / 'feature-importance.json').read_text())
    expected = report_for_bundle(d)
    if actual != expected:
        raise ValueError('feature importance differs from serialized model/metadata')
    return actual
