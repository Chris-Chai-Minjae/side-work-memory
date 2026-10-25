import LocalAuthentication
import Security
import XCTest
@testable import Side

final class SideKeychainQueryTests: XCTestCase {
    func testMasterKeyRotationUpdatesBeforeAddAndNeverDeletesOnFailure() throws {
        let replacement = Data(repeating: 0x43, count: 32)
        var calls: [String] = []
        XCTAssertThrowsError(try SideKeychain.replaceMasterKey(replacement, update: {
            calls.append("update")
            return errSecAuthFailed
        }, add: {
            calls.append("add")
            return errSecSuccess
        }))
        XCTAssertEqual(calls, ["update"])

        calls.removeAll()
        XCTAssertThrowsError(try SideKeychain.replaceMasterKey(replacement, update: {
            calls.append("update")
            return errSecItemNotFound
        }, add: {
            calls.append("add")
            return errSecDuplicateItem
        }))
        XCTAssertEqual(calls, ["update", "add"])

        XCTAssertEqual(try SideKeychain.replaceMasterKey(replacement, update: {
            errSecSuccess
        }, add: {
            XCTFail("existing key must be updated, not added")
            return errSecSuccess
        }), replacement)
    }

    func testProviderMetadataQueryFailsWhenAuthenticationUIIsNeeded() throws {
        let query = SideKeychain(account: "synthetic").nonInteractiveQuery(
            service: SideKeychain.providerService, account: "synthetic-ref", returnAttributes: true
        )

        XCTAssertEqual(query[kSecReturnAttributes as String] as? Bool, true)
        XCTAssertNil(query[kSecReturnData as String])
        XCTAssertNil(query[kSecUseAuthenticationUI as String])
        XCTAssertEqual((query[kSecUseAuthenticationContext as String] as? LAContext)?.interactionNotAllowed, true)
    }

    func testProviderDataQueryFailsWhenAuthenticationUIIsNeeded() throws {
        let query = SideKeychain(account: "synthetic").nonInteractiveQuery(
            service: SideKeychain.providerService, account: "synthetic-ref", returnAttributes: false
        )

        XCTAssertEqual(query[kSecReturnData as String] as? Bool, true)
        XCTAssertNil(query[kSecReturnAttributes as String])
        XCTAssertNil(query[kSecUseAuthenticationUI as String])
        XCTAssertEqual((query[kSecUseAuthenticationContext as String] as? LAContext)?.interactionNotAllowed, true)
    }
}
