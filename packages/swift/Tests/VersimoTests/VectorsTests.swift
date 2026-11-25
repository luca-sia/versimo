import Foundation
import XCTest
import Versimo

private extension JSONValue {
    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }
    var items: [JSONValue] {
        if case .array(let a) = self { return a }
        return []
    }
    var text: String? {
        if case .string(let s) = self { return s }
        return nil
    }
    var int: Int? {
        if case .number(let d) = self { return Int(d) }
        return nil
    }
    var bool: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
}

private func loadVectors() throws -> JSONValue {
    let bundle = Bundle.module
    let url = bundle.url(forResource: "vectors", withExtension: "json", subdirectory: "Resources")
        ?? bundle.url(forResource: "vectors", withExtension: "json")
    let data = try Data(contentsOf: try XCTUnwrap(url, "vectors.json is missing from the test bundle"))
    return try JSONDecoder().decode(JSONValue.self, from: data)
}

private func parseDate(_ text: String) throws -> Date {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return try XCTUnwrap(f.date(from: text), "bad date \(text)")
}

final class VectorsTests: XCTestCase {
    func testBucket() throws {
        let cases = try XCTUnwrap(loadVectors()["bucket"]).items
        XCTAssertGreaterThanOrEqual(cases.count, 40)
        for c in cases {
            let module = try XCTUnwrap(c["module"]?.text)
            let user = try XCTUnwrap(c["userId"]?.text)
            XCTAssertEqual(bucketFor(module: module, userId: user), c["bucket"]?.int, "\(module) \(user)")
        }
    }

    func testResolve() throws {
        for c in try XCTUnwrap(loadVectors()["resolve"]).items {
            let name = c["name"]?.text ?? ""
            let record = try ModuleRecord(json: try XCTUnwrap(c["record"]))
            let r = resolve(record, userId: c["userId"]?.text)
            let e = try XCTUnwrap(c["expected"])
            XCTAssertEqual(r.version, e["version"]?.text, name)
            XCTAssertEqual(r.channel.rawValue, e["channel"]?.text, name)
            XCTAssertEqual(r.reason.rawValue, e["reason"]?.text, name)
            XCTAssertEqual(r.bucket, e["bucket"]?.int, name)
        }
    }

    func testTransitions() throws {
        for c in try XCTUnwrap(loadVectors()["transitions"]).items {
            let name = c["name"]?.text ?? ""
            let record = try ModuleRecord(json: try XCTUnwrap(c["record"]))
            let args = try XCTUnwrap(c["args"])
            let options = TransitionOptions(
                by: c["by"]?.text, now: try parseDate(try XCTUnwrap(c["now"]?.text)), reason: c["reason"]?.text
            )
            let op = c["op"]?.text ?? ""

            func run() throws -> ModuleRecord {
                switch op {
                case "promote": return try promote(record, options: options)
                case "rollback": return try rollback(record, options: options)
                case "setRollout":
                    guard case .number(let n)? = args["n"] else { throw VersimoError(.invalidInput, "n") }
                    // The Int parameter rules out a fraction, so a fraction is an error here too.
                    if n != n.rounded(.towardZero) { throw VersimoError(.invalidInput, "fraction") }
                    return try setRollout(record, to: Int(n), options: options)
                case "draftNext":
                    var patch = false
                    if case .bool(let p)? = args["patch"] { patch = p }
                    return try draftNext(record, version: try XCTUnwrap(args["version"]?.text), options: options, patch: patch)
                default:
                    XCTFail("unknown op \(op)")
                    return record
                }
            }

            if let code = c["error"]?.text {
                XCTAssertThrowsError(try run(), name) { error in
                    XCTAssertEqual((error as? VersimoError)?.code.rawValue, code, name)
                }
            } else {
                let out = try run()
                XCTAssertEqual(out.jsonValue, c["expected"], name)
            }
        }
    }

