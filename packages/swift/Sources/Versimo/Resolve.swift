/// Works out which version of the module this user gets, and why.
/// A nil or empty `userId` means no user.
public func resolve(_ record: ModuleRecord, userId: String? = nil) -> Resolution {
    if !record.healthy {
        if let last = record.last {
            return Resolution(version: last, channel: .last, reason: .unhealthy, bucket: nil)
        }
        return Resolution(version: record.current, channel: .current, reason: .unhealthy, bucket: nil)
    }
    guard let userId, !userId.isEmpty else {
        return Resolution(version: record.current, channel: .current, reason: .noUser, bucket: nil)
    }
    let bucket = bucketFor(module: record.module, userId: userId)
    if let next = record.next, bucket < record.rollout {
        return Resolution(version: next, channel: .next, reason: .rollout, bucket: bucket)
    }
    return Resolution(version: record.current, channel: .current, reason: .default, bucket: bucket)
}

public func resolveVersion(_ record: ModuleRecord, userId: String? = nil) -> String {
    resolve(record, userId: userId).version
}
