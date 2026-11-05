import unittest

from cloud.routepilot_traffic import month_start, update


class MonthlyTrafficTest(unittest.TestCase):
    boundary = 1793491200  # 2026-11-01 00:00 UTC

    def setUp(self):
        self.prior = {"month": month_start(self.boundary - 45), "at": self.boundary - 45,
                      "counter": 1000, "used": 9000, "interface": "eth0", "boot_id": "old"}

    def test_month_boundary_uses_only_new_month_fraction(self):
        self.assertEqual(update(self.prior, self.boundary + 15, self.boundary - 10000,
                                "old", "eth0", 1600), 150)

    def test_new_month_after_reboot_uses_new_counter(self):
        self.assertEqual(update(self.prior, self.boundary + 15, self.boundary + 1,
                                "new", "eth0", 400), 400)

    def test_reboot_during_month_preserves_usage_and_retry_adds_nothing(self):
        self.assertEqual(update(self.prior, self.prior["at"], self.prior["at"] - 200,
                                "old", "eth0", 1000), 9000)
        self.assertEqual(update(self.prior, self.boundary - 5, self.boundary - 10,
                                "new", "eth0", 400), 9400)
