package com.meta.wearable.dat.externalsampleapps.cameraaccess.siberius

import android.util.Log
import com.meta.wearable.dat.externalsampleapps.cameraaccess.gemini.GeminiConfig
import com.meta.wearable.dat.externalsampleapps.cameraaccess.openclaw.OpenClawConnectionState
import com.meta.wearable.dat.externalsampleapps.cameraaccess.openclaw.ToolCallStatus
import com.meta.wearable.dat.externalsampleapps.cameraaccess.openclaw.ToolResult
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

/**
 * SiberiusGateway replaces OpenClawBridge.
 *
 * It speaks the same interface (delegateTask, checkConnection, resetSession)
 * so ToolCallRouter and GeminiSessionViewModel need zero logic changes.
 *
 * Two modes:
 *   1. Direct Siberius format  →  POST /execute  { task, toolName }
 *   2. OpenAI-compat format    →  POST /v1/chat/completions  { model, messages, stream }
 *
 * The gateway also serves /v1/chat/completions so existing VisionClaw code
 * works unmodified if you just swap the host/port/token.
 */
class SiberiusGateway {
    companion object {
        private const val TAG = "SiberiusGateway"
        private const val MAX_HISTORY_TURNS = 10
    }

    private val _lastToolCallStatus = MutableStateFlow<ToolCallStatus>(ToolCallStatus.Idle)
    val lastToolCallStatus: StateFlow<ToolCallStatus> = _lastToolCallStatus.asStateFlow()

    private val _connectionState = MutableStateFlow<OpenClawConnectionState>(OpenClawConnectionState.NotConfigured)
    val connectionState: StateFlow<OpenClawConnectionState> = _connectionState.asStateFlow()

    fun setToolCallStatus(status: ToolCallStatus) {
        _lastToolCallStatus.value = status
    }

    private val client = OkHttpClient.Builder()
        .readTimeout(120, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    private val pingClient = OkHttpClient.Builder()
        .readTimeout(5, TimeUnit.SECONDS)
        .connectTimeout(5, TimeUnit.SECONDS)
        .build()

    private var sessionKey: String = newSessionKey()
    private val conversationHistory = mutableListOf<JSONObject>()

    // --- Connection check (hits /health on Siberius Gateway) ---

    suspend fun checkConnection() = withContext(Dispatchers.IO) {
        if (!GeminiConfig.isOpenClawConfigured) {
            _connectionState.value = OpenClawConnectionState.NotConfigured
            return@withContext
        }
        _connectionState.value = OpenClawConnectionState.Checking

        val url = "${GeminiConfig.openClawHost}:${GeminiConfig.openClawPort}/health"
        try {
            val request = Request.Builder()
                .url(url)
                .get()
                .build()

            val response = pingClient.newCall(request).execute()
            val code = response.code
            val body = response.body?.string() ?: ""
            response.close()

            if (code == 200) {
                _connectionState.value = OpenClawConnectionState.Connected
                Log.d(TAG, "Siberius Gateway reachable: $body")
            } else {
                _connectionState.value = OpenClawConnectionState.Unreachable("HTTP $code")
            }
        } catch (e: Exception) {
            _connectionState.value = OpenClawConnectionState.Unreachable(e.message ?: "Unknown error")
            Log.d(TAG, "Siberius Gateway unreachable: ${e.message}")
        }
    }

    fun resetSession() {
        sessionKey = newSessionKey()
        conversationHistory.clear()
        Log.d(TAG, "New Siberius session: $sessionKey")
    }

    // --- Core task delegation ---
    // Sends to /v1/chat/completions so the Siberius Gateway's OpenAI-compat
    // endpoint handles it. This means zero changes to ToolCallRouter.

    suspend fun delegateTask(
        task: String,
        toolName: String = "execute"
    ): ToolResult = withContext(Dispatchers.IO) {
        _lastToolCallStatus.value = ToolCallStatus.Executing(toolName)

        val url = "${GeminiConfig.openClawHost}:${GeminiConfig.openClawPort}/v1/chat/completions"

        // Append user message
        conversationHistory.add(JSONObject().apply {
            put("role", "user")
            put("content", task)
        })

        // Trim history
        if (conversationHistory.size > MAX_HISTORY_TURNS * 2) {
            val trimmed = conversationHistory.takeLast(MAX_HISTORY_TURNS * 2)
            conversationHistory.clear()
            conversationHistory.addAll(trimmed)
        }

        Log.d(TAG, "Sending ${conversationHistory.size} messages to Siberius")

        try {
            val messagesArray = JSONArray()
            for (msg in conversationHistory) {
                messagesArray.put(msg)
            }

            val body = JSONObject().apply {
                put("model", "siberius")
                put("messages", messagesArray)
                put("stream", false)
            }

            val request = Request.Builder()
                .url(url)
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .addHeader("Authorization", "Bearer ${GeminiConfig.openClawGatewayToken}")
                .addHeader("Content-Type", "application/json")
                .addHeader("x-siberius-session-key", sessionKey)
                .build()

            val response = client.newCall(request).execute()
            val responseBody = response.body?.string() ?: ""
            val statusCode = response.code
            response.close()

            if (statusCode !in 200..299) {
                Log.d(TAG, "Siberius failed: HTTP $statusCode - ${responseBody.take(200)}")
                _lastToolCallStatus.value = ToolCallStatus.Failed(toolName, "HTTP $statusCode")
                return@withContext ToolResult.Failure("Siberius returned HTTP $statusCode")
            }

            val json = JSONObject(responseBody)

            // Check for confirmation required (safety gate)
            val sibetiusMeta = json.optJSONObject("siberius")
            if (sibetiusMeta?.optBoolean("confirmationRequired") == true) {
                val summary = sibetiusMeta.optString("confirmationSummary", "Action requires confirmation")
                Log.d(TAG, "Safety gate triggered: $summary")
                _lastToolCallStatus.value = ToolCallStatus.Completed(toolName)
                return@withContext ToolResult.Success(summary)
            }

            val choices = json.optJSONArray("choices")
            val content = choices?.optJSONObject(0)
                ?.optJSONObject("message")
                ?.optString("content", "")

            if (!content.isNullOrEmpty()) {
                conversationHistory.add(JSONObject().apply {
                    put("role", "assistant")
                    put("content", content)
                })
                Log.d(TAG, "Siberius result: ${content.take(200)}")
                _lastToolCallStatus.value = ToolCallStatus.Completed(toolName)
                return@withContext ToolResult.Success(content)
            }

            conversationHistory.add(JSONObject().apply {
                put("role", "assistant")
                put("content", responseBody)
            })
            Log.d(TAG, "Siberius raw: ${responseBody.take(200)}")
            _lastToolCallStatus.value = ToolCallStatus.Completed(toolName)
            return@withContext ToolResult.Success(responseBody)
        } catch (e: Exception) {
            Log.e(TAG, "Siberius error: ${e.message}")
            _lastToolCallStatus.value = ToolCallStatus.Failed(toolName, e.message ?: "Unknown")
            return@withContext ToolResult.Failure("Siberius error: ${e.message}")
        }
    }

    private fun newSessionKey(): String {
        val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        formatter.timeZone = TimeZone.getTimeZone("UTC")
        val ts = formatter.format(Date())
        return "siberius:main:glass:$ts"
    }
}
