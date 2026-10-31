// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OtaUnzip",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "OtaUnzip",
            targets: ["OtaUnzipPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.0")
    ],
    targets: [
        .target(
            name: "OtaUnzipPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "ZIPFoundation", package: "ZIPFoundation")
            ],
            path: "ios/Sources/OtaUnzipPlugin")
    ]
)
