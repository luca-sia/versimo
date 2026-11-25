import json
import unittest

from versimo import POSTHOG_DISTINCT_ID, Client, PostHogRollout, VersimoError


def make_record(**o):
    return {
        "module": "billing",
        "last": "2.3.1",
        "current": "2.4.0",
        "next": "2.5.0",
        "rollout": 10,
        "healthy": True,
        "updatedAt": "2026-03-12T09:30:00Z",
        **o,
    }


def on(rollout):
    return {"enabled": True, "metadata": {"payload": json.dumps({"rollout": rollout})}}


class FakePostHog:
    def __init__(self, *answers):
        self.answers = list(answers)
        self.calls = []

    def __call__(self, url, body):
        self.calls.append((url, body))
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, int):
            return answer, b""
        return 200, json.dumps({"flags": answer}).encode()


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


class PostHogTests(unittest.TestCase):
    def client(self, record, fake, **kw):
        return Client(lambda m: record, rollout=PostHogRollout("phc_test", post=fake, **kw))

    def test_share_drives_next_and_bucketing_picks_users(self):
        c = self.client(make_record(rollout=0), FakePostHog({"versimo-billing": on(100)}))
        r = c.resolve("billing", "user-42")
        self.assertEqual((r.version, r.channel, r.bucket), ("2.5.0", "next", 33))
        self.assertEqual(c.record("billing")["rollout"], 100)

    def test_boundary_follows_the_bucket(self):
        for share, version in ((33, "2.4.0"), (34, "2.5.0")):
            c = self.client(make_record(rollout=0), FakePostHog({"versimo-billing": on(share)}))
            self.assertEqual(c.version("billing", "user-42"), version)

    def test_flag_off_takes_everyone_off_next(self):
        c = self.client(make_record(rollout=100), FakePostHog({"versimo-billing": {"enabled": False}}))
        self.assertEqual(c.version("billing", "user-42"), "2.4.0")

    def test_no_flag_keeps_record_rollout(self):
        c = self.client(make_record(rollout=100), FakePostHog({"versimo-search": on(0)}))
        self.assertEqual(c.version("billing", "user-42"), "2.5.0")

    def test_unhealthy_still_goes_to_last(self):
        c = self.client(make_record(healthy=False), FakePostHog({"versimo-billing": on(100)}))
        self.assertEqual(c.version("billing", "user-42"), "2.3.1")

    def test_down_with_no_answer_uses_record(self):
        c = self.client(make_record(rollout=100), FakePostHog(503))
        self.assertEqual(c.version("billing", "user-42"), "2.5.0")
        c = self.client(make_record(rollout=0), FakePostHog(OSError("offline")))
        self.assertEqual(c.version("billing", "user-42"), "2.4.0")

    def test_down_after_good_answer_keeps_it(self):
        clock = Clock()
        fake = FakePostHog({"versimo-billing": on(100)}, 500)
        rollout = PostHogRollout("phc_test", post=fake, ttl_ms=10, now=clock)
        self.assertEqual(rollout("billing"), 100)
        clock.t = 10
        self.assertEqual(rollout("billing"), 100)
        self.assertEqual(len(fake.calls), 2)

    def test_one_request_per_ttl(self):
        clock = Clock()
        fake = FakePostHog({"versimo-billing": on(10), "versimo-search": on(20)})
        rollout = PostHogRollout("phc_test", post=fake, ttl_ms=1000, now=clock)
        self.assertEqual([rollout("billing"), rollout("search")], [10, 20])
        clock.t = 999
        rollout("search")
        self.assertEqual(len(fake.calls), 1)
        clock.t = 1000
        rollout("search")
        self.assertEqual(len(fake.calls), 2)

    def test_change_lands_without_deploy(self):
        clock = Clock()
        fake = FakePostHog({"versimo-billing": on(0)}, {"versimo-billing": on(100)})
        c = Client(lambda m: make_record(rollout=0), rollout=PostHogRollout("phc_test", post=fake, ttl_ms=10, now=clock))
        self.assertEqual(c.version("billing", "user-42"), "2.4.0")
        clock.t = 10
        self.assertEqual(c.version("billing", "user-42"), "2.5.0")

    def test_no_user_data_sent(self):
        fake = FakePostHog({"versimo-billing": on(50)})
        c = Client(lambda m: make_record(), rollout=PostHogRollout("phc_test", host="https://us.i.posthog.com/", post=fake))
        c.resolve("billing", "sealed-client-user-7")
        self.assertEqual(len(fake.calls), 1)
        url, body = fake.calls[0]
        self.assertEqual(url, "https://us.i.posthog.com/flags?v=2")
        self.assertEqual(json.loads(body), {"api_key": "phc_test", "distinct_id": POSTHOG_DISTINCT_ID})
        self.assertNotIn(b"sealed-client-user-7", body)

    def test_default_host_is_eu(self):
        fake = FakePostHog({})
        PostHogRollout("phc_test", post=fake)("billing")
        self.assertEqual(fake.calls[0][0], "https://eu.i.posthog.com/flags?v=2")

    def test_bad_rollout_source_leaves_record(self):
        def boom(m):
            raise RuntimeError("boom")

        for src in (boom, lambda m: 150, lambda m: 2.5, lambda m: None, lambda m: True):
            c = Client(lambda m: make_record(rollout=100), rollout=src)
            self.assertEqual(c.record("billing")["rollout"], 100)

    def test_needs_api_key(self):
        with self.assertRaises(VersimoError):
            PostHogRollout("")


if __name__ == "__main__":
    unittest.main()
