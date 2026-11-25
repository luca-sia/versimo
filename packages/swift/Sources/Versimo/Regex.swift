import Foundation

/// Groups of a match that covers the whole string, or nil. Missing groups are nil.
/// The patterns end with `\z` so a trailing newline never matches.
func fullMatch(_ regex: NSRegularExpression, _ text: String) -> [String?]? {
    let ns = NSString(string: text)
    let full = NSRange(location: 0, length: ns.length)
    guard let m = regex.firstMatch(in: text, options: [], range: full), m.range == full else { return nil }
    return (0..<m.numberOfRanges).map { i in
        let r = m.range(at: i)
        return r.location == NSNotFound ? nil : ns.substring(with: r)
    }
}
