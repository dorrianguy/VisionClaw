# Siberius Gateway Integration for VisionClaw

## Overview

This document describes how VisionClaw has been modified to use the **Siberius Gateway** instead of OpenClaw. VisionClaw becomes a "wearable client" for the Siberius multi-agent system, turning Meta Ray-Ban glasses into a hands-free AI command center.

## Architecture

```
Meta Ray-Ban Glasses (or phone camera)
       |
       | video frames + mic audio
       v
iOS / Android App (VisionClaw)
       |
       | JPEG frames (~1fps) + PCM audio (16kHz)
       v
Gemini Live API (WebSocket)
       |
       |-- Audio response (PCM 24kHz) --> App --> Speaker
       |-- Tool calls (execute) -------> App --> Siberius Gateway
       |                                              |
       |                                     Intent Classifier
       |                                     /    |    |    \
       |                                  Comms Research Ops SmartHome
       |                                     |    |    |    |
       |                                     Safety Gates (confirm/deny)
       |                                              |
       |<---- Tool response (text) <----- App <-------+
       |
       v
  Gemini speaks the result via glasses speaker
```

## What Changed

### Files Modified (Android)
- `GeminiSessionViewModel.kt` - Swapped `OpenClawBridge` -> `SiberiusGateway`

### Files Modified (iOS)
- `GeminiSessionViewModel.swift` - Swapped `OpenClawBridge` -> `SiberiusGateway`

### Files Added (Android)
- `siberius/SiberiusGateway.kt` - Drop-in replacement for OpenClawBridge
- `siberius/SiberiusToolCallRouter.kt` - Drop-in replacement for ToolCallRouter

### Files Added (iOS)
- `Siberius/SiberiusGateway.swift` - Drop-in replacement for OpenClawBridge
- `Siberius/SiberiusToolCallRouter.swift` - Drop-in replacement for ToolCallRouter

### Files Added (Server)
- `siberius-gateway/` - Node.js/TypeScript HTTP service

### Files NOT Changed
- `ToolCallModels.kt/.swift` - Data models remain identical
- `GeminiLiveService.kt/.swift` - Gemini WebSocket untouched
- `GeminiConfig.kt/.swift` - Config structure reused (host/port/token fields)
- `WebRTC/*` - Completely independent layer
- `AudioManager.kt/.swift` - Audio pipeline untouched

## Setup

### Step 1: Enable Meta Ray-Ban Developer Mode

1. Open the **Meta AI** app on your phone
2. Go to **Settings** (gear icon)
3. Tap **App Info**
4. Tap the **App version** number **5 times** -- unlocks Developer Mode
5. Go back to Settings -- toggle **Developer Mode** on

### Step 2: Start the Siberius Gateway

```bash
cd VisionClaw/siberius-gateway
cp .env.example .env
# Edit .env with your API key

npm install
npm run dev
```

The gateway starts on port 3000, bound to 0.0.0.0 (LAN accessible).

Verify it's running:
```bash
curl http://localhost:3000/health
```

### Step 3: Configure VisionClaw App

#### Android (`Secrets.kt`)
```kotlin
object Secrets {
    const val geminiAPIKey = "YOUR_GEMINI_API_KEY"
    const val openClawHost = "http://YOUR_PC_IP"  // e.g., http://192.168.1.100
    const val openClawPort = 3000
    const val openClawHookToken = ""
    const val openClawGatewayToken = "your-siberius-api-key"
    const val webrtcSignalingURL = "wss://YOUR_SIGNALING_SERVER"
}
```

#### iOS (`Secrets.swift`)
```swift
enum Secrets {
    static let geminiAPIKey = "YOUR_GEMINI_API_KEY"
    static let openClawHost = "http://YOUR_PC_IP"
    static let openClawPort = 3000
    static let openClawHookToken = ""
    static let openClawGatewayToken = "your-siberius-api-key"
    static let webrtcSignalingURL = "ws://YOUR_PC_IP:8080"
}
```

> **Note:** The field names still say "openClaw" because GeminiConfig reads them. The actual connection goes to Siberius Gateway.

### Step 4: Build and Run

**Android:** Open `samples/CameraAccessAndroid/` in Android Studio, build, run on device.

**iOS:** Open `samples/CameraAccess/CameraAccess.xcodeproj` in Xcode, build, run on device.

### Step 5: Talk to Siberius

- Without glasses: Tap "Start on Phone/iPhone" -> tap AI button
- With glasses: Tap "Start Streaming" -> tap AI button
- Say: "Hey, search for the best coffee shops near me"
- Siberius classifies intent -> routes to research agent -> returns result -> Gemini speaks it

## API Endpoints

### POST /execute (Direct Siberius format)
```json
// Request
{ "task": "Add milk to my shopping list", "toolName": "execute" }

// Response
{
  "success": true,
  "result": "Added milk to your shopping list",
  "agent": "ops",
  "intent": "add_to_list"
}
```

