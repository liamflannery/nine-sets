import unittest

from workout_dsl import WorkoutError, build_workout, parse


class DslTest(unittest.TestCase):
    def test_easy_run_with_strides(self):
        w = build_workout(
            "1 - Easy run",
            "warmup 5min\nrun 30min @7:15-7:45 hr<150\n4x(run 20s -- strides, fast but relaxed; recover 60s)\ncooldown 5min",
            "Easy, conversational.",
        )
        steps = w["workoutSegments"][0]["workoutSteps"]
        self.assertEqual([s["stepType"]["stepTypeKey"] for s in steps],
                         ["warmup", "interval", "repeat", "cooldown"])
        main = steps[1]
        self.assertEqual(main["endConditionValue"], 1800.0)
        self.assertEqual(main["targetType"]["workoutTargetTypeKey"], "pace.zone")
        # slower pace is the lower m/s limit
        self.assertAlmostEqual(main["targetValueOne"], 1000 / 465, 5)
        self.assertAlmostEqual(main["targetValueTwo"], 1000 / 435, 5)
        self.assertEqual(main["secondaryTargetType"]["workoutTargetTypeKey"], "heart.rate.zone")
        self.assertEqual((main["secondaryTargetValueOne"], main["secondaryTargetValueTwo"]), (80, 150))
        rep = steps[2]
        self.assertEqual(rep["numberOfIterations"], 4)
        self.assertEqual(rep["workoutSteps"][0]["description"], "strides, fast but relaxed")
        self.assertEqual([s["stepOrder"] for s in rep["workoutSteps"]], [4, 5])
        self.assertEqual(steps[3]["stepOrder"], 6)
        self.assertEqual(w["estimatedDurationInSecs"], 300 + 1800 + 4 * 80 + 300)
        self.assertEqual(w["description"], "Easy, conversational.")

    def test_distance_zone_and_lap(self):
        items = parse("wu lap; run 5km hr z2; 6 x (run 400m @5:00; jog 90s); cd 1:30")
        self.assertEqual(items[0]["end"], ("lap", 0))
        self.assertEqual(items[1]["end"], ("distance", 5000))
        self.assertEqual(items[1]["hr"], ("zone", 2))
        self.assertEqual(items[2]["repeat"], 6)
        self.assertEqual(items[2]["steps"][0]["pace"], (305, 295))
        self.assertEqual(items[3]["end"], ("time", 90))
        w = build_workout("x", "run 5km hr z2")
        s = w["workoutSegments"][0]["workoutSteps"][0]
        self.assertEqual(s["zoneNumber"], 2)
        self.assertEqual(s["endCondition"]["conditionTypeKey"], "distance")

    def test_hr_with_space(self):
        self.assertEqual(parse("run 20min hr 135-150")[0]["hr"], ("range", 135, 150))

    def test_errors(self):
        for bad in ("sprint 5min", "run 5 parsecs", "4x(run 1min", "run 10min @fast", ""):
            with self.assertRaises(WorkoutError, msg=bad):
                build_workout("x", bad)


if __name__ == "__main__":
    unittest.main()
