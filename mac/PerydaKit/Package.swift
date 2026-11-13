// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PerydaKit",
    defaultLocalization: "tr",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "PerydaKit", targets: ["PerydaKit"]),
        // Sparkle, for the downloaded Mac app's update check only. Declared here so that one
        // Package.resolved pins every package the app is built from.
        .library(name: "PerydaUpdater", targets: ["PerydaUpdater"]),
    ],
    dependencies: [
        // Same versions as the iPhone app: backups and EPUB archives (ZIP), EPUB markup cleaning (SwiftSoup).
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", exact: "0.9.20"),
        .package(url: "https://github.com/scinfu/SwiftSoup.git", exact: "2.13.9"),
        // Pinned to the commit of Sparkle 2.10.1, whose Package.swift carries the checksum of the
        // framework it downloads, so a moved tag cannot change what is shipped.
        .package(url: "https://github.com/sparkle-project/Sparkle", revision: "ab7d71291238df6e0492143b120c9b696a35f603"),
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
        .target(
            name: "PerydaUpdater",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")]
        ),
        .testTarget(
            name: "PerydaKitTests",
            dependencies: ["PerydaKit"]
        ),
    ]
)
