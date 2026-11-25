import Foundation

public enum Channel: String, Sendable {
    case next, current, last
}

public enum Reason: String, Sendable {
    case rollout = "ROLLOUT"
    case `default` = "DEFAULT"
    case noUser = "NO_USER"
    case unhealthy = "UNHEALTHY"
}

/// Which version a user gets and why. `bucket` is nil when there was no user id.
public struct Resolution: Equatable, Sendable {
    public let version: String
    public let channel: Channel
    public let reason: Reason
    public let bucket: Int?
}

public enum ErrorCode: String, Sendable {
    case invalidInput = "INVALID_INPUT"
    case invalidRecord = "INVALID_RECORD"
    case notFound = "NOT_FOUND"
    case sourceError = "SOURCE_ERROR"
}

public struct VersimoError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: ErrorCode
    public let message: String

    public init(_ code: ErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "\(code.rawValue): \(message)" }
}

public struct HistoryEntry: Equatable, Sendable {
    public var at: String
    public var action: String
    public var from: String?
    public var to: String?
    public var by: String?

    public init(at: String, action: String, from: String?, to: String?, by: String? = nil) {
        self.at = at
        self.action = action
        self.from = from
        self.to = to
        self.by = by
    }
}

/// The release state of one module. Transitions return a new record.
public struct ModuleRecord: Equatable, Sendable {
    public var module: String
    public var last: String?
    public var current: String
    public var next: String?
    public var rollout: Int
    public var healthy: Bool
    public var updatedAt: String
    public var history: [HistoryEntry]?
    public var schema: String?

    public init(
        module: String, last: String?, current: String, next: String?, rollout: Int,
        healthy: Bool, updatedAt: String, history: [HistoryEntry]? = nil, schema: String? = nil
    ) {
        self.module = module
        self.last = last
        self.current = current
        self.next = next
        self.rollout = rollout
        self.healthy = healthy
        self.updatedAt = updatedAt
        self.history = history
        self.schema = schema
    }

    /// Validates `json` and builds a record. Throws `invalidRecord`.
    public init(json: JSONValue, label: String = "record") throws {
        let checked = validateRecord(json)
        guard checked.ok, case .object(let o) = json else {
            throw VersimoError(.invalidRecord, "Invalid record for \"\(label)\": \(checked.errors.joined(separator: "; "))")
        }
        func text(_ v: JSONValue?) -> String? {
            if case .string(let s)? = v { return s }
            return nil
        }
        var entries: [HistoryEntry]?
        if case .array(let items)? = o["history"] {
            entries = items.compactMap { item in
                guard case .object(let e) = item, let at = text(e["at"]), let action = text(e["action"]) else { return nil }
                return HistoryEntry(at: at, action: action, from: text(e["from"]), to: text(e["to"]), by: text(e["by"]))
            }
        }
        guard case .number(let rollout)? = o["rollout"], case .bool(let healthy)? = o["healthy"] else {
            throw VersimoError(.invalidRecord, "Invalid record for \"\(label)\"")
        }
        self.init(
            module: text(o["module"]) ?? "", last: text(o["last"]), current: text(o["current"]) ?? "",
            next: text(o["next"]), rollout: Int(rollout), healthy: healthy,
            updatedAt: text(o["updatedAt"]) ?? "", history: entries, schema: text(o["$schema"])
        )
    }

    /// Reads and validates a record from JSON data. Throws `invalidRecord`.
    public init(data: Data, label: String = "record") throws {
        let value: JSONValue
        do {
            value = try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            throw VersimoError(.invalidRecord, "Invalid JSON for \"\(label)\": \(error.localizedDescription)")
        }
        try self.init(json: value, label: label)
    }

    /// The record as the JSON value of the record format.
    public var jsonValue: JSONValue {
        func opt(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }
        var o: [String: JSONValue] = [:]
        if let schema { o["$schema"] = .string(schema) }
        o["module"] = .string(module)
        o["last"] = opt(last)
        o["current"] = .string(current)
        o["next"] = opt(next)
        o["rollout"] = .number(Double(rollout))
        o["healthy"] = .bool(healthy)
        o["updatedAt"] = .string(updatedAt)
        if let history {
            o["history"] = .array(history.map { e in
                var h: [String: JSONValue] = ["at": .string(e.at), "action": .string(e.action), "from": opt(e.from), "to": opt(e.to)]
                if let by = e.by { h["by"] = .string(by) }
                return .object(h)
            })
        }
        return .object(o)
    }

    /// The record as JSON data, ready to save.
    public func encoded() throws -> Data {
        try JSONEncoder().encode(jsonValue)
    }
}

/// Options shared by the functions that change a record. `now` defaults to the current time.
public struct TransitionOptions: Sendable {
    public var by: String?
    public var now: Date?

    public init(by: String? = nil, now: Date? = nil) {
        self.by = by
        self.now = now
    }
}
