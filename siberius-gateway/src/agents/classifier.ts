import { createLogger } from '../logger';

const logger = createLogger('classifier');

export type AgentType =
  // Core agents (original)
  | 'siberius'
  | 'ops'
  | 'research'
  | 'comms'
  | 'smart_home'
  // Vision Feature Agents (VISION-FEATURES-SPEC.md)
  | 'memory'        // Feature 1: Perfect Memory / Life Indexing
  | 'networking'    // Feature 2: Networking Superpower
  | 'deal'          // Feature 3: Live Deal / Price Intelligence
  | 'security'      // Feature 4: Situational Awareness / Security
  | 'meeting'       // Feature 5: Covert Meeting Intelligence
  | 'debug'         // Feature 6: Hands-Free Debugging
  | 'inspection'    // Feature 7: Automated Inspections / Documentation
  | 'context'       // Feature 8: Context-Aware Assistant
  | 'translation'   // Feature 9: Deep Translation + Cultural Intel
  | 'chain';        // Feature 10: Context Chains

interface ClassificationResult {
  agent: AgentType;
  confidence: number;
  intent: string;
  /** When vision agents fire, this indicates image capture is expected */
  requiresImage: boolean;
}

// Pattern-based intent classifier for routing to sub-agents
// Order matters: more specific agents are checked before generic ones
const agentPatterns: Record<AgentType, { patterns: RegExp[]; intents: string[]; requiresImage: boolean }> = {

  // ─── VISION FEATURE AGENTS (checked first — more specific) ───

  meeting: {
    patterns: [
      /\b(start meeting|begin meeting|meeting on|meeting mode)\b/i,
      /\b(end meeting|stop meeting|meeting over|wrap up (?:the )?meeting)\b/i,
      /\b(meeting summary|action items|who said|meeting notes|what did .+ commit)\b/i,
      /\b(transcri(?:be|ption)|record(?:ing)? (?:this )?meeting)\b/i,
    ],
    intents: ['start_meeting', 'end_meeting', 'query_meeting', 'meeting_summary'],
    requiresImage: true,
  },

  inspection: {
    patterns: [
      /\b(start inspection|begin inspection|start inventory|inventory scan|walkthrough|condition report|inspection mode|property inspection|server room|rack audit|site walk)\b/i,
      /\b(end inspection|inspection (?:complete|done|finished)|stop inspection|end inventory)\b/i,
      /\b(document(?:ing)? (?:this|the)|photo evidence|annotate|note:\s|inspection report)\b/i,
      /\b(generate report|inspection report|create report|export report)\b/i,
      /\b(scanned?\s+(?:barcode|upc|item)|barcode\s+\d{8,14}|upc\s+\d{8,14})\b/i,
      /\b(aisle\s+\w+|move(?:d)? to aisle|now (?:in|on) aisle)\b/i,
    ],
    intents: ['start_inspection', 'end_inspection', 'annotate', 'generate_report', 'scan_item', 'set_aisle'],
    requiresImage: true,
  },

  debug: {
    patterns: [
      /\b(debug|what'?s wrong|fix this|read (?:this )?(?:code|error|screen)|what'?s (?:the )?error)\b/i,
      /\b(stack ?trace|exception|syntax error|bug|crash(?:ing)?|broken)\b/i,
      /\b(explain (?:this )?(?:code|error)|why (?:is|isn'?t) (?:this|it) (?:work|compil))/i,
      /\b(code review|what does this (?:code )?do)\b/i,
    ],
    intents: ['debug_code', 'read_screen', 'explain_error', 'code_review'],
    requiresImage: true,
  },

  networking: {
    patterns: [
      /\b(who is (?:this|that)|identify (?:this )?person|name ?badge|business card)\b/i,
      /\b(brief me|pre-?meeting (?:brief|research)|attendee(?:s)?|who(?:'s| is) in (?:this|the) meeting)\b/i,
      /\b(save (?:this )?contact|add (?:to )?contacts|linkedin|look (?:up|them up))\b/i,
      /\b(who works at|what company|networking mode)\b/i,
    ],
    intents: ['identify_person', 'pre_meeting_brief', 'save_contact', 'research_person'],
    requiresImage: true,
  },

  deal: {
    patterns: [
      /\b(what'?s (?:this|it) worth|price check|how much (?:is|does|should)|compare price)\b/i,
      /\b(deal analysis|is this a good deal|fair price|market value|over ?priced|under ?priced)\b/i,
      /\b(car (?:price|value|worth)|vehicle (?:history|report)|vin|kelley blue|kbb)\b/i,
      /\b(real estate|comp(?:arable)?s?|zillow|listing|apprais)\b/i,
      /\b(amazon price|price history|camel|wholesale|retail price)\b/i,
    ],
    intents: ['product_price', 'vehicle_analysis', 'real_estate_comp', 'deal_verdict'],
    requiresImage: true,
  },

  security: {
    patterns: [
      /\b(is (?:this|it) safe|security (?:check|scan)|threat|phishing|scam)\b/i,
      /\b(scan (?:this )?(?:qr|code|barcode)|check (?:this )?(?:url|link|qr))\b/i,
      /\b(skimmer|tamper|suspicious|card reader|atm)\b/i,
      /\b(review (?:this )?contract|fine print|hidden (?:fees?|clause)|auto[- ]?renew)\b/i,
      /\b(fake (?:badge|credential|id|wifi)|spoof|rubber ducky|usb drop)\b/i,
      /\b(shoulder surf|someone (?:looking|watching)|wi-?fi (?:safe|network))\b/i,
    ],
    intents: ['qr_scan', 'threat_assess', 'contract_review', 'device_check', 'network_check'],
    requiresImage: true,
  },

  memory: {
    patterns: [
      /\b(remember (?:this|that)|save (?:this|that)|store (?:this|that))\b/i,
      /\b(what did I (?:see|look at|view|read)|when did I (?:see|last)|recall)\b/i,
      /\b(show me (?:every|all)|search (?:my )?(?:memory|photos|captures|history))\b/i,
      /\b(delete (?:last|the last)|forget (?:last|the last)|purge|clear (?:my )?(?:memory|captures))\b/i,
      /\b(what was (?:on )?(?:that|the)|where did I (?:see|put|leave))\b/i,
      /\b(visual memory|life ?log|memory search)\b/i,
    ],
    intents: ['store_memory', 'query_memory', 'delete_memory', 'browse_memory'],
    requiresImage: true,
  },

  translation: {
    patterns: [
      /\b(translate|what does (?:this|that|it) say|what language is)\b/i,
      /\b(how do you say .+ in|speak(?:ing)? (?:to|with) .+ in)\b/i,
      /\b(translation mode|interpret|foreign (?:text|sign|menu|language))\b/i,
      /\b(cultural (?:context|tip|note|etiquette)|local custom)\b/i,
    ],
    intents: ['translate_text', 'cultural_context', 'conversation_translate', 'language_detect'],
    requiresImage: true,
  },

  context: {
    patterns: [
      /\b(what (?:is|are) (?:this|that|these|those))\b/i,
      /\b(identify (?:this|that)|tell me about (?:this|that))\b/i,
      /\b(help(?! me (?:send|text|email|buy|order|search|find|debug|translate|inspect)))\b/i,
      /\b(what (?:kind|type|brand|model|species|plant|animal))\b/i,
      /\b(how (?:do I|to) (?:use|cook|fix|assemble|open|operate))\b/i,
      /\b(recipe|instructions? for|step(?:s| by step))\b/i,
      /\b(nutrition|calories|ingredients|allergen)\b/i,
      /\b(torque spec|bolt size|wire gauge|measurement)\b/i,
    ],
    intents: ['identify_object', 'contextual_help', 'step_guide', 'nutrition_check'],
    requiresImage: true,
  },

  chain: {
    patterns: [
      /\b(start (?:sales|shopping|travel|meeting) (?:mode|chain))\b/i,
      /\b(activate chain|chain mode|full (?:mode|workflow))\b/i,
      /\b(end (?:sales|shopping|travel) (?:mode|chain)|stop chain)\b/i,
    ],
    intents: ['activate_chain', 'deactivate_chain', 'chain_status'],
    requiresImage: false,
  },

  // ─── CORE AGENTS (original — checked after vision agents) ───

  comms: {
    patterns: [
      /\b(send|text|message|email|call|reply|forward|dm|whatsapp|telegram|slack|imessage)\b/i,
      /\b(contact|reach out|get in touch|notify)\b/i,
    ],
    intents: ['send_message', 'send_email', 'make_call', 'reply_message'],
    requiresImage: false,
  },

  research: {
    patterns: [
      /\b(search|look up|find|google|what is|who is|define|wikipedia|explain|research)\b/i,
      /\b(news|latest|current|trending|article)\b/i,
    ],
    intents: ['web_search', 'wiki_lookup', 'news_search', 'fact_check'],
    requiresImage: false,
  },

  ops: {
    patterns: [
      /\b(remind|timer|alarm|schedule|calendar|todo|task|note|list|appointment)\b/i,
      /\b(shopping list|add to|create|set|plan)\b/i,
    ],
    intents: ['set_reminder', 'create_note', 'add_to_list', 'schedule_event'],
    requiresImage: false,
  },

  smart_home: {
    patterns: [
      /\b(lights?|thermostat|temperature|lock|door|garage|fan|ac|heat|blinds|curtains)\b/i,
      /\b(turn on|turn off|dim|brighten|set to|adjust|home)\b/i,
    ],
    intents: ['control_device', 'query_status', 'set_scene'],
    requiresImage: false,
  },

  // ─── DEFAULT FALLBACK ───

  siberius: {
    patterns: [], // Default fallback — no patterns needed
    intents: ['general_task'],
    requiresImage: false,
  },
};

/**
 * Classify a natural language task string into an agent type + intent.
 * More specific vision agents are checked before generic core agents.
 * Returns the best match with a confidence score.
 */
export function classifyIntent(task: string): ClassificationResult {
  let bestMatch: ClassificationResult = {
    agent: 'siberius',
    confidence: 0.3,
    intent: 'general_task',
    requiresImage: false,
  };

  for (const [agent, { patterns, intents, requiresImage }] of Object.entries(agentPatterns)) {
    if (agent === 'siberius') continue; // Skip default

    let matchCount = 0;
    let bestIntentIdx = 0;

    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].test(task)) {
        matchCount++;
        // Use the index of the first matching pattern to pick the most relevant intent
        if (matchCount === 1) bestIntentIdx = Math.min(i, intents.length - 1);
      }
    }

    if (matchCount > 0) {
      const confidence = Math.min(0.5 + matchCount * 0.2, 0.95);
      if (confidence > bestMatch.confidence) {
        bestMatch = {
          agent: agent as AgentType,
          confidence,
          intent: intents[bestIntentIdx] || 'general_task',
          requiresImage,
        };
      }
    }
  }

  logger.info({
    task: task.slice(0, 80),
    agent: bestMatch.agent,
    confidence: bestMatch.confidence,
    intent: bestMatch.intent,
    requiresImage: bestMatch.requiresImage,
  }, 'Task classified');

  return bestMatch;
}

/**
 * Check if a given agent type is a vision feature agent.
 * Vision agents expect image data alongside the task.
 */
export function isVisionAgent(agent: AgentType): boolean {
  const visionAgents: AgentType[] = [
    'memory', 'networking', 'deal', 'security', 'meeting',
    'debug', 'inspection', 'context', 'translation',
  ];
  return visionAgents.includes(agent);
}

/**
 * Get the list of all registered agent types.
 */
export function getAgentTypes(): AgentType[] {
  return Object.keys(agentPatterns) as AgentType[];
}
