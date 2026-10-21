import unittest
from model_family_tuning import split_dates, paired_comparisons, GRIDS


class TuningRules(unittest.TestCase):
    def test_thirty_thirty_disjoint(self):
        dates = [f'2026-{i:03}' for i in range(70)]
        tune, evaluate = split_dates(dates)
        self.assertEqual(tune, dates[10:40])
        self.assertEqual(evaluate, dates[40:70])
        self.assertFalse(set(tune) & set(evaluate))

    def test_insufficient_dates_stop(self):
        with self.assertRaises(ValueError):
            split_dates(list(range(59)))

    def test_all_grid_combinations(self):
        self.assertEqual({n: len(g) for n, g in GRIDS.items()},
                         {'LightGBM': 36, 'XGBoost': 27, 'Random Forest': 18})

    def test_paired_zero_has_no_decisive_gap(self):
        daily = {name: [('a', 20, 10), ('b', 30, 10)] for name in GRIDS}
        for row in paired_comparisons(daily):
            self.assertEqual(row['difference'], 0)
            self.assertEqual(row['ciAdjusted95'], [0, 0])
            self.assertFalse(row['decisive'])


if __name__ == '__main__':
    unittest.main()