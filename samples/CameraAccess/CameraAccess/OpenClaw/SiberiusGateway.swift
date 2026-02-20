import Foundation

/// SiberiusGateway replaces OpenClawBridge.
///
/// Same interface (delegateTask, checkConnection, resetSession) so
/// ToolCallRouter and GeminiSessionViewModel need zero logic changes.
///
/// Talks to the Siberius Gateway HTTP service instead of OpenClaw.
/// Supports both /execute (direct) and /v1/chat/completions (OpenAI-compat).
@MainActor
class SiberiusGateway: ObservableObject {
  @Published var lastToolCallStatus: ToolCallStatus = .idle
  @Published var connectionState: OpenClawConnectionState = .notConfigured

  private let session: URLSession
  private let pingSession: URLSession
  private var sessionKey: String
  private var conversationHistory: [[String: String]] = []
  private let maxHistoryTurns = 10

  init() {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 120
    self.session = URLSession(configuration: config)

    let pingConfig = URLSessionConfiguration.default
    pingConfig.timeoutIntervalForRequest = 5
    self.pingSession = URLSession(configuration: pingConfig)

    self.sessionKey = SiberiusGateway.newSessionKey()
  }

  // MARK: - Connection Check (hits /health on Siberius Gateway)

  func checkConnection() async {
    guard GeminiConfig.isOpenClawConfigured else {
      connectionState = .notConfigured
      return
    }
    connectionState = .checking
    guard let url = URL(string: "\(GeminiConfig.openClawHost):\(GeminiConfig.openClawPort)/health") else {
      connectionState = .unreachable("Invalid URL")
      return
    }
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    do {
      let (_, response) = try await pingSession.data(for: request)
      if let http = response as? HTTPURLResponse, http.statusCode == 200 {
        connectionState = .connected
        NSLog("[Siberius] Gateway reachable")
      } else {
        connectionState = .unreachable("Unexpected response")
      }
    } catch {
      connectionState = .unreachable(error.localizedDescription)
      NSLog("[Siberius] Gateway unreachable: %@", error.localizedDescription)
    }
  }

  func resetSession() {
    sessionKey = SiberiusGateway.newSessionKey()
    conversationHistory = []
    NSLog("[Siberius] New session: %@", sessionKey)
  }

  private static func newSessionKey() -> String {
    let ts = ISO8601DateFormatter().string(from: Date())
    return "siberius:main:glass:\(ts)"
  }

  // MARK: - Core Task Delegation

  func delegateTask(
    task: String,
    toolName: String = "execute"
  ) async -> ToolResult {
    lastToolCallStatus = .executing(toolName)

    guard let url = URL(string: "\(GeminiConfig.openClawHost):\(GeminiConfig.openClawPort)/v1/chat/completions") else {
      lastToolCallStatus = .failed(toolName, "Invalid URL")
      return .failure("Invalid gateway URL")
    }

    // Append the new user message
    conversationHistory.append(["role": "user", "content": task])

    // Trim history
    if conversationHistory.count > maxHistoryTurns * 2 {
      conversationHistory = Array(conversationHistory.suffix(maxHistoryTurns * 2))
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer \(GeminiConfig.openClawGatewayToken)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(sessionKey, forHTTPHeaderField: "x-siberius-session-key")

    let body: [String: Any] = [
      "model": "siberius",
      "messages": conversationHistory,
      "stream": false
    ]

    NSLog("[Siberius] Sending %d messages", conversationHistory.count)

    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      let (data, response) = try await session.data(for: request)
      let httpResponse = response as? HTTPURLResponse

      guard let statusCode = httpResponse?.statusCode, (200...299).contains(statusCode) else {
        let code = httpResponse?.statusCode ?? 0
        let bodyStr = String(data: data, encoding: .utf8) ?? "no body"
        NSLog("[Siberius] Failed: HTTP %d - %@", code, String(bodyStr.prefix(200)))
        lastToolCallStatus = .failed(toolName, "HTTP \(code)")
        return .failure("Siberius returned HTTP \(code)")
      }

      if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        // Check for safety gate confirmation
        if let siberius = json["siberius"] as? [String: Any],
           let confirmationRequired = siberius["confirmationRequired"] as? Bool,
           confirmationRequired {
          let summary = siberius["confirmationSummary"] as? String ?? "Action requires confirmation"
          NSLog("[Siberius] Safety gate triggered: %@", summary)
          lastToolCallStatus = .completed(toolName)
          return .success(summary)
        }

        if let choices = json["choices"] as? [[String: Any]],
           let first = choices.first,
           let message = first["message"] as? [String: Any],
           let content = message["content"] as? String {
          conversationHistory.append(["role": "assistant", "content": content])
          NSLog("[Siberius] Result: %@", String(content.prefix(200)))
          lastToolCallStatus = .completed(toolName)
          return .success(content)
        }
      }

      let raw = String(data: data, encoding: .utf8) ?? "OK"
      conversationHistory.append(["role": "assistant", "content": raw])
      NSLog("[Siberius] Raw: %@", String(raw.prefix(200)))
      lastToolCallStatus = .completed(toolName)
      return .success(raw)
    } catch {
      NSLog("[Siberius] Error: %@", error.localizedDescription)
      lastToolCallStatus = .failed(toolName, error.localizedDescription)
      return .failure("Siberius error: \(error.localizedDescription)")
    }
  }
}
