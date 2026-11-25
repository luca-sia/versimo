package dev.versimo

/**
 * Maps a module and user to a stable bucket from 0 to 99.
 * FNV-1a over the UTF-8 bytes of [module], a NUL byte and [userId],
 * then the murmur3 32-bit finaliser, then modulo 100.
 */
fun bucketFor(module: String, userId: String): Int {
    var h = 0x811c9dc5.toInt()
    for (byte in "$module\u0000$userId".toByteArray(Charsets.UTF_8)) {
        h = h xor (byte.toInt() and 0xff)
        h *= 0x01000193
    }
    h = h xor (h ushr 16)
    h *= 0x85ebca6b.toInt()
    h = h xor (h ushr 13)
    h *= 0xc2b2ae35.toInt()
    h = h xor (h ushr 16)
    return ((h.toLong() and 0xffffffffL) % 100).toInt()
}
