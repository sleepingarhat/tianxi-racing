import importlib.util, pathlib, sys
import pandas as pd, pytest

P = pathlib.Path(__file__).resolve().parents[1] / 'scripts/backtest/predict_upcoming.py'

def load():
    spec = importlib.util.spec_from_file_location('pu', P)
    m = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(m)
    except ImportError as e:
        pytest.skip(f'optional dependency missing: {e}')
    return m

def test_valid_positions_map_to_grades():
    m = load()
    out = m.make_graded_label(pd.DataFrame({'finishing_position': [1, 2, 3, 4, 5, 14]}))
    assert out.tolist() == [4, 3, 2, 1, 0, 0]

@pytest.mark.parametrize('bad', [999, 0, None, 'WV', 99])
def test_withdrawn_or_nonfinisher_fails_closed(bad):
    m = load()
    with pytest.raises(ValueError):
        m.make_graded_label(pd.DataFrame({'finishing_position': [1, bad]}))
