import Foundation

public struct ValidationResult: Equatable, Sendable {
    public let ok: Bool
    public let errors: [String]
}

private let slugRegex = try! NSRegularExpression(pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*\\z")
private let dateTimeRegex = try! NSRegularExpression(
    pattern: "^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\\.[0-9]+)?(?:Z|[+-]([0-9]{2}):([0-9]{2}))\\z"
)
private let actions = ["draft", "promote", "rollback", "rollout", "patch"]
private let keys: Set<String> = ["$schema", "module", "last", "current", "next", "rollout", "healthy", "updatedAt", "history"]
private let entryKeys: Set<String> = ["at", "action", "from", "to", "by"]

private func isDateTime(_ v: JSONValue?) -> Bool {
    guard case .string(let s)? = v, let g = fullMatch(dateTimeRegex, s) else { return false }
    func n(_ i: Int) -> Int { Int(g[i] ?? "") ?? 0 }
    let month = n(2), day = n(3), hour = n(4), minute = n(5), second = n(6)
    if month < 1 || month > 12 || day < 1 || day > 31 || minute > 59 || second > 59 { return false }
    // The reference implementation accepts 24:00:00 and any day up to 31.
    if hour > 24 || (hour == 24 && (minute != 0 || second != 0)) { return false }
    if g[8] != nil && (n(8) > 23 || n(9) > 59) { return false }
    return true
}

private func wholeNumber(_ v: JSONValue?) -> Double? {
    guard case .number(let d)? = v, d.isFinite, d == d.rounded(.towardZero) else { return nil }
    return d
}

private func isSemverValue(_ v: JSONValue?) -> Bool {
    if case .string(let s)? = v { return isSemver(s) }
    return false
}

private func isString(_ v: JSONValue?) -> Bool {
    if case .string? = v { return true }
    return false
}

private func checkEntry(_ entry: JSONValue, path: String, errors: inout [String]) {
    guard case .object(let e) = entry else {
        errors.append("\(path) must be an object")
        return
    }
    for key in e.keys.sorted() where !entryKeys.contains(key) { errors.append("\(path).\(key) is not allowed") }
    if !isDateTime(e["at"]) { errors.append("\(path).at must be an ISO 8601 date-time") }
    if case .string(let a)? = e["action"], actions.contains(a) {} else {
        errors.append("\(path).action must be one of \(actions.joined(separator: ", "))")
    }
    for key in ["from", "to"] {
        let v = e[key]
        if v == nil || (v != .null && !isString(v)) { errors.append("\(path).\(key) must be a string or null") }
    }
    if let by = e["by"], !isString(by) { errors.append("\(path).by must be a string") }
}

/// Checks a record by hand. It never throws. Each error names the field.
public func validateRecord(_ value: JSONValue) -> ValidationResult {
    guard case .object(let rec) = value else {
        return ValidationResult(ok: false, errors: ["record must be an object"])
    }
    var errors: [String] = []

    for key in rec.keys.sorted() where !keys.contains(key) { errors.append("\(key) is not allowed") }
    if let s = rec["$schema"], !isString(s) { errors.append("$schema must be a string") }
    if case .string(let m)? = rec["module"], fullMatch(slugRegex, m) != nil {} else {
        errors.append("module must be a lower-case slug such as \"billing\" or \"sign-in\"")
    }
    let last = rec["last"]
    if last == nil || (last != .null && !isSemverValue(last)) { errors.append("last must be a semver string or null") }
    if !isSemverValue(rec["current"]) { errors.append("current must be a semver string") }
    let next = rec["next"]
    if next == nil || (next != .null && !isSemverValue(next)) { errors.append("next must be a semver string or null") }
    let rollout = wholeNumber(rec["rollout"])
    if rollout == nil || rollout! < 0 || rollout! > 100 { errors.append("rollout must be an integer from 0 to 100") }
    if case .bool? = rec["healthy"] {} else { errors.append("healthy must be a boolean") }
    if !isDateTime(rec["updatedAt"]) { errors.append("updatedAt must be an ISO 8601 date-time") }

    if let history = rec["history"] {
        if case .array(let items) = history {
            for (i, e) in items.enumerated() { checkEntry(e, path: "history[\(i)]", errors: &errors) }
        } else {
            errors.append("history must be an array")
        }
    }

    if errors.isEmpty, case .string(let current)? = rec["current"] {
        if case .string(let n)? = next, (try? compareSemver(n, current)) ?? 0 <= 0 {
            errors.append("next must be greater than current")
        }
        if case .string(let l)? = last, (try? compareSemver(l, current)) ?? 0 >= 0 {
            errors.append("last must be lower than current")
        }
        if next == .null, rollout != 0 { errors.append("rollout must be 0 when next is null") }
    }
    return ValidationResult(ok: errors.isEmpty, errors: errors)
}
