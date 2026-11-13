import Foundation
import Security

/// Where the reader's AI keys live.
public protocol KeyVault: Sendable {
    func load() -> ByokSettings
    func save(_ settings: ByokSettings) throws
    func clear() throws
}

/// The macOS Keychain. Keys never touch the library folder, backups or logs.
public struct KeychainVault: KeyVault {
    let service: String
    let account = "byok-settings"

    public init(service: String = "com.isnalcan.peryda.mac.byok") {
        self.service = service
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() -> ByokSettings {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
              let settings = try? JSONDecoder().decode(ByokSettings.self, from: data)
        else { return ByokSettings() }
        return settings
    }

    public func save(_ settings: ByokSettings) throws {
        let data = try JSONEncoder().encode(settings)
        let status = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = baseQuery
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
            let added = SecItemAdd(add as CFDictionary, nil)
            guard added == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(added)) }
        } else if status != errSecSuccess {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
    }

    public func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}

/// Keeps keys only for this run ("do not remember on this Mac") and in tests.
public final class MemoryVault: KeyVault, @unchecked Sendable {
    private var settings = ByokSettings()
    private let lock = NSLock()

    public init() {}

    public func load() -> ByokSettings { lock.withLock { settings } }
    public func save(_ settings: ByokSettings) throws { lock.withLock { self.settings = settings } }
    public func clear() throws { lock.withLock { settings = ByokSettings() } }
}
