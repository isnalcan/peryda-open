// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PerydaKit",
    defaultLocalization: "tr",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "PerydaKit", targets: ["PerydaKit"]),
    ],
    dependencies: [
        // Same versions as the iPhone app: backups and EPUB archives (ZIP), EPUB markup cleaning (SwiftSoup).
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", exact: "0.9.20"),
        .package(url: "https://github.com/scinfu/SwiftSoup.git", exact: "2.13.9"),
    ],
    targets: [
        .target(
            name: "PerydaKit",
            dependencies: [
                .product(name: "ZIPFoundation", package: "ZIPFoundation"),
                .product(name: "SwiftSoup", package: "SwiftSoup"),
            ],
            resources: [.copy("Resources/shared")]
        ),
        .testTarget(
            name: "PerydaKitTests",
            dependencies: ["PerydaKit"]
        ),
    ]
)
