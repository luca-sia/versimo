package dev.versimo

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ClientTest {
    private fun sample(rollout: Int = 10) = ModuleRecord(
        module = "billing", last = "2.3.1", current = "2.4.0", next = "2.5.0",
        rollout = rollout, healthy = true, updatedAt = "2026-03-12T09:30:00Z",
    )

    private class Counting(var record: ModuleRecord?) : RecordSource {
        var calls = 0
        override fun load(module: String): ModuleRecord? {
            calls++
            return record
        }
    }

    @Test
    fun cachesUntilTtlRunsOut() {
        var t = 0L
        val src = Counting(sample())
        val client = VersimoClient(src, ttlMs = 1000, clock = { t })
        client.version("billing", "a")
        client.version("billing", "b")
        assertEquals(1, src.calls)
        t = 999
        client.record("billing")
        assertEquals(1, src.calls)
        t = 1000
        client.record("billing")
        assertEquals(2, src.calls)
    }

    @Test
    fun refetchPicksUpAChangedRecord() {
        var t = 0L
        val src = Counting(sample(rollout = 0))
        val client = VersimoClient(src, ttlMs = 10, clock = { t })
        assertEquals("2.4.0", client.version("billing", "u"))
        src.record = sample(rollout = 100)
        assertEquals("2.4.0", client.version("billing", "u"))
        t = 10
        assertEquals("2.5.0", client.version("billing", "u"))
    }

    @Test
    fun clearDropsTheCache() {
        val src = Counting(sample())
        val client = VersimoClient(src)
        client.record("billing")
        client.clear("billing")
        client.record("billing")
        client.clear()
        client.record("billing")
        assertEquals(3, src.calls)
    }

    @Test
    fun concurrentCallsShareOneLoad() {
        var calls = 0
        val client = VersimoClient(RecordSource {
            synchronized(this) { calls++ }
            Thread.sleep(50)
            sample()
        })
        val threads = (1..6).map { Thread { client.record("billing") }.also { it.start() } }
        threads.forEach { it.join() }
        assertEquals(1, calls)
    }

    @Test
    fun errorCodes() {
        assertEquals(ErrorCode.NOT_FOUND, assertFailsWith<VersimoException> { VersimoClient(Counting(null)).record("billing") }.code)
        assertEquals(
            ErrorCode.INVALID_RECORD,
            assertFailsWith<VersimoException> { VersimoClient(Counting(sample(rollout = 150))).record("billing") }.code,
        )
        val down = VersimoClient(RecordSource { throw java.io.IOException("down") })
        assertEquals(ErrorCode.SOURCE_ERROR, assertFailsWith<VersimoException> { down.record("billing") }.code)
    }

    @Test
    fun badSlugNeverReachesTheSource() {
        val src = Counting(sample())
        val client = VersimoClient(src)
        for (slug in listOf("../etc/passwd", "Billing", "billing\n", "")) {
            assertEquals(ErrorCode.INVALID_INPUT, assertFailsWith<VersimoException> { client.record(slug) }.code)
        }
        assertEquals(0, src.calls)
    }

    @Test
    fun servesStaleRecordWhenSourceFails() {
        var t = 0L
        var fail = false
        val client = VersimoClient(RecordSource {
            if (fail) throw java.io.IOException("down")
            sample()
        }, ttlMs = 10, clock = { t })
        client.record("billing")
        fail = true
        t = 50
        assertEquals("2.4.0", client.record("billing").current)
    }

    @Test
    fun staleIsNotServedForAnInvalidRecord() {
        var t = 0L
        val src = Counting(sample())
        val client = VersimoClient(src, ttlMs = 10, clock = { t })
        client.record("billing")
        src.record = sample(rollout = 500)
        t = 50
        assertEquals(ErrorCode.INVALID_RECORD, assertFailsWith<VersimoException> { client.record("billing") }.code)
    }

    @Test
    fun urlSourceBuildsUrls() {
        val seen = mutableListOf<String>()
        val fetcher = HttpFetcher { url ->
            seen.add(url)
            HttpResponse(200, sample().toJson())
        }
        VersimoClient.fromUrl("https://example.test/records/", fetcher = fetcher).record("billing")
        VersimoClient.fromUrl("https://example.test/api?m={module}", fetcher = fetcher).record("billing")
        assertEquals(listOf("https://example.test/records/billing.json", "https://example.test/api?m=billing"), seen)
    }

    @Test
    fun urlSourceStatusCodes() {
        fun client(status: Int, body: String = "") = VersimoClient.fromUrl("https://example.test", fetcher = { HttpResponse(status, body) })
        assertEquals(ErrorCode.NOT_FOUND, assertFailsWith<VersimoException> { client(404).record("billing") }.code)
        assertEquals(ErrorCode.SOURCE_ERROR, assertFailsWith<VersimoException> { client(500).record("billing") }.code)
        assertEquals(ErrorCode.SOURCE_ERROR, assertFailsWith<VersimoException> { client(200, "<html>").record("billing") }.code)
        assertEquals(ErrorCode.INVALID_RECORD, assertFailsWith<VersimoException> { client(200, "{}").record("billing") }.code)
    }

    @Test
    fun urlSourceOverHttp() {
        val server = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val found = ex.requestURI.path == "/billing.json"
            val body = if (found) sample().toJson().toByteArray() else ByteArray(0)
            ex.sendResponseHeaders(if (found) 200 else 404, if (found) body.size.toLong() else -1)
            if (found) ex.responseBody.use { it.write(body) } else ex.close()
        }
        server.start()
        try {
            val client = VersimoClient.fromUrl("http://127.0.0.1:${server.address.port}")
            assertEquals("2.4.0", client.record("billing").current)
            assertEquals(ErrorCode.NOT_FOUND, assertFailsWith<VersimoException> { client.record("search") }.code)
        } finally {
            server.stop(0)
        }
    }
}
