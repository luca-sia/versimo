import json
import unittest
from pathlib import Path

import versimo

VECTORS = json.loads((Path(__file__).resolve().parents[3] / "spec" / "vectors.json").read_text("utf-8"))


class VectorTests(unittest.TestCase):
    def test_bucket(self):
        for c in VECTORS["bucket"]:
            with self.subTest(module=c["module"], user=c["userId"][:20]):
                self.assertEqual(versimo.bucket_for(c["module"], c["userId"]), c["bucket"])

    def test_resolve(self):
        for c in VECTORS["resolve"]:
            with self.subTest(c["name"]):
                r = versimo.resolve(c["record"], c["userId"])
                e = c["expected"]
                self.assertEqual((r.version, r.channel, r.reason, r.bucket), (e["version"], e["channel"], e["reason"], e["bucket"]))

    def test_transitions(self):
        for c in VECTORS["transitions"]:
            with self.subTest(c["name"]):
                kw = {"now": c["now"], "by": c.get("by"), "reason": c.get("reason")}
                args = c["args"]

                def run():
                    if c["op"] == "promote":
                        return versimo.promote(c["record"], **kw)
                    if c["op"] == "rollback":
                        return versimo.rollback(c["record"], **kw)
                    if c["op"] == "setRollout":
                        return versimo.set_rollout(c["record"], args["n"], **kw)
                    return versimo.draft_next(c["record"], args["version"], patch=bool(args.get("patch")), **kw)

                if "error" in c:
                    with self.assertRaises(versimo.VersimoError) as ctx:
                        run()
                    self.assertEqual(ctx.exception.code, c["error"])
                else:
                    before = json.dumps(c["record"], sort_keys=True)
                    self.assertEqual(run(), c["expected"])
                    self.assertEqual(json.dumps(c["record"], sort_keys=True), before, "input was changed")

    def test_validation(self):
        for c in VECTORS["validation"]:
            with self.subTest(c["name"]):
                r = versimo.validate_record(c["record"])
                self.assertEqual(r.ok, c["ok"])
                self.assertEqual([e.split(" ")[0] for e in r.errors], c["errors"])

    def test_health(self):
        for c in VECTORS["health"]:
            with self.subTest(c["name"]):

                def run():
                    return versimo.check_health(
                        c["record"], c["checks"], c["observation"], by=c.get("by"), now=c["now"]
                    )

                if "error" in c:
                    with self.assertRaises(versimo.VersimoError) as ctx:
                        run()
                    self.assertEqual(ctx.exception.code, c["error"])
                    continue
                before = json.dumps(c["record"], sort_keys=True)
                r = run()
                e = c["expected"]
                self.assertEqual(r.record, e["record"])
                self.assertEqual(r.verdict.healthy, e["verdict"]["healthy"])
                self.assertEqual(r.verdict.failures, e["verdict"]["failures"])
                self.assertEqual(r.rolled_back, e["rolledBack"])
                self.assertEqual(json.dumps(c["record"], sort_keys=True), before, "input was changed")

    def test_semver(self):
        for c in VECTORS["semver"]["compare"]:
            with self.subTest(a=c["a"], b=c["b"]):
                self.assertEqual(versimo.compare_semver(c["a"], c["b"]), c["expected"])
        for c in VECTORS["semver"]["valid"]:
            with self.subTest(value=c["value"]):
                self.assertEqual(versimo.is_semver(c["value"]), c["valid"])

    def test_posthog(self):
        for c in VECTORS["posthog"]:
            with self.subTest(c["name"]):
                self.assertEqual(versimo.rollout_from_flag(c["flag"]), c["rollout"])


if __name__ == "__main__":
    unittest.main()