### POST /v1/chat/completions (OpenAI-compatible)
```json
// Request (same format VisionClaw already sends)
{
  "model": "siberius",
  "messages": [{ "role": "user", "content": "Add milk to my shopping list" }],
  "stream": false
}

// Response (same format VisionClaw already parses)
{
  "choices": [{
    "message": { "role": "assistant", "content": "Added milk to your shopping list" }
  }],
  "siberius": { "agent": "ops", "intent": "add_to_list" }
}
```

### GET /health
```json
{ "status": "ok", "ready": true, "gateway": "siberius", "tools": 24 }
```

### POST /confirm (Safety gate resolution)
```json
// Request
{ "confirmationId": "abc-123", "approved": true }

// Response
{ "success": true, "result": "Action approved and executing", "approved": true }
```

## Features

### Multi-Agent Routing
Tasks are classified by intent and routed to specialized sub-agents:

| Agent | Handles | Examples |
|-------|---------|----------|
| `comms` | Messaging, email, calls | "Send John a message", "Email the report" |
| `research` | Web search, lookups, facts | "What's the weather?", "Search for..." |
| `ops` | Lists, reminders, notes, calendar | "Add milk to list", "Set a timer" |
| `smart_home` | IoT, lights, thermostat | "Turn off the lights", "Set temp to 72" |
| `vision` | Post-processing of camera input | "Read that barcode", "What brand is this?" |
| `siberius` | Default fallback | Everything else |

### Safety Gates
Actions in these categories require confirmation before execution:

- **Messaging** - sending texts, emails, DMs
- **Purchases** - buying, ordering, subscribing
- **Deletions** - removing, erasing, cancelling
- **Payments** - transferring money, paying invoices

When triggered, Gemini tells the user: "This action requires confirmation: [summary]". The user confirms verbally, and the confirmation is sent to the `/confirm` endpoint.

### Tool Allowlist
Only pre-approved tools can be executed. The allowlist is in `safety/allowlist.ts`. Blocked tools (like `system_command`) are never allowed regardless of classification.

### Adaptive Frame Sending (Expansion)
The `sendVideoFrameIfThrottled()` method in the ViewModel already throttles to ~1fps. To implement adaptive frame sending:

```kotlin
// In GeminiSessionViewModel, modify sendVideoFrameIfThrottled:
fun sendVideoFrameIfThrottled(bitmap: Bitmap) {
    if (!_uiState.value.isGeminiActive) return
    if (_uiState.value.connectionState != GeminiConnectionState.Ready) return
    val now = System.currentTimeMillis()

    // Adaptive: send faster during active tool calls or user speech
    val interval = if (_uiState.value.toolCallStatus.isActive ||
                       _uiState.value.userTranscript.isNotEmpty()) {
        500L  // 2fps during active interaction
    } else {
        2000L // 0.5fps when idle (saves bandwidth)
    }

    if (now - lastVideoFrameTime < interval) return
    lastVideoFrameTime = now
    geminiService.sendVideoFrame(bitmap)
}
```

### Key Hygiene / WebSocket Proxy (Expansion)
To avoid leaking API keys over the LAN, implement a WebSocket relay:

1. VisionClaw connects to Siberius Gateway via WebSocket (not direct to Gemini)
2. Siberius Gateway holds the Gemini API key server-side
3. Siberius Gateway proxies audio/video to Gemini
4. No API keys ever leave the server

This is a larger change that requires modifying GeminiLiveService to connect through the proxy.

## What Siberius Needs To Do

The gateway currently has stub agent handlers. To make each agent functional:

1. **comms agent** - Integrate Telegram Bot API (`node-telegram-bot-api`) for messaging @siberiusbot
2. **research agent** - Integrate a search API (Brave Search, SerpAPI, or Tavily)
3. **ops agent** - Integrate with a task/notes API (Notion, Todoist, Google Tasks)
4. **smart_home agent** - Integrate Home Assistant REST API
5. **vision agent** - Add barcode/QR lookup, OCR post-processing

## What You Need To Do

1. Get a Gemini API key: https://aistudio.google.com/apikey
2. Find your PC's LAN IP (run `ipconfig` on Windows or `hostname -I` on Linux)
3. Start the Siberius Gateway on your PC
4. Configure the app with your PC's IP and the Siberius API key
5. Build and deploy to your phone
6. Enable Developer Mode in Meta AI app (for glasses streaming)
7. Start talking to Siberius through your glasses

## Producing Patch PRs

To extend functionality with new skills:

1. Add a new agent handler in `siberius-gateway/src/agents/executor.ts`
2. Add patterns to the classifier in `siberius-gateway/src/agents/classifier.ts`
3. Add tools to the allowlist in `siberius-gateway/src/safety/allowlist.ts`
4. Test with: `curl -X POST http://localhost:3000/execute -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" -d '{"task":"your test task"}'`
5. Commit and PR with conventional commit: `feat: add [skill-name] agent`
