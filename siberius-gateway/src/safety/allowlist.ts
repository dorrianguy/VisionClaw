import { createLogger } from '../logger';

const logger = createLogger('allowlist');

// Tools/skills that Siberius is allowed to execute
// Add new skills here as you expand capabilities
const ALLOWED_TOOLS = new Set([
  // ─── Information Retrieval ───
  'web_search',
  'wikipedia_lookup',
  'weather',
  'time_zone',
  'calculator',
  'unit_convert',
  'translate',

  // ─── Productivity ───
  'shopping_list',
  'reminders',
  'notes',
  'calendar_read',
  'calendar_write',
  'timer',
  'todo_list',

  // ─── Smart Home (read-only by default) ───
  'smart_home_status',
  'smart_home_lights',
  'smart_home_thermostat',

  // ─── Communication (safety-gated) ───
  'send_message',
  'send_email',

  // ─── Navigation ───
  'directions',
  'nearby_places',

  // ─── Media ───
  'play_music',
  'podcast_search',

  // ─── Vision Core ───
  'describe_scene',
  'read_text',
  'identify_object',
  'barcode_lookup',
  'camera_snap',

  // ─── Feature 1: Visual Memory ───
  'memory_store',
  'memory_query',
  'memory_delete',
  'memory_browse',

  // ─── Feature 2: Networking ───
  'badge_read',
  'contact_save',
  'person_research',
  'linkedin_lookup',
  'pre_meeting_brief',

  // ─── Feature 3: Deal Intelligence ───
  'price_check',
  'upc_lookup',
  'vehicle_vin_decode',
  'kbb_lookup',
  'real_estate_comp',
  'price_history',

  // ─── Feature 4: Security ───
  'qr_decode',
  'url_safety_check',
  'contract_review',
  'device_tamper_check',
  'wifi_scan',

  // ─── Feature 5: Meeting Intelligence ───
  'meeting_start',
  'meeting_end',
  'meeting_query',
  'transcription_stream',
  'speaker_diarize',

  // ─── Feature 6: Debug ───
  'screen_read',
  'code_analyze',
  'error_explain',
  'code_review',

  // ─── Feature 7: Inspection ───
  'inspection_start',
  'inspection_end',
  'inspection_annotate',
  'inspection_report',
  'inventory_scan',

  // ─── Feature 8: Context-Aware ───
  'object_identify',
  'nutrition_lookup',
  'recipe_search',
  'step_guide',
  'torque_spec',

  // ─── Feature 9: Translation ───
  'translate_image',
  'language_detect',
  'cultural_context',
  'conversation_translate',

  // ─── Feature 10: Context Chains ───
  'chain_activate',
  'chain_deactivate',
  'chain_status',
]);

// Tools that are NEVER allowed (blocklist overrides allowlist)
const BLOCKED_TOOLS = new Set([
  'system_command',
  'file_delete',
  'admin_access',
  'root_shell',
]);

export function isToolAllowed(toolName: string): boolean {
  if (BLOCKED_TOOLS.has(toolName)) {
    logger.warn({ tool: toolName }, 'Blocked tool attempted');
    return false;
  }
  return ALLOWED_TOOLS.has(toolName);
}

export function getAllowedTools(): string[] {
  return Array.from(ALLOWED_TOOLS);
}

export function addTool(toolName: string): void {
  if (BLOCKED_TOOLS.has(toolName)) {
    logger.warn({ tool: toolName }, 'Cannot add blocked tool');
    return;
  }
  ALLOWED_TOOLS.add(toolName);
  logger.info({ tool: toolName }, 'Tool added to allowlist');
}

export function removeTool(toolName: string): void {
  ALLOWED_TOOLS.delete(toolName);
  logger.info({ tool: toolName }, 'Tool removed from allowlist');
}
