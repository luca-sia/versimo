package versimo

// BucketFor maps a module and user to a stable bucket from 0 to 99.
// FNV-1a over the UTF-8 bytes of module, a NUL byte and userID,
// then the murmur3 32-bit finaliser, then modulo 100.
func BucketFor(module, userID string) int {
	h := uint32(0x811c9dc5)
	for _, b := range []byte(module + "\x00" + userID) {
		h ^= uint32(b)
		h *= 0x01000193
	}
	h ^= h >> 16
	h *= 0x85ebca6b
	h ^= h >> 13
	h *= 0xc2b2ae35
	h ^= h >> 16
	return int(h % 100)
}
