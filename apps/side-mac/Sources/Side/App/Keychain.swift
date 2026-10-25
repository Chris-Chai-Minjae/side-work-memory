import Foundation
import LocalAuthentication
import Security

protocol SideKeyStore: Sendable {
    func masterKey() throws -> Data
    func rotateMasterKey() throws -> Data
    func setProviderKey(ref: String, secret: String) throws
    func providerKey(ref: String) throws -> String?
    func providerKeyStatus(ref: String) throws -> (stored: Bool, accessible: Bool)
    func authorizeProviderKey(ref: String) throws -> Bool
}

enum SideKeychainError: Error {
    case invalidMasterKey
    case invalidProviderKey
    case randomGenerationFailed
    case keychain(OSStatus)
}

struct SideKeychain: SideKeyStore {
    static let masterService = "local-context-awareness-ledger"
    static let providerService = "side-provider-api-key"

    private let account: String

    init(account: String = NSUserName()) {
        self.account = account
    }

    func masterKey() throws -> Data {
        if let existing = try read(service: Self.masterService, account: account) {
            guard existing.count == 32 else { throw SideKeychainError.invalidMasterKey }
            return existing
        }

        let key = try randomKey()
        let status = SecItemAdd(addQuery(service: Self.masterService, account: account, data: key) as CFDictionary, nil)
        if status == errSecDuplicateItem {
            guard let existing = try read(service: Self.masterService, account: account), existing.count == 32 else {
                throw SideKeychainError.invalidMasterKey
            }
            return existing
        }
        guard status == errSecSuccess else { throw SideKeychainError.keychain(status) }
        return key
    }

    func rotateMasterKey() throws -> Data {
        let replacement = try randomKey()
        let query = itemQuery(service: Self.masterService, account: account)
        return try Self.replaceMasterKey(replacement, update: {
            SecItemUpdate(query as CFDictionary, [kSecValueData as String: replacement] as CFDictionary)
        }, add: {
            SecItemAdd(addQuery(service: Self.masterService, account: account, data: replacement) as CFDictionary, nil)
        })
    }

    static func replaceMasterKey(
        _ replacement: Data,
        update: () -> OSStatus,
        add: () -> OSStatus
    ) throws -> Data {
        let updateStatus = update()
        if updateStatus == errSecSuccess { return replacement }
        guard updateStatus == errSecItemNotFound else { throw SideKeychainError.keychain(updateStatus) }
        let addStatus = add()
        guard addStatus == errSecSuccess else { throw SideKeychainError.keychain(addStatus) }
        return replacement
    }

    func setProviderKey(ref: String, secret: String) throws {
        guard !ref.isEmpty, !secret.isEmpty, let data = secret.data(using: .utf8) else {
            throw SideKeychainError.invalidProviderKey
        }
        let status = SecItemAdd(addQuery(service: Self.providerService, account: ref, data: data) as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(
                itemQuery(service: Self.providerService, account: ref) as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            guard updateStatus == errSecSuccess else { throw SideKeychainError.keychain(updateStatus) }
            return
        }
        guard status == errSecSuccess else { throw SideKeychainError.keychain(status) }
    }

    func providerKey(ref: String) throws -> String? {
        guard !ref.isEmpty else { throw SideKeychainError.invalidProviderKey }
        guard let data = try read(service: Self.providerService, account: ref, nonInteractive: true) else { return nil }
        guard let secret = String(data: data, encoding: .utf8) else {
            throw SideKeychainError.invalidProviderKey
        }
        return secret
    }

    func providerKeyStatus(ref: String) throws -> (stored: Bool, accessible: Bool) {
        guard !ref.isEmpty else { throw SideKeychainError.invalidProviderKey }
        let query = nonInteractiveQuery(service: Self.providerService, account: ref, returnAttributes: true)
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return (false, false) }
        if status == errSecInteractionNotAllowed { return (true, false) }
        guard status == errSecSuccess else { throw SideKeychainError.keychain(status) }
        do {
            return (true, try providerKey(ref: ref)?.isEmpty == false)
        } catch SideKeychainError.keychain(let error) where error == errSecInteractionNotAllowed || error == errSecAuthFailed {
            return (true, false)
        }
    }

    func authorizeProviderKey(ref: String) throws -> Bool {
        guard !ref.isEmpty else { throw SideKeychainError.invalidProviderKey }
        do {
            return try read(service: Self.providerService, account: ref) != nil
        } catch SideKeychainError.keychain(let status) where status == errSecUserCanceled || status == errSecAuthFailed {
            return false
        }
    }

    private func read(service: String, account: String, nonInteractive: Bool = false) throws -> Data? {
        let query: [String: Any]
        if nonInteractive {
            query = nonInteractiveQuery(service: service, account: account, returnAttributes: false)
        } else {
            var interactiveQuery = itemQuery(service: service, account: account)
            interactiveQuery[kSecReturnData as String] = true
            interactiveQuery[kSecMatchLimit as String] = kSecMatchLimitOne
            query = interactiveQuery
        }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SideKeychainError.keychain(status) }
        guard let data = item as? Data else { throw SideKeychainError.invalidProviderKey }
        return data
    }

    func nonInteractiveQuery(service: String, account: String, returnAttributes: Bool) -> [String: Any] {
        var query = itemQuery(service: service, account: account)
        query[(returnAttributes ? kSecReturnAttributes : kSecReturnData) as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let context = LAContext()
        context.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = context
        return query
    }

    private func itemQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func addQuery(service: String, account: String, data: Data) -> [String: Any] {
        var query = itemQuery(service: service, account: account)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return query
    }

    private func randomKey() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw SideKeychainError.randomGenerationFailed
        }
        return Data(bytes)
    }
}
