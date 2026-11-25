import Foundation

private let ident = "(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)"

/// The same expression the JSON Schema uses, with `\z` for the end.
public let semverPattern =
    "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)"
    + "(?:-(\(ident)(?:\\.\(ident))*))?"
    + "(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?\\z"

// The pattern is a constant, so it always compiles.
private let semverRegex = try! NSRegularExpression(pattern: semverPattern)

public func isSemver(_ value: String) -> Bool {
    fullMatch(semverRegex, value) != nil
}

private struct Parsed {
    let core: [String]
    let pre: [String]
}

private func parse(_ value: String) throws -> Parsed {
    guard let g = fullMatch(semverRegex, value) else {
        throw VersimoError(.invalidInput, "Invalid semver: \(value)")
    }
    let pre = g[4].map { $0.split(separator: ".", omittingEmptySubsequences: false).map(String.init) } ?? []
    return Parsed(core: [g[1] ?? "", g[2] ?? "", g[3] ?? ""], pre: pre)
}

// Numbers have no leading zeros, so length then text compares exactly, with no overflow.
private func cmpNumeric(_ a: String, _ b: String) -> Int {
    if a.count != b.count { return a.count < b.count ? -1 : 1 }
    return a == b ? 0 : (a < b ? -1 : 1)
}

private func isNumeric(_ s: String) -> Bool {
    !s.isEmpty && s.utf8.allSatisfy { $0 >= 48 && $0 <= 57 }
}

/// Returns -1, 0 or 1. Build metadata is ignored. Throws `invalidInput` for an invalid version.
public func compareSemver(_ a: String, _ b: String) throws -> Int {
    let x = try parse(a)
    let y = try parse(b)
    for i in 0..<3 {
        let c = cmpNumeric(x.core[i], y.core[i])
        if c != 0 { return c }
    }
    if x.pre.isEmpty && y.pre.isEmpty { return 0 }
    if x.pre.isEmpty { return 1 }
    if y.pre.isEmpty { return -1 }
    for i in 0..<max(x.pre.count, y.pre.count) {
        if i >= x.pre.count { return -1 }
        if i >= y.pre.count { return 1 }
        let p = x.pre[i]
        let q = y.pre[i]
        if p == q { continue }
        let pn = isNumeric(p)
        let qn = isNumeric(q)
        if pn && qn { return cmpNumeric(p, q) }
        if pn { return -1 }
        if qn { return 1 }
        return p < q ? -1 : 1
    }
    return 0
}
