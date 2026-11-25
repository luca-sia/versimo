// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Versimo",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "Versimo", targets: ["Versimo"]),
    ],
    targets: [
        .target(name: "Versimo"),
        .testTarget(
            name: "VersimoTests",
            dependencies: ["Versimo"],
            resources: [.copy("Resources")]
        ),
    ]
)
