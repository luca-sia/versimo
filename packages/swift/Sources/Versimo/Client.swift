import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Returns the record for a module, or nil when there is none.
public typealias RecordSource = @Sendable (String) async throws -> ModuleRecord?

/// Does one GET request and returns the status code and body.
public typealias Fetcher = @Sendable (URL) async throws -> (status: Int, body: Data)

private let slugRegex = try! NSRegularExpression(pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*\\z")

/// Resolves versions from a source, with a TTL cache and stale-on-error.
/// Concurrent calls for one module share a single load.
public actor VersimoClient {
    private struct Cached {
        let record: ModuleRecord
        let expires: Date
    }

    private let source: RecordSource
    private let ttl: TimeInterval
    private let now: @Sendable () -> Date
    private var cache: [String: Cached] = [:]
    private var inflight: [String: Task<ModuleRecord, Error>] = [:]

    /// `ttl` is in seconds. `now` is the clock for the cache, mainly for tests.
    public init(source: @escaping RecordSource, ttl: TimeInterval = 30, now: @escaping @Sendable () -> Date = { Date() }) {
        self.source = source
        self.ttl = ttl
        self.now = now
    }

    /// A client that fetches `<base>/<module>.json`. A `url` containing `{module}` has it replaced instead.
    public static func url(
        _ url: String, ttl: TimeInterval = 30, fetch: Fetcher? = nil, now: @escaping @Sendable () -> Date = { Date() }
    ) -> VersimoClient {
        VersimoClient(source: urlSource(url, fetch ?? defaultFetch), ttl: ttl, now: now)
    }

    public func record(_ module: String) async throws -> ModuleRecord {
        guard fullMatch(slugRegex, module) != nil else {
            throw VersimoError(.invalidInput, "Invalid module slug: \"\(module)\"")
        }
        let hit = cache[module]
        if let hit, hit.expires > now() { return hit.record }
        if let task = inflight[module] { return try await task.value }
        let task = Task { try await self.refresh(module, stale: hit) }
        inflight[module] = task
        defer { inflight[module] = nil }
        return try await task.value
    }

    public func resolve(_ module: String, userId: String? = nil) async throws -> Resolution {
        Versimo.resolve(try await record(module), userId: userId)
    }

    public func version(_ module: String, userId: String? = nil) async throws -> String {
        try await resolve(module, userId: userId).version
    }

    /// Drops one cached record, or all of them.
    public func clear(_ module: String? = nil) {
        if let module { cache[module] = nil } else { cache.removeAll() }
    }

    private func refresh(_ module: String, stale: Cached?) async throws -> ModuleRecord {
        do {
            let rec = try await load(module)
            cache[module] = Cached(record: rec, expires: now().addingTimeInterval(ttl))
            return rec
        } catch {
            let e = (error as? VersimoError) ?? VersimoError(.sourceError, "\(error)")
            // Serve the stale record when the source is down. A missing or invalid record is not hidden.
            if let stale, e.code == .sourceError {
                cache[module] = Cached(record: stale.record, expires: now().addingTimeInterval(ttl))
                return stale.record
            }
            throw e
        }
    }

    private func load(_ module: String) async throws -> ModuleRecord {
        guard let rec = try await source(module) else {
            throw VersimoError(.notFound, "No record for module \"\(module)\"")
        }
        let checked = validateRecord(rec.jsonValue)
        guard checked.ok else {
            throw VersimoError(.invalidRecord, "Invalid record for \"\(module)\": \(checked.errors.joined(separator: "; "))")
        }
        return rec
    }
}

@Sendable private func defaultFetch(_ url: URL) async throws -> (status: Int, body: Data) {
    let (data, response) = try await URLSession.shared.data(from: url)
    guard let http = response as? HTTPURLResponse else { throw VersimoError(.sourceError, "Not an HTTP response") }
    return (http.statusCode, data)
}

private func urlSource(_ url: String, _ fetch: @escaping Fetcher) -> RecordSource {
    { module in
        var base = url
        while base.hasSuffix("/") { base.removeLast() }
        let target = url.contains("{module}")
            ? url.replacingOccurrences(of: "{module}", with: module)
            : "\(base)/\(module).json"
        guard let u = URL(string: target) else { throw VersimoError(.sourceError, "Invalid URL: \(target)") }
        let result: (status: Int, body: Data)
        do {
            result = try await fetch(u)
        } catch {
            throw VersimoError(.sourceError, "Could not fetch \(target): \(error)")
        }
        if result.status == 404 { return nil }
        guard (200...299).contains(result.status) else {
            throw VersimoError(.sourceError, "Fetching \(target) returned \(result.status)")
        }
        let json: JSONValue
        do {
            json = try JSONDecoder().decode(JSONValue.self, from: result.body)
        } catch {
            throw VersimoError(.sourceError, "Fetching \(target) returned invalid JSON")
        }
        return try ModuleRecord(json: json, label: module)
    }
}
