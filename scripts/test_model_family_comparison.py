import unittest
import numpy as np
import pandas as pd
from model_family_comparison import complete_field, graded_labels, top_four, safe_parameters

class ComparisonRules(unittest.TestCase):
    def test_missing_parameter_saved_as_null(self):
        self.assertEqual(safe_parameters({'missing':float('nan'),'seed':42}),{'missing':None,'seed':42})

    def test_four_grades(self):
        np.testing.assert_array_equal(graded_labels(np.array([1,2,3,4,5,98])),[4,3,2,1,0,0])

    def test_fixed_four_selected_with_two_hits(self):
        g=pd.DataFrame({'horse_id':['A','B','C','D','E','F'],'finishing_position':[1,5,3,6,2,4]})
        picks,hits=top_four(g,[6,5,4,3,2,1])
        self.assertEqual(picks,['A','B','C','D']);self.assertEqual(hits,2)

    def test_incomplete_and_dead_heat_excluded(self):
        g=pd.DataFrame({'race_date':['2026-10-14']*4,'horse_id':['A','B','C','D'],'finishing_position':[1,2,3,4],'field_size':[4]*4})
        self.assertTrue(complete_field(g))
        self.assertFalse(complete_field(g.iloc[:3]))
        g.loc[3,'finishing_position']=3
        self.assertFalse(complete_field(g))

if __name__=='__main__': unittest.main()