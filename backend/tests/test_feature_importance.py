import unittest, sys, tempfile, json, hashlib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/backtest'))
from feature_importance import build_report, write_report, verify_report

class Fake:
    def __init__(self, gain=(3, 1, 0), split=(1, 3, 0), names=None):
        self.gain, self.split, self.names = gain, split, names
    def feature_name(self): return self.names or ['Column_0','Column_1','Column_2']
    def num_feature(self): return 3
    def num_trees(self): return 4
    def feature_importance(self, importance_type, iteration):
        assert iteration == -1
        return self.gain if importance_type == 'gain' else self.split

class ImportanceTest(unittest.TestCase):
    def report(self, booster):
        return build_report(booster,['z','a','unused'],'version',{'model.txt':'a'*64,'meta.json':'b'*64})
    def test_gain_and_split_independent(self):
        r=self.report(Fake());self.assertEqual([x['name'] for x in r['features']],['z','a','unused'])
        self.assertEqual([x['gainPct'] for x in r['features']],[75,25,0])
        self.assertEqual([x['splitPct'] for x in r['features']],[25,75,0])
    def test_zero_totals(self):
        r=self.report(Fake((0,0,0),(0,0,0)));self.assertEqual(sum(x['gainPct'] for x in r['features']),0)
    def test_reject_bad_values(self):
        for bad in [(-1,1,0),(float('nan'),1,0),(float('inf'),1,0)]:
            with self.assertRaises(ValueError): self.report(Fake(gain=bad))
        with self.assertRaises(ValueError): self.report(Fake(split=(1.5,2,0)))
    def test_reject_order_and_lengths(self):
        with self.assertRaises(ValueError): self.report(Fake(names=['a','z','unused']))
        with self.assertRaises(ValueError): self.report(Fake(gain=(3,1)))
    def test_exact_saved_booster_and_tampering(self):
        import lightgbm as lgb, numpy as np
        with tempfile.TemporaryDirectory() as tmp:
            d=Path(tmp);X=np.array([[i%4,i//4,0] for i in range(40)],float)
            model=lgb.train({'objective':'lambdarank','verbosity':-1,'num_threads':1,'min_data_in_leaf':1,'min_data_in_bin':1},lgb.Dataset(X,label=np.tile([0,1,2,3],10),group=[4]*10),num_boost_round=5)
            model.save_model(str(d/'model.txt'));(d/'meta.json').write_text(json.dumps({'featCols':['z','a','unused'],'modelVersion':'test'}))
            before=model.predict(X);write_report(d);r=verify_report(d)
            self.assertEqual(r['sha256']['model.txt'],hashlib.sha256((d/'model.txt').read_bytes()).hexdigest())
            self.assertEqual(r['features'][2]['gain'],0)
            np.testing.assert_array_equal(before,model.predict(X))
            r['features'][0]['gainPct']+=1;(d/'feature-importance.json').write_text(json.dumps(r))
            with self.assertRaises(ValueError):verify_report(d)
if __name__ == '__main__': unittest.main()