    func testValidation() throws {
        for c in try XCTUnwrap(loadVectors()["validation"]).items {
            let name = c["name"]?.text ?? ""
            let r = validateRecord(try XCTUnwrap(c["record"]))
            XCTAssertEqual(r.ok, c["ok"]?.bool, name)
            let fields = r.errors.map { String($0.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: false)[0]) }
            XCTAssertEqual(fields, c["errors"]?.items.compactMap { $0.text }, name)
        }
    }

    /// Thrown when the Swift types rule out a vector input, such as a fraction for a count.
    private struct TypeRuledOut: Error {}

    private func number(_ v: JSONValue?) throws -> Double? {
        switch v {
        case nil, .null?: return nil
        case .number(let d)?: return d
        default: throw TypeRuledOut()
        }
    }

    private func count(_ v: JSONValue?) throws -> Int? {
        guard let d = try number(v) else { return nil }
        guard d == d.rounded(.towardZero) else { throw TypeRuledOut() }
        return Int(d)
    }

    func testHealth() throws {
        for c in try XCTUnwrap(loadVectors()["health"]).items {
            let name = c["name"]?.text ?? ""
            let code = c["error"]?.text
            let ch = try XCTUnwrap(c["checks"])
            let ob = try XCTUnwrap(c["observation"])
            let checks: HealthChecks
            let observation: HealthObservation
            do {
                if let url = ch["url"], url.text == nil { throw TypeRuledOut() }
                checks = HealthChecks(
                    maxErrorRate: try number(ch["maxErrorRate"]), maxLatencyMs: try number(ch["maxLatencyMs"]),
                    url: ch["url"]?.text, minRequests: try count(ch["minRequests"])
                )
                observation = HealthObservation(
                    requests: try count(ob["requests"]), errors: try count(ob["errors"]),
                    latencyMs: try number(ob["latencyMs"]), urlStatus: try count(ob["urlStatus"])
                )
            } catch is TypeRuledOut {
                XCTAssertEqual(code, "INVALID_INPUT", "\(name): input the types reject should be an error case")
                continue
            }
            let record = try ModuleRecord(json: try XCTUnwrap(c["record"]))
            let options = TransitionOptions(by: c["by"]?.text, now: try parseDate(try XCTUnwrap(c["now"]?.text)))
            if let code {
                XCTAssertThrowsError(try checkHealth(record, checks: checks, observation: observation, options: options), name) { error in
                    XCTAssertEqual((error as? VersimoError)?.code.rawValue, code, name)
                }
                continue
            }
            let r = try checkHealth(record, checks: checks, observation: observation, options: options)
            let e = try XCTUnwrap(c["expected"])
            let v = try XCTUnwrap(e["verdict"])
            XCTAssertEqual(r.record.jsonValue, e["record"], name)
            XCTAssertEqual(r.rolledBack, e["rolledBack"]?.bool, name)
            XCTAssertEqual(r.verdict.healthy, v["healthy"]?.bool, name)
            let want = try XCTUnwrap(v["failures"]).items.map { f in
                HealthFailure(check: f["check"]?.text ?? "", value: try number(f["value"]) ?? .nan, limit: try number(f["limit"]))
            }
            XCTAssertEqual(r.verdict.failures, want, name)
        }
    }

    func testSemver() throws {
        let s = try XCTUnwrap(loadVectors()["semver"])
        for c in try XCTUnwrap(s["compare"]).items {
            let a = try XCTUnwrap(c["a"]?.text)
            let b = try XCTUnwrap(c["b"]?.text)
            XCTAssertEqual(try compareSemver(a, b), c["expected"]?.int, "\(a) vs \(b)")
        }
        for c in try XCTUnwrap(s["valid"]).items {
            let value = try XCTUnwrap(c["value"]?.text)
            XCTAssertEqual(isSemver(value), c["valid"]?.bool, "\"\(value)\"")
        }
    }
}
