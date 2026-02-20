import Foundation

/// SiberiusToolCallRouter - drop-in replacement for ToolCallRouter.
/// Routes Gemini tool calls to SiberiusGateway instead of OpenClawBridge.
/// Same interface, same response format.
@MainActor
class SiberiusToolCallRouter {
  private let gateway: SiberiusGateway
  private var inFlightTasks: [String: Task<Void, Never>] = [:]

  init(gateway: SiberiusGateway) {
    self.gateway = gateway
  }

  func handleToolCall(
    _ call: GeminiFunctionCall,
    sendResponse: @escaping ([String: Any]) -> Void
  ) {
    let callId = call.id
    let callName = call.name

    NSLog("[SiberiusToolCall] Received: %@ (id: %@) args: %@",
          callName, callId, String(describing: call.args))

    let task = Task { @MainActor in
      let taskDesc = call.args["task"] as? String ?? String(describing: call.args)
      let result = await gateway.delegateTask(task: taskDesc, toolName: callName)

      guard !Task.isCancelled else {
        NSLog("[SiberiusToolCall] Task %@ was cancelled, skipping response", callId)
        return
      }

      NSLog("[SiberiusToolCall] Result for %@ (id: %@): %@",
            callName, callId, String(describing: result))

      let response = self.buildToolResponse(callId: callId, name: callName, result: result)
      sendResponse(response)

      self.inFlightTasks.removeValue(forKey: callId)
    }

    inFlightTasks[callId] = task
  }

  func cancelToolCalls(ids: [String]) {
    for id in ids {
      if let task = inFlightTasks[id] {
        NSLog("[SiberiusToolCall] Cancelling in-flight call: %@", id)
        task.cancel()
        inFlightTasks.removeValue(forKey: id)
      }
    }
    gateway.lastToolCallStatus = .cancelled(ids.first ?? "unknown")
  }

  func cancelAll() {
    for (id, task) in inFlightTasks {
      NSLog("[SiberiusToolCall] Cancelling in-flight call: %@", id)
      task.cancel()
    }
    inFlightTasks.removeAll()
  }

  // MARK: - Private

  private func buildToolResponse(
    callId: String,
    name: String,
    result: ToolResult
  ) -> [String: Any] {
    return [
      "toolResponse": [
        "functionResponses": [
          [
            "id": callId,
            "name": name,
            "response": result.responseValue
          ]
        ]
      ]
    ]
  }
}
