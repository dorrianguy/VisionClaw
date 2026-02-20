package com.meta.wearable.dat.externalsampleapps.cameraaccess.siberius

import android.util.Log
import com.meta.wearable.dat.externalsampleapps.cameraaccess.openclaw.GeminiFunctionCall
import com.meta.wearable.dat.externalsampleapps.cameraaccess.openclaw.ToolCallStatus
import com.meta.wearable.dat.externalsampleapps.cameraaccess.openclaw.ToolResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/**
 * SiberiusToolCallRouter - drop-in replacement for ToolCallRouter.
 * Routes Gemini tool calls to SiberiusGateway instead of OpenClawBridge.
 * Same interface, same response format.
 */
class SiberiusToolCallRouter(
    private val gateway: SiberiusGateway,
    private val scope: CoroutineScope
) {
    companion object {
        private const val TAG = "SiberiusToolRouter"
    }

    private val inFlightJobs = mutableMapOf<String, Job>()

    fun handleToolCall(
        call: GeminiFunctionCall,
        sendResponse: (JSONObject) -> Unit
    ) {
        val callId = call.id
        val callName = call.name

        Log.d(TAG, "Received: $callName (id: $callId) args: ${call.args}")

        val job = scope.launch {
            val taskDesc = call.args["task"]?.toString() ?: call.args.toString()
            val result = gateway.delegateTask(task = taskDesc, toolName = callName)

            if (!coroutineContext[Job]!!.isCancelled) {
                Log.d(TAG, "Result for $callName (id: $callId): $result")
                val response = buildToolResponse(callId, callName, result)
                sendResponse(response)
            } else {
                Log.d(TAG, "Task $callId was cancelled, skipping response")
            }

            inFlightJobs.remove(callId)
        }

        inFlightJobs[callId] = job
    }

    fun cancelToolCalls(ids: List<String>) {
        for (id in ids) {
            inFlightJobs[id]?.let { job ->
                Log.d(TAG, "Cancelling in-flight call: $id")
                job.cancel()
                inFlightJobs.remove(id)
            }
        }
        gateway.setToolCallStatus(ToolCallStatus.Cancelled(ids.firstOrNull() ?: "unknown"))
    }

    fun cancelAll() {
        for ((id, job) in inFlightJobs) {
            Log.d(TAG, "Cancelling in-flight call: $id")
            job.cancel()
        }
        inFlightJobs.clear()
    }

    private fun buildToolResponse(
        callId: String,
        name: String,
        result: ToolResult
    ): JSONObject {
        return JSONObject().apply {
            put("toolResponse", JSONObject().apply {
                put("functionResponses", JSONArray().put(JSONObject().apply {
                    put("id", callId)
                    put("name", name)
                    put("response", result.toJSON())
                }))
            })
        }
    }
}
