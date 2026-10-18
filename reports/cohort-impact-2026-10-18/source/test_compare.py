import unittest
import pandas as pd
from compare import z, blend

class ComparisonRules(unittest.TestCase):
    def test_fixed_alpha(self):
        values=blend(pd.Series([1.,3.]),pd.Series([3.,1.]))
        self.assertAlmostEqual(values.iloc[1],(.88-.12)/2**.5)
    def test_sample_standard_deviation(self):
        self.assertAlmostEqual(z(pd.Series([1.,3.])).iloc[1],1/2**.5)
    def test_missing_component_is_neutral(self):
        self.assertEqual(z(pd.Series([1.,3.,None])).iloc[2],0)

if __name__=='__main__':unittest.main()