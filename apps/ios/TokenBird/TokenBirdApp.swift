import SwiftUI
import Security
import WebKit

private enum ConnectionStore {
    static let service = "top.goldgom.tokenbird.connection"
    static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "server"]
    }
    static func load() -> (String, String) {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let values = try? JSONDecoder().decode([String].self, from: data), values.count == 2 else {
            return ("", "")
        }
        return (values[0], values[1])
    }
    static func save(url: String, token: String) throws {
        let data = try JSONEncoder().encode([url, token])
        let update = [kSecValueData as String: data]
        var status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Unable to save the server connection in Keychain."])
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var serverURL: String
    @Published var token: String
    @Published var pageURL: URL?
    @Published var error = ""
    @Published var configuring: Bool
    @Published var reloadID = UUID()
    @Published var download: URL?
    private var server: LocalWebServer?

    init() {
        let connection = ConnectionStore.load()
        serverURL = connection.0
        token = connection.1
        configuring = connection.0.isEmpty
    }

    func connect() {
        let address = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: address), ["ws", "wss"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host, !host.isEmpty, url.user == nil, url.password == nil, url.fragment == nil else {
            error = "Enter a WebSocket address, for example wss://your-server.example:9100."; return
        }
        // Production connections use TLS. Permit unencrypted LAN development only.
        if url.scheme == "ws" {
            let octets = host.split(separator: ".").compactMap { Int($0) }
            let privateIPv4 = octets.count == 4 && octets.allSatisfy { (0...255).contains($0) }
                && (octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168)
                    || (octets[0] == 172 && (16...31).contains(octets[1])))
            guard privateIPv4 || host == "localhost" || host.hasSuffix(".local") else {
                error = "Use wss:// for servers outside your local network."; return
            }
        }
        do {
            try ConnectionStore.save(url: address, token: token)
            server?.stop()
            pageURL = nil
            error = ""
            let localServer = try LocalWebServer(serverURL: address, token: token)
            server = localServer
            try localServer.start { [weak self, weak localServer] result in
                guard let self, self.server === localServer else { return }
                switch result {
                case .success(let page):
                    self.pageURL = page
                    self.configuring = false
                case .failure(let error):
                    self.error = error.localizedDescription
                    self.configuring = true
                }
            }
        } catch { self.error = error.localizedDescription }
    }
}

@main
struct TokenBirdApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        WindowGroup {
            NavigationView {
                Group {
                    if let page = model.pageURL {
                        WebView(url: page, onError: { model.error = $0 }, onDownload: { model.download = $0 })
                            .id(model.reloadID)
                    } else {
                        SplashLoadingView()
                    }
                }
                .navigationTitle("TokenBird")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button { model.configuring = true } label: { Label("Server", systemImage: "server.rack") }
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { model.reloadID = UUID() } label: { Label("Reload", systemImage: "arrow.clockwise") }
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    if !model.error.isEmpty && !model.configuring {
                        Text(model.error).font(.caption).padding().frame(maxWidth: .infinity).background(.regularMaterial)
                    }
                }
            }
            .navigationViewStyle(StackNavigationViewStyle())
            .sheet(isPresented: $model.configuring) { ConnectionForm(model: model) }
            .sheet(isPresented: Binding(get: { model.download != nil }, set: { if !$0 { model.download = nil } })) {
                if let download = model.download { ShareSheet(url: download) }
            }
            .task { if !model.serverURL.isEmpty { model.connect() } }
        }
    }
}

private struct SplashLoadingView: View {
    @State private var active = false

    var body: some View {
        VStack(spacing: 22) {
            Image("AppIcon")
                .resizable()
                .scaledToFit()
                .frame(width: 112, height: 112)
                .scaleEffect(active ? 1 : 0.94)
                .opacity(active ? 1 : 0.72)
                .animation(.easeInOut(duration: 1.35).repeatForever(autoreverses: true), value: active)
            ProgressView()
                .tint(.accentColor)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .onAppear { active = true }
    }
}

private struct ConnectionForm: View {
    @ObservedObject var model: AppModel
    var body: some View {
        NavigationView {
            Form {
                Section("Agent server") {
                    TextField("wss://your-server.example:9100", text: $model.serverURL)
                        .textInputAutocapitalization(.never).disableAutocorrection(true).keyboardType(.URL)
                    SecureField("Server token", text: $model.token)
                        .textInputAutocapitalization(.never).disableAutocorrection(true)
                }
                Section {
                    Text("Connect to a TokenBird desktop or headless server. Conversations and agent tasks run on that server.")
                    if !model.error.isEmpty { Text(model.error).foregroundStyle(.red) }
                    Button("Save and connect") { model.connect() }.disabled(model.serverURL.isEmpty)
                }
            }
            .navigationTitle("Server connection")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if model.pageURL != nil {
                        Button("Cancel") { model.configuring = false }
                    }
                }
            }
        }
        .navigationViewStyle(StackNavigationViewStyle())
        .interactiveDismissDisabled(model.pageURL == nil)
    }
}

private struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct WebView: UIViewRepresentable {
    let url: URL
    let onError: (String) -> Void
    let onDownload: (URL) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.isOpaque = false
        view.load(URLRequest(url: url))
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
        private let parent: WebView
        private var downloads: [ObjectIdentifier: URL] = [:]
        init(_ parent: WebView) { self.parent = parent }
        private func local(_ url: URL) -> Bool {
            url.scheme == parent.url.scheme && url.host == parent.url.host && url.port == parent.url.port
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            if action.shouldPerformDownload { decisionHandler(.download); return }
            if action.targetFrame?.isMainFrame != false, !local(url), url.scheme != "blob", url.scheme != "about" {
                if ["https", "http", "mailto"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
                decisionHandler(.cancel); return
            }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url {
                if local(url) { webView.load(action.request) }
                else if ["https", "http"].contains(url.scheme ?? "") { UIApplication.shared.open(url) }
            }
            return nil
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled { parent.onError(error.localizedDescription) }
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.onError(error.localizedDescription) }
        func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
        func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let name = (suggestedFilename as NSString).lastPathComponent
                let file = folder.appendingPathComponent(name.isEmpty ? "TokenBird-export" : name)
                downloads[ObjectIdentifier(download)] = file
                completionHandler(file)
            } catch { parent.onError(error.localizedDescription); completionHandler(nil) }
        }
        func downloadDidFinish(_ download: WKDownload) {
            if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) { parent.onDownload(url) }
        }
        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            downloads.removeValue(forKey: ObjectIdentifier(download))
            parent.onError(error.localizedDescription)
        }
    }
}
