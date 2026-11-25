import Foundation
import XCTest
import Versimo

private func sample(rollout: Int = 10) -> ModuleRecord {
    ModuleRecord(
        module: "billing", last: "2.3.1", current: "2.4.0", next: "2.5.0",
        rollout: rollout, healthy: true, updatedAt: "2026-03-12T09:30:00Z"
    )
}

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 0)
    func set(_ seconds: TimeInterval) { lock.lock(); date = Date(timeIntervalSince1970: seconds); lock.unlock() }
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return date }
}

private actor Box {
    var calls = 0
    var record: ModuleRecord?
    var fail = false
    init(_ record: ModuleRecord?) { self.record = record }
    func load() throws -> ModuleRecord? {
        calls += 1
        if fail { throw URLError(.notConnectedToInternet) }
        return record
    }
    func set(record: ModuleRecord?) { self.record = record }
    func set(fail: Bool) { self.fail = fail }
}

private func code(_ body: () async throws -> Void) async -> ErrorCode? {
    do { try await body() } catch { return (error as? VersimoError)?.code }
    return nil
}

final class ClientTests: XCTestCase {
    func testCachesUntilTtlRunsOut() async throws {
        let clock = Clock()
        let box = Box(sample())
        let client = VersimoClient(source: { _ in try await box.load() }, ttl: 1, now: { clock.now() })
        _ = try await client.version("billing", userId: "a")
        _ = try await client.version("billing", userId: "b")
        var calls = await box.calls
        XCTAssertEqual(calls, 1)
        clock.set(0.999)
        _ = try await client.record("billing")
        calls = await box.calls
        XCTAssertEqual(calls, 1)
        clock.set(1)
        _ = try await client.record("billing")
        calls = await box.calls
        XCTAssertEqual(calls, 2)
    }

    func testRefetchPicksUpAChangedRecord() async throws {
        let clock = Clock()
        let box = Box(sample(rollout: 0))
        let client = VersimoClient(source: { _ in try await box.load() }, ttl: 0.01, now: { clock.now() })
        var v = try await client.version("billing", userId: "u")
        XCTAssertEqual(v, "2.4.0")
        await box.set(record: sample(rollout: 100))
        v = try await client.version("billing", userId: "u")
        XCTAssertEqual(v, "2.4.0")
        clock.set(0.01)
        v = try await client.version("billing", userId: "u")
        XCTAssertEqual(v, "2.5.0")
    }

    func testClear() async throws {
        let box = Box(sample())
        let client = VersimoClient(source: { _ in try await box.load() })
        _ = try await client.record("billing")
        await client.clear("billing")
        _ = try await client.record("billing")
        await client.clear()
        _ = try await client.record("billing")
        let calls = await box.calls
        XCTAssertEqual(calls, 3)
    }

    func testConcurrentCallsShareOneLoad() async throws {
        let box = Box(sample())
        let client = VersimoClient(source: { _ in
            try await Task.sleep(nanoseconds: 50_000_000)
            return try await box.load()
        })
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<6 { group.addTask { _ = try await client.record("billing") } }
            try await group.waitForAll()
        }
        let calls = await box.calls
        XCTAssertEqual(calls, 1)
    }

    func testErrorCodes() async {
        let missing = VersimoClient(source: { _ in nil })
        let missingCode = await code { _ = try await missing.record("billing") }
        XCTAssertEqual(missingCode, .notFound)

        let invalid = VersimoClient(source: { _ in sample(rollout: 150) })
        let invalidCode = await code { _ = try await invalid.record("billing") }
        XCTAssertEqual(invalidCode, .invalidRecord)

        let down = VersimoClient(source: { _ in throw URLError(.notConnectedToInternet) })
        let downCode = await code { _ = try await down.record("billing") }
        XCTAssertEqual(downCode, .sourceError)
    }

    func testBadSlugNeverReachesTheSource() async {
        let box = Box(sample())
        let client = VersimoClient(source: { _ in try await box.load() })
        for slug in ["../etc/passwd", "Billing", "billing\n", ""] {
            let c = await code { _ = try await client.record(slug) }
            XCTAssertEqual(c, .invalidInput, slug)
        }
        let calls = await box.calls
        XCTAssertEqual(calls, 0)
    }

    func testServesStaleRecordWhenSourceFails() async throws {
        let clock = Clock()
        let box = Box(sample())
        let client = VersimoClient(source: { _ in try await box.load() }, ttl: 0.01, now: { clock.now() })
        _ = try await client.record("billing")
        await box.set(fail: true)
        clock.set(1)
        let rec = try await client.record("billing")
        XCTAssertEqual(rec.current, "2.4.0")
    }

    func testStaleIsNotServedForAnInvalidRecord() async throws {
        let clock = Clock()
        let box = Box(sample())
        let client = VersimoClient(source: { _ in try await box.load() }, ttl: 0.01, now: { clock.now() })
        _ = try await client.record("billing")
        await box.set(record: sample(rollout: 500))
        clock.set(1)
        let c = await code { _ = try await client.record("billing") }
        XCTAssertEqual(c, .invalidRecord)
    }

    func testUrlSourceBuildsUrls() async throws {
        final class Seen: @unchecked Sendable { var urls: [String] = [] }
        let log = Seen()
        let body = try sample().encoded()
        let fetch: Fetcher = { url in
            log.urls.append(url.absoluteString)
            return (200, body)
        }
        _ = try await VersimoClient.url("https://example.test/records/", fetch: fetch).record("billing")
        _ = try await VersimoClient.url("https://example.test/api?m={module}", fetch: fetch).record("billing")
        XCTAssertEqual(log.urls, ["https://example.test/records/billing.json", "https://example.test/api?m=billing"])
    }

    func testUrlSourceStatusCodes() async {
        func client(_ status: Int, _ body: String = "") -> VersimoClient {
            .url("https://example.test", fetch: { _ in (status, Data(body.utf8)) })
        }
        let notFound = await code { _ = try await client(404).record("billing") }
        XCTAssertEqual(notFound, .notFound)
        let server = await code { _ = try await client(500).record("billing") }
        XCTAssertEqual(server, .sourceError)
        let badJson = await code { _ = try await client(200, "<html>").record("billing") }
        XCTAssertEqual(badJson, .sourceError)
        let badRecord = await code { _ = try await client(200, "{}").record("billing") }
        XCTAssertEqual(badRecord, .invalidRecord)
    }

    func testRecordRoundTrip() throws {
        let data = try sample().encoded()
        XCTAssertEqual(try ModuleRecord(data: data), sample())
    }
}
