import unittest

import versimo
from test_client import make_record


class RecordTests(unittest.TestCase):
    def test_transitions_do_not_change_the_input(self):
        rec = make_record()
        versimo.promote(rec)
        self.assertNotIn("history", rec)

    def test_now_accepts_datetime_and_milliseconds(self):
        from datetime import datetime, timezone

        a = versimo.promote(make_record(), now=datetime(2026, 4, 1, 10, 0, tzinfo=timezone.utc))
        b = versimo.promote(make_record(), now=1775037600000)
        self.assertEqual(a["updatedAt"], "2026-04-01T10:00:00.000Z")
        self.assertEqual(a, b)

    def test_bad_now_is_invalid_input(self):
        with self.assertRaises(versimo.VersimoError) as ctx:
            versimo.promote(make_record(), now="yesterday")
        self.assertEqual(ctx.exception.code, "INVALID_INPUT")


if __name__ == "__main__":
    unittest.main()
