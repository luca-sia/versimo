/// Maps a module and user to a stable bucket from 0 to 99.
/// FNV-1a over the UTF-8 bytes of `module`, a NUL byte and `userId`,
/// then the murmur3 32-bit finaliser, then modulo 100.
public func bucketFor(module: String, userId: String) -> Int {
    var h: UInt32 = 0x811c9dc5
    for byte in (module + "\u{0}" + userId).utf8 {
        h ^= UInt32(byte)
        h = h &* 0x01000193
    }
    h ^= h >> 16
    h = h &* 0x85ebca6b
    h ^= h >> 13
    h = h &* 0xc2b2ae35
    h ^= h >> 16
    return Int(h % 100)
}
