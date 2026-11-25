import threading
import time
import unittest

from versimo import Client, VersimoError


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


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


class ClientTests(unittest.TestCase):
    def counting(self, records):
        state = {"calls": 0}

        def source(module):
            state["calls"] += 1
            return records.get(module)

        return state, source

    def test_caches_until_ttl_runs_out(self):
        clock = Clock()
        state, source = self.counting({"billing": make_record()})
        client = Client(source, ttl_ms=1000, now=clock)
        client.version("billing", "a")
        client.version("billing", "b")
        self.assertEqual(state["calls"], 1)
        clock.t = 999
        client.record("billing")
        self.assertEqual(state["calls"], 1)
        clock.t = 1000
        client.record("billing")
        self.assertEqual(state["calls"], 2)

    def test_refetch_picks_up_a_changed_record(self):
        clock = Clock()
        records = {"billing": make_record(rollout=0)}
        client = Client(records.get, ttl_ms=10, now=clock)
        self.assertEqual(client.version("billing", "u"), "2.4.0")
        records["billing"] = make_record(rollout=100)
        self.assertEqual(client.version("billing", "u"), "2.4.0")
        clock.t = 10
        self.assertEqual(client.version("billing", "u"), "2.5.0")

    def test_clear(self):
        state, source = self.counting({"billing": make_record()})
        client = Client(source)
        client.record("billing")
        client.clear("billing")
        client.record("billing")
        client.clear()
        client.record("billing")
        self.assertEqual(state["calls"], 3)

    def test_concurrent_calls_share_one_load(self):
        calls = []

        def source(module):
            calls.append(module)
            time.sleep(0.05)
            return make_record()

        client = Client(source)
        threads = [threading.Thread(target=client.record, args=("billing",)) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(calls), 1)

    def test_missing_record_is_not_found(self):
        with self.assertRaises(VersimoError) as ctx:
            Client(lambda m: None).record("billing")
        self.assertEqual(ctx.exception.code, "NOT_FOUND")

    def test_invalid_record(self):
        with self.assertRaises(VersimoError) as ctx:
            Client(lambda m: {"module": "billing"}).record("billing")
        self.assertEqual(ctx.exception.code, "INVALID_RECORD")

    def test_bad_slug_never_reaches_the_source(self):
        state, source = self.counting({})
        for slug in ["../etc/passwd", "Billing", "billing\n", ""]:
            with self.assertRaises(VersimoError) as ctx:
                Client(source).record(slug)
            self.assertEqual(ctx.exception.code, "INVALID_INPUT")
        self.assertEqual(state["calls"], 0)

    def test_serves_stale_record_when_source_fails_after_expiry(self):
        clock = Clock()
        fail = {"on": False}

        def source(module):
            if fail["on"]:
                raise OSError("down")
            return make_record()

        client = Client(source, ttl_ms=10, now=clock)
        client.record("billing")
        fail["on"] = True
        clock.t = 50
        self.assertEqual(client.record("billing")["current"], "2.4.0")

    def test_stale_is_not_served_for_an_invalid_record(self):
        clock = Clock()
        records = {"billing": make_record()}
        client = Client(records.get, ttl_ms=10, now=clock)
        client.record("billing")
        records["billing"] = {"module": "billing"}
        clock.t = 50
        with self.assertRaises(VersimoError) as ctx:
            client.record("billing")
        self.assertEqual(ctx.exception.code, "INVALID_RECORD")

    def test_fails_when_source_fails_and_nothing_is_cached(self):
        def source(module):
            raise OSError("down")

        with self.assertRaises(VersimoError) as ctx:
            Client(source).record("billing")
        self.assertEqual(ctx.exception.code, "SOURCE_ERROR")

    def test_url_source_appends_file_name_to_a_base(self):
        import json

        seen = []

        def fetch(url):
            seen.append(url)
            return 200, json.dumps(make_record()).encode()

        Client("https://example.test/records/", fetch=fetch).record("billing")
        self.assertEqual(seen, ["https://example.test/records/billing.json"])

    def test_url_source_fills_a_placeholder(self):
        import json

        seen = []

        def fetch(url):
            seen.append(url)
            return 200, json.dumps(make_record()).encode()

        Client("https://example.test/api?m={module}", fetch=fetch).record("billing")
        self.assertEqual(seen, ["https://example.test/api?m=billing"])

    def test_url_source_status_codes(self):
        def make(status):
            return Client("https://example.test", fetch=lambda url: (status, b""))

        with self.assertRaises(VersimoError) as ctx:
            make(404).record("billing")
        self.assertEqual(ctx.exception.code, "NOT_FOUND")
        with self.assertRaises(VersimoError) as ctx:
            make(500).record("billing")
        self.assertEqual(ctx.exception.code, "SOURCE_ERROR")

    def test_url_source_bad_json_is_a_source_error(self):
        with self.assertRaises(VersimoError) as ctx:
            Client("https://example.test", fetch=lambda url: (200, b"<html>")).record("billing")
        self.assertEqual(ctx.exception.code, "SOURCE_ERROR")

    def test_url_source_over_http(self):
        import json
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/billing.json":
                    body = json.dumps(make_record()).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            client = Client(f"http://127.0.0.1:{server.server_port}")
            self.assertEqual(client.record("billing")["current"], "2.4.0")
            with self.assertRaises(VersimoError) as ctx:
                client.record("search")
            self.assertEqual(ctx.exception.code, "NOT_FOUND")
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
