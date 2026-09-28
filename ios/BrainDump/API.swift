import Foundation
import Security

/// Talks to the Brain Dump server. The sign-in token lives in the Keychain; the server
/// address comes from the build (Info.plist BDServerURL) or from the page itself.
enum BrainDumpAPI {
    enum Failure: LocalizedError {
        case notSignedIn, server(String), offline
        var errorDescription: String? {
            switch self {
            case .notSignedIn: return "Open Brain Dump once to sign in."
            case .server(let m): return m
            case .offline: return "I can’t reach Brain Dump right now."
            }
        }
    }

    static var server: URL {
        if let s = Shared.defaults.string(forKey: "server"), let u = URL(string: s) { return u }
        let plist = (Bundle.main.object(forInfoDictionaryKey: "BDServerURL") as? String) ?? ""
        return URL(string: plist) ?? URL(string: "https://brain-dump.onrender.com")!
    }

    static func setSession(token: String, server: String) {
        Keychain.set(token, for: "token")
        if URL(string: server) != nil { Shared.defaults.set(server, forKey: "server") }
    }

    static var token: String? { Keychain.get("token") }

    /// JSON in, JSON out.
    @discardableResult
    static func call(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let token else { throw Failure.notSignedIn }
        var base = server.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base + (path.hasPrefix("/") ? path : "/" + path)) else { throw Failure.server("Bad address.") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw Failure.offline
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw Failure.notSignedIn }
        if !(200..<300).contains(status) { throw Failure.server(json["error"] as? String ?? "Brain Dump had a problem (\(status)).") }
        return json
    }

    /// Say something to Brain Dump (as Siri does). The phone's own apps are updated right after.
    static func say(_ text: String) async throws -> String {
        let r = try await call("/api/quick?client=native", method: "POST", body: ["text": text])
        await DeviceAgent.shared.runOutbox()
        await DeviceAgent.shared.refreshWidget()
        return (r["text"] as? String) ?? "Done."
    }
}

/// Minimal Keychain wrapper for the sign-in token (this device only).
enum Keychain {
    private static let service = "app.braindump"

    static func set(_ value: String, for key: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key,
            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
