import unittest
import numpy as np
import pandas as pd
from replay import composite, serving_scores, serving_z

class ServingFormulaTests(unittest.TestCase):
    def test_available_axis_weights_are_renormalized(self):
        frame=pd.DataFrame({'h_elo':[1500,np.nan,np.nan], 'j_elo':[1600,1600,np.nan], 't_elo':[np.nan,1400,np.nan]})
        values=composite(frame)
        self.assertAlmostEqual(values[0],(1500*.7+1600*.2)/.9)
        self.assertAlmostEqual(values[1],(1600*.2+1400*.1)/.3)
        self.assertTrue(np.isnan(values[2]))

    def test_serving_uses_sample_standard_deviation(self):
        np.testing.assert_allclose(serving_z([1,2,3]),[-1,0,1])

    def test_factor_changes_rank_but_not_displayed_score(self):
        a,rank_a=serving_scores([-2,-1],[1500,1600],[0,0])
        b,rank_b=serving_scores([-2,-1],[1500,1600],[10,-10])
        np.testing.assert_array_equal(a,b)
        np.testing.assert_allclose(rank_b-rank_a,[.05,-.05])

    def test_outer_alpha_is_point_88_and_score_is_1500_plus_100_blend(self):
        score,rank=serving_scores([1,2,3],[3,2,1],[0,0,0])
        np.testing.assert_array_equal(score,[1424,1500,1576])
        np.testing.assert_allclose(rank,[-.76,0,.76])

if __name__=='__main__': unittest.main()