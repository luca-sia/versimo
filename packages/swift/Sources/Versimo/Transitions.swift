import Foundation

private func stamp(_ options: TransitionOptions) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: options.now ?? Date())
}

private func applying(
    _ record: ModuleRecord, action: String, from: String?, to: String?, options: TransitionOptions,
    change: (inout ModuleRecord) -> Void
) -> ModuleRecord {
    let at = stamp(options)
    var out = record
    change(&out)
    out.updatedAt = at
    out.history = (record.history ?? []) + [HistoryEntry(at: at, action: action, from: from, to: to, by: options.by)]
    return out
}

/// Sets a new next version at 0% rollout. It replaces any next already drafted.
public func draftNext(
    _ record: ModuleRecord, version: String, options: TransitionOptions = TransitionOptions(), patch: Bool = false
) throws -> ModuleRecord {
    guard isSemver(version) else { throw VersimoError(.invalidInput, "Invalid semver: \(version)") }
    guard try compareSemver(version, record.current) > 0 else {
        throw VersimoError(.invalidInput, "Next \(version) must be greater than current \(record.current)")
    }
    return applying(
        record, action: patch ? "patch" : "draft", from: record.next ?? record.current, to: version, options: options
    ) {
        $0.next = version
        $0.rollout = 0
    }
}

/// Moves next to current and current to last. Rollout resets to 0.
public func promote(_ record: ModuleRecord, options: TransitionOptions = TransitionOptions()) throws -> ModuleRecord {
    guard let next = record.next else { throw VersimoError(.invalidInput, "Nothing to promote: next is empty") }
    return applying(record, action: "promote", from: record.current, to: next, options: options) {
        $0.last = record.current
        $0.current = next
        $0.next = nil
        $0.rollout = 0
        $0.healthy = true
    }
}

/// Puts last back as current. The failed version and any drafted next are dropped,
/// so there is nothing left to roll back to until the next promote.
public func rollback(_ record: ModuleRecord, options: TransitionOptions = TransitionOptions()) throws -> ModuleRecord {
    guard let last = record.last else { throw VersimoError(.invalidInput, "Nothing to roll back to: last is empty") }
    return applying(record, action: "rollback", from: record.current, to: last, options: options) {
        $0.last = nil
        $0.current = last
        $0.next = nil
        $0.rollout = 0
        $0.healthy = true
    }
}

/// Sets the share of users on next, an integer from 0 to 100.
public func setRollout(
    _ record: ModuleRecord, to n: Int, options: TransitionOptions = TransitionOptions()
) throws -> ModuleRecord {
    guard n >= 0, n <= 100 else { throw VersimoError(.invalidInput, "Rollout must be an integer from 0 to 100") }
    if n > 0 && record.next == nil { throw VersimoError(.invalidInput, "Cannot roll out: next is empty") }
    return applying(record, action: "rollout", from: String(record.rollout), to: String(n), options: options) {
        $0.rollout = n
    }
}
