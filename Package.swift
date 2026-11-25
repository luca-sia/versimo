// swift-tools-version:5.9
// Lets SwiftPM add this repository by URL. The code lives in packages/swift.
import PackageDescription

let package = Package(
    name: "Versimo",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "Versimo", targets: ["Versimo"]),
    ],
    targets: [
        .target(name: "Versimo", path: "packages/swift/Sources/Versimo"),
    ]
)
